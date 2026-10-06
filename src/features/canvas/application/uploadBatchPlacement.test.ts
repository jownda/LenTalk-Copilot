import { describe, expect, it } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import {
  UPLOAD_BATCH_COLLISION_GAP,
  UPLOAD_BATCH_GAP,
  collectCanvasOccupiedRects,
  resolveUploadBatchColumnCount,
  resolveUploadBatchPositions,
  type UploadBatchRect,
} from './uploadBatchPlacement';

function square(size = 96) {
  return { width: size, height: size };
}

function rectsOverlap(first: UploadBatchRect, second: UploadBatchRect): boolean {
  return (
    first.x < second.x + second.width
    && first.x + first.width > second.x
    && first.y < second.y + second.height
    && first.y + first.height > second.y
  );
}

function createNode(
  id: string,
  x: number,
  y: number,
  width = 96,
  height = 96,
  parentId?: string,
): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.upload,
    position: { x, y },
    parentId,
    width,
    height,
    data: { displayName: id, imageUrl: null, aspectRatio: '1:1' },
  } as CanvasNode;
}

describe('resolveUploadBatchColumnCount', () => {
  it('使用接近正方形的最小列数, 并受单行上限约束', () => {
    expect(resolveUploadBatchColumnCount(0)).toBe(0);
    expect(resolveUploadBatchColumnCount(1)).toBe(1);
    expect(resolveUploadBatchColumnCount(2)).toBe(2);
    expect(resolveUploadBatchColumnCount(4)).toBe(2);
    expect(resolveUploadBatchColumnCount(6)).toBe(3);
    expect(resolveUploadBatchColumnCount(9)).toBe(3);
    // 上限: 超过 9 个也维持 3 列, 不再往右无限延伸
    expect(resolveUploadBatchColumnCount(16)).toBe(3);
    expect(resolveUploadBatchColumnCount(16, 5)).toBe(4);
  });
});

describe('resolveUploadBatchPositions', () => {
  it('空批次不产生任何落点', () => {
    expect(resolveUploadBatchPositions({ anchor: { x: 10, y: 20 }, items: [] })).toEqual([]);
  });

  it('单个素材落在基准点上', () => {
    expect(resolveUploadBatchPositions({ anchor: { x: 400, y: 300 }, items: [square()] })).toEqual([
      { x: 400, y: 300 },
    ]);
  });

  it('同一行的素材顶边对齐且间距等于 UPLOAD_BATCH_GAP', () => {
    const positions = resolveUploadBatchPositions({
      anchor: { x: 0, y: 0 },
      items: [square(), square()],
    });

    expect(positions).toEqual([
      { x: 0, y: 0 },
      { x: 96 + UPLOAD_BATCH_GAP, y: 0 },
    ]);
  });

  it('换行后左边缘回到基准点, 且行间距等于 UPLOAD_BATCH_GAP', () => {
    const positions = resolveUploadBatchPositions({
      anchor: { x: 0, y: 0 },
      items: [square(), square(), square(), square()],
    });

    // 4 个 → 2 列 2 行
    expect(positions).toEqual([
      { x: 0, y: 0 },
      { x: 120, y: 0 },
      { x: 0, y: 120 },
      { x: 120, y: 120 },
    ]);
  });

  it('统一单元格: 尺寸不同的素材也落在同一套行列线上', () => {
    const positions = resolveUploadBatchPositions({
      anchor: { x: 0, y: 0 },
      items: [
        { width: 200, height: 100 },
        { width: 100, height: 200 },
        { width: 200, height: 200 },
      ],
    });

    // 单元格取 200x200, 3 个 → 2 列
    expect(positions).toEqual([
      { x: 0, y: 0 },
      { x: 200 + UPLOAD_BATCH_GAP, y: 0 },
      { x: 0, y: 200 + UPLOAD_BATCH_GAP },
    ]);
  });

  it('批次内部任意两个节点都不重叠', () => {
    const items = Array.from({ length: 7 }, () => square());
    const positions = resolveUploadBatchPositions({ anchor: { x: 0, y: 0 }, items });
    const boxes = positions.map((position) => ({ ...position, ...square() }));

    for (let first = 0; first < boxes.length; first += 1) {
      for (let second = first + 1; second < boxes.length; second += 1) {
        expect(rectsOverlap(boxes[first], boxes[second])).toBe(false);
      }
    }
  });

  it('整块被已有节点挡住时向下让开, 且保持行列对齐', () => {
    // 基准点正好压在既有节点上
    const occupied: UploadBatchRect[] = [{ x: 0, y: 0, width: 300, height: 300 }];
    const positions = resolveUploadBatchPositions({
      anchor: { x: 0, y: 0 },
      items: [square(), square(), square(), square()],
      occupied,
    });

    const expectedTop = 300 + UPLOAD_BATCH_GAP;
    expect(positions[0]).toEqual({ x: 0, y: expectedTop });
    expect(positions[1]).toEqual({ x: 120, y: expectedTop });
    expect(positions[2]).toEqual({ x: 0, y: expectedTop + 120 });
    expect(positions[3]).toEqual({ x: 120, y: expectedTop + 120 });

    const boxes = positions.map((position) => ({ ...position, ...square() }));
    for (const box of boxes) {
      expect(rectsOverlap(box, occupied[0])).toBe(false);
    }
  });

  it('与已有节点横向错开时不下移', () => {
    const occupied: UploadBatchRect[] = [{ x: 0, y: 0, width: 300, height: 300 }];
    const positions = resolveUploadBatchPositions({
      anchor: { x: 300 + UPLOAD_BATCH_GAP, y: 0 },
      items: [square()],
      occupied,
    });

    expect(positions).toEqual([{ x: 324, y: 0 }]);
  });

  it('间距刚好等于碰撞阈值时不认为重叠', () => {
    const occupied: UploadBatchRect[] = [{ x: 0, y: 0, width: 100, height: 100 }];
    const positions = resolveUploadBatchPositions({
      anchor: { x: 100 + UPLOAD_BATCH_COLLISION_GAP, y: 0 },
      items: [square()],
      occupied,
    });

    expect(positions).toEqual([{ x: 112, y: 0 }]);
  });

  it('连续冲突时逐层向下让开, 不会停在半空', () => {
    const occupied: UploadBatchRect[] = [
      { x: 0, y: 0, width: 120, height: 120 },
      { x: 0, y: 120, width: 120, height: 120 },
      { x: 0, y: 240, width: 120, height: 120 },
    ];
    const positions = resolveUploadBatchPositions({
      anchor: { x: 0, y: 0 },
      items: [square(), square()],
      occupied,
    });

    const boxes = positions.map((position) => ({ ...position, ...square() }));
    for (const box of boxes) {
      for (const occupiedRect of occupied) {
        expect(rectsOverlap(box, occupiedRect)).toBe(false);
      }
    }
    expect(positions[0].y).toBe(240 + 120 + UPLOAD_BATCH_GAP);
  });

  it('忽略纵向不相干的既有节点', () => {
    const occupied: UploadBatchRect[] = [{ x: 0, y: 5000, width: 120, height: 120 }];
    const positions = resolveUploadBatchPositions({
      anchor: { x: 0, y: 0 },
      items: [square()],
      occupied,
    });

    expect(positions).toEqual([{ x: 0, y: 0 }]);
  });
});

describe('collectCanvasOccupiedRects', () => {
  it('组内子节点换算成绝对坐标, 不会被当成画布原点的挡板', () => {
    const rects = collectCanvasOccupiedRects(
      [createNode('group', 300, 200, 400, 300), createNode('child', 20, 30, 96, 96, 'group')],
      96,
      96,
    );

    expect(rects).toEqual([
      { x: 300, y: 200, width: 400, height: 300 },
      { x: 320, y: 230, width: 96, height: 96 },
    ]);
  });

  it('缺尺寸时回落到传入的默认宽高', () => {
    const node = { ...createNode('bare', 5, 6), width: undefined, height: undefined } as unknown as CanvasNode;
    expect(collectCanvasOccupiedRects([node], 220, 200)).toEqual([
      { x: 5, y: 6, width: 220, height: 200 },
    ]);
  });
});
