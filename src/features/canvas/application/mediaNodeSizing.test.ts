import { describe, it, expect } from 'vitest';

import {
  MEDIA_NODE_FIT_MAX_EDGE,
  MEDIA_NODE_FIT_MIN_EDGE,
  isMediaNodeSizeSettled,
  resolveMediaNodeFitSize,
} from './mediaNodeSizing';

describe('resolveMediaNodeFitSize: 边框贴合画面比例', () => {
  it('16:9 画面放进 16:9 的盒子时尺寸不变(幂等)', () => {
    const size = resolveMediaNodeFitSize(1920, 1080, { width: 171, height: 96 });
    expect(size).toEqual({ width: 171, height: 96 });
  });

  it('换成正方形画面时按面积重算成正方形(边框不留黑边)', () => {
    const size = resolveMediaNodeFitSize(1024, 1024, { width: 171, height: 96 });
    expect(size).not.toBeNull();
    expect(size?.width).toBe(size?.height);
    // 面积保持不变: 171 x 96 ≈ 16416, 正方形边长 ≈ 128
    expect(size?.width).toBe(128);
  });

  it('竖屏 9:16 画面会变成高瘦的盒子', () => {
    const size = resolveMediaNodeFitSize(1080, 1920, { width: 200, height: 100 });
    expect(size).not.toBeNull();
    expect(size!.height).toBeGreaterThan(size!.width);
    expect(size!.width / size!.height).toBeCloseTo(1080 / 1920, 2);
  });

  it('超宽画面受最小短边约束: 短边不会被压到看不出画面', () => {
    const size = resolveMediaNodeFitSize(4000, 1000, { width: 96, height: 96 });
    expect(size).not.toBeNull();
    expect(size!.height).toBe(MEDIA_NODE_FIT_MIN_EDGE);
    expect(size!.width).toBe(MEDIA_NODE_FIT_MIN_EDGE * 4);
  });

  it('超大比例不会超过长边上限', () => {
    const size = resolveMediaNodeFitSize(8000, 1000, { width: 1600, height: 1600 });
    expect(size).not.toBeNull();
    expect(Math.max(size!.width, size!.height)).toBeLessThanOrEqual(MEDIA_NODE_FIT_MAX_EDGE);
  });

  it('媒体宽高不合法时返回 null, 调用方保持原尺寸', () => {
    expect(resolveMediaNodeFitSize(0, 100, { width: 100, height: 100 })).toBeNull();
    expect(resolveMediaNodeFitSize(100, Number.NaN, { width: 100, height: 100 })).toBeNull();
  });

  it('盒子尺寸缺失时退回最小边, 不至于算出 0', () => {
    const size = resolveMediaNodeFitSize(1000, 1000, { width: 0, height: 0 });
    expect(size).toEqual({
      width: MEDIA_NODE_FIT_MIN_EDGE,
      height: MEDIA_NODE_FIT_MIN_EDGE,
    });
  });
});

describe('isMediaNodeSizeSettled: 1px 取整误差内视为已贴合', () => {
  it('相差 1px 不再触发重复写入', () => {
    expect(isMediaNodeSizeSettled({ width: 171, height: 96 }, { width: 172, height: 95 })).toBe(true);
  });

  it('相差 2px 仍需修正', () => {
    expect(isMediaNodeSizeSettled({ width: 171, height: 96 }, { width: 173, height: 96 })).toBe(false);
  });

  it('缺失尺寸一律视为未贴合', () => {
    expect(isMediaNodeSizeSettled(null, { width: 171, height: 96 })).toBe(false);
    expect(isMediaNodeSizeSettled({ width: 171, height: 96 }, null)).toBe(false);
  });
});
