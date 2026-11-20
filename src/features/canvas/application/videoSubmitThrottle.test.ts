import { afterEach, describe, expect, it } from "vitest";

import {
  isVideoSubmitThrottled,
  markVideoSubmit,
  remainingVideoSubmitCooldown,
  resetVideoSubmitThrottle,
  VIDEO_SUBMIT_COOLDOWN_MS,
} from "./videoSubmitThrottle";

/**
 * 视频提交防误点：只挡「刚刚那一下」，不挡「过几秒再点一次生成新的」。
 *
 * 这个模块是模块级 Map 而不是组件内 state —— 节点滚出视口会卸载重挂载，
 * 组件内状态会清零，那正是「只点一次却生成两个视频」的来源之一。
 */
describe("videoSubmitThrottle", () => {
  afterEach(resetVideoSubmitThrottle);

  it("第一次提交不被挡", () => {
    expect(isVideoSubmitThrottled("node-a")).toBe(false);
  });

  it("刚提交完的 2 秒内再点会被挡（双击 / 手滑）", () => {
    const now = 1_000_000;
    markVideoSubmit("node-a", now);

    expect(isVideoSubmitThrottled("node-a", now + 0)).toBe(true);
    expect(isVideoSubmitThrottled("node-a", now + 300)).toBe(true);
    expect(isVideoSubmitThrottled("node-a", now + 1_500)).toBe(true);
  });

  it("超过窗口就能再点一次（连续生成新的视频）", () => {
    const now = 1_000_000;
    markVideoSubmit("node-a", now);

    expect(isVideoSubmitThrottled("node-a", now + VIDEO_SUBMIT_COOLDOWN_MS)).toBe(false);
    expect(isVideoSubmitThrottled("node-a", now + 10_000)).toBe(false);
  });

  it("按节点独立计时：一个节点提交不影响另一个", () => {
    const now = 1_000_000;
    markVideoSubmit("node-a", now);

    expect(isVideoSubmitThrottled("node-a", now + 100)).toBe(true);
    expect(isVideoSubmitThrottled("node-b", now + 100)).toBe(false);
  });

  it("剩余冷却时间不会变成负数", () => {
    const now = 1_000_000;
    markVideoSubmit("node-a", now);

    expect(remainingVideoSubmitCooldown("node-a", now + 500)).toBe(VIDEO_SUBMIT_COOLDOWN_MS - 500);
    expect(remainingVideoSubmitCooldown("node-a", now + 60_000)).toBe(0);
    expect(remainingVideoSubmitCooldown("unknown-node", now)).toBe(0);
  });
});
