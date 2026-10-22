import { describe, expect, it } from 'vitest';

import { findDownstreamPlacement, type PlacementRect } from './downstreamPlacement';

const SOURCE: PlacementRect = { x: 1000, y: 1000, width: 300, height: 300 };
const SIZE = { width: 420, height: 340 };
const GAP = 8;

function overlaps(a: PlacementRect, b: PlacementRect): boolean {
  return (
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
  );
}

describe('findDownstreamPlacement', () => {
  it('右边空着时紧贴右侧、顶边对齐', () => {
    const position = findDownstreamPlacement({ source: SOURCE, size: SIZE, obstacles: [] });
    expect(position).toEqual({ x: SOURCE.x + SOURCE.width + GAP, y: SOURCE.y });
  });

  it('同一排向右跨过一个矮挡板（宽度在跨度内）', () => {
    const blocker: PlacementRect = {
      x: SOURCE.x + SOURCE.width + GAP,
      y: SOURCE.y,
      width: 200,
      height: 200,
    };
    const position = findDownstreamPlacement({ source: SOURCE, size: SIZE, obstacles: [blocker] });
    expect(position).toEqual({ x: blocker.x + blocker.width + GAP, y: SOURCE.y });
  });

  it('右侧是超宽挡板（分组那种）时不许飞到它右边', () => {
    const hugeGroup: PlacementRect = {
      x: SOURCE.x + SOURCE.width + GAP,
      y: SOURCE.y - 200,
      width: 2000,
      height: 1200,
    };
    const position = findDownstreamPlacement({
      source: SOURCE,
      size: SIZE,
      obstacles: [hugeGroup],
    });

    // 关键约束：落点要留在来源附近，不能被推到 2000px 之外
    expect(position.x).toBeLessThan(SOURCE.x + SOURCE.width + 400);
    // 而且不能和挡板重叠
    expect(overlaps({ ...position, ...SIZE }, hugeGroup)).toBe(false);
  });

  it('同排右侧整列被占时，最多跨一列就找位置（不会一直往右漂）', () => {
    const blockers: PlacementRect[] = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((index) => ({
      x: SOURCE.x + SOURCE.width + GAP,
      y: SOURCE.y + index * 348 - 4,
      width: 420,
      height: 340,
    }));
    const position = findDownstreamPlacement({
      source: SOURCE,
      size: SIZE,
      obstacles: blockers,
      maxStack: 4,
    });

    const leftX = SOURCE.x + SOURCE.width + GAP;
    // 最多跨过一列（挡板宽 + 一个间距），且不与任何挡板重叠 —— 不会一路往右漂
    expect(position.x - leftX).toBeLessThanOrEqual(SIZE.width + GAP);
    const candidate: PlacementRect = { ...position, ...SIZE };
    for (const blocker of blockers) {
      expect(overlaps(candidate, blocker)).toBe(false);
    }
  });

  it('已有下游节点时，接在最后一个下游下方并与第一个左对齐', () => {
    const first: PlacementRect = { x: SOURCE.x + 308, y: SOURCE.y, width: 420, height: 340 };
    const second: PlacementRect = { x: first.x, y: first.y + 348, width: 420, height: 340 };
    const position = findDownstreamPlacement({
      source: SOURCE,
      size: SIZE,
      obstacles: [first, second],
      downstreamRects: [first, second],
    });

    expect(position).toEqual({ x: first.x, y: second.y + second.height + GAP });
  });

  it('随机布局下：永不与障碍重叠，且落点离来源不会离谱', () => {
    let seed = 20261022;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };

    for (let round = 0; round < 200; round += 1) {
      const obstacles: PlacementRect[] = Array.from({ length: 1 + Math.floor(random() * 10) }).map(
        () => ({
          x: SOURCE.x - 600 + random() * 2600,
          y: SOURCE.y - 600 + random() * 2600,
          width: 120 + random() * 1400,
          height: 100 + random() * 900,
        }),
      );
      const position = findDownstreamPlacement({ source: SOURCE, size: SIZE, obstacles });
      const candidate: PlacementRect = { ...position, ...SIZE };

      for (const obstacle of obstacles) {
        expect(overlaps(candidate, obstacle)).toBe(false);
      }

      // 离来源（右缘 / 下缘）不超过「自身尺寸 + 9 个堆叠格 + 允许跨度」的量级
      const maxDistance =
        SOURCE.width + SIZE.width * 12 + SIZE.height * 10 + 400;
      expect(Math.abs(position.x - SOURCE.x)).toBeLessThan(maxDistance);
      expect(Math.abs(position.y - SOURCE.y)).toBeLessThan(maxDistance);
    }
  });
});
