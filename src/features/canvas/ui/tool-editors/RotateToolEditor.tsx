import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlipHorizontal2, FlipVertical2, RotateCcw, RotateCw } from 'lucide-react';

import type { VisualToolEditorProps } from './types';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';

export type RotateOperation =
  | 'rotate-left-90'
  | 'rotate-right-90'
  | 'flip-horizontal'
  | 'flip-vertical';

const OPERATION_BUTTONS: Array<{ operation: RotateOperation; icon: 'left90' | 'right90' | 'flipH' | 'flipV' }> = [
  { operation: 'rotate-left-90', icon: 'left90' },
  { operation: 'rotate-right-90', icon: 'right90' },
  { operation: 'flip-horizontal', icon: 'flipH' },
  { operation: 'flip-vertical', icon: 'flipV' },
];

/**
 * 在已变换的 canvas 上再应用一次变换(累积)。
 * 尺寸基于「当前 canvas 的实际宽高」计算,90° 旋转交换宽高,
 * 因此连续点击同一按钮会在已变换结果上继续叠加。
 */
function applyTransformToCanvas(source: HTMLCanvasElement, operation: RotateOperation): HTMLCanvasElement {
  const nw = source.width;
  const nh = source.height;
  const needsSwap = operation === 'rotate-left-90' || operation === 'rotate-right-90';
  const outWidth = needsSwap ? nh : nw;
  const outHeight = needsSwap ? nw : nh;

  const dest = document.createElement('canvas');
  dest.width = Math.max(1, outWidth);
  dest.height = Math.max(1, outHeight);
  const ctx = dest.getContext('2d');
  if (!ctx) {
    return source;
  }
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(dest.width / 2, dest.height / 2);

  let radians = 0;
  switch (operation) {
    case 'rotate-left-90':
      radians = -Math.PI / 2;
      break;
    case 'rotate-right-90':
      radians = Math.PI / 2;
      break;
    case 'flip-horizontal':
      ctx.scale(-1, 1);
      break;
    case 'flip-vertical':
      ctx.scale(1, -1);
      break;
  }
  ctx.rotate(radians);
  ctx.drawImage(source, -nw / 2, -nh / 2, nw, nh);
  ctx.restore();
  return dest;
}

export function RotateToolEditor({ sourceImageUrl, options, onOptionsChange }: VisualToolEditorProps) {
  const { t } = useTranslation();
  const workCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const originalImageRef = useRef<HTMLImageElement | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const selectedOperation = typeof options.operation === 'string'
    ? (options.operation as RotateOperation)
    : 'rotate-right-90';

  // 加载原始图片,初始化「累积画布」(初始即原图)
  useEffect(() => {
    if (!sourceImageUrl) {
      return;
    }
    let cancelled = false;
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      if (cancelled) {
        return;
      }
      originalImageRef.current = image;
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(image, 0, 0, image.naturalWidth, image.naturalHeight);
      }
      workCanvasRef.current = canvas;
      setPreviewUrl(canvas.toDataURL('image/png'));
    };
    image.src = resolveImageDisplayUrl(sourceImageUrl);
    return () => {
      cancelled = true;
      originalImageRef.current = null;
      workCanvasRef.current = null;
    };
  }, [sourceImageUrl]);

  const handleSelect = useCallback(
    (operation: RotateOperation) => {
      const current = workCanvasRef.current;
      if (!current) {
        return;
      }
      // 在当前(已变换)画布上再应用一次变换 —— 累积效果
      const next = applyTransformToCanvas(current, operation);
      workCanvasRef.current = next;
      const nextUrl = next.toDataURL('image/png');
      setPreviewUrl(nextUrl);
      onOptionsChange({
        ...options,
        operation,
        resultDataUrl: nextUrl,
      });
    },
    [onOptionsChange, options]
  );

  const renderIcon = (icon: (typeof OPERATION_BUTTONS)[number]['icon']) => {
    const className = 'h-5 w-5';
    switch (icon) {
      case 'left90':
        return <RotateCcw className={className} />;
      case 'right90':
        return <RotateCw className={className} />;
      case 'flipH':
        return <FlipHorizontal2 className={className} />;
      case 'flipV':
        return <FlipVertical2 className={className} />;
    }
  };

  const renderLabel = (operation: RotateOperation) => {
    switch (operation) {
      case 'rotate-left-90':
        return t('tool.rotate.left90');
      case 'rotate-right-90':
        return t('tool.rotate.right90');
      case 'flip-horizontal':
        return t('tool.rotate.flipH');
      case 'flip-vertical':
        return t('tool.rotate.flipV');
    }
  };

  return (
    <div className="space-y-4">
      {/* 固定高度预览区,img + object-contain 自适应,布局不随旋转跳动 */}
      <div className="flex h-[320px] items-center justify-center overflow-hidden rounded-xl border border-[rgba(255,255,255,0.12)] bg-black">
        {previewUrl ? (
          <img
            src={previewUrl}
            alt={t('tool.rotate.previewAlt', '旋转预览')}
            className="max-h-full max-w-full object-contain"
            draggable={false}
          />
        ) : (
          <span className="text-xs text-text-muted">{t('tool.rotate.loading', '加载中…')}</span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        {OPERATION_BUTTONS.map((button) => (
          <button
            key={button.operation}
            type="button"
            className={`
              flex items-center justify-center gap-2 rounded-lg border px-2 py-3 text-xs transition-colors
              ${selectedOperation === button.operation
                ? 'border-accent/60 bg-accent/15 text-text-dark'
                : 'border-[rgba(255,255,255,0.14)] bg-bg-dark/70 text-text-muted hover:border-[rgba(255,255,255,0.28)] hover:text-text-dark'}
            `}
            onClick={() => handleSelect(button.operation)}
          >
            {renderIcon(button.icon)}
            <span>{renderLabel(button.operation)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
