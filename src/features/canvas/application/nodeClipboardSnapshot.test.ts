import { describe, expect, it } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasEdge, type CanvasNode } from '../domain/canvasNodes';
import {
  buildNodeClipboardSnapshot,
  collectNodeClipboardIds,
  sortNodesParentsFirst,
} from './nodeClipboardSnapshot';

type NodeSeed = {
  id: string;
  type?: string;
  parentId?: string;
  x?: number;
  y?: number;
};

function makeNode(seed: NodeSeed): CanvasNode {
  const node = {
    id: seed.id,
    type: seed.type ?? CANVAS_NODE_TYPES.imageEdit,
    position: { x: seed.x ?? 0, y: seed.y ?? 0 },
    data: {},
  } as CanvasNode & { parentId?: string };
  if (seed.parentId) {
    node.parentId = seed.parentId;
  }
  return node as CanvasNode;
}

function makeEdge(source: string, target: string): CanvasEdge {
  return { id: `${source}->${target}`, source, target };
}

describe('collectNodeClipboardIds', () => {
  it('剪切组节点时把组内节点一起带走', () => {
    const nodes = [
      makeNode({ id: 'group', type: CANVAS_NODE_TYPES.group }),
      makeNode({ id: 'child-1', parentId: 'group' }),
      makeNode({ id: 'child-2', parentId: 'group' }),
      makeNode({ id: 'outside' }),
    ];

    expect([...collectNodeClipboardIds(nodes, ['group'])]).toEqual(['group', 'child-1', 'child-2']);
  });

  it('多层嵌套的子节点也会被带上', () => {
    const nodes = [
      makeNode({ id: 'outer', type: CANVAS_NODE_TYPES.group }),
      makeNode({ id: 'inner', type: CANVAS_NODE_TYPES.group, parentId: 'outer' }),
      makeNode({ id: 'leaf', parentId: 'inner' }),
    ];

    expect([...collectNodeClipboardIds(nodes, ['outer'])]).toEqual(['outer', 'inner', 'leaf']);
  });

  it('剪切组内某个子节点不会把整组带走', () => {
    const nodes = [
      makeNode({ id: 'group', type: CANVAS_NODE_TYPES.group }),
      makeNode({ id: 'child', parentId: 'group' }),
    ];

    expect([...collectNodeClipboardIds(nodes, ['child'])]).toEqual(['child']);
  });

  it('忽略画布上不存在的 id', () => {
    const nodes = [makeNode({ id: 'a' })];

    expect(collectNodeClipboardIds(nodes, ['a', 'ghost'])).toEqual(new Set(['a']));
  });

  it('父级成环时只按父链收集一次，不会死循环', () => {
    const nodes = [
      makeNode({ id: 'a', type: CANVAS_NODE_TYPES.group, parentId: 'b' }),
      makeNode({ id: 'b', type: CANVAS_NODE_TYPES.group, parentId: 'a' }),
    ];

    expect(collectNodeClipboardIds(nodes, ['a'])).toEqual(new Set(['a', 'b']));
  });
});

describe('sortNodesParentsFirst', () => {
  it('父节点排在子节点之前，同层保持原顺序', () => {
    const nodes = [
      makeNode({ id: 'child-1', parentId: 'group' }),
      makeNode({ id: 'top-1' }),
      makeNode({ id: 'child-2', parentId: 'group' }),
      makeNode({ id: 'group', type: CANVAS_NODE_TYPES.group }),
    ];

    expect(sortNodesParentsFirst(nodes).map((node) => node.id)).toEqual([
      'top-1',
      'group',
      'child-1',
      'child-2',
    ]);
  });

  it('跨多层的节点按层深排序', () => {
    const nodes = [
      makeNode({ id: 'leaf', parentId: 'inner' }),
      makeNode({ id: 'inner', type: CANVAS_NODE_TYPES.group, parentId: 'outer' }),
      makeNode({ id: 'outer', type: CANVAS_NODE_TYPES.group }),
    ];

    expect(sortNodesParentsFirst(nodes).map((node) => node.id)).toEqual(['outer', 'inner', 'leaf']);
  });
});

describe('buildNodeClipboardSnapshot', () => {
  it('只收录内部边，跨出选区的边被丢弃', () => {
    const nodes = [
      makeNode({ id: 'group', type: CANVAS_NODE_TYPES.group }),
      makeNode({ id: 'child', parentId: 'group' }),
      makeNode({ id: 'outside' }),
    ];
    const edges = [makeEdge('child', 'outside'), makeEdge('group', 'child')];

    const snapshot = buildNodeClipboardSnapshot(nodes, edges, ['group']);

    expect(snapshot.nodes.map((node) => node.id)).toEqual(['group', 'child']);
    expect(snapshot.edges.map((edge) => edge.id)).toEqual(['group->child']);
  });

  it('单个普通节点只带回自己，不带任何边', () => {
    const nodes = [makeNode({ id: 'a' }), makeNode({ id: 'b' })];
    const edges = [makeEdge('a', 'b')];

    expect(buildNodeClipboardSnapshot(nodes, edges, ['a'])).toEqual({
      nodes: [expect.objectContaining({ id: 'a' })],
      edges: [],
    });
  });

  it('目标节点不存在时返回空快照', () => {
    expect(buildNodeClipboardSnapshot([makeNode({ id: 'a' })], [], ['ghost'])).toEqual({
      nodes: [],
      edges: [],
    });
  });
});
