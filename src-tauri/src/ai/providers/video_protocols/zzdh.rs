// ---------------------------------------------------------------------------
// 字子动画(zizidonghua.com)视频协议
//
// 对应前端 `generateZzdhVideo`(事实来源: `src/commands/zzdhApi.ts` 里照抄的官方文档)。
// 与通用 OpenAI 兼容视频的差异:
//   - 端点是 `/v8/videos/generations`, 查询是 `${submitUrl}/{taskId}`(不是 ?task_id=)。
//   - 画幅枚举只有 16:9 / 9:16 / 1:1; **首尾帧要跟随首帧图片的实际宽高**推导。
//   - `resolution` 优先于 `aspect_ratio`, 必须用**最终画幅**去算, 否则会出现
//     resolution=1280x720 与 aspect_ratio=9:16 互相矛盾、平台按横屏执行的静默错误;
//     档位写在模型名里时(`...-480p` / `...-4k`)一律不传 resolution。
//   - 参考图/视频是对象数组: 非 H3 可以内联 `base64`, H3 **只收公网 HTTP(S) URL**,
//     本地素材必须经用户配置的上传服务换 URL(否则平台报 reference image must be public)。
//   - H3 还要显式传 `mode`(t2v / fl2v / ref2v), 不传会被静默当成参考生。
//   - 网关偶发同步返回 HTTP 400「请求转换失败」; 官方明确被拒绝的请求不扣费,
//     所以只对这一种错误做一次有界重试。
// ---------------------------------------------------------------------------
use serde_json::{json, Value};

use crate::ai::error::AIError;
use crate::ai::providers::video_protocols::assets::{extract_asset_url, resolve_reference_asset, truncate, ReferenceAsset};
use crate::ai::providers::video_protocols::extract;
use crate::ai::providers::video_protocols::{
    http_error, meta_string, queued, string_array_param, string_param, PollContext, SubmitContext,
};
use crate::ai::{GenerateVideoRequest, ProviderTaskHandle, ProviderTaskPollResult, ProviderTaskSubmission};

pub const TRANSPORT: &str = "zzdh-v8-video";
const SUBMIT_PATH: &str = "/v8/videos/generations";
const PLATFORM_LABEL: &str = "字子动画";
const ASPECT_RATIOS: [&str; 3] = ["16:9", "9:16", "1:1"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Family {
    MinimaxH3,
    Kling,
    Seedance,
    Wan,
    HappyHorse,
    Other,
}

fn api_model(request: &GenerateVideoRequest) -> String {
    request
        .model
        .split_once('/')
        .map(|(_, model)| model.to_string())
        .unwrap_or_else(|| request.model.clone())
}

/// 按 `-` / `_` 切词。官方文档里「档位」与「-video」都写在名字的独立词段上,
/// 切词比对等价于文档的正则 `(?:^|[-_])(...)(?:[-_]|$)`。
fn model_tokens(model: &str) -> Vec<String> {
    model
        .trim()
        .to_ascii_lowercase()
        .split(['-', '_'])
        .map(str::to_string)
        .collect()
}

fn family_of(model: &str) -> Family {
    let normalized = model.trim().to_ascii_lowercase();
    if normalized.contains("minimax") || normalized.contains("h3") {
        Family::MinimaxH3
    } else if normalized.contains("kling") {
        Family::Kling
    } else if normalized.contains("seedance") || normalized.contains("doubao") {
        Family::Seedance
    } else if normalized.contains("wan") {
        Family::Wan
    } else if normalized.contains("happyhorse") {
        Family::HappyHorse
    } else {
        Family::Other
    }
}

/// 档位写在模型名里时(如 `zzdh-Minimax-h3-480p`、`doubao-seedance-2-video-4k`)。
fn resolution_tier(model: &str) -> Option<String> {
    const TIERS: [&str; 7] = ["480p", "540p", "720p", "768p", "1080p", "2k", "4k"];
    model_tokens(model).into_iter().find(|token| TIERS.contains(&token.as_str()))
}

/// H3 时长按档位收窄(480P 5~10s, 其余 5~15s); 其它系列未声明范围。
fn duration_range(model: &str) -> Option<(u32, u32)> {
    if family_of(model) != Family::MinimaxH3 {
        return None;
    }
    let max = if resolution_tier(model).as_deref() == Some("480p") { 10 } else { 15 };
    Some((5, max))
}

fn resolve_aspect_ratio(value: &str) -> String {
    let trimmed = value.trim();
    ASPECT_RATIOS
        .iter()
        .find(|candidate| **candidate == trimmed)
        .map(|value| (*value).to_string())
        .unwrap_or_else(|| "16:9".to_string())
}

fn ratio_value(value: &str) -> f64 {
    match value {
        "9:16" => 9.0 / 16.0,
        "1:1" => 1.0,
        _ => 16.0 / 9.0,
    }
}

fn aspect_ratio_from_size(width: u32, height: u32) -> String {
    if width == 0 || height == 0 {
        return "16:9".to_string();
    }
    let ratio = width as f64 / height as f64;
    let mut best = "16:9";
    let mut best_diff = f64::INFINITY;
    for candidate in ASPECT_RATIOS {
        let diff = (ratio_value(candidate) - ratio).abs();
        if diff < best_diff {
            best_diff = diff;
            best = candidate;
        }
    }
    best.to_string()
}

/// 非 H3 的 `resolution` 是精确尺寸, 必须用**最终画幅**推导; 档位锁在模型名里则不传。
fn video_resolution(requested: Option<&str>, aspect_ratio: &str, model: &str) -> Option<String> {
    if resolution_tier(model).is_some() {
        return None;
    }
    let requested = requested.map(|value| value.trim().to_ascii_lowercase()).unwrap_or_default();
    if !requested.is_empty() && is_exact_size(&requested) {
        return Some(requested);
    }
    let table: [(&str, [(&str, &str); 4]); 3] = [
        (
            "16:9",
            [("480p", "854x480"), ("720p", "1280x720"), ("1080p", "1920x1080"), ("2k", "2560x1440")],
        ),
        (
            "9:16",
            [("480p", "480x854"), ("720p", "720x1280"), ("1080p", "1080x1920"), ("2k", "1440x2560")],
        ),
        (
            "1:1",
            [("480p", "480x480"), ("720p", "720x720"), ("1080p", "1080x1080"), ("2k", "2048x2048")],
        ),
    ];
    let entry = table.iter().find(|(ratio, _)| *ratio == aspect_ratio.trim());
    let Some((_, tiers)) = entry else {
        return Some("1280x720".to_string());
    };
    let value = tiers
        .iter()
        .find(|(tier, _)| *tier == requested)
        .map(|(_, size)| (*size).to_string())
        .or_else(|| tiers.iter().find(|(tier, _)| *tier == "720p").map(|(_, size)| (*size).to_string()))
        .unwrap_or_else(|| "1280x720".to_string());
    Some(value)
}

fn is_exact_size(value: &str) -> bool {
    let Some((width, height)) = value.split_once('x') else {
        return false;
    };
    !width.is_empty()
        && !height.is_empty()
        && width.chars().all(|ch| ch.is_ascii_digit())
        && height.chars().all(|ch| ch.is_ascii_digit())
}

fn reference_role(family: Family, image_mode: Option<&str>, index: usize) -> &'static str {
    if family == Family::MinimaxH3 && image_mode != Some("first-last") {
        return "reference_image";
    }
    if index == 0 {
        "first_frame"
    } else {
        "last_frame"
    }
}

fn generation_mode(image_mode: Option<&str>, image_count: usize, model: &str) -> &'static str {
    if image_mode == Some("first-last") {
        return "fl2v";
    }
    if image_count == 0 {
        return "t2v";
    }
    // 4K 档模型页只写「文生 / 图生 / 首尾帧」(无参考生), 有图时按首帧生视频。
    if resolution_tier(model).as_deref() == Some("4k") {
        "fl2v"
    } else {
        "ref2v"
    }
}

/// 用户配置的参考素材上传服务(把本地素材换成公网 URL)。
struct UploadConfig {
    url: String,
    token: String,
}

fn upload_config(request: &GenerateVideoRequest) -> Option<UploadConfig> {
    let url = string_param(request, "reference_asset_upload_url")
        .trim_end_matches('/')
        .to_string();
    let token = string_param(request, "reference_asset_upload_token");
    (!url.is_empty() && !token.is_empty()).then_some(UploadConfig { url, token })
}

async fn upload_public_reference_asset(
    ctx: &SubmitContext,
    config: &UploadConfig,
    mime_type: &str,
    extension: &str,
    bytes: &[u8],
    index: usize,
) -> Result<String, AIError> {
    use base64::{engine::general_purpose::STANDARD, Engine};
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
        .map_err(|error| AIError::Provider(format!("参考素材上传失败(网络): {}", error)))?;
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

/// 参考图 → 平台要求的对象数组。
async fn resolve_reference_images(
    ctx: &SubmitContext,
    request: &GenerateVideoRequest,
    sources: &[String],
    family: Family,
    image_mode: Option<&str>,
) -> Result<Vec<Value>, AIError> {
    let config = upload_config(request);
    let mut resolved = Vec::with_capacity(sources.len());
    for (index, source) in sources.iter().enumerate() {
        let label = format!("{}参考图片 {}", PLATFORM_LABEL, index + 1);
        let asset = resolve_reference_asset(source, &label).await?;
        let role = reference_role(family, image_mode, index);
        match asset {
            ReferenceAsset::Url(url) => resolved.push(json!({ "url": url, "role": role })),
            ReferenceAsset::File { mime_type, extension, bytes } => {
                if family == Family::MinimaxH3 {
                    let Some(config) = config.as_ref() else {
                        return Err(AIError::InvalidRequest(format!(
                            "{} MiniMax H3 参考图仅支持公网 HTTP(S) URL：第 {} 张是本地或内嵌素材。请先在{}的平台设置中配置“参考素材上传地址”和“上传令牌”，或上传到可公开访问的图床/CDN 后再生成。",
                            PLATFORM_LABEL,
                            index + 1,
                            PLATFORM_LABEL
                        )));
                    };
                    let url = upload_public_reference_asset(ctx, config, &mime_type, &extension, &bytes, index).await?;
                    resolved.push(json!({ "url": url, "role": role }));
                } else {
                    use base64::{engine::general_purpose::STANDARD, Engine};
                    resolved.push(json!({ "base64": STANDARD.encode(&bytes), "role": role }));
                }
            }
        }
    }
    Ok(resolved)
}

async fn resolve_reference_videos(
    ctx: &SubmitContext,
    request: &GenerateVideoRequest,
    sources: &[String],
    family: Family,
) -> Result<Vec<Value>, AIError> {
    let config = upload_config(request);
    let mut resolved = Vec::with_capacity(sources.len());
    for (index, source) in sources.iter().enumerate() {
        let label = format!("{}参考视频 {}", PLATFORM_LABEL, index + 1);
        let asset = resolve_reference_asset(source, &label).await?;
        match asset {
            ReferenceAsset::Url(url) => resolved.push(json!({ "url": url })),
            ReferenceAsset::File { mime_type, extension, bytes } => {
                if family == Family::MinimaxH3 {
                    let Some(config) = config.as_ref() else {
                        return Err(AIError::InvalidRequest(format!(
                            "{} MiniMax H3 对口型参考视频仅支持公网 HTTP(S) URL：当前素材是本地或内嵌视频。请先在{}的平台设置中配置“参考素材上传地址”和“上传令牌”，或上传到可公开访问的图床/CDN 后再生成。",
                            PLATFORM_LABEL, PLATFORM_LABEL
                        )));
                    };
                    let url = upload_public_reference_asset(ctx, config, &mime_type, &extension, &bytes, index).await?;
                    resolved.push(json!({ "url": url }));
                } else {
                    use base64::{engine::general_purpose::STANDARD, Engine};
                    resolved.push(json!({ "base64": STANDARD.encode(&bytes) }));
                }
            }
        }
    }
    Ok(resolved)
}

/// 首帧图片的实际宽高(首尾帧画幅跟随首帧)。读不到时回退 UI 选择的画幅。
async fn first_frame_aspect_ratio(ctx: &SubmitContext, source: &str, fallback: &str) -> String {
    let Some(dimensions) = source_dimensions(ctx, source).await else {
        return resolve_aspect_ratio(fallback);
    };
    aspect_ratio_from_size(dimensions.0, dimensions.1)
}

async fn source_dimensions(ctx: &SubmitContext, source: &str) -> Option<(u32, u32)> {
    use image::GenericImageView;
    let asset = resolve_reference_asset(source, "字子动画首帧").await.ok()?;
    let bytes = match asset {
        ReferenceAsset::File { bytes, .. } => bytes,
        ReferenceAsset::Url(url) => {
            let response = ctx.client.get(&url).header("Accept-Encoding", "identity").send().await.ok()?;
            if !response.status().is_success() {
                return None;
            }
            response.bytes().await.ok()?.to_vec()
        }
    };
    let image = image::load_from_memory(&bytes).ok()?;
    let (width, height) = image.dimensions();
    (width > 0 && height > 0).then_some((width, height))
}

pub async fn submit(ctx: &SubmitContext, request: &GenerateVideoRequest) -> Result<ProviderTaskSubmission, AIError> {
    let base_url = ctx.base_url.trim_end_matches('/').to_string();
    let model = api_model(request);
    let family = family_of(&model);
    let is_minimax_h3 = family == Family::MinimaxH3;
    let is_first_last = request.image_mode.as_deref() == Some("first-last");
    let images: Vec<String> = request
        .reference_images
        .clone()
        .unwrap_or_default()
        .into_iter()
        .filter(|source| !source.trim().is_empty())
        .collect();
    let images: Vec<String> = if is_first_last { images.into_iter().take(2).collect() } else { images };
    let raw_videos: Vec<String> = string_array_param(request, "reference_videos", 3);

    let reference_images = resolve_reference_images(ctx, request, &images, family, request.image_mode.as_deref()).await?;
    let reference_videos = resolve_reference_videos(ctx, request, &raw_videos, family).await?;

    let generation_mode = generation_mode(request.image_mode.as_deref(), images.len() + reference_videos.len(), &model);
    let aspect_ratio = if is_first_last {
        match images.first() {
            Some(source) => first_frame_aspect_ratio(ctx, source, &request.aspect_ratio).await,
            None => resolve_aspect_ratio(&request.aspect_ratio),
        }
    } else {
        resolve_aspect_ratio(&request.aspect_ratio)
    };
    let resolution = video_resolution(request.video_resolution.as_deref(), &aspect_ratio, &model);
    let duration = match duration_range(&model) {
        Some((min, max)) => request.duration.clamp(min, max),
        None => request.duration.max(1),
    };
    let reference_audios: Vec<Value> = request
        .reference_audio
        .clone()
        .unwrap_or_default()
        .into_iter()
        .map(|url| url.trim().to_string())
        .filter(|url| !url.is_empty())
        .map(|url| json!({ "url": url }))
        .collect();

    let mut body = json!({
        "model": model,
        "prompt": request.prompt,
        "duration": duration,
        "aspect_ratio": aspect_ratio,
    });
    if let Some(object) = body.as_object_mut() {
        if is_minimax_h3 {
            object.insert("mode".into(), Value::String(generation_mode.to_string()));
        }
        if let Some(resolution) = resolution {
            object.insert("resolution".into(), Value::String(resolution));
        }
        if !reference_images.is_empty() {
            object.insert("reference_images".into(), Value::Array(reference_images));
        }
        if !reference_videos.is_empty() {
            object.insert("reference_videos".into(), Value::Array(reference_videos));
        }
        if !reference_audios.is_empty() {
            object.insert("reference_audios".into(), Value::Array(reference_audios));
        }
    }

    let submit_url = format!("{}{}", base_url, SUBMIT_PATH);
    // 网关偶发 400「请求转换失败」(转换参考素材时); 被拒绝的请求官方明确不扣费,
    // 因此只对这一种错误重试一次。
    let mut last = (reqwest::StatusCode::OK, String::new());
    for attempt in 0..2 {
        let response = ctx
            .client
            .post(&submit_url)
            .bearer_auth(&ctx.api_key)
            .header("Accept-Encoding", "identity")
            .json(&body)
            .send()
            .await
            .map_err(|error| AIError::Provider(format!("{}视频请求失败(网络): {}", PLATFORM_LABEL, error)))?;
        let status = response.status();
        let raw = response.text().await.unwrap_or_default();
        let retriable = !status.is_success() && attempt == 0 && raw.contains("请求转换失败");
        last = (status, raw);
        if !retriable {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    }
    let (status, raw) = last;
    let payload: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(http_error(&format!("{}视频请求失败", PLATFORM_LABEL), status, &raw, &submit_url));
    }

    if let Some(url) = extract::result_url(&payload) {
        return Ok(ProviderTaskSubmission::Succeeded(url));
    }
    let task_id = extract::task_id(&payload).ok_or_else(|| {
        AIError::TaskFailed(format!(
            "{}视频响应中未找到任务 ID 或视频地址: {}",
            PLATFORM_LABEL,
            truncate(&payload.to_string(), 600)
        ))
    })?;
    let query_url = format!("{}/{}", submit_url, urlencoding::encode(&task_id));
    Ok(queued(task_id, &ctx.provider_id, TRANSPORT, query_url, None))
}

pub async fn poll(
    ctx: &PollContext,
    metadata: &serde_json::Map<String, Value>,
    _handle: &ProviderTaskHandle,
) -> Result<ProviderTaskPollResult, AIError> {
    let query_url = meta_string(metadata, "query_url")
        .ok_or_else(|| AIError::InvalidRequest("字子动画任务缺少查询地址, 无法续查".into()))?;
    let response = ctx
        .client
        .get(query_url)
        .bearer_auth(&ctx.api_key)
        .header("Accept-Encoding", "identity")
        .send()
        .await
        .map_err(|error| AIError::Provider(format!("{}视频查询失败(网络): {}", PLATFORM_LABEL, error)))?;
    let status = response.status();
    let raw = response.text().await.unwrap_or_default();
    let payload: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    if !status.is_success() {
        if status.is_client_error() {
            return Ok(ProviderTaskPollResult::Failed(format!(
                "{}视频查询失败: HTTP {} {}",
                PLATFORM_LABEL,
                status,
                truncate(&raw, 500)
            )));
        }
        return Err(http_error(&format!("{}视频查询失败", PLATFORM_LABEL), status, &raw, query_url));
    }

    if let Some(url) = extract::result_url(&payload) {
        return Ok(ProviderTaskPollResult::Succeeded(url));
    }
    let task_status = extract::task_status(&payload);
    if matches!(
        task_status.as_str(),
        "FAILED" | "FAILURE" | "ERROR" | "CANCELED" | "CANCELLED" | "REJECTED"
    ) {
        let reason = extract::failure_reason(&payload).unwrap_or(task_status);
        return Ok(ProviderTaskPollResult::Failed(format!("{}视频生成失败: {}", PLATFORM_LABEL, reason)));
    }
    Ok(ProviderTaskPollResult::Running)
}

/// 供 `openai_compat` 判定是否属于本协议。
pub fn matches(transport: &str, provider_base_url: &str, provider_id: &str) -> bool {
    if transport == TRANSPORT {
        return true;
    }
    if !transport.is_empty() {
        return false;
    }
    let lower_url = provider_base_url.trim().to_ascii_lowercase();
    let normalized_id = provider_id.trim().to_ascii_lowercase().replace("custom:", "");
    lower_url.contains("zizidonghua.com")
        || matches!(normalized_id.as_str(), "zizidonghua" | "字子动画" | "字字动画")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolution_tier_reads_model_name_tokens() {
        assert_eq!(resolution_tier("zzdh-Minimax-h3-480p").as_deref(), Some("480p"));
        assert_eq!(resolution_tier("doubao-seedance-2-video-4k").as_deref(), Some("4k"));
        assert_eq!(resolution_tier("zzdh-h3"), None);
    }

    #[test]
    fn h3_duration_range_narrows_at_480p() {
        assert_eq!(duration_range("zzdh-minimax-h3-480p"), Some((5, 10)));
        assert_eq!(duration_range("zzdh-minimax-h3-768p"), Some((5, 15)));
        assert_eq!(duration_range("kling-3.0-omni"), None);
    }

    #[test]
    fn resolution_is_omitted_when_tier_is_locked_in_model_name() {
        assert_eq!(video_resolution(Some("720p"), "16:9", "zzdh-minimax-h3-480p"), None);
        assert_eq!(
            video_resolution(Some("720p"), "16:9", "zzdh-video").as_deref(),
            Some("1280x720")
        );
        assert_eq!(
            video_resolution(Some("854x480"), "9:16", "zzdh-video").as_deref(),
            Some("854x480")
        );
    }

    #[test]
    fn reference_role_follows_family_and_mode() {
        assert_eq!(reference_role(Family::MinimaxH3, None, 2), "reference_image");
        assert_eq!(reference_role(Family::MinimaxH3, Some("first-last"), 1), "last_frame");
        assert_eq!(reference_role(Family::Kling, None, 0), "first_frame");
        assert_eq!(reference_role(Family::Kling, None, 1), "last_frame");
    }

    #[test]
    fn generation_mode_is_explicit_for_h3() {
        assert_eq!(generation_mode(Some("first-last"), 2, "zzdh-h3"), "fl2v");
        assert_eq!(generation_mode(None, 0, "zzdh-h3"), "t2v");
        assert_eq!(generation_mode(None, 1, "zzdh-h3"), "ref2v");
        assert_eq!(generation_mode(None, 1, "zzdh-Minimax-h3-4k"), "fl2v");
    }

    #[test]
    fn aspect_ratio_snaps_to_official_enum() {
        assert_eq!(aspect_ratio_from_size(1920, 1080), "16:9");
        assert_eq!(aspect_ratio_from_size(1080, 1920), "9:16");
        assert_eq!(aspect_ratio_from_size(1000, 1000), "1:1");
        assert_eq!(resolve_aspect_ratio("4:3"), "16:9");
    }
}
