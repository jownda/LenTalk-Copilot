//! RunningHub 标准模型 API 协议(runninghub.cn / runninghub.ai)。
//!
//! ## 与其它协议的根本区别
//!
//! RunningHub 的视频模型**不是一个固定端点 + 一堆字段**, 而是
//! `POST /openapi/v2/{endpoint}` —— `{endpoint}` 本身就是模型
//! (如 `kling-v3.0-pro/image-to-video`), **每个端点的参数 schema 都不一样**:
//!
//! - 参考图字段: 全能视频S 是 `imageUrl`, 可灵 / 万相 / Seedance 是
//!   `firstImageUrl` + `lastImageUrl`, Seedance 2.0 是 `firstFrameUrl` +
//!   `lastFrameUrl`;
//! - 画幅字段: 多数是 `aspectRatio`, Seedance 2.0 是 `ratio`, 全能视频S 官方版
//!   是 `size`(收 `720x1280` 这种像素串);
//! - 还有一批**必填但不由用户驱动**的参数(可灵的 `sound` / `shotType`,
//!   海螺的 `enablePromptExpansion`, Vidu 的 `style` / `audio`), 类型也不统一
//!   (`sound` 在可灵 2.6 上是 LIST 字符串 `"true"`, 在 3.0 上是 BOOLEAN `true`)。
//!
//! 所以协议层**刻意不认识任何具体模型**: 字段名、选项枚举、必填默认值全部由前端
//! `runningHubProtocol.ts` 通过 `extra_params.runninghub_video` 传进来, 本模块只做
//! 「按说明装填 + 提交 + 轮询」。新增模型只改前端那一份目录。
//!
//! 只有 `extra_params` 缺失时(老节点 / 其它入口)才回落到一份保守默认映射。
//!
//! ## 接口形状(已实测)
//!
//! - 提交: `POST {base}/openapi/v2/{endpoint}`, body 为该端点的参数字典,
//!   `Authorization: Bearer <key>`。
//! - 轮询: `POST {base}/openapi/v2/query`, body `{"taskId": "..."}`(**不是 GET**)。
//! - 上传: `POST {base}/openapi/v2/media/upload/binary`, multipart 字段 `file`,
//!   成功体 `{"code": 0, "data": {"download_url": "..."}}`; 失败时 HTTP 仍可能
//!   是 200 而 `code != 0`。
//! - 任务信封(提交与查询共用):
//!   `{"taskId", "status", "errorCode", "errorMessage", "results", "clientId"}`,
//!   `status: "SUCCESS"` 时 `results[].url` 为成片地址。
//!
//! ## 为什么必须有 `envelope_error`
//!
//! RunningHub 对**未知端点 / 参数错误**回的是 `HTTP 200` + `errorCode: "1001"`
//! + `errorMessage: "Invalid URL, ..."`, 而 `status` 是空串。通用 `classify` 只认
//! 状态词与 `error` 系键, 认不出 `errorCode` —— 任务会被一直当成"还在跑"直到轮询
//! 窗口耗尽, 正是本项目最怕的「平台照跑照计费、成片永远收不回」。
//! 提交阶段更危险: 错误信封里 `taskId` 是空串, 直接交给 `submission_from_payload`
//! 会落库一个空任务号, 之后每一轮查询都必然失败。

use serde_json::{Map, Value};

use crate::ai::error::AIError;
use crate::ai::{
    GenerateVideoRequest, ProviderTaskHandle, ProviderTaskPollResult, ProviderTaskSubmission,
};

use super::assets::{
    extract_asset_url, resolve_reference_asset, truncate, upload_reference_asset_multipart,
};
use super::{
    classify, describe_reqwest_error, http_error, meta_string, submission_from_payload, PollContext,
    SubmitContext,
};

/// 与前端 `runningHubProtocol.ts` 的 `RUNNINGHUB_VIDEO_TRANSPORT` 必须一致。
pub const TRANSPORT: &str = "runninghub-model";
const PLATFORM_LABEL: &str = "RunningHub";
/// 站点 API 前缀。Base URL 已由 openai_compat 去掉结尾斜杠与 `/v1`。
const API_PREFIX: &str = "/openapi/v2";
const QUERY_PATH: &str = "/openapi/v2/query";
const UPLOAD_PATH: &str = "/openapi/v2/media/upload/binary";
/// 参考图上限: 首尾帧最多 2 张, 普通图生视频 1 张。
const MAX_REFERENCE_IMAGES: usize = 2;

/// 前端注入的装填说明(`extra_params.runninghub_video`)。
#[derive(Debug, Default, Clone)]
struct VideoSpec {
    endpoint: String,
    prompt: Option<String>,
    image: Option<String>,
    last_image: Option<String>,
    image_list: Option<String>,
    video: Option<String>,
    video_list: Option<String>,
    audio: Option<String>,
    audio_list: Option<String>,
    negative_prompt: Option<String>,
    duration: Option<String>,
    /// `"string"`(LIST 型, 平台收字符串) / `"number"`(INT 型)。
    duration_type: String,
    ratio: Option<String>,
    /// `"ratio"` / `"size"`。
    ratio_kind: String,
    resolution: Option<String>,
    durations: Vec<i64>,
    ratios: Vec<String>,
    size_options: Vec<String>,
    resolutions: Vec<String>,
    max_images: usize,
    max_videos: usize,
    max_audios: usize,
    defaults: Map<String, Value>,
}

fn opt_string(map: &Map<String, Value>, key: &str) -> Option<String> {
    map.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    value
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
        .unwrap_or_default()
}

fn number_list(value: Option<&Value>) -> Vec<i64> {
    value
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_i64).collect())
        .unwrap_or_default()
}

/// 从 `extra_params.runninghub_video` 读装填说明; 缺失时回落到保守默认。
fn spec_of(request: &GenerateVideoRequest) -> VideoSpec {
    let raw = request
        .extra_params
        .as_ref()
        .and_then(|params| params.get("runninghub_video"))
        .and_then(Value::as_object);

    let Some(raw) = raw else {
        // 回落: 只带最通用的字段名。这不是"猜模型", 而是让没有注入说明的老入口
        // 仍然能发出一个形状合理的请求 —— 能不能被平台接受由平台自己判定。
        return VideoSpec {
            endpoint: String::new(),
            prompt: Some("prompt".to_string()),
            image: Some("imageUrl".to_string()),
            last_image: Some("lastImageUrl".to_string()),
            negative_prompt: Some("negativePrompt".to_string()),
            duration: Some("duration".to_string()),
            duration_type: "string".to_string(),
            ratio: Some("aspectRatio".to_string()),
            ratio_kind: "ratio".to_string(),
            resolution: Some("resolution".to_string()),
            max_images: MAX_REFERENCE_IMAGES,
            max_videos: 0,
            max_audios: 0,
            ..VideoSpec::default()
        };
    };

    let fields = raw.get("fields").and_then(Value::as_object);
    let fields = fields.unwrap_or(&Map::new()).clone();
    VideoSpec {
        endpoint: opt_string(raw, "endpoint").unwrap_or_default(),
        prompt: opt_string(&fields, "prompt"),
        image: opt_string(&fields, "image"),
        last_image: opt_string(&fields, "lastImage"),
        image_list: opt_string(&fields, "imageList"),
        video: opt_string(&fields, "video"),
        video_list: opt_string(&fields, "videoList"),
        audio: opt_string(&fields, "audio"),
        audio_list: opt_string(&fields, "audioList"),
        negative_prompt: opt_string(&fields, "negativePrompt"),
        duration: opt_string(&fields, "duration"),
        duration_type: opt_string(raw, "durationType").unwrap_or_else(|| "string".to_string()),
        ratio: opt_string(&fields, "ratio"),
        ratio_kind: opt_string(&fields, "ratioKind").unwrap_or_else(|| "ratio".to_string()),
        resolution: opt_string(&fields, "resolution"),
        durations: number_list(raw.get("durations")),
        ratios: string_list(raw.get("ratios")),
        size_options: string_list(raw.get("sizeOptions")),
        resolutions: string_list(raw.get("resolutions")),
        max_images: raw
            .get("maxImages")
            .and_then(Value::as_u64)
            .unwrap_or(30) as usize,
        max_videos: raw
            .get("maxVideos")
            .and_then(Value::as_u64)
            .unwrap_or(10) as usize,
        max_audios: raw
            .get("maxAudios")
            .and_then(Value::as_u64)
            .unwrap_or(10) as usize,
        defaults: raw
            .get("defaults")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default(),
    }
}

/// `"16:9"` / `"1280x720"` / `"1280*720"` → 宽高比数值。
fn ratio_value(text: &str) -> Option<f64> {
    let normalized = text.trim().replace('×', "x");
    let (left, right) = normalized
        .split_once(['x', '*', ':'])
        .or_else(|| normalized.split_once('/'))?;
    let width: f64 = left.trim().parse().ok()?;
    let height: f64 = right.trim().parse().ok()?;
    if !width.is_finite() || !height.is_finite() || height == 0.0 {
        return None;
    }
    Some(width / height)
}

/// 时长吸附: 有枚举就取最近的(同距取较小档), 无枚举则按 1~30 收敛。
fn snap_duration(durations: &[i64], requested: u32) -> i64 {
    let wanted = i64::from(requested);
    if durations.is_empty() {
        return wanted.clamp(1, 30);
    }
    let mut best = durations[0];
    for candidate in durations {
        let distance = (*candidate - wanted).abs();
        let best_distance = (best - wanted).abs();
        if distance < best_distance || (distance == best_distance && *candidate < best) {
            best = *candidate;
        }
    }
    best
}

/// 画幅吸附。`size` 型端点要把比例折成官方像素枚举里的那一档。
fn snap_ratio(spec: &VideoSpec, requested: &str) -> Option<String> {
    let wanted = requested.trim();
    if wanted.is_empty() {
        return None;
    }
    // 精确命中(大小写不敏感)优先。
    if let Some(exact) = spec
        .ratios
        .iter()
        .find(|item| item.eq_ignore_ascii_case(wanted))
    {
        if spec.ratio_kind == "size" {
            return pick_size(spec, wanted);
        }
        return Some(exact.clone());
    }
    if spec.ratio_kind == "size" {
        return pick_size(spec, wanted);
    }
    let target = ratio_value(wanted)?;
    let mut best: Option<&String> = None;
    let mut best_distance = f64::INFINITY;
    for candidate in &spec.ratios {
        let Some(value) = ratio_value(candidate) else {
            continue;
        };
        let distance = (value - target).abs();
        if distance < best_distance {
            best = Some(candidate);
            best_distance = distance;
        }
    }
    best.cloned()
}

/// 比例 → 官方像素串(就近选宽高比)。
fn pick_size(spec: &VideoSpec, requested: &str) -> Option<String> {
    let target = ratio_value(requested)?;
    let mut best: Option<&String> = None;
    let mut best_distance = f64::INFINITY;
    for candidate in &spec.size_options {
        let Some(value) = ratio_value(candidate) else {
            continue;
        };
        let distance = (value - target).abs();
        if distance < best_distance {
            best = Some(candidate);
            best_distance = distance;
        }
    }
    best.cloned().or_else(|| spec.size_options.first().cloned())
}

/// 分辨率吸附: 大小写不敏感精确命中优先(万相是 `720P`), 否则回落官方首档。
fn snap_resolution(spec: &VideoSpec, requested: &str) -> Option<String> {
    let wanted = requested.trim();
    if wanted.is_empty() || spec.resolutions.is_empty() {
        return None;
    }
    spec.resolutions
        .iter()
        .find(|item| item.eq_ignore_ascii_case(wanted))
        .cloned()
        .or_else(|| spec.resolutions.first().cloned())
}

/// 按装填说明构造请求体。
///
/// **schema 里没有的键一律不发** —— RunningHub 对陌生字段回 `PARAMS_INVALID`,
/// 多发一个键等于整个任务提交失败。
fn build_body(
    spec: &VideoSpec,
    request: &GenerateVideoRequest,
    images: &[String],
    videos: &[String],
    audios: &[String],
) -> Value {
    // 先铺官方必填的固定参数(sound / shotType / enablePromptExpansion …), 缺了会被拒。
    let mut body = spec.defaults.clone();

    if let Some(key) = spec.prompt.as_deref() {
        // prompt 多数端点必填: 即使为空也占位, 让平台用自己的默认提示词,
        // 而不是由我们发一个缺字段的请求。
        body.insert(key.to_string(), Value::String(request.prompt.clone()));
    }
    if let Some(key) = spec.negative_prompt.as_deref() {
        let negative = request
            .extra_params
            .as_ref()
            .and_then(|params| params.get("negative_prompt"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if let Some(negative) = negative {
            body.insert(key.to_string(), Value::String(negative.to_string()));
        }
    }
    if let Some(key) = spec.image.as_deref() {
        if let Some(first) = images.first() {
            body.insert(key.to_string(), Value::String(first.clone()));
        }
    }
    if let Some(key) = spec.last_image.as_deref() {
        if let Some(last) = images.get(1) {
            body.insert(key.to_string(), Value::String(last.clone()));
        }
    }
    if let Some(key) = spec.image_list.as_deref() {
        if !images.is_empty() {
            body.insert(
                key.to_string(),
                Value::Array(
                    images
                        .iter()
                        .take(spec.max_images)
                        .cloned()
                        .map(Value::String)
                        .collect(),
                ),
            );
        }
    }
    if let Some(key) = spec.video.as_deref() {
        if let Some(first) = videos.first() {
            body.insert(key.to_string(), Value::String(first.clone()));
        }
    }
    if let Some(key) = spec.video_list.as_deref() {
        if !videos.is_empty() {
            body.insert(
                key.to_string(),
                Value::Array(
                    videos
                        .iter()
                        .take(spec.max_videos)
                        .cloned()
                        .map(Value::String)
                        .collect(),
                ),
            );
        }
    }
    if let Some(key) = spec.audio.as_deref() {
        if let Some(first) = audios.first() {
            body.insert(key.to_string(), Value::String(first.clone()));
        }
    }
    if let Some(key) = spec.audio_list.as_deref() {
        if !audios.is_empty() {
            body.insert(
                key.to_string(),
                Value::Array(
                    audios
                        .iter()
                        .take(spec.max_audios)
                        .cloned()
                        .map(Value::String)
                        .collect(),
                ),
            );
        }
    }
    if let Some(key) = spec.duration.as_deref() {
        let snapped = snap_duration(&spec.durations, request.duration);
        let value = if spec.duration_type == "number" {
            Value::Number(snapped.into())
        } else {
            Value::String(snapped.to_string())
        };
        body.insert(key.to_string(), value);
    }
    if let Some(key) = spec.ratio.as_deref() {
        // 空串由 `snap_ratio` 内部挡掉(返回 None), 这里不必额外分支。
        if let Some(snapped) = snap_ratio(spec, &request.aspect_ratio) {
            body.insert(key.to_string(), Value::String(snapped));
        }
    }
    if let (Some(key), Some(resolution)) =
        (spec.resolution.as_deref(), request.video_resolution.as_deref())
    {
        if let Some(snapped) = snap_resolution(spec, resolution) {
            body.insert(key.to_string(), Value::String(snapped));
        }
    }

    Value::Object(body)
}

/// 把 `{base}/openapi/v2/{endpoint}` 拼成绝对地址, 并容忍用户把 Base URL 填到
/// `/openapi/v2` 这一层(或填了 `/v1` —— openai_compat 已剥掉 `/v1`)。
fn submit_url(ctx: &SubmitContext, endpoint: &str) -> String {
    let base = ctx.base_url.trim_end_matches('/');
    let base = base.strip_suffix(API_PREFIX).unwrap_or(base);
    let endpoint = endpoint.trim_start_matches('/');
    format!("{}{}/{}", base, API_PREFIX, endpoint)
}

fn abs_url(ctx: &SubmitContext, path: &str) -> String {
    let base = ctx.base_url.trim_end_matches('/');
    let base = base.strip_suffix(API_PREFIX).unwrap_or(base);
    format!("{}{}", base, path)
}

/// RunningHub 的错误信封判定。
///
/// 成功时 `errorCode` 是空串 / 不存在; 失败时形如
/// `{"errorCode":"1001","errorMessage":"Invalid URL, please check your link"}`,
/// 且 HTTP 状态码是 **200**。也兼容文档外可能的 `code` 字段。
fn envelope_error(payload: &Value) -> Option<String> {
    let object = payload.as_object()?;
    let reason = object
        .get("errorMessage")
        .or_else(|| object.get("msg"))
        .or_else(|| object.get("message"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    // 主判据: 文档口径的 `errorCode`。它出现即代表业务结果, 只有空串 / "0" 等
    // 成功写法才放过。
    if let Some(code) = object.get("errorCode") {
        let text = code_text(code)?;
        if text.is_empty() || is_success_code(&text) {
            return None;
        }
        return Some(reason.unwrap_or_else(|| format!("平台返回错误码 {}", text)));
    }

    // 兜底判据: `code`(上传接口用 `{"code":0,"data":{download_url}}`,
    // 失败时 `{"code":1000,"msg":"Unknown error"}`)。
    //
    // **必须同时给出错误消息才认** —— 提交 / 查询的成功信封里 `code` 不是我们的
    // 字段, 若平台顺手带一个无害的 `code:1`, 单看数字会把一个正在生成(且已计费)
    // 的任务直接判死。宁可漏判(继续轮询)也不误判。
    let code = object.get("code")?;
    let text = code_text(code)?;
    if text.is_empty() || is_success_code(&text) {
        return None;
    }
    reason
}

/// 错误码取成可比较的文本; 非数字 / 非字符串一律当作"不是错误码"。
fn code_text(code: &Value) -> Option<String> {
    match code {
        Value::Number(number) => Some(number.to_string()),
        Value::String(value) => Some(value.trim().to_string()),
        _ => None,
    }
}

fn is_success_code(text: &str) -> bool {
    matches!(
        text.to_ascii_uppercase().as_str(),
        "0" | "00" | "000" | "0000" | "200" | "SUCCESS" | "OK"
    )
}

/// 上传一张参考素材, 换成公网 URL。已是公网 URL 的直接透传
/// (与官方 CLI 的 `resolve_media` 一致 —— 它对 http(s) 输入不做二次上传)。
async fn upload_reference(
    ctx: &SubmitContext,
    source: &str,
    index: usize,
    label: &str,
) -> Result<String, AIError> {
    let asset = resolve_reference_asset(source, &format!("{} {}", PLATFORM_LABEL, label)).await?;
    let extension = match &asset {
        crate::ai::providers::video_protocols::assets::ReferenceAsset::Url(url) => {
            return Ok(url.clone())
        }
        crate::ai::providers::video_protocols::assets::ReferenceAsset::File { extension, .. } => {
            extension.clone()
        }
    };
    let filename = format!("runninghub-{}-{}.{}", label, index + 1, extension);
    let payload = upload_reference_asset_multipart(
        &ctx.client,
        &abs_url(ctx, UPLOAD_PATH),
        &ctx.api_key,
        &filename,
        &asset,
        PLATFORM_LABEL,
    )
    .await?;
    // 上传失败时 HTTP 也可能是 200, 真正的判据在 `code`。
    if let Some(reason) = envelope_error(&payload) {
        return Err(AIError::TaskFailed(format!(
            "{} {}上传失败: {}",
            PLATFORM_LABEL, label, reason
        )));
    }
    extract_asset_url(&payload).ok_or_else(|| {
        AIError::TaskFailed(format!(
            "{} {}上传响应中未找到公网 URL: {}",
            PLATFORM_LABEL,
            label,
            truncate(&payload.to_string(), 500)
        ))
    })
}

/// 从请求扩展字段取多媒体参考。视频节点会把上游视频素材放在这里，避免
/// 为 RunningHub 端点再增加一套持久化 DTO；模型 schema 决定最终是否消费它。
fn extra_string_array(request: &GenerateVideoRequest, key: &str, limit: usize) -> Vec<String> {
    request
        .extra_params
        .as_ref()
        .and_then(|params| params.get(key))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .take(limit)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// POST 一个 JSON 端点。错误语义与 `fetch_json` 对齐:
/// 4xx / 平台已给定论 → `TaskFailed`(确定性); 5xx / 408 / 429 → `Provider`(可重试)。
async fn post_json(
    client: &reqwest::Client,
    api_key: &str,
    url: &str,
    body: &Value,
    label: &str,
) -> Result<Value, AIError> {
    let response = client
        .post(url)
        .bearer_auth(api_key)
        .header("Accept-Encoding", "identity")
        .json(body)
        .send()
        .await
        .map_err(|error| {
            AIError::Provider(format!(
                "{} 请求失败(网络): {}",
                label,
                describe_reqwest_error(&error)
            ))
        })?;
    let status = response.status();
    let raw = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(http_error(label, status, &raw, url));
    }
    serde_json::from_str::<Value>(&raw).map_err(|_| {
        AIError::TaskFailed(format!(
            "{}返回了非 JSON 响应 ({}): {}",
            label,
            url,
            truncate(&raw, 300)
        ))
    })
}

pub async fn submit(
    ctx: &SubmitContext,
    request: &GenerateVideoRequest,
) -> Result<ProviderTaskSubmission, AIError> {
    let spec = spec_of(request);
    // 端点 ID = 模型名里第一段斜杠之后的全部(端点自己还带斜杠, 如
    // `kling-v3.0-pro/image-to-video`), 比 `extra_params` 更可信 —— 它一定存在。
    let endpoint = {
        let from_extra = request
            .extra_params
            .as_ref()
            .and_then(|params| params.get("runninghub_endpoint"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let from_model = request
            .model
            .split_once('/')
            .map(|(_, model)| model)
            .unwrap_or(request.model.as_str())
            .trim()
            .trim_start_matches('/')
            .to_string();
        if let Some(from_extra) = from_extra {
            from_extra.to_string()
        } else if spec.endpoint.is_empty() {
            from_model
        } else {
            spec.endpoint.clone()
        }
    };
    if endpoint.is_empty() {
        return Err(AIError::InvalidRequest(
            "RunningHub 请求缺少端点 ID(模型名格式应为 custom:<平台>/<端点>, 如 \
             custom:runninghub/kling-v3.0-pro/image-to-video)"
                .to_string(),
        ));
    }

    let is_first_last = request.image_mode.as_deref() == Some("first-last");
    let image_limit = if spec.image_list.is_some() {
        spec.max_images
    } else if spec.image.is_some() && spec.last_image.is_none() {
        1
    } else if spec.image.is_none() {
        0
    } else if is_first_last {
        2
    } else {
        MAX_REFERENCE_IMAGES
    };
    let raw_images: Vec<String> = if image_limit == 0 {
        Vec::new()
    } else {
        request
            .reference_images
            .clone()
            .unwrap_or_default()
            .into_iter()
            .filter(|source| !source.trim().is_empty())
            .take(image_limit)
            .collect()
    };

    let mut images = Vec::with_capacity(raw_images.len());
    for (index, source) in raw_images.iter().enumerate() {
        images.push(
            upload_reference(ctx, source, index, &format!("参考图{}", index + 1)).await?,
        );
    }

    let raw_videos = if spec.video.is_some() || spec.video_list.is_some() {
        extra_string_array(request, "reference_videos", spec.max_videos)
    } else {
        Vec::new()
    };
    let raw_audios = if spec.audio.is_some() || spec.audio_list.is_some() {
        request
            .reference_audio
            .clone()
            .unwrap_or_default()
            .into_iter()
            .filter(|source| !source.trim().is_empty())
            .take(spec.max_audios)
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let mut videos = Vec::with_capacity(raw_videos.len());
    for (index, source) in raw_videos.iter().enumerate() {
        videos.push(upload_reference(ctx, source, images.len() + index, &format!("参考视频{}", index + 1)).await?);
    }
    let mut audios = Vec::with_capacity(raw_audios.len());
    for (index, source) in raw_audios.iter().enumerate() {
        audios.push(upload_reference(ctx, source, images.len() + videos.len() + index, &format!("参考音频{}", index + 1)).await?);
    }

    let body = build_body(&spec, request, &images, &videos, &audios);
    let url = submit_url(ctx, &endpoint);
    let payload = post_json(
        &ctx.client,
        &ctx.api_key,
        &url,
        &body,
        &format!("{} 视频提交", PLATFORM_LABEL),
    )
    .await?;

    // 必须在取 taskId 之前拦: 错误信封里的 taskId 是空串, 交给
    // `submission_from_payload` 会落库一个空任务号(之后每轮查询必失败)。
    if let Some(reason) = envelope_error(&payload) {
        return Err(AIError::TaskFailed(format!(
            "{} 视频提交失败(端点 {}): {}",
            PLATFORM_LABEL, endpoint, reason
        )));
    }

    // 查询地址在提交时算好并落库 —— 续查发生在任意进程/会话, 那时 extra_params 已不存在。
    let query_url = abs_url(ctx, QUERY_PATH);
    submission_from_payload(&payload, &ctx.provider_id, TRANSPORT, query_url, None)
}

pub async fn poll(
    ctx: &PollContext,
    metadata: &Map<String, Value>,
    handle: &ProviderTaskHandle,
) -> Result<ProviderTaskPollResult, AIError> {
    let query_url = meta_string(metadata, "query_url")
        .ok_or_else(|| AIError::InvalidRequest("RunningHub 任务缺少查询地址, 无法续查".into()))?;
    let body = serde_json::json!({ "taskId": handle.task_id });
    let payload = match post_json(
        &ctx.client,
        &ctx.api_key,
        query_url,
        &body,
        &format!("{} 任务查询", PLATFORM_LABEL),
    )
    .await
    {
        Ok(payload) => payload,
        Err(AIError::TaskFailed(reason)) => {
            // 4xx 这类确定性错误要**回 Failed 而不是 Err**: 上层把 Err 当成"临时故障"
            // 保持 running, 于是一个地址写错的任务会一直转圈到轮询窗口耗尽。
            return Ok(ProviderTaskPollResult::Failed(format!(
                "{} 任务查询失败: {}",
                PLATFORM_LABEL, reason
            )));
        }
        Err(other) => return Err(other),
    };

    // 业务错误包优先于通用归类: 这种响应的 `status` 是空串, 通用归类会判成"还在跑"。
    if let Some(reason) = envelope_error(&payload) {
        return Ok(ProviderTaskPollResult::Failed(format!(
            "{} 生成失败: {}",
            PLATFORM_LABEL, reason
        )));
    }
    let verdict = classify(&payload, handle);
    Ok(verdict)
}

/// 供 `openai_compat` 判定是否属于本协议。
///
/// transport 命中是主路径(前端 `injectCustomApiRequestMode` 已按平台配置注入)。
/// Base URL 兜底**只在 transport 为空时**生效 —— 否则用户显式把平台配成
/// `openai-video` 自定义路径时会被误抢。
pub fn matches(transport: &str, provider_base_url: &str, _provider_id: &str) -> bool {
    transport == TRANSPORT
        || (transport.is_empty() && host_is_runninghub(provider_base_url))
}

/// 只比对**主机名**: `runninghub.cn.evil.com` 这类伪装域名不该命中 ——
/// 命中意味着把 Bearer Key 发到别人的服务器。
fn host_is_runninghub(base_url: &str) -> bool {
    let trimmed = base_url.trim().to_ascii_lowercase();
    let without_scheme = trimmed
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed.as_str());
    let host = without_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default()
        .rsplit_once('@')
        .map(|(_, host)| host)
        .unwrap_or(without_scheme.split(['/', '?', '#']).next().unwrap_or_default());
    let host = host.split(':').next().unwrap_or_default();
    for domain in ["runninghub.cn", "runninghub.ai"] {
        if host == domain || host.ends_with(&format!(".{}", domain)) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(model: &str, duration: u32, ratio: &str) -> GenerateVideoRequest {
        GenerateVideoRequest {
            prompt: "一只猫".to_string(),
            model: model.to_string(),
            duration,
            aspect_ratio: ratio.to_string(),
            video_resolution: None,
            image_mode: None,
            reference_images: None,
            reference_audio: None,
            extra_params: None,
        }
    }

    fn spec_from_frontend(fields: Value, extra: Value) -> VideoSpec {
        let mut map = Map::new();
        map.insert("fields".to_string(), fields);
        if let Value::Object(rest) = extra {
            for (key, value) in rest {
                map.insert(key, value);
            }
        }
        let mut request = req("custom:runninghub/kling-v3.0-pro/image-to-video", 5, "16:9");
        let mut extras = std::collections::HashMap::new();
        extras.insert("runninghub_video".to_string(), Value::Object(map));
        request.extra_params = Some(extras);
        spec_of(&request)
    }

    #[test]
    fn submit_url_joins_prefix_without_duplicating_it() {
        let ctx = SubmitContext {
            client: reqwest::Client::new(),
            base_url: "https://www.runninghub.cn".to_string(),
            api_key: "k".to_string(),
            provider_id: "custom:runninghub".to_string(),
        };
        assert_eq!(
            submit_url(&ctx, "kling-v3.0-pro/image-to-video"),
            "https://www.runninghub.cn/openapi/v2/kling-v3.0-pro/image-to-video"
        );
        // 用户把 Base URL 填到 /openapi/v2 这一层也不会拼成 /openapi/v2/openapi/v2。
        let nested = SubmitContext {
            base_url: "https://www.runninghub.cn/openapi/v2".to_string(),
            ..SubmitContext {
                client: reqwest::Client::new(),
                base_url: String::new(),
                api_key: "k".to_string(),
                provider_id: "custom:runninghub".to_string(),
            }
        };
        assert_eq!(
            submit_url(&nested, "vidu/text-to-video-q3-pro"),
            "https://www.runninghub.cn/openapi/v2/vidu/text-to-video-q3-pro"
        );
        assert_eq!(
            abs_url(&ctx, QUERY_PATH),
            "https://www.runninghub.cn/openapi/v2/query"
        );
    }

    #[test]
    fn host_match_rejects_lookalike_domains() {
        assert!(host_is_runninghub("https://www.runninghub.cn"));
        assert!(host_is_runninghub("https://www.runninghub.ai"));
        assert!(host_is_runninghub("https://runninghub.cn"));
        assert!(host_is_runninghub("https://api.runninghub.cn:443/v1"));
        assert!(!host_is_runninghub("https://runninghub.cn.evil.com"));
        assert!(!host_is_runninghub("https://evil-runninghub.cn.attacker.io"));
        assert!(!host_is_runninghub("https://api.7tai.cc"));
    }

    #[test]
    fn matches_uses_transport_first_and_base_url_only_as_fallback() {
        assert!(matches(TRANSPORT, "https://api.7tai.cc", ""));
        assert!(matches("", "https://www.runninghub.cn", ""));
        // 用户显式配了别的协议时不该被抢。
        assert!(!matches("openai-video", "https://www.runninghub.cn", ""));
        assert!(!matches("", "https://www.runninghub.cn.evil.com", ""));
    }

    #[test]
    fn envelope_error_ignores_success_shapes() {
        assert!(envelope_error(&serde_json::json!({"taskId":"1","status":"SUCCESS","errorCode":""})).is_none());
        assert!(envelope_error(&serde_json::json!({"code":0,"data":{}})).is_none());
        assert!(envelope_error(&serde_json::json!({"code":"0000"})).is_none());
        assert!(envelope_error(&serde_json::json!({"taskId":"1","status":"RUNNING"})).is_none());
        // 关键边界: 提交 / 查询的成功信封里 `code` 不是我们的字段。平台顺手带一个
        // 无害的 `code:1` 时**不能**判成失败 —— 那会把一个正在生成、且已计费的
        // 付费任务直接判死。没有错误消息的 `code` 一律不采信。
        assert!(envelope_error(&serde_json::json!({
            "taskId": "abc", "status": "RUNNING", "code": 1, "clientId": "c"
        }))
        .is_none());
    }

    #[test]
    fn envelope_error_reads_real_failure_shape() {
        // 实机形状: HTTP 200 + 空 status + errorCode 1001。
        let reason = envelope_error(&serde_json::json!({
            "taskId": "",
            "status": "",
            "errorCode": "1001",
            "errorMessage": "Invalid URL, please check your link | 请求链接无效，请检查您的调用链接"
        }))
        .expect("must detect");
        assert!(reason.contains("Invalid URL"));

        let upload = envelope_error(&serde_json::json!({"code": 1000, "msg": "Unknown error"}))
            .expect("must detect");
        assert_eq!(upload, "Unknown error");
    }

    #[test]
    fn duration_snaps_to_official_options() {
        // 可灵 2.6 只有 5 / 10。
        assert_eq!(snap_duration(&[5, 10], 12), 10);
        assert_eq!(snap_duration(&[5, 10], 4), 5);
        assert_eq!(snap_duration(&[5, 10], 5), 5);
        // 连续枚举就近。
        assert_eq!(snap_duration(&[3, 4, 5, 6, 7], 6), 6);
        assert_eq!(snap_duration(&[3, 4, 5, 6, 7], 99), 7);
        // 无枚举(可灵 o3 的 INT)→ 按 1~30 收敛, 不凭空造档位。
        assert_eq!(snap_duration(&[], 7), 7);
        assert_eq!(snap_duration(&[], 0), 1);
        assert_eq!(snap_duration(&[], 999), 30);
    }

    #[test]
    fn duration_type_decides_string_or_number() {
        let spec = spec_from_frontend(
            serde_json::json!({"prompt": "prompt", "duration": "duration"}),
            serde_json::json!({"durationType": "number", "durations": [5]}),
        );
        let body = build_body(&spec, &req("custom:r/x", 5, ""), &[], &[], &[]);
        assert_eq!(body.get("duration"), Some(&Value::Number(5.into())));

        let spec = spec_from_frontend(
            serde_json::json!({"prompt": "prompt", "duration": "duration"}),
            serde_json::json!({"durationType": "string", "durations": [5]}),
        );
        let body = build_body(&spec, &req("custom:r/x", 5, ""), &[], &[], &[]);
        assert_eq!(body.get("duration"), Some(&Value::String("5".into())));
    }

    #[test]
    fn body_uses_injected_field_names_per_family() {
        // 可灵: firstImageUrl / lastImageUrl。
        let kling = spec_from_frontend(
            serde_json::json!({"prompt": "prompt", "image": "firstImageUrl", "lastImage": "lastImageUrl"}),
            serde_json::json!({}),
        );
        let body = build_body(
            &kling,
            &req("custom:r/kling-v3.0-pro/image-to-video", 5, ""),
            &["https://x/a.png".to_string(), "https://x/b.png".to_string()],
            &[],
            &[],
        );
        assert_eq!(body.get("firstImageUrl").unwrap(), "https://x/a.png");
        assert_eq!(body.get("lastImageUrl").unwrap(), "https://x/b.png");
        assert!(body.get("imageUrl").is_none());

        // Seedance 2.0: firstFrameUrl / lastFrameUrl。
        let spark = spec_from_frontend(
            serde_json::json!({"prompt": "prompt", "image": "firstFrameUrl", "lastImage": "lastFrameUrl"}),
            serde_json::json!({}),
        );
        let body = build_body(&spark, &req("custom:r/x", 5, ""), &["https://x/a.png".to_string()], &[], &[]);
        assert_eq!(body.get("firstFrameUrl").unwrap(), "https://x/a.png");
        assert!(body.get("lastFrameUrl").is_none());
    }

    #[test]
    fn body_never_sends_keys_outside_schema() {
        // 只有 prompt: 不应出现 image / duration / aspectRatio / resolution。
        let spec = spec_from_frontend(serde_json::json!({"prompt": "prompt"}), serde_json::json!({}));
        let mut request = req("custom:r/minimax/hailuo-02/t2v-pro", 10, "16:9");
        request.video_resolution = Some("1080p".to_string());
        let body = build_body(&spec, &request, &[], &[], &[]);
        let object = body.as_object().unwrap();
        assert_eq!(object.len(), 1);
        assert!(object.contains_key("prompt"));
    }

    #[test]
    fn body_carries_official_required_defaults() {
        let spec = spec_from_frontend(
            serde_json::json!({"prompt": "prompt"}),
            serde_json::json!({"defaults": {"sound": true, "shotType": "customize"}}),
        );
        let body = build_body(&spec, &req("custom:r/kling-v3.0-pro/text-to-video", 5, ""), &[], &[], &[]);
        assert_eq!(body.get("sound").unwrap(), &Value::Bool(true));
        assert_eq!(body.get("shotType").unwrap(), "customize");
    }

    #[test]
    fn body_supports_multimodal_array_fields() {
        let spec = spec_from_frontend(
            serde_json::json!({
                "prompt": "prompt",
                "imageList": "imageUrls",
                "videoList": "videoUrls",
                "audioList": "audioUrls"
            }),
            serde_json::json!({
                "maxImages": 2,
                "maxVideos": 1,
                "maxAudios": 1
            }),
        );
        let body = build_body(
            &spec,
            &req("custom:r/multimodal-video", 5, ""),
            &["https://x/1.png".into(), "https://x/2.png".into(), "https://x/3.png".into()],
            &["https://x/a.mp4".into(), "https://x/b.mp4".into()],
            &["https://x/a.mp3".into()],
        );
        assert_eq!(body["imageUrls"], serde_json::json!(["https://x/1.png", "https://x/2.png"]));
        assert_eq!(body["videoUrls"], serde_json::json!(["https://x/a.mp4"]));
        assert_eq!(body["audioUrls"], serde_json::json!(["https://x/a.mp3"]));
    }

    #[test]
    fn ratio_snaps_and_maps_to_size_pixels() {
        let ratio_spec = spec_from_frontend(
            serde_json::json!({"prompt": "prompt", "ratio": "aspectRatio", "ratioKind": "ratio"}),
            serde_json::json!({"ratios": ["1:1", "16:9", "9:16"]}),
        );
        assert_eq!(snap_ratio(&ratio_spec, "16:9").as_deref(), Some("16:9"));
        assert_eq!(snap_ratio(&ratio_spec, "4:3").as_deref(), Some("1:1"));
        assert_eq!(snap_ratio(&ratio_spec, "21:9").as_deref(), Some("16:9"));

        let size_spec = spec_from_frontend(
            // `ratioKind` 属于 `fields`(前端 `RunningHubVideoFields` 的成员),
            // 放在顶层会被忽略 —— 那样横屏请求会静默回落首档, 变成竖屏。
            serde_json::json!({"prompt": "prompt", "ratio": "size", "ratioKind": "size"}),
            serde_json::json!({
                "ratioKind": "size",
                "ratios": ["9:16", "16:9"],
                "sizeOptions": ["720x1280", "1280x720"]
            }),
        );
        // 比例标签必须折成像素串, 而且横屏不能变成竖屏。
        assert_eq!(snap_ratio(&size_spec, "16:9").as_deref(), Some("1280x720"));
        assert_eq!(snap_ratio(&size_spec, "9:16").as_deref(), Some("720x1280"));
        assert_eq!(snap_ratio(&size_spec, "4:3").as_deref(), Some("1280x720"));
    }

    #[test]
    fn resolution_snaps_case_insensitively() {
        let spec = spec_from_frontend(
            serde_json::json!({"prompt": "prompt", "resolution": "resolution"}),
            serde_json::json!({"resolutions": ["720P", "1080P"]}),
        );
        assert_eq!(snap_resolution(&spec, "1080p").as_deref(), Some("1080P"));
        assert_eq!(snap_resolution(&spec, "8k").as_deref(), Some("720P"));

        let none = spec_from_frontend(serde_json::json!({"prompt": "prompt"}), serde_json::json!({}));
        assert!(snap_resolution(&none, "720p").is_none());
    }

    #[test]
    fn falls_back_to_conservative_mapping_without_injection() {
        let request = req("custom:runninghub/kling-v3.0-pro/image-to-video", 5, "16:9");
        let spec = spec_of(&request);
        assert_eq!(spec.prompt.as_deref(), Some("prompt"));
        assert_eq!(spec.image.as_deref(), Some("imageUrl"));
        assert_eq!(spec.duration.as_deref(), Some("duration"));
        // 没有注入说明时不给任何枚举 → 不做吸附, 原样透传。
        assert!(spec.durations.is_empty());
        assert!(spec.ratios.is_empty());
    }
}
