/**
 * 候选卡片（场景站位 / 场景角色候选 / 道具）的尺寸与分批策略。
 *
 * 抽成纯函数是因为这两条规则都跟「视口大小 / 资产数量」有关，容易被后续微调改坏：
 * 卡片必须整张落在视口内（否则又会被画布边缘裁掉），缩略图必须按批挂载
 * （否则几百个角色会在展开那一下一起解码，卡住主线程）。
 */

/**
 * 缩略图盒子的比例 —— **4:3 横屏**，三个候选框（场景站位 / 场景角色候选 / 道具）共用。
 *
 * 用常量 + 内联 `style` 下发，不靠 Tailwind 生成 `aspect-[4/3]`：这是「缩略图多大、
 * 什么形状」的唯一开关，必须能被测试断言，也不会因为扫描规则变化而静默失效。
 *
 * ⚠️ 盒子是 4:3 **不代表图片看起来是 4:3** —— 图片还必须是 `object-cover`（裁切铺满），
 * 用 `object-contain` 的话超宽素材（角色三视图那种横幅）会在盒子里缩成一条扁带、
 * 下面留一大片空白，三张卡片看起来就会「比例各不相同」。
 */
export const QUICK_ASSET_THUMB_ASPECT_RATIO = "4 / 3";

/**
 * 卡片目标宽度（画布节点侧）。
 *
 * 关键不是列数本身，而是**单格宽度**：最早是 360 配六列，单格只有约 54px 宽，
 * 角色参考图缩到那个尺寸基本看不出是谁。现在仍是六列，但卡片加宽到 640，
 * 单格约 100px，人脸和服装细节才看得出来。
 */
export const QUICK_ASSET_PANEL_WIDTH = 640;
/** 极窄窗口下的下限；再窄就没有可用的六列网格了。 */
export const QUICK_ASSET_PANEL_MIN_WIDTH = 240;
/** 画布侧网格列数。六列 + 640px 宽 = 单格约 100px（4:3 缩略图约 100x75）。 */
export const QUICK_ASSET_GRID_COLUMNS = 6;
/** 列表滚动区的理想高度（工作台侧沿用）。 */
export const QUICK_ASSET_LIST_HEIGHT = 224;
/**
 * 画布侧列表高。格子放大后行高从约 57px 涨到约 100px，可视区不跟着加高就只剩两行，
 * 反而更不好挑。
 */
export const QUICK_ASSET_CANVAS_LIST_HEIGHT = 300;
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
 * 经过同一套视口夹取。`preferredListHeight` 同理 —— 画布侧格子更大，需要更高的可视区。
 */
export function resolveQuickAssetPanelSize(
  viewport: { width: number; height: number },
  preferredWidth: number = QUICK_ASSET_PANEL_WIDTH,
  preferredListHeight: number = QUICK_ASSET_LIST_HEIGHT,
): QuickAssetPanelSize {
  const width = Math.min(
    preferredWidth,
    Math.max(QUICK_ASSET_PANEL_MIN_WIDTH, viewport.width - QUICK_ASSET_VIEWPORT_MARGIN * 2),
  );
  const listHeight = Math.max(
    MIN_LIST_HEIGHT,
    Math.min(
      preferredListHeight,
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
