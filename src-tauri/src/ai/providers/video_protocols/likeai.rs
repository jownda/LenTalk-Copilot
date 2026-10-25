// ---------------------------------------------------------------------------
// likeai520(api.likeai520.cc)Seedance 视频分组
//
// 官方文档: https://www.likeai520.cc/docs/api/video-generation
//
// 与 Sub2API / Dramaya 都是「/v1/videos 异步任务」的外形, 但字段口径又一次不同,
// 所以单独一份实现:
//   - 提交 `POST /v1/videos`, 轮询 `GET /v1/videos/{id}`, 成片 `GET /v1/videos/{id}/content`;
//   - 时长字段是 `duration`(整数秒; `seconds` 只是别名, **两者不能同传**);
//   - 画幅字段是 `ratio`(不是 aspect_ratio), 分辨率 `resolution`(720p / 1080p);
//   - **有素材时正文必须放进 `content` 数组, 且不能再传 `prompt`**(文档明确二选一);
//   - 素材角色是 `first_frame` / `last_frame` / `reference_image` / `reference_audio`,
//     URL 包在同名对象里(`{"image_url": {"url": ...}}`);
//   - 站点**没有** files / upload 接口 —— 素材只能是上游可读的 HTTPS 地址。
//     本机素材只有两条出路: 用户自己配了 `reference_asset_upload_url` 图床(先传换 URL),
//     否则直接给出可行动的报错, 而不是把 data URL 硬塞进去换来一个看不懂的 400;
//   - 状态枚举 queued / in_progress / completed / failed / cancelled,
//     `extract::task_status` 转大写后即可复用统一判定;
//   - 文档明确要求**创建请求不加自动重试**(超时不代表上游没收到), 因此这里是单次提交;
//     若失败响应里已经带了任务号, 直接按「已排队」返回 —— 宁可让用户去查原任务,
//     也不能重新提交造成二次扣费。
// ---------------------------------------------------------------------------
use serde_json::{json, Map, Value};

use crate::ai::error::AIError;
use crate::ai::providers::video_protocols::assets::{
    extract_asset_url, resolve_reference_asset, truncate, upload_reference_asset_multipart, ReferenceAsset,
};
use crate::ai::providers::video_protocols::extract;
use crate::ai::providers::video_protocols::video_extension_hint;
use crate::ai::providers::video_protocols::{
    describe_reqwest_error, http_error, meta_string, persist_media_bytes, queued, string_param, PollContext,
    SubmitContext,
};
use crate::ai::{GenerateVideoRequest, ProviderTaskHandle, ProviderTaskPollResult, ProviderTaskSubmission};

pub const TRANSPORT: &str = "likeai-video";
const PLATFORM_LABEL: &str = "likeai520";
const SUBMIT_PATH: &str = "/v1/videos";

fn host_of(value: &str) -> Option<&str> {
    let rest = value.split_once("://").map(|(_, rest)| rest).unwrap_or(value);
    let host_port = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = host_port.split('@').next_back().unwrap_or(host_port);
    (!host.is_empty()).then(|| host.split(':').next().unwrap_or(host))
}

/// 只认 API 站点。文档站(www.likeai520.cc)也是同一个域名族, 一并识别 ——
/// 用户把 `https://www.likeai520.cc` 填成 Base URL 是常见误填, 认出来后能给出
/// 「接口地址应为 api.likeai520.cc」这类可读错误, 而不是 404 重定向的怪响应。
pub fn is_likeai_base_url(base_url: &str) -> bool {
    host_of(base_url.trim())
        .map(|host| {
            host.eq_ignore_ascii_case("api.likeai520.cc")
                || host.eq_ignore_ascii_case("likeai520.cc")
                || host.eq_ignore_ascii_case("www.likeai520.cc")
        })
        .unwrap_or(false)
}

/// `custom:<id>/<model>` → `<model>`; 平台按精确型号串路由。
fn api_model(request: &GenerateVideoRequest) -> String {
    request
        .model
        .split_once('/')
        .map(|(_, model)| model.to_string())
        .unwrap_or_else(|| request.model.clone())
}

fn is_public_url(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    // `asset.localhost` 是 Tauri 的本地预览协议, 不是公网可达地址。
    !lower.contains("asset.localhost") && (lower.starts_with("https://") || lower.starts_with("http://"))
}

fn is_terminal_failure(status: &str) -> bool {
    matches!(
        status.trim().to_ascii_uppercase().as_str(),
        "FAILED" | "FAILURE" | "ERROR" | "CANCELED" | "CANCELLED" | "EXPIRED" | "REJECTED"
    )
}

/// 本机素材 → 图床换公网 URL。
///
/// 平台本身没有上传接口, 所以这里**只走用户显式配置的图床**(设置页的
/// `referenceAssetUploadUrl`)。没配就直接报错并说明怎么配 —— 把 data URL 硬发过去
/// 只会换来一个 400(文档要求素材必须是 HTTPS), 用户看不出该改什么。
///
/// 鉴权用 `reference_asset_upload_token` 而**不是**平台 Key: 图床通常是第三方,
/// 把 likeai520 的 Key 发给它等于泄露。
async fn material_url(
    ctx: &SubmitContext,
    request: &GenerateVideoRequest,
    source: &str,
    index: usize,
    kind: &str,
) -> Result<String, AIError> {
    let trimmed = source.trim();
    if is_public_url(trimmed) {
        return Ok(trimmed.to_string());
    }
    let upload_url = string_param(request, "reference_asset_upload_url");
    if upload_url.is_empty() {
        return Err(AIError::InvalidRequest(format!(
            "{} 没有素材上传接口，参考{} {} 必须是公网 HTTPS 地址。\
             想直接用画布上的本机素材，请在平台设置的「素材上传地址」里填一个图床(上传后返回 URL)。",
            PLATFORM_LABEL,
            kind,
            index + 1
        )));
    }
    let label = format!("{} 参考{} {}", PLATFORM_LABEL, kind, index + 1);
    let asset = resolve_reference_asset(trimmed, &label).await?;
    let extension = match &asset {
        ReferenceAsset::Url(url) => return Ok(url.clone()),
        ReferenceAsset::File { extension, .. } => extension.clone(),
    };
    let filename = format!("lentalk-{}-{}.{}", kind_slug(kind), index + 1, extension);
    let token = string_param(request, "reference_asset_upload_token");
    let payload = upload_reference_asset_multipart(
        &ctx.client,
        &upload_url,
        &token,
        &filename,
        &asset,
        PLATFORM_LABEL,
    )
    .await?;
    extract_asset_url(&payload).ok_or_else(|| {
        AIError::TaskFailed(format!(
            "{} 参考{} {} 上传后未拿到公网 URL: {}",
            PLATFORM_LABEL,
            kind,
            index + 1,
            truncate(&payload.to_string(), 500)
        ))
    })
}

fn kind_slug(kind: &str) -> &'static str {
    match kind {
        "音频" => "audio",
        _ => "image",
    }
}

/// 组装一条素材条目: `{"type": "...", "role": "...", "<type>": {"url": ...}}`。
fn material_item(kind: &str, role: &str, url: &str) -> Value {
    match kind {
        "音频" => json!({ "type": "audio_url", "role": role, "audio_url": { "url": url } }),
        "视频" => json!({ "type": "video_url", "role": role, "video_url": { "url": url } }),
        _ => json!({ "type": "image_url", "role": role, "image_url": { "url": url } }),
    }
}

pub async fn submit(ctx: &SubmitContext, request: &GenerateVideoRequest) -> Result<ProviderTaskSubmission, AIError> {
    let model = api_model(request);
    let is_first_last = request.image_mode.as_deref() == Some("first-last");

    let sources: Vec<String> = request
        .reference_images
        .clone()
        .unwrap_or_default()
        .into_iter()
        .map(|source| source.trim().to_string())
        .filter(|source| !source.is_empty())
        .collect();
    // 首尾帧模式最多两张(文档: 尾帧必须同时给首帧), 其余按普通参考图提交。
    let sources: Vec<String> = if is_first_last { sources.into_iter().take(2).collect() } else { sources };
    let audios: Vec<String> = request
        .reference_audio
        .clone()
        .unwrap_or_default()
        .into_iter()
        .map(|source| source.trim().to_string())
        .filter(|source| !source.is_empty())
        .collect();

    let mut content: Vec<Value> = Vec::new();
    let prompt = request.prompt.trim();
    if !prompt.is_empty() {
        content.push(json!({ "type": "text", "text": request.prompt }));
    }
    for (index, source) in sources.iter().enumerate() {
        let role = if is_first_last {
            if index == 0 { "first_frame" } else { "last_frame" }
        } else {
            "reference_image"
        };
        let url = material_url(ctx, request, source, index, "图").await?;
        content.push(material_item("图", role, &url));
    }
    for (index, source) in audios.iter().enumerate() {
        let url = material_url(ctx, request, source, index, "音频").await?;
        content.push(material_item("音频", "reference_audio", &url));
    }

    let mut body = Map::new();
    body.insert("model".into(), Value::String(model));
    if sources.is_empty() && audios.is_empty() {
        body.insert("prompt".into(), Value::String(request.prompt.clone()));
    } else {
        // 有素材就只能走 content 数组: 文档写明 prompt 与 content 二选一,
        // 同传会被判参数冲突。
        body.insert("content".into(), Value::Array(content));
    }
    if request.duration > 0 {
        body.insert("duration".into(), json!(request.duration));
    }
    let ratio = request.aspect_ratio.trim();
    if !ratio.is_empty() {
        body.insert("ratio".into(), Value::String(ratio.to_string()));
    }
    if let Some(resolution) = request
        .video_resolution
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        body.insert("resolution".into(), Value::String(resolution.to_string()));
    }
    if let Some(params) = request.extra_params.as_ref() {
        if let Some(generate_audio) = params.get("generate_audio").and_then(Value::as_bool) {
            body.insert("generate_audio".into(), json!(generate_audio));
        }
        if let Some(seed) = params.get("seed").and_then(Value::as_i64) {
            body.insert("seed".into(), json!(seed));
        }
    }

    let submit_url = format!("{}{}", ctx.base_url.trim_end_matches('/'), SUBMIT_PATH);
    let response = ctx
        .client
        .post(&submit_url)
        .bearer_auth(&ctx.api_key)
        .header("Accept-Encoding", "identity")
        .json(&Value::Object(body))
        .send()
        .await
        .map_err(|error| {
            AIError::Provider(format!(
                "{} 视频请求失败(网络): {}",
                PLATFORM_LABEL,
                describe_reqwest_error(&error)
            ))
        })?;
    let status = response.status();
    let raw = response.text().await.unwrap_or_default();
    let payload: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);

    if !status.is_success() {
        // 文档: 错误响应里若带 task_id, 说明上游可能已经收到 —— 必须查原任务,
        // 不能重新提交(会二次扣费)。这里直接返回句柄, 让轮询流程去核实。
        if let Some(task_id) = extract::task_id(&payload) {
            let query_url = format!(
                "{}{}/{}",
                ctx.base_url.trim_end_matches('/'),
                SUBMIT_PATH,
                urlencoding::encode(&task_id)
            );
            return Ok(queued(task_id, &ctx.provider_id, TRANSPORT, query_url, None));
        }
        return Err(http_error(
            &format!("{} 视频请求失败", PLATFORM_LABEL),
            status,
            &raw,
            &submit_url,
        ));
    }

    let task_id = extract::task_id(&payload).ok_or_else(|| {
        AIError::TaskFailed(format!(
            "{} 响应中未找到任务 ID: {}",
            PLATFORM_LABEL,
            truncate(&payload.to_string(), 600)
        ))
    })?;
    let query_url = format!(
        "{}{}/{}",
        ctx.base_url.trim_end_matches('/'),
        SUBMIT_PATH,
        urlencoding::encode(&task_id)
    );
    Ok(queued(task_id, &ctx.provider_id, TRANSPORT, query_url, None))
}

pub async fn poll(
    ctx: &PollContext,
    metadata: &Map<String, Value>,
    _handle: &ProviderTaskHandle,
) -> Result<ProviderTaskPollResult, AIError> {
    let query_url = meta_string(metadata, "query_url")
        .ok_or_else(|| AIError::InvalidRequest(format!("{} 任务缺少查询地址, 无法续查", PLATFORM_LABEL)))?;
    let payload = super::fetch_json(&ctx.client, &ctx.api_key, query_url, PLATFORM_LABEL).await?;

    // `submission_status: "unknown"` = 提交结果不明确, 文档明确「不是可以安全重试的
    // 信号」。继续轮询只是白等, 判失败并把原话交给用户(附管理员核对指引)。
    if let Some("unknown") = payload.get("submission_status").and_then(Value::as_str) {
        return Ok(ProviderTaskPollResult::Failed(format!(
            "{} 提交结果待核对(submission_status=unknown)：请先用同一 Key 查询原任务或联系平台管理员，不要重新创建",
            PLATFORM_LABEL
        )));
    }

    let task_status = extract::task_status(&payload);
    if is_terminal_failure(&task_status) {
        let reason = extract::failure_reason(&payload).unwrap_or(task_status);
        return Ok(ProviderTaskPollResult::Failed(format!(
            "{} 视频生成失败: {}",
            PLATFORM_LABEL, reason
        )));
    }
    if !extract::is_completed_status(&task_status) {
        return Ok(ProviderTaskPollResult::Running);
    }

    // `video_url` 是**受保护的站内相对路径**(`/v1/videos/{id}/content`), 必须带本站
    // Key 走固定下载接口 —— 文档明确不要把 Key 塞进 URL 或发给外部域名。
    let content_url = format!("{}/content", query_url.trim_end_matches('/'));
    let bytes = super::download_bytes(&ctx.client, &ctx.api_key, &content_url, PLATFORM_LABEL).await?;
    let extension = video_extension_hint("video/mp4", "");
    Ok(ProviderTaskPollResult::Succeeded(persist_media_bytes(&bytes, &extension)?))
}

/// 供 `openai_compat` 判定是否属于本协议。
pub fn matches(transport: &str, provider_base_url: &str, _provider_id: &str) -> bool {
    if transport == TRANSPORT {
        return true;
    }
    if !transport.is_empty() {
        return false;
    }
    is_likeai_base_url(provider_base_url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_likeai_hosts_match() {
        assert!(is_likeai_base_url("https://api.likeai520.cc"));
        assert!(is_likeai_base_url("https://api.likeai520.cc/"));
        // 文档站同域名族, 认出来才能给出「Base URL 填错了」的可读错误。
        assert!(is_likeai_base_url("https://www.likeai520.cc"));
        // 前缀拼接不能命中。
        assert!(!is_likeai_base_url("https://notlikeai520.cc"));
        assert!(!is_likeai_base_url("https://api.example.com"));
    }

    #[test]
    fn asset_protocol_urls_are_not_public() {
        assert!(!is_public_url("http://asset.localhost/D%3A/a.png"));
        assert!(!is_public_url("data:image/png;base64,AAAA"));
        assert!(is_public_url("https://cdn.example.com/a.png"));
    }

    #[test]
    fn material_items_use_role_and_nested_url() {
        let image = material_item("图", "first_frame", "https://cdn/x.png");
        assert_eq!(image["type"], "image_url");
        assert_eq!(image["role"], "first_frame");
        assert_eq!(image["image_url"]["url"], "https://cdn/x.png");

        let audio = material_item("音频", "reference_audio", "https://cdn/a.mp3");
        assert_eq!(audio["type"], "audio_url");
        assert_eq!(audio["audio_url"]["url"], "https://cdn/a.mp3");
    }

    #[test]
    fn terminal_failures_cover_lowercase_statuses() {
        assert!(is_terminal_failure("failed"));
        assert!(is_terminal_failure("cancelled"));
        assert!(!is_terminal_failure("in_progress"));
        assert!(!is_terminal_failure("completed"));
    }

    #[test]
    fn model_is_taken_after_provider_prefix() {
        let request = GenerateVideoRequest {
            prompt: "p".into(),
            model: "custom:likeai520/doubao-seedance-2.0-mini".into(),
            duration: 4,
            aspect_ratio: "16:9".into(),
            video_resolution: Some("720p".into()),
            image_mode: None,
            reference_images: None,
            reference_audio: None,
            extra_params: None,
        };
        assert_eq!(api_model(&request), "doubao-seedance-2.0-mini");
    }
}
