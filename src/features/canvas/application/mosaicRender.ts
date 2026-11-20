/**
 * 无缝拼图 / 图层编辑的合成渲染。
 *
 * 抽出来是因为有**两个入口**：全屏编辑器里的「导出拼图」，和节点上的「导出」按钮。
 * 以前只有编辑器里那一份实现，节点上要导出就得点进去 —— 那层多余的点击正是这次要省掉的。
 * 两份各写一次必然越走越偏（旋转 / 混合模式只在一边生效那类问题），所以只留这一个函数。
 */
import { loadImageElement } from "@/features/canvas/application/imageData";
import { renderAdjustedCanvas } from "@/features/canvas/application/mosaicAdjust";
import { isAdjustIdentity } from "@/features/canvas/domain/mosaicAdjust";
import type { SeamlessMosaicNodeData } from "@/features/canvas/domain/canvasNodes";
import { mosaicBlendOperation } from "@/features/canvas/domain/mosaicBlend";

export interface MosaicRenderResult {
  canvas: HTMLCanvasElement;
  /** 实际参与渲染的图层数量；为 0 说明所有图层都加载失败。 */
  renderedLayerCount: number;
}

/**
 * 从掩码 data URL 读出 alpha 通道，缩放到 `width × height`，返回逐像素 alpha 数组。
 *
 * 局部调色的掩码存的是图层框坐标，而渲染时平图就是图层框尺寸，两者天然对齐；
 * 万一尺寸有出入，这里 `drawImage` 缩放兜底。
 */
export async function loadMaskAlpha(maskDataUrl: string, width: number, height: number): Promise<Uint8ClampedArray | null> {
  if (!maskDataUrl) {
    return null;
  }
  try {
    const image = await loadImageElement(maskDataUrl);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return null;
    }
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const alpha = new Uint8ClampedArray(canvas.width * canvas.height);
    for (let i = 0; i < alpha.length; i += 1) {
      alpha[i] = data[i * 4 + 3];
    }
    return alpha;
  } catch {
    return null;
  }
}

/**
 * 把单个图层渲染成一张与「图层框」等大的独立画布（不含画布偏移）。
 *
 * 破坏性「删除选中内容」用：先把图层 bake 成平图（crop/adjust/rotation 都拍进去），
 * 再在局部坐标上 destination-out 抹掉选区，生成的新图替换 `imageUrl`。
 *
 * 坐标约定：返回 canvas 的 (0,0) 对应图层框左上角（layer.x, layer.y），
 * 选区掩码从画布坐标平移 (mask.x - layer.x, mask.y - layer.y) 即可对齐。
 */
export async function renderLayerToCanvas(
  layer: import("@/features/canvas/domain/canvasNodes").MosaicLayerItem,
  options?: { skipAdjust?: boolean },
): Promise<HTMLCanvasElement> {
  const width = Math.max(1, Math.round(layer.width));
  const height = Math.max(1, Math.round(layer.height));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("无法创建画布上下文");
  }

  const image = await loadImageElement(layer.imageUrl);
  const crop = layer.crop ?? { x: 0, y: 0, width: 1, height: 1 };
  const imageWidth = Math.max(1, image.naturalWidth);
  const imageHeight = Math.max(1, image.naturalHeight);
  // 局部调色蒙版（图层局部坐标的 alpha 掩码）。
  const maskAlpha = layer.adjustMask ? await loadMaskAlpha(layer.adjustMask, width, height) : null;
  const source =
    !options?.skipAdjust && layer.adjust && !isAdjustIdentity(layer.adjust)
      ? renderAdjustedCanvas(image, imageWidth, imageHeight, layer.adjust, maskAlpha)
      : image;
  const cropWidth = Math.max(1, imageWidth * Math.max(0.01, crop.width));
  const cropHeight = Math.max(1, imageHeight * Math.max(0.01, crop.height));
  const scale = Math.max(layer.width / cropWidth, layer.height / cropHeight);
  const drawWidth = imageWidth * scale;
  const drawHeight = imageHeight * scale;
  // 图层框局部坐标：中心对齐。
  const drawX = layer.width / 2 - (crop.x + crop.width / 2) * drawWidth;
  const drawY = layer.height / 2 - (crop.y + crop.height / 2) * drawHeight;

  context.globalAlpha = typeof layer.opacity === "number" ? layer.opacity : 1;
  context.save();
  const rotation = layer.rotation ?? 0;
  if (rotation) {
    context.translate(layer.width / 2, layer.height / 2);
    context.rotate((rotation * Math.PI) / 180);
    context.translate(-layer.width / 2, -layer.height / 2);
  }
  context.beginPath();
  context.rect(0, 0, width, height);
  context.clip();
  context.drawImage(source, drawX, drawY, drawWidth, drawHeight);
  context.restore();
  return canvas;
}

export async function renderMosaicToCanvas(data: SeamlessMosaicNodeData): Promise<MosaicRenderResult> {
  const canvasWidth = Math.max(1, Math.round(data.canvasWidth || 1920));
  const canvasHeight = Math.max(1, Math.round(data.canvasHeight || 1080));

  const canvas = document.createElement("canvas");
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("无法创建画布上下文");
  }

  context.fillStyle = data.backgroundColor ?? "#0f1115";
  context.fillRect(0, 0, canvasWidth, canvasHeight);

  const sorted = [...(data.layers ?? [])]
    .filter((layer) => layer.visible)
    .sort((a, b) => a.order - b.order);
  if (sorted.length === 0) {
    throw new Error("请先添加至少一张可见图片");
  }

  let renderedLayerCount = 0;
  for (const layer of sorted) {
    try {
      // 有「局部调色蒙版」的图层走「bake 平图 + 局部调色」路径：
      // 先把图层（crop/rotation 都拍进去，但不含 adjust）bake 成图层框坐标的平图，
      // 再在图层框坐标上应用「选区掩码限制的 adjust」，最后整框贴到画布。
      // 这样掩码（图层局部坐标）与调色范围直接对齐，没有源图/画布坐标转换的坑。
      if (layer.adjustMask && layer.adjust && !isAdjustIdentity(layer.adjust)) {
        const baked = await renderLayerToCanvas(layer, { skipAdjust: true });
        const maskAlpha = await loadMaskAlpha(layer.adjustMask, baked.width, baked.height);
        const localized = renderAdjustedCanvas(baked, baked.width, baked.height, layer.adjust, maskAlpha);
        context.globalAlpha = typeof layer.opacity === "number" ? layer.opacity : 1;
        context.save();
        context.globalCompositeOperation = mosaicBlendOperation(layer.blendMode);
        context.drawImage(localized, layer.x, layer.y, layer.width, layer.height);
        context.restore();
        context.globalCompositeOperation = "source-over";
        renderedLayerCount += 1;
        continue;
      }

      const image = await loadImageElement(layer.imageUrl);
      const crop = layer.crop ?? { x: 0, y: 0, width: 1, height: 1 };
      const imageWidth = Math.max(1, image.naturalWidth);
      const imageHeight = Math.max(1, image.naturalHeight);
      // 图层调整（曲线/色阶/色彩平衡…）先落到离屏画布上，和预览走同一份实现。
      const source =
        layer.adjust && !isAdjustIdentity(layer.adjust)
          ? renderAdjustedCanvas(image, imageWidth, imageHeight, layer.adjust)
          : image;
      const cropWidth = Math.max(1, imageWidth * Math.max(0.01, crop.width));
      const cropHeight = Math.max(1, imageHeight * Math.max(0.01, crop.height));
      // 让**裁剪区**铺满图层框：以前是整张图 contain 进框再裁，裁剪区比框小，
      // 框里就空出一块底色（节点预览看到的却是铺满的，两边对不上）。
      const scale = Math.max(layer.width / cropWidth, layer.height / cropHeight);
      const drawWidth = imageWidth * scale;
      const drawHeight = imageHeight * scale;
      // 裁剪区居中于框；框比例 == 裁剪比例时就是精确贴合。
      const drawX = layer.x + layer.width / 2 - (crop.x + crop.width / 2) * drawWidth;
      const drawY = layer.y + layer.height / 2 - (crop.y + crop.height / 2) * drawHeight;

      context.globalAlpha = typeof layer.opacity === "number" ? layer.opacity : 1;
      context.save();
      // 混合模式与旋转都在 save/restore 之间设置，restore 会一并复位。
      context.globalCompositeOperation = mosaicBlendOperation(layer.blendMode);
      const rotation = layer.rotation ?? 0;
      if (rotation) {
        const centerX = layer.x + layer.width / 2;
        const centerY = layer.y + layer.height / 2;
        context.translate(centerX, centerY);
        context.rotate((rotation * Math.PI) / 180);
        context.translate(-centerX, -centerY);
      }
      // 裁到图层框：框外的一切都不该出现在成片里。
      context.beginPath();
      context.rect(layer.x, layer.y, layer.width, layer.height);
      context.clip();
      context.drawImage(source, drawX, drawY, drawWidth, drawHeight);
      context.restore();
      context.globalCompositeOperation = "source-over";
      renderedLayerCount += 1;
    } catch (error) {
      console.warn("[Mosaic] layer draw failed, skipped", layer.id, error);
    }
  }
  context.globalAlpha = 1;

  if (renderedLayerCount === 0) {
    throw new Error("图片无法加载，暂时不能导出");
  }
  return { canvas, renderedLayerCount };
}

/**
 * 画布需要扩大多少才能装下图层（**只往右下扩**）。
 *
 * 用户把图片往右/下推出界时，节点应该跟着长（即梦的图层编辑就是这个手感）。
 * 往左 / 往上不扩：扩左边必须把所有图层整体平移回来，画幅和节点比例会跟着变，
 * 用户会看到「我只想把图贴着左边框，结果整个节点的比例都变了」。
 * 左/上的边界由拖动处直接钳到 0（见 `MosaicInlineStage`），画幅因此完全不动。
 */
export function resolveCanvasExpansion(
  layers: readonly { x: number; y: number; width: number; height: number }[],
  canvasWidth: number,
  canvasHeight: number,
): { width: number; height: number } | null {
  if (layers.length === 0) return null;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const layer of layers) {
    maxX = Math.max(maxX, layer.x + layer.width);
    maxY = Math.max(maxY, layer.y + layer.height);
  }
  const width = Math.max(Math.round(canvasWidth), Math.ceil(maxX));
  const height = Math.max(Math.round(canvasHeight), Math.ceil(maxY));
  if (width === Math.round(canvasWidth) && height === Math.round(canvasHeight)) {
    return null;
  }
  return { width, height };
}

/**
 * 画幅被图层推出界撑大后，节点框该多大。
 *
 * **按轴跟着画幅一起长**，绝不用「宽度反推高度」：只往右推时画幅只变宽，
 * 反推会把节点算矮（用户正在放大图片、边框却缩小一截）。
 * 这里保证只增不减，并夹在节点尺寸上下限之间。
 */
export function scaleNodeFrameForCanvasExpansion(
  node: { width: number; height: number },
  canvasBefore: { width: number; height: number },
  canvasAfter: { width: number; height: number },
  bounds: { minWidth: number; minHeight: number; maxWidth: number; maxHeight: number },
): { width: number; height: number } {
  const ratioX = canvasBefore.width > 0 ? canvasAfter.width / canvasBefore.width : 1;
  const ratioY = canvasBefore.height > 0 ? canvasAfter.height / canvasBefore.height : 1;
  const scale = (value: number, ratio: number, min: number, max: number) =>
    Math.min(max, Math.max(min, value, Math.round(value * (Number.isFinite(ratio) ? ratio : 1))));
  return {
    width: scale(node.width, ratioX, bounds.minWidth, bounds.maxWidth),
    height: scale(node.height, ratioY, bounds.minHeight, bounds.maxHeight),
  };
}

/** 画幅像素上下限：太小导不出、太大 canvas 会吃爆内存。 */
const CANVAS_MIN_EDGE = 64;
const CANVAS_MAX_EDGE = 8192;

function clampCanvasEdge(edge: number): number {
  return Math.min(CANVAS_MAX_EDGE, Math.max(CANVAS_MIN_EDGE, edge));
}

/**
 * 拖节点边框 → 只改画幅尺寸，图层坐标与尺寸一律**不动**。
 *
 * 按轴等比缩放画幅：节点宽了 r 倍，画幅宽也跟着宽 r 倍，两边一起变，
 * 于是 `图层宽 / 画幅宽` 这个占比恒定 —— 每张图在节点上的位置、大小一个像素都不变，
 * 多出来的只是右侧/下方的空白画布（往里拖就是裁掉）。即梦图层编辑就是这个手感。
 *
 * 早先的写法是反过来把图层跟着画幅一起缩放，等于把整张图拉大 / 压扁，
 * 所以一拖边框画面就「跑」，圆图还会被拉成椭圆。
 */
export function scaleCanvasForNodeResize(
  previousNode: { width: number; height: number },
  nextNode: { width: number; height: number },
  canvasWidth: number,
  canvasHeight: number,
): { width: number; height: number } | null {
  const ratioX = previousNode.width > 0 ? nextNode.width / previousNode.width : 1;
  const ratioY = previousNode.height > 0 ? nextNode.height / previousNode.height : 1;
  if (!Number.isFinite(ratioX) || !Number.isFinite(ratioY) || ratioX <= 0 || ratioY <= 0) return null;

  const current = { width: Math.round(canvasWidth), height: Math.round(canvasHeight) };
  const scaledWidth = Math.round(canvasWidth * ratioX);
  const scaledHeight = Math.round(canvasHeight * ratioY);
  // 该轴没变就保持原值，避免把本来就超界的旧画幅顺手裁一刀。
  const width = scaledWidth === current.width ? current.width : clampCanvasEdge(scaledWidth);
  const height = scaledHeight === current.height ? current.height : clampCanvasEdge(scaledHeight);
  if (width === current.width && height === current.height) return null;
  return { width, height };
}
