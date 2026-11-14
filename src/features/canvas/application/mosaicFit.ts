/**
 * 拼图图层「贴合图片」的几何计算。
 *
 * 黑边全来自同一个原因：**图层框的比例和图片真实比例不一致**。
 * `<img>` 用 `object-contain` 把图缩进框里，比例对不上就上下（或左右）各留一条黑边；
 * 单个图层的节点还会再叠一层「画幅比图片大」的黑边。
 *
 * 两条规则：
 * 1. 框必须贴住图片 —— `snugLayerToImage`（宽不变，高按真实比例改）。
 * 2. 只有一个图层时，画幅直接等于这张图 —— `fitCanvasToSingleLayer`。
 *    多图层时画幅是拼图版面，不能随便缩，所以只返回 null。
 */
import type { MosaicLayerItem } from "@/features/canvas/domain/canvasNodes";

/** 归一化裁剪框（0-1 相对源图）。 */
export type MosaicCropRect = NonNullable<MosaicLayerItem["crop"]>;

const CANVAS_MIN_EDGE = 64;
const CANVAS_MAX_EDGE = 8192;
/** 比例误差容忍度：小于千分之五就不动，避免每次挂载都改一位小数。 */
const ASPECT_TOLERANCE = 0.005;

/** `"512:512"` / `"512/512"` / `"512：512"` → 512/512；取不到时返回 1。 */
export function parseAspectRatio(value: string | undefined): number {
  const match = value?.match(/^(\d+(?:\.\d+)?)\s*[:：/]\s*(\d+(?:\.\d+)?)$/);
  if (!match) return 1;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? width / height : 1;
}

/** 图层里那张图真实的可见宽高比（把裁剪也算进去）。 */
export function layerImageAspect(layer: Pick<MosaicLayerItem, "aspectRatio" | "crop">): number {
  const crop = layer.crop;
  const cropRatio = (crop?.width ?? 1) / Math.max(0.01, crop?.height ?? 1);
  return parseAspectRatio(layer.aspectRatio) * cropRatio;
}

/**
 * 把图层框贴到图片比例上。
 *
 * 两种改法：保宽度（改高度）或保高度（改宽度）。优先保宽度 —— 用户看到的是宽度，
 * 改宽度会让图缩一圈。但如果保宽度会把框撑出画幅（裁剪过的图往往更高），
 * 就改用保高度，否则会把图的上下裁掉一截。
 * 已经贴合（误差 < 0.5%）时返回 null。
 */
export function snugLayerToImage(
  layer: MosaicLayerItem,
  bounds?: { width: number; height: number },
): MosaicLayerItem | null {
  if (layer.width <= 0 || layer.height <= 0) return null;
  const aspect = layerImageAspect(layer);
  if (!Number.isFinite(aspect) || aspect <= 0) return null;
  const current = layer.width / layer.height;
  if (Math.abs(current - aspect) / aspect < ASPECT_TOLERANCE) return null;

  // 保宽度：宽度不动，高度按比例重算，中心不动。
  const keepWidthHeight = Math.max(1, Math.round(layer.width / aspect));
  const keepWidth = {
    x: layer.x,
    y: layer.y + (layer.height - keepWidthHeight) / 2,
    width: Math.round(layer.width),
    height: keepWidthHeight,
  };
  // 保高度：高度不动，宽度按比例重算。
  const keepHeightWidth = Math.max(1, Math.round(layer.height * aspect));
  const keepHeight = {
    x: layer.x + (layer.width - keepHeightWidth) / 2,
    y: layer.y,
    width: keepHeightWidth,
    height: Math.round(layer.height),
  };

  const fits = (box: { x: number; y: number; width: number; height: number }) =>
    !bounds ||
    (box.x >= -0.5 &&
      box.y >= -0.5 &&
      box.x + box.width <= bounds.width + 0.5 &&
      box.y + box.height <= bounds.height + 0.5);

  const chosen = fits(keepWidth) ? keepWidth : fits(keepHeight) ? keepHeight : keepWidth;
  const height = Math.max(1, chosen.height);
  const width = Math.max(1, chosen.width);
  let x = chosen.x;
  let y = chosen.y;
  if (bounds) {
    // 两种改法都出界时，至少把框平移回画内。
    x = Math.min(Math.max(0, x), Math.max(0, bounds.width - width));
    y = Math.min(Math.max(0, y), Math.max(0, bounds.height - height));
  }
  return { ...layer, x, y, width, height };
}

function clampCanvasEdge(edge: number): number {
  return Math.min(CANVAS_MAX_EDGE, Math.max(CANVAS_MIN_EDGE, Math.round(edge)));
}

export interface SingleLayerCanvasFit {
  layers: MosaicLayerItem[];
  width: number;
  height: number;
}

/**
 * 单图层节点：画幅直接贴住这张图，节点框因此不再有上下（左右）黑边。
 *
 * 只在「恰好一个可见图层、没有旋转」时成立：旋转后外接矩形不等于图片本身，
 * 多图层时画幅是版面（要留给拼图），都不能这样缩。
 * 已经贴合、或算下来等于原画幅时返回 null。
 */
export function fitCanvasToSingleLayer(
  layers: readonly MosaicLayerItem[],
  canvasWidth: number,
  canvasHeight: number,
): SingleLayerCanvasFit | null {
  const visible = layers.filter((layer) => layer.visible);
  if (visible.length !== 1) return null;
  const layer = visible[0];
  if (Math.abs(layer.rotation ?? 0) > 0.01) return null;

  // 这里画幅会直接等于框，所以不受当前画幅边界约束 —— 优先保宽度（分辨率不丢）。
  const snug = snugLayerToImage(layer) ?? layer;
  const width = clampCanvasEdge(snug.width);
  const height = clampCanvasEdge(snug.height);

  const unchanged =
    Math.round(layer.x) === 0 &&
    Math.round(layer.y) === 0 &&
    Math.round(layer.width) === width &&
    Math.round(layer.height) === height &&
    Math.round(canvasWidth) === width &&
    Math.round(canvasHeight) === height;
  if (unchanged) return null;

  return {
    layers: layers.map((item) =>
      item.id === layer.id ? { ...snug, x: 0, y: 0, width, height } : item,
    ),
    width,
    height,
  };
}

/**
 * 图层在画布坐标里的「按裁剪铺满框」矩形。
 *
 * 节点预览以前完全忽略 `crop`：框里画的是整张图，导出却只画裁剪区，
 * 于是「看到的」和「导出的」不是一张东西。按 `框 / 裁剪比例` 放大、再把裁剪偏移
 * 吃到负方向，裁剪区就正好落在框里 —— 与 `renderMosaicToCanvas` 的 clip 语义一致。
 */
export function layerFillRect(layer: MosaicLayerItem): { x: number; y: number; width: number; height: number } {
  const crop = layer.crop;
  const cropWidth = Math.max(0.01, crop?.width ?? 1);
  const cropHeight = Math.max(0.01, crop?.height ?? 1);
  const width = layer.width / cropWidth;
  const height = layer.height / cropHeight;
  return {
    x: layer.x - (crop?.x ?? 0) * width,
    y: layer.y - (crop?.y ?? 0) * height,
    width,
    height,
  };
}

/**
 * 单个图层的初始框：按图片真实比例给尺寸，别再一律 512×512。
 *
 * 以前正方形框配非正方形图，`object-contain` 必然留黑边，怎么拖都消不掉。
 */
export function initialLayerBox(aspectRatio: string | undefined, base = 512): { width: number; height: number } {
  const aspect = parseAspectRatio(aspectRatio);
  if (aspect >= 1) return { width: base, height: Math.max(1, Math.round(base / aspect)) };
  return { width: Math.max(1, Math.round(base * aspect)), height: base };
}

/**
 * 画幅换成某个宽高比之后，节点框该多大（宽度优先，越界再按高度锚定）。
 *
 * 保证「节点框比例 = 画幅比例」，否则预览会把图拉扁。
 */
export function nodeSizeForCanvasAspect(
  aspect: number,
  preferredWidth: number,
  bounds: { minWidth: number; minHeight: number; maxWidth: number; maxHeight: number },
): { width: number; height: number } {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  let width = Math.min(bounds.maxWidth, Math.max(bounds.minWidth, Math.round(preferredWidth)));
  let height = Math.round(width / safeAspect);
  if (height < bounds.minHeight) {
    height = bounds.minHeight;
    width = Math.min(bounds.maxWidth, Math.max(bounds.minWidth, Math.round(height * safeAspect)));
  }
  if (height > bounds.maxHeight) {
    height = bounds.maxHeight;
    width = Math.min(bounds.maxWidth, Math.max(bounds.minWidth, Math.round(height * safeAspect)));
  }
  return { width, height };
}
