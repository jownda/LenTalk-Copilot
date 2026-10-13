import { afterEach, describe, expect, it, vi } from "vitest";

import {
  VideoGenerationCanceledError,
  closeVideoCancellationWindow,
  isVideoCancellationRequested,
  isVideoCancellationWindowOpen,
  isVideoGenerationCanceledError,
  openVideoCancellationWindow,
  requestVideoCancellation,
  subscribeVideoCancellation,
  throwIfVideoSubmissionCanceled,
} from "./videoGenerationCancel";

const NODE = "node-output";

afterEach(() => {
  // 模块级 Map 是跨用例共享的, 每个用例自己收尾, 避免相互串味。
  closeVideoCancellationWindow(NODE);
  closeVideoCancellationWindow(`${NODE}-b`);
});

describe("videoGenerationCancel", () => {
  it("窗口未打开时既不可取消, 也不抛哨兵", () => {
    expect(isVideoCancellationWindowOpen(NODE)).toBe(false);
    expect(requestVideoCancellation(NODE)).toBe(false);
    expect(() => throwIfVideoSubmissionCanceled(NODE)).not.toThrow();
  });

  it("打开后可取消; 关闭后取消请求被拒绝", () => {
    openVideoCancellationWindow(NODE);
    expect(isVideoCancellationWindowOpen(NODE)).toBe(true);
    expect(requestVideoCancellation(NODE)).toBe(true);
    expect(isVideoCancellationRequested(NODE)).toBe(true);

    closeVideoCancellationWindow(NODE);
    expect(isVideoCancellationWindowOpen(NODE)).toBe(false);
    // 平台已受理后再点取消必须返回 false —— 调用方不能假装取消成功。
    expect(requestVideoCancellation(NODE)).toBe(false);
  });

  it("重复点击取消不会重复生效", () => {
    openVideoCancellationWindow(NODE);
    expect(requestVideoCancellation(NODE)).toBe(true);
    expect(requestVideoCancellation(NODE)).toBe(false);
  });

  it("检查点在窗口内抛哨兵, 关闭后放行", () => {
    openVideoCancellationWindow(NODE);
    requestVideoCancellation(NODE);
    expect(() => throwIfVideoSubmissionCanceled(NODE)).toThrow(VideoGenerationCanceledError);

    closeVideoCancellationWindow(NODE);
    expect(() => throwIfVideoSubmissionCanceled(NODE)).not.toThrow();
  });

  it("空 nodeId 是 no-op(非画布节点发起的提交)", () => {
    expect(() => throwIfVideoSubmissionCanceled(undefined)).not.toThrow();
    expect(() => throwIfVideoSubmissionCanceled(null)).not.toThrow();
    expect(() => throwIfVideoSubmissionCanceled("")).not.toThrow();
  });

  it("哨兵错误可被类型判定识别, 普通错误不会误判", () => {
    expect(isVideoGenerationCanceledError(new VideoGenerationCanceledError())).toBe(true);
    expect(isVideoGenerationCanceledError(new Error("已取消生成"))).toBe(false);
  });

  it("订阅者在开窗/取消/关窗时被通知, 退订后不再收到", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeVideoCancellation(listener);

    openVideoCancellationWindow(NODE);
    expect(listener).toHaveBeenCalledTimes(1);

    requestVideoCancellation(NODE);
    expect(listener).toHaveBeenCalledTimes(2);

    closeVideoCancellationWindow(NODE);
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    openVideoCancellationWindow(NODE);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("两个节点的窗口互不影响", () => {
    openVideoCancellationWindow(NODE);
    openVideoCancellationWindow(`${NODE}-b`);
    requestVideoCancellation(NODE);

    expect(isVideoCancellationRequested(NODE)).toBe(true);
    expect(isVideoCancellationRequested(`${NODE}-b`)).toBe(false);
  });

  it("关窗幂等, 不会误伤已关闭的窗口", () => {
    closeVideoCancellationWindow(NODE);
    openVideoCancellationWindow(NODE);
    closeVideoCancellationWindow(NODE);
    closeVideoCancellationWindow(NODE);
    expect(isVideoCancellationWindowOpen(NODE)).toBe(false);
  });
});
