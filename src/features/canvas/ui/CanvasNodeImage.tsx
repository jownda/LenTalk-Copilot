import { memo, useCallback, type ImgHTMLAttributes, type MouseEvent } from 'react';

import { useCanvasStore } from '@/stores/canvasStore';

export interface CanvasNodeImageProps extends ImgHTMLAttributes<HTMLImageElement> {
  viewerSourceUrl?: string | null;
  viewerImageList?: Array<string | null | undefined>;
  disableViewer?: boolean;
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
  onDoubleClick,
  src,
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

  return (
    <img
      {...props}
      src={src}
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
