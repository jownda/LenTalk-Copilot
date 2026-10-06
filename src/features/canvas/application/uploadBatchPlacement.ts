import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';

/** 一次导入多个素材时的排列间距, 与画布「下游节点」既有间距保持一致。 */
export const UPLOAD_BATCH_GAP = 24;

/**
 * 与既有节点判定贴靠的最小间隙: 距离小于该值才算「叠在一起」。
 * 比排列间距小, 避免落点只是靠近既有节点就被整块推走。
 */
export const UPLOAD_BATCH_COLLISION_GAP = 12;

/** 单行最多放几个节点。 */
export const UPLOAD_BATCH_MAX_COLUMNS = 3;

/** 网格整块避让的最大轮数, 防止异常画布数据造成死循环。 */
const MAX_AVOID_PASSES = 64;

export interface UploadBatchItemSize {
  width: number;
  height: number;
}

export interface UploadBatchRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface UploadBatchPlacementOptions {
  /** 网格左上角的基准点(画布绝对坐标)。 */
  anchor: { x: number; y: number };
  /** 待放置素材各自的占位尺寸, 按期望的排列顺序传入。 */
  items: UploadBatchItemSize[];
  /** 画布上已被占用的矩形(节点绝对坐标), 用于整块避让。 */
  occupied?: UploadBatchRect[];
  /** 网格间距, 默认 {@link UPLOAD_BATCH_GAP}。 */
  gap?: number;
  /** 单行最多几个, 默认 {@link UPLOAD_BATCH_MAX_COLUMNS}。 */
  maxColumns?: number;
}

function resolvePositiveDimension(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return fallback;
}

/**
 * 列数规则: 取「接近正方形」的最小列数, 再受单行上限约束。
 * 1→1、2→2、3→2、4→2、5→3、6→3、7~9→3, 超过 9 也维持 3 列。
 */
export function resolveUploadBatchColumnCount(count: number, maxColumns = UPLOAD_BATCH_MAX_COLUMNS): number {
  if (count <= 0) {
    return 0;
  }
  const limit = Math.max(1, Math.floor(resolvePositiveDimension(maxColumns, UPLOAD_BATCH_MAX_COLUMNS)));
  return Math.max(1, Math.min(limit, Math.ceil(Math.sqrt(count))));
}

/** 两个矩形在允许的最小间隙内是否发生干涉。 */
function intersectsWithGap(first: UploadBatchRect, second: UploadBatchRect, gap: number): boolean {
  return (
    first.x < second.x + second.width + gap
    && first.x + first.width + gap > second.x
    && first.y < second.y + second.height + gap
    && first.y + first.height + gap > second.y
  );
}

/**
 * 把一批素材排成对齐网格, 并整体避让画布上已有节点。
 *
 * 规则:
 * - 所有单元格取批次内的最大宽高(统一单元格), 因此行、列都严格对齐;
 * - 按行优先(左→右, 上→下)填充, 列数由 {@link resolveUploadBatchColumnCount} 决定;
 * - 整块与已有节点干涉时, 只把**整个网格**向下推到冲突节点的下方,
 *   保持网格本身的横平竖直 —— 逐个节点错开会把方阵打散, 反而不"对齐";
 * - 返回值为画布绝对坐标, 顺序与 `items` 一致。
 */
export function resolveUploadBatchPositions(options: UploadBatchPlacementOptions): Array<{ x: number; y: number }> {
  const { anchor, items } = options;
  if (items.length === 0) {
    return [];
  }

  const gap = resolvePositiveDimension(options.gap, UPLOAD_BATCH_GAP);
  const columns = resolveUploadBatchColumnCount(items.length, options.maxColumns);
  const cellWidth = Math.max(...items.map((item) => item.width));
  const cellHeight = Math.max(...items.map((item) => item.height));
  const rows = Math.ceil(items.length / columns);
  const blockWidth = columns * cellWidth + (columns - 1) * gap;
  const blockHeight = rows * cellHeight + (rows - 1) * gap;

  const occupied = options.occupied ?? [];
  const blockX = Math.round(anchor.x);
  let blockY = Math.round(anchor.y);

  // 向下推是单调的, 且上界是所有冲突节点的底部, 因此每轮只会更靠下, 必然收敛。
  for (let pass = 0; pass < MAX_AVOID_PASSES; pass += 1) {
    const block: UploadBatchRect = { x: blockX, y: blockY, width: blockWidth, height: blockHeight };
    let nextY = blockY;
    for (const rect of occupied) {
      if (!intersectsWithGap(block, rect, UPLOAD_BATCH_COLLISION_GAP)) {
        continue;
      }
      nextY = Math.max(nextY, rect.y + rect.height + gap);
    }
    if (nextY === blockY) {
      break;
    }
    blockY = Math.round(nextY);
  }

  return items.map((_, index) => ({
    x: blockX + (index % columns) * (cellWidth + gap),
    y: blockY + Math.floor(index / columns) * (cellHeight + gap),
  }));
}

/**
 * 收集画布上所有节点的占位矩形(绝对坐标)。
 * 组内子节点先沿 `parentId` 链累加出绝对坐标, 否则会被当成画布原点的挡板。
 */
export function collectCanvasOccupiedRects(
  nodes: CanvasNode[],
  fallbackWidth: number,
  fallbackHeight: number,
): UploadBatchRect[] {
  const nodeMap = new Map(nodes.map((node) => [node.id, node] as const));
  const resolveAbsolute = (node: CanvasNode): { x: number; y: number } => {
    let x = 0;
    let y = 0;
    let current: CanvasNode | undefined = node;
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      x += current.position.x;
      y += current.position.y;
      current = current.parentId ? nodeMap.get(current.parentId) : undefined;
    }
    return { x, y };
  };

  return nodes.map((node) => {
    const style = node.style as { width?: unknown; height?: unknown } | undefined;
    const absolute = resolveAbsolute(node);
    return {
      x: absolute.x,
      y: absolute.y,
      width: resolvePositiveDimension(node.measured?.width ?? node.width ?? style?.width, fallbackWidth),
      height: resolvePositiveDimension(node.measured?.height ?? node.height ?? style?.height, fallbackHeight),
    };
  });
}
