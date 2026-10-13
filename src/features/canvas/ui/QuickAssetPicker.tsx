import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { createPortal } from "react-dom";
import { Check, Plus, X } from "lucide-react";

import { useOverlayLayerFloor } from "@/components/ui/overlayLayer";
import { getFloatingPanelPosition } from "@/features/canvas/ui/floatingPanelPosition";
import {
  QUICK_ASSET_LIST_HEIGHT,
  QUICK_ASSET_PANEL_CHROME_HEIGHT,
  QUICK_ASSET_PANEL_WIDTH,
  QUICK_ASSET_RENDER_BATCH,
  nextQuickAssetRenderCount,
  resolveQuickAssetPanelSize,
} from "@/features/canvas/ui/quickAssetPickerLayout";
import { useAssetThumbnails } from "@/features/canvas/ui/useAssetThumbnails";
import {
  canGenerateThumbnail,
  readThumbnail,
  resolveDisplaySource,
} from "@/features/canvas/application/thumbnailCache";
import "@/features/canvas/ui/quickAssetPicker.css";

export interface QuickAssetPickerItem {
  /** 业务侧主键（画布节点用素材库条目 id，工作台用工程资产 id）。 */
  id: string;
  name: string;
  /**
   * **原始**素材地址（本地路径 / `file://` / http / data URL），不要在这里做
   * `resolveImageDisplayUrl`：卡片内部会先把本地原图换成 Rust 生成的小缩略图，
   * 直接塞原图地址等于每次展开都解码上百 MB。为空时退化成首字母块。
   */
  source: string;
  active: boolean;
}

/**
 * 视觉变体：
 * - `canvas`：画布节点上的浮层，沿用节点主题类（深色面板 + Tailwind 令牌）。
 * - `studio`：工作台面板里的浮层。卡片 portal 到 `document.body`，拿不到
 *   `.cinematic-studio-app` 作用域里的局部令牌，所以外观由 `quickAssetPicker.css`
 *   用 `:root` 上的全局主题令牌接管（明暗自适应，跟随工作台）。
 */
export type QuickAssetPickerVariant = "canvas" | "studio";

export interface QuickAssetPickerCardProps {
  open: boolean;
  /**
   * 触发按钮的 ref。落点按它的实时位置算；画布缩放 / 面板滚动时重算，
   * 所以只能传 ref 不能传元素快照（快照不会跟着动）。
   */
  anchorRef: RefObject<HTMLElement | null>;
  title: string;
  emptyHint: string;
  items: QuickAssetPickerItem[];
  onToggleItem: (id: string) => void;
  onClose: () => void;
  variant?: QuickAssetPickerVariant;
  /** 卡片理想宽度；仍会被视口夹取。 */
  preferredWidth?: number;
}

export interface QuickAssetPickerProps {
  /** 加号按钮的无障碍标签，例如「添加角色」。 */
  addLabel: string;
  /** 卡片是否展开；由父组件持有，保证整个节点同一时刻只开一张卡片。 */
  active: boolean;
  onToggleOpen: (next: boolean) => void;
  title: string;
  emptyHint: string;
  items: QuickAssetPickerItem[];
  onToggleItem: (id: string) => void;
}

const PANEL_WIDTH = QUICK_ASSET_PANEL_WIDTH;
const RENDER_BATCH = QUICK_ASSET_RENDER_BATCH;
/** 列表之外的高度（标题行 + 内边距），只用于估算下翻还是上翻。 */
const PANEL_CHROME_HEIGHT = QUICK_ASSET_PANEL_CHROME_HEIGHT;

/**
 * 候选卡片浮层 —— 画布节点与工作台面板共用同一套行为。
 *
 * 卡片 portal 到 `document.body`（`position: fixed`）：以前它 `absolute` 在节点/面板里，
 * 贴着画布边缘时会被裁掉，也会被后渲染的节点压在下面。落在 body 上后由
 * `getFloatingPanelPosition` 统一夹进视口（左右 / 上下各留 16px），底部放不下自动翻到
 * 按钮上方；画布缩放、面板滚动时按触发按钮的实时位置重算，不会跑偏。
 *
 * 缩略图分三层处理，缺一层都还会卡：
 * 1. 只挂当前这一批（`renderCount`），滚动到末尾再补，几百个角色不会一次进 DOM。
 * 2. 每张图先换成 Rust 生成的小图（约 10KB）而不是原图（实测单张 p90 近 10MB）。
 * 3. 小图还没就绪时显示占位块 —— 绝不能把原图当兜底塞进去，否则第 2 层白做。
 */
export function QuickAssetPickerCard({
  open,
  anchorRef,
  title,
  emptyHint,
  items,
  onToggleItem,
  onClose,
  variant = "canvas",
  preferredWidth = PANEL_WIDTH,
}: QuickAssetPickerCardProps) {
  const overlayFloor = useOverlayLayerFloor();
  const panelRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const layoutFrameRef = useRef(0);
  const [layout, setLayout] = useState({
    left: 0,
    top: 0,
    width: preferredWidth,
    listHeight: QUICK_ASSET_LIST_HEIGHT,
  });
  const [renderCount, setRenderCount] = useState(RENDER_BATCH);

  const updateLayout = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor || typeof window === "undefined") return;
    const { width, listHeight } = resolveQuickAssetPanelSize(
      { width: window.innerWidth, height: window.innerHeight },
      preferredWidth,
    );
    const next = getFloatingPanelPosition(anchor, panelRef.current, {
      align: "start",
      preferredSide: "below",
      fallbackSize: { width, height: listHeight + PANEL_CHROME_HEIGHT },
    });
    if (!next) return;
    // 落点没变就不要换 state：画布滚轮缩放时会连着触发重算，无谓的重渲染会让
    // 卡片里的列表滚动发抖。
    setLayout((current) =>
      current.left === next.left &&
      current.top === next.top &&
      current.width === width &&
      current.listHeight === listHeight
        ? current
        : { left: next.left, top: next.top, width, listHeight },
    );
  }, [anchorRef, preferredWidth]);

  /**
   * 把落点重算合并到下一帧。
   *
   * `getFloatingPanelPosition` 会读 `offsetWidth/offsetHeight` 与
   * `getBoundingClientRect`，也就是**强制同步布局**。滚动事件是每帧好几发的，
   * 不加合并就会在滚动缩略图时逐事件触发回流，这才是「滚起来卡」的主因。
   */
  const scheduleLayout = useCallback(() => {
    if (layoutFrameRef.current) return;
    layoutFrameRef.current = window.requestAnimationFrame(() => {
      layoutFrameRef.current = 0;
      updateLayout();
    });
  }, [updateLayout]);

  // 首次落位放在 layout effect：等测量完再画，卡片不会先在左上角闪一帧。
  // 视口高度变化会让列表高度跟着变（进而改变卡片总高），所以拿它当依赖再量一次。
  useLayoutEffect(() => {
    if (!open) return;
    updateLayout();
  }, [open, layout.listHeight, updateLayout]);

  useEffect(() => {
    if (!open) return;
    return () => {
      if (layoutFrameRef.current) {
        window.cancelAnimationFrame(layoutFrameRef.current);
        layoutFrameRef.current = 0;
      }
    };
  }, [open]);

  // 卡片开着的时候跟着窗口缩放 / 画布滚动重算落点。
  //
  // 捕获阶段监听会连卡片**自己**那个列表的滚动一起收到：那种滚动跟落点无关，
  // 直接跳过，否则用户滚缩略图时每一帧都在算锚点位置。
  useEffect(() => {
    if (!open) return;
    const handleScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && panelRef.current?.contains(target)) return;
      scheduleLayout();
    };
    window.addEventListener("resize", scheduleLayout);
    document.addEventListener("scroll", handleScroll, true);
    return () => {
      window.removeEventListener("resize", scheduleLayout);
      document.removeEventListener("scroll", handleScroll, true);
    };
  }, [open, scheduleLayout]);

  // 画布缩放是 transform，不会发 scroll 事件；用 wheel 捕获在下一帧补量一次落点，
  // 卡片才不会停在缩放前的位置上。
  useEffect(() => {
    if (!open) return;
    document.addEventListener("wheel", scheduleLayout, true);
    return () => document.removeEventListener("wheel", scheduleLayout, true);
  }, [open, scheduleLayout]);

  // 展开和收起都归零：每个打开动作都从第一批重新渲染，上一次滚到很深的批次
  // 不会带进新的一次选择（收起时就归零，展开后的第一帧也不会闪出几百张缩略图）。
  useEffect(() => {
    setRenderCount(RENDER_BATCH);
  }, [open, title]);

  // 滚到列表末尾再补下一批 —— 几百个角色时首屏只挂几十张缩略图。
  useEffect(() => {
    if (!open || renderCount >= items.length) return;
    const scrollElement = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (!scrollElement || !sentinel || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setRenderCount((current) => nextQuickAssetRenderCount(current, items.length, RENDER_BATCH));
        }
      },
      { root: scrollElement },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [open, items.length, renderCount]);

  const visibleItems = useMemo(() => items.slice(0, renderCount), [items, renderCount]);
  /** 只为当前这批准备缩略图；卡片收起时不再发起新任务。 */
  const visibleSources = useMemo(
    () => visibleItems.map((item) => item.source),
    [visibleItems],
  );
  const thumbnails = useAssetThumbnails(visibleSources, open);

  if (!open || typeof document === "undefined") return null;

  const isStudio = variant === "studio";
  const panelClassName = `${isStudio ? "quick-asset-picker--studio" : "border border-white/15 bg-[#171b25]"} fixed rounded-lg p-2 ${isStudio ? "" : "shadow-2xl"}`;
  const gridClassName = isStudio ? "quick-asset-picker__grid grid" : "grid grid-cols-6";
  const titleClassName = isStudio ? "quick-asset-picker__title" : "text-text";
  const closeClassName = isStudio
    ? "quick-asset-picker__close rounded p-0.5"
    : "rounded p-0.5 text-text-muted hover:bg-white/10 hover:text-white";
  const thumbClassName = isStudio ? "quick-asset-picker__thumb object-contain object-top" : "bg-black/40 object-contain object-top";
  const fallbackClassName = isStudio
    ? "quick-asset-picker__fallback text-sm font-semibold"
    : "bg-black/40 text-sm font-semibold text-text-muted";
  const skeletonClassName = isStudio
    ? "quick-asset-picker__skeleton"
    : "animate-pulse bg-white/5";

  return createPortal(
    <div
      ref={panelRef}
      data-quick-popover
      role="dialog"
      aria-label={title}
      className={panelClassName}
      style={{
        left: layout.left,
        top: layout.top,
        width: layout.width,
        zIndex: overlayFloor > 0 ? overlayFloor + 150 : 140,
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className={`text-xs font-medium ${titleClassName}`}>{title}</span>
        <button type="button" className={closeClassName} onClick={onClose} aria-label="关闭选择器">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {/* 固定格 + 横屏 4:3 缩略图：格子尺寸恒定，图片整体缩放（object-contain）不裁切，
          并贴顶居中（object-top）—— 宽幅素材的留白落在格子底部。 */}
      <div
        ref={scrollRef}
        className={`ui-scrollbar content-start gap-1 overflow-y-auto overscroll-contain pr-0.5 ${gridClassName}`}
        style={{ height: layout.listHeight }}
      >
        {visibleItems.map((item) => {
          const itemClassName = isStudio
            ? `quick-asset-picker__item relative overflow-hidden rounded border text-left transition-colors ${item.active ? "is-active" : ""}`
            : `relative overflow-hidden rounded border text-left transition-colors ${item.active ? "border-accent ring-1 ring-accent" : "border-white/15 hover:border-white/40"}`;
          // 本地原图正在生成小图 —— 显示占位块而不是原图，否则这里会把几百 MB 的
          // 解码工作重新引回来，前面的分批和缓存全部白做。
          // 两层都要看：组件 state 决定「什么时候重渲染」，模块缓存决定「这一刻到底有没有」，
          // 只看 state 会让刚滚动进来的那批闪一帧占位。
          // 值是空串代表已确认生成不了（源文件没了 / 非本地文件），此时回落原图。
          const resolved = thumbnails.get(item.source) ?? readThumbnail(item.source);
          const waitingForThumbnail = canGenerateThumbnail(item.source) && resolved === undefined;
          const displayUrl = waitingForThumbnail ? "" : resolveDisplaySource(item.source);
          return (
            <button
              key={item.id}
              type="button"
              className={itemClassName}
              onClick={() => onToggleItem(item.id)}
              title={item.name}
            >
              {displayUrl ? (
                <img
                  className={`aspect-[4/3] w-full ${thumbClassName}`}
                  src={displayUrl}
                  alt={item.name}
                  loading="lazy"
                  decoding="async"
                />
              ) : (
                <span
                  aria-hidden="true"
                  className={`flex aspect-[4/3] w-full items-center justify-center ${waitingForThumbnail ? skeletonClassName : fallbackClassName}`}
                >
                  {item.name.slice(0, 1)}
                </span>
              )}
              <span className="block truncate bg-black/70 px-0.5 py-0.5 text-[8px] text-white">{item.name}</span>
              {item.active ? (
                <span className="absolute right-0.5 top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-accent text-white">
                  <Check className="h-2.5 w-2.5" />
                </span>
              ) : null}
            </button>
          );
        })}
        {items.length === 0 ? (
          <p className="col-span-full py-4 text-center text-[10px] text-text-muted">{emptyHint}</p>
        ) : null}
        {renderCount < items.length ? (
          <div ref={sentinelRef} aria-hidden="true" className="col-span-full h-px" />
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

/**
 * 画布节点上那个「+ / 添加 XX」按钮 + 它弹出的候选卡片。
 *
 * 加号按钮留在本组件里（画布节点三个候选框外观一致），工作台侧自己渲染按钮，
 * 只复用上面的 `QuickAssetPickerCard`。
 */
export function QuickAssetPicker({
  addLabel,
  active,
  onToggleOpen,
  title,
  emptyHint,
  items,
  onToggleItem,
}: QuickAssetPickerProps) {
  const anchorRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-label={addLabel}
        aria-haspopup="dialog"
        aria-expanded={active}
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded border border-dashed text-text-muted transition-colors hover:border-accent hover:bg-accent/10 hover:text-accent ${active ? "border-accent bg-accent/10 text-accent" : "border-white/25"}`}
        onClick={() => onToggleOpen(!active)}
      >
        <Plus className="h-4 w-4" />
      </button>

      <QuickAssetPickerCard
        open={active}
        anchorRef={anchorRef}
        title={title}
        emptyHint={emptyHint}
        items={items}
        onToggleItem={onToggleItem}
        onClose={() => onToggleOpen(false)}
      />
    </>
  );
}
