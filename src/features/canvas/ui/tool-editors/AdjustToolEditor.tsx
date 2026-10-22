import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import {
  adjustImageSource,
  DEFAULT_IMAGE_ADJUSTMENTS,
  type ImageAdjustments,
} from '@/features/canvas/application/imageAdjust';
import type { VisualToolEditorProps } from './types';

const PREVIEW_MAX_DIMENSION = 800;

interface AdjustFieldDef {
  key: keyof ImageAdjustments;
  label: string;
}

const ADJUST_FIELDS: AdjustFieldDef[] = [
  { key: 'brightness', label: '亮度' },
  { key: 'contrast', label: '对比度' },
  { key: 'saturation', label: '饱和度' },
  { key: 'temperature', label: '色温' },
  { key: 'shadows', label: '暗部' },
  { key: 'highlights', label: '亮部' },
];

function readNumber(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

export function AdjustToolEditor({
  sourceImageUrl,
  options,
  onOptionsChange,
}: VisualToolEditorProps) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const adjustments: ImageAdjustments = useMemo(
    () => ({
      brightness: readNumber(options.brightness) ?? DEFAULT_IMAGE_ADJUSTMENTS.brightness,
      contrast: readNumber(options.contrast) ?? DEFAULT_IMAGE_ADJUSTMENTS.contrast,
      saturation: readNumber(options.saturation) ?? DEFAULT_IMAGE_ADJUSTMENTS.saturation,
      temperature: readNumber(options.temperature) ?? DEFAULT_IMAGE_ADJUSTMENTS.temperature,
      shadows: readNumber(options.shadows) ?? DEFAULT_IMAGE_ADJUSTMENTS.shadows,
      highlights: readNumber(options.highlights) ?? DEFAULT_IMAGE_ADJUSTMENTS.highlights,
    }),
    [
      options.brightness,
      options.contrast,
      options.saturation,
      options.temperature,
      options.shadows,
      options.highlights,
    ]
  );

  const adjustmentKey = JSON.stringify(adjustments);

  useEffect(() => {
    let cancelled = false;
    if (previewTimerRef.current) {
      clearTimeout(previewTimerRef.current);
    }
    previewTimerRef.current = setTimeout(() => {
      setPreviewBusy(true);
      void adjustImageSource(sourceImageUrl, adjustments, PREVIEW_MAX_DIMENSION)
        .then((url) => {
          if (!cancelled) {
            setPreviewUrl(url);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setPreviewUrl(null);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setPreviewBusy(false);
          }
        });
    }, 120);

    return () => {
      cancelled = true;
      if (previewTimerRef.current) {
        clearTimeout(previewTimerRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adjustmentKey, sourceImageUrl]);

  const displaySource = previewUrl ?? resolveImageDisplayUrl(sourceImageUrl);

  const handleChange = useCallback(
    (key: keyof ImageAdjustments, value: number) => {
      onOptionsChange({ ...options, [key]: value });
    },
    [onOptionsChange, options]
  );

  const handleReset = useCallback(() => {
    onOptionsChange({ ...options, ...DEFAULT_IMAGE_ADJUSTMENTS });
  }, [onOptionsChange, options]);

  const isDefault = adjustmentKey === JSON.stringify(DEFAULT_IMAGE_ADJUSTMENTS);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-center overflow-hidden rounded-lg border border-[rgba(255,255,255,0.1)] bg-bg-dark/60">
        <img
          src={displaySource}
          alt="调节预览"
          className={`max-h-[220px] w-auto max-w-full object-contain transition-opacity ${previewBusy ? 'opacity-60' : 'opacity-100'}`}
        />
      </div>

      <div className="space-y-3">
        {ADJUST_FIELDS.map((field) => (
          <div key={field.key} className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-xs text-text-muted">{field.label}</span>
              <span className="text-[11px] tabular-nums text-text-muted/70">
                {adjustments[field.key] > 0 ? '+' : ''}
                {adjustments[field.key]}
              </span>
            </div>
            <input
              type="range"
              min={-100}
              max={100}
              step={1}
              value={adjustments[field.key]}
              onChange={(event) => handleChange(field.key, Number(event.target.value))}
              className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-bg-dark accent-accent"
            />
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={handleReset}
        disabled={isDefault}
        className="w-full rounded-lg border border-[rgba(255,255,255,0.15)] py-1.5 text-xs text-text-muted transition-colors hover:bg-bg-dark disabled:opacity-40"
      >
        重置
      </button>
    </div>
  );
}
