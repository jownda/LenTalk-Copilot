import { describe, expect, it } from "vitest";

import { snapLayerPosition } from "./layerSnap";

describe("layerSnap.snapLayerPosition", () => {
  const canvas = { width: 1000, height: 800 };

  it("贴近画布左边缘时吸附到 x=0", () => {
    const layer = { x: 4, y: 100, width: 200, height: 150 };
    const result = snapLayerPosition(layer, canvas.width, canvas.height, [], 6);
    expect(result.x).toBe(0);
    expect(result.snapped).toBe(true);
  });

  it("贴近画布右边缘时吸附（右缘对齐 canvas.width）", () => {
    const layer = { x: 796, y: 100, width: 200, height: 150 };
    const result = snapLayerPosition(layer, canvas.width, canvas.height, [], 6);
    expect(result.x).toBe(800);
  });

  it("贴近水平中心线时吸附到画布中心", () => {
    // 图层中心线 = x + width/2 = 502，距离画布中心 500 差 2px → 吸附
    const layer = { x: 402, y: 50, width: 200, height: 150 };
    const result = snapLayerPosition(layer, canvas.width, canvas.height, [], 6);
    // 中心线吸附：中心 x 变成 500，则左缘 = 400
    expect(result.x).toBe(400);
  });

  it("吸附到另一个图层的边缘", () => {
    const other = { x: 300, y: 100, width: 100, height: 100 };
    // 移动图层右缘 = x+width = 302，距离 other 左缘 300 差 2 → 吸附
    const layer = { x: 102, y: 100, width: 200, height: 150 };
    const result = snapLayerPosition(layer, canvas.width, canvas.height, [other], 6);
    // 右缘对齐 other.x=300，则左缘 = 100
    expect(result.x).toBe(100);
  });

  it("阈值外不吸附", () => {
    const layer = { x: 20, y: 100, width: 200, height: 150 };
    const result = snapLayerPosition(layer, canvas.width, canvas.height, [], 6);
    expect(result.x).toBe(20);
    expect(result.snapped).toBe(false);
  });

  it("同时贴近横向与纵向候选时两个轴都吸附", () => {
    const layer = { x: 4, y: 4, width: 200, height: 150 };
    const result = snapLayerPosition(layer, canvas.width, canvas.height, [], 6);
    expect(result.x).toBe(0);
    expect(result.y).toBe(0);
  });
});
