/**
 * 图片/视频节点的「边框贴合画面」尺寸计算。
 *
 * 这类节点的盒子就是画面本身: 边框必须与媒体同比例, 否则画面周围会留黑边,
 * 看起来像「边框被拉大了、画面没跟上」。这里提供与框架无关的纯函数 ——
 * 给定媒体的真实宽高和节点当前的盒子, 算出一个同比例、且视觉体量(面积)
 * 基本不变的尺寸, 让边框在媒体换了一张不同比例的画面后依然贴合。
 */

export interface MediaNodeBoxSize {
  width: number;
  height: number;
}

export interface MediaNodeFitOptions {
  /** 短边下限; 太小的边框看不清画面, 也点不到工具栏。 */
  minEdge?: number;
  /** 长边上限; 与历史各节点的 maxWidth/maxHeight 保持一致。 */
  maxEdge?: number;
}

/** 节点最小短边(与 EXPORT_RESULT_NODE_MIN_WIDTH/HEIGHT 同源)。 */
export const MEDIA_NODE_FIT_MIN_EDGE = 96;
/** 节点最大长边(与历史缩放上限一致)。 */
export const MEDIA_NODE_FIT_MAX_EDGE = 1600;

function isUsablePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * 按媒体比例重算节点尺寸。
 *
 * - 面积取当前盒子的面积: 换画面时不至于从 96px 一下跳到 400px(或反过来),
 *   现有画布布局不会被打乱;
 * - 短边低于 `minEdge` 时整体放大, 长边超过 `maxEdge` 时整体缩小, 全程保持比例。
 *
 * 媒体宽高不合法时返回 null, 调用方应保持原尺寸不做修改。
 */
export function resolveMediaNodeFitSize(
  mediaWidth: number,
  mediaHeight: number,
  box: MediaNodeBoxSize,
  options?: MediaNodeFitOptions
): MediaNodeBoxSize | null {
  if (!isUsablePositive(mediaWidth) || !isUsablePositive(mediaHeight)) {
    return null;
  }

  const ratio = mediaWidth / mediaHeight;
  const boxWidth = isUsablePositive(box?.width) ? box.width : MEDIA_NODE_FIT_MIN_EDGE;
  const boxHeight = isUsablePositive(box?.height) ? box.height : MEDIA_NODE_FIT_MIN_EDGE;

  const minEdge = isUsablePositive(options?.minEdge)
    ? (options?.minEdge as number)
    : MEDIA_NODE_FIT_MIN_EDGE;
  const maxEdge = Math.max(
    minEdge,
    isUsablePositive(options?.maxEdge) ? (options?.maxEdge as number) : MEDIA_NODE_FIT_MAX_EDGE
  );

  const area = boxWidth * boxHeight;
  // 面积固定时 width = sqrt(area * ratio), height = width / ratio。
  let width = Math.sqrt(area * ratio);
  let height = width / ratio;

  const shortEdge = Math.min(width, height);
  if (shortEdge > 0 && shortEdge < minEdge) {
    const scale = minEdge / shortEdge;
    width *= scale;
    height *= scale;
  }

  const longEdge = Math.max(width, height);
  if (longEdge > maxEdge) {
    const scale = maxEdge / longEdge;
    width *= scale;
    height *= scale;
  }

  if (!isUsablePositive(width) || !isUsablePositive(height)) {
    return null;
  }

  return {
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
  };
}

/** 尺寸是否已经贴合目标(允许 1px 的取整误差)。 */
export function isMediaNodeSizeSettled(
  current: MediaNodeBoxSize | null | undefined,
  target: MediaNodeBoxSize | null | undefined
): boolean {
  if (!current || !target) {
    return false;
  }
  if (!isUsablePositive(current.width) || !isUsablePositive(current.height)) {
    return false;
  }
  return Math.abs(current.width - target.width) <= 1 && Math.abs(current.height - target.height) <= 1;
}

/**
 * 盒子当前的宽高比是否已经贴合媒体(默认允许 1% 偏差)。
 *
 * 用途: 用户手动拖过边框的媒体节点会被标记「手动尺寸」, 但那并不意味着它的比例
 * 还和画面一致 —— 老工程里可能残留着被拖歪的盒子。只有比例对得上才保留用户尺寸,
 * 对不上仍要按画面收敛, 否则画面会被拉伸或四周留黑边。
 */
export function isMediaNodeBoxRatioMatching(
  box: MediaNodeBoxSize | null | undefined,
  mediaWidth: number,
  mediaHeight: number,
  tolerance = 0.01
): boolean {
  if (!box || !isUsablePositive(box.width) || !isUsablePositive(box.height)) {
    return false;
  }
  if (!isUsablePositive(mediaWidth) || !isUsablePositive(mediaHeight)) {
    return false;
  }

  const boxRatio = box.width / box.height;
  const mediaRatio = mediaWidth / mediaHeight;
  return Math.abs(boxRatio - mediaRatio) / mediaRatio <= tolerance;
}
