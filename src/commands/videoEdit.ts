import { invoke } from "@tauri-apps/api/core";

/** 音轨处理方式：保留原声 / 静音 / 换成新音轨 / 与原声混合。 */
export type VideoEditAudioMode = "keep" | "mute" | "replace" | "mix";

/** 一段保留下来的源区间（秒）。多段按数组顺序拼接成片。 */
export interface VideoEditSegment {
  start: number;
  end: number;
}

export interface VideoEditRequest {
  sourcePath: string;
  /**
   * 保留的片段列表（秒，按时间升序、互不重叠）。
   *
   * 单段时后端走 `-ss/-t` 快路径；多段时改走 `filter_complex` 的 concat。
   * 不传则回落到 `trimStart/trimEnd` 的旧行为。
   */
  segments?: VideoEditSegment[];
  /** 裁剪起点（秒），缺省 0。仅在没传 `segments` 时生效。 */
  trimStart?: number;
  /** 裁剪终点（秒），缺省到片尾。仅在没传 `segments` 时生效。 */
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
  /** 视频帧率（ffmpeg 报的小数，如 23.98）。探测不到时为 null。 */
  fps?: number | null;
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

/** 高级剪辑：时间线上一段视频（`start/end` 是源素材内的入出点，秒）。 */
/** 片段画面变换。单位见 `advancedEditor.ts` 的 `ClipTransform`。 */
export interface AdvancedVideoClipTransform {
  scale?: number;
  scaleX?: number;
  scaleY?: number;
  /** 画布宽百分比。 */
  x?: number;
  /** 画布高百分比。 */
  y?: number;
  rotation?: number;
  opacity?: number;
  borderRadius?: number;
}

/** 一个关键帧：`t` 是**相对片段起点**的秒数。 */
export interface AdvancedVideoKeyframe {
  t: number;
  v: number;
  e?: "linear" | "ease-in" | "ease-out" | "ease-in-out";
}

/**
 * 片段属性动画。
 *
 * 只包含后端能算的属性 —— 它们都会变成 ffmpeg 表达式里的 `t` 函数。
 * 透明度/圆角目前只能静态（滤镜没有逐帧参数），所以不在这个列表里。
 */
export interface AdvancedVideoClipKeyframes {
  x?: AdvancedVideoKeyframe[];
  y?: AdvancedVideoKeyframe[];
  rotation?: AdvancedVideoKeyframe[];
}

export interface AdvancedVideoClip {
  sourcePath: string;
  start: number;
  end: number;
  /** 只提交**非默认**字段；整段没变换就不带，后端走快速的 concat 路径。 */
  transform?: AdvancedVideoClipTransform;
  /** 属性动画；有它就一定走合成路径（表达式逐帧求值）。 */
  keyframes?: AdvancedVideoClipKeyframes;
}

/** 高级剪辑：音乐轨。`start` 是在**成片时间轴**上的起点（秒）。 */
export interface AdvancedVideoMusic {
  sourcePath: string;
  start?: number;
  volume?: number;
  fadeIn?: number;
  fadeOut?: number;
}

/** 文字叠加：导出时由 ffmpeg `drawtext` 烧进画面。 */
export interface AdvancedVideoTitle {
  text: string;
  /** 在成片时间轴上的起止（秒）。 */
  start: number;
  end: number;
  /** 按 1080p 画布设计的字号，后端按实际画布高缩放。 */
  fontSize: number;
  /** `#RRGGBB`。 */
  color: string;
  position:
    | "top-left"
    | "top-center"
    | "top-right"
    | "middle-left"
    | "middle-center"
    | "middle-right"
    | "bottom-left"
    | "bottom-center"
    | "bottom-right";
  backdrop: boolean;
}

export interface AdvancedVideoEditRequest {
  clips: AdvancedVideoClip[];
  /** 文字叠加，按时间顺序。 */
  titles?: AdvancedVideoTitle[];
  /** `keep` 保留原声 / `mute` 静音。 */
  audioMode?: "keep" | "mute";
  audioVolume?: number;
  music?: AdvancedVideoMusic;
}

export interface AdvancedVideoEditResult {
  outputPath: string;
  /** 非致命问题（例如系统里没有可用字体，文字没画到成片上）。 */
  warnings?: string[];
  durationSec: number | null;
  /** 实际画布尺寸（以第一段为准，其余素材等比缩放并留边）。 */
  canvasWidth: number;
  canvasHeight: number;
}

/**
 * 高级剪辑渲染：多片段、可多源，首尾相接成一个新视频。
 *
 * 与 `renderVideoEdit` 的分工：那个是「一个源切几段」（快路径），这个是「任意片段序列」，
 * 会统一画布 / 帧率、给没音轨的片段补静音、并把音乐按时间轴偏移混进去。
 */
export async function renderAdvancedVideoEdit(
  request: AdvancedVideoEditRequest,
): Promise<AdvancedVideoEditResult> {
  return invoke<AdvancedVideoEditResult>("render_video_edit_advanced", { request });
}

/**
 * 视频胶片条：在 `[startSec, endSec]` 均匀抽 `frameCount` 帧，拼成一张横排 JPEG。
 *
 * 返回可交给 `resolveImageDisplayUrl` 的缓存路径；失败（无画面 / ffmpeg 缺失）返回 null，
 * 前端退成纯色块。
 */
export async function extractVideoFilmstrip(
  videoPath: string,
  startSec: number,
  endSec: number,
  frameCount: number,
  cellAspect: number,
): Promise<string | null> {
  return invoke<string | null>("extract_video_filmstrip", {
    videoPath,
    startSec,
    endSec,
    frameCount,
    cellAspect,
  });
}
