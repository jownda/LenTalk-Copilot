import { describe, expect, it } from "vitest";

import type { Asset, ProjectV2, SceneV2, ShotV2 } from "../../shared-types";
import { validateDirectorLayers } from "./validateDirectorLayers";

// ─────────────────────────────────────────────────────────────
// 共享 fixture：中英两组资产 + 场景（V2-P2-1 要求 zh/en 各一组）
// ─────────────────────────────────────────────────────────────
const ZH_ASSETS: Asset[] = [
  {
    id: "lin", kind: "character", name: "林警官",
    description: "middle-aged East Asian man, stocky build", descriptionZh: "中年东亚男性，敦实身材",
    referencePaths: [], useFor: ["face", "body", "wardrobe"], ignore: ["pose", "background", "lighting"],
    lockLevel: "strict", tags: [],
    uniqueMarkers: ["宽厚方脸"], alwaysVisible: ["深蓝西装", "白衬衫"],
  },
  {
    id: "ajun", kind: "character", name: "阿俊",
    description: "young man with black dreadlocks", descriptionZh: "年轻男性，黑色脏辫",
    referencePaths: [], lockLevel: "soft", tags: [],
  },
  {
    id: "subway", kind: "location", name: "无尽地铁车厢",
    description: "bright modern white subway carriage", descriptionZh: "明亮现代白色地铁车厢",
    referencePaths: [], lockLevel: "none", tags: [],
  },
  {
    id: "cigarette", kind: "prop", name: "烟头",
    description: "cigarette butt on the floor", descriptionZh: "地上散落的烟头",
    referencePaths: [], lockLevel: "none", tags: [],
  },
];

const EN_ASSETS: Asset[] = [
  {
    id: "hero", kind: "character", name: "LIN",
    description: "middle-aged East Asian man, broad square face, slicked-back black hair",
    referencePaths: [], useFor: ["face", "body", "wardrobe"], ignore: ["pose", "background"],
    lockLevel: "strict", tags: [],
  },
  {
    id: "jax", kind: "character", name: "JAXX",
    description: "young man, black dreadlocks, round glasses",
    referencePaths: [], lockLevel: "soft", tags: [],
  },
  {
    id: "cafe", kind: "location", name: "CAFE INTERIOR",
    description: "dimly lit cafe with red booths",
    referencePaths: [], lockLevel: "none", tags: [],
  },
];

function makeShot(characterId: string, propIds: string[] = []): ShotV2 {
  return {
    id: "sh-1", label: "镜头 1", duration: "15秒", framing: "全景", lens: "24mm",
    movement: "Steadicam", action: "快步走", acting: "克制克制", direction: "left-to-right",
    characterId,
    participants: [{ characterId, role: "primary", position: "center" }],
    beats: [{ id: "beat-1", order: 1, verb: "wait", actorId: characterId, actionText: "保持坐姿" }],
    propStatesAtStart: propIds.map((propId) => ({ propId, state: "on-ground", position: "地面" })),
  };
}

function makeScene(
  layers: Record<string, string>,
  options: { shootingMode?: SceneV2["shootingMode"]; locationAssetId?: string; characterId?: string } = {},
): SceneV2 {
  return {
    id: "sc-1", name: "无尽车厢", logline: "", location: "地铁车厢", time: "夜晚",
    weather: "暴雨", duration: "15秒", palette: "", lighting: "", environmentLock: true,
    staging: {
      locationAssetId: options.locationAssetId ?? "subway",
      characterOrder: [options.characterId ?? "lin"],
    },
    shootingMode: options.shootingMode,
    directorLayers: { ...layers },
    shots: [makeShot(options.characterId ?? "lin", ["cigarette"])],
  };
}

function makeProject(assets: Asset[], scene: SceneV2): ProjectV2 {
  return {
    id: "p-1", title: "测试项目", description: "", preset: "custom",
    assets, identityRules: [], scenes: [scene], characters: [],
  } as ProjectV2;
}

const cleanZhLayers: Record<string, string> = {
  sceneContext: "林警官独自坐在高速行驶的无尽地铁车厢中央。",
  activeReferences: "@林警官 — 中年东亚男性，敦实方脸，后梳黑发，浓眉，无胡须，深蓝西装白衬衫。@无尽地铁车厢 — 明亮现代白色车厢。",
  locationMap: "镜头位于车厢中央过道偏低位置；前景地面散落烟头。",
  firstFrame: "林警官坐在画面中央偏下，面部朝向镜头。",
  formatMode: "SINGLE CONTINUOUS TAKE",
  optics: "84° 标准视场，广角纵深透视，近大远小，前后景深度拉开。",
  camera: "低角度呼吸式手持，围绕面部做极小幅度修正。",
  actionTiming: "0:00–0:15：林警官坐在地板中央，烟夹在嘴边，车厢高速运行。",
  physics: "坐姿重量真实压在地板，背部与扶手有接触阴影，香烟固定在手指之间。",
  lighting: "主光为车厢顶部冷白灯，沿车厢纵深延伸。",
  audio: "无配乐，仅保留高速列车低频运行声。",
  positiveConstraints: "全段只使用现有角色资产；林警官始终保持中年东亚男性、敦实方脸、后梳黑发、深蓝西装白衬衫。",
  negativeLocks: "禁止身份漂移、服装和发型漂移、额外肢体、漂浮或瞬移运动。",
};

describe("validateDirectorLayers（中文 fixture）", () => {
  it("干净样例：无任何 issue", () => {
    const project = makeProject(ZH_ASSETS, makeScene(cleanZhLayers));
    expect(validateDirectorLayers(cleanZhLayers, project, project.scenes[0])).toEqual([]);
  });

  it("检查器字段缺失 → warning，但不升级为 error", () => {
    const scene = makeScene(cleanZhLayers);
    scene.shots[0] = { ...scene.shots[0], beats: [], acting: "" };
    const issues = validateDirectorLayers(cleanZhLayers, makeProject(ZH_ASSETS, scene), scene);
    const hit = issues.find((issue) => issue.code === "DIRECTOR.INSPECTOR_COVERAGE");
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe("warning");
    expect(hit?.detailZh).toContain("节拍");
  });

  it("首帧把后续入画角色提前写入 → error", () => {
    const scene = makeScene(cleanZhLayers, { shootingMode: "multi-shot" });
    scene.shots = [
      makeShot("lin"),
      { ...makeShot("ajun"), id: "sh-2", label: "镜头 2", participants: [{ characterId: "ajun", role: "primary", position: "screen-right", entrance: "enters-left" }] },
    ];
    const layers = {
      ...cleanZhLayers,
      firstFrame: "第1段首帧：林警官在画面中央。\n第2段首帧：阿俊已经在画面右侧。",
    };
    const issues = validateDirectorLayers(layers, makeProject(ZH_ASSETS, scene), scene);
    expect(issues.map((issue) => issue.code)).toContain("DIRECTOR.FIRST_FRAME_PARTICIPANT_CONFLICT");
  });

  it("场景地图的镜头级位置与结构化参与者冲突 → error", () => {
    const scene = makeScene(cleanZhLayers);
    scene.shots[0] = { ...scene.shots[0], participants: [{ characterId: "lin", role: "primary", position: "screen-right" }] };
    const layers = { ...cleanZhLayers, locationMap: "镜头1：林警官位于画面左侧。" };
    const issues = validateDirectorLayers(layers, makeProject(ZH_ASSETS, scene), scene);
    const hit = issues.find((issue) => issue.code === "DIRECTOR.LOCATION_MAP_POSITION_CONFLICT");
    expect(hit?.severity).toBe("error");
    expect(hit?.detailZh).toContain("结构化镜头");
  });

  it("多镜头声明 + 单一连续时间轴 → error", () => {
    const layers = {
      ...cleanZhLayers,
      formatMode: "CONTROLLED MULTI-SHOT SEQUENCE",
      actionTiming: "0:00–0:05：林警官坐在地板中央；0:05–0:11：他的眼神向内收；0:11–0:17：他看向镜头附近。",
    };
    const scene = makeScene(layers, { shootingMode: "multi-shot" });
    const issues = validateDirectorLayers(layers, makeProject(ZH_ASSETS, scene), scene);
    expect(issues.map((i) => i.code)).toContain("DIRECTOR.MULTI_SHOT_TIMELINE");
    expect(issues.find((i) => i.code === "DIRECTOR.MULTI_SHOT_TIMELINE")?.severity).toBe("error");
  });

  it("正文提到未引用资产 → error", () => {
    const layers = { ...cleanZhLayers, sceneContext: "阿俊坐在车厢角落，手里握着打火机。" };
    const project = makeProject(ZH_ASSETS, makeScene(layers));
    const issues = validateDirectorLayers(layers, project, project.scenes[0]);
    expect(issues.map((i) => i.code)).toContain("DIRECTOR.UNREFERENCED_ASSET");
  });

  it("项目管理语句（启用/未启用）→ error", () => {
    const layers = { ...cleanZhLayers, activeReferences: "启用资产：@林警官、@无尽地铁车厢。未启用：阿俊。" };
    const project = makeProject(ZH_ASSETS, makeScene(layers));
    const issues = validateDirectorLayers(layers, project, project.scenes[0]);
    expect(issues.map((i) => i.code)).toContain("DIRECTOR.META_STATEMENT");
  });

  it("诊断摘要（连续性结论）→ error", () => {
    const layers = { ...cleanZhLayers, sceneContext: "连续性：共 3 个问题（0 个错误，3 个警告）。最终导出前请解决。" };
    const project = makeProject(ZH_ASSETS, makeScene(layers));
    const issues = validateDirectorLayers(layers, project, project.scenes[0]);
    expect(issues.map((i) => i.code)).toContain("DIRECTOR.DIAGNOSTIC_META");
  });

  it("84° 广角 + 压缩感 → error", () => {
    const layers = { ...cleanZhLayers, optics: "采用84度广角，背景压缩感强烈。" };
    const project = makeProject(ZH_ASSETS, makeScene(layers));
    const issues = validateDirectorLayers(layers, project, project.scenes[0]);
    expect(issues.map((i) => i.code)).toContain("DIRECTOR.OPTICS_WIDE_COMPRESSION");
  });

  it("29° 长焦 + 近大远小拉伸 → error", () => {
    const layers = { ...cleanZhLayers, optics: "29°长焦拍摄，近大远小拉伸明显。" };
    const project = makeProject(ZH_ASSETS, makeScene(layers));
    const issues = validateDirectorLayers(layers, project, project.scenes[0]);
    expect(issues.map((i) => i.code)).toContain("DIRECTOR.OPTICS_TELE_STRETCH");
  });

  it("首帧禁新道具 + 具体道具并存 → warning", () => {
    const layers = {
      ...cleanZhLayers,
      firstFrame: "首帧不得加入新道具，不得加入其他人物。",
      locationMap: "前景地面散落烟头，车厢中轴线的纵深结构保持完整。",
    };
    const project = makeProject(ZH_ASSETS, makeScene(layers));
    const issues = validateDirectorLayers(layers, project, project.scenes[0]);
    const hit = issues.find((i) => i.code === "DIRECTOR.NO_NEW_PROPS_CONFLICT");
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe("warning");
    expect(hit?.detailZh).toContain("烟头");
  });

  it("严格锁定角色身份描述在引用层之外重复 → warning", () => {
    const layers = {
      ...cleanZhLayers,
      optics: "林警官的敦实方脸贴近画面，后梳黑发细节清晰。",
    };
    const project = makeProject(ZH_ASSETS, makeScene(layers));
    const issues = validateDirectorLayers(layers, project, project.scenes[0]);
    const hit = issues.find((i) => i.code === "DIRECTOR.IDENTITY_ANCHOR_DUP");
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe("warning");
    expect(hit?.detailZh).toContain("林警官");
  });
});

// ─────────────────────────────────────────────────────────────
// 英文 fixture：校验器必须同时覆盖 en 词表
// ─────────────────────────────────────────────────────────────
const cleanEnLayers: Record<string, string> = {
  sceneContext: "LIN sits alone in the center of the endless subway carriage.",
  activeReferences: "@LIN — middle-aged East Asian man, broad square face, slicked-back black hair, dark navy suit, white shirt. @CAFE INTERIOR — dimly lit cafe.",
  locationMap: "Camera sits low in the central aisle; the cafe booth and red door are visible behind.",
  firstFrame: "LIN sits center frame, face toward camera.",
  formatMode: "SINGLE CONTINUOUS TAKE",
  optics: "84° standard FOV, wide-angle depth with near-large far-small perspective.",
  camera: "Low breathing handheld with minimal corrections.",
  actionTiming: "0:00–0:15: LIN sits on the floor, cigarette near his mouth, train running.",
  physics: "Seated weight grounded on the floor, back and armrest contact shadow, cigarette fixed between fingers.",
  lighting: "Cool white top light from the carriage ceiling.",
  audio: "No score, only low-frequency train rumble.",
  positiveConstraints: "Only existing assets; LIN keeps broad square face, slicked-back black hair, dark navy suit, white shirt.",
  negativeLocks: "No identity drift, no wardrobe drift, no floating motion.",
};

describe("validateDirectorLayers（英文 fixture）", () => {
  function enScene(layers: Record<string, string>): SceneV2 {
    return {
      id: "sc-en", name: "Endless Carriage", logline: "", location: "Subway", time: "Night",
      weather: "Storm", duration: "15s", palette: "", lighting: "", environmentLock: true,
      staging: { locationAssetId: "cafe", characterOrder: ["hero"] },
      directorLayers: { ...layers },
      shots: [{
        id: "sh-en", label: "Shot 1", duration: "15s", framing: "Wide", lens: "24mm",
        movement: "Steadicam", action: "Walks fast", acting: "Restrained", direction: "left-to-right",
        characterId: "hero",
        participants: [{ characterId: "hero", role: "primary", position: "center" }],
        beats: [{ id: "beat-en-1", order: 1, verb: "wait", actorId: "hero", actionText: "holds position" }],
      }],
    };
  }

  it("干净英文样例：无任何 issue", () => {
    const scene = enScene(cleanEnLayers);
    expect(validateDirectorLayers(cleanEnLayers, makeProject(EN_ASSETS, scene), scene)).toEqual([]);
  });

  it("元数据 / 诊断摘要（英文）→ error", () => {
    const layers = {
      ...cleanEnLayers,
      sceneContext: "Enabled assets: @LIN, @CAFE INTERIOR. Continuity: 5 issues total (0 errors, 4 warnings). Resolve error-level issues before final export.",
    };
    const scene = enScene(layers);
    const issues = validateDirectorLayers(layers, makeProject(EN_ASSETS, scene), scene);
    const codes = issues.map((i) => i.code);
    expect(codes).toContain("DIRECTOR.META_STATEMENT");
    expect(codes).toContain("DIRECTOR.DIAGNOSTIC_META");
  });

  it("84° wide + compression（英文）→ error", () => {
    const layers = { ...cleanEnLayers, optics: "84° wide angle with strong background compression." };
    const scene = enScene(layers);
    const issues = validateDirectorLayers(layers, makeProject(EN_ASSETS, scene), scene);
    expect(issues.map((i) => i.code)).toContain("DIRECTOR.OPTICS_WIDE_COMPRESSION");
  });

  it("未引用资产（英文）→ error", () => {
    const layers = { ...cleanEnLayers, sceneContext: "JAXX stands near the booth with a lighter." };
    const scene = enScene(layers);
    const issues = validateDirectorLayers(layers, makeProject(EN_ASSETS, scene), scene);
    expect(issues.map((i) => i.code)).toContain("DIRECTOR.UNREFERENCED_ASSET");
  });
});
