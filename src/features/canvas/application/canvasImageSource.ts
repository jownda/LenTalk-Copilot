/**
 * 画布节点「该显示哪张图」的统一判定（纯函数，可单测）。
 *
 * 背景：画布节点此前一律把 `imageUrl`（常常是 4000x3000 的原图）直接喂给 `<img>`，
 * 一屏挂 20 个节点就要解码几百 MB —— 这是「每次打开项目都要重新加载媒体、很卡」
 * 的主因。而 React Flow 的 `onlyRenderVisibleElements` 还会卸载视口外节点，
 * 平移回来重新挂载就再解码一次。
 *
 * 判定顺序（从便宜到贵）：
 * 1. 放大到 `shouldUseOriginalImageByZoom` 阈值以上 → 原图（用户主动要看细节）；
 * 2. 有 `previewImageUrl` → 用它（生成流水线落盘的 512 小图，已经存在，
 *    比现生成缩略图更省，也避免了重复文件）；
 * 3. 只剩本地原图可显示 → 交给 Rust 生成缩略图（**落盘持久化**，
 *    重开项目只做一次 stat，不再解码原图）；
 * 4. 远端 / data / blob 源没法缩略，只能直接用。
 */

import {
  resolveImageDisplayUrl,
  shouldUseOriginalImageByZoom,
} from '@/features/canvas/application/imageData';
import { isThumbnailableLocalSource } from '@/features/canvas/application/thumbnailCache';

export type CanvasImageKind = 'original' | 'preview' | 'thumbnail' | 'none';

export interface CanvasImagePick {
  kind: CanvasImageKind;
  /** 已经解析成可直接给 `<img>` 的地址；`thumbnail` 分支为 `null`（要等生成）。 */
  url: string | null;
  /** `kind === 'thumbnail'` 时给出可交给 Rust 生成缩略图的本地源路径。 */
  thumbnailSource: string | null;
}

export interface PickCanvasImageSourceParams {
  zoom: number;
  imageUrl?: string | null;
  previewImageUrl?: string | null;
  /**
   * 是否允许用缩略图。查看器 / 需要精确像素的地方传 `false`，
   * 此时一律返回原图，不走缩略图这条便宜路径。
   */
  allowThumbnail?: boolean;
}

const NONE: CanvasImagePick = { kind: 'none', url: null, thumbnailSource: null };

export function pickCanvasImageSource({
  zoom,
  imageUrl,
  previewImageUrl,
  allowThumbnail = true,
}: PickCanvasImageSourceParams): CanvasImagePick {
  const original = (imageUrl ?? '').trim();
  const preview = (previewImageUrl ?? '').trim();

  // 关掉缩略图、或放大到阈值以上（用户主动要看细节）→ 给最清晰的可用源。
  if (!allowThumbnail || shouldUseOriginalImageByZoom(zoom)) {
    const picked = original || preview;
    return picked
      ? { kind: 'original', url: resolveImageDisplayUrl(picked), thumbnailSource: null }
      : NONE;
  }

  // 生成流水线落盘的 512 小图：已经存在，比现生成缩略图更省。
  if (preview) {
    return { kind: 'preview', url: resolveImageDisplayUrl(preview), thumbnailSource: null };
  }

  if (!original) {
    return NONE;
  }

  if (isThumbnailableLocalSource(original)) {
    // 这里**刻意不给 url**：调用方应先显示骨架，等缩略图就绪再换上去。
    // 顺手把原图递出去的话，等于照样解码一遍，白优化。
    return { kind: 'thumbnail', url: null, thumbnailSource: original };
  }

  return { kind: 'original', url: resolveImageDisplayUrl(original), thumbnailSource: null };
}
