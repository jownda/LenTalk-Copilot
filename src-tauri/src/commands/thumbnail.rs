//! 素材缩略图缓存。
//!
//! 候选卡片里的缩略图只有约 54x40 个像素，但素材库 / 电影资产记录的「预览图」经常就是
//! 原图本身 —— `cinematicMirrorSync` 是把 `referencePaths[0]` 原样写进 `previewImageUrl`
//! 的。实测本机素材库前 36 张角色参考图合计约 145MB（p90 单张近 10MB、最大 17MB），
//! 于是「点开卡片」这一下要让 WebView 读盘并解码上百 MB 的图片，只为画 54x40 的格子。
//! 前端分批挂载只能减少 DOM 节点数，**并不能减少要读和解码的字节数**，所以那种卡顿
//! 一直没消掉。
//!
//! 这里把缩略图换成真正的小图：Rust 侧按「路径 + 尺寸 + 源文件 mtime/size」生成一次
//! 并落盘缓存，前端拿到的是十几 KB 的 JPEG。生成发生在工作线程池里（`spawn_blocking`），
//! WebView 主线程不参与解码；第二次打开直接命中缓存，连解码都省了。
//!
//! 缓存键带上 mtime/size，源图被重新生成时会自然失效，不需要额外的清理逻辑。

use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use image::codecs::jpeg::JpegEncoder;
use image::ImageReader;
use tauri::{AppHandle, Manager};

use crate::database::app_data_dir;

/// 缩略图缓存目录（位于 app data 下，落在这里才能被 `asset://` 协议读到：
/// `tauri.conf.json` 的 `assetProtocol.scope` 已放开了 `$APPDATA/**`）。
const THUMBNAIL_DIR: &str = "thumbnails";
/// 目标长边像素的兜底值（前端显式传值，见 `thumbnailCache.ts` 的 `THUMBNAIL_MAX_EDGE`）。
/// 候选卡片格子放大到约 108px 后，2x 屏需要约 216px，所以两处都对齐到 256。
const DEFAULT_MAX_EDGE: u32 = 256;
const MIN_MAX_EDGE: u32 = 32;
const MAX_MAX_EDGE: u32 = 1024;
const JPEG_QUALITY: u8 = 80;
/// 缓存文件数上限，超出后按 mtime 清理最旧的一批。单张约 10~15KB，2000 张约 25MB。
const MAX_CACHE_FILES: usize = 2000;
const PRUNE_BATCH: usize = 200;

/// 把前端传来的源地址规整成文件系统路径。
///
/// 只接受本地路径：`http(s)://` / `data:` / `blob:` 这些不是本地文件，
/// 本模块不负责下载，返回 `None` 让前端回落原图。
fn normalize_source_path(source: &str) -> Option<PathBuf> {
    let value = source.trim();
    if value.is_empty() {
        return None;
    }
    let lower = value.to_ascii_lowercase();
    if lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("data:")
        || lower.starts_with("blob:")
        || lower.starts_with("asset:")
    {
        return None;
    }

    let raw = if lower.starts_with("file://") {
        let rest = &value["file://".len()..];
        // `file:///C:/x/y` → `/C:/x/y`
        let without_host = rest.strip_prefix("localhost").unwrap_or(rest);
        without_host.trim_start_matches('/').to_string()
    } else {
        value.to_string()
    };

    let decoded = percent_decode(&raw);
    if decoded.trim().is_empty() {
        return None;
    }
    Some(PathBuf::from(decoded))
}

/// 最小 percent-decoding：只处理 `%XX`，够用于 `file://` 地址里的空格与中文。
/// 不引入额外依赖，解码失败（非法十六进制）时原样保留。
fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok();
            if let Some(byte) = hex.and_then(|text| u8::from_str_radix(text, 16).ok()) {
                output.push(byte);
                index += 3;
                continue;
            }
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(output).unwrap_or_else(|_| value.to_string())
}

/// 缓存键：路径 + 目标尺寸 + 源文件的 size/mtime。
/// 带上 mtime/size 后，源图被重新生成时旧缓存自然不再命中，无需手动失效。
fn thumbnail_cache_key(source: &Path, max_edge: u32) -> String {
    let metadata = std::fs::metadata(source).ok();
    let length = metadata.as_ref().map(|item| item.len()).unwrap_or(0);
    let modified = metadata
        .and_then(|item| item.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let signature = format!(
        "{}|{}|{}|{}",
        source.to_string_lossy(),
        max_edge,
        length,
        modified
    );
    format!("{:x}", md5::compute(signature.as_bytes()))
}

/// 生成并原子落盘一张缩略图。
fn write_thumbnail(source: &Path, target: &Path, max_edge: u32) -> Result<(), String> {
    let decoded = ImageReader::open(source)
        .map_err(|error| format!("无法打开缩略图源文件 {}: {error}", source.display()))?
        .with_guessed_format()
        .map_err(|error| format!("无法识别缩略图源文件格式: {error}"))?
        .decode()
        .map_err(|error| format!("无法解码缩略图源文件: {error}"))?;

    // JPEG 不支持透明通道，先转 RGB8；否则带 alpha 的 PNG 会在编码阶段报错。
    let resized = decoded.thumbnail(max_edge, max_edge).to_rgb8();

    let mut buffer = Cursor::new(Vec::new());
    let mut encoder = JpegEncoder::new_with_quality(&mut buffer, JPEG_QUALITY);
    encoder
        .encode_image(&resized)
        .map_err(|error| format!("无法编码缩略图: {error}"))?;

    // 先写临时文件再改名：并发请求同一张图时不会读到写了一半的文件。
    let temporary = target.with_extension("jpg.part");
    std::fs::write(&temporary, buffer.get_ref())
        .map_err(|error| format!("无法写入缩略图缓存: {error}"))?;
    std::fs::rename(&temporary, target).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        format!("无法提交缩略图缓存: {error}")
    })
}

/// 缓存目录里的 `.jpg` 数量超过上限时，按修改时间清掉最旧的一批。
/// 清理失败不影响本次结果（缩略图已经写好了），所以这里不返回错误。
fn prune_cache_if_needed(directory: &Path) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("jpg") {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|item| item.modified())
            .unwrap_or(UNIX_EPOCH);
        files.push((modified, path));
    }
    if files.len() <= MAX_CACHE_FILES {
        return;
    }
    files.sort_by_key(|(modified, _)| *modified);
    for (_, path) in files.iter().take(PRUNE_BATCH) {
        let _ = std::fs::remove_file(path);
    }
}

/// 返回可交给 `convertFileSrc` 的缩略图路径，必要时现场生成。
///
/// 前端只关心结果路径；命中缓存时是纯文件系统 stat，开销可以忽略。
#[tauri::command]
pub async fn ensure_image_thumbnail(
    app: AppHandle,
    path: String,
    max_edge: Option<u32>,
) -> Result<String, String> {
    let source = normalize_source_path(&path).ok_or_else(|| "缩略图源不是本地文件".to_string())?;
    if !source.is_file() {
        return Err(format!("缩略图源文件不存在: {}", source.display()));
    }

    let edge = max_edge
        .unwrap_or(DEFAULT_MAX_EDGE)
        .clamp(MIN_MAX_EDGE, MAX_MAX_EDGE);
    let directory = app_data_dir(&app)?.join(THUMBNAIL_DIR);
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("无法创建缩略图缓存目录: {error}"))?;

    let target = directory.join(format!("{}.jpg", thumbnail_cache_key(&source, edge)));
    if target.is_file() {
        return Ok(target.to_string_lossy().to_string());
    }
    let result_path = target.to_string_lossy().to_string();

    // 解码 + 缩放是纯 CPU 工作，放到阻塞线程池：几十 MB 的原图在命令线程上解会拖住 IPC。
    let cache_directory = directory.clone();
    tauri::async_runtime::spawn_blocking(move || {
        write_thumbnail(&source, &target, edge)?;
        prune_cache_if_needed(&cache_directory);
        Ok::<(), String>(())
    })
    .await
    .map_err(|error| format!("缩略图任务执行失败: {error}"))??;

    Ok(result_path)
}

/// 启动时把缓存目录登记进 asset 协议作用域。
///
/// 目录本来就在 `$APPDATA/**` 之下，但作用域一旦失配的表现是「文件写得出来却显示空白、
/// 且不报错」，排查成本远高于这里多一行调用。
pub fn register_asset_scope(app: &AppHandle) -> Result<(), String> {
    let directory = app_data_dir(app)?.join(THUMBNAIL_DIR);
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("无法创建缩略图缓存目录: {error}"))?;
    app.asset_protocol_scope()
        .allow_directory(&directory, true)
        .map_err(|error| format!("无法为缩略图目录开放本地读取权限: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_sources_that_are_not_local_files() {
        assert!(normalize_source_path("https://example.com/a.png").is_none());
        assert!(normalize_source_path("data:image/png;base64,AAAA").is_none());
        assert!(normalize_source_path("blob:http://localhost/abc").is_none());
        assert!(normalize_source_path("asset://localhost/C:/a.png").is_none());
        assert!(normalize_source_path("   ").is_none());
    }

    #[test]
    fn normalizes_windows_file_urls() {
        assert_eq!(
            normalize_source_path("file:///C:/Users/a/my%20image.png").unwrap(),
            PathBuf::from("C:/Users/a/my image.png"),
        );
        assert_eq!(
            normalize_source_path(r"C:\Users\a\image.png").unwrap(),
            PathBuf::from(r"C:\Users\a\image.png"),
        );
    }

    #[test]
    fn decodes_percent_escapes_including_utf8_paths() {
        assert_eq!(percent_decode("a%20b.png"), "a b.png");
        assert_eq!(percent_decode("%E8%A7%92%E8%89%B2.png"), "角色.png");
        // 非法转义原样保留，不能把整条路径吞掉。
        assert_eq!(percent_decode("100%zz.png"), "100%zz.png");
        assert_eq!(percent_decode("tail%"), "tail%");
    }

    #[test]
    fn cache_key_is_stable_and_path_specific() {
        let first = thumbnail_cache_key(Path::new("C:/a/b.png"), 192);
        let second = thumbnail_cache_key(Path::new("C:/a/b.png"), 192);
        let other_path = thumbnail_cache_key(Path::new("C:/a/c.png"), 192);
        let other_edge = thumbnail_cache_key(Path::new("C:/a/b.png"), 256);
        assert_eq!(first, second);
        assert_ne!(first, other_path);
        assert_ne!(first, other_edge);
        // md5 十六进制，固定 32 位，可以直接当文件名用。
        assert_eq!(first.len(), 32);
        assert!(first.chars().all(|value| value.is_ascii_hexdigit()));
    }
}
