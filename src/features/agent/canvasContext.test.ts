import { describe, expect, it } from "vitest";

import { extractToolResultNodeIds } from "./canvasContext";

describe("extractToolResultNodeIds", () => {
  it("单节点 / 批量 / 连线三种返回形状都认", () => {
    // 字段不统一是历史原因：单节点回 nodeId、批量回 nodeIds、连线回 source/target
    expect(extractToolResultNodeIds({ nodeId: "a", nodeName: "封面" })).toEqual(["a"]);
    expect(extractToolResultNodeIds({ nodeIds: ["a", "b"], nodeNames: ["A", "B"] })).toEqual([
      "a",
      "b",
    ]);
    expect(extractToolResultNodeIds({ edgeId: "e", source: "a", target: "b" })).toEqual(["a", "b"]);
  });

  it("去重、丢掉空值与非字符串", () => {
    expect(
      extractToolResultNodeIds({ nodeIds: ["a", "a", "", null, 3], nodeId: "a" }),
    ).toEqual(["a"]);
  });

  it("没有节点信息时返回空数组 —— 撤销、读快照这类卡片就不该出现定位按钮", () => {
    expect(extractToolResultNodeIds(undefined)).toEqual([]);
    expect(extractToolResultNodeIds(null)).toEqual([]);
    expect(extractToolResultNodeIds("plain text")).toEqual([]);
    expect(extractToolResultNodeIds({})).toEqual([]);
  });
});
