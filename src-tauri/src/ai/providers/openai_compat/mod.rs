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
use futures_util::StreamExt;
use reqwest::multipart::{Form, Part};
use serde_json::{json, Value};
use tracing::info;

use crate::ai::error::AIError;
use crate::ai::providers::video_protocols;
use crate::ai::{
    AIProvider, GenerateRequest, GenerateVideoRequest, ProviderTaskHandle, ProviderTaskPollResult, ProviderTaskSubmission,
};

const CUSTOM_PROVIDER_PREFIX: &str = "custom:";

pub struct OpenAICompatibleProvider {
    custom_api_keys: Arc<RwLock<HashMap<String, String>>>,
}

/// OpenAI 系推理模型(o 系 / gpt-5 及更新型号)会在**模型执行前**先跑一遍输入内容预检,
/// 命中即拒:
///
/// `{"error":{"code":"invalid_prompt","message":"Invalid prompt: your prompt was flagged
///   as potentially violating our usage policy...","type":"invalid_request_error"}}`
///
/// 它是**审核判定**而不是参数/格式错误: 官方社区反馈它和提示词**长度**的相关性高于内容
/// 本身, 且随模型 / 账号 / 时段波动 —— 同一段提示词换个模型或再点一次往往就能过。
/// 直译这串英文给用户没有任何可操作信息, 所以补一句中文指引。
fn prompt_policy_hint(body: &str) -> &'static str {
    let lower = body.to_ascii_lowercase();
    if lower.contains("invalid_prompt") || lower.contains("flagged as potentially violating") {
        "（上游输入内容预检拦截：不是参数错误，与提示词长度相关性较高、随模型和时段偶发；\
可以原样重试一次，或把 Chat 模型换成非 OpenAI 推理模型，或精简风格/故事梗概后再试）"
    } else {
        ""
    }
}

/// 判断已收字节是否是一份**完整** JSON。
///
/// 中转网关在传输大体积图片响应(4K b64 PNG 可达数十 MB)时收尾断流并不罕见 ——
/// 此时 body 里的数据往往**本身是完整的**, 只是缺 HTTP 层的正常终止
/// (缺末尾 chunk / Content-Length 未收满)。这类响应必须直接采信: 丢弃它等于让
/// 用户白丢一次**已在平台侧计费**的生成结果。
fn is_complete_json_body(bytes: &[u8]) -> bool {
    !bytes.is_empty() && serde_json::from_slice::<Value>(bytes).is_ok()
}

/// media 信封里的图片参数命名族。
///
/// 灵柯网关把同类参数在不同模型上写成了不同名字, 而且 `size` 一词有三义 ——
/// 像素(tt-image-2)、档位(doubao-seedream)、画幅比例(qwen-image / wan2.x-image)。
/// 传错键名平台不报错、直接按默认值出图, 所以必须按模型挑键名。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MediaImageParamStyle {
    /// banana-* / mj_imagine: `aspectRatio`(驼峰) + `imageSize`
    CamelTier,
    /// tt-image-2.5 / gk-image-2.0 / kling-v3* / vidu-image-2: `aspect_ratio` + `resolution`
    SnakeTier,
    /// doubao-seedream-*: `aspect_ratio` + `size`(档位 2K/3K/4K)
    SnakeSizeTier,
    /// tt-image-2*: 只有 `size`, 值是像素尺寸(比例与档位都折进像素串)
    PixelSize,
    /// qwen-image / wan2.x-image: `size` 就是画幅比例, 没有独立分辨率
    RatioOnly,
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

    pub(crate) fn video_result_url(payload: &Value) -> Option<String> {
        match payload {
            Value::String(value) => {
                let trimmed = value.trim();
                if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
                    return Some(trimmed.to_string());
                }
                // 平台有时会返回“视频已生成: https://...”这类说明文本。
                for marker in ["https://", "http://"] {
                    if let Some(start) = trimmed.find(marker) {
                        let tail = &trimmed[start..];
                        let end = tail
                            .char_indices()
                            .find(|(_, ch)| ch.is_whitespace() || matches!(ch, ']' | ')' | '}' | '"' | '\'' | ','))
                            .map(|(offset, _)| offset)
                            .unwrap_or(tail.len());
                        if end > marker.len() {
                            return Some(tail[..end].to_string());
                        }
                    }
                }
                None
            }
            Value::Array(items) => items.iter().find_map(Self::video_result_url),
            // 与前端 getVideoResultUrl 的键集合对齐: 知鸟 AI 的成片地址就放在
            // result_url 上, 缺了它任务会一直轮询到超时为止。
            Value::Object(map) => ["url", "video_url", "videoUrl", "result_url", "resultUrl", "uri", "download_url", "downloadUrl", "file_url", "fileUrl", "output_url", "outputUrl", "video", "media_url", "mediaUrl", "content_url", "contentUrl", "play_url", "playUrl", "mp4_url", "mp4Url", "result_video", "resultVideo"]
                .iter().find_map(|key| map.get(*key).and_then(Self::video_result_url))
                .or_else(|| ["data", "result", "output", "task", "detail", "videos", "video_urls", "videoUrls", "output_videos", "outputs", "results", "task_result", "files", "response", "media", "content", "message"].iter().find_map(|key| map.get(*key).and_then(Self::video_result_url))),
            _ => None,
        }
    }

    pub(crate) fn video_task_id(payload: &Value) -> Option<String> {
        match payload {
            Value::Object(map) => ["id", "task_id", "taskId", "video_id", "videoId"]
                .iter().find_map(|key| map.get(*key).and_then(Value::as_str).map(str::to_string))
                .or_else(|| ["data", "result", "task"].iter().find_map(|key| map.get(*key).and_then(Self::video_task_id))),
            _ => None,
        }
    }

    pub(crate) fn video_task_status(payload: &Value) -> String {
        fn collect(value: &Value, statuses: &mut Vec<String>) {
            match value {
                Value::String(status) => {
                    let normalized = status.trim().to_uppercase();
                    if matches!(normalized.as_str(), "FAILED" | "FAIL" | "FAILURE" | "ERROR" | "CANCELED" | "CANCELLED" | "REJECTED" | "EXPIRED" | "TIMEOUT" | "TIMED_OUT" | "ABORTED") {
                        statuses.push(normalized);
                    }
                }
                Value::Object(map) => {
                    for key in ["status", "task_status", "taskStatus", "state", "task_state", "taskState"] {
                        if let Some(status) = map.get(key).and_then(Value::as_str) {
                            statuses.push(status.to_uppercase());
                        }
                    }
                    for value in map.values() {
                        collect(value, statuses);
                    }
                }
                Value::Array(items) => {
                    for value in items {
                        collect(value, statuses);
                    }
                }
                _ => {}
            }
        }

        let mut statuses = Vec::new();
        collect(payload, &mut statuses);
        statuses
            .iter()
            .find(|status| matches!(status.as_str(), "FAILED" | "FAIL" | "FAILURE" | "ERROR" | "CANCELED" | "CANCELLED" | "REJECTED" | "EXPIRED" | "TIMEOUT" | "TIMED_OUT" | "ABORTED"))
            .cloned()
            .or_else(|| statuses.into_iter().next())
            .unwrap_or_default()
    }

    pub(crate) fn video_failure_reason(payload: &Value) -> Option<String> {
        fn find(value: &Value) -> Option<String> {
            match value {
                Value::Object(map) => {
                    // 键序 = 优先级。`message` / `msg` 放在最后: 它们是通用键, 几乎每个网关
                    // 都在用, 但只有在更具体的失败键都取不到时才该采信。
                    //
                    // 补这两个键是必须的 —— WGSPAI / OpenAI Videos 系协议的失败体是
                    // `{"status":"failed","error":{"message":"上游繁忙","code":"generation_failed"}}`:
                    // `error` 是**对象**而非字符串, 顶层又没有 fail_reason 系键, 早先的列表
                    // 递归进 `error` 后一个都匹配不上, 于是理由退化成状态词, 用户看到的
                    // 是「视频生成失败: FAILED」而不是「视频生成失败: 上游繁忙」。
                    for key in ["failure_reason", "failureReason", "fail_reason", "failReason", "error_message", "errorMessage", "error", "message", "msg"] {
                        if let Some(reason) = map.get(key).and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()) {
                            return Some(reason.to_string());
                        }
                    }
                    map.values().find_map(find)
                }
                Value::Array(items) => items.iter().find_map(find),
                _ => None,
            }
        }
        find(payload)
    }

    /// 失败字段必须**真的有内容**才算失败。
    ///
    /// 平台普遍会每轮都带一个空占位: 炳火在 `status: IN_PROGRESS / progress: 30%` 时返回
    /// `"fail_reason": ""`, 同族实现还会返回 `"error": {}` / `"error": false`。原实现只看
    /// **键是否存在**, 于是"还在生成"的第一次轮询就被判死 —— 平台照跑照计费, 成片永久
    /// 收不回(实机 2026-09-23 11:17 的 `task_YJrE1qDyOyFwgMVh1b3W4WPRiVJNN7AV`,
    /// 查询时 `progress: 30%` 仍在跑, 软件已报「平台返回失败标记」)。
    fn failure_value_is_present(value: &Value) -> bool {
        match value {
            Value::Null => false,
            Value::String(text) => !text.trim().is_empty(),
            Value::Bool(flag) => *flag,
            Value::Number(number) => number.as_f64().is_some_and(|value| value != 0.0),
            Value::Array(items) => !items.is_empty(),
            Value::Object(map) => !map.is_empty(),
        }
    }

    pub(crate) fn video_has_failure_signal(payload: &Value) -> bool {
        match payload {
            Value::Object(map) => {
                for key in ["success", "ok"] {
                    if map.get(key).and_then(Value::as_bool) == Some(false) {
                        return true;
                    }
                }
                if ["error", "failure_reason", "failureReason", "fail_reason", "failReason"]
                    .iter()
                    .any(|key| map.get(*key).is_some_and(Self::failure_value_is_present))
                {
                    return true;
                }
                map.values().any(Self::video_has_failure_signal)
            }
            Value::Array(items) => items.iter().any(Self::video_has_failure_signal),
            _ => false,
        }
    }

    /// 视频任务的轮询窗口(次数)。**不要再维护第二份常量的值** —— 窗口与间隔的
    /// 单一真源在 `video_protocols::{max_poll_attempts, poll_interval}`(知鸟官方口径
    /// 中位 4~40 分钟、p90 55~75 分钟, 沿用通用的 30 分钟会把长任务误判成超时)。
    fn video_max_poll_attempts(transport: &str) -> u32 {
        video_protocols::max_poll_attempts(transport)
    }

    /// 同步驱动: 提交后在本函数内长轮询直到出结果。保留这条路径是为了兼容不落库的
    /// 调用方; 后端任务执行器走 submit_video_task + poll_video_task, 两段共用同一份
    /// 请求体与查询实现, 避免两条链路各自漂移。
    pub async fn generate_video(&self, request: GenerateVideoRequest) -> Result<String, AIError> {
        let transport = request
            .extra_params
            .as_ref()
            .and_then(|params| params.get("video_transport"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let max_polls = Self::video_max_poll_attempts(transport);
        let poll_every = video_protocols::poll_interval(transport);
        match self.submit_video_task(request).await? {
            ProviderTaskSubmission::Succeeded(url) => Ok(url),
            ProviderTaskSubmission::Queued(handle) => {
                for _ in 0..max_polls {
                    tokio::time::sleep(poll_every).await;
                    match self.poll_video_task(handle.clone()).await {
                        Ok(ProviderTaskPollResult::Running) => continue,
                        Ok(ProviderTaskPollResult::Succeeded(url)) => return Ok(url),
                        Ok(ProviderTaskPollResult::Failed(message)) => {
                            return Err(AIError::TaskFailed(message))
                        }
                        // 4xx / 缺配置这类**确定性**错误: 再等下去也是同一个结果,
                        // 直接把原因报出去, 别让用户干等到窗口耗尽。
                        Err(error @ AIError::TaskFailed(_)) => return Err(error),
                        // 5xx / 408 / 429 / 网络抖动: 保持等待。这里原本用的是 `?`,
                        // 一次平台抖动就会把仍在生成的长任务判死 —— 用户只能重提,
                        // 等于我们自己制造了二次扣费。
                        Err(_) => continue,
                    }
                }
                Err(AIError::TaskFailed(format!(
                    "视频生成超时（{} 分钟）",
                    (max_polls as u64 * poll_every.as_secs()) / 60
                )))
            }
        }
    }

    /// 提交视频任务。平台若立即返回成片地址则直接 Succeeded; 否则返回 Queued 句柄,
    /// 由调用方把 task_id 与查询元数据落库, 再用 poll_video_task 续查。
    ///
    /// 元数据里带的是**提交时解析好的绝对查询地址**: 轮询时 extra_params 已不可用,
    /// 再走一遍 base_url/路径推导会重新依赖平台配置, 平台配置一改就查不到旧任务。
    pub async fn submit_video_task(
        &self,
        request: GenerateVideoRequest,
    ) -> Result<ProviderTaskSubmission, AIError> {
        let (provider_id, api_model) = request
            .model
            .split_once('/')
            .ok_or_else(|| AIError::InvalidRequest("自定义平台模型格式应为 custom:<id>/<model>".into()))?;
        if !provider_id.starts_with(CUSTOM_PROVIDER_PREFIX) {
            return Err(AIError::InvalidRequest("视频生成仅支持自定义平台(custom:*)模型".into()));
        }

        let (base_url, api_key) = self.resolve_base_url_and_key(provider_id, &request.extra_params).await?;
        let base_url = base_url.trim_end_matches('/').trim_end_matches("/v1").trim_end_matches('/');
        let extras = request.extra_params.as_ref();
        let transport = extras
            .and_then(|params| params.get("video_transport"))
            .and_then(Value::as_str)
            .unwrap_or("");
        // 后端任务执行器已实现的视频协议白名单。前端 needsCompatibilityVideoWorker
        // 必须与这里保持一致 —— 不在此列却交给后端的协议会被直接拒掉(一个请求都
        // 不发, 表现为「点生成但平台收不到请求」)。
        if !video_protocols::is_backend_transport(transport) {
            return Err(AIError::InvalidRequest(format!(
                "视频协议 {} 尚未迁移到后端任务执行器，请在模型设置中使用 OpenAI 兼容视频协议",
                transport
            )));
        }

        // 专有协议(端点/字段名与通用 OpenAI 兼容视频不同)在这里分流。它们与通用
        // 协议共用 submit/poll 两段式接口, 因此同样享受「提交即落库、可跨会话续查」——
        // 任务不再因为 WebView 刷新/切页而丢失, 用户也就不必重新提交(二次扣费)。
        //
        // 分派顺序无关紧要: 每个 matches 都以 `transport` 精确命中为主, Base URL /
        // 平台 id 兜底只在 transport 为空时才参与, 不会互相抢。
        let protocol_ctx = video_protocols::SubmitContext {
            client: Self::build_client(),
            base_url: base_url.to_string(),
            api_key: api_key.clone(),
            provider_id: provider_id.to_string(),
        };
        if video_protocols::kling::matches(transport, base_url, provider_id) {
            return video_protocols::kling::submit(&protocol_ctx, &request).await;
        }
        if video_protocols::zhenjian::matches(transport, base_url, provider_id) {
            return video_protocols::zhenjian::submit(&protocol_ctx, &request).await;
        }
        if video_protocols::zzdh::matches(transport, base_url, provider_id) {
            return video_protocols::zzdh::submit(&protocol_ctx, &request).await;
        }
        if video_protocols::sub2api::matches(transport, base_url, provider_id) {
            return video_protocols::sub2api::submit(&protocol_ctx, &request).await;
        }
        // Dramaya 与 Sub2API 同族但字段口径不同(seconds / aspect_ratio / image_urls,
        // 签名成片下载不带 Bearer), 必须单独分派。sub2api 的 matches 在 transport
        // 为空时只认 RJM 域名, 不会抢走这里的请求。
        if video_protocols::dramaya::matches(transport, base_url, provider_id) {
            return video_protocols::dramaya::submit(&protocol_ctx, &request).await;
        }
        // likeai520(Seedance 独立分组): 同样是 `/v1/videos` 异步任务, 但正文与素材
        // 字段口径不同(content 数组 / ratio / duration), 必须单独分派。
        if video_protocols::likeai::matches(transport, base_url, provider_id) {
            return video_protocols::likeai::submit(&protocol_ctx, &request).await;
        }
        if video_protocols::wgspai::matches(transport, base_url, provider_id) {
            return video_protocols::wgspai::submit(&protocol_ctx, &request).await;
        }
        if video_protocols::binghuo::matches(transport, base_url, provider_id) {
            return video_protocols::binghuo::submit(&protocol_ctx, &request).await;
        }
        // api666888(灵柯同源网关): 一条是本站 media 信封, 一条是火山方舟格式。
        // 必须排在通用分支前面 —— 通用分支会发 `/v1/videos/generations` 并带
        // `aspect_ratio`, 这两条链路都不认。
        if video_protocols::media::matches(transport, base_url, provider_id) {
            return video_protocols::media::submit(&protocol_ctx, &request).await;
        }
        if video_protocols::ark::matches(transport, base_url, provider_id) {
            return video_protocols::ark::submit(&protocol_ctx, &request).await;
        }
        // RunningHub 的端点 ID 本身即模型(`kling-v3.0-pro/image-to-video`), 且每个
        // 端点的字段名 / 枚举 / 必填默认值都不同 —— 全部由前端 `runningHubProtocol.ts`
        // 通过 `extra_params.runninghub_video` 注入, 协议层只负责按说明装填。
        if video_protocols::runninghub::matches(transport, base_url, provider_id) {
            return video_protocols::runninghub::submit(&protocol_ctx, &request).await;
        }

        let is_zhiniao = transport == "zhiniao-video";

        let endpoint_for = |configured: Option<&Value>, fallback: &str, task_id: Option<&str>| {
            let configured = configured.and_then(Value::as_str).filter(|value| !value.trim().is_empty()).unwrap_or(fallback);
            let path = if let Some(task_id) = task_id {
                configured.replace("{taskId}", &urlencoding::encode(task_id))
            } else {
                configured.to_string()
            };
            if path.starts_with("http://") || path.starts_with("https://") { path } else { format!("{}{}", base_url, if path.starts_with('/') { path } else { format!("/{}", path) }) }
        };

        let is_first_last = request.image_mode.as_deref() == Some("first-last");
        // 知鸟单次最多 30 张参考图(首尾帧模式取 2 张), 与前端 generateZhiniaoVideo 一致。
        let images = if is_first_last {
            request.reference_images.as_ref().map(|items| items.iter().take(2).cloned().collect())
        } else if is_zhiniao {
            request.reference_images.as_ref().map(|items| items.iter().take(30).cloned().collect())
        } else { request.reference_images.clone() };
        let mut body = if is_zhiniao {
            // 知鸟 AI(TokenGo) 的扁平入口: 参数全部放顶层, 不接受 params 信封。
            // 参考图的用途由 mode 决定(取值与前端 resolveZhiniaoVideoMode 严格一致),
            // 缺了 mode 平台会静默退化成纯文生视频。
            let image_count = images.as_ref().map(|items| items.len()).unwrap_or(0);
            // ⚠️ 必须与前端 `src/commands/ai.ts: resolveZhiniaoVideoMode` **逐条一致**。
            // 单图刻意不发 first-frame：平台在首帧 / 首尾帧模式下会忽略 aspect_ratio、
            // 直接沿用首帧图片比例（用户选 9:16 却拿到参考图的 3:4），只有 reference 认我们传的比例。
            let mode = if image_count == 0 {
                "text-to-video"
            } else if is_first_last && image_count >= 2 {
                "first-last"
            } else {
                "reference"
            };
            serde_json::json!({
                "model": api_model,
                "prompt": request.prompt,
                "mode": mode,
                "duration": request.duration.max(1),
                "aspect_ratio": request.aspect_ratio,
                "count": 1,
            })
        } else {
            serde_json::json!({
                "model": api_model,
                "prompt": request.prompt,
                "duration": request.duration.max(1),
                "aspect_ratio": request.aspect_ratio,
            })
        };
        if let Some(object) = body.as_object_mut() {
            if let Some(images) = images.filter(|items| !items.is_empty()) {
                object.insert("images".into(), serde_json::json!(images));
                if is_first_last && !is_zhiniao { object.insert("generation_type".into(), Value::String("frame".into())); }
            }
            if let Some(audio) = request.reference_audio.filter(|items| !items.is_empty()) {
                if is_zhiniao {
                    // 知鸟用 audios 数组(单次最多 10 条), 不是 audio_url / audio_urls。
                    object.insert("audios".into(), serde_json::json!(audio.into_iter().take(10).collect::<Vec<_>>()));
                } else {
                    object.insert("audio_url".into(), Value::String(audio[0].clone()));
                    if audio.len() > 1 { object.insert("audio_urls".into(), serde_json::json!(audio)); }
                }
            }
            if let Some(resolution) = request.video_resolution.filter(|value| !value.trim().is_empty()) { object.insert("resolution".into(), Value::String(resolution)); }
        }

        let client = Self::build_client();
        let submit_url = endpoint_for(extras.and_then(|params| params.get("video_submit_path")), "/v1/videos/generations", None);
        let response = client.post(&submit_url).bearer_auth(api_key.clone()).header("Accept-Encoding", "identity").json(&body).send().await?;
        let status = response.status();
        let raw = response.text().await.unwrap_or_default();
        let payload: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
        let raw_lower = raw.to_ascii_lowercase();
        if payload.is_null()
            && (raw_lower.contains("failed")
                || raw_lower.contains("failure")
                || raw_lower.contains("error")
                || raw_lower.contains("rejected")
                || raw_lower.contains("cancelled")
                || raw_lower.contains("canceled")
                || raw.contains("失败"))
        {
            return Err(AIError::TaskFailed(format!(
                "视频生成失败: {}",
                raw.chars().take(800).collect::<String>()
            )));
        }
        if !status.is_success() { return Err(AIError::TaskFailed(format!("视频生成请求失败: HTTP {} {}", status, raw.chars().take(500).collect::<String>()))); }
        if let Some(url) = Self::video_result_url(&payload) { return Ok(ProviderTaskSubmission::Succeeded(url)); }
        let id = Self::video_task_id(&payload).ok_or_else(|| AIError::TaskFailed("视频平台响应中未找到任务 ID 或视频地址".into()))?;
        let query_fallback = format!("{}/{{taskId}}", extras.and_then(|params| params.get("video_submit_path")).and_then(Value::as_str).unwrap_or("/v1/videos/generations"));
        let query_url = endpoint_for(extras.and_then(|params| params.get("video_query_path")), &query_fallback, Some(&id));
        Ok(ProviderTaskSubmission::Queued(ProviderTaskHandle {
            task_id: id,
            metadata: Some(serde_json::json!({
                // 轮询时重新解析 API Key 需要 provider_id; base_url 不再参与,
                // 因为 query_url 已经是提交时算好的绝对地址。
                "provider_id": provider_id,
                "query_url": query_url,
                "max_poll_attempts": Self::video_max_poll_attempts(transport),
            })),
        }))
    }

    /// 凭落库的句柄查询视频任务状态。可由任意进程/会话调用, 因此不依赖任何内存状态。
    pub async fn poll_video_task(
        &self,
        handle: ProviderTaskHandle,
    ) -> Result<ProviderTaskPollResult, AIError> {
        let metadata = handle
            .metadata
            .as_ref()
            .and_then(Value::as_object)
            .ok_or_else(|| AIError::InvalidRequest("视频任务缺少查询元数据, 无法续查".into()))?;
        let query_url = metadata
            .get("query_url")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| AIError::InvalidRequest("视频任务缺少查询地址, 无法续查".into()))?;
        let provider_id = metadata.get("provider_id").and_then(Value::as_str).unwrap_or_default();
        let api_key = match self.resolve_custom_key(provider_id).await {
            Some(key) if !key.is_empty() => key,
            _ => self.resolve_custom_key("default").await.unwrap_or_default(),
        };
        if api_key.is_empty() {
            return Err(AIError::InvalidRequest("未配置 API Key".into()));
        }

        let transport = metadata.get("transport").and_then(Value::as_str).unwrap_or("");
        // 专有协议的查询响应形状与通用协议不同(相对地址要补站点根、二进制成片要先
        // 下载落盘、motion-control 返回顶层数组……), 交给各协议自己的解析实现。
        if video_protocols::has_protocol_poll(transport) {
            let ctx = video_protocols::PollContext {
                client: Self::build_client(),
                api_key: api_key.clone(),
            };
            return video_protocols::poll(&ctx, transport, metadata, &handle).await;
        }

        let client = Self::build_client();
        let response = client
            .get(query_url)
            .bearer_auth(&api_key)
            .header("Accept-Encoding", "identity")
            .send()
            .await?;
        let status = response.status();
        let raw = response.text().await.unwrap_or_default();
        let payload: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
        if !status.is_success() {
            // 4xx 是配置/鉴权类问题, 不会自愈, 判为失败让用户看到原因; 5xx 与网络抖动
            // 属于暂时性故障, 必须保持 running —— 否则一次 502 就会把仍在平台生成
            // (且已计费)的长任务判死, 用户只能重新提交, 反而多扣一次钱。
            if status.is_client_error() {
                return Ok(ProviderTaskPollResult::Failed(format!(
                    "视频生成查询失败: HTTP {} {}",
                    status,
                    raw.chars().take(500).collect::<String>()
                )));
            }
            return Err(AIError::Provider(format!(
                "视频生成查询暂时不可用: HTTP {} {}",
                status,
                raw.chars().take(200).collect::<String>()
            )));
        }
        let task_status = Self::video_task_status(&payload);
        if video_protocols::is_failed_status(&task_status) {
            let reason = Self::video_failure_reason(&payload).unwrap_or(task_status);
            return Ok(ProviderTaskPollResult::Failed(format!("视频生成失败: {}", reason)));
        }
        // 与 `video_protocols::classify` 保持同一条判据: 平台说「还在跑」时,
        // 响应里的失败字段不采信(炳火 `IN_PROGRESS` 会带 `"fail_reason": ""`)。
        // 注意这里只能回 Running, 不能回 Err —— 回 Err 会每 2 秒打一条前端 warn,
        // 还会被当成"临时故障"掩盖真正的失败原因。
        if video_protocols::is_running_status(&task_status) {
            return Ok(ProviderTaskPollResult::Running);
        }
        if Self::video_has_failure_signal(&payload) {
            let reason = Self::video_failure_reason(&payload).unwrap_or_else(|| "平台返回失败标记".to_string());
            return Ok(ProviderTaskPollResult::Failed(format!("视频生成失败: {}", reason)));
        }
        if let Some(url) = Self::video_result_url(&payload) {
            let lower = url.to_ascii_lowercase();
            let placeholder = lower.contains("placeholder")
                || lower.ends_with("/pending")
                || lower.ends_with("/processing");
            if !placeholder {
                return Ok(ProviderTaskPollResult::Succeeded(url));
            }
        }
        if let Some(reason) = Self::video_failure_reason(&payload) {
            let lower = reason.to_ascii_lowercase();
            if lower.contains("fail") || lower.contains("error") || lower.contains("reject") || lower.contains("cancel") || lower.contains("timeout") || reason.contains("失败") {
                return Ok(ProviderTaskPollResult::Failed(format!("视频生成失败: {}", reason)));
            }
        }
        Ok(ProviderTaskPollResult::Running)
    }

    fn build_client() -> reqwest::Client {
        // 使用 macOS/Windows 系统代理和用户显式配置的环境代理。部分海外自定义
        // 平台只能通过系统代理完成 DNS 解析；未配置代理时 reqwest 自动直连。
        //
        // `connect_timeout` 单独设 15s: 只看总超时(180s)的话, 一旦 DNS 卡住或对端
        // IP 被黑洞(域名解析出多个 A 记录时很常见), 请求会静静地挂满三分钟才报错 ——
        // 素材上传那边的重试也因此根本来不及发生。建连本身慢到 15s 以上, 重试才有意义。
        reqwest::Client::builder()
            .http1_only()
            .connect_timeout(std::time::Duration::from_secs(15))
            .timeout(std::time::Duration::from_secs(180))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    }

    /// 图片生成专用 client(同步接口)。
    ///
    /// 通用 `build_client()` 的总超时是 180s, 对**同步**图片接口明显偏短: gpt-image 系
    /// 4K 出图实测经常在 3 分钟以上, 一旦超时落在 body 传输阶段, reqwest 会把它折叠成
    /// `error decoding response body` —— 与"平台断流"在报错文案上**完全无法区分**
    /// (实报 `req_39d98b3b-d6e8-4467-b221-4225be7639fc` 即此形态)。所以这里:
    ///   * 总上限放宽到 15 分钟, 给 4K 留够出图时间;
    ///   * `read_timeout(300s)` 兜底 —— 连续 5 分钟收不到**任何**字节才判死连接,
    ///     避免对端真挂掉时用户白等一刻钟。
    fn build_image_client() -> reqwest::Client {
        reqwest::Client::builder()
            .http1_only()
            .connect_timeout(std::time::Duration::from_secs(15))
            .timeout(std::time::Duration::from_secs(900))
            .read_timeout(std::time::Duration::from_secs(300))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    }

    /// 短超时 client(20s): 用于「验证连接/验证协议/拉取模型」等交互操作,
    /// 避免平台不可达时 UI 长时间卡在"验证中/拉取中"。
    fn build_short_timeout_client() -> reqwest::Client {
        reqwest::Client::builder()
            .http1_only()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    }

    /// 图片提交的重试次数。
    ///
    /// 参考图内联时请求体是**几 MB 到几十 MB** 的量级(实测 26MB 单单上传就要 28 秒),
    /// 传输层抖动的概率远高于普通 JSON 调用。此前一次抖动就直接把 reqwest 的
    /// `error sending request for url (...)` 抛给用户: 既没说原因、也没给重试机会。
    const IMAGE_SEND_MAX_ATTEMPTS: usize = 3;

    /// 把 reqwest 的传输层失败翻成能定位问题的中文。
    ///
    /// reqwest 的 Display 只有 `error sending request for url (…)`;到底是连接被拒、
    /// TLS 被掐、还是超时,全在 source 链里。这层不翻出来,用户报障时我们只能瞎猜。
    fn describe_send_failure(error: &reqwest::Error) -> String {
        let mut causes: Vec<String> = Vec::new();
        let mut source = std::error::Error::source(error);
        while let Some(item) = source {
            let text = item.to_string();
            if !text.trim().is_empty() && !causes.iter().any(|existing| existing == &text) {
                causes.push(text);
            }
            source = item.source();
        }
        let kind = if error.is_connect() {
            "无法与上游建立连接"
        } else if error.is_timeout() {
            "等待上游超时"
        } else if error.is_body() || error.is_request() {
            "发送请求体时连接被中断"
        } else {
            "请求未能送达上游"
        };
        if causes.is_empty() {
            kind.to_string()
        } else {
            format!("{kind}（{}）", causes.join("；"))
        }
    }

    /// 只有在「一个字节的响应都没收到」时才允许重投。
    ///
    /// 拿得到状态码说明平台已经受理(哪怕回的是 4xx),重发就是重复出图、重复计费;
    /// 而连接阶段/上传阶段就断掉的请求,对端根本没收到完整请求体,重投是安全的。
    fn is_retryable_send_failure(error: &reqwest::Error) -> bool {
        error.status().is_none()
            && (error.is_connect() || error.is_timeout() || error.is_request() || error.is_body())
    }

    /// 提交图片请求: 传输层失败自动重投, 最终失败时给出可定位的中文原因。
    ///
    /// `build` 用闭包而不是 RequestBuilder, 因为 RequestBuilder 一旦 send 就被消费,
    /// 想重投只能重新拼一次(请求体本身是 `Value`/`String`, 复制成本可以忽略)。
    async fn send_image_request<F>(
        context: &str,
        endpoint: &str,
        build: F,
    ) -> Result<reqwest::Response, AIError>
    where
        F: Fn() -> reqwest::RequestBuilder,
    {
        let mut attempt = 1;
        loop {
            match build().send().await {
                Ok(response) => return Ok(response),
                Err(error) => {
                    let detail = Self::describe_send_failure(&error);
                    if !Self::is_retryable_send_failure(&error) || attempt >= Self::IMAGE_SEND_MAX_ATTEMPTS {
                        return Err(AIError::NetworkMessage(format!(
                            "{detail} [endpoint: {endpoint}，{context} 共尝试 {attempt} 次]"
                        )));
                    }
                    let backoff = std::time::Duration::from_millis(600 * attempt as u64);
                    tracing::warn!(
                        "[OpenAI Compatible] {context} 第 {attempt} 次未送达（{detail}），{:?} 后重试",
                        backoff
                    );
                    tokio::time::sleep(backoff).await;
                    attempt += 1;
                }
            }
        }
    }

    /// 判断传输层失败时的不重投说明(用于 multipart 这类无法重建请求体的分支)。
    fn send_failure(error: reqwest::Error, context: &str, endpoint: &str) -> AIError {
        AIError::NetworkMessage(format!(
            "{} [endpoint: {endpoint}，{context}]",
            Self::describe_send_failure(&error)
        ))
    }

    /// 内联参考图的体积预算: 超过就缩放重编码。
    ///
    /// 手机直出的商品图动辄 4~8MB, 转 base64 再叠上 `image` + `images` 的兼容性冗余,
    /// 单个请求体可以到 20MB 以上 —— 上传本身就要十几二十秒, 期间任何一次抖动都会
    /// 以 `Network error: error sending request` 收场。参考图对 2K 出图的有效信息在
    /// 长边 2048 以内已经饱和, 再大只是白等。
    const INLINE_REFERENCE_MAX_BYTES: usize = 2 * 1024 * 1024;
    const INLINE_REFERENCE_MAX_SIDE: u32 = 2048;

    /// 把超预算的参考图缩到长边 2048 并重编码;不超预算、解不开、或压完反而更大时原样返回。
    fn compact_inline_reference(bytes: Vec<u8>, mime: &str) -> (Vec<u8>, String) {
        use image::GenericImageView;
        let decoded = match image::load_from_memory(&bytes) {
            Ok(image) => image,
            // webp 变体 / 奇怪编码: 解不开就不要动, 原样送过去让对端自己判断
            Err(_) => return (bytes, mime.to_string()),
        };
        let (width, height) = decoded.dimensions();
        let longest = width.max(height);
        if bytes.len() <= Self::INLINE_REFERENCE_MAX_BYTES && longest <= Self::INLINE_REFERENCE_MAX_SIDE {
            return (bytes, mime.to_string());
        }
        let scale = (Self::INLINE_REFERENCE_MAX_SIDE as f64 / longest as f64).min(1.0);
        let target = if scale < 1.0 {
            decoded.resize_exact(
                ((width as f64 * scale).round() as u32).max(1),
                ((height as f64 * scale).round() as u32).max(1),
                image::imageops::FilterType::Lanczos3,
            )
        } else {
            decoded
        };
        let encoded = if target.color().has_alpha() {
            let mut buffer = Vec::new();
            match target.write_to(&mut std::io::Cursor::new(&mut buffer), image::ImageFormat::Png) {
                Ok(()) => Some((buffer, "image/png")),
                Err(_) => None,
            }
        } else {
            let mut buffer = Vec::new();
            match image::codecs::jpeg::JpegEncoder::new_with_quality(&mut std::io::Cursor::new(&mut buffer), 90)
                .encode_image(&target)
            {
                Ok(()) => Some((buffer, "image/jpeg")),
                Err(_) => None,
            }
        };
        match encoded {
            // 压完更大说明原图本来就编码得很紧, 保留原图
            Some((buffer, out_mime)) if buffer.len() < bytes.len() => {
                info!(
                    "[OpenAI Compatible] 参考图压缩: {}KB -> {}KB ({}x{} 上限 {})",
                    bytes.len() / 1024,
                    buffer.len() / 1024,
                    width,
                    height,
                    Self::INLINE_REFERENCE_MAX_SIDE
                );
                (buffer, out_mime.to_string())
            }
            _ => (bytes, mime.to_string()),
        }
    }

    /// data URL 形态的参考图: 超预算时解码 → 缩放 → 重新编码, 其余原样返回。
    fn compact_reference_data_url(payload: &str) -> String {
        let Some((metadata, encoded)) = payload.split_once(',') else {
            return format!("data:{payload}");
        };
        // base64 每 4 字符 3 字节, 用长度先做一次廉价预判, 避免对每张小图都解码
        if !metadata.contains(";base64") || encoded.len() <= Self::INLINE_REFERENCE_MAX_BYTES / 3 * 4 {
            return format!("data:{payload}");
        }
        let mime = metadata
            .split(';')
            .next()
            .filter(|value| value.starts_with("image/"))
            .unwrap_or("image/png");
        match STANDARD.decode(encoded) {
            Ok(bytes) => {
                let (bytes, mime) = Self::compact_inline_reference(bytes, mime);
                format!("data:{};base64,{}", mime, STANDARD.encode(bytes))
            }
            Err(_) => format!("data:{payload}"),
        }
    }

    /// 读取响应体文本。
    ///
    /// **刻意不用 `response.bytes()`** —— 它把 body 层的一切失败折叠成 Display 恒为
    /// `error decoding response body` 的 `reqwest::Error`, 真实原因只藏在 `source()` 里。
    /// 本项目 reqwest 未启用 gzip/brotli/deflate/zstd feature, 因此这条 Display 只可能
    /// 来自**传输层截断**(连接提前关闭 / chunked 未终止 / Content-Length 未收满),
    /// 而不是解压失败 —— 但光看 Display 完全区分不出来, 这就是之前只能写"可能返回了
    /// 损坏的压缩或分块响应"的原因。改为逐块累积后:
    ///   1. 流以 `Err` 结束、但已收字节是**完整 JSON** → 直接采信(`is_complete_json_body`);
    ///   2. 否则报错, 并把 source 链 + 已收字节数 + 关键响应头一起带上, 一次定性。
    async fn read_response_text(
        response: reqwest::Response,
        context: &str,
    ) -> Result<(reqwest::StatusCode, String), AIError> {
        let status = response.status();
        let headers = response.headers().clone();
        let upstream_task_id = headers
            .get("x-upstream-task-id")
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        // HeaderMap::get 本身大小写不敏感, 无需再试一遍 X-Request-ID。
        let request_id = headers
            .get("x-request-id")
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| "unknown".to_string());
        let header_of = |name: &str| -> String {
            headers
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("-")
                .to_string()
        };
        let declared_len = header_of("content-length");
        // 预分配按声明长度, 但设 64MB 上限: 声明可能是假的(某些网关会给超大值),
        // 不能让它直接决定内存申请量。
        let mut buffer: Vec<u8> =
            Vec::with_capacity(declared_len.parse::<usize>().unwrap_or(0).min(64 * 1024 * 1024));

        let mut stream = response.bytes_stream();
        let mut stream_error: Option<reqwest::Error> = None;
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(chunk) => buffer.extend_from_slice(&chunk),
                Err(error) => {
                    stream_error = Some(error);
                    break;
                }
            }
        }

        if let Some(error) = stream_error {
            if status.is_success() {
                // 平台已受理(响应头带回任务 ID)时保留续查能力: 绝不重复提交计费请求。
                if let Some(task_id) = upstream_task_id {
                    // Some relays return the accepted task id in a header but
                    // close a malformed chunked body. Preserve resumability
                    // without submitting the billable request again.
                    return Ok((status, format!(r#"{{"id":"{}"}}"#, task_id)));
                }
                if is_complete_json_body(&buffer) {
                    tracing::warn!(
                        "[OpenAI Compatible] {} 响应体收尾处断流({}), 但已收 {} 字节是完整 JSON, 直接采信",
                        context,
                        video_protocols::describe_reqwest_error(&error),
                        buffer.len()
                    );
                    return Ok((status, String::from_utf8_lossy(&buffer).into_owned()));
                }
            }
            let declared = if declared_len == "-" {
                String::new()
            } else {
                format!("(声明 {})", declared_len)
            };
            return Err(AIError::TaskFailed(format!(
                "{} 已返回 HTTP {}, 但响应体在传输中断开: {}。已收 {} 字节{}；content-type={} content-encoding={} \
transfer-encoding={}；request_id={}。本次请求平台已受理，这类断流多发生在上游传输大体积图片响应（4K 图可达数十 MB）时。\
建议原样重试一次；若连续复现，请把分辨率降到 2K 或改用平台的异步查询模式，并可用上面的 request_id 向平台核对本次是否已计费。",
                context,
                status,
                video_protocols::describe_reqwest_error(&error),
                buffer.len(),
                declared,
                header_of("content-type"),
                header_of("content-encoding"),
                header_of("transfer-encoding"),
                request_id
            )));
        }

        Ok((status, String::from_utf8_lossy(&buffer).into_owned()))
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

        // media 信封的请求体含全部参考图, 同样是 MB 级上传: 抖动就重投
        let response = Self::send_image_request("media 提交", &endpoint, || {
            client
                .post(&endpoint)
                .bearer_auth(api_key)
                .header("Accept-Encoding", "identity")
                .json(&body)
        })
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
            return Err(AIError::TaskFailed(format!(
                "HTTP {}: {}{}",
                status,
                message,
                prompt_policy_hint(&body_text)
            )));
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
    /// ⚠️ 这只描述**参数协议**, 不代表像素预算 —— 中转平台的 `gpt-image-2` 走非 native
    /// 协议(会发 aspect_ratio), 但上游同样施加 OpenAI 图像族的像素上限。
    fn uses_native_image_parameters(api_model: &str) -> bool {
        let normalized = api_model.trim().to_ascii_lowercase();
        normalized.ends_with("-native")
            || normalized.ends_with("-n")
            || normalized.contains("gpt-image-1")
            || normalized.contains("dall-e")
    }

    /// OpenAI 图像族的像素预算:单边 ≤3840、长短比 ≤3:1、总像素 ≤8,294,400(= 3840x2160)。
    /// 覆盖 gpt-image 全系(gpt-image-1 / 1.5 / 2 / 2.5 / 以及 `-2k`/`-4k`/`-auto` 等变体)、
    /// dall-e 与 `-native` 协议变体。
    ///
    /// ⚠️ **刻意与 `uses_native_image_parameters` 解耦**:后者管参数协议,本函数管像素预算。
    /// 曾经两者合一, 结果 `gpt-image-2` 既不匹配 `gpt-image-1` 也不以 `-native` 结尾,
    /// 于是 4K + 4:3 会拼出 3840x2880(11.06M 像素)被上游 400 拒绝。
    fn enforces_openai_image_pixel_budget(api_model: &str) -> bool {
        let normalized = api_model.trim().to_ascii_lowercase();
        normalized.contains("gpt-image")
            || normalized.contains("dall-e")
            || normalized.contains("dalle")
            || normalized.ends_with("-native")
            || normalized.ends_with("-n")
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

        if Self::enforces_openai_image_pixel_budget(api_model) {
            const MAX_OPENAI_IMAGE_PIXELS: f64 = 8_294_400.0;
            let pixels = width as f64 * height as f64;
            if pixels > MAX_OPENAI_IMAGE_PIXELS {
                let scale = (MAX_OPENAI_IMAGE_PIXELS / pixels).sqrt();
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

    fn resolve_image_count(request: &GenerateRequest) -> u32 {
        request
            .image_count
            .or_else(|| {
                request
                    .extra_params
                    .as_ref()
                    .and_then(|params| params.get("image_count"))
                    .and_then(Value::as_u64)
                    .map(|value| value as u32)
            })
            .unwrap_or(1)
            .clamp(1, 10)
    }

    fn apply_image_count(body: &mut Value, image_count: u32) {
        body["n"] = json!(image_count);
    }

    /// 允许透传进图片请求体的「模型专属参数」白名单。
    ///
    /// `extra_params` 里有两种东西：一是控制字段（`image_transport` / `protocol` /
    /// `provider_base_url` / `request_mode` / `image_generation_mode`…），只该在
    /// 客户端与后端之间流转；二是模型自己的参数（Midjourney 的 `count` / `bot_type` /
    /// `version` / `stylize`，各平台的 `seed` / `quality`…）。后者以前**一个都发不出去**，
    /// 面板上选了等于没选。这里只放行确定属于请求体的键，控制字段仍然进不来。
    ///
    /// `negative_prompt` **刻意不在名单里**：它在 `extra_params` 里是给 grsai / fal /
    /// RunningHub 这些自家协议读的，原样塞进 OpenAI Images 请求体会被严格的厂商
    /// （原生 gpt-image 系）判成「未知参数」直接 400。要负向提示词请用各模型自己的字段。
    const IMAGE_PARAM_PASSTHROUGH: &'static [&'static str] = &[
        "count",
        "bot_type",
        "version",
        "stylize",
        "chaos",
        "quality",
        "style",
        "seed",
        "tile",
        "hd",
        "draft",
        "sref",
        "cref",
        "iw",
        "cw",
        "sw",
        "stop",
        "weird",
        "extra",
        "output_format",
    ];

    /// 把白名单里的模型参数装进请求体。
    ///
    /// 两个细节：
    /// - 空串按「没选」处理（Midjourney 的 `version` 默认档就是空串），别把 `""` 发上去；
    /// - 体里一旦有 `count` 就把 `n` 删掉。Midjourney 的 `count` 是**组数**（一组 4 张），
    ///   实测 `n` 会被上游忽略（`n: 1` 仍回 4 张），两个字段并存只会让渠道各自理解。
    fn apply_model_extra_params(body: &mut Value, extra_params: &Option<HashMap<String, Value>>) {
        let Some(params) = extra_params.as_ref() else {
            return;
        };
        let Some(object) = body.as_object_mut() else {
            return;
        };
        for key in Self::IMAGE_PARAM_PASSTHROUGH {
            let Some(value) = params.get(*key) else {
                continue;
            };
            if value.is_null() {
                continue;
            }
            if let Some(text) = value.as_str() {
                if text.trim().is_empty() {
                    continue;
                }
            }
            object.insert((*key).to_string(), value.clone());
        }
        if object.contains_key("count") {
            object.remove("n");
        }
    }

    fn serialize_image_sources(images: Vec<String>) -> Result<String, AIError> {
        let mut unique: Vec<String> = Vec::new();
        for image in images {
            if !image.trim().is_empty() && !unique.iter().any(|item| item == &image) {
                unique.push(image);
            }
        }
        match unique.len() {
            0 => Err(AIError::TaskFailed("响应中未找到图片数据".to_string())),
            1 => Ok(unique.remove(0)),
            _ => serde_json::to_string(&unique)
                .map_err(|error| AIError::TaskFailed(format!("图片结果序列化失败: {error}"))),
        }
    }

    // -----------------------------------------------------------------------
    // media 信封图片(灵柯 / api666888 的音视频网关)
    //
    // 同一网关下**图片模型挂了两套协议**, 而且不是按平台区分、是按模型区分:
    //   - `tt-image-2.5` 等老模型: `POST /v1/images/generations` 直接 200;
    //   - `banana-2.1` / `gk-image-2.0` / `doubao-seedream-*` 等新模型: 一律 400
    //     「模型 'x' 不支持 /v1/images/* 端点，请改用 POST /v1/media/generate」。
    //
    // 平台会把短名映射成上游真名(`banana-2.1` → `gemini-nano-banana-2.1`), 所以
    // 无法在前端按模型名预判; 只能按**这句报错**兜底重投一次 media 信封:
    //   POST /v1/media/generate  { model, prompt, params: { aspect_ratio,
    //                              resolution, image_url[] } }
    //   → {"code":200,"data":{"task_id":181687051}}
    //   GET /v1/skills/task-status?task_id=…  → is_final + state + result_urls
    // -----------------------------------------------------------------------

    /// 单张图片任务的总等待上限。banana 实测 29 秒; 慢渠道(MJ 类)可能两三分钟。
    const MEDIA_IMAGE_TIMEOUT_SECS: u64 = 300;
    const MEDIA_IMAGE_POLL_INTERVAL_SECS: u64 = 3;

    /// 平台在「该模型只挂了 media 信封」时返回的 400 文案。
    ///
    /// 必须同时认住 `media/generate` 与 `/v1/images` 两个片段: 只认前者的话,
    /// 其它平台把 `media/generate` 写进普通参数错误的提示里也会被误判成该重投。
    fn image_requires_media_envelope(body_text: &str) -> bool {
        let lower = body_text.to_ascii_lowercase();
        lower.contains("media/generate") && (lower.contains("/v1/images") || lower.contains("不支持"))
    }

    /// 「这个模型只认 media 信封」的进程内记忆。
    ///
    /// 不记的话每次出图都要先整包上传打一次**必败**的 `/v1/images/*`(带参考图时十几 MB),
    /// 再整包上传一次 media —— 白白多花十秒以上, 也白白多一次断连机会(用户看到的
    /// `Network error: error sending request` 正是这种大包上传时最容易撞上的)。
    fn media_envelope_cache() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
        static CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
            std::sync::OnceLock::new();
        CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
    }

    fn media_envelope_key(provider_id: &str, api_model: &str) -> String {
        format!(
            "{}/{}",
            provider_id.to_ascii_lowercase(),
            api_model.to_ascii_lowercase()
        )
    }

    fn media_envelope_known(provider_id: &str, api_model: &str) -> bool {
        Self::media_envelope_cache()
            .lock()
            .map(|cache| cache.contains(&Self::media_envelope_key(provider_id, api_model)))
            .unwrap_or(false)
    }

    fn remember_media_envelope(provider_id: &str, api_model: &str) {
        if let Ok(mut cache) = Self::media_envelope_cache().lock() {
            cache.insert(Self::media_envelope_key(provider_id, api_model));
        }
    }

    /// 构造 media 信封请求体。
    ///
    /// 平台这套 `params` 是按**模型**定的, 不是按平台定的 —— 21 个图片模型共有
    /// 五套不同的字段名(见 [`Self::media_image_param_style`]), 传错名不会报错,
    /// 平台直接当没传、按默认值出图。所以这里必须按模型挑键名, 不能写死一套。
    fn build_media_image_body(
        api_model: &str,
        prompt: &str,
        resolution: &str,
        aspect_ratio: &str,
        reference_images: Option<&Vec<String>>,
        extra_params: Option<&HashMap<String, Value>>,
    ) -> Result<Value, AIError> {
        let mut params = json!({});
        let object = params.as_object_mut().expect("params 一定是对象");
        let aspect_ratio = aspect_ratio.trim();
        // 前端可能传 `auto` / `1024x1024` 这类平台不认的值, 只放行 `宽:高` 形态。
        let ratio = Self::media_image_aspect_ratio(aspect_ratio);
        match Self::media_image_param_style(api_model) {
            MediaImageParamStyle::CamelTier => {
                if let Some(ratio) = ratio {
                    object.insert("aspectRatio".into(), json!(ratio));
                }
                if let Some(tier) = Self::media_image_tier(resolution) {
                    object.insert("imageSize".into(), json!(tier));
                }
            }
            MediaImageParamStyle::SnakeTier => {
                if let Some(ratio) = ratio {
                    object.insert("aspect_ratio".into(), json!(ratio));
                }
                if let Some(tier) = Self::media_image_tier(resolution) {
                    object.insert("resolution".into(), json!(tier));
                }
            }
            MediaImageParamStyle::SnakeSizeTier => {
                if let Some(ratio) = ratio {
                    object.insert("aspect_ratio".into(), json!(ratio));
                }
                if let Some(tier) = Self::media_image_tier(resolution) {
                    object.insert("size".into(), json!(tier));
                }
            }
            // 这一族的 `size` 是像素枚举, 比例与档位都要折进像素串。
            MediaImageParamStyle::PixelSize => {
                if let Some(size) = Self::media_image_pixel_size(resolution, aspect_ratio) {
                    object.insert("size".into(), json!(size));
                }
            }
            // 这一族没有独立分辨率参数, `size` 直接就是画幅比例。
            MediaImageParamStyle::RatioOnly => {
                if let Some(ratio) = ratio {
                    object.insert("size".into(), json!(ratio));
                }
            }
        }
        let mut images: Vec<String> = Vec::new();
        for reference in reference_images.into_iter().flatten() {
            if let Some(image) = Self::reference_image_to_image_field(reference)? {
                images.push(image);
            }
        }
        if !images.is_empty() {
            // 文档口径就是 `images`(type=upload 一律传数组); 平台另认 `image_url`
            // 只是历史兼容, 新接入按文档走。
            object.insert("images".into(), json!(images));
        }
        Self::apply_media_model_params(object, extra_params);
        Ok(json!({ "model": api_model, "prompt": prompt, "params": params }))
    }

    /// 把面板上选的模型专属参数搬进 `params`。
    ///
    /// media 信封里连 Midjourney 的引擎都得放在 `params` 内(且是驼峰 `botType`),
    /// 不放的话 `mj_imagine` 这类「必填引擎」的模型会直接失败; `tt-image-2.5` 的
    /// `version`(标准版/增强版)同理。只搬白名单里的键, 控制字段进不来。
    ///
    /// `count` 刻意跳过: media 一次只出一张, `count` 在别的平台表示组数,
    /// 传上去只会让渠道各按各的理解。
    fn apply_media_model_params(
        params: &mut serde_json::Map<String, Value>,
        extra_params: Option<&HashMap<String, Value>>,
    ) {
        let Some(extra) = extra_params else {
            return;
        };
        for key in Self::IMAGE_PARAM_PASSTHROUGH {
            if *key == "count" {
                continue;
            }
            let Some(value) = extra.get(*key) else {
                continue;
            };
            if value.is_null() {
                continue;
            }
            // 空串按「没选」处理(Midjourney 的 version 默认档就是空串)
            if value.as_str().is_some_and(|text| text.trim().is_empty()) {
                continue;
            }
            // 平台的 media 参数一律驼峰: bot_type → botType
            let field = match *key {
                "bot_type" => "botType",
                other => other,
            };
            params.insert(field.to_string(), value.clone());
        }
    }

    /// `1K` / `2K` / `4K` 这类档位才丢给平台(图片侧参数是枚举)。
    ///
    /// 小数档也要认: `banana-2` 的 `imageSize` 有 `0.5K` 一档。
    fn media_image_tier(resolution: &str) -> Option<String> {
        let resolution = resolution.trim();
        let bytes = resolution.as_bytes();
        let (digits, unit) = bytes.split_at(bytes.len().checked_sub(1)?);
        let is_tier = matches!(unit.first(), Some(b'k' | b'K'))
            && !digits.is_empty()
            && digits.iter().all(|byte| byte.is_ascii_digit() || *byte == b'.');
        is_tier.then(|| resolution.to_string())
    }

    fn media_image_aspect_ratio(aspect_ratio: &str) -> Option<String> {
        let value = aspect_ratio.trim();
        let (width, height) = value.split_once(':')?;
        (!width.is_empty()
            && !height.is_empty()
            && width.chars().all(|item| item.is_ascii_digit())
            && height.chars().all(|item| item.is_ascii_digit()))
        .then(|| value.to_string())
    }

    /// `tt-image-2` 族的 `size` 是像素枚举: 比例 + 档位必须查表折成具体像素。
    /// 表来自文档里该参数的全部 options, 不在表里的组合一律不传(让平台用默认)。
    fn media_image_pixel_size(resolution: &str, aspect_ratio: &str) -> Option<&'static str> {
        let ratio = aspect_ratio.trim();
        let resolution = resolution.trim().to_ascii_uppercase();
        let table: &[(&str, &str)] = match resolution.as_str() {
            "1K" => &[
                ("1:1", "1024x1024"),
                ("2:3", "1024x1536"),
                ("3:2", "1536x1024"),
                ("3:4", "960x1280"),
                ("4:3", "1280x960"),
                ("9:16", "1088x1920"),
                ("16:9", "1920x1088"),
                ("4:5", "1024x1280"),
                ("5:4", "1280x1024"),
                ("1:2", "960x1920"),
                ("2:1", "1920x960"),
            ],
            "2K" => &[
                ("1:1", "2048x2048"),
                ("2:3", "2048x3072"),
                ("3:2", "3072x2048"),
                ("3:4", "1920x2560"),
                ("4:3", "2560x1920"),
                ("9:16", "1440x2560"),
                ("16:9", "2560x1440"),
                ("4:5", "2048x2560"),
                ("5:4", "2560x2048"),
                ("1:2", "1280x2560"),
                ("2:1", "2560x1280"),
            ],
            "4K" => &[
                ("1:1", "2880x2880"),
                ("2:3", "2304x3456"),
                ("3:2", "3456x2304"),
                ("3:4", "2400x3200"),
                ("4:3", "3200x2400"),
                ("9:16", "2160x3840"),
                ("16:9", "3840x2160"),
                ("4:5", "2560x3200"),
                ("5:4", "3200x2560"),
                ("1:2", "1920x3840"),
                ("2:1", "3840x1920"),
            ],
            _ => return None,
        };
        table
            .iter()
            .find(|(key, _)| *key == ratio)
            .map(|(_, value)| *value)
    }

    /// 灵柯 / API666888 的图片模型参数命名族。
    ///
    /// 用**族**而不是逐模型分支: 同族模型的参数签名完全一致, 逐模型写会漏。
    fn media_image_param_style(api_model: &str) -> MediaImageParamStyle {
        let model = api_model.trim().to_ascii_lowercase();
        if model.starts_with("banana") || model.starts_with("mj_imagine") || model == "mj-imagine" {
            return MediaImageParamStyle::CamelTier;
        }
        if model.starts_with("tt-image-2.5") {
            return MediaImageParamStyle::SnakeTier;
        }
        if model.starts_with("tt-image-2") {
            return MediaImageParamStyle::PixelSize;
        }
        if model.starts_with("doubao-seedream") {
            return MediaImageParamStyle::SnakeSizeTier;
        }
        if model.starts_with("qwen-image") || model.starts_with("wan2.6-image") || model.starts_with("wan2.7-image") {
            return MediaImageParamStyle::RatioOnly;
        }
        // gk-image-2.0 / kling-v3 / kling-v3-omni / vidu-image-2 以及未知新模型:
        // `aspect_ratio + resolution` 是平台里最常见的一套, 兜底选它。
        MediaImageParamStyle::SnakeTier
    }

    /// 灵柯网关里「只在 media 信封出现」的 21 个图片模型(2026-10-20 抓自
    /// `GET /houduan/gongkai/apidoc/moxing-liebiao`, 全部 `api_xieyi=media`)。
    ///
    /// 它们打 `/v1/images/generations` 一律 400「请改用 POST /v1/media/generate」,
    /// 靠报错兜底等于每次白传一遍参考图(十几 MB), 所以本地直接记死。
    const MEDIA_ONLY_IMAGE_MODELS: &[&str] = &[
        "tt-image-2.5",
        "tt-image-2.5-token",
        "tt-image-2",
        "tt-image-2-token",
        "banana-2.1",
        "banana-2.1-token",
        "banana-2",
        "banana-2-token",
        "banana-pro",
        "banana-pro-token",
        "mj_imagine",
        "doubao-seedream-4-5-251128",
        "doubao-seedream-5-0-260128",
        "doubao-seedream-5-0-pro-260628",
        "gk-image-2.0",
        "kling-v3",
        "kling-v3-omni",
        "vidu-image-2",
        "qwen-image",
        "wan2.6-image",
        "wan2.7-image",
    ];

    /// 该模型是否「文档声明只走 media 信封」。
    ///
    /// 只在灵柯网关生效: 同名模型挂在别家中转上时, 对方可能是标准 OpenAI 图片协议。
    fn declared_media_only_image_model(base_url: &str, api_model: &str) -> bool {
        let host = base_url.to_ascii_lowercase();
        if !(host.contains("lk888") || host.contains("lingkeai")) {
            return false;
        }
        Self::MEDIA_ONLY_IMAGE_MODELS
            .iter()
            .any(|item| item.eq_ignore_ascii_case(api_model.trim()))
    }

    /// 从 `{"code":200,"data":{"task_id":181687051}}` 里取任务号 —— 数字/字符串都认。
    fn media_task_id(payload: &Value) -> Option<String> {
        fn id_of(value: &Value) -> Option<String> {
            match value {
                Value::Object(map) => {
                    for key in ["task_id", "taskId", "id"] {
                        match map.get(key) {
                            Some(Value::String(text)) if !text.trim().is_empty() => {
                                return Some(text.trim().to_string())
                            }
                            Some(Value::Number(number)) => return Some(number.to_string()),
                            _ => {}
                        }
                    }
                    for key in ["data", "result", "task"] {
                        if let Some(found) = map.get(key).and_then(id_of) {
                            return Some(found);
                        }
                    }
                    None
                }
                _ => None,
            }
        }
        id_of(payload)
    }

    /// 业务错误包: HTTP 200 也可能是失败(`{"code":400,"msg":"…"}`)。
    fn media_business_error(payload: &Value) -> Option<String> {
        let map = payload.as_object()?;
        let code = map.get("code")?;
        let failed = match code {
            Value::Number(number) => number.as_i64().is_some_and(|value| value != 0 && value != 200),
            Value::String(text) => !matches!(text.trim(), "" | "0" | "200" | "success" | "ok"),
            _ => false,
        };
        if !failed {
            return None;
        }
        let message = ["msg", "message", "error"]
            .iter()
            .find_map(|key| map.get(*key).and_then(Value::as_str))
            .unwrap_or("未知错误");
        Some(format!("{code} {}", message.trim()))
    }

    /// 读一次任务状态: `None` = 还在跑, `Some(Ok(urls))` = 成功, `Some(Err(原因))` = 失败。
    fn media_image_task_outcome(payload: &Value) -> Option<Result<Vec<String>, String>> {
        let map = payload.as_object()?;
        if !map.get("is_final").and_then(Value::as_bool).unwrap_or(false) {
            return None;
        }
        let state = map
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        let mut urls: Vec<String> = map
            .get("result_urls")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|item| !item.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        if let Some(single) = map
            .get("result_url")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|item| !item.is_empty())
        {
            if !urls.iter().any(|item| item == single) {
                urls.insert(0, single.to_string());
            }
        }
        if matches!(state.as_str(), "success" | "succeeded" | "completed" | "finished") {
            return Some(if urls.is_empty() {
                Err("任务已完成, 但结果里没有图片地址".to_string())
            } else {
                Ok(urls)
            });
        }
        if matches!(
            state.as_str(),
            "failed" | "failure" | "error" | "canceled" | "cancelled" | "timeout"
        ) {
            let message = map
                .get("error")
                .and_then(|value| {
                    value
                        .as_str()
                        .map(str::to_string)
                        .or_else(|| value.get("message").and_then(Value::as_str).map(str::to_string))
                })
                .or_else(|| map.get("status").and_then(Value::as_str).map(str::to_string))
                .unwrap_or_else(|| "平台没有给出失败原因".to_string());
            return Some(Err(message));
        }
        // is_final 却没有可识别终态: 直接报错, 不要让用户陪着无限等
        Some(Err(format!("任务已结束但状态未知(state={state})")))
    }

    /// 轮询任务直到终态。3 秒一次、最长 5 分钟 —— 图片任务实测 30 秒左右。
    async fn poll_media_image_task(
        client: &reqwest::Client,
        base_url: &str,
        api_key: &str,
        task_id: &str,
    ) -> Result<Vec<String>, AIError> {
        let deadline =
            std::time::Instant::now() + std::time::Duration::from_secs(Self::MEDIA_IMAGE_TIMEOUT_SECS);
        let mut last_state = String::from("未知");
        loop {
            if std::time::Instant::now() >= deadline {
                return Err(AIError::TaskFailed(format!(
                    "等待图片生成超时（{} 秒，最后状态：{}）—— 平台侧可能仍在生成，可稍后到平台后台按任务号 {} 查看",
                    Self::MEDIA_IMAGE_TIMEOUT_SECS,
                    last_state,
                    task_id
                )));
            }
            let url = format!("{}/v1/skills/task-status?task_id={}", base_url, task_id);
            let response = client
                .get(&url)
                .bearer_auth(api_key)
                .header("Accept-Encoding", "identity")
                .send()
                .await;
            let response = match response {
                Ok(response) => response,
                Err(error) => {
                    // 网络抖动(代理断连 / 连接重置)不该判死, 等下一轮再问
                    last_state = format!("查询失败 {}", error);
                    tokio::time::sleep(std::time::Duration::from_secs(
                        Self::MEDIA_IMAGE_POLL_INTERVAL_SECS,
                    ))
                    .await;
                    continue;
                }
            };
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            if status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                last_state = format!("HTTP {}", status.as_u16());
                tokio::time::sleep(std::time::Duration::from_secs(
                    Self::MEDIA_IMAGE_POLL_INTERVAL_SECS,
                ))
                .await;
                continue;
            }
            if !status.is_success() {
                return Err(AIError::TaskFailed(format!(
                    "查询图片任务失败 (HTTP {}): {}",
                    status.as_u16(),
                    text.chars().take(300).collect::<String>()
                )));
            }
            let payload: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            if let Some(state) = payload.get("state").and_then(Value::as_str) {
                last_state = state.to_string();
            }
            match Self::media_image_task_outcome(&payload) {
                Some(Ok(urls)) => return Ok(urls),
                Some(Err(reason)) => {
                    return Err(AIError::TaskFailed(format!("图片生成失败: {reason}")))
                }
                None => {
                    tokio::time::sleep(std::time::Duration::from_secs(
                        Self::MEDIA_IMAGE_POLL_INTERVAL_SECS,
                    ))
                    .await;
                }
            }
        }
    }

    /// 走 media 信封生成一张图片: 提交 → 轮询 → 返回结果地址。
    async fn generate_image_via_media(
        client: &reqwest::Client,
        base_url: &str,
        api_key: &str,
        api_model: &str,
        prompt: &str,
        resolution: &str,
        aspect_ratio: &str,
        reference_images: Option<&Vec<String>>,
        extra_params: Option<&HashMap<String, Value>>,
    ) -> Result<String, AIError> {
        let body = Self::build_media_image_body(
            api_model,
            prompt,
            resolution,
            aspect_ratio,
            reference_images,
            extra_params,
        )?;
        let endpoint = format!("{}/v1/media/generate", base_url);
        info!(
            "[OpenAI Compatible] media 信封出图: model={}, has_reference={}",
            api_model,
            reference_images.map(|items| !items.is_empty()).unwrap_or(false)
        );
        let response = client
            .post(&endpoint)
            .bearer_auth(api_key)
            .header("Accept-Encoding", "identity")
            .json(&body)
            .send()
            .await?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        let payload: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if !status.is_success() {
            return Err(AIError::TaskFailed(format!(
                "自定义平台 media 提交失败 (HTTP {}): {} [endpoint: {}]",
                status.as_u16(),
                if text.trim().is_empty() {
                    "空响应体".to_string()
                } else {
                    text.chars().take(300).collect::<String>()
                },
                endpoint
            )));
        }
        if let Some(error) = Self::media_business_error(&payload) {
            return Err(AIError::TaskFailed(format!(
                "自定义平台 media 提交被拒绝: {error} [endpoint: {}]",
                endpoint
            )));
        }
        let task_id = Self::media_task_id(&payload).ok_or_else(|| {
            AIError::TaskFailed(format!(
                "media 提交响应里没有 task_id: {}",
                text.chars().take(300).collect::<String>()
            ))
        })?;
        let urls = Self::poll_media_image_task(client, base_url, api_key, &task_id).await?;
        Self::serialize_image_sources(urls)
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
            } else if reference_image_field == "images" {
                // 知鸟 AI 等平台把参考图定义为 images 数组, 单图也必须是数组。
                let encoded_images = images
                    .into_iter()
                    .map(|image| Self::encode_reference_image(image, reference_image_encoding))
                    .collect::<Vec<_>>();
                body["images"] = json!(encoded_images);
            } else if reference_image_field == "reference_images" {
                // 字子动画等平台按文档要求参考图是对象数组: [{"url": "..."}]。
                let encoded_images = images
                    .into_iter()
                    .map(|image| Self::encode_reference_image(image, reference_image_encoding))
                    .collect::<Vec<_>>();
                body["reference_images"] = json!(
                    encoded_images
                        .into_iter()
                        .map(|url| json!({ "url": url }))
                        .collect::<Vec<_>>()
                );
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
        provider_id: &str,
        api_model: &str,
        reference_image_count: usize,
    ) -> &'static str {
        // The 65535 Gemini image channel requires multipart edits whenever
        // references are present. Keep this model-specific override ahead of
        // the legacy generations_json default saved by older builds.
        if reference_image_count > 0 && Self::uses_65535_gemini_edits(provider_id, api_model) {
            return "edits_multipart";
        }
        match extra_params
            .as_ref()
            .and_then(|params| params.get("image_transport"))
            .and_then(|value| value.as_str())
        {
            Some("generations_json") => "generations_json",
            Some("edits_multipart") => "edits_multipart",
            Some("apimart_json") => "apimart_json",
            _ => "generations_json",
        }
    }

    fn uses_65535_gemini_edits(provider_id: &str, api_model: &str) -> bool {
        provider_id == "custom:65535" && {
            let model = api_model.to_ascii_lowercase();
            model.contains("gemini") && model.contains("image")
        }
    }

    async fn build_edits_form(
        provider_id: &str,
        api_model: &str,
        prompt: &str,
        resolution: &str,
        aspect_ratio: &str,
        reference_images: Option<&Vec<String>>,
        image_count: u32,
    ) -> Result<Form, AIError> {
        let mut form = Form::new()
            .text("model", api_model.to_string())
            .text("prompt", prompt.to_string())
            .text(
                "size",
                if Self::uses_65535_gemini_edits(provider_id, api_model) {
                    match resolution.trim().to_ascii_uppercase().as_str() {
                        "1K" | "2K" | "4K" => resolution.trim().to_ascii_uppercase(),
                        _ => Self::map_requested_image_size(api_model, resolution, aspect_ratio),
                    }
                } else {
                    Self::map_requested_image_size(api_model, resolution, aspect_ratio)
                },
            )
            .text("n", image_count.to_string());
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
            Some("images") => "images",
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

    /// 生成模式(mode): 知鸟 AI(TokenGo)等平台把「参考图语义」放在这个 model 参数上,
    /// 默认 text-to-image 会**忽略**随请求送来的参考图, 因此有参考图时必须显式声明
    /// image-edit(单图编辑) / multi-reference(多图融合)。
    fn resolve_image_mode(extra_params: &Option<HashMap<String, Value>>) -> Option<String> {
        extra_params
            .as_ref()
            .and_then(|params| params.get("image_generation_mode"))
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    }

    /// 把 mode 合并进已构造好的请求体; 未配置该参数时原样不动。
    fn apply_image_mode(body: &mut Value, extra_params: &Option<HashMap<String, Value>>) {
        if let Some(mode) = Self::resolve_image_mode(extra_params) {
            body["mode"] = json!(mode);
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
        if reference_image_field == "input_image" || reference_image_field == "images" {
            "image"
        } else if reference_image_field == "reference_images" {
            // 字子动画文档写明老字段 image 会自动对齐, 兜底回退到 image。
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

    /// 提取响应中的全部图片。供应商常把多张图放在 data[] / output[] / choices[]，
    /// 旧实现只取 first，导致模型实际返回 4 张时画布只显示 1 张。
    fn extract_image_data_all(payload: &Value) -> Vec<String> {
        fn push_value(value: &Value, key: &str, output: &mut Vec<String>) {
            match value {
                Value::String(text)
                    if (matches!(key, "b64_json" | "url" | "image" | "images" | "image_url" | "image_urls" | "result" | "results" | "artifacts")
                        || (matches!(key, "data" | "output" | "choices" | "message" | "task" | "job")
                            && (text.starts_with("http://")
                                || text.starts_with("https://")
                                || text.starts_with("data:")))
                        || (key.is_empty()
                            && (text.starts_with("http://")
                                || text.starts_with("https://")
                                || text.starts_with("data:"))))
                        && !text.trim().is_empty() =>
                {
                    let normalized = if key == "b64_json" {
                        format!("data:image/png;base64,{}", text)
                    } else if key == "result"
                        && !text.starts_with("http://")
                        && !text.starts_with("https://")
                        && !text.starts_with("data:")
                    {
                        format!("data:image/png;base64,{}", text)
                    } else {
                        text.to_string()
                    };
                    if !output.iter().any(|item| item == &normalized) {
                        output.push(normalized);
                    }
                }
                Value::String(text) if matches!(key, "content" | "text") => {
                    if let Some(url) = OpenAICompatibleProvider::extract_url_from_chat_content(text) {
                        if !output.iter().any(|item| item == &url) {
                            output.push(url);
                        }
                    }
                }
                Value::Array(items) => {
                    for item in items {
                        push_value(item, key, output);
                    }
                }
                Value::Object(object) => {
                    for (child_key, child_value) in object {
                        if matches!(child_key.as_str(), "b64_json" | "url" | "image" | "images" | "image_url" | "image_urls" | "result" | "results" | "artifacts") {
                            push_value(child_value, child_key, output);
                        } else if matches!(child_key.as_str(), "data" | "output" | "choices" | "message" | "content" | "task" | "job" | "images" | "results" | "artifacts") {
                            push_value(child_value, child_key, output);
                        }
                    }
                }
                _ => {}
            }
        }

        let mut output = Vec::new();
        push_value(payload, "", &mut output);
        output
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
    /// data URL / http(s) URL 原样返回(超预算的 data URL 先缩放);本地路径/文件 URL 读取并转 base64 data URL。
    fn reference_image_to_image_field(source: &str) -> Result<Option<String>, AIError> {
        let trimmed = source.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }
        if let Some(payload) = trimmed.strip_prefix("data:") {
            return Ok(Some(Self::compact_reference_data_url(payload)));
        }
        if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
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
        // 本地原图(base64 之前的那一份)同样受体积预算约束, 否则一张手机直出
        // 的 8MB PNG 会让整个请求体膨胀到 30MB 级别。
        let (bytes, mime) = Self::compact_inline_reference(bytes, mime);
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

    fn supports_video_task_resume(&self) -> bool {
        // 视频提交后立刻落库平台任务 ID, 之后凭它续查。若返回 false,
        // submit_generate_video_job 会把长轮询整个塞进进程内任务 —— 进程一退,
        // 仍在平台生成(且已计费)的任务就被判成中断。
        true
    }

    async fn submit_video_task(
        &self,
        request: GenerateVideoRequest,
    ) -> Result<ProviderTaskSubmission, AIError> {
        OpenAICompatibleProvider::submit_video_task(self, request).await
    }

    async fn poll_video_task(
        &self,
        handle: ProviderTaskHandle,
    ) -> Result<ProviderTaskPollResult, AIError> {
        OpenAICompatibleProvider::poll_video_task(self, handle).await
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
        let client = Self::build_image_client();
        // WGSPAI gpt-image 强制走 Responses API(该平台只通过 image_generation tool 提供能力)
        let force_wgspai_responses = Self::uses_wgspai_responses(provider_id, api_model);
        let image_protocol = Self::resolve_image_protocol(&request.extra_params);
        let is_responses = image_protocol == "responses" || force_wgspai_responses;
        let is_chat = image_protocol == "chat";
        let reference_image_field = Self::resolve_reference_image_field(&request.extra_params, api_model);
        let reference_image_encoding = Self::resolve_reference_image_encoding(&request.extra_params, reference_image_field);
        let reference_image_count = request.reference_images.as_ref().map(|images| images.len()).unwrap_or(0);
        let image_count = Self::resolve_image_count(&request);
        let image_transport = Self::resolve_image_transport(
            &request.extra_params,
            provider_id,
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
        // 已经吃过一次「该模型不支持 /v1/images/*」的 400: 直接走 media, 不再整包上传两次。
        // 文档里声明只走 media 的那批图片模型(灵柯 21 个)同样直接走, 不用先白试一次。
        if !is_responses
            && !is_chat
            && (Self::media_envelope_known(provider_id, api_model)
                || Self::declared_media_only_image_model(&base_url, api_model))
        {
            return Self::generate_image_via_media(
                &client,
                &base_url,
                &api_key,
                api_model,
                &request.prompt,
                &request.size,
                &request.aspect_ratio,
                request.reference_images.as_ref(),
                request.extra_params.as_ref(),
            )
            .await;
        }
        let response = if is_responses {
            let mut body = Self::build_responses_body(
                    api_model,
                    &request.prompt,
                    &request.size,
                    &request.aspect_ratio,
                    request.reference_images.as_ref(),
                )
                .await?;
            Self::apply_image_count(&mut body, image_count);
            Self::send_image_request("图片提交", &endpoint, || {
                client
                    .post(&endpoint)
                    .bearer_auth(&api_key)
                    .header("Accept-Encoding", "identity")
                    .json(&body)
            })
            .await?
        } else if is_chat {
            let mut body = Self::build_chat_body(
                    api_model,
                    &request.prompt,
                    request.reference_images.as_ref(),
                )?;
            Self::apply_image_count(&mut body, image_count);
            Self::send_image_request("图片提交", &endpoint, || {
                client
                    .post(&endpoint)
                    .bearer_auth(&api_key)
                    .header("Accept-Encoding", "identity")
                    .json(&body)
            })
            .await?
        } else if image_transport == "edits_multipart" && reference_image_count > 0 {
            let form = Self::build_edits_form(
                provider_id,
                api_model,
                &request.prompt,
                &request.size,
                &request.aspect_ratio,
                request.reference_images.as_ref(),
                image_count,
            )
            .await?;
            client
                .post(&endpoint)
                .bearer_auth(&api_key)
                .header("Accept-Encoding", "identity")
                .multipart(form)
                .send()
                .await
                .map_err(|error| Self::send_failure(error, "图片上传(multipart)", &endpoint))?
        } else {
            let mut body = if image_transport == "apimart_json" {
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
            Self::apply_image_count(&mut body, image_count);
            Self::apply_model_extra_params(&mut body, &request.extra_params);
            Self::apply_image_mode(&mut body, &request.extra_params);
            Self::send_image_request("图片提交", &endpoint, || {
                client
                    .post(&endpoint)
                    .bearer_auth(&api_key)
                    .header("Accept-Encoding", "identity")
                    .json(&body)
            })
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
            let mut fallback_body = Self::build_request_body(
                api_model,
                &request.prompt,
                &request.size,
                &request.aspect_ratio,
                request.reference_images.as_ref(),
                "input_image",
                "raw_base64",
            )?;
            Self::apply_image_count(&mut fallback_body, image_count);
            Self::apply_model_extra_params(&mut fallback_body, &request.extra_params);
            Self::apply_image_mode(&mut fallback_body, &request.extra_params);
            info!(
                "[OpenAI Compatible Request] WGSPAI gpt-image Responses 404, falling back to /v1/images/generations"
            );
            let fallback_response = client
                .post(format!("{}/v1/images/generations", base_url))
                .bearer_auth(&api_key)
                .header("Accept-Encoding", "identity")
                .json(&fallback_body)
                .send()
                .await
                .map_err(|error| Self::send_failure(error, "降级请求", &endpoint))?;
            (status, body_text) = Self::read_response_text(fallback_response, "自定义平台图片降级请求").await?;
        }

        // 仅 images 协议做参考图字段重试; responses/chat 协议的请求体字段固定。
        if image_protocol == "images" && Self::should_retry_with_alternate_reference_field(
            status,
            &body_text,
            reference_image_count,
        ) {
            let alternate_field = Self::alternate_reference_image_field(reference_image_field);
            let mut alternate_body = Self::build_request_body(
                api_model,
                &request.prompt,
                &request.size,
                &request.aspect_ratio,
                request.reference_images.as_ref(),
                alternate_field,
                Self::resolve_reference_image_encoding(&request.extra_params, alternate_field),
            )?;
            Self::apply_image_count(&mut alternate_body, image_count);
            Self::apply_model_extra_params(&mut alternate_body, &request.extra_params);
            Self::apply_image_mode(&mut alternate_body, &request.extra_params);
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
                .await
                .map_err(|error| Self::send_failure(error, "参考图字段重试", &endpoint))?;
            (status, body_text) = Self::read_response_text(retry_response, "自定义平台图片重试请求").await?;
        }
        // 灵柯网关: 部分图片模型只挂 media 信封, `/v1/images/*` 会 400 并明说该怎么走。
        // 按报错兜底而不是按模型名预判 —— 平台会把短名映射成上游真名
        // (banana-2.1 → gemini-nano-banana-2.1), 前端那层根本看不到真名。
        if !status.is_success() && Self::image_requires_media_envelope(&body_text) {
            // 记住这个模型, 下次直接走 media(省掉一次十几 MB 的必败上传)
            Self::remember_media_envelope(provider_id, api_model);
            info!(
                "[OpenAI Compatible] {} 不支持 /v1/images/*, 改用 /v1/media/generate",
                api_model
            );
            return Self::generate_image_via_media(
                &client,
                &base_url,
                &api_key,
                api_model,
                &request.prompt,
                &request.size,
                &request.aspect_ratio,
                request.reference_images.as_ref(),
                request.extra_params.as_ref(),
            )
            .await;
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
            return Self::serialize_image_sources(Self::extract_image_data_all(&payload));
        }

        if active_protocol == "chat" {
            return Self::serialize_image_sources(Self::extract_image_data_all(&payload));
        }

        Self::serialize_image_sources(Self::extract_image_data_all(&payload))
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
        let client = Self::build_image_client();
        // WGSPAI gpt-image 强制走 Responses API(该平台只通过 image_generation tool 提供能力)
        let force_wgspai_responses = Self::uses_wgspai_responses(provider_id, api_model);
        let image_protocol = Self::resolve_image_protocol(&request.extra_params);
        let is_responses = image_protocol == "responses" || force_wgspai_responses;
        let is_chat = image_protocol == "chat";
        let reference_image_field = Self::resolve_reference_image_field(&request.extra_params, api_model);
        let reference_image_encoding = Self::resolve_reference_image_encoding(&request.extra_params, reference_image_field);
        let reference_image_count = request.reference_images.as_ref().map(|images| images.len()).unwrap_or(0);
        let image_count = Self::resolve_image_count(&request);
        let image_transport = Self::resolve_image_transport(
            &request.extra_params,
            provider_id,
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
            let mut body = Self::build_responses_body(
                    api_model,
                    &request.prompt,
                    &request.size,
                    &request.aspect_ratio,
                    request.reference_images.as_ref(),
                )
                .await?;
            Self::apply_image_count(&mut body, image_count);
            Self::send_image_request("图片提交", &endpoint, || {
                client
                    .post(&endpoint)
                    .bearer_auth(&api_key)
                    .header("Accept-Encoding", "identity")
                    .json(&body)
            })
            .await?
        } else if is_chat {
            let mut body = Self::build_chat_body(
                    api_model,
                    &request.prompt,
                    request.reference_images.as_ref(),
                )?;
            Self::apply_image_count(&mut body, image_count);
            Self::send_image_request("图片提交", &endpoint, || {
                client
                    .post(&endpoint)
                    .bearer_auth(&api_key)
                    .header("Accept-Encoding", "identity")
                    .json(&body)
            })
            .await?
        } else if image_transport == "edits_multipart" && reference_image_count > 0 {
            let form = Self::build_edits_form(
                provider_id,
                api_model,
                &request.prompt,
                &request.size,
                &request.aspect_ratio,
                request.reference_images.as_ref(),
                image_count,
            )
            .await?;
            client
                .post(&endpoint)
                .bearer_auth(&api_key)
                .header("Accept-Encoding", "identity")
                .multipart(form)
                .send()
                .await
                .map_err(|error| Self::send_failure(error, "图片上传(multipart)", &endpoint))?
        } else {
            let mut body = if image_transport == "apimart_json" {
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
            Self::apply_image_count(&mut body, image_count);
            Self::apply_model_extra_params(&mut body, &request.extra_params);
            Self::apply_image_mode(&mut body, &request.extra_params);
            Self::send_image_request("图片提交", &endpoint, || {
                client
                    .post(&endpoint)
                    .bearer_auth(&api_key)
                    .header("Accept-Encoding", "identity")
                    .json(&body)
            })
            .await?
        };
        let (mut status, mut body_text) = Self::read_response_text(response, "自定义平台异步提交").await?;

        // WGSPAI gpt-image: Responses 404 时降级到 Images API + input_image 重试一次。
        if force_wgspai_responses
            && status == reqwest::StatusCode::NOT_FOUND
            && body_text.to_ascii_lowercase().contains("not found")
        {
            let mut fallback_body = Self::build_request_body(
                api_model,
                &request.prompt,
                &request.size,
                &request.aspect_ratio,
                request.reference_images.as_ref(),
                "input_image",
                "raw_base64",
            )?;
            Self::apply_image_count(&mut fallback_body, image_count);
            Self::apply_model_extra_params(&mut fallback_body, &request.extra_params);
            Self::apply_image_mode(&mut fallback_body, &request.extra_params);
            info!(
                "[OpenAI Compatible Request] async: WGSPAI gpt-image Responses 404, falling back to /v1/images/generations"
            );
            let fallback_response = client
                .post(format!("{}/v1/images/generations", base_url))
                .bearer_auth(&api_key)
                .header("Accept-Encoding", "identity")
                .json(&fallback_body)
                .send()
                .await
                .map_err(|error| Self::send_failure(error, "降级请求", &endpoint))?;
            (status, body_text) = Self::read_response_text(fallback_response, "自定义平台异步降级请求").await?;
        }

        // 仅 images 协议做参考图字段重试; responses/chat 协议的请求体字段固定。
        if image_protocol == "images" && image_transport == "generations_json" && Self::should_retry_with_alternate_reference_field(
            status,
            &body_text,
            reference_image_count,
        ) {
            let alternate_field = Self::alternate_reference_image_field(reference_image_field);
            let mut alternate_body = Self::build_request_body(
                api_model,
                &request.prompt,
                &request.size,
                &request.aspect_ratio,
                request.reference_images.as_ref(),
                alternate_field,
                Self::resolve_reference_image_encoding(&request.extra_params, alternate_field),
            )?;
            Self::apply_image_count(&mut alternate_body, image_count);
            Self::apply_model_extra_params(&mut alternate_body, &request.extra_params);
            Self::apply_image_mode(&mut alternate_body, &request.extra_params);
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
                .await
                .map_err(|error| Self::send_failure(error, "参考图字段重试", &endpoint))?;
            (status, body_text) = Self::read_response_text(retry_response, "自定义平台异步重试").await?;
        }
        // 同 `generate`: 只挂 media 信封的图片模型在异步模式下也一样要重投。
        // 图片任务本身只有几十秒, 这里直接走「提交 + 轮询」并当作已完成返回,
        // 不再落一条异步任务记录 —— 免得用户在任务列表里看到一条秒完的僵尸任务。
        if !status.is_success() && Self::image_requires_media_envelope(&body_text) {
            // 记住这个模型, 下次直接走 media(省掉一次十几 MB 的必败上传)
            Self::remember_media_envelope(provider_id, api_model);
            info!(
                "[OpenAI Compatible] async: {} 不支持 /v1/images/*, 改用 /v1/media/generate",
                api_model
            );
            let image = Self::generate_image_via_media(
                &client,
                &base_url,
                &api_key,
                api_model,
                &request.prompt,
                &request.size,
                &request.aspect_ratio,
                request.reference_images.as_ref(),
                request.extra_params.as_ref(),
            )
            .await?;
            return Ok(ProviderTaskSubmission::Succeeded(image));
        }
        let payload: Value = serde_json::from_str(&body_text).unwrap_or(Value::Null);

        if status.is_success() {
            // 平台同步直接返回图片
            let images = Self::extract_image_data_all(&payload);
            if !images.is_empty() {
                return Ok(ProviderTaskSubmission::Succeeded(
                    Self::serialize_image_sources(images)?,
                ));
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

            let images = Self::extract_image_data_all(&payload);
            if !images.is_empty() {
                return Ok(ProviderTaskPollResult::Succeeded(
                    Self::serialize_image_sources(images)?,
                ));
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

    async fn generate_video(&self, request: GenerateVideoRequest) -> Result<String, AIError> {
        OpenAICompatibleProvider::generate_video(self, request).await
    }
}

#[cfg(test)]
mod tests {
    use super::{is_complete_json_body, prompt_policy_hint, OpenAICompatibleProvider};
    use serde_json::json;
    use std::collections::HashMap;

    /// 中转网关传大图片时收尾断流, body 往往仍是完整 JSON —— 必须采信,
    /// 否则用户丢掉的是**已经在平台侧计费**的结果。
    #[test]
    fn complete_json_bodies_are_rescued_from_truncated_streams() {
        assert!(is_complete_json_body(br#"{"data":[{"b64_json":"AAAA"}]}"#));
        assert!(is_complete_json_body(br#"  {"id":"x"}  "#));
        // 半截 JSON / 空 body / 网关 HTML 错误页 一律不能采信。
        assert!(!is_complete_json_body(br#"{"data":[{"b64_json":"AAA"#));
        assert!(!is_complete_json_body(b""));
        assert!(!is_complete_json_body(b"<html>502 Bad Gateway</html>"));
    }

    /// 起一个「声明了 Content-Length 却提前关连接」的对端 —— 中转网关截断响应的典型形态。
    ///
    /// **必须先读走请求再回应**: 服务器端带着未读的接收数据关闭连接时, Windows 会发 RST,
    /// 客户端在 `send()` 阶段就报 `10053 ConnectionAborted` —— 走不到「读 body」那一步,
    /// 这种失败与被测行为无关, 纯属测试服务器写法问题。
    async fn serve_truncated_response(body: &'static [u8], declared_extra: usize) -> std::net::SocketAddr {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let address = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            if let Ok((mut stream, _)) = listener.accept().await {
                // 请求是 GET, 很短, 一次读就能读干净。
                let mut request = [0u8; 2048];
                let _ = stream.read(&mut request).await;
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                    body.len() + declared_extra
                );
                let _ = stream.write_all(head.as_bytes()).await;
                let _ = stream.write_all(body).await;
                let _ = stream.flush().await;
                // 发完就 FIN: 声明长度永远收不满 → 客户端读到 IncompleteMessage。
                let _ = stream.shutdown().await;
            }
        });
        address
    }

    /// 断流但**数据完整**时必须采信 —— 丢掉它等于让用户白丢一次已在平台侧计费的出图
    /// （实报 `req_39d98b3b-d6e8-4467-b221-4225be7639fc`）。
    #[tokio::test]
    async fn rescues_a_complete_body_from_a_truncated_response() {
        let address = serve_truncated_response(br#"{"data":[{"b64_json":"AAAA"}]}"#, 100).await;
        // 必须 no_proxy(): 本机若开着系统代理, 发往 127.0.0.1 的请求会被劫持成 502
        // (仓库里已踩过多次, 见 commands/novel.rs 顶部注释), 测试随之变成假阴性。
        let response = reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("client")
            .get(format!("http://{address}/v1/images/generations"))
            .send()
            .await
            .expect("响应头应当到手");
        let (status, body) = OpenAICompatibleProvider::read_response_text(response, "测试图片请求")
            .await
            .expect("已收字节是完整 JSON, 必须采信");
        assert!(status.is_success());
        assert!(body.contains("b64_json"));
    }

    /// 断流且数据**残缺**时仍然报错, 但文案必须带上已收字节数与 request_id ——
    /// 否则用户贴出来的报错还是那句无从下手的 "error decoding response body"。
    #[tokio::test]
    async fn reports_received_bytes_when_the_truncated_body_is_incomplete() {
        // 声明长度比实际多 100 字节 → 客户端必然读到 IncompleteMessage, 拿到的 JSON 也是残缺的。
        let address = serve_truncated_response(br#"{"data":[{"b64_json":"AAA"#, 100).await;
        // 必须 no_proxy(): 本机若开着系统代理, 发往 127.0.0.1 的请求会被劫持成 502
        // (仓库里已踩过多次, 见 commands/novel.rs 顶部注释), 测试随之变成假阴性。
        let response = reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("client")
            .get(format!("http://{address}/v1/images/generations"))
            .send()
            .await
            .expect("响应头应当到手");
        let error = OpenAICompatibleProvider::read_response_text(response, "测试图片请求")
            .await
            .expect_err("残缺 JSON 必须报错");
        let text = error.to_string();
        assert!(text.contains("测试图片请求"), "{text}");
        assert!(text.contains("已收"), "{text}");
        assert!(text.contains("request_id="), "{text}");
    }

    /// OpenAI 推理模型的输入内容预检拒绝: 必须补上可操作的中文指引, 其它错误保持原样。
    #[test]
    fn prompt_policy_rejection_gets_an_actionable_hint() {
        let rejection = r#"{"error":{"code":"invalid_prompt","message":"Invalid prompt: your prompt was flagged as potentially violating our usage policy. Please try again with a different prompt: https://platform.openai.com/docs/guides/reasoning#advice-on-prompting","param":null,"type":"invalid_request_error"}}"#;
        assert!(prompt_policy_hint(rejection).contains("重试"));
        assert!(prompt_policy_hint(rejection).contains("非 OpenAI 推理模型"));
        assert_eq!(prompt_policy_hint(r#"{"error":{"message":"invalid api key"}}"#), "");
        assert_eq!(prompt_policy_hint(""), "");
    }

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
    fn extracts_all_openai_image_results_and_serializes_multiple_sources() {
        let payload = json!({
            "data": [
                { "url": "https://cdn.example.com/one.png" },
                { "b64_json": "QUJD" },
                { "url": "https://cdn.example.com/one.png" }
            ]
        });
        let images = OpenAICompatibleProvider::extract_image_data_all(&payload);
        assert_eq!(images.len(), 2);
        assert_eq!(images[0], "https://cdn.example.com/one.png");
        assert_eq!(images[1], "data:image/png;base64,QUJD");
        let serialized = OpenAICompatibleProvider::serialize_image_sources(images)
            .expect("multiple image sources should serialize");
        let parsed: Vec<String> = serde_json::from_str(&serialized).expect("serialized image list");
        assert_eq!(parsed.len(), 2);

        let direct_urls = json!({
            "output": [
                "https://cdn.example.com/two.png",
                "https://cdn.example.com/three.png"
            ]
        });
        assert_eq!(
            OpenAICompatibleProvider::extract_image_data_all(&direct_urls),
            vec![
                "https://cdn.example.com/two.png".to_string(),
                "https://cdn.example.com/three.png".to_string(),
            ]
        );
    }

    #[test]
    fn detects_failed_video_status_nested_in_arrays() {
        let payload = json!({
            "data": [{
                "task": { "status": "failed", "failureReason": "内容审核未通过" }
            }]
        });

        assert_eq!(OpenAICompatibleProvider::video_task_status(&payload), "FAILED");
        assert_eq!(
            OpenAICompatibleProvider::video_failure_reason(&payload).as_deref(),
            Some("内容审核未通过")
        );
    }

    #[test]
    fn recognizes_expired_and_timeout_video_states() {
        for status in ["FAIL", "EXPIRED", "TIMEOUT", "TIMED_OUT", "ABORTED"] {
            let payload = json!({ "result": [{ "task_status": status }] });
            assert_eq!(OpenAICompatibleProvider::video_task_status(&payload), status);
        }
    }

    #[test]
    fn extracts_video_url_from_nested_media_fields_and_message_text() {
        let payload = json!({
            "status": "completed",
            "data": [{
                "media": { "contentUrl": "https://cdn.example.com/result.mp4" },
                "message": "视频已生成：https://cdn.example.com/message.mp4"
            }]
        });

        assert_eq!(
            OpenAICompatibleProvider::video_result_url(&payload).as_deref(),
            Some("https://cdn.example.com/result.mp4")
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
    fn uses_edits_transport_only_for_65535_gemini_reference_images() {
        assert_eq!(
            OpenAICompatibleProvider::resolve_image_transport(
                &None,
                "custom:65535",
                "gemini-3-pro-image",
                1,
            ),
            "edits_multipart"
        );
        let legacy_generations = Some(HashMap::from([(
            "image_transport".to_string(),
            json!("generations_json"),
        )]));
        assert_eq!(
            OpenAICompatibleProvider::resolve_image_transport(
                &legacy_generations,
                "custom:65535",
                "gemini-3.1-flash-image",
                2,
            ),
            "edits_multipart"
        );
        assert_eq!(
            OpenAICompatibleProvider::resolve_image_transport(
                &None,
                "custom:65535",
                "gpt-image-2",
                1,
            ),
            "generations_json"
        );
        assert_eq!(
            OpenAICompatibleProvider::resolve_image_transport(
                &None,
                "custom:65535",
                "gemini-3-pro-image",
                0,
            ),
            "generations_json"
        );
        assert_eq!(
            OpenAICompatibleProvider::resolve_image_transport(
                &None,
                "custom:other",
                "gemini-3-pro-image",
                1,
            ),
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
    fn clamps_relay_gpt_image_2_to_pixel_budget() {
        // 中转平台的 `gpt-image-2` 走非 native 协议(仍发 aspect_ratio), 但上游同样限制
        // 8,294,400 像素。4K + 4:3 直接拼出 3840x2880 = 11.06M 会被 400 拒绝:
        // "invalid params.size ... total pixels must be <= 8294400"。
        let size = OpenAICompatibleProvider::map_requested_image_size("gpt-image-2", "4K", "4:3");
        let (width, height) = size.split_once('x').expect("size should be WxH");
        let width: u64 = width.parse().expect("width should be numeric");
        let height: u64 = height.parse().expect("height should be numeric");

        assert!(
            width * height <= 8_294_400,
            "{size} = {} px 超出预算",
            width * height
        );
        assert!(width <= 3840 && height <= 3840, "{size} 单边超过 3840");
        assert_eq!(size, "3312x2480");
    }

    #[test]
    fn pixel_budget_does_not_shrink_16_9_or_untouched_models() {
        // 16:9 / 9:16 的 4K 正好等于预算上限, 不应被缩小。
        assert_eq!(
            OpenAICompatibleProvider::map_requested_image_size("gpt-image-2", "4K", "16:9"),
            "3840x2160",
        );
        assert_eq!(
            OpenAICompatibleProvider::map_requested_image_size("gpt-image-2", "4K", "9:16"),
            "2160x3840",
        );
        // 非 OpenAI 图像族的模型不受该预算约束, 保持原样。
        assert_eq!(
            OpenAICompatibleProvider::map_requested_image_size("seedream-4", "4K", "4:3"),
            "3840x2880",
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

    /// 灵柯网关的 400 文案: 该模型只挂了 media 信封。别把普通参数错误也当成它。
    #[test]
    fn recognises_the_media_envelope_hint() {
        let real = r#"{"error":{"message":"模型 'gemini-nano-banana-2.1' 不支持 /v1/images/* 端点，请改用 POST /v1/media/generate（请求体 model 指定模型）","type":"invalid_request_error"}}"#;
        assert!(OpenAICompatibleProvider::image_requires_media_envelope(real));

        // 没有提到 media 信封的一律不重投, 否则会白白多打一次请求
        assert!(!OpenAICompatibleProvider::image_requires_media_envelope(
            r#"{"error":{"message":"invalid size"}}"#
        ));
        assert!(!OpenAICompatibleProvider::image_requires_media_envelope(""));
        // 只提到 media/generate 但没说图片端点: 不认
        assert!(!OpenAICompatibleProvider::image_requires_media_envelope(
            r#"{"error":{"message":"media/generate is temporarily unavailable"}}"#
        ));
    }

    #[test]
    fn builds_media_envelope_with_references_and_tier_resolution() {
        let references = vec![
            "https://example.com/a.png".to_string(),
            String::new(),
        ];
        // banana 系是驼峰: 传 aspect_ratio / resolution 平台不报错, 直接按默认出图,
        // 比例与档位等于白选 —— 实测 2K/1:1 请求回了 16:9 之外的默认 2048x2048。
        let body = OpenAICompatibleProvider::build_media_image_body(
            "banana-2.1",
            "product hero shot",
            "2K",
            "1:1",
            Some(&references),
            None,
        )
        .expect("body");
        assert_eq!(body["model"], "banana-2.1");
        assert_eq!(body["prompt"], "product hero shot");
        assert_eq!(body["params"]["aspectRatio"], "1:1");
        assert_eq!(body["params"]["imageSize"], "2K");
        assert!(body["params"].get("aspect_ratio").is_none());
        assert!(body["params"].get("resolution").is_none());
        // 空参考图被丢掉, 公网 URL 原样透传; 字段名按文档是 images
        assert_eq!(body["params"]["images"], json!(["https://example.com/a.png"]));
        assert!(body["params"].get("image_url").is_none());

        // 像素尺寸不是档位枚举, 宁可让平台用默认档
        let body = OpenAICompatibleProvider::build_media_image_body(
            "banana-2.1",
            "x",
            "1024x1024",
            "1:1",
            None,
            None,
        )
        .expect("body");
        assert!(body["params"].get("imageSize").is_none());
        assert!(body["params"].get("images").is_none());
    }

    #[test]
    fn picks_media_image_param_names_by_model_family() {
        let build = |model: &str, resolution: &str, ratio: &str| {
            OpenAICompatibleProvider::build_media_image_body(model, "p", resolution, ratio, None, None)
                .expect("body")["params"]
                .clone()
        };

        // tt-image-2.5: 下划线 + resolution
        let params = build("tt-image-2.5", "4K", "16:9");
        assert_eq!(params["aspect_ratio"], "16:9");
        assert_eq!(params["resolution"], "4K");

        // doubao-seedream: 下划线 + size(档位)
        let params = build("doubao-seedream-5-0-260128", "2K", "3:4");
        assert_eq!(params["aspect_ratio"], "3:4");
        assert_eq!(params["size"], "2K");
        assert!(params.get("resolution").is_none());

        // tt-image-2: size 是像素枚举, 比例与档位折成像素串
        let params = build("tt-image-2", "2K", "16:9");
        assert_eq!(params["size"], "2560x1440");
        assert!(params.get("aspect_ratio").is_none());
        assert!(params.get("resolution").is_none());

        // qwen-image / wan: size 就是画幅比例
        let params = build("qwen-image", "2K", "1:1");
        assert_eq!(params["size"], "1:1");
        assert!(params.get("resolution").is_none());

        // 未知模型兜底走 aspect_ratio + resolution
        let params = build("gk-image-2.0", "2K", "1:1");
        assert_eq!(params["aspect_ratio"], "1:1");
        assert_eq!(params["resolution"], "2K");
    }

    #[test]
    fn drops_unsupported_aspect_ratio_values() {
        let build = |ratio: &str| {
            OpenAICompatibleProvider::build_media_image_body(
                "banana-2.1", "p", "2K", ratio, None, None,
            )
            .expect("body")["params"]
                .clone()
        };
        assert!(build("auto").get("aspectRatio").is_none());
        assert!(build("1024x1024").get("aspectRatio").is_none());
    }

    #[test]
    fn passes_model_specific_params_into_the_media_envelope() {
        // media 信封里连 Midjourney 的引擎都在 params 内, 且是驼峰 `botType`。
        // 不透传的话 `mj_imagine`(botType 必填) 会直接失败。
        let mut extra = HashMap::new();
        extra.insert("bot_type".to_string(), json!("niji"));
        extra.insert("stylize".to_string(), json!("250"));
        extra.insert("count".to_string(), json!(4));
        extra.insert("version".to_string(), json!(""));
        extra.insert("image_transport".to_string(), json!("generations_json"));

        let body = OpenAICompatibleProvider::build_media_image_body(
            "mj_imagine",
            "p",
            "2K",
            "1:1",
            None,
            Some(&extra),
        )
        .expect("body");

        assert_eq!(body["params"]["botType"], "niji");
        assert_eq!(body["params"]["stylize"], "250");
        // media 一次只出一张, count 是组数语义, 不能透传
        assert!(body["params"].get("count").is_none());
        // 空串 = 没选
        assert!(body["params"].get("version").is_none());
        // 客户端控制字段进不了请求体
        assert!(body["params"].get("image_transport").is_none());
    }

    #[test]
    fn parses_media_task_ids_of_both_types() {
        assert_eq!(
            OpenAICompatibleProvider::media_task_id(&json!({"code":200,"data":{"task_id":181687051}})),
            Some("181687051".to_string())
        );
        assert_eq!(
            OpenAICompatibleProvider::media_task_id(&json!({"data":{"task_id":"abc-1"}})),
            Some("abc-1".to_string())
        );
        assert_eq!(OpenAICompatibleProvider::media_task_id(&json!({"code":400})), None);
    }

    #[test]
    fn reads_media_task_outcomes() {
        // 还在跑
        assert!(OpenAICompatibleProvider::media_image_task_outcome(&json!({
            "is_final": false, "state": "running"
        }))
        .is_none());

        // 成功: result_url 与 result_urls 合并去重
        let done = OpenAICompatibleProvider::media_image_task_outcome(&json!({
            "is_final": true,
            "state": "success",
            "result_url": "https://tos.example.com/a.jpg",
            "result_urls": ["https://tos.example.com/a.jpg"],
        }));
        assert_eq!(
            done,
            Some(Ok(vec!["https://tos.example.com/a.jpg".to_string()]))
        );

        // 失败: 把平台给的原因原样带出来
        let failed = OpenAICompatibleProvider::media_image_task_outcome(&json!({
            "is_final": true,
            "state": "failed",
            "error": "content policy violation",
        }));
        assert_eq!(
            failed,
            Some(Err("content policy violation".to_string()))
        );

        // 已完成但没有图片地址: 不能当成成功返回空
        let empty = OpenAICompatibleProvider::media_image_task_outcome(&json!({
            "is_final": true,
            "state": "success",
            "result_urls": [],
        }));
        assert!(matches!(empty, Some(Err(_))));
    }

    /// 端到端走一遍 media 信封: 提交拿 task_id → 轮询 → 取回图片地址。
    /// 用本机 mock 对端, 不发真实请求也不花钱。
    #[tokio::test]
    async fn generates_image_through_the_media_envelope() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let address = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            let replies = [
                r#"{"code":200,"data":{"task_id":181687051},"msg":"任务创建成功"}"#,
                r#"{"is_final":true,"state":"success","result_url":"https://tos.example.com/out.jpg","result_urls":["https://tos.example.com/out.jpg"]}"#,
            ];
            for body in replies {
                let Ok((mut stream, _)) = listener.accept().await else { return };
                let mut buffer = [0u8; 8192];
                let _ = stream.read(&mut buffer).await;
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes()).await;
                let _ = stream.write_all(body.as_bytes()).await;
                let _ = stream.flush().await;
            }
        });

        let client = reqwest::Client::builder().no_proxy().build().expect("client");
        let base_url = format!("http://{address}");
        let image = OpenAICompatibleProvider::generate_image_via_media(
            &client,
            &base_url,
            "test-key",
            "banana-2.1",
            "a cat on a table",
            "2K",
            "1:1",
            None,
            None,
        )
        .await
        .expect("media 出图应当成功");
        assert_eq!(image, "https://tos.example.com/out.jpg");
    }

    /// 大图参考图必须被压到体积预算内, 否则请求体随手机照片线性膨胀。
    #[test]
    fn compacts_oversized_reference_images() {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        use image::GenericImageView;
        // 3000x2400 噪声 PNG: 接近手机直出照片的体积(解码后能被压缩才说明真的重编码了)
        let mut source = image::RgbImage::new(3000, 2400);
        let mut seed: u32 = 12345;
        for pixel in source.pixels_mut() {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            *pixel = image::Rgb([(seed >> 16) as u8, (seed >> 8) as u8, seed as u8]);
        }
        let mut png = Vec::new();
        source
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .expect("encode");
        let original_len = png.len();
        let data_url = format!("data:image/png;base64,{}", STANDARD.encode(&png));

        let compacted = OpenAICompatibleProvider::compact_reference_data_url(&data_url[5..]);
        let payload = compacted.strip_prefix("data:").expect("data url");
        let (metadata, encoded) = payload.split_once(',').expect("payload");
        assert!(metadata.contains("base64"));
        assert!(metadata.starts_with("image/"));
        let bytes = STANDARD.decode(encoded).expect("decode");
        assert!(
            bytes.len() < original_len / 4,
            "压缩后应当显著变小: {} -> {}",
            original_len,
            bytes.len()
        );
        let decoded = image::load_from_memory(&bytes).expect("decode image");
        let (width, height) = decoded.dimensions();
        assert_eq!(width.max(height), OpenAICompatibleProvider::INLINE_REFERENCE_MAX_SIDE);
    }

    /// 预算内的图必须原样透传: 重编码是有损的, 不能顺手把用户的小图也压一遍。
    #[test]
    fn keeps_small_reference_images_untouched() {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let mut source = image::RgbImage::new(64, 64);
        source.put_pixel(0, 0, image::Rgb([255, 0, 0]));
        let mut png = Vec::new();
        source
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .expect("encode");
        let data_url = format!("data:image/png;base64,{}", STANDARD.encode(&png));
        // 传进来的已经是去掉 `data:` 前缀的负载
        assert_eq!(
            OpenAICompatibleProvider::compact_reference_data_url(&data_url[5..]),
            data_url
        );
        // 公网 URL 不下载、不改写
        assert_eq!(
            OpenAICompatibleProvider::reference_image_to_image_field("https://example.com/a.png")
                .expect("ok")
                .as_deref(),
            Some("https://example.com/a.png")
        );
    }

    /// 传输层失败必须翻成人话: reqwest 的 Display 只有 "error sending request for url (…)"。
    #[tokio::test]
    async fn describes_connect_failures_in_plain_words() {
        let client = reqwest::Client::builder().no_proxy().build().expect("client");
        // 127.0.0.1:1 必然拒绝连接, 用它拿到一个真实的 connect 失败
        let error = client
            .post("http://127.0.0.1:1/v1/images/generations")
            .body("x")
            .send()
            .await
            .expect_err("应当连接失败");
        let described = OpenAICompatibleProvider::describe_send_failure(&error);
        assert!(
            described.contains("无法与上游建立连接"),
            "实际文案: {described}"
        );
        assert!(OpenAICompatibleProvider::is_retryable_send_failure(&error));
    }

    /// 第一次请求被对端直接掐断, 第二次成功: 用户不该看到失败。
    #[tokio::test]
    async fn retries_when_the_connection_dies_before_any_response() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let address = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            // 第 1 次: 读完请求立刻关连接(模拟传输层抖动 / 对端掐断)
            if let Ok((mut stream, _)) = listener.accept().await {
                let mut buffer = [0u8; 4096];
                let _ = stream.read(&mut buffer).await;
                drop(stream);
            }
            // 第 2 次: 正常返回
            if let Ok((mut stream, _)) = listener.accept().await {
                let mut buffer = [0u8; 4096];
                let _ = stream.read(&mut buffer).await;
                let body = r#"{"ok":true}"#;
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes()).await;
                let _ = stream.write_all(body.as_bytes()).await;
                let _ = stream.flush().await;
            }
        });

        let client = reqwest::Client::builder().no_proxy().build().expect("client");
        let endpoint = format!("http://{address}/v1/images/generations");
        let response = OpenAICompatibleProvider::send_image_request("测试", &endpoint, || {
            client.post(&endpoint).body("payload")
        })
        .await
        .expect("第二次应当成功");
        assert!(response.status().is_success());
    }

    /// 拿到状态码就说明平台已受理: 绝不能再重投(重复出图 = 重复计费)。
    #[tokio::test]
    async fn never_retries_after_a_status_code_arrives() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let address = listener.local_addr().expect("addr");
        let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = hits.clone();
        tokio::spawn(async move {
            for _ in 0..3 {
                let Ok((mut stream, _)) = listener.accept().await else { return };
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let mut buffer = [0u8; 4096];
                let _ = stream.read(&mut buffer).await;
                let body = r#"{"error":{"message":"boom"}}"#;
                let head = format!(
                    "HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes()).await;
                let _ = stream.write_all(body.as_bytes()).await;
                let _ = stream.flush().await;
            }
        });

        let client = reqwest::Client::builder().no_proxy().build().expect("client");
        let endpoint = format!("http://{address}/v1/images/generations");
        let response = OpenAICompatibleProvider::send_image_request("测试", &endpoint, || {
            client.post(&endpoint).body("payload")
        })
        .await
        .expect("500 是响应, 不是传输失败");
        assert_eq!(response.status().as_u16(), 500);
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    /// media 记忆按 provider+模型 记，且大小写不敏感（前端偶尔会把模型名大小写打得不一样）。
    #[test]
    fn remembers_which_models_only_speak_the_media_envelope() {
        assert!(!OpenAICompatibleProvider::media_envelope_known(
            "api666888-probe",
            "banana-probe-9"
        ));
        OpenAICompatibleProvider::remember_media_envelope("api666888-probe", "banana-probe-9");
        assert!(OpenAICompatibleProvider::media_envelope_known(
            "API666888-PROBE",
            "BANANA-PROBE-9"
        ));
        // 别的模型不受影响
        assert!(!OpenAICompatibleProvider::media_envelope_known(
            "api666888-probe",
            "tt-image-2.5"
        ));
    }
}
