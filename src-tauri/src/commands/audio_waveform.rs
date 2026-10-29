//! 音频波形提取。
//!
//! 为什么不用 WebView 的 `decodeAudioData`：那需要先把**整个视频文件**读进 JS 内存
//! （几十上百 MB），再交给浏览器解码。剪辑素材动辄几十 MB，每次打开面板都这么干一次，
//! 既慢又占内存，而且容器/编码不受支持时直接失败。ffmpeg 只解码音频轨，代价小得多。
//!
//! 输出是**归一化到 0~1 的桶峰值**（每个桶取 RMS），前端直接画柱状图。
//! 没有音轨、文件不存在、ffmpeg 不可用——一律返回**空数组**，不报错：
//! 波形是锦上添花，缺了不该让剪辑面板弹错误框。

use std::process::Command;

use tauri::AppHandle;

use super::video_cfr::{hide_child_console, resolve_ffmpeg_path};

/// 取波形时的采样率。
///
/// 波形只给人看强弱，4 kHz 足够分辨 10ms 级的起伏；10 分钟的视频也只有
/// `4000 × 2 × 600 ≈ 4.6 MB` 的管道数据，读完即丢。
const SAMPLE_RATE: u32 = 4_000;
/// 桶数下限/上限：太少看不出节奏，太多既画不下也白占内存。
const MIN_BUCKETS: u32 = 16;
const MAX_BUCKETS: u32 = 4_000;

#[tauri::command]
pub async fn audio_waveform(
    app: AppHandle,
    source_path: String,
    buckets: u32,
) -> Result<Vec<f32>, String> {
    tauri::async_runtime::spawn_blocking(move || audio_waveform_blocking(&app, &source_path, buckets))
        .await
        .map_err(|error| format!("波形提取失败: {error}"))?
}

fn audio_waveform_blocking(
    app: &AppHandle,
    source_path: &str,
    buckets: u32,
) -> Result<Vec<f32>, String> {
    let input = source_path.trim();
    if input.is_empty() {
        return Ok(Vec::new());
    }
    let remote = input.starts_with("http://") || input.starts_with("https://");
    // 远程源会让 ffmpeg 真去拉网络，波形不值得这个等待，直接当作拿不到。
    if remote || !std::path::Path::new(input).is_file() {
        return Ok(Vec::new());
    }
    let Some(ffmpeg) = resolve_ffmpeg_path(app) else {
        return Ok(Vec::new());
    };
    let buckets = buckets.clamp(MIN_BUCKETS, MAX_BUCKETS) as usize;

    let mut command = Command::new(ffmpeg);
    hide_child_console(&mut command);
    let output = command
        .args([
            "-v",
            "error",
            "-i",
            input,
            // 丢掉画面，只留音频；没有音轨时 ffmpeg 会以非 0 退出，下面按「空」处理。
            "-vn",
            "-ac",
            "1",
            "-ar",
            &SAMPLE_RATE.to_string(),
            "-f",
            "s16le",
            "-acodec",
            "pcm_s16le",
            "-",
        ])
        .output()
        .map_err(|error| format!("无法启动 ffmpeg: {error}"))?;

    if !output.status.success() || output.stdout.is_empty() {
        return Ok(Vec::new());
    }
    Ok(bucket_peaks_le_bytes(&output.stdout, buckets))
}

/// 把 s16le 的裸字节切成桶算 RMS，再归一化到 0~1。
///
/// 抽成独立函数是为了能单测：ffmpeg 是否可用不该成为「算法对不对」的前置条件。
fn bucket_peaks_le_bytes(bytes: &[u8], buckets: usize) -> Vec<f32> {
    let samples: Vec<i16> = bytes
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    bucket_peaks(&samples, buckets)
}

fn bucket_peaks(samples: &[i16], buckets: usize) -> Vec<f32> {
    if samples.is_empty() || buckets == 0 {
        return Vec::new();
    }
    let per_bucket = samples.len().div_ceil(buckets);
    let mut peaks = Vec::with_capacity(buckets);
    for index in 0..buckets {
        let start = index * per_bucket;
        if start >= samples.len() {
            peaks.push(0.0);
            continue;
        }
        let end = (start + per_bucket).min(samples.len());
        let mut sum = 0.0_f64;
        for sample in &samples[start..end] {
            let value = f64::from(*sample) / f64::from(i16::MAX);
            sum += value * value;
        }
        peaks.push((sum / (end - start) as f64).sqrt() as f32);
    }

    // 归一化：绝对音量没有意义（有的素材录得很轻），能看出相对强弱就够。
    let max = peaks.iter().copied().fold(0.0_f32, f32::max);
    if max <= f32::EPSILON {
        return peaks.iter().map(|_| 0.0).collect();
    }
    peaks.iter().map(|peak| (peak / max).clamp(0.0, 1.0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input_yields_empty_output() {
        assert!(bucket_peaks(&[], 8).is_empty());
        assert!(bucket_peaks(&[1, 2, 3], 0).is_empty());
    }

    #[test]
    fn constant_signal_normalizes_to_full_scale() {
        let samples = vec![i16::MAX; 100];
        let peaks = bucket_peaks(&samples, 4);
        assert_eq!(peaks.len(), 4);
        for peak in peaks {
            assert!((peak - 1.0).abs() < 1e-6, "peak={peak}");
        }
    }

    #[test]
    fn silence_stays_zero_instead_of_nan() {
        let peaks = bucket_peaks(&vec![0_i16; 64], 4);
        assert_eq!(peaks, vec![0.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn quieter_bucket_stays_proportionally_lower() {
        // 前半满幅、后半半幅：归一化之后应当是 1.0 与 0.5。
        let mut samples = vec![i16::MAX; 50];
        samples.extend(vec![i16::MAX / 2; 50]);
        let peaks = bucket_peaks(&samples, 2);
        assert!((peaks[0] - 1.0).abs() < 1e-6, "loud={}", peaks[0]);
        assert!((peaks[1] - 0.5).abs() < 1e-3, "quiet={}", peaks[1]);
    }

    #[test]
    fn extra_buckets_are_padded_with_zero_not_dropped() {
        // 样本比桶还少时，多出来的桶要补 0，长度必须仍然是 buckets ——
        // 少了会让前端的时间轴映射整体错位。
        let peaks = bucket_peaks(&[i16::MAX, i16::MAX], 8);
        assert_eq!(peaks.len(), 8);
        assert!(peaks[2..].iter().all(|peak| *peak == 0.0));
    }

    #[test]
    fn reads_little_endian_pcm() {
        // 0x7FFF = 32767（满幅）、0x0000 = 0
        let bytes = [0xFF, 0x7F, 0x00, 0x00];
        let peaks = bucket_peaks_le_bytes(&bytes, 2);
        assert!((peaks[0] - 1.0).abs() < 1e-6);
        assert_eq!(peaks[1], 0.0);
    }

    #[test]
    fn odd_trailing_byte_is_ignored() {
        let peaks = bucket_peaks_le_bytes(&[0xFF, 0x7F, 0x00], 1);
        assert_eq!(peaks.len(), 1);
        assert!((peaks[0] - 1.0).abs() < 1e-6);
    }
}
