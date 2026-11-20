/**
 * 图片编辑器的「选择工具」选区数据模型与几何计算。
 *
 * 只做纯几何：选区是一段闭合路径（矩形 / 椭圆 / 自由套索），画布坐标（像素）。
 * 蚂蚁线渲染、布尔运算、局部修改各自消费这里的几何，不掺 React 状态。
 */

/** 选区的一种形状。矩形/椭圆由两个对角点确定，套索由一串锚点构成。 */
export type SelectionShape =
  | { kind: "rect"; x: number; y: number; width: number; height: number }
  | { kind: "ellipse"; x: number; y: number; width: number; height: number }
  | { kind: "lasso"; points: Array<{ x: number; y: number }> };

export interface Selection {
  shape: SelectionShape;
  /** 羽化半径（画布像素），0 = 硬边。 */
  feather: number;
}

/** 由两个对角点归一化出矩形（保证 width/height >= 0）。 */
export function rectFromPoints(ax: number, ay: number, bx: number, by: number): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    width: Math.abs(bx - ax),
    height: Math.abs(by - ay),
  };
}

/**
 * 判断一个点是否落在选区内（画布像素坐标）。
 *
 * 羽化不算在内：羽化只影响「修改的作用强度」，不影响「选没选中」。
 * 布尔运算与删除命中判定都用这个。
 */
export function selectionContainsPoint(selection: Selection | null, px: number, py: number): boolean {
  if (!selection) {
    return false;
  }
  const shape = selection.shape;
  if (shape.kind === "rect") {
    return px >= shape.x && px <= shape.x + shape.width && py >= shape.y && py <= shape.y + shape.height;
  }
  if (shape.kind === "ellipse") {
    const cx = shape.x + shape.width / 2;
    const cy = shape.y + shape.height / 2;
    const rx = Math.max(1e-6, shape.width / 2);
    const ry = Math.max(1e-6, shape.height / 2);
    const nx = (px - cx) / rx;
    const ny = (py - cy) / ry;
    return nx * nx + ny * ny <= 1;
  }
  // 套索：射线法（point-in-polygon）。
  const points = shape.points;
  if (points.length < 3) {
    return false;
  }
  let inside = false;
  // 标准射线法：j 指向前一条边的起点，i 指向当前边。必须 `j = i, i++`（先取旧值再自增），
  // 写成 `j = i += 1` 会让 j 和 i 指向同一个点，每条边都退化成「点自己」，永远不命中。
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const xi = points[i].x;
    const yi = points[i].y;
    const xj = points[j].x;
    const yj = points[j].y;
    const intersect =
      yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * 选区在画布坐标下的闭合轮廓路径（`Path2D`）。
 *
 * 渲染蚂蚁线、`clip()` 局部调色、`destination-out` 删除都用这一条路径，
 * 保证「看到的」和「实际作用到的」是同一个范围。
 */
export function selectionToPath2D(selection: Selection): Path2D {
  const path = new Path2D();
  const shape = selection.shape;
  if (shape.kind === "rect") {
    path.rect(shape.x, shape.y, shape.width, shape.height);
    return path;
  }
  if (shape.kind === "ellipse") {
    path.ellipse(
      shape.x + shape.width / 2,
      shape.y + shape.height / 2,
      shape.width / 2,
      shape.height / 2,
      0,
      0,
      Math.PI * 2,
    );
    return path;
  }
  const points = shape.points;
  if (points.length > 0) {
    path.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) {
      path.lineTo(points[i].x, points[i].y);
    }
    path.closePath();
  }
  return path;
}

/** 选区轮廓的边界框（用于缩放/命中判定等）。 */
export function selectionBounds(selection: Selection): { x: number; y: number; width: number; height: number } {
  const shape = selection.shape;
  if (shape.kind === "rect" || shape.kind === "ellipse") {
    return { x: shape.x, y: shape.y, width: shape.width, height: shape.height };
  }
  const points = shape.points;
  if (points.length === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** 选区是否「空」（没有可作用的范围）。 */
export function isSelectionEmpty(selection: Selection | null): boolean {
  if (!selection) {
    return true;
  }
  const bounds = selectionBounds(selection);
  return bounds.width < 1 || bounds.height < 1;
}

/** 布尔运算模式：新选区与旧选区的组合方式（对应 Photoshop 的 Shift / Alt / Shift+Alt）。 */
export type SelectionCombine = "new" | "add" | "subtract" | "intersect";

/**
 * 选区掩码：`data` 是 alpha 通道（0 = 未选，255 = 选中），`width/height` 是画布尺寸。
 *
 * 用纯 `Uint8ClampedArray` 而非 canvas，是为了能在 node 测试环境直接验证，
 * 与 `mosaicAdjust` 的 `applyAdjustToImageData` 同一套模式。运行时再 `putImageData` 落地。
 */
export interface Mask {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

function createMask(canvasWidth: number, canvasHeight: number): Mask {
  const width = Math.max(1, Math.round(canvasWidth));
  const height = Math.max(1, Math.round(canvasHeight));
  return { width, height, data: new Uint8ClampedArray(width * height) };
}

/** 把选区栅格化成掩码（alpha 255 = 选中），羽化用 box blur 实现软边。 */
export function selectionToMask(
  selection: Selection,
  canvasWidth: number,
  canvasHeight: number,
): Mask {
  const mask = createMask(canvasWidth, canvasHeight);
  const { width, height, data } = mask;

  // 逐像素判定是否在选区内（矩形/椭圆/套索都复用 selectionContainsPoint 的语义）。
  const bounds = selectionBounds(selection);
  const x0 = Math.max(0, Math.floor(bounds.x - selection.feather));
  const y0 = Math.max(0, Math.floor(bounds.y - selection.feather));
  const x1 = Math.min(width, Math.ceil(bounds.x + bounds.width + selection.feather));
  const y1 = Math.min(height, Math.ceil(bounds.y + bounds.height + selection.feather));
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      if (selectionContainsPoint(selection, x + 0.5, y + 0.5)) {
        data[y * width + x] = 255;
      }
    }
  }

  if (selection.feather > 0) {
    return blurMask(mask, selection.feather);
  }
  return mask;
}

/** box blur：连续多次 3×3 均值模糊，近似高斯，实现羽化软边。 */
function blurMask(mask: Mask, radius: number): Mask {
  const { width, height, data } = mask;
  const out = new Uint8ClampedArray(data);
  const passes = Math.max(1, Math.round(radius));
  for (let pass = 0; pass < passes; pass += 1) {
    const src = pass % 2 === 0 ? data : out;
    const dst = pass % 2 === 0 ? out : data;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let sum = 0;
        let count = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < width && ny < height) {
              sum += src[ny * width + nx];
              count += 1;
            }
          }
        }
        dst[y * width + x] = Math.round(sum / count);
      }
    }
  }
  // 确保最终结果在 out 里
  if (passes % 2 === 1) {
    mask.data.set(out);
  }
  return mask;
}

/** 掩码布尔运算：加 / 减 / 交。逐像素 alpha 组合。 */
export function combineSelectionMasks(
  previous: Mask | null,
  next: Mask,
  combine: SelectionCombine,
): Mask {
  const width = next.width;
  const height = next.height;
  if (combine === "new" || !previous) {
    return { width, height, data: new Uint8ClampedArray(next.data) };
  }
  const out = createMask(width, height);
  const a = previous.data;
  const b = next.data;
  for (let i = 0; i < a.length; i += 1) {
    if (combine === "add") {
      out.data[i] = Math.max(a[i], b[i]);
    } else if (combine === "subtract") {
      out.data[i] = b[i] >= 128 ? 0 : a[i];
    } else {
      // intersect
      out.data[i] = Math.min(a[i], b[i]);
    }
  }
  return out;
}

/** 反选：选中区变未选，未选区变选中。 */
export function invertSelectionMask(mask: Mask): Mask {
  const out = createMask(mask.width, mask.height);
  for (let i = 0; i < mask.data.length; i += 1) {
    out.data[i] = mask.data[i] >= 128 ? 0 : 255;
  }
  return out;
}

/**
 * 从掩码提取轮廓点集（供蚂蚁线显示布尔运算后的真实边界）。
 *
 * 凡「自己选中、相邻（上下左右）未选中」的像素就是边界点。返回无序点集，
 * 蚂蚁线按点阵直接描即可。
 */
export function maskToBoundaryPoints(mask: Mask, step = 1): Array<{ x: number; y: number }> {
  const { width, height, data } = mask;
  const selected = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= width || y >= height) {
      return false;
    }
    return data[y * width + x] >= 128;
  };
  const points: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      if (!selected(x, y)) {
        continue;
      }
      const edge =
        !selected(x - step, y) || !selected(x + step, y) || !selected(x, y - step) || !selected(x, y + step);
      if (edge) {
        points.push({ x, y });
      }
    }
  }
  return points;
}

/**
 * 掩码 → 数据 URL（供运行时落地到 canvas 或局部调色用）。
 * 只保留 alpha 有意义，RGB 全白即可，消费方用 alpha 通道。
 */
export function maskToDataUrl(mask: Mask): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = mask.width;
  canvas.height = mask.height;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const imageData = ctx.createImageData(mask.width, mask.height);
    for (let i = 0; i < mask.data.length; i += 1) {
      imageData.data[i * 4] = 255;
      imageData.data[i * 4 + 1] = 255;
      imageData.data[i * 4 + 2] = 255;
      imageData.data[i * 4 + 3] = mask.data[i];
    }
    ctx.putImageData(imageData, 0, 0);
  }
  return canvas;
}

/**
 * 把「画布坐标」的掩码裁剪成「图层局部坐标」的掩码数据 URL。
 *
 * 局部调色要把选区作用到单个图层，而图层有 x/y 偏移 —— 这里把掩码整体平移到
 * 图层框，裁出图层框范围，返回 data URL。渲染时按图层局部坐标直接取 alpha。
 */
export function maskToLayerDataUrl(
  mask: Mask,
  layerX: number,
  layerY: number,
  layerWidth: number,
  layerHeight: number,
): string {
  const w = Math.max(1, Math.round(layerWidth));
  const h = Math.max(1, Math.round(layerHeight));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return "";
  }
  const source = maskToDataUrl(mask);
  // 掩码原点是画布原点，图层框在 (layerX, layerY)：向左上平移。
  ctx.drawImage(source, -layerX, -layerY);
  return canvas.toDataURL("image/png");
}
