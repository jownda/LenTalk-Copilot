import {
  canvasNodeDefinitions,
  nodeHasSourceHandle,
  nodeHasTargetHandle,
} from '@/features/canvas/domain/nodeRegistry';
import { CANVAS_NODE_TYPES, type CanvasNode, type CanvasNodeType } from '@/features/canvas/domain/canvasNodes';

/** 面板/连线端点的固定 handle id —— 每个画布节点只有一个 source 和一个 target。 */
const SOURCE_HANDLE_ID = 'source';
const TARGET_HANDLE_ID = 'target';

/**
 * 不参与批量连接的节点类型。
 *
 * 目前只有「组」：它体积大，框选时几乎必然被圈进来，而它本身是个容器、不是素材，
 * 顺手连上去不是用户想要的。它自己的 source handle 另有用途（从组派生下游节点），
 * 所以单独拖它的时候照旧按原样连一条，不进批量。
 */
const BATCH_EXCLUDED_TYPES = new Set<CanvasNodeType>([CANVAS_NODE_TYPES.group]);

export type BatchHandleType = 'source' | 'target';

/**
 * 「参与批量」的节点最小形状。
 *
 * 故意放宽成结构类型而不是直接要 `CanvasNode`：拖拽过程中的幽灵线跑在 React Flow 的
 * `connectionLineComponent` 里，那里能拿到的是 React Flow 内部节点（`type` 是 `string`），
 * 用它凑不出 `CanvasNode`。判据本身只依赖 id / type / selected，抽到这里两边都能用。
 */
export interface BatchCandidateNode {
  id: string;
  type?: string;
  selected?: boolean;
}

function isBatchExcluded(type: string | undefined): boolean {
  return type !== undefined && BATCH_EXCLUDED_TYPES.has(type as CanvasNodeType);
}

/** 节点有没有指定方向的端口；`type` 可能是任意字符串（React Flow 内部节点），先做一次收窄。 */
function hasHandleOfType(type: string | undefined, handleType: BatchHandleType): boolean {
  if (!type || !(type in canvasNodeDefinitions)) {
    return false;
  }
  const canvasType = type as CanvasNodeType;
  return handleType === 'source' ? nodeHasSourceHandle(canvasType) : nodeHasTargetHandle(canvasType);
}

/**
 * 「用户拖的那一端」实际会被连上的节点（**含锚点自身，含顺序**）。
 *
 * 这是批量连接唯一的候选判定，两个地方共用：
 * - `buildBatchConnections` —— 松手后真正落地几条边；
 * - 拖拽过程中的幽灵线 —— 拉出来就该是几条线。
 *
 * 两者共用一份判据，才能保证「看到几条线就落地几条边」，不会出现视觉与结果对不上。
 * 未框选、或锚点本身被排除（组）时只返回锚点自己 —— 批量退化成单条，视觉上也不该多出线。
 */
export function resolveBatchAnchorCandidates<N extends BatchCandidateNode>({
  anchorNodeId,
  anchorHandleType,
  nodes,
}: {
  anchorNodeId: string;
  anchorHandleType: BatchHandleType;
  nodes: N[];
}): N[] {
  const anchorNode = nodes.find((node) => node.id === anchorNodeId);
  if (!anchorNode) {
    return [];
  }

  const canBatch = Boolean(anchorNode.selected) && !isBatchExcluded(anchorNode.type);
  if (!canBatch) {
    return [anchorNode];
  }

  const result: N[] = [];
  const seen = new Set<string>();

  for (const node of nodes) {
    if (!node.selected || isBatchExcluded(node.type)) {
      continue;
    }
    if (seen.has(node.id)) {
      continue;
    }
    if (!hasHandleOfType(node.type, anchorHandleType)) {
      continue;
    }
    seen.add(node.id);
    result.push(node);
  }

  return result;
}

export interface BatchConnectionItem {
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
}

export interface BatchConnectionInput {
  /** 用户实际拖拽的那一端节点（从它身上拉出线，或把线拖进它）。 */
  anchorNodeId: string;
  /** 另一端：落点节点，或松手后新建出来的节点。 */
  peerNodeId: string;
  /** 用户是从 anchor 的哪个 handle 起手的。source = 正向拖出，target = 反向拖入。 */
  anchorHandleType: 'source' | 'target';
  /** 当前全部节点（带 selected 标记）。 */
  nodes: CanvasNode[];
}

/**
 * 框选多个节点后，只拖一条线就把它们一次性接到同一个节点上。
 *
 * 触发规则（刻意做得保守，避免误伤）：
 * - **只有「用户拖的那个节点本身也在框选集合里」才升级成批量。** 否则从框选范围外的节点
 *   拖线会顺手把旁边选中的一堆也连上 —— 那不是用户要的。
 * - 拖的节点若属于 `BATCH_EXCLUDED_TYPES`（组），也退回单条。
 * - 批量的是**用户拖的那一端**：正向拖出就批量 source（多个素材 → 一个目标），
 *   反向拖入就批量 target（一个源 → 多个目标）。
 * - 候选要过 `nodeHasSourceHandle` / `nodeHasTargetHandle`：没有对应端口的节点自动出局，
 *   不需要在这里维护「什么算素材」的白名单。
 *
 * 返回的是「本次要建立的连接」。调用方拿它去 store 批量落地（只压一个历史快照）。
 * 没有任何候选合法时返回空数组，调用方按原样什么都不做。
 */
export function buildBatchConnections({
  anchorNodeId,
  peerNodeId,
  anchorHandleType,
  nodes,
}: BatchConnectionInput): BatchConnectionItem[] {
  const peerNode = nodes.find((node) => node.id === peerNodeId);

  if (!peerNode || anchorNodeId === peerNodeId) {
    return [];
  }

  const anchorIsSource = anchorHandleType === 'source';
  // 候选判定与拖拽时的幽灵线共用（见 resolveBatchAnchorCandidates 注释）。
  const candidates = resolveBatchAnchorCandidates({ anchorNodeId, anchorHandleType, nodes }).filter(
    (node) => node.id !== peerNodeId,
  );

  const connections: BatchConnectionItem[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const source = anchorIsSource ? candidate : peerNode;
    const target = anchorIsSource ? peerNode : candidate;

    if (source.id === target.id) {
      continue;
    }
    if (!nodeHasSourceHandle(source.type) || !nodeHasTargetHandle(target.type)) {
      continue;
    }

    // 同一对节点不重复。
    const key = `${source.id}->${target.id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    connections.push({
      source: source.id,
      target: target.id,
      sourceHandle: SOURCE_HANDLE_ID,
      targetHandle: TARGET_HANDLE_ID,
    });
  }

  return connections;
}

/** 拖拽连接线时用来提示「松手会连上几个」；语义与 buildBatchConnections 保持一致。 */
export function countBatchConnections(input: BatchConnectionInput): number {
  return buildBatchConnections(input).length;
}
