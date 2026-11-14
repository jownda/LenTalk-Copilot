import { describe, expect, it } from 'vitest';

import type { MosaicLayerItem } from '@/features/canvas/domain/canvasNodes';
import {
  fitCanvasToSingleLayer,
  initialLayerBox,
  layerFillRect,
  layerImageAspect,
  nodeSizeForCanvasAspect,
  parseAspectRatio,
  snugLayerToImage,
} from './mosaicFit';

function makeLayer(patch: Partial<MosaicLayerItem> = {}): MosaicLayerItem {
  return {
    id: 'layer-1',
    imageUrl: 'asset://a.png',
    aspectRatio: '4:3',
    x: 0,
    y: 0,
    width: 512,
    height: 384,
    visible: true,
    order: 0,
    ...patch,
  };
}

describe('parseAspectRatio', () => {
  it('支持冒号 / 斜杠 / 全角冒号，取不到时按 1', () => {
    expect(parseAspectRatio('1920:1080')).toBeCloseTo(16 / 9);
    expect(parseAspectRatio('4/3')).toBeCloseTo(4 / 3);
    expect(parseAspectRatio('4：3')).toBeCloseTo(4 / 3);
    expect(parseAspectRatio('')).toBe(1);
    expect(parseAspectRatio('square')).toBe(1);
  });
});

describe('layerImageAspect', () => {
  it('把裁剪也算进可见比例', () => {
    expect(layerImageAspect(makeLayer())).toBeCloseTo(4 / 3);
    expect(
      layerImageAspect(makeLayer({ crop: { x: 0, y: 0, width: 0.5, height: 1 } })),
    ).toBeCloseTo((4 / 3) * 0.5);
  });
});

describe('initialLayerBox', () => {
  it('横图按宽度定基准，竖图按高度定基准 —— 不再一律正方形', () => {
    expect(initialLayerBox('4:3')).toEqual({ width: 512, height: 384 });
    expect(initialLayerBox('3:4')).toEqual({ width: 384, height: 512 });
    expect(initialLayerBox('1:1')).toEqual({ width: 512, height: 512 });
  });
});

describe('snugLayerToImage', () => {
  it('正方框配 4:3 的图 → 宽度不变，高度收到 4:3，中心不动', () => {
    const snug = snugLayerToImage(makeLayer({ y: 100, width: 512, height: 512 }));
    expect(snug).toMatchObject({ x: 0, width: 512, height: 384 });
    // 中心 y 仍是 100 + 512/2 = 356
    expect(snug!.y + snug!.height / 2).toBeCloseTo(356);
  });

  it('已经贴合就不动', () => {
    expect(snugLayerToImage(makeLayer())).toBeNull();
  });

  it('保宽度会把框顶出画幅时，改用保高度（不裁掉图的上下）', () => {
    const layer = makeLayer({
      x: 100,
      y: 100,
      width: 600,
      height: 200,
      crop: { x: 0, y: 0, width: 0.375, height: 1 },
    });
    expect(snugLayerToImage(layer, { width: 1000, height: 1000 })).toMatchObject({
      x: 350,
      y: 100,
      width: 100,
      height: 200,
    });
  });
});

describe('fitCanvasToSingleLayer', () => {
  it('单图层：画幅贴住图片，图层归零到左上角', () => {
    const fit = fitCanvasToSingleLayer([makeLayer({ x: 0, y: 0, width: 1920, height: 1080 })], 1920, 1080);
    expect(fit).not.toBeNull();
    expect({ width: fit!.width, height: fit!.height }).toEqual({ width: 1920, height: 1440 });
    expect(fit!.layers[0]).toMatchObject({ x: 0, y: 0, width: 1920, height: 1440 });
  });

  it('多图层不动画幅（画幅是拼图版面）', () => {
    expect(
      fitCanvasToSingleLayer([makeLayer(), makeLayer({ id: 'layer-2', order: 1 })], 1920, 1080),
    ).toBeNull();
  });

  it('有旋转不动（外接矩形不等于图片本身）', () => {
    expect(fitCanvasToSingleLayer([makeLayer({ rotation: 15 })], 1920, 1080)).toBeNull();
  });

  it('隐藏图层不参与，全隐藏时也不动', () => {
    expect(fitCanvasToSingleLayer([makeLayer({ visible: false })], 1920, 1080)).toBeNull();
  });

  it('已经贴合且占满画幅时返回 null', () => {
    expect(
      fitCanvasToSingleLayer([makeLayer({ width: 512, height: 384 })], 512, 384),
    ).toBeNull();
  });
});

describe('nodeSizeForCanvasAspect', () => {
  const bounds = { minWidth: 220, minHeight: 170, maxWidth: 1400, maxHeight: 1400 };

  it('按宽度锚定，高度跟着比例走', () => {
    expect(nodeSizeForCanvasAspect(4 / 3, 400, bounds)).toEqual({ width: 400, height: 300 });
  });

  it('太扁时以最小高度锚定，宽度反向补齐', () => {
    expect(nodeSizeForCanvasAspect(16 / 9, 260, bounds)).toEqual({ width: 302, height: 170 });
  });

  it('太高时以最大高度封顶', () => {
    const size = nodeSizeForCanvasAspect(1 / 4, 400, bounds);
    expect(size.height).toBe(1400);
    expect(size.width).toBe(350);
  });
});

describe('layerFillRect', () => {
  it('无裁剪时就是盒子的矩形', () => {
    expect(layerFillRect(makeLayer({ x: 10, y: 20, width: 300, height: 200 }))).toEqual({
      x: 10,
      y: 20,
      width: 300,
      height: 200,
    });
  });

  it('有裁剪时按「框 / 裁剪比例」放大并把偏移吃到负方向', () => {
    const rect = layerFillRect(
      makeLayer({
        x: 100,
        y: 50,
        width: 600,
        height: 400,
        crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.5 },
      }),
    );
    expect(rect.width).toBe(1200);
    expect(rect.height).toBe(800);
    expect(rect.x).toBeCloseTo(100 - 0.1 * 1200);
    expect(rect.y).toBeCloseTo(50 - 0.2 * 800);
  });
});
