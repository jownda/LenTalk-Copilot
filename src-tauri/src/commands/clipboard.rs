use std::io::Cursor;

use arboard::Clipboard;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;

/// 系统剪贴板里的媒体快照。
///
/// 画布右键菜单拿不到原生 PasteEvent，只能主动读系统剪贴板：这里一次把「复制的本地文件路径」
/// 和「截图这类纯位图」都取回来，前端据此判断上一次复制的是本地媒体还是画布节点。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardMediaSnapshot {
    /// 在访达 / 资源管理器里复制的本地文件(保持复制顺序)。
    pub file_paths: Vec<String>,
    /// 剪贴板里是否有位图数据(截图、复制图片等)。
    pub has_image: bool,
    /// 位图的 PNG base64；`include_image` 为 false 时始终为 None。
    pub image_base64: Option<String>,
    /// 剪贴板里的纯文本(少数平台复制文件时只留 file:// 文本)。
    pub text: Option<String>,
}

/// 读取系统剪贴板里的媒体内容。
///
/// `include_image` 为 false 时只做轻量探测(不把位图编码成 PNG)，
/// 供「判断上一次复制的是不是本地文件」这类只比对指纹的场景使用。
#[tauri::command]
pub async fn read_clipboard_media(include_image: bool) -> Result<ClipboardMediaSnapshot, String> {
    // arboard 是阻塞式 API，别占住 async runtime。
    tauri::async_runtime::spawn_blocking(move || read_clipboard_media_blocking(include_image))
        .await
        .map_err(|error| format!("读取系统剪贴板失败：{error}"))?
}

fn read_clipboard_media_blocking(include_image: bool) -> Result<ClipboardMediaSnapshot, String> {
    let mut clipboard = Clipboard::new().map_err(|error| format!("无法访问系统剪贴板：{error}"))?;

    // 复制本地文件时粘贴板里是文件 URL 列表(访达 / 资源管理器都走这条)。
    let file_paths = clipboard
        .get()
        .file_list()
        .map(|paths| {
            paths
                .into_iter()
                .map(|path| path.to_string_lossy().to_string())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let text = clipboard
        .get_text()
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let mut has_image = false;
    let mut image_base64 = None;

    // 已经有文件列表就不再读位图：复制图片文件时粘贴板常常同时带一份位图表示，
    // 两个都读会让一次粘贴落下两份内容。
    if file_paths.is_empty() {
        if let Ok(bitmap) = clipboard.get().image() {
            has_image = true;
            if include_image {
                image_base64 =
                    encode_rgba_png_base64(bitmap.width, bitmap.height, bitmap.bytes.as_ref());
            }
        }
    }

    let snapshot = ClipboardMediaSnapshot {
        file_paths,
        has_image,
        image_base64,
        text,
    };

    // 只记数量与标志，不落剪贴板内容；出问题时可以从日志确认这条链路有没有被调用。
    tracing::debug!(
        include_image,
        files = snapshot.file_paths.len(),
        has_image = snapshot.has_image,
        has_text = snapshot.text.is_some(),
        "read_clipboard_media"
    );

    Ok(snapshot)
}

fn encode_rgba_png_base64(width: usize, height: usize, bytes: &[u8]) -> Option<String> {
    if width == 0 || height == 0 {
        return None;
    }

    let image = image::RgbaImage::from_raw(width as u32, height as u32, bytes.to_vec())?;
    let mut buffer = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image)
        .write_to(&mut buffer, image::ImageFormat::Png)
        .ok()?;
    Some(STANDARD.encode(buffer.into_inner()))
}
