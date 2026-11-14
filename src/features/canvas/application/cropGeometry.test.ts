import { describe, expect, it } from 'vitest';

import { toImageSpaceCrop, toRenderedCrop } from './cropGeometry';

describe('toImageSpaceCrop', () => {
  it('用百分比换算, 不受"期望渲染尺寸"影响', () => {
    // 真实源图 2000x1000, 我们以为渲染成 500x250 (0.25), 实际 CSS 把它压到了 400x200。
    // 用户在真实盒子里框了 (40,20)-(200,120) → 百分比 (0.1, 0.1, 0.4, 0.5)。
    const percent = { x: 0.1, y: 0.1, width: 0.4, height: 0.5 };
    const pixelsInRealBox = { x: 40, y: 20, width: 160, height: 100 };

    const crop = toImageSpaceCrop(pixelsInRealBox, percent, 500, 250, 2000, 1000);

    expect(crop).toEqual({ cropX: 200, cropY: 100, cropWidth: 800, cropHeight: 500 });
  });

  it('拿不到百分比时才退回按像素反推', () => {
    const crop = toImageSpaceCrop({ x: 50, y: 25, width: 100, height: 50 }, null, 500, 250, 2000, 1000);

    expect(crop).toEqual({ cropX: 200, cropY: 100, cropWidth: 400, cropHeight: 200 });
  });

  it('百分比是空框时不采用(避免 0 宽高被当成"整图")', () => {
    const crop = toImageSpaceCrop(
      { x: 0, y: 0, width: 500, height: 250 },
      { x: 0, y: 0, width: 0, height: 0 },
      500,
      250,
      2000,
      1000
    );

    expect(crop).toEqual({ cropX: 0, cropY: 0, cropWidth: 2000, cropHeight: 1000 });
  });

  it('不产生 0 宽高, 也不超出源图', () => {
    const crop = toImageSpaceCrop(
      { x: 0, y: 0, width: 1, height: 1 },
      { x: 0.999, y: 0.999, width: 0.001, height: 0.001 },
      500,
      250,
      2000,
      1000
    );

    expect(crop.cropX + crop.cropWidth).toBeLessThanOrEqual(2000);
    expect(crop.cropY + crop.cropHeight).toBeLessThanOrEqual(1000);
  });
});

describe('toRenderedCrop', () => {
  it('重开对话框时能把源图像素还原成渲染框', () => {
    const rendered = toRenderedCrop(
      { cropX: 200, cropY: 100, cropWidth: 800, cropHeight: 500 },
      500,
      250,
      2000,
      1000
    );

    expect(rendered).toEqual({ x: 50, y: 25, width: 200, height: 125 });
  });

  it('源图尺寸未知时不除零', () => {
    const rendered = toRenderedCrop({ cropX: 10, cropY: 10, cropWidth: 10, cropHeight: 10 }, 100, 100, 0, 0);

    expect(Number.isFinite(rendered.x)).toBe(true);
    expect(rendered.width).toBeGreaterThanOrEqual(1);
  });
});
