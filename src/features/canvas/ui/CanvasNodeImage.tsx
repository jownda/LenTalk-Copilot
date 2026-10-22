import { memo, useCallback, type ImgHTMLAttributes, type MouseEvent } from 'react';

import { useCanvasStore } from '@/stores/canvasStore';

export interface CanvasNodeImageProps extends ImgHTMLAttributes<HTMLImageElement> {
  viewerSourceUrl?: string | null;
  viewerImageList?: Array<string | null | undefined>;
  disableViewer?: boolean;
  /**
   * `src` 还没就绪时（例如正在等缩略图生成）显示骨架方块，
   * 而不是渲染一张空 `src` 的破图。调用方负责在拿到地址后把 `src` 传进来。
   */
  placeholder?: boolean;
}

function normalizeViewerList(
  imageList: Array<string | null | undefined> | undefined,
  currentImageUrl: string
): string[] {
  const deduped: string[] = [];
  for (const rawItem of imageList ?? []) {
    const item = typeof rawItem === 'string' ? rawItem.trim() : '';
    if (!item || deduped.includes(item)) {
      continue;
    }
    deduped.push(item);
  }

  if (!deduped.includes(currentImageUrl)) {
    deduped.unshift(currentImageUrl);
  }

  return deduped.length > 0 ? deduped : [currentImageUrl];
}

export const CanvasNodeImage = memo(({
  viewerSourceUrl,
  viewerImageList,
  disableViewer = false,
  placeholder = false,
  onDoubleClick,
  src,
  className,
  ...props
}: CanvasNodeImageProps) => {
  const openImageViewer = useCanvasStore((state) => state.openImageViewer);

  const handleDoubleClick = useCallback((event: MouseEvent<HTMLImageElement>) => {
    onDoubleClick?.(event);

    if (event.defaultPrevented || disableViewer) {
      return;
    }

    const fallbackSrc = event.currentTarget.currentSrc || (typeof src === 'string' ? src : '');
    const resolvedSource =
      typeof viewerSourceUrl === 'string' && viewerSourceUrl.trim().length > 0
        ? viewerSourceUrl.trim()
        : fallbackSrc.trim();
    if (!resolvedSource) {
      return;
    }

    event.stopPropagation();
    openImageViewer(resolvedSource, normalizeViewerList(viewerImageList, resolvedSource));
  }, [disableViewer, onDoubleClick, openImageViewer, src, viewerImageList, viewerSourceUrl]);

  if (placeholder && !src) {
    // 骨架占位：缩略图还没生成好时**刻意不回落原图** —— 把原图递出去等于照样
    // 解码一遍（一张 12MP 照片几十 MB），优化就白做了。
    return (
      <div
        aria-hidden
        data-canvas-image-placeholder="true"
        className={`animate-pulse bg-white/[0.06] ${className ?? ''}`}
      />
    );
  }

  return (
    <img
      {...props}
      src={src}
      className={className}
      // 异步解码：避免大图解码阻塞主线程绘制，缩放/拖动时更跟手。
      decoding="async"
      // 禁用浏览器原生图片拖拽(幽灵图): 否则按住图片拖动会触发原生拖拽,
      // React Flow 收不到 mousedown 拖动, 节点就拖不动。统一 false 后
      // 整个节点(含图片区)左键按住即可拖动节点, 与文本节点一致。
      draggable={false}
      data-viewer-src={
        typeof viewerSourceUrl === 'string' && viewerSourceUrl.trim().length > 0
          ? viewerSourceUrl.trim()
          : undefined
      }
      onDoubleClick={handleDoubleClick}
    />
  );
});

CanvasNodeImage.displayName = 'CanvasNodeImage';
