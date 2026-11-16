import { beforeEach, describe, expect, it, vi } from "vitest";

const addNode = vi.fn(() => "script-node-1");
const addEdge = vi.fn();
const updateNodeData = vi.fn();
const findNodePosition = vi.fn(() => ({ x: 0, y: 0 }));

vi.mock("@/stores/canvasStore", () => ({
  useCanvasStore: {
    getState: () => ({ addNode, addEdge, updateNodeData, findNodePosition }),
  },
}));

const readPajubenScript = vi.fn(async () => "# 第1集\n\n△【00:01】中景｜推门\n\n角色表\n张三");

vi.mock("@/commands/pajuben", () => ({
  readPajubenScript: (...args: unknown[]) => readPajubenScript(...(args as [])),
  onPajubenLog: vi.fn(),
  onPajubenProgress: vi.fn(),
  onPajubenFinish: vi.fn(),
}));

vi.mock("@/i18n", () => ({
  default: { t: (key: string, fallback?: string) => fallback ?? key },
}));

import {
  finishRun,
  hasPajubenScript,
  isQuickRunActive,
  pajubenScriptEpisodeOf,
  usePajubenQuickRuns,
} from "./pajubenQuickRuns";

describe("hasPajubenScript / pajubenScriptEpisodeOf", () => {
  it("没有标记过就是没扒过", () => {
    expect(hasPajubenScript({})).toBe(false);
    expect(hasPajubenScript(null)).toBe(false);
    expect(hasPajubenScript(undefined)).toBe(false);
    expect(pajubenScriptEpisodeOf({})).toBeNull();
  });

  it("有合法时间戳才算扒过, 脏值一律当没扒过", () => {
    expect(hasPajubenScript({ pajubenExtractedAt: 1_763_000_000_000 })).toBe(true);
    expect(hasPajubenScript({ pajubenExtractedAt: 0 })).toBe(false);
    expect(hasPajubenScript({ pajubenExtractedAt: "1763000000000" })).toBe(false);
    expect(hasPajubenScript({ pajubenExtractedAt: Number.NaN })).toBe(false);
  });

  it("集号只认正整数", () => {
    expect(pajubenScriptEpisodeOf({ pajubenScriptEpisode: 3 })).toBe(3);
    expect(pajubenScriptEpisodeOf({ pajubenScriptEpisode: 0 })).toBeNull();
    expect(pajubenScriptEpisodeOf({ pajubenScriptEpisode: -2 })).toBeNull();
    expect(pajubenScriptEpisodeOf({ pajubenScriptEpisode: "3" })).toBeNull();
  });
});

describe("isQuickRunActive", () => {
  const run = (status: string) => ({ status }) as never;

  it("准备与运行中都算活跃, 完成和失败不算", () => {
    expect(isQuickRunActive(run("preparing"))).toBe(true);
    expect(isQuickRunActive(run("running"))).toBe(true);
    expect(isQuickRunActive(run("succeeded"))).toBe(false);
    expect(isQuickRunActive(run("failed"))).toBe(false);
    expect(isQuickRunActive(undefined)).toBe(false);
  });
});

describe("finishRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePajubenQuickRuns.setState({ runs: {} });
  });

  it("成功后把「已扒过」写回视频节点, 供按钮切成「重新生成」", async () => {
    usePajubenQuickRuns.getState().start({
      nodeId: "video-1",
      videoPath: "D:/剧集/第07集.mp4",
      episode: 7,
      statusText: "准备中…",
    });

    await finishRun("video-1", true, "");

    expect(addNode).toHaveBeenCalledTimes(1);
    expect(addEdge).toHaveBeenCalledWith("video-1", "script-node-1");
    // 关键：没有这个标记, 工具栏永远显示「扒视频」, 再点还是走缓存命中那条路。
    expect(updateNodeData).toHaveBeenCalledWith("video-1", {
      pajubenExtractedAt: expect.any(Number),
      pajubenScriptEpisode: 7,
    });
    expect(usePajubenQuickRuns.getState().runs["video-1"].status).toBe("succeeded");
  });

  it("失败只记原因, 不落节点也不写「已扒过」", async () => {
    usePajubenQuickRuns.getState().start({
      nodeId: "video-2",
      videoPath: "D:/剧集/第08集.mp4",
      episode: 8,
      statusText: "准备中…",
    });

    await finishRun("video-2", false, "网络中断");

    expect(addNode).not.toHaveBeenCalled();
    expect(updateNodeData).not.toHaveBeenCalled();
    const stored = usePajubenQuickRuns.getState().runs["video-2"];
    expect(stored.status).toBe("failed");
    expect(stored.notice).toBe("网络中断");
  });
});
