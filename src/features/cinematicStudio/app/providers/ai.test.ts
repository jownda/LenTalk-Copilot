import { describe, expect, it, vi } from "vitest";

import type { Asset, ProjectV2, SceneV2 } from "../../shared-types";
import { AI_RESPONSE_TIMEOUT_MS, assembleHybridFinalPrompt, buildFinalGenerationSource, buildFinalPromptRequest, ChatCompletionInterruptedError, classifyError, collectSceneAssetIds, normalizeContinuityRepairPatch, normalizeSceneDraft, prepareReferenceImageSource, readChatCompletionText, sanitizeFinalPromptResponse, SCENE_DRAFT_JSON_SCHEMA } from "./ai";
import { buildQuickPromptRequest } from "./quickPromptAgent";
import { LocalSuggestionProvider } from "../../engine/ai/assistant";
import { extractFirstPersonPovLock, renderFirstPersonPovLock } from "../../engine/story-supplement";

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
  it("极简节点 Agent 只使用显式输入，并保留素材引用与表演规则", () => {
    const request = buildQuickPromptRequest({
      style: "低饱和雨夜胶片质感",
      synopsis: "警察在车厢里盯住说谎的乘客，随后压低声音追问。",
      sceneAssets: [{ id: "scene", name: "车厢", description: "深夜列车车厢", referenceIndex: 1 }],
      characterAssets: [{ id: "hero", name: "林警官", description: "克制、警觉的中年警察", referenceIndex: 2 }],
    }, "zh");

    expect(request.system).toContain("CINEDANCE V4");
    expect(request.system).toContain("ACTING SYSTEM");
    expect(request.system).toContain("behavior under immediate pressure");
    // locale 决定成品提示词语言：中文界面要求输出中文成品，英文界面要求英文成品。
    expect(request.system).toContain("Write in clear, cinematic Chinese.");
    expect(request.user).toContain("低饱和雨夜胶片质感");
    expect(request.user).toContain("@车厢 [image1]");
    expect(request.user).toContain("@林警官 [image2]");
    expect(request.user).not.toContain("未选择素材");
  });

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

    const eofWithoutDone = new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: '{"shots":[]}' } }] })}\n`,
      { headers: { "Content-Type": "text/event-stream" } },
    );
    await expect(readChatCompletionText(eofWithoutDone, undefined, { allowUnterminatedEof: true }))
      .resolves.toBe('{"shots":[]}');

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
    const response = "<think>**Ensuring precise Chinese heading order**</think>\n\n风格：\n王家卫风格。\n\n活动引用：\n@char_demo_hero_base_v1 [image1]：阿俊。";
    expect(sanitizeFinalPromptResponse(response)).toBe("风格：\n王家卫风格。\n\n活动引用：\n@char_demo_hero_base_v1 [image1]：阿俊。");
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
    const request = buildFinalPromptRequest("阿俊在车厢内。", "zh");
    expect(request.user).toContain("CANONICAL AUDITED SOURCE:");
    expect(request.user).toContain("阿俊在车厢内");
    expect(request.user).toContain("Do not invent, remove, reinterpret, or contradict any fact");
    expect(request.user).toContain("Do not add prior context, story summaries, user notes");
    expect(request.user).toContain("清晰、电影级的中文");
    expect(request.system).toContain("clear, cinematic-grade Chinese");
    expect(request.system).toContain("an elite AI film prompt director for Seedance 2.0 and Higgsfield Seedance");
    expect(request.system).toContain("scene diagnosis, spatial blocking, optics selection, physics validation");
    expect(request.user).toContain("风格、活动引用、场景地图和站位");
    expect(request.user).toContain("动作节奏");
    expect(request.user).toContain("Every @asset_tag, matching [imageN], and @audioN token");
    expect(request.user).toContain("Acting master profiles are AI-only references");
    expect(request.user).toContain("only their shot-specific, observable adaptation");
    expect(request.user).toContain("场景地图和站位合并为同一段");
    expect(request.user).toContain("只输出一份场景级空间总图");
    expect(request.user).toContain("不输出任何首帧占位"); // 首帧已从最终导出整体移除
    expect(request.user).toContain("FORMAT MODE 是本次生成的整体执行格式摘要");
    expect(request.user).toContain("两个段落，一次甩切");
    expect(request.user).toContain("格式模式范围锁（优先级高于上文）：只写生成组织方式、总时长、段数、画幅、速度和镜头连接顺序");
    expect(request.user).toContain("正向约束范围锁（优先级高于上文）：只写模型容易犯错且必须锁死的事实");
    expect(request.user).toContain("CAMERA 必须先写一段适用于全程的总摄影机描述");
    expect(request.user).toContain("摄像机范围锁（优先级高于上文）：只写运镜路径、速度/力度、触发事件、停止或落点");
    expect(request.user).toContain("OPTICS 是镜头执行的结构化真源");
    expect(request.user).toContain("第 1 段：……");
    expect(request.user).toContain("STYLE 是导演文档中的本地风格原文");
    expect(request.user).toContain("必须逐字复制规范源 STYLE 段的正文");
    expect(request.user).not.toContain("画质特征（清晰度、对比度、颗粒/无颗粒");
  });

  it("英文界面要求最终提示词使用英文类别和英文正文", () => {
    const request = buildFinalPromptRequest("SCENE CONTEXT:\nA train carriage.", "en");

    expect(request.system).toContain("clear, cinematic-grade English");
    expect(request.system).not.toContain("cinematic-grade Chinese");
    expect(request.system).toContain("elite AI film prompt director");
    expect(request.system).toContain("silent QA before output");
    expect(request.user).toContain("Output only clear, cinematic-grade English");
    expect(request.user).toContain("STYLE, ACTIVE REFERENCES, SCENE MAP AND STAGING");
    expect(request.user).toContain("the PERFORMANCE section is generated locally per shot and inserted verbatim");
    expect(request.user).toContain("never write character acting, micro-expression, eye life, or eyeline inside ACTION TIMING");
    // 动作节奏必须明确禁止复述机位配置，否则模型会把 CAMERA / OPTICS 再抄一遍。
    expect(request.user).toContain("never open a segment with a camera recital in place of its action");
    expect(request.user).toContain("SCENE MAP AND STAGING is one section");
    expect(request.user).toContain("output one scene-level master map only");
    expect(request.user).toContain("Do not output any first-frame occupancy block");
    expect(request.user).toContain("FORMAT MODE is the overall execution-format summary");
    expect(request.user).toContain("two segments, one whip cut");
    expect(request.user).toContain("grouped by shot segment");
    expect(request.user).toContain("matching [imageN]");
    expect(request.user).toContain("CAMERA must begin with one overall camera-language paragraph");
    expect(request.user).toContain("OPTICS is the structured source of truth for shot execution");
    expect(request.user).toContain("SHOT 1: ...");
    expect(request.user).toContain("STYLE is the local style text from the director document");
    expect(request.user).toContain("copy the STYLE body from the canonical source character-for-character");
    expect(request.user).not.toContain("image-quality traits (clarity, contrast, grain / no grain");
    expect(request.user).not.toContain("场景上下文、活动引用、场景地图");
  });

  it("最终提示词的风格段始终直接采用本地规范源", () => {
    const source = [
      "SCENE CONTEXT:\nA train carriage.",
      "STYLE:\n青绿色约 60%、墨色冷灰约 30%、自然肤色与环境色约 10%；所有镜头保持统一色调。",
      "POSITIVE CONSTRAINTS:\nKeep the same style.",
    ].join("\n\n");
    const modelText = [
      "SCENE CONTEXT:\nA train carriage.",
      "STYLE:\nA warm, grainy style rewritten by the model.",
      "POSITIVE CONSTRAINTS:\nKeep the same style.",
    ].join("\n\n");

    const sanitized = sanitizeFinalPromptResponse(modelText, source, "en");
    expect(sanitized).toContain("STYLE:\n青绿色约 60%、墨色冷灰约 30%、自然肤色与环境色约 10%；所有镜头保持统一色调。");
    expect(sanitized).not.toContain("A warm, grainy style rewritten by the model");
  });

  it("中文界面最终提示词的风格段同样直接采用本地规范源", () => {
    const source = [
      "STYLE:\n王家卫风格：潮湿浓烈的红绿色调，慢快门的霓虹拖影，颗粒感保留。",
      "ACTIVE REFERENCES:\n@loc_demo_base_v1 [image1]：空间。",
    ].join("\n\n");
    const modelText = [
      "风格：\n被 AI 重写的一段风格描述。",
      "活动引用：\n@loc_demo_base_v1 [image1]：空间。",
    ].join("\n\n");

    const sanitized = sanitizeFinalPromptResponse(modelText, source, "zh");
    expect(sanitized).toContain("风格：\n王家卫风格：潮湿浓烈的红绿色调，慢快门的霓虹拖影，颗粒感保留。");
    expect(sanitized).not.toContain("被 AI 重写的一段风格描述");
  });

  it("模型重复输出两段风格（一段带冒号一段裸标题）时只保留一份且位于开头", () => {
    const source = [
      "STYLE:\n青绿色约 60%、墨色冷灰约 30%；所有镜头保持统一色调。",
      "ACTIVE REFERENCES:\n@loc_demo_base_v1 [image1]：车厢。",
      "SHOT EXECUTION:\nSHOT 1 0:00-0:02:\n0:00-0:01: 阿俊转身。",
    ].join("\n\n");
    const modelText = [
      "风格：\n青绿色约 60%、墨色冷灰约 30%；所有镜头保持统一色调。",
      "风格\n青绿色约 60%、墨色冷灰约 30%；所有镜头保持统一色调。",
      "活动引用\n@loc_demo_base_v1 [image1]：车厢。",
      "动作节奏\n0:00–0:01：阿俊转身。",
    ].join("\n\n");

    const sanitized = sanitizeFinalPromptResponse(modelText, source, "zh");

    expect(sanitized.match(/^风格：/)).not.toBeNull();
    expect(sanitized.split("青绿色约 60%")).toHaveLength(2);
    expect(sanitized).toContain("@loc_demo_base_v1 [image1]：车厢。");
    expect(sanitized).toContain("0:00–0:01：阿俊转身。");
  });


  it("最终生成源按 CINEDANCE 类别顺序合并导演文档与镜头执行", () => {
    const sceneWithDocument: SceneV2 = {
      ...scene,
      directorLayers: {
        optics: "已编辑的光学。",
        lighting: "已编辑的光线。",
      },
    };
    const source = buildFinalGenerationSource({ ...project, styleId: "wong-kar-wai" }, sceneWithDocument);

    expect(source).not.toContain("SCENE CONTEXT:");
    expect(source).toContain("ACTION TIMING:\n");
    expect(source).toContain("SCENE MAP AND STAGING:\n");
    expect(source).not.toContain("SHOT 1 FIRST FRAME");
    expect(source).not.toContain("FIRST FRAME");
    expect(source).toContain("@林警官: 克制.");
    expect(source).toContain("0:00 to 0:05: @林警官: 拿起 toward @香烟.");
    expect(source.indexOf("STYLE:")).toBeLessThan(source.indexOf("ACTIVE REFERENCES:"));
    expect(source.indexOf("CAMERA:")).toBeLessThan(source.indexOf("ACTION TIMING:"));
    expect(source.indexOf("ACTION TIMING:")).toBeLessThan(source.indexOf("PHYSICS:"));
    expect(source).toContain("STYLE:\n");
    expect(source.indexOf("STYLE:")).toBeLessThan(source.indexOf("LIGHTING:"));
    expect(source.indexOf("STYLE:")).toBeLessThan(source.indexOf("POSITIVE CONSTRAINTS:"));
    expect(source).not.toContain("已编辑的光学。");
    expect(source).not.toContain("SHOT EXECUTION:");
  });

  it("最终生成始终采用镜头详情中的景别和镜头语言，而不是旧导演文档层", () => {
    const manualShotScene: SceneV2 = {
      ...scene,
      shots: [{
        ...scene.shots[0],
        framing: "Tight two-shot",
        optics: { lensCharacter: "12-long-tele", fieldOfViewDegrees: 12 },
      }],
      directorLayers: { optics: "过期的 84° 广角光学文本。" },
    };

    const source = buildFinalGenerationSource(project, manualShotScene, "zh");

    expect(source).toContain("OPTICS:\n镜头 1：12° 超长焦；景别：紧凑双人镜头");
    expect(source).not.toContain("过期的 84° 广角光学文本。");
  });

  it("最终生成始终采用镜头检查器手动选择的相机型号，而不是规划时预填的相机层快照", () => {
    const manualCameraScene: SceneV2 = {
      ...scene,
      shots: [{ ...scene.shots[0], camera: "sony-venice-2" }],
      directorLayers: { camera: "相机型号：ARRI ALEXA 35（规划时预填的旧快照）。" },
    };

    const source = buildFinalGenerationSource(project, manualCameraScene, "zh");

    expect(source).toContain("相机型号：SONY VENICE 2");
    expect(source).not.toContain("ARRI ALEXA 35");
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

    // 空间冲突时回退为本地生成的场景级总图（不再输出逐镜首帧占位）。
    expect(source).toContain("Location reference: @车厢");
    // 参与者站位仍由镜头执行的 ACTION TIMING 逐镜承载。
    expect(source).toContain("(screen-right)");
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
    // declared once; holder, execution, dialogue order, and voice blocks reuse
    // the same @ tag (always with [imageN], never a bare name). The first-frame
    // block was intentionally removed from the final export and no longer
    // contributes a reference.
    expect((source.match(/@char_demo_hero_base_v1/g) ?? [])).toHaveLength(7);
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

  it("将场景候选角色纳入分镜规划资产范围，但不要求进入空间排序", () => {
    const nextScene = {
      ...scene,
      staging: { ...scene.staging, characterRoster: ["unused-character"], characterOrder: [] },
    };

    expect(collectSceneAssetIds(project, nextScene)).toEqual(["location", "hero", "prop", "unused-character"]);
  });

  it("忽略 AI 导演层文本，始终用结构化分镜填充导演文档", () => {
    const invalidScene = { ...scene, shootingMode: "multi-shot" as const };
    const result = normalizeSceneDraft(project, invalidScene, {
      directorLayers: {
        optics: "AI 写的错误光学。",
      },
      shots: [],
    }, "秒");

    expect(result.directorLayers).not.toHaveProperty("sceneContext");
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
        formatMode: "FORMAT MODE:\n错误的旧格式。",
      },
      shots: [],
    }, "秒");

    expect(result.scene.emotionArc).toBe("从等待转为警觉。");
    expect(result.scene.lightingDirection).toMatchObject({ primarySource: "车厢顶灯" });
    expect(result.directorLayers).not.toHaveProperty("sceneContext");
    expect(result.directorLayers?.formatMode).toContain("单一连续长镜头");
    expect(result.directorLayers?.formatMode).not.toContain("错误的旧格式");
    expect(result.scene.directorLayers).toEqual(result.directorLayers);
    expect(result).not.toHaveProperty("directorLayerIssues");
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

  it("将第一层表演节拍绑定到第二层镜头，并过滤不存在的节拍 id", () => {
    const plannedScene: SceneV2 = {
      ...scene,
      performancePlan: {
        id: "performance-plan-1",
        status: "confirmed",
        characterPlans: [{ characterId: "hero", objective: "让阿俊承认隐瞒" }],
        beats: [{ id: "performance-beat-1", order: 1, actorId: "hero", targetCharacterId: "support", action: "手指在烟盒边缘停住，先看见阿俊回避的视线" }],
        version: 1,
      },
    };
    const result = normalizeSceneDraft(project, plannedScene, {
      shots: [{
        label: "确认",
        time: { startSeconds: 0, endSeconds: 5 },
        movement: "Dolly",
        direction: "left-to-right",
        action: "林警官逼近阿俊",
        performanceDescription: "林警官的手指停在烟盒边缘，目光先捕捉阿俊回避的眼神。",
        lightingBehavior: "顶灯在林警官左后上方，靠近时左脸亮部收窄，阿俊身后的车窗反光变亮。",
        backgroundActivity: "后景乘客错开整理背包和避让过道，靠门的人短暂停住。",
        participants: [{ characterId: "hero", role: "primary" }, { characterId: "support", role: "target" }],
        planningMeta: {
          performanceBeatIds: ["performance-beat-1", "unknown"],
          shotIntent: "让回避成为可见证据",
          cameraTrigger: "阿俊移开目光",
          cameraEndState: "停在两人之间的紧张距离",
        },
      }],
    }, "秒");

    expect(result.scene.shots[0].planningMeta).toEqual({
      status: "confirmed",
      performanceBeatIds: ["performance-beat-1"],
      shotIntent: "让回避成为可见证据",
      cameraTrigger: "阿俊移开目光",
      cameraEndState: "停在两人之间的紧张距离",
    });
    expect(result.scene.shots[0]).toMatchObject({
      lightingBehavior: "顶灯在林警官左后上方，靠近时左脸亮部收窄，阿俊身后的车窗反光变亮。",
      backgroundActivity: "后景乘客错开整理背包和避让过道，靠门的人短暂停住。",
    });
  });

  it("将故事梗概里的全程第一人称 POV 升级为跨镜头锁，并排除视角持有者", () => {
    const ajian: Asset = { id: "ajian", kind: "character", name: "阿健", description: "", referencePaths: [], lockLevel: "none", tags: [] };
    const rebecca: Asset = { id: "rebecca", kind: "character", name: "Rebecca", description: "", referencePaths: [], lockLevel: "none", tags: [] };
    const povScene: SceneV2 = {
      ...scene,
      logline: "全程阿健第一人称 POV 视角拍摄 Rebecca 全身背影，阿健不出镜。",
      staging: { ...scene.staging, characterRoster: [ajian.id, rebecca.id] },
    };
    const povProject = { ...project, assets: [...assets, ajian, rebecca] };
    const lock = extractFirstPersonPovLock(povScene.logline);
    expect(lock).toMatchObject({ operatorName: "阿健", hideOperator: true });
    expect(renderFirstPersonPovLock(lock!, "zh")).toContain("禁止第三人称、旁观或反打机位");

    const result = normalizeSceneDraft(povProject, povScene, {
      shots: [{
        label: "错误的第三人称覆盖镜头",
        movement: "Crane",
        cameraBehavior: { description: "摄影机从远处升起，俯瞰阿健与 Rebecca。" },
        participants: [{ characterId: ajian.id, role: "primary" }],
        action: "阿健走向 Rebecca",
        direction: "left-to-right",
      }],
    }, "秒");

    expect(result.scene.shots[0].movement).toBe("POV");
    expect(result.scene.shots[0].participants).toEqual([]);
    expect(result.scene.shots[0].cameraBehavior?.description).toContain("全程第一人称 POV 锁");
  });

  it("最终混合整理遇到 POV 锁时透传 canonical 相机与动作节奏，拒绝 AI 第三人称改写", () => {
    const povSource = [
      "STYLE:\n写实。",
      "CAMERA:\n全程第一人称 POV 锁：摄影机即阿健的眼睛；禁止第三人称、旁观或反打机位；阿健绝不出镜，包括身体、脸、影子与倒影。",
      "ACTION TIMING:\n0:00–0:05 — 镜头 1（相机：全程第一人称 POV 锁：摄影机即阿健的眼睛；POV运镜）：Rebecca移动。",
      "FORMAT MODE:\n单次生成。",
    ].join("\n\n");
    const rewritten = [
      "摄像机：第三人称环绕阿健和 Rebecca。",
      "动作节奏：从 Rebecca 背后切到阿健正面。",
      "格式模式：单次生成。",
    ].join("\n");
    const output = assembleHybridFinalPrompt(povSource, rewritten, "zh");

    expect(output).toContain("全程第一人称 POV 锁：摄影机即阿健的眼睛");
    expect(output).toContain("0:00–0:05 — 镜头 1（相机：全程第一人称 POV 锁");
    expect(output).not.toContain("第三人称环绕");
    expect(output).not.toContain("切到阿健正面");
  });

  it("最终生成的相机段始终透传 canonical（手动改动的型号为准），AI 输出的冲突摄像机/相机段被丢弃", () => {
    const source = [
      "STYLE:\n写实。",
      "CAMERA:\n相机型号：ARRI ALEXA 35（用户手动修正）；相机行为：手持贴身跟随。",
      "FORMAT MODE:\n单次生成。",
    ].join("\n\n");
    const rewritten = [
      "摄像机：相机型号：SONY VENICE 2；固定机位观察。",
      "相机：相机型号：RED KOMODO。",
      "动作节奏：\n0:00–0:02：人物移动。",
      "格式模式：\n单次生成。",
    ].join("\n");
    const output = assembleHybridFinalPrompt(source, rewritten, "zh");

    expect(output).toContain("相机型号：ARRI ALEXA 35（用户手动修正）；相机行为：手持贴身跟随。");
    expect(output).not.toContain("SONY VENICE 2");
    expect(output).not.toContain("RED KOMODO");
    // 相机段只保留一份，不再出现“相机 + 摄像机”两个标题并存
    expect(output.match(/相机：/g)?.length).toBe(1);
    expect(output).not.toContain("摄像机：");
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
    expect(SCENE_DRAFT_JSON_SCHEMA).toContain('"lightingBehavior"');
    expect(SCENE_DRAFT_JSON_SCHEMA).toContain('"backgroundActivity"');
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

describe("prepareReferenceImageSource", () => {
  it("公网地址直接透传，不重复下载图片", async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      await expect(prepareReferenceImageSource("https://cdn.example.com/ref.jpg"))
        .resolves.toBe("https://cdn.example.com/ref.jpg");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("本机文件路径（素材库 sourcePath）转成 data URL，模型才能取到图", async () => {
    const originalFetch = globalThis.fetch;
    const originalFileReader = (globalThis as { FileReader?: unknown }).FileReader;
    const fetchSpy = vi.fn(async () => new Response(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    class FakeFileReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL(): void {
        this.result = "data:image/png;base64,QUJD";
        this.onload?.();
      }
    }
    (globalThis as { FileReader?: unknown }).FileReader = FakeFileReader;
    try {
      await expect(prepareReferenceImageSource("/Users/job/Pictures/ref.png"))
        .resolves.toBe("data:image/png;base64,QUJD");
      expect(fetchSpy).toHaveBeenCalledWith("/Users/job/Pictures/ref.png");
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as { FileReader?: unknown }).FileReader = originalFileReader;
    }
  });

  it("已经是 data URL 时原样返回（无 canvas 环境不做缩放）", async () => {
    const dataUrl = "data:image/png;base64,QUJD";
    await expect(prepareReferenceImageSource(dataUrl)).resolves.toBe(dataUrl);
  });

  it("空地址直接报错，不把空图片发给模型", async () => {
    await expect(prepareReferenceImageSource("   ")).rejects.toThrow(/为空/);
  });
});
