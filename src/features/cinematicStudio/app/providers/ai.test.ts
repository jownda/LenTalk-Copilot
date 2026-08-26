import { describe, expect, it } from "vitest";

import type { Asset, ProjectV2, SceneV2 } from "../../shared-types";
import { collectSceneAssetIds, normalizeSceneDraft } from "./ai";

const assets: Asset[] = [
  { id: "location", kind: "location", name: "车厢", description: "carriage", referencePaths: [], lockLevel: "none", tags: [] },
  { id: "hero", kind: "character", name: "林警官", description: "hero", referencePaths: [], lockLevel: "strict", tags: [] },
  { id: "support", kind: "character", name: "阿俊", description: "support", referencePaths: [], lockLevel: "soft", tags: [] },
  { id: "prop", kind: "prop", name: "香烟", description: "cigarette", referencePaths: [], lockLevel: "none", tags: [] },
  { id: "unused-character", kind: "character", name: "未出场角色", description: "unused", referencePaths: [], lockLevel: "none", tags: [] },
  { id: "unused-prop", kind: "prop", name: "未使用道具", description: "unused", referencePaths: [], lockLevel: "none", tags: [] },
];

const scene: SceneV2 = {
  id: "scene-1", name: "测试场景", logline: "", location: "", time: "", weather: "", duration: "5秒",
  palette: "", lighting: "", environmentLock: true,
  staging: { locationAssetId: "location", characterOrder: ["hero", "support"] },
  shots: [{
    id: "shot-1", label: "镜头 1", duration: "5秒", framing: "中景", lens: "35mm",
    movement: "Static", action: "等待", acting: "克制", direction: "left-to-right",
    participants: [{ characterId: "hero", role: "primary" }],
    beats: [{ id: "beat-1", order: 1, verb: "拿起", actorId: "hero", targetPropId: "prop" }],
  }],
};

const project: ProjectV2 = {
  id: "project-1", title: "测试", description: "", preset: "custom", scenes: [scene], characters: [], assets,
};

describe("collectSceneAssetIds", () => {
  it("只返回地点、站位角色、镜头参与者和动作引用的资产", () => {
    expect(collectSceneAssetIds(project, scene)).toEqual(["location", "hero", "prop", "support"]);
    expect(collectSceneAssetIds(project, scene)).not.toContain("unused-character");
    expect(collectSceneAssetIds(project, scene)).not.toContain("unused-prop");
  });

  it("去重并忽略不存在的站位 id", () => {
    const nextScene = { ...scene, staging: { ...scene.staging, characterOrder: ["hero", "missing", "hero"] } };
    expect(collectSceneAssetIds(project, nextScene)).toEqual(["location", "hero", "prop"]);
  });

  it("写回前丢弃 error 级 directorLayers，并返回质量问题供面板使用", () => {
    const invalidScene = { ...scene, shootingMode: "multi-shot" as const };
    const result = normalizeSceneDraft(project, invalidScene, {
      directorLayers: {
        formatMode: "FORMAT MODE:\nCONTROLLED MULTI-SHOT SEQUENCE.",
        actionTiming: "ACTION TIMING:\n0:00-0:05: continuous timeline without shot blocks.",
      },
      shots: [],
    }, "秒");

    expect(result.scene.directorLayers).toBeUndefined();
    expect(result.directorLayers).toBeUndefined();
    expect(result.directorLayerIssues?.map((issue) => issue.code)).toContain("DIRECTOR.MULTI_SHOT_TIMELINE");
  });

  it("没有 error 时保留 AI directorLayers", () => {
    const layers = {
      sceneContext: "SCENE CONTEXT:\nA quiet carriage.",
      formatMode: "FORMAT MODE:\nSINGLE CONTINUOUS TAKE.",
    };
    const result = normalizeSceneDraft(project, scene, { directorLayers: layers, shots: [] }, "秒");
    expect(result.directorLayers).toEqual(layers);
    expect(result.scene.directorLayers).toEqual(layers);
    expect(result.directorLayerIssues).toBeUndefined();
  });
});
