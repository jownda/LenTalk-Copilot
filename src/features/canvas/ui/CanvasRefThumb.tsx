import { useThumbnailFallback } from '@/features/canvas/ui/useCanvasImageSource';

interface CanvasRefThumbProps {
  /** 原始媒体地址（可能是 asset:// 或本地绝对路径）。 */
  source: string | null | undefined;
  alt?: string;
  className?: string;
}

/**
 * `@图N` / `[imageN]` 这类**行内小方块**（18~24px）的专用缩略图。
 *
 * 为什么单独做一个组件：这几种引用标记渲染在 `renderPromptWithHighlights` 的循环里，
 * 而 `useThumbnailFallback` 是 hook —— 循环里直接调会违反 hooks 规则，必须落到组件边界上。
 *
 * 为什么不能直接喂原图：为了画 20px 去解码一张 12MP 的照片（几十 MB）是最亏的一种浪费。
 * 走 `useThumbnailFallback` 复用画布已有的 256 缩略图缓存 —— 同一张图在主体区域早已生成过，
 * 这里直接同步命中，既不新增磁盘文件也不再解码大图。
 */
export function CanvasRefThumb({ source, alt, className = '' }: CanvasRefThumbProps) {
  const image = useThumbnailFallback(source);

  if (!image.url) {
    // 缩略图还在生成：给个同尺寸的浅色块占位，避免行内排版跳动。
    return <div aria-hidden="true" className={`${className} bg-white/10`} />;
  }

  return <img src={image.url} alt={alt ?? ''} draggable={false} className={className} />;
}
