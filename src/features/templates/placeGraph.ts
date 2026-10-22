import type { CanvasEdge, CanvasNode } from '@/features/canvas/domain/canvasNodes';
import type { TemplateGraphSnapshot } from '@/features/templates/types';

export interface PlacedTemplateNode {
  /** 模板里原来的节点 id, 仅用于给调用方建 旧id→新id 映射 */
  templateNodeId: string;
  type: CanvasNode['type'];
  position: { x: number; y: number };
  data: CanvasNode['data'];
  /** 保存模板那一刻的节点尺寸; 缺省表示模板没存下尺寸, 由调用方回落节点类型默认尺寸。 */
  size?: { width: number; height: number };
}

export interface TemplatePlacement {
  nodes: PlacedTemplateNode[];
  edges: CanvasEdge[];
  outputTemplateNodeId: string | null;
  videoTemplateNodeId: string | null;
}

const EMPTY_PLACEMENT: TemplatePlacement = { nodes: [], edges: [], outputTemplateNodeId: null, videoTemplateNodeId: null };

function toPositiveNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

/**
 * 还原保存模板那一刻的节点尺寸。
 *
 * 优先级与画布上的 `resolveCanvasNodeSize` 保持一致: React Flow 的实测值(measured) →
 * 节点自身的 width/height → `createNode` 写下的 style。宽高缺一即认为模板没存下尺寸,
 * 返回 undefined 让 `addNode` 走节点类型注册的 defaultSize(与改造前的行为一致)。
 */
function resolveSnapshotNodeSize(node: CanvasNode): { width: number; height: number } | undefined {
  const measured = node.measured;
  const style = node.style;
  const width = toPositiveNumber(measured?.width) ?? toPositiveNumber(node.width) ?? toPositiveNumber(style?.width);
  const height = toPositiveNumber(measured?.height) ?? toPositiveNumber(node.height) ?? toPositiveNumber(style?.height);
  if (width === null || height === null) return undefined;
  return { width, height };
}

/**
 * 把模板 graph 摆到画布落点上。
 *
 * 模板里的节点坐标是**保存模板那一刻画布上的绝对坐标**（可能在负几千像素处，
 * 见 `createTemplate.ts` 的 `buildGraphSnapshot` 直接拷贝 `node.position`），
 * 因此不能直接叠加落点 —— 必须先归一到 graph 自身的左上角，再整体平移到落点。
 * 否则节点会落在离鼠标很远的地方（表现为「拖到画布不跟随鼠标」）。
 *
 * 尺寸同样来自保存时的快照, 一并通过 `size` 交回给调用方, 这样拖入的结果与
 * 模板图页(`TemplateGraphPage` 直接把快照节点灌进 React Flow)看到的样子一致。
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
      size: resolveSnapshotNodeSize(node),
    })),
    edges: graph?.edges ?? [],
    outputTemplateNodeId: graph?.outputNodeId ?? null,
    videoTemplateNodeId: graph?.videoNodeId ?? null,
  };
}
