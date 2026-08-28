import { describe, expect, it } from "vitest";

import type { Asset, ProjectV2, SceneV2 } from "../../shared-types";
import { buildFinalGenerationSource, buildFinalPromptRequest, classifyError, collectSceneAssetIds, normalizeSceneDraft, sanitizeFinalPromptResponse, SCENE_DRAFT_JSON_SCHEMA } from "./ai";

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
  it("清理最终提示词开头的隐藏推理标签，保留中文首个类别标题", () => {
    const response = "<think>**Ensuring precise Chinese heading order**</think>\n\n场景上下文：\n阿俊站在车厢内。\n\n活动引用：\n@char_demo_hero_base_v1 [image1]：阿俊。";
    expect(sanitizeFinalPromptResponse(response)).toBe("场景上下文：\n阿俊站在车厢内。\n\n活动引用：\n@char_demo_hero_base_v1 [image1]：阿俊。");
  });

  it("最终生成只交给 AI 已审核的 canonical source，不让它重新规划场景", () => {
    const request = buildFinalPromptRequest("场景上下文：\n阿俊在车厢内。", "zh");
    expect(request.user).toContain("CANONICAL AUDITED SOURCE:");
    expect(request.user).toContain("阿俊在车厢内");
    expect(request.user).toContain("Do not invent, remove, reinterpret, or contradict any fact");
    expect(request.user).toContain("Do not add prior context, story summaries, user notes");
    expect(request.user).toContain("清晰、电影级的中文");
    expect(request.system).toContain("clear, cinematic-grade Chinese");
    expect(request.user).toContain("场景上下文、活动引用、场景地图");
    expect(request.user).toContain("动作节奏");
    expect(request.user).toContain("Every @asset_tag, [imageN], and @audioN token");
  });

  it("最终生成源按 CINEDANCE 类别顺序合并导演文档与镜头执行", () => {
    const sceneWithDocument: SceneV2 = {
      ...scene,
      directorLayers: {
        sceneContext: "已编辑的场景上下文。",
        optics: "已编辑的光学。",
        lighting: "已编辑的光线。",
      },
    };
    const source = buildFinalGenerationSource({ ...project, styleId: "wong-kar-wai" }, sceneWithDocument);

    expect(source).toContain("SCENE CONTEXT:\n已编辑的场景上下文。");
    expect(source).toContain("ACTION TIMING:\n");
    expect(source).toContain("Performance tone");
    expect(source.indexOf("SCENE CONTEXT:")).toBeLessThan(source.indexOf("ACTIVE REFERENCES:"));
    expect(source.indexOf("CAMERA:")).toBeLessThan(source.indexOf("ACTION TIMING:"));
    expect(source.indexOf("ACTION TIMING:")).toBeLessThan(source.indexOf("PHYSICS:"));
    expect(source).toContain("STYLE:\n");
    expect(source.indexOf("LIGHTING:")).toBeLessThan(source.indexOf("STYLE:"));
    expect(source.indexOf("STYLE:")).toBeLessThan(source.indexOf("POSITIVE CONSTRAINTS:"));
    expect(source).not.toContain("SHOT EXECUTION:");
  });

  it("最终生成从镜头结构重建角色、道具和声音的活动引用", () => {
    const taggedAssets: Asset[] = [
      { ...assets[0], referenceTag: "loc_demo_carriage_base_v1", referencePaths: ["location-image"] },
      {
        ...assets[1], referenceTag: "char_demo_hero_base_v1", referencePaths: ["hero-image"], voiceClip: "hero-voice",
        attachedPropIds: ["bag"],
        actingProfile: { masterProfileZh: "肩膀始终绷紧，先屏住呼吸再看向对手。", voicePromptZh: "低沉、短句、尾音收紧。" },
      },
      { ...assets[2], referenceTag: "char_demo_support_base_v1", referencePaths: ["support-image"] },
      { id: "bag", kind: "prop", name: "红色托特包", referenceTag: "prop_demo_bag_base_v1", description: "red tote bag", descriptionZh: "红色托特包", referencePaths: ["bag-image"], lockLevel: "none", tags: [], propHolderCharacterId: "hero", propPositionZh: "双腿上" },
      assets.find((asset) => asset.id === "prop")!,
      assets.find((asset) => asset.id === "unused-character")!,
    ];
    const multiShotScene: SceneV2 = {
      ...scene,
      shootingMode: "multi-shot",
      directorLayers: { activeReferences: "过期的活动引用，必须忽略。" },
      shots: [
        { ...scene.shots[0], participants: [{ characterId: "hero", role: "primary" }], beats: [] },
        { ...scene.shots[0], id: "shot-2", label: "镜头 2", participants: [{ characterId: "support", role: "primary" }], beats: [] },
      ],
    };
    const source = buildFinalGenerationSource({ ...project, assets: taggedAssets }, multiShotScene);

    expect(source).toContain("@loc_demo_carriage_base_v1 [image1]: 车厢 — carriage");
    expect(source).toContain("@char_demo_hero_base_v1 [image2]: 林警官 — hero");
    expect(source).toContain("Acting template: 肩膀始终绷紧，先屏住呼吸再看向对手。");
    expect(source).toContain("Voice lock: 低沉、短句、尾音收紧。");
    expect(source).toContain("Voice reference: @audio1");
    expect(source).toContain("@prop_demo_bag_base_v1 [image3]: 红色托特包 — red tote bag");
    expect(source).toContain("@char_demo_support_base_v1 [image4]: 阿俊 — support");
    expect(source).not.toContain("过期的活动引用");
    expect(source).not.toContain("未出场角色");
    // The prop declaration names its holder with the same @ handle, as required
    // by Seedance. The character's image, appearance, profile, and voice data
    // are still declared only once on the character line.
    expect((source.match(/@char_demo_hero_base_v1/g) ?? [])).toHaveLength(2);
    expect((source.match(/@prop_demo_bag_base_v1/g) ?? [])).toHaveLength(1);
  });

  it.each([504, 524])("将 HTTP %i 识别为上游网关超时，而不是普通网络错误", (status) => {
    const result = classifyError(new Error(`HTTP ${status}：gateway timeout`));
    expect(result.kind).toBe("gateway-timeout");
    expect(result.message).toContain(String(status));
  });

  it("只返回地点、站位角色、镜头参与者和动作引用的资产", () => {
    expect(collectSceneAssetIds(project, scene)).toEqual(["location", "hero", "prop", "support"]);
    expect(collectSceneAssetIds(project, scene)).not.toContain("unused-character");
    expect(collectSceneAssetIds(project, scene)).not.toContain("unused-prop");
  });

  it("去重并忽略不存在的站位 id", () => {
    const nextScene = { ...scene, staging: { ...scene.staging, characterOrder: ["hero", "missing", "hero"] } };
    expect(collectSceneAssetIds(project, nextScene)).toEqual(["location", "hero", "prop"]);
  });

  it("丢弃不合格的 AI 导演层后，仍用结构化分镜填充导演文档", () => {
    const invalidScene = { ...scene, shootingMode: "multi-shot" as const };
    const result = normalizeSceneDraft(project, invalidScene, {
      directorLayers: {
        sceneContext: "未出场角色躲在车厢尽头。",
      },
      shots: [],
    }, "秒");

    expect(result.directorLayers?.sceneContext).not.toContain("未出场角色");
    expect(result.directorLayers?.locationMap).toContain("车厢");
    expect(result.scene.directorLayers).toEqual(result.directorLayers);
    expect(result.directorLayerIssues?.map((issue) => issue.code)).toContain("DIRECTOR.UNREFERENCED_ASSET");
  });

  it("没有 error 时保留 AI directorLayers", () => {
    const layers = {
      sceneContext: "SCENE CONTEXT:\nA quiet carriage.",
      formatMode: "FORMAT MODE:\nSINGLE CONTINUOUS TAKE.",
    };
    const result = normalizeSceneDraft(project, scene, { directorLayers: layers, shots: [] }, "秒");
    expect(result.directorLayers).toMatchObject(layers);
    expect(result.directorLayers?.locationMap).toContain("车厢");
    expect(result.scene.directorLayers).toEqual(result.directorLayers);
    expect(result.directorLayerIssues).toBeUndefined();
  });

  it("解析 AI 生成的场景上下文并写回 scene", () => {
    const result = normalizeSceneDraft(project, scene, {
      sceneContext: "阿俊擦开车窗雾气，看向窗外无尽的黑暗。",
      shots: [],
    }, "秒");

    expect(result.scene.sceneContext).toBe("阿俊擦开车窗雾气，看向窗外无尽的黑暗。");
  });

  it("保留用户已填写的场景上下文，AI 未返回时不覆盖为空", () => {
    const sceneWithContext = { ...scene, sceneContext: "林sir坐在车厢中央，等待列车到站。" };
    const result = normalizeSceneDraft(project, sceneWithContext, { shots: [] }, "秒");
    expect(result.scene.sceneContext).toBe("林sir坐在车厢中央，等待列车到站。");
  });

  it("忽略 AI 返回的 audioPlan，避免覆盖用户填写的音频计划", () => {
    const result = normalizeSceneDraft(project, scene, {
      audioPlan: { diegeticMusic: ["AI 自拟音乐"], sfx: ["AI 自拟音效"], score: "original-score", subtitles: true },
      shots: [],
    }, "秒");
    expect(result).not.toHaveProperty("audioPlan");
    expect(result.scene).not.toHaveProperty("audioPlan");
  });

  it("长镜头 AI 规划只写回一个连续镜头，忽略额外覆盖镜头", () => {
    const longTake = { ...scene, shootingMode: "long-take" as const, duration: "8秒" };
    const result = normalizeSceneDraft(project, longTake, {
      shots: [
        { label: "镜头 1", time: { startSeconds: 0, endSeconds: 5 }, action: "角色停住观察", acting: "克制", movement: "Static", direction: "left-to-right" },
        { label: "镜头 2", time: { startSeconds: 5, endSeconds: 8 }, action: "角色继续前进", acting: "克制", movement: "Tracking", direction: "left-to-right" },
      ],
    }, "秒");

    expect(result.scene.shots).toHaveLength(1);
    expect(result.scene.shots[0].time).toEqual({ startSeconds: 0, endSeconds: 5 });
  });

  it("AI 分镜 schema 不再要求 AI 返回音频计划、旧 mm 焦段或道具状态链", () => {
    expect(SCENE_DRAFT_JSON_SCHEMA).not.toContain('"audioPlan"');
    expect(SCENE_DRAFT_JSON_SCHEMA).toContain('"directorLayers"');
    expect(SCENE_DRAFT_JSON_SCHEMA).not.toContain('"actionTiming"');
    expect(SCENE_DRAFT_JSON_SCHEMA).not.toContain('"lens": string');
    expect(SCENE_DRAFT_JSON_SCHEMA).not.toContain('"stateBefore"');
    expect(SCENE_DRAFT_JSON_SCHEMA).not.toContain('"stateAfter"');
    expect(SCENE_DRAFT_JSON_SCHEMA).not.toContain('"propStatesAtStart"');
    expect(SCENE_DRAFT_JSON_SCHEMA).not.toContain('"propStatesAtEnd"');
    expect(SCENE_DRAFT_JSON_SCHEMA).toContain('"fieldOfViewDegrees": number');
    expect(SCENE_DRAFT_JSON_SCHEMA).toContain('"sceneContext": string');
  });
});
