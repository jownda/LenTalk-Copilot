import type { MosaicLayerItem } from "@/features/canvas/domain/canvasNodes";

/**
 * 图层移动吸附的候选线：一条「目标 x/y」及其来源（画布还是别的图层）。
 * 只做纯计算，不碰 React 状态，方便单测。
 */
export interface SnapCandidate {
  /** 目标坐标（画布像素）。 */
  value: number;
  /** 这条线来自画布还是某个图层，仅用于调试/测试断言。 */
  source: "canvas" | "layer";
}

/**
 * 计算「吸附后」的图层位置。
 *
 * 移动图层时，把它的四条边 / 中心线去靠下面的候选线：
 * - 画布四边（0、canvasWidth / canvasHeight）
 * - 画布水平 / 垂直中心线
 * - 其它图层的四条边与中心线
 *
 * 阈值按 `snapPx`（屏幕像素）给，调用方用画布缩放 `scale` 把屏幕像素折成画布像素，
 * 这样放大缩小画布时，「感觉上要吸多近」保持一致。
 *
 * 返回「吸附后的位置」与「命中了哪条线」，命中时调用方可以画一条辅助线提示。
 */
export function snapLayerPosition(
  layer: Pick<MosaicLayerItem, "x" | "y" | "width" | "height">,
  canvasWidth: number,
  canvasHeight: number,
  others: ReadonlyArray<Pick<MosaicLayerItem, "x" | "y" | "width" | "height">>,
  snapPx: number,
): { x: number; y: number; snapped: boolean } {
  const left = layer.x;
  const top = layer.y;
  const right = layer.x + layer.width;
  const bottom = layer.y + layer.height;
  const centerX = layer.x + layer.width / 2;
  const centerY = layer.y + layer.height / 2;

  // 画布候选线（x 方向 + y 方向）。
  const candidatesX: SnapCandidate[] = [
    { value: 0, source: "canvas" },
    { value: canvasWidth / 2, source: "canvas" },
    { value: canvasWidth, source: "canvas" },
  ];
  const candidatesY: SnapCandidate[] = [
    { value: 0, source: "canvas" },
    { value: canvasHeight / 2, source: "canvas" },
    { value: canvasHeight, source: "canvas" },
  ];

  // 其它图层的候选线。
  for (const other of others) {
    candidatesX.push(
      { value: other.x, source: "layer" },
      { value: other.x + other.width / 2, source: "layer" },
      { value: other.x + other.width, source: "layer" },
    );
    candidatesY.push(
      { value: other.y, source: "layer" },
      { value: other.y + other.height / 2, source: "layer" },
      { value: other.y + other.height, source: "layer" },
    );
  }

  // 被移动图层的「锚点」在 x / y 上分别可对上的位置。
  const anchorsX = [left, centerX, right];
  const anchorsY = [top, centerY, bottom];

  const bestX = snapAxis(anchorsX, candidatesX, snapPx);
  const bestY = snapAxis(anchorsY, candidatesY, snapPx);

  return {
    x: bestX.delta === 0 ? layer.x : layer.x + bestX.delta,
    y: bestY.delta === 0 ? layer.y : layer.y + bestY.delta,
    snapped: bestX.delta !== 0 || bestY.delta !== 0,
  };
}

/**
 * 单轴吸附：给定一组「当前锚点」与一组「候选线」，返回让某个锚点贴到最近候选线的位移。
 * 没有候选线在阈值内则位移为 0。
 */
function snapAxis(
  anchors: number[],
  candidates: SnapCandidate[],
  snapPx: number,
): { delta: number } {
  let bestDelta = 0;
  let bestDistance = snapPx;
  for (const anchor of anchors) {
    for (const candidate of candidates) {
      const delta = candidate.value - anchor;
      const distance = Math.abs(delta);
      if (distance <= bestDistance) {
        bestDistance = distance;
        bestDelta = delta;
      }
    }
  }
  return { delta: bestDelta };
}
