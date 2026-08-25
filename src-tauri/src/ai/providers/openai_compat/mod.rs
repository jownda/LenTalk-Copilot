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
use reqwest::multipart::{Form, Part};
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
        // no_proxy(): 不读 HTTP_PROXY/HTTPS_PROXY 环境变量(宿主注入的代理常连不通
        // 国外 AI 平台), 由系统 Clash 透明代理(TUN)接管即可。
        reqwest::Client::builder()
            .http1_only()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(180))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    }

    /// 短超时 client(20s): 用于「验证连接/验证协议/拉取模型」等交互操作,
    /// 避免平台不可达时 UI 长时间卡在"验证中/拉取中"。
    fn build_short_timeout_client() -> reqwest::Client {
        reqwest::Client::builder()
            .http1_only()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    }

    async fn read_response_text(
        response: reqwest::Response,
        context: &str,
    ) -> Result<(reqwest::StatusCode, String), AIError> {
        let status = response.status();
        let upstream_task_id = response
            .headers()
            .get("x-upstream-task-id")
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let request_id = response
            .headers()
            .get("x-request-id")
            .or_else(|| response.headers().get("X-Request-ID"))
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| "unknown".to_string());
        let bytes = match response.bytes().await {
            Ok(bytes) => bytes,
            Err(error) if status.is_success() => {
                if let Some(task_id) = upstream_task_id {
                    // Some relays return the accepted task id in a header but
                    // close a malformed chunked body. Preserve resumability
                    // without submitting the billable request again.
                    return Ok((status, format!(r#"{{"id":"{}"}}"#, task_id)));
                }
                return Err(AIError::TaskFailed(format!(
                    "{} (HTTP {})响应体读取失败: {}。平台可能返回了损坏的压缩或分块响应，request_id={}",
                    context, status, error, request_id
                )));
            }
            Err(error) => {
                return Err(AIError::TaskFailed(format!(
                    "{} (HTTP {})响应体读取失败: {}。平台可能返回了损坏的压缩或分块响应，request_id={}",
                    context, status, error, request_id
                )));
            }
        };
        Ok((status, String::from_utf8_lossy(&bytes).into_owned()))
    }

    /// 从 OpenAI 兼容服务的 /v1/models 拉取模型列表(供「测试链接 / 拉取模型」使用)
    pub async fn fetch_openai_models(
        base_url: &str,
        api_key: &str,
    ) -> Result<Vec<String>, AIError> {
        let client = Self::build_short_timeout_client();
        // base_url 可能已含 /v1(如 ModelScope 推荐地址 https://.../v1), 避免拼出 /v1/v1/models
        let normalized_base = base_url
            .trim_end_matches('/')
            .trim_end_matches("/v1")
            .trim_end_matches('/');
        let endpoint = format!("{}/v1/models", normalized_base);

        let response = client
            .get(&endpoint)
            .bearer_auth(api_key)
            .header("Accept-Encoding", "identity")
            .send()
            .await?;
        // 先读文本再尝试 JSON: 部分平台 /v1/models 返回非标准 JSON/HTML,
        // 直接 .json() 会抛 "error decoding response body"
        let (status, body_text) = Self::read_response_text(response, "/v1/models").await?;
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
            return Err(AIError::TaskFailed(format!("HTTP {}: {}", status, message)));
        }
        if payload.is_null() {
            return Err(AIError::TaskFailed(format!(
                "/v1/models 返回非 JSON 响应: {}",
                body_text.chars().take(200).collect::<String>()
            )));
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

    /// 纯文本 Chat Completion: 供提示词优化等纯文本任务使用。
    pub async fn chat_completion(
        base_url: &str,
        api_key: &str,
        model: &str,
        messages: &[(String, serde_json::Value)],
    ) -> Result<String, AIError> {
        let client = Self::build_client();
        let normalized_base = base_url
            .trim_end_matches('/')
            .trim_end_matches("/v1")
            .trim_end_matches('/');
        let endpoint = format!("{}/v1/chat/completions", normalized_base);
        let message_payload: Vec<Value> = messages
            .iter()
            .map(|(role, content)| json!({ "role": role, "content": content }))
            .collect();
        let body = json!({
            "model": model,
            "messages": message_payload,
            "temperature": 0.4,
        });

        let response = client
            .post(&endpoint)
            .bearer_auth(api_key)
            .header("Accept-Encoding", "identity")
            .json(&body)
            .send()
            .await?;
        let (status, body_text) =
            Self::read_response_text(response, "/v1/chat/completions").await?;
        let payload: Value = serde_json::from_str(&body_text).unwrap_or(Value::Null);

        if !status.is_success() {
            let message = payload
                .get("error")
                .and_then(|value| value.get("message"))
                .and_then(|value| value.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| {
                    if body_text.trim().is_empty() {
                        format!("HTTP {} 空响应体", status)
                    } else {
                        body_text.chars().take(400).collect()
                    }
                });
            return Err(AIError::TaskFailed(format!("HTTP {}: {}", status, message)));
        }

        payload
            .get("choices")
            .and_then(|value| value.as_array())
            .and_then(|choices| choices.first())
            .and_then(|choice| choice.get("message"))
            .and_then(|message| message.get("content"))
            .and_then(|content| content.as_str())
            .map(str::to_string)
            .ok_or_else(|| {
                AIError::TaskFailed("chat completion 响应缺少 choices[0].message.content".into())
            })
    }

    /// 仅检查 Base URL 是否可达(不依赖 API Key,供「验证链接」使用)
    pub async fn check_url_reachable(base_url: &str) -> Result<u16, AIError> {
        let client = Self::build_short_timeout_client();
        let normalized = base_url
            .trim_end_matches('/')
            .trim_end_matches("/v1")
            .trim_end_matches('/');
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

    /// Native GPT Image parameter mode rejects a standalone aspect_ratio field.
    fn uses_native_image_parameters(api_model: &str) -> bool {
        let normalized = api_model.trim().to_ascii_lowercase();
        normalized.ends_with("-native")
            || normalized.ends_with("-n")
            || normalized.contains("gpt-image-1")
            || normalized.contains("dall-e")
    }

    fn parse_aspect_ratio(aspect_ratio: &str) -> Option<(u32, u32)> {
        let (width, height) = aspect_ratio.trim().split_once(':')?;
        let width = width.trim().parse::<u32>().ok()?;
        let height = height.trim().parse::<u32>().ok()?;
        (width > 0 && height > 0).then_some((width, height))
    }

    fn round_to_multiple_of_16(value: f64) -> u32 {
        (((value / 16.0).round() as u32).max(1)) * 16
    }

    /// Map the UI resolution tier to an upstream pixel size.
    fn map_requested_image_size(api_model: &str, resolution: &str, aspect_ratio: &str) -> String {
        let trimmed_resolution = resolution.trim();
        if trimmed_resolution.contains('x')
            && trimmed_resolution
                .split_once('x')
                .map(|(width, height)| {
                    width.parse::<u32>().is_ok() && height.parse::<u32>().is_ok()
                })
                .unwrap_or(false)
        {
            return trimmed_resolution.to_string();
        }

        if trimmed_resolution.eq_ignore_ascii_case("1K") {
            return Self::map_gpt_image_size(aspect_ratio).to_string();
        }

        let target_long_edge = if trimmed_resolution.eq_ignore_ascii_case("4K") {
            3840u32
        } else if trimmed_resolution.eq_ignore_ascii_case("2K") {
            2048u32
        } else {
            return Self::map_gpt_image_size(aspect_ratio).to_string();
        };
        let (ratio_width, ratio_height) = Self::parse_aspect_ratio(aspect_ratio).unwrap_or((1, 1));
        let (mut width, mut height) = if ratio_width >= ratio_height {
            (
                target_long_edge,
                Self::round_to_multiple_of_16(
                    target_long_edge as f64 * ratio_height as f64 / ratio_width as f64,
                ),
            )
        } else {
            (
                Self::round_to_multiple_of_16(
                    target_long_edge as f64 * ratio_width as f64 / ratio_height as f64,
                ),
                target_long_edge,
            )
        };

        if Self::uses_native_image_parameters(api_model) {
            const MAX_NATIVE_PIXELS: f64 = 8_294_400.0;
            let pixels = width as f64 * height as f64;
            if pixels > MAX_NATIVE_PIXELS {
                let scale = (MAX_NATIVE_PIXELS / pixels).sqrt();
                width = (((width as f64 * scale) / 16.0).floor() as u32).max(1) * 16;
                height = (((height as f64 * scale) / 16.0).floor() as u32).max(1) * 16;
            }
        }

        format!("{}x{}", width, height)
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
        resolution: &str,
        aspect_ratio: &str,
        reference_images: Option<&Vec<String>>,
        reference_image_field: &str,
        reference_image_encoding: &str,
    ) -> Result<Value, AIError> {
        let is_gpt_image = api_model.to_ascii_lowercase().contains("gpt-image");
        let mut body = json!({
            "model": api_model,
            "prompt": prompt,
            "n": 1,
        });
        body["size"] = json!(Self::map_requested_image_size(
            api_model,
            resolution,
            aspect_ratio,
        ));
        if is_gpt_image {
            body["output_format"] = json!("png");
            // gpt-image-2-* 中转模型会读取该字段；仅传 OpenAI 的 size 时会回退为服务端默认横幅。
            if api_model.to_ascii_lowercase().contains("gpt-image-2")
                && !Self::uses_native_image_parameters(api_model)
            {
                body["aspect_ratio"] = json!(aspect_ratio);
            }
        } else {
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
                    .map(|image| Self::encode_reference_image(image, reference_image_encoding))
                    .collect::<Vec<_>>();
                body["input_image"] = if normalized.len() == 1 {
                    json!(normalized[0])
                } else {
                    json!(normalized)
                };
            } else {
                // image 保持单图兼容；多图使用 images 数组，确保所有上游图片都送达平台。
                let encoded_images = images
                    .into_iter()
                    .map(|image| Self::encode_reference_image(image, reference_image_encoding))
                    .collect::<Vec<_>>();
                body["image"] = json!(encoded_images[0]);
                if encoded_images.len() > 1 {
                    body["images"] = json!(encoded_images);
                }
            }
        }
        Ok(body)
    }

    fn build_apimart_request_body(
        api_model: &str,
        prompt: &str,
        resolution: &str,
        aspect_ratio: &str,
        reference_images: Option<&Vec<String>>,
    ) -> Result<Value, AIError> {
        let images = reference_images
            .map(|references| {
                references
                    .iter()
                    .filter_map(|reference| Self::reference_image_to_image_field(reference).transpose())
                    .collect::<Result<Vec<_>, _>>()
            })
            .transpose()?
            .unwrap_or_default();
        let mut body = json!({
            "model": api_model,
            "prompt": prompt,
            "n": 1,
            "size": Self::map_requested_image_size(api_model, resolution, aspect_ratio),
            "aspect_ratio": aspect_ratio,
            "official_fallback": false,
        });
        if !images.is_empty() {
            body["image_urls"] = json!(images);
        }
        Ok(body)
    }

    fn resolve_image_transport(
        extra_params: &Option<HashMap<String, Value>>,
        _api_model: &str,
        reference_image_count: usize,
    ) -> &'static str {
        match extra_params
            .as_ref()
            .and_then(|params| params.get("image_transport"))
            .and_then(|value| value.as_str())
        {
            Some("generations_json") => "generations_json",
            Some("edits_multipart") => "edits_multipart",
            Some("apimart_json") => "apimart_json",
            // 默认把所有带参考图的图片请求视作图生图，使用 OpenAI 标准的
            // /v1/images/edits multipart 上传。仅无参考图才走文生图 generations。
            // 对不兼容 edits 的中转平台，可在设置中显式改为 JSON/APIMart 适配器。
            _ if reference_image_count > 0 => "edits_multipart",
            _ => "generations_json",
        }
    }

    async fn build_edits_form(
        api_model: &str,
        prompt: &str,
        resolution: &str,
        aspect_ratio: &str,
        reference_images: Option<&Vec<String>>,
    ) -> Result<Form, AIError> {
        let mut form = Form::new()
            .text("model", api_model.to_string())
            .text("prompt", prompt.to_string())
            .text(
                "size",
                Self::map_requested_image_size(api_model, resolution, aspect_ratio),
            )
            .text("n", "1");
        if !Self::uses_native_image_parameters(api_model) {
            form = form.text("aspect_ratio", aspect_ratio.to_string());
        }

        if let Some(images) = reference_images {
            for (index, reference) in images.iter().enumerate() {
                if let Some(part) = Self::reference_image_to_multipart_part(reference, index).await? {
                    form = form.part("image", part);
                }
            }
        }
        Ok(form)
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

    fn resolve_reference_image_encoding(
        extra_params: &Option<HashMap<String, Value>>,
        reference_image_field: &str,
    ) -> &'static str {
        match extra_params
            .as_ref()
            .and_then(|params| params.get("reference_image_encoding"))
            .and_then(|value| value.as_str())
        {
            Some(value) if value.eq_ignore_ascii_case("raw_base64") => "raw_base64",
            Some(value) if value.eq_ignore_ascii_case("data_url") => "data_url",
            Some(value) if value.eq_ignore_ascii_case("url") => "url",
            _ if reference_image_field == "input_image" => "raw_base64",
            _ => "data_url",
        }
    }

    fn encode_reference_image(image: String, encoding: &str) -> String {
        if encoding != "raw_base64" {
            return image;
        }
        image
            .strip_prefix("data:")
            .and_then(|rest| rest.split_once(',').map(|(_, base64_part)| base64_part.to_string()))
            .unwrap_or(image)
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
        if reference_image_count == 0 {
            return false;
        }

        let normalized_body = body_text.to_ascii_lowercase();
        // 部分 OpenAI 兼容中转会把不支持的 image / input_image 字段错误
        // 错误地返回为 404 Not Found。请求未被受理时切换字段重试一次，
        // 使 GPT Image 的多参考图编辑可以兼容这类实现。
        (status.as_u16() == 400 && normalized_body.contains("failed to parse request body"))
            || (status == reqwest::StatusCode::NOT_FOUND && normalized_body.contains("not found"))
    }

    /// 解析图片接口协议: images(/v1/images/generations) | responses(/v1/responses) | chat(/v1/chat/completions)
    fn resolve_image_protocol(extra_params: &Option<HashMap<String, Value>>) -> &'static str {
        match extra_params
            .as_ref()
            .and_then(|params| params.get("protocol"))
            .and_then(|value| value.as_str())
        {
            Some(value) if value.eq_ignore_ascii_case("responses") => "responses",
            Some(value)
                if value.eq_ignore_ascii_case("chat")
                    || value.eq_ignore_ascii_case("chat/completions")
                    || value.eq_ignore_ascii_case("chat_completions") => "chat",
            _ => "images",
        }
    }

    /// WGSPAI 的 gpt-image-2-2k 是 gpt-image-2 的 2K 档变体: OpenAI 只通过
    /// Responses API(image_generation tool)提供该模型生成能力, 走
    /// /v1/chat/completions 或 /v1/images/generations 都会得到 404。
    /// 这是平台专用兼容分支, 其它自定义平台不受影响。
    fn uses_wgspai_responses(provider_id: &str, api_model: &str) -> bool {
        provider_id == "custom:wgspai" && api_model.to_ascii_lowercase().contains("gpt-image")
    }

    /// 构造 Chat Completions 图像请求体: messages + text + image_url(参考图)。
    /// 常见兼容实现: content 数组含 {type:text} 与 {type:image_url, image_url:{url}},
    /// 部分平台要求顶层 response_format={"type":"image"} 或 n=1。
    fn build_chat_body(
        api_model: &str,
        prompt: &str,
        reference_images: Option<&Vec<String>>,
    ) -> Result<Value, AIError> {
        let mut content: Vec<Value> = vec![json!({ "type": "text", "text": prompt })];
        if let Some(images) = reference_images {
            for reference in images.iter() {
                if let Some(image) = Self::reference_image_to_image_field(reference)? {
                    // 参考图: data URL / http URL 原样; 本地路径已转 data URL。
                    content.push(json!({
                        "type": "image_url",
                        "image_url": { "url": image },
                    }));
                }
            }
        }
        Ok(json!({
            "model": api_model,
            "messages": [{
                "role": "user",
                "content": content,
            }],
            "n": 1,
            "response_format": { "type": "image" },
        }))
    }

    /// 构造 Responses API 请求体: input_text + input_image + image_generation tool。
    async fn build_responses_body(
        api_model: &str,
        prompt: &str,
        resolution: &str,
        aspect_ratio: &str,
        reference_images: Option<&Vec<String>>,
    ) -> Result<Value, AIError> {
        let mut content: Vec<Value> = vec![json!({ "type": "input_text", "text": prompt })];
        if let Some(images) = reference_images {
            for reference in images.iter() {
                if let Some(base64_data) = Self::reference_image_to_responses_base64(reference).await? {
                    // comfly 等 responses 平台期望纯 base64(无 data: 前缀), URL 需下载转 base64
                    content.push(json!({ "type": "input_image", "image_url": base64_data }));
                }
            }
        }
        let action = if reference_images.map_or(false, |images| !images.is_empty()) {
            "edit"
        } else {
            "generate"
        };
        let mut tool = json!({ "type": "image_generation", "action": action });
        tool["size"] = json!(Self::map_requested_image_size(
            api_model,
            resolution,
            aspect_ratio,
        ));
        Ok(json!({
            "model": api_model,
            "input": [{ "role": "user", "content": content }],
            "tools": [tool],
            "tool_choice": { "type": "image_generation" },
        }))
    }

    /// Responses 协议的 input_image.image_url: comfly 等平台期望纯 base64
    /// (直接把值当 base64 解码)。URL 需下载转 base64, data: 去前缀, 本地路径读文件。
    async fn reference_image_to_responses_base64(source: &str) -> Result<Option<String>, AIError> {
        let trimmed = source.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }
        if trimmed.starts_with("data:") {
            // 去掉 data:image/png;base64, 前缀, 只留纯 base64
            if let Some((_, base64_part)) = trimmed.split_once(',') {
                return Ok(Some(base64_part.to_string()));
            }
            return Ok(Some(trimmed.to_string()));
        }
        if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            let client = Self::build_short_timeout_client();
            let response = client
                .get(trimmed)
                .send()
                .await
                .map_err(|error| AIError::TaskFailed(format!("下载参考图失败: {error}")))?;
            let bytes = response
                .bytes()
                .await
                .map_err(|error| AIError::TaskFailed(format!("读取参考图失败: {error}")))?;
            return Ok(Some(STANDARD.encode(bytes)));
        }
        // 本地路径/asset: 读文件转 base64
        let path = if trimmed.starts_with("file://") {
            PathBuf::from(Self::decode_file_url_path(trimmed))
        } else {
            PathBuf::from(trimmed)
        };
        let bytes = std::fs::read(&path).map_err(|error| {
            AIError::InvalidRequest(format!(
                "读取参考图失败 \"{}\": {}",
                path.to_string_lossy(),
                error
            ))
        })?;
        Ok(Some(STANDARD.encode(bytes)))
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

    fn extract_url_from_chat_content(content: &str) -> Option<String> {
        let start = content.find("https://").or_else(|| content.find("http://"))?;
        let candidate = &content[start..];
        let end = candidate
            .find(|character: char| character.is_whitespace() || matches!(character, ')' | ']' | '}' | '"' | '\'' | ','))
            .unwrap_or(candidate.len());
        let url = candidate[..end].trim();
        (!url.is_empty()).then(|| url.to_string())
    }

    /// 兼容聊天式图像响应:结果通常位于 assistant content 的 Markdown/纯 URL 中。
    fn extract_chat_image(payload: &Value) -> Option<String> {
        let choices = payload.get("choices")?.as_array()?;
        for choice in choices {
            let message = choice.get("message")?;
            if let Some(image_url) = message.get("image_url").and_then(|value| value.as_str()) {
                if !image_url.is_empty() {
                    return Some(image_url.to_string());
                }
            }
            let Some(content) = message.get("content") else {
                continue;
            };
            if let Some(text) = content.as_str() {
                if let Some(url) = Self::extract_url_from_chat_content(text) {
                    return Some(url);
                }
                continue;
            }
            if let Some(parts) = content.as_array() {
                for part in parts {
                    if let Some(image_url) = part
                        .get("image_url")
                        .and_then(|value| value.get("url").or(Some(value)))
                        .and_then(|value| value.as_str())
                    {
                        if !image_url.is_empty() {
                            return Some(image_url.to_string());
                        }
                    }
                    if let Some(text) = part.get("text").and_then(|value| value.as_str()) {
                        if let Some(url) = Self::extract_url_from_chat_content(text) {
                            return Some(url);
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
        for container in ["data", "result", "task", "job"] {
            if let Some(value) = payload.get(container) {
                if let Some(image) = Self::extract_image_data_if_present(value) {
                    return Some(image);
                }
            }
        }
        Self::extract_responses_image(payload)
            .or_else(|| Self::extract_chat_image(payload))
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
        for container in ["data", "task", "result", "job"] {
            if let Some(value) = payload.get(container) {
                if let Some(task_id) = Self::extract_task_id(value) {
                    return Some(task_id);
                }
            }
        }
        None
    }

    fn extract_query_url(payload: &Value) -> Option<String> {
        for key in [
            "query_url", "queryUrl", "status_url", "statusUrl", "poll_url", "pollUrl",
            "result_url", "resultUrl",
        ] {
            if let Some(url) = payload.get(key).and_then(Value::as_str) {
                if url.starts_with("http://") || url.starts_with("https://") || url.starts_with('/') {
                    return Some(url.to_string());
                }
            }
        }
        for container in ["data", "task", "result", "job"] {
            if let Some(value) = payload.get(container) {
                if let Some(url) = Self::extract_query_url(value) {
                    return Some(url);
                }
            }
        }
        None
    }

    fn extract_status(payload: &Value) -> Option<String> {
        for key in ["status", "state", "task_status", "taskStatus", "gen_status", "phase"] {
            if let Some(status) = payload.get(key).and_then(Value::as_str) {
                return Some(status.to_string());
            }
        }
        for container in ["data", "result", "task", "job"] {
            if let Some(value) = payload.get(container) {
                if let Some(status) = Self::extract_status(value) {
                    return Some(status);
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

    async fn reference_image_to_multipart_part(
        source: &str,
        index: usize,
    ) -> Result<Option<Part>, AIError> {
        let trimmed = source.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }

        let (bytes, mime) = if let Some(data_url) = trimmed.strip_prefix("data:") {
            let (metadata, encoded) = data_url.split_once(',').ok_or_else(|| {
                AIError::InvalidRequest("参考图 Data URL 格式不正确".to_string())
            })?;
            let mime = metadata
                .split(';')
                .next()
                .filter(|value| value.starts_with("image/"))
                .unwrap_or("image/png")
                .to_string();
            let bytes = if metadata.contains(";base64") {
                STANDARD.decode(encoded).map_err(|error| {
                    AIError::InvalidRequest(format!("参考图 Base64 解码失败: {error}"))
                })?
            } else {
                urlencoding::decode(encoded)
                    .map(|value| value.into_owned().into_bytes())
                    .map_err(|error| AIError::InvalidRequest(format!("参考图 URL 解码失败: {error}")))?
            };
            (bytes, mime)
        } else if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            let response = Self::build_short_timeout_client()
                .get(trimmed)
                .send()
                .await
                .map_err(|error| AIError::TaskFailed(format!("下载参考图失败: {error}")))?
                .error_for_status()
                .map_err(|error| AIError::TaskFailed(format!("下载参考图失败: {error}")))?;
            let mime = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.split(';').next())
                .filter(|value| value.starts_with("image/"))
                .unwrap_or("image/png")
                .to_string();
            let bytes = response
                .bytes()
                .await
                .map_err(|error| AIError::TaskFailed(format!("读取参考图失败: {error}")))?
                .to_vec();
            (bytes, mime)
        } else {
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
            let bytes = std::fs::read(&path).map_err(|error| {
                AIError::InvalidRequest(format!("读取参考图失败 \"{}\": {}", path.display(), error))
            })?;
            (bytes, Self::guess_image_mime(&path.to_string_lossy()).to_string())
        };

        if bytes.is_empty() {
            return Ok(None);
        }
        let extension = match mime.as_str() {
            "image/jpeg" => "jpg",
            "image/webp" => "webp",
            "image/gif" => "gif",
            _ => "png",
        };
        let part = Part::bytes(bytes)
            .file_name(format!("reference-{}.{}", index + 1, extension))
            .mime_str(&mime)
            .map_err(|error| AIError::InvalidRequest(format!("参考图 MIME 类型无效: {error}")))?;
        Ok(Some(part))
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
        if let Some(image) = Self::extract_chat_image(payload) {
            return Ok(image);
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

    fn supports_task_resume(&self) -> bool {
        // The async request mode is implemented by submit_task/poll_task. The
        // registry must opt into that branch or every custom image request is
        // treated as an in-memory, non-resumable job.
        true
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
        // base_url 可能已含 /v1(如 ModelScope 推荐地址), 归一化避免拼出 /v1/v1/...
        let base_url = base_url
            .trim_end_matches('/')
            .trim_end_matches("/v1")
            .trim_end_matches('/')
            .to_string();
        let client = Self::build_client();
        // WGSPAI gpt-image 强制走 Responses API(该平台只通过 image_generation tool 提供能力)
        let force_wgspai_responses = Self::uses_wgspai_responses(provider_id, api_model);
        let image_protocol = Self::resolve_image_protocol(&request.extra_params);
        let is_responses = image_protocol == "responses" || force_wgspai_responses;
        let is_chat = image_protocol == "chat";
        let reference_image_field = Self::resolve_reference_image_field(&request.extra_params, api_model);
        let reference_image_encoding = Self::resolve_reference_image_encoding(&request.extra_params, reference_image_field);
        let reference_image_count = request.reference_images.as_ref().map(|images| images.len()).unwrap_or(0);
        let image_transport = Self::resolve_image_transport(
            &request.extra_params,
            api_model,
            reference_image_count,
        );
        let endpoint = if is_responses {
            format!("{}/v1/responses", base_url)
        } else if is_chat {
            format!("{}/v1/chat/completions", base_url)
        } else if image_transport == "edits_multipart" && reference_image_count > 0 {
            format!("{}/v1/images/edits", base_url)
        } else {
            format!("{}/v1/images/generations", base_url)
        };
        let response = if is_responses {
            let body = Self::build_responses_body(
                    api_model,
                    &request.prompt,
                    &request.size,
                    &request.aspect_ratio,
                    request.reference_images.as_ref(),
                )
                .await?;
            client.post(&endpoint)
                .bearer_auth(&api_key)
                .header("Accept-Encoding", "identity")
                .json(&body)
                .send()
                .await?
        } else if is_chat {
            let body = Self::build_chat_body(
                    api_model,
                    &request.prompt,
                    request.reference_images.as_ref(),
                )?;
            client.post(&endpoint)
                .bearer_auth(&api_key)
                .header("Accept-Encoding", "identity")
                .json(&body)
                .send()
                .await?
        } else if image_transport == "edits_multipart" && reference_image_count > 0 {
            let form = Self::build_edits_form(
                api_model,
                &request.prompt,
                &request.size,
                &request.aspect_ratio,
                request.reference_images.as_ref(),
            )
            .await?;
            client.post(&endpoint)
                .bearer_auth(&api_key)
                .header("Accept-Encoding", "identity")
                .multipart(form)
                .send()
                .await?
        } else {
            let body = if image_transport == "apimart_json" {
                Self::build_apimart_request_body(
                    api_model,
                    &request.prompt,
                    &request.size,
                    &request.aspect_ratio,
                    request.reference_images.as_ref(),
                )?
            } else {
                Self::build_request_body(
                    api_model,
                    &request.prompt,
                    &request.size,
                    &request.aspect_ratio,
                    request.reference_images.as_ref(),
                    reference_image_field,
                    reference_image_encoding,
                )?
            };
            client.post(&endpoint)
                .bearer_auth(&api_key)
                .header("Accept-Encoding", "identity")
                .json(&body)
                .send()
                .await?
        };
        let active_protocol = if is_responses { "responses" } else if is_chat { "chat" } else { "images" };

        info!(
            "[OpenAI Compatible Request] model: {}, protocol: {}, transport: {}, reference_images: {}, reference_image_field: {}",
            api_model,
            active_protocol,
            image_transport,
            reference_image_count,
            if is_responses { "image_url" } else if is_chat { "image_url" } else { reference_image_field },
        );

        // 先读文本, 再尝试 JSON: 4xx/5xx 平台可能返回 HTML/空 body, 避免笼统的 "decoding response body"
        let (mut status, mut body_text) = Self::read_response_text(response, "自定义平台图片请求").await?;

        // WGSPAI gpt-image: 部分渠道的 Responses 路由未挂载时返回 404, 降级到
        // Images API + input_image 重试一次(该平台模型在 images 通道也可能可用)。
        if force_wgspai_responses
            && status == reqwest::StatusCode::NOT_FOUND
            && body_text.to_ascii_lowercase().contains("not found")
        {
            let fallback_body = Self::build_request_body(
                api_model,
                &request.prompt,
                &request.size,
                &request.aspect_ratio,
                request.reference_images.as_ref(),
                "input_image",
                "raw_base64",
            )?;
            info!(
                "[OpenAI Compatible Request] WGSPAI gpt-image Responses 404, falling back to /v1/images/generations"
            );
            let fallback_response = client
                .post(format!("{}/v1/images/generations", base_url))
                .bearer_auth(&api_key)
                .header("Accept-Encoding", "identity")
                .json(&fallback_body)
                .send()
                .await?;
            (status, body_text) = Self::read_response_text(fallback_response, "自定义平台图片降级请求").await?;
        }

        // 仅 images 协议做参考图字段重试; responses/chat 协议的请求体字段固定。
        if image_protocol == "images" && Self::should_retry_with_alternate_reference_field(
            status,
            &body_text,
            reference_image_count,
        ) {
            let alternate_field = Self::alternate_reference_image_field(reference_image_field);
            let alternate_body = Self::build_request_body(
                api_model,
                &request.prompt,
                &request.size,
                &request.aspect_ratio,
                request.reference_images.as_ref(),
                alternate_field,
                Self::resolve_reference_image_encoding(&request.extra_params, alternate_field),
            )?;
            info!(
                "[OpenAI Compatible Request] retrying with reference_image_field: {}",
                alternate_field
            );
            let retry_response = client
                .post(&endpoint)
                .bearer_auth(&api_key)
                .header("Accept-Encoding", "identity")
                .json(&alternate_body)
                .send()
                .await?;
            (status, body_text) = Self::read_response_text(retry_response, "自定义平台图片重试请求").await?;
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
                "自定义平台请求失败 (HTTP {} {}): {} [endpoint: {}]",
                status,
                status.canonical_reason().unwrap_or(""),
                message,
                endpoint
            )));
        }
        if payload.is_null() {
            return Err(AIError::TaskFailed(format!(
                "自定义平台响应不是有效 JSON: {}",
                body_text.chars().take(300).collect::<String>()
            )));
        }

        if active_protocol == "responses" {
            if let Some(image) = Self::extract_responses_image(&payload) {
                return Ok(image);
            }
            return Err(AIError::TaskFailed(
                "Responses 响应中未找到图片(请确认该平台模型为 image-to-image 变体)".to_string(),
            ));
        }

        if active_protocol == "chat" {
            if let Some(image) = Self::extract_chat_image(&payload) {
                return Ok(image);
            }
            return Err(AIError::TaskFailed(
                "Chat Completions 响应中未找到图片(请确认模型支持图像生成且提示词已要求返回图片)".to_string(),
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
        let base_url = base_url
            .trim_end_matches('/')
            .trim_end_matches("/v1")
            .trim_end_matches('/')
            .to_string();
        let client = Self::build_client();
        // WGSPAI gpt-image 强制走 Responses API(该平台只通过 image_generation tool 提供能力)
        let force_wgspai_responses = Self::uses_wgspai_responses(provider_id, api_model);
        let image_protocol = Self::resolve_image_protocol(&request.extra_params);
        let is_responses = image_protocol == "responses" || force_wgspai_responses;
        let is_chat = image_protocol == "chat";
        let reference_image_field = Self::resolve_reference_image_field(&request.extra_params, api_model);
        let reference_image_encoding = Self::resolve_reference_image_encoding(&request.extra_params, reference_image_field);
        let reference_image_count = request.reference_images.as_ref().map(|images| images.len()).unwrap_or(0);
        let image_transport = Self::resolve_image_transport(
            &request.extra_params,
            api_model,
            reference_image_count,
        );
        let endpoint = if is_responses {
            format!("{}/v1/responses", base_url)
        } else if is_chat {
            format!("{}/v1/chat/completions", base_url)
        } else if image_transport == "edits_multipart" && reference_image_count > 0 {
            format!("{}/v1/images/edits", base_url)
        } else {
            format!("{}/v1/images/generations", base_url)
        };
        let response = if is_responses {
            let body = Self::build_responses_body(
                    api_model,
                    &request.prompt,
                    &request.size,
                    &request.aspect_ratio,
                    request.reference_images.as_ref(),
                )
                .await?;
            client.post(&endpoint)
                .bearer_auth(&api_key)
                .header("Accept-Encoding", "identity")
                .json(&body)
                .send()
                .await?
        } else if is_chat {
            let body = Self::build_chat_body(
                    api_model,
                    &request.prompt,
                    request.reference_images.as_ref(),
                )?;
            client.post(&endpoint)
                .bearer_auth(&api_key)
                .header("Accept-Encoding", "identity")
                .json(&body)
                .send()
                .await?
        } else if image_transport == "edits_multipart" && reference_image_count > 0 {
            let form = Self::build_edits_form(
                api_model,
                &request.prompt,
                &request.size,
                &request.aspect_ratio,
                request.reference_images.as_ref(),
            )
            .await?;
            client.post(&endpoint)
                .bearer_auth(&api_key)
                .header("Accept-Encoding", "identity")
                .multipart(form)
                .send()
                .await?
        } else {
            let body = if image_transport == "apimart_json" {
                Self::build_apimart_request_body(
                    api_model,
                    &request.prompt,
                    &request.size,
                    &request.aspect_ratio,
                    request.reference_images.as_ref(),
                )?
            } else {
                Self::build_request_body(
                    api_model,
                    &request.prompt,
                    &request.size,
                    &request.aspect_ratio,
                    request.reference_images.as_ref(),
                    reference_image_field,
                    reference_image_encoding,
                )?
            };
            client.post(&endpoint)
                .bearer_auth(&api_key)
                .header("Accept-Encoding", "identity")
                .json(&body)
                .send()
                .await?
        };
        let (mut status, mut body_text) = Self::read_response_text(response, "自定义平台异步提交").await?;

        // WGSPAI gpt-image: Responses 404 时降级到 Images API + input_image 重试一次。
        if force_wgspai_responses
            && status == reqwest::StatusCode::NOT_FOUND
            && body_text.to_ascii_lowercase().contains("not found")
        {
            let fallback_body = Self::build_request_body(
                api_model,
                &request.prompt,
                &request.size,
                &request.aspect_ratio,
                request.reference_images.as_ref(),
                "input_image",
                "raw_base64",
            )?;
            info!(
                "[OpenAI Compatible Request] async: WGSPAI gpt-image Responses 404, falling back to /v1/images/generations"
            );
            let fallback_response = client
                .post(format!("{}/v1/images/generations", base_url))
                .bearer_auth(&api_key)
                .header("Accept-Encoding", "identity")
                .json(&fallback_body)
                .send()
                .await?;
            (status, body_text) = Self::read_response_text(fallback_response, "自定义平台异步降级请求").await?;
        }

        // 仅 images 协议做参考图字段重试; responses/chat 协议的请求体字段固定。
        if image_protocol == "images" && image_transport == "generations_json" && Self::should_retry_with_alternate_reference_field(
            status,
            &body_text,
            reference_image_count,
        ) {
            let alternate_field = Self::alternate_reference_image_field(reference_image_field);
            let alternate_body = Self::build_request_body(
                api_model,
                &request.prompt,
                &request.size,
                &request.aspect_ratio,
                request.reference_images.as_ref(),
                alternate_field,
                Self::resolve_reference_image_encoding(&request.extra_params, alternate_field),
            )?;
            info!(
                "[OpenAI Compatible Request] async retrying with reference_image_field: {}",
                alternate_field
            );
            let retry_response = client
                .post(&endpoint)
                .bearer_auth(&api_key)
                .header("Accept-Encoding", "identity")
                .json(&alternate_body)
                .send()
                .await?;
            (status, body_text) = Self::read_response_text(retry_response, "自定义平台异步重试").await?;
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
                    "provider_id": provider_id,
                    "query_url": Self::extract_query_url(&payload),
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
        // New jobs resolve the key from the in-memory provider registry. Older
        // jobs may still contain api_key in metadata, so keep a compatibility
        // fallback while they age out.
        let provider_id = handle
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("provider_id"))
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        let api_key = self
            .resolve_custom_key(provider_id.as_str())
            .await
            .or_else(|| {
                handle
                    .metadata
                    .as_ref()
                    .and_then(|metadata| metadata.get("api_key"))
                    .and_then(|value| value.as_str())
                    .map(String::from)
            })
            .unwrap_or_default();
        let task_id = &handle.task_id;
        if base_url.is_empty() {
            return Err(AIError::InvalidRequest("异步任务缺少基础地址".into()));
        }

        let mut candidates: Vec<(reqwest::Method, String)> = Vec::new();
        if let Some(query_url) = handle
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("query_url"))
            .and_then(Value::as_str)
        {
            let resolved_query_url = query_url.replace("{task_id}", task_id).replace("{id}", task_id);
            let resolved_query_url = if resolved_query_url.starts_with('/') {
                format!("{}{}", base_url, resolved_query_url)
            } else {
                resolved_query_url
            };
            candidates.push((reqwest::Method::GET, resolved_query_url));
        }
        candidates.extend([
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
            (reqwest::Method::GET, format!("{}/v1/tasks/{}", base_url, task_id)),
            (reqwest::Method::GET, format!("{}/v1/tasks/{}/status", base_url, task_id)),
            (reqwest::Method::POST, format!("{}/v1/tasks/{}/status", base_url, task_id)),
            (reqwest::Method::GET, format!("{}/v1/task/{}", base_url, task_id)),
            (reqwest::Method::GET, format!("{}/v1/jobs/{}", base_url, task_id)),
            (reqwest::Method::GET, format!("{}/v1/jobs/{}/status", base_url, task_id)),
            (reqwest::Method::POST, format!("{}/v1/jobs/{}/status", base_url, task_id)),
            (reqwest::Method::GET, format!("{}/v1/requests/{}", base_url, task_id)),
            (reqwest::Method::GET, format!("{}/v1/async/{}", base_url, task_id)),
            (reqwest::Method::GET, format!("{}/v1/async/tasks/{}", base_url, task_id)),
            (reqwest::Method::GET, format!("{}/v1/images/{}", base_url, task_id)),
            (reqwest::Method::GET, format!("{}/v1/generations/{}", base_url, task_id)),
        ]);

        let client = Self::build_client();
        for (method, url) in candidates {
            let mut request = client.request(method, &url);
            if !api_key.is_empty() {
                request = request.bearer_auth(&api_key);
            }
            request = request.header("Accept-Encoding", "identity");
            let response = request.send().await?;
            let status_code = response.status();
            if status_code == reqwest::StatusCode::NOT_FOUND
                || status_code == reqwest::StatusCode::METHOD_NOT_ALLOWED
            {
                continue;
            }
            let (_, body_text) = Self::read_response_text(response, "自定义平台任务查询").await?;
            let payload: Value = serde_json::from_str(&body_text).unwrap_or(Value::Null);

            if let Some(image) = Self::extract_image_data_if_present(&payload) {
                return Ok(ProviderTaskPollResult::Succeeded(image));
            }

            let status_text = Self::extract_status(&payload).unwrap_or_default();
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
            if lower.contains("queue")
                || lower.contains("pending")
                || lower.contains("process")
                || lower.contains("running")
                || lower.contains("generat")
                || lower.contains("wait")
            {
                return Ok(ProviderTaskPollResult::Running);
            }
            // A gateway may return 200 with an error envelope or an HTML/JSON
            // health response for an unknown path. Do not treat that as
            // Running, otherwise the canvas polls forever and hides the real
            // protocol mismatch.
            continue;
        }

        Ok(ProviderTaskPollResult::Failed(
            "平台未提供可识别的任务状态端点；已尝试 query_url、/v1/images/generations、/v1/tasks、/v1/jobs、/v1/async 等路径。请在平台能力设置中配置正确的查询地址，或将请求模式改为同步".to_string(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::OpenAICompatibleProvider;

    #[test]
    fn retries_alternate_reference_field_for_supported_reference_errors() {
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
        assert!(OpenAICompatibleProvider::should_retry_with_alternate_reference_field(
            reqwest::StatusCode::NOT_FOUND,
            "Not Found",
            2,
        ));
        assert!(!OpenAICompatibleProvider::should_retry_with_alternate_reference_field(
            reqwest::StatusCode::NOT_FOUND,
            "Not Found",
            0,
        ));
        assert!(!OpenAICompatibleProvider::should_retry_with_alternate_reference_field(
            reqwest::StatusCode::BAD_REQUEST,
            "failed to parse request body",
            0,
        ));
    }

    #[test]
    fn extracts_chat_image_url_from_markdown_content() {
        let payload = serde_json::json!({
            "choices": [{
                "message": {
                    "content": "![generated image](https://cdn.example.com/generated.png)"
                }
            }]
        });

        assert_eq!(
            OpenAICompatibleProvider::extract_chat_image(&payload),
            Some("https://cdn.example.com/generated.png".to_string())
        );
    }

    #[test]
    fn builds_generic_image_field_when_configured() {
        let references = vec!["data:image/png;base64,QUJD".to_string()];
        let body = OpenAICompatibleProvider::build_request_body(
            "gpt-image-2",
            "edit the image",
            "1K",
            "1:1",
            Some(&references),
            "image",
            "data_url",
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
            "1K",
            "1:1",
            Some(&references),
            "input_image",
            "raw_base64",
        )
        .expect("request body should be built");

        assert_eq!(body["input_image"], "QUJD");
        assert!(body.get("image").is_none());
    }

    #[test]
    fn encodes_generic_image_field_as_raw_base64_when_configured() {
        let references = vec!["data:image/png;base64,QUJD".to_string()];
        let body = OpenAICompatibleProvider::build_request_body(
            "gpt-image-2",
            "edit the image",
            "1K",
            "1:1",
            Some(&references),
            "image",
            "raw_base64",
        )
        .expect("request body should be built");

        assert_eq!(body["image"], "QUJD");
    }

    #[test]
    fn keeps_gpt_image_two_aspect_ratio_for_compatible_platforms() {
        let body = OpenAICompatibleProvider::build_request_body(
            "gpt-image-2-auto",
            "generate a square image",
            "1K",
            "1:1",
            None,
            "image",
            "data_url",
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
            "1K",
            "1:1",
            Some(&references),
            "image",
            "data_url",
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
            "1K",
            "1:1",
            Some(&references),
            "input_image",
            "raw_base64",
        )
        .expect("request body should be built");

        assert_eq!(body["input_image"], serde_json::json!(["QUJD", "REVG"]));
    }

    #[test]
    fn uses_edits_transport_for_all_reference_images_by_default() {
        assert_eq!(
            OpenAICompatibleProvider::resolve_image_transport(&None, "gpt-image-2", 1),
            "edits_multipart"
        );
        assert_eq!(
            OpenAICompatibleProvider::resolve_image_transport(&None, "gemini-3-pro-image", 1),
            "edits_multipart"
        );
        assert_eq!(
            OpenAICompatibleProvider::resolve_image_transport(&None, "gpt-image-2", 0),
            "generations_json"
        );
    }

    #[test]
    fn builds_apimart_body_with_all_reference_images() {
        let references = vec![
            "data:image/png;base64,QUJD".to_string(),
            "data:image/png;base64,REVG".to_string(),
        ];
        let body = OpenAICompatibleProvider::build_apimart_request_body(
            "gpt-image-2",
            "combine both images",
            "1K",
            "16:9",
            Some(&references),
        )
        .expect("request body should be built");

        assert_eq!(body["size"], "1536x1024");
        assert_eq!(body["aspect_ratio"], "16:9");
        assert_eq!(body["image_urls"], serde_json::json!(references));
    }
    #[test]
    fn maps_resolution_tiers_to_real_pixel_sizes() {
        assert_eq!(
            OpenAICompatibleProvider::map_requested_image_size("gpt-image-2-auto", "2K", "16:9"),
            "2048x1152",
        );
        assert_eq!(
            OpenAICompatibleProvider::map_requested_image_size("gpt-image-2-auto", "4K", "16:9"),
            "3840x2160",
        );
        assert_eq!(
            OpenAICompatibleProvider::map_requested_image_size("gpt-image-2-auto", "4K", "9:16"),
            "2160x3840",
        );
    }

    #[test]
    fn native_model_omits_aspect_ratio_and_stays_within_pixel_limit() {
        let body = OpenAICompatibleProvider::build_request_body(
            "gpt-image-2-native",
            "generate a square image",
            "4K",
            "1:1",
            None,
            "input_image",
            "raw_base64",
        )
        .expect("request body should be built");

        assert_eq!(body["size"], "2880x2880");
        assert!(body.get("aspect_ratio").is_none());
    }
}

