/**
 * 候选卡片（场景站位 / 场景角色候选 / 道具）的尺寸与分批策略。
 *
 * 抽成纯函数是因为这两条规则都跟「视口大小 / 资产数量」有关，容易被后续微调改坏：
 * 卡片必须整张落在视口内（否则又会被画布边缘裁掉），缩略图必须按批挂载
 * （否则几百个角色会在展开那一下一起解码，卡住主线程）。
 */

/** 卡片目标宽度。六列缩略图刚好排得下，也放得下较长的资产名。 */
export const QUICK_ASSET_PANEL_WIDTH = 360;
/** 极窄窗口下的下限；再窄就没有可用的六列网格了。 */
export const QUICK_ASSET_PANEL_MIN_WIDTH = 240;
/** 列表滚动区的理想高度。 */
export const QUICK_ASSET_LIST_HEIGHT = 224;
/** 列表之外的高度（标题行 + 内边距），只用于估算下翻还是上翻。 */
export const QUICK_ASSET_PANEL_CHROME_HEIGHT = 78;
/** 视口四周留白。 */
export const QUICK_ASSET_VIEWPORT_MARGIN = 16;
/** 首屏渲染的缩略图数量。 */
export const QUICK_ASSET_RENDER_BATCH = 36;
/** 列表滚动区的高度下限 —— 再矮就只剩一两行缩略图了。 */
const MIN_LIST_HEIGHT = 96;

export interface QuickAssetPanelSize {
  /** 卡片宽度（已夹进视口）。 */
  width: number;
  /** 列表滚动区高度（已按视口高度收窄）。 */
  listHeight: number;
}

/**
 * 卡片尺寸：宽度不超出视口左右各 16px，列表高度不超出视口上下各 16px
 * —— 这样卡片总高最多占满视口，不会被上下边缘裁掉。
 *
 * `preferredWidth` 让不同场景挑自己的理想宽度（画布节点窄、工作台面板宽），但都要
 * 经过同一套视口夹取。
 */
export function resolveQuickAssetPanelSize(
  viewport: { width: number; height: number },
  preferredWidth: number = QUICK_ASSET_PANEL_WIDTH,
): QuickAssetPanelSize {
  const width = Math.min(
    preferredWidth,
    Math.max(QUICK_ASSET_PANEL_MIN_WIDTH, viewport.width - QUICK_ASSET_VIEWPORT_MARGIN * 2),
  );
  const listHeight = Math.max(
    MIN_LIST_HEIGHT,
    Math.min(
      QUICK_ASSET_LIST_HEIGHT,
      viewport.height - QUICK_ASSET_PANEL_CHROME_HEIGHT - QUICK_ASSET_VIEWPORT_MARGIN * 2,
    ),
  );
  return { width, listHeight };
}

/** 再补一批缩略图；补齐到总数即封顶，不会无限追加。 */
export function nextQuickAssetRenderCount(
  current: number,
  total: number,
  batch: number = QUICK_ASSET_RENDER_BATCH,
): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  if (!Number.isFinite(current) || current < 0) return Math.min(batch, total);
  return Math.min(total, current + batch);
}
