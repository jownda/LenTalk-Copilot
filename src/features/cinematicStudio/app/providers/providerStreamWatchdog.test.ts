import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AI_STREAM_IDLE_TIMEOUT_MS,
  AI_STREAM_START_TIMEOUT_MS,
  createProviderStreamWatchdog,
} from "./providerStreamWatchdog";

describe("providerStreamWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("等响应头超过上限就回调，且只回调一次", () => {
    const onTimeout = vi.fn();
    const watchdog = createProviderStreamWatchdog({ onTimeout });
    watchdog.armStart();

    vi.advanceTimersByTime(AI_STREAM_START_TIMEOUT_MS - 1);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(String(onTimeout.mock.calls[0][0])).toContain("响应头");

    // 已经触发过，再往前推不应该重复回调（否则调用方会重复 reject/error）。
    vi.advanceTimersByTime(AI_STREAM_IDLE_TIMEOUT_MS * 2);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("响应头到达后切换成空闲计时，每收到一块数据就重置", () => {
    const onTimeout = vi.fn();
    const watchdog = createProviderStreamWatchdog({
      onTimeout,
      startTimeoutMs: 1_000,
      idleTimeoutMs: 5_000,
    });

    watchdog.armStart();
    vi.advanceTimersByTime(900);
    // 响应头到达：此刻起按空闲上限算，而不是继续用等响应头的 1 秒。
    watchdog.touch();

    vi.advanceTimersByTime(4_000);
    expect(onTimeout).not.toHaveBeenCalled();

    watchdog.touch();
    vi.advanceTimersByTime(4_000);
    expect(onTimeout).not.toHaveBeenCalled();

    // 连续 5 秒没有新字节：判渠道挂死。
    vi.advanceTimersByTime(1_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(String(onTimeout.mock.calls[0][0])).toContain("没有返回任何数据");
  });

  it("正常结束(stop)之后不再回调", () => {
    const onTimeout = vi.fn();
    const watchdog = createProviderStreamWatchdog({ onTimeout, startTimeoutMs: 1_000 });
    watchdog.armStart();
    vi.advanceTimersByTime(500);
    watchdog.stop();

    vi.advanceTimersByTime(10_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("默认上限覆盖「渠道静默」而非正常长生成（首字 2 分钟内、中途持续吐字节）", () => {
    // 健康渠道实测 TTFB 约 3 秒；这里锁住默认值，避免以后被顺手调成几十秒把长生成掐断。
    expect(AI_STREAM_START_TIMEOUT_MS).toBe(120_000);
    expect(AI_STREAM_IDLE_TIMEOUT_MS).toBe(120_000);
  });
});
