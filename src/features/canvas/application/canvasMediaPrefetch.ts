/**
 * 画布媒体预热：**视口优先 + 后台分批**。
 *
 * 要解决的问题：打开项目时，视口内几十个节点会在同一帧里同时去读盘解码媒体，
 * 于是首屏卡住；拖动画布到别处，同样的过程再来一遍（React Flow 的
 * `onlyRenderVisibleElements` 会把视口外节点卸载，平移回来就是重新挂载 + 重新解码）。
 *
 * 分三层分摊压力：
 * 1. **视口内的立刻提交** —— 用户马上要看的东西优先，这批只受 `thumbnailCache` 的并发闸门约束；
 * 2. **视口外的进后台队列分批提交** —— 每 `PREFETCH_BATCH_INTERVAL_MS` 放
 *    `PREFETCH_BATCH_SIZE` 张进去，把一次性的尖峰摊成一条平缓的流；
 * 3. **已经在落盘缓存里的直接跳过** —— Rust 侧缩略图是持久化的，第二次打开项目时
 *    这些源全部命中，等于「加载过一次，之后再也不用加载」。
 *
 * 预热只做 **512**（画布主体图那一档）。节点上的 36px 小方块走 256，与素材选择器
 * 共用同一份缓存，多数在用户挑选素材时就已生成。
 */

import { pickCanvasImageSource } from '@/features/canvas/application/canvasImageSource';
import {
  CANVAS_THUMBNAIL_MAX_EDGE,
  readThumbnail,
  requestThumbnail,
} from '@/features/canvas/application/thumbnailCache';

/** 视口停下后多久才真正算一遍（拖动期间只重置定时器，不做任何计算）。 */
export const MEDIA_PREFETCH_DEBOUNCE_MS = 300;
/** 后台队列每批提交多少张。 */
export const PREFETCH_BATCH_SIZE = 4;
/** 批与批之间的间隔：把尖峰摊平，给渲染和交互留出空隙。 */
export const PREFETCH_BATCH_INTERVAL_MS = 140;
/**
 * 视口外扩范围（画布坐标单位）。
 * 只备「拖一下就能看到」的一圈，不是把整个项目都预热了 —— 那样又把压力堆回一次性的。
 */
export const PREFETCH_VISIBLE_MARGIN = 600;

/** 只取结构里真正用到的字段，避免和画布节点类型耦合。 */
export interface PrefetchNodeLike {
  position?: { x: number; y: number } | null;
  width?: number | null;
  height?: number | null;
  measured?: { width?: number | null; height?: number | null } | null;
  data?: Record<string, unknown> | null;
}

export interface PrefetchViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface PrefetchCandidate {
  source: string;
  visible: boolean;
}

/** 节点默认尺寸：`measured` 还没回填时用的兜底，只影响可见性判定，不影响正确性。 */
const FALLBACK_NODE_WIDTH = 260;
const FALLBACK_NODE_HEIGHT = 220;

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 收集一个节点里**需要 512 缩略图**的媒体源。
 *
 * 判定刻意复用 `pickCanvasImageSource`（zoom 传 1，即"小图档"）——
 * 否则就会出现「预热算一套、显示算另一套」的分叉，正是最难查的那类 bug。
 * 只收 `kind === 'thumbnail'` 的：有 preview 的用 preview、远端源走原图，都不需要预热。
 */
export function collectNodePrefetchSources(node: PrefetchNodeLike | null | undefined): string[] {
  const data = node?.data;
  if (!data || typeof data !== 'object') {
    return [];
  }

  const out: string[] = [];
  const push = (imageUrl: string, previewImageUrl: string) => {
    const pick = pickCanvasImageSource({ zoom: 1, imageUrl, previewImageUrl });
    if (pick.kind === 'thumbnail' && pick.thumbnailSource) {
      out.push(pick.thumbnailSource);
    }
  };

  push(asString(data.imageUrl), asString(data.previewImageUrl));
  push(asString(data.outputImageUrl), asString(data.outputPreviewImageUrl));
  push(asString(data.firstFrameImageUrl), asString(data.firstFramePreviewImageUrl));
  push(asString(data.lastFrameImageUrl), asString(data.lastFramePreviewImageUrl));

  // 分镜展示节点的每一格都走主体图路径。
  const frames = data.frames;
  if (Array.isArray(frames)) {
    for (const frame of frames) {
      if (!frame || typeof frame !== 'object') continue;
      const record = frame as Record<string, unknown>;
      push(asString(record.imageUrl), asString(record.previewImageUrl));
    }
  }

  return out;
}

/** 节点在画布坐标系里的包围盒。 */
export function nodeBounds(node: PrefetchNodeLike) {
  const width = node.measured?.width ?? node.width ?? FALLBACK_NODE_WIDTH;
  const height = node.measured?.height ?? node.height ?? FALLBACK_NODE_HEIGHT;
  const x = node.position?.x ?? 0;
  const y = node.position?.y ?? 0;
  return { left: x, top: y, right: x + width, bottom: y + height };
}

/**
 * 纯函数：按视口把节点的媒体源分成「看得到」和「看不到」两组。
 *
 * 传 `containerWidth/Height` 为 0（还没测到尺寸）时，一律按不可见处理 ——
 * 这样最坏情况只是全部走后台队列分批预热，仍然不会卡。
 */
export function collectPrefetchCandidates(
  nodes: readonly PrefetchNodeLike[],
  viewport: PrefetchViewport,
  containerWidth: number,
  containerHeight: number,
): PrefetchCandidate[] {
  const zoom = Math.max(0.01, viewport.zoom || 1);
  const left = -viewport.x / zoom - PREFETCH_VISIBLE_MARGIN;
  const top = -viewport.y / zoom - PREFETCH_VISIBLE_MARGIN;
  const right = -viewport.x / zoom + containerWidth / zoom + PREFETCH_VISIBLE_MARGIN;
  const bottom = -viewport.y / zoom + containerHeight / zoom + PREFETCH_VISIBLE_MARGIN;

  const seen = new Set<string>();
  const candidates: PrefetchCandidate[] = [];

  for (const node of nodes) {
    const bounds = nodeBounds(node);
    const visible =
      containerWidth > 0 &&
      containerHeight > 0 &&
      bounds.left <= right &&
      bounds.right >= left &&
      bounds.top <= bottom &&
      bounds.bottom >= top;

    for (const source of collectNodePrefetchSources(node)) {
      if (seen.has(source)) continue;
      seen.add(source);
      candidates.push({ source, visible });
    }
  }

  return candidates;
}

export interface MediaPrefetchScheduler {
  submit(candidates: readonly PrefetchCandidate[]): void;
  dispose(): void;
}

/**
 * 分批调度器。
 *
 * 可见的立刻提交（它们本来就只受并发闸门约束，先提交先排队，天然优先）；
 * 其余进后台队列，按固定节奏一批批放。已在内存缓存里的直接跳过。
 */
export function createMediaPrefetchScheduler(
  maxEdge: number = CANVAS_THUMBNAIL_MAX_EDGE,
): MediaPrefetchScheduler {
  /** 本次会话已经处理过的源（含跳过与已排队），避免重复提交。 */
  const handled = new Set<string>();
  const background: string[] = [];
  let timer: number | null = null;
  let disposed = false;

  const drainOneBatch = () => {
    timer = null;
    if (disposed) return;
    for (let index = 0; index < PREFETCH_BATCH_SIZE && background.length > 0; index += 1) {
      const source = background.shift();
      if (source) void requestThumbnail(source, maxEdge);
    }
    scheduleTick();
  };

  const scheduleTick = () => {
    if (disposed || timer !== null || background.length === 0) return;
    timer = window.setTimeout(drainOneBatch, PREFETCH_BATCH_INTERVAL_MS);
  };

  return {
    submit(candidates) {
      if (disposed || candidates.length === 0) return;

      const visible: string[] = [];
      const hidden: string[] = [];

      for (const candidate of candidates) {
        const source = candidate.source;
        if (!source || handled.has(source)) continue;
        handled.add(source);
        // 落盘缓存命中（第二次打开项目就是这种情况）：显示时会同步拿到小图，不必排队。
        if (readThumbnail(source, maxEdge)) continue;
        if (candidate.visible) visible.push(source);
        else hidden.push(source);
      }

      for (const source of visible) {
        void requestThumbnail(source, maxEdge);
      }

      if (hidden.length > 0) {
        background.push(...hidden);
        scheduleTick();
      }
    },
    dispose() {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      background.length = 0;
    },
  };
}

let scheduler: MediaPrefetchScheduler | null = null;

function activeScheduler(): MediaPrefetchScheduler {
  if (!scheduler) {
    scheduler = createMediaPrefetchScheduler();
  }
  return scheduler;
}

export interface PrefetchCanvasMediaParams {
  nodes: readonly PrefetchNodeLike[];
  viewport: PrefetchViewport;
  containerWidth: number;
  containerHeight: number;
}

/**
 * 打开项目 / 拖动画布停下 / 生成出新图之后调一次。
 * 调用方负责防抖（Canvas 侧用定时器，拖动期间只重置，不做计算）。
 */
export function prefetchCanvasMedia({
  nodes,
  viewport,
  containerWidth,
  containerHeight,
}: PrefetchCanvasMediaParams): void {
  if (nodes.length === 0) return;
  activeScheduler().submit(
    collectPrefetchCandidates(nodes, viewport, containerWidth, containerHeight),
  );
}

/** 测试与排查用：丢弃调度状态。 */
export function resetMediaPrefetchScheduler(): void {
  scheduler?.dispose();
  scheduler = null;
}
