// ---------------------------------------------------------------------------
// 帧间 API(zhenjian.work)任务协议
//
// 对应前端 `generateZhenjianVideo`(见 `src/commands/zhenjianApi.ts`)。与通用
// OpenAI 兼容视频的差异:
//   - 参考素材必须 POST `/v1/assets`(multipart, 字段名 file, 同时带 model + kind)
//     换成 asset id; **本地与公网 URL 都要先落成字节再上传** —— 平台不收 URL 透传。
//   - 提交 POST `/v1/videos`, 请求体用 `seconds` / `ratio` / `resolution` / `assets`。
//   - 查询 GET `/v1/tasks/{id}`, 官方建议 10s 一次。
//   - 成片地址常常是**相对路径**(甚至平台压根不给, 只能按
//     `/v1/tasks/{id}/video?download=1` 兜底), 而且要带 Bearer 才下得动 ——
//     所以必须在后端下载字节再落盘, 把本地路径交给画布。
//   - 上传幂等, 用 Idempotency-Key 头防止重复提交(重复=重复计费)。
// ---------------------------------------------------------------------------
use serde_json::{json, Value};

use crate::ai::error::AIError;
use crate::ai::providers::video_protocols::assets::{
    download_url_to_asset, resolve_reference_asset, truncate, upload_reference_asset_multipart_with_fields,
    ReferenceAsset,
};
use crate::ai::providers::video_protocols::extract::{self, MediaKind};
use crate::ai::providers::video_protocols::{
    describe_reqwest_error, download_bytes, http_error, meta_string, persist_media_bytes, queued, video_extension_hint, PollContext,
    SubmitContext,
};
use crate::ai::{GenerateVideoRequest, ProviderTaskHandle, ProviderTaskPollResult, ProviderTaskSubmission};

pub const TRANSPORT: &str = "zhenjian-task-api";
const API_PREFIX: &str = "/v1";
const SUBMIT_PATH: &str = "/v1/videos";
const UPLOAD_PATH: &str = "/v1/assets";
const PLATFORM_LABEL: &str = "帧间 API";

/// 上传端点的 `kind` 字段取值(平台按它把素材归到对应模型输入)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AssetKind {
    Image,
    Video,
    Audio,
}

impl AssetKind {
    fn name(self) -> &'static str {
        match self {
            AssetKind::Image => "image",
            AssetKind::Video => "video",
            AssetKind::Audio => "audio",
        }
    }

    fn label(self) -> &'static str {
        match self {
            AssetKind::Image => "图片",
            AssetKind::Video => "视频",
            AssetKind::Audio => "音频",
        }
    }

    fn fallback_mime(self) -> &'static str {
        match self {
            AssetKind::Image => "image/png",
            AssetKind::Video => "video/mp4",
            AssetKind::Audio => "audio/mpeg",
        }
    }
}

fn api_model(request: &GenerateVideoRequest) -> String {
    request
        .model
        .split_once('/')
        .map(|(_, model)| model.to_string())
        .unwrap_or_else(|| request.model.clone())
}

fn site_root(base_url: &str) -> String {
    base_url.trim().trim_end_matches('/').to_string()
}

/// 与前端 `createZhenjianIdempotencyKey` 同构: 随机段 + 模型名净化段。
fn idempotency_key(seed: &str) -> String {
    let random = uuid::Uuid::new_v4().simple().to_string();
    let suffix: String = seed
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '_' || *ch == '-')
        .take(24)
        .collect();
    let mut key = format!("{}{}", random, suffix);
    key.truncate(100);
    while key.len() < 16 {
        key.push('0');
    }
    key
}

/// 参考素材 → asset id。远端 URL 也要先下载再上传(平台不认 URL 透传)。
async fn upload_asset(
    ctx: &SubmitContext,
    source: &str,
    model: &str,
    kind: AssetKind,
    index: usize,
) -> Result<String, AIError> {
    let label = format!("{} 参考{} {}", PLATFORM_LABEL, kind.label(), index + 1);
    let resolved = resolve_reference_asset(source, &label).await?;
    let asset = match resolved {
        ReferenceAsset::Url(url) => {
            download_url_to_asset(&ctx.client, &url, kind.fallback_mime(), &label).await?
        }
        file => file,
    };
    let upload_url = format!("{}{}", site_root(&ctx.base_url), UPLOAD_PATH);
    let (filename, asset) = match &asset {
        ReferenceAsset::File { extension, .. } => (format!("reference-{}.{}", index + 1, extension), asset),
        ReferenceAsset::Url(url) => return Ok(url.clone()),
    };
    let payload = upload_reference_asset_multipart_with_fields(
        &ctx.client,
        &upload_url,
        &ctx.api_key,
        &filename,
        &asset,
        PLATFORM_LABEL,
        &[("model", model), ("kind", kind.name())],
    )
    .await?;
    extract::task_or_asset_id(&payload).ok_or_else(|| {
        AIError::TaskFailed(format!(
            "{} 参考素材上传响应中未找到 asset id: {}",
            PLATFORM_LABEL,
            truncate(&payload.to_string(), 600)
        ))
    })
}

/// 成片地址解析。相对路径补站点根; 平台不给地址时按官方兜底端点取。
fn resolve_result_url(root: &str, result: &str, task_id: &str, kind: MediaKind) -> String {
    let value = result.trim();
    if value.to_ascii_lowercase().starts_with("data:") || value.starts_with("http://") || value.starts_with("https://") {
        return value.to_string();
    }
    if let Some(rest) = value.strip_prefix('/') {
        return format!("{}/{}", root, rest);
    }
    if !value.is_empty() {
        return format!("{}/{}", root, value);
    }
    let suffix = match kind {
        MediaKind::Image => "image/0",
        MediaKind::Video => "video",
    };
    format!(
        "{}{}/tasks/{}/{}?download=1",
        root,
        API_PREFIX,
        urlencoding::encode(task_id),
        suffix
    )
}

/// 下载成片 → 落盘 → 返回本地绝对路径。
///
/// 注意: `data:` 内联结果原样透传(与前端一致), 不额外落盘。
async fn materialize(
    ctx: &PollContext,
    root: &str,
    result: &str,
    task_id: &str,
    kind: MediaKind,
) -> Result<String, AIError> {
    if result.to_ascii_lowercase().starts_with("data:") {
        return Ok(result.to_string());
    }
    let url = resolve_result_url(root, result, task_id, kind);
    let label = match kind {
        MediaKind::Image => format!("{} 图片", PLATFORM_LABEL),
        MediaKind::Video => format!("{} 视频", PLATFORM_LABEL),
    };
    let bytes = download_bytes(&ctx.client, &ctx.api_key, &url, &label).await?;
    let extension = video_extension_hint(&mime_hint(&url, kind), &url);
    persist_media_bytes(&bytes, &extension)
}

fn mime_hint(url: &str, kind: MediaKind) -> String {
    let lower = url.to_ascii_lowercase();
    if lower.contains(".webm") {
        return "video/webm".to_string();
    }
    if lower.contains(".mov") {
        return "video/quicktime".to_string();
    }
    if lower.contains(".webp") {
        return "image/webp".to_string();
    }
    if lower.contains(".jpg") || lower.contains(".jpeg") {
        return "image/jpeg".to_string();
    }
    match kind {
        MediaKind::Image => "image/png".to_string(),
        MediaKind::Video => "video/mp4".to_string(),
    }
}

pub async fn submit(ctx: &SubmitContext, request: &GenerateVideoRequest) -> Result<ProviderTaskSubmission, AIError> {
    let root = site_root(&ctx.base_url);
    let model = api_model(request);
    let images: Vec<String> = request
        .reference_images
        .clone()
        .unwrap_or_default()
        .into_iter()
        .filter(|source| !source.trim().is_empty())
        .collect();
    let audio: Vec<String> = request
        .reference_audio
        .clone()
        .unwrap_or_default()
        .into_iter()
        .filter(|source| !source.trim().is_empty())
        .collect();

    let mut assets: Vec<String> = Vec::with_capacity(images.len() + audio.len());
    for (index, source) in images.iter().enumerate() {
        assets.push(upload_asset(ctx, source, &model, AssetKind::Image, index).await?);
    }
    for (index, source) in audio.iter().enumerate() {
        assets.push(upload_asset(ctx, source, &model, AssetKind::Audio, index).await?);
    }

    let mut body = json!({
        "model": model,
        "prompt": request.prompt,
        "resolution": request
            .video_resolution
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("720p"),
        "seconds": request.duration.max(1),
        "ratio": request.aspect_ratio,
    });
    if !assets.is_empty() {
        if let Some(object) = body.as_object_mut() {
            object.insert("assets".into(), json!(assets));
        }
    }

    let submit_url = format!("{}{}", root, SUBMIT_PATH);
    let response = ctx
        .client
        .post(&submit_url)
        .bearer_auth(&ctx.api_key)
        .header("Accept-Encoding", "identity")
        .header("Idempotency-Key", idempotency_key(&model))
        .json(&body)
        .send()
        .await
        .map_err(|error| AIError::Provider(format!("{} 视频请求失败(网络): {}", PLATFORM_LABEL, describe_reqwest_error(&error))))?;
    let status = response.status();
    let raw = response.text().await.unwrap_or_default();
    let payload: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(http_error(&format!("{} 视频请求失败", PLATFORM_LABEL), status, &raw, &submit_url));
    }

    // 提交接口偶尔直接给出成片地址(同一次响应里也可能同时给 task_id)。
    if let Some(immediate) = extract::media_reference(&payload, MediaKind::Video) {
        let task_id = extract::task_or_asset_id(&payload).unwrap_or_else(|| "result".to_string());
        if immediate.to_ascii_lowercase().starts_with("data:") {
            return Ok(ProviderTaskSubmission::Succeeded(immediate));
        }
        let poll_ctx = PollContext { client: ctx.client.clone(), api_key: ctx.api_key.clone() };
        let persisted = materialize(&poll_ctx, &root, &immediate, &task_id, MediaKind::Video).await?;
        return Ok(ProviderTaskSubmission::Succeeded(persisted));
    }

    let task_id = extract::task_or_asset_id(&payload).ok_or_else(|| {
        AIError::TaskFailed(format!(
            "{} 响应中未找到任务 ID: {}",
            PLATFORM_LABEL,
            truncate(&payload.to_string(), 600)
        ))
    })?;
    let query_url = format!("{}{}/tasks/{}", root, API_PREFIX, urlencoding::encode(&task_id));
    // base_url 必须落库: 轮询阶段要用它把相对成片地址补成绝对地址。
    Ok(queued(
        task_id,
        &ctx.provider_id,
        TRANSPORT,
        query_url,
        Some(json!({ "base_url": root })),
    ))
}

pub async fn poll(
    ctx: &PollContext,
    metadata: &serde_json::Map<String, Value>,
    handle: &ProviderTaskHandle,
) -> Result<ProviderTaskPollResult, AIError> {
    let query_url = meta_string(metadata, "query_url")
        .ok_or_else(|| AIError::InvalidRequest("帧间任务缺少查询地址, 无法续查".into()))?;
    let root = meta_string(metadata, "base_url")
        .map(str::to_string)
        .unwrap_or_default();
    let response = ctx
        .client
        .get(query_url)
        .bearer_auth(&ctx.api_key)
        .header("Accept-Encoding", "identity")
        .send()
        .await
        .map_err(|error| AIError::Provider(format!("{} 任务查询失败(网络): {}", PLATFORM_LABEL, describe_reqwest_error(&error))))?;
    let status = response.status();
    let raw = response.text().await.unwrap_or_default();
    let payload: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    if !status.is_success() {
        // 4xx 是配置/鉴权问题, 不会自愈; 5xx 与抖动必须保持 running, 否则仍在
        // 平台生成(且已计费)的长任务会被一次 502 判死。
        if status.is_client_error() {
            return Ok(ProviderTaskPollResult::Failed(format!(
                "{} 任务查询失败: HTTP {} {}",
                PLATFORM_LABEL,
                status,
                truncate(&raw, 500)
            )));
        }
        return Err(http_error(&format!("{} 任务查询失败", PLATFORM_LABEL), status, &raw, query_url));
    }

    if let Some(result) = extract::media_reference(&payload, MediaKind::Video) {
        let persisted = materialize(ctx, &root, &result, &handle.task_id, MediaKind::Video).await?;
        return Ok(ProviderTaskPollResult::Succeeded(persisted));
    }
    let task_status = extract::task_status(&payload).to_ascii_lowercase();
    if matches!(
        task_status.as_str(),
        "failed" | "failure" | "error" | "canceled" | "cancelled" | "rejected"
    ) {
        let reason = extract::failure_reason(&payload).unwrap_or(task_status);
        return Ok(ProviderTaskPollResult::Failed(format!("{} 视频生成失败: {}", PLATFORM_LABEL, reason)));
    }
    if extract::is_completed_status(&task_status) {
        // 平台只给完成状态不给地址: 按官方兜底端点取。
        let persisted = materialize(ctx, &root, "", &handle.task_id, MediaKind::Video).await?;
        return Ok(ProviderTaskPollResult::Succeeded(persisted));
    }
    Ok(ProviderTaskPollResult::Running)
}

/// 供 `openai_compat` 判定是否属于本协议。transport 命中是主路径; Base URL / 平台 id
/// 兜底**只在 transport 为空时**生效, 避免用户显式配置的通用协议被误抢。
pub fn matches(transport: &str, provider_base_url: &str, provider_id: &str) -> bool {
    if transport == TRANSPORT {
        return true;
    }
    if !transport.is_empty() {
        return false;
    }
    let lower_url = provider_base_url.to_ascii_lowercase();
    let normalized_id = provider_id.trim().to_ascii_lowercase().replace("custom:", "");
    lower_url.contains("zhenjian.work")
        || normalized_id == "zhenjian"
        || normalized_id.contains("帧间")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_relative_and_fallback_result_urls() {
        assert_eq!(resolve_result_url("https://z.test", "/v1/a.mp4", "t", MediaKind::Video), "https://z.test/v1/a.mp4");
        assert_eq!(resolve_result_url("https://z.test", "a.mp4", "t", MediaKind::Video), "https://z.test/a.mp4");
        assert_eq!(
            resolve_result_url("https://z.test", "", "t 1", MediaKind::Video),
            "https://z.test/v1/tasks/t%201/video?download=1"
        );
    }

    #[test]
    fn idempotency_key_is_bounded_and_sanitized() {
        let key = idempotency_key("my model/名!");
        assert!(key.len() >= 16 && key.len() <= 100);
        assert!(key.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-'));
    }

    #[test]
    fn base_url_fallback_only_when_transport_empty() {
        assert!(matches("", "https://zhenjian.work", "custom:x"));
        assert!(matches("", "", "zhenjian"));
        assert!(!matches("openai-video", "https://zhenjian.work", "custom:x"));
    }
}
