/**
 * 一键镜头模板库（P1.2）
 * 用户选择模板 → 自动创建推荐 Beats、参与角色、状态与必须填写项。
 * "自动分镜"首版基于这些模板 + 已选资产生成；AI 接入后仍输出同一结构。
 */
import type { ProjectV2, SceneV2, ShotV2 } from "../shared-types";

export interface ShotTemplateResult {
  shot: ShotV2;
  /** 必须填写项（UI 提示用户补全） */
  requiredFields: string[];
}

export interface ShotTemplate {
  id: string;
  name: string;
  nameEn: string;
  description: string;
  create(project: ProjectV2, scene: SceneV2): ShotTemplateResult;
}

const newId = () => crypto.randomUUID();

function nextLabel(scene: SceneV2): string {
  return String(scene.shots.length + 1).padStart(2, "0");
}

/** 1. 决心反应三连：3 个 ECU、视线传递、微表情、总时长 4-5s */
const resolveReaction: ShotTemplate = {
  id: "resolve-reaction", name: "决心反应三连", nameEn: "Resolve Reaction Trio",
  description: "3 个 ECU、视线传递、微表情字段、总时长 4-5 秒",
  create: (project, scene) => {
    const firstCharacter = (project.assets ?? []).find((a) => a.kind === "character")?.id;
    const shot: ShotV2 = {
      id: newId(), label: nextLabel(scene), duration: "0-5s", framing: "Extreme close-up", lens: "85mm", movement: "Static",
      participants: firstCharacter ? [{ characterId: firstCharacter, role: "primary", position: "center", entrance: "already-in-frame" }] : [],
      beats: [
        { id: newId(), order: 1, duration: 1.5, actorId: firstCharacter, verb: "pauses", actionText: "eye darts toward the target, decision forming" },
        { id: newId(), order: 2, duration: 1.5, actorId: firstCharacter, verb: "pauses", actionText: "micro-expression shift, resolve hardening" },
        { id: newId(), order: 3, duration: 2, actorId: firstCharacter, verb: "pauses", actionText: "gaze locks, body commits" },
      ],
      time: { startSeconds: 0, endSeconds: 5 },
      cutStyle: "hard-cut",
      action: "Three-beat reaction: eye dart, micro-expression, commit.",
      acting: "Subtle, internal, building resolve.",
      direction: "left-to-right",
    };
    return { shot, requiredFields: ["微表情/表演细节", "视线传递方向", "角色（未选择时需手动添加）"] };
  },
};

/** 2. 群像站位：Wide、站位继承、所有角色可见、道具位置 */
const groupStaging: ShotTemplate = {
  id: "group-staging", name: "群像站位", nameEn: "Group Staging",
  description: "Wide、站位继承、所有角色可见、道具位置",
  create: (project, scene) => {
    const orderList = scene.staging?.characterOrder ?? [];
    const participants = orderList
      .map((characterId): { characterId: string; role: "primary" | "supporting" | "target" | "background" } | null => {
        const asset = (project.assets ?? []).find((a) => a.id === characterId);
        return asset ? { characterId, role: asset.id === orderList[0] ? "primary" : "supporting" } : null;
      })
      .filter((p): p is { characterId: string; role: "primary" | "supporting" | "target" | "background" } => Boolean(p));
    const shot: ShotV2 = {
      id: newId(), label: nextLabel(scene), duration: "0-3s", framing: "Wide", lens: "24mm", movement: "Static",
      participants,
      layout: { useSceneStaging: true },
      beats: [{ id: newId(), order: 1, duration: 3, verb: "pauses", actionText: "full group visible, static hold" }],
      time: { startSeconds: 0, endSeconds: 3 },
      cutStyle: "hard-cut",
      action: "Full group visible in the wide frame.",
      acting: "Still, grounded presence.",
      direction: "left-to-right",
    };
    return { shot, requiredFields: ["场景左到右排序（未配置时）", "道具位置", "空间锚点"] };
  },
};

/** 3. 道具触发：手部 CU → 装置 CU → 结果镜头；状态前后变化强制填写 */
const propTrigger: ShotTemplate = {
  id: "prop-trigger", name: "道具触发", nameEn: "Prop Trigger",
  description: "手部 CU → 装置 CU → 结果镜头；状态前后变化强制填写",
  create: (project, scene) => {
    const firstCharacter = (project.assets ?? []).find((a) => a.kind === "character")?.id;
    const firstProp = (project.assets ?? []).find((a) => a.kind === "prop")?.id;
    const shot: ShotV2 = {
      id: newId(), label: nextLabel(scene), duration: "0-6s", framing: "Close-up", lens: "50mm", movement: "Static",
      participants: firstCharacter ? [{ characterId: firstCharacter, role: "primary", position: "center", entrance: "already-in-frame" }] : [],
      beats: [
        { id: newId(), order: 1, duration: 1.5, actorId: firstCharacter, verb: "grabs", targetPropId: firstProp, targetBodyPart: "hand close-up" },
        { id: newId(), order: 2, duration: 1.5, actorId: firstCharacter, verb: "presses", targetPropId: firstProp, targetBodyPart: "trigger" },
        { id: newId(), order: 3, duration: 3, actorId: firstCharacter, verb: "watches", actionText: "the result unfolds" },
      ],
      time: { startSeconds: 0, endSeconds: 6 },
      cutStyle: "match-cut",
      action: "Hand close-up triggers the device; result unfolds.",
      acting: "Deliberate, careful hands.",
      direction: "left-to-right",
    };
    return { shot, requiredFields: ["目标道具", "前置状态 → 后置状态", "结果镜头内容"] };
  },
};

/** 4. 救援动作链：接触/反应/释放/结果 4 Beats；攻击目标与禁止目标强制填写 */
const rescueChain: ShotTemplate = {
  id: "rescue-chain", name: "救援动作链", nameEn: "Rescue Action Chain",
  description: "接触/反应/释放/结果 4 Beats；攻击目标与禁止目标强制填写",
  create: (project, scene) => {
    const characters = (project.assets ?? []).filter((a) => a.kind === "character");
    const attacker = characters[0]?.id;
    const victim = characters[1]?.id;
    const shot: ShotV2 = {
      id: newId(), label: nextLabel(scene), duration: "0-8s", framing: "Medium", lens: "35mm", movement: "Handheld",
      participants: [attacker, victim].filter(Boolean).map((characterId) => ({ characterId: characterId!, role: "primary" as const, entrance: "already-in-frame" as const })),
      beats: [
        { id: newId(), order: 1, duration: 2, actorId: attacker, verb: "grabs", targetCharacterId: victim, targetBodyPart: "collar", required: true, forbiddenTargets: [] },
        { id: newId(), order: 2, duration: 2, actorId: victim, verb: "recoils", targetCharacterId: attacker, actionText: "struggles against the grip" },
        { id: newId(), order: 3, duration: 2, actorId: victim, verb: "breaks free", actionText: "slips free and stumbles back" },
        { id: newId(), order: 4, duration: 2, verb: "pauses", actionText: "both sides reset, outcome held" },
      ],
      time: { startSeconds: 0, endSeconds: 8 },
      cutStyle: "hard-cut",
      action: "Contact, recoil, break-free, reset.",
      acting: "Urgent, physical, precise.",
      direction: "left-to-right",
    };
    return { shot, requiredFields: ["攻击目标（未选角色时）", "禁止目标", "释放前后状态（gripped → freed）"] };
  },
};

/** 5. 爆破冲入：引爆 → 门变化 → 烟尘 → 广角进入；物理风险自动拉高 */
const blastEnter: ShotTemplate = {
  id: "blast-enter", name: "爆破冲入", nameEn: "Blast & Enter",
  description: "引爆 → 门变化 → 烟尘 → 广角进入；物理风险自动拉高",
  create: (project, scene) => {
    const firstCharacter = (project.assets ?? []).find((a) => a.kind === "character")?.id;
    const firstProp = (project.assets ?? []).find((a) => a.kind === "prop")?.id;
    const location = scene.staging?.locationAssetId ?? (project.assets ?? []).find((a) => a.kind === "location")?.id;
    const shot: ShotV2 = {
      id: newId(), label: nextLabel(scene), duration: "0-10s", framing: "Wide", lens: "24mm", movement: "Dolly",
      participants: firstCharacter ? [{ characterId: firstCharacter, role: "primary", position: "center", entrance: "enters-left" }] : [],
      propStatesAtStart: firstProp ? [{ propId: firstProp, state: "armed" }] : [],
      beats: [
        { id: newId(), order: 1, duration: 1.5, actorId: firstCharacter, verb: "presses", targetPropId: firstProp, targetBodyPart: "detonator", required: true, stateBefore: firstProp ? [{ propId: firstProp, state: "armed" }] : [], stateAfter: firstProp ? [{ propId: firstProp, state: "pressed" }] : [] },
        { id: newId(), order: 2, duration: 2.5, verb: "watches", targetPropId: location, actionText: "the doors blow open inward with a muffled boom", required: true, stateAfter: location ? [{ propId: location, state: "blown-open" }] : [] },
        { id: newId(), order: 3, duration: 3, verb: "pauses", actionText: "smoke and debris roll out through the doorway" },
        { id: newId(), order: 4, duration: 3, actorId: firstCharacter, verb: "enters", targetPropId: location, actionText: "bursts through the smoke into the wide frame", cutRule: "cut exactly as the first figure crosses the threshold" },
      ],
      time: { startSeconds: 0, endSeconds: 10 },
      cutStyle: "match-cut",
      action: "Detonate, doors blow, smoke rolls, burst through.",
      acting: "Decisive, urgent, unstoppable.",
      direction: "left-to-right",
    };
    return { shot, requiredFields: ["引爆道具（未选择道具时）", "门/地点状态链（closed → blown-open）", "烟尘与碎屑物理"] };
  },
};

export const SHOT_TEMPLATES: ShotTemplate[] = [resolveReaction, groupStaging, propTrigger, rescueChain, blastEnter];

export function shotTemplateById(id: string): ShotTemplate | undefined {
  return SHOT_TEMPLATES.find((template) => template.id === id);
}
