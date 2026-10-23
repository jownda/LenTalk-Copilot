// ---------------------------------------------------------------------------
// Dramaya 视频协议(video.dramaya.us)
//
// 与 Sub2API 同族, 但字段口径不同, 因此单独一个模块而不是往 sub2api.rs 里塞分支:
//   - 提交 `POST /v1/videos`, 轮询 `GET /v1/videos/{task_id}`, 成片 `GET .../content`;
//   - 时长字段是 `seconds`(兼容 `duration`, 两者同传必须一致 —— 只发一种);
//   - 画幅字段是 `aspect_ratio`(sub2api 用的是 `ratio`), 不认 `camera_movement`;
//   - 参考图两条路: 公网 URL 进 `image_urls`, 本地文件先传 `POST /v1/files` 换
//     `image_id` 再放进 `image_ids`(文档明确「不得同一素材两套字段重复传」);
//   - `Idempotency-Key` 必带, 同键不同正文会回 409;
//   - completed 之后 `data[].url` / `video_url` 是**签名地址**, 下载时**不能**带
//     Bearer(带了反而签名不匹配), 这一点与其它协议相反;
//   - 状态枚举是小写(queued/running/completed/failed/cancelled/expired),
//     统一交给 `extract::task_status` 转大写后再判。
// ---------------------------------------------------------------------------
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};

use crate::ai::error::AIError;
use crate::ai::providers::video_protocols::assets::{resolve_reference_asset, truncate, ReferenceAsset};
use crate::ai::providers::video_protocols::extract;
use crate::ai::providers::video_protocols::video_extension_hint;
use crate::ai::providers::video_protocols::{
    describe_reqwest_error, http_error, meta_string, persist_media_bytes, queued, string_param, PollContext,
    SubmitContext,
};
use crate::ai::{GenerateVideoRequest, ProviderTaskHandle, ProviderTaskPollResult, ProviderTaskSubmission};

pub const TRANSPORT: &str = "dramaya-video";
const PLATFORM_LABEL: &str = "Dramaya";
const SUBMIT_PATH: &str = "/v1/videos";
const UPLOAD_PATH: &str = "/v1/files";
const RESERVATION_PATH: &str = "/v1/input-reservations";

fn host_of(value: &str) -> Option<&str> {
    let rest = value.split_once("://").map(|(_, rest)| rest).unwrap_or(value);
    let host_port = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = host_port.split('@').next_back().unwrap_or(host_port);
    (!host.is_empty()).then(|| host.split(':').next().unwrap_or(host))
}

/// 只认正典域名 `video.dramaya.us`。图片是另一个域名(img.dramaya.us)且是另一套
/// 协议, 不能在这里顺带命中 —— 否则图片请求会被当成视频提交出去。
pub fn is_dramaya_base_url(base_url: &str) -> bool {
    host_of(base_url.trim())
        .map(|host| host.eq_ignore_ascii_case("video.dramaya.us"))
        .unwrap_or(false)
}

/// `custom:<id>/<model>` → `<model>`; 平台只认精确型号 ID。
fn api_model(request: &GenerateVideoRequest) -> String {
    request
        .model
        .split_once('/')
        .map(|(_, model)| model.to_string())
        .unwrap_or_else(|| request.model.clone())
}

fn idempotency_key(request: &GenerateVideoRequest) -> String {
    let configured = string_param(request, "client_job_id");
    if !configured.is_empty() {
        return configured;
    }
    format!("lentalk-video-{}", uuid::Uuid::new_v4())
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

/// 申请上传容量(文档要求上传带 `X-Media-Input-Reservation-ID`)。
///
/// 这一步是**尽力而为**: 有的分组直接放行裸上传, 预约接口未必对所有 Key 开放。
/// 拿到 granted 就带头发, 拿不到就不带 —— 不能因为预约失败就把参考图整个扔掉。
async fn request_reservation(ctx: &SubmitContext, bytes_len: usize, mime_type: &str) -> Option<String> {
    let url = format!("{}{}", ctx.base_url.trim_end_matches('/'), RESERVATION_PATH);
    let response = ctx
        .client
        .post(&url)
        .bearer_auth(&ctx.api_key)
        .header("Accept-Encoding", "identity")
        .json(&json!({ "bytes": bytes_len, "mime_type": mime_type }))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let payload: Value = response.json().await.ok()?;
    ["id", "reservation_id", "reservationId"]
        .iter()
        .find_map(|key| payload.get(*key).and_then(Value::as_str))
        .map(str::to_string)
        // 202 queued 时可能只回状态不回 id; 这种情况直接放弃预约。
        .filter(|value| !value.trim().is_empty())
}

/// 本地上传后的两种可用表示。
///
/// 平台的参数白名单是**按模型发布的**: 有的型号只声明 `image_urls`, 传 `image_ids`
/// 会被直接拒(`unsupported published model parameter "image_ids"`)。所以上传后
/// **优先拿公网 `url` 走 `*_urls` 字段**, 只有平台没回 url 时才退回 id 形式。
struct UploadedReference {
    file_id: Option<String>,
    url: Option<String>,
}

/// 本地素材 → `/v1/files` → `file_id` / 公网 `url`。
async fn upload_reference(
    ctx: &SubmitContext,
    source: &str,
    index: usize,
    kind: &str,
) -> Result<UploadedReference, AIError> {
    let label = format!("{} 参考{} {}", PLATFORM_LABEL, kind, index + 1);
    let asset = resolve_reference_asset(source, &label).await?;
    let (bytes, mime_type) = match asset {
        // 本来就是公网地址: 不需要上传, 直接当 url 用。
        ReferenceAsset::Url(url) => {
            return Ok(UploadedReference { file_id: None, url: Some(url) });
        }
        ReferenceAsset::File { bytes, mime_type, .. } => (bytes, mime_type),
    };

    let reservation = request_reservation(ctx, bytes.len(), &mime_type).await;
    let upload_url = format!("{}{}", ctx.base_url.trim_end_matches('/'), UPLOAD_PATH);
    let mut request = ctx
        .client
        .post(&upload_url)
        .bearer_auth(&ctx.api_key)
        .header("Accept-Encoding", "identity")
        .json(&json!({
            "file_b64": STANDARD.encode(&bytes),
            "mime_type": mime_type,
        }));
    if let Some(id) = reservation.as_deref() {
        request = request.header("X-Media-Input-Reservation-ID", id);
    }

    let response = request.send().await.map_err(|error| {
        AIError::Provider(format!("{} 上传失败(网络): {}", label, describe_reqwest_error(&error)))
    })?;
    let status = response.status();
    let raw = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(http_error(&format!("{} 上传失败", label), status, &raw, &upload_url));
    }
    let payload: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    let file_id = ["file_id", "image_id", "id", "fileId", "imageId"]
        .iter()
        .find_map(|key| payload.get(*key).and_then(Value::as_str))
        .map(str::to_string);
    let url = ["url", "image_url", "file_url", "download_url"]
        .iter()
        .find_map(|key| payload.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| value.starts_with("http://") || value.starts_with("https://"))
        .map(str::to_string);
    if file_id.is_none() && url.is_none() {
        return Err(AIError::TaskFailed(format!(
            "{} 上传响应中既没有 file_id 也没有公网 url: {}",
            label,
            truncate(&payload.to_string(), 500)
        )));
    }
    Ok(UploadedReference { file_id, url })
}

/// 同族网关里, 同一个参数在不同型号上可能用**两套命名**。被点名时优先改名重试,
/// 改名也不认才删。只删不换会让时长/画幅直接丢失(平台退默认值), 用户看到的是
/// 「选的能力被吞掉了」。
fn parameter_alias(param: &str) -> Option<&'static str> {
    match param {
        "seconds" => Some("duration"),
        "duration" => Some("seconds"),
        "aspect_ratio" => Some("ratio"),
        "ratio" => Some("aspect_ratio"),
        "image_urls" => Some("images"),
        "images" => Some("image_urls"),
        "reference_audio_urls" => Some("audio_urls"),
        "audio_urls" => Some("reference_audio_urls"),
        _ => None,
    }
}

/// 从 400 响应里抠出被拒的参数名:
/// `unsupported published model parameter "image_ids"`。
fn unsupported_parameter(raw: &str) -> Option<String> {
    let marker = "unsupported published model parameter";
    let index = raw.to_ascii_lowercase().find(marker)?;
    let rest = &raw[index..];
    let quoted = rest.split('"').nth(1).or_else(|| rest.split('\'').nth(1))?;
    // 报文常常是 JSON: `"message":"... parameter \"seconds\""`。按 `"` 切出来的片段
    // 会带一个尾随反斜杠(`seconds\`), 直接拿去比对 body 的键永远不匹配 —— 于是重试
    // 逻辑静默失效(线上表现就是「明明加了自愈还是同一个 400」)。这里只保留标识符字符。
    let name: String = quoted
        .chars()
        .skip_while(|ch| !(ch.is_alphanumeric() || *ch == '_'))
        .take_while(|ch| ch.is_alphanumeric() || *ch == '_' || *ch == '-' || *ch == '.')
        .collect();
    (!name.is_empty()).then_some(name)
}

pub async fn submit(ctx: &SubmitContext, request: &GenerateVideoRequest) -> Result<ProviderTaskSubmission, AIError> {
    let model = api_model(request);
    let is_first_last = request.image_mode.as_deref() == Some("first-last");

    let mut image_urls: Vec<String> = Vec::new();
    let mut image_ids: Vec<String> = Vec::new();
    let sources: Vec<String> = request
        .reference_images
        .clone()
        .unwrap_or_default()
        .into_iter()
        .filter(|source| !source.trim().is_empty())
        .collect();
    // 首尾帧模式最多两张(文档: 尾帧必须同时给首帧), 其余按普通参考图提交。
    let sources: Vec<String> = if is_first_last { sources.into_iter().take(2).collect() } else { sources };

    for (index, source) in sources.iter().enumerate() {
        if is_public_url(source) {
            image_urls.push(source.trim().to_string());
            continue;
        }
        // 本地文件: 先上传。**能用 url 就不用 id** —— `image_ids` 不是每个型号都
        // 发布过的参数, 拿它提交会被平台以 400 拒掉(线上事故即此)。
        let uploaded = upload_reference(ctx, source, index, "图").await?;
        match uploaded.url {
            Some(url) => image_urls.push(url),
            None => image_ids.extend(uploaded.file_id),
        }
    }

    let mut body = serde_json::Map::new();
    body.insert("model".into(), Value::String(model));
    body.insert("prompt".into(), Value::String(request.prompt.clone()));
    body.insert("seconds".into(), json!(request.duration.max(1)));
    let ratio = request.aspect_ratio.trim();
    if !ratio.is_empty() {
        body.insert("aspect_ratio".into(), Value::String(ratio.to_string()));
    }
    if let Some(resolution) = request
        .video_resolution
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        body.insert("resolution".into(), Value::String(resolution.to_string()));
    }
    if !image_urls.is_empty() {
        body.insert("image_urls".into(), json!(image_urls));
    }
    if !image_ids.is_empty() {
        body.insert("image_ids".into(), json!(image_ids));
    }

    // 参考音频: 文档字段是 reference_audio_urls / reference_audio_ids。
    // 本地音频同样走 /v1/files 换 file_id —— 画布上的音频基本都是本地文件。
    let mut audio_urls: Vec<String> = Vec::new();
    let mut audio_ids: Vec<String> = Vec::new();
    for (index, source) in request
        .reference_audio
        .clone()
        .unwrap_or_default()
        .into_iter()
        .filter(|source| !source.trim().is_empty())
        .enumerate()
    {
        if is_public_url(&source) {
            audio_urls.push(source.trim().to_string());
            continue;
        }
        if let Ok(uploaded) = upload_reference(ctx, &source, index, "音频").await {
            match uploaded.url {
                Some(url) => audio_urls.push(url),
                None => audio_ids.extend(uploaded.file_id),
            }
        }
    }
    if !audio_urls.is_empty() {
        body.insert("reference_audio_urls".into(), json!(audio_urls));
    }
    if !audio_ids.is_empty() {
        body.insert("reference_audio_ids".into(), json!(audio_ids));
    }

    let submit_url = format!("{}{}", ctx.base_url.trim_end_matches('/'), SUBMIT_PATH);
    let base_key = idempotency_key(request);
    // 每个型号**发布过的参数集不一样**, 平台会拿它逐个校验:
    //   400 unsupported published model parameter "image_ids"   ← 该型号根本没这个字段
    //   400 unsupported published model parameter "seconds"     ← 换名字了, 该用 duration
    // 两种都要能自愈: 有别名就改名重试, 没别名才删掉交给平台默认值。
    // model / prompt 是必需项, 永不删。每次重试请求体不同, 幂等键必须换后缀, 否则 409。
    let mut payload = Value::Null;
    let mut raw = String::new();
    let mut status = reqwest::StatusCode::OK;
    let mut rejected: Vec<String> = Vec::new();
    for attempt in 0..=4 {
        let response = ctx
            .client
            .post(&submit_url)
            .bearer_auth(&ctx.api_key)
            .header("Accept-Encoding", "identity")
            .header(
                "Idempotency-Key",
                if attempt == 0 { base_key.clone() } else { format!("{}-{}", base_key, attempt) },
            )
            .json(&Value::Object(body.clone()))
            .send()
            .await
            .map_err(|error| {
                AIError::Provider(format!(
                    "{} 视频请求失败(网络): {}",
                    PLATFORM_LABEL,
                    describe_reqwest_error(&error)
                ))
            })?;
        status = response.status();
        raw = response.text().await.unwrap_or_default();
        payload = serde_json::from_str(&raw).unwrap_or(Value::Null);
        if status.is_success() {
            break;
        }
        let Some(param) = unsupported_parameter(&raw) else { break };
        if param == "model" || param == "prompt" || !body.contains_key(&param) {
            break;
        }
        rejected.push(param.clone());
        // 别名可用就用别名(同值换键); 别名已试过或命名里已有同名键, 才算「这个参数不能用」。
        let alias = parameter_alias(&param)
            .filter(|alias| !rejected.iter().any(|item| item == alias) && !body.contains_key(*alias));
        match alias {
            Some(alias) => {
                if let Some(value) = body.remove(&param) {
                    body.insert(alias.to_string(), value);
                }
            }
            None => {
                body.remove(&param);
            }
        }
    }
    if !status.is_success() {
        let error = http_error(&format!("{} 视频请求失败", PLATFORM_LABEL), status, &raw, &submit_url);
        if rejected.is_empty() {
            return Err(error);
        }
        // 把「自动调整过哪些参数」写进错误里 —— 否则用户看不出我们动过请求体。
        return Err(match error {
            AIError::Provider(text) => {
                AIError::Provider(format!("{text} ｜已自动换名/剔除的参数: {}", rejected.join(", ")))
            }
            other => other,
        });
    }

    // 少数情况平台会直接回成片地址。
    if let Some(url) = extract::result_url(&payload) {
        if extract::task_status(&payload).is_empty() {
            return Ok(ProviderTaskSubmission::Succeeded(url));
        }
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

/// 签名地址下载**不带** Authorization(文档明确要求), 否则签名校验会失败。
async fn download_signed(ctx: &PollContext, url: &str) -> Result<Vec<u8>, AIError> {
    let response = ctx
        .client
        .get(url)
        .header("Accept-Encoding", "identity")
        .send()
        .await
        .map_err(|error| {
            AIError::Provider(format!(
                "{} 成片下载失败(网络): {}",
                PLATFORM_LABEL,
                describe_reqwest_error(&error)
            ))
        })?;
    let status = response.status();
    if !status.is_success() {
        let raw = response.text().await.unwrap_or_default();
        return Err(http_error(
            &format!("{} 成片下载失败", PLATFORM_LABEL),
            status,
            &raw,
            url,
        ));
    }
    let bytes = response.bytes().await.map_err(|error| {
        AIError::Provider(format!(
            "{} 成片下载失败(读取响应体): {}",
            PLATFORM_LABEL,
            describe_reqwest_error(&error)
        ))
    })?;
    if bytes.is_empty() {
        return Err(AIError::TaskFailed(format!(
            "{} 成片下载失败: 内容为空 ({})",
            PLATFORM_LABEL, url
        )));
    }
    Ok(bytes.to_vec())
}

pub async fn poll(
    ctx: &PollContext,
    metadata: &serde_json::Map<String, Value>,
    _handle: &ProviderTaskHandle,
) -> Result<ProviderTaskPollResult, AIError> {
    let query_url = meta_string(metadata, "query_url")
        .ok_or_else(|| AIError::InvalidRequest("Dramaya 任务缺少查询地址, 无法续查".into()))?;
    let response = ctx
        .client
        .get(query_url)
        .bearer_auth(&ctx.api_key)
        .header("Accept-Encoding", "identity")
        .send()
        .await
        .map_err(|error| {
            AIError::Provider(format!(
                "{} 视频查询失败(网络): {}",
                PLATFORM_LABEL,
                describe_reqwest_error(&error)
            ))
        })?;
    let status = response.status();
    let raw = response.text().await.unwrap_or_default();
    let payload: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    if !status.is_success() {
        // 4xx 是确定性错误(键失效 / 任务不存在), 继续轮询没有意义。
        if status.is_client_error() {
            return Ok(ProviderTaskPollResult::Failed(format!(
                "{} 视频查询失败: HTTP {} {}",
                PLATFORM_LABEL,
                status,
                truncate(&raw, 500)
            )));
        }
        return Err(http_error(
            &format!("{} 视频查询失败", PLATFORM_LABEL),
            status,
            &raw,
            query_url,
        ));
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

    // 完成: 优先用 data[].url / video_url(签名地址, 直接下), 没有再去 /content 取。
    let extension = video_extension_hint("video/mp4", "");
    if let Some(url) = extract::result_url(&payload) {
        let bytes = download_signed(ctx, &url).await?;
        return Ok(ProviderTaskPollResult::Succeeded(persist_media_bytes(&bytes, &extension)?));
    }
    let content_url = format!("{}/content", query_url.trim_end_matches('/'));
    let bytes = super::download_bytes(&ctx.client, &ctx.api_key, &content_url, PLATFORM_LABEL).await?;
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
    is_dramaya_base_url(provider_base_url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_canonical_video_host_matches() {
        assert!(is_dramaya_base_url("https://video.dramaya.us/v1"));
        assert!(is_dramaya_base_url("https://video.dramaya.us"));
        // 图片站是另一套协议, 不能命中视频链路。
        assert!(!is_dramaya_base_url("https://img.dramaya.us/v1"));
        // 前缀拼接不能命中(notvideo.dramaya.us 不是同一个站点)。
        assert!(!is_dramaya_base_url("https://notvideo.dramaya.us"));
        assert!(!is_dramaya_base_url("https://api.example.com"));
    }

    #[test]
    fn asset_protocol_urls_are_not_public() {
        assert!(!is_public_url("http://asset.localhost/D%3A/a.png"));
        assert!(is_public_url("https://cdn.example.com/a.png"));
    }

    #[test]
    fn parses_rejected_parameter_name() {
        assert_eq!(
            unsupported_parameter("HTTP 400 Bad Request unsupported published model parameter \"image_ids\"").as_deref(),
            Some("image_ids")
        );
        // JSON 转义形态: 反斜杠必须被剥掉, 否则永远匹配不上 body 的键
        assert_eq!(
            unsupported_parameter(r#"{"message":"unsupported published model parameter \"seconds\""}"#).as_deref(),
            Some("seconds")
        );
        assert_eq!(unsupported_parameter("model is required"), None);
    }

    #[test]
    fn parameter_aliases_cover_both_naming_styles() {
        assert_eq!(parameter_alias("seconds"), Some("duration"));
        assert_eq!(parameter_alias("aspect_ratio"), Some("ratio"));
        assert_eq!(parameter_alias("image_urls"), Some("images"));
        // 没有对应写法的参数返回 None → 走「删掉」分支
        assert_eq!(parameter_alias("image_ids"), None);
    }

    #[test]
    fn terminal_failures_cover_lowercase_statuses() {
        assert!(is_terminal_failure("failed"));
        assert!(is_terminal_failure("cancelled"));
        assert!(is_terminal_failure("expired"));
        assert!(!is_terminal_failure("running"));
        assert!(!is_terminal_failure("completed"));
    }
}
