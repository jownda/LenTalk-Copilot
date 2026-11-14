use base64::{engine::general_purpose::STANDARD, Engine};
use ab_glyph::{FontArc, PxScale};
use arboard::{Clipboard, ImageData};
use directories::UserDirs;
use fast_image_resize as fir;
use fast_image_resize::images::Image as FirImage;
use image::{DynamicImage, GenericImageView, ImageReader, Rgba, RgbaImage};
use imageproc::drawing::{draw_text_mut, text_size};
use md5;
use png::{BitDepth, ColorType, Decoder, Encoder};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::collections::HashMap;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tracing::{debug, info};

use super::media_output;

const STORYBOARD_METADATA_PNG_TEXT_KEY: &str = "StoryboardCopilotMetadata";
const FAST_PREVIEW_BYPASS_MAX_BYTES: usize = 2_000_000;
const FAST_PREVIEW_BYPASS_MAX_DIMENSION: u32 = 2048;
const REMOTE_IMAGE_DOWNLOAD_ATTEMPTS: usize = 3;

/// 远端媒体的下载预算。
///
/// 图片和视频不能用同一套参数：图片小、要快，且生成服务的 CDN 在压缩传输或 HTTP/2
/// 连接复用期间会中断响应体，所以限 HTTP/1.1 + 短超时 + 多试几次；视频动辄几十 MB，
/// 45 秒和 HTTP/1.1 都会把它自己掐断，必须放宽时长、允许 HTTP/2、少重试
/// （重试一次要再花一份流量）。
#[derive(Clone, Copy)]
struct DownloadBudget {
    connect_timeout: std::time::Duration,
    request_timeout: std::time::Duration,
    http1_only: bool,
    attempts: usize,
}

const IMAGE_DOWNLOAD_BUDGET: DownloadBudget = DownloadBudget {
    connect_timeout: std::time::Duration::from_secs(10),
    request_timeout: std::time::Duration::from_secs(45),
    http1_only: true,
    attempts: REMOTE_IMAGE_DOWNLOAD_ATTEMPTS,
};

const VIDEO_DOWNLOAD_BUDGET: DownloadBudget = DownloadBudget {
    connect_timeout: std::time::Duration::from_secs(15),
    request_timeout: std::time::Duration::from_secs(600),
    http1_only: false,
    attempts: 2,
};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryboardImageMetadata {
    pub grid_rows: u32,
    pub grid_cols: u32,
    pub frame_notes: Vec<String>,
}

#[tauri::command]
pub async fn split_image(
    image_base64: String,
    rows: u32,
    cols: u32,
    line_thickness: Option<u32>,
    col_fractions: Option<Vec<f32>>,
    row_fractions: Option<Vec<f32>>,
) -> Result<Vec<String>, String> {
    let safe_rows = rows.max(1);
    let safe_cols = cols.max(1);
    let requested_line = line_thickness.unwrap_or(0);

    info!(
        "Splitting image into {}x{}, line thickness={}",
        safe_rows, safe_cols, requested_line
    );

    let image_data = STANDARD
        .decode(&image_base64)
        .map_err(|e| format!("Failed to decode base64: {}", e))?;

    let img =
        image::load_from_memory(&image_data).map_err(|e| format!("Failed to load image: {}", e))?;

    let (width, height) = img.dimensions();
    let resolved_line = resolve_line_thickness(width, height, safe_rows, safe_cols, requested_line);
    let usable_width = width.saturating_sub((safe_cols.saturating_sub(1)).saturating_mul(resolved_line));
    let usable_height = height.saturating_sub((safe_rows.saturating_sub(1)).saturating_mul(resolved_line));

    if usable_width < safe_cols || usable_height < safe_rows {
        return Err("分割线过粗，无法完成切割".to_string());
    }

    let column_widths = match &col_fractions {
        Some(fractions) if fractions.len() == safe_cols as usize => {
            split_sizes_with_fractions(usable_width, fractions)
        }
        _ => split_sizes(usable_width, safe_cols),
    };
    let row_heights = match &row_fractions {
        Some(fractions) if fractions.len() == safe_rows as usize => {
            split_sizes_with_fractions(usable_height, fractions)
        }
        _ => split_sizes(usable_height, safe_rows),
    };

    let mut x_offsets = Vec::with_capacity(safe_cols as usize);
    let mut cursor_x = 0_u32;
    for col in 0..safe_cols {
        x_offsets.push(cursor_x);
        cursor_x = cursor_x.saturating_add(column_widths[col as usize]);
        if col < safe_cols - 1 {
            cursor_x = cursor_x.saturating_add(resolved_line);
        }
    }

    let mut y_offsets = Vec::with_capacity(safe_rows as usize);
    let mut cursor_y = 0_u32;
    for row in 0..safe_rows {
        y_offsets.push(cursor_y);
        cursor_y = cursor_y.saturating_add(row_heights[row as usize]);
        if row < safe_rows - 1 {
            cursor_y = cursor_y.saturating_add(resolved_line);
        }
    }

    let mut results = Vec::new();

    for row in 0..safe_rows {
        for col in 0..safe_cols {
            let x = x_offsets[col as usize];
            let y = y_offsets[row as usize];
            let width = column_widths[col as usize];
            let height = row_heights[row as usize];

            let cropped = img.crop_imm(x, y, width, height);

            let mut buffer = Cursor::new(Vec::new());
            cropped
                .write_to(&mut buffer, image::ImageFormat::Png)
                .map_err(|e| format!("Failed to encode cropped image: {}", e))?;

            let base64_data = STANDARD.encode(buffer.get_ref());
            results.push(format!("data:image/png;base64,{}", base64_data));
        }
    }

    info!("Split into {} images", results.len());
    Ok(results)
}

#[tauri::command]
pub async fn split_image_source(
    app: AppHandle,
    source: String,
    rows: u32,
    cols: u32,
    line_thickness: Option<u32>,
    col_fractions: Option<Vec<f32>>,
    row_fractions: Option<Vec<f32>>,
) -> Result<Vec<String>, String> {
    let started = Instant::now();
    let trimmed_source = source.trim();
    if trimmed_source.is_empty() {
        return Err("Image source is empty".to_string());
    }

    let safe_rows = rows.max(1);
    let safe_cols = cols.max(1);
    let requested_line = line_thickness.unwrap_or(0);

    info!(
        "Splitting source image into {}x{}, line thickness={}",
        safe_rows, safe_cols, requested_line
    );

    let (source_bytes, _source_ext) = resolve_source_bytes(trimmed_source).await?;
    let decode_done = Instant::now();
    let image = image::load_from_memory(&source_bytes)
        .map_err(|e| format!("Failed to decode source image: {}", e))?;

    let (width, height) = image.dimensions();
    let resolved_line = resolve_line_thickness(width, height, safe_rows, safe_cols, requested_line);
    let usable_width = width.saturating_sub((safe_cols.saturating_sub(1)).saturating_mul(resolved_line));
    let usable_height = height.saturating_sub((safe_rows.saturating_sub(1)).saturating_mul(resolved_line));

    if usable_width < safe_cols || usable_height < safe_rows {
        return Err("分割线过粗，无法完成切割".to_string());
    }

    let column_widths = match &col_fractions {
        Some(fractions) if fractions.len() == safe_cols as usize => {
            split_sizes_with_fractions(usable_width, fractions)
        }
        _ => split_sizes(usable_width, safe_cols),
    };
    let row_heights = match &row_fractions {
        Some(fractions) if fractions.len() == safe_rows as usize => {
            split_sizes_with_fractions(usable_height, fractions)
        }
        _ => split_sizes(usable_height, safe_rows),
    };

    let mut x_offsets = Vec::with_capacity(safe_cols as usize);
    let mut cursor_x = 0_u32;
    for col in 0..safe_cols {
        x_offsets.push(cursor_x);
        cursor_x = cursor_x.saturating_add(column_widths[col as usize]);
        if col < safe_cols - 1 {
            cursor_x = cursor_x.saturating_add(resolved_line);
        }
    }

    let mut y_offsets = Vec::with_capacity(safe_rows as usize);
    let mut cursor_y = 0_u32;
    for row in 0..safe_rows {
        y_offsets.push(cursor_y);
        cursor_y = cursor_y.saturating_add(row_heights[row as usize]);
        if row < safe_rows - 1 {
            cursor_y = cursor_y.saturating_add(resolved_line);
        }
    }

    let mut results = Vec::with_capacity((safe_rows * safe_cols) as usize);

    for row in 0..safe_rows {
        for col in 0..safe_cols {
            let x = x_offsets[col as usize];
            let y = y_offsets[row as usize];
            let width = column_widths[col as usize];
            let height = row_heights[row as usize];
            let cropped = image.crop_imm(x, y, width, height);

            let mut buffer = Cursor::new(Vec::new());
            cropped
                .write_to(&mut buffer, image::ImageFormat::Png)
                .map_err(|e| format!("Failed to encode split image: {}", e))?;

            let persisted = persist_image_bytes(&app, buffer.get_ref(), "png")?;
            results.push(persisted);
        }
    }

    info!(
        "split_image_source done: {} frames, decode={}ms, total={}ms",
        results.len(),
        decode_done.duration_since(started).as_millis(),
        started.elapsed().as_millis()
    );

    Ok(results)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeStoryboardImagesPayload {
    pub frame_sources: Vec<String>,
    pub rows: u32,
    pub cols: u32,
    pub cell_gap: u32,
    pub outer_padding: u32,
    pub note_height: u32,
    pub font_size: u32,
    pub background_color: String,
    pub max_dimension: u32,
    pub show_frame_index: Option<bool>,
    pub show_frame_note: Option<bool>,
    pub note_placement: Option<String>,
    pub image_fit: Option<String>,
    pub frame_index_prefix: Option<String>,
    pub text_color: Option<String>,
    pub frame_notes: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeStoryboardImagesResult {
    pub image_path: String,
    pub canvas_width: u32,
    pub canvas_height: u32,
    pub cell_width: u32,
    pub cell_height: u32,
    pub gap: u32,
    pub padding: u32,
    pub note_height: u32,
    pub font_size: u32,
    pub text_overlay_applied: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareNodeImageResult {
    pub image_path: String,
    pub preview_image_path: String,
    pub aspect_ratio: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CropImageSourcePayload {
    pub source: String,
    pub aspect_ratio: Option<String>,
    pub crop_x: Option<f64>,
    pub crop_y: Option<f64>,
    pub crop_width: Option<f64>,
    pub crop_height: Option<f64>,
}

fn split_sizes(total: u32, segments: u32) -> Vec<u32> {
    let safe_segments = segments.max(1);
    let base = total / safe_segments;
    let remainder = total % safe_segments;

    (0..safe_segments)
        .map(|index| base + if index < remainder { 1 } else { 0 })
        .collect()
}

fn split_sizes_with_fractions(total: u32, fractions: &[f32]) -> Vec<u32> {
    if fractions.is_empty() {
        return split_sizes(total, 1);
    }
    let mut sizes: Vec<u32> = fractions
        .iter()
        .map(|fraction| (total as f32 * fraction.max(0.0)).floor() as u32)
        .collect();
    let sum: u32 = sizes.iter().sum();
    if sum < total {
        if let Some(last) = sizes.last_mut() {
            *last += total - sum;
        }
    }
    sizes
}


fn gcd_u32(a: u32, b: u32) -> u32 {
    let mut x = a.max(1);
    let mut y = b.max(1);

    while y != 0 {
        let temp = y;
        y = x % y;
        x = temp;
    }

    x.max(1)
}

fn reduce_aspect_ratio(width: u32, height: u32) -> String {
    let safe_width = width.max(1);
    let safe_height = height.max(1);
    let gcd = gcd_u32(safe_width, safe_height);
    format!("{}:{}", safe_width / gcd, safe_height / gcd)
}

fn parse_aspect_ratio(value: &str) -> Option<f64> {
    let trimmed = value.trim();
    if trimmed.eq_ignore_ascii_case("free") || trimmed.is_empty() {
        return None;
    }

    let (w, h) = trimmed.split_once(':')?;
    let width = w.trim().parse::<f64>().ok()?;
    let height = h.trim().parse::<f64>().ok()?;
    if width <= 0.0 || height <= 0.0 {
        return None;
    }

    Some(width / height)
}

fn resolve_line_thickness(
    image_width: u32,
    image_height: u32,
    rows: u32,
    cols: u32,
    line_thickness: u32,
) -> u32 {
    if line_thickness == 0 {
        return 0;
    }

    let max_by_width = if cols > 1 {
        image_width.saturating_sub(cols) / (cols - 1)
    } else {
        line_thickness
    };
    let max_by_height = if rows > 1 {
        image_height.saturating_sub(rows) / (rows - 1)
    } else {
        line_thickness
    };
    line_thickness.min(max_by_width.min(max_by_height))
}

fn parse_hex_color(color: &str) -> Rgba<u8> {
    let value = color.trim().trim_start_matches('#');
    let parse_pair = |start: usize| -> Option<u8> {
        u8::from_str_radix(value.get(start..start + 2)?, 16).ok()
    };

    match value.len() {
        6 => {
            let (Some(r), Some(g), Some(b)) = (parse_pair(0), parse_pair(2), parse_pair(4)) else {
                return Rgba([15, 17, 21, 255]);
            };
            Rgba([r, g, b, 255])
        }
        8 => {
            let (Some(r), Some(g), Some(b), Some(a)) = (
                parse_pair(0),
                parse_pair(2),
                parse_pair(4),
                parse_pair(6),
            ) else {
                return Rgba([15, 17, 21, 255]);
            };
            Rgba([r, g, b, a])
        }
        _ => Rgba([15, 17, 21, 255]),
    }
}

static OVERLAY_FONT: OnceLock<Option<FontArc>> = OnceLock::new();

fn load_overlay_font() -> Option<&'static FontArc> {
    OVERLAY_FONT
        .get_or_init(|| {
            #[cfg(target_os = "windows")]
            let candidate_paths = [
                // Prefer Microsoft YaHei for CJK readability.
                "C:\\Windows\\Fonts\\msyh.ttc",
                "C:\\Windows\\Fonts\\msyhbd.ttc",
                "C:\\Windows\\Fonts\\msyhl.ttc",
                "C:\\Windows\\Fonts\\simhei.ttf",
                // Fallback Latin fonts.
                "C:\\Windows\\Fonts\\segoeui.ttf",
                "C:\\Windows\\Fonts\\arial.ttf",
            ];

            #[cfg(target_os = "macos")]
            let candidate_paths = [
                // Prefer PingFang for CJK readability.
                "/System/Library/Fonts/PingFang.ttc",
                "/System/Library/Fonts/Hiragino Sans GB.ttc",
                "/System/Library/Fonts/STHeiti Medium.ttc",
                // Fallback.
                "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
                "/System/Library/Fonts/Supplemental/Arial.ttf",
            ];

            #[cfg(not(any(target_os = "windows", target_os = "macos")))]
            let candidate_paths = [
                "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
                "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
                "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
                "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            ];

            for path in candidate_paths {
                if let Ok(bytes) = std::fs::read(path) {
                    if let Ok(font) = FontArc::try_from_vec(bytes) {
                        info!("Loaded storyboard overlay font from {}", path);
                        return Some(font);
                    }
                }
            }

            info!("No suitable system font found for storyboard text overlay");
            None
        })
        .as_ref()
}

fn trim_text_to_width(font: &FontArc, scale: PxScale, text: &str, max_width: u32) -> String {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let safe_text = normalized.trim();
    if safe_text.is_empty() {
        return String::new();
    }

    if text_size(scale, font, safe_text).0 <= max_width {
        return safe_text.to_string();
    }

    let mut content = safe_text.to_string();
    while content.chars().count() > 1 {
        content.pop();
        let with_ellipsis = format!("{}...", content);
        if text_size(scale, font, &with_ellipsis).0 <= max_width {
            return with_ellipsis;
        }
    }

    "...".to_string()
}

fn fill_rect(image: &mut RgbaImage, x: u32, y: u32, width: u32, height: u32, color: Rgba<u8>) {
    if width == 0 || height == 0 {
        return;
    }

    let max_x = (x.saturating_add(width)).min(image.width());
    let max_y = (y.saturating_add(height)).min(image.height());

    for yy in y..max_y {
        for xx in x..max_x {
            image.put_pixel(xx, yy, color);
        }
    }
}

fn blend_pixel(bottom: Rgba<u8>, top: Rgba<u8>) -> Rgba<u8> {
    let top_a = top[3] as u16;
    if top_a == 0 {
        return bottom;
    }
    if top_a == 255 {
        return top;
    }

    let bottom_a = bottom[3] as u16;
    let inv_top_a = 255_u16.saturating_sub(top_a);

    let out_a = top_a + (bottom_a * inv_top_a + 127) / 255;
    if out_a == 0 {
        return Rgba([0, 0, 0, 0]);
    }

    let blend_channel = |bottom_c: u8, top_c: u8| -> u8 {
        let bottom_premul = bottom_c as u32 * bottom_a as u32;
        let top_premul = top_c as u32 * top_a as u32;
        let out_premul = top_premul + ((bottom_premul * inv_top_a as u32 + 127) / 255);
        let out = (out_premul + (out_a as u32 / 2)) / out_a as u32;
        out.min(255) as u8
    };

    Rgba([
        blend_channel(bottom[0], top[0]),
        blend_channel(bottom[1], top[1]),
        blend_channel(bottom[2], top[2]),
        out_a as u8,
    ])
}

fn fill_rect_alpha_blend(
    image: &mut RgbaImage,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    color: Rgba<u8>,
) {
    if width == 0 || height == 0 {
        return;
    }

    let max_x = (x.saturating_add(width)).min(image.width());
    let max_y = (y.saturating_add(height)).min(image.height());

    for yy in y..max_y {
        for xx in x..max_x {
            let current = *image.get_pixel(xx, yy);
            image.put_pixel(xx, yy, blend_pixel(current, color));
        }
    }
}

fn stroke_right_edge(image: &mut RgbaImage, x: u32, y: u32, width: u32, height: u32, color: Rgba<u8>) {
    if width < 1 || height < 1 {
        return;
    }

    let x2 = x.saturating_add(width.saturating_sub(1));
    if x2 >= image.width() {
        return;
    }

    let max_y = y.saturating_add(height).min(image.height());
    for yy in y..max_y {
        if yy < image.height() {
            image.put_pixel(x2, yy, color);
        }
    }
}

fn stroke_bottom_edge(image: &mut RgbaImage, x: u32, y: u32, width: u32, height: u32, color: Rgba<u8>) {
    if width < 1 || height < 1 {
        return;
    }

    let y2 = y.saturating_add(height.saturating_sub(1));
    if y2 >= image.height() {
        return;
    }

    let max_x = x.saturating_add(width).min(image.width());
    for xx in x..max_x {
        if xx < image.width() {
            image.put_pixel(xx, y2, color);
        }
    }
}

fn resize_image_fast(source: &DynamicImage, target_width: u32, target_height: u32) -> Result<RgbaImage, String> {
    let source_rgba = source.to_rgba8();
    let source_width = source_rgba.width().max(1);
    let source_height = source_rgba.height().max(1);
    let source_pixels = source_rgba.into_raw();

    let source_image = FirImage::from_vec_u8(
        source_width,
        source_height,
        source_pixels,
        fir::PixelType::U8x4,
    )
    .map_err(|e| format!("Failed to create source image for fast resize: {}", e))?;
    let mut target_image =
        FirImage::new(target_width.max(1), target_height.max(1), fir::PixelType::U8x4);

    let mut resizer = fir::Resizer::new();
    let resize_options =
        fir::ResizeOptions::new().resize_alg(fir::ResizeAlg::Convolution(fir::FilterType::Bilinear));
    resizer
        .resize(&source_image, &mut target_image, Some(&resize_options))
        .map_err(|e| format!("Failed to run fast image resize: {}", e))?;

    RgbaImage::from_raw(target_width.max(1), target_height.max(1), target_image.into_vec())
        .ok_or_else(|| "Failed to build RGBA image from resized buffer".to_string())
}

async fn load_dynamic_image_from_source(source: &str) -> Result<DynamicImage, String> {
    let (bytes, _extension) = resolve_source_bytes(source).await?;
    image::load_from_memory(&bytes).map_err(|e| format!("Failed to decode image source: {}", e))
}

/// 读图并**套用 EXIF 方向**，专供裁剪使用。
///
/// 🔴 坐标系必须和前端一致。浏览器渲染 `<img>` 时会先按 EXIF Orientation 旋转，
/// `naturalWidth/naturalHeight` 与用户看到的画面都是「已旋转」的；而
/// `image::load_from_memory` 只按原始像素解，对带方向标签的照片（手机竖拍常见，
/// Orientation=6/8）会差一个 90° 转置。前端算好的裁剪矩形落在「旋转后」坐标系，
/// 后端在「未旋转」坐标系里切 —— 切出来就是完全另一块内容（实报：裁的是右边人物，
/// 出来是左上角一块）。
///
/// 所以裁剪链路单独走这个 loader：先取 decoder 的 orientation，解完再 apply。
/// 其它链路（分镜合并、拼图）仍用 `load_dynamic_image_from_source`，避免连带改行为。
async fn load_dynamic_image_for_crop(source: &str) -> Result<DynamicImage, String> {
    use image::ImageDecoder;

    let (bytes, _extension) = resolve_source_bytes(source).await?;
    let reader = ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|e| format!("Failed to guess image format: {}", e))?;
    let mut decoder = reader
        .into_decoder()
        .map_err(|e| format!("Failed to open image decoder: {}", e))?;
    // 没有 EXIF 的图（AI 生成图、PNG 截图）返回 NoTransforms，等于不处理。
    let orientation = decoder.orientation().unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut image = DynamicImage::from_decoder(decoder)
        .map_err(|e| format!("Failed to decode image source: {}", e))?;
    image.apply_orientation(orientation);
    Ok(image)
}

fn clamp_f64(value: f64, min: f64, max: f64) -> f64 {
    value.max(min).min(max)
}

fn prepare_node_image_from_bytes(
    app: &AppHandle,
    bytes: &[u8],
    extension: &str,
    safe_max_dimension: u32,
    trace_tag: &str,
) -> Result<PrepareNodeImageResult, String> {
    let started = Instant::now();
    let probe_started = Instant::now();
    let (raw_width, raw_height) = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| format!("Failed to guess image format: {}", e))?
        .into_dimensions()
        .map_err(|e| format!("Failed to parse image dimensions: {}", e))?;
    let probe_elapsed = probe_started.elapsed().as_millis();
    let width = raw_width.max(1);
    let height = raw_height.max(1);

    let persist_started = Instant::now();
    let image_path = persist_image_bytes(app, bytes, extension)?;
    let persist_elapsed = persist_started.elapsed().as_millis();
    let longest_side = width.max(height);
    let bypass_preview = longest_side <= safe_max_dimension
        || (bytes.len() <= FAST_PREVIEW_BYPASS_MAX_BYTES
            && longest_side <= FAST_PREVIEW_BYPASS_MAX_DIMENSION);
    if bypass_preview {
        info!(
            "prepare_node_image done [{}]: bytes={}, ext={}, size={}x{}, max_preview={}, probe={}ms, decode=0ms, persist_original={}ms, resize=0ms, bypass_preview=true, total={}ms",
            trace_tag,
            bytes.len(),
            extension,
            width,
            height,
            safe_max_dimension,
            probe_elapsed,
            persist_elapsed,
            started.elapsed().as_millis()
        );
        return Ok(PrepareNodeImageResult {
            image_path: image_path.clone(),
            preview_image_path: image_path,
            aspect_ratio: reduce_aspect_ratio(width, height),
        });
    }

    let decode_started = Instant::now();
    let image = image::load_from_memory(bytes)
        .map_err(|e| format!("Failed to decode image source: {}", e))?;
    let decode_elapsed = decode_started.elapsed().as_millis();

    let resize_started = Instant::now();
    let scale = safe_max_dimension as f64 / longest_side as f64;
    let target_width = ((width as f64) * scale).round().max(1.0) as u32;
    let target_height = ((height as f64) * scale).round().max(1.0) as u32;
    let resized_rgba = resize_image_fast(&image, target_width, target_height)
        .unwrap_or_else(|_| {
            image
                .resize(target_width, target_height, image::imageops::FilterType::Triangle)
                .to_rgba8()
        });
    let resized = DynamicImage::ImageRgba8(resized_rgba);

    let mut preview_buffer = Cursor::new(Vec::new());
    resized
        .write_to(&mut preview_buffer, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode preview image: {}", e))?;
    let preview_image_path = persist_image_bytes(app, preview_buffer.get_ref(), "png")?;
    let resize_elapsed = resize_started.elapsed().as_millis();

    info!(
        "prepare_node_image done [{}]: bytes={}, ext={}, size={}x{}, max_preview={}, probe={}ms, decode={}ms, persist_original={}ms, resize={}ms, total={}ms",
        trace_tag,
        bytes.len(),
        extension,
        width,
        height,
        safe_max_dimension,
        probe_elapsed,
        decode_elapsed,
        persist_elapsed,
        resize_elapsed,
        started.elapsed().as_millis()
    );

    Ok(PrepareNodeImageResult {
        image_path,
        preview_image_path,
        aspect_ratio: reduce_aspect_ratio(width, height),
    })
}

#[tauri::command]
pub async fn prepare_node_image_source(
    app: AppHandle,
    source: String,
    max_preview_dimension: Option<u32>,
) -> Result<PrepareNodeImageResult, String> {
    let started = Instant::now();
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("Image source is empty".to_string());
    }

    let safe_max_dimension = max_preview_dimension.unwrap_or(512).clamp(64, 4096);
    let resolve_started = Instant::now();
    let (bytes, extension) = resolve_source_bytes(trimmed).await?;
    let resolve_elapsed = resolve_started.elapsed().as_millis();
    let result = prepare_node_image_from_bytes(
        &app,
        &bytes,
        &extension,
        safe_max_dimension,
        "source",
    )?;
    info!(
        "prepare_node_image_source resolved: bytes={}, ext={}, resolve_source={}ms, total={}ms",
        bytes.len(),
        extension,
        resolve_elapsed,
        started.elapsed().as_millis()
    );
    Ok(result)
}

#[tauri::command]
pub async fn prepare_node_image_binary(
    app: AppHandle,
    bytes: Vec<u8>,
    extension: Option<String>,
    max_preview_dimension: Option<u32>,
) -> Result<PrepareNodeImageResult, String> {
    let started = Instant::now();
    if bytes.is_empty() {
        return Err("Image bytes are empty".to_string());
    }

    let safe_max_dimension = max_preview_dimension.unwrap_or(512).clamp(64, 4096);
    let resolved_extension = extension
        .as_deref()
        .map(normalize_extension)
        .unwrap_or_else(|| "png".to_string());

    let result = prepare_node_image_from_bytes(
        &app,
        &bytes,
        &resolved_extension,
        safe_max_dimension,
        "binary",
    )?;
    info!(
        "prepare_node_image_binary resolved: bytes={}, ext={}, total={}ms",
        bytes.len(),
        resolved_extension,
        started.elapsed().as_millis()
    );
    Ok(result)
}

#[tauri::command]
pub async fn crop_image_source(
    app: AppHandle,
    payload: CropImageSourcePayload,
) -> Result<String, String> {
    let trimmed = payload.source.trim();
    if trimmed.is_empty() {
        return Err("Image source is empty".to_string());
    }

    // 裁剪必须用「已按 EXIF 方向摆正」的图，坐标才和前端看到的一致。
    let source_image = load_dynamic_image_for_crop(trimmed).await?;
    let source_width = source_image.width() as f64;
    let source_height = source_image.height() as f64;

    let crop_x = payload.crop_x.unwrap_or(f64::NAN);
    let crop_y = payload.crop_y.unwrap_or(f64::NAN);
    let crop_width_option = payload.crop_width.unwrap_or(f64::NAN);
    let crop_height_option = payload.crop_height.unwrap_or(f64::NAN);
    let has_manual_crop = crop_x.is_finite()
        && crop_y.is_finite()
        && crop_width_option.is_finite()
        && crop_height_option.is_finite()
        && crop_width_option > 0.0
        && crop_height_option > 0.0;

    let aspect_ratio = payload
        .aspect_ratio
        .as_deref()
        .unwrap_or("1:1")
        .trim()
        .to_string();
    let target_ratio = parse_aspect_ratio(&aspect_ratio);

    let (offset_x, offset_y, crop_width, crop_height) = if has_manual_crop {
        let safe_x = clamp_f64(crop_x.floor(), 0.0, (source_width - 1.0).max(0.0));
        let safe_y = clamp_f64(crop_y.floor(), 0.0, (source_height - 1.0).max(0.0));
        let safe_width = clamp_f64(crop_width_option.floor(), 1.0, source_width - safe_x);
        let safe_height = clamp_f64(crop_height_option.floor(), 1.0, source_height - safe_y);
        (safe_x, safe_y, safe_width, safe_height)
    } else if aspect_ratio.eq_ignore_ascii_case("free") {
        (0.0, 0.0, source_width, source_height)
    } else if let Some(ratio) = target_ratio {
        let source_ratio = source_width / source_height;
        if source_ratio > ratio {
            let width = source_height * ratio;
            ((source_width - width) / 2.0, 0.0, width, source_height)
        } else {
            let height = source_width / ratio;
            (0.0, (source_height - height) / 2.0, source_width, height)
        }
    } else {
        (0.0, 0.0, source_width, source_height)
    };

    let final_x = offset_x.floor().max(0.0) as u32;
    let final_y = offset_y.floor().max(0.0) as u32;
    let max_crop_width = source_image.width().saturating_sub(final_x).max(1);
    let max_crop_height = source_image.height().saturating_sub(final_y).max(1);
    let final_width = (crop_width.floor().max(1.0) as u32).min(max_crop_width);
    let final_height = (crop_height.floor().max(1.0) as u32).min(max_crop_height);

    let cropped = source_image.crop_imm(final_x, final_y, final_width, final_height);
    let mut buffer = Cursor::new(Vec::new());
    cropped
        .write_to(&mut buffer, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode cropped image: {}", e))?;

    persist_image_bytes(&app, buffer.get_ref(), "png")
}

#[tauri::command]
pub async fn merge_storyboard_images(
    app: AppHandle,
    payload: MergeStoryboardImagesPayload,
) -> Result<MergeStoryboardImagesResult, String> {
    let started = Instant::now();
    let rows = payload.rows.max(1);
    let cols = payload.cols.max(1);
    let total_cells = rows.saturating_mul(cols) as usize;

    let mut frames: Vec<Option<DynamicImage>> = Vec::with_capacity(total_cells);
    let mut reference_size: Option<(u32, u32)> = None;

    for index in 0..total_cells {
        let source = payload
            .frame_sources
            .get(index)
            .map(|value| value.trim())
            .unwrap_or("");

        if source.is_empty() {
            frames.push(None);
            continue;
        }

        match load_dynamic_image_from_source(source).await {
            Ok(image) => {
                if reference_size.is_none() {
                    reference_size = Some((image.width().max(1), image.height().max(1)));
                }
                frames.push(Some(image));
            }
            Err(_) => {
                frames.push(None);
            }
        }
    }
    let load_done = Instant::now();

    let (source_cell_width, source_cell_height) =
        reference_size.ok_or_else(|| "没有可导出的图片".to_string())?;

    let raw_gap = payload.cell_gap.min(240);
    let raw_padding = payload.outer_padding.min(360);
    let raw_note_height = payload.note_height.min(360);
    let raw_font_size = payload.font_size.clamp(10, 240);
    let max_dimension = payload.max_dimension.clamp(1024, 8192);
    let show_frame_index = payload.show_frame_index.unwrap_or(false);
    let show_frame_note = payload.show_frame_note.unwrap_or(false);
    let note_placement = payload
        .note_placement
        .as_deref()
        .unwrap_or("overlay")
        .to_ascii_lowercase();
    let image_fit = payload
        .image_fit
        .as_deref()
        .unwrap_or("cover")
        .to_ascii_lowercase();
    let use_cover_fit = image_fit != "contain";
    let frame_index_prefix = payload
        .frame_index_prefix
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("S")
        .to_string();
    let text_color = parse_hex_color(payload.text_color.as_deref().unwrap_or("#f8fafc"));
    let frame_notes = payload.frame_notes.unwrap_or_default();
    let overlay_requested = show_frame_index || show_frame_note;

    let raw_output_width = raw_padding as u64 * 2
        + cols as u64 * source_cell_width as u64
        + cols.saturating_sub(1) as u64 * raw_gap as u64;
    let raw_output_height = raw_padding as u64 * 2
        + rows as u64 * (source_cell_height as u64 + raw_note_height as u64)
        + rows.saturating_sub(1) as u64 * raw_gap as u64;

    let longest_side = raw_output_width.max(raw_output_height).max(1) as f64;
    let scale = (max_dimension as f64 / longest_side).min(1.0);

    let cell_width = ((source_cell_width as f64) * scale).round().max(8.0) as u32;
    let cell_height = ((source_cell_height as f64) * scale).round().max(8.0) as u32;
    let gap = ((raw_gap as f64) * scale).round().max(0.0) as u32;
    let padding = ((raw_padding as f64) * scale).round().max(0.0) as u32;
    let note_height = ((raw_note_height as f64) * scale).round().max(0.0) as u32;
    let font_size = ((raw_font_size as f64) * scale).round().max(9.0) as u32;

    let output_width = padding.saturating_mul(2)
        + cols.saturating_mul(cell_width)
        + cols.saturating_sub(1).saturating_mul(gap);
    let output_height = padding.saturating_mul(2)
        + rows.saturating_mul(cell_height.saturating_add(note_height))
        + rows.saturating_sub(1).saturating_mul(gap);

    let mut canvas = RgbaImage::from_pixel(
        output_width.max(1),
        output_height.max(1),
        parse_hex_color(&payload.background_color),
    );
    let placeholder = Rgba([0, 0, 0, 90]);
    let border = Rgba([255, 255, 255, 56]);
    let overlay_font = if overlay_requested { load_overlay_font() } else { None };
    let overlay_scale = PxScale::from(font_size.max(9) as f32);
    let text_overlay_applied = !overlay_requested || overlay_font.is_some();

    for index in 0..total_cells {
        let row = (index as u32) / cols;
        let col = (index as u32) % cols;
        let x = padding + col.saturating_mul(cell_width.saturating_add(gap));
        let y = padding + row.saturating_mul(cell_height.saturating_add(note_height).saturating_add(gap));

        fill_rect(&mut canvas, x, y, cell_width, cell_height, placeholder);

        if let Some(frame) = frames.get(index).and_then(|item| item.as_ref()) {
            let src_w = frame.width().max(1) as f64;
            let src_h = frame.height().max(1) as f64;
            let ratio = if use_cover_fit {
                ((cell_width as f64) / src_w).max((cell_height as f64) / src_h)
            } else {
                ((cell_width as f64) / src_w).min((cell_height as f64) / src_h)
            };
            let draw_w = (src_w * ratio).round().max(1.0) as u32;
            let draw_h = (src_h * ratio).round().max(1.0) as u32;

            let mut cell_canvas = RgbaImage::from_pixel(cell_width.max(1), cell_height.max(1), placeholder);
            let draw_x = (cell_width as i64 - draw_w as i64) / 2;
            let draw_y = (cell_height as i64 - draw_h as i64) / 2;

            if draw_w == frame.width() && draw_h == frame.height() {
                image::imageops::overlay(&mut cell_canvas, &frame.to_rgba8(), draw_x, draw_y);
            } else if let Ok(resized_rgba) = resize_image_fast(frame, draw_w, draw_h) {
                image::imageops::overlay(&mut cell_canvas, &resized_rgba, draw_x, draw_y);
            } else {
                // Fallback path keeps behavior correct if SIMD resize fails for unexpected input.
                let resized = frame.resize(draw_w, draw_h, image::imageops::FilterType::Triangle);
                image::imageops::overlay(&mut cell_canvas, &resized.to_rgba8(), draw_x, draw_y);
            }

            image::imageops::overlay(&mut canvas, &cell_canvas, x as i64, y as i64);
        }

        // Keep only internal split lines; do not draw an outer frame around the whole storyboard.
        if col < cols.saturating_sub(1) {
            stroke_right_edge(&mut canvas, x, y, cell_width, cell_height, border);
        }
        if row < rows.saturating_sub(1) {
            stroke_bottom_edge(&mut canvas, x, y, cell_width, cell_height, border);
        }

        if let Some(font) = overlay_font {
            if show_frame_index {
                let label = format!("{}{}", frame_index_prefix, index + 1);
                let (label_w, label_h) = text_size(overlay_scale, font, &label);
                let badge_padding_x = (font_size as f32 * 0.35).round().max(6.0) as u32;
                let badge_height = (font_size as f32 * 1.15).round().max(18.0) as u32;
                let badge_width = label_w.saturating_add(badge_padding_x.saturating_mul(2));
                let badge_x = x.saturating_add(6);
                let badge_y = y.saturating_add(6);

                fill_rect_alpha_blend(
                    &mut canvas,
                    badge_x,
                    badge_y,
                    badge_width,
                    badge_height,
                    Rgba([0, 0, 0, 166]),
                );

                let text_x = badge_x.saturating_add(badge_padding_x) as i32;
                let text_y = badge_y
                    .saturating_add(badge_height.saturating_sub(label_h) / 2)
                    .max(0) as i32;
                draw_text_mut(&mut canvas, text_color, text_x, text_y, overlay_scale, font, &label);
            }

            if show_frame_note {
                let note_raw = frame_notes
                    .get(index)
                    .map(|value| value.trim())
                    .unwrap_or("");
                if !note_raw.is_empty() {
                    let note = trim_text_to_width(font, overlay_scale, note_raw, cell_width.saturating_sub(14));
                    if !note.is_empty() {
                        let (note_w, note_h) = text_size(overlay_scale, font, &note);
                        if note_placement == "bottom" && note_height > 0 {
                            let note_x = x.saturating_add(4) as i32;
                            let note_y = y
                                .saturating_add(cell_height)
                                .saturating_add(note_height.saturating_sub(note_h) / 2)
                                .max(0) as i32;
                            let _ = note_w;
                            draw_text_mut(&mut canvas, text_color, note_x, note_y, overlay_scale, font, &note);
                        } else {
                            let overlay_height = (font_size as f32 * 1.35).round().max(18.0) as u32;
                            let overlay_y = y
                                .saturating_add(cell_height)
                                .saturating_sub(overlay_height);
                            fill_rect_alpha_blend(
                                &mut canvas,
                                x,
                                overlay_y,
                                cell_width,
                                overlay_height,
                                Rgba([0, 0, 0, 153]),
                            );
                            let note_x = x.saturating_add(7) as i32;
                            let note_y = overlay_y
                                .saturating_add(overlay_height.saturating_sub(note_h) / 2)
                                .max(0) as i32;
                            draw_text_mut(&mut canvas, text_color, note_x, note_y, overlay_scale, font, &note);
                        }
                    }
                }
            }
        }
    }

    let mut buffer = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(canvas)
        .write_to(&mut buffer, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode merged storyboard image: {}", e))?;

    let image_path = persist_image_bytes(&app, buffer.get_ref(), "png")?;
    info!(
        "merge_storyboard_images done: {} cells, load={}ms, total={}ms, text_overlay_applied={}",
        total_cells,
        load_done.duration_since(started).as_millis(),
        started.elapsed().as_millis(),
        text_overlay_applied
    );

    Ok(MergeStoryboardImagesResult {
        image_path,
        canvas_width: output_width.max(1),
        canvas_height: output_height.max(1),
        cell_width,
        cell_height,
        gap,
        padding,
        note_height,
        font_size,
        text_overlay_applied,
    })
}

/// 图片的落盘目录。
///
/// 位置本身由 [`media_output`] 决定（「设置 → 通用 → 默认落盘位置」，默认
/// `<系统下载文件夹>/LenTalk/images`）。这里只保留函数名，避免动到十几个调用点。
fn resolve_images_dir(app: &AppHandle) -> Result<PathBuf, String> {
    media_output::media_dir(app, media_output::MediaKind::Image)
}

/// 把字节写进指定目录，文件名取内容 md5（同一份内容只落一次）。
/// 把字节写进目录，文件名优先用**来源名**，没有可读名字才退回内容哈希。
///
/// 以前一律用 `<md5>.<ext>`：去重和幂等都是白送的，但文件名完全不可读 ——
/// 用户在资源管理器里看到 `8e8adbeb1d9d05f875a56a782cce52e1.mp3` 认不出这是什么。
/// 素材多来自资产库或本地导入，名字本来就是用户起的，直接沿用更符合直觉。
///
/// 去重依然保留：**同名且内容相同就复用同一个文件**，同名不同内容才加 `-2`、`-3`。
fn persist_bytes_into(
    dir: &Path,
    bytes: &[u8],
    extension: &str,
    suggested_stem: Option<&str>,
) -> Result<String, String> {
    let extension = normalize_extension(extension);
    let output_path = match suggested_stem.and_then(usable_file_stem) {
        Some(stem) => unique_media_path(dir, &stem, &extension, md5::compute(bytes), bytes.len() as u64),
        // 连名字都没有（平台直接甩回二进制）时仍用内容哈希：至少保证重复请求命中同一个文件。
        None => dir.join(format!("{:x}.{}", md5::compute(bytes), extension)),
    };

    if !output_path.exists() {
        std::fs::write(&output_path, bytes)
            .map_err(|e| format!("Failed to persist generated media: {}", e))?;
    }

    Ok(output_path.to_string_lossy().to_string())
}

/// 清洗后的名字是否可用（`sanitize_file_stem` 的兜底值说明原名其实是空的）。
fn usable_file_stem(raw: &str) -> Option<String> {
    let cleaned = sanitize_file_stem(raw);
    (cleaned != "storyboard-image").then_some(cleaned)
}

/// 在目录里挑一个可用路径：`名字.ext` → 同名但内容不同则 `名字-2.ext` → `名字-3.ext`…
///
/// 同名且**内容一致**时直接返回已有文件，不重复写盘 —— 这样「同一段音频导入两次」
/// 仍然只占一份空间，和内容寻址时的手感一致。
fn unique_media_path(
    dir: &Path,
    stem: &str,
    extension: &str,
    digest: md5::Digest,
    size: u64,
) -> PathBuf {
    for index in 0..1000u32 {
        let name = if index == 0 {
            format!("{stem}.{extension}")
        } else {
            format!("{stem}-{}.{extension}", index + 1)
        };
        let candidate = dir.join(name);
        if !candidate.exists() {
            return candidate;
        }
        let same_size = std::fs::metadata(&candidate)
            .map(|meta| meta.len() == size)
            .unwrap_or(false);
        if same_size && hash_file_md5(&candidate).ok() == Some(digest) {
            return candidate;
        }
    }
    // 同名文件多到离谱（几乎不可能）：用哈希收口，保证还能落盘。
    dir.join(format!("{stem}-{:x}.{extension}", digest))
}

/// 从来源（本地路径 / URL / asset 地址）里取一个可读的文件名主干。
///
/// 取不到就返回 None，由调用方退回内容哈希。
fn suggested_stem_from_source(source: &str) -> Option<String> {
    let trimmed = source.trim();
    if trimmed.is_empty() || trimmed.starts_with("data:") {
        return None;
    }
    let without_fragment = trimmed.split('#').next()?;
    let without_query = without_fragment.split('?').next()?;
    let file_name = without_query.rsplit(['/', '\\']).next()?;
    let stem = Path::new(file_name).file_stem()?.to_str()?;
    // URL 里的中文是百分号编码的，不还原的话名字会变成一串 `%E4%B8%88...`。
    let decoded = urlencoding::decode(stem).ok();
    usable_file_stem(decoded.as_deref().unwrap_or(stem))
}

/// 流式算 md5：本地视频动辄几百 MB，不能为了取名把它整个读进内存。
fn hash_file_md5(path: &Path) -> Result<md5::Digest, String> {
    use std::io::Read;

    let mut file = std::fs::File::open(path)
        .map_err(|error| format!("Failed to open local media for hashing: {error}"))?;
    let mut context = md5::Context::new();
    let mut buffer = vec![0u8; 256 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Failed to read local media for hashing: {error}"))?;
        if read == 0 {
            break;
        }
        context.consume(&buffer[..read]);
    }
    Ok(context.compute())
}

/// 应用自己下载 CLI 产物用的中转目录。
///
/// 这些目录里的文件在搬进落盘目录之后就是纯冗余：没有任何节点再指向它们，
/// 但不清的话每生成一条视频就多留一份 —— `jimeng-cli\videos` 实测已经堆到 1.8 GB。
fn app_managed_temp_roots(app: &AppHandle) -> Vec<PathBuf> {
    match app.path().app_data_dir() {
        Ok(base) => vec![base.join("jimeng-cli")],
        Err(error) => {
            debug!("skip temp cleanup, app data dir unavailable: {error}");
            Vec::new()
        }
    }
}

/// 已搬过的临时源文件备忘：源路径 → 落盘后的路径。
///
/// 为什么需要：同一条产物会被节点上的多个字段引用（`sourcePath` / `videoUrl` / …），
/// 「搬完即删源」之后第二次请求会发现源文件已经不在，`local_media_path` 返回 None，
/// 于是退化成「当成远端地址下载」→ 整条失败。这里记住第一次的结果，同进程内直接命中。
static ADOPTED_TEMP_SOURCES: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn adopted_cache() -> &'static Mutex<HashMap<String, String>> {
    ADOPTED_TEMP_SOURCES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 缓存键只统一分隔符，不动大小写（大小写敏感卷上不能合并两个路径）。
fn adopted_cache_key(source: &str) -> String {
    source.trim().replace('\\', "/")
}

/// 这个源之前搬过、且成品还在 → 直接复用，不用再找源文件。
fn cached_adopted_target(source: &str) -> Option<String> {
    let cache = adopted_cache().lock().ok()?;
    let target = cache.get(&adopted_cache_key(source))?.clone();
    drop(cache);
    Path::new(&target).exists().then_some(target)
}

fn remember_adopted_source(source: &str, target: &str) {
    if let Ok(mut cache) = adopted_cache().lock() {
        // 纯粹是备忘录用，不值得无上限增长。
        if cache.len() > 2048 {
            cache.clear();
        }
        cache.insert(adopted_cache_key(source), target.to_string());
    }
}

/// 搬进落盘目录之后清尾：删源文件、CLI 顺手写在旁边的封面、以及空掉的 run 目录。
///
/// 只对 `cleanup_roots` 里的路径生效 —— 用户自己素材盘里的文件一律不动。
/// 删除错误全部吞掉：源文件可能正被播放器或 CLI 占着，删不掉就留着，
/// 绝不能因为清理失败把这次生成判死（成品已经在落盘目录里了）。
fn cleanup_adopted_source(source: &Path, cleanup_roots: &[PathBuf]) {
    if !cleanup_roots.iter().any(|root| source.starts_with(root)) {
        return;
    }
    // 只清中转目录**下面**的文件，root 自己（或它的直接上级）不许碰。
    if source
        .parent()
        .map(|parent| cleanup_roots.iter().any(|root| root.as_path() == parent))
        .unwrap_or(false)
    {
        return;
    }

    if let Err(error) = std::fs::remove_file(source) {
        debug!("keep adopted source {}: {error}", source.display());
        return;
    }

    // CLI 会把封面写成 `<产物名>.jpg`，前端从不引用，一起清。
    let cover = PathBuf::from(format!("{}.jpg", source.to_string_lossy()));
    let _ = std::fs::remove_file(&cover);

    // 只在目录空了才删；同一 run 还有别的产物就留着。
    if let Some(parent) = source.parent() {
        let _ = std::fs::remove_dir(parent);
    }
}

/// 把「已经在本机、但不在落盘目录里」的媒体搬进落盘目录。
///
/// 现实来源：即梦 CLI / 画布 CLI 会把产物下到
/// `%APPDATA%\com.storyboard.copilot\jimeng-cli\videos\<run_id>\canvas-<run_id>.mp4`
/// 就直接把这个绝对路径返回给前端。它不像 CDN 链接那样会过期，但仍然是「寄居」——
/// 清 AppData、重装、换机都会整批丢，而且完全不归「设置 → 默认落盘位置」管。
///
/// 命名规则与 [`persist_bytes_into`] 一致（内容 md5），所以同一条产物反复经过这里
/// 只会有一个文件；源文件已经在落盘目录里时直接返回原路径，保证幂等。
///
/// `cleanup_roots` 给的是「搬完可以删源」的目录（应用自己的下载中转目录）。
/// 传空数组就是只搬不删，给素材盘里用户自己的文件用。
fn adopt_local_media_file(
    dir: &Path,
    source: &Path,
    cleanup_roots: &[PathBuf],
) -> Result<String, String> {
    if source.parent().map(|parent| parent == dir).unwrap_or(false) {
        return Ok(source.to_string_lossy().to_string());
    }

    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .map(normalize_extension)
        .unwrap_or_else(|| "bin".to_string());
    let digest = hash_file_md5(source)?;
    // 搬进落盘目录时保留原文件名：用户在墙纸/资源管理器里看到的应该是
    // 「丈夫.mp3」而不是「8e8adbeb….mp3」。同名且内容相同则复用，不同才加序号。
    let size = std::fs::metadata(source)
        .map(|meta| meta.len())
        .unwrap_or(0);
    let suggested = source
        .file_stem()
        .and_then(|value| value.to_str())
        .and_then(usable_file_stem);
    let output_path = match suggested {
        Some(stem) => unique_media_path(dir, &stem, &extension, digest, size),
        None => dir.join(format!("{:x}.{}", digest, extension)),
    };
    let source_text = source.to_string_lossy().to_string();

    if !output_path.exists() {
        std::fs::copy(source, &output_path)
            .map_err(|error| format!("Failed to adopt local media into output dir: {error}"))?;
    }
    info!(
        "adopted local media into output dir: {} -> {}",
        source.display(),
        output_path.display()
    );

    let adopted = output_path.to_string_lossy().to_string();
    if cleanup_roots.iter().any(|root| source.starts_with(root)) {
        // 先记账再删源：删完之后的重复请求要靠这条缓存找到成品。
        remember_adopted_source(&source_text, &adopted);
        cleanup_adopted_source(source, cleanup_roots);
    }
    Ok(adopted)
}

/// 这个来源是不是「本机绝对路径」。远端地址、内联数据、asset 协议都不算。
fn local_media_path(source: &str) -> Option<&Path> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("data:")
        || lower.starts_with("blob:")
        || lower.starts_with("asset:")
        || lower.starts_with("//")
    {
        return None;
    }
    let path = Path::new(trimmed);
    if !path.is_absolute() {
        return None;
    }
    path.exists().then_some(path)
}

/// 像本地绝对路径、但文件已经不在了（被移走 / 删除 / 素材库搬过家）。
///
/// 这种情况**不能**再往下载链路走：`resolve_source_bytes` 会把它当"本地源"去读，
/// 最终报一句 `Failed to read local image source: 系统找不到指定的文件。(os error 2)` +
/// 一段"放宽预算重试后仍失败"的内部话术 —— 用户既不知道发生了什么，也不知道该做什么。
fn missing_local_path(source: &str) -> Option<&Path> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("data:")
        || lower.starts_with("blob:")
        || lower.starts_with("asset:")
        || lower.starts_with("//")
        || lower.starts_with("file://")
    {
        return None;
    }
    let path = Path::new(trimmed);
    if !path.is_absolute() {
        return None;
    }
    (!path.exists()).then_some(path)
}

/// 统一的「本地文件已丢失」报错文案。
fn missing_local_message(path: &Path) -> String {
    format!(
        "素材的本地文件已经不存在了（可能被移动或删除）：{}。这个素材无法再保存到本地，请重新上传、重新生成或从素材库重新选一张",
        path.display()
    )
}

/// 生成结果落盘（没有来源名可用，文件名退回内容哈希）。
fn persist_image_bytes(app: &AppHandle, bytes: &[u8], extension: &str) -> Result<String, String> {
    persist_image_bytes_named(app, bytes, extension, None)
}

/// 同上，但可以带一个「建议文件名」——本地导入/资产库来的素材都走这条，
/// 落盘后文件名保持用户能认出来的样子。
fn persist_image_bytes_named(
    app: &AppHandle,
    bytes: &[u8],
    extension: &str,
    suggested_stem: Option<&str>,
) -> Result<String, String> {
    let images_dir = resolve_images_dir(app)?;
    persist_bytes_into(&images_dir, bytes, extension, suggested_stem)
}

/// 按扩展名把字节写进对应的媒体子目录（图片 `images/`、视频 `videos/`、音频 `audio/`）。
fn persist_media_bytes(app: &AppHandle, bytes: &[u8], extension: &str) -> Result<String, String> {
    persist_media_bytes_named(app, bytes, extension, None)
}

/// 同上，带建议文件名（见 [`persist_image_bytes_named`]）。
fn persist_media_bytes_named(
    app: &AppHandle,
    bytes: &[u8],
    extension: &str,
    suggested_stem: Option<&str>,
) -> Result<String, String> {
    // 以内容为准，别只信传进来的扩展名：它上游可能是 MIME（会说谎）、文件名（也可能是错的），
    // 或者干脆没有。判断错了就是「mp3 存成 images/<hash>.png」这种后患。
    let fallback = normalize_extension(extension);
    let extension = sniff_media_extension(bytes).unwrap_or(fallback.as_str());
    let kind = media_output::kind_for_extension(extension);
    let dir = media_output::media_dir(app, kind)?;
    persist_bytes_into(&dir, bytes, extension, suggested_stem)
}

fn normalize_extension(raw_ext: &str) -> String {
    let ext = raw_ext.trim().trim_start_matches('.').to_ascii_lowercase();
    if ext.is_empty() {
        return "png".to_string();
    }

    if ext == "jpeg" {
        return "jpg".to_string();
    }

    ext
}

fn extension_from_mime(mime: &str) -> String {
    let normalized = mime
        .split(';')
        .next()
        .unwrap_or(mime)
        .trim()
        .to_ascii_lowercase();
    match normalized.as_str() {
        "image/png" => "png".to_string(),
        "image/jpeg" => "jpg".to_string(),
        "image/jpg" => "jpg".to_string(),
        "image/webp" => "webp".to_string(),
        "image/gif" => "gif".to_string(),
        "image/bmp" => "bmp".to_string(),
        "image/avif" => "avif".to_string(),
        "video/mp4" | "application/mp4" => "mp4".to_string(),
        "video/webm" => "webm".to_string(),
        "video/quicktime" => "mov".to_string(),
        "video/x-msvideo" => "avi".to_string(),
        "video/x-matroska" => "mkv".to_string(),
        "video/mpeg" => "mpeg".to_string(),
        // 音频是必须的一条。少了它 `audio/mpeg` 会落到下面的兜底 `png`，
        // 结果是 mp3 字节被存成 `images/<hash>.png`：预览裂图，当音色参考还会被服务端拒。
        "audio/mpeg" | "audio/mp3" => "mp3".to_string(),
        "audio/wav" | "audio/x-wav" | "audio/wave" => "wav".to_string(),
        "audio/mp4" | "audio/x-m4a" | "audio/aac" => {
            if normalized == "audio/aac" {
                "aac".to_string()
            } else {
                "m4a".to_string()
            }
        }
        "audio/ogg" | "application/ogg" => "ogg".to_string(),
        "audio/opus" => "opus".to_string(),
        "audio/flac" | "audio/x-flac" => "flac".to_string(),
        "audio/amr" => "amr".to_string(),
        _ => "png".to_string(),
    }
}

/// 按文件头嗅探真实媒体类型。
///
/// 为什么不能只信 MIME / 扩展名：
///   * 不少 CDN 对音频回 `application/octet-stream`，`extension_from_mime` 认不出来就兜底成 png；
///   * 反过来，文件名也可能是错的（历史落盘把 mp3 存成了 `.png`）。
///
/// 一旦把音频存成图片，就会出现「预览裂图 + 当音色参考被拒」这类看不懂的毛病。
pub(crate) fn sniff_media_extension(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() < 12 {
        return None;
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("png");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("jpg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("gif");
    }
    if &bytes[0..4] == b"RIFF" {
        let brand = &bytes[8..12];
        if brand == b"WEBP".as_slice() {
            return Some("webp");
        }
        if brand == b"WAVE".as_slice() {
            return Some("wav");
        }
        return None;
    }
    if bytes.starts_with(b"fLaC") {
        return Some("flac");
    }
    if bytes.starts_with(b"OggS") {
        return Some("ogg");
    }
    if bytes.starts_with(b"ID3") {
        return Some("mp3");
    }
    // MPEG 音频帧同步字（0xFFEx / 0xFFFx）：mp3 没有 ID3 标签时就是这个形状。
    if bytes[0] == 0xFF && (bytes[1] & 0xE0) == 0xE0 {
        return Some("mp3");
    }
    if &bytes[4..8] == b"ftyp" {
        let brand = &bytes[8..12];
        if brand == b"M4A ".as_slice() || brand == b"M4B ".as_slice() {
            return Some("m4a");
        }
        if brand == b"qt  ".as_slice() {
            return Some("mov");
        }
        return Some("mp4");
    }
    if bytes.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        return Some("mkv");
    }
    None
}

fn extension_from_path_like(value: &str) -> Option<String> {
    let cleaned = value
        .split('#')
        .next()
        .unwrap_or(value)
        .split('?')
        .next()
        .unwrap_or(value);
    let ext = Path::new(cleaned)
        .extension()
        .and_then(|item| item.to_str())
        .map(normalize_extension)?;

    Some(ext)
}

fn decode_file_url_path(value: &str) -> String {
    let raw = value.trim_start_matches("file://");
    let decoded = urlencoding::decode(raw)
        .map(|result| result.into_owned())
        .unwrap_or_else(|_| raw.to_string());

    if cfg!(target_os = "windows")
        && decoded.starts_with('/')
        && decoded.len() > 2
        && decoded.as_bytes().get(2) == Some(&b':')
    {
        decoded[1..].to_string()
    } else {
        decoded
    }
}

fn parse_data_url(source: &str) -> Result<(Vec<u8>, String), String> {
    let (meta, payload) = source
        .split_once(',')
        .ok_or_else(|| "Invalid data URL format".to_string())?;

    if !meta.starts_with("data:") || !meta.ends_with(";base64") {
        return Err("Only base64 data URL is supported".to_string());
    }

    let mime = meta
        .strip_prefix("data:")
        .and_then(|v| v.strip_suffix(";base64"))
        .unwrap_or("image/png");

    let bytes = STANDARD
        .decode(payload)
        .map_err(|e| format!("Failed to decode data URL: {}", e))?;

    Ok((bytes, extension_from_mime(mime)))
}

fn read_storyboard_metadata_from_png_bytes(bytes: &[u8]) -> Result<Option<StoryboardImageMetadata>, String> {
    let decoder = Decoder::new(Cursor::new(bytes));
    let reader = decoder
        .read_info()
        .map_err(|e| format!("Failed to decode PNG metadata: {}", e))?;
    let info = reader.info();

    for text_chunk in &info.uncompressed_latin1_text {
        if text_chunk.keyword == STORYBOARD_METADATA_PNG_TEXT_KEY {
            let parsed = serde_json::from_str::<StoryboardImageMetadata>(&text_chunk.text)
                .map_err(|e| format!("Invalid storyboard metadata JSON: {}", e))?;
            return Ok(Some(parsed));
        }
    }

    for text_chunk in &info.utf8_text {
        if text_chunk.keyword == STORYBOARD_METADATA_PNG_TEXT_KEY {
            let text = text_chunk
                .get_text()
                .map_err(|e| format!("Failed to decode iTXt metadata text: {}", e))?;
            let parsed = serde_json::from_str::<StoryboardImageMetadata>(&text)
                .map_err(|e| format!("Invalid storyboard metadata JSON: {}", e))?;
            return Ok(Some(parsed));
        }
    }

    for text_chunk in &info.compressed_latin1_text {
        if text_chunk.keyword == STORYBOARD_METADATA_PNG_TEXT_KEY {
            let text = text_chunk
                .get_text()
                .map_err(|e| format!("Failed to decode zTXt metadata text: {}", e))?;
            let parsed = serde_json::from_str::<StoryboardImageMetadata>(&text)
                .map_err(|e| format!("Invalid storyboard metadata JSON: {}", e))?;
            return Ok(Some(parsed));
        }
    }

    Ok(None)
}

fn encode_png_with_storyboard_metadata(
    image: &DynamicImage,
    metadata: &StoryboardImageMetadata,
) -> Result<Vec<u8>, String> {
    let metadata_json = serde_json::to_string(metadata)
        .map_err(|e| format!("Failed to serialize storyboard metadata: {}", e))?;
    let rgba = image.to_rgba8();
    let width = rgba.width().max(1);
    let height = rgba.height().max(1);
    let mut output = Vec::new();

    {
        let mut encoder = Encoder::new(&mut output, width, height);
        encoder.set_color(ColorType::Rgba);
        encoder.set_depth(BitDepth::Eight);
        encoder
            .add_itxt_chunk(
                STORYBOARD_METADATA_PNG_TEXT_KEY.to_string(),
                metadata_json,
            )
            .map_err(|e| format!("Failed to attach storyboard metadata into PNG: {}", e))?;
        let mut writer = encoder
            .write_header()
            .map_err(|e| format!("Failed to write PNG header: {}", e))?;
        writer
            .write_image_data(rgba.as_raw())
            .map_err(|e| format!("Failed to encode PNG pixels: {}", e))?;
    }

    Ok(output)
}

async fn resolve_source_bytes(source: &str) -> Result<(Vec<u8>, String), String> {
    resolve_source_bytes_with_budget(source, IMAGE_DOWNLOAD_BUDGET).await
}

async fn resolve_source_bytes_with_budget(
    source: &str,
    budget: DownloadBudget,
) -> Result<(Vec<u8>, String), String> {
    if source.starts_with("data:") {
        return parse_data_url(source);
    }

    if source.starts_with("http://") || source.starts_with("https://") {
        // 生成服务的 CDN 有时会在压缩传输或 HTTP/2 连接复用期间中断响应体。
        // 图片下载量很小，使用 HTTP/1.1、原始内容编码并作有限重试更可靠；
        // 视频用另一套预算（见 DownloadBudget），这里不能写死。
        let mut builder = reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(budget.connect_timeout)
            .timeout(budget.request_timeout);
        if budget.http1_only {
            builder = builder.http1_only();
        }
        let client = builder
            .build()
            .map_err(|e| format!("Failed to build media download client: {}", e))?;

        let mut last_error = String::new();
        for attempt in 1..=budget.attempts {
            let response = match client
                .get(source)
                .header(reqwest::header::ACCEPT_ENCODING, "identity")
                .send()
                .await
            {
                Ok(response) => response,
                Err(error) => {
                    last_error = format!("request error: {}", error);
                    if attempt < budget.attempts {
                        tokio::time::sleep(std::time::Duration::from_millis(
                            300 * attempt as u64,
                        ))
                        .await;
                        continue;
                    }
                    break;
                }
            };

            let status = response.status();
            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("unknown")
                .to_string();
            let content_length = response
                .headers()
                .get(reqwest::header::CONTENT_LENGTH)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("unknown")
                .to_string();

            if !status.is_success() {
                return Err(format!(
                    "Remote image request failed with status {} (content-type: {}, content-length: {})",
                    status, content_type, content_length
                ));
            }

            let mime_ext = Some(extension_from_mime(&content_type));
            match response.bytes().await {
                Ok(bytes) if !bytes.is_empty() => {
                    let ext = mime_ext
                        .or_else(|| extension_from_path_like(source))
                        .unwrap_or_else(|| "png".to_string());
                    return Ok((bytes.to_vec(), ext));
                }
                Ok(_) => {
                    last_error = format!(
                        "empty response body (content-type: {}, content-length: {})",
                        content_type, content_length
                    );
                }
                Err(error) => {
                    last_error = format!(
                        "body read error: {} (content-type: {}, content-length: {})",
                        error, content_type, content_length
                    );
                }
            }

            if attempt < budget.attempts {
                tokio::time::sleep(std::time::Duration::from_millis(
                    300 * attempt as u64,
                ))
                .await;
            }
        }

        return Err(format!(
            "Failed to download remote media after {} attempts: {}",
            budget.attempts, last_error
        ));
    }

    if source.starts_with("file://") {
        let file_path = decode_file_url_path(source);
        let local_path = PathBuf::from(file_path);
        let bytes = std::fs::read(&local_path)
            .map_err(|e| format!("Failed to read file:// image source: {}", e))?;
        let ext = local_path
            .extension()
            .and_then(|item| item.to_str())
            .map(normalize_extension)
            .unwrap_or_else(|| "png".to_string());
        return Ok((bytes, ext));
    }

    let local_path = PathBuf::from(source);
    let bytes = std::fs::read(&local_path)
        .map_err(|e| format!("Failed to read local image source: {}", e))?;
    let ext = local_path
        .extension()
        .and_then(|item| item.to_str())
        .map(normalize_extension)
        .unwrap_or_else(|| "png".to_string());

    Ok((bytes, ext))
}

#[tauri::command]
pub async fn read_storyboard_image_metadata(
    source: String,
) -> Result<Option<StoryboardImageMetadata>, String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("Image source is empty".to_string());
    }

    let (bytes, extension) = resolve_source_bytes(trimmed).await?;
    if extension != "png" {
        return Ok(None);
    }

    read_storyboard_metadata_from_png_bytes(&bytes)
}

#[tauri::command]
pub async fn embed_storyboard_image_metadata(
    app: AppHandle,
    source: String,
    metadata: StoryboardImageMetadata,
) -> Result<String, String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("Image source is empty".to_string());
    }

    let (bytes, _extension) = resolve_source_bytes(trimmed).await?;
    let image = image::load_from_memory(&bytes)
        .map_err(|e| format!("Failed to decode image for metadata embedding: {}", e))?;
    let encoded = encode_png_with_storyboard_metadata(&image, &metadata)?;

    persist_image_bytes(&app, &encoded, "png")
}

#[tauri::command]
pub async fn persist_image_source(app: AppHandle, source: String) -> Result<String, String> {
    persist_media_source(app, source, media_output::MediaKind::Image).await
}

/// 视频生成结果的本地化。
///
/// 存在的意义：API 平台回的是自家 CDN 的**临时**链接（阿里云 OSS 上 `reference-assets/`
/// 这类目录会被定期清理）。不落盘的话，模板同步、跨机分享、离线预览全都押在一条随时会
/// 失效的外部链接上 —— 链接一断，画布上那个节点就永久坏了，换任何网络都救不回来。
#[tauri::command]
pub async fn persist_video_source(app: AppHandle, source: String) -> Result<String, String> {
    persist_media_source(app, source, media_output::MediaKind::Video).await
}

/// 类型未知的媒体本地化（存量节点/模板批量修复用）。
///
/// 生成链路知道自己拿到的是图片还是视频，所以走 `persist_image_source` /
/// `persist_video_source` 就能选对预算。但**存量数据**是一堆混在一起的来源：同一个
/// 节点树上可能同时挂着图片、视频、音频，调用方根本不知道手上这个字符串是什么。
///
/// 这里按 URL 后缀先猜一次：像图片的用快速预算（HTTP/1.1 + 短超时，对生成服务的 CDN
/// 更稳），其余（视频/音频/认不出来）用宽松预算。猜错（后缀像图片、实际是几十 MB 的
/// 视频）时再用宽松预算补一次，不会因为一次误判就把素材判死。
///
/// 落盘目录一律以**下载后的真实扩展名**（响应 content-type 优先）为准，
/// 不依赖调用方的猜测。
#[tauri::command]
pub async fn persist_media_source_auto(app: AppHandle, source: String) -> Result<String, String> {
    let trimmed = source.trim().to_string();
    if trimmed.is_empty() {
        return Err("Media source is empty".to_string());
    }

    // 与 `persist_media_source` 同一条捷径：本机文件按真实扩展名决定进哪个子目录，
    // 不猜下载预算、也不读进内存。
    if let Some(target) = cached_adopted_target(&trimmed) {
        return Ok(target);
    }
    if let Some(missing) = missing_local_path(&trimmed) {
        return Err(missing_local_message(missing));
    }
    if let Some(local_path) = local_media_path(&trimmed) {
        let extension = local_path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        let dir = media_output::media_dir(&app, media_output::kind_for_extension(extension))?;
        return adopt_local_media_file(&dir, local_path, &app_managed_temp_roots(&app));
    }

    let guessed_image = matches!(
        extension_from_path_like(&trimmed)
            .map(|extension| media_output::kind_for_extension(&extension)),
        Some(media_output::MediaKind::Image)
    );

    let budget = if guessed_image {
        IMAGE_DOWNLOAD_BUDGET
    } else {
        VIDEO_DOWNLOAD_BUDGET
    };

    // 有源文件名就沿用（用户在资源管理器里认得出），没有才退回内容哈希。
    let stem = suggested_stem_from_source(&trimmed);
    match resolve_source_bytes_with_budget(&trimmed, budget).await {
        Ok((bytes, extension)) => {
            persist_media_bytes_named(&app, &bytes, &extension, stem.as_deref())
        }
        Err(primary_error) if guessed_image => {
            let (bytes, extension) =
                resolve_source_bytes_with_budget(&trimmed, VIDEO_DOWNLOAD_BUDGET)
                    .await
                    .map_err(|retry_error| {
                        format!("{primary_error}; 放宽预算重试后仍失败: {retry_error}")
                    })?;
            persist_media_bytes_named(&app, &bytes, &extension, stem.as_deref())
        }
        Err(error) => Err(error),
    }
}

/// 下载远端/内联/本机的媒体并落盘，返回本地绝对路径。
///
/// 与 `persist_image_source` 是同一条实现，差别只在下载预算（视频比图片大得多，见
/// `DownloadBudget`）和落到哪个子目录。
async fn persist_media_source(
    app: AppHandle,
    source: String,
    kind: media_output::MediaKind,
) -> Result<String, String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("Media source is empty".to_string());
    }

    // 本机已有的文件（典型：即梦两条 CLI 的临时下载目录）不下载，直接搬进落盘目录。
    // 搬完会把中转目录里的源文件删掉（见 `cleanup_adopted_source`），所以这里先查一次
    // 备忘：同一条产物被多个字段引用时，第二次的源文件已经没了。
    if let Some(target) = cached_adopted_target(trimmed) {
        return Ok(target);
    }
    if let Some(local_path) = local_media_path(trimmed) {
        let dir = media_output::media_dir(&app, kind)?;
        return adopt_local_media_file(&dir, local_path, &app_managed_temp_roots(&app));
    }

    let budget = match kind {
        media_output::MediaKind::Video => VIDEO_DOWNLOAD_BUDGET,
        _ => IMAGE_DOWNLOAD_BUDGET,
    };
    let (bytes, extension) = resolve_source_bytes_with_budget(trimmed, budget).await?;
    let dir = media_output::media_dir(&app, kind)?;
    let stem = suggested_stem_from_source(trimmed);
    persist_bytes_into(&dir, &bytes, &extension, stem.as_deref())
}

#[tauri::command]
pub async fn persist_image_binary(
    app: AppHandle,
    bytes: Vec<u8>,
    extension: Option<String>,
) -> Result<String, String> {
    let started = Instant::now();
    if bytes.is_empty() {
        return Err("Image bytes are empty".to_string());
    }

    let resolved_extension = extension
        .as_deref()
        .map(normalize_extension)
        .unwrap_or_else(|| "png".to_string());

    let output = persist_image_bytes(&app, &bytes, &resolved_extension)?;
    info!(
        "persist_image_binary done: bytes={}, ext={}, elapsed={}ms",
        bytes.len(),
        resolved_extension,
        started.elapsed().as_millis()
    );
    Ok(output)
}

/// 供 `video_protocols` 注入的媒体落盘实现。
///
/// AI 层刻意不依赖 tauri, 所以「把平台返回的二进制成片写进本地媒体目录」这一步
/// 由命令层提供: 写进当前生效的落盘位置（见 [`media_output`]），返回本地绝对路径
/// —— 前端 `resolveImageDisplayUrl` 会对本地路径做 convertFileSrc, 与迁移前前端
/// 自己 `persistImageBinary` 的结果形态完全一致。
pub fn make_media_persister(
    app: AppHandle,
) -> Box<dyn Fn(&[u8], &str) -> Result<String, String> + Send + Sync> {
    Box::new(move |bytes, extension| {
        if bytes.is_empty() {
            return Err("媒体字节为空".to_string());
        }
        // 按扩展名路由：有些视频协议（sub2api / 震剪）会直接把成片字节交到这里，
        // 以前无条件写进 images/ ，现在 mp4 进 videos/ 、mp3 进 audio/ 。
        persist_media_bytes(&app, bytes, &normalize_extension(extension))
    })
}

/// 建议文件名最多保留多少个字符。
///
/// Windows 单个路径组件的上限是 255 个 UTF-16 单元，超了 `CreateFileW` 报
/// `ERROR_INVALID_NAME`（**os error 123**）—— 提示语是「文件名、目录名或卷标语法不正确」，
/// 完全看不出真正原因是「名字太长」。
///
/// 节点管理里的建议名取自节点标题，而那里可能被写进一整段提示词（实测 1835 字），
/// 不截断必然失败。80 个字符够认、也远在限制之内（就算全是 emoji 也只占 160 个单元）。
const MAX_FILE_STEM_CHARS: usize = 80;

/// Windows 保留设备名：`CON` / `PRN` / `AUX` / `NUL` / `COM1-9` / `LPT1-9`。
/// 拿它们当文件名会写进设备而不是文件，或者直接失败。
fn is_reserved_windows_name(stem: &str) -> bool {
    let upper = stem.to_ascii_uppercase();
    if matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }
    let bytes = upper.as_bytes();
    bytes.len() == 4
        && (upper.starts_with("COM") || upper.starts_with("LPT"))
        && bytes[3].is_ascii_digit()
}

fn sanitize_file_stem(raw: &str) -> String {
    let trimmed = raw.trim();
    let fallback = "storyboard-image";
    if trimmed.is_empty() {
        return fallback.to_string();
    }

    let mut sanitized = String::with_capacity(trimmed.len().min(MAX_FILE_STEM_CHARS * 4));
    for ch in trimmed.chars() {
        // 控制字符（换行、制表符…）换成空格而不是删掉：直接删会把前后两段粘成一个词
        // （"SCENE CONTEXT\n藏式…" 变成 "SCENE CONTEXT藏式…"），文件名读不出层次。
        if ch.is_control() {
            sanitized.push(' ');
            continue;
        }
        let blocked = matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*');
        if blocked {
            continue;
        }
        sanitized.push(ch);
    }

    // 空白压成一个空格：控制字符虽然已经被挡掉，但连续的换行/制表符会把名字切得七零八落，
    // 而截断后留下的空白还可能变成结尾空格（Windows 同样不允许）。
    let compacted = sanitized.split_whitespace().collect::<Vec<_>>().join(" ");
    // 按**字符**截断（不是字节），截完再掐掉结尾的点和空格。
    let truncated: String = compacted.chars().take(MAX_FILE_STEM_CHARS).collect();
    let compact = truncated
        .trim()
        .trim_end_matches(|c: char| c == '.' || c == ' ')
        .to_string();

    if compact.is_empty() {
        return fallback.to_string();
    }
    if is_reserved_windows_name(&compact) {
        return format!("_{compact}");
    }
    compact
}

/// 目标文件已存在、且内容与待写字节一致。
///
/// 先比大小（几乎不花时间），一致才读文件算 md5；大小不同直接判否。
fn same_content_file(path: &Path, bytes: &[u8]) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if meta.len() != bytes.len() as u64 {
        return false;
    }
    hash_file_md5(path).ok() == Some(md5::compute(bytes))
}

fn ensure_unique_path(path: PathBuf) -> PathBuf {
    if !path.exists() {
        return path;
    }

    let parent = path.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."));
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("storyboard-image");
    let ext = path.extension().and_then(|value| value.to_str()).unwrap_or("png");

    for index in 1..10_000_u32 {
        let candidate = parent.join(format!("{}-{}.{}", stem, index, ext));
        if !candidate.exists() {
            return candidate;
        }
    }

    path
}

fn ensure_output_path_with_extension(path: &Path, extension: &str) -> PathBuf {
    if path.extension().is_some() {
        return path.to_path_buf();
    }

    let mut with_extension = path.to_path_buf();
    with_extension.set_extension(normalize_extension(extension));
    with_extension
}

#[tauri::command]
pub async fn save_image_source_to_downloads(
    source: String,
    suggested_file_name: Option<String>,
) -> Result<String, String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("Image source is empty".to_string());
    }

    let (bytes, extension) = resolve_source_bytes(trimmed).await?;
    let user_dirs = UserDirs::new().ok_or_else(|| "Failed to resolve user dirs".to_string())?;
    let downloads_dir = user_dirs
        .download_dir()
        .or_else(|| user_dirs.desktop_dir())
        .or_else(|| Some(user_dirs.home_dir()))
        .ok_or_else(|| "Failed to resolve downloads dir".to_string())?;
    std::fs::create_dir_all(downloads_dir)
        .map_err(|e| format!("Failed to create downloads dir: {}", e))?;

    let now_millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Failed to resolve current time: {}", e))?
        .as_millis();
    let stem = sanitize_file_stem(suggested_file_name.as_deref().unwrap_or(""));
    let default_stem = if stem == "storyboard-image" {
        format!("storyboard-{}", now_millis)
    } else {
        stem
    };

    let target = downloads_dir.join(format!(
        "{}.{}",
        default_stem,
        normalize_extension(&extension)
    ));
    // 同一份内容已经在下载目录里：直接复用，不要再写一份 `-2`、`-3`。
    // 以前连点几次「下载」会堆出四五个 26 MB 的同名副本，看起来像「点了没反应」的
    // 同时也白占磁盘。
    if same_content_file(&target, &bytes) {
        return Ok(target.to_string_lossy().to_string());
    }
    let output_path = ensure_unique_path(target);
    std::fs::write(&output_path, bytes).map_err(|e| {
        // 把目标路径带出来：只报一句「失败」的话，用户和排查的人都不知道写的是哪个文件。
        format!(
            "Failed to save media into downloads: {}（目标文件：{}）",
            e,
            output_path.display()
        )
    })?;

    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn save_image_source_to_path(source: String, target_path: String) -> Result<String, String> {
    let trimmed_source = source.trim();
    if trimmed_source.is_empty() {
        return Err("Media source is empty".to_string());
    }

    let trimmed_target = target_path.trim();
    if trimmed_target.is_empty() {
        return Err("Target path is empty".to_string());
    }

    let (bytes, extension) = resolve_source_bytes(trimmed_source).await?;
    let raw_path = PathBuf::from(trimmed_target);
    let output_path = ensure_output_path_with_extension(&raw_path, &extension);

    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create output dir: {}", e))?;
    }

    std::fs::write(&output_path, bytes)
        .map_err(|e| format!("Failed to save media to target path: {}", e))?;

    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn save_image_source_to_directory(
    source: String,
    target_dir: String,
    suggested_file_name: Option<String>,
) -> Result<String, String> {
    let trimmed_source = source.trim();
    if trimmed_source.is_empty() {
        return Err("Image source is empty".to_string());
    }

    let trimmed_dir = target_dir.trim();
    if trimmed_dir.is_empty() {
        return Err("Target directory is empty".to_string());
    }

    let (bytes, extension) = resolve_source_bytes(trimmed_source).await?;
    let dir_path = PathBuf::from(trimmed_dir);
    std::fs::create_dir_all(&dir_path)
        .map_err(|e| format!("Failed to create target dir: {}", e))?;

    let now_millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Failed to resolve current time: {}", e))?
        .as_millis();
    let stem = sanitize_file_stem(suggested_file_name.as_deref().unwrap_or(""));
    let default_stem = if stem == "storyboard-image" {
        format!("storyboard-{}", now_millis)
    } else {
        stem
    };

    let output_path = ensure_unique_path(dir_path.join(format!(
        "{}.{}",
        default_stem,
        normalize_extension(&extension)
    )));
    std::fs::write(&output_path, bytes)
        .map_err(|e| format!("Failed to save image to target directory: {}", e))?;

    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn save_image_source_to_app_debug_dir(
    app: AppHandle,
    source: String,
    category: Option<String>,
    suggested_file_name: Option<String>,
) -> Result<String, String> {
    let trimmed_source = source.trim();
    if trimmed_source.is_empty() {
        return Err("Image source is empty".to_string());
    }

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;
    let normalized_category = sanitize_file_stem(category.as_deref().unwrap_or("grid"));
    let target_dir = app_data_dir.join("debug").join(normalized_category);
    std::fs::create_dir_all(&target_dir)
        .map_err(|e| format!("Failed to create app debug dir: {}", e))?;

    let (bytes, extension) = resolve_source_bytes(trimmed_source).await?;
    let now_millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Failed to resolve current time: {}", e))?
        .as_millis();
    let stem = sanitize_file_stem(suggested_file_name.as_deref().unwrap_or(""));
    let default_stem = if stem == "storyboard-image" {
        format!("debug-{}", now_millis)
    } else {
        stem
    };
    let output_path = ensure_unique_path(target_dir.join(format!(
        "{}.{}",
        default_stem,
        normalize_extension(&extension)
    )));

    std::fs::write(&output_path, bytes)
        .map_err(|e| format!("Failed to save image to app debug dir: {}", e))?;

    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn copy_image_source_to_clipboard(source: String) -> Result<(), String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("Image source is empty".to_string());
    }

    let (bytes, _extension) = resolve_source_bytes(trimmed).await?;
    let image = image::load_from_memory(&bytes)
        .map_err(|e| format!("Failed to decode image source: {}", e))?
        .to_rgba8();
    let width = image.width() as usize;
    let height = image.height() as usize;
    let pixels = image.into_raw();

    let mut clipboard = Clipboard::new()
        .map_err(|e| format!("Failed to access clipboard: {}", e))?;
    clipboard
        .set_image(ImageData {
            width,
            height,
            bytes: Cow::Owned(pixels),
        })
        .map_err(|e| format!("Failed to write image into clipboard: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn load_image(file_path: String) -> Result<String, String> {
    info!("Loading image from: {}", file_path);

    let image_data =
        std::fs::read(&file_path).map_err(|e| format!("Failed to read file: {}", e))?;

    let base64_data = STANDARD.encode(&image_data);

    let mime = if file_path.ends_with(".png") {
        "image/png"
    } else if file_path.ends_with(".jpg") || file_path.ends_with(".jpeg") {
        "image/jpeg"
    } else if file_path.ends_with(".gif") {
        "image/gif"
    } else if file_path.ends_with(".webp") {
        "image/webp"
    } else if file_path.ends_with(".mp3") {
        "audio/mpeg"
    } else if file_path.ends_with(".wav") {
        "audio/wav"
    } else if file_path.ends_with(".m4a") {
        "audio/mp4"
    } else if file_path.ends_with(".aac") {
        "audio/aac"
    } else if file_path.ends_with(".ogg") {
        "audio/ogg"
    } else if file_path.ends_with(".flac") {
        "audio/flac"
    } else if file_path.ends_with(".webm") {
        "audio/webm"
    } else if file_path.ends_with(".mp4") {
        "video/mp4"
    } else if file_path.ends_with(".mov") {
        "video/quicktime"
    } else {
        "image/png"
    };

    Ok(format!("data:{};base64,{}", mime, base64_data))
}

/// 本地临时文件的「搬家」逻辑测试。
///
/// 只测纯文件操作那一段（不碰 `AppHandle`）：这条路径是把即梦 CLI 的
/// `%APPDATA%\...\jimeng-cli\videos\<run_id>\` 产物搬进落盘目录的唯一入口，
/// 一旦命名或幂等错了，表现是「每次生成都多一份文件」或「节点指向不存在的路径」。
#[cfg(test)]
mod adopt_local_media_tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "lentalk-adopt-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    /// 按真实结构造一个「中转目录」：`<root>/videos/<run_id>/canvas-<run_id>.mp4`。
    /// 直接拿 source 的父目录当 root 会命中「不许删 root 本身」的保护分支，测不出清理。
    fn temp_root_with_source(label: &str, bytes: &[u8]) -> (PathBuf, PathBuf, PathBuf) {
        let root = temp_dir(label);
        let run_dir = root.join("videos").join("run-1");
        std::fs::create_dir_all(&run_dir).expect("create run dir");
        let source = run_dir.join("canvas-run-1.mp4");
        std::fs::write(&source, bytes).expect("write source");
        (root, run_dir, source)
    }

    #[test]
    fn copies_local_file_into_output_dir_keeping_its_name() {
        let source_dir = temp_dir("src");
        let output_dir = temp_dir("out");
        let source = source_dir.join("canvas-abc.mp4");
        std::fs::write(&source, b"fake-video-bytes").expect("write source");

        let adopted = adopt_local_media_file(&output_dir, &source, &[]).expect("adopt");

        assert!(Path::new(&adopted).exists(), "搬过去的文件必须真的存在");
        assert_eq!(
            std::fs::read(&adopted).expect("read adopted"),
            b"fake-video-bytes"
        );
        // 保留原文件名：用户在资源管理器里要认得出这是什么，而不是一串哈希。
        assert_eq!(
            Path::new(&adopted).file_name().and_then(|name| name.to_str()),
            Some("canvas-abc.mp4")
        );
        // 没给清理根目录 = 用户自己素材盘里的文件，只搬不删。
        assert!(source.exists(), "用户自己的源文件不能被删");
    }

    #[test]
    fn adopt_is_idempotent() {
        let source_dir = temp_dir("src2");
        let output_dir = temp_dir("out2");
        let source = source_dir.join("canvas-def.mp4");
        std::fs::write(&source, b"same-bytes").expect("write source");

        let first = adopt_local_media_file(&output_dir, &source, &[]).expect("first");
        let second = adopt_local_media_file(&output_dir, &source, &[]).expect("second");

        assert_eq!(first, second, "同一条产物重复搬家必须落到同一个文件");
        let count = std::fs::read_dir(&output_dir)
            .expect("list output dir")
            .count();
        assert_eq!(count, 1, "重复搬家不能产生第二份文件");
    }

    #[test]
    fn skips_file_already_in_output_dir() {
        let output_dir = temp_dir("out3");
        let existing = output_dir.join("already-there.mp4");
        std::fs::write(&existing, b"x").expect("write");

        let adopted = adopt_local_media_file(&output_dir, &existing, &[]).expect("adopt");

        assert_eq!(adopted, existing.to_string_lossy().to_string());
        let count = std::fs::read_dir(&output_dir)
            .expect("list output dir")
            .count();
        assert_eq!(count, 1, "已在落盘目录里的文件不该被再复制一份");
    }

    #[test]
    fn local_media_path_only_accepts_existing_absolute_files() {
        let dir = temp_dir("probe");
        let file = dir.join("clip.mp4");
        std::fs::write(&file, b"x").expect("write");

        let absolute = file.to_string_lossy().to_string();

        assert!(local_media_path(&absolute).is_some());
        assert!(local_media_path("https://example.com/a.mp4").is_none());
        assert!(local_media_path("data:video/mp4;base64,AAAA").is_none());
        assert!(local_media_path("asset://localhost/C:/a.mp4").is_none());
        assert!(local_media_path("//server/share/a.mp4").is_none());
        assert!(local_media_path("relative/a.mp4").is_none());
        assert!(
            local_media_path(&dir.join("missing.mp4").to_string_lossy()).is_none(),
            "不存在的文件不该被当成可搬来源"
        );
    }

    /// 中转目录里的产物搬完必须清尾：源文件、CLI 附带封面、空掉的 run 目录。
    /// 不清的话每生成一条视频就多留一份，`jimeng-cli\videos` 会无限增长。
    #[test]
    fn cleans_up_temp_source_after_adopting() {
        let (root, run_dir, source) = temp_root_with_source("clean", b"video-bytes");
        let output_dir = temp_dir("out-clean");
        let cover = PathBuf::from(format!("{}.jpg", source.to_string_lossy()));
        std::fs::write(&cover, b"cover").expect("write cover");

        let adopted =
            adopt_local_media_file(&output_dir, &source, std::slice::from_ref(&root)).expect("adopt");

        assert!(Path::new(&adopted).exists(), "成品必须在落盘目录里");
        assert!(!source.exists(), "中转目录里的源文件应该被删掉");
        assert!(!cover.exists(), "CLI 附带的封面也应该一起清掉");
        assert!(!run_dir.exists(), "空掉的 run 目录应该被删除");
        assert!(root.exists(), "中转目录的根不能删");
    }

    /// 同一 run 里还有别的产物时，目录必须留着 —— 删目录只是顺手，不能连坐。
    #[test]
    fn keeps_run_dir_when_other_products_remain() {
        let (root, run_dir, source) = temp_root_with_source("keep", b"one");
        let output_dir = temp_dir("out-keep");
        let sibling = run_dir.join("canvas-run-1-second.mp4");
        std::fs::write(&sibling, b"two").expect("write sibling");

        adopt_local_media_file(&output_dir, &source, std::slice::from_ref(&root)).expect("adopt");

        assert!(!source.exists(), "自己那份应该清掉");
        assert!(sibling.exists(), "同目录其它产物不受影响");
        assert!(run_dir.exists(), "目录里还有文件就不能删");
    }

    /// 用户自己素材盘里的文件，即使显式给了清理根目录也不许删。
    #[test]
    fn never_deletes_files_outside_temp_roots() {
        let root = temp_dir("root-only");
        let user_dir = temp_dir("user-media");
        let source = user_dir.join("my-shot.mp4");
        std::fs::write(&source, b"mine").expect("write");
        let output_dir = temp_dir("out-user");

        adopt_local_media_file(&output_dir, &source, std::slice::from_ref(&root)).expect("adopt");

        assert!(source.exists(), "清理只对自己下载的中转目录生效");
    }

    /// 源已经被删掉之后，靠备忘仍能找回成品路径（同一产物被多个字段引用）。
    #[test]
    fn cached_target_survives_source_deletion() {
        let (root, _run_dir, source) = temp_root_with_source("cache", b"cached-bytes");
        let output_dir = temp_dir("out-cache");

        let adopted =
            adopt_local_media_file(&output_dir, &source, std::slice::from_ref(&root)).expect("adopt");
        assert!(!source.exists(), "前提：源已经清掉了");
        assert!(
            local_media_path(&source.to_string_lossy()).is_none(),
            "前提：普通流程已经找不到这个源了"
        );

        assert_eq!(
            cached_adopted_target(&source.to_string_lossy()).as_deref(),
            Some(adopted.as_str()),
            "备忘要能把第二次请求接回成品"
        );
    }
}

#[cfg(test)]
mod file_stem_tests {
    use super::*;

    /// 真机踩到的坑：`images/<md5>.png` 里装的其实是 mp3。
    /// 当时 `extension_from_mime` 没有音频分支，`audio/mpeg` 一路落到兜底的 `png`。
    #[test]
    fn audio_mime_maps_to_real_extension() {
        assert_eq!(extension_from_mime("audio/mpeg"), "mp3");
        assert_eq!(extension_from_mime("audio/mpeg; charset=binary"), "mp3");
        assert_eq!(extension_from_mime("audio/wav"), "wav");
        assert_eq!(extension_from_mime("audio/mp4"), "m4a");
        assert_eq!(extension_from_mime("audio/aac"), "aac");
        assert_eq!(extension_from_mime("audio/ogg"), "ogg");
        assert_eq!(extension_from_mime("audio/flac"), "flac");
    }

    #[test]
    fn sniffing_recognizes_audio_behind_a_wrong_extension() {
        // 只有 ID3 头 + 填充，足够嗅探；前缀就是 mp3。
        let mp3 = b"ID3\x03\x00\x00\x00\x00\x00\x00extra-bytes";
        assert_eq!(sniff_media_extension(mp3), Some("mp3"));
        // 没有 ID3 标签的 mp3：第一帧同步字 0xFFEx。
        let raw_mp3 = [0xFF_u8, 0xF3, 0x44, 0xC4, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
        assert_eq!(sniff_media_extension(&raw_mp3), Some("mp3"));

        assert_eq!(
            sniff_media_extension(b"\x89PNG\r\n\x1a\n00000000"),
            Some("png")
        );
        assert_eq!(
            sniff_media_extension(b"\xFF\xD8\xFF\xE0\x00\x10JFIF\x00\x01\x01\x00"),
            Some("jpg")
        );
        let wav = b"RIFF\x24\x00\x00\x00WAVEfmt ";
        assert_eq!(sniff_media_extension(wav), Some("wav"));
    }

    #[test]
    fn short_or_unknown_payloads_are_not_guessed() {
        assert_eq!(sniff_media_extension(b"ID3"), None);
        assert_eq!(sniff_media_extension(b"\x00\x00\x00\x18ft"), None);
    }

    /// 落盘文件名用来源名（用户在资源管理器里认得出），而不是一串 md5。
    #[test]
    fn source_stem_is_used_for_readable_file_names() {
        assert_eq!(
            suggested_stem_from_source(r"D://media//丈夫.mp3").as_deref(),
            Some("丈夫")
        );
        assert_eq!(
            suggested_stem_from_source("https://cdn.example.com/a/voice_01.mp3?sign=1").as_deref(),
            Some("voice_01")
        );
        // URL 里的中文是百分号编码的，必须还原成 `丈夫` 而不是 `%E4%B8%88%E5%A4%AB`。
        assert_eq!(
            suggested_stem_from_source("https://cdn.example.com/a/%E4%B8%88%E5%A4%AB.mp3").as_deref(),
            Some("丈夫")
        );
        // 内联数据没有名字。
        assert_eq!(
            suggested_stem_from_source("data:audio/mpeg;base64,AAAA"),
            None
        );
        // 只有目录、没有文件名。
        assert_eq!(suggested_stem_from_source("https://cdn.example.com/"), None);
    }

    #[test]
    fn same_name_with_same_content_reuses_one_file() {
        let dir = std::env::temp_dir().join(format!("lentalk-name-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create dir");

        let bytes = b"ID3\x03\x00\x00\x00\x00\x00\x00-same".to_vec();
        let first = persist_bytes_into(&dir, &bytes, "mp3", Some("丈夫")).expect("first");
        let second = persist_bytes_into(&dir, &bytes, "mp3", Some("丈夫")).expect("second");

        assert_eq!(first, second, "同内容不该存两份");
        assert!(first.ends_with("丈夫.mp3"), "{first}");
        assert_eq!(std::fs::read_dir(&dir).expect("list").count(), 1);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn same_name_with_different_content_gets_a_suffix() {
        let dir = std::env::temp_dir().join(format!("lentalk-name2-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create dir");

        let first = persist_bytes_into(&dir, b"ID3content-A", "mp3", Some("丈夫")).expect("a");
        let second = persist_bytes_into(&dir, b"ID3content-B", "mp3", Some("丈夫")).expect("b");

        assert_ne!(first, second);
        assert!(second.ends_with("丈夫-2.mp3"), "{second}");
        assert_eq!(std::fs::read_dir(&dir).expect("list").count(), 2);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// 没有来源名时（平台直接返回二进制）仍用内容哈希：重复请求命中同一个文件。
    #[test]
    fn missing_name_falls_back_to_content_hash() {
        let dir = std::env::temp_dir().join(format!("lentalk-hash-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create dir");

        let bytes = b"ID3anonymous".to_vec();
        let first = persist_bytes_into(&dir, &bytes, "mp3", None).expect("a");
        let second = persist_bytes_into(&dir, &bytes, "mp3", None).expect("b");
        assert_eq!(first, second);
        assert_eq!(std::fs::read_dir(&dir).expect("list").count(), 1);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// 连点「下载」不该在下载目录堆同名副本。
    #[test]
    fn repeated_download_reuses_the_same_file() {
        let dir = std::env::temp_dir().join(format!("lentalk-dl-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create dir");

        let bytes = b"fake-video-bytes".to_vec();
        let target = dir.join("demo.mp4");

        // 第一次：目标不存在 → 不算同内容。
        assert!(!same_content_file(&target, &bytes));
        std::fs::write(&target, &bytes).expect("write target");

        // 第二次：内容一致 → 判定命中，调用方直接复用，不再写 `demo-2.mp4`。
        assert!(same_content_file(&target, &bytes));

        // 同名不同内容 → 必须继续走 `ensure_unique_path`，不能覆盖。
        assert!(!same_content_file(&target, b"other-bytes"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn long_title_is_truncated_not_rejected() {
        // 真实踩到的数据：节点标题被写进了一整段提示词（1835 字），
        // 直接落盘会撞 Windows 255 的路径组件上限，报 os error 123。
        let prompt = format!(
            "SCENE CONTEXT\n{}",
            "藏式室内讲堂内，藏医面向镜头严厉警示观众。".repeat(60)
        );
        assert!(prompt.chars().count() > 255);

        let stem = sanitize_file_stem(&prompt);
        assert_eq!(stem.chars().count(), MAX_FILE_STEM_CHARS);
        // 换行必须已经压成空格，不然还是一个非法组件。
        assert!(!stem.contains('\n'));
        assert!(stem.starts_with("SCENE CONTEXT 藏式室内讲堂"));
    }

    #[test]
    fn trailing_dot_and_space_are_stripped() {
        assert_eq!(sanitize_file_stem("封面. ."), "封面");
        assert_eq!(sanitize_file_stem("  多   空格  "), "多 空格");
    }

    #[test]
    fn illegal_characters_are_dropped() {
        assert_eq!(sanitize_file_stem("a/b\\c*d?e\"f<g>h|i"), "abcdefghi");
        // 控制字符变成空格（直接删会让前后粘连）。
        assert_eq!(sanitize_file_stem("视频\u{0000}标题"), "视频 标题");
    }

    #[test]
    fn reserved_device_names_get_a_prefix() {
        // `CON.mp4` 在 Windows 上根本创建不出来。
        assert_eq!(sanitize_file_stem("CON"), "_CON");
        assert_eq!(sanitize_file_stem("com1"), "_com1");
        assert_eq!(sanitize_file_stem("CONSOLE"), "CONSOLE");
    }

    #[test]
    fn empty_input_falls_back() {
        assert_eq!(sanitize_file_stem(""), "storyboard-image");
        assert_eq!(sanitize_file_stem("   "), "storyboard-image");
        assert_eq!(sanitize_file_stem("..."), "storyboard-image");
    }
}
