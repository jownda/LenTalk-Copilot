/**
 * 画布媒体展示地址 hook。
 *
 * 两个入口，覆盖画布上所有「显示媒体」的场景：
 * - `useCanvasImageSource`：给节点的**主体图片**用（图节点 / 上传节点 / 分镜格），
 *   按 zoom 在原图、preview、512 缩略图之间选。
 * - `useThumbnailFallback`：给节点上的**微型方块**用（素材条、首尾帧、上游图条，常见 36~48px），
 *   直接拿指定尺寸的缩略图；默认复用素材选择器已生成的 256，磁盘多半已经命中。
 *
 * 共同的三条行为：
 * 1. **同步命中优先**：`readThumbnail` 是纯内存查表，第二次打开项目时第一帧就是小图，
 *    不会再走 IPC、更不会解码原图 —— 这就是「后台加载一次，之后不用再加载」的实现。
 * 2. **未就绪显示骨架，而不是原图**：把原图递出去等于照样解码一遍（一张 12MP 照片几十 MB），
 *    优化就白做了。36px 的方块去解码 12MP 原图尤其离谱。
 * 3. **有超时兜底**：生成太慢或失败（文件被删 / 格式不支持）时回落原图，绝不让节点一直空着。
 */

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@xyflow/react';

import {
  CANVAS_THUMBNAIL_MAX_EDGE,
  THUMBNAIL_MAX_EDGE,
  canGenerateThumbnail,
  readThumbnail,
  requestThumbnail,
  resolveFallbackSource,
} from '@/features/canvas/application/thumbnailCache';
import {
  pickCanvasImageSource,
  type CanvasImageKind,
  type CanvasImagePick,
} from '@/features/canvas/application/canvasImageSource';
import { shouldUseOriginalImageByZoom } from '@/features/canvas/application/imageData';

/**
 * 缩略图迟迟不返回时的兜底时长。
 *
 * 典型耗时：命中磁盘只有一次 stat（毫秒级）；首次生成要解码原图 + 缩放 + 写盘
 * （几十到一两百毫秒）。超过一秒还没好，多半是文件被删或格式不支持，先给原图比一直空着强。
 */
const THUMBNAIL_FALLBACK_TIMEOUT_MS = 1200;

export interface CanvasImageSourceState {
  /** 当前该给 `<img>` 的地址；`null` 表示应当显示占位骨架。 */
  url: string | null;
  /** `true` 表示还在等缩略图，调用方应显示骨架而不是空图。 */
  isPlaceholder: boolean;
  kind: CanvasImageKind;
}

const EMPTY: CanvasImageSourceState = { url: null, isPlaceholder: false, kind: 'none' };

/** 共用内核：查缓存 → 命中就同步用 → 否则请求，期间置占位，超时放弃。 */
function useThumbnailResolution(
  source: string | null,
  maxEdge: number,
): { url: string | null; giveUp: boolean } {
  const [resolved, setResolved] = useState<string | null>(() =>
    source ? readThumbnail(source, maxEdge) ?? null : null,
  );
  const [giveUp, setGiveUp] = useState(false);

  useEffect(() => {
    if (!source) {
      setResolved(null);
      setGiveUp(false);
      return;
    }

    const cached = readThumbnail(source, maxEdge);
    if (cached) {
      setResolved(cached);
      setGiveUp(false);
      return;
    }

    let cancelled = false;
    setResolved(null);
    setGiveUp(false);

    const timer = window.setTimeout(() => {
      if (!cancelled) setGiveUp(true);
    }, THUMBNAIL_FALLBACK_TIMEOUT_MS);

    void requestThumbnail(source, maxEdge)
      .then((url) => {
        if (cancelled) return;
        window.clearTimeout(timer);
        if (url) setResolved(url);
        else setGiveUp(true);
      })
      .catch(() => {
        if (cancelled) return;
        window.clearTimeout(timer);
        setGiveUp(true);
      });

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [maxEdge, source]);

  return { url: resolved, giveUp };
}

/**
 * 把 `pick` 落成最终的展示状态（缩略图未就绪时给骨架 / 超时回落原图）。
 * 抽出来是为了让「订阅 zoom 数值」与「订阅阈值布尔」两个入口共用同一套尾段逻辑。
 */
function useResolvedCanvasImage(pick: CanvasImagePick): CanvasImageSourceState {
  const thumbnailSource = pick.thumbnailSource;
  const { url: thumbnailUrl, giveUp } = useThumbnailResolution(
    thumbnailSource,
    CANVAS_THUMBNAIL_MAX_EDGE,
  );

  if (pick.kind !== 'thumbnail' || !thumbnailSource) {
    return pick.url ? { url: pick.url, isPlaceholder: false, kind: pick.kind } : EMPTY;
  }

  if (thumbnailUrl) {
    return { url: thumbnailUrl, isPlaceholder: false, kind: 'thumbnail' };
  }

  if (giveUp) {
    // 生成失败/超时：给原图，不让节点一直空着。
    return { url: resolveFallbackSource(thumbnailSource), isPlaceholder: false, kind: 'original' };
  }

  return { url: null, isPlaceholder: true, kind: 'thumbnail' };
}

/**
 * 节点主体图片（**推荐**）：不订阅整个视口，只订阅「是否跨过原图阈值」这一个布尔。
 *
 * 🔴 `useViewport()` 会订阅 `{ x, y, zoom }` —— **平移画布时 x/y 每帧都在变**，
 * 于是每一个带图的节点都跟着每帧重渲染。一屏几十个图节点 / 分镜格时，平移就明显掉帧。
 * 这里把订阅收窄成 `transform[2] >= 阈值`：平移完全不触发，缩放也只在跨界那一下触发。
 */
export function useCanvasImageSourceAuto(
  imageUrl?: string | null,
  previewImageUrl?: string | null,
  allowThumbnail = true,
): CanvasImageSourceState {
  const useOriginal = useStore((state) =>
    shouldUseOriginalImageByZoom(state.transform?.[2] ?? 0),
  );

  const pick = useMemo(
    () =>
      pickCanvasImageSource({
        // zoom 不参与判断：上面已经把结论算成 useOriginal 了
        zoom: 0,
        useOriginal,
        imageUrl,
        previewImageUrl,
        allowThumbnail,
      }),
    [allowThumbnail, imageUrl, previewImageUrl, useOriginal],
  );

  return useResolvedCanvasImage(pick);
}

/** 节点主体图片：按 zoom 在原图 / preview / 512 缩略图之间选。 */
export function useCanvasImageSource(
  zoom: number,
  imageUrl?: string | null,
  previewImageUrl?: string | null,
  allowThumbnail = true,
): CanvasImageSourceState {
  const pick = useMemo(
    () => pickCanvasImageSource({ zoom, imageUrl, previewImageUrl, allowThumbnail }),
    [allowThumbnail, imageUrl, previewImageUrl, zoom],
  );

  return useResolvedCanvasImage(pick);
}

/**
 * 节点上的微型方块：素材条 / 首尾帧 / 上游图条这类 36~48px 的小图。
 *
 * 默认用 256 —— 与素材选择器同一个尺寸，**共用磁盘与内存缓存**：用户在卡片里看过的图
 * 拖到画布上时是小图同步命中，不会为新尺寸再生成一份。
 */
export function useThumbnailFallback(
  source: string | null | undefined,
  maxEdge: number = THUMBNAIL_MAX_EDGE,
): CanvasImageSourceState {
  const trimmed = (source ?? '').trim();
  const usable = trimmed && canGenerateThumbnail(trimmed) ? trimmed : null;

  const { url: thumbnailUrl, giveUp } = useThumbnailResolution(usable, maxEdge);

  if (!trimmed) {
    return EMPTY;
  }

  if (!usable) {
    // 远端 / data / blob：没法缩略，只能直接用。
    return { url: resolveFallbackSource(trimmed), isPlaceholder: false, kind: 'original' };
  }

  if (thumbnailUrl) {
    return { url: thumbnailUrl, isPlaceholder: false, kind: 'thumbnail' };
  }

  if (giveUp) {
    return { url: resolveFallbackSource(usable), isPlaceholder: false, kind: 'original' };
  }

  return { url: null, isPlaceholder: true, kind: 'thumbnail' };
}
