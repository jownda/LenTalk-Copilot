import { describe, expect, it } from "vitest";

import { clampScalar, scalarModifier, scrubScalar, snapScalar } from "./scalarMath";

describe("数值控件的小数处理", () => {
  it("按住 Shift 走大步、按住 Cmd/Ctrl 走小步", () => {
    expect(scalarModifier({ shiftKey: false, metaKey: false })).toBe(1);
    expect(scalarModifier({ shiftKey: true, metaKey: false })).toBe(10);
    expect(scalarModifier({ shiftKey: false, metaKey: true })).toBe(0.1);
    // 两个一起按互相抵消，仍然是 1 —— 没必要让组合键更"聪明"。
    expect(scalarModifier({ shiftKey: true, metaKey: true })).toBe(1);
  });

  it("clamp 两头都夹住", () => {
    expect(clampScalar(-5, 0, 10)).toBe(0);
    expect(clampScalar(15, 0, 10)).toBe(10);
    expect(clampScalar(5, 0, 10)).toBe(5);
  });

  it("按步长吸附且不留浮点尾巴", () => {
    // 0.30000000000000004 这种值直接写进输入框会让人以为控件坏了。
    expect(snapScalar(0.30000000000000004, 0, 1, 0.05)).toBe(0.3);
    expect(snapScalar(0.26, 0, 1, 0.05)).toBe(0.25);
    expect(snapScalar(0.28, 0, 1, 0.05)).toBe(0.3);
  });

  it("吸附后仍然夹在范围内", () => {
    expect(snapScalar(-1, 0, 10, 1)).toBe(0);
    expect(snapScalar(99, 0, 10, 1)).toBe(10);
  });

  it("从 min 起算步长（不是从 0）", () => {
    // 范围 12~160、步长 1 时，13 就该吸到 13 而不是 12。
    expect(snapScalar(13.4, 12, 160, 1)).toBe(13);
    expect(snapScalar(14.6, 12, 160, 1)).toBe(15);
  });

  it("横向拖动按 像素 × 步长 累积，并受修饰键影响", () => {
    const none = { shiftKey: false, metaKey: false };
    expect(scrubScalar(5, 10, 0.5, 0, 100, none)).toBe(10);
    expect(scrubScalar(5, 10, 0.5, 0, 100, { shiftKey: true, metaKey: false })).toBe(55);
    expect(scrubScalar(5, 10, 0.5, 0, 100, { shiftKey: false, metaKey: true })).toBe(5.5);
  });

  it("拖动不会越界，也不会带出浮点尾巴", () => {
    expect(scrubScalar(95, 100, 0.5, 0, 100, { shiftKey: false, metaKey: false })).toBe(100);
    expect(scrubScalar(0.1, 1, 0.1, 0, 1, { shiftKey: false, metaKey: false })).toBe(0.2);
  });
});
