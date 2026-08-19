import type { CanvasEdge, CanvasNode } from '../domain/canvasNodes';

const DEFAULT_NODE_WIDTH = 220;
const DEFAULT_NODE_HEIGHT = 200;
const H_GAP = 130;
const V_GAP = 60;
const START_X = 40;
const START_Y = 40;

function getNodeSize(node: CanvasNode): { width: number; height: number } {
  const width = typeof node.measured?.width === 'number'
    ? node.measured.width
    : typeof node.width === 'number'
      ? node.width
      : DEFAULT_NODE_WIDTH;
  const height = typeof node.measured?.height === 'number'
    ? node.measured.height
    : typeof node.height === 'number'
      ? node.height
      : DEFAULT_NODE_HEIGHT;
  return {
    width: width > 0 ? width : DEFAULT_NODE_WIDTH,
    height: height > 0 ? height : DEFAULT_NODE_HEIGHT,
  };
}

/** 沿 parentId 链向上找顶层节点 id(组内子节点提升到组节点) */
function resolveTopLevelId(nodeId: string, nodeMap: Map<string, CanvasNode>): string {
  let current = nodeId;
  let guard = 0;
  while (guard < 64) {
    guard += 1;
    const node = nodeMap.get(current);
    if (!node || !node.parentId) {
      return current;
    }
    current = node.parentId;
  }
  return current;
}

/**
 * 画布自动布局: 左→右拓扑分层。
 * - 只布局顶层节点(无 parentId); 组内子节点保持相对位置, 随组节点整体移动。
 * - 边会提升到顶层祖先, 组内节点的连线也参与组之间的布局。
 * - 孤立节点与无依赖节点排在最左列; 循环依赖兜底按剩余顺序排新层。
 */
export function computeAutoLayout(
  nodes: CanvasNode[],
  edges: CanvasEdge[]
): Map<string, { x: number; y: number }> {
  const nodeMap = new Map(nodes.map((node) => [node.id, node] as const));
  const topLevelNodes = nodes.filter((node) => !node.parentId);
  const positions = new Map<string, { x: number; y: number }>();

  if (topLevelNodes.length === 0) {
    return positions;
  }

  const adjacency = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const node of topLevelNodes) {
    adjacency.set(node.id, []);
    indegree.set(node.id, 0);
  }

  for (const edge of edges) {
    const source = resolveTopLevelId(edge.source, nodeMap);
    const target = resolveTopLevelId(edge.target, nodeMap);
    if (source === target) {
      continue;
    }
    if (!adjacency.has(source) || !indegree.has(target)) {
      continue;
    }
    const targets = adjacency.get(source) as string[];
    if (!targets.includes(target)) {
      targets.push(target);
      indegree.set(target, (indegree.get(target) ?? 0) + 1);
    }
  }

  // Kahn 拓扑分层
  const layer = new Map<string, number>();
  const queue: string[] = [];
  for (const node of topLevelNodes) {
    if ((indegree.get(node.id) ?? 0) === 0) {
      layer.set(node.id, 0);
      queue.push(node.id);
    }
  }

  let head = 0;
  const processed = new Set<string>();
  while (head < queue.length) {
    const id = queue[head];
    head += 1;
    processed.add(id);
    const currentLayer = layer.get(id) ?? 0;
    for (const target of adjacency.get(id) ?? []) {
      indegree.set(target, (indegree.get(target) ?? 0) - 1);
      layer.set(target, Math.max(layer.get(target) ?? 0, currentLayer + 1));
      if ((indegree.get(target) ?? 0) === 0 && !processed.has(target)) {
        queue.push(target);
      }
    }
  }

  // 循环依赖/剩余节点兜底
  let maxLayer = 0;
  layer.forEach((value) => {
    maxLayer = Math.max(maxLayer, value);
  });
  for (const node of topLevelNodes) {
    if (!layer.has(node.id)) {
      maxLayer += 1;
      layer.set(node.id, maxLayer);
    }
  }

  // 组装层(层内按节点原始顺序稳定排列)
  const layerBuckets = new Map<number, string[]>();
  layer.forEach((layerIndex, nodeId) => {
    const bucket = layerBuckets.get(layerIndex) ?? [];
    bucket.push(nodeId);
    layerBuckets.set(layerIndex, bucket);
  });
  const originalOrder = new Map(nodes.map((node, index) => [node.id, index] as const));
  layerBuckets.forEach((bucket) => {
    bucket.sort((a, b) => (originalOrder.get(a) ?? 0) - (originalOrder.get(b) ?? 0));
  });

  // 计算位置: 同层纵向排列, 层间横向推进
  let cursorX = START_X;
  const layerKeys = Array.from(layerBuckets.keys()).sort((a, b) => a - b);
  for (const layerIndex of layerKeys) {
    const bucket = layerBuckets.get(layerIndex) as string[];
    let cursorY = START_Y;
    let maxWidth = 0;
    for (const nodeId of bucket) {
      const node = nodeMap.get(nodeId);
      const size = node ? getNodeSize(node) : { width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT };
      positions.set(nodeId, { x: Math.round(cursorX), y: Math.round(cursorY) });
      cursorY += size.height + V_GAP;
      maxWidth = Math.max(maxWidth, size.width);
    }
    cursorX += maxWidth + H_GAP;
  }

  return positions;
}

export type NodeAlignMode =
  | 'left'
  | 'centerH'
  | 'right'
  | 'top'
  | 'centerV'
  | 'bottom'
  | 'distributeH'
  | 'distributeV';

export interface AlignableItem {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 计算选中节点的对齐目标位置(绝对坐标)。等距分布按中心点排序。 */
export function computeAlignment(
  items: AlignableItem[],
  mode: NodeAlignMode
): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  if (items.length === 0) {
    return result;
  }

  const minX = Math.min(...items.map((item) => item.x));
  const minY = Math.min(...items.map((item) => item.y));
  const maxX = Math.max(...items.map((item) => item.x + item.width));
  const maxY = Math.max(...items.map((item) => item.y + item.height));
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  if (mode === 'distributeH' || mode === 'distributeV') {
    const sorted = [...items].sort((a, b) =>
      mode === 'distributeH' ? a.x - b.x : a.y - b.y
    );
    if (sorted.length === 1) {
      result.set(sorted[0].id, { x: sorted[0].x, y: sorted[0].y });
      return result;
    }

    if (mode === 'distributeH') {
      const totalWidth = sorted.reduce((sum, item) => sum + item.width, 0);
      const span = maxX - minX;
      const gap = Math.max(0, (span - totalWidth) / (sorted.length - 1));
      let cursorX = minX;
      for (const item of sorted) {
        result.set(item.id, { x: Math.round(cursorX), y: item.y });
        cursorX += item.width + gap;
      }
    } else {
      const totalHeight = sorted.reduce((sum, item) => sum + item.height, 0);
      const span = maxY - minY;
      const gap = Math.max(0, (span - totalHeight) / (sorted.length - 1));
      let cursorY = minY;
      for (const item of sorted) {
        result.set(item.id, { x: item.x, y: Math.round(cursorY) });
        cursorY += item.height + gap;
      }
    }
    return result;
  }

  for (const item of items) {
    let nextX = item.x;
    let nextY = item.y;
    switch (mode) {
      case 'left':
        nextX = minX;
        break;
      case 'centerH':
        nextX = centerX - item.width / 2;
        break;
      case 'right':
        nextX = maxX - item.width;
        break;
      case 'top':
        nextY = minY;
        break;
      case 'centerV':
        nextY = centerY - item.height / 2;
        break;
      case 'bottom':
        nextY = maxY - item.height;
        break;
      default:
        break;
    }
    result.set(item.id, { x: Math.round(nextX), y: Math.round(nextY) });
  }

  // 防重叠: 水平对齐(left/centerH/right)只动 x, y 尽量保持;
  // 若对齐后纵向重叠, 按原始相对顺序自动错开, 保证画面不叠在一起。
  if (mode === 'left' || mode === 'centerH' || mode === 'right') {
    resolveNonOverlapAlongY(items, result);
  } else if (mode === 'top' || mode === 'centerV' || mode === 'bottom') {
    resolveNonOverlapAlongX(items, result);
  }

  return result;
}

const ALIGN_OVERLAP_GAP = 24;

/** 沿 y 方向防重叠: 保持原始上下相对顺序, 仅在与已放置节点 x/y 均重叠时下移错开 */
function resolveNonOverlapAlongY(
  items: AlignableItem[],
  positions: Map<string, { x: number; y: number }>
): void {
  const sorted = [...items].sort(
    (a, b) => (positions.get(a.id)?.y ?? a.y) - (positions.get(b.id)?.y ?? b.y)
  );
  const placed: Array<{ left: number; right: number; top: number; bottom: number }> = [];
  for (const item of sorted) {
    const pos = positions.get(item.id) as { x: number; y: number };
    let top = pos.y;
    for (const region of placed) {
      const overlapsX = pos.x < region.right && pos.x + item.width > region.left;
      if (overlapsX && top < region.bottom && top + item.height > region.top) {
        top = region.bottom + ALIGN_OVERLAP_GAP;
      }
    }
    positions.set(item.id, { x: pos.x, y: Math.round(top) });
    placed.push({ left: pos.x, right: pos.x + item.width, top, bottom: top + item.height });
  }
}

/** 沿 x 方向防重叠: 保持原始左右相对顺序, 仅在与已放置节点 x/y 均重叠时右移错开 */
function resolveNonOverlapAlongX(
  items: AlignableItem[],
  positions: Map<string, { x: number; y: number }>
): void {
  const sorted = [...items].sort(
    (a, b) => (positions.get(a.id)?.x ?? a.x) - (positions.get(b.id)?.x ?? b.x)
  );
  const placed: Array<{ left: number; right: number; top: number; bottom: number }> = [];
  for (const item of sorted) {
    const pos = positions.get(item.id) as { x: number; y: number };
    let left = pos.x;
    for (const region of placed) {
      const overlapsY = pos.y < region.bottom && pos.y + item.height > region.top;
      if (overlapsY && left < region.right && left + item.width > region.left) {
        left = region.right + ALIGN_OVERLAP_GAP;
      }
    }
    positions.set(item.id, { x: Math.round(left), y: pos.y });
    placed.push({ left, right: left + item.width, top: pos.y, bottom: pos.y + item.height });
  }
}

/** 智能吸附阈值(px): 与附近节点/组边框边缘或中心线距离小于该值才吸附 */
export const SMART_SNAP_THRESHOLD = 24;

/**
 * 边缘贴合时保留的间隙(px): 右缘贴左缘 / 左缘贴右缘 / 上下贴合时中间留一点空隙。
 * 不宜过大——间隙大于节点原有间距会把近的节点"推远"; 8px 既能避免贴死,
 * 又能让 4 个同尺寸方块整理后拼成整齐方阵(横平竖直)。
 */
export const SNAP_EDGE_GAP = 8;

interface SnapBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
}

/**
 * 全画布智能对齐 + 防重叠:
 * - 只布局顶层节点(组内子节点随组节点整体移动, 不单独吸附);
 * - 按 y 顺序贪心处理: 先处理的节点作为固定基准(自身不动, 也不被后续节点拉动),
 *   后续节点吸附到「已固定节点/组边框」的边缘或中心线(左/中/右、上/中/下),
 *   距离小于阈值(SMART_SNAP_THRESHOLD)才吸附;
 * - 保持节点原有上下相对顺序, 对齐后若有纵向重叠则自动下移错开, 保证不叠在一起。
 * 返回 nodeId -> 绝对坐标(与 computeAlignment 的返回值形式一致)。
 */
export function computeSmartSnapLayout(
  nodes: CanvasNode[],
  threshold = SMART_SNAP_THRESHOLD
): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  const snap = threshold > 0 ? threshold : SMART_SNAP_THRESHOLD;
  const topLevelNodes = nodes.filter((node) => !node.parentId);
  if (topLevelNodes.length < 2) {
    return result;
  }

  // 快照所有顶层节点的包围盒(基于当前绝对坐标)
  const boxes = new Map<string, SnapBox>();
  for (const node of topLevelNodes) {
    const size = getNodeSize(node);
    const left = node.position.x;
    const top = node.position.y;
    boxes.set(node.id, {
      left,
      right: left + size.width,
      top,
      bottom: top + size.height,
      cx: left + size.width / 2,
      cy: top + size.height / 2,
      width: size.width,
      height: size.height,
    });
  }

  // 初始化: 全部节点保持原位(防重叠逻辑需要每个节点都有条目)
  for (const node of topLevelNodes) {
    const box = boxes.get(node.id) as SnapBox;
    result.set(node.id, { x: Math.round(box.left), y: Math.round(box.top) });
  }

  // 按 y 排序保证处理顺序确定且稳定(水平并排节点保持原始相对顺序)
  const ordered = topLevelNodes
    .slice()
    .sort((a, b) => (boxes.get(a.id) as SnapBox).top - (boxes.get(b.id) as SnapBox).top);

  // 已固定节点的最终包围盒(作为后续节点的吸附参考线)
  const fixed: SnapBox[] = [];

  for (const node of ordered) {
    const self = boxes.get(node.id) as SnapBox;
    let targetX: number | null = null;
    let targetY: number | null = null;
    let bestXDist = snap + 1;
    let bestYDist = snap + 1;

    for (const other of fixed) {
      const xCandidates: Array<[number, number]> = [
        // self.left 对齐 other 的 left / cx / right(右缘贴左缘时留 SNAP_EDGE_GAP 空隙) → 目标 x
        [other.left, Math.abs(self.left - other.left)],
        [other.cx - self.width / 2, Math.abs(self.left - other.cx)],
        [other.right + SNAP_EDGE_GAP, Math.abs(self.left - other.right)],
        // self.cx 对齐 other 的 left / cx / right → 目标 x
        [other.left - self.width / 2, Math.abs(self.cx - other.left)],
        [other.cx - self.width / 2, Math.abs(self.cx - other.cx)],
        [other.right - self.width / 2, Math.abs(self.cx - other.right)],
        // self.right 对齐 other 的 left(留 SNAP_EDGE_GAP 空隙) / cx / right → 目标 x
        [other.left - self.width - SNAP_EDGE_GAP, Math.abs(self.right - other.left)],
        [other.cx - self.width / 2, Math.abs(self.right - other.cx)],
        [other.right - self.width, Math.abs(self.right - other.right)],
      ];
      for (const [target, dist] of xCandidates) {
        if (dist < bestXDist) {
          bestXDist = dist;
          targetX = target;
        }
      }

      const yCandidates: Array<[number, number]> = [
        // self.top 对齐 other 的 top / cy / bottom(下缘贴上缘时留空隙) → 目标 y
        [other.top, Math.abs(self.top - other.top)],
        [other.cy - self.height / 2, Math.abs(self.top - other.cy)],
        [other.bottom + SNAP_EDGE_GAP, Math.abs(self.top - other.bottom)],
        // self.cy 对齐 other 的 top / cy / bottom → 目标 y
        [other.top - self.height / 2, Math.abs(self.cy - other.top)],
        [other.cy - self.height / 2, Math.abs(self.cy - other.cy)],
        [other.bottom - self.height / 2, Math.abs(self.cy - other.bottom)],
        // self.bottom 对齐 other 的 top(留空隙) / cy / bottom → 目标 y
        [other.top - self.height - SNAP_EDGE_GAP, Math.abs(self.bottom - other.top)],
        [other.cy - self.height / 2, Math.abs(self.bottom - other.cy)],
        [other.bottom - self.height, Math.abs(self.bottom - other.bottom)],
      ];
      for (const [target, dist] of yCandidates) {
        if (dist < bestYDist) {
          bestYDist = dist;
          targetY = target;
        }
      }
    }

    if (targetX !== null || targetY !== null) {
      result.set(node.id, {
        x: targetX !== null ? Math.round(targetX) : Math.round(self.left),
        y: targetY !== null ? Math.round(targetY) : Math.round(self.top),
      });
    }

    // 用最终位置加入固定参考(后续节点吸到实际位置)
    const final = result.get(node.id) as { x: number; y: number };
    fixed.push({
      left: final.x,
      right: final.x + self.width,
      top: final.y,
      bottom: final.y + self.height,
      cx: final.x + self.width / 2,
      cy: final.y + self.height / 2,
      width: self.width,
      height: self.height,
    });
  }

  // 防重叠: 保持上下相对顺序, 重叠时下移错开
  const items: AlignableItem[] = topLevelNodes.map((node) => {
    const box = boxes.get(node.id) as SnapBox;
    const pos = result.get(node.id) as { x: number; y: number };
    return {
      id: node.id,
      x: pos.x,
      y: pos.y,
      width: box.width,
      height: box.height,
    };
  });
  resolveNonOverlapAlongY(items, result);
  return result;
}
