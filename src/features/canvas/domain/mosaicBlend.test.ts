import { describe, expect, it } from 'vitest';

import { MOSAIC_BLEND_MODE_OPTIONS, mosaicBlendOperation, normalizeRotation, rotatedLayerBounds } from './mosaicBlend';

describe('mosaicBlendOperation', () => {
  it('枚举名与 canvas 合成算子一一对应', () => {
    expect(mosaicBlendOperation('normal')).toBe('source-over');
    expect(mosaicBlendOperation('multiply')).toBe('multiply');
    expect(mosaicBlendOperation('screen')).toBe('screen');
    expect(mosaicBlendOperation('soft-light')).toBe('soft-light');
  });

  it('缺省/未知值退回正常叠加（不抛错，避免导出整批失败）', () => {
    expect(mosaicBlendOperation(undefined)).toBe('source-over');
    expect(mosaicBlendOperation(null)).toBe('source-over');
    // 老数据里可能存了别的字符串
    expect(mosaicBlendOperation('nope' as never)).toBe('source-over');
  });

  it('选项列表覆盖全部枚举且标签不重复', () => {
    const ids = MOSAIC_BLEND_MODE_OPTIONS.map((option) => option.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('normal');
    expect(ids).toContain('difference');
  });
});

describe('normalizeRotation', () => {
  it('把角度收进 (-180, 180]', () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(90)).toBe(90);
    expect(normalizeRotation(190)).toBe(-170);
    expect(normalizeRotation(-190)).toBe(170);
    expect(normalizeRotation(360)).toBe(0);
    expect(normalizeRotation(720 + 45)).toBe(45);
  });

  it('非数字退回 0', () => {
    expect(normalizeRotation(Number.NaN)).toBe(0);
    expect(normalizeRotation(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('rotatedLayerBounds', () => {
  it('不旋转时就是原矩形', () => {
    expect(rotatedLayerBounds({ x: 10, y: 20, width: 100, height: 50 })).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 50,
    });
  });

  it('90 度时宽高互换，中心不变', () => {
    const bounds = rotatedLayerBounds({ x: 0, y: 0, width: 100, height: 50, rotation: 90 });
    expect(bounds.width).toBeCloseTo(50, 5);
    expect(bounds.height).toBeCloseTo(100, 5);
    expect(bounds.x + bounds.width / 2).toBeCloseTo(50, 5);
    expect(bounds.y + bounds.height / 2).toBeCloseTo(25, 5);
  });

  it('45 度时包围盒按 |cos|+|sin| 放大', () => {
    const bounds = rotatedLayerBounds({ x: 0, y: 0, width: 100, height: 100, rotation: 45 });
    expect(bounds.width).toBeCloseTo(141.42, 1);
    expect(bounds.height).toBeCloseTo(141.42, 1);
  });
});
