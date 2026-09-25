// ---------------------------------------------------------------------------
// Kling 动作控制 / 高级对口型(kling-control)
//
// 对应前端 `generateKlingControlVideo`。这不是普通的文生视频, 而是两套独立接口,
// 因此画布节点会显式打上 `video_transport = "kling-control"` 标记 —— 通用视频
// 端点永远不会被用来跑它们。
//
//   - motion-control: POST `/motion-control/kling-2.6|kling-3.0`, 查询
//     GET `/tasks?task_ids={taskId}`(**注意是查询参数, 返回顶层数组**)。
//   - lip-sync: POST `/v1/videos/advanced-lip-sync`, 查询
//     GET `/v1/videos/advanced-lip-sync/{taskId}`; 提交前必须先拿待处理视频去
//     `/v1/videos/identify-face` 换 `session_id` + `face_id`。
//
// 参考素材三条出路(按优先级): 公网 URL 直接透传 → 用户配置的上传服务换 URL →
// 内联 data URL(网关对小的内联素材可接受, 让节点在没有图床时也能用)。
// 走知鸟网关时改用它的 multipart `/v1/files`。
// ---------------------------------------------------------------------------
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};

use crate::ai::error::AIError;
use crate::ai::providers::video_protocols::assets::{
    extract_asset_url, resolve_reference_asset, to_data_url, truncate, upload_reference_asset_multipart,
    ReferenceAsset,
};
use crate::ai::providers::video_protocols::extract;
use crate::ai::providers::video_protocols::{describe_reqwest_error, http_error, meta_string, queued, string_param, PollContext, SubmitContext};
use crate::ai::{GenerateVideoRequest, ProviderTaskHandle, ProviderTaskPollResult, ProviderTaskSubmission};

pub const TRANSPORT: &str = "kling-control";
const PLATFORM_LABEL: &str = "Kling";
const IDENTIFY_FACE_PATH: &str = "/v1/videos/identify-face";
const ZHINIAO_UPLOAD_PATH: &str = "/v1/files";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ControlMode {
    MotionControl,
    LipSync,
}

fn api_model(request: &GenerateVideoRequest) -> String {
    request
        .model
        .split_once('/')
        .map(|(_, model)| model.to_string())
        .unwrap_or_else(|| request.model.clone())
}

fn control_mode(request: &GenerateVideoRequest) -> ControlMode {
    if string_param(request, "control_mode") == "lip-sync" {
        ControlMode::LipSync
    } else {
        ControlMode::MotionControl
    }
}

struct UploadConfig {
    url: String,
    token: String,
}

fn upload_config(request: &GenerateVideoRequest) -> Option<UploadConfig> {
    let url = string_param(request, "reference_asset_upload_url").trim_end_matches('/').to_string();
    let token = string_param(request, "reference_asset_upload_token");
    (!url.is_empty() && !token.is_empty()).then_some(UploadConfig { url, token })
}

/// 知鸟网关(cuai.token6688.com / api.tokengo.love)有自家的参考素材上传入口。
fn zhiniao_upload_base(ctx: &SubmitContext) -> Option<String> {
    let lower = ctx.base_url.trim().to_ascii_lowercase();
    (lower.contains("cuai.token6688.com") || lower.contains("api.tokengo.love"))
        .then(|| ctx.base_url.trim().trim_end_matches('/').to_string())
}

fn number_param(request: &GenerateVideoRequest, key: &str, fallback: f64) -> f64 {
    request
        .extra_params
        .as_ref()
        .and_then(|params| params.get(key))
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(fallback)
}

async fn upload_public_asset(
    ctx: &SubmitContext,
    config: &UploadConfig,
    mime_type: &str,
    extension: &str,
    bytes: &[u8],
    index: usize,
) -> Result<String, AIError> {
    let response = ctx
        .client
        .post(&config.url)
        .bearer_auth(&config.token)
        .header("Accept-Encoding", "identity")
        .json(&json!({
            "filename": format!("reference-{}.{}", index + 1, extension),
            "content_type": mime_type,
            "data_base64": STANDARD.encode(bytes),
        }))
        .send()
        .await
        .map_err(|error| AIError::Provider(format!("参考素材上传失败(网络): {}", describe_reqwest_error(&error))))?;
    let status = response.status();
    let raw = response.text().await.unwrap_or_default();
    let payload: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(http_error("参考素材上传失败", status, &raw, &config.url));
    }
    extract_asset_url(&payload)
        .filter(|url| url.starts_with("http://") || url.starts_with("https://"))
        .ok_or_else(|| {
            AIError::TaskFailed(format!(
                "参考素材上传失败: 上传服务未返回公网 HTTP(S) URL ({})",
                config.url
            ))
        })
}

/// 知鸟 `/v1/files` 上传。与炳火同构: 网关偶发返回不带 URL 的 file 对象,
/// 上传本身幂等, 自动重试一次。
async fn upload_via_zhiniao(
    ctx: &SubmitContext,
    base_url: &str,
    asset: &ReferenceAsset,
    filename: &str,
) -> Result<String, AIError> {
    if let ReferenceAsset::Url(url) = asset {
        return Ok(url.clone());
    }
    let upload_url = format!("{}{}", base_url, ZHINIAO_UPLOAD_PATH);
    let mut last = Value::Null;
    for attempt in 1..=2 {
        let payload = upload_reference_asset_multipart(
            &ctx.client,
            &upload_url,
            &ctx.api_key,
            filename,
            asset,
            "知鸟 AI",
        )
        .await?;
        if let Some(url) = extract_asset_url(&payload) {
            return Ok(url);
        }
        last = payload;
        if attempt == 1 {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        }
    }
    Err(AIError::TaskFailed(format!(
        "知鸟 AI 参考素材上传响应中未找到公网 URL: {}",
        truncate(&last.to_string(), 600)
    )))
}

/// 参考素材 → 平台可消费的地址。
async fn resolve_asset(
    ctx: &SubmitContext,
    source: &str,
    label: &str,
    upload: Option<&UploadConfig>,
    zhiniao_base: Option<&str>,
    index: usize,
) -> Result<String, AIError> {
    let asset = resolve_reference_asset(source, label).await?;
    let (mime_type, extension, bytes) = match &asset {
        ReferenceAsset::Url(url) => return Ok(url.clone()),
        ReferenceAsset::File { mime_type, extension, bytes } => (mime_type.as_str(), extension.as_str(), bytes.as_slice()),
    };
    if let Some(config) = upload {
        return upload_public_asset(ctx, config, mime_type, extension, bytes, index).await;
    }
    let filename = format!("reference-{}.{}", index + 1, extension);
    if let Some(base_url) = zhiniao_base {
        return upload_via_zhiniao(ctx, base_url, &asset, &filename).await;
    }
    // 网关能接受较小的内联素材; 没有图床时让节点保持可用。
    Ok(to_data_url(mime_type, bytes))
}

fn kling_version(model: &str) -> &'static str {
    let normalized = model.trim().to_ascii_lowercase();
    if normalized.contains("2.6") || normalized.contains("2_6") || normalized.contains("2-6") {
        "kling-2.6"
    } else {
        "kling-3.0"
    }
}

fn submit_path(request: &GenerateVideoRequest, mode: ControlMode, model: &str) -> String {
    let configured = string_param(request, "kling_submit_path");
    if !configured.is_empty() {
        return configured;
    }
    match mode {
        ControlMode::MotionControl => format!("/motion-control/{}", kling_version(model)),
        ControlMode::LipSync => "/v1/videos/advanced-lip-sync".to_string(),
    }
}

fn query_path(request: &GenerateVideoRequest, mode: ControlMode) -> String {
    let configured = string_param(request, "kling_query_path");
    if !configured.is_empty() {
        return configured;
    }
    match mode {
        ControlMode::MotionControl => "/tasks?task_ids={taskId}".to_string(),
        ControlMode::LipSync => "/v1/videos/advanced-lip-sync/{taskId}".to_string(),
    }
}

fn endpoint(base_url: &str, path: &str) -> String {
    if path.starts_with("http://") || path.starts_with("https://") {
        return path.to_string();
    }
    format!(
        "{}{}",
        base_url.trim_end_matches('/'),
        if path.starts_with('/') { path.to_string() } else { format!("/{}", path) }
    )
}

/// 对口型的前置步骤: 拿待处理视频去人脸识别, 换 session_id / face_id。
async fn identify_face(ctx: &SubmitContext, video_url: &str) -> Result<(String, String), AIError> {
    let url = endpoint(&ctx.base_url, IDENTIFY_FACE_PATH);
    let response = ctx
        .client
        .post(&url)
        .bearer_auth(&ctx.api_key)
        .header("Accept-Encoding", "identity")
        .json(&json!({ "video_url": video_url }))
        .send()
        .await
        .map_err(|error| AIError::Provider(format!("{} 人脸识别失败(网络): {}", PLATFORM_LABEL, describe_reqwest_error(&error))))?;
    let status = response.status();
    let raw = response.text().await.unwrap_or_default();
    let payload: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(http_error(&format!("{} 人脸识别失败", PLATFORM_LABEL), status, &raw, &url));
    }
    let data = payload.get("data").cloned().unwrap_or(Value::Null);
    let session_id = data
        .get("session_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let face_id = data
        .get("face_data")
        .and_then(Value::as_array)
        .and_then(|faces| faces.iter().find_map(|face| face.get("face_id").and_then(Value::as_str)))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    match (session_id, face_id) {
        (Some(session_id), Some(face_id)) => Ok((session_id, face_id)),
        _ => Err(AIError::TaskFailed(format!(
            "{} 人脸识别未返回 session_id / face_id: {}",
            PLATFORM_LABEL,
            truncate(&payload.to_string(), 600)
        ))),
    }
}

pub async fn submit(ctx: &SubmitContext, request: &GenerateVideoRequest) -> Result<ProviderTaskSubmission, AIError> {
    let mode = control_mode(request);
    let model = api_model(request);
    let upload = upload_config(request);
    let zhiniao_base = zhiniao_upload_base(ctx);

    let image_source = request
        .reference_images
        .as_ref()
        .and_then(|items| items.first())
        .map(|value| value.trim().to_string())
        .unwrap_or_default();
    let motion_video_source = string_param(request, "motion_reference_video");
    let source_video = string_param(request, "source_video");
    let audio_source = {
        let configured = string_param(request, "lip_sync_audio");
        if !configured.is_empty() {
            configured
        } else {
            request
                .reference_audio
                .as_ref()
                .and_then(|items| items.first())
                .map(|value| value.trim().to_string())
                .unwrap_or_default()
        }
    };

    match mode {
        ControlMode::MotionControl => {
            if image_source.is_empty() || motion_video_source.is_empty() {
                return Err(AIError::InvalidRequest(
                    "Kling Motion Control 需要角色图片和动作参考视频".into(),
                ));
            }
        }
        ControlMode::LipSync => {
            if source_video.is_empty() || audio_source.is_empty() {
                return Err(AIError::InvalidRequest("Kling 对口型需要待处理视频和音频".into()));
            }
        }
    }

    let body = match mode {
        ControlMode::MotionControl => {
            let image = resolve_asset(
                ctx,
                &image_source,
                "Kling 角色图片",
                upload.as_ref(),
                zhiniao_base.as_deref(),
                0,
            )
            .await?;
            let motion_video = resolve_asset(
                ctx,
                &motion_video_source,
                "Kling 动作参考视频",
                upload.as_ref(),
                zhiniao_base.as_deref(),
                1,
            )
            .await?;
            let prompt = request.prompt.trim();
            let mut contents: Vec<Value> = Vec::new();
            if !prompt.is_empty() {
                contents.push(json!({ "type": "prompt", "text": prompt }));
            }
            contents.push(json!({ "type": "image", "url": image }));
            contents.push(json!({ "type": "video", "url": motion_video }));
            let orientation = {
                let configured = string_param(request, "character_orientation");
                if configured.is_empty() { "image".to_string() } else { configured }
            };
            let resolution = {
                let configured = string_param(request, "resolution");
                let value = if configured.is_empty() {
                    request.video_resolution.clone().unwrap_or_default()
                } else {
                    configured
                };
                if value.trim().is_empty() { "720p".to_string() } else { value }
            };
            let keep_original_audio = request
                .extra_params
                .as_ref()
                .and_then(|params| params.get("keep_original_audio"))
                .and_then(Value::as_bool)
                .unwrap_or(true);
            json!({
                "contents": contents,
                "settings": {
                    "character_orientation": if orientation == "video" { "video" } else { "image" },
                    "audio": if keep_original_audio { "original" } else { "off" },
                    "resolution": if resolution == "1080p" { "1080p" } else { "720p" },
                },
            })
        }
        ControlMode::LipSync => {
            let source_video_url = resolve_asset(
                ctx,
                &source_video,
                "Kling 待处理视频",
                upload.as_ref(),
                zhiniao_base.as_deref(),
                0,
            )
            .await?;
            let audio = resolve_asset(
                ctx,
                &audio_source,
                "Kling 对口型音频",
                upload.as_ref(),
                zhiniao_base.as_deref(),
                1,
            )
            .await?;

            let mut session_id = string_param(request, "face_session_id");
            let mut face_id = string_param(request, "face_id");
            if session_id.is_empty() || face_id.is_empty() {
                let (detected_session, detected_face) = identify_face(ctx, &source_video_url).await?;
                if session_id.is_empty() {
                    session_id = detected_session;
                }
                if face_id.is_empty() {
                    face_id = detected_face;
                }
            }
            json!({
                "session_id": session_id,
                "face_choose": [{
                    "face_id": face_id,
                    "sound_file": audio,
                    "sound_start_time": number_param(request, "sound_start_time", 0.0),
                    "sound_end_time": number_param(request, "sound_end_time", 60_000.0),
                    "sound_insert_time": number_param(request, "sound_insert_time", 0.0),
                    "sound_volume": number_param(request, "sound_volume", 1.0),
                    "original_audio_volume": number_param(request, "original_audio_volume", 1.0),
                }],
            })
        }
    };

    if mode == ControlMode::LipSync {
        let ready = body
            .get("session_id")
            .and_then(Value::as_str)
            .map(|value| !value.is_empty())
            .unwrap_or(false);
        if !ready {
            return Err(AIError::InvalidRequest(
                "Kling 对口型需要先做人脸识别，并提供 session_id 和 face_id".into(),
            ));
        }
    }

    let submit_url = endpoint(&ctx.base_url, &submit_path(request, mode, &model));
    let response = ctx
        .client
        .post(&submit_url)
        .bearer_auth(&ctx.api_key)
        .header("Accept-Encoding", "identity")
        .json(&body)
        .send()
        .await
        .map_err(|error| AIError::Provider(format!("{} 请求失败(网络): {}", PLATFORM_LABEL, describe_reqwest_error(&error))))?;
    let status = response.status();
    let raw = response.text().await.unwrap_or_default();
    let payload: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(http_error(&format!("{} 请求失败", PLATFORM_LABEL), status, &raw, &submit_url));
    }

    let task_id = extract::task_id(&payload);
    if let Some(url) = extract::result_url(&payload) {
        // 有 url 又没给 task_id 才算真的出片; 同时给了就以 task_id 为准继续轮询
        // (平台有时会先塞一个占位地址)。
        if task_id.is_none() {
            return Ok(ProviderTaskSubmission::Succeeded(url));
        }
    }
    let task_id = task_id.ok_or_else(|| {
        AIError::TaskFailed(format!(
            "{} 响应中未找到任务 ID: {}",
            PLATFORM_LABEL,
            truncate(&payload.to_string(), 600)
        ))
    })?;
    // motion-control 的查询路径是 `/tasks?task_ids={taskId}`, 其余是路径占位符 ——
    // 两种形态都在这里一次性算成绝对地址落库。
    let raw_query_path = query_path(request, mode);
    let query_url = if raw_query_path.contains("{taskId}") {
        endpoint(&ctx.base_url, &raw_query_path.replace("{taskId}", &urlencoding::encode(&task_id)))
    } else if raw_query_path.contains("task_ids=") {
        format!("{}{}", endpoint(&ctx.base_url, &raw_query_path), urlencoding::encode(&task_id))
    } else {
        endpoint(&ctx.base_url, &raw_query_path)
    };
    Ok(queued(task_id, &ctx.provider_id, TRANSPORT, query_url, None))
}

pub async fn poll(
    ctx: &PollContext,
    metadata: &serde_json::Map<String, Value>,
    _handle: &ProviderTaskHandle,
) -> Result<ProviderTaskPollResult, AIError> {
    let query_url = meta_string(metadata, "query_url")
        .ok_or_else(|| AIError::InvalidRequest("Kling 任务缺少查询地址, 无法续查".into()))?;
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

    if let Some(url) = extract::result_url(&payload) {
        return Ok(ProviderTaskPollResult::Succeeded(url));
    }
    // motion-control 的查询返回顶层数组, `extract::task_status` 对数组刻意返回空串 ——
    // 数组里任一元素的终态不能代表整单, 于是这里保持 running 直到出现成片地址。
    let task_status = extract::task_status(&payload);
    if matches!(
        task_status.as_str(),
        "FAILED" | "FAILURE" | "ERROR" | "CANCELED" | "CANCELLED" | "REJECTED"
    ) {
        let reason = extract::failure_reason(&payload).unwrap_or(task_status);
        return Ok(ProviderTaskPollResult::Failed(format!("{} 生成失败: {}", PLATFORM_LABEL, reason)));
    }
    Ok(ProviderTaskPollResult::Running)
}

/// 供 `openai_compat` 判定是否属于本协议。Kling 控制链路只有节点显式标记一条入口,
/// 没有 Base URL 兜底 —— 通用端点绝不能误抢动作控制 / 对口型请求。
pub fn matches(transport: &str, _provider_base_url: &str, _provider_id: &str) -> bool {
    transport == TRANSPORT
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request_with(params: Value) -> GenerateVideoRequest {
        let extra_params = params.as_object().map(|map| {
            map.iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect::<std::collections::HashMap<String, Value>>()
        });
        GenerateVideoRequest {
            prompt: "p".into(),
            model: "custom:x/kling-2.6".into(),
            duration: 5,
            aspect_ratio: "16:9".into(),
            video_resolution: None,
            image_mode: None,
            reference_images: None,
            reference_audio: None,
            extra_params,
        }
    }

    #[test]
    fn version_detection_covers_dot_underscore_dash() {
        assert_eq!(kling_version("kling-2.6"), "kling-2.6");
        assert_eq!(kling_version("Kling_2_6"), "kling-2.6");
        assert_eq!(kling_version("kling-2-6-pro"), "kling-2.6");
        assert_eq!(kling_version("kling-3.0"), "kling-3.0");
    }

    #[test]
    fn mode_defaults_to_motion_control() {
        assert_eq!(control_mode(&request_with(json!({}))), ControlMode::MotionControl);
        assert_eq!(
            control_mode(&request_with(json!({ "control_mode": "lip-sync" }))),
            ControlMode::LipSync
        );
    }

    #[test]
    fn official_paths_are_not_hijacked_by_generic_video_paths() {
        let request = request_with(json!({
            "video_submit_path": "/v1/videos/generations",
            "video_query_path": "/v1/tasks/{taskId}",
        }));
        assert_eq!(
            submit_path(&request, ControlMode::MotionControl, "kling-3.0"),
            "/motion-control/kling-3.0"
        );
        assert_eq!(
            query_path(&request, ControlMode::MotionControl),
            "/tasks?task_ids={taskId}"
        );
        assert_eq!(query_path(&request, ControlMode::LipSync), "/v1/videos/advanced-lip-sync/{taskId}");
    }

    #[test]
    fn kling_specific_overrides_win() {
        let request = request_with(json!({ "kling_query_path": "/custom/{taskId}" }));
        assert_eq!(query_path(&request, ControlMode::MotionControl), "/custom/{taskId}");
    }

    #[test]
    fn numeric_params_fall_back_only_when_absent() {
        let request = request_with(json!({ "sound_volume": 0, "sound_end_time": 1200 }));
        assert_eq!(number_param(&request, "sound_volume", 1.0), 0.0);
        assert_eq!(number_param(&request, "sound_end_time", 60_000.0), 1200.0);
        assert_eq!(number_param(&request, "sound_start_time", 0.0), 0.0);
    }
}
