import { describe, expect, it } from "vitest";

import { CANVAS_NODE_TYPES, type CanvasNode } from "../domain/canvasNodes";
import {
  ALIGNMENT_GUIDE_SNAP_THRESHOLD,
  computeDragAlignment,
  computeSmartSnapLayout,
  SMART_SNAP_THRESHOLD,
  SNAP_EDGE_GAP,
} from "./canvasLayout";

function createNode(id: string, x: number, y: number, width = 220, height = 200, parentId?: string): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.exportImage,
    position: { x, y },
    measured: { width, height },
    data: {},
    ...(parentId ? { parentId } : {}),
  } as CanvasNode;
}

describe("computeSmartSnapLayout", () => {
  it("左边缘相距 ≤ 阈值时对齐到基准节点左边缘", () => {
    // c 先处理(y=0)固定; b 后处理, b.left=110 距 c.left=100 仅 10px → 吸附到 100
    const nodes = [createNode("c", 100, 100), createNode("b", 110, 500)];
    const result = computeSmartSnapLayout(nodes, SMART_SNAP_THRESHOLD);
    expect(result.get("b")).toEqual({ x: 100, y: 500 });
    // 基准节点不被后续节点拉动
    expect(result.get("c")).toEqual({ x: 100, y: 100 });
  });

  it("右缘贴近基准右边缘时对齐并留间隙(不紧紧挨着)", () => {
    // c: 100..320; b.left=326 距 c.right=320 仅 6px → b 吸到 320 + 24 空隙
    const nodes = [createNode("c", 100, 100), createNode("b", 326, 500)];
    const result = computeSmartSnapLayout(nodes, SMART_SNAP_THRESHOLD);
    expect(result.get("b")).toEqual({ x: 320 + SNAP_EDGE_GAP, y: 500 });
    expect(result.get("c")).toEqual({ x: 100, y: 100 });
  });

  it("左缘贴近基准左边缘时对齐并留间隙(右侧节点贴左侧节点)", () => {
    // c 在右侧固定: c.left=300; b.right=304 距 c.left=300 仅 4px → b 吸到 300 - 宽 - 24
    const nodes = [createNode("c", 300, 100), createNode("b", 84, 500)];
    const result = computeSmartSnapLayout(nodes, SMART_SNAP_THRESHOLD);
    expect(result.get("b")).toEqual({ x: 300 - 220 - SNAP_EDGE_GAP, y: 500 });
  });

  it("上缘贴近基准下边缘时对齐并留间隙", () => {
    // c: y 100..300; b.top=304 距 c.bottom=300 仅 4px → b 吸到 300 + 24
    const nodes = [createNode("c", 0, 100), createNode("b", 0, 304)];
    const result = computeSmartSnapLayout(nodes, SMART_SNAP_THRESHOLD);
    expect(result.get("b")).toEqual({ x: 0, y: 300 + SNAP_EDGE_GAP });
  });

  it("中心线接近时不进行自动吸附", () => {
    // c(0,0,220x200): b 宽 100, x=58 时 b.cx=108, 但左右边缘均不接近 c 的边缘
    const nodes = [createNode("c", 0, 0), createNode("b", 58, 500, 100, 100)];
    const result = computeSmartSnapLayout(nodes, SMART_SNAP_THRESHOLD);
    expect(result.get("b")).toEqual({ x: 58, y: 500 });
  });

  it("距离超过阈值时不吸附", () => {
    const nodes = [createNode("c", 100, 100), createNode("b", 250, 500)];
    // b.left=250 距 c 所有线(100/210/320) 均 ≥ 40px > 12 → 不吸附
    const result = computeSmartSnapLayout(nodes, SMART_SNAP_THRESHOLD);
    expect(result.get("b")).toEqual({ x: 250, y: 500 });
  });

  it("组的边框作为参考线(组是顶层节点, 子节点不单独吸附)", () => {
    // group 先处理固定; solo.left=408 距 group.right=400 仅 8px → 吸到 400 + 24 空隙
    const group = createNode("group", 0, 0, 400, 300);
    const child = createNode("child", 10, 10, 100, 100, "group");
    const solo = createNode("solo", 408, 600);
    const nodes = [group, child, solo];
    const result = computeSmartSnapLayout(nodes, SMART_SNAP_THRESHOLD);
    expect(result.get("solo")).toEqual({ x: 400 + SNAP_EDGE_GAP, y: 600 });
    // 子节点不参与吸附(result 不含 child, 运行时保持原位)
    expect(result.has("child")).toBe(false);
    // 组本身是第一个固定节点, 位置不变
    expect(result.get("group")).toEqual({ x: 0, y: 0 });
  });

  it("整齐的一列 + 偏移节点: 整列不动, 偏移节点被吸正", () => {
    // a/b/c x=100 已对齐(y 方向互不重叠); d 在 x=108 偏移 8px → 吸到 100; 整列不被拉动
    const nodes = [
      createNode("a", 100, 100),
      createNode("d", 108, 330),
      createNode("b", 100, 650),
      createNode("c", 100, 1000),
    ];
    const result = computeSmartSnapLayout(nodes, SMART_SNAP_THRESHOLD);
    expect(result.get("d")).toEqual({ x: 100, y: 330 });
    expect(result.get("a")).toEqual({ x: 100, y: 100 });
    expect(result.get("b")).toEqual({ x: 100, y: 650 });
    expect(result.get("c")).toEqual({ x: 100, y: 1000 });
  });

  it("再次一键整理时，已符合边框和标准间隙的节点保持原位", () => {
    const nodes = [createNode("a", 100, 100), createNode("b", 100, 308), createNode("c", 328, 100)];

    const result = computeSmartSnapLayout(nodes, SMART_SNAP_THRESHOLD);

    expect(result.get("a")).toEqual({ x: 100, y: 100 });
    expect(result.get("b")).toEqual({ x: 100, y: 308 });
    expect(result.get("c")).toEqual({ x: 328, y: 100 });
  });

  it("4 个同尺寸方块整理后拼成方阵(横平竖直, 不推远)", () => {
    // 每个方块都略微偏移(≤阈值): a 固定, b 右上(微偏), c 左下(微偏), d 右下(微偏)
    const nodes = [
      createNode("a", 0, 0, 200, 200),
      createNode("b", 190, 5, 200, 200),
      createNode("c", 5, 190, 200, 200),
      createNode("d", 195, 195, 200, 200),
    ];
    const result = computeSmartSnapLayout(nodes, SMART_SNAP_THRESHOLD);
    // 整理后拼成 2×2 方阵(中间留 SNAP_EDGE_GAP 缝隙), 各节点位移都很小
    expect(result.get("a")).toEqual({ x: 0, y: 0 });
    expect(result.get("b")).toEqual({ x: 200 + SNAP_EDGE_GAP, y: 0 });
    expect(result.get("c")).toEqual({ x: 0, y: 200 + SNAP_EDGE_GAP });
    expect(result.get("d")).toEqual({ x: 200 + SNAP_EDGE_GAP, y: 200 + SNAP_EDGE_GAP });
  });

  it("吸附后纵向重叠时自动错开(y 方向)", () => {
    // c 固定; a.left=6 → 吸到 c.left=0; b 不按中心线吸附, 保持 x=50;
    // a(0..220, 300..500) 与 b(50..150, 320..420) x/y 均重叠 → b 下移错开
    const nodes = [createNode("c", 0, 0), createNode("a", 6, 300), createNode("b", 50, 320, 100, 100)];
    const result = computeSmartSnapLayout(nodes, SMART_SNAP_THRESHOLD);
    expect(result.get("a")).toEqual({ x: 0, y: 300 });
    expect(result.get("b")?.x).toBe(50);
    const aPos = result.get("a") as { x: number; y: number };
    const bPos = result.get("b") as { x: number; y: number };
    // b 在 a 下方且重叠 → b.y ≥ a.bottom + 24 = 500 + 24
    expect(bPos.y).toBeGreaterThanOrEqual(aPos.y + 200 + 24);
  });
});

describe("computeDragAlignment", () => {
  it("接近左边缘时吸附并返回垂直辅助线", () => {
    const result = computeDragAlignment(
      { id: "moving", x: 108, y: 400, width: 100, height: 80 },
      [{ id: "reference", x: 100, y: 100, width: 220, height: 200 }],
      ALIGNMENT_GUIDE_SNAP_THRESHOLD,
    );

    expect(result.position.x).toBe(100);
    expect(result.guides).toContainEqual({
      axis: "vertical",
      position: 100,
      start: 300,
      end: 400,
    });
  });

  it("接近上边缘时吸附并返回水平辅助线", () => {
    const result = computeDragAlignment(
      { id: "moving", x: 500, y: 112, width: 100, height: 80 },
      [{ id: "reference", x: 100, y: 100, width: 220, height: 200 }],
      ALIGNMENT_GUIDE_SNAP_THRESHOLD,
    );

    expect(result.position.y).toBe(100);
    expect(result.guides).toContainEqual({
      axis: "horizontal",
      position: 100,
      start: 320,
      end: 500,
    });
  });

  it("节点在辅助线方向重叠时仍吸附，但不让辅助线穿过节点内部", () => {
    const result = computeDragAlignment(
      { id: "moving", x: 108, y: 160, width: 100, height: 80 },
      [{ id: "reference", x: 100, y: 100, width: 220, height: 200 }],
      ALIGNMENT_GUIDE_SNAP_THRESHOLD,
    );

    expect(result.position.x).toBe(100);
    expect(result.guides).toEqual([]);
  });

  it("超过吸附阈值时保持原位置且不显示辅助线", () => {
    const result = computeDragAlignment(
      { id: "moving", x: 350, y: 400, width: 100, height: 80 },
      [{ id: "reference", x: 100, y: 100, width: 220, height: 200 }],
      ALIGNMENT_GUIDE_SNAP_THRESHOLD,
    );

    expect(result.position).toEqual({ x: 350, y: 400 });
    expect(result.guides).toEqual([]);
  });
});
