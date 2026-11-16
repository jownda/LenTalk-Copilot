import { describe, expect, it } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode } from '../domain/canvasNodes';
import {
  resolveAbsolutePositions,
  resolveClipboardOrigin,
  resolvePastePlacements,
} from './clipboardPasteLayout';

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

function toMap(nodes: CanvasNode[]): Map<string, CanvasNode> {
  return new Map(nodes.map((node) => [node.id, node]));
}

describe('resolveAbsolutePositions', () => {
  it('顶层节点: 绝对坐标就是自身 position', () => {
    const nodes = [makeNode({ id: 'a', x: 120, y: 80 })];
    const absolute = resolveAbsolutePositions(nodes, toMap(nodes));
    expect(absolute.get('a')).toEqual({ x: 120, y: 80 });
  });

  it('组内节点: 累加父节点偏移, 而不是把局部坐标当绝对坐标', () => {
    const nodes = [
      makeNode({ id: 'group', type: CANVAS_NODE_TYPES.group, x: 400, y: 300 }),
      makeNode({ id: 'child', parentId: 'group', x: 20, y: 30 }),
    ];
    const absolute = resolveAbsolutePositions(nodes, toMap(nodes));
    expect(absolute.get('child')).toEqual({ x: 420, y: 330 });
  });

  it('多层嵌套一路累加到根', () => {
    const nodes = [
      makeNode({ id: 'outer', type: CANVAS_NODE_TYPES.group, x: 100, y: 100 }),
      makeNode({ id: 'inner', type: CANVAS_NODE_TYPES.group, parentId: 'outer', x: 50, y: 20 }),
      makeNode({ id: 'leaf', parentId: 'inner', x: 10, y: 5 }),
    ];
    const absolute = resolveAbsolutePositions(nodes, toMap(nodes));
    expect(absolute.get('leaf')).toEqual({ x: 160, y: 125 });
  });

  it('父节点不在表里时退化为自身 position, 不会死循环', () => {
    const lonely = makeNode({ id: 'orphan', parentId: 'gone', x: 33, y: 44 });
    const absolute = resolveAbsolutePositions([lonely], toMap([lonely]));
    expect(absolute.get('orphan')).toEqual({ x: 33, y: 44 });
  });
});

describe('resolveClipboardOrigin', () => {
  it('取整片选区的左上角, 组内节点按绝对坐标参与比较', () => {
    const nodes = [
      makeNode({ id: 'group', type: CANVAS_NODE_TYPES.group, x: 500, y: 200 }),
      makeNode({ id: 'child', parentId: 'group', x: 20, y: 260 }),
      makeNode({ id: 'loose', x: 100, y: 900 }),
    ];
    const absolute = resolveAbsolutePositions(nodes, toMap(nodes));
    // child 的绝对坐标是 (520, 460), 所以左上角是 loose 的 (100, 200) —— y 取 group 的 200 更小。
    expect(resolveClipboardOrigin(nodes, absolute)).toEqual({ x: 100, y: 200 });
  });

  it('空选区返回原点, 不抛错', () => {
    expect(resolveClipboardOrigin([], new Map())).toEqual({ x: 0, y: 0 });
  });
});

describe('resolvePastePlacements', () => {
  it('多选复制后整片一起平移: 节点之间的相对位置逐一对齐', () => {
    const nodes = [
      makeNode({ id: 'group', type: CANVAS_NODE_TYPES.group, x: 300, y: 300 }),
      makeNode({ id: 'child-a', parentId: 'group', x: 40, y: 40 }),
      makeNode({ id: 'child-b', parentId: 'group', x: 300, y: 160 }),
      makeNode({ id: 'loose', x: 900, y: 750 }),
    ];
    const copied = new Set(nodes.map((node) => node.id));
    const absolute = resolveAbsolutePositions(nodes, toMap(nodes));
    const offset = { x: 520, y: -180 };
    const placements = resolvePastePlacements(nodes, absolute, offset, copied);

    // 根节点整体平移
    expect(placements.get('group')!.position).toEqual({ x: 820, y: 120 });
    expect(placements.get('loose')!.position).toEqual({ x: 1420, y: 570 });
    // 组内节点保持局部坐标（父已经平移过, 再加一次就是双重位移）
    expect(placements.get('child-a')!.position).toEqual({ x: 40, y: 40 });
    expect(placements.get('child-b')!.position).toEqual({ x: 300, y: 160 });
    expect(placements.get('child-a')!.attachesToNewParent).toBe(true);

    // 关键断言: 还原成绝对坐标后, 每个节点都只平移了同一个 offset。
    const pastedAbsolute = (id: string) => {
      const placement = placements.get(id)!;
      if (!placement.attachesToNewParent) {
        return placement.position;
      }
      const parentAbsolute = placements.get('group')!.position;
      return { x: parentAbsolute.x + placement.position.x, y: parentAbsolute.y + placement.position.y };
    };
    for (const node of nodes) {
      const before = absolute.get(node.id)!;
      const after = pastedAbsolute(node.id);
      expect(after.x - before.x).toBe(offset.x);
      expect(after.y - before.y).toBe(offset.y);
    }
  });

  it('只复制组内某个节点时它落成顶层节点, 用绝对坐标定位', () => {
    const group = makeNode({ id: 'group', type: CANVAS_NODE_TYPES.group, x: 500, y: 500 });
    const child = makeNode({ id: 'child', parentId: 'group', x: 30, y: 60 });
    const absolute = resolveAbsolutePositions([child], toMap([group, child]));
    const placements = resolvePastePlacements(
      [child],
      absolute,
      { x: 100, y: 100 },
      new Set(['child']),
    );

    expect(placements.get('child')!.attachesToNewParent).toBe(false);
    // 绝对坐标 (530, 560) + offset(100, 100)
    expect(placements.get('child')!.position).toEqual({ x: 630, y: 660 });
  });
});
