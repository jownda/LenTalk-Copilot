import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useStore } from '@xyflow/react';
import { AudioLines } from 'lucide-react';

import { CanvasNodeImage } from './CanvasNodeImage';
import {
  findClippingAncestor,
  measureOffsetWithin,
  resolveNodePickerPlacement,
  resolveViewportBounds,
  type NodePickerPlacement,
  type PickerAnchor,
} from './nodeReferencePickerLayout';

/**
 * 输入 `@` 弹出的「候选素材」面板 —— AI 图片 / AI 视频 / 分镜生成 / 提示词优化四个节点共用。
 *
 * 之前这份 UI 在四个节点里各抄了一份（固定 120px 宽、绝对定位、不做边界收敛），
 * 结果是光标靠右时面板整块探出节点卡片、节点又贴画布边缘时被裁掉，条目间距也偏大。
 * 现在统一到这里：
 * - 位置由 resolveNodePickerPlacement 夹进「节点卡片 ∩ 画布可视区」（右下放不下会左移 / 上翻）；
 * - 缩略图与行距收紧到 24px 图 + 8px 相邻间距，长素材名截断而不是把面板撑宽。
 */
export interface NodeReferencePickerEntry {
  key: string;
  /** 缺省按图片处理，`audio` 时显示音频占位图标。 */
  kind?: 'image' | 'audio';
  label: string;
  /** 图片缩略图地址；为空时降级成占位块。 */
  thumbUrl?: string | null;
  /** 双击缩略图打开大图用的源地址。 */
  viewerSourceUrl?: string | null;
  viewerImageList?: Array<string | null | undefined>;
}

interface NodeReferencePickerProps {
  /** 锚点：节点容器坐标系、未缩放（见 nodeReferencePickerLayout 的坐标系约定）。 */
  anchor: PickerAnchor;
  /** 节点根容器：面板的收敛边界以它为准。 */
  containerRef: RefObject<HTMLElement | null>;
  /**
   * 当前画布缩放。间距/留白是「视觉常量」，要靠它折算成未缩放坐标，
   * 否则画布放大时间距会跟着放大 —— 表现就是「@ 卡片离光标忽远忽近」。
   */
  zoom?: number;
  entries: NodeReferencePickerEntry[];
  activeIndex: number;
  onSelect: (index: number) => void;
  onHover: (index: number) => void;
  /** 行文字尺寸，视频节点用更小的字号。 */
  labelClassName?: string;
  /** 面板自身的额外类名（分镜节点的格子更小，需要更窄的最大宽度）。 */
  className?: string;
}

/**
 * 累加 offsetLeft/offsetTop 直到碰到 ancestor，得到 element 相对 ancestor 的偏移。
 * 具体实现与「为什么必须从 offsetParent 起步」见 nodeReferencePickerLayout.measureOffsetWithin，
 * 那里是纯函数、有回归用例；组件这边只负责量尺寸。
 */
export function NodeReferencePicker({
  anchor,
  containerRef,
  zoom = 1,
  entries,
  activeIndex,
  onSelect,
  onHover,
  labelClassName = 'text-xs',
  className = '',
}: NodeReferencePickerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<NodePickerPlacement | null>(null);
  // 上一帧量到的收敛结果：ResizeObserver 会反复回调，值没变就别 setState，免得白渲染一轮。
  const placementRef = useRef<NodePickerPlacement | null>(null);
  // 真正会裁剪面板的那层祖先（一般是画布根）。它只和节点所在的 DOM 结构有关，挂载后查一次即可。
  const clippingAncestorRef = useRef<HTMLElement | null>(null);
  const entryCount = entries.length;

  // 画布平移与缩放都会改变「可视区相对节点」的位置，所以要订阅整个 transform 而不只是 zoom。
  // 拼成字符串是为了让 zustand 用 Object.is 比对：数组每次都是新引用，直接订阅会空转重渲染。
  const canvasTransformKey = useStore(
    (state) => `${state.transform[0]},${state.transform[1]},${state.transform[2]}`,
  );

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const container = containerRef.current;
    if (!panel || !container) {
      return;
    }

    const clipping =
      clippingAncestorRef.current ??
      (clippingAncestorRef.current = findClippingAncestor(container));

    const applyPlacement = () => {
      const offset = measureOffsetWithin(panel, container);
      // 画布可视区：节点被拖到画布边缘时，只认卡片会让面板落在屏幕外 ——
      // 「底部 @ 出来的卡片被画布边框遮住、选不到」就是少了这一步。
      const viewport = clipping
        ? resolveViewportBounds(
            container.getBoundingClientRect(),
            clipping.getBoundingClientRect(),
            zoom,
          )
        : null;

      const next = resolveNodePickerPlacement({
        anchorLeft: anchor.left,
        anchorTop: anchor.top,
        panelWidth: panel.offsetWidth,
        panelHeight: panel.offsetHeight,
        containerWidth: container.offsetWidth,
        containerHeight: container.offsetHeight,
        parentOffsetLeft: offset.left,
        parentOffsetTop: offset.top,
        zoom,
        viewport,
      });

      const previous = placementRef.current;
      if (
        previous &&
        previous.left === next.left &&
        previous.top === next.top &&
        previous.maxHeight === next.maxHeight
      ) {
        return;
      }

      placementRef.current = next;
      setPlacement(next);
    };

    applyPlacement();

    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    // 节点被拖动缩放后容器尺寸会变、画布窗口大小变了裁剪祖先尺寸也会变，都要重算一次，
    // 才不会留下半截露在外面的面板。
    const observer = new ResizeObserver(applyPlacement);
    observer.observe(container);
    if (clipping) {
      observer.observe(clipping);
    }
    return () => observer.disconnect();
    // zoom / canvasTransformKey 进依赖：画布缩放或平移后要重算，否则边界会停在旧位置上。
  }, [anchor.left, anchor.top, containerRef, entryCount, zoom, canvasTransformKey]);

  return (
    <div
      ref={panelRef}
      data-node-reference-picker=""
      className={`nowheel absolute z-30 flex min-w-[96px] flex-col overflow-hidden rounded-lg border border-[rgba(255,255,255,0.16)] bg-surface-dark shadow-xl ${className}`}
      style={{
        left: placement?.left ?? anchor.left,
        top: placement?.top ?? anchor.top,
        maxHeight: placement?.maxHeight,
        // 相对定位父级的宽度上限；剩下那 12px 是给卡片两侧留白，别贴着边框。
        maxWidth: 'calc(100% - 12px)',
        // 量完尺寸前先藏着：否则会先按锚点画一帧、再跳到收敛后的位置，看着就是「闪一下」。
        // 用 visibility 而不是 display，是因为前者仍参与布局，offsetWidth/Height 才有值可量。
        visibility: placement ? 'visible' : 'hidden',
      }}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onWheelCapture={(event) => event.stopPropagation()}
    >
      <div
        className="ui-scrollbar nowheel min-h-0 flex-1 overflow-y-auto py-0.5"
        onWheelCapture={(event) => event.stopPropagation()}
      >
        {entries.map((entry, index) => {
          const isAudio = entry.kind === 'audio';
          const active = activeIndex === index;

          return (
            <button
              key={entry.key}
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onSelect(index);
              }}
              onMouseEnter={() => onHover(index)}
              className={`flex w-full items-center gap-1.5 border border-transparent bg-bg-dark/70 px-1.5 py-1 text-left ${labelClassName} text-text-dark transition-colors hover:border-[rgba(255,255,255,0.18)] ${
                active ? 'border-[rgba(255,255,255,0.24)] bg-bg-dark' : ''
              }`}
            >
              {isAudio ? (
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-accent/15 text-accent">
                  <AudioLines className="h-3.5 w-3.5" />
                </span>
              ) : entry.thumbUrl ? (
                <CanvasNodeImage
                  src={entry.thumbUrl}
                  alt={entry.label}
                  viewerSourceUrl={entry.viewerSourceUrl ?? undefined}
                  viewerImageList={entry.viewerImageList}
                  className="h-6 w-6 shrink-0 rounded object-cover"
                  draggable={false}
                />
              ) : (
                <span className="h-6 w-6 shrink-0 rounded bg-bg-dark" />
              )}
              <span className="truncate">{entry.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
