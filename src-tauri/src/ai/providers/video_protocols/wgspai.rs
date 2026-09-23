// ---------------------------------------------------------------------------
// WGSPAI 视频协议(api.wgspai.cn)
//
// 对应前端 `generateWgspaiVideo`。与通用 OpenAI 兼容视频的差异:
//   - 端点单复数不同: `/v1/video/generations`(通用是 `/v1/videos/generations`)
//   - 画幅字段叫 `ratio` 而不是 `aspect_ratio`
//   - 固定带 `generate_audio: true` 与 `n: 1`
//   - 首尾帧用 `start_frame` / `end_frame` 数组, 不是 `images` + `generation_type`
//   - 参考音频字段是 `reference_audios`
//   - 平台**没有独立上传端点**, 本地素材只能内联成 data URL
// ---------------------------------------------------------------------------
use serde_json::{json, Value};

use crate::ai::error::AIError;
use crate::ai::providers::video_protocols::assets::{
    resolve_reference_asset, to_data_url, ReferenceAsset,
};
use crate::ai::providers::video_protocols::{http_error, submission_from_payload, SubmitContext};
use crate::ai::{GenerateVideoRequest, ProviderTaskSubmission};

const TRANSPORT: &str = "wgspai-video";
const SUBMIT_PATH: &str = "/v1/video/generations";

/// 平台无上传端点: 公网 URL 透传, 其余读成本地字节后内联成 data URL。
async fn inline_source(source: &str, label: &str) -> Result<String, AIError> {
    match resolve_reference_asset(source, label).await? {
        ReferenceAsset::Url(url) => Ok(url),
        ReferenceAsset::File { mime_type, bytes, .. } => Ok(to_data_url(&mime_type, &bytes)),
    }
}

pub async fn submit(
    ctx: &SubmitContext,
    request: &GenerateVideoRequest,
) -> Result<ProviderTaskSubmission, AIError> {
    let is_first_last = request.image_mode.as_deref() == Some("first-last");
    let image_limit = if is_first_last { 2 } else { 30 };
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

    let mut images = Vec::with_capacity(raw_images.len());
    for (index, source) in raw_images.iter().enumerate() {
        images.push(inline_source(source, &format!("WGSPAI 参考素材 {}", index + 1)).await?);
    }
    let mut audios = Vec::with_capacity(raw_audio.len());
    for (index, source) in raw_audio.iter().enumerate() {
        audios.push(inline_source(source, &format!("WGSPAI 参考音频 {}", index + 1)).await?);
    }

    let mut body = json!({
        "model": request.model.split_once('/').map(|(_, model)| model).unwrap_or(request.model.as_str()),
        "prompt": request.prompt,
        "duration": request.duration.max(1),
        "ratio": request.aspect_ratio,
        "generate_audio": true,
        "n": 1,
    });
    if let Some(object) = body.as_object_mut() {
        if !images.is_empty() {
            if is_first_last {
                object.insert("start_frame".into(), json!([images[0]]));
                if let Some(end) = images.get(1) {
                    object.insert("end_frame".into(), json!([end]));
                }
            } else {
                object.insert("images".into(), json!(images));
            }
        }
        if !audios.is_empty() {
            object.insert("reference_audios".into(), json!(audios));
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
        .map_err(|error| AIError::Provider(format!("WGSPAI 视频提交失败(网络): {}", error)))?;
    let status = response.status();
    let raw = response.text().await.unwrap_or_default();
    let payload: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(http_error("WGSPAI 视频请求失败", status, &raw, &submit_url));
    }

    // 查询地址在提交时算好并落库: 续查时 extra_params 已不可用。
    let query_url = format!("{}/{{taskId}}", submit_url);
    submission_from_payload(&payload, &ctx.provider_id, TRANSPORT, query_url, None)
}

/// 供 `openai_compat` 判定是否属于本协议。
///
/// transport 命中是主路径(前端 `injectCustomApiRequestMode` 已按 providerId /
/// Base URL 注入好)。Base URL 兜底**只在 transport 为空时**生效 —— 否则用户
/// 显式把平台配成 `openai-video` 自定义路径时会被误抢。
pub fn matches(transport: &str, provider_base_url: &str, _provider_id: &str) -> bool {
    transport == TRANSPORT
        || (transport.is_empty()
            && provider_base_url.to_ascii_lowercase().contains("api.wgspai.cn"))
}
