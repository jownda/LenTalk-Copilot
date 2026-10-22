// ---------------------------------------------------------------------------
// Sub2API 视频协议(RJM / 通用 Sub2API 中转)
//
// 对应前端 `generateSub2ApiVideo`。与通用 OpenAI 兼容视频的差异:
//   - 参考图分两条路走: **公网 URL 进 `images` 数组**, 其余必须先 POST
//     `/v1/files`(`{ image_b64 }`)换 `image_id`, 再放进 `image_ids` 数组。
//   - 必须带 `Idempotency-Key`(重发同一请求=重复扣费)。
//   - Seedance 2.0 / 2.5 的时长是**锁死的**(15s / 30s), 且画幅只认 16:9 / 9:16。
//   - 终态是 `COMPLETED` 而不是 SUCCEEDED, 而且**没有成片地址** —— 要再去
//     `{taskUrl}/content` 拉二进制。这一步必须带 Bearer, 所以只能在后端做:
//     下载 → 落盘 → 把本地绝对路径交回画布。
//   - RJM(video.rjm.us.ci / sub2api.rjm.us.ci)是同一套协议固定域名, 端点写死。
// ---------------------------------------------------------------------------
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};

use crate::ai::error::AIError;
use crate::ai::providers::video_protocols::assets::{resolve_reference_asset, truncate, ReferenceAsset};
use crate::ai::providers::video_protocols::extract;
use crate::ai::providers::video_protocols::{
    describe_reqwest_error, download_bytes, http_error, meta_string, persist_media_bytes, queued, string_param, PollContext, SubmitContext,
};
use crate::ai::{GenerateVideoRequest, ProviderTaskHandle, ProviderTaskPollResult, ProviderTaskSubmission};

pub const TRANSPORT: &str = "sub2api-video";
const SUBMIT_PATH: &str = "/v1/videos";
const UPLOAD_PATH: &str = "/v1/files";
const PLATFORM_LABEL: &str = "Sub2API";

fn api_model(request: &GenerateVideoRequest) -> String {
    request
        .model
        .split_once('/')
        .map(|(_, model)| model.to_string())
        .unwrap_or_else(|| request.model.clone())
}

fn host_of(value: &str) -> Option<&str> {
    let rest = value.split_once("://").map(|(_, rest)| rest).unwrap_or(value);
    let host_port = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = host_port.split('@').next_back().unwrap_or(host_port);
    (!host.is_empty()).then(|| host.split(':').next().unwrap_or(host))
}

/// RJM 的两个固定域名收敛到同一个站点根。与前端 `resolveRjmVideoApiBaseUrl` 一致:
/// hostname 不匹配就返回 None(而不是做前缀匹配 —— `notvideo.rjm.us.ci` 不能命中)。
pub fn resolve_rjm_base_url(base_url: &str) -> Option<String> {
    let trimmed = base_url.trim();
    let lower = trimmed.to_ascii_lowercase();
    let scheme = if lower.starts_with("https://") {
        "https"
    } else if lower.starts_with("http://") {
        "http"
    } else {
        return None;
    };
    let host = host_of(trimmed)?.to_ascii_lowercase();
    if host != "video.rjm.us.ci" && host != "sub2api.rjm.us.ci" {
        return None;
    }
    Some(format!("{}://video.rjm.us.ci", scheme))
}

fn resolve_endpoint(base_url: &str, configured: Option<&str>, fallback: &str, task_id: Option<&str>) -> String {
    let path = configured
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback)
        .to_string();
    let path = match task_id {
        Some(id) => path.replace("{taskId}", &urlencoding::encode(id)),
        None => path,
    };
    if path.starts_with("http://") || path.starts_with("https://") {
        return path;
    }
    format!("{}{}", base_url.trim_end_matches('/'), if path.starts_with('/') { path } else { format!("/{}", path) })
}

/// Seedance 2.5 = 30s / 2.0 = 15s, 时长由模型决定, 不接受用户传值。
fn fixed_seedance_duration(api_model: &str) -> Option<u32> {
    match api_model.trim().to_ascii_lowercase().as_str() {
        "seedance2.5" => Some(30),
        "seedance2.0" => Some(15),
        _ => None,
    }
}

/// RJM 的 Seedance 档位白名单(2.5 不支持 1080p / 4k)。
fn resolve_rjm_seedance_resolution(api_model: &str, requested: Option<&str>) -> String {
    let allowed: &[&str] = if api_model.trim().to_ascii_lowercase() == "seedance2.5" {
        &["480p", "720p"]
    } else {
        &["480p", "720p", "1080p", "4k"]
    };
    let normalized = requested.map(|value| value.trim().to_ascii_lowercase()).unwrap_or_default();
    if !normalized.is_empty() && allowed.contains(&normalized.as_str()) {
        return normalized;
    }
    "720p".to_string()
}

fn idempotency_key(request: &GenerateVideoRequest) -> String {
    let configured = string_param(request, "client_job_id");
    if !configured.is_empty() {
        return configured;
    }
    format!("lentalk-video-{}", uuid::Uuid::new_v4())
}

/// 非公网参考图 → `image_id`。平台只收裸 base64(不带 `data:` 前缀)。
async fn upload_reference_image(ctx: &SubmitContext, source: &str, index: usize) -> Result<String, AIError> {
    let label = format!("{} 参考图 {}", PLATFORM_LABEL, index + 1);
    let asset = resolve_reference_asset(source, &label).await?;
    let encoded = match asset {
        ReferenceAsset::Url(url) => url,
        ReferenceAsset::File { bytes, .. } => STANDARD.encode(bytes),
    };
    let upload_url = format!("{}{}", ctx.base_url.trim_end_matches('/'), UPLOAD_PATH);
    let response = ctx
        .client
        .post(&upload_url)
        .bearer_auth(&ctx.api_key)
        .header("Accept-Encoding", "identity")
        .json(&json!({ "image_b64": encoded }))
        .send()
        .await
        .map_err(|error| AIError::Provider(format!("{} 参考图上传失败(网络): {}", PLATFORM_LABEL, describe_reqwest_error(&error))))?;
    let status = response.status();
    let raw = response.text().await.unwrap_or_default();
    let payload: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(http_error(&format!("{} 参考图上传失败", PLATFORM_LABEL), status, &raw, &upload_url));
    }
    extract_image_id(&payload).ok_or_else(|| {
        AIError::TaskFailed(format!(
            "{} 参考图上传响应中未找到 image_id: {}",
            PLATFORM_LABEL,
            truncate(&payload.to_string(), 600)
        ))
    })
}

fn extract_image_id(payload: &Value) -> Option<String> {
    match payload {
        Value::Array(items) => items.iter().find_map(extract_image_id),
        Value::Object(map) => ["image_id", "imageId"]
            .iter()
            .find_map(|key| map.get(*key).and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).map(str::to_string))
            .or_else(|| ["data", "file", "result"].iter().find_map(|key| map.get(*key).and_then(extract_image_id))),
        _ => None,
    }
}

fn is_public_url(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    lower.starts_with("https://") || lower.starts_with("http://")
}

fn is_failed(status: &str) -> bool {
    matches!(
        status,
        "FAILED" | "FAILURE" | "ERROR" | "CANCELED" | "CANCELLED" | "REJECTED"
    )
}

pub async fn submit(ctx: &SubmitContext, request: &GenerateVideoRequest) -> Result<ProviderTaskSubmission, AIError> {
    if request.reference_audio.as_ref().map(|items| items.iter().any(|item| !item.trim().is_empty())).unwrap_or(false) {
        return Err(AIError::InvalidRequest(
            "Sub2API 当前推荐的 Seedance 视频链路只支持图片参考，暂不提交音频参考。".into(),
        ));
    }

    let rjm_base = resolve_rjm_base_url(&ctx.base_url);
    let is_rjm = rjm_base.is_some();
    let base_url = rjm_base.unwrap_or_else(|| ctx.base_url.trim_end_matches('/').to_string());
    let api_model = api_model(request);
    let is_first_last = request.image_mode.as_deref() == Some("first-last");
    let sources: Vec<String> = request
        .reference_images
        .clone()
        .unwrap_or_default()
        .into_iter()
        .filter(|source| !source.trim().is_empty())
        .collect();
    let sources: Vec<String> = if is_first_last { sources.into_iter().take(2).collect() } else { sources };

    let mut image_ids: Vec<String> = Vec::new();
    let mut image_urls: Vec<String> = Vec::new();
    for (index, source) in sources.iter().enumerate() {
        if is_public_url(source) {
            image_urls.push(source.trim().to_string());
        } else {
            image_ids.push(upload_reference_image(ctx, source, index).await?);
        }
    }

    let fixed_duration = fixed_seedance_duration(&api_model);
    let is_fixed_seedance = fixed_duration.is_some();
    let ratio = if is_first_last && !image_ids.is_empty() && is_rjm {
        "auto".to_string()
    } else if is_fixed_seedance && matches!(request.aspect_ratio.trim(), "16:9" | "9:16") {
        request.aspect_ratio.trim().to_string()
    } else if is_fixed_seedance {
        "16:9".to_string()
    } else {
        request.aspect_ratio.trim().to_string()
    };
    let resolution = if is_fixed_seedance {
        if is_rjm {
            resolve_rjm_seedance_resolution(&api_model, request.video_resolution.as_deref())
        } else {
            "720p".to_string()
        }
    } else {
        request
            .video_resolution
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("")
            .to_string()
    };

    let mut body = json!({
        "model": api_model,
        "prompt": request.prompt,
        "duration": fixed_duration.unwrap_or_else(|| request.duration.max(1)),
        "ratio": ratio,
        "camera_movement": "auto",
    });
    if let Some(object) = body.as_object_mut() {
        if !resolution.is_empty() {
            object.insert("resolution".into(), Value::String(resolution));
        }
        if !image_ids.is_empty() {
            object.insert("image_ids".into(), json!(image_ids));
        }
        if !image_urls.is_empty() {
            object.insert("images".into(), json!(image_urls));
        }
    }

    let submit_url = if is_rjm {
        format!("{}{}", base_url, SUBMIT_PATH)
    } else {
        resolve_endpoint(
            &base_url,
            request
                .extra_params
                .as_ref()
                .and_then(|params| params.get("video_submit_path"))
                .and_then(Value::as_str),
            SUBMIT_PATH,
            None,
        )
    };
    let response = ctx
        .client
        .post(&submit_url)
        .bearer_auth(&ctx.api_key)
        .header("Accept-Encoding", "identity")
        .header("Idempotency-Key", idempotency_key(request))
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

    if let Some(url) = extract::result_url(&payload) {
        return Ok(ProviderTaskSubmission::Succeeded(url));
    }
    let task_id = extract::task_id(&payload).ok_or_else(|| {
        AIError::TaskFailed(format!(
            "{} 响应中未找到任务 ID: {}",
            PLATFORM_LABEL,
            truncate(&payload.to_string(), 600)
        ))
    })?;
    let query_url = if is_rjm {
        format!("{}{}/{}", base_url, SUBMIT_PATH, urlencoding::encode(&task_id))
    } else {
        resolve_endpoint(
            &base_url,
            request
                .extra_params
                .as_ref()
                .and_then(|params| params.get("video_query_path"))
                .and_then(Value::as_str),
            "/v1/videos/{taskId}",
            Some(&task_id),
        )
    };
    Ok(queued(task_id, &ctx.provider_id, TRANSPORT, query_url, None))
}

pub async fn poll(
    ctx: &PollContext,
    metadata: &serde_json::Map<String, Value>,
    _handle: &ProviderTaskHandle,
) -> Result<ProviderTaskPollResult, AIError> {
    let query_url = meta_string(metadata, "query_url")
        .ok_or_else(|| AIError::InvalidRequest("Sub2API 任务缺少查询地址, 无法续查".into()))?;
    let response = ctx
        .client
        .get(query_url)
        .bearer_auth(&ctx.api_key)
        .header("Accept-Encoding", "identity")
        .send()
        .await
        .map_err(|error| AIError::Provider(format!("{} 视频查询失败(网络): {}", PLATFORM_LABEL, describe_reqwest_error(&error))))?;
    let status = response.status();
    let raw = response.text().await.unwrap_or_default();
    let payload: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    if !status.is_success() {
        if status.is_client_error() {
            return Ok(ProviderTaskPollResult::Failed(format!(
                "{} 视频查询失败: HTTP {} {}",
                PLATFORM_LABEL,
                status,
                truncate(&raw, 500)
            )));
        }
        return Err(http_error(&format!("{} 视频查询失败", PLATFORM_LABEL), status, &raw, query_url));
    }

    if let Some(url) = extract::result_url(&payload) {
        // 有些平台在任务未完成时也会带占位地址, 但同时会给任务 ID —— 以任务 ID 为准。
        if extract::task_id(&payload).is_none() {
            return Ok(ProviderTaskPollResult::Succeeded(url));
        }
    }
    let task_status = extract::task_status(&payload);
    if is_failed(&task_status) {
        let reason = extract::failure_reason(&payload).unwrap_or(task_status);
        return Ok(ProviderTaskPollResult::Failed(format!("{} 视频生成失败: {}", PLATFORM_LABEL, reason)));
    }
    if extract::is_completed_status(&task_status) {
        // COMPLETED 只表示跑完了, 成片要另去 /content 取二进制。
        let content_url = format!("{}/content", query_url.trim_end_matches('/'));
        let bytes = download_bytes(&ctx.client, &ctx.api_key, &content_url, PLATFORM_LABEL).await?;
        let persisted = persist_media_bytes(&bytes, "mp4")?;
        return Ok(ProviderTaskPollResult::Succeeded(persisted));
    }
    Ok(ProviderTaskPollResult::Running)
}

/// 供 `openai_compat` 判定是否属于本协议。
pub fn matches(transport: &str, provider_base_url: &str, _provider_id: &str) -> bool {
    if transport == TRANSPORT {
        return true;
    }
    if !transport.is_empty() {
        return false;
    }
    resolve_rjm_base_url(provider_base_url).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rjm_hosts_are_exact_matches() {
        assert_eq!(resolve_rjm_base_url("https://video.rjm.us.ci/v1").as_deref(), Some("https://video.rjm.us.ci"));
        assert_eq!(
            resolve_rjm_base_url("https://sub2api.rjm.us.ci").as_deref(),
            Some("https://video.rjm.us.ci")
        );
        assert!(resolve_rjm_base_url("https://notvideo.rjm.us.ci").is_none());
        assert!(resolve_rjm_base_url("https://api.example.com").is_none());
    }

    #[test]
    fn seedance_durations_are_lockstepped() {
        assert_eq!(fixed_seedance_duration("Seedance2.5"), Some(30));
        assert_eq!(fixed_seedance_duration("seedance2.0"), Some(15));
        assert_eq!(fixed_seedance_duration("seedance2.1"), None);
    }

    #[test]
    fn rjm_resolution_whitelist_narrows_for_25() {
        assert_eq!(resolve_rjm_seedance_resolution("seedance2.5", Some("1080p")), "720p");
        assert_eq!(resolve_rjm_seedance_resolution("seedance2.0", Some("1080p")), "1080p");
        assert_eq!(resolve_rjm_seedance_resolution("seedance2.0", None), "720p");
    }
}
