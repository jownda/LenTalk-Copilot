import type { VideoEditAudioMode, VideoEditRequest } from "@/commands/videoEdit";

import {
  TICKS_PER_SECOND,
  formatTimecode,
  snapTicksToFrame,
  ticksPerFrame,
  ticksToSeconds,
  type FrameRate,
} from "./mediaTime";

/**
 * 视频编辑弹窗的纯逻辑。弹窗只负责渲染与事件绑定，所有「算得出来」的东西都放这里。
 *
 * 数据模型是**多段保留区间**（`ClipSegment[]`），不是单个 `{start, end}`。
 * 原因很实际：剪辑最常做的操作是「删掉中间某段、把两边接起来」，单区间物理上装不下第二刀，
 * 用户只能反复导出再导入。
 *
 * 时间是 **tick 整数**（见 `mediaTime.ts`），不是浮点秒：浮点做减法会出现
 * `5.1 - 5 = 0.09999999999999964` 这种结果，只能靠四舍五入到毫秒掩盖，帧边界也就无从谈起。
 */

/** 最短片段（秒）。与后端 `MIN_TRIM_DURATION_SEC` 保持一致，前端先挡一道能省一次往返。 */
export const MIN_CLIP_DURATION_SEC = 0.1;
const MIN_CLIP_TICKS = Math.round(MIN_CLIP_DURATION_SEC * TICKS_PER_SECOND);

/** 时长未知（元数据还没读到）时用的占位时长，让时间轴仍可交互。 */
export const FALLBACK_DURATION_SEC = 1;
const FALLBACK_DURATION_TICKS = FALLBACK_DURATION_SEC * TICKS_PER_SECOND;

/** 一段保留下来的源片段。`id` 只为渲染与选中服务，落盘时不传。 */
export interface ClipSegment {
  id: string;
  startTicks: number;
  endTicks: number;
}

export interface VideoEditState {
  /** 源视频总长（tick）。0 表示还没读到。 */
  durationTicks: number;
  /** 源视频帧率；探测失败时为 null，此时吸附退回毫秒。 */
  frameRate: FrameRate | null;
  /** 保留的片段，按时间升序、互不重叠、至少一段。 */
  segments: ClipSegment[];
  /** 当前选中的片段 id（删除 / 微调秒数作用于它）。 */
  selectedId: string | null;
  audioMode: VideoEditAudioMode;
  audioVolume: number;
  trackPath: string | null;
  trackPathLabel: string | null;
  trackVolume: number;
  fadeIn: number;
  fadeOut: number;
}

let segmentCounter = 0;
function nextSegmentId(): string {
  segmentCounter += 1;
  return `seg-${segmentCounter}`;
}

export function makeSegment(startTicks: number, endTicks: number): ClipSegment {
  return { id: nextSegmentId(), startTicks, endTicks };
}

/** 每次打开弹窗都拿一份全新状态，避免上一段视频的裁剪区间被带过来。 */
export function createVideoEditState(): VideoEditState {
  return {
    durationTicks: 0,
    frameRate: null,
    segments: [makeSegment(0, FALLBACK_DURATION_TICKS)],
    selectedId: null,
    audioMode: "keep",
    audioVolume: 1,
    trackPath: null,
    trackPathLabel: null,
    trackVolume: 1,
    fadeIn: 0,
    fadeOut: 0,
  };
}

/** 时间轴总长；时长未知时退回占位值，避免除以 0 得到 Infinity 宽度。 */
export function timelineTicks(state: Pick<VideoEditState, "durationTicks">): number {
  return state.durationTicks > 0 ? state.durationTicks : FALLBACK_DURATION_TICKS;
}

/**
 * 被剪掉的区间（段落之间的空隙），用于在时间轴上压暗这些区域。
 *
 * 单独成函数是因为它是**几何**而不是渲染细节：波形要按它分区着色，
 * 空档遮罩要按它定位，将来做「点空隙自动闭合」也要用它。写进组件里就只能靠肉眼验。
 *
 * 段落允许乱序传入；函数自己排序，并且按 `endTicks` 推进游标
 * （直接取 `segment.endTicks` 会在重叠输入下把人倒退回去，反而漏掉空隙）。
 */
export function removedRanges(
  segments: readonly ClipSegment[],
  durationTicks: number,
): Array<{ startTicks: number; endTicks: number }> {
  if (durationTicks <= 0) return [];
  const sorted = [...segments].sort((left, right) => left.startTicks - right.startTicks);
  const gaps: Array<{ startTicks: number; endTicks: number }> = [];
  let cursor = 0;
  for (const segment of sorted) {
    const start = Math.max(0, segment.startTicks);
    if (start > cursor) {
      gaps.push({ startTicks: cursor, endTicks: Math.min(start, durationTicks) });
    }
    cursor = Math.max(cursor, segment.endTicks);
    if (cursor >= durationTicks) break;
  }
  if (cursor < durationTicks) {
    gaps.push({ startTicks: cursor, endTicks: durationTicks });
  }
  return gaps.filter((gap) => gap.endTicks > gap.startTicks);
}

/**
 * 最短片段长度（tick）。
 *
 * 取「不小于 0.1 秒的整数帧」：24fps 每帧 5000 tick，硬用 12000 会得到一个跨帧的边界，
 * 之后每次吸附都要再修一次。
 */
export function minSegmentTicks(rate: FrameRate | null | undefined): number {
  const perFrame = ticksPerFrame(rate);
  if (!perFrame) return MIN_CLIP_TICKS;
  return Math.ceil(MIN_CLIP_TICKS / perFrame) * perFrame;
}

/**
 * 视频元数据到齐后初始化 / 校正片段。
 *
 * 首次读到时长 → 铺满整段；时长变了（换了素材）→ 收敛到新时长内，但不重置用户已经做的剪辑。
 */
export function applySourceMeta(
  state: VideoEditState,
  meta: { durationTicks: number; frameRate: FrameRate | null },
): VideoEditState {
  const durationTicks = meta.durationTicks > 0 ? Math.round(meta.durationTicks) : 0;
  const firstLoad = state.durationTicks <= 0;

  if (firstLoad) {
    const segments = durationTicks > 0 ? [makeSegment(0, durationTicks)] : state.segments;
    return {
      ...state,
      durationTicks,
      frameRate: meta.frameRate,
      segments,
      // 只有一段时直接选中它：这样「删除」在只剩一段时会被挡下，而不是静默无反应。
      selectedId: segments[0]?.id ?? null,
    };
  }

  return clampSegmentsToDuration(
    { ...state, frameRate: meta.frameRate },
    durationTicks > 0 ? durationTicks : state.durationTicks,
  );
}

/** 把片段收进 `[0, duration]`，并丢掉彻底越界的段（保留至少一段）。 */
export function clampSegmentsToDuration(state: VideoEditState, durationTicks: number): VideoEditState {
  const minTicks = minSegmentTicks(state.frameRate);
  const kept: ClipSegment[] = [];
  for (const segment of state.segments) {
    const startTicks = Math.max(0, Math.min(segment.startTicks, durationTicks));
    const endTicks = Math.max(0, Math.min(segment.endTicks, durationTicks));
    if (endTicks - startTicks >= minTicks) {
      kept.push({ ...segment, startTicks, endTicks });
    }
  }
  const segments = kept.length > 0 ? kept : [makeSegment(0, Math.max(minTicks, durationTicks))];
  const selectedId = segments.some((segment) => segment.id === state.selectedId)
    ? state.selectedId
    : (segments[0]?.id ?? null);
  return { ...state, durationTicks, segments, selectedId };
}

/** 成片总长（所有保留段相加）。 */
export function totalKeptTicks(segments: readonly ClipSegment[]): number {
  return segments.reduce((sum, segment) => sum + Math.max(0, segment.endTicks - segment.startTicks), 0);
}

/** 该时间点落在哪一段里（`[start, end)`）。 */
export function findSegmentAt(
  segments: readonly ClipSegment[],
  ticks: number,
): ClipSegment | null {
  for (const segment of segments) {
    if (ticks >= segment.startTicks && ticks < segment.endTicks) return segment;
  }
  return null;
}

/** 该时间点是否已被剪掉（用于压暗与「播放时跳过」）。 */
export function isTicksRemoved(segments: readonly ClipSegment[], ticks: number): boolean {
  if (segments.length === 0) return false;
  return findSegmentAt(segments, ticks) === null;
}

/**
 * 在指定位置切一刀。
 *
 * 切点会吸附到帧；若切点离段边界不足一个最短片段，则不切（返回原数组并由调用方提示），
 * 否则会切出一段无法导出的碎渣。
 */
export function splitSegmentsAt(
  segments: readonly ClipSegment[],
  ticks: number,
  rate: FrameRate | null | undefined,
): ClipSegment[] {
  const minTicks = minSegmentTicks(rate);
  const target = snapTicksToFrame(ticks, rate);
  const container = findSegmentAt(segments, target);
  if (!container) return [...segments];

  if (
    target - container.startTicks < minTicks ||
    container.endTicks - target < minTicks
  ) {
    return [...segments];
  }

  const result: ClipSegment[] = [];
  for (const segment of segments) {
    if (segment.id !== container.id) {
      result.push(segment);
      continue;
    }
    result.push({ ...segment, endTicks: target });
    result.push(makeSegment(target, segment.endTicks));
  }
  return result;
}

/**
 * 删除某一段（留下空隙 = 中间被剪掉）。
 *
 * 最后一段不允许删 —— 全删光既导不出东西，也没法在界面上恢复。
 */
export function deleteSegment(segments: readonly ClipSegment[], id: string): ClipSegment[] {
  if (segments.length <= 1) return [...segments];
  const next = segments.filter((segment) => segment.id !== id);
  return next.length > 0 ? next : [...segments];
}

/**
 * 拖动某一段的边界。
 *
 * 拖起点时不能越过上一段的终点，拖终点时不能越过下一段的起点 —— 否则段会重叠，
 * 导出时同一段画面会重复两遍，而界面上完全看不出来。
 */
export function moveSegmentEdge(
  segments: readonly ClipSegment[],
  id: string,
  edge: "start" | "end",
  ticks: number,
  rate: FrameRate | null | undefined,
  durationTicks: number,
): ClipSegment[] {
  const minTicks = minSegmentTicks(rate);
  const index = segments.findIndex((segment) => segment.id === id);
  if (index < 0) return [...segments];

  const segment = segments[index];
  const snapped = snapTicksToFrame(ticks, rate);
  const previousEnd = index > 0 ? segments[index - 1].endTicks : 0;
  const nextStart = index + 1 < segments.length ? segments[index + 1].startTicks : durationTicks;

  const next: ClipSegment[] = segments.map((item) => ({ ...item }));
  if (edge === "start") {
    next[index].startTicks = Math.max(
      previousEnd,
      Math.min(snapped, segment.endTicks - minTicks),
    );
  } else {
    next[index].endTicks = Math.min(
      nextStart,
      Math.max(snapped, segment.startTicks + minTicks),
    );
  }
  return next;
}

/**
 * 播放时用：给出下一个仍在保留区的起点。
 *
 * 没有它的话，删掉中间一段后按播放，被删掉的画面照常播出来，用户以为没剪上。
 */
export function nextKeptTick(
  segments: readonly ClipSegment[],
  ticks: number,
  durationTicks: number,
): number | null {
  let candidate: number | null = null;
  for (const segment of segments) {
    if (segment.startTicks > ticks && (candidate === null || segment.startTicks < candidate)) {
      candidate = segment.startTicks;
    }
  }
  if (candidate !== null) return candidate;
  // 后面已经没有保留段了：要么停在片尾，要么不动。
  return ticks < durationTicks ? durationTicks : null;
}

/** 秒 → 时间轴上的 0~1 比例。 */
export function ticksToRatio(ticks: number, durationTicks: number): number {
  const total = durationTicks > 0 ? durationTicks : FALLBACK_DURATION_TICKS;
  if (!Number.isFinite(ticks)) return 0;
  return Math.min(1, Math.max(0, ticks / total));
}

/** 0~1 比例 → tick。 */
export function ratioToTicks(ratio: number, durationTicks: number): number {
  const total = durationTicks > 0 ? durationTicks : FALLBACK_DURATION_TICKS;
  if (!Number.isFinite(ratio)) return 0;
  return Math.min(1, Math.max(0, ratio)) * total;
}

/** 时间轴刻度：**带标签**。旧版只画了三条没标签的竖线，长视频里根本定位不了。 */
export function buildTimelineTicks(
  durationTicks: number,
  rate: FrameRate | null | undefined,
  count = 5,
): Array<{ ratio: number; label: string }> {
  const total = durationTicks > 0 ? durationTicks : FALLBACK_DURATION_TICKS;
  const steps = Math.max(1, Math.floor(count));
  return Array.from({ length: steps + 1 }, (_, index) => {
    const ratio = index / steps;
    return { ratio, label: formatTimecode(ratio * total, rate) };
  });
}

/**
 * 选择音轨之后把模式自动切到「替换」：
 * 用户刚挑了首配乐，绝大多数情况下想要的是换掉原声，而不是什么都不发生。
 */
export function resolveAudioModeAfterTrackPick(
  current: VideoEditAudioMode,
  hasTrack: boolean,
): VideoEditAudioMode {
  if (!hasTrack) return "keep";
  return current === "keep" ? "replace" : current;
}

export type VideoEditValidationError = "missingTrack" | "clipTooShort" | "missingSource" | "noClip";

/** 返回第一条挡住提交的原因；`null` 表示可以提交。 */
export function validateVideoEditState(
  state: VideoEditState,
  sourcePath: string | null | undefined,
): VideoEditValidationError | null {
  if (!sourcePath || !sourcePath.trim()) return "missingSource";
  if (state.segments.length === 0) return "noClip";
  if (totalKeptTicks(state.segments) < minSegmentTicks(state.frameRate)) return "noClip";
  if ((state.audioMode === "replace" || state.audioMode === "mix") && !state.trackPath) {
    return "missingTrack";
  }
  return null;
}

/** tick → 提交用的秒（6 位小数；1 tick = 0.00000833 秒，够精确了）。 */
function ticksToWireSeconds(ticks: number): number {
  return Math.round(ticksToSeconds(ticks) * 1_000_000) / 1_000_000;
}

/** 把弹窗状态翻成后端请求体；不用的字段直接不传，让 Rust 侧走默认值。 */
export function buildVideoEditRequest(state: VideoEditState, sourcePath: string): VideoEditRequest {
  const usesTrack = state.audioMode === "replace" || state.audioMode === "mix";
  return {
    sourcePath,
    segments: state.segments.map((segment) => ({
      start: ticksToWireSeconds(segment.startTicks),
      end: ticksToWireSeconds(segment.endTicks),
    })),
    audioMode: state.audioMode,
    audioVolume: state.audioVolume,
    ...(usesTrack && state.trackPath
      ? { trackPath: state.trackPath, trackVolume: state.trackVolume }
      : {}),
    fadeIn: state.fadeIn,
    fadeOut: state.fadeOut,
  };
}

/** 成片时长（秒），用于按钮上的「导出 x 秒」提示。 */
export function resolveOutputDuration(state: VideoEditState): number {
  return Math.round(ticksToSeconds(totalKeptTicks(state.segments)) * 1000) / 1000;
}

/** 重新导出时给 UI 用的时间码。 */
export function formatTicks(ticks: number, rate: FrameRate | null | undefined): string {
  return formatTimecode(ticks, rate);
}
