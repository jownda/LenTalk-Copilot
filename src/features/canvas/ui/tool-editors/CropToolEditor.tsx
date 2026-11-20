import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactCrop, {
  centerCrop,
  makeAspectCrop,
  type Crop,
  type PercentCrop,
  type PixelCrop,
} from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';

import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import type { ToolSelectField } from '@/features/canvas/tools';
import type { VisualToolEditorProps } from './types';
import { toImageSpaceCrop, toRenderedCrop } from '@/features/canvas/application/cropGeometry';

const VIEWPORT_PADDING_PX = 20;
const VIEWPORT_MIN_WIDTH_PX = 220;
const VIEWPORT_MIN_HEIGHT_PX = 180;

/**
 * 小于这个尺寸的框视作「误触」（点了一下但没拖）。
 *
 * `react-image-crop` 在图片上按下就会立刻回调一个 0×0 的 crop，松手才给最终值。
 * 只点击不拖动时最终值仍然极小，若照单收下，用户下一次点「应用」就会得到一张
 * 1×1 的切片 —— 所以这里丢掉过小的框，保留上一块有效选区。
 */
const MIN_CROP_PX = 24;

function parsePresetRatio(value: string): number | null {
  if (!value.includes(':')) {
    return null;
  }

  const [rawW, rawH] = value.split(':').map((item) => Number(item));
  if (!Number.isFinite(rawW) || !Number.isFinite(rawH) || rawW <= 0 || rawH <= 0) {
    return null;
  }

  return rawW / rawH;
}

function parseCustomRatio(value: string): number | null {
  const input = value.trim();
  if (!input) {
    return null;
  }

  if (input.includes(':')) {
    return parsePresetRatio(input);
  }

  const numeric = Number(input);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  return numeric;
}

function toNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 按比例给出的初始框（只用于锁比例的情况）。
 *
 * 🔴 自由比例**不要**给初始框：`ReactCrop` 的选区是一层覆盖在图片上的 plane
 * （`cursor: move`），铺满整张图时会把所有 pointerdown 吃掉 —— 用户按下去拖动，
 * 触发的是「移动选区」，而选区已经顶到四边、位移被钳成 0，看起来就是「框拖不出来」。
 * 所以自由比例从「没有框」开始，按住即拖出新框（库的默认语义）。
 *
 * 锁比例时给 88% 的框：四周留出余量，仍可在框外按下重新框选。
 */
function buildDefaultCrop(width: number, height: number, aspect: number): Crop {
  return centerCrop(
    makeAspectCrop(
      {
        unit: '%',
        width: 88,
      },
      aspect,
      width,
      height
    ),
    width,
    height
  );
}

/** 两个框是否几乎一样（用于抑制「回写 → 再落地」造成的 1px 抖动）。 */
export function cropsNearlyEqual(a: Crop | undefined, b: Crop | undefined): boolean {
  if (!a || !b) {
    return !a && !b;
  }
  return (
    Math.abs((a.x ?? 0) - (b.x ?? 0)) < 1.5 &&
    Math.abs((a.y ?? 0) - (b.y ?? 0)) < 1.5 &&
    Math.abs((a.width ?? 0) - (b.width ?? 0)) < 1.5 &&
    Math.abs((a.height ?? 0) - (b.height ?? 0)) < 1.5
  );
}

export function CropToolEditor({ plugin, sourceImageUrl, options, onOptionsChange }: VisualToolEditorProps) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const previousAspectKeyRef = useRef<string | null>(null);
  /** 正在拖：这期间绝不能用 options 回写 crop，否则拖到一半会被打回上一次的位置。 */
  const draggingRef = useRef(false);
  /** 上一块有效选区：误触（只点不拖）时用来回退。 */
  const lastValidCropRef = useRef<Crop | undefined>(undefined);
  const [crop, setCrop] = useState<Crop>();
  const [customRatioInput, setCustomRatioInput] = useState(
    typeof options.customAspectRatio === 'string' ? options.customAspectRatio : ''
  );
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });

  const displaySourceImageUrl = useMemo(
    () => resolveImageDisplayUrl(sourceImageUrl),
    [sourceImageUrl]
  );

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) {
      return;
    }

    const updateViewportSize = () => {
      const rect = element.getBoundingClientRect();
      setViewportSize({
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
      });
    };

    updateViewportSize();
    const observer = new ResizeObserver(updateViewportSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const renderedImageSize = useMemo(() => {
    if (naturalSize.width <= 0 || naturalSize.height <= 0) {
      return null;
    }

    const maxWidth = Math.max(
      VIEWPORT_MIN_WIDTH_PX,
      viewportSize.width - VIEWPORT_PADDING_PX * 2
    );
    const maxHeight = Math.max(
      VIEWPORT_MIN_HEIGHT_PX,
      viewportSize.height - VIEWPORT_PADDING_PX * 2
    );
    const ratio = Math.min(maxWidth / naturalSize.width, maxHeight / naturalSize.height, 1);

    return {
      width: Math.max(1, Math.round(naturalSize.width * ratio)),
      height: Math.max(1, Math.round(naturalSize.height * ratio)),
    };
  }, [naturalSize.height, naturalSize.width, viewportSize.height, viewportSize.width]);

  const ratioOptions = useMemo(() => {
    const field = plugin.fields.find((item) => item.type === 'select' && item.key === 'aspectRatio');
    if (!field) {
      return [
        { label: '自由', value: 'free' },
        { label: '1:1', value: '1:1' },
        { label: '16:9', value: '16:9' },
        { label: '9:16', value: '9:16' },
        { label: '4:3', value: '4:3' },
        { label: '3:4', value: '3:4' },
        { label: '3:2', value: '3:2' },
        { label: '2:3', value: '2:3' },
        { label: '4:5', value: '4:5' },
        { label: '5:4', value: '5:4' },
        { label: '2:1', value: '2:1' },
        { label: '21:9', value: '21:9' },
        { label: '原图', value: 'original' },
      ];
    }

    return (field as ToolSelectField).options;
  }, [plugin.fields]);

  const aspectMode = typeof options.aspectRatio === 'string' ? options.aspectRatio : 'free';
  const resolvedAspect = useMemo(() => {
    if (aspectMode === 'free') {
      return undefined;
    }

    if (aspectMode === 'original') {
      if (naturalSize.width <= 0 || naturalSize.height <= 0) {
        return undefined;
      }
      return naturalSize.width / naturalSize.height;
    }

    if (aspectMode === 'custom') {
      return parseCustomRatio(customRatioInput) ?? undefined;
    }

    return parsePresetRatio(aspectMode) ?? undefined;
  }, [aspectMode, customRatioInput, naturalSize.height, naturalSize.width]);

  const customRatioError = useMemo(() => {
    if (aspectMode !== 'custom') {
      return null;
    }
    if (!customRatioInput.trim()) {
      return '请输入比例，例如 3:2 或 1.5';
    }
    if (!parseCustomRatio(customRatioInput)) {
      return '比例格式无效';
    }
    return null;
  }, [aspectMode, customRatioInput]);

  useEffect(() => {
    setCustomRatioInput(typeof options.customAspectRatio === 'string' ? options.customAspectRatio : '');
  }, [options.customAspectRatio]);

  const syncCropToOptions = useCallback((pixelCrop: PixelCrop, percentCrop?: PercentCrop | null) => {
    if (!renderedImageSize || naturalSize.width <= 0 || naturalSize.height <= 0) {
      return;
    }

    const imageCrop = toImageSpaceCrop(
      pixelCrop,
      percentCrop ?? null,
      renderedImageSize.width,
      renderedImageSize.height,
      naturalSize.width,
      naturalSize.height
    );

    onOptionsChange({
      ...options,
      aspectRatio: aspectMode,
      customAspectRatio: customRatioInput,
      ...imageCrop,
    });
  }, [
    aspectMode,
    customRatioInput,
    naturalSize.height,
    naturalSize.width,
    onOptionsChange,
    options,
    renderedImageSize,
  ]);

  /**
   * 🔴 不要给 `ReactCrop` 传 `keepSelection`。
   *
   * v11 里这个 prop 只在一个地方生效，就是 `onComponentPointerDown` 的守卫：
   *
   * ```js
   * if (disabled || locked || (keepSelection && crop)) return;
   * ```
   *
   * 而 `crop` 在本组件里**始终有值**（打开对话框就按默认比例框好一块，之后又由
   * `applyCropFromOptions` 持续同步）。两者同时成立 ⇒ 在图片上按下的事件被直接丢弃，
   * 用户永远拖不出第二块选区，只能去拖已有选框的把手 —— 实报「裁剪拖不出框」。
   *
   * 去掉之后回到库的默认语义：在图上按下即新建选区，在选区内/把手上按下仍是移动与缩放
   * （选区是容器的兄弟节点，事件不会冒泡到图片那层，两者不冲突）。
   */
  const handleCropComplete = useCallback(
    (pixelCrop: PixelCrop, percentCrop?: PercentCrop | null) => {
      // 松手了，允许 options 再次回写
      draggingRef.current = false;
      if (pixelCrop.width < MIN_CROP_PX || pixelCrop.height < MIN_CROP_PX) {
        // 只点了一下没拖：丢掉这块 1×1 的框，回到上一块有效的选区
        setCrop(lastValidCropRef.current);
        return;
      }
      lastValidCropRef.current = {
        unit: 'px',
        x: pixelCrop.x,
        y: pixelCrop.y,
        width: pixelCrop.width,
        height: pixelCrop.height,
      };
      syncCropToOptions(pixelCrop, percentCrop);
    },
    [syncCropToOptions]
  );

  /** 已保存的裁剪（源图像素）→ 渲染尺寸下的框；没有或已接近整图时返回 null。 */
  const cropFromOptions = useCallback((): Crop | null => {
    if (!renderedImageSize || naturalSize.width <= 0 || naturalSize.height <= 0) {
      return null;
    }

    const cropX = toNumber(options.cropX);
    const cropY = toNumber(options.cropY);
    const cropWidth = toNumber(options.cropWidth);
    const cropHeight = toNumber(options.cropHeight);
    if (
      cropX === null ||
      cropY === null ||
      cropWidth === null ||
      cropHeight === null ||
      cropWidth <= 0 ||
      cropHeight <= 0
    ) {
      return null;
    }

    // 「整张图」不算裁剪：没必要显示一个铺满画布的框（它会把按下事件全吃掉）。
    const fullWidth = cropWidth >= naturalSize.width * 0.995;
    const fullHeight = cropHeight >= naturalSize.height * 0.995;
    if (fullWidth && fullHeight && cropX <= naturalSize.width * 0.005 && cropY <= naturalSize.height * 0.005) {
      return null;
    }

    return {
      unit: 'px',
      ...toRenderedCrop(
        { cropX, cropY, cropWidth, cropHeight },
        renderedImageSize.width,
        renderedImageSize.height,
        naturalSize.width,
        naturalSize.height
      ),
    };
  }, [
    naturalSize.height,
    naturalSize.width,
    options.cropHeight,
    options.cropWidth,
    options.cropX,
    options.cropY,
    renderedImageSize,
  ]);

  /**
   * 框的落地入口：只在「打开 / 图片尺寸就绪 / 换比例预设」时决定框长什么样。
   *
   * 🔴 不再跟着 `options` 每变一次就回写 `crop`。拖动的中间态在 `onChange` 里，
   * 松手才写 options；若 effect 也在写，两边会互相覆盖 —— 实报「拖到一半跳回原处」。
   */
  useEffect(() => {
    if (!renderedImageSize) {
      return;
    }
    // 正在拖：这一刻的框以用户的指针为准，任何回写都会打断手感
    if (draggingRef.current) {
      return;
    }

    const aspectKey = `${aspectMode}:${aspectMode === 'custom' ? customRatioInput : ''}`;
    const aspectModeChanged =
      previousAspectKeyRef.current !== null
      && previousAspectKeyRef.current !== aspectKey;
    previousAspectKeyRef.current = aspectKey;

    const restored = cropFromOptions();
    if (!aspectModeChanged && restored) {
      // 重开对话框 / 窗口尺寸变化：按已保存的裁剪还原，不重新框
      if (!cropsNearlyEqual(crop, restored)) {
        setCrop(restored);
      }
      lastValidCropRef.current = restored;
      return;
    }

    if (resolvedAspect) {
      const next = buildDefaultCrop(
        renderedImageSize.width,
        renderedImageSize.height,
        resolvedAspect
      );
      setCrop(next);
      lastValidCropRef.current = next;
      syncCropToOptions({
        unit: 'px',
        x: Math.round(next.x ?? 0),
        y: Math.round(next.y ?? 0),
        width: Math.round(next.width ?? renderedImageSize.width),
        height: Math.round(next.height ?? renderedImageSize.height),
      });
      return;
    }

    // 自由比例、且没有可用的已保存裁剪：不出初始框，让用户按住直接拖。
    setCrop(undefined);
    lastValidCropRef.current = undefined;
    if (aspectModeChanged) {
      // 从锁定比例切回「自由」：把上一套裁剪参数一并清掉，
      // 否则下一轮 effect 又会照它把框还原出来（用户以为「切自由没反应」）。
      onOptionsChange({
        ...options,
        aspectRatio: aspectMode,
        customAspectRatio: customRatioInput,
        // 宽高给 0：前后端都把「宽或高 <= 0」当作没有手工裁剪
        cropX: 0,
        cropY: 0,
        cropWidth: 0,
        cropHeight: 0,
      });
    }
  }, [
    aspectMode,
    crop,
    cropFromOptions,
    customRatioInput,
    onOptionsChange,
    options,
    renderedImageSize,
    resolvedAspect,
    syncCropToOptions,
  ]);

  const handleImageLoad = useCallback(() => {
    const image = imageRef.current;
    if (!image) {
      return;
    }

    setNaturalSize({
      width: image.naturalWidth,
      height: image.naturalHeight,
    });
  }, []);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {ratioOptions.map((item) => {
          const active = item.value === aspectMode;
          return (
            <button
              key={item.value}
              type="button"
              className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                active
                  ? 'border-accent/45 bg-accent/15 text-text-dark'
                  : 'border-[rgba(255,255,255,0.15)] text-text-muted hover:bg-bg-dark'
              }`}
              onClick={() =>
                onOptionsChange({
                  ...options,
                  aspectRatio: item.value,
                })
              }
            >
              {item.label}
            </button>
          );
        })}

        <button
          type="button"
          className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
            aspectMode === 'custom'
              ? 'border-accent/45 bg-accent/15 text-text-dark'
              : 'border-[rgba(255,255,255,0.15)] text-text-muted hover:bg-bg-dark'
          }`}
          onClick={() =>
            onOptionsChange({
              ...options,
              aspectRatio: 'custom',
            })
          }
        >
          自定义
        </button>
      </div>

      {aspectMode === 'custom' && (
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={customRatioInput}
            onChange={(event) => {
              const next = event.target.value;
              setCustomRatioInput(next);
              onOptionsChange({
                ...options,
                aspectRatio: 'custom',
                customAspectRatio: next,
              });
            }}
            placeholder="输入比例，如 3:2 或 1.5"
            className="h-9 w-[220px] rounded-lg border border-[rgba(255,255,255,0.15)] bg-bg-dark/80 px-3 text-sm text-text-dark outline-none"
          />
          {customRatioError && <span className="text-xs text-red-400">{customRatioError}</span>}
        </div>
      )}

      <div
        ref={viewportRef}
        className="relative h-[min(62vh,640px)] rounded-xl border border-[rgba(255,255,255,0.12)] bg-bg-dark/85"
      >
        <div className="flex h-full w-full items-center justify-center p-3">
          {renderedImageSize && (
            <ReactCrop
              crop={crop}
              onChange={(nextCrop) => {
                if (!nextCrop) {
                  return;
                }
                // 拖动开始：标记一下，避免 effect 拿旧的 options 把框打回去
                draggingRef.current = true;
                setCrop(nextCrop);
              }}
              onComplete={handleCropComplete}
              aspect={resolvedAspect}
              minWidth={MIN_CROP_PX}
              minHeight={MIN_CROP_PX}
              ruleOfThirds
            >
              <img
                ref={imageRef}
                src={displaySourceImageUrl}
                alt="Crop Source"
                // Safari / WKWebView 里 <img> 默认可拖：按住拖动会起原生 drag 而不是选区，
                // 指针事件被夺走后表现为「框拖到一半断掉」。Chromium 侧同样受益。
                draggable={false}
                onDragStart={(event) => event.preventDefault()}
                className="block select-none object-contain [-webkit-user-drag:none]"
                style={{
                  width: `${renderedImageSize.width}px`,
                  height: `${renderedImageSize.height}px`,
                  maxWidth: 'none',
                  maxHeight: 'none',
                }}
                onLoad={handleImageLoad}
              />
            </ReactCrop>
          )}
          {!renderedImageSize && (
            <img
              ref={imageRef}
              src={displaySourceImageUrl}
              alt="Crop Source"
              className="hidden"
              onLoad={handleImageLoad}
            />
          )}
        </div>
        {!crop && (
          // 没有初始框时给一句话：以前默认框铺满整张图，用户以为「框拖不出来」，
          // 现在从空白开始，得明确告诉他「按住拖」。
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
            <span className="rounded-full bg-black/60 px-3 py-1 text-xs text-white/85">
              在图片上按住拖动，框出要保留的区域
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
