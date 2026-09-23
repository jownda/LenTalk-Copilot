import { describe, expect, it } from "vitest";

import { isQuickGenerationRunActive, QUICK_GENERATION_STALE_MS } from "./quickGenerationRunState";

/**
 * 这些用例锁的是用户实际报过的那条症状:
 * 「点击生成并创建视频 → 按钮显示生成中 → 把节点移出画布再移回来, 按钮立刻变回『生成并创建视频』,
 *  但下游节点还没生成」。根因是节点被卸载后局部 state 丢失, 判定必须能从落库字段重算。
 */
describe("isQuickGenerationRunActive", () => {
  const SESSION = "runtime-1758600000000-abc12345";
  const NOW = 1_758_600_600_000;

  it("本次会话 + 未超窗: 恢复「生成中…」", () => {
    expect(isQuickGenerationRunActive(NOW - 30_000, SESSION, NOW, SESSION)).toBe(true);
  });

  it("会话 id 不匹配(上一次运行留下的标记): 视为已结束, 不锁按钮", () => {
    expect(isQuickGenerationRunActive(NOW - 30_000, "runtime-1-other", NOW, SESSION)).toBe(false);
  });

  it("超过恢复窗口: 视为残留标记, 不锁按钮", () => {
    expect(
      isQuickGenerationRunActive(NOW - QUICK_GENERATION_STALE_MS - 1, SESSION, NOW, SESSION),
    ).toBe(false);
  });

  it("恰好落在窗口边界上仍算进行中", () => {
    expect(
      isQuickGenerationRunActive(NOW - QUICK_GENERATION_STALE_MS + 1, SESSION, NOW, SESSION),
    ).toBe(true);
  });

  it("标记被清空后(null / undefined / 0 / 空串)一律为闲置", () => {
    for (const startedAt of [null, undefined, 0, -1, "1758600000000", Number.NaN]) {
      expect(isQuickGenerationRunActive(startedAt, SESSION, NOW, SESSION)).toBe(false);
    }
    for (const sessionId of [null, undefined, "", 42]) {
      expect(isQuickGenerationRunActive(NOW - 1_000, sessionId, NOW, SESSION)).toBe(false);
    }
  });

  it("超窗判定与传入的 now 一致(便于测试注入时钟)", () => {
    const startedAt = NOW - 60_000;
    expect(isQuickGenerationRunActive(startedAt, SESSION, startedAt + 10, SESSION)).toBe(true);
    expect(
      isQuickGenerationRunActive(startedAt, SESSION, startedAt + QUICK_GENERATION_STALE_MS + 1, SESSION),
    ).toBe(false);
  });
});
