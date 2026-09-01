import { describe, expect, it } from "vitest";

import type { Asset, ProjectV2, SceneV2 } from "../../shared-types";
import { AI_RESPONSE_TIMEOUT_MS, buildFinalGenerationSource, buildFinalPromptRequest, ChatCompletionInterruptedError, classifyError, collectSceneAssetIds, normalizeContinuityRepairPatch, normalizeSceneDraft, readChatCompletionText, sanitizeFinalPromptResponse, SCENE_DRAFT_JSON_SCHEMA } from "./ai";
import { LocalSuggestionProvider } from "../../engine/ai/assistant";

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
  it("只解析修复补丁白名单字段，不接受任意项目重写字段", () => {
    const patch = normalizeContinuityRepairPatch({
      patch: {
        shotUpdates: [{ shotId: "shot-1", participantUpdates: [{ characterId: "hero", position: "画面左侧", unknown: "drop" }], unknownField: true }],
        project: { scenes: [] },
      },
    });
    expect(patch).toEqual({ shotUpdates: [{ shotId: "shot-1", participantUpdates: [{ characterId: "hero", position: "画面左侧" }] }] });
  });

  it("本地修复建议为连续性问题返回受限补丁，而不是只返回说明文字", async () => {
    const provider = new LocalSuggestionProvider();
    const fix = await provider.repairContinuity({
      project,
      scene,
      issue: { code: "SCENE.ENVIRONMENT_UNLOCKED", severity: "warning", label: "Environment lock", detail: "lock" },
    });
    expect(fix.patch).toEqual({ sceneUpdates: { environmentLock: true } });
  });

  it("保留较长生成等待窗口，并兼容流式与普通 Chat Completions 响应", async () => {
    expect(AI_RESPONSE_TIMEOUT_MS).toBe(15 * 60 * 1000);

    const streamed = new Response([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "场景上下文：" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "车厢内。" } }] })}`,
      "data: [DONE]",
      "",
    ].join("\n"), { headers: { "Content-Type": "text/event-stream" } });
    expect(await readChatCompletionText(streamed)).toBe("场景上下文：车厢内。");

    const legacyTextStream = new Response([
      `data: ${JSON.stringify({ choices: [{ text: "兼容的流式文本" }] })}`,
      "data: [DONE]",
      "",
    ].join("\n"),
      { headers: { "Content-Type": "text/event-stream" } },
    );
    await expect(readChatCompletionText(legacyTextStream)).resolves.toBe("兼容的流式文本");

    const received: number[] = [];
    const progressStream = new Response([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "第一段" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "第二段" } }] })}`,
      "data: [DONE]",
      "",
    ].join("\n"), { headers: { "Content-Type": "text/event-stream" } });
    expect(await readChatCompletionText(progressStream, (count) => received.push(count))).toBe("第一段第二段");
    expect(received).toEqual([3, 6]);

    const neverClosedAfterDone = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([
          `data: ${JSON.stringify({ choices: [{ delta: { content: "已完成" }, finish_reason: "stop" }] })}`,
          "data: [DONE]",
        ].join("\n")));
        // Deliberately do not close: a gateway can keep SSE heartbeats alive.
      },
      cancel() {},
    });
    await expect(readChatCompletionText(new Response(neverClosedAfterDone))).resolves.toBe("已完成");

    const ordinary = new Response(JSON.stringify({ choices: [{ message: { content: "普通响应" } }] }), {
      headers: { "Content-Type": "application/json" },
    });
    expect(await readChatCompletionText(ordinary)).toBe("普通响应");

    const interrupted = new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "已收到的前半段" } }] })}\n`, {
      headers: { "Content-Type": "text/event-stream" },
    });
    await expect(readChatCompletionText(interrupted)).rejects.toMatchObject({
      name: "ChatCompletionInterruptedError",
      partialText: "已收到的前半段",
    } satisfies Partial<ChatCompletionInterruptedError>);
  });

  it("清理最终提示词开头的隐藏推理标签，保留中文首个类别标题", () => {
    const response = "<think>**Ensuring precise Chinese heading order**</think>\n\n场景上下文：\n阿俊站在车厢内。\n\n活动引用：\n@char_demo_hero_base_v1 [image1]：阿俊。";
    expect(sanitizeFinalPromptResponse(response)).toBe("场景上下文：\n阿俊站在车厢内。\n\n活动引用：\n@char_demo_hero_base_v1 [image1]：阿俊。");
  });

  it("最终提示词动作节奏缺少分段时，按 canonical 镜头时间边界恢复分组并补齐图片标记", () => {
    const canonical = [
      "SCENE CONTEXT:\nA carriage.",
      "SHOT EXECUTION:\nSHOT 1 0:00-0:02:\n0:00-0:01: @char_demo_hero_base_v1 [image1]: reaches.\n\nSHOT 2 0:02-0:05:\n0:02-0:03: @char_demo_hero_base_v1 [image1]: turns.",
      "PHYSICS:\nKeep contact.",
    ].join("\n\n");
    const response = [
      "场景上下文：\n车厢内。",
      "动作节奏：\n0:00–0:01：@char_demo_hero_base_v1：伸手。\n0:02–0:03：@char_demo_hero_base_v1：转身。",
      "物理：\n保持接触。",
    ].join("\n\n");

    const result = sanitizeFinalPromptResponse(response, canonical, "zh");

    expect(result).toContain("第 1 段（0:00–0:02）：");
    expect(result).toContain("第 2 段（0:02–0:05）：");
    expect(result).toContain("@char_demo_hero_base_v1 [image1]：伸手");
    expect(result).toContain("@char_demo_hero_base_v1 [image1]：转身");
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
    expect(request.user).toContain("Every @asset_tag, matching [imageN], and @audioN token");
    expect(request.user).toContain("Acting master profiles are AI-only references");
    expect(request.user).toContain("only their shot-specific, observable adaptation");
    expect(request.user).toContain("首帧与空间走位必须覆盖最终输出中的每一个镜头段");
    expect(request.user).toContain("第 1 段首帧");
    expect(request.user).toContain("FORMAT MODE 是本次生成的整体执行格式摘要");
    expect(request.user).toContain("两个段落，一次甩切");
    expect(request.user).toContain("CAMERA 必须先写一段适用于全程的总摄影机描述");
    expect(request.user).toContain("第 1 段：……");
    expect(request.user).toContain("STYLE 必须位于光线之后、正向约束之前");
    expect(request.user).toContain("画质特征（清晰度、对比度、颗粒/无颗粒");
  });

  it("英文界面要求最终提示词使用英文类别和英文正文", () => {
    const request = buildFinalPromptRequest("SCENE CONTEXT:\nA train carriage.", "en");

    expect(request.system).toContain("clear, cinematic-grade English");
    expect(request.system).not.toContain("cinematic-grade Chinese");
    expect(request.user).toContain("Output only clear, cinematic-grade English");
    expect(request.user).toContain("SCENE CONTEXT, ACTIVE REFERENCES, LOCATION MAP");
    expect(request.user).toContain("attach acting to the corresponding shot and character inside ACTION TIMING");
    expect(request.user).toContain("FIRST FRAME AND SPATIAL BLOCKING must cover every shot segment");
    expect(request.user).toContain("SHOT 1 FIRST FRAME");
    expect(request.user).toContain("FORMAT MODE is the overall execution-format summary");
    expect(request.user).toContain("two segments, one whip cut");
    expect(request.user).toContain("grouped by shot segment");
    expect(request.user).toContain("matching [imageN]");
    expect(request.user).toContain("CAMERA must begin with one overall camera-language paragraph");
    expect(request.user).toContain("SHOT 1: ...");
    expect(request.user).toContain("STYLE must come after LIGHTING and before POSITIVE CONSTRAINTS");
    expect(request.user).toContain("image-quality traits (clarity, contrast, grain / no grain");
    expect(request.user).not.toContain("场景上下文、活动引用、场景地图");
  });


  it("最终生成源按 CINEDANCE 类别顺序合并导演文档与镜头执行", () => {
    const sceneWithDocument: SceneV2 = {
      ...scene,
      directorLayers: {
        sceneContext: "Edited scene context.",
        optics: "已编辑的光学。",
        lighting: "已编辑的光线。",
      },
    };
    const source = buildFinalGenerationSource({ ...project, styleId: "wong-kar-wai" }, sceneWithDocument);

    expect(source).toContain("SCENE CONTEXT:\nEdited scene context.");
    expect(source).toContain("ACTION TIMING:\n");
    expect(source).toContain("FIRST FRAME AND SPATIAL BLOCKING:\n");
    expect(source).toContain("LONG-TAKE FIRST FRAME");
    expect(source).toContain("@林警官: 克制.");
    expect(source).toContain("0:00 to 0:05: @林警官: 拿起 toward @香烟.");
    expect(source.indexOf("SCENE CONTEXT:")).toBeLessThan(source.indexOf("ACTIVE REFERENCES:"));
    expect(source.indexOf("CAMERA:")).toBeLessThan(source.indexOf("ACTION TIMING:"));
    expect(source.indexOf("ACTION TIMING:")).toBeLessThan(source.indexOf("PHYSICS:"));
    expect(source).toContain("STYLE:\n");
    expect(source.indexOf("LIGHTING:")).toBeLessThan(source.indexOf("STYLE:"));
    expect(source.indexOf("STYLE:")).toBeLessThan(source.indexOf("POSITIVE CONSTRAINTS:"));
    expect(source).not.toContain("SHOT EXECUTION:");
  });

  it("最终生成不会采用带场号或超长的旧场景上下文", () => {
    const staleContext = "如月车站1场1镜，发生在密集的城市街道，夜晚暴雨。旧预制场景的长篇摘要继续描述无关动作。";
    const source = buildFinalGenerationSource(project, {
      ...scene,
      sceneContext: staleContext,
      directorLayers: { sceneContext: `SCENE CONTEXT:\n${staleContext}` },
    });

    expect(source).not.toContain(staleContext);
    expect(source).not.toContain("密集的城市街道");
    expect(source).toContain("SCENE CONTEXT:\n");
  });

  it("最终生成遇到导演文档空间冲突时，以结构化镜头站位作为空间层兜底", () => {
    const conflictingScene: SceneV2 = {
      ...scene,
      shots: [{
        ...scene.shots[0],
        participants: [{ characterId: "hero", role: "primary", position: "screen-right" }],
      }],
      directorLayers: { locationMap: "镜头1：林警官位于画面左侧。" },
    };
    const source = buildFinalGenerationSource(project, conflictingScene);

    expect(source).toContain("shot 1");
    expect(source).toContain("position: screen-right");
    expect(source).not.toContain("林警官位于画面左侧");
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
        {
          ...scene.shots[0],
          participants: [{ characterId: "hero", role: "primary" }],
          // 声音锁只在角色开口的镜头输出：hero 在首镜开口，声音数据才会进活动引用。
          beats: [{ id: "beat-hero-line", order: 1, verb: "speak", actorId: "hero", dialogue: "我听见了。" }],
        },
        { ...scene.shots[0], id: "shot-2", label: "镜头 2", participants: [{ characterId: "support", role: "primary" }], beats: [] },
      ],
    };
    const source = buildFinalGenerationSource({ ...project, assets: taggedAssets }, multiShotScene);

    expect(source).toContain("@loc_demo_carriage_base_v1 [image1]: 车厢 — carriage");
    expect(source).toContain("@char_demo_hero_base_v1 [image2]: 林警官 — hero");
    expect(source).not.toContain("Acting template: 肩膀始终绷紧，先屏住呼吸再看向对手。");
    expect(source).toContain("林警官 VOICE: @char_demo_hero_base_v1 [image2]; voice lock: 低沉、短句、尾音收紧。; voice reference: @audio1.");
    expect(source).toContain("SHOT 1 (镜头 1): line: \"我听见了。\"");
    expect(source).toContain("After the final line, remain silent with no extra dialogue.");
    expect(source).toContain("@prop_demo_bag_base_v1 [image3]: 红色托特包 — red tote bag");
    expect(source).toContain("@char_demo_support_base_v1 [image4]: 阿俊 — support");
    expect(source).not.toContain("过期的活动引用");
    expect(source).not.toContain("未出场角色");
    // The prop declaration names its holder with the same @ handle, as required
    // by Seedance. The character's image, appearance, and acting profile are
    // declared once; holder, execution, and voice blocks reuse the same @ tag.
    expect((source.match(/@char_demo_hero_base_v1/g) ?? [])).toHaveLength(5);
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

  it("忽略 AI 导演层文本，始终用结构化分镜填充导演文档", () => {
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
    expect(result).not.toHaveProperty("directorLayerIssues");
  });

  it("只接受少量宏观决策，导演层仍由本地编译", () => {
    const result = normalizeSceneDraft(project, scene, {
      macro: {
        emotionArc: "从等待转为警觉。",
        lightingDirection: { primarySource: "车厢顶灯", direction: "从上方垂直向下" },
      },
      directorLayers: {
        sceneContext: "A quiet carriage.",
        formatMode: "FORMAT MODE:\n错误的旧格式。",
      },
      shots: [],
    }, "秒");

    expect(result.scene.emotionArc).toBe("从等待转为警觉。");
    expect(result.scene.lightingDirection).toMatchObject({ primarySource: "车厢顶灯" });
    expect(result.directorLayers?.sceneContext).toContain("车厢");
    expect(result.directorLayers?.formatMode).toContain("单一连续长镜头");
    expect(result.directorLayers?.formatMode).not.toContain("错误的旧格式");
    expect(result.scene.directorLayers).toEqual(result.directorLayers);
    expect(result).not.toHaveProperty("directorLayerIssues");
  });

  it("不接受 AI 返回的场景上下文，改由本地从场景与镜头事实生成", () => {
    const result = normalizeSceneDraft(project, {
      ...scene,
      location: "地铁车厢",
      logline: "阿俊擦开车窗雾气，看向窗外的黑暗。",
    }, {
      sceneContext: "旧预制街道场景。",
      shots: [],
    }, "秒", "zh", { preserveSceneContext: false });

    expect(result.scene.sceneContext).toBeUndefined();
    expect(result.directorLayers?.sceneContext).toContain("地铁车厢");
    expect(result.directorLayers?.sceneContext).toContain("阿俊擦开车窗雾气");
  });

  it("保留用户已填写的场景上下文，AI 未返回时不覆盖为空", () => {
    const sceneWithContext = { ...scene, sceneContext: "林sir坐在车厢中央，等待列车到站。" };
    const result = normalizeSceneDraft(project, sceneWithContext, { shots: [] }, "秒");
    expect(result.scene.sceneContext).toBe("林sir坐在车厢中央，等待列车到站。");
  });

  it("AI 编译不继承旧预制场景的场景上下文", () => {
    const sceneWithStaleContext = { ...scene, location: "地铁车厢", time: "白天", weather: "晴朗", sceneContext: "旧预制场景：雨夜中角色站在街道上。" };
    const result = normalizeSceneDraft(project, sceneWithStaleContext, { sceneContext: "旧预制场景：雨夜中角色站在街道上。", shots: [] }, "秒", "zh", { preserveSceneContext: false });
    expect(result.scene.sceneContext).toBeUndefined();
    expect(result.directorLayers?.sceneContext).not.toContain("雨夜");
    expect(result.directorLayers?.sceneContext).toContain("地铁车厢");
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

  it("AI 返回景别和镜头语言冲突时自动归一为可匹配组合", () => {
    const result = normalizeSceneDraft(project, scene, {
      shots: [{
        label: "失踪传说后的确认",
        framing: "Medium close-up",
        optics: { lensCharacter: "47-standard", fieldOfViewDegrees: 47 },
        action: "人物确认对方身份",
        acting: "克制",
        movement: "Static",
        direction: "left-to-right",
      }],
    }, "秒");

    expect(result.scene.shots[0].framing).toBe("Medium close-up");
    expect(result.scene.shots[0].optics).toMatchObject({ lensCharacter: "29-short-tele", fieldOfViewDegrees: 29 });
  });

  it("复杂镜头按可见事件保留超过八个节拍，不因固定数量被截断", () => {
    const beats = Array.from({ length: 13 }, (_, index) => ({
      order: index + 1,
      verb: "reacts",
      actorId: "hero",
      actionText: `可见反应 ${index + 1}`,
      duration: 0.25,
    }));
    const result = normalizeSceneDraft(project, scene, {
      shots: [{ ...scene.shots[0], beats }],
    }, "秒");

    expect(result.scene.shots[0].beats).toHaveLength(13);
  });

  it("AI 分镜 schema 只保留镜头执行与少量宏观决策", () => {
    expect(SCENE_DRAFT_JSON_SCHEMA).not.toContain('"audioPlan"');
    expect(SCENE_DRAFT_JSON_SCHEMA).not.toContain('"directorLayers"');
    expect(SCENE_DRAFT_JSON_SCHEMA).not.toContain('"activeReferences"');
    expect(SCENE_DRAFT_JSON_SCHEMA).not.toContain('"firstFrame"');
    expect(SCENE_DRAFT_JSON_SCHEMA).not.toContain('"actionTiming"');
    expect(SCENE_DRAFT_JSON_SCHEMA).not.toContain('"sceneContext"');
    expect(SCENE_DRAFT_JSON_SCHEMA).not.toContain('"actingObjectives"');
    expect(SCENE_DRAFT_JSON_SCHEMA).not.toContain('"firstFrameLock"');
    expect(SCENE_DRAFT_JSON_SCHEMA).not.toContain('"negativePrompt"');
    expect(SCENE_DRAFT_JSON_SCHEMA).not.toContain('"lens": string');
    expect(SCENE_DRAFT_JSON_SCHEMA).not.toContain('"stateBefore"');
    expect(SCENE_DRAFT_JSON_SCHEMA).not.toContain('"stateAfter"');
    expect(SCENE_DRAFT_JSON_SCHEMA).not.toContain('"propStatesAtStart"');
    expect(SCENE_DRAFT_JSON_SCHEMA).not.toContain('"propStatesAtEnd"');
    expect(SCENE_DRAFT_JSON_SCHEMA).toContain('"fieldOfViewDegrees": number');
    expect(SCENE_DRAFT_JSON_SCHEMA).toContain('"shots"');
    expect(SCENE_DRAFT_JSON_SCHEMA).toContain('"macro"');
    expect(SCENE_DRAFT_JSON_SCHEMA).toContain('"emotionArc"');
    expect(SCENE_DRAFT_JSON_SCHEMA).toContain('"startSeconds": number | null');
  });
});
