import { describe, expect, it } from 'vitest';

import { cropsNearlyEqual } from './CropToolEditor';

describe('cropsNearlyEqual', () => {
  const base = { unit: 'px' as const, x: 10, y: 20, width: 100, height: 80 };

  it('亚像素误差视为相同（不会因为取整把框抖一下）', () => {
    expect(cropsNearlyEqual(base, { ...base, x: 10.4, width: 100.3 })).toBe(true);
  });

  it('差 2px 以上视为不同（窗口尺寸变了就要重新落位）', () => {
    expect(cropsNearlyEqual(base, { ...base, x: 13 })).toBe(false);
    expect(cropsNearlyEqual(base, { ...base, width: 98 })).toBe(false);
  });

  it('两边都没有框时算相同', () => {
    expect(cropsNearlyEqual(undefined, undefined)).toBe(true);
  });

  it('一边有一边没有算不同', () => {
    expect(cropsNearlyEqual(base, undefined)).toBe(false);
    expect(cropsNearlyEqual(undefined, base)).toBe(false);
  });
});
