// ---------------------------------------------------------------------------
// 炳火视频协议(api.7tai.cc)
//
// 对应前端 `generateBinghuoVideo`。与通用 OpenAI 兼容视频的差异:
//   - 参考素材必须先 POST `/v1/assets/uploads`(multipart, 字段名 file)换公网 URL,
//     平台不接受 data URL; 首次响应偶尔不带 URL(限流/风控), 需要重试一次。
//   - 端点单复数不同: `/v1/video/generations`
//   - 画幅字段叫 `ratio`; 固定带 `generate_audio: true` 与 `n: 1`
//   - 首尾帧 `start_frame` / `end_frame`; 参考音频 `reference_audios`
//   - 参考视频字段名必须是 `reference_videos`(手册 3.3 强调 `videos` /
//     `video_urls` 会被部分模型静默忽略)
//   - `skip_review` 仅对 bh2.0 系模型生效(责任声明, 手册 3.8)
// ---------------------------------------------------------------------------
use serde_json::{json, Value};

use crate::ai::error::AIError;
use crate::ai::providers::video_protocols::assets::{
    extract_asset_url, resolve_reference_asset, truncate, upload_reference_asset_multipart,
    ReferenceAsset,
};
use crate::ai::providers::video_protocols::{
    http_error, string_array_param, submission_from_payload, SubmitContext,
};
use crate::ai::{GenerateVideoRequest, ProviderTaskSubmission};

const TRANSPORT: &str = "binghuo-video";
const SUBMIT_PATH: &str = "/v1/video/generations";
const UPLOAD_PATH: &str = "/v1/assets/uploads";
const PLATFORM_LABEL: &str = "炳火 API";

fn api_model(request: &GenerateVideoRequest) -> String {
    request
        .model
        .split_once('/')
        .map(|(_, model)| model.to_string())
        .unwrap_or_else(|| request.model.clone())
}

fn is_minimax_h3(api_model: &str) -> bool {
    api_model.trim().to_ascii_lowercase().starts_with("minimax-h3-pro-")
}

/// 上传换公网 URL。网关偶发返回不带 URL 的 file 对象(瞬时限流/风控), 上传本身
/// 幂等, 自动重试一次 —— 与前端 `uploadPlatformReferenceAsset` 的行为一致。
async fn upload_one(
    ctx: &SubmitContext,
    source: &str,
    index: usize,
    label: &str,
) -> Result<String, AIError> {
    let asset = resolve_reference_asset(source, label).await?;
    // 已是公网 URL 就不必上传。
    let extension = match &asset {
        ReferenceAsset::Url(url) => return Ok(url.clone()),
        ReferenceAsset::File { extension, .. } => extension.clone(),
    };
    let upload_url = format!("{}{}", ctx.base_url, UPLOAD_PATH);
    let filename = format!("reference-{}.{}", index + 1, extension);

    let mut last_payload = Value::Null;
    for attempt in 1..=2 {
        let payload =
            upload_reference_asset_multipart(&ctx.client, &upload_url, &ctx.api_key, &filename, &asset, PLATFORM_LABEL)
                .await?;
        if let Some(url) = extract_asset_url(&payload) {
            return Ok(url);
        }
        last_payload = payload;
        if attempt == 1 {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        }
    }
    Err(AIError::TaskFailed(format!(
        "{} 参考素材上传响应中未找到公网 URL: {}",
        PLATFORM_LABEL,
        truncate(&last_payload.to_string(), 600)
    )))
}

pub async fn submit(
    ctx: &SubmitContext,
    request: &GenerateVideoRequest,
) -> Result<ProviderTaskSubmission, AIError> {
    let model = api_model(request);
    let is_first_last = request.image_mode.as_deref() == Some("first-last");
    let image_limit = if is_first_last {
        2
    } else if is_minimax_h3(&model) {
        9
    } else {
        30
    };

    let raw_images: Vec<String> = request
        .reference_images
        .clone()
        .unwrap_or_default()
        .into_iter()
        .take(image_limit)
        .collect();
    let raw_audio: Vec<String> = request
        .reference_audio
        .clone()
        .unwrap_or_default()
        .into_iter()
        .take(3)
        .collect();
    let raw_videos = string_array_param(request, "reference_videos", 3);

    let mut image_sources = Vec::with_capacity(raw_images.len());
    for (index, source) in raw_images.iter().enumerate() {
        image_sources.push(
            upload_one(ctx, source, index, &format!("{} 参考素材 {}", PLATFORM_LABEL, index + 1)).await?,
        );
    }
    let mut audio_sources = Vec::with_capacity(raw_audio.len());
    for (index, source) in raw_audio.iter().enumerate() {
        audio_sources.push(
            upload_one(
                ctx,
                source,
                image_sources.len() + index,
                &format!("{} 参考音频 {}", PLATFORM_LABEL, index + 1),
            )
            .await?,
        );
    }
    let mut video_sources = Vec::with_capacity(raw_videos.len());
    for (index, source) in raw_videos.iter().enumerate() {
        video_sources.push(
            upload_one(
                ctx,
                source,
                image_sources.len() + audio_sources.len() + index,
                &format!("{} 参考视频 {}", PLATFORM_LABEL, index + 1),
            )
            .await?,
        );
    }

    let mut body = json!({
        "model": model,
        "prompt": request.prompt,
        "duration": request.duration.max(1),
        "ratio": request.aspect_ratio,
        "generate_audio": true,
        "n": 1,
    });
    if let Some(object) = body.as_object_mut() {
        if !image_sources.is_empty() {
            if is_first_last {
                object.insert("start_frame".into(), json!([image_sources[0]]));
                if let Some(end) = image_sources.get(1) {
                    object.insert("end_frame".into(), json!([end]));
                }
            } else {
                object.insert("images".into(), json!(image_sources));
            }
        }
        if !audio_sources.is_empty() {
            object.insert("reference_audios".into(), json!(audio_sources));
        }
        if !video_sources.is_empty() {
            object.insert("reference_videos".into(), json!(video_sources));
        }
        if request
            .extra_params
            .as_ref()
            .and_then(|params| params.get("skip_review"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            object.insert("skip_review".into(), Value::Bool(true));
        }
        if let Some(resolution) = request
            .video_resolution
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            object.insert("resolution".into(), Value::String(resolution.to_string()));
        }
    }

    let submit_url = ctx.endpoint(Some(SUBMIT_PATH), SUBMIT_PATH, None);
    let response = ctx
        .client
        .post(&submit_url)
        .bearer_auth(&ctx.api_key)
        .header("Accept-Encoding", "identity")
        .json(&body)
        .send()
        .await
        .map_err(|error| AIError::Provider(format!("{} 视频提交失败(网络): {}", PLATFORM_LABEL, error)))?;
    let status = response.status();
    let raw = response.text().await.unwrap_or_default();
    let payload: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(http_error(
            &format!("{} 视频请求失败", PLATFORM_LABEL),
            status,
            &raw,
            &submit_url,
        ));
    }

    let query_url = format!("{}/{{taskId}}", submit_url);
    submission_from_payload(&payload, &ctx.provider_id, TRANSPORT, query_url, None)
}

/// 供 `openai_compat` 判定是否属于本协议。
///
/// 前端 `injectCustomApiRequestMode` 已经按 providerId / Base URL 把
/// `video_transport` 注入好了, 所以 transport 命中是主路径; Base URL 兜底
/// **只在 transport 为空时**生效, 避免用户显式配置的通用协议被误抢。
pub fn matches(transport: &str, provider_base_url: &str, _provider_id: &str) -> bool {
    transport == TRANSPORT
        || (transport.is_empty() && provider_base_url.to_ascii_lowercase().contains("api.7tai.cc"))
}
