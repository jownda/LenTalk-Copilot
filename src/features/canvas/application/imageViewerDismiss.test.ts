import { describe, expect, it } from 'vitest';
import { CLICK_CLOSE_DRAG_THRESHOLD_PX, shouldDismissOnClick } from './imageViewerDismiss';

describe('shouldDismissOnClick', () => {
  const origin = { x: 100, y: 100 };

  it('原地点击关闭', () => {
    expect(shouldDismissOnClick(origin, { x: 100, y: 100 })).toBe(true);
  });

  it('手抖 1px 仍算点击并关闭', () => {
    expect(shouldDismissOnClick(origin, { x: 101, y: 100 })).toBe(true);
  });

  it('位移恰好等于阈值仍关闭(阈值语义为「超过才不关」)', () => {
    expect(shouldDismissOnClick(origin, { x: 100 + CLICK_CLOSE_DRAG_THRESHOLD_PX, y: 100 })).toBe(true);
  });

  it('超过阈值视为拖拽平移, 不关闭', () => {
    expect(shouldDismissOnClick(origin, { x: 100 + CLICK_CLOSE_DRAG_THRESHOLD_PX + 1, y: 100 })).toBe(false);
  });

  it('斜向拖拽按欧氏距离判定', () => {
    expect(shouldDismissOnClick(origin, { x: 103, y: 103 })).toBe(true);
    expect(shouldDismissOnClick(origin, { x: 104, y: 104 })).toBe(false);
  });

  it('反方向拖拽同样按位移判定', () => {
    expect(shouldDismissOnClick(origin, { x: 80, y: 100 })).toBe(false);
  });

  it('没有按下记录时默认关闭', () => {
    expect(shouldDismissOnClick(null, { x: 0, y: 0 })).toBe(true);
  });
});
