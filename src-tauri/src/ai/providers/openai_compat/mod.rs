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
use tracing::info;

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

    /// 短超时 client(20s): 用于「验证连接/验证协议/拉取模型」等交互操作,
    /// 避免平台不可达时 UI 长时间卡在"验证中/拉取中"。
    fn build_short_timeout_client() -> reqwest::Client {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    }

    /// 从 OpenAI 兼容服务的 /v1/models 拉取模型列表(供「测试链接 / 拉取模型」使用)
    pub async fn fetch_openai_models(
        base_url: &str,
        api_key: &str,
    ) -> Result<Vec<String>, AIError> {
        let client = Self::build_short_timeout_client();
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
        let client = Self::build_short_timeout_client();
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

    /// 构造 /v1/images/generations 请求体。
    /// 自定义中转平台通常使用 image，原生 GPT Image API 使用 input_image。
    fn build_request_body(
        api_model: &str,
        prompt: &str,
        aspect_ratio: &str,
        reference_images: Option<&Vec<String>>,
        reference_image_field: &str,
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
            // gpt-image-2-* 中转模型会读取该字段；仅传 OpenAI 的 size 时会回退为服务端默认横幅。
            if api_model.to_ascii_lowercase().contains("gpt-image-2") {
                body["aspect_ratio"] = json!(aspect_ratio);
            }
        } else {
            body["size"] = json!("1024x1024");
            // Generic OpenAI-compatible image relays commonly expose arbitrary
            // canvas framing through aspect_ratio rather than size alone.
            body["aspect_ratio"] = json!(aspect_ratio);
            body["response_format"] = json!("b64_json");
        }
        let images = reference_images
            .map(|references| {
                references
                    .iter()
                    .filter_map(|reference| Self::reference_image_to_image_field(reference).transpose())
                    .collect::<Result<Vec<_>, _>>()
            })
            .transpose()?
            .unwrap_or_default();

        if !images.is_empty() {
            if reference_image_field == "input_image" {
                // input_image 只接受 URL 或纯 base64(不含 data: 前缀)。
                let normalized = images
                    .into_iter()
                    .map(|image| {
                        image
                            .strip_prefix("data:")
                            .and_then(|rest| rest.split_once(',').map(|(_, base64_part)| base64_part.to_string()))
                            .unwrap_or(image)
                    })
                    .collect::<Vec<_>>();
                body["input_image"] = if normalized.len() == 1 {
                    json!(normalized[0])
                } else {
                    json!(normalized)
                };
            } else {
                // image 保持单图兼容；多图使用 images 数组，确保所有上游图片都送达平台。
                body["image"] = json!(images[0]);
                if images.len() > 1 {
                    body["images"] = json!(images);
                }
            }
        }
        Ok(body)
    }

    fn resolve_reference_image_field(extra_params: &Option<HashMap<String, Value>>, api_model: &str) -> &'static str {
        match extra_params
            .as_ref()
            .and_then(|params| params.get("reference_image_field"))
            .and_then(|value| value.as_str())
        {
            Some("input_image") => "input_image",
            Some("image") => "image",
            // 兼容旧调用: 未传配置时沿用 GPT Image 的原有 input_image 行为。
            _ if api_model.to_ascii_lowercase().contains("gpt-image") => "input_image",
            _ => "image",
        }
    }

    fn alternate_reference_image_field(reference_image_field: &str) -> &'static str {
        if reference_image_field == "input_image" {
            "image"
        } else {
            "input_image"
        }
    }

    fn should_retry_with_alternate_reference_field(
        status: reqwest::StatusCode,
        body_text: &str,
        reference_image_count: usize,
    ) -> bool {
        reference_image_count > 0
            && status.as_u16() == 400
            && body_text
                .to_ascii_lowercase()
                .contains("failed to parse request body")
    }

    /// 是否走 Responses API 协议(extra_params.protocol == "responses")。
    /// 部分 gpt-image 中转平台(如 comfly)用 /v1/responses + image_generation tool,
    /// 而非 /v1/images/generations。
    fn is_responses_protocol(extra_params: &Option<HashMap<String, Value>>) -> bool {
        extra_params
            .as_ref()
            .and_then(|params| params.get("protocol"))
            .and_then(|value| value.as_str())
            .map(|value| value.eq_ignore_ascii_case("responses"))
            .unwrap_or(false)
    }

    /// 构造 Responses API 请求体: input_text + input_image + image_generation tool。
    fn build_responses_body(
        api_model: &str,
        prompt: &str,
        aspect_ratio: &str,
        reference_images: Option<&Vec<String>>,
    ) -> Result<Value, AIError> {
        let mut content: Vec<Value> = vec![json!({ "type": "input_text", "text": prompt })];
        if let Some(images) = reference_images {
            for reference in images.iter() {
                if let Some(field) = Self::reference_image_to_image_field(reference)? {
                    content.push(json!({ "type": "input_image", "image_url": field }));
                }
            }
        }
        let action = if reference_images.map_or(false, |images| !images.is_empty()) {
            "edit"
        } else {
            "generate"
        };
        let mut tool = json!({ "type": "image_generation", "action": action });
        tool["size"] = json!(Self::map_gpt_image_size(aspect_ratio));
        Ok(json!({
            "model": api_model,
            "input": [{ "role": "user", "content": content }],
            "tools": [tool],
            "tool_choice": { "type": "image_generation" },
        }))
    }

    /// 解析 Responses 输出: output[] 里 image_generation_call.result(b64/url) 或 image.image_url。
    fn extract_responses_image(payload: &Value) -> Option<String> {
        let output = payload.get("output").and_then(|value| value.as_array())?;
        for item in output {
            if let Some(result) = item.get("result").and_then(|value| value.as_str()) {
                if result.is_empty() {
                    continue;
                }
                if result.starts_with("http://") || result.starts_with("https://") || result.starts_with("data:") {
                    return Some(result.to_string());
                }
                return Some(format!("data:image/png;base64,{}", result));
            }
            if let Some(image_url) = item.get("image_url").and_then(|value| value.as_str()) {
                if !image_url.is_empty() {
                    return Some(image_url.to_string());
                }
            }
            if let Some(content) = item.get("content").and_then(|value| value.as_array()) {
                for part in content {
                    if let Some(image_url) = part.get("image_url").and_then(|value| value.as_str()) {
                        if !image_url.is_empty() {
                            return Some(image_url.to_string());
                        }
                    }
                }
            }
        }
        None
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
        let is_responses = Self::is_responses_protocol(&request.extra_params);
        let reference_image_field = Self::resolve_reference_image_field(&request.extra_params, api_model);
        let reference_image_count = request.reference_images.as_ref().map(|images| images.len()).unwrap_or(0);
        let (endpoint, body) = if is_responses {
            (
                format!("{}/v1/responses", base_url),
                Self::build_responses_body(
                    api_model,
                    &request.prompt,
                    &request.aspect_ratio,
                    request.reference_images.as_ref(),
                )?,
            )
        } else {
            (
                format!("{}/v1/images/generations", base_url),
                Self::build_request_body(
                    api_model,
                    &request.prompt,
                    &request.aspect_ratio,
                    request.reference_images.as_ref(),
                    reference_image_field,
                )?,
            )
        };

        info!(
            "[OpenAI Compatible Request] model: {}, protocol: {}, reference_images: {}, reference_image_field: {}",
            api_model,
            if is_responses { "responses" } else { "images" },
            reference_image_count,
            if is_responses { "input_image" } else { reference_image_field },
        );

        let response = client
            .post(&endpoint)
            .bearer_auth(&api_key)
            .json(&body)
            .send()
            .await?;

        let mut status = response.status();
        // 先读文本, 再尝试 JSON: 4xx/5xx 平台可能返回 HTML/空 body, 避免笼统的 "decoding response body"
        let mut body_text = response.text().await?;
        if !is_responses && Self::should_retry_with_alternate_reference_field(
            status,
            &body_text,
            reference_image_count,
        ) {
            let alternate_field = Self::alternate_reference_image_field(reference_image_field);
            let alternate_body = Self::build_request_body(
                api_model,
                &request.prompt,
                &request.aspect_ratio,
                request.reference_images.as_ref(),
                alternate_field,
            )?;
            info!(
                "[OpenAI Compatible Request] retrying with reference_image_field: {}",
                alternate_field
            );
            let retry_response = client
                .post(&endpoint)
                .bearer_auth(&api_key)
                .json(&alternate_body)
                .send()
                .await?;
            status = retry_response.status();
            body_text = retry_response.text().await?;
        }
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

        if is_responses {
            if let Some(image) = Self::extract_responses_image(&payload) {
                return Ok(image);
            }
            return Err(AIError::TaskFailed(
                "Responses 响应中未找到图片(请确认该平台模型为 image-to-image 变体)".to_string(),
            ));
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
        let reference_image_field = Self::resolve_reference_image_field(&request.extra_params, api_model);
        let body = Self::build_request_body(
            api_model,
            &request.prompt,
            &request.aspect_ratio,
            request.reference_images.as_ref(),
            reference_image_field,
        )?;

        let response = client
            .post(&endpoint)
            .bearer_auth(&api_key)
            .json(&body)
            .send()
            .await?;
        let mut status = response.status();
        let mut body_text = response.text().await?;
        let reference_image_count = request.reference_images.as_ref().map(|images| images.len()).unwrap_or(0);
        if Self::should_retry_with_alternate_reference_field(
            status,
            &body_text,
            reference_image_count,
        ) {
            let alternate_field = Self::alternate_reference_image_field(reference_image_field);
            let alternate_body = Self::build_request_body(
                api_model,
                &request.prompt,
                &request.aspect_ratio,
                request.reference_images.as_ref(),
                alternate_field,
            )?;
            info!(
                "[OpenAI Compatible Request] async retrying with reference_image_field: {}",
                alternate_field
            );
            let retry_response = client
                .post(&endpoint)
                .bearer_auth(&api_key)
                .json(&alternate_body)
                .send()
                .await?;
            status = retry_response.status();
            body_text = retry_response.text().await?;
        }
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

#[cfg(test)]
mod tests {
    use super::OpenAICompatibleProvider;

    #[test]
    fn retries_alternate_reference_field_only_for_request_body_parse_errors() {
        assert!(OpenAICompatibleProvider::should_retry_with_alternate_reference_field(
            reqwest::StatusCode::BAD_REQUEST,
            r#"{"code":400,"message":"failed to parse request body"}"#,
            1,
        ));
        assert!(!OpenAICompatibleProvider::should_retry_with_alternate_reference_field(
            reqwest::StatusCode::BAD_REQUEST,
            "invalid model",
            1,
        ));
        assert!(!OpenAICompatibleProvider::should_retry_with_alternate_reference_field(
            reqwest::StatusCode::BAD_REQUEST,
            "failed to parse request body",
            0,
        ));
    }

    #[test]
    fn builds_generic_image_field_when_configured() {
        let references = vec!["data:image/png;base64,QUJD".to_string()];
        let body = OpenAICompatibleProvider::build_request_body(
            "gpt-image-2",
            "edit the image",
            "1:1",
            Some(&references),
            "image",
        )
        .expect("request body should be built");

        assert_eq!(body["image"], "data:image/png;base64,QUJD");
        assert!(body.get("input_image").is_none());
    }

    #[test]
    fn builds_native_input_image_field_when_configured() {
        let references = vec!["data:image/png;base64,QUJD".to_string()];
        let body = OpenAICompatibleProvider::build_request_body(
            "gpt-image-2",
            "edit the image",
            "1:1",
            Some(&references),
            "input_image",
        )
        .expect("request body should be built");

        assert_eq!(body["input_image"], "QUJD");
        assert!(body.get("image").is_none());
    }

    #[test]
    fn keeps_gpt_image_two_aspect_ratio_for_compatible_platforms() {
        let body = OpenAICompatibleProvider::build_request_body(
            "gpt-image-2-auto",
            "generate a square image",
            "1:1",
            None,
            "image",
        )
        .expect("request body should be built");

        assert_eq!(body["size"], "1024x1024");
        assert_eq!(body["aspect_ratio"], "1:1");
    }

    #[test]
    fn keeps_all_generic_reference_images() {
        let references = vec![
            "data:image/png;base64,QUJD".to_string(),
            "data:image/png;base64,REVG".to_string(),
        ];
        let body = OpenAICompatibleProvider::build_request_body(
            "gpt-image-2",
            "combine both images",
            "1:1",
            Some(&references),
            "image",
        )
        .expect("request body should be built");

        assert_eq!(body["image"], "data:image/png;base64,QUJD");
        assert_eq!(body["images"], serde_json::json!(references));
    }

    #[test]
    fn keeps_all_native_reference_images() {
        let references = vec![
            "data:image/png;base64,QUJD".to_string(),
            "data:image/png;base64,REVG".to_string(),
        ];
        let body = OpenAICompatibleProvider::build_request_body(
            "gpt-image-1",
            "combine both images",
            "1:1",
            Some(&references),
            "input_image",
        )
        .expect("request body should be built");

        assert_eq!(body["input_image"], serde_json::json!(["QUJD", "REVG"]));
    }
}
