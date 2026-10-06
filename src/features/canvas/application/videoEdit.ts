import type { VideoEditAudioMode, VideoEditRequest } from "@/commands/videoEdit";

/**
 * 视频编辑弹窗的纯逻辑。
 *
 * 弹窗本身只负责渲染与事件绑定，所有「算得出来」的东西都放这里：时间轴换算、
 * 双手柄夹取、请求体拼装、可提交性校验。这样在无 jsdom 的测试环境里也能直接断言。
 */

/** 最短片段。和后端 `MIN_TRIM_DURATION_SEC` 保持一致，前端先挡一道能省一次往返。 */
export const MIN_CLIP_DURATION_SEC = 0.1;

/** 时长未知（元数据还没读到）时用的占位时长，让时间轴仍可交互。 */
export const FALLBACK_DURATION_SEC = 1;

export interface TrimRange {
  start: number;
  end: number;
}

export interface VideoEditState {
  /** 源视频时长（秒）。0 表示还没读到。 */
  duration: number;
  trim: TrimRange;
  audioMode: VideoEditAudioMode;
  audioVolume: number;
  trackPath: string | null;
  trackPathLabel: string | null;
  trackVolume: number;
  fadeIn: number;
  fadeOut: number;
}

/** 每次打开弹窗都拿一份全新的状态，避免上一段视频的裁剪区间被带过来。 */
export function createVideoEditState(duration = 0): VideoEditState {
  return {
    duration,
    trim: createFullTrimRange(duration),
    audioMode: "keep",
    audioVolume: 1,
    trackPath: null,
    trackPathLabel: null,
    trackVolume: 1,
    fadeIn: 0,
    fadeOut: 0,
  };
}

function clampToRange(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

/** 时长不可用（0 / NaN / 负数）时退回占位值，避免除以 0 得到 Infinity 宽度。 */
export function resolveTimelineDuration(duration: number): number {
  return Number.isFinite(duration) && duration > 0 ? duration : FALLBACK_DURATION_SEC;
}

/** 新视频的默认区间：整段。 */
export function createFullTrimRange(duration: number): TrimRange {
  const total = resolveTimelineDuration(duration);
  return { start: 0, end: total };
}

/**
 * 把区间收进 `[0, duration]`，并保证至少 MIN_CLIP_DURATION_SEC。
 * 优先保住起点（用户刚拖过的那一侧），把终点顶开。
 */
export function clampTrimRange(range: TrimRange, duration: number): TrimRange {
  const total = resolveTimelineDuration(duration);
  const minGap = Math.min(MIN_CLIP_DURATION_SEC, total);
  let start = clampToRange(range.start, 0, Math.max(0, total - minGap));
  let end = clampToRange(range.end, start + minGap, total);
  if (end - start < minGap) {
    start = Math.max(0, end - minGap);
    end = Math.min(total, start + minGap);
  }
  return { start, end };
}

/**
 * 拖动某一侧手柄。
 *
 * 起点被夹在 `[0, end - minGap]`，终点被夹在 `[start + minGap, duration]`，
 * 也就是两个手柄不会交叉，也不会把片段压成 0 长度。
 */
export function moveTrimHandle(
  handle: "start" | "end",
  seconds: number,
  range: TrimRange,
  duration: number,
): TrimRange {
  const total = resolveTimelineDuration(duration);
  const minGap = Math.min(MIN_CLIP_DURATION_SEC, total);
  if (handle === "start") {
    const start = clampToRange(seconds, 0, Math.max(0, range.end - minGap));
    return { start, end: range.end };
  }
  const end = clampToRange(seconds, Math.min(total, range.start + minGap), total);
  return { start: range.start, end };
}

/** 点时间轴时，看鼠标离哪个手柄更近 —— 就近吸附后继续拖。 */
export function pickNearestTrimHandle(seconds: number, range: TrimRange): "start" | "end" {
  if (!Number.isFinite(seconds)) return "start";
  return Math.abs(seconds - range.start) <= Math.abs(seconds - range.end) ? "start" : "end";
}

/**
 * 选中片段长度（秒）。
 *
 * 结果按毫秒取整：两个手柄贴到最小时长时，`5.1 - 5` 在二进制浮点下是
 * `0.09999999999999964`，四舍五入回 `0.1` 才能和下端的时长校验对齐。
 */
export function trimSelectionDuration(range: TrimRange): number {
  return Math.max(0, Math.round((range.end - range.start) * 1000) / 1000);
}

/** 秒 -> 时间轴上的 0~1 比例。 */
export function secondsToRatio(seconds: number, duration: number): number {
  const total = resolveTimelineDuration(duration);
  return clampToRange(seconds / total, 0, 1);
}

/** 0~1 比例 -> 秒。 */
export function ratioToSeconds(ratio: number, duration: number): number {
  const total = resolveTimelineDuration(duration);
  return clampToRange(ratio, 0, 1) * total;
}

function roundSeconds(value: number): number {
  return Math.round(clampToRange(value, 0, Number.MAX_SAFE_INTEGER) * 1000) / 1000;
}

/** 剪辑用时间码，保留一位小数 —— 只到秒的话拖不出想要的片段。 */
export function formatTimecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0:00.0";
  }
  const total = Math.floor(seconds * 10) / 10;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const secondsText = rest.toFixed(1).padStart(4, "0");
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${secondsText}`;
  }
  return `${minutes}:${secondsText}`;
}

/** 时间轴刻度文案：整段自动切成 5 段，长视频只留到整秒。 */
export function buildTimelineTicks(duration: number, count = 5): Array<{ ratio: number; label: string }> {
  const total = resolveTimelineDuration(duration);
  const steps = Math.max(1, Math.floor(count));
  return Array.from({ length: steps + 1 }, (_, index) => {
    const ratio = index / steps;
    return { ratio, label: formatTimecode(ratio * total) };
  });
}

/**
 * 选择音轨之后把模式自动切到「替换」：
 * 用户刚挑了首配乐，绝大多数情况下想要的是换掉原声，而不是什么都不发生。
 */
export function resolveAudioModeAfterTrackPick(current: VideoEditAudioMode, hasTrack: boolean): VideoEditAudioMode {
  if (!hasTrack) return "keep";
  return current === "keep" ? "replace" : current;
}

export type VideoEditValidationError = "missingTrack" | "clipTooShort" | "missingSource";

/** 返回第一条挡住提交的原因；`null` 表示可以提交。 */
export function validateVideoEditState(
  state: VideoEditState,
  sourcePath: string | null | undefined,
): VideoEditValidationError | null {
  if (!sourcePath || !sourcePath.trim()) return "missingSource";
  if ((state.audioMode === "replace" || state.audioMode === "mix") && !state.trackPath) {
    return "missingTrack";
  }
  if (trimSelectionDuration(state.trim) < MIN_CLIP_DURATION_SEC) return "clipTooShort";
  return null;
}

/** 把弹窗状态翻成后端请求体；不用的字段直接不传，让 Rust 侧走默认值。 */
export function buildVideoEditRequest(state: VideoEditState, sourcePath: string): VideoEditRequest {
  const usesTrack = state.audioMode === "replace" || state.audioMode === "mix";
  return {
    sourcePath,
    trimStart: roundSeconds(state.trim.start),
    trimEnd: roundSeconds(state.trim.end),
    audioMode: state.audioMode,
    audioVolume: state.audioVolume,
    ...(usesTrack && state.trackPath ? { trackPath: state.trackPath, trackVolume: state.trackVolume } : {}),
    fadeIn: state.fadeIn,
    fadeOut: state.fadeOut,
  };
}

/** 成片时长（秒），用于按钮上的「导出 x 秒」提示。 */
export function resolveOutputDuration(state: VideoEditState): number {
  return roundSeconds(trimSelectionDuration(state.trim));
}
