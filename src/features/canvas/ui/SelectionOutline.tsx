import { useMemo } from "react";

import type { Selection } from "@/features/canvas/application/selection";

/**
 * 蚂蚁线（marching ants）选区轮廓。
 *
 * 两种模式：
 * - 矢量模式（默认）：`selection` 传入矩形/椭圆/套索形状，直接画闭合 path。
 * - 点阵模式：`boundary` 传入从掩码提取的边界点集（布尔运算/反选后），逐点描边。
 *
 * 用 SVG 叠加在画板上：`stroke-dasharray` + `stroke-dashoffset` 流动的 CSS 动画，
 * 就是经典的「黑白相间虚线往前爬」。
 */
export function SelectionOutline({
  selection,
  boundary,
  canvasWidth,
  canvasHeight,
  scale,
}: {
  selection?: Selection | null;
  /** 从掩码提取的边界点集；给非空时优先于点阵渲染（布尔/反选后的真实轮廓）。 */
  boundary?: Array<{ x: number; y: number }> | null;
  canvasWidth: number;
  canvasHeight: number;
  scale: number;
}) {
  const d = useMemo(() => {
    if (!selection) {
      return "";
    }
    const shape = selection.shape;
    if (shape.kind === "rect") {
      const { x, y, width, height } = shape;
      return `M ${x} ${y} H ${x + width} V ${y + height} H ${x} Z`;
    }
    if (shape.kind === "ellipse") {
      const cx = shape.x + shape.width / 2;
      const cy = shape.y + shape.height / 2;
      const rx = Math.max(1e-6, shape.width / 2);
      const ry = Math.max(1e-6, shape.height / 2);
      return [
        `M ${cx - rx} ${cy}`,
        `A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy}`,
        `A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy}`,
        "Z",
      ].join(" ");
    }
    const points = shape.points;
    if (points.length === 0) {
      return "";
    }
    return (
      points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ") +
      " Z"
    );
  }, [selection]);

  // 点阵模式的 path：把每个边界点当 1px 线段，密集描边即轮廓。
  const boundaryPath = useMemo(() => {
    if (!boundary || boundary.length === 0) {
      return "";
    }
    const step = 1; // 每个点画成极短竖线，连起来就是虚线蚂蚁线
    return boundary
      .map((point) => `M ${point.x} ${point.y} h ${step}`)
      .join(" ");
  }, [boundary]);

  if ((!selection && !boundary) || (!d && !boundaryPath)) {
    return null;
  }

  const strokeWidth = 1.5 / Math.max(0.01, scale);
  const dash = 4 / Math.max(0.01, scale);
  const pathData = boundaryPath || d;

  return (
    <svg
      className="pointer-events-none absolute left-0 top-0"
      width="100%"
      height="100%"
      viewBox={`0 0 ${Math.max(1, canvasWidth)} ${Math.max(1, canvasHeight)}`}
    >
      <path d={pathData} fill="none" stroke="#000" strokeWidth={strokeWidth} />
      <path
        d={pathData}
        fill="none"
        stroke="#fff"
        strokeWidth={strokeWidth}
        strokeDasharray={`${dash} ${dash}`}
        strokeDashoffset="0"
        className="selection-ants"
      />
    </svg>
  );
}

/** 供应用注入的 CSS：让白虚线流动。注入点见 `SeamlessMosaicEditor` 的样式。 */
export const SELECTION_ANTS_CSS = `
@keyframes selection-ants-march {
  to { stroke-dashoffset: -16px; }
}
.selection-ants {
  animation: selection-ants-march 0.5s linear infinite;
}
`;
