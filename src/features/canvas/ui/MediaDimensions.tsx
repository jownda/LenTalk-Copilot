import { useEffect, useState } from 'react';

export interface MediaDimensions {
  width: number;
  height: number;
}

function isValidDimensions(width: number, height: number): boolean {
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
}

/** 读取媒体原始像素尺寸，不使用节点的 CSS 显示尺寸。 */
export function useImageDimensions(source: string | null | undefined): MediaDimensions | null {
  const [dimensions, setDimensions] = useState<MediaDimensions | null>(null);

  useEffect(() => {
    setDimensions(null);
    const normalizedSource = source?.trim();
    if (!normalizedSource) {
      return;
    }

    let disposed = false;
    const image = new Image();
    const applyDimensions = () => {
      if (!disposed && isValidDimensions(image.naturalWidth, image.naturalHeight)) {
        setDimensions({ width: image.naturalWidth, height: image.naturalHeight });
      }
    };
    image.onload = applyDimensions;
    image.src = normalizedSource;
    if (image.complete) {
      applyDimensions();
    }

    return () => {
      disposed = true;
      image.onload = null;
      image.onerror = null;
    };
  }, [source]);

  return dimensions;
}

export function formatMediaDimensions(dimensions: MediaDimensions | null): string | null {
  if (!dimensions) {
    return null;
  }
  return `${dimensions.width} × ${dimensions.height}px`;
}

interface MediaDimensionsLabelProps {
  dimensions: MediaDimensions | null;
  className?: string;
}

export function MediaDimensionsLabel({ dimensions, className = '' }: MediaDimensionsLabelProps) {
  const label = formatMediaDimensions(dimensions);
  if (!label) {
    return null;
  }

  return (
    <div className={`shrink-0 px-2 pb-1.5 pt-1 text-center text-[10px] leading-4 text-text-muted ${className}`}>
      尺寸 {label}
    </div>
  );
}
