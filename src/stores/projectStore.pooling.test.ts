import { describe, expect, it } from 'vitest';

import type { CanvasNode } from './canvasStore';
import { mapNodeImageReferences } from './projectStore';

/**
 * 参考图数组必须和标量字段走同一条池化通道。
 *
 * 这里的回归点很具体：`quickReferenceImages` / `studioReferenceImages` /
 * 下游视频节点的 `studioReferenceImages` 是**同一个数组的三份拷贝**，值是几十 KB 的
 * data URL，漏掉任何一处，工程 JSON 就会按份数线性膨胀（实测 220 节点的工程 17 MB）。
 */

function makeNode(data: Record<string, unknown>): CanvasNode {
  return {
    id: 'node-1',
    type: 'cinematicStudioNode',
    position: { x: 0, y: 0 },
    data,
  } as unknown as CanvasNode;
}

function encodeWithPool(nodes: CanvasNode[]) {
  const pool: string[] = [];
  const index = new Map<string, number>();
  const map = (value: string | null | undefined) => {
    if (typeof value !== 'string' || value.length === 0) return value;
    const existing = index.get(value);
    if (typeof existing === 'number') return `ref:${existing}`;
    const next = pool.length;
    pool.push(value);
    index.set(value, next);
    return `ref:${next}`;
  };
  const mapped = mapNodeImageReferences(nodes, map);
  const decode = (value: string | null | undefined) =>
    typeof value === 'string' && value.startsWith('ref:')
      ? (pool[Number.parseInt(value.slice(4), 10)] ?? null)
      : value;
  return { mapped, decode, pool };
}

describe('mapNodeImageReferences', () => {
  it('把三份重复的参考图数组池化成一份', () => {
    const images = ['data:image/png;base64,AAA', 'data:image/png;base64,BBB'];
    const { mapped, pool } = encodeWithPool([
      makeNode({
        quickReferenceImages: images,
        studioReferenceImages: images,
      }),
      makeNode({ studioReferenceImages: images }),
    ]);

    // 三份引用、两张图 → 池里只有两条。
    expect(pool).toEqual(images);
    const first = mapped[0].data as Record<string, unknown>;
    const second = mapped[1].data as Record<string, unknown>;
    expect(first.quickReferenceImages).toEqual(['ref:0', 'ref:1']);
    expect(first.studioReferenceImages).toEqual(['ref:0', 'ref:1']);
    expect(second.studioReferenceImages).toEqual(['ref:0', 'ref:1']);
  });

  it('解码后能原样还原，包括被排除的参考源', () => {
    const images = ['/library/a.png', 'data:image/png;base64,CCC'];
    const nodes = [
      makeNode({
        quickReferenceImages: images,
        excludedReferenceSources: ['data:image/png;base64,CCC'],
      }),
    ];

    const { mapped, decode } = encodeWithPool(nodes);
    const restored = mapNodeImageReferences(mapped, decode);
    const data = restored[0].data as Record<string, unknown>;

    expect(data.quickReferenceImages).toEqual(images);
    expect(data.excludedReferenceSources).toEqual(['data:image/png;base64,CCC']);
  });

  it('数组里的非字符串项与空串保持原样', () => {
    const { mapped } = encodeWithPool([
      makeNode({
        studioReferenceImages: ['', null, 42, { nested: true }],
      }),
    ]);
    const data = mapped[0].data as Record<string, unknown>;
    expect(data.studioReferenceImages).toEqual(['', null, 42, { nested: true }]);
  });
});
