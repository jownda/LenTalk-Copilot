import { describe, expect, it } from "vitest";

import { summarizeNodePrices, type NodePriceEstimate } from "./agentNodePrice";

const known = (label: string): NodePriceEstimate => ({ label, known: true });
const unknown = (): NodePriceEstimate => ({ label: "未知", known: false });

/**
 * 报价只解决一个问题：**点「确认执行」之前，用户要知道大概花多少**。
 * 所以这里守的重点不是「算得准」，而是「不知道就别说不知道以外的数」——
 * 把未知当成 0 会给出偏低报价，比不报价更危险。
 */
describe("summarizeNodePrices", () => {
  it("同币种求和", () => {
    expect(summarizeNodePrices([known("¥0.06"), known("¥0.06"), known("¥0.04")])).toBe(
      "合计 ¥0.16，共 3 个",
    );
  });

  it("有未知项时单独计数，且明确写出来", () => {
    const text = summarizeNodePrices([known("¥0.06"), known("¥0.06"), unknown(), unknown()]);
    expect(text).toContain("合计 ¥0.12");
    expect(text).toContain("共 4 个");
    expect(text).toContain("另有 2 个无法估价");
  });

  it("全部未知时不下结论", () => {
    expect(summarizeNodePrices([unknown(), unknown()])).toBe("2 个节点，价格未知");
  });

  it("币种不同时不硬算合计", () => {
    expect(summarizeNodePrices([known("¥0.06"), known("$0.01")])).toContain("币种不一致");
  });

  it("带单位后缀的标签只取前导货币符号，不把单位算进去", () => {
    // 「元/条」不能进符号位，否则会拼出 `¥元/条1` 这种畸形文案
    expect(summarizeNodePrices([known("¥0.5元/条"), known("¥0.5元/条")])).toBe(
      "合计 ¥1，共 2 个",
    );
  });

  it("只有一个可估价时仍然给合计，并把未知项说清楚", () => {
    expect(summarizeNodePrices([known("¥0.06"), unknown()])).toBe(
      "合计 ¥0.06，共 2 个（另有 1 个无法估价）",
    );
  });

  it("空输入不产出任何文案（避免卡片上出现一句空话）", () => {
    expect(summarizeNodePrices([])).toBe("");
  });
});
