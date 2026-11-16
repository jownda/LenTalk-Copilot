import type { CanvasNode } from "@/features/canvas/domain/canvasNodes";

export interface CanvasPoint {
  x: number;
  y: number;
}

/**
 * 源节点的**绝对**画布坐标。
 *
 * 组内节点的 `position` 存的是相对父节点的局部坐标，直接当画布坐标用会整体错位
 * （粘出来挤到左上角，或者被父节点和自身各加一次偏移）。多层嵌套一路累加到根。
 * 父节点不在表里（比如只复制了组内某个节点、组已删）时，累加到能拿到的那一层为止，
 * 至少不会把局部坐标当成绝对坐标直接落盘。
 */
export function resolveAbsolutePositions(
  sourceNodes: CanvasNode[],
  nodeMap: Map<string, CanvasNode>,
): Map<string, CanvasPoint> {
  const positions = new Map<string, CanvasPoint>();
  for (const node of sourceNodes) {
    let x = 0;
    let y = 0;
    let current: CanvasNode | undefined = node;
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      x += current.position.x;
      y += current.position.y;
      const parentId: string | undefined = current.parentId;
      current = parentId ? nodeMap.get(parentId) : undefined;
    }
    positions.set(node.id, { x, y });
  }
  return positions;
}

/**
 * 选区包围盒的左上角。
 *
 * 粘贴时用它对齐鼠标：整片内容一起平移，节点之间的相对位置一个像素都不动。
 * 以前拿「快照里第一个节点」当锚点 —— 首个节点常常是组内子节点（局部坐标），
 * 于是算出来的偏移量离谱，整片粘到很远的地方去。
 */
export function resolveClipboardOrigin(
  sourceNodes: CanvasNode[],
  absolutePositions: Map<string, CanvasPoint>,
): CanvasPoint {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  for (const node of sourceNodes) {
    const position = absolutePositions.get(node.id);
    if (!position) {
      continue;
    }
    minX = Math.min(minX, position.x);
    minY = Math.min(minY, position.y);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return { x: 0, y: 0 };
  }
  return { x: minX, y: minY };
}

export interface PastePlacement {
  /** 落到新画布上的 `position`：组内节点是相对新父节点的局部坐标。 */
  position: CanvasPoint;
  /** true = 这个节点会挂到同批还原的父节点下，位置因此保持局部坐标。 */
  attachesToNewParent: boolean;
}

/**
 * 算出每个源节点粘贴后的 `position` 与「是否挂在新父节点下」。
 *
 * 规则只有一条：**同一个偏移量作用在所有根节点上，子节点跟着父走**。
 * 子节点如果也加一次偏移，它相对父的位置就会被平移两次（组内布局散架），
 * 所以「父也在这一批里」时原样保留局部坐标。
 */
export function resolvePastePlacements(
  sourceNodes: CanvasNode[],
  absolutePositions: Map<string, CanvasPoint>,
  offset: CanvasPoint,
  copiedIds: Set<string>,
): Map<string, PastePlacement> {
  const placements = new Map<string, PastePlacement>();
  for (const node of sourceNodes) {
    const attachesToNewParent = Boolean(node.parentId && copiedIds.has(node.parentId));
    if (attachesToNewParent) {
      placements.set(node.id, {
        position: { x: node.position.x, y: node.position.y },
        attachesToNewParent,
      });
      continue;
    }
    const absolute = absolutePositions.get(node.id) ?? node.position;
    placements.set(node.id, {
      position: { x: absolute.x + offset.x, y: absolute.y + offset.y },
      attachesToNewParent,
    });
  }
  return placements;
}
