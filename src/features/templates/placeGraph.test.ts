import { describe, expect, it } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasEdge, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { resolveTemplatePlacement } from './placeGraph';
import type { TemplateGraphSnapshot } from './types';

function graphNode(id: string, x: number, y: number): CanvasNode {
  return { id, type: CANVAS_NODE_TYPES.textAnnotation, position: { x, y }, data: { displayName: id } } as CanvasNode;
}

function graph(nodes: CanvasNode[], edges: CanvasEdge[] = []): TemplateGraphSnapshot {
  return { nodes, edges, outputNodeId: nodes[nodes.length - 1]?.id ?? '', videoNodeId: nodes[0]?.id ?? '' };
}

describe('resolveTemplatePlacement', () => {
  it('re-anchors a graph saved at far-away absolute canvas coordinates onto the drop point', () => {
    // 真实模板数据: 节点坐标是负数, 直接叠加落点会把整条链路甩出屏幕几千像素
    const placement = resolveTemplatePlacement(
      graph([
        graphNode('text', -3600, 560),
        graphNode('video', -2626, 560),
        graphNode('output', -2062, 560),
      ]),
      { x: 300, y: 400 },
    );

    expect(placement.nodes.map((node) => node.position)).toEqual([
      { x: 300, y: 400 },
      { x: 1274, y: 400 },
      { x: 1838, y: 400 },
    ]);
  });

  it('anchors the bounding-box top-left to the drop point when the graph has a ragged top edge', () => {
    const placement = resolveTemplatePlacement(
      graph([graphNode('a', -2761.607196039888, 412.00553541529854), graphNode('b', -3600, 560)]),
      { x: 300, y: 400 },
    );

    // min y 是 412.005…, 所以 text 节点落在落点下方约 148px
    expect(placement.nodes[0].position).toEqual({ x: 1138, y: 400 });
    expect(placement.nodes[1].position).toEqual({ x: 300, y: 548 });
  });

  it('keeps drop point as-is when the graph already sits at the origin', () => {
    const placement = resolveTemplatePlacement(graph([graphNode('a', 0, 0)]), { x: 120, y: 240 });
    expect(placement.nodes[0].position).toEqual({ x: 120, y: 240 });
  });

  it('preserves the relative geometry between nodes', () => {
    const placement = resolveTemplatePlacement(
      graph([graphNode('a', -3180, 560), graphNode('b', -2626, 560)]),
      { x: 0, y: 0 },
    );
    expect(placement.nodes[1].position.x - placement.nodes[0].position.x).toBe(554);
    expect(placement.nodes[1].position.y - placement.nodes[0].position.y).toBe(0);
  });

  it('carries edges and focus node ids through unchanged', () => {
    const edges: CanvasEdge[] = [{ id: 'e1', source: 'a', target: 'b' }];
    const placement = resolveTemplatePlacement(
      { nodes: [graphNode('a', 10, 10), graphNode('b', 20, 20)], edges, outputNodeId: 'b', videoNodeId: 'a' },
      { x: 0, y: 0 },
    );

    expect(placement.edges).toEqual(edges);
    expect(placement.outputTemplateNodeId).toBe('b');
    expect(placement.videoTemplateNodeId).toBe('a');
  });

  it('returns an empty placement for a missing or empty graph', () => {
    expect(resolveTemplatePlacement(undefined, { x: 10, y: 10 })).toEqual({
      nodes: [],
      edges: [],
      outputTemplateNodeId: null,
      videoTemplateNodeId: null,
    });
    expect(resolveTemplatePlacement(graph([]), { x: 10, y: 10 }).nodes).toEqual([]);
  });
});
