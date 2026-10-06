//! 视频编辑：简单剪辑（起止点裁剪）与音轨处理（保留 / 静音 / 替换 / 混合 + 音量 + 淡入淡出）。
//!
//! 全部交给随包 ffmpeg 完成。先用一次 `ffmpeg -i`（不带输出）读头部信息，
//! 顺带拿到**时长**与**源视频是否自带音轨**两件事 —— 后者决定「混合」要不要降级：
//! `[0:a]` 出现在 filter_complex 里时，源视频没有音轨会让 ffmpeg 直接报错退出，
//! 所以探测结果必须参与参数生成，而不是运行时兜底。
//!
//! 输出写入应用数据目录的 `library-assets`，与素材库共用同一个受 asset 协议覆盖的
//! 目录，前端拿到路径即可直接播放，不需要额外注册作用域。

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use super::video_cfr::{hide_child_console, local_or_remote_video_source, resolve_ffmpeg_path};

/// 最短可导出片段。0 长度片段会让 ffmpeg 产出空文件，提前挡掉。
const MIN_TRIM_DURATION_SEC: f64 = 0.1;
/// 判定最小时长时的浮点容差：`5.1 - 5` 在二进制浮点下是 `0.09999999999999964`，
/// 不留容差会出现「前端显示 0.1s 合法、后端判成过短」的错杀。
const TRIM_EPSILON_SEC: f64 = 1e-6;
/// 音量上限（1.0 = 原声）。留出增强空间，但不至于随便就削波失真。
const MAX_AUDIO_VOLUME: f64 = 4.0;
/// 单侧淡入/淡出时长上限。
const MAX_FADE_SEC: f64 = 30.0;
const AUDIO_BITRATE: &str = "192k";
const VIDEO_PRESET: &str = "veryfast";
const VIDEO_CRF: &str = "20";

/// 音轨处理方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AudioMode {
    /// 保留原声（可调音量 / 淡入淡出）。
    Keep,
    /// 整条音轨静音。
    Mute,
    /// 用选中的音轨替换原声。
    Replace,
    /// 原声与新音轨混合。
    Mix,
}

impl AudioMode {
    fn parse(value: Option<&str>) -> Self {
        match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
            Some("mute") => Self::Mute,
            Some("replace") => Self::Replace,
            Some("mix") => Self::Mix,
            _ => Self::Keep,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Keep => "keep",
            Self::Mute => "mute",
            Self::Replace => "replace",
            Self::Mix => "mix",
        }
    }

    fn uses_external_track(self) -> bool {
        matches!(self, Self::Replace | Self::Mix)
    }
}

/// 前端提交的编辑参数。字段全部可选：缺省即「不裁剪 + 保留原声」。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoEditRequest {
    pub source_path: String,
    #[serde(default)]
    pub trim_start: Option<f64>,
    #[serde(default)]
    pub trim_end: Option<f64>,
    #[serde(default)]
    pub audio_mode: Option<String>,
    #[serde(default)]
    pub audio_volume: Option<f64>,
    #[serde(default)]
    pub track_path: Option<String>,
    #[serde(default)]
    pub track_volume: Option<f64>,
    #[serde(default)]
    pub fade_in: Option<f64>,
    #[serde(default)]
    pub fade_out: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoEditResult {
    pub output_path: String,
    pub duration_sec: Option<f64>,
    /// 实际生效的音轨模式（源视频无音轨时 `mix` 会降级成 `replace`）。
    pub audio_mode: String,
}

/// `ffmpeg -i` 头部探测结果。
#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct MediaProbe {
    duration_sec: Option<f64>,
    has_audio: bool,
}

/// 校验并收敛后的编辑参数，`build_ffmpeg_args` 只认这个结构。
#[derive(Debug, Clone, PartialEq)]
struct NormalizedEdit {
    trim_start: f64,
    /// 裁剪终点。`None` = 一直到片尾。
    trim_end: Option<f64>,
    /// 成片时长。`None` = 交给 ffmpeg 自己走到片尾。
    duration: Option<f64>,
    mode: AudioMode,
    volume: f64,
    track_path: Option<String>,
    track_volume: f64,
    fade_in: f64,
    fade_out: f64,
}

fn parse_hms(stamp: &str) -> Option<f64> {
    let mut parts = stamp.split(':');
    let hours: f64 = parts.next()?.trim().parse().ok()?;
    let minutes: f64 = parts.next()?.trim().parse().ok()?;
    let seconds: f64 = parts.next()?.trim().parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    let total = hours * 3600.0 + minutes * 60.0 + seconds;
    if total.is_finite() && total >= 0.0 {
        Some(total)
    } else {
        None
    }
}

/// 从 `ffmpeg -i <file>` 的 stderr 里读时长与是否存在音频流。
///
/// ffmpeg 在没有指定输出文件时以非零码退出，但**头部信息已经打完**，
/// 因此这里只看文本不看退出码。
fn parse_media_probe(text: &str) -> MediaProbe {
    let duration_sec = text.find("Duration:").and_then(|index| {
        let rest = text[index + "Duration:".len()..].trim_start();
        parse_hms(rest.split(',').next()?.trim())
            // `N/A` 等占位值解析失败，视为未知。
            .filter(|value| *value > 0.0)
    });
    let has_audio = text
        .lines()
        .any(|line| line.contains("Stream #") && line.contains("Audio:"));
    MediaProbe {
        duration_sec,
        has_audio,
    }
}

/// 读一次头部信息。失败（文件不可读 / 远程不可达）时返回默认值，由后续步骤报错。
fn probe_media(ffmpeg: &Path, input: &str) -> MediaProbe {
    let mut command = Command::new(ffmpeg);
    hide_child_console(&mut command);
    let Ok(result) = command
        .args(["-hide_banner", "-i", input])
        .output()
    else {
        return MediaProbe::default();
    };
    parse_media_probe(&String::from_utf8_lossy(&result.stderr))
}

fn sanitize_seconds(value: Option<f64>) -> Option<f64> {
    value.filter(|value| value.is_finite() && *value >= 0.0)
}

/// 区间是否短到不能导出。带容差，避免浮点误差把刚好 0.1s 的片段判死。
fn is_clip_too_short(start: f64, end: f64) -> bool {
    end - start < MIN_TRIM_DURATION_SEC - TRIM_EPSILON_SEC
}

fn clamp_volume(value: Option<f64>) -> f64 {
    match value {
        Some(value) if value.is_finite() => value.clamp(0.0, MAX_AUDIO_VOLUME),
        _ => 1.0,
    }
}

/// 淡入淡出互相挤占时按**用户填写的比例**缩到片段长度内，而不是先把各自夹到片长
/// 再缩放 —— 后者会把「淡入 4s / 淡出 6s」压成等长，丢掉用户想要的轻重关系。
fn resolve_fades(request_in: Option<f64>, request_out: Option<f64>, duration: Option<f64>) -> (f64, f64) {
    let raw_in = sanitize_seconds(request_in).unwrap_or(0.0).min(MAX_FADE_SEC);
    let raw_out = sanitize_seconds(request_out).unwrap_or(0.0).min(MAX_FADE_SEC);
    let Some(total) = duration.filter(|value| *value > 0.0) else {
        return (raw_in, raw_out);
    };
    let sum = raw_in + raw_out;
    if sum <= total {
        return (raw_in.min(total), raw_out.min(total));
    }
    let scale = total / sum;
    (raw_in * scale, raw_out * scale)
}

/// 校验 + 收敛。`probe` 只用于兜底与「混合」降级判断，裁剪区间以用户提交值为准。
fn normalize_edit(request: &VideoEditRequest, probe: MediaProbe) -> Result<NormalizedEdit, String> {
    let source = request.source_path.trim();
    if source.is_empty() {
        return Err("视频来源为空".to_string());
    }

    let requested_mode = AudioMode::parse(request.audio_mode.as_deref());
    let track_path = request
        .track_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if requested_mode.uses_external_track() && track_path.is_none() {
        return Err("请先选择要加入的音轨".to_string());
    }
    let mode = if requested_mode == AudioMode::Mix && !probe.has_audio {
        // 源视频没有音轨，没有可混合的对象 —— 等价于直接换成新音轨。
        AudioMode::Replace
    } else {
        requested_mode
    };

    let probed = probe.duration_sec;
    let trim_start = sanitize_seconds(request.trim_start).unwrap_or(0.0);
    if let Some(total) = probed {
        if trim_start >= total {
            return Err(format!("裁剪起点 {trim_start:.1}s 超出视频时长 {total:.1}s"));
        }
    }

    let requested_end = sanitize_seconds(request.trim_end);
    if let Some(end) = requested_end {
        if is_clip_too_short(trim_start, end) {
            return Err("裁剪区间太短，请至少保留 0.1 秒".to_string());
        }
    }
    // 用户给的值可能超过真实时长（前端拿到的是解码器估算值），按探测值收口。
    let trim_end = requested_end.map(|end| match probed {
        Some(total) if total > 0.0 => end.min(total),
        _ => end,
    });
    if let Some(end) = trim_end {
        if is_clip_too_short(trim_start, end) {
            return Err("裁剪区间太短，请至少保留 0.1 秒".to_string());
        }
    }

    let duration = match trim_end {
        Some(end) => Some(end - trim_start),
        None => probed
            .map(|total| (total - trim_start).max(0.0))
            .filter(|value| *value > MIN_TRIM_DURATION_SEC - TRIM_EPSILON_SEC),
    };
    let (fade_in, fade_out) = resolve_fades(request.fade_in, request.fade_out, duration);

    Ok(NormalizedEdit {
        trim_start,
        trim_end,
        duration,
        mode,
        volume: clamp_volume(request.audio_volume),
        track_path,
        track_volume: clamp_volume(request.track_volume),
        fade_in,
        fade_out,
    })
}

fn fmt_seconds(value: f64) -> String {
    format!("{value:.3}")
}

/// 只生成淡入淡出片段，供「保留 / 替换」直接接在 volume 之后，
/// 供「混合」接在 amix 之后。
fn fade_filter(fade_in: f64, fade_out: f64, duration: Option<f64>) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if fade_in > 0.0 {
        parts.push(format!("afade=t=in:st=0:d={:.3}", fade_in));
    }
    if fade_out > 0.0 {
        // 淡出必须贴着片段结尾，所以起点要用时长反推；时长未知时宁可不做，
        // 也不要写一个越界的时间点让 ffmpeg 报错。
        if let Some(total) = duration.filter(|value| *value > 0.0) {
            let start = (total - fade_out).max(0.0);
            parts.push(format!("afade=t=out:st={:.3}:d={:.3}", start, fade_out));
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(","))
    }
}

fn audio_filter_chain(volume: f64, fade_in: f64, fade_out: f64, duration: Option<f64>) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if (volume - 1.0).abs() > 0.001 {
        parts.push(format!("volume={volume:.3}"));
    }
    if let Some(fades) = fade_filter(fade_in, fade_out, duration) {
        parts.push(fades);
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(","))
    }
}

/// 拼 ffmpeg 参数。纯函数，好断言。
///
/// 约定：`edit.mode == Mix` 时调用方必须已确认源视频**自带音轨**
/// （`normalize_edit` 会把无音轨的 `mix` 降级成 `replace`），
/// 否则 filter_complex 里的 `[0:a]` 会直接匹配失败。
fn build_ffmpeg_args(input: &str, edit: &NormalizedEdit, output: &Path) -> Vec<String> {
    let mut args: Vec<String> = ["-y", "-hide_banner", "-loglevel", "error"]
        .iter()
        .map(|value| value.to_string())
        .collect();

    // `-ss` 放在 `-i` 之前：先按关键帧跳转再解码丢弃，配合重新编码可做到帧级准确，
    // 比放在后面（先全解码再丢弃）快得多。
    if edit.trim_start > 0.0 {
        args.push("-ss".to_string());
        args.push(fmt_seconds(edit.trim_start));
    }
    args.push("-i".to_string());
    args.push(input.to_string());

    if edit.mode.uses_external_track() {
        if let Some(track) = edit.track_path.as_deref() {
            // 新音轨与画面用同一个起点裁，保证「裁剪后音画仍然对得上」。
            if edit.trim_start > 0.0 {
                args.push("-ss".to_string());
                args.push(fmt_seconds(edit.trim_start));
            }
            args.push("-i".to_string());
            args.push(track.to_string());
        }
    }

    if let Some(duration) = edit.duration.filter(|value| *value > 0.0) {
        args.push("-t".to_string());
        args.push(fmt_seconds(duration));
    }

    // 显式 map 之后 ffmpeg 不再做自动流选择，只映射视频轨即可。
    args.push("-map".to_string());
    args.push("0:v:0".to_string());

    match edit.mode {
        AudioMode::Keep => {
            // `?` = 源视频没有音轨时不报错，直接输出纯画面。
            args.push("-map".to_string());
            args.push("0:a:0?".to_string());
            if let Some(chain) = audio_filter_chain(edit.volume, edit.fade_in, edit.fade_out, edit.duration) {
                args.push("-af".to_string());
                args.push(chain);
            }
            args.push("-c:a".to_string());
            args.push("aac".to_string());
            args.push("-b:a".to_string());
            args.push(AUDIO_BITRATE.to_string());
        }
        AudioMode::Mute => {
            args.push("-an".to_string());
        }
        AudioMode::Replace => {
            args.push("-map".to_string());
            args.push("1:a:0".to_string());
            if let Some(chain) = audio_filter_chain(edit.track_volume, edit.fade_in, edit.fade_out, edit.duration) {
                args.push("-af".to_string());
                args.push(chain);
            }
            args.push("-c:a".to_string());
            args.push("aac".to_string());
            args.push("-b:a".to_string());
            args.push(AUDIO_BITRATE.to_string());
        }
        AudioMode::Mix => {
            // duration=first 让混音长度跟着画面走；normalize=0 保留各自音量，
            // 否则 ffmpeg 会按输入数量自动衰减，调完音量听起来反而更小。
            let mut graph = format!(
                "[0:a]volume={:.3}[a0];[1:a]volume={:.3}[a1];[a0][a1]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[am]",
                edit.volume, edit.track_volume
            );
            match fade_filter(edit.fade_in, edit.fade_out, edit.duration) {
                Some(fades) => graph.push_str(&format!(";[am]{fades}[aout]")),
                None => graph.push_str(";[am]anull[aout]"),
            }
            args.push("-filter_complex".to_string());
            args.push(graph);
            args.push("-map".to_string());
            args.push("[aout]".to_string());
            args.push("-c:a".to_string());
            args.push("aac".to_string());
            args.push("-b:a".to_string());
            args.push(AUDIO_BITRATE.to_string());
        }
    }

    args.push("-c:v".to_string());
    args.push("libx264".to_string());
    args.push("-preset".to_string());
    args.push(VIDEO_PRESET.to_string());
    args.push("-crf".to_string());
    args.push(VIDEO_CRF.to_string());
    args.push("-pix_fmt".to_string());
    args.push("yuv420p".to_string());
    // H.264 要求宽高为偶数，奇数尺寸的源（手机竖屏常见 1081）会让编码直接失败。
    args.push("-vf".to_string());
    args.push("scale=trunc(iw/2)*2:trunc(ih/2)*2".to_string());
    args.push("-movflags".to_string());
    args.push("+faststart".to_string());
    args.push(output.to_string_lossy().to_string());
    args
}

/// 执行一次视频编辑，返回新文件路径。
#[tauri::command]
pub fn render_video_edit(
    app: AppHandle,
    request: VideoEditRequest,
) -> Result<VideoEditResult, String> {
    let input = local_or_remote_video_source(&request.source_path)
        .ok_or_else(|| "不支持的视频来源，无法编辑".to_string())?;
    let is_remote = input.starts_with("http://") || input.starts_with("https://");
    if !is_remote && !Path::new(&input).is_file() {
        return Err(format!("视频文件不存在: {input}"));
    }

    // 随包 / 系统 PATH / 已下载都找不到时，再走一次「按需准备」：Windows 从国内镜像
    // 下载，macOS 用 Homebrew 安装。直接报「未找到 ffmpeg」会把用户堵死在死路上。
    let mut ffmpeg = resolve_ffmpeg_path(&app);
    if ffmpeg.is_none() {
        super::pajuben::ensure_ffmpeg(&app)
            .map_err(|error| format!("未找到 ffmpeg，无法编辑视频：{error}"))?;
        // `ensure_ffmpeg` 命中已有时返回的是目录，落地后统一按可执行文件路径重新解析。
        ffmpeg = resolve_ffmpeg_path(&app);
    }
    let ffmpeg = ffmpeg.ok_or_else(|| "未找到 ffmpeg，无法编辑视频".to_string())?;
    let probe = probe_media(&ffmpeg, &input);
    let edit = normalize_edit(&request, probe)?;

    if let Some(track) = edit.track_path.as_deref() {
        let track_remote = track.starts_with("http://") || track.starts_with("https://");
        if !track_remote && !Path::new(track).is_file() {
            return Err(format!("音轨文件不存在: {track}"));
        }
    }

    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?
        .join("library-assets");
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("无法创建素材目录: {error}"))?;
    let output: PathBuf = directory.join(format!("{}.mp4", Uuid::new_v4()));

    let args = build_ffmpeg_args(&input, &edit, &output);
    let mut command = Command::new(&ffmpeg);
    hide_child_console(&mut command);
    let result = command
        .args(&args)
        .output()
        .map_err(|error| format!("无法启动 ffmpeg: {error}"))?;
    if !result.status.success() {
        let _ = std::fs::remove_file(&output);
        let detail = String::from_utf8_lossy(&result.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            format!("视频编辑失败 (exit: {:?})", result.status)
        } else {
            format!("视频编辑失败: {detail}")
        });
    }
    let empty_or_missing = output
        .metadata()
        .map(|metadata| metadata.len() == 0)
        .unwrap_or(true);
    if empty_or_missing {
        let _ = std::fs::remove_file(&output);
        return Err("ffmpeg 未生成有效的视频文件".to_string());
    }

    let output_path = output.to_string_lossy().to_string();
    let duration_sec = edit
        .duration
        .or_else(|| probe_media(&ffmpeg, &output_path).duration_sec);

    Ok(VideoEditResult {
        output_path,
        duration_sec,
        audio_mode: edit.mode.as_str().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_request() -> VideoEditRequest {
        VideoEditRequest {
            source_path: "/tmp/clip.mp4".to_string(),
            trim_start: None,
            trim_end: None,
            audio_mode: None,
            audio_volume: None,
            track_path: None,
            track_volume: None,
            fade_in: None,
            fade_out: None,
        }
    }

    fn probe_with_audio(duration: f64) -> MediaProbe {
        MediaProbe {
            duration_sec: Some(duration),
            has_audio: true,
        }
    }

    #[test]
    fn parses_hms_stamps() {
        assert_eq!(parse_hms("00:00:06.00"), Some(6.0));
        assert_eq!(parse_hms("01:02:03.500"), Some(3723.5));
        assert_eq!(parse_hms("00:00:00.00"), Some(0.0));
        assert_eq!(parse_hms("N/A"), None);
        assert_eq!(parse_hms("00:06"), None);
    }

    #[test]
    fn parses_ffmpeg_header_output() {
        let stderr = "ffmpeg version 7.0\n\
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'clip.mp4':\n\
  Metadata:\n\
    major_brand     : isom\n\
  Duration: 00:00:06.00, start: 0.000000, bitrate: 118 kb/s\n\
  Stream #0:0[0x1](und): Video: h264 (High) (avc1), yuv420p, 320x240, 30 fps\n\
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a), 44100 Hz, mono\n\
At least one output file must be specified\n";
        let probe = parse_media_probe(stderr);
        assert_eq!(probe.duration_sec, Some(6.0));
        assert!(probe.has_audio);
    }

    #[test]
    fn detects_missing_audio_track() {
        let stderr = "  Duration: 00:00:04.50, start: 0.000000, bitrate: 60 kb/s\n\
  Stream #0:0: Video: h264, yuv420p, 320x240\n";
        let probe = parse_media_probe(stderr);
        assert_eq!(probe.duration_sec, Some(4.5));
        assert!(!probe.has_audio);
    }

    #[test]
    fn unknown_duration_is_none() {
        assert_eq!(parse_media_probe("no header here").duration_sec, None);
        assert_eq!(
            parse_media_probe("  Duration: N/A, start: 0.000000\n").duration_sec,
            None
        );
    }

    #[test]
    fn clamps_volume_to_supported_range() {
        assert_eq!(clamp_volume(None), 1.0);
        assert_eq!(clamp_volume(Some(f64::NAN)), 1.0);
        assert_eq!(clamp_volume(Some(-3.0)), 0.0);
        assert_eq!(clamp_volume(Some(1.5)), 1.5);
        assert_eq!(clamp_volume(Some(99.0)), MAX_AUDIO_VOLUME);
    }

    #[test]
    fn scales_fades_that_do_not_fit_the_clip() {
        let (fade_in, fade_out) = resolve_fades(Some(4.0), Some(6.0), Some(5.0));
        assert!((fade_in - 2.0).abs() < 1e-6, "fade_in={fade_in}");
        assert!((fade_out - 3.0).abs() < 1e-6, "fade_out={fade_out}");
        assert!(fade_in + fade_out <= 5.0 + 1e-6);
    }

    #[test]
    fn keeps_fades_when_duration_unknown() {
        let (fade_in, fade_out) = resolve_fades(Some(1.0), Some(2.0), None);
        assert_eq!((fade_in, fade_out), (1.0, 2.0));
        // 上限始终生效，避免用户拖出一个荒唐的数值。
        let (capped, _) = resolve_fades(Some(999.0), None, None);
        assert_eq!(capped, MAX_FADE_SEC);
    }

    #[test]
    fn resolves_trim_to_probed_duration() {
        let mut request = base_request();
        request.trim_start = Some(1.0);
        request.trim_end = Some(99.0);
        let edit = normalize_edit(&request, probe_with_audio(6.0)).expect("normalizes");
        assert_eq!(edit.trim_start, 1.0);
        assert_eq!(edit.trim_end, Some(6.0));
        assert_eq!(edit.duration, Some(5.0));
    }

    #[test]
    fn trim_without_end_runs_to_the_clip_end() {
        let mut request = base_request();
        request.trim_start = Some(2.0);
        let edit = normalize_edit(&request, probe_with_audio(6.0)).expect("normalizes");
        assert_eq!(edit.trim_end, None);
        assert_eq!(edit.duration, Some(4.0));
    }

    #[test]
    fn rejects_too_short_and_out_of_range_trims() {
        let mut too_short = base_request();
        too_short.trim_start = Some(1.0);
        too_short.trim_end = Some(1.05);
        assert!(normalize_edit(&too_short, probe_with_audio(6.0)).is_err());

        let mut past_end = base_request();
        past_end.trim_start = Some(7.0);
        assert!(normalize_edit(&past_end, probe_with_audio(6.0)).is_err());
    }

    #[test]
    fn accepts_a_clip_exactly_at_the_minimum_length() {
        // 5.1 - 5 在二进制浮点下是 0.09999999999999964，容差不生效就会被错杀。
        let mut request = base_request();
        request.trim_start = Some(5.0);
        request.trim_end = Some(5.1);
        let edit = normalize_edit(&request, probe_with_audio(10.0)).expect("0.1s clip is allowed");
        assert!((edit.duration.expect("duration") - 0.1).abs() < 1e-6);
    }

    #[test]
    fn degrades_mix_to_replace_without_source_audio() {
        let mut request = base_request();
        request.audio_mode = Some("mix".to_string());
        request.track_path = Some("/tmp/music.m4a".to_string());
        let no_audio = MediaProbe {
            duration_sec: Some(6.0),
            has_audio: false,
        };
        assert_eq!(normalize_edit(&request, no_audio).expect("normalizes").mode, AudioMode::Replace);
        assert_eq!(
            normalize_edit(&request, probe_with_audio(6.0)).expect("normalizes").mode,
            AudioMode::Mix
        );
    }

    #[test]
    fn requires_a_track_for_replace_and_mix() {
        let mut request = base_request();
        request.audio_mode = Some("replace".to_string());
        assert!(normalize_edit(&request, probe_with_audio(6.0)).is_err());
        request.audio_mode = Some("mute".to_string());
        assert!(normalize_edit(&request, probe_with_audio(6.0)).is_ok());
    }

    #[test]
    fn unknown_audio_mode_defaults_to_keep() {
        assert_eq!(AudioMode::parse(None), AudioMode::Keep);
        assert_eq!(AudioMode::parse(Some(" KEEP ")), AudioMode::Keep);
        assert_eq!(AudioMode::parse(Some("weird")), AudioMode::Keep);
        assert_eq!(AudioMode::parse(Some("MUTE")), AudioMode::Mute);
    }

    fn args_of(edit: &NormalizedEdit) -> Vec<String> {
        build_ffmpeg_args("/tmp/in.mp4", edit, Path::new("/tmp/out.mp4"))
    }

    fn arg_value(args: &[String], flag: &str) -> Option<String> {
        args.iter().position(|arg| arg == flag).and_then(|index| args.get(index + 1).cloned()
        )
    }

    #[test]
    fn keep_mode_maps_audio_optionally() {
        let request = base_request();
        let edit = normalize_edit(&request, probe_with_audio(6.0)).expect("normalizes");
        let args = args_of(&edit);
        assert_eq!(arg_value(&args, "-map"), Some("0:v:0".to_string()));
        assert!(args.contains(&"0:a:0?".to_string()));
        // 音量/淡入淡出都没改，不生成多余的滤镜。
        assert!(!args.contains(&"-af".to_string()));
        assert_eq!(args.last().map(String::as_str), Some("/tmp/out.mp4"));
    }

    #[test]
    fn keep_mode_writes_volume_and_fade_filters() {
        let mut request = base_request();
        request.audio_volume = Some(1.5);
        request.fade_in = Some(0.5);
        request.fade_out = Some(1.0);
        let edit = normalize_edit(&request, probe_with_audio(10.0)).expect("normalizes");
        let chain = arg_value(&args_of(&edit), "-af").expect("has audio filter");
        assert!(chain.contains("volume=1.500"), "chain={chain}");
        assert!(chain.contains("afade=t=in:st=0:d=0.500"), "chain={chain}");
        assert!(chain.contains("afade=t=out:st=9.000:d=1.000"), "chain={chain}");
    }

    #[test]
    fn mute_mode_drops_the_audio_track() {
        let mut request = base_request();
        request.audio_mode = Some("mute".to_string());
        let edit = normalize_edit(&request, probe_with_audio(6.0)).expect("normalizes");
        let args = args_of(&edit);
        assert!(args.contains(&"-an".to_string()));
        assert!(!args.contains(&"-af".to_string()));
    }

    #[test]
    fn replace_mode_maps_the_new_track() {
        let mut request = base_request();
        request.audio_mode = Some("replace".to_string());
        request.track_path = Some("/tmp/music.m4a".to_string());
        request.track_volume = Some(0.8);
        request.trim_start = Some(2.0);
        let edit = normalize_edit(&request, probe_with_audio(10.0)).expect("normalizes");
        let args = args_of(&edit);
        assert_eq!(
            args.iter().filter(|arg| arg.as_str() == "-i").count(),
            2,
            "args={args:?}"
        );
        assert!(args.contains(&"1:a:0".to_string()));
        // 两个输入都要带同一个 -ss，音画才不会错位。
        assert_eq!(args.iter().filter(|arg| arg.as_str() == "-ss").count(), 2);
        assert_eq!(
            arg_value(&args, "-af"),
            Some("volume=0.800".to_string()),
            "args={args:?}"
        );
    }

    #[test]
    fn mix_mode_builds_an_amix_filtergraph() {
        let mut request = base_request();
        request.audio_mode = Some("mix".to_string());
        request.track_path = Some("/tmp/music.m4a".to_string());
        request.audio_volume = Some(1.2);
        request.track_volume = Some(0.4);
        request.fade_out = Some(0.5);
        let edit = normalize_edit(&request, probe_with_audio(10.0)).expect("normalizes");
        let args = args_of(&edit);
        let graph = arg_value(&args, "-filter_complex").expect("has filtergraph");
        assert!(graph.contains("[0:a]volume=1.200[a0]"), "graph={graph}");
        assert!(graph.contains("[1:a]volume=0.400[a1]"), "graph={graph}");
        assert!(graph.contains("amix=inputs=2:duration=first"), "graph={graph}");
        assert!(graph.ends_with("[am]afade=t=out:st=9.500:d=0.500[aout]"), "graph={graph}");
        assert!(args.contains(&"[aout]".to_string()));
    }

    #[test]
    fn trim_window_is_forwarded_to_ffmpeg() {
        let mut request = base_request();
        request.trim_start = Some(1.5);
        request.trim_end = Some(4.0);
        let edit = normalize_edit(&request, probe_with_audio(10.0)).expect("normalizes");
        let args = args_of(&edit);
        assert_eq!(arg_value(&args, "-ss"), Some("1.500".to_string()));
        assert_eq!(arg_value(&args, "-t"), Some("2.500".to_string()));
    }

    #[test]
    fn output_keeps_even_dimensions_and_faststart() {
        let request = base_request();
        let edit = normalize_edit(&request, probe_with_audio(6.0)).expect("normalizes");
        let args = args_of(&edit);
        assert_eq!(
            arg_value(&args, "-vf"),
            Some("scale=trunc(iw/2)*2:trunc(ih/2)*2".to_string())
        );
        assert!(args.contains(&"+faststart".to_string()));
        assert_eq!(arg_value(&args, "-c:v"), Some("libx264".to_string()));
    }
}
