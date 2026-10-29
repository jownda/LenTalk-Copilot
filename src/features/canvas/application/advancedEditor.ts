import type { AdvancedVideoEditRequest } from "@/commands/videoEdit";
import { TICKS_PER_SECOND, ticksPerFrame, type FrameRate } from "./mediaTime";

/**
 * 高级剪辑时间轴的纯逻辑。
 *
 * 模型和「基础剪辑」不同：那边是一个源视频切几段，这边是**任意多个片段首尾相接**，
 * 片段可以来自不同素材（不同分辨率、帧率、有没有音轨都行，后端负责统一画布）。
 *
 * 两条轨道：
 * - **V1 主视频轨**：片段按数组顺序首尾相接，位置由顺序推导 —— 拖动改变的是顺序，
 *   不是绝对坐标。这样时间线永远是「实心」的，不会出现需要黑场填充的空隙。
 * - **A2 音乐轨**：一条，位置自由（`startTicks`），后端用 `adelay` 推到对应位置。
 *
 * 原声（A1）不单独建模：它跟着 V1 的片段走，只有整体音量与静音两个开关。
 */

/**
 * 片段的画面变换（缩放 / 位移 / 旋转 / 透明 / 圆角）。
 *
 * 语义对齐 OpenChatCut 的 `ClipTransform`，也决定后端滤镜顺序：
 * **先缩放 → 再旋转（绕自身中心）→ 最后按画布百分比位移**，
 * 和 CSS 的 `translate(...) rotate(...) scale(...)` 完全一致，预览与导出一一对应。
 *
 * 单位约定：
 * - `scale*` 是倍数，1 = 100%（相对「等比放进画布」后的尺寸，不是相对素材原始分辨率）；
 * - `x/y` 是**画布宽/高的百分比**，不是像素 —— 换导出分辨率时位置不变；
 * - `rotation` 是角度；`opacity` 是 0~1；`borderRadius` 是画布像素。
 */
export interface ClipTransform {
  /** 等比缩放。`scaleX/scaleY` 未单独设置时以它为准。 */
  scale: number;
  /** 横向缩放，覆盖 `scale`。 */
  scaleX: number;
  /** 纵向缩放，覆盖 `scale`。 */
  scaleY: number;
  /** 水平位移，画布宽百分比（-100~100）。 */
  x: number;
  /** 垂直位移，画布高百分比（-100~100）。 */
  y: number;
  /** 旋转角度。 */
  rotation: number;
  /** 不透明度 0~1。 */
  opacity: number;
  /** 圆角，画布像素。 */
  borderRadius: number;
}

export const DEFAULT_CLIP_TRANSFORM: ClipTransform = {
  scale: 1,
  scaleX: 1,
  scaleY: 1,
  x: 0,
  y: 0,
  rotation: 0,
  opacity: 1,
  borderRadius: 0,
};

/** 拿到片段的完整变换（没设过的字段用默认值补齐）。 */
export function resolveClipTransform(clip: Pick<SequenceClip, "transform">): ClipTransform {
  return { ...DEFAULT_CLIP_TRANSFORM, ...(clip.transform ?? {}) };
}

/** 是否与「原样铺满画布」等价 —— 等价时后端走原来的 concat 路径，不必合成。 */
export function isIdentityTransform(transform: ClipTransform): boolean {
  return (
    Math.abs(transform.scale - 1) < 1e-4 &&
    Math.abs(transform.scaleX - 1) < 1e-4 &&
    Math.abs(transform.scaleY - 1) < 1e-4 &&
    Math.abs(transform.x) < 1e-4 &&
    Math.abs(transform.y) < 1e-4 &&
    Math.abs(transform.rotation) < 1e-4 &&
    Math.abs(transform.opacity - 1) < 1e-4 &&
    transform.borderRadius < 0.5
  );
}

/** 实际生效的 X/Y 缩放倍数：轴向值优先于等比（和参考项目一致，边拖不被等比覆盖）。 */
export function resolveScaleAxes(transform: ClipTransform): { scaleX: number; scaleY: number } {
  return {
    scaleX: transform.scaleX ?? transform.scale,
    scaleY: transform.scaleY ?? transform.scale,
  };
}

/**
 * 可以打关键帧的属性。
 *
 * 只有位移和旋转 —— 它们能用「每帧固定的输出尺寸 + 表达式」实现：
 * overlay 的 `x/y` 和 rotate 的 `a` 都接受含 `t` 的表达式，画面尺寸不变。
 *
 * 🔴 **缩放不能动画**：`scale=...:eval=frame` 会让输出尺寸逐帧变化，
 * 与 rotate 同链时 ffmpeg 直接崩溃（Windows 上 `0xC0000005`，单独用两者都正常）。
 * 缩放动画需要换成 zoompan 一类「固定输出尺寸的缩放」方案，属于另一件事。
 */
export const ANIMATABLE_PROPS = ["x", "y", "rotation"] as const;
export type AnimatableProp = (typeof ANIMATABLE_PROPS)[number];

/**
 * 缓动。
 *
 * 只提供四种，而且都必须是**能用四则运算写成 ffmpeg 表达式**的 ——
 * 后端要把整条曲线塞进滤镜参数里逐帧求值，贝塞尔之类算不了。
 */
export type KeyframeEasing = "linear" | "ease-in" | "ease-out" | "ease-in-out";

export const KEYFRAME_EASINGS: KeyframeEasing[] = ["linear", "ease-in", "ease-out", "ease-in-out"];

/** 一个关键帧。`ticks` 是**相对片段起点**的位置，不是时间轴绝对位置。 */
export interface ClipKeyframe {
  ticks: number;
  value: number;
  /** 从这一帧到**下一帧**之间用哪种缓动（最后一帧的 easing 无意义）。 */
  easing: KeyframeEasing;
}

export type ClipKeyframes = Partial<Record<AnimatableProp, ClipKeyframe[]>>;

/** 缓动曲线：输入 0~1 的进度，输出 0~1 的进度。 */
export function applyEasing(progress: number, easing: KeyframeEasing): number {
  const t = Math.min(1, Math.max(0, progress));
  switch (easing) {
    case "ease-in":
      return t * t;
    case "ease-out":
      return 1 - (1 - t) * (1 - t);
    case "ease-in-out":
      // 前后各半段用二次曲线接起来，中点斜率为 1，接缝处不会有折角。
      return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
    default:
      return t;
  }
}

/** 在一条关键帧序列上取值：首帧之前用首帧值，末帧之后用末帧值。 */
export function sampleKeyframes(
  keyframes: readonly ClipKeyframe[],
  localTicks: number,
): number | null {
  if (!keyframes.length) return null;
  const sorted = keyframes;
  if (localTicks <= sorted[0].ticks) return sorted[0].value;
  const last = sorted[sorted.length - 1];
  if (localTicks >= last.ticks) return last.value;
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const from = sorted[index];
    const to = sorted[index + 1];
    if (localTicks >= from.ticks && localTicks <= to.ticks) {
      const span = to.ticks - from.ticks;
      if (span <= 0) return to.value;
      const progress = applyEasing((localTicks - from.ticks) / span, from.easing);
      return from.value + (to.value - from.value) * progress;
    }
  }
  return last.value;
}

/**
 * 求某一时刻的**实际**变换 = 静态值 + 关键帧覆盖。
 *
 * 有关键帧的属性一律以曲线为准（静态值只在完全没有关键帧时生效），
 * 这样「打了帧又拖滑块」不会互相打架。
 */
export function sampleClipTransform(
  clip: Pick<SequenceClip, "transform" | "keyframes">,
  localTicks: number,
): ClipTransform {
  const base = resolveClipTransform(clip);
  const keyframes = clip.keyframes;
  if (!keyframes) return base;
  const next = { ...base };
  for (const prop of ANIMATABLE_PROPS) {
    const list = keyframes[prop];
    if (!list?.length) continue;
    const value = sampleKeyframes(list, localTicks);
    if (value !== null) next[prop] = value;
  }
  return next;
}

/** 片段上所有关键帧时刻（去重升序），时间轴画菱形用。 */
export function clipKeyframeTicks(clip: Pick<SequenceClip, "keyframes">): number[] {
  const ticks = new Set<number>();
  for (const prop of ANIMATABLE_PROPS) {
    for (const frame of clip.keyframes?.[prop] ?? []) ticks.add(frame.ticks);
  }
  return [...ticks].sort((left, right) => left - right);
}

/** 某一属性在这一刻是否已经有关键帧（容差半帧，避免取整误差导致「点了没反应」）。 */
export function findKeyframe(
  clip: Pick<SequenceClip, "keyframes" | "transform">,
  prop: AnimatableProp,
  localTicks: number,
  toleranceTicks: number,
): ClipKeyframe | null {
  const list = clip.keyframes?.[prop];
  if (!list) return null;
  return list.find((frame) => Math.abs(frame.ticks - localTicks) <= toleranceTicks) ?? null;
}

const TRANSFORM_LIMITS = {
  scale: [0.05, 8] as const,
  offset: [-200, 200] as const,
  rotation: [-360, 360] as const,
  opacity: [0, 1] as const,
  radius: [0, 1000] as const,
};

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** V1 上的一个片段。`inTicks/outTicks` 是**源素材内**的入出点。 */
export interface SequenceClip {
  id: string;
  sourcePath: string;
  sourceName: string;
  inTicks: number;
  outTicks: number;
  /** 画面变换；未设置 = 原样铺满画布。 */
  transform?: Partial<ClipTransform>;
  /** 属性动画。有关键帧的属性以曲线为准，静态值不再生效。 */
  keyframes?: ClipKeyframes;
}

/** A2 音乐：多一个时间轴位置。 */
export interface MusicClip {
  id: string;
  sourcePath: string;
  sourceName: string;
  inTicks: number;
  outTicks: number;
  /** 在成片时间轴上的起点。 */
  startTicks: number;
}

/** 文字在画面上的九宫格位置。用格子而不是自由 x/y：drawtext 里好算，用户也不用拖。 */
export type TitlePosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "middle-left"
  | "middle-center"
  | "middle-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

/**
 * 文字片段：叠在画面上的字，导出时由 ffmpeg `drawtext` 烧进成片。
 *
 * `fontSize` 是**按 1080p 画布**设计的像素值。后端会按「实际画布高 / 1080」缩放，
 * 这样同一份工程换成 720p 导出时字仍然占同样的画面比例。
 */
export interface TitleClip {
  id: string;
  text: string;
  /** 在成片时间轴上的起点与时长。 */
  startTicks: number;
  durationTicks: number;
  fontSize: number;
  /** `#RRGGBB`。 */
  color: string;
  position: TitlePosition;
  /** 半透明底衬：在浅色画面上也看得清。 */
  backdrop: boolean;
}

export interface AdvancedEditorState {
  frameRate: FrameRate | null;
  clips: SequenceClip[];
  titles: TitleClip[];
  music: MusicClip | null;
  originalVolume: number;
  muted: boolean;
  musicVolume: number;
  musicFadeIn: number;
  musicFadeOut: number;
  selectedId: string | null;
  playheadTicks: number;
  /** 时间轴缩放：每秒多少像素。 */
  pixelsPerSecond: number;
}

/** 最短片段（秒）。和后端 `MIN_TRIM_DURATION_SEC` 一致，前端先挡一道。 */
export const MIN_CLIP_DURATION_SEC = 0.1;
const MIN_CLIP_TICKS = Math.round(MIN_CLIP_DURATION_SEC * TICKS_PER_SECOND);

export const ZOOM_MIN_PX_PER_SEC = 8;
export const ZOOM_MAX_PX_PER_SEC = 320;
export const ZOOM_DEFAULT_PX_PER_SEC = 80;

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

export function minClipTicks(rate: FrameRate | null | undefined): number {
  const perFrame = ticksPerFrame(rate);
  if (!perFrame) return MIN_CLIP_TICKS;
  // 向下取整到帧的整数倍，避免最短长度本身跨帧。
  return Math.max(perFrame, Math.floor(MIN_CLIP_TICKS / perFrame) * perFrame);
}

export function createAdvancedState(frameRate: FrameRate | null = null): AdvancedEditorState {
  return {
    frameRate,
    clips: [],
    titles: [],
    music: null,
    originalVolume: 1,
    muted: false,
    musicVolume: 0.6,
    musicFadeIn: 0,
    musicFadeOut: 0,
    selectedId: null,
    playheadTicks: 0,
    pixelsPerSecond: ZOOM_DEFAULT_PX_PER_SEC,
  };
}

export function clipDuration(clip: Pick<SequenceClip, "inTicks" | "outTicks">): number {
  return Math.max(0, clip.outTicks - clip.inTicks);
}

/** V1 总长 = 各片段之和。 */
export function sequenceTicks(clips: readonly SequenceClip[]): number {
  return clips.reduce((sum, clip) => sum + clipDuration(clip), 0);
}

/** 每个 V1 片段在成片时间轴上的区间（首尾相接，由顺序推导）。 */
export function clipRanges(
  clips: readonly SequenceClip[],
): Array<{ clip: SequenceClip; start: number; end: number }> {
  let cursor = 0;
  return clips.map((clip) => {
    const duration = clipDuration(clip);
    const range = { clip, start: cursor, end: cursor + duration };
    cursor += duration;
    return range;
  });
}

/** 时间轴总长 = max(V1 总长, 音乐结束点)。 */
export function timelineTicks(state: AdvancedEditorState): number {
  const sequence = sequenceTicks(state.clips);
  const musicEnd = state.music ? state.music.startTicks + clipDuration(state.music) : 0;
  return Math.max(sequence, musicEnd);
}

export function findClipAt(
  clips: readonly SequenceClip[],
  ticks: number,
): { clip: SequenceClip; index: number; start: number } | null {
  const ranges = clipRanges(clips);
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];
    if (ticks >= range.start && ticks < range.end) {
      return { clip: range.clip, index, start: range.start };
    }
  }
  // 正好落在末尾时归到最后一段，避免「播放头在片尾却切不到」。
  const last = ranges[ranges.length - 1];
  if (last && ticks === last.end) {
    return { clip: last.clip, index: ranges.length - 1, start: last.start };
  }
  return null;
}

export function appendClip(
  state: AdvancedEditorState,
  source: { sourcePath: string; sourceName: string; durationTicks: number },
): AdvancedEditorState {
  return insertClip(state, state.clips.length, source);
}

/**
 * 插到序列的第 `index` 位（0 = 最前）。
 *
 * 拖拽落到 V1 时用得上：V1 是首尾相接的实心序列，落点要先换算成「插到第几段之前」，
 * 不能像 A2 那样按秒定位。
 */
export function insertClip(
  state: AdvancedEditorState,
  index: number,
  source: { sourcePath: string; sourceName: string; durationTicks: number },
): AdvancedEditorState {
  if (source.durationTicks <= 0) return state;
  const clip: SequenceClip = {
    id: nextId("clip"),
    sourcePath: source.sourcePath,
    sourceName: source.sourceName,
    inTicks: 0,
    outTicks: source.durationTicks,
  };
  const at = Math.max(0, Math.min(Math.round(index), state.clips.length));
  const clips = [...state.clips.slice(0, at), clip, ...state.clips.slice(at)];
  return { ...state, clips, selectedId: clip.id };
}

export function duplicateClip(state: AdvancedEditorState, id: string): AdvancedEditorState {
  const index = state.clips.findIndex((clip) => clip.id === id);
  if (index < 0) return state;
  const copy: SequenceClip = { ...state.clips[index], id: nextId("clip") };
  const clips = [...state.clips];
  clips.splice(index + 1, 0, copy);
  return { ...state, clips, selectedId: copy.id };
}

export function removeClip(state: AdvancedEditorState, id: string): AdvancedEditorState {
  const clips = state.clips.filter((clip) => clip.id !== id);
  return {
    ...state,
    clips,
    selectedId: state.selectedId === id ? (clips[0]?.id ?? null) : state.selectedId,
  };
}

/**
 * 在时间轴位置切一刀。
 *
 * 切点先换算成**源素材内**的位置，再按最短长度校验 —— 直接按时间轴算会在
 * 片段交接处切出 0 长度的碎渣。
 */
export function splitAt(state: AdvancedEditorState, ticks: number): AdvancedEditorState {
  const hit = findClipAt(state.clips, ticks);
  if (!hit) return state;
  const offset = ticks - hit.start;
  const sourceTicks = hit.clip.inTicks + offset;
  const minTicks = minClipTicks(state.frameRate);
  if (sourceTicks - hit.clip.inTicks < minTicks || hit.clip.outTicks - sourceTicks < minTicks) {
    return state;
  }

  const left: SequenceClip = { ...hit.clip, outTicks: sourceTicks };
  const right: SequenceClip = {
    id: nextId("clip"),
    sourcePath: hit.clip.sourcePath,
    sourceName: hit.clip.sourceName,
    inTicks: sourceTicks,
    outTicks: hit.clip.outTicks,
  };
  const clips = [...state.clips];
  clips.splice(hit.index, 1, left, right);
  return { ...state, clips, selectedId: right.id };
}

/**
 * 拖V1 片段的边缘。
 *
 * 只改源素材的入出点，不改位置 —— 位置由顺序决定，改它会和前后片段起冲突。
 * 拖左边 = 改入点（片段在时间线上会变短/变长，后面的片段整体前移/后移，符合磁吸直觉）。
 */
export function trimClipEdge(
  state: AdvancedEditorState,
  id: string,
  edge: "start" | "end",
  deltaTicks: number,
): AdvancedEditorState {
  const minTicks = minClipTicks(state.frameRate);
  const clips = state.clips.map((clip) => {
    if (clip.id !== id) return clip;
    if (edge === "start") {
      // 往右拖 = 入点变晚 = 片段变短；不能拖过出点（留出一个最短片段）。
      const nextIn = Math.min(Math.max(0, clip.inTicks + deltaTicks), clip.outTicks - minTicks);
      return { ...clip, inTicks: nextIn };
    }
    const nextOut = Math.max(clip.inTicks + minTicks, clip.outTicks + deltaTicks);
    return { ...clip, outTicks: nextOut };
  });
  return { ...state, clips };
}

/** 拖动改变顺序：把片段移到目标下标。 */
export function moveClipToIndex(
  state: AdvancedEditorState,
  id: string,
  targetIndex: number,
): AdvancedEditorState {
  const index = state.clips.findIndex((clip) => clip.id === id);
  if (index < 0 || state.clips.length <= 1) return state;
  const clips = [...state.clips];
  const [clip] = clips.splice(index, 1);
  const clamped = Math.max(0, Math.min(targetIndex, clips.length));
  clips.splice(clamped, 0, clip);
  return { ...state, clips };
}

/** 时间轴位置 → 应该插到第几个片段之后（拖动落点用）。 */
export function resolveDropIndex(clips: readonly SequenceClip[], ticks: number): number {
  const ranges = clipRanges(clips);
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];
    if (ticks < (range.start + range.end) / 2) return index;
  }
  return ranges.length;
}

/** 拖进轨道的落点。 */
export interface DropPlan {
  /** 落到哪条轨（拖音频进 V1 会自动改到 A2）。 */
  lane: "video" | "audio";
  /** 给 `addFromPool` 用：**V1 是插入索引，A2 是起点 tick**。 */
  at: number;
  /** 块在时间轴上的起点 tick（画虚线占位用）。 */
  startTicks: number;
  durationTicks: number;
}

/**
 * 把「指针位置 + 目标轨 + 素材」换算成落点。
 *
 * 预览（虚线块）和真正落子**共用这一个函数** —— 分开写迟早会出现
 * 「虚线画在一处、东西落在另一处」。所以它放在模型层，纯函数、可单测。
 *
 * 两条轨的落点语义本来就不同：
 * - **V1** 首尾相接的实心序列，没有空隙，落点只能是「插到第几段之前」；
 * - **A2** 音乐能停在任意位置，落点就是秒数。
 */
export function resolveDropPlan(
  clips: readonly SequenceClip[],
  ticks: number,
  lane: "video" | "audio",
  kind: "video" | "audio",
  durationTicks: number,
  fallbackDurationTicks: number,
): DropPlan {
  const duration = durationTicks > 0 ? durationTicks : fallbackDurationTicks;
  // 拖到哪条轨就按哪条轨走：拖进 A2 的视频当音乐放，拖进 V1 的音频也归到 A2。
  if (lane === "audio" || kind === "audio") {
    const start = Math.max(0, Math.round(ticks));
    return { lane: "audio", at: start, startTicks: start, durationTicks: duration };
  }
  const index = resolveDropIndex(clips, ticks);
  const startTicks = clips.slice(0, index).reduce((sum, clip) => sum + clipDuration(clip), 0);
  return { lane: "video", at: index, startTicks, durationTicks: duration };
}

/** 默认文字：3 秒、中下位置、48px 白字带底衬 —— 字幕最常见的形态。 */
export const DEFAULT_TITLE_DURATION_TICKS = TICKS_PER_SECOND * 3;
export const DEFAULT_TITLE_FONT_SIZE = 48;

export function createTitle(startTicks: number): TitleClip {
  return {
    id: nextId("title"),
    text: "双击这里编辑文字",
    startTicks: Math.max(0, startTicks),
    durationTicks: DEFAULT_TITLE_DURATION_TICKS,
    fontSize: DEFAULT_TITLE_FONT_SIZE,
    color: "#FFFFFF",
    position: "bottom-center",
    backdrop: true,
  };
}

/** 在播放头处加一段文字，并选中它（加完就能直接改属性）。 */
export function addTitle(state: AdvancedEditorState, atTicks: number): AdvancedEditorState {
  const title = createTitle(atTicks);
  return {
    ...state,
    titles: [...state.titles, title].sort((left, right) => left.startTicks - right.startTicks),
    selectedId: title.id,
  };
}

export function updateTitle(
  state: AdvancedEditorState,
  id: string,
  patch: Partial<Omit<TitleClip, "id">>,
): AdvancedEditorState {
  return {
    ...state,
    titles: state.titles.map((title) => (title.id === id ? { ...title, ...patch } : title)),
  };
}

export function removeTitle(state: AdvancedEditorState, id: string): AdvancedEditorState {
  return {
    ...state,
    titles: state.titles.filter((title) => title.id !== id),
    selectedId: state.selectedId === id ? null : state.selectedId,
  };
}

/** 拖文字块改起点。 */
export function moveTitle(state: AdvancedEditorState, id: string, startTicks: number): AdvancedEditorState {
  return updateTitle(state, id, { startTicks: Math.max(0, Math.round(startTicks)) });
}

/**
 * Q 键：裁掉选中片段里播放线**左边**的部分 —— 入点提到播放线对应的源内位置。
 *
 * 播放线必须在选中片段内；裁完仍要留出最短片段，太短就什么都不做（比静默裁坏好）。
 */
export function trimClipInToPlayhead(
  state: AdvancedEditorState,
  id: string,
  playheadTicks: number,
): AdvancedEditorState {
  const hit = findClipAt(state.clips, playheadTicks);
  if (!hit || hit.clip.id !== id) return state;
  const sourceTicks = hit.clip.inTicks + (playheadTicks - hit.start);
  const minTicks = minClipTicks(state.frameRate);
  if (sourceTicks - hit.clip.inTicks < minTicks) return state;
  return {
    ...state,
    clips: state.clips.map((clip) => (clip.id === id ? { ...clip, inTicks: sourceTicks } : clip)),
    // 播放线回到片段开头：预览停在新入点的第一帧，别让画面跳到别处。
    playheadTicks: hit.start,
  };
}

/** W 键：裁掉选中片段里播放线**右边**的部分 —— 出点退到播放线对应的源内位置。 */
export function trimClipOutToPlayhead(
  state: AdvancedEditorState,
  id: string,
  playheadTicks: number,
): AdvancedEditorState {
  const hit = findClipAt(state.clips, playheadTicks);
  if (!hit || hit.clip.id !== id) return state;
  const sourceTicks = hit.clip.inTicks + (playheadTicks - hit.start);
  const minTicks = minClipTicks(state.frameRate);
  if (hit.clip.outTicks - sourceTicks < minTicks) return state;
  return {
    ...state,
    clips: state.clips.map((clip) => (clip.id === id ? { ...clip, outTicks: sourceTicks } : clip)),
    // 播放线停到片段末尾：预览停在新的出点帧。
    playheadTicks: hit.start + (sourceTicks - hit.clip.inTicks),
  };
}

/**
 * 改片段变换。
 *
 * 所有值在这里统一收敛（clamp + 处理 NaN），UI 层就不用每处都判一遍 ——
 * 滑块拖到边界、输入框清空、手柄拖飞都只会得到合法值。
 */
export function updateClipTransform(
  state: AdvancedEditorState,
  id: string,
  patch: Partial<ClipTransform>,
): AdvancedEditorState {
  const clip = state.clips.find((item) => item.id === id);
  if (!clip) return state;
  const current = resolveClipTransform(clip);
  const next: ClipTransform = {
    scale: clampNumber(patch.scale ?? current.scale, ...TRANSFORM_LIMITS.scale),
    scaleX: clampNumber(patch.scaleX ?? current.scaleX, ...TRANSFORM_LIMITS.scale),
    scaleY: clampNumber(patch.scaleY ?? current.scaleY, ...TRANSFORM_LIMITS.scale),
    x: clampNumber(patch.x ?? current.x, ...TRANSFORM_LIMITS.offset),
    y: clampNumber(patch.y ?? current.y, ...TRANSFORM_LIMITS.offset),
    rotation: clampNumber(patch.rotation ?? current.rotation, ...TRANSFORM_LIMITS.rotation),
    opacity: clampNumber(patch.opacity ?? current.opacity, ...TRANSFORM_LIMITS.opacity),
    borderRadius: clampNumber(patch.borderRadius ?? current.borderRadius, ...TRANSFORM_LIMITS.radius),
  };
  return {
    ...state,
    clips: state.clips.map((item) => (item.id === id ? { ...item, transform: next } : item)),
  };
}

/**
 * 等比缩放：两轴一起改，并把 `scale` 同步成同一个值。
 *
 * 只改 `scale` 而不动 `scaleX/scaleY` 是不够的 —— 一旦用户单独拖过竖向手柄，
 * 轴向值就有了自己的值并覆盖等比（见 `resolveScaleAxes`），此后拖等比手柄会"没反应"。
 */
export function setClipUniformScale(
  state: AdvancedEditorState,
  id: string,
  scale: number,
): AdvancedEditorState {
  const value = clampNumber(scale, ...TRANSFORM_LIMITS.scale);
  return updateClipTransform(state, id, { scale: value, scaleX: value, scaleY: value });
}

/** 打 / 改一个关键帧（同一时刻只保留一个）。 */
export function setClipKeyframe(
  state: AdvancedEditorState,
  id: string,
  prop: AnimatableProp,
  localTicks: number,
  value: number,
  easing: KeyframeEasing = "linear",
  toleranceTicks = 0,
): AdvancedEditorState {
  const clip = state.clips.find((item) => item.id === id);
  if (!clip) return state;
  const ticks = Math.max(0, Math.round(localTicks));
  const list = [...(clip.keyframes?.[prop] ?? [])];
  const existing = list.findIndex((frame) => Math.abs(frame.ticks - ticks) <= toleranceTicks);
  const frame: ClipKeyframe = { ticks, value, easing: existing >= 0 ? list[existing].easing : easing };
  if (existing >= 0) list[existing] = frame;
  else list.push(frame);
  list.sort((left, right) => left.ticks - right.ticks);
  return patchClipKeyframes(state, id, { ...clip.keyframes, [prop]: list });
}

/** 删掉某一时刻的关键帧。删空了就把这条属性整个移除（不留空数组）。 */
export function removeClipKeyframe(
  state: AdvancedEditorState,
  id: string,
  prop: AnimatableProp,
  localTicks: number,
  toleranceTicks = 0,
): AdvancedEditorState {
  const clip = state.clips.find((item) => item.id === id);
  if (!clip?.keyframes?.[prop]) return state;
  const list = (clip.keyframes[prop] ?? []).filter(
    (frame) => Math.abs(frame.ticks - Math.round(localTicks)) > toleranceTicks,
  );
  const next: ClipKeyframes = { ...clip.keyframes };
  if (list.length) next[prop] = list;
  else delete next[prop];
  return patchClipKeyframes(state, id, next);
}

/**
 * 一键切换：这一刻没有就按当前值打一帧，有就删掉。
 *
 * 值取的是**当前实际显示的值**（有关键帧时是曲线上的值），否则第一次打帧会跳变。
 */
export function toggleClipKeyframe(
  state: AdvancedEditorState,
  id: string,
  prop: AnimatableProp,
  localTicks: number,
  currentValue: number,
  toleranceTicks = 0,
): AdvancedEditorState {
  const clip = state.clips.find((item) => item.id === id);
  if (!clip) return state;
  const existing = findKeyframe(clip, prop, localTicks, toleranceTicks);
  return existing
    ? removeClipKeyframe(state, id, prop, localTicks, toleranceTicks)
    : setClipKeyframe(state, id, prop, localTicks, currentValue, "linear", toleranceTicks);
}

/** 改某一段（从这一帧到下一帧）的缓动。 */
export function setClipKeyframeEasing(
  state: AdvancedEditorState,
  id: string,
  prop: AnimatableProp,
  localTicks: number,
  easing: KeyframeEasing,
  toleranceTicks = 0,
): AdvancedEditorState {
  const clip = state.clips.find((item) => item.id === id);
  const list = clip?.keyframes?.[prop];
  if (!clip || !list) return state;
  const next = list.map((frame) =>
    Math.abs(frame.ticks - Math.round(localTicks)) <= toleranceTicks ? { ...frame, easing } : frame,
  );
  return patchClipKeyframes(state, id, { ...clip.keyframes, [prop]: next });
}

/** 拖动关键帧改时刻（拖动时就是删旧的、补新的，顺带保持排序）。 */
export function moveClipKeyframe(
  state: AdvancedEditorState,
  id: string,
  prop: AnimatableProp,
  fromTicks: number,
  toTicks: number,
): AdvancedEditorState {
  const clip = state.clips.find((item) => item.id === id);
  const list = clip?.keyframes?.[prop];
  if (!clip || !list) return state;
  const frame = list.find((item) => item.ticks === Math.round(fromTicks));
  if (!frame) return state;
  const ticks = Math.max(0, Math.round(toTicks));
  if (ticks === frame.ticks) return state;
  // 目标时刻已有别的帧 → 直接覆盖，避免同一时刻两帧导致曲线歧义。
  const next = list
    .filter((item) => item.ticks !== frame.ticks && item.ticks !== ticks)
    .concat({ ...frame, ticks })
    .sort((left, right) => left.ticks - right.ticks);
  return patchClipKeyframes(state, id, { ...clip.keyframes, [prop]: next });
}

function patchClipKeyframes(
  state: AdvancedEditorState,
  id: string,
  keyframes: ClipKeyframes,
): AdvancedEditorState {
  const isEmpty = Object.keys(keyframes).length === 0;
  return {
    ...state,
    clips: state.clips.map((clip) =>
      clip.id === id ? { ...clip, keyframes: isEmpty ? undefined : keyframes } : clip,
    ),
  };
}

/** 清掉变换，回到「原样铺满画布」。 */
export function resetClipTransform(state: AdvancedEditorState, id: string): AdvancedEditorState {
  return {
    ...state,
    clips: state.clips.map((clip) =>
      clip.id === id ? { ...clip, transform: { ...DEFAULT_CLIP_TRANSFORM } } : clip,
    ),
  };
}

/** 拖文字块左右边缘改时长；左手柄同时移动起点，保持右边缘不动。 */
export function trimTitleEdge(
  state: AdvancedEditorState,
  id: string,
  edge: "start" | "end",
  ticks: number,
  rate: FrameRate | null | undefined,
): AdvancedEditorState {
  const title = state.titles.find((item) => item.id === id);
  if (!title) return state;
  const minTicks = minClipTicks(rate);
  if (edge === "end") {
    const end = Math.max(title.startTicks + minTicks, Math.round(ticks));
    return updateTitle(state, id, { durationTicks: end - title.startTicks });
  }
  const end = title.startTicks + title.durationTicks;
  const start = Math.min(Math.max(0, Math.round(ticks)), end - minTicks);
  return updateTitle(state, id, { startTicks: start, durationTicks: end - start });
}

/** 播放头落在哪段文字上（用于预览显示）。 */
export function findTitleAt(titles: readonly TitleClip[], ticks: number): TitleClip | null {
  return (
    titles.find((title) => ticks >= title.startTicks && ticks < title.startTicks + title.durationTicks) ?? null
  );
}

export function setMusic(
  state: AdvancedEditorState,
  source: { sourcePath: string; sourceName: string; durationTicks: number } | null,
  atTicks = 0,
): AdvancedEditorState {
  if (!source) return { ...state, music: null, selectedId: state.selectedId === state.music?.id ? null : state.selectedId };
  const music: MusicClip = {
    id: nextId("music"),
    sourcePath: source.sourcePath,
    sourceName: source.sourceName,
    inTicks: 0,
    outTicks: source.durationTicks,
    startTicks: Math.max(0, atTicks),
  };
  return { ...state, music, selectedId: music.id };
}

export function moveMusic(state: AdvancedEditorState, startTicks: number): AdvancedEditorState {
  if (!state.music) return state;
  return { ...state, music: { ...state.music, startTicks: Math.max(0, startTicks) } };
}

export function setZoom(state: AdvancedEditorState, pixelsPerSecond: number): AdvancedEditorState {
  const clamped = Math.max(ZOOM_MIN_PX_PER_SEC, Math.min(ZOOM_MAX_PX_PER_SEC, pixelsPerSecond));
  return { ...state, pixelsPerSecond: clamped };
}

export function ticksToPx(ticks: number, pixelsPerSecond: number): number {
  return (ticks / TICKS_PER_SECOND) * pixelsPerSecond;
}

export function pxToTicks(px: number, pixelsPerSecond: number): number {
  return Math.round((px / Math.max(1, pixelsPerSecond)) * TICKS_PER_SECOND);
}

export type AdvancedValidationError = "noClip" | "missingSource" | "clipTooShort";

export function validateAdvancedState(
  state: AdvancedEditorState,
  nodeSourcePath: string | null | undefined,
): AdvancedValidationError | null {
  // 时间线为空时允许导出，但要有东西可导：优先时间线，其次节点自身素材。
  if (state.clips.length === 0 && !nodeSourcePath?.trim()) return "missingSource";
  if (state.clips.length === 0) return "noClip";
  const minTicks = minClipTicks(state.frameRate);
  for (const clip of state.clips) {
    if (!clip.sourcePath.trim()) return "missingSource";
    if (clipDuration(clip) < minTicks) return "clipTooShort";
  }
  return null;
}

/** 转成后端请求。所有时间换算成秒，保留 6 位小数（1 tick ≈ 0.0000083 秒）。 */
export function buildAdvancedRequest(
  state: AdvancedEditorState,
  /** 可选：按路径给出**真实时长（tick）**，用来把超出的出点收回来。 */
  knownDurationTicks?: (path: string) => number | null,
): AdvancedVideoEditRequest {
  const toSeconds = (ticks: number) => Math.round((ticks / TICKS_PER_SECOND) * 1_000_000) / 1_000_000;
  const clips = state.clips.map((clip) => {
    // 探测到的真实时长可能小于前端估算值，先收口，避免后端因「超出时长」整单失败。
    const known = knownDurationTicks?.(clip.sourcePath) ?? null;
    const outTicks = known && known > 0 ? Math.min(clip.outTicks, known) : clip.outTicks;
    const transform = resolveClipTransform(clip);
    // 只发非默认字段：全默认等于没变换，后端据此走原来的 concat 路径（更快也更稳）。
    const patch: Record<string, number> = {};
    if (Math.abs(transform.scale - 1) > 1e-6) patch.scale = transform.scale;
    if (Math.abs(transform.scaleX - 1) > 1e-6) patch.scaleX = transform.scaleX;
    if (Math.abs(transform.scaleY - 1) > 1e-6) patch.scaleY = transform.scaleY;
    if (Math.abs(transform.x) > 1e-6) patch.x = transform.x;
    if (Math.abs(transform.y) > 1e-6) patch.y = transform.y;
    if (Math.abs(transform.rotation) > 1e-6) patch.rotation = transform.rotation;
    if (Math.abs(transform.opacity - 1) > 1e-6) patch.opacity = transform.opacity;
    if (transform.borderRadius > 1e-6) patch.borderRadius = transform.borderRadius;
    // 关键帧：tick → 相对片段起点的秒。只发改过的属性，空的整条不发。
    const keyframes: Record<string, { t: number; v: number; e: ClipKeyframe["easing"] }[]> = {};
    for (const prop of ANIMATABLE_PROPS) {
      const list = clip.keyframes?.[prop];
      if (!list?.length) continue;
      keyframes[prop] = list.map((frame) => ({
        t: toSeconds(frame.ticks),
        v: frame.value,
        e: frame.easing,
      }));
    }

    return {
      sourcePath: clip.sourcePath,
      start: toSeconds(clip.inTicks),
      end: toSeconds(outTicks),
      ...(Object.keys(patch).length ? { transform: patch } : {}),
      ...(Object.keys(keyframes).length ? { keyframes } : {}),
    };
  });

  const music = state.music
    ? {
        sourcePath: state.music.sourcePath,
        start: toSeconds(state.music.startTicks),
        volume: state.musicVolume,
        fadeIn: state.musicFadeIn,
        fadeOut: state.musicFadeOut,
      }
    : undefined;

  // 文字：空文本不提交（drawtext 收到空串会直接报错），时长过短的也丢掉。
  const titles = state.titles
    .filter((title) => title.text.trim() && title.durationTicks > 0)
    .map((title) => ({
      text: title.text,
      start: toSeconds(title.startTicks),
      end: toSeconds(title.startTicks + title.durationTicks),
      fontSize: title.fontSize,
      color: title.color,
      position: title.position,
      backdrop: title.backdrop,
    }));

  return {
    clips,
    audioMode: state.muted ? "mute" : "keep",
    audioVolume: state.originalVolume,
    ...(music ? { music } : {}),
    ...(titles.length ? { titles } : {}),
  };
}

/** 成片时长（秒）。 */
export function resolveOutputDuration(state: AdvancedEditorState): number {
  return Math.round((sequenceTicks(state.clips) / TICKS_PER_SECOND) * 1000) / 1000;
}
