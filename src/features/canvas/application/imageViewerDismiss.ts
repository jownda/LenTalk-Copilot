/**
 * 图片预览「点击任意处关闭」的判定。
 *
 * 预览层只有两种鼠标手势: 单击(想关掉)与按住拖拽(想看图的其余部分)。两者都以
 * `click` 事件收尾, 所以只能靠「按下点到抬起点的位移」来区分 —— 超过阈值判定为
 * 拖拽, 此时不关闭, 否则用户每次平移图片都会被顺手关掉。
 *
 * 阈值取 5px: 足够滤掉手抖与触控板微动, 又不会让人误以为点击失灵。
 */
export const CLICK_CLOSE_DRAG_THRESHOLD_PX = 5;

export interface PointerPoint {
  x: number;
  y: number;
}

/**
 * 该次点击是否应关闭预览。
 *
 * @param start 按下时的坐标; 为 null(如没有按下记录的合成点击)时按「关闭」处理。
 * @param end 抬起(click)时的坐标。
 * @param thresholdPx 位移阈值, 恰好等于阈值仍算点击。
 */
export function shouldDismissOnClick(
  start: PointerPoint | null,
  end: PointerPoint,
  thresholdPx: number = CLICK_CLOSE_DRAG_THRESHOLD_PX,
): boolean {
  if (!start) return true;
  return Math.hypot(end.x - start.x, end.y - start.y) <= thresholdPx;
}
