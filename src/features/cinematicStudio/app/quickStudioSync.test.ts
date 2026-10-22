import { describe, expect, it } from "vitest";
import { applyQuickStudioSync, mergeUpstreamText, quickSyncFromProject, stripUpstreamText } from "./quickStudioSync";

describe("compact studio ↔ advanced workbench sync", () => {
  it("keeps style, story, scene staging, candidates, and left-to-right order together", () => {
    const project: any = {
      styleBrief: "old style",
      scenes: [
        { id: "scene-a", logline: "old story", staging: {}, shots: [] },
        { id: "scene-b", logline: "keep this", staging: {}, shots: [] },
      ],
    };
    const sync = {
      sceneId: "scene-a",
      styleBrief: "胶片颗粒、冷暖对比",
      storySynopsis: "侦探穿过雨夜的站台。",
      staging: {
        locationAssetId: "platform",
        characterRoster: ["detective", "witness"],
        characterOrder: ["witness", "detective"],
      },
    };

    const next = applyQuickStudioSync(project, sync);

    expect(next.styleBrief).toBe(sync.styleBrief);
    expect(next.styleBriefZh).toBe(sync.styleBrief);
    expect(next.scenes[0].logline).toBe(sync.storySynopsis);
    expect(next.scenes[0].staging).toEqual(sync.staging);
    expect(next.scenes[1].logline).toBe("keep this");
    expect(quickSyncFromProject(next, "scene-a")).toEqual(sync);
  });

  it("keeps the advanced editor's staging when the node has none yet", () => {
    const project: any = {
      styleBrief: "old style",
      scenes: [{ id: "scene-a", logline: "old story", staging: { locationAssetId: "platform", characterRoster: ["detective"] }, shots: [] }],
    };

    // 极简节点还没点过场景站位：不带 staging，绝不能把高级编辑里已设好的站位清空。
    const next = applyQuickStudioSync(project, { sceneId: "scene-a", styleBrief: "新风格", storySynopsis: "新梗概" });

    expect(next.scenes[0].staging).toEqual({ locationAssetId: "platform", characterRoster: ["detective"] });
    expect(next.styleBrief).toBe("新风格");
  });

  it("mirrors the staging both ways: node → workbench → node stays identical", () => {
    const project: any = {
      styleBrief: "风格",
      scenes: [{ id: "scene-a", logline: "梗概", staging: { locationAssetId: "old" }, shots: [] }],
    };
    // 节点侧点选：地点 + 角色候选 + 左右排序
    const fromNode = {
      sceneId: "scene-a",
      styleBrief: "风格",
      storySynopsis: "梗概",
      staging: { locationAssetId: "platform", characterRoster: ["a", "b"], characterOrder: ["b", "a"] },
    };
    const inWorkbench = applyQuickStudioSync(project, fromNode);

    // 高级编辑里改：换地点、再加一个候选角色
    const edited: any = {
      ...inWorkbench,
      scenes: inWorkbench.scenes.map((scene: any) => scene.id === "scene-a"
        ? { ...scene, staging: { ...scene.staging, locationAssetId: "alley", characterRoster: ["a", "b", "c"] } }
        : scene),
    };

    // 写回节点后再推回来，不能丢字段、也不能把工程改回旧值。
    const backToNode = quickSyncFromProject(edited, "scene-a");
    expect(backToNode.staging).toEqual({ locationAssetId: "alley", characterRoster: ["a", "b", "c"], characterOrder: ["b", "a"] });
    expect(applyQuickStudioSync(edited, backToNode).scenes[0].staging).toEqual(backToNode.staging);
  });

  it("treats an explicit empty staging from the node as a real change", () => {
    const project: any = {
      styleBrief: "风格",
      scenes: [{ id: "scene-a", logline: "梗概", staging: { locationAssetId: "platform" }, shots: [] }],
    };

    // 用户在节点里移除了地点：这是明确的清空，应当覆盖高级编辑。
    const next = applyQuickStudioSync(project, {
      sceneId: "scene-a",
      styleBrief: "风格",
      storySynopsis: "梗概",
      staging: { locationAssetId: undefined },
    });

    expect(next.scenes[0].staging).toEqual({ locationAssetId: undefined });
  });

  it("carries the scene prop roster through the node ↔ workbench round trip", () => {
    const project: any = {
      styleBrief: "风格",
      scenes: [{ id: "scene-a", logline: "梗概", staging: {}, shots: [] }],
    };
    // 节点侧在「道具」候选框里选了道具
    const fromNode = {
      sceneId: "scene-a",
      styleBrief: "风格",
      storySynopsis: "梗概",
      staging: { locationAssetId: "platform", propRoster: ["knife", "lighter"] },
    };
    const inWorkbench = applyQuickStudioSync(project, fromNode);
    expect(inWorkbench.scenes[0].staging).toEqual(fromNode.staging);

    // 写回节点时 propRoster 必须原样带回，否则节点上的道具选中态会凭空消失。
    expect(quickSyncFromProject(inWorkbench, "scene-a")).toEqual(fromNode);
  });
});

describe("upstream text pass-through", () => {
  it("prepends the upstream block, de-duplicates it, and keeps the local text last", () => {
    expect(mergeUpstreamText(["上游风格", " 上游风格 "], "")).toBe("上游风格");
    expect(mergeUpstreamText(["上游风格"], "本地风格")).toBe("上游风格\n\n本地风格");
    expect(mergeUpstreamText([], "本地风格")).toBe("本地风格");
    // 上游文本空白时不应产生多余空行
    expect(mergeUpstreamText(["", "   "], "本地风格")).toBe("本地风格");
  });

  it("is idempotent so a workbench write-back is not merged again", () => {
    const upstream = ["上游风格"];
    const merged = "上游风格\n\n本地风格";
    expect(mergeUpstreamText(upstream, merged)).toBe(merged);
  });

  it("strips the upstream block from the workbench write-back", () => {
    expect(stripUpstreamText("上游风格\n\n本地风格", ["上游风格"])).toBe("本地风格");
    // 只剩上游文本时，本地字段应当清空
    expect(stripUpstreamText("上游风格", ["上游风格"])).toBe("");
    // 高级编辑里改成了别的文本：整段都算本地内容
    expect(stripUpstreamText("只有本地风格", ["上游风格"])).toBe("只有本地风格");
    expect(stripUpstreamText("本地风格", [])).toBe("本地风格");
  });

  it("survives repeated node → workbench → node round trips without stacking", () => {
    const upstream = ["侦探穿过雨夜的站台。"];
    let local = "胶片颗粒、冷暖对比";
    for (let round = 0; round < 3; round += 1) {
      const merged = mergeUpstreamText(upstream, local); // 节点 → 高级编辑
      local = stripUpstreamText(merged, upstream); // 高级编辑 → 节点
    }
    expect(local).toBe("胶片颗粒、冷暖对比");
    expect(mergeUpstreamText(upstream, local)).toBe("侦探穿过雨夜的站台。\n\n胶片颗粒、冷暖对比");
  });
});
