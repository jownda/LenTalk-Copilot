// ---------------------------------------------------------------------------
// 视频参考素材解析与上传(后端侧)
//
// `src/commands/referenceAssetSource.ts` 的后端等价物。画布上的参考素材可能是:
// 公网 URL / data URL / 裸 base64 / 本机绝对路径 / file:// / Tauri 的 asset://
// 预览 URL。中转平台只认「公网 URL」或「平台能读到的字节」, 所以这里先统一还原
// 成本地可读的字节 + MIME, 再由各协议决定是透传 URL 还是上传换 URL。
// ---------------------------------------------------------------------------
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::multipart::{Form, Part};
use serde_json::Value;
use std::time::Duration;

use super::describe_reqwest_error;
use crate::ai::error::AIError;

/// 素材上传的最大尝试次数。
///
/// 上传本身**幂等**(最坏情况是图床上多留一个没人引用的对象), 不产生计费单, 所以
/// 网络层失败可以放心重试 —— 这与提交阶段「不重试纯网络错误」的规则刻意不同:
/// 提交可能已送达并被计费, 重提就是二次扣费; 而上传这里, 一次瞬断就让整个视频
/// 任务作废的代价太高。
const UPLOAD_ATTEMPTS: usize = 3;

/// 两次重试之间的等待(第 1 次失败后、第 2 次失败后)。指数退避, 避免在对方抖动
/// 期间连着打三枪。
const UPLOAD_RETRY_BACKOFF: [Duration; 2] = [Duration::from_millis(400), Duration::from_millis(1200)];

/// 单次上传的超时。
///
/// 比视频提交的 180s 短得多: 上传只是把素材送出去, 卡住就该尽快失败并交给重试,
/// 而不是把总超时耗光 —— 否则一次卡死要等三分钟, 重试也来不及发生。
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(60);

/// 一个参考素材的归一化结果。
#[derive(Debug, Clone)]
pub enum ReferenceAsset {
    /// 公网 URL, 平台可自行下载 —— 原样透传, 不读本地字节。
    Url(String),
    /// 需要由调用方处理(上传换 URL, 或内联进请求体)。
    File {
        mime_type: String,
        extension: String,
        bytes: Vec<u8>,
    },
}

/// MIME → 扩展名。multipart 文件名要带正确后缀, 平台才会正确识别。
fn extension_from_mime_type(mime_type: &str) -> String {
    let normalized = mime_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let mapped = match normalized.as_str() {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/bmp" => "bmp",
        "image/tiff" => "tiff",
        "image/avif" => "avif",
        "image/heic" => "heic",
        "image/heif" => "heif",
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/mp4" | "audio/m4a" => "m4a",
        "audio/aac" => "aac",
        "audio/ogg" => "ogg",
        "audio/flac" => "flac",
        "audio/webm" => "webm",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "video/quicktime" => "mov",
        _ => "",
    };
    if !mapped.is_empty() {
        return mapped.to_string();
    }
    let subtype = normalized.split('/').nth(1).unwrap_or("");
    let cleaned: String = subtype.chars().filter(|ch| ch.is_ascii_alphanumeric()).collect();
    if cleaned.is_empty() {
        "bin".to_string()
    } else {
        cleaned
    }
}

/// 扩展名 → MIME。读取本地文件时按后缀推断, 与前端 load_image 的行为对齐。
fn mime_from_extension(extension: &str) -> String {
    let normalized = extension.trim().trim_start_matches('.').to_ascii_lowercase();
    match normalized.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        "avif" => "image/avif",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        _ => "application/octet-stream",
    }
    .to_string()
}

fn ascii_at(head: &[u8], offset: usize, text: &[u8]) -> bool {
    head.len() >= offset + text.len() && &head[offset..offset + text.len()] == text
}

/// 文件头签名 → MIME。**强签名在前**: 弱签名(如 BMP 的 'BM')容易与随机字节撞车。
fn mime_from_magic(head: &[u8]) -> Option<&'static str> {
    if head.len() < 4 {
        return None;
    }
    if head[0] == 0x89 && ascii_at(head, 1, b"PNG") {
        return Some("image/png");
    }
    if head[0] == 0xff && head[1] == 0xd8 && head[2] == 0xff {
        return Some("image/jpeg");
    }
    if ascii_at(head, 0, b"GIF8") {
        return Some("image/gif");
    }
    if ascii_at(head, 0, b"RIFF") && ascii_at(head, 8, b"WEBP") {
        return Some("image/webp");
    }
    if ascii_at(head, 0, b"RIFF") && ascii_at(head, 8, b"WAVE") {
        return Some("audio/wav");
    }
    if ascii_at(head, 0, b"OggS") {
        return Some("audio/ogg");
    }
    if ascii_at(head, 0, b"fLaC") {
        return Some("audio/flac");
    }
    if head[0] == 0x1a && head[1] == 0x45 && head[2] == 0xdf && head[3] == 0xa3 {
        return Some("video/webm");
    }
    if ascii_at(head, 4, b"ftyp") {
        return Some("video/mp4");
    }
    if ascii_at(head, 0, b"ID3") {
        return Some("audio/mpeg");
    }
    if ascii_at(head, 0, b"BM") {
        return Some("image/bmp");
    }
    // MP3 帧同步位: 弱签名, 额外要求第二字节的层/码率位合法。
    if head[0] == 0xff && (head[1] & 0xe0) == 0xe0 && (head[1] & 0x06) != 0 {
        return Some("audio/mpeg");
    }
    None
}

/// 解析 `data:<mime>;base64,<payload>`。
fn parse_data_url(source: &str) -> Option<(String, Vec<u8>)> {
    let trimmed = source.trim();
    if !trimmed.to_ascii_lowercase().starts_with("data:") {
        return None;
    }
    let (meta, payload) = trimmed.split_once(',')?;
    if !meta.to_ascii_lowercase().contains(";base64") {
        return None;
    }
    let mime_type = meta
        .trim_start_matches("data:")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if mime_type.is_empty() {
        return None;
    }
    let compact: String = payload.chars().filter(|ch| !ch.is_whitespace()).collect();
    let bytes = STANDARD.decode(compact.as_bytes()).ok()?;
    if bytes.is_empty() {
        return None;
    }
    Some((mime_type, bytes))
}

/// 平台要求 raw_base64 时上游给的是不带 `data:` 前缀的裸 base64(如 `/9j/4AAQ…`)。
/// 只在**解出的文件头命中已知媒体签名**时才认, 否则本地路径或普通文本会被误判。
fn detect_raw_base64_asset(source: &str) -> Option<(String, Vec<u8>)> {
    let compact: String = source.chars().filter(|ch| !ch.is_whitespace()).collect();
    if compact.len() < 32 || compact.len() % 4 != 0 {
        return None;
    }
    if !compact
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '+' || ch == '/' || ch == '=')
    {
        return None;
    }
    let prefix_len = (32usize.div_ceil(3)) * 4;
    let prefix = &compact[..prefix_len.min(compact.len())];
    let head = STANDARD.decode(prefix.as_bytes()).ok()?;
    let mime_type = mime_from_magic(&head)?;
    let bytes = STANDARD.decode(compact.as_bytes()).ok()?;
    Some((mime_type.to_string(), bytes))
}

fn is_asset_protocol_url(lower: &str) -> bool {
    lower.starts_with("asset://")
        || lower.starts_with("http://asset.localhost")
        || lower.starts_with("https://asset.localhost")
}

/// 至少两个字符才算协议前缀, 避免把 Windows 盘符 `C:` 当成 scheme。
fn has_scheme(value: &str) -> bool {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphabetic() => {}
        _ => return false,
    }
    let mut count = 0;
    for ch in chars {
        if ch == ':' {
            return count >= 1;
        }
        if ch.is_ascii_alphanumeric() || ch == '+' || ch == '.' || ch == '-' {
            count += 1;
            continue;
        }
        return false;
    }
    false
}

fn looks_like_local_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    if value.starts_with('/') || value.starts_with("\\\\") {
        return true;
    }
    // `C:\...` 或 `C:/...`
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

fn percent_decode(value: &str) -> String {
    urlencoding::decode(value)
        .map(|decoded| decoded.into_owned())
        .unwrap_or_else(|_| value.to_string())
}

fn normalize_windows_drive(path: String) -> Option<String> {
    // asset:// 解出来的路径前导斜杠个数**不稳定**: macOS 的 convertFileSrc 产物是
    // `asset://localhost/%2FUsers%2F...`(解码后 `/Users/...`), 而 Windows 侧既可能是
    // `asset://localhost/%2FC%3A%2Fa` → `/C:/a`, 也可能是 `...//%2FC%3A%2Fa` → `//C:/a`
    // (字面 `/` 与编码进去的 `%2F` 叠加)。多一个斜杠会让 `C:\` 盘符路径变成
    // `\\C:\...`(非法路径), 本地素材一律读不出来 —— 所以统一剥掉全部前导斜杠。
    //
    // Unix 形态必须原样保留, 靠「首字符是盘符且紧跟冒号」来区分:
    //   `/Users/x` → trimmed=`Users/x`, bytes[1]='s' → 不是盘符 → 保留 `/Users/x`
    //   `//server/share`(UNC) → bytes[1]='e' → 保留原样
    let trimmed = path.trim_start_matches('/');
    let bytes = trimmed.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return Some(trimmed.to_string());
    }
    (!path.is_empty()).then_some(path)
}

/// 还原本地素材路径的书写形态: `file:///...` / `asset://localhost/<encoded>` /
/// `http://asset.localhost/<encoded>` / 普通绝对路径。非本地协议返回 None。
pub fn local_path_from_source(source: &str) -> Option<String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();
    if !lower.starts_with("file://") && !is_asset_protocol_url(&lower) {
        if has_scheme(trimmed) {
            return None;
        }
        return looks_like_local_path(trimmed).then(|| trimmed.to_string());
    }
    if lower.starts_with("file://") {
        let rest = &trimmed["file://".len()..];
        let rest = rest.strip_prefix("localhost").unwrap_or(rest);
        let rest = rest.strip_prefix('/').unwrap_or(rest);
        // `file:///C:/x` 与 `file:///home/x` 都要能还原。
        let candidate = if looks_like_local_path(rest) {
            rest.to_string()
        } else {
            format!("/{}", rest)
        };
        return normalize_windows_drive(percent_decode(&candidate));
    }
    // asset:// 与 http://asset.localhost 都是 convertFileSrc 的产物:
    // 形态是 `asset://localhost/<percent-encoded 绝对路径>`。
    // 解码后交给 normalize_windows_drive —— 它同时处理 Unix 的 `/Users/...`
    // (原样保留) 和 Windows 被编码进去的前导斜杠 (`/C:/...` → `C:/...`)。
    let after_scheme = trimmed
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed);
    let after_host = after_scheme
        .strip_prefix("asset.localhost")
        .unwrap_or(after_scheme);
    let after_host = after_host.strip_prefix("localhost").unwrap_or(after_host);
    // 主机名与绝对路径之间那个**字面** `/` 只是分隔符, 不属于路径本身。
    // 它若和编码进去的 `%2F` 叠加, 就会造出 `//Users/...`(Unix) 或
    // `///C:/...`(Windows) 这类畸形前缀 —— 前者在 POSIX 上虽能打开,
    // 但会一路带着脏前缀进日志与元数据, 所以在这里先剥掉一层。
    let after_host = after_host.strip_prefix('/').unwrap_or(after_host);
    normalize_windows_drive(percent_decode(after_host))
}

/// 统一入口: 公网 URL 透传, 其余一律读成字节交给调用方。
pub async fn resolve_reference_asset(
    source: &str,
    platform_label: &str,
) -> Result<ReferenceAsset, AIError> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err(AIError::InvalidRequest(format!("{} 参考素材地址为空", platform_label)));
    }
    // `http://asset.localhost/...` 是 Windows Tauri 的本地预览协议, 不是公网 URL;
    // 必须先还原本地路径, 不能透传给要求公网 URL 的平台。
    if !is_asset_protocol_url(&trimmed.to_ascii_lowercase())
        && (trimmed.starts_with("http://") || trimmed.starts_with("https://"))
    {
        return Ok(ReferenceAsset::Url(trimmed.to_string()));
    }
    if let Some((mime_type, bytes)) = parse_data_url(trimmed) {
        let extension = extension_from_mime_type(&mime_type);
        return Ok(ReferenceAsset::File { mime_type, extension, bytes });
    }
    if let Some((mime_type, bytes)) = detect_raw_base64_asset(trimmed) {
        let extension = extension_from_mime_type(&mime_type);
        return Ok(ReferenceAsset::File { mime_type, extension, bytes });
    }
    if let Some(path) = local_path_from_source(trimmed) {
        let bytes = tokio::fs::read(&path).await.map_err(|error| {
            AIError::InvalidRequest(format!(
                "{} 参考素材本地文件读取失败({}): {}",
                platform_label, path, error
            ))
        })?;
        if bytes.is_empty() {
            return Err(AIError::InvalidRequest(format!(
                "{} 参考素材本地文件为空({})",
                platform_label, path
            )));
        }
        let extension = std::path::Path::new(&path)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let mime_type = mime_from_magic(&bytes)
            .map(str::to_string)
            .unwrap_or_else(|| mime_from_extension(&extension));
        let extension = if extension.is_empty() {
            extension_from_mime_type(&mime_type)
        } else {
            extension
        };
        return Ok(ReferenceAsset::File { mime_type, extension, bytes });
    }
    Err(AIError::InvalidRequest(format!(
        "{} 参考素材必须是公网 URL 或可读取的本地素材({})",
        platform_label,
        describe_source(trimmed)
    )))
}

fn describe_source(source: &str) -> String {
    let preview: String = if source.chars().count() > 96 {
        let head: String = source.chars().take(96).collect();
        format!("{}…", head)
    } else {
        source.to_string()
    };
    if let Some((scheme, _)) = source.split_once(':') {
        if scheme.len() >= 2 && scheme.chars().all(|ch| ch.is_ascii_alphabetic() || ch == '+' || ch == '.') {
            return format!("{}: 协议无法作为参考素材({})", scheme, preview);
        }
    }
    format!("本地文件读取失败({})", preview)
}

/// 把本地字节转成 `data:<mime>;base64,<...>`(部分平台没有上传端点, 只能内联)。
pub fn to_data_url(mime_type: &str, bytes: &[u8]) -> String {
    format!("data:{};base64,{}", mime_type, STANDARD.encode(bytes))
}

/// multipart 上传换公网 URL 的通用流程: 字段名固定 `file`, 上传体由本函数拼装
/// (转发 JSON 的 Content-Type 会让 multipart 失效, 所以这里自己带 boundary)。
pub async fn upload_reference_asset_multipart(
    client: &reqwest::Client,
    upload_url: &str,
    api_key: &str,
    filename: &str,
    asset: &ReferenceAsset,
    platform_label: &str,
) -> Result<Value, AIError> {
    upload_reference_asset_multipart_with_fields(
        client,
        upload_url,
        api_key,
        filename,
        asset,
        platform_label,
        &[],
    )
    .await
}

/// 同上, 但允许附带额外的表单文本字段。
///
/// 帧间的 `/v1/assets` 要求同时带上 `model` 与 `kind`(image / video / audio),
/// 少了它们平台无法把素材归到对应模型上, 会直接 400。
pub async fn upload_reference_asset_multipart_with_fields(
    client: &reqwest::Client,
    upload_url: &str,
    api_key: &str,
    filename: &str,
    asset: &ReferenceAsset,
    platform_label: &str,
    fields: &[(&str, &str)],
) -> Result<Value, AIError> {
    let (mime_type, bytes) = match asset {
        ReferenceAsset::Url(url) => return Ok(Value::String(url.clone())),
        ReferenceAsset::File { mime_type, bytes, .. } => (mime_type.clone(), bytes.clone()),
    };

    let mut last_error: Option<reqwest::Error> = None;
    for attempt in 1..=UPLOAD_ATTEMPTS {
        // `Form` 会被 `send()` 消费, 所以每次重试都要重新拼一份。上传体构造失败
        // (非法 MIME)重试多少次都一样, 直接返回。
        let part = Part::bytes(bytes.clone())
            .file_name(filename.to_string())
            .mime_str(&mime_type)
            .map_err(|error| AIError::InvalidRequest(format!("{} 上传体构造失败: {}", platform_label, error)))?;
        let mut form = Form::new();
        for (name, value) in fields {
            form = form.text((*name).to_string(), (*value).to_string());
        }
        let form = form.part("file", part);
        // api_key 为空 = 该图床是**匿名可上传**的, 不要发出 `Authorization: Bearer `
        // (空值)。WGSPAI 的背景机图床 https://wgspai.cn/image-bed/api/upload 就属于
        // 这一类 —— 官方 curl 示例不带任何鉴权头, 而带上一个空 Bearer 会让部分
        // 网关直接 401, 反而把本来能用的上传打断。
        let mut request = client
            .post(upload_url)
            .header("Accept-Encoding", "identity")
            .timeout(UPLOAD_TIMEOUT)
            .multipart(form);
        if !api_key.trim().is_empty() {
            request = request.bearer_auth(api_key);
        }
        match request.send().await {
            Ok(response) => {
                let status = response.status();
                let raw = response.text().await.unwrap_or_default();
                let payload: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
                if !status.is_success() {
                    return Err(AIError::TaskFailed(format!(
                        "{} 参考素材上传失败: HTTP {} {}",
                        platform_label,
                        status,
                        truncate(&raw, 500)
                    )));
                }
                return Ok(payload);
            }
            Err(error) => {
                // 请求构造类错误(URL / header 非法)重试也不会变好, 其余都当瞬时故障。
                let worth_retrying = attempt < UPLOAD_ATTEMPTS && !error.is_builder();
                last_error = Some(error);
                if !worth_retrying {
                    break;
                }
                tokio::time::sleep(UPLOAD_RETRY_BACKOFF[attempt - 1]).await;
            }
        }
    }
    let error = last_error.expect("循环只在拿到错误后才退出, 这里必然有值");
    Err(AIError::Provider(format!(
        "{} 参考素材上传失败(网络): 已重试 {} 次仍未成功 — {}",
        platform_label,
        UPLOAD_ATTEMPTS - 1,
        describe_reqwest_error(&error)
    )))
}

/// 有些平台的上传端点只收字节(帧间 `/v1/assets`), 不接受公网 URL 透传 ——
/// 这时必须先把远端素材下载回来, 再当成本地文件上传。
pub async fn download_url_to_asset(
    client: &reqwest::Client,
    url: &str,
    fallback_mime: &str,
    platform_label: &str,
) -> Result<ReferenceAsset, AIError> {
    let response = client
        .get(url)
        .header("Accept-Encoding", "identity")
        .send()
        .await
        .map_err(|error| AIError::Provider(format!("{} 参考素材下载失败(网络): {}", platform_label, describe_reqwest_error(&error))))?;
    let status = response.status();
    if !status.is_success() {
        return Err(AIError::TaskFailed(format!(
            "{} 参考素材下载失败: HTTP {} ({})",
            platform_label, status, url
        )));
    }
    let header_mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.split(';').next().unwrap_or("").trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty() && value != "application/octet-stream");
    let bytes = response
        .bytes()
        .await
        .map_err(|error| AIError::Provider(format!("{} 参考素材下载失败(读取响应体): {}", platform_label, error)))?;
    if bytes.is_empty() {
        return Err(AIError::TaskFailed(format!("{} 参考素材下载失败: 内容为空 ({})", platform_label, url)));
    }
    let mime_type = mime_from_magic(&bytes)
        .map(str::to_string)
        .or(header_mime)
        .unwrap_or_else(|| fallback_mime.to_string());
    let extension = extension_from_mime_type(&mime_type);
    Ok(ReferenceAsset::File {
        mime_type,
        extension,
        bytes: bytes.to_vec(),
    })
}

/// 从上传响应里找出公网 URL。各家中转的字段名不统一, 按常见键递归找。
pub fn extract_asset_url(payload: &Value) -> Option<String> {
    match payload {
        Value::String(value) if value.starts_with("http://") || value.starts_with("https://") => {
            Some(value.clone())
        }
        Value::Array(items) => items.iter().find_map(extract_asset_url),
        Value::Object(map) => [
            "url",
            "asset_url",
            "assetUrl",
            "public_url",
            "publicUrl",
            "cdn_url",
            "cdnUrl",
            "file_url",
            "fileUrl",
            "web_url",
            "webUrl",
            "signed_url",
            "signedUrl",
            "href",
            "download_url",
            "downloadUrl",
        ]
        .iter()
        .find_map(|key| map.get(*key).and_then(extract_asset_url))
        .or_else(|| {
            ["data", "result", "asset", "file"]
                .iter()
                .find_map(|key| map.get(*key).and_then(extract_asset_url))
        }),
        _ => None,
    }
}

pub fn truncate(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_data_url() {
        let (mime, bytes) = parse_data_url("data:image/png;base64,iVBORw0KGgo=").expect("data url");
        assert_eq!(mime, "image/png");
        assert!(!bytes.is_empty());
    }

    #[test]
    fn detects_raw_base64_png() {
        let png_prefix = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
        let (mime, _) = detect_raw_base64_asset(png_prefix).expect("raw base64");
        assert_eq!(mime, "image/png");
    }

    #[test]
    fn rejects_plain_text_as_base64() {
        assert!(detect_raw_base64_asset("D:\\LENTALK\\a very long plain text path here.png").is_none());
    }

    #[test]
    fn resolves_windows_local_path_forms() {
        assert_eq!(
            local_path_from_source("C:\\a\\b.png").as_deref(),
            Some("C:\\a\\b.png")
        );
        assert_eq!(
            local_path_from_source("file:///C:/a/b.png").as_deref(),
            Some("C:/a/b.png")
        );
        assert_eq!(
            local_path_from_source("asset://localhost/%2FC%3A%2Fa%2Fb.png").as_deref(),
            Some("C:/a/b.png")
        );
        // 字面 `/` 与编码进去的 `%2F` 叠加出的双斜杠也要能还原。
        assert_eq!(
            local_path_from_source("asset://localhost//%2FC%3A%2Fa%2Fb.png").as_deref(),
            Some("C:/a/b.png")
        );
        // Unix 形态与 UNC 不能被盘符规则误伤。
        assert_eq!(
            local_path_from_source("asset://localhost/%2FUsers%2Fme%2Fa.png").as_deref(),
            Some("/Users/me/a.png")
        );
        assert_eq!(
            local_path_from_source("\\\\server\\share\\a.png").as_deref(),
            Some("\\\\server\\share\\a.png")
        );
        assert!(local_path_from_source("https://cdn.example.com/a.png").is_none());
    }

    #[test]
    fn maps_extension_to_mime() {
        assert_eq!(mime_from_extension("mp3"), "audio/mpeg");
        assert_eq!(extension_from_mime_type("audio/mpeg"), "mp3");
        assert_eq!(extension_from_mime_type("image/jpeg"), "jpg");
    }

    #[test]
    fn finds_asset_url_in_nested_payload() {
        let payload = serde_json::json!({ "data": { "file": { "public_url": "https://x/y.png" } } });
        assert_eq!(extract_asset_url(&payload).as_deref(), Some("https://x/y.png"));
    }
}
