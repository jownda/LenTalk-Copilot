// ---------------------------------------------------------------------------
// OpenAI 兼容平台 provider(自定义平台)
// 前端在设置里新增的 custom:<id> 平台走这里:
//   POST {base_url}/v1/images/generations(文生图)
// base_url 通过 GenerateRequest.extra_params["provider_base_url"] 传入,
// API Key 通过 set_api_key("custom:<id>", key) 按平台存储。
// ---------------------------------------------------------------------------
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};

use crate::ai::error::AIError;
use crate::ai::{
    AIProvider, GenerateRequest, ProviderTaskHandle, ProviderTaskPollResult, ProviderTaskSubmission,
};

const CUSTOM_PROVIDER_PREFIX: &str = "custom:";

pub struct OpenAICompatibleProvider {
    custom_api_keys: Arc<RwLock<HashMap<String, String>>>,
}

impl OpenAICompatibleProvider {
    pub fn new() -> Self {
        Self {
            custom_api_keys: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// 按自定义平台 id 存储 key
    async fn store_custom_key(&self, provider_id: &str, api_key: String) {
        let mut keys = self.custom_api_keys.write().await;
        keys.insert(provider_id.to_string(), api_key);
    }

    async fn resolve_custom_key(&self, provider_id: &str) -> Option<String> {
        let keys = self.custom_api_keys.read().await;
        keys.get(provider_id).cloned()
    }

    fn build_client() -> reqwest::Client {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(180))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    }

    /// 从 OpenAI 兼容服务的 /v1/models 拉取模型列表(供「测试链接 / 拉取模型」使用)
    pub async fn fetch_openai_models(
        base_url: &str,
        api_key: &str,
    ) -> Result<Vec<String>, AIError> {
        let client = Self::build_client();
        let endpoint = format!("{}/v1/models", base_url.trim_end_matches('/'));

        let response = client
            .get(&endpoint)
            .bearer_auth(api_key)
            .send()
            .await?;
        let status = response.status();
        let payload: Value = response.json().await?;

        if !status.is_success() {
            let payload_text = payload.to_string();
            let message = payload
                .get("error")
                .and_then(|value| value.get("message"))
                .and_then(|value| value.as_str())
                .unwrap_or(&payload_text);
            return Err(AIError::TaskFailed(format!("HTTP {}: {}", status, message)));
        }

        let models = payload
            .get("data")
            .and_then(|value| value.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.get("id").and_then(|id| id.as_str()).map(String::from))
                    .collect()
            })
            .unwrap_or_default();

        Ok(models)
    }

    /// 仅检查 Base URL 是否可达(不依赖 API Key,供「验证链接」使用)
    pub async fn check_url_reachable(base_url: &str) -> Result<u16, AIError> {
        let client = Self::build_client();
        let normalized = base_url.trim_end_matches('/');
        if normalized.is_empty() {
            return Err(AIError::InvalidRequest("Base URL 为空".into()));
        }

        // 先尝试根路径;部分服务根路径 404/405 但可达,也视为可达
        let mut last_status = 0u16;
        let endpoints = [normalized.to_string(), format!("{}/v1/models", normalized)];
        for endpoint in endpoints {
            let response = client.get(&endpoint).send().await?;
            last_status = response.status().as_u16();
            // 2xx/3xx 或明确的服务端响应(4xx 说明服务在)都视为可达
            if last_status < 500 {
                return Ok(last_status);
            }
        }
        Ok(last_status)
    }

    /// gpt-image 系列仅支持 1024x1024 / 1536x1024 / 1024x1536。
    /// 按目标画幅映射到最接近的官方尺寸(忽略档位, gpt-image 物理上限即 1536)。
    fn map_gpt_image_size(aspect_ratio: &str) -> &'static str {
        match aspect_ratio {
            "9:16" | "3:4" | "2:3" | "4:5" | "1:2" | "1:3" => "1024x1536",
            "16:9" | "3:2" | "4:3" | "5:4" | "2:1" | "3:1" | "21:9" => "1536x1024",
            _ => "1024x1024",
        }
    }

    /// 解析自定义平台 base_url 与 API Key(优先该平台, 其次 default)。
    async fn resolve_base_url_and_key(
        &self,
        provider_id: &str,
        extra_params: &Option<HashMap<String, Value>>,
    ) -> Result<(String, String), AIError> {
        let base_url = extra_params
            .as_ref()
            .and_then(|params| params.get("provider_base_url"))
            .and_then(|value| value.as_str())
            .map(|value| value.trim().trim_end_matches('/').to_string())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AIError::InvalidRequest("缺少 provider_base_url,请检查自定义平台配置".into()))?;
        let api_key = match self.resolve_custom_key(provider_id).await {
            Some(key) if !key.is_empty() => key,
            _ => self.resolve_custom_key("default").await.unwrap_or_default(),
        };
        if api_key.is_empty() {
            return Err(AIError::InvalidRequest("未配置 API Key".into()));
        }
        Ok((base_url, api_key))
    }

    /// 构造 /v1/images/generations 请求体(gpt-image 系列用 input_image + output_format)。
    fn build_request_body(
        api_model: &str,
        prompt: &str,
        aspect_ratio: &str,
        reference_images: Option<&Vec<String>>,
    ) -> Result<Value, AIError> {
        let is_gpt_image = api_model.to_ascii_lowercase().contains("gpt-image");
        let mut body = json!({
            "model": api_model,
            "prompt": prompt,
            "n": 1,
        });
        if is_gpt_image {
            body["size"] = json!(Self::map_gpt_image_size(aspect_ratio));
            body["output_format"] = json!("png");
        } else {
            body["size"] = json!("1024x1024");
            body["response_format"] = json!("b64_json");
        }
        if let Some(reference_image) = reference_images.and_then(|images| images.first()) {
            let image_field =
                Self::reference_image_to_image_field(reference_image).map_err(|error| {
                    AIError::InvalidRequest(format!("自定义平台参考图处理失败: {}", error))
                })?;
            if let Some(image) = image_field {
                if is_gpt_image {
                    body["input_image"] = json!(image);
                } else {
                    body["image"] = json!(image);
                }
            }
        }
        Ok(body)
    }

    /// 从响应中提取图片(不报错版): 支持 data[]b64/url、顶层 b64_json/url/image/output。
    fn extract_image_data_if_present(payload: &Value) -> Option<String> {
        if let Some(data) = payload.get("data").and_then(|value| value.as_array()) {
            if let Some(first) = data.first() {
                if let Some(b64) = first.get("b64_json").and_then(|value| value.as_str()) {
                    if !b64.is_empty() {
                        return Some(format!("data:image/png;base64,{}", b64));
                    }
                }
                if let Some(url) = first.get("url").and_then(|value| value.as_str()) {
                    if !url.is_empty() {
                        return Some(url.to_string());
                    }
                }
            }
        }
        for key in ["b64_json", "url", "image", "image_url", "output"] {
            if let Some(value) = payload.get(key) {
                if let Some(text) = value.as_str() {
                    if !text.is_empty() {
                        return Some(if key == "b64_json" {
                            format!("data:image/png;base64,{}", text)
                        } else {
                            text.to_string()
                        });
                    }
                }
                if let Some(array) = value.as_array() {
                    if let Some(first) = array.iter().find_map(|item| item.as_str()) {
                        if !first.is_empty() {
                            return Some(first.to_string());
                        }
                    }
                }
            }
        }
        None
    }

    /// 从提交响应中提取任务 id(各平台非标字段名)。
    fn extract_task_id(payload: &Value) -> Option<String> {
        for key in ["task_id", "request_id", "job_id", "submission_id", "id"] {
            if let Some(value) = payload.get(key) {
                if let Some(text) = value.as_str() {
                    if !text.is_empty() {
                        return Some(text.to_string());
                    }
                }
                if let Some(number) = value.as_u64() {
                    return Some(number.to_string());
                }
            }
        }
        None
    }

    /// 参考图 → 可发送给平台的 image 值:
    /// data URL / http(s) URL 原样返回;本地路径/文件 URL 读取并转 base64 data URL。
    fn reference_image_to_image_field(source: &str) -> Result<Option<String>, AIError> {
        let trimmed = source.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }
        if trimmed.starts_with("data:") || trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            return Ok(Some(trimmed.to_string()));
        }
        if trimmed.starts_with("asset://") || trimmed.starts_with("tauri://") || trimmed.starts_with("app://") {
            return Err(AIError::InvalidRequest(format!(
                "参考图不支持本地协议源: {}",
                trimmed
            )));
        }

        let path = if trimmed.starts_with("file://") {
            PathBuf::from(Self::decode_file_url_path(trimmed))
        } else {
            PathBuf::from(trimmed)
        };
        let bytes = std::fs::read(&path).map_err(|err| {
            AIError::InvalidRequest(format!(
                "读取参考图失败 \"{}\": {}",
                path.to_string_lossy(),
                err
            ))
        })?;
        if bytes.is_empty() {
            return Ok(None);
        }
        let mime = Self::guess_image_mime(&path.to_string_lossy());
        let encoded = STANDARD.encode(&bytes);
        Ok(Some(format!("data:{};base64,{}", mime, encoded)))
    }

    fn guess_image_mime(path: &str) -> &'static str {
        let lower = path.to_ascii_lowercase();
        if lower.ends_with(".webp") {
            "image/webp"
        } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
            "image/jpeg"
        } else if lower.ends_with(".gif") {
            "image/gif"
        } else {
            "image/png"
        }
    }

    fn decode_file_url_path(value: &str) -> String {
        let raw = value.trim_start_matches("file://");
        let decoded = urlencoding::decode(raw)
            .map(|result| result.into_owned())
            .unwrap_or_else(|_| raw.to_string());
        let normalized = if decoded.starts_with('/')
            && decoded.len() > 2
            && decoded.as_bytes().get(2) == Some(&b':')
        {
            &decoded[1..]
        } else {
            &decoded
        };
        normalized.to_string()
    }

    /// 解析 OpenAI Images 响应:优先 b64_json,其次 url
    fn extract_image_data(payload: &Value) -> Result<String, AIError> {        if let Some(data) = payload.get("data").and_then(|value| value.as_array()) {
            if let Some(first) = data.first() {
                if let Some(b64) = first.get("b64_json").and_then(|value| value.as_str()) {
                    if !b64.is_empty() {
                        return Ok(format!("data:image/png;base64,{}", b64));
                    }
                }
                if let Some(url) = first.get("url").and_then(|value| value.as_str()) {
                    if !url.is_empty() {
                        return Ok(url.to_string());
                    }
                }
            }
        }
        let error_message = payload
            .get("error")
            .and_then(|value| value.get("message"))
            .and_then(|value| value.as_str())
            .unwrap_or("响应中未找到图片数据");
        Err(AIError::TaskFailed(error_message.to_string()))
    }
}

impl Default for OpenAICompatibleProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl AIProvider for OpenAICompatibleProvider {
    fn name(&self) -> &str {
        "openai-compatible"
    }

    fn supports_model(&self, model: &str) -> bool {
        model.starts_with(CUSTOM_PROVIDER_PREFIX)
    }

    async fn set_api_key(&self, api_key: String) -> Result<(), AIError> {
        // 默认 key(未区分平台时)
        let mut keys = self.custom_api_keys.write().await;
        keys.insert("default".to_string(), api_key);
        Ok(())
    }

    async fn set_api_key_for(&self, provider_id: &str, api_key: String) -> Result<(), AIError> {
        self.store_custom_key(provider_id, api_key).await;
        Ok(())
    }

    async fn generate(&self, request: GenerateRequest) -> Result<String, AIError> {
        let (provider_id, api_model) = request
            .model
            .split_once('/')
            .ok_or_else(|| AIError::InvalidRequest("自定义平台模型格式应为 custom:<id>/<model>".into()))?;
        if !provider_id.starts_with(CUSTOM_PROVIDER_PREFIX) {
            return Err(AIError::InvalidRequest(format!(
                "模型 {} 不属于自定义平台",
                request.model
            )));
        }

        let (base_url, api_key) = self
            .resolve_base_url_and_key(provider_id, &request.extra_params)
            .await?;
        let client = Self::build_client();
        let endpoint = format!("{}/v1/images/generations", base_url);
        let body = Self::build_request_body(
            api_model,
            &request.prompt,
            &request.aspect_ratio,
            request.reference_images.as_ref(),
        )?;

        let response = client
            .post(&endpoint)
            .bearer_auth(api_key)
            .json(&body)
            .send()
            .await?;

        let status = response.status();
        // 先读文本, 再尝试 JSON: 4xx/5xx 平台可能返回 HTML/空 body, 避免笼统的 "decoding response body"
        let body_text = response.text().await?;
        let payload: Value = serde_json::from_str(&body_text).unwrap_or(Value::Null);
        if !status.is_success() {
            let message = payload
                .get("error")
                .and_then(|value| value.get("message"))
                .and_then(|value| value.as_str())
                .map(|value| value.to_string())
                .unwrap_or_else(|| {
                    if body_text.trim().is_empty() {
                        format!("HTTP {} 空响应体", status)
                    } else {
                        body_text.chars().take(300).collect()
                    }
                });
            return Err(AIError::TaskFailed(format!(
                "自定义平台请求失败 (HTTP {}): {}",
                status, message
            )));
        }
        if payload.is_null() {
            return Err(AIError::TaskFailed(format!(
                "自定义平台响应不是有效 JSON: {}",
                body_text.chars().take(300).collect::<String>()
            )));
        }

        Self::extract_image_data(&payload)
    }

    /// 异步模式提交(extra_params.request_mode == "async"):
    /// 平台同步返回图片 → Succeeded; 返回任务 id → Queued; 其余报错。
    async fn submit_task(&self, request: GenerateRequest) -> Result<ProviderTaskSubmission, AIError> {
        let is_async = request
            .extra_params
            .as_ref()
            .and_then(|params| params.get("request_mode"))
            .and_then(|value| value.as_str())
            .map(|value| value.eq_ignore_ascii_case("async"))
            .unwrap_or(false);
        // 未开启异步 → 走同步 generate
        if !is_async {
            let image = self.generate(request).await?;
            return Ok(ProviderTaskSubmission::Succeeded(image));
        }

        let (provider_id, api_model) = request
            .model
            .split_once('/')
            .ok_or_else(|| AIError::InvalidRequest("自定义平台模型格式应为 custom:<id>/<model>".into()))?;
        if !provider_id.starts_with(CUSTOM_PROVIDER_PREFIX) {
            return Err(AIError::InvalidRequest(format!(
                "模型 {} 不属于自定义平台",
                request.model
            )));
        }

        let (base_url, api_key) = self
            .resolve_base_url_and_key(provider_id, &request.extra_params)
            .await?;
        let client = Self::build_client();
        let endpoint = format!("{}/v1/images/generations", base_url);
        let body = Self::build_request_body(
            api_model,
            &request.prompt,
            &request.aspect_ratio,
            request.reference_images.as_ref(),
        )?;

        let response = client
            .post(&endpoint)
            .bearer_auth(api_key.clone())
            .json(&body)
            .send()
            .await?;
        let status = response.status();
        let body_text = response.text().await?;
        let payload: Value = serde_json::from_str(&body_text).unwrap_or(Value::Null);

        if status.is_success() {
            // 平台同步直接返回图片
            if let Some(image) = Self::extract_image_data_if_present(&payload) {
                return Ok(ProviderTaskSubmission::Succeeded(image));
            }
            // 返回任务 id → 异步轮询
            if let Some(task_id) = Self::extract_task_id(&payload) {
                let metadata = json!({
                    "base_url": base_url,
                    "api_key": api_key,
                });
                return Ok(ProviderTaskSubmission::Queued(ProviderTaskHandle {
                    task_id,
                    metadata: Some(metadata),
                }));
            }
        }

        let message = payload
            .get("error")
            .and_then(|value| value.get("message"))
            .and_then(|value| value.as_str())
            .map(|value| value.to_string())
            .unwrap_or_else(|| {
                if body_text.trim().is_empty() {
                    format!("HTTP {} 空响应体", status)
                } else {
                    body_text.chars().take(300).collect()
                }
            });
        Err(AIError::TaskFailed(format!(
            "自定义平台异步提交失败 (HTTP {}): {}",
            status, message
        )))
    }

    /// 异步模式轮询: 依次探测常见状态端点, 直到找到可识别的端点。
    async fn poll_task(&self, handle: ProviderTaskHandle) -> Result<ProviderTaskPollResult, AIError> {
        let base_url = handle
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("base_url"))
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        let api_key = handle
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("api_key"))
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        let task_id = &handle.task_id;
        if base_url.is_empty() {
            return Err(AIError::InvalidRequest("异步任务缺少基础地址".into()));
        }

        let candidates: Vec<(reqwest::Method, String)> = vec![
            (
                reqwest::Method::GET,
                format!("{}/v1/images/generations/{}", base_url, task_id),
            ),
            (
                reqwest::Method::GET,
                format!("{}/v1/images/generations/{}/status", base_url, task_id),
            ),
            (
                reqwest::Method::POST,
                format!("{}/v1/images/generations/{}/status", base_url, task_id),
            ),
        ];

        let client = Self::build_client();
        for (method, url) in candidates {
            let mut request = client.request(method, &url);
            if !api_key.is_empty() {
                request = request.bearer_auth(&api_key);
            }
            let response = request.send().await?;
            if response.status() == reqwest::StatusCode::NOT_FOUND {
                continue;
            }
            let body_text = response.text().await?;
            let payload: Value = serde_json::from_str(&body_text).unwrap_or(Value::Null);

            if let Some(image) = Self::extract_image_data_if_present(&payload) {
                return Ok(ProviderTaskPollResult::Succeeded(image));
            }

            let status_text = payload
                .get("status")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let lower = status_text.to_ascii_lowercase();
            if lower.contains("fail") || lower.contains("error") {
                let message = payload
                    .get("error")
                    .and_then(|value| value.get("message"))
                    .and_then(|value| value.as_str())
                    .or_else(|| payload.get("message").and_then(|value| value.as_str()))
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| format!("任务失败: {}", status_text));
                return Ok(ProviderTaskPollResult::Failed(message));
            }
            if lower.contains("succeed")
                || lower.contains("complete")
                || lower.contains("success")
                || lower.contains("done")
            {
                return Ok(ProviderTaskPollResult::Failed(format!(
                    "任务完成但响应中未找到图片: {}",
                    body_text.chars().take(200).collect::<String>()
                )));
            }
            // queued / processing / running / 无明确状态 → 继续轮询
            return Ok(ProviderTaskPollResult::Running);
        }

        Ok(ProviderTaskPollResult::Failed(
            "平台未提供可识别的任务状态端点(尝试了 /images/generations/<id> 与 /status)".to_string(),
        ))
    }
}
