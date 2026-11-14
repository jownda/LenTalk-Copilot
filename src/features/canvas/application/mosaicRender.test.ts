import { describe, expect, it } from 'vitest';

import { scaleCanvasForNodeResize, scaleNodeFrameForCanvasExpansion, resolveCanvasExpansion } from './mosaicRender';

describe('resolveCanvasExpansion', () => {
  it('图层都在画内时不动画幅', () => {
    expect(
      resolveCanvasExpansion([{ x: 0, y: 0, width: 100, height: 100 }], 500, 500),
    ).toBeNull();
  });

  it('往右下推出界 → 画幅跟着长，不位移图层', () => {
    const result = resolveCanvasExpansion([{ x: 400, y: 400, width: 300, height: 300 }], 500, 500);
    expect(result).toEqual({ width: 700, height: 700 });
  });

  it('往左 / 上推出界 → 绝不扩画幅（边框大小与比例都不变）', () => {
    expect(resolveCanvasExpansion([{ x: -120, y: -40, width: 200, height: 200 }], 500, 500)).toBeNull();
  });

  it('没有图层时不扩', () => {
    expect(resolveCanvasExpansion([], 500, 500)).toBeNull();
  });
});

describe('scaleCanvasForNodeResize', () => {
  it('只拖右边框 → 只加宽画幅，高度不动（图片原样不动）', () => {
    expect(
      scaleCanvasForNodeResize({ width: 280, height: 200 }, { width: 400, height: 200 }, 1920, 1080),
    ).toEqual({ width: 2743, height: 1080 });
  });

  it('只拖下边框 → 只加高画幅，宽度不动', () => {
    expect(
      scaleCanvasForNodeResize({ width: 280, height: 200 }, { width: 280, height: 300 }, 1920, 1080),
    ).toEqual({ width: 1920, height: 1620 });
  });

  it('缩小时按同样比例缩画幅（等于裁掉右/下边）', () => {
    expect(
      scaleCanvasForNodeResize({ width: 400, height: 200 }, { width: 300, height: 200 }, 2743, 1080),
    ).toEqual({ width: 2057, height: 1080 });
  });

  it('尺寸没变时不动画幅', () => {
    expect(
      scaleCanvasForNodeResize({ width: 280, height: 200 }, { width: 280, height: 200 }, 1920, 1080),
    ).toBeNull();
  });

  it('画幅尺寸夹在安全范围内', () => {
    const huge = scaleCanvasForNodeResize({ width: 100, height: 100 }, { width: 1400, height: 100 }, 1920, 1080);
    expect(huge?.width).toBe(8192);
    const tiny = scaleCanvasForNodeResize({ width: 1400, height: 100 }, { width: 100, height: 100 }, 800, 800);
    expect(tiny?.width).toBe(64);
  });
});

describe('scaleNodeFrameForCanvasExpansion', () => {
  const bounds = { minWidth: 220, minHeight: 170, maxWidth: 1400, maxHeight: 1400 };

  it('画幅只向右扩 → 节点只变宽，高度一动不动（不会突然缩一截）', () => {
    expect(
      scaleNodeFrameForCanvasExpansion(
        { width: 280, height: 200 },
        { width: 1920, height: 1080 },
        { width: 2400, height: 1080 },
        bounds,
      ),
    ).toEqual({ width: 350, height: 200 });
  });

  it('画幅只向下扩 → 节点只变高，宽度不动', () => {
    expect(
      scaleNodeFrameForCanvasExpansion(
        { width: 280, height: 200 },
        { width: 1920, height: 1080 },
        { width: 1920, height: 1620 },
        bounds,
      ),
    ).toEqual({ width: 280, height: 300 });
  });

  it('两轴都扩 → 两轴一起长', () => {
    expect(
      scaleNodeFrameForCanvasExpansion(
        { width: 280, height: 200 },
        { width: 2000, height: 1000 },
        { width: 3000, height: 1500 },
        bounds,
      ),
    ).toEqual({ width: 420, height: 300 });
  });

  it('涨过头就夹在上限，且永远不会比原来小', () => {
    expect(
      scaleNodeFrameForCanvasExpansion(
        { width: 700, height: 100 },
        { width: 1000, height: 1000 },
        { width: 9000, height: 1000 },
        bounds,
      ),
    ).toEqual({ width: 1400, height: 170 });
  });
});
