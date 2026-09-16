import {
  CANVAS_NODE_TYPES,
  EXPORT_RESULT_NODE_MIN_HEIGHT,
  EXPORT_RESULT_NODE_MIN_WIDTH,
  type CanvasNodeType,
} from '@/features/canvas/domain/canvasNodes';

/**
 * 媒体节点(图片/视频)的等比缩放约束。
 *
 * 图片/视频节点拖拽边框时应当保持媒体自身的宽高比: 否则画面会被拉伸变形,
 * 或在节点内留下黑边。这里提供与框架无关的纯函数 —— 依据"拖拽前的尺寸(已等比)"
 * 与"React Flow 按指针位置算出的候选尺寸", 推导出仍保持目标比例、且落在边界内的尺寸。
 */

export interface AspectLockedSize {
  width: number;
  height: number;
}

export interface AspectLockedResizeBounds {
  minWidth: number;
  minHeight: number;
  maxWidth: number;
  maxHeight: number;
}

export interface ResolveAspectLockedResizeInput {
  /** 拖拽前的节点尺寸; 正常情况下已处于目标比例 */
  previous: AspectLockedSize;
  /** 按指针位置算出的候选尺寸, 通常是任意比例的自由拉伸结果 */
  next: AspectLockedSize;
  /** 目标宽高比 = width / height */
  ratio: number;
  bounds: AspectLockedResizeBounds;
}

export interface MediaAspectLock {
  ratio: number;
  bounds: AspectLockedResizeBounds;
}

/** AI 图片节点 / 图片结果节点的缩放边界。 */
export const IMAGE_MEDIA_RESIZE_BOUNDS: AspectLockedResizeBounds = {
  minWidth: EXPORT_RESULT_NODE_MIN_WIDTH,
  minHeight: EXPORT_RESULT_NODE_MIN_HEIGHT,
  maxWidth: 1600,
  maxHeight: 1600,
};

/** 上传节点的缩放边界(上限较图片节点保守)。 */
export const UPLOAD_MEDIA_RESIZE_BOUNDS: AspectLockedResizeBounds = {
  minWidth: EXPORT_RESULT_NODE_MIN_WIDTH,
  minHeight: EXPORT_RESULT_NODE_MIN_HEIGHT,
  maxWidth: 1400,
  maxHeight: 1400,
};

/**
 * 视频结果节点的缩放边界。
 * 上限相对旧值(520x400)放宽: 锁定比例后能拖出的尺寸被比例约束, 竖屏视频
 * (如 9:16)在旧上限下只剩几十像素的可调范围, 几乎无法放大。
 */
export const VIDEO_MEDIA_RESIZE_BOUNDS: AspectLockedResizeBounds = {
  minWidth: 180,
  minHeight: 150,
  maxWidth: 1400,
  maxHeight: 1400,
};

/** 纯音频节点(不显示画面)的缩放边界, 保持原有取值。 */
export const AUDIO_ONLY_RESIZE_BOUNDS: AspectLockedResizeBounds = {
  minWidth: 180,
  minHeight: 150,
  maxWidth: 520,
  maxHeight: 400,
};

function isUsablePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function normalizePositive(value: number, fallback: number): number {
  return isUsablePositive(value) ? value : fallback;
}

function roundEdge(value: number, fallback = 1): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.round(value));
}

/** 严格解析 `宽:高` 文本; 解析不出来时返回 null, 调用方应放弃比例锁定。 */
export function parseAspectRatioText(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }

  const match = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(value);
  if (!match) {
    return null;
  }

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!isUsablePositive(width) || !isUsablePositive(height)) {
    return null;
  }

  return width / height;
}

/** 这些节点在拖拽缩放时需要按媒体比例锁定。 */
export function isAspectLockedMediaNodeType(type: CanvasNodeType): boolean {
  return type === CANVAS_NODE_TYPES.upload
    || type === CANVAS_NODE_TYPES.imageEdit
    || type === CANVAS_NODE_TYPES.exportImage
    || type === CANVAS_NODE_TYPES.audio;
}

/**
 * 解析节点自身的比例锁定配置。
 * 返回 null 表示不锁定 —— 未支持的节点类型、缺少 `aspectRatio`、
 * 或纯音频节点(没有画面比例可言)。
 */
export function resolveMediaNodeAspectLock(
  type: CanvasNodeType,
  data: Record<string, unknown> | undefined
): MediaAspectLock | null {
  if (!isAspectLockedMediaNodeType(type)) {
    return null;
  }

  const record = data ?? {};
  const ratio = parseAspectRatioText(record.aspectRatio);
  if (ratio === null) {
    return null;
  }

  if (type === CANVAS_NODE_TYPES.audio) {
    // 音频节点只有视频形态有画面比例; aspectRatio 由 AudioNode 在视频元数据
    // 就绪时写回真实宽高比。
    return record.mediaType === 'video'
      ? { ratio, bounds: VIDEO_MEDIA_RESIZE_BOUNDS }
      : null;
  }

  return {
    ratio,
    bounds: type === CANVAS_NODE_TYPES.upload
      ? UPLOAD_MEDIA_RESIZE_BOUNDS
      : IMAGE_MEDIA_RESIZE_BOUNDS,
  };
}

/** 供 `NodeResizeHandle` 使用的边界取值, 与 store 侧的等比修正保持同源。 */
export function resolveMediaNodeResizeBounds(
  type: CanvasNodeType,
  data?: Record<string, unknown>
): AspectLockedResizeBounds {
  const lock = resolveMediaNodeAspectLock(type, data);
  if (lock) {
    return lock.bounds;
  }

  return type === CANVAS_NODE_TYPES.audio
    ? AUDIO_ONLY_RESIZE_BOUNDS
    : IMAGE_MEDIA_RESIZE_BOUNDS;
}

/** 把尺寸等比收进边界: 先满足两个最小边, 再满足两个最大边。 */
function fitInsideBounds(
  size: AspectLockedSize,
  bounds: AspectLockedResizeBounds
): AspectLockedSize {
  const minWidth = roundEdge(bounds.minWidth);
  const minHeight = roundEdge(bounds.minHeight);
  const maxWidth = Math.max(minWidth, roundEdge(bounds.maxWidth, minWidth));
  const maxHeight = Math.max(minHeight, roundEdge(bounds.maxHeight, minHeight));

  let { width, height } = size;

  if (width < minWidth || height < minHeight) {
    const scale = Math.max(minWidth / width, minHeight / height);
    width *= scale;
    height *= scale;
  }

  if (width > maxWidth || height > maxHeight) {
    const scale = Math.min(maxWidth / width, maxHeight / height);
    width *= scale;
    height *= scale;
  }

  return { width, height };
}

/**
 * 把自由拉伸的候选尺寸修正成保持目标比例、且不越界的尺寸。
 *
 * 主导轴取"相对变化幅度更大"的那一边: 宽高像素量级不同, 用绝对差值会让
 * 数值大的一边永远占优, 表现为只能横向拖动。取主导轴后另一边等比推导,
 * 节点边框因此始终贴合媒体比例。
 */
export function resolveAspectLockedResize({
  previous,
  next,
  ratio,
  bounds,
}: ResolveAspectLockedResizeInput): AspectLockedSize {
  const fallback: AspectLockedSize = {
    width: roundEdge(next.width),
    height: roundEdge(next.height),
  };

  if (!isUsablePositive(ratio)) {
    return fallback;
  }

  const previousWidth = normalizePositive(previous.width, fallback.width);
  const previousHeight = normalizePositive(previous.height, fallback.height);
  const nextWidth = normalizePositive(next.width, previousWidth);
  const nextHeight = normalizePositive(next.height, previousHeight);

  const widthDelta = Math.abs(nextWidth - previousWidth) / previousWidth;
  const heightDelta = Math.abs(nextHeight - previousHeight) / previousHeight;
  const widthDominates = widthDelta >= heightDelta;

  const fitted = fitInsideBounds(
    widthDominates
      ? { width: nextWidth, height: nextWidth / ratio }
      : { width: nextHeight * ratio, height: nextHeight },
    bounds
  );

  return {
    width: roundEdge(fitted.width),
    height: roundEdge(fitted.height),
  };
}
