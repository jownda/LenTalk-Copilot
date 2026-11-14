import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 本地 CLI（即梦两条链路）的「提交前取消」接线测试。
 *
 * 这三处缺一处按钮就不会出现，光测纯函数护不住：
 *  1. `submitGenerateVideoJob` 的本地分支必须报 `cancelable: true`（否则节点立刻关窗）；
 *  2. `cancelGenerateVideoJob` 必须把取消转给后端的 `cancel_local_cli_video`；
 *  3. 后端在检查点抛「已取消生成」时，任务要记成 `canceled` 而不是 `failed`
 *     （画布轮询据此给中性提示，不弹红色错误框）。
 */

const generateJimengCliVideo = vi.fn(async () => "C:/out/jimeng.mp4");
const generateJimengCanvasVideo = vi.fn(async () => "C:/out/canvas.mp4");
const cancelLocalCliVideo = vi.fn(async (_clientJobId: string) => true);

vi.mock("@/commands/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/ai")>();
  return {
    ...actual,
    // 即梦 CLI：不真的起进程，直接给一个成品路径。
    generateJimengCliVideo: (...args: unknown[]) => generateJimengCliVideo(...(args as [])),
    cancelLocalCliVideo: (...args: unknown[]) => cancelLocalCliVideo(...(args as [string])),
  };
});

vi.mock("@/commands/jimengCanvasCli", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/jimengCanvasCli")>();
  return {
    ...actual,
    generateJimengCanvasVideo: (...args: unknown[]) => generateJimengCanvasVideo(...(args as [])),
  };
});

import { tauriAiGateway } from "./tauriAiGateway";
import type { GenerateVideoPayload } from "@/features/canvas/application/ports";

const basePayload = (model: string): GenerateVideoPayload =>
  ({
    clientJobId: "node-source-1",
    prompt: "雨夜站台，男人回头",
    model,
    duration: 5,
    aspectRatio: "9:16",
    videoResolution: "720p",
  }) as GenerateVideoPayload;

describe("本地 CLI 视频的提交前取消", () => {
  beforeEach(() => {
    generateJimengCliVideo.mockClear();
    generateJimengCanvasVideo.mockClear();
    cancelLocalCliVideo.mockClear();
    cancelLocalCliVideo.mockResolvedValue(true);
  });

  it("即梦 CLI 提交后仍报 cancelable: true，取消会转给后端", async () => {
    const submitted = await tauriAiGateway.submitGenerateVideoJob(basePayload("jimeng-cli/seedance2.0"));
    // 关键：为 false 的话节点会立刻把「取消生成」收掉，用户根本点不到。
    expect(submitted.cancelable).toBe(true);

    const outcome = await tauriAiGateway.cancelGenerateVideoJob(submitted.jobId);
    expect(outcome).toBe("canceled");
    // 后端取消表按 clientJobId 记账，必须原样透传节点的 clientJobId。
    expect(cancelLocalCliVideo).toHaveBeenCalledWith("node-source-1");
  });

  it("即梦画布 CLI 同样可取消", async () => {
    const submitted = await tauriAiGateway.submitGenerateVideoJob(basePayload("jimeng-canvas/seedance_2.5"));
    expect(submitted.cancelable).toBe(true);
    expect(await tauriAiGateway.cancelGenerateVideoJob(submitted.jobId)).toBe("canceled");
  });

  it("后端回 false(已经交到平台) 时如实报 too_late, 不能谎报取消成功", async () => {
    cancelLocalCliVideo.mockResolvedValueOnce(false);
    const submitted = await tauriAiGateway.submitGenerateVideoJob(basePayload("jimeng-cli/seedance2.0"));
    expect(await tauriAiGateway.cancelGenerateVideoJob(submitted.jobId)).toBe("too_late");
  });
});
