import { describe, expect, it } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { resolveFrameInsertPositions } from './videoFramePlacement';

function createNode(
  id: string,
  x: number,
  y: number,
  width = 192,
  height = 144,
  parentId?: string,
): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.upload,
    position: { x, y },
    parentId,
    width,
    height,
    data: {
      displayName: id,
      imageUrl: null,
      aspectRatio: '4:3',
    },
  } as CanvasNode;
}

describe('resolveFrameInsertPositions', () => {
  it('anchors the first extracted frame to the visible viewport center', () => {
    const [position] = resolveFrameInsertPositions(
      [],
      { x: 0, y: 0, zoom: 1 },
      { width: 1000, height: 800 },
      [{ width: 192, height: 144 }],
    );

    expect(position).toEqual({ x: 404, y: 328 });
  });

  it('moves around occupied space while keeping extracted frames close to center', () => {
    const positions = resolveFrameInsertPositions(
      [createNode('center', 404, 328)],
      { x: 0, y: 0, zoom: 1 },
      { width: 1000, height: 800 },
      [{ width: 192, height: 144 }, { width: 192, height: 144 }],
    );

    expect(positions).toHaveLength(2);
    expect(positions[0]).not.toEqual({ x: 404, y: 328 });
    expect(positions[1]).not.toEqual(positions[0]);
    expect(Math.hypot(positions[0].x - 404, positions[0].y - 328)).toBeLessThan(260);
    expect(Math.hypot(positions[1].x - 404, positions[1].y - 328)).toBeLessThan(260);
  });

  it('uses absolute positions when an existing node is inside a group', () => {
    const positions = resolveFrameInsertPositions(
      [
        createNode('group', 300, 200, 400, 300),
        createNode('child', 104, 128, 192, 144, 'group'),
      ],
      { x: 0, y: 0, zoom: 1 },
      { width: 1000, height: 800 },
      [{ width: 192, height: 144 }],
    );

    expect(positions[0]).not.toEqual({ x: 404, y: 328 });
  });
});
