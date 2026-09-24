// ---------------------------------------------------------------------------
// WGSPAI 视频协议(api.wgspai.cn)
//
// 对应前端 `generateWgspaiVideo`。按站点四份对接文档对齐:
//   - API文档.md                              (总览 / 图床 / 错误体)
//   - api.wgspai.cn-seedance2.5-对接文档.md    (seedance2.5)
//   - minimax-h3-api.md                        (Minimax-h3)
//   - seedance-v2-720p-9-3-3对接文档.md        (seedance-v2 系列)
//
// 早期本文件是从炳火协议整份拷贝出来的, 两家的响应形状确实同构, 但**请求字段并不
// 相同**, 拷贝带过来的几处与 WGSPAI 文档不符, 已逐条纠正:
//
//   1. 端点: 文档三处写明「推荐统一用 /v1/videos」, `/v1/video/generations` 只是
//      「兼容路径(可选)」。提交改 POST /v1/videos, 查询 GET /v1/videos/{id}。
//   2. 本地素材: 从「无上传端点, 只能内联 data URL」改为走**官方背景机图床**
//      https://wgspai.cn/image-bed/api/upload(字段 file, 匿名可传)。文档明确
//      「请求里的图片须为公网可访问 URL, 本地文件先上传本站图床」, 并对 data URL
//      标注「体积大、易触达请求上限」—— 这条不是优化而是修错。
//   3. 参考音频字段是 `audio_urls`(seedance-v2-720p 文档), 不是炳火的
//      `reference_audios`。
//   4. 参考视频字段是 `video_urls`(同上), 不是炳火的 `reference_videos`;
//      原实现**完全没有**透传参考视频。
//   5. 时长: 传 `seconds`(三份文档都认的字段名)。seedance2.5 固定 30 秒、按次
//      计费, 文档建议「不传或传 "30"」→ 该模型直接省略。
//   6. 画幅: `ratio` 与 `size` **同时**传。seedance2.5 / Minimax-h3 的正式字段是
//      `ratio`; seedance-v2-720p 的正式字段是 `size`, 只传 ratio 会被它忽略。
//      `size` 用像素值(1280x720 等), 三份文档都接受, 且 720p 文档明确
//      「`9:16` / `720x1280` 均判为竖屏」。
//   7. 首尾帧: 原实现用 `start_frame` / `end_frame`, 四份文档里**都没有**这两个
//      字段。改为文档口径 —— `images` 传全部, 首尾帧模式时附
//      `image_usage: "first_frame"`(seedance2.5 文档: 默认 reference, first_frame
//      表示第 1 张作首帧)。
//   8. 参考图上限按模型区分(720p / Minimax-h3 都是 9, 超出会被平台拒绝;
//      文档要求「超过上限请自行截断」)。
//
// 保留的两处非文档字段: `generate_audio` 与 `n`。它们是从炳火协议继承下来的,
// 四份文档均未提及; 但多发的字段在网关展平后通常被上游忽略, 删掉反而可能丢掉
// 某个模型上已经生效的行为, 因此保留不动。
// ---------------------------------------------------------------------------
use serde_json::{json, Value};

use crate::ai::error::AIError;
use crate::ai::providers::video_protocols::assets::{
    extract_asset_url, resolve_reference_asset, truncate, upload_reference_asset_multipart,
    ReferenceAsset,
};
use crate::ai::providers::video_protocols::{
    http_error, string_array_param, string_param, submission_from_payload, SubmitContext,
};
use crate::ai::{GenerateVideoRequest, ProviderTaskSubmission};

const TRANSPORT: &str = "wgspai-video";
const SUBMIT_PATH: &str = "/v1/videos";
const PLATFORM_LABEL: &str = "WGSPAI";

/// 图床补全路径。API 域是 `api.wgspai.cn`, 而图床在同站的 `wgspai.cn`
/// (见 seedance2.5 文档第 1 节与 seedance-v2-720p 文档第 2.1 节) —— 两者不是
/// 同一个 host, 所以不能像炳火那样拿 base_url 直接拼, 需要先把 `api.` 前缀摘掉。
const IMAGE_BED_PATH: &str = "/image-bed/api/upload";

/// 各模型在 `/v1/videos` 下的参考素材上限与时长规则。
///
/// 只对**文档明确写了的模型**做收敛, 未识别的模型走宽松默认 —— 宁可透传后由平台
/// 报出它的真实约束, 也不要在这里替用户把素材悄悄丢掉。
struct ModelLimits {
    max_reference_images: usize,
    /// `Some(30)` = 该模型时长固定, 不传 `seconds` 让平台用自己的默认值。
    fixed_duration_seconds: Option<u32>,
    supports_reference_audio: bool,
    supports_reference_video: bool,
}

fn model_limits(model: &str) -> ModelLimits {
    let normalized = model.trim().to_ascii_lowercase();

    // seedance2.5: 「30 秒视频、按次计费」, 参考图最多 30 张; 音频 / 参考视频
    // 「即使传了也不保证生效」→ 仍然透传, 由平台决定要不要用。
    if normalized.contains("seedance2.5") || normalized.contains("seedance-2.5") {
        return ModelLimits {
            max_reference_images: 30,
            fixed_duration_seconds: Some(30),
            supports_reference_audio: true,
            supports_reference_video: true,
        };
    }

    // seedance v2 系列: 9 图 / 3 音频 / 3 视频(简称 9-3-3), 其中参考视频
    // 仅 `-video` 后缀的模型支持。
    if normalized.contains("seedance-v2") || normalized.contains("seedance-v2.5") {
        return ModelLimits {
            max_reference_images: 9,
            fixed_duration_seconds: None,
            supports_reference_audio: true,
            supports_reference_video: normalized.contains("-video"),
        };
    }

    // Minimax-h3: 参考图最多 9; 文档第 2 节明确「参考音视频: 不支持」,
    // 这里不透传, 免得平台因为多出来的字段直接 400。
    if normalized.contains("minimax-h3") {
        return ModelLimits {
            max_reference_images: 9,
            fixed_duration_seconds: None,
            supports_reference_audio: false,
            supports_reference_video: false,
        };
    }

    ModelLimits {
        max_reference_images: 30,
        fixed_duration_seconds: None,
        supports_reference_audio: true,
        supports_reference_video: true,
    }
}

/// 画幅比例 → 像素尺寸。文档里 `ratio` 收比例串、`size` 收像素串(也接受比例串),
/// 两个都发能同时命中「只认 ratio」与「只认 size」的模型。
fn pixel_size_of(aspect_ratio: &str) -> Option<&'static str> {
    match aspect_ratio.trim() {
        "16:9" => Some("1280x720"),
        "9:16" => Some("720x1280"),
        "1:1" => Some("1024x1024"),
        "4:3" => Some("1024x768"),
        "3:4" => Some("768x1024"),
        _ => None,
    }
}

/// 图床地址: 优先读平台配置里的 `reference_asset_upload_url`(设置页可填),
/// 否则按 base_url 推导出同站的图床入口。
fn image_bed_upload_url(base_url: &str, request: &GenerateVideoRequest) -> String {
    let configured = string_param(request, "reference_asset_upload_url");
    if !configured.is_empty() {
        return configured;
    }
    // `https://api.wgspai.cn` → `https://wgspai.cn`
    let root = base_url.trim().trim_end_matches('/').replacen("://api.", "://", 1);
    format!("{}{}", root, IMAGE_BED_PATH)
}

/// 本地素材上传到图床换公网 URL; 已经是公网 URL 的直接透传。
///
/// 图床按文档是**匿名可上传**的(官方 curl 不带鉴权头), 所以 api_key 传空 ——
/// `upload_reference_asset_multipart` 会据此跳过 Authorization 头。
async fn upload_one(
    ctx: &SubmitContext,
    upload_url: &str,
    source: &str,
    stem: &str,
    label: &str,
) -> Result<String, AIError> {
    let asset = resolve_reference_asset(source, label).await?;
    let extension = match &asset {
        ReferenceAsset::Url(url) => return Ok(url.clone()),
        ReferenceAsset::File { extension, .. } => extension.clone(),
    };
    let filename = format!("{}.{}", stem, extension);
    let payload =
        upload_reference_asset_multipart(&ctx.client, upload_url, "", &filename, &asset, PLATFORM_LABEL)
            .await?;
    extract_asset_url(&payload).ok_or_else(|| {
        AIError::TaskFailed(format!(
            "{} 参考素材上传响应中未找到公网 URL: {}",
            PLATFORM_LABEL,
            truncate(&payload.to_string(), 600)
        ))
    })
}

pub async fn submit(
    ctx: &SubmitContext,
    request: &GenerateVideoRequest,
) -> Result<ProviderTaskSubmission, AIError> {
    let model = request
        .model
        .split_once('/')
        .map(|(_, model)| model)
        .unwrap_or(request.model.as_str())
        .to_string();
    let limits = model_limits(&model);
    let is_first_last = request.image_mode.as_deref() == Some("first-last");

    let image_limit = if is_first_last { 2 } else { limits.max_reference_images };
    let raw_images: Vec<String> = request
        .reference_images
        .clone()
        .unwrap_or_default()
        .into_iter()
        .take(image_limit)
        .collect();
    let raw_audio: Vec<String> = if limits.supports_reference_audio {
        request
            .reference_audio
            .clone()
            .unwrap_or_default()
            .into_iter()
            .take(3)
            .collect()
    } else {
        Vec::new()
    };
    let raw_videos: Vec<String> = if limits.supports_reference_video {
        string_array_param(request, "reference_videos", 3)
    } else {
        Vec::new()
    };

    let upload_url = image_bed_upload_url(&ctx.base_url, request);
    let mut images = Vec::with_capacity(raw_images.len());
    for (index, source) in raw_images.iter().enumerate() {
        images.push(
            upload_one(
                ctx,
                &upload_url,
                source,
                &format!("image-{}", index + 1),
                &format!("{} 参考图 {}", PLATFORM_LABEL, index + 1),
            )
            .await?,
        );
    }
    let mut audios = Vec::with_capacity(raw_audio.len());
    for (index, source) in raw_audio.iter().enumerate() {
        audios.push(
            upload_one(
                ctx,
                &upload_url,
                source,
                &format!("audio-{}", index + 1),
                &format!("{} 参考音频 {}", PLATFORM_LABEL, index + 1),
            )
            .await?,
        );
    }
    let mut videos = Vec::with_capacity(raw_videos.len());
    for (index, source) in raw_videos.iter().enumerate() {
        videos.push(
            upload_one(
                ctx,
                &upload_url,
                source,
                &format!("video-{}", index + 1),
                &format!("{} 参考视频 {}", PLATFORM_LABEL, index + 1),
            )
            .await?,
        );
    }

    let mut body = json!({
        "model": model,
        "prompt": request.prompt,
        // 非文档字段, 从炳火协议继承; 保留以不改变既有行为(见文件头说明)。
        "generate_audio": true,
        "n": 1,
    });

    if let Some(object) = body.as_object_mut() {
        // 时长: 固定时长的模型直接省略, 让平台用它的默认值(seedance2.5 = 30 秒)。
        if limits.fixed_duration_seconds.is_none() {
            object.insert(
                "seconds".into(),
                Value::String(request.duration.max(1).to_string()),
            );
        }

        let aspect_ratio = request.aspect_ratio.trim();
        if !aspect_ratio.is_empty() {
            object.insert("ratio".into(), Value::String(aspect_ratio.to_string()));
            if let Some(size) = pixel_size_of(aspect_ratio) {
                object.insert("size".into(), Value::String(size.to_string()));
            }
        }

        if !images.is_empty() {
            object.insert("images".into(), json!(images));
            // 首尾帧模式: 文档口径是 `images` + `image_usage: first_frame`
            // (第 1 张作首帧), 不是炳火那套 start_frame / end_frame。
            if is_first_last {
                object.insert("image_usage".into(), Value::String("first_frame".into()));
            }
        }
        if !audios.is_empty() {
            object.insert("audio_urls".into(), json!(audios));
        }
        if !videos.is_empty() {
            object.insert("video_urls".into(), json!(videos));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seedance25_is_fixed_30s_with_30_images() {
        let limits = model_limits("seedance2.5");
        assert_eq!(limits.fixed_duration_seconds, Some(30));
        assert_eq!(limits.max_reference_images, 30);
    }

    #[test]
    fn seedance_v2_uses_933_limits() {
        let limits = model_limits("seedance-v2-720p");
        assert_eq!(limits.max_reference_images, 9);
        assert_eq!(limits.fixed_duration_seconds, None);
        assert!(limits.supports_reference_audio);
        // 参考视频只由 `-video` 后缀模型支持。
        assert!(!limits.supports_reference_video);
        assert!(model_limits("seedance-v2-720p-video").supports_reference_video);
    }

    #[test]
    fn minimax_h3_rejects_audio_and_video_references() {
        let limits = model_limits("Minimax-h3");
        assert_eq!(limits.max_reference_images, 9);
        assert!(!limits.supports_reference_audio);
        assert!(!limits.supports_reference_video);
    }

    #[test]
    fn model_matching_is_case_insensitive_and_prefix_tolerant() {
        assert_eq!(model_limits("HF-Seedance-2.5-1080p").fixed_duration_seconds, Some(30));
        assert_eq!(model_limits("seedance-v2.5-1080p").max_reference_images, 9);
        assert_eq!(model_limits("minimax-h3-pro-720p").max_reference_images, 9);
    }

    #[test]
    fn unknown_model_keeps_permissive_defaults() {
        let limits = model_limits("some-other-video-model");
        assert_eq!(limits.max_reference_images, 30);
        assert_eq!(limits.fixed_duration_seconds, None);
        assert!(limits.supports_reference_audio);
        assert!(limits.supports_reference_video);
    }

    #[test]
    fn pixel_size_maps_documented_ratios() {
        assert_eq!(pixel_size_of("16:9"), Some("1280x720"));
        assert_eq!(pixel_size_of("9:16"), Some("720x1280"));
        assert_eq!(pixel_size_of("1:1"), Some("1024x1024"));
        // 未覆盖的比例只发 ratio, 不猜 size。
        assert_eq!(pixel_size_of("adaptive"), None);
    }

    fn request_with_extras(
        extra_params: Option<std::collections::HashMap<String, Value>>,
    ) -> GenerateVideoRequest {
        GenerateVideoRequest {
            prompt: String::new(),
            model: "wgspai/seedance2.5".into(),
            duration: 10,
            aspect_ratio: "16:9".into(),
            video_resolution: None,
            image_mode: None,
            reference_images: None,
            reference_audio: None,
            extra_params,
        }
    }

    #[test]
    fn image_bed_url_strips_api_subdomain() {
        let request = request_with_extras(None);
        assert_eq!(
            image_bed_upload_url("https://api.wgspai.cn", &request),
            "https://wgspai.cn/image-bed/api/upload"
        );
        // 不带 api. 前缀的写法同样成立, 末尾斜杠不影响结果。
        assert_eq!(
            image_bed_upload_url("https://wgspai.cn/", &request),
            "https://wgspai.cn/image-bed/api/upload"
        );
    }

    #[test]
    fn configured_upload_url_wins() {
        let mut params = std::collections::HashMap::new();
        params.insert(
            "reference_asset_upload_url".to_string(),
            serde_json::json!("https://mirror.example.com/upload"),
        );
        let request = request_with_extras(Some(params));
        assert_eq!(
            image_bed_upload_url("https://api.wgspai.cn", &request),
            "https://mirror.example.com/upload"
        );
    }
}
