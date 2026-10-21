import type { CanvasEdge, CanvasNode } from "@/features/canvas/domain/canvasNodes";

/** 一次「复制 / 剪切」装进剪贴板的内容：节点，以及只在它们之间连线的边。 */
export interface NodeClipboardSnapshot {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

/**
 * 收集种子节点及其全部子节点（只往下找，不往上找）。
 *
 * 组节点被删除时会连带删掉组内节点（见 `canvasStore.deleteNodes` 里的
 * `collectNodeIdsWithDescendants`），所以剪切组时必须把子节点一起装进剪贴板，
 * 否则粘贴回来只剩一个空组框。反过来，剪切组里的某个节点不该把整组带走。
 */
export function collectNodeClipboardIds(nodes: CanvasNode[], seedIds: string[]): Set<string> {
  const existingIds = new Set(nodes.map((node) => node.id));
  const collected = new Set(seedIds.filter((id) => existingIds.has(id)));

  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (!node.parentId || collected.has(node.id)) {
        continue;
      }
      if (collected.has(node.parentId)) {
        collected.add(node.id);
        changed = true;
      }
    }
  }

  return collected;
}

/**
 * 父节点排在子节点前面。
 *
 * 还原快照时要先建父节点拿到新 id，子节点的 `parentId` 才能映射过去；
 * React Flow 也要求父节点在数组里先出现，否则组内节点渲染时找不到父级。
 * 同层节点保持原顺序（`Array.prototype.sort` 是稳定排序）。
 */
export function sortNodesParentsFirst(nodes: CanvasNode[]): CanvasNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node] as const));

  const depthOf = (node: CanvasNode): number => {
    let depth = 0;
    let parentId = node.parentId;
    const visited = new Set<string>();
    while (parentId && byId.has(parentId) && !visited.has(parentId)) {
      visited.add(parentId);
      depth += 1;
      parentId = byId.get(parentId)?.parentId;
    }
    return depth;
  };

  return [...nodes].sort((a, b) => depthOf(a) - depthOf(b));
}

/** 生成一次复制 / 剪切的快照（节点按父先子后排序，边只保留内部连线）。 */
export function buildNodeClipboardSnapshot(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  seedIds: string[],
): NodeClipboardSnapshot {
  const ids = collectNodeClipboardIds(nodes, seedIds);
  if (ids.size === 0) {
    return { nodes: [], edges: [] };
  }

  return {
    nodes: sortNodesParentsFirst(nodes.filter((node) => ids.has(node.id))),
    // 只带内部边：跨出选区的边一端会被删掉，粘回来也无处可连。
    edges: edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
  };
}
