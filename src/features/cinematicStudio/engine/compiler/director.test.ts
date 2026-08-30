import { describe, expect, it } from "vitest";

import type { Asset, ProjectV2, SceneV2 } from "../../shared-types";
import { buildDirectorDocumentLayers, compileDirectorSequence, DIRECTOR_LAYERS } from "./director";
import { compilePrompt } from "./models";

function makeScene(overrides: Partial<SceneV2> = {}): SceneV2 {
  return {
    id: "scene-1",
    name: "测试场景",
    logline: "角色在车厢中等待。",
    location: "地铁车厢",
    time: "夜晚",
    weather: "晴",
    duration: "5秒",
    palette: "冷白",
    lighting: "顶部灯光",
    environmentLock: true,
    shootingMode: "long-take",
    shots: [{
      id: "shot-1",
      label: "镜头 1",
      duration: "5秒",
      framing: "中景",
      lens: "35mm",
      movement: "Static",
      action: "角色保持坐姿",
      acting: "克制",
      direction: "left-to-right",
    }],
    ...overrides,
  };
}

function makeProject(scene: SceneV2): ProjectV2 {
  return {
    id: "project-1",
    title: "测试项目",
    description: "",
    preset: "custom",
    scenes: [scene],
    characters: [],
    assets: [],
  };
}

describe("compileDirectorSequence final export audit", () => {
  it("导演文档层不包含镜头执行，镜头执行仍从结构化镜头导出", () => {
    const scene = makeScene();
    const project = makeProject(scene);
    const layers = buildDirectorDocumentLayers(project, scene, { locale: "zh" });

    expect(DIRECTOR_LAYERS.map((layer) => layer.key)).not.toContain("actionTiming");
    expect(layers).not.toHaveProperty("actionTiming");
    expect(layers.sceneContext).toContain("测试场景");
    expect(compileDirectorSequence(project, scene, { locale: "zh" })).toContain("镜头执行：");
  });

  it("将选中的导演风格写入导演文档，并位于光线之后、正向约束之前", () => {
    const scene = makeScene();
    const project = { ...makeProject(scene), styleId: "wong-kar-wai" };
    const output = compileDirectorSequence(project, scene, { locale: "zh" });
    const layers = buildDirectorDocumentLayers(project, scene, { locale: "zh" });

    expect(output).toContain("风格：\n王家卫风格：");
    expect(layers.style).toContain("王家卫风格：");
    expect(output.indexOf("光线：")).toBeLessThan(output.indexOf("风格："));
    expect(output.indexOf("风格：")).toBeLessThan(output.indexOf("正向约束："));
  });

  it("没有预设导演时仍输出用户填写的自定义风格", () => {
    const scene = makeScene();
    const project = { ...makeProject(scene), styleBriefZh: "低饱和的潮湿现实质感。" };
    const output = compileDirectorSequence(project, scene, { locale: "zh" });

    expect(output).toContain("风格：\n低饱和的潮湿现实质感。");
  });

  it("故意越轴写入 CAMERA 段，而不是空间站位段", () => {
    const scene = makeScene({
      shootingMode: "multi-shot",
      shots: [
        { ...makeScene().shots[0], id: "shot-1", label: "正面" },
        {
          ...makeScene().shots[0],
          id: "shot-2",
          label: "反向切入",
          direction: "right-to-left",
          layout: { intentionalAxisBreak: true, axisNote: "表现关系突然失衡" },
        },
      ],
    });
    const output = compileDirectorSequence(makeProject(scene), scene, { locale: "zh" });

    expect(output).toContain("相机：\n镜头 反向切入：故意越轴：摄影机有意跨过180°轴线；表现关系突然失衡。");
    expect(output.indexOf("相机：")).toBeLessThan(output.indexOf("镜头执行："));
    expect(output).not.toContain("空间布局：故意越轴");
  });

  it("把摄影设备、空间视线、道具变化和节拍约束带入最终镜头执行", () => {
    const actor: Asset = {
      id: "actor-1", kind: "character", name: "林警官", description: "", descriptionZh: "中年男性",
      referencePaths: [], lockLevel: "none", tags: [],
    };
    const prop: Asset = {
      id: "prop-1", kind: "prop", name: "红色打火机", description: "", descriptionZh: "红色打火机",
      referencePaths: [], lockLevel: "none", tags: [],
    };
    const shot = {
      ...makeScene().shots[0],
      camera: "arri-alexa-35",
      lensModel: "cooke-s7i",
      participants: [{ characterId: actor.id, role: "primary" as const, position: "center", eyeline: "盯住红色打火机" }],
      layout: { useSceneStaging: false, characterOrder: [actor.id] },
      propChangeDescription: "林警官从桌上拿起打火机并点燃。",
      propStatesAtStart: [{ propId: prop.id, state: "held", holderCharacterId: actor.id }],
      beats: [{
        id: "beat-1", order: 1, duration: 2, actorId: actor.id, verb: "reaches",
        targetPropId: prop.id, targetBodyPart: "右手", actionText: "拿起并点燃",
        tactic: "试探", subtext: "假装漫不经心", required: true, forbiddenTargets: ["prop-2"],
        cutRule: "火焰出现时切换", stateAfter: [{ propId: prop.id, state: "lit", holderCharacterId: actor.id }],
      }],
    };
    const scene = makeScene({ shots: [shot] });
    const project = makeProject(scene);
    project.assets = [actor, prop];
    const output = compileDirectorSequence(project, scene, { locale: "zh" });

    expect(output).toContain("相机型号：ARRI ALEXA 35");
    expect(output).toContain("镜头型号：Cooke S7/i Full Frame+");
    expect(output).toContain("视线：盯住红色打火机");
    expect(output).toContain("道具变化：林警官从桌上拿起打火机并点燃");
    expect(output).toContain("目标部位：右手");
    expect(output).toContain("策略：试探");
    expect(output).toContain("潜台词：假装漫不经心");
    expect(output).toContain("必须发生");
    expect(output).toContain("禁止目标：prop-2");
    expect(output).toContain("剪辑规则：火焰出现时切换");
    expect(output).toContain("红色打火机：");
  });

  it("不再原样透传 storedLayers，也不导出用户填写的场景简报", () => {
    const storedLayers = {
      sceneContext: "SCENE CONTEXT:\nStored scene text.",
      formatMode: "FORMAT MODE:\nSINGLE CONTINUOUS TAKE.",
      negativeLocks: "NEGATIVE LOCKS:\nNo watermark.",
    };
    const scene = makeScene({ directorLayers: storedLayers });
    const output = compileDirectorSequence(makeProject(scene), scene, { locale: "en" });

    expect(output).toContain("FORMAT MODE:");
    expect(output).toContain("SCENE CONTEXT:");
    const context = output.split("\n\n")[0];
    expect(context).toContain("5 seconds");
    expect(context).not.toMatch(/[\u3400-\u9fff]/);
    expect(output).not.toContain("Stored scene text.");
    expect(output).not.toContain("No watermark.");
    expect(output).not.toContain("STRUCTURED SHOT INSPECTOR:");
  });

  it("最终导出无论选中何种旧模板，始终使用导演文档并隔离参考简报与全局技术", () => {
    const scene = makeScene({
      logline: "这是只供 AI 规划使用的场景梗概。",
      staging: { priorContext: "这是只供 AI 规划使用的前情提要。" },
    });
    const project = makeProject(scene);
    project.technicalProfile = {
      cinematography: ["这是只供 AI 规划使用的全局技术"],
    };
    const output = compilePrompt(project, scene, scene.shots[0], {
      template: "shot-cards",
      director: true,
      locale: "zh",
    }).text;

    expect(output).toContain("格式模式：");
    expect(output).not.toContain("分镜卡");
    expect(output).not.toContain("这是只供 AI 规划使用的场景梗概");
    expect(output).not.toContain("这是只供 AI 规划使用的前情提要");
    expect(output).not.toContain("这是只供 AI 规划使用的全局技术");
    expect(output).not.toContain("全局技术：");
    expect(output).not.toContain("风格倾向：");
    expect(output).not.toContain("前情提要：");
  });

  it("活动引用仅输出一次，长镜头不输出检查器或多个独立镜头块", () => {
    const actor: Asset = {
      id: "actor-1",
      kind: "character",
      name: "林警官",
      description: "middle-aged man",
      descriptionZh: "中年男性",
      referencePaths: ["actor-image"],
      voiceClip: "actor-voice",
      lockLevel: "none",
      tags: [],
      actingProfile: {
        masterProfileZh: "重心压低，先用停顿判断对手，再用缓慢转头逼近。",
        voicePromptZh: "低沉克制，压力下呼吸加重。",
      },
    };
    const scene = makeScene({
      directorLayers: {
        sceneContext: "SCENE CONTEXT:\nAI scene prose.",
        formatMode: "FORMAT MODE:\nSINGLE CONTINUOUS TAKE.",
        actionTiming: "ACTION TIMING:\nAI timing reference.",
      },
      shots: [{
        ...makeScene().shots[0],
        participants: [{ characterId: actor.id, role: "primary", position: "center" }],
        optics: { fieldOfViewDegrees: 84 },
        beats: [{
          id: "beat-1",
          order: 1,
          duration: 2,
          verb: "speak",
          actorId: actor.id,
          actionText: "抬眼并压低声音",
          dialogue: "我听见了。",
          required: true,
        }],
        acting: "先压住怒意，再让恐惧从眼神里露出来。",
        eyeLife: "眼睛先于头部转向声源，眨眼变慢。",
        performanceLevel: 4,
      }],
    });
    const project = makeProject(scene);
    project.assets = [actor];
    const output = compileDirectorSequence(project, scene, { locale: "zh", syntax: "at-mention" });

    expect(output).toContain("活动引用：");
    expect(output).toContain("@林警官");
    expect(output).toContain("抬眼并压低声音");
    expect(output).not.toContain("表演评分：");
    expect(output).toContain("说：“我听见了。”");
    expect(output).toContain("音频：");
    expect(output).toContain("对白顺序：林警官说“我听见了。”");
    expect(output).toContain("每句对白结束后保留约 0.5–1 秒环境声尾巴");
    expect(output).toContain("表演模板：重心压低，先用停顿判断对手，再用缓慢转头逼近。");
    expect(output).toContain("声音锁：低沉克制，压力下呼吸加重。");
    expect(output).toContain("声音参考：@audio1");
    expect(output).not.toContain("声音锁（林警官）");
    expect(output).not.toContain("镜头结构化检查器");
    expect(output).not.toContain("AI timing reference.");
    expect((output.match(/@林警官/g) ?? [])).toHaveLength(2);
  });

  it("身份锚不会重复完整描述中已有的服装或发型", () => {
    const actor: Asset = {
      id: "actor-1", kind: "character", name: "阿俊", description: "", descriptionZh: "阿俊穿黑色风衣，留短发，左眉有一道旧疤。",
      referencePaths: [], lockLevel: "strict", tags: [], uniqueMarkers: ["黑色风衣", "短发", "左眉旧疤"], alwaysVisible: ["左眉旧疤"],
    };
    const scene = makeScene({ shots: [{ ...makeScene().shots[0], participants: [{ characterId: actor.id, role: "primary" }] }] });
    const project = makeProject(scene);
    project.assets = [actor];
    const output = compileDirectorSequence(project, scene, { locale: "zh", syntax: "at-mention" });
    const references = output.split("\n\n")[1];
    expect(references).toContain("左眉有一道旧疤");
    expect(references).not.toContain("身份锚：黑色风衣");
    expect(references).not.toContain("身份锚：短发");
    expect(references).not.toContain("身份锚：左眉旧疤");
  });

  it("error 级分层冲突时回退结构化编译，不透传错误 storedLayers", () => {
    const invalidLayers = {
      sceneContext: "SCENE CONTEXT:\nAI generated scene.",
      formatMode: "FORMAT MODE:\nCONTROLLED MULTI-SHOT SEQUENCE.",
      actionTiming: "ACTION TIMING:\n0:00-0:05: continuous action without shot blocks.",
    };
    const scene = makeScene({
      shootingMode: "multi-shot",
      directorLayers: invalidLayers,
    });
    const output = compileDirectorSequence(makeProject(scene), scene, { locale: "en" });

    expect(output).toContain("FORMAT MODE");
    expect(output).toContain("SCENE CONTEXT:");
    expect(output).toContain("SHOT 1 0:00-0:05:");
    expect(output).toContain("SHOT 1: 47° Standard");
    expect(output).not.toContain("35mm");
    expect(output).not.toContain("AI generated scene.");
    expect(output).not.toContain("continuous action without shot blocks.");
  });

  it("场景上下文作为最终提示词第一段，且不泄漏前情或故事梗概", () => {
    const scene = makeScene({
      sceneContext: "阿俊坐在车厢中央，看向窗外。",
      logline: "仅供 AI 规划的故事梗概。",
      staging: { priorContext: "仅供 AI 规划的前情提要。" },
    });
    const output = compileDirectorSequence(makeProject(scene), scene, { locale: "zh" });

    expect(output.startsWith("场景上下文：\n阿俊坐在车厢中央，看向窗外。")).toBe(true);
    expect(output).not.toContain("仅供 AI 规划的");
  });

  it("没有 AI 场景上下文时使用确定性回退，仍输出为第一段", () => {
    const scene = makeScene();
    const output = compileDirectorSequence(makeProject(scene), scene, { locale: "zh" });

    expect(output.startsWith("场景上下文：")).toBe(true);
    expect(output).toContain("测试场景，5秒。");
    expect(output).toContain("发生在地铁车厢，夜晚，晴。");
    expect(output).toContain("角色保持坐姿。");
  });

  it("AI 场景上下文混入元信息时回退到结构化事实", () => {
    const scene = makeScene({
      sceneContext: "前情提要：上集林警官追查列车。本集阿俊看向窗外。",
    });
    const output = compileDirectorSequence(makeProject(scene), scene, { locale: "zh" });

    expect(output.startsWith("场景上下文：")).toBe(true);
    expect(output).not.toContain("前情提要");
    expect(output).not.toContain("上集");
  });

  it("场景上下文回退只取首镜角色并限制为三句", () => {
    const first = { id: "first", kind: "character" as const, name: "阿俊", description: "", descriptionZh: "", referencePaths: [], lockLevel: "none" as const, tags: [] };
    const later = { id: "later", kind: "character" as const, name: "琪琪", description: "", descriptionZh: "", referencePaths: [], lockLevel: "none" as const, tags: [] };
    const scene = makeScene({
      name: "车厢",
      shots: [{ ...makeScene().shots[0], participants: [{ characterId: "first", role: "primary" }] }],
    });
    const project = makeProject(scene);
    project.assets = [first, later];
    const output = compileDirectorSequence(project, scene, { locale: "zh" });
    const context = output.split("\n\n")[0];
    expect(context).toContain("阿俊");
    expect(context).not.toContain("琪琪");
    expect((context.match(/[。！？]/g) ?? []).length).toBeLessThanOrEqual(3);
  });

  it("英文界面拒绝中文 AI 语境并使用英文回退", () => {
    const scene = makeScene({ sceneContext: "阿俊坐在车厢中央，看向窗外。" });
    const output = compileDirectorSequence(makeProject(scene), scene, { locale: "en" });
    const context = output.split("\n\n")[0];
    expect(context).toContain("SCENE CONTEXT:");
    expect(context).not.toMatch(/[\u3400-\u9fff]/);
    expect(context).toContain("seconds");
  });

  it("多镜头在镜头执行中明确输出每个切点，并合并表演与动作", () => {
    const base = makeScene().shots[0];
    const scene = makeScene({
      shootingMode: "multi-shot",
      shots: [
        { ...base, id: "shot-1", label: "镜头 1", time: { startSeconds: 0, endSeconds: 2 }, action: "角色先停住。" },
        { ...base, id: "shot-2", label: "镜头 2", time: { startSeconds: 2, endSeconds: 5 }, cutStyle: "match-cut", action: "角色转身离开。" },
      ],
    });
    const output = compileDirectorSequence(makeProject(scene), scene, { locale: "zh" });

    expect(output).toContain("镜头执行：");
    expect(output).toContain("镜头 1 0:00–0:02：\n镜头保持：克制；角色先停住。");
    expect(output).toContain("镜头 2 0:02–0:05：动作匹配剪辑进入镜头 2；\n镜头保持：克制；角色转身离开。");
    expect(output).not.toContain("角色表演：");
    expect(output).not.toContain("角色站位（从左到右）");
  });

  it("按镜头隔离活动人物引用，不把场景角色表复制到每一镜", () => {
    const ajun: Asset = { id: "ajun", kind: "character", name: "阿俊", description: "", descriptionZh: "阿俊", referencePaths: [], lockLevel: "none", tags: [] };
    const qiqi: Asset = { id: "qiqi", kind: "character", name: "琪琪", description: "", descriptionZh: "琪琪", referencePaths: [], lockLevel: "none", tags: [] };
    const base = makeScene().shots[0];
    const scene = makeScene({ shootingMode: "multi-shot", shots: [
      { ...base, id: "shot-ajun", label: "阿俊特写", participants: [{ characterId: ajun.id, role: "primary" }] },
      { ...base, id: "shot-qiqi", label: "琪琪反应", time: { startSeconds: 5, endSeconds: 8 }, participants: [{ characterId: qiqi.id, role: "primary" }] },
    ] });
    const project = makeProject(scene);
    project.assets = [ajun, qiqi];
    const references = compileDirectorSequence(project, scene, { locale: "zh", syntax: "at-mention" }).split("场景地图：")[0];
    const firstShotReferences = references.split("镜头 2（琪琪反应）")[0];

    expect(firstShotReferences).toContain("镜头 1（阿俊特写）");
    expect(firstShotReferences).toContain("@阿俊");
    expect(firstShotReferences).not.toContain("@琪琪");
    expect(references).toContain("镜头 2（琪琪反应）");
  });

  it("将角色级镜头表演绑定到实际参与者", () => {
    const actor: Asset = { id: "actor", kind: "character", name: "林警官", description: "", descriptionZh: "", referencePaths: [], lockLevel: "none", tags: [] };
    const scene = makeScene({ shots: [{
      ...makeScene().shots[0],
      participants: [{ characterId: actor.id, role: "primary", acting: "手指停在烟灰缸边，压低呼吸", eyeLife: "视线先掠过车门，慢眨一次后回到对手" }],
    }] });
    const project = makeProject(scene);
    project.assets = [actor];
    const output = compileDirectorSequence(project, scene, { locale: "zh" });

    expect(output).toContain("@林警官：克制；手指停在烟灰缸边，压低呼吸；视线先掠过车门，慢眨一次后回到对手；角色保持坐姿。");
  });

  it("镜头执行使用角色显示名，并明确目标，不泄漏内部资产标签", () => {
    const actor: Asset = {
      id: "actor-1", kind: "character", name: "阿俊", referenceTag: "char_cb_阿俊_base_v1",
      description: "", descriptionZh: "", referencePaths: [], lockLevel: "none", tags: [],
    };
    const target: Asset = {
      id: "target-1", kind: "character", name: "黛莲", referenceTag: "char_cb_黛莲_base_v1",
      description: "", descriptionZh: "", referencePaths: [], lockLevel: "none", tags: [],
    };
    const scene = makeScene({
      shots: [{
        ...makeScene().shots[0],
        participants: [{ characterId: actor.id, role: "primary" }, { characterId: target.id, role: "supporting" }],
        beats: [{ id: "beat-1", order: 1, verb: "解释", actorId: actor.id, targetCharacterId: target.id, actionText: "压低声音说明传说", dialogue: "我听过。" }],
      }],
    });
    const project = makeProject(scene);
    project.assets = [actor, target];
    const output = compileDirectorSequence(project, scene, { locale: "zh", syntax: "at-mention" });

    expect(output).toContain("@char_cb_阿俊_base_v1：克制；压低声音说明传说；朝向黛莲；说：“我听过。”。");
    const execution = output.split("镜头执行：")[1]?.split("\n\n")[0] ?? "";
    expect(execution).toContain("@char_cb_阿俊_base_v1");
    expect(execution).not.toContain("@char_cb_黛莲_base_v1");
  });

  it("镜头执行按角色分组，提前反应不会串到其他角色", () => {
    const ajun: Asset = {
      id: "ajun", kind: "character", name: "阿俊", referenceTag: "char_cb_阿俊_base_v1",
      description: "", descriptionZh: "", referencePaths: [], lockLevel: "none", tags: [],
    };
    const qiqi: Asset = {
      id: "qiqi", kind: "character", name: "琪琪", referenceTag: "char_cb_琪琪_base_v1",
      description: "", descriptionZh: "", referencePaths: [], lockLevel: "none", tags: [],
    };
    const scene = makeScene({
      shots: [{
        ...makeScene().shots[0],
        acting: "阿俊克制讲述，琪琪压住恐惧。",
        eyeLife: "阿俊看向车厢深处，琪琪短暂看向公文包。",
        participants: [{ characterId: ajun.id, role: "primary" }, { characterId: qiqi.id, role: "supporting" }],
        beats: [
          { id: "beat-ajun", order: 1, verb: "讲述", actorId: ajun.id, actionText: "压低声音讲述传说", beatChange: "语速逐渐加快" },
          { id: "beat-qiqi", order: 2, verb: "收紧", actorId: qiqi.id, actionText: "把公文包压在胸前", reactionBeforeLine: "在阿俊开口前先收紧手指" },
        ],
      }],
    });
    const project = makeProject(scene);
    project.assets = [ajun, qiqi];
    const output = compileDirectorSequence(project, scene, { locale: "zh", syntax: "at-mention" });
    const execution = output.split("镜头执行：")[1]?.split("\n\n")[0] ?? "";

    expect(execution).toContain("@char_cb_阿俊_base_v1：阿俊克制讲述，琪琪压住恐惧；阿俊看向车厢深处，琪琪短暂看向公文包；压低声音讲述传说；语速逐渐加快。");
    expect(execution).toContain("@char_cb_琪琪_base_v1：把公文包压在胸前；在阿俊开口前先收紧手指。");
    expect(execution.indexOf("@char_cb_阿俊_base_v1：")).toBeLessThan(execution.indexOf("@char_cb_琪琪_base_v1："));
    expect(execution).toContain("@char_cb_阿俊_base_v1");
    expect(execution).toContain("@char_cb_琪琪_base_v1");
  });

  it("长镜头保留连续时间轴中的动作时间块", () => {
    const base = makeScene().shots[0];
    const scene = makeScene({
      shootingMode: "long-take",
      duration: "5秒",
      shots: [
        { ...base, id: "shot-1", time: { startSeconds: 0, endSeconds: 2 }, action: "先停住。" },
        { ...base, id: "shot-2", time: { startSeconds: 2, endSeconds: 5 }, action: "再向前走。" },
      ],
    });
    const output = compileDirectorSequence(makeProject(scene), scene, { locale: "zh" });

    expect(output).toContain("0:00–0:02：\n镜头保持：克制；先停住。");
    expect(output).toContain("0:02–0:05：\n镜头保持：克制；再向前走。");
  });

  it("中文导出将结构化场景地图标签渲染为中文", () => {
    const actor: Asset = {
      id: "actor-1", kind: "character", name: "林警官", description: "", descriptionZh: "", referencePaths: [], lockLevel: "none", tags: [],
    };
    const scene = makeScene({ staging: {
      locationAssetId: "train", characterOrder: [actor.id], anchorDescription: "中央过道", spacing: "相距两米", axisDirection: "left-to-right",
    }, shots: [{
      ...makeScene().shots[0],
      cameraBehavior: { height: "胸口高度", distance: "距人物两米", angle: "朝向车厢后端", depthOfField: "前景烟头清晰，后景逐渐虚化" },
      participants: [{ characterId: actor.id, role: "primary", position: "中景中央", anchorDistance: "距车门一米" }],
    }] });
    const project = makeProject(scene);
    project.assets = [actor, { id: "train", kind: "location", name: "地铁车厢", description: "", descriptionZh: "", referencePaths: [], lockLevel: "none", tags: [] }];
    const output = compileDirectorSequence(project, scene, { locale: "zh" });

    expect(output).toContain("场景地图：");
    expect(output).toContain("地点参考：地铁车厢");
    expect(output).toContain("相机位置：");
    expect(output).toContain("场景人物基准位置");
    expect(output).toContain("空间基准：使用地点参考的真实地理关系、材质、地标和相关光线方向");
    expect(output).toContain("屏幕方向：从左到右");
    expect(output).not.toContain("Location reference:");
  });

  it("首帧参考图写入首帧锁并在活动资产图片之后编号", () => {
    const scene = makeScene({
      firstFrameLock: { occupancyStatement: "第一帧已包含林警官。", referenceImages: ["first-frame-image"] },
      shots: [{ ...makeScene().shots[0], characterId: "actor-1", participants: [{ characterId: "actor-1", role: "primary" }] }],
    });
    const actor: Asset = { id: "actor-1", kind: "character", name: "林警官", description: "中年男性", referencePaths: ["actor-image"], lockLevel: "none", tags: [] };
    const output = compileDirectorSequence({ ...makeProject(scene), assets: [actor] }, scene, { locale: "zh" });
    expect(output).toContain("首帧参考图：[image2]");
  });

  it("默认首帧锁禁止空镜和延迟亮相", () => {
    const scene = makeScene({ firstFrameLock: { requiredSubjectIds: ["actor-1"] } });
    const actor: Asset = { id: "actor-1", kind: "character", name: "林警官", description: "中年男性", referencePaths: [], lockLevel: "none", tags: [] };
    const output = compileDirectorSequence({ ...makeProject(scene), assets: [actor] }, scene, { locale: "zh" });
    expect(output).toContain("无空镜建立镜头");
    expect(output).toContain("空间关系在第一帧立即可读");
  });

  it("镜头执行保留可拍摄表演与提前反应，不导出评分或潜台词字段", () => {
    const actor: Asset = {
      id: "actor-1", kind: "character", name: "林警官", description: "", descriptionZh: "", referencePaths: [], lockLevel: "none", tags: [],
    };
    const scene = makeScene({ shots: [{
      ...makeScene().shots[0], participants: [{ characterId: actor.id, role: "primary", position: "center" }], acting: "压住怒气，呼吸逐渐变浅", eyeLife: "先看车门，再回到前方", performanceLevel: 5,
      beats: [{ id: "beat-1", order: 1, verb: "pauses", actorId: actor.id, beatChange: "擦烟灰的手突然停住", reactionBeforeLine: "先收紧手指" }],
    }] });
    const project = makeProject(scene);
    project.assets = [actor];
    const output = compileDirectorSequence(project, scene, { locale: "zh" });

    expect(output).toContain("镜头执行：");
    expect(output).toContain("压住怒气，呼吸逐渐变浅");
    expect(output).toContain("@林警官：压住怒气，呼吸逐渐变浅；先看车门，再回到前方；pauses；擦烟灰的手突然停住；先收紧手指。");
    expect(output).not.toContain("表演评分");
    expect(output).not.toContain("潜台词：");
  });

  it("将已知失败模式导出为局部正向锁，而不是默认负面词堆", () => {
    const scene = makeScene();
    const project = makeProject(scene);
    project.negativePrompt = "no floating props, no wardrobe changes";
    const output = compileDirectorSequence(project, scene, { locale: "zh" });

    expect(output).toContain("所有道具始终有明确的接触点、重量和位置");
    expect(output).toContain("服装在全段保持不变");
    expect(output).not.toContain("不要漂浮道具");
    expect(output).not.toContain("不要服装变化");
  });

  it("默认导出无配乐无字幕，并且不泄漏仅供 AI 参考的简报字段", () => {
    const scene = makeScene({ dialogue: "这段对白仅供 AI 分镜参考。", mustHappen: ["必须发生的参考事件"] });
    const project = makeProject(scene);
    const output = compileDirectorSequence(project, scene, { locale: "zh" });

    expect(output).toContain("默认环境声：");
    expect(output).toContain("人物呼吸、衣料、脚步、道具接触、摩擦与碰撞");
    expect(output).toContain("配乐：无。字幕：无。");
    expect(output).not.toContain("这段对白仅供 AI 分镜参考。");
    expect(output).not.toContain("必须发生的参考事件");
  });

  it("只导出用户主动选择的音频计划项", () => {
    const scene = makeScene();
    const project = makeProject(scene);
    project.audioPlan = { diegeticMusic: ["车载收音机"], sfx: ["列车低频轰鸣"], score: "original-score", subtitles: true };
    const output = compileDirectorSequence(project, scene, { locale: "zh" });

    expect(output).toContain("画内音乐：车载收音机。");
    expect(output).toContain("环境音效：列车低频轰鸣。");
    expect(output).toContain("配乐：原始配乐。字幕：烧录字幕。");
  });

  it("将与广角 FOV 矛盾的压缩感改为可观察的纵深结果", () => {
    const scene = makeScene({ shots: [{
      ...makeScene().shots[0],
      optics: { fieldOfViewDegrees: 84, lensOutcome: ["84° 广角压缩感"] },
    }] });
    const output = compileDirectorSequence(makeProject(scene), scene, { locale: "zh" });
    expect(output).toContain("纵深拉开，近景略大于远景");
    expect(output).not.toContain("广角压缩感");
  });

  it("多镜头逐镜输出 FOV 与可见结果，不再输出检查器式镜头锁", () => {
    const base = makeScene().shots[0];
    const scene = makeScene({ shootingMode: "multi-shot", shots: [
      { ...base, id: "wide", label: "建立", optics: { lensCharacter: "84-wide", fieldOfViewDegrees: 84 } },
      { ...base, id: "tele", label: "反应", optics: { lensCharacter: "29-short-tele", fieldOfViewDegrees: 29 }, time: { startSeconds: 5, endSeconds: 10 } },
    ] });
    const output = compileDirectorSequence(makeProject(scene), scene, { locale: "zh" });
    expect(output).toContain("镜头 1：84° 经典广角；主体周围环境被清晰建立");
    expect(output).toContain("镜头 2：29° 中近特写；讨喜的面部压缩，自然比例");
    expect(output).not.toContain("镜头检查");
  });
});
