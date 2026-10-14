import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Library, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useOverlayLayerFloor } from '@/components/ui/overlayLayer';
import { UiChipButton } from '@/components/ui';
import { usePromptLibraryStore, type PromptTemplate } from '@/features/prompts/promptLibraryStore';
import type { PromptApplyMode } from '@/features/prompts/promptApply';
import {
  NODE_CONTROL_ICON_CHIP_CLASS,
  NODE_CONTROL_ICON_CHIP_ICON_CLASS,
} from './nodeControlStyles';
import { getFloatingPanelPosition } from './floatingPanelPosition';
import {
  collectPromptCategories,
  filterPromptTemplates,
  PROMPT_PICKER_ALL_CATEGORY,
  PROMPT_PICKER_CHROME_HEIGHT,
  PROMPT_PICKER_GRID_GAP,
  resolvePromptPickerSize,
  sortPromptTemplatesByRecency,
} from './promptTemplatePickerLayout';

export interface PromptTemplatePickerProps {
  /**
   * 用户挑中一条提示词模板。文本怎么合并、写进哪个字段由调用方决定
   * （画布节点走 `prompts/promptApply` 的 composePromptText + appendPromptText）。
   */
  onApply: (template: PromptTemplate, mode: PromptApplyMode) => void;
  /** 按钮的额外类名；节点里同一排还有别的按钮时用来对齐。 */
  className?: string;
}

/** 内置词库里的英文分类 → 中文显示，与素材库提示词 tab 保持一致。 */
const CATEGORY_LABELS: Record<string, string> = {
  lighting: '光影',
  view: '视角',
  character: '角色',
  product: '产品',
  storyboard: '分镜',
  custom: '自定义',
};

function resolveCategoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

/**
 * 输入框工具栏的「提示词模板」按钮 —— 只显示图标，点开弹出提示词库的选择卡片。
 *
 * 数据源是素材库 →「提示词库」那同一个 store（`usePromptLibraryStore`），
 * 所以在素材库里增删改的条目，这里立刻可见。
 *
 * 列表**一行排两个**（`resolvePromptPickerColumns`：面板被窄窗口夹到 300px 以下时退回一列，
 * 否则每列不足 140px，名称 / 分类 / 提示词会一起变成省略号）。
 *
 * 按钮**刻意用 `UiChipButton` 而不是自己画一个 button**：它和同一排的「模型」「参数」
 * 必须是同一套外观（同高、同圆角、同 `ui-field` 底纹与描边、同样的展开态），
 * 各写一份迟早会走形。差异只在「没有文字」→ 宽度收成方块（`NODE_CONTROL_ICON_CHIP_CLASS`）。
 *
 * 卡片 portal 到 `document.body`（`position: fixed`）：画布节点是 `overflow` 可裁剪、
 * 且会被后渲染的节点压住的容器，卡片留在节点里一定会出现「展开后被画布边缘裁掉 /
 * 被别的节点盖住」。落到 body 后由 `getFloatingPanelPosition` 统一夹进视口
 * （四周各留 16px），下方放不下自动翻到按钮上方；画布缩放、窗口尺寸变化时按按钮的
 * 实时位置重算落点。
 */
export function PromptTemplatePicker({ onApply, className = '' }: PromptTemplatePickerProps) {
  const { t } = useTranslation();
  const overlayFloor = useOverlayLayerFloor();
  const libraries = usePromptLibraryStore((state) => state.libraries);

  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const layoutFrameRef = useRef(0);

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState(PROMPT_PICKER_ALL_CATEGORY);
  const [layout, setLayout] = useState({ left: 0, top: 0, width: 0, listHeight: 0, columns: 2 as 1 | 2 });

  // 最新添加的排最上面（素材库里刚存的那条不用往下翻）。
  const templates = useMemo(
    () => sortPromptTemplatesByRecency(libraries.flatMap((library) => library.items)),
    [libraries],
  );
  const categories = useMemo(() => collectPromptCategories(templates), [templates]);
  const visibleTemplates = useMemo(
    () => filterPromptTemplates(templates, { search, category: activeCategory }),
    [activeCategory, search, templates],
  );

  const updateLayout = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor || typeof window === 'undefined') return;

    const { width, listHeight, columns } = resolvePromptPickerSize({
      width: window.innerWidth,
      height: window.innerHeight,
    });
    const next = getFloatingPanelPosition(anchor, panelRef.current, {
      align: 'start',
      // 按钮在节点输入框的右下角，卡片优先往下方弹。
      preferredSide: 'below',
      fallbackSize: { width, height: listHeight + PROMPT_PICKER_CHROME_HEIGHT },
    });
    if (!next) return;

    // 落点没变就不换 state：画布滚轮缩放会连着触发重算，无谓的重渲染会让列表滚动发抖。
    setLayout((current) =>
      current.left === next.left &&
      current.top === next.top &&
      current.width === width &&
      current.listHeight === listHeight &&
      current.columns === columns
        ? current
        : { left: next.left, top: next.top, width, listHeight, columns },
    );
  }, []);

  /**
   * 把落点重算合并到下一帧。`getFloatingPanelPosition` 会读 offsetWidth 与
   * getBoundingClientRect（强制同步布局），滚动事件每帧好几发，不合并会逐事件回流。
   */
  const scheduleLayout = useCallback(() => {
    if (layoutFrameRef.current) return;
    layoutFrameRef.current = window.requestAnimationFrame(() => {
      layoutFrameRef.current = 0;
      updateLayout();
    });
  }, [updateLayout]);

  // 首次落位放在 layout effect：等测量完再画，卡片不会先在左上角闪一帧。
  useLayoutEffect(() => {
    if (!open) return;
    // 每次展开都重置筛选，上一次搜到一半的关键词不会带进下一次。
    setSearch('');
    setActiveCategory(PROMPT_PICKER_ALL_CATEGORY);
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

  // 卡片开着时跟着窗口缩放 / 画布滚动重算落点。捕获阶段会连卡片自己那个列表的
  // 滚动一起收到，那种滚动跟落点无关，直接跳过。
  useEffect(() => {
    if (!open) return;
    const handleScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && panelRef.current?.contains(target)) return;
      scheduleLayout();
    };
    window.addEventListener('resize', scheduleLayout);
    document.addEventListener('scroll', handleScroll, true);
    return () => {
      window.removeEventListener('resize', scheduleLayout);
      document.removeEventListener('scroll', handleScroll, true);
    };
  }, [open, scheduleLayout]);

  // 画布缩放是 transform，不会发 scroll 事件；用 wheel 捕获在下一帧补量一次。
  useEffect(() => {
    if (!open) return;
    document.addEventListener('wheel', scheduleLayout, true);
    return () => document.removeEventListener('wheel', scheduleLayout, true);
  }, [open, scheduleLayout]);

  // 点击卡片与按钮之外的任何地方关闭；按钮自身除外，否则会和 onClick 的 toggle 打架。
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

  const close = useCallback(() => setOpen(false), []);

  const handlePick = useCallback(
    (template: PromptTemplate, mode: PromptApplyMode) => {
      onApply(template, mode);
      close();
    },
    [close, onApply],
  );

  const buttonLabel = t('canvas.promptTemplate.open', '提示词模板');

  return (
    <>
      {/*
        和同一排的「模型 / 参数」chip 共用底座（`UiChipButton` + `ui-field` 的底纹与描边，
        展开态 = `border-accent/45 bg-accent/15`），只是没有文字，宽度收成一个 24px 方块。
        样式全部来自 `NODE_CONTROL_ICON_CHIP_CLASS`，别再在这里写死颜色 / 圆角 —— 那边改了这里要一起变。
      */}
      <UiChipButton
        ref={anchorRef}
        type="button"
        active={open}
        aria-label={buttonLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={buttonLabel}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
        // 画布节点里：不能触发节点选中 / 框选 / 拖拽。
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        className={`nodrag ${NODE_CONTROL_ICON_CHIP_CLASS} ${className}`}
      >
        <Library className={NODE_CONTROL_ICON_CHIP_ICON_CLASS} />
      </UiChipButton>

      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={panelRef}
              data-prompt-template-picker=""
              role="dialog"
              aria-label={buttonLabel}
              className="nowheel fixed rounded-lg border border-[rgba(255,255,255,0.16)] bg-surface-dark p-2 shadow-xl"
              style={{
                left: layout.left,
                top: layout.top,
                width: layout.width,
                zIndex: overlayFloor > 0 ? overlayFloor + 150 : 140,
              }}
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onWheel={(event) => event.stopPropagation()}
            >
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="truncate text-[11px] font-medium text-text-dark">
                  {t('canvas.promptTemplate.title', '提示词模板')}
                </span>
                <button
                  type="button"
                  aria-label={t('common.close', '关闭')}
                  className="shrink-0 rounded p-0.5 text-text-muted transition-colors hover:bg-white/10 hover:text-text-dark"
                  onClick={close}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>

              <div className="mb-1.5 flex items-center gap-1.5 rounded border border-[rgba(255,255,255,0.14)] bg-bg-dark/60 px-1.5">
                <Search className="h-3 w-3 shrink-0 text-text-muted" />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t('canvas.promptTemplate.search', '搜索提示词')}
                  className="nowheel h-6 min-w-0 flex-1 bg-transparent text-[11px] text-text-dark outline-none placeholder:text-text-muted/70"
                />
              </div>

              {categories.length > 1 ? (
                <div className="ui-scrollbar mb-1.5 flex gap-1 overflow-x-auto pb-0.5">
                  {[PROMPT_PICKER_ALL_CATEGORY, ...categories].map((category) => {
                    const active = activeCategory === category;
                    return (
                      <button
                        key={category}
                        type="button"
                        onClick={() => setActiveCategory(category)}
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                          active
                            ? 'bg-accent/20 text-text-dark'
                            : 'bg-bg-dark/60 text-text-muted hover:text-text-dark'
                        }`}
                      >
                        {category === PROMPT_PICKER_ALL_CATEGORY
                          ? t('canvas.promptTemplate.allCategories', '全部')
                          : resolveCategoryLabel(category)}
                      </button>
                    );
                  })}
                </div>
              ) : null}

              <div
                className="ui-scrollbar grid content-start overflow-y-auto overscroll-contain"
                style={{
                  height: layout.listHeight,
                  // 列数与间距都走内联样式：列数是按视口算出来的，Tailwind 扫不到动态拼的类名；
                  // 间距用常量而不是 `gap-1.5`，免得改了常量而样式没跟上。
                  gap: PROMPT_PICKER_GRID_GAP,
                  gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))`,
                }}
              >
                {visibleTemplates.map((template) => (
                  // 两个平级按钮、小按钮绝对定位：不用把 button 套在 button 里，
                  // 键盘与指针的点击目标各自独立，不会互相触发。
                  <div key={template.id} className="relative min-w-0">
                    <button
                      type="button"
                      data-prompt-template-item={template.id}
                      onClick={() => handlePick(template, 'full')}
                      title={template.positive}
                      className="flex h-full w-full flex-col gap-0.5 rounded border border-[rgba(255,255,255,0.12)] bg-bg-dark/70 px-1.5 py-1 text-left transition-colors hover:border-accent/60"
                    >
                      <span className="w-full truncate text-[11px] font-medium text-text-dark">
                        {template.name}
                      </span>
                      {/*
                        分类徽标与场景同占一行：一行两个后每列只有 ~150px，
                        徽标再跟名称抢位置，名称就得截断了（分类和场景都不是必填）。
                      */}
                      {template.category || template.scene ? (
                        <span className="flex w-full items-center gap-1">
                          {template.category ? (
                            <span className="shrink-0 rounded bg-bg-dark px-1 py-px text-[9px] text-text-muted">
                              {resolveCategoryLabel(template.category)}
                            </span>
                          ) : null}
                          {template.scene ? (
                            <span
                              className="min-w-0 flex-1 truncate text-[9px] text-text-muted"
                              title={template.scene}
                            >
                              {template.scene}
                            </span>
                          ) : null}
                        </span>
                      ) : null}
                      <span
                        className={`w-full text-[9px] leading-3 text-text-muted/80 ${template.negative ? 'pr-11' : ''}`}
                        style={{
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                        }}
                      >
                        {template.positive}
                      </span>
                    </button>
                    {template.negative ? (
                      // 整卡点击 = 完整填入（带负向）；这里只取正向。
                      <button
                        type="button"
                        data-prompt-template-positive={template.id}
                        title={t('canvas.promptTemplate.positiveOnly', '仅填入正向提示词')}
                        onClick={() => handlePick(template, 'positive')}
                        className="absolute bottom-1 right-1 shrink-0 rounded border border-[rgba(255,255,255,0.14)] bg-bg-dark/80 px-1.5 py-px text-[9px] text-text-muted transition-colors hover:border-accent/60 hover:text-text-dark"
                      >
                        {t('canvas.promptTemplate.positiveOnlyShort', '仅正向')}
                      </button>
                    ) : null}
                  </div>
                ))}

                {visibleTemplates.length === 0 ? (
                  // 列表是网格：这一行要横跨全部列，否则会被挤进左边那一格。
                  <p className="col-span-full py-3 text-center text-[10px] leading-snug text-text-muted">
                    {templates.length === 0
                      ? t('canvas.promptTemplate.empty', '提示词库还没有内容，可在「素材库 → 提示词库」中添加')
                      : t('canvas.promptTemplate.noMatch', '没有匹配的提示词')}
                  </p>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
