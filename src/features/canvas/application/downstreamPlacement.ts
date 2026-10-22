/**
 * 下游节点落位。
 *
 * 之前是内联在 store 里的「环形搜索」：一旦同排右侧碰到挡板，就把候选点推到
 * 「挡板右缘 + 间距」。挡板只要是个宽东西（分组、分镜、工作室面板），新节点就
 * 被甩到很右边 —— 用户看到的是「明明右边还有空间，节点却跑到很远的地方」。
 *
 * 这里换成**就近取位**：先同排右侧，再在允许跨度内跨过矮挡板，再同一列往下，
 * 最后才到来源正下方；横向跨度有上限，绝不为了绕开一个大挡板而飞到远处。
 * 纯函数，便于用单测把「不许乱飞」这条约束钉住。
 */

export interface PlacementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DownstreamPlacementInput {
  /** 来源节点在画布上的绝对矩形 */
  source: PlacementRect;
  /** 待放置节点的尺寸 */
  size: { width: number; height: number };
  /** 画布上其它顶层节点的绝对矩形（不含来源节点与其子节点） */
  obstacles: PlacementRect[];
  /** 已有的下游节点矩形，用于沿用「接在最后一个下游下方」的习惯 */
  downstreamRects?: PlacementRect[];
  /** 节点之间的最小间距 */
  gap?: number;
  /** 允许从「来源右缘 + 间距」再往右跨的最大距离 */
  maxSlide?: number;
  /** 同一列 / 下方最多探几格 */
  maxStack?: number;
}

const DEFAULT_GAP = 8;
const DEFAULT_MAX_STACK = 8;

function intersects(
  x: number,
  y: number,
  size: { width: number; height: number },
  rect: PlacementRect,
): boolean {
  return (
    x < rect.x + rect.width &&
    x + size.width > rect.x &&
    y < rect.y + rect.height &&
    y + size.height > rect.y
  );
}

function isFree(
  x: number,
  y: number,
  size: { width: number; height: number },
  obstacles: PlacementRect[],
): boolean {
  return !obstacles.some((rect) => intersects(x, y, size, rect));
}

/**
 * 计算下游节点落点（画布绝对坐标）。候选顺序：
 * 1. 接在已有下游节点的最下方，左边与第一个下游对齐；
 * 2. 同排右侧（来源右缘 + 间距）；
 * 3. 同排向右跨过「挡板右缘未超出允许跨度」的障碍，逐格尝试；
 * 4. 同一列往下（每格 = 一个自身高度 + 间距）；
 * 5. 来源节点正下方，逐行往下；
 * 6. 兜底：右侧继续往外，保证不与已有内容重叠。
 */
export function findDownstreamPlacement({
  source,
  size,
  obstacles,
  downstreamRects = [],
  gap = DEFAULT_GAP,
  maxSlide,
  maxStack = DEFAULT_MAX_STACK,
}: DownstreamPlacementInput): { x: number; y: number } {
  const leftX = source.x + source.width + gap;
  const slideLimit = maxSlide ?? Math.max(size.width, 360);
  const free = (x: number, y: number) => isFree(x, y, size, obstacles);

  // 1) 已有下游：接在最后一个下游节点下方
  if (downstreamRects.length > 0) {
    const first = downstreamRects[0];
    const last = downstreamRects[downstreamRects.length - 1];
    const belowLast = { x: first.x, y: last.y + last.height + gap };
    if (free(belowLast.x, belowLast.y)) {
      return belowLast;
    }
  }

  // 2) 同排右侧
  if (free(leftX, source.y)) {
    return { x: leftX, y: source.y };
  }

  // 3) 同排向右跨过挡板，但只在允许跨度内（跨度上限就是「不许乱飞」的闸门）
  const blockers = obstacles
    .filter(
      (rect) =>
        rect.x + rect.width > leftX &&
        rect.x < leftX + slideLimit + size.width &&
        rect.y < source.y + size.height &&
        rect.y + rect.height > source.y,
    )
    .map((rect) => ({ ...rect, edge: rect.x + rect.width + gap }))
    .filter((rect) => rect.edge - leftX <= slideLimit)
    .sort((a, b) => a.edge - b.edge);
  for (const blocker of blockers) {
    for (let index = 0; index <= maxStack; index += 1) {
      const y = source.y + index * (size.height + gap);
      if (free(blocker.edge, y)) {
        return { x: blocker.edge, y };
      }
    }
  }

  // 4) 同一列往下
  for (let index = 1; index <= maxStack; index += 1) {
    const y = source.y + index * (size.height + gap);
    if (free(leftX, y)) {
      return { x: leftX, y };
    }
  }

  // 5) 来源正下方，逐行往下
  for (let index = 0; index < maxStack; index += 1) {
    const y = source.y + source.height + gap + index * (size.height + gap);
    if (free(source.x, y)) {
      return { x: source.x, y };
    }
  }

  // 6) 兜底：右侧继续往外找，绝不与已有节点重叠
  for (let index = 1; index <= 64; index += 1) {
    const x = leftX + index * (size.width + gap);
    if (free(x, source.y)) {
      return { x, y: source.y };
    }
  }

  return { x: leftX, y: source.y + source.height + gap };
}
