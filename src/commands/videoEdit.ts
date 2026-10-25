import { invoke } from "@tauri-apps/api/core";

/** 音轨处理方式：保留原声 / 静音 / 换成新音轨 / 与原声混合。 */
export type VideoEditAudioMode = "keep" | "mute" | "replace" | "mix";

export interface VideoEditRequest {
  sourcePath: string;
  /** 裁剪起点（秒），缺省 0。 */
  trimStart?: number;
  /** 裁剪终点（秒），缺省到片尾。 */
  trimEnd?: number;
  audioMode?: VideoEditAudioMode;
  /** 原声音量倍率，1 = 原样。 */
  audioVolume?: number;
  /** 新音轨来源（本地路径或远程 URL）。 */
  trackPath?: string;
  trackVolume?: number;
  /** 淡入 / 淡出秒数。 */
  fadeIn?: number;
  fadeOut?: number;
}

export interface VideoEditResult {
  outputPath: string;
  durationSec: number | null;
  /** 实际生效的模式：源视频没有音轨时 mix 会被后端降级成 replace。 */
  audioMode: VideoEditAudioMode;
}

/**
 * 交给随包 ffmpeg 做一次剪辑 + 音轨处理，返回写入素材目录的新文件路径。
 * 原生渲染只在桌面端可用，调用前请自行确认 `isTauri()`。
 */
export async function renderVideoEdit(request: VideoEditRequest): Promise<VideoEditResult> {
  return invoke<VideoEditResult>("render_video_edit", { request });
}

export interface VideoAudioProbeResult {
  /** 源文件里是否有音频流。 */
  hasAudio: boolean;
  durationSec: number | null;
}

/**
 * 探测视频有没有音频流。
 *
 * 「扒视频」用它提前决定链路：有音轨就走「视觉模型 + 音频模型」双模型，
 * 没有音轨就只用视觉模型拉片（否则音频听写阶段必然报错，整条链路白跑）。
 * 探测本身失败（ffmpeg 缺失、文件不可读）时抛错，调用方按「未知」处理、保持旧行为。
 */
export async function probeVideoAudio(sourcePath: string): Promise<VideoAudioProbeResult> {
  return invoke<VideoAudioProbeResult>("probe_video_audio", { sourcePath });
}
