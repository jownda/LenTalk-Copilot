import { describe, expect, it } from "vitest";

import {
  combineSelectionMasks,
  invertSelectionMask,
  isSelectionEmpty,
  maskToBoundaryPoints,
  rectFromPoints,
  selectionBounds,
  selectionContainsPoint,
  selectionToMask,
  type Selection,
} from "./selection";

describe("selection.rectFromPoints", () => {
  it("任意对角点都归一化成非负宽高", () => {
    expect(rectFromPoints(100, 100, 200, 250)).toEqual({ x: 100, y: 100, width: 100, height: 150 });
    expect(rectFromPoints(200, 250, 100, 100)).toEqual({ x: 100, y: 100, width: 100, height: 150 });
  });
});

describe("selection.selectionContainsPoint", () => {
  it("矩形选区命中", () => {
    const selection: Selection = { shape: { kind: "rect", x: 10, y: 10, width: 20, height: 30 }, feather: 0 };
    expect(selectionContainsPoint(selection, 15, 20)).toBe(true);
    expect(selectionContainsPoint(selection, 5, 20)).toBe(false);
    expect(selectionContainsPoint(selection, 15, 50)).toBe(false);
  });

  it("椭圆选区命中", () => {
    const selection: Selection = { shape: { kind: "ellipse", x: 0, y: 0, width: 100, height: 100 }, feather: 0 };
    expect(selectionContainsPoint(selection, 50, 50)).toBe(true);
    expect(selectionContainsPoint(selection, 50, 0)).toBe(true);
    expect(selectionContainsPoint(selection, 95, 95)).toBe(false);
  });

  it("套索（多边形）选区命中（射线法）", () => {
    const selection: Selection = {
      shape: {
        kind: "lasso",
        points: [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
          { x: 100, y: 100 },
          { x: 0, y: 100 },
        ],
      },
      feather: 0,
    };
    expect(selectionContainsPoint(selection, 50, 50)).toBe(true);
    expect(selectionContainsPoint(selection, 150, 50)).toBe(false);
  });

  it("空选区 / null 都不命中", () => {
    expect(selectionContainsPoint(null, 0, 0)).toBe(false);
    expect(selectionContainsPoint({ shape: { kind: "lasso", points: [] }, feather: 0 }, 0, 0)).toBe(false);
  });
});

describe("selection.selectionToMask / 掩码布尔 / 反选", () => {
  const alphaAt = (mask: { width: number; height: number; data: Uint8ClampedArray }, x: number, y: number) =>
    mask.data[y * mask.width + x];

  it("选区栅格化成掩码，选中像素不透明、外部透明", () => {
    const selection: Selection = { shape: { kind: "rect", x: 10, y: 10, width: 20, height: 20 }, feather: 0 };
    const mask = selectionToMask(selection, 100, 100);
    expect(alphaAt(mask, 20, 20)).toBe(255);
    expect(alphaAt(mask, 5, 5)).toBe(0);
  });

  it("椭圆与套索同样栅格化", () => {
    const ellipse: Selection = { shape: { kind: "ellipse", x: 0, y: 0, width: 100, height: 100 }, feather: 0 };
    const em = selectionToMask(ellipse, 100, 100);
    expect(alphaAt(em, 50, 50)).toBe(255);
    expect(alphaAt(em, 95, 95)).toBe(0);

    const lasso: Selection = {
      shape: { kind: "lasso", points: [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 60 }, { x: 0, y: 60 }] },
      feather: 0,
    };
    const lm = selectionToMask(lasso, 100, 100);
    expect(alphaAt(lm, 30, 30)).toBe(255);
    expect(alphaAt(lm, 90, 30)).toBe(0);
  });

  it("加 / 减 / 交 布尔运算", () => {
    const a: Selection = { shape: { kind: "rect", x: 0, y: 0, width: 60, height: 60 }, feather: 0 };
    const b: Selection = { shape: { kind: "rect", x: 40, y: 40, width: 60, height: 60 }, feather: 0 };
    const maskA = selectionToMask(a, 100, 100);
    const maskB = selectionToMask(b, 100, 100);

    const add = combineSelectionMasks(maskA, maskB, "add");
    expect(alphaAt(add, 30, 30)).toBe(255); // 只在 A
    expect(alphaAt(add, 70, 70)).toBe(255); // 只在 B
    expect(alphaAt(add, 50, 50)).toBe(255); // 交集

    const subtract = combineSelectionMasks(maskA, maskB, "subtract");
    expect(alphaAt(subtract, 30, 30)).toBe(255); // A 保留
    expect(alphaAt(subtract, 50, 50)).toBe(0); // 交集被减掉

    const intersect = combineSelectionMasks(maskA, maskB, "intersect");
    expect(alphaAt(intersect, 30, 30)).toBe(0); // 只在 A，被去掉
    expect(alphaAt(intersect, 50, 50)).toBe(255); // 交集保留
  });

  it("反选：选中区变未选，未选区变选中", () => {
    const selection: Selection = { shape: { kind: "rect", x: 10, y: 10, width: 20, height: 20 }, feather: 0 };
    const mask = selectionToMask(selection, 100, 100);
    const inverted = invertSelectionMask(mask);
    expect(alphaAt(inverted, 20, 20)).toBe(0); // 原选中区变空
    expect(alphaAt(inverted, 90, 90)).toBe(255); // 原未选区变选中
  });

  it("掩码边界点提取：选中块边缘有点、内部无点", () => {
    const selection: Selection = { shape: { kind: "rect", x: 20, y: 20, width: 20, height: 20 }, feather: 0 };
    const mask = selectionToMask(selection, 60, 60);
    const points = maskToBoundaryPoints(mask, 1);
    const hasPoint = (x: number, y: number) => points.some((point) => point.x === x && point.y === y);
    expect(points.length).toBeGreaterThan(0);
    expect(hasPoint(20, 20)).toBe(true); // 边缘
    expect(hasPoint(30, 30)).toBe(false); // 内部
  });
});

describe("selection.selectionBounds / isSelectionEmpty", () => {
  it("矩形边界框正确", () => {
    const selection: Selection = { shape: { kind: "rect", x: 10, y: 20, width: 30, height: 40 }, feather: 0 };
    expect(selectionBounds(selection)).toEqual({ x: 10, y: 20, width: 30, height: 40 });
  });

  it("套索边界框是包围盒", () => {
    const selection: Selection = {
      shape: {
        kind: "lasso",
        points: [
          { x: 10, y: 50 },
          { x: 90, y: 10 },
          { x: 50, y: 90 },
        ],
      },
      feather: 0,
    };
    expect(selectionBounds(selection)).toEqual({ x: 10, y: 10, width: 80, height: 80 });
  });

  it("空选区判定", () => {
    expect(isSelectionEmpty(null)).toBe(true);
    expect(isSelectionEmpty({ shape: { kind: "rect", x: 0, y: 0, width: 0, height: 0 }, feather: 0 })).toBe(true);
    expect(isSelectionEmpty({ shape: { kind: "rect", x: 0, y: 0, width: 50, height: 50 }, feather: 0 })).toBe(false);
  });
});
