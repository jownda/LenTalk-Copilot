//! 视频 CFR（恒定帧率）归一化。
//!
//! 背景：知鸟 AI(aliyun-video-superres) 等超分服务端对 VFR（可变帧率）源视频的
//! 时间轴处理不当，会把整段视频按错误帧率重采样并插帧，导致输出被整体拉伸成
//! 慢动作、时长变长、音画不同步（实测 14.02s/337 帧被拉到 25.02s/600 帧）。
//!
//! 本模块在超分上传前做一道保险：内置轻量 MP4 解析读取视频轨 stts 时间戳表，
//! 判断是否 VFR；仅在 VFR 时调用随应用分发的 ffmpeg 转成 30fps CFR 临时文件，
//! 供前端替换上传源。CFR 源 / 非 MP4 / 缺 ffmpeg 一律原路径返回，不阻塞主流程。

use std::collections::HashSet;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// 归一化结果：`converted=true` 表示已转出 CFR 新文件（output_path 为新文件路径）；
/// `converted=false` 表示无需转换（CFR / 非 MP4 / 缺 ffmpeg），output_path 保持源路径。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoCfrResult {
    pub output_path: String,
    pub converted: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone)]
struct Mp4Box {
    box_type: [u8; 4],
    body_start: u64,
    body_size: u64,
}

fn read_u32(file: &mut File, offset: u64) -> std::io::Result<u32> {
    let mut buf = [0u8; 4];
    file.seek(SeekFrom::Start(offset))?;
    file.read_exact(&mut buf)?;
    Ok(u32::from_be_bytes(buf))
}

fn read_u64(file: &mut File, offset: u64) -> std::io::Result<u64> {
    let mut buf = [0u8; 8];
    file.seek(SeekFrom::Start(offset))?;
    file.read_exact(&mut buf)?;
    Ok(u64::from_be_bytes(buf))
}

/// 遍历一段范围内的顶层 box（ISO BMFF：ftyp / moov / mdat / free …）。
fn list_boxes(file: &mut File, start: u64, end: u64) -> std::io::Result<Vec<Mp4Box>> {
    let mut boxes = Vec::new();
    let mut offset = start;
    while offset + 8 <= end {
        let size32 = read_u32(file, offset)?;
        let mut box_type = [0u8; 4];
        file.seek(SeekFrom::Start(offset + 4))?;
        file.read_exact(&mut box_type)?;
        let (header_size, body_size) = if size32 == 1 {
            let large = read_u64(file, offset + 8)?;
            (16u64, large.saturating_sub(16))
        } else if size32 == 0 {
            (8u64, end.saturating_sub(offset + 8))
        } else {
            (8u64, (size32 as u64).saturating_sub(8))
        };
        if body_size == 0 {
            break;
        }
        boxes.push(Mp4Box {
            box_type,
            body_start: offset + header_size,
            body_size,
        });
        offset += header_size + body_size;
    }
    Ok(boxes)
}

fn find_box<'a>(boxes: &'a [Mp4Box], box_type: &[u8; 4]) -> Option<&'a Mp4Box> {
    boxes.iter().find(|item| &item.box_type == box_type)
}

/// 沿 moov → trak → mdia → minf → stbl 定位视频轨的 stts（解码时间戳表）。
fn find_video_stts(file: &mut File, start: u64, end: u64) -> std::io::Result<Option<Mp4Box>> {
    let tops = list_boxes(file, start, end)?;
    let Some(moov) = find_box(&tops, b"moov") else {
        return Ok(None);
    };
    let moov_end = moov.body_start + moov.body_size;
    let traks = list_boxes(file, moov.body_start, moov_end)?;
    for trak in traks.iter().filter(|item| &item.box_type == b"trak") {
        let trak_end = trak.body_start + trak.body_size;
        let trak_children = list_boxes(file, trak.body_start, trak_end)?;
        let Some(mdia) = find_box(&trak_children, b"mdia") else {
            continue;
        };
        let mdia_end = mdia.body_start + mdia.body_size;
        let mdia_children = list_boxes(file, mdia.body_start, mdia_end)?;
        // hdlr body: fullbox(4) + pre_defined(4) + handler_type(4)
        let is_video = mdia_children
            .iter()
            .find(|item| &item.box_type == b"hdlr")
            .map(|hdlr| {
                read_u32(file, hdlr.body_start + 8)
                    .map(|handler| handler == u32::from_be_bytes(*b"vide"))
                    .unwrap_or(false)
            })
            .unwrap_or(false);
        if !is_video {
            continue;
        }
        let Some(minf) = find_box(&mdia_children, b"minf") else {
            continue;
        };
        let minf_end = minf.body_start + minf.body_size;
        let minf_children = list_boxes(file, minf.body_start, minf_end)?;
        let Some(stbl) = find_box(&minf_children, b"stbl") else {
            continue;
        };
        let stbl_end = stbl.body_start + stbl.body_size;
        let stbl_children = list_boxes(file, stbl.body_start, stbl_end)?;
        if let Some(stts) = find_box(&stbl_children, b"stts") {
            return Ok(Some(stts.clone()));
        }
    }
    Ok(None)
}

/// 读取 stts 的 sample_delta 集合（run-length 编码，取每段 delta 值即可判断是否 VFR）。
fn read_stts_deltas(file: &mut File, stts: &Mp4Box) -> std::io::Result<Vec<u32>> {
    let mut deltas = Vec::new();
    // stts body: fullbox(4) + entry_count(4) + entries(sample_count u32 + sample_delta u32)
    let entry_count = read_u32(file, stts.body_start + 4)? as usize;
    const MAX_ENTRIES: usize = 200_000;
    for index in 0..entry_count.min(MAX_ENTRIES) {
        let entry_offset = stts.body_start + 8 + (index as u64) * 8;
        if entry_offset + 8 > stts.body_start + stts.body_size {
            break;
        }
        let sample_delta = read_u32(file, entry_offset + 4)?;
        deltas.push(sample_delta);
    }
    Ok(deltas)
}

/// VFR 判定：非零 delta 种类 > 1 即为可变帧率。
fn deltas_are_vfr(deltas: &[u32]) -> bool {
    let mut seen = HashSet::new();
    for &delta in deltas {
        if delta > 0 {
            seen.insert(delta);
        }
    }
    seen.len() > 1
}

fn ffmpeg_exe_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    }
}

/// 定位随应用分发的 ffmpeg：资源目录 → 编译期清单目录（dev）→ 可执行文件同目录。
/// 同时供视频缩略图抽帧（asset_library::extract_video_thumbnail）复用。
pub(crate) fn resolve_ffmpeg_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;

    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidate = resource_dir.join("bin").join(ffmpeg_exe_name());
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("bin")
        .join(ffmpeg_exe_name());
    if manifest.is_file() {
        return Some(manifest);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join("bin").join(ffmpeg_exe_name());
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn run_ffmpeg_normalize(ffmpeg: &Path, input: &Path, output: &Path) -> Result<(), String> {
    let status = Command::new(ffmpeg)
        .args(["-y", "-hide_banner", "-loglevel", "error"])
        .arg("-i")
        .arg(input)
        .args(["-r", "30"])
        .args(["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p"])
        .args(["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"])
        .arg(output)
        .status()
        .map_err(|error| format!("无法启动 ffmpeg: {error}"))?;
    if !status.success() {
        return Err(format!("ffmpeg 转码失败 (exit: {status:?})"));
    }
    let empty_or_missing = output
        .metadata()
        .map(|meta| meta.len() == 0)
        .unwrap_or(true);
    if empty_or_missing {
        return Err("ffmpeg 输出文件缺失或为空".to_string());
    }
    Ok(())
}

/// 超分上传前的 CFR 归一化入口：VFR 源转 30fps CFR 临时文件，其余原样返回。
#[tauri::command]
pub fn normalize_video_cfr(
    app: tauri::AppHandle,
    source_path: String,
) -> Result<VideoCfrResult, String> {
    let unchanged = |reason: &str| VideoCfrResult {
        output_path: source_path.clone(),
        converted: false,
        reason: Some(reason.to_string()),
    };

    let source = Path::new(&source_path);
    if !source.is_file() {
        return Ok(unchanged("源文件不存在"));
    }
    let extension = source
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .unwrap_or_default();
    if extension != "mp4" && extension != "mov" && extension != "m4v" {
        return Ok(unchanged("非 MP4/MOV 容器，跳过 CFR 归一化"));
    }

    let mut file = File::open(source).map_err(|error| format!("打开源视频失败: {error}"))?;
    let file_len = file
        .seek(SeekFrom::End(0))
        .map_err(|error| format!("读取文件长度失败: {error}"))?;
    if file_len < 64 {
        return Ok(unchanged("文件过小，无法解析"));
    }
    let stts = find_video_stts(&mut file, 0, file_len)
        .map_err(|error| format!("解析视频结构失败: {error}"))?;
    let Some(stts) = stts else {
        return Ok(unchanged("未找到视频轨时间戳表(stts)"));
    };
    let deltas = read_stts_deltas(&mut file, &stts)
        .map_err(|error| format!("读取时间戳表失败: {error}"))?;
    if deltas.is_empty() {
        return Ok(unchanged("时间戳表为空"));
    }
    if !deltas_are_vfr(&deltas) {
        return Ok(unchanged("恒定帧率(CFR)，无需转换"));
    }
    let Some(ffmpeg) = resolve_ffmpeg_path(&app) else {
        return Ok(unchanged("未找到 ffmpeg 可执行文件"));
    };

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let output = std::env::temp_dir().join(format!("lentalk-cfr-{nanos}.mp4"));
    run_ffmpeg_normalize(&ffmpeg, source, &output)?;

    Ok(VideoCfrResult {
        output_path: output.to_string_lossy().to_string(),
        converted: true,
        reason: None,
    })
}
