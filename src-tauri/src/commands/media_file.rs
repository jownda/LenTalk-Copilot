//! 媒体文件的体积读取与字节读取。
//!
//! 节点需要在媒体画面外侧标注文件体积, 而前端 fetch 远程 CDN 会被 CORS 拦截,
//! 因此统一走 Rust: 本地文件读元数据, 远程地址发 HEAD / Range 探测,
//! data URL 直接按 base64 长度换算, 避免为了拿体积把整个视频下载一遍。
//!
//! 视频截图同样受 CORS 限制: webview 直接以 <video> 拉跨域源后, canvas 会被污染,
//! `toDataURL` 抛 SecurityError。这里提供 `load_media_data_url` 由 Rust 取字节,
//! 前端转成 blob URL 再抽帧 —— blob 与文档同源, 画布不会被污染。

use std::path::PathBuf;
use std::time::Duration;

/// 按 base64 长度换算 data URL 的原始字节数。
/// 每 4 个字符编码 3 字节, 末尾 `=` 为填充, 用整数除法天然处理不足一组的情况。
fn data_url_byte_size(source: &str) -> Option<u64> {
    let (metadata, payload) = source.split_once(',')?;
    if metadata.to_ascii_lowercase().contains(";base64") {
        let encoded: String = payload.chars().filter(|character| !character.is_whitespace()).collect();
        if encoded.is_empty() {
            return None;
        }
        let padding = encoded.chars().rev().take_while(|character| *character == '=').count() as u64;
        let significant = encoded.len() as u64 - padding;
        return Some(significant * 3 / 4);
    }
    // 非 base64 的 data URL 按百分号解码后的字节数计算。
    let decoded = urlencoding::decode(payload).ok()?;
    Some(decoded.as_ref().len() as u64)
}

/// 把媒体来源还原成本地文件路径。
/// 只有本地文件才有路径; asset / http(s) 等协议返回 None 交给远程探测分支。
fn local_path_from_source(source: &str) -> Option<PathBuf> {
    let trimmed = source.trim();
    if let Some(rest) = trimmed.strip_prefix("file://") {
        let decoded = urlencoding::decode(rest).ok()?;
        let value: &str = decoded.as_ref();
        // Windows 下 file:// 路径形如 /C:/xxx, 去掉前导斜杠
        #[cfg(target_os = "windows")]
        let value = value.strip_prefix('/').unwrap_or(value);
        return Some(PathBuf::from(value));
    }
    if trimmed.contains("://") {
        return None;
    }
    Some(PathBuf::from(trimmed))
}

/// 探测远程媒体体积: 先 HEAD 拿 Content-Length, 失败再退回只取 1 字节的 Range 请求,
/// 从 Content-Range 尾部读总长度。两条路径都不会下载完整文件。
async fn remote_media_byte_size(url: &str) -> Result<u64, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    if let Ok(response) = client.head(url).send().await {
        if response.status().is_success() {
            if let Some(length) = response.content_length().filter(|length| *length > 0) {
                return Ok(length);
            }
        }
    }

    let response = client
        .get(url)
        .header("Range", "bytes=0-0")
        .send()
        .await
        .map_err(|error| format!("无法访问媒体地址: {error}"))?;
    if let Some(total) = response
        .headers()
        .get("content-range")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.rsplit('/').next())
        .and_then(|value| value.trim().parse::<u64>().ok())
    {
        return Ok(total);
    }
    response
        .content_length()
        .filter(|length| *length > 0)
        .ok_or_else(|| "远程媒体未返回体积信息".to_string())
}

/// 返回媒体来源对应的字节数, 供节点在画面外侧标注体积 (KB / MB)。
#[tauri::command]
pub async fn resolve_media_file_size(source: String) -> Result<u64, String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("媒体地址为空".to_string());
    }
    if trimmed.starts_with("data:") {
        return data_url_byte_size(trimmed).ok_or_else(|| "无法解析 data URL 体积".to_string());
    }
    if let Some(path) = local_path_from_source(trimmed) {
        return if path.is_file() {
            std::fs::metadata(&path)
                .map(|metadata| metadata.len())
                .map_err(|error| format!("无法读取媒体文件体积: {error}"))
        } else {
            // 能解析成本地路径说明不是协议地址, 失败原因是文件不在磁盘上。
            Err(format!("媒体文件不存在: {}", path.display()))
        };
    }
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return remote_media_byte_size(trimmed).await;
    }
    Err("不支持的媒体地址".to_string())
}

/// 按扩展名推断媒体 MIME, 给 blob 打上正确的 content type。
/// 远端响应的 Content-Type 常被 CDN 写成 application/octet-stream, 或干脆缺失。
fn mime_from_extension(source: &str) -> Option<&'static str> {
    let without_query = source.split(['?', '#']).next().unwrap_or(source);
    let extension = without_query.rsplit('.').next()?.to_ascii_lowercase();
    match extension.as_str() {
        "mp4" | "m4v" => Some("video/mp4"),
        "mov" => Some("video/quicktime"),
        "webm" => Some("video/webm"),
        "mkv" => Some("video/x-matroska"),
        "avi" => Some("video/x-msvideo"),
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        "bmp" => Some("image/bmp"),
        "mp3" => Some("audio/mpeg"),
        "wav" => Some("audio/wav"),
        "m4a" => Some("audio/mp4"),
        "aac" => Some("audio/aac"),
        "ogg" | "oga" => Some("audio/ogg"),
        "flac" => Some("audio/flac"),
        _ => None,
    }
}

/// 截图链路允许加载的单段媒体体积上限, 避免把超大视频整段读进内存再经 IPC 传回前端。
const MAX_CAPTURABLE_MEDIA_BYTES: u64 = 256 * 1024 * 1024;

fn encode_data_url(mime: &str, bytes: &[u8]) -> String {
    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    format!("data:{mime};base64,{encoded}")
}

fn oversize_error(bytes: u64) -> String {
    format!(
        "媒体文件过大({:.0} MB), 超出截图可读取上限 {} MB",
        bytes as f64 / 1024.0 / 1024.0,
        MAX_CAPTURABLE_MEDIA_BYTES / 1024 / 1024
    )
}

/// 读取媒体字节并返回 data URL, 供前端转成同源 blob 后抽帧。
///
/// 跨域视频直接喂给 <video> 会把 canvas 标记为污染源(SecurityError),
/// 而这里的读取发生在 Rust, 不受 webview CORS 约束。
#[tauri::command]
pub async fn load_media_data_url(source: String) -> Result<String, String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("媒体地址为空".to_string());
    }
    // 已经是 data URL 时原样返回, 前端自行转 blob。
    if trimmed.starts_with("data:") {
        return Ok(trimmed.to_string());
    }

    if let Some(path) = local_path_from_source(trimmed) {
        if !path.is_file() {
            return Err(format!("媒体文件不存在: {}", path.display()));
        }
        let bytes_on_disk = std::fs::metadata(&path)
            .map_err(|error| format!("无法读取媒体文件信息: {error}"))?
            .len();
        if bytes_on_disk > MAX_CAPTURABLE_MEDIA_BYTES {
            return Err(oversize_error(bytes_on_disk));
        }
        let bytes = std::fs::read(&path).map_err(|error| format!("无法读取媒体文件: {error}"))?;
        let mime = mime_from_extension(&path.to_string_lossy()).unwrap_or("application/octet-stream");
        return Ok(encode_data_url(mime, &bytes));
    }

    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(180))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        let response = client
            .get(trimmed)
            .send()
            .await
            .map_err(|error| format!("无法下载媒体: {error}"))?;
        if !response.status().is_success() {
            return Err(format!("下载媒体失败: HTTP {}", response.status()));
        }
        // Content-Length 缺失时下载完成后再校验一次体积。
        if let Some(length) = response.content_length() {
            if length > MAX_CAPTURABLE_MEDIA_BYTES {
                return Err(oversize_error(length));
            }
        }
        let header_mime = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.split(';').next().unwrap_or(value).trim().to_string())
            .filter(|value| !value.is_empty() && value != "application/octet-stream" && value != "binary/octet-stream");
        let bytes = response
            .bytes()
            .await
            .map_err(|error| format!("读取媒体数据失败: {error}"))?;
        if bytes.len() as u64 > MAX_CAPTURABLE_MEDIA_BYTES {
            return Err(oversize_error(bytes.len() as u64));
        }
        let mime = header_mime
            .or_else(|| mime_from_extension(trimmed).map(str::to_string))
            .unwrap_or_else(|| "video/mp4".to_string());
        return Ok(encode_data_url(&mime, &bytes));
    }

    Err("不支持的媒体地址".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_base64_data_url_to_byte_size() {
        // "hello" 的 base64 为 aGVsbG8=, 解码后 5 字节
        assert_eq!(data_url_byte_size("data:text/plain;base64,aGVsbG8="), Some(5));
        assert_eq!(data_url_byte_size("data:text/plain;base64,aGVsbG8"), Some(5));
        assert_eq!(data_url_byte_size("data:text/plain;base64,aGVs"), Some(3));
    }

    #[test]
    fn ignores_whitespace_inside_base64_payload() {
        assert_eq!(data_url_byte_size("data:text/plain;base64,aGVs\nbG8="), Some(5));
    }

    #[test]
    fn rejects_data_url_without_payload() {
        assert_eq!(data_url_byte_size("data:text/plain;base64,"), None);
    }

    #[test]
    fn decodes_percent_encoded_data_url() {
        assert_eq!(data_url_byte_size("data:text/plain,hello%20world"), Some(11));
    }

    #[test]
    fn resolves_file_url_to_local_path() {
        let path = local_path_from_source("file:///C:/clips/clip.mp4").expect("file url resolves");
        let normalized = path.to_string_lossy().replace('\\', "/");
        // Windows 去掉前导斜杠得到 C:/clips/clip.mp4; 类 Unix 保留为 /C:/clips/clip.mp4。
        assert!(normalized.ends_with("clips/clip.mp4"), "unexpected: {normalized}");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn strips_leading_slash_from_windows_file_url() {
        let path = local_path_from_source("file:///C:/clips/clip.mp4").expect("resolves");
        assert_eq!(
            path.to_string_lossy().replace('\\', "/"),
            "C:/clips/clip.mp4"
        );
    }

    #[test]
    fn treats_plain_path_as_local_file() {
        let path = local_path_from_source("D:\\clips\\clip.mp4").expect("plain path resolves");
        assert_eq!(path, PathBuf::from("D:\\clips\\clip.mp4"));
    }

    #[test]
    fn skips_protocol_urls_when_resolving_local_path() {
        assert!(local_path_from_source("asset://localhost/C%3A/foo.png").is_none());
        assert!(local_path_from_source("https://example.com/clip.mp4").is_none());
    }

    #[test]
    fn expands_percent_encoded_file_url() {
        let path = local_path_from_source("file:///C:/clips/my%20clip.mp4").expect("resolves");
        assert!(path.to_string_lossy().contains("my clip.mp4"), "unexpected: {}", path.display());
    }

    #[tokio::test]
    async fn reads_byte_size_from_a_real_file() {
        let path = std::env::temp_dir().join(format!("lentalk-media-size-{}.bin", uuid::Uuid::new_v4()));
        std::fs::write(&path, vec![0_u8; 2048]).expect("write fixture");

        let size = resolve_media_file_size(path.to_string_lossy().into_owned())
            .await
            .expect("reads local file size");

        assert_eq!(size, 2048);
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn reads_byte_size_from_a_file_url() {
        let path = std::env::temp_dir().join(format!("lentalk-media-url-{}.bin", uuid::Uuid::new_v4()));
        std::fs::write(&path, vec![0_u8; 1024]).expect("write fixture");
        let normalized = path.to_string_lossy().replace('\\', "/");
        // Windows 需要 file:///C:/..., 类 Unix 需要 file:///var/... — 前缀斜杠数量不同。
        #[cfg(target_os = "windows")]
        let url = format!("file:///{normalized}");
        #[cfg(not(target_os = "windows"))]
        let url = format!("file://{normalized}");

        let size = resolve_media_file_size(url.clone()).await.expect("reads file url size");

        assert_eq!(size, 1024, "unexpected size for {url}");
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn rejects_missing_local_file() {
        let missing = std::env::temp_dir().join("lentalk-media-missing-does-not-exist.bin");
        std::fs::remove_file(&missing).ok();
        assert!(resolve_media_file_size(missing.to_string_lossy().into_owned()).await.is_err());
    }

    #[test]
    fn infers_mime_from_extension() {
        assert_eq!(mime_from_extension("clip.mp4"), Some("video/mp4"));
        assert_eq!(mime_from_extension("C:\\clips\\CLIP.MOV"), Some("video/quicktime"));
        assert_eq!(mime_from_extension("https://cdn.example.com/a/b.webm?token=1"), Some("video/webm"));
        assert_eq!(mime_from_extension("shot.png#fragment"), Some("image/png"));
        assert_eq!(mime_from_extension("no-extension"), None);
        assert_eq!(mime_from_extension("archive.zip"), None);
    }

    #[test]
    fn encodes_data_url_with_base64_payload() {
        // "hello" -> aGVsbG8=
        assert_eq!(
            encode_data_url("text/plain", b"hello"),
            "data:text/plain;base64,aGVsbG8="
        );
    }

    #[tokio::test]
    async fn reads_local_media_into_data_url() {
        let path = std::env::temp_dir().join(format!("lentalk-capture-{}.mp4", uuid::Uuid::new_v4()));
        let payload = b"\x00\x00\x00\x18ftypmp42".to_vec();
        std::fs::write(&path, &payload).expect("write fixture");

        let data_url = load_media_data_url(path.to_string_lossy().into_owned())
            .await
            .expect("reads local media");

        assert!(data_url.starts_with("data:video/mp4;base64,"), "unexpected: {data_url}");
        let encoded = data_url.split_once(',').expect("has payload").1;
        use base64::Engine;
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("payload decodes");
        assert_eq!(decoded, payload);

        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn passes_through_existing_data_url() {
        let source = "data:video/mp4;base64,aGVsbG8=";
        assert_eq!(
            load_media_data_url(source.to_string()).await.expect("passthrough"),
            source
        );
    }

    #[tokio::test]
    async fn rejects_unsupported_media_source() {
        assert!(load_media_data_url("".to_string()).await.is_err());
        assert!(load_media_data_url("blob:http://localhost/abc".to_string()).await.is_err());
        assert!(
            load_media_data_url("/definitely/missing/clip.mp4".to_string())
                .await
                .is_err()
        );
    }
}
