import type { CanvasEdge, CanvasNode } from '@/features/canvas/domain/canvasNodes';
import type { TemplateGraphSnapshot } from '@/features/templates/types';

export interface PlacedTemplateNode {
  /** 模板里原来的节点 id, 仅用于给调用方建 旧id→新id 映射 */
  templateNodeId: string;
  type: CanvasNode['type'];
  position: { x: number; y: number };
  data: CanvasNode['data'];
}

export interface TemplatePlacement {
  nodes: PlacedTemplateNode[];
  edges: CanvasEdge[];
  outputTemplateNodeId: string | null;
  videoTemplateNodeId: string | null;
}

const EMPTY_PLACEMENT: TemplatePlacement = { nodes: [], edges: [], outputTemplateNodeId: null, videoTemplateNodeId: null };

/**
 * 把模板 graph 摆到画布落点上。
 *
 * 模板里的节点坐标是**保存模板那一刻画布上的绝对坐标**（可能在负几千像素处，
 * 见 `createTemplate.ts` 的 `buildGraphSnapshot` 直接拷贝 `node.position`），
 * 因此不能直接叠加落点 —— 必须先归一到 graph 自身的左上角，再整体平移到落点。
 * 否则节点会落在离鼠标很远的地方（表现为「拖到画布不跟随鼠标」）。
 */
export function resolveTemplatePlacement(
  graph: TemplateGraphSnapshot | undefined,
  dropPosition: { x: number; y: number },
): TemplatePlacement {
  const nodes = graph?.nodes ?? [];
  if (nodes.length === 0) return EMPTY_PLACEMENT;

  const minX = Math.min(...nodes.map((node) => node.position.x));
  const minY = Math.min(...nodes.map((node) => node.position.y));

  return {
    nodes: nodes.map((node) => ({
      templateNodeId: node.id,
      type: node.type,
      position: {
        x: Math.round(dropPosition.x + node.position.x - minX),
        y: Math.round(dropPosition.y + node.position.y - minY),
      },
      data: node.data,
    })),
    edges: graph?.edges ?? [],
    outputTemplateNodeId: graph?.outputNodeId ?? null,
    videoTemplateNodeId: graph?.videoNodeId ?? null,
  };
}
