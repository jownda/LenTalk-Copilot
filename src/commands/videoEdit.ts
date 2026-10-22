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
