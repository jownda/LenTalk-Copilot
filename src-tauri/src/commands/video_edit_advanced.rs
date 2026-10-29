//! 高级剪辑：**多片段、可多源**按时间线顺序拼接，外加一条自由定位的音乐轨。
//!
//! 与 `video_edit.rs` 的分工：
//! - 那边是「一个源视频切几段」（基础剪辑，快路径 `-ss/-t`，不统一画布）；
//! - 这边是「任意多个源片段首尾相接」（高级剪辑），所以必须处理三件那边不需要的事：
//!
//! 1. **统一画布**：concat 滤镜要求所有片段分辨率 / SAR 一致，不同源的素材必须
//!    `scale + pad` 到同一个画布，否则 ffmpeg 直接报错；
//! 2. **统一帧率**：同上，靠 `fps=<有理数>` 归一；用有理数而不是小数，避免 23.976 被写成 23.98 长期漂移；
//! 3. **补齐音轨**：concat 的 `a=1` 要求每一段都有音频。没有音轨的片段（AI 生成素材常见）
//!    必须用 `anullsrc` 造一段等长静音填进去，否则整条链路失败。
//!
//! 音乐轨存在时间轴偏移（可以从第 3 秒才进来），用 `adelay` 实现；配合输出端 `-t 成片长度`
//! 把尾巴切掉。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use super::video_cfr::{hide_child_console, local_or_remote_video_source, resolve_ffmpeg_path};
use super::video_edit::{
    clamp_volume, fmt_seconds, is_clip_too_short, probe_media, sanitize_seconds, MediaProbe,
    AUDIO_BITRATE,
    MAX_AUDIO_VOLUME, MAX_FADE_SEC, MIN_TRIM_DURATION_SEC, TRIM_EPSILON_SEC, VIDEO_CRF,
    VIDEO_PRESET,
};

/// 片段缩放的上下限（和前端 `TRANSFORM_LIMITS` 对齐）。
const MIN_CLIP_SCALE: f64 = 0.05;
const MAX_CLIP_SCALE: f64 = 8.0;
/// 位移上限（画布百分比）：±200% 已经能把画面整个移出画布，再大没有意义。
const MAX_CLIP_OFFSET: f64 = 200.0;
const MAX_CLIP_RADIUS: f64 = 1000.0;
/// 每条属性最多几个关键帧。表达式里每帧一层 `if()`，太多会让 ffmpeg 解析变慢甚至失败。
const MAX_KEYFRAMES_PER_PROPERTY: usize = 32;

/// 时间线上一段视频。`start/end` 是**源素材内**的入出点（秒）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvancedClipRequest {
    pub source_path: String,
    pub start: f64,
    pub end: f64,
    /// 画面变换。全默认时前端不会带这个字段。
    #[serde(default)]
    pub transform: Option<AdvancedClipTransformRequest>,
    /// 属性动画。带了这个就走合成路径（表达式逐帧算）。
    #[serde(default)]
    pub keyframes: Option<AdvancedClipKeyframesRequest>,
}

/// 音乐轨。`start` 是它在**成片时间轴**上的起点（秒），不是素材内偏移。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvancedMusicRequest {
    pub source_path: String,
    #[serde(default)]
    pub start: Option<f64>,
    #[serde(default)]
    pub volume: Option<f64>,
    #[serde(default)]
    pub fade_in: Option<f64>,
    #[serde(default)]
    pub fade_out: Option<f64>,
}

/// 画面上的文字。`start/end` 是**成片时间轴**上的起止（秒）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvancedTitleRequest {
    pub text: String,
    pub start: f64,
    pub end: f64,
    /// 按 1080p 画布设计的字号；渲染时按实际画布高缩放。
    #[serde(default)]
    pub font_size: Option<f64>,
    /// `#RRGGBB`。
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub position: Option<String>,
    #[serde(default)]
    pub backdrop: Option<bool>,
}

/// 片段画面变换。字段全可选 —— 没带的按默认值（原样铺满画布）处理。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvancedClipTransformRequest {
    #[serde(default)]
    pub scale: Option<f64>,
    #[serde(default)]
    pub scale_x: Option<f64>,
    #[serde(default)]
    pub scale_y: Option<f64>,
    /// 画布宽百分比。
    #[serde(default)]
    pub x: Option<f64>,
    /// 画布高百分比。
    #[serde(default)]
    pub y: Option<f64>,
    #[serde(default)]
    pub rotation: Option<f64>,
    #[serde(default)]
    pub opacity: Option<f64>,
    #[serde(default)]
    pub border_radius: Option<f64>,
}

/// 一个关键帧：`t` 是**相对片段起点**的秒数。
#[derive(Debug, Clone, Deserialize)]
pub struct AdvancedKeyframeRequest {
    pub t: f64,
    pub v: f64,
    pub e: Option<String>,
}

/// 片段属性动画。字段全可选，空的等于没动画。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvancedClipKeyframesRequest {
    #[serde(default)]
    pub x: Vec<AdvancedKeyframeRequest>,
    #[serde(default)]
    pub y: Vec<AdvancedKeyframeRequest>,
    #[serde(default)]
    pub rotation: Vec<AdvancedKeyframeRequest>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvancedVideoEditRequest {
    pub clips: Vec<AdvancedClipRequest>,
    /// 文字叠加。空文本由 `normalize_advanced` 过滤掉。
    #[serde(default)]
    pub titles: Vec<AdvancedTitleRequest>,
    /// `keep` | `mute`。缺省保留原声。
    #[serde(default)]
    pub audio_mode: Option<String>,
    #[serde(default)]
    pub audio_volume: Option<f64>,
    #[serde(default)]
    pub music: Option<AdvancedMusicRequest>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvancedVideoEditResult {
    pub output_path: String,
    /// 非致命问题（如找不到中文字体导致文字没画上），前端可提示。
    pub warnings: Vec<String>,
    pub duration_sec: Option<f64>,
    /// 实际用到的画布尺寸，前端可据此提示「素材被缩放」。
    pub canvas_width: u32,
    pub canvas_height: u32,
}

/// 收敛后的画面变换。默认值 = 原样铺满画布。
#[derive(Debug, Clone, Copy, PartialEq)]
struct NormalizedTransform {
    scale: f64,
    scale_x: f64,
    scale_y: f64,
    x: f64,
    y: f64,
    rotation: f64,
    opacity: f64,
    border_radius: f64,
}

impl Default for NormalizedTransform {
    fn default() -> Self {
        Self {
            scale: 1.0,
            scale_x: 1.0,
            scale_y: 1.0,
            x: 0.0,
            y: 0.0,
            rotation: 0.0,
            opacity: 1.0,
            border_radius: 0.0,
        }
    }
}

impl NormalizedTransform {
    /// 和「原样铺满画布」等价与否。等价时走原来的 concat 路径 —— 那条路径已经跑熟了，
    /// 没必要为了几个 0 像素的变换去付合成的开销。
    fn is_identity(&self) -> bool {
        (self.scale - 1.0).abs() < 1e-4
            && (self.scale_x - 1.0).abs() < 1e-4
            && (self.scale_y - 1.0).abs() < 1e-4
            && self.x.abs() < 1e-4
            && self.y.abs() < 1e-4
            && self.rotation.abs() < 1e-4
            && (self.opacity - 1.0).abs() < 1e-4
            && self.border_radius < 0.5
    }
}

/// 缓动曲线。只保留能用四则运算写进 ffmpeg 表达式的四种。
#[derive(Debug, Clone, Copy, PartialEq)]
enum Easing {
    Linear,
    EaseIn,
    EaseOut,
    EaseInOut,
}

fn parse_easing(raw: Option<&str>) -> Easing {
    match raw.unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "ease-in" => Easing::EaseIn,
        "ease-out" => Easing::EaseOut,
        "ease-in-out" => Easing::EaseInOut,
        _ => Easing::Linear,
    }
}

#[derive(Debug, Clone, Copy)]
struct NormalizedKeyframe {
    /// 相对片段起点的秒。
    t: f64,
    v: f64,
    easing: Easing,
}

/// 一条属性的关键帧曲线。空 = 该属性没有动画。
type Track = Option<Vec<NormalizedKeyframe>>;

/// 只有位移和旋转能动画：它们的表达式不改变画面尺寸。
///
/// 🔴 缩放**故意不在这里**：`scale=...:eval=frame` 让输出尺寸逐帧变化，
/// 和 rotate 同链时 ffmpeg 会直接崩溃（`0xC0000005`，两者单独用都正常）。
#[derive(Debug, Clone, Default)]
struct NormalizedTracks {
    x: Track,
    y: Track,
    rotation: Track,
}

impl NormalizedTracks {
    fn is_empty(&self) -> bool {
        self.x.is_none() && self.y.is_none() && self.rotation.is_none()
    }
}

struct NormalizedClip {
    path_index: usize,
    start: f64,
    end: f64,
    has_audio: bool,
    transform: NormalizedTransform,
    /// 片段在画布上的显示尺寸（缩放后、未旋转）。滤镜里直接用它，避免浮点表达式。
    display_width: u32,
    display_height: u32,
    /// 圆角蒙版 PNG（只有 `border_radius > 0` 才有）。渲染完要删。
    mask_path: Option<std::path::PathBuf>,
    /// 属性动画。非空时这段走表达式逐帧求值。
    tracks: NormalizedTracks,
}

impl NormalizedClip {
    fn duration(&self) -> f64 {
        (self.end - self.start).max(0.0)
    }
}

#[derive(Debug, Clone, Copy)]
struct NormalizedMusic {
    path_index: usize,
    /// 在成片时间轴上的起点（秒）。
    start: f64,
    /// 实际可用的时长（已被成片长度裁过）。
    duration: f64,
    volume: f64,
    fade_in: f64,
    fade_out: f64,
}

#[derive(Debug, Clone)]
/// 收敛后的文字：文本已经落成临时文件，drawtext 用 `textfile` 读。
struct NormalizedTitle {
    /// 文本文件路径（`textfile=`）。用文件而不是 `text=`，见 `write_title_file` 的注释。
    text_file: std::path::PathBuf,
    /// 字体文件（`fontfile=`）。在收敛阶段就定下来：渲染时再探一次可能拿到空值。
    font_file: std::path::PathBuf,
    start: f64,
    end: f64,
    font_size: u32,
    color: String,
    position: String,
    backdrop: bool,
}

struct NormalizedAdvanced {
    inputs: Vec<String>,
    clips: Vec<NormalizedClip>,
    /// 有任意片段带非默认变换 → 必须走合成路径（透明叠加），不能再 concat。
    needs_composite: bool,
    titles: Vec<NormalizedTitle>,
    /// 非致命问题，最终透传到结果里给前端提示。
    warnings: Vec<String>,
    music: Option<NormalizedMusic>,
    keep_audio: bool,
    audio_volume: f64,
    width: u32,
    height: u32,
    fps: String,
    total_duration: f64,
}

/// 把 ffmpeg 报的小数帧率还原成有理数，避免 23.976 被当成 23.98 用（每帧差 tick，长片会漂）。
fn snap_fps_rational(fps: f64) -> String {
    const KNOWN: [(f64, u32, u32); 10] = [
        (24000.0 / 1001.0, 24_000, 1_001),
        (24.0, 24, 1),
        (25.0, 25, 1),
        (30000.0 / 1001.0, 30_000, 1_001),
        (30.0, 30, 1),
        (48.0, 48, 1),
        (50.0, 50, 1),
        (60000.0 / 1001.0, 60_000, 1_001),
        (60.0, 60, 1),
        (120.0, 120, 1),
    ];
    if !fps.is_finite() || fps <= 0.0 || fps > 1_000.0 {
        return "30".to_string();
    }
    let mut best = KNOWN[4];
    let mut best_error = f64::INFINITY;
    for candidate in KNOWN {
        let error = (candidate.0 - fps).abs() / fps;
        if error < best_error {
            best_error = error;
            best = candidate;
        }
    }
    // 0.05% 以内才认：够认 23.98 → 24000/1001（0.017%），不会把 30 错认成 29.97（0.10%）。
    if best_error < 5e-4 {
        format!("{}/{}", best.1, best.2)
    } else {
        format!("{fps}")
    }
}

/// 像素尺寸取偶数：H.264 要求宽高可被 2 整除，奇数尺寸会让编码直接失败。
fn even(value: u32) -> u32 {
    if value % 2 == 0 {
        value.max(2)
    } else {
        value.saturating_sub(1).max(2)
    }
}

/// 找一个能画中文的字体。
///
/// ffmpeg 的 `drawtext` 不会自己找字体族，必须给具体文件（`fontfile`）。
/// 找不到就**不画文字**并回一条 warning —— 直接报错会让整条 30 秒的片子因为一行字失败。
fn resolve_title_font() -> Option<std::path::PathBuf> {
    const CANDIDATES: [&str; 6] = [
        // Windows：微软雅黑（中英文都有），退到黑体。
        "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/msyhbd.ttc",
        "C:/Windows/Fonts/simhei.ttf",
        // macOS
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Medium.ttc",
        // Linux
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ];
    CANDIDATES
        .iter()
        .map(std::path::PathBuf::from)
        .find(|path| path.is_file())
}

/// 把文字写进临时文件，drawtext 用 `textfile=` 读。
///
/// 🔴 **不要用 `text=` 内联**：drawtext 的文本要过两层转义（filtergraph 一遍、filter 参数一遍），
/// 冒号、逗号、单引号、反斜杠、百分号都得逐个处理，中文再加一层容易出错。
/// 写文件后 ffmpeg 原样读字节，换行也天然支持。
fn write_title_file(index: usize, text: &str) -> Result<std::path::PathBuf, String> {
    let path = std::env::temp_dir().join(format!("lentalk-title-{}-{index}.txt", Uuid::new_v4()));
    std::fs::write(&path, text.as_bytes())
        .map_err(|error| format!("写入文字文件失败: {error}"))?;
    Ok(path)
}

/// 九宫格 → drawtext 的 `x` / `y` 表达式。
///
/// 位置串是 `<纵向>-<横向>`（`top-center` / `bottom-right` / `middle-left`）。
/// `margin` 按画布高算，保证 720p 和 1080p 看起来边距一致。
fn title_position_expr(position: &str, margin: f64) -> (String, String) {
    let margin = format!("{margin:.0}");
    let (vertical, horizontal) = position.split_once('-').unwrap_or(("bottom", "center"));
    let x = match horizontal {
        "left" => margin.clone(),
        "right" => format!("w-text_w-{margin}"),
        _ => "(w-text_w)/2".to_string(),
    };
    let y = match vertical {
        "top" => margin.clone(),
        "bottom" => format!("h-text_h-{margin}"),
        _ => "(h-text_h)/2".to_string(),
    };
    (x, y)
}

/// 收敛文字请求：过滤空文本、裁到成片长度、按画布高缩放字号、落成文本文件。
fn normalize_titles(
    request: &AdvancedVideoEditRequest,
    total_duration: f64,
    height: u32,
    warnings: &mut Vec<String>,
) -> Vec<NormalizedTitle> {
    if request.titles.is_empty() {
        return Vec::new();
    }
    let Some(font) = resolve_title_font() else {
        warnings.push("系统里没找到可用字体，文字没有画到成片上".to_string());
        return Vec::new();
    };

    // 字号按 1080p 设计，按实际画布高缩放；下限 8px，再小就成噪点了。
    let scale = height as f64 / 1080.0;
    let mut titles = Vec::new();
    for (index, title) in request.titles.iter().enumerate() {
        let text = title.text.trim_end();
        if text.trim().is_empty() {
            continue;
        }
        let start = sanitize_seconds(Some(title.start)).unwrap_or(0.0).max(0.0);
        let end = sanitize_seconds(Some(title.end)).unwrap_or(start).min(total_duration);
        if end - start < MIN_TRIM_DURATION_SEC - TRIM_EPSILON_SEC {
            // 完全落在成片之外（或短到看不见）：跳过而不是报错。
            continue;
        }
        let font_size = (title.font_size.unwrap_or(48.0) * scale).round().clamp(8.0, 400.0) as u32;
        let color = sanitize_hex_color(title.color.as_deref());
        let position = sanitize_title_position(title.position.as_deref());
        let Ok(text_file) = write_title_file(index, text) else {
            warnings.push("有文字写入临时文件失败，已跳过".to_string());
            continue;
        };
        titles.push(NormalizedTitle {
            text_file,
            font_file: font.clone(),
            start,
            end,
            font_size,
            color,
            position,
            backdrop: title.backdrop.unwrap_or(true),
        });
    }
    titles
}

/// `#RRGGBB` → `0xRRGGBB`；非法值退回白色（宁可白字，也不要 ffmpeg 因颜色解析失败中止）。
fn sanitize_hex_color(value: Option<&str>) -> String {
    let raw = value.unwrap_or("").trim();
    let hex = raw.strip_prefix('#').or_else(|| raw.strip_prefix("0x")).or_else(|| raw.strip_prefix("0X"));
    match hex {
        Some(hex) if hex.len() == 6 && hex.chars().all(|character| character.is_ascii_hexdigit()) => {
            format!("0x{}", hex.to_ascii_uppercase())
        }
        _ => "0xFFFFFF".to_string(),
    }
}

fn sanitize_title_position(value: Option<&str>) -> String {
    const ALLOWED: [&str; 9] = [
        "top-left", "top-center", "top-right",
        "middle-left", "middle-center", "middle-right",
        "bottom-left", "bottom-center", "bottom-right",
    ];
    let raw = value.unwrap_or("").trim();
    if ALLOWED.contains(&raw) {
        raw.to_string()
    } else {
        "bottom-center".to_string()
    }
}

/// 收敛一条关键帧曲线：裁到片段内、按时间排序、同刻去重、限幅。
///
/// 后端不假设前端守规矩：`t` 可能是负数、NaN、超出片段长度，值可能离谱。
/// 这些脏数据进到滤镜表达式里会让整条渲染失败（而且报错信息完全指不到源头）。
fn normalize_track(
    frames: &[AdvancedKeyframeRequest],
    duration: f64,
    min: f64,
    max: f64,
) -> Track {
    let mut list: Vec<NormalizedKeyframe> = frames
        .iter()
        .filter(|frame| frame.t.is_finite() && frame.v.is_finite())
        .map(|frame| NormalizedKeyframe {
            t: frame.t.clamp(0.0, duration.max(0.0)),
            v: frame.v.clamp(min, max),
            easing: parse_easing(frame.e.as_deref()),
        })
        .collect();
    list.sort_by(|left, right| left.t.partial_cmp(&right.t).unwrap_or(std::cmp::Ordering::Equal));
    // 同一时刻只留最后一帧（后来覆盖先来），并限制数量：表达式里每个关键帧就是一层 if()。
    list.dedup_by(|later, earlier| {
        if (later.t - earlier.t).abs() < 1e-3 {
            earlier.v = later.v;
            earlier.easing = later.easing;
            true
        } else {
            false
        }
    });
    list.truncate(MAX_KEYFRAMES_PER_PROPERTY);
    if list.is_empty() {
        None
    } else {
        Some(list)
    }
}

fn resolve_keyframes(
    request: Option<&AdvancedClipKeyframesRequest>,
    duration: f64,
) -> NormalizedTracks {
    let Some(request) = request else {
        return NormalizedTracks::default();
    };
    NormalizedTracks {
        x: normalize_track(&request.x, duration, -MAX_CLIP_OFFSET, MAX_CLIP_OFFSET),
        y: normalize_track(&request.y, duration, -MAX_CLIP_OFFSET, MAX_CLIP_OFFSET),
        rotation: normalize_track(&request.rotation, duration, -360.0, 360.0),
    }
}

/// 缓动表达式：输入进度 `p`（0~1，已 clamp），输出缓动后的进度。
fn easing_expression(easing: Easing, progress: &str) -> String {
    match easing {
        Easing::Linear => progress.to_string(),
        Easing::EaseIn => format!("({progress})*({progress})"),
        Easing::EaseOut => format!("1-(1-({progress}))*(1-({progress}))"),
        Easing::EaseInOut => format!(
            "if(lt({progress},0.5),2*({progress})*({progress}),1-2*(1-({progress}))*(1-({progress})))"
        ),
    }
}

/// 把一条关键帧曲线编译成 ffmpeg 表达式（关于时间变量 `var` 的函数）。
///
/// 结构是一串嵌套 `if(lt(var, t_next), 本段插值, 后面的段)`，从最后一帧往前套。
/// `convert` 用来把值换算成滤镜要的单位（位移 % → 像素）。
///
/// 🔴 里面的逗号**不能在这层转义**：调用方统一处理（见 `escape_expression`），
/// 否则同一串会被转义两次，ffmpeg 会当成普通字符而不是分隔符。
fn keyframe_expression(
    frames: &[NormalizedKeyframe],
    var: &str,
    convert: &dyn Fn(f64) -> f64,
) -> String {
    if frames.len() == 1 {
        return format!("{:.4}", convert(frames[0].v));
    }
    let last = frames[frames.len() - 1];
    let mut expression = format!("{:.4}", convert(last.v));
    for index in (0..frames.len() - 1).rev() {
        let from = frames[index];
        let to = frames[index + 1];
        let span = (to.t - from.t).max(1e-4);
        // 进度必须 clamp：片段起点之前 / 末帧之后会算出越界的 p，曲线会飞出去。
        let progress = format!("max(0,min(1,({var}-{:.4})/{span:.4}))", from.t);
        let eased = easing_expression(from.easing, &progress);
        let from_value = convert(from.v);
        let delta = convert(to.v) - from_value;
        let segment = format!("({from_value:.4}+({delta:.4})*({eased}))");
        expression = format!("if(lt({var},{:.4}),{segment},{expression})", to.t);
    }
    // 首帧之前保持首帧值（不外插）。
    format!("if(lt({var},{:.4}),{:.4},{expression})", frames[0].t, convert(frames[0].v))
}

/// 滤镜参数里的表达式要再转义一层逗号：`,` 是 filter 的选项分隔符。
fn escape_expression(expression: &str) -> String {
    expression.replace(',', "\\,")
}

/// 收敛前端传来的变换：缺省用默认值，越界夹到合法范围。
///
/// 前端也 clamp 过一次，这里再做一遍不是多余 —— IPC 参数可以是任何值
/// （旧版本前端、手改的工程文件），后端不能假设它守规矩。
fn resolve_clip_transform(request: Option<&AdvancedClipTransformRequest>) -> NormalizedTransform {
    let Some(request) = request else {
        return NormalizedTransform::default();
    };
    let pick = |value: Option<f64>, fallback: f64, min: f64, max: f64| match value {
        Some(value) if value.is_finite() => value.clamp(min, max),
        _ => fallback,
    };
    // `scale` 是两个轴的回退值，和前端 `resolveScaleAxes` 一致。
    let scale = pick(request.scale, 1.0, MIN_CLIP_SCALE, MAX_CLIP_SCALE);
    NormalizedTransform {
        scale,
        scale_x: pick(request.scale_x, scale, MIN_CLIP_SCALE, MAX_CLIP_SCALE),
        scale_y: pick(request.scale_y, scale, MIN_CLIP_SCALE, MAX_CLIP_SCALE),
        x: pick(request.x, 0.0, -MAX_CLIP_OFFSET, MAX_CLIP_OFFSET),
        y: pick(request.y, 0.0, -MAX_CLIP_OFFSET, MAX_CLIP_OFFSET),
        rotation: pick(request.rotation, 0.0, -360.0, 360.0),
        opacity: pick(request.opacity, 1.0, 0.0, 1.0),
        border_radius: pick(request.border_radius, 0.0, 0.0, MAX_CLIP_RADIUS),
    }
}

/// 片段在画布上的显示尺寸（缩放后，未旋转）。
///
/// 基准是「等比装进画布」后的尺寸（等价于 ffmpeg 的
/// `scale=W:H:force_original_aspect_ratio=decrease`），再乘用户缩放。
/// 这样「100%」永远表示「正好铺满画布的那一档」，和后端预览/导出语义一致。
fn fit_size(probe: &MediaProbe, canvas_width: u32, canvas_height: u32) -> (f64, f64) {
    let (Some(source_width), Some(source_height)) = (probe.width, probe.height) else {
        return (canvas_width as f64, canvas_height as f64);
    };
    if source_width == 0 || source_height == 0 {
        return (canvas_width as f64, canvas_height as f64);
    }
    let fit = (canvas_width as f64 / source_width as f64)
        .min(canvas_height as f64 / source_height as f64);
    (source_width as f64 * fit, source_height as f64 * fit)
}

fn display_size(probe: &MediaProbe, canvas_width: u32, canvas_height: u32, transform: &NormalizedTransform) -> (u32, u32) {
    let (fit_width, fit_height) = fit_size(probe, canvas_width, canvas_height);
    (
        scale_dimension(fit_width, transform.scale_x),
        scale_dimension(fit_height, transform.scale_y),
    )
}

/// 缩放后的像素长度：至少 2px（1px 会让某些滤镜直接报错），并取偶数便于编码。
fn scale_dimension(base: f64, scale: f64) -> u32 {
    let value = (base * scale).round().max(2.0) as u32;
    if value % 2 == 0 { value } else { value + 1 }
}

/// 画一张圆角矩形蒙版（灰度：白=保留，黑=透明），给 `alphamerge` 用。
///
/// 🔴 用**预生成一张 PNG** 而不是 `geq` 逐像素算：`geq` 是每个像素每帧都跑一遍表达式，
/// 1080p、10 秒就是 600 万次求值，渲染会慢到不可用。蒙版是静态的，生成一次即可。
///
/// 抗锯齿用「到圆角矩形的有符号距离」做 1px 过渡，边缘比硬切干净得多。
fn write_rounded_mask(width: u32, height: u32, radius: f64) -> Result<PathBuf, String> {
    let path = std::env::temp_dir().join(format!("lentalk-mask-{}.png", Uuid::new_v4()));
    let w = width.max(1);
    let h = height.max(1);
    let radius = radius.clamp(0.0, (w.min(h) as f64) / 2.0);
    let mut buffer = image::GrayImage::new(w, h);
    let half_w = w as f64 / 2.0;
    let half_h = h as f64 / 2.0;
    for y in 0..h {
        for x in 0..w {
            // 像素中心相对画面中心的坐标。
            let px = x as f64 + 0.5 - half_w;
            let py = y as f64 + 0.5 - half_h;
            // 圆角矩形的有符号距离（负数在内部）。
            let qx = px.abs() - (half_w - radius);
            let qy = py.abs() - (half_h - radius);
            let outside = (qx.max(0.0).powi(2) + qy.max(0.0).powi(2)).sqrt();
            let distance = outside + qx.max(qy).min(0.0) - radius;
            let coverage = (0.5 - distance).clamp(0.0, 1.0);
            buffer.put_pixel(x, y, image::Luma([(coverage * 255.0).round() as u8]));
        }
    }
    buffer
        .save(&path)
        .map_err(|error| format!("写入圆角蒙版失败: {error}"))?;
    Ok(path)
}

fn normalize_advanced(
    request: &AdvancedVideoEditRequest,
    probes: &HashMap<String, MediaProbe>,
) -> Result<NormalizedAdvanced, String> {
    if request.clips.is_empty() {
        return Err("时间线上还没有片段".to_string());
    }

    // 画布尺寸取第一段的尺寸：整条片子以第一段为准，其余片段等比缩放 + 留边。
    // 必须先于片段循环算出来 —— 每段的显示尺寸（缩放后的像素宽高）要拿它当基准。
    // 画布尺寸取第一段的尺寸：整条片子以第一段为准，其余片段等比缩放 + 留边。
    let first_probe = probes
        .get(&request.clips[0].source_path)
        .ok_or_else(|| "读取素材尺寸失败".to_string())?;
    let (width, height) = match (first_probe.width, first_probe.height) {
        (Some(width), Some(height)) => (even(width), even(height)),
        _ => return Err("无法读取第一段素材的画面尺寸，无法确定画布".to_string()),
    };
    let fps = snap_fps_rational(first_probe.fps.unwrap_or(30.0));

    let mut inputs: Vec<String> = Vec::new();
    let mut index_of: HashMap<String, usize> = HashMap::new();
    let mut clips: Vec<NormalizedClip> = Vec::with_capacity(request.clips.len());
    // 非致命问题（缺字体、圆角与缩放动画冲突…）：一路收集，最后随结果透传给前端。
    let mut warnings: Vec<String> = Vec::new();

    for (position, clip) in request.clips.iter().enumerate() {
        let resolved = local_or_remote_video_source(&clip.source_path)
            .ok_or_else(|| format!("第 {} 段的素材来源不支持", position + 1))?;
        let probe = probes
            .get(&clip.source_path)
            .ok_or_else(|| format!("第 {} 段读取素材信息失败", position + 1))?;

        let start = sanitize_seconds(Some(clip.start)).unwrap_or(0.0);
        // 用户给的终点可能超过真实时长（前端拿到的是估算值），按探测值收口。
        let end = match probe.duration_sec {
            Some(total) if total > 0.0 => clip.end.min(total),
            _ => clip.end,
        };
        if !end.is_finite() || is_clip_too_short(start, end) {
            return Err(format!("第 {} 段太短，请至少保留 0.1 秒", position + 1));
        }

        let path_index = match index_of.get(&resolved) {
            Some(index) => *index,
            None => {
                let index = inputs.len();
                inputs.push(resolved.clone());
                index_of.insert(resolved, index);
                index
            }
        };
        let transform = resolve_clip_transform(clip.transform.as_ref());
        let tracks = resolve_keyframes(clip.keyframes.as_ref(), end - start);

        // 显示尺寸 = 「等比装进画布」的尺寸 × 用户缩放。
        // 静态算出来是为了：① 滤镜参数用整数更稳；② 圆角蒙版要按这个尺寸生成。
        let (display_width, display_height) = display_size(probe, width, height, &transform);

        clips.push(NormalizedClip {
            path_index,
            start,
            end,
            has_audio: probe.has_audio,
            transform,
            display_width,
            display_height,
            tracks,
            mask_path: None,
        });
    }

    let total_duration: f64 = clips.iter().map(|clip| clip.duration()).sum();
    if total_duration < MIN_TRIM_DURATION_SEC - TRIM_EPSILON_SEC {
        return Err("成片太短，请至少保留 0.1 秒".to_string());
    }

    let keep_audio = !matches!(
        request.audio_mode.as_deref().map(str::trim).map(str::to_ascii_lowercase).as_deref(),
        Some("mute")
    );

    let music = match request.music.as_ref() {
        Some(music) => {
            let resolved = local_or_remote_video_source(&music.source_path)
                .ok_or_else(|| "音乐轨来源不支持".to_string())?;
            let probe = probes
                .get(&music.source_path)
                .ok_or_else(|| "读取音乐轨信息失败".to_string())?;
            let start = sanitize_seconds(music.start).unwrap_or(0.0).max(0.0);
            if start >= total_duration {
                // 音乐起点落在成片之外：忽略比报错更友好（用户可能只是拖过头了）。
                None
            } else {
                let available = (total_duration - start).max(0.0);
                let source_length = probe.duration_sec.unwrap_or(available);
                let duration = available.min(source_length);
                if duration < MIN_TRIM_DURATION_SEC - TRIM_EPSILON_SEC {
                    None
                } else {
                    let path_index = match index_of.get(&resolved) {
                        Some(index) => *index,
                        None => {
                            let index = inputs.len();
                            inputs.push(resolved.clone());
                            index_of.insert(resolved, index);
                            index
                        }
                    };
                    let (fade_in, fade_out) = clamp_music_fades(
                        sanitize_seconds(music.fade_in).unwrap_or(0.0),
                        sanitize_seconds(music.fade_out).unwrap_or(0.0),
                        duration,
                    );
                    Some(NormalizedMusic {
                        path_index,
                        start,
                        duration,
                        volume: clamp_volume(music.volume),
                        fade_in,
                        fade_out,
                    })
                }
            }
        }
        None => None,
    };

    // 文字最后处理：它依赖成片总长（超出范围的直接丢掉）与画布高（字号缩放）。
    let titles = normalize_titles(request, total_duration, height, &mut warnings);

    // 圆角蒙版放到最后生成：前面任何一步校验失败都会提前 return，早写文件只会留垃圾。
    let needs_composite = clips
        .iter()
        .any(|clip| !clip.transform.is_identity() || !clip.tracks.is_empty());
    for clip in clips.iter_mut() {
        if clip.transform.border_radius < 0.5 {
            continue;
        }
        match write_rounded_mask(clip.display_width, clip.display_height, clip.transform.border_radius) {
            Ok(path) => clip.mask_path = Some(path),
            // 蒙版写不出来就退成直角，不要因为一个装饰性效果让整条片子失败。
            Err(error) => warnings.push(format!("圆角未生效: {error}")),
        }
    }

    Ok(NormalizedAdvanced {
        inputs,
        clips,
        needs_composite,
        titles,
        warnings,
        music,
        keep_audio,
        audio_volume: clamp_volume(request.audio_volume),
        width,
        height,
        fps,
        total_duration,
    })
}

/// 淡入淡出按用户比例缩到音乐时长内，而不是各自先夹再缩放（否则丢掉轻重关系）。
fn clamp_music_fades(fade_in: f64, fade_out: f64, duration: f64) -> (f64, f64) {
    let fade_in = fade_in.clamp(0.0, MAX_FADE_SEC);
    let fade_out = fade_out.clamp(0.0, MAX_FADE_SEC);
    let sum = fade_in + fade_out;
    if sum <= duration || sum <= 0.0 {
        return (fade_in.min(duration), fade_out.min(duration));
    }
    let scale = duration / sum;
    (fade_in * scale, fade_out * scale)
}

fn build_advanced_args(edit: &NormalizedAdvanced, output: &Path) -> Vec<String> {
    let mut args: Vec<String> = ["-y", "-hide_banner", "-loglevel", "error"]
        .iter()
        .map(|value| value.to_string())
        .collect();

    for clip in &edit.clips {
        if clip.start > 0.0 {
            args.push("-ss".to_string());
            args.push(fmt_seconds(clip.start));
        }
        args.push("-t".to_string());
        args.push(fmt_seconds(clip.duration()));
        args.push("-i".to_string());
        args.push(edit.inputs[clip.path_index].clone());
    }
    if let Some(music) = edit.music {
        args.push("-i".to_string());
        args.push(edit.inputs[music.path_index].clone());
    }

    // 圆角蒙版是额外的**图片输入**：`-loop 1` 让静态图变成一条与画面同长的流，
    // `alphamerge` 才能逐帧取用。索引要在滤镜图里对得上，所以边加边记。
    let mut mask_inputs: HashMap<usize, usize> = HashMap::new();
    let mut input_count = edit.clips.len() + usize::from(edit.music.is_some());
    for (index, clip) in edit.clips.iter().enumerate() {
        let Some(mask) = clip.mask_path.as_ref() else {
            continue;
        };
        args.push("-loop".to_string());
        args.push("1".to_string());
        args.push("-framerate".to_string());
        args.push(edit.fps.clone());
        args.push("-i".to_string());
        args.push(mask.to_string_lossy().to_string());
        mask_inputs.insert(index, input_count);
        input_count += 1;
    }

    let (graph, audio_label) = build_advanced_graph(edit, &mask_inputs);
    args.push("-filter_complex".to_string());
    args.push(graph);
    args.push("-map".to_string());
    args.push("[vout]".to_string());
    match audio_label {
        Some(label) => {
            args.push("-map".to_string());
            args.push(label);
            args.push("-c:a".to_string());
            args.push("aac".to_string());
            args.push("-b:a".to_string());
            args.push(AUDIO_BITRATE.to_string());
        }
        None => args.push("-an".to_string()),
    }

    // 成片长度以片段之和为上限：音乐被 adelay 推后会把尾巴拖长，必须显式裁掉。
    args.push("-t".to_string());
    args.push(fmt_seconds(edit.total_duration));

    args.push("-c:v".to_string());
    args.push("libx264".to_string());
    args.push("-preset".to_string());
    args.push(VIDEO_PRESET.to_string());
    args.push("-crf".to_string());
    args.push(VIDEO_CRF.to_string());
    args.push("-pix_fmt".to_string());
    args.push("yuv420p".to_string());
    args.push("-movflags".to_string());
    args.push("+faststart".to_string());
    args.push(output.to_string_lossy().to_string());
    args
}

/// 拼滤镜图。返回 `(graph, 音频输出标签)`；音频为 `None` 表示成片无音轨。
/// filter 参数里的路径转义：`:` 会被当成选项分隔符，`'` 会破坏引号，反斜杠统一转正斜杠。
fn escape_filter_path(path: &str) -> String {
    path.replace('\\', "/").replace(':', "\\:").replace('\'', "\\'")
}

/// 一段 drawtext。
///
/// 文本走 `textfile=`（见 `write_title_file`）；颜色已转成 `0xRRGGBB`；
/// `enable` 里的逗号必须转义 —— filter 参数的逗号是分隔符，不转义会直接把图形拆坏。
fn build_drawtext(title: &NormalizedTitle, height: u32) -> String {
    // 边距按画布高算：4.5% 在 1080p 上是 48px，720p 上是 29px，看起来一致。
    let margin = (height as f64 * 0.045).round().max(16.0);
    let (x, y) = title_position_expr(&title.position, margin);
    // 🔴 `expansion=none` 不能省。drawtext 默认会把文本里的 `%` 当展开语法解析，
    // 字幕里只要出现「100%」就整帧绘制失败（stderr 只有一行 `Stray % near ...`，
    // 帧上却什么都没有，极难往这里想）。实测：不加这个参数时字完全不显示。
    let mut spec = format!(
        "drawtext=fontfile='{}':textfile='{}':expansion=none:fontsize={}:fontcolor={}",
        escape_filter_path(&title.font_file.to_string_lossy()),
        escape_filter_path(&title.text_file.to_string_lossy()),
        title.font_size,
        title.color,
    );
    if title.backdrop {
        // 半透明底衬：浅色画面上白字也能读。
        spec.push_str(":box=1:boxcolor=black@0.45:boxborderw=14");
    }
    spec.push_str(&format!(":line_spacing=8:x={x}:y={y}"));
    spec.push_str(&format!(
        ":enable=between(t\\,{start:.3}\\,{end:.3})",
        start = title.start,
        end = title.end,
    ));
    spec
}

/// 拼整个滤镜图：`(graph, 音频输出标签)`，音频 `None` 表示成片无音轨。
///
/// **两条视频路径**：
/// - 所有片段都没变换 → `concat`（老路径，快、稳）；
/// - 有任意片段带变换 → 合成（每段叠到黑底画布上，用 `enable` 控制时间窗）。
///
/// 之所以不统一走合成：concat 只在完全没有变换时才等价，而绝大多数片子是不改几何的，
/// 没必要为一个功能让所有导出都多付一层 overlay 的开销。
fn build_advanced_graph(
    edit: &NormalizedAdvanced,
    mask_inputs: &HashMap<usize, usize>,
) -> (String, Option<String>) {
    let mut parts: Vec<String> = if edit.needs_composite {
        build_composite_video(edit, mask_inputs)
    } else {
        build_concat_video(edit)
    };

    let audio_label = build_audio(edit, &mut parts);

    // 文字接在视频输出 [vcat] 之后：每段一个 drawtext，串成一条链。
    // 空文本在收敛阶段已被过滤，这里拿到的都是要画的字。
    let mut video_label = "[vcat]".to_string();
    for (index, title) in edit.titles.iter().enumerate() {
        let next = format!("[vt{index}]");
        parts.push(format!("{video_label}{}{next}", build_drawtext(title, edit.height)));
        video_label = next;
    }
    parts.push(format!("{video_label}null[vout]"));

    (parts.join(";"), audio_label)
}

/// 老路径：逐段等比装进画布 → concat。输出 `[vcat]`。
fn build_concat_video(edit: &NormalizedAdvanced) -> Vec<String> {
    let width = edit.width;
    let height = edit.height;
    let mut parts: Vec<String> = Vec::with_capacity(edit.clips.len() + 1);

    for (index, clip) in edit.clips.iter().enumerate() {
        // 等比缩放后居中留边，再统一 SAR 与帧率 —— concat 要求这三者完全一致。
        parts.push(format!(
            "[{input}:v]scale={width}:{height}:force_original_aspect_ratio=decrease,\
pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps},format=yuv420p,\
setpts=PTS-STARTPTS[v{index}]",
            input = clip.path_index,
            fps = edit.fps,
        ));
    }
    // 保留原声时用**一条** concat 同时出画面和声音（老路径，一次搞定）；
    // 只有走合成路径时视频不从 concat 出来，音频才需要单独 concat。
    if edit.keep_audio {
        let pairs: String = (0..edit.clips.len()).map(|index| format!("[v{index}][a{index}]")).collect();
        parts.push(format!(
            "{pairs}concat=n={count}:v=1:a=1[vcat][acat]",
            count = edit.clips.len()
        ));
    } else {
        let pairs: String = (0..edit.clips.len()).map(|index| format!("[v{index}]")).collect();
        parts.push(format!(
            "{pairs}concat=n={count}:v=1:a=0[vcat]",
            count = edit.clips.len()
        ));
    }
    parts
}

/// 合成路径：黑底画布 + 每段（缩放 / 圆角 / 旋转 / 透明度）叠上去，用时间窗控制出场。
///
/// 为什么用 overlay 而不是 pad：`pad` 要求输入必须**小于**输出画布，缩放 > 100% 时直接失败；
/// `overlay` 支持负坐标并自己裁切，放大、移出画面、旋转都能覆盖。
fn build_composite_video(edit: &NormalizedAdvanced, mask_inputs: &HashMap<usize, usize>) -> Vec<String> {
    let width = edit.width;
    let height = edit.height;
    let mut parts: Vec<String> = Vec::with_capacity(edit.clips.len() * 6 + 2);

    // 黑底画布先铺满整条成片，后面每段只是「在有自己画面的那段时间里」叠上来。
    parts.push(format!(
        "color=c=black:s={width}x{height}:r={fps}:d={duration}[base0]",
        fps = edit.fps,
        duration = fmt_seconds(edit.total_duration),
    ));

    let mut label = "[base0]".to_string();
    let mut start = 0.0_f64;

    for (index, clip) in edit.clips.iter().enumerate() {
        let duration = clip.duration();
        let transform = clip.transform;
        let tracks = &clip.tracks;

        // 缩放是静态的（动画版会让输出尺寸逐帧变，见 NormalizedTracks 的注释）。
        // 注意 setpts 放到最后（overlay 之前）：这样 rotate 里的 `t` 是**片段内相对时间**，
        // 只有 overlay 需要减掉 start 换算回相对时间，少一层心智负担。
        parts.push(format!(
            "[{input}:v]scale={dw}:{dh},setsar=1,fps={fps},format=rgba[cf{index}]",
            dw = clip.display_width,
            dh = clip.display_height,
            input = clip.path_index,
            fps = edit.fps,
        ));
        let mut current = format!("[cf{index}]");

        if let Some(mask_index) = mask_inputs.get(&index) {
            // 蒙版是灰度图：白=不透明。`alphamerge` 用它的亮度替换 alpha。
            parts.push(format!("[{mask_index}:v]format=gray[mk{index}]"));
            parts.push(format!("{current}[mk{index}]alphamerge[cr{index}]"));
            current = format!("[cr{index}]");
        }

        // ── 旋转：动画时 a 是表达式，外接框按「最大角度」静态算一次 ──
        let max_angle = match &tracks.rotation {
            Some(frames) => frames.iter().map(|frame| frame.v.abs()).fold(0.0, f64::max),
            None => transform.rotation.abs(),
        };
        if max_angle > 1e-4 {
            let angle = match &tracks.rotation {
                Some(frames) => format!(
                    "'{}'",
                    escape_expression(&keyframe_expression(frames, "t", &|value| value * std::f64::consts::PI / 180.0))
                ),
                None => format!("{:.6}*PI/180", transform.rotation),
            };
            let radians = max_angle * std::f64::consts::PI / 180.0;
            // 外接框必须静态：输出尺寸不能逐帧变。
            parts.push(format!(
                "{current}rotate=a={angle}:c=none:ow=rotw({radians:.6}):oh=roth({radians:.6})[rt{index}]"
            ));
            current = format!("[rt{index}]");
        }

        if (transform.opacity - 1.0).abs() > 1e-4 {
            parts.push(format!(
                "{current}colorchannelmixer=aa={alpha:.4}[op{index}]",
                alpha = transform.opacity,
            ));
            current = format!("[op{index}]");
        }

        // ── 时间轴对齐 ──
        parts.push(format!(
            "{current}setpts=PTS-STARTPTS+{start}/TB[sp{index}]",
            start = fmt_seconds(start),
        ));
        current = format!("[sp{index}]");

        // ── 叠加：位移按画布百分比换算成像素；动画时是表达式 ──
        let offset_x = offset_argument(&tracks.x, transform.x, start, width as f64);
        let offset_y = offset_argument(&tracks.y, transform.y, start, height as f64);
        let next = format!("[b{}]", index + 1);
        parts.push(format!(
            "{label}{current}overlay=x=(W-w)/2{offset_x}:y=(H-h)/2{offset_y}:eof_action=pass:repeatlast=0:enable='between(t,{from},{to})'{next}",
            from = fmt_seconds(start),
            to = fmt_seconds(start + duration),
        ));
        label = next;
        start += duration;
    }

    parts.push(format!("{label}format=yuv420p[vcat]"));
    parts
}

/// 位移参数：静态时给 `+12.000` 形式的像素偏移，动画时给 `+(表达式)`。
///
/// `var_template` 里的 `{}` 会被替换成片段起点秒数 —— overlay 的 `t` 是**成片绝对时间**，
/// 而关键帧的时间是相对片段起点的，必须减掉。
fn offset_argument(track: &Track, percent: f64, start: f64, dimension: f64) -> String {
    match track {
        Some(frames) => {
            // overlay 的 `t` 是成片绝对时间，关键帧是相对片段起点的：减掉起点换算回相对时间。
            // 🔴 时间变量只在这里拼一次 —— 之前用 `replace("{}")` 占位符，模板里写的却是 `{:.3}`，
            // 结果 `(t-{:.3})` 原样进了表达式，ffmpeg 直接解析失败。
            let var = format!("(t-{start:.3})");
            let expression = keyframe_expression(frames, &var, &|value| value / 100.0 * dimension);
            format!("+({})", escape_expression(&expression))
        }
        None => signed(percent / 100.0 * dimension),
    }
}

/// 音频：逐段原声 → concat；再看要不要混音乐。返回输出标签。
fn build_audio(edit: &NormalizedAdvanced, parts: &mut Vec<String>) -> Option<String> {
    let count = edit.clips.len();
    if edit.keep_audio {
        for (index, clip) in edit.clips.iter().enumerate() {
            parts.push(clip_audio_chain(index, clip, count));
        }
        // 合成路径下视频不走 concat，声音就得自己 concat 一条（v=0）。
        if edit.needs_composite {
            let pairs: String = (0..count).map(|index| format!("[a{index}]")).collect();
            parts.push(format!("{pairs}concat=n={count}:v=0:a=1[acat]"));
        }
    }

    let music_label = edit.music.map(|music| {
        let mut chain = format!(
            "[{index}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,\
atrim=0:{duration},asetpts=PTS-STARTPTS,volume={volume}",
            index = music.path_index,
            duration = fmt_seconds(music.duration),
            volume = format!("{:.3}", music.volume),
        );
        if music.fade_in > 0.0 {
            chain.push_str(&format!(",afade=t=in:st=0:d={:.3}", music.fade_in));
        }
        if music.fade_out > 0.0 {
            let start = (music.duration - music.fade_out).max(0.0);
            chain.push_str(&format!(",afade=t=out:st={start:.3}:d={:.3}", music.fade_out));
        }
        // adelay 放在最后：先裁到音乐自身长度，再把整段推到时间轴位置。
        let delay_ms = (music.start * 1000.0).round().max(0.0) as u64;
        chain.push_str(&format!(",adelay={delay_ms}:all=1[am]"));
        parts.push(chain);
        "[am]".to_string()
    });

    match (edit.keep_audio, music_label) {
        (true, Some(_music)) => {
            parts.push(format!("[acat]volume={:.3}[as]", edit.audio_volume));
            // duration=first 让混音跟着画面走：第一个输入是原声（长度 = 成片）。
            parts.push(
                "[as][am]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]"
                    .to_string(),
            );
            Some("[aout]".to_string())
        }
        (true, None) => {
            parts.push(format!("[acat]volume={:.3}[aout]", edit.audio_volume));
            Some("[aout]".to_string())
        }
        (false, Some(_)) => Some("[am]".to_string()),
        (false, None) => None,
    }
}

/// 带符号的小数：`+12.300` / `-12.300`。
///
/// ffmpeg 表达式里 `+-12.3` 这种「两个运算符挨着」的写法不能保证解析正确，
/// 所以符号直接拼进字符串，而不是依赖 `{:+}` 再让表达式自己消化。
fn signed(value: f64) -> String {
    if value < 0.0 {
        format!("-{:.3}", value.abs())
    } else {
        format!("+{:.3}", value)
    }
}

/// 单段音频链。**没有音轨的片段必须补静音**，否则 `concat a=1` 整段失败。
fn clip_audio_chain(index: usize, clip: &NormalizedClip, _count: usize) -> String {
    if clip.has_audio {
        format!(
            "[{input}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,\
asetpts=PTS-STARTPTS[a{index}]",
            input = clip.path_index,
        )
    } else {
        format!(
            "anullsrc=r=48000:cl=stereo,atrim=0:{duration},\
aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[a{index}]",
            duration = fmt_seconds(clip.duration()),
        )
    }
}

/// 逐段探测（同一路径只探一次）。
fn probe_all(ffmpeg: &Path, request: &AdvancedVideoEditRequest) -> HashMap<String, MediaProbe> {
    let mut probes = HashMap::new();
    for clip in &request.clips {
        if probes.contains_key(&clip.source_path) {
            continue;
        }
        if let Some(resolved) = local_or_remote_video_source(&clip.source_path) {
            probes.insert(clip.source_path.clone(), probe_media(ffmpeg, &resolved));
        }
    }
    if let Some(music) = request.music.as_ref() {
        if !probes.contains_key(&music.source_path) {
            if let Some(resolved) = local_or_remote_video_source(&music.source_path) {
                probes.insert(music.source_path.clone(), probe_media(ffmpeg, &resolved));
            }
        }
    }
    probes
}

#[tauri::command]
pub async fn render_video_edit_advanced(
    app: AppHandle,
    request: AdvancedVideoEditRequest,
) -> Result<AdvancedVideoEditResult, String> {
    tauri::async_runtime::spawn_blocking(move || render_advanced_blocking(app, request))
        .await
        .map_err(|error| format!("高级剪辑任务失败: {error}"))?
}

fn render_advanced_blocking(
    app: AppHandle,
    request: AdvancedVideoEditRequest,
) -> Result<AdvancedVideoEditResult, String> {
    let mut ffmpeg = resolve_ffmpeg_path(&app);
    if ffmpeg.is_none() {
        super::pajuben::ensure_ffmpeg(&app)
            .map_err(|error| format!("未找到 ffmpeg，无法剪辑视频：{error}"))?;
        ffmpeg = resolve_ffmpeg_path(&app);
    }
    let ffmpeg = ffmpeg.ok_or_else(|| "未找到 ffmpeg，无法剪辑视频".to_string())?;

    let probes = probe_all(&ffmpeg, &request);
    let edit = normalize_advanced(&request, &probes)?;

    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?
        .join("library-assets");
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("无法创建素材目录: {error}"))?;
    let output: PathBuf = directory.join(format!("{}.mp4", Uuid::new_v4()));

    let outcome = run_ffmpeg_render(&ffmpeg, &edit, &output);

    // 临时文字文件**无论成败都要删**：它们是每次渲染现写的，
    // 留下来只会在系统 temp 里越积越多（而且内容全是用户配的字）。
    for title in &edit.titles {
        let _ = std::fs::remove_file(&title.text_file);
    }
    // 圆角蒙版同理：每次渲染现生成，留在 temp 里只会越积越多。
    for clip in &edit.clips {
        if let Some(mask) = &clip.mask_path {
            let _ = std::fs::remove_file(mask);
        }
    }
    outcome?;

    Ok(AdvancedVideoEditResult {
        output_path: output.to_string_lossy().to_string(),
        duration_sec: Some(edit.total_duration),
        canvas_width: edit.width,
        canvas_height: edit.height,
        warnings: edit.warnings,
    })
}

/// 真正跑一次 ffmpeg 并校验产物。拆出来是为了让调用方在 `?` 之前也能清理临时文件。
fn run_ffmpeg_render(ffmpeg: &Path, edit: &NormalizedAdvanced, output: &Path) -> Result<(), String> {
    let args = build_advanced_args(edit, output);
    let mut command = Command::new(ffmpeg);
    hide_child_console(&mut command);
    let result = command
        .args(&args)
        .output()
        .map_err(|error| format!("无法启动 ffmpeg: {error}"))?;
    if !result.status.success() {
        let _ = std::fs::remove_file(output);
        let detail = String::from_utf8_lossy(&result.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            format!("高级剪辑渲染失败 (exit: {:?})", result.status)
        } else {
            format!("高级剪辑渲染失败: {detail}")
        });
    }

    let empty_or_missing = output
        .metadata()
        .map(|metadata| metadata.len() == 0)
        .unwrap_or(true);
    if empty_or_missing {
        let _ = std::fs::remove_file(output);
        return Err("ffmpeg 未生成有效的视频文件".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(duration: f64, has_audio: bool, width: u32, height: u32) -> MediaProbe {
        MediaProbe {
            duration_sec: Some(duration),
            has_audio,
            fps: Some(30.0),
            width: Some(width),
            height: Some(height),
        }
    }

    fn request_of(clips: &[(&str, f64, f64)]) -> AdvancedVideoEditRequest {
        AdvancedVideoEditRequest {
            clips: clips
                .iter()
                .map(|(path, start, end)| AdvancedClipRequest {
                    source_path: (*path).to_string(),
                    start: *start,
                    end: *end,
                    transform: None,
                    keyframes: None,
                })
                .collect(),
            titles: Vec::new(),
            audio_mode: None,
            audio_volume: None,
            music: None,
        }
    }

    fn probes_for(request: &AdvancedVideoEditRequest) -> HashMap<String, MediaProbe> {
        let mut probes = HashMap::new();
        for clip in &request.clips {
            probes
                .entry(clip.source_path.clone())
                .or_insert_with(|| probe(10.0, true, 1920, 1080));
        }
        probes
    }

    fn args_of(edit: &NormalizedAdvanced) -> Vec<String> {
        build_advanced_args(edit, Path::new("/tmp/out.mp4"))
    }

    fn title_of(text: &str, start: f64, end: f64) -> AdvancedTitleRequest {
        AdvancedTitleRequest {
            text: text.to_string(),
            start,
            end,
            font_size: Some(48.0),
            color: Some("#FFCC00".to_string()),
            position: Some("bottom-center".to_string()),
            backdrop: Some(true),
        }
    }

    #[test]
    fn nine_grid_positions_map_to_drawtext_expressions() {
        let margin = 48.0;
        assert_eq!(title_position_expr("top-left", margin), ("48".to_string(), "48".to_string()));
        assert_eq!(
            title_position_expr("middle-center", margin),
            ("(w-text_w)/2".to_string(), "(h-text_h)/2".to_string())
        );
        assert_eq!(
            title_position_expr("bottom-right", margin),
            ("w-text_w-48".to_string(), "h-text_h-48".to_string())
        );
    }

    #[test]
    fn hex_color_is_normalized_and_falls_back_to_white() {
        assert_eq!(sanitize_hex_color(Some("#ffcc00")), "0xFFCC00");
        assert_eq!(sanitize_hex_color(Some("0x00FF00")), "0x00FF00");
        // 非法值一律白字：宁可颜色不对，也不要 ffmpeg 因解析失败整条中止。
        assert_eq!(sanitize_hex_color(Some("red")), "0xFFFFFF");
        assert_eq!(sanitize_hex_color(Some("#FFF")), "0xFFFFFF");
        assert_eq!(sanitize_hex_color(None), "0xFFFFFF");
    }

    #[test]
    fn filter_paths_escape_colon_and_quotes() {
        assert_eq!(
            escape_filter_path(r"C:/Windows/Fonts/msyh.ttc"),
            "C\\:/Windows/Fonts/msyh.ttc"
        );
        assert_eq!(escape_filter_path("/tmp/a'b.txt"), "/tmp/a\\'b.txt");
    }

    #[test]
    fn titles_become_a_drawtext_chain_after_concat() {
        let mut request = request_of(&[("/a.mp4", 0.0, 3.0)]);
        request.titles = vec![title_of("第一行", 0.0, 2.0), title_of("第二行", 1.0, 3.0)];
        let edit = normalize_advanced(&request, &probes_for(&request)).expect("normalizes");
        let graph = build_advanced_graph(&edit, &HashMap::new()).0;

        // 两条文字各自一段 drawtext，并且串在 concat 之后。
        assert_eq!(graph.matches("drawtext=").count(), 2, "graph={graph}");
        assert!(graph.contains("[vcat]drawtext="), "graph={graph}");
        assert!(graph.contains("null[vout]"), "graph={graph}");
        // 文本走 textfile 而不是 text=：逐字符转义太容易出错。
        assert!(graph.contains("textfile="), "graph={graph}");
        assert!(!graph.contains(":text="), "graph={graph}");
        // enable 里的逗号必须转义，否则 filtergraph 会被拆坏。
        assert!(graph.contains("enable=between(t\\,0.000\\,2.000)"), "graph={graph}");
        assert!(graph.contains("box=1:boxcolor=black@0.45"), "graph={graph}");
        // 缺了这个，字幕里的 % 会让整帧绘制失败且画面上毫无提示。
        assert!(graph.contains("expansion=none"), "graph={graph}");

        for title in &edit.titles {
            let _ = std::fs::remove_file(&title.text_file);
        }
    }

    #[test]
    fn font_size_scales_with_canvas_height() {
        let mut request = request_of(&[("/a.mp4", 0.0, 3.0)]);
        request.titles = vec![title_of("字", 0.0, 2.0)];
        // 720p 画布：48 * 720/1080 = 32。
        let probes = {
            let mut map = HashMap::new();
            map.insert("/a.mp4".to_string(), probe(10.0, true, 1280, 720));
            map
        };
        let edit = normalize_advanced(&request, &probes).expect("normalizes");
        if edit.titles.is_empty() {
            // 机器上没有中文字体时会走 warning 分支。
            assert!(!edit.warnings.is_empty());
            return;
        }
        assert_eq!(edit.titles[0].font_size, 32);
        for title in &edit.titles {
            let _ = std::fs::remove_file(&title.text_file);
        }
    }

    #[test]
    fn blank_text_and_out_of_range_titles_are_dropped() {
        let mut request = request_of(&[("/a.mp4", 0.0, 3.0)]);
        request.titles = vec![
            title_of("   ", 0.0, 2.0),
            // 完全落在成片之后
            title_of("越界", 10.0, 12.0),
            title_of("正常的字", 0.5, 2.0),
        ];
        let edit = normalize_advanced(&request, &probes_for(&request)).expect("normalizes");
        if resolve_title_font().is_none() {
            assert!(edit.titles.is_empty());
            return;
        }
        assert_eq!(edit.titles.len(), 1);
        assert_eq!(edit.titles[0].start, 0.5);
        // 超出成片末尾的部分被裁到成片长度。
        assert_eq!(edit.titles[0].end, 2.0);
        for title in &edit.titles {
            let _ = std::fs::remove_file(&title.text_file);
        }
    }

    fn transform_of(patch: AdvancedClipTransformRequest) -> Option<AdvancedClipTransformRequest> {
        Some(patch)
    }

    #[test]
    fn transform_defaults_and_scale_falls_back_to_axes() {
        let defaults = resolve_clip_transform(None);
        assert!(defaults.is_identity());

        // 只给 scale，两轴都跟着走。
        let uniform = resolve_clip_transform(transform_of(AdvancedClipTransformRequest {
            scale: Some(0.5),
            ..Default::default()
        }).as_ref());
        assert_eq!(uniform.scale_x, 0.5);
        assert_eq!(uniform.scale_y, 0.5);
        assert!(!uniform.is_identity());

        // 轴向值优先于等比。
        let mixed = resolve_clip_transform(transform_of(AdvancedClipTransformRequest {
            scale: Some(0.5),
            scale_y: Some(2.0),
            ..Default::default()
        }).as_ref());
        assert_eq!(mixed.scale_x, 0.5);
        assert_eq!(mixed.scale_y, 2.0);
    }

    #[test]
    fn transform_values_are_clamped_and_nan_falls_back() {
        let clamped = resolve_clip_transform(transform_of(AdvancedClipTransformRequest {
            scale: Some(99.0),
            x: Some(-999.0),
            opacity: Some(5.0),
            border_radius: Some(9_999.0),
            rotation: Some(f64::NAN),
            ..Default::default()
        }).as_ref());
        assert_eq!(clamped.scale_x, MAX_CLIP_SCALE);
        assert_eq!(clamped.x, -MAX_CLIP_OFFSET);
        assert_eq!(clamped.opacity, 1.0);
        assert_eq!(clamped.border_radius, MAX_CLIP_RADIUS);
        // NaN 不是有限数 → 退回默认值（0°），不能把 NaN 塞进滤镜表达式。
        assert_eq!(clamped.rotation, 0.0);
    }

    #[test]
    fn display_size_fits_source_into_canvas_then_scales() {
        let probe = probe(10.0, true, 1080, 1920);
        let transform = NormalizedTransform::default();
        // 竖屏素材放进 1920x1080 画布：等比缩小到 608x1080（取偶）。
        assert_eq!(display_size(&probe, 1920, 1080, &transform), (608, 1080));

        let half = NormalizedTransform { scale_x: 0.5, scale_y: 0.5, ..Default::default() };
        assert_eq!(display_size(&probe, 1920, 1080, &half), (304, 540));
    }

    #[test]
    fn transformed_clip_switches_to_composite_path() {
        let mut request = request_of(&[("/a.mp4", 0.0, 3.0)]);
        request.clips[0].transform = transform_of(AdvancedClipTransformRequest {
            scale: Some(0.5),
            x: Some(10.0),
            rotation: Some(90.0),
            opacity: Some(0.5),
            ..Default::default()
        });
        let edit = normalize_advanced(&request, &probes_for(&request)).expect("normalizes");
        assert!(edit.needs_composite);
        let graph = build_advanced_graph(&edit, &HashMap::new()).0;

        // 合成路径：黑底画布 + overlay + 旋转 + 透明，不再走 concat。
        assert!(graph.contains("[base0]"), "graph={graph}");
        assert!(graph.contains("overlay=x=(W-w)/2"), "graph={graph}");
        // 外接框用弧度常量（rotw 只吃角度），角度本身是弧度表达式。
        assert!(graph.contains("rotate=a=90.000000*PI/180:c=none:ow=rotw(1.570796)"), "graph={graph}");
        assert!(graph.contains("colorchannelmixer=aa=0.5000"), "graph={graph}");
        // 画面不再走 concat（音频仍会单独 concat 一条，所以只断言视频那半）。
        assert!(!graph.contains("concat=n=1:v=1"), "graph={graph}");
        // 位移 10% 画布宽：画布 1920 → 192px。
        assert!(graph.contains("x=(W-w)/2+192.000"), "graph={graph}");
        assert!(graph.contains("format=yuv420p[vcat]"), "graph={graph}");
    }

    fn kf(t: f64, v: f64, easing: &str) -> AdvancedKeyframeRequest {
        AdvancedKeyframeRequest { t, v, e: Some(easing.to_string()) }
    }

    #[test]
    fn keyframe_tracks_are_sorted_deduped_and_clamped() {
        let request = AdvancedClipKeyframesRequest {
            // 乱序 + 同刻重复 + 越界 + NaN
            x: vec![kf(2.0, 20.0, "linear"), kf(0.0, 0.0, "linear"), kf(2.0, 30.0, "linear"), kf(99.0, 500.0, "linear"), kf(f64::NAN, 1.0, "linear")],
            y: vec![],
            rotation: vec![],
        };
        let tracks = resolve_keyframes(Some(&request), 4.0);
        let list = tracks.x.expect("has x track");
        // NaN 被丢掉；同刻只留最后一个；t 超出片段被裁到 4.0；值被限幅到 ±200。
        assert_eq!(list.len(), 3, "{list:?}");
        assert_eq!(list[0].t, 0.0);
        assert_eq!(list[1].t, 2.0);
        assert_eq!(list[1].v, 30.0);
        assert_eq!(list[2].t, 4.0);
        assert_eq!(list[2].v, MAX_CLIP_OFFSET);
        // 空属性不该产生空 Vec（否则会被当成「有动画」）。
        assert!(tracks.y.is_none());
    }

    #[test]
    fn keyframe_expression_is_nested_if_with_escaped_commas() {
        let frames = vec![
            NormalizedKeyframe { t: 0.0, v: 0.0, easing: Easing::Linear },
            NormalizedKeyframe { t: 2.0, v: 100.0, easing: Easing::Linear },
        ];
        let expression = keyframe_expression(&frames, "t", &|value| value / 100.0 * 640.0);
        // 首帧前保持首帧值 → 段 → 末帧之后保持末帧值。
        assert!(expression.starts_with("if(lt(t,0.0000)"), "{expression}");
        assert!(expression.contains("if(lt(t,2.0000)"), "{expression}");
        assert!(expression.contains("max(0,min(1,(t-0.0000)/2.0000))"), "{expression}");
        // 值换算成像素：100% → 640px。
        assert!(expression.ends_with("640.0000))"), "{expression}");

        // 进滤镜前每个逗号都要转义，否则会被当选项分隔符。
        let escaped = escape_expression(&expression);
        // 每个逗号前面都必须有反斜杠（否则会被 filter 当选项分隔符）。
        assert_eq!(
            escaped.matches(',').count(),
            escaped.matches("\\,").count(),
            "有未转义的逗号: {escaped}"
        );
        assert!(escaped.contains("lt(t\\,0.0000)"), "{escaped}");
    }

    #[test]
    fn eased_expression_uses_quadratic_curves() {
        let frames = vec![
            NormalizedKeyframe { t: 0.0, v: 0.0, easing: Easing::EaseIn },
            NormalizedKeyframe { t: 1.0, v: 10.0, easing: Easing::Linear },
        ];
        let expression = keyframe_expression(&frames, "t", &|value| value);
        // 缓入 = p*p
        assert!(
            expression.contains("*((max(0,min(1,(t-0.0000)/1.0000)))*(max(0,min(1,(t-0.0000)/1.0000))))"),
            "{expression}"
        );

        let inout = vec![
            NormalizedKeyframe { t: 0.0, v: 0.0, easing: Easing::EaseInOut },
            NormalizedKeyframe { t: 1.0, v: 10.0, easing: Easing::Linear },
        ];
        let expression = keyframe_expression(&inout, "t", &|value| value);
        // 缓入缓出要分段，且必须用 if(lt(p,0.5),…)
        assert!(expression.contains("if(lt(max(0,min(1,(t-0.0000)/1.0000)),0.5)"), "{expression}");
    }

    #[test]
    fn animated_offsets_switch_to_composite_and_use_relative_time() {
        let mut request = request_of(&[("/a.mp4", 0.0, 4.0)]);
        request.clips[0].keyframes = Some(AdvancedClipKeyframesRequest {
            x: vec![kf(0.0, 0.0, "linear"), kf(4.0, 40.0, "linear")],
            y: vec![],
            rotation: vec![],
        });
        let edit = normalize_advanced(&request, &probes_for(&request)).expect("normalizes");
        // 只有关键帧、没有任何静态变换，也必须走合成路径。
        assert!(edit.needs_composite);
        let graph = build_advanced_graph(&edit, &HashMap::new()).0;
        assert!(graph.contains("overlay=x=(W-w)/2+("), "graph={graph}");
        // overlay 的 t 是成片绝对时间，表达式里必须减掉片段起点。
        assert!(graph.contains("(t-0.000)"), "graph={graph}");
        assert!(graph.contains("concat=n=1:v=1") == false, "graph={graph}");
    }

    #[test]
    fn animated_rotation_uses_max_angle_for_the_bounding_box() {
        let mut request = request_of(&[("/a.mp4", 0.0, 4.0)]);
        request.clips[0].keyframes = Some(AdvancedClipKeyframesRequest {
            x: vec![],
            y: vec![],
            rotation: vec![kf(0.0, 0.0, "linear"), kf(4.0, 45.0, "linear")],
        });
        let edit = normalize_advanced(&request, &probes_for(&request)).expect("normalizes");
        let graph = build_advanced_graph(&edit, &HashMap::new()).0;
        // 外接框按最大角度（45°）静态算，不能逐帧变。
        let radians = 45.0_f64 * std::f64::consts::PI / 180.0;
        assert!(graph.contains(&format!("ow=rotw({radians:.6})")), "graph={graph}");
        assert!(graph.contains("rotate=a='if(lt(t"), "graph={graph}");
    }

    #[test]
    fn identity_transform_keeps_the_concat_path() {
        let request = request_of(&[("/a.mp4", 0.0, 3.0)]);
        let edit = normalize_advanced(&request, &probes_for(&request)).expect("normalizes");
        assert!(!edit.needs_composite);
        let graph = build_advanced_graph(&edit, &HashMap::new()).0;
        assert!(graph.contains("concat=n=1"), "graph={graph}");
        assert!(!graph.contains("overlay="), "graph={graph}");
    }

    #[test]
    fn rounded_mask_is_white_inside_and_dark_in_the_corner() {
        let path = write_rounded_mask(40, 40, 12.0).expect("writes mask");
        let mask = image::open(&path).expect("reads mask").to_luma8();
        let corner = mask.get_pixel(0, 0)[0];
        let center = mask.get_pixel(20, 20)[0];
        let edge_middle = mask.get_pixel(0, 20)[0];
        assert!(center > 240, "center={center}");
        // 圆角处被切掉；边的中点仍然保留（说明切的是角，不是整条边）。
        assert!(corner < 40, "corner={corner}");
        assert!(edge_middle > 200, "edge={edge_middle}");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn concatenates_two_sources_and_normalizes_them() {
        let request = request_of(&[("/a.mp4", 0.0, 2.0), ("/b.mp4", 1.0, 3.0)]);
        let edit = normalize_advanced(&request, &probes_for(&request)).expect("normalizes");
        let args = args_of(&edit);
        let graph = args
            .iter()
            .position(|arg| arg == "-filter_complex")
            .and_then(|index| args.get(index + 1))
            .expect("has filtergraph");

        // 每个片段都要 scale + pad + setsar + fps，否则 concat 会因尺寸/帧率不一致失败。
        assert!(graph.contains("scale=1920:1080:force_original_aspect_ratio=decrease"), "graph={graph}");
        assert!(graph.contains("pad=1920:1080"), "graph={graph}");
        assert!(graph.contains("setsar=1"), "graph={graph}");
        assert!(graph.contains("fps=30/1"), "graph={graph}");
        assert!(graph.contains("concat=n=2:v=1:a=1"), "graph={graph}");
        // 两段都来自不同文件 → 两个输入。
        assert_eq!(args.iter().filter(|arg| arg.as_str() == "-i").count(), 2);
    }

    #[test]
    fn silent_clips_get_a_generated_silence_track() {
        let request = request_of(&[("/a.mp4", 0.0, 2.0), ("/b.mp4", 0.0, 2.0)]);
        let mut probes = probes_for(&request);
        // b 没有音轨（AI 生成素材很常见）。
        probes.insert("/b.mp4".to_string(), probe(10.0, false, 1920, 1080));
        let edit = normalize_advanced(&request, &probes).expect("normalizes");
        let graph = build_advanced_graph(&edit, &HashMap::new()).0;
        assert!(graph.contains("anullsrc=r=48000:cl=stereo,atrim=0:2.000"), "graph={graph}");
    }

    #[test]
    fn mute_mode_drops_audio_and_skips_audio_filters() {
        let mut request = request_of(&[("/a.mp4", 0.0, 2.0), ("/b.mp4", 2.0, 4.0)]);
        request.audio_mode = Some("mute".to_string());
        let edit = normalize_advanced(&request, &probes_for(&request)).expect("normalizes");
        let (graph, label) = build_advanced_graph(&edit, &HashMap::new());
        assert!(label.is_none());
        assert!(graph.contains("concat=n=2:v=1:a=0"));
        assert!(!graph.contains("anullsrc"));
    }

    #[test]
    fn music_is_delayed_to_its_timeline_position() {
        let mut request = request_of(&[("/a.mp4", 0.0, 5.0)]);
        request.music = Some(AdvancedMusicRequest {
            source_path: "/m.m4a".to_string(),
            start: Some(1.5),
            volume: Some(0.4),
            fade_in: Some(0.5),
            fade_out: Some(0.5),
        });
        let mut probes = probes_for(&request);
        probes.insert("/m.m4a".to_string(), probe(8.0, true, 0, 0));
        let edit = normalize_advanced(&request, &probes).expect("normalizes");
        let (graph, label) = build_advanced_graph(&edit, &HashMap::new());
        assert_eq!(label, Some("[aout]".to_string()));
        // 音乐从成片第 1.5 秒进来。
        assert!(graph.contains("adelay=1500:all=1"), "graph={graph}");
        assert!(graph.contains("volume=0.400"), "graph={graph}");
        assert!(graph.contains("amix=inputs=2:duration=first"), "graph={graph}");
    }

    #[test]
    fn music_is_trimmed_to_the_remaining_sequence() {
        let mut request = request_of(&[("/a.mp4", 0.0, 4.0)]);
        request.music = Some(AdvancedMusicRequest {
            source_path: "/m.m4a".to_string(),
            start: Some(1.0),
            volume: None,
            fade_in: None,
            fade_out: None,
        });
        let mut probes = probes_for(&request);
        probes.insert("/m.m4a".to_string(), probe(30.0, true, 0, 0));
        let edit = normalize_advanced(&request, &probes).expect("normalizes");
        // 成片 4 秒、音乐从 1 秒进来 → 最多只能放 3 秒。
        assert_eq!(edit.music.map(|music| music.duration), Some(3.0));
    }

    #[test]
    fn output_is_capped_at_the_sequence_length() {
        let request = request_of(&[("/a.mp4", 0.0, 2.0), ("/a.mp4", 2.0, 5.0)]);
        let edit = normalize_advanced(&request, &probes_for(&request)).expect("normalizes");
        let args = args_of(&edit);
        // 最后一个 -t 是输出端上限，防止 adelay 把尾巴拖长。
        let last_t = args
            .iter()
            .enumerate()
            .filter(|(_, arg)| arg.as_str() == "-t")
            .last()
            .and_then(|(index, _)| args.get(index + 1))
            .cloned();
        assert_eq!(last_t, Some("5.000".to_string()));
    }

    #[test]
    fn same_source_twice_opens_a_single_input() {
        let request = request_of(&[("/a.mp4", 0.0, 2.0), ("/a.mp4", 6.0, 8.0)]);
        let edit = normalize_advanced(&request, &probes_for(&request)).expect("normalizes");
        // 同一个文件只开一次输入，两段共用 —— 否则同一文件被解码两遍。
        assert_eq!(edit.inputs.len(), 1);
        assert_eq!(edit.clips.len(), 2);
    }

    #[test]
    fn rejects_empty_timeline_and_too_short_clips() {
        let empty = request_of(&[]);
        assert!(normalize_advanced(&empty, &HashMap::new()).is_err());

        let mut probes = HashMap::new();
        probes.insert("/a.mp4".to_string(), probe(10.0, true, 640, 480));
        let too_short = request_of(&[("/a.mp4", 1.0, 1.02)]);
        assert!(normalize_advanced(&too_short, &probes).is_err());
    }

    #[test]
    fn clamps_clip_end_to_probed_duration() {
        let request = request_of(&[("/a.mp4", 0.0, 99.0)]);
        let mut probes = HashMap::new();
        probes.insert("/a.mp4".to_string(), probe(6.0, true, 640, 480));
        let edit = normalize_advanced(&request, &probes).expect("normalizes");
        assert_eq!(edit.clips[0].end, 6.0);
        assert_eq!(edit.total_duration, 6.0);
    }

    #[test]
    fn odd_dimensions_are_rounded_to_even() {
        let request = request_of(&[("/a.mp4", 0.0, 2.0)]);
        let mut probes = HashMap::new();
        probes.insert("/a.mp4".to_string(), probe(10.0, true, 1081, 1921));
        let edit = normalize_advanced(&request, &probes).expect("normalizes");
        assert_eq!((edit.width, edit.height), (1080, 1920));
    }

    #[test]
    fn snaps_decimal_fps_to_rational() {
        assert_eq!(snap_fps_rational(23.98), "24000/1001");
        assert_eq!(snap_fps_rational(29.97), "30000/1001");
        assert_eq!(snap_fps_rational(30.0), "30/1");
        assert_eq!(snap_fps_rational(25.0), "25/1");
        // 认不出来的保持小数，交给 ffmpeg 自己解析。
        assert_eq!(snap_fps_rational(15.0), "15");
    }
}
