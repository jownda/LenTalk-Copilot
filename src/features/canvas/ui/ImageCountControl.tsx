import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Images } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useOverlayLayerFloor } from '@/components/ui/overlayLayer';
import { UiChipButton } from '@/components/ui';
import {
  IMAGE_GENERATION_COUNT_MAX,
  IMAGE_GENERATION_COUNT_MIN,
} from '@/features/canvas/domain/canvasNodes';
import { resolveImageCountImages } from '@/features/canvas/models/midjourney';
import { getFloatingPanelPosition } from './floatingPanelPosition';
import { NODE_CONTROL_CHIP_CLASS, NODE_CONTROL_ICON_CHIP_ICON_CLASS } from './nodeControlStyles';

export interface ImageCountControlProps {
  /** 节点里存的档位（1~4），不是实际张数。 */
  imageCount: number;
  /**
   * 一个档位实际出几张。Midjourney 传 4（一次任务恒出 4 张），其余模型不传。
   * 展示与请求换算都以它为准，节点数据结构保持不变。
   */
  imagesPerCountUnit?: number;
  disabled?: boolean;
  onChange: (count: number) => void;
}

const PANEL_WIDTH = 176;
const PANEL_ESTIMATED_HEIGHT = 168;

/**
 * 输入框工具栏上的「生成张数」按钮 —— 一个 chip，点开选 1~4 档。
 *
 * 为什么从模型参数面板里搬出来：`生成张数` 是每张图都要看一眼的参数，
 * 埋进「参数」弹窗里等于每次生成前多点一次；而画布节点的操作排本来就有空档。
 * 现在它紧挨着提示词模板按钮（模板 → 张数 → 生成，右手一条线）。
 *
 * Midjourney 的档位语义不同（一档 = 一组 4 张，见 `models/midjourney.ts` 的实测），
 * 所以 chip 上显示的是**换算后的张数**，面板里额外给一行说明，避免用户以为
 * 「选 1 张」能拿到 1 张。
 */
export function ImageCountControl({
  imageCount,
  imagesPerCountUnit = 1,
  disabled = false,
  onChange,
}: ImageCountControlProps) {
  const { t } = useTranslation();
  const overlayFloor = useOverlayLayerFloor();

  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const layoutFrameRef = useRef(0);

  const [open, setOpen] = useState(false);
  const [layout, setLayout] = useState({ left: 0, top: 0 });

  const images = resolveImageCountImages(imageCount, imagesPerCountUnit);
  const isGrouped = imagesPerCountUnit > 1;

  const updateLayout = useCallback(() => {
    const next = getFloatingPanelPosition(anchorRef.current, panelRef.current, {
      align: 'start',
      // 按钮在节点底部工具栏，卡片优先往上弹（下面就是节点外沿了）。
      preferredSide: 'above',
      fallbackSize: { width: PANEL_WIDTH, height: PANEL_ESTIMATED_HEIGHT },
    });
    if (!next) return;
    setLayout((current) => (current.left === next.left && current.top === next.top ? current : next));
  }, []);

  const scheduleLayout = useCallback(() => {
    if (layoutFrameRef.current) return;
    layoutFrameRef.current = window.requestAnimationFrame(() => {
      layoutFrameRef.current = 0;
      updateLayout();
    });
  }, [updateLayout]);

  useLayoutEffect(() => {
    if (!open) return;
    updateLayout();
  }, [open, updateLayout]);

  useEffect(() => {
    if (!open) return;
    return () => {
      if (layoutFrameRef.current) {
        window.cancelAnimationFrame(layoutFrameRef.current);
        layoutFrameRef.current = 0;
      }
    };
  }, [open]);

  // 画布缩放走 transform，不会发 scroll；窗口尺寸变化与滚动都要重算落点。
  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', scheduleLayout);
    document.addEventListener('scroll', scheduleLayout, true);
    document.addEventListener('wheel', scheduleLayout, true);
    return () => {
      window.removeEventListener('resize', scheduleLayout);
      document.removeEventListener('scroll', scheduleLayout, true);
      document.removeEventListener('wheel', scheduleLayout, true);
    };
  }, [open, scheduleLayout]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [open]);

  const label = `${t('modelParams.imageCount')}：${images}`;

  return (
    <>
      <UiChipButton
        ref={anchorRef}
        type="button"
        active={open}
        disabled={disabled}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={label}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        className={`nodrag ${NODE_CONTROL_CHIP_CLASS} !w-auto !shrink-0 !justify-center`}
      >
        <Images className={`${NODE_CONTROL_ICON_CHIP_ICON_CLASS} shrink-0`} />
        <span className="tabular-nums leading-none">{images}</span>
      </UiChipButton>

      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={panelRef}
              data-image-count-control=""
              role="dialog"
              aria-label={label}
              className="nowheel fixed rounded-lg border border-[rgba(255,255,255,0.16)] bg-surface-dark p-2 shadow-xl"
              style={{
                left: layout.left,
                top: layout.top,
                width: PANEL_WIDTH,
                zIndex: overlayFloor > 0 ? overlayFloor + 150 : 140,
              }}
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onWheel={(event) => event.stopPropagation()}
            >
              <div className="mb-1.5 text-[11px] font-medium text-text-dark">
                {t('modelParams.imageCount')}
              </div>
              <div className="grid grid-cols-2 gap-1">
                {Array.from(
                  { length: IMAGE_GENERATION_COUNT_MAX - IMAGE_GENERATION_COUNT_MIN + 1 },
                  (_, index) => index + IMAGE_GENERATION_COUNT_MIN,
                ).map((count) => {
                  const active = count === imageCount;
                  const countImages = resolveImageCountImages(count, imagesPerCountUnit);
                  return (
                    <button
                      key={count}
                      type="button"
                      data-image-count-option={count}
                      className={`h-7 rounded-md text-[11px] transition-colors ${
                        active
                          ? 'bg-surface-dark text-text-dark ring-1 ring-accent/60'
                          : 'bg-bg-dark/70 text-text-muted hover:text-text-dark'
                      }`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onChange(count);
                        setOpen(false);
                      }}
                    >
                      {t('modelParams.imageCountOption', { count: countImages })}
                    </button>
                  );
                })}
              </div>
              {isGrouped ? (
                // MJ 的档位不是「张」而是「组」，这行说明是必须的：
                // 否则用户会以为漏了 1/2/3 张的选项。
                <p className="mt-1.5 text-[10px] leading-4 text-text-muted">
                  {t('modelParams.imageCountGroupHint', { unit: imagesPerCountUnit })}
                </p>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
