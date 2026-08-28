/**
 * AI 辅助层（P3）
 * 规则：AI 只生成「结构化建议」，用户确认后才写资产/状态；禁止直接返回大段 Prompt。
 * compilePrompt 始终本地执行。
 */
import type { AssetKind, ContinuityIssueV2, ProjectV2, SceneV2, ShotV2 } from "../../shared-types";
import { SHOT_TEMPLATES } from "../shot-templates";

/** 参考图分析建议（写资产前需用户确认） */
export interface AssetSuggestion {
  name: string;
  description: string;
  descriptionZh?: string;
  useFor: string[];
  uniqueMarkers: string[];
  lockLevel: "none" | "soft" | "strict";
}

/** 场景生成建议（Scene + 资产清单 + 站位 + 镜头模板） */
export interface SceneSuggestion {
  name: string;
  logline: string;
  emotionArc?: string;
  locationHint: string;
  characterOrder: string[];
  shotTemplateIds: string[];
}

/** Beat 生成建议（必须返回 schema，禁止大段 Prompt） */
export interface BeatSuggestion {
  order: number;
  verb: string;
  actorId?: string;
  targetCharacterId?: string;
  targetPropId?: string;
  targetBodyPart?: string;
  actionText?: string;
  required?: boolean;
  forbiddenTargets: string[];
  stateBefore?: { propId: string; state: string }[];
  stateAfter?: { propId: string; state: string }[];
}

/** 连续性修复建议（结构化） */
export interface FixSuggestion {
  code: string;
  label: string;
  detail: string;
  /** 修复动作描述（UI 展示；真正执行走本地 fixIssue） */
  apply: string;
}

export interface AIAssistant {
  analyzeReferenceImage(input: { assetKind: AssetKind; name?: string; imageHint?: string }): Promise<AssetSuggestion>;
  generateStructuredScene(input: { logline: string; assets: { id: string; name: string; kind: AssetKind }[]; shotCount: number }): Promise<SceneSuggestion>;
  generateBeats(input: { logline: string; scene: SceneV2; participants: string[]; props: string[] }): Promise<BeatSuggestion[]>;
  repairContinuity(input: { issue: ContinuityIssueV2; project: ProjectV2; scene: SceneV2; shot?: ShotV2 }): Promise<FixSuggestion>;
  /** 审核详情内的一键修复：生成可预览、用户确认后再写入的短文本（表演/首帧/声音锁/重分镜意图）。 */
  generateAuditRepairText(input: {
    code: string;
    locale: "zh" | "en";
    generateFor: "acting" | "first-frame" | "voice" | "beats" | "replan";
    scene: SceneV2;
    shot?: ShotV2;
    characterName?: string;
    issueSummary: string;
  }): Promise<{ text: string }>;
}

const USE_FOR_BY_KIND: Record<AssetKind, string[]> = {
  character: ["face", "body", "wardrobe"],
  location: ["environment"],
  prop: ["prop"],
  "style-reference": ["appearance"],
  "audio-reference": ["appearance"],
};

/** 本地建议 Provider：无 API Key 时的确定性模板建议（可测试、可演示） */
export class LocalSuggestionProvider implements AIAssistant {
  async analyzeReferenceImage(input: { assetKind: AssetKind; name?: string; imageHint?: string }): Promise<AssetSuggestion> {
    const kindLabel = { character: "character", location: "location", prop: "prop", "style-reference": "style reference", "audio-reference": "audio reference" }[input.assetKind];
    const name = input.name?.trim() || (kindLabel === "character" ? "UNNAMED CHARACTER" : kindLabel === "location" ? "UNNAMED LOCATION" : kindLabel === "prop" ? "UNNAMED PROP" : "REFERENCE");
    const hint = input.imageHint?.trim() ? `, ${input.imageHint.trim()}` : "";
    return {
      name,
      description: `Canonical reference of ${name.toLowerCase()} (${kindLabel})${hint}. Use as the identity source for this ${kindLabel}.`,
      descriptionZh: `${name}（${kindLabel === "character" ? "角色" : kindLabel === "location" ? "地点" : kindLabel === "prop" ? "道具" : "参考"}）的基准参考${hint ? `，${input.imageHint}` : ""}。`,
      useFor: USE_FOR_BY_KIND[input.assetKind],
      uniqueMarkers: [],
      lockLevel: input.assetKind === "character" ? "strict" : "soft",
    };
  }

  async generateStructuredScene(input: { logline: string; assets: { id: string; name: string; kind: AssetKind }[]; shotCount: number }): Promise<SceneSuggestion> {
    const characters = input.assets.filter((a) => a.kind === "character");
    const locations = input.assets.filter((a) => a.kind === "location");
    const logline = input.logline.trim() || "An unscripted scene unfolds.";
    const low = logline.toLowerCase();
    // 关键词 → 镜头模板序列（自动分镜建议）
    let shotTemplateIds: string[] = ["resolve-reaction", "group-staging"];
    if (/(爆炸|爆破|引爆|detonat|blast|explos)/i.test(low)) shotTemplateIds = ["prop-trigger", "blast-enter", "resolve-reaction"];
    else if (/(救援|挣脱|救|rescue|free|break)/i.test(low)) shotTemplateIds = ["rescue-chain", "group-staging", "resolve-reaction"];
    else if (/(追逐|追|chase|run)/i.test(low)) shotTemplateIds = ["resolve-reaction", "prop-trigger", "blast-enter"];
    // 按目标镜头数裁剪/补全
    while (shotTemplateIds.length < Math.max(1, input.shotCount)) shotTemplateIds.push(SHOT_TEMPLATES[(shotTemplateIds.length - 1) % SHOT_TEMPLATES.length].id);
    shotTemplateIds = shotTemplateIds.slice(0, Math.max(1, input.shotCount));
    return {
      name: (locations[0]?.name ?? "UNTITLED LOCATION").replace(/( INTERIOR| EXTERIOR)$/i, ""),
      logline,
      emotionArc: "Tension builds, then release.",
      locationHint: locations[0]?.name ?? "An unspecified practical location matching the logline.",
      characterOrder: characters.map((c) => c.id),
      shotTemplateIds,
    };
  }

  async generateBeats(input: { logline: string; scene: SceneV2; participants: string[]; props: string[] }): Promise<BeatSuggestion[]> {
    const [actor, target] = input.participants;
    const prop = input.props[0];
    const low = input.logline.toLowerCase();
    const beats: BeatSuggestion[] = [];
    if (/(爆炸|爆破|引爆|detonat|blast|explos)/i.test(low) && prop) {
      beats.push({ order: 1, verb: "presses", actorId: actor, targetPropId: prop, targetBodyPart: "detonator", required: true, forbiddenTargets: [], stateBefore: [{ propId: prop, state: "armed" }], stateAfter: [{ propId: prop, state: "pressed" }] });
      beats.push({ order: 2, verb: "watches", actorId: actor, actionText: "the doors blow open; smoke and debris roll out", required: true, forbiddenTargets: [] });
      beats.push({ order: 3, verb: "enters", actorId: actor, actionText: "bursts through the smoke into the wide frame", forbiddenTargets: [] });
    } else if (/(救援|挣脱|救|rescue|free|break)/i.test(low) && target) {
      beats.push({ order: 1, verb: "grabs", actorId: actor, targetCharacterId: target, targetBodyPart: "collar", required: true, forbiddenTargets: [] });
      beats.push({ order: 2, verb: "recoils", actorId: target, actionText: "struggles against the grip", forbiddenTargets: [] });
      beats.push({ order: 3, verb: "breaks free", actorId: target, actionText: "slips free and stumbles back", forbiddenTargets: [] });
    } else {
      beats.push({ order: 1, verb: "pauses", actorId: actor, actionText: "observes the situation", forbiddenTargets: [] });
      beats.push({ order: 2, verb: "pauses", actionText: "the moment holds, tension builds", forbiddenTargets: [] });
      beats.push({ order: 3, verb: "pauses", actionText: "the scene resolves", forbiddenTargets: [] });
    }
    return beats.map((beat, index) => ({ ...beat, order: index + 1 }));
  }

  async repairContinuity(input: { issue: ContinuityIssueV2; project: ProjectV2; scene: SceneV2; shot?: ShotV2 }): Promise<FixSuggestion> {
    const { issue, shot } = input;
    const fixes: Record<string, { label: string; detail: string; apply: string }> = {
      "SCENE.ENVIRONMENT_UNLOCKED": { label: "Environment lock", detail: "Enable the environment lock so the model keeps the location stable.", apply: "Set scene.environmentLock = true." },
      "SCENE.WEATHER_MISSING": { label: "Weather", detail: "Declare weather for the scene (e.g. Overcast, Night rain).", apply: "Fill scene.weather before export." },
      "TECHNICAL.NEGATIVE_EMPTY": { label: "Negative prompt", detail: "A default negative prompt constrains drift terms.", apply: "Use the built-in default negative prompt." },
      "AUDIO.PLAN_MISSING": { label: "Audio plan", detail: "A minimal audio plan makes the sound design explicit.", apply: "Create a default audio plan (score none, subtitles off)." },
      "SPATIAL.AXIS_CONFLICT": { label: "Axis conflict", detail: "Screen direction reverses across the 180° line.", apply: "Mark the shot as an intentional axis break, or flip the direction." },
      "CAUSALITY.TARGET_MISSING": { label: "Attack target", detail: "Attack beats must declare a target character or prop.", apply: "Set beat.targetCharacterId or beat.targetPropId." },
    };
    const known = fixes[issue.code];
    if (known) {
      return { code: issue.code, label: known.label, detail: known.detail, apply: known.apply };
    }
    return {
      code: issue.code,
      label: issue.label,
      detail: `Review this ${issue.severity}-level issue in ${shot?.label ?? input.scene.name}.`,
      apply: "Manually resolve the conflicting fields before export.",
    };
  }

  async generateAuditRepairText(input: { code: string; locale: "zh" | "en"; generateFor: "acting" | "first-frame" | "voice" | "beats" | "replan"; scene: SceneV2; shot?: ShotV2; characterName?: string; issueSummary: string }): Promise<{ text: string }> {
    const shotLabel = input.shot?.label ?? input.scene.name;
    const participantNames = input.scene.shots?.find((item) => item.id === input.shot?.id)?.participants?.length
      ? `${input.scene.shots.find((item) => item.id === input.shot?.id)!.participants!.length} 位参与角色`
      : "场景内的参与角色";
    if (input.generateFor === "acting") {
      return {
        text: input.locale === "zh"
          ? `深吸一口气，目光先在远处落定两拍，再向下扫向双手：指尖微微收紧，肩膀随呼吸下沉，最后抬眼看向对手，完成一个可见的眼神转折。`
          : `${shotLabel}: inhale; the gaze lands on the distance for two beats, drops to the hands as the fingers tighten, the shoulders settle with the breath, then the eyes lift to the partner — one visible turning point.`,
      };
    }
    if (input.generateFor === "first-frame") {
      return {
        text: input.locale === "zh"
          ? `首帧锁定：${participantNames}占据画面主体位置，先完成视线建立，再开始摄影机运动；首帧不得出现未引用的资产。`
          : `First-frame lock: the scene's participants occupy the visual center, establish eyeline, then the camera moves; no unreferenced asset appears on the first frame.`,
      };
    }
    if (input.generateFor === "voice") {
      const name = input.characterName ?? "该角色";
      return {
        text: input.locale === "zh"
          ? `${name}：低沉、克制、略带磁性的男中音；句尾干净利落，重音放在关键词上，紧张时音量微降、语速不变。`
          : `${name}: low, restrained baritone; clean line endings, emphasis on key words, volume drops slightly under pressure without changing pace.`,
      };
    }
    if (input.generateFor === "replan") {
      return {
        text: input.locale === "zh"
          ? "重新分镜：按剧情节奏压缩为更少的镜头，总时长不超过场景上限；慢节奏场景减少镜头数量，快节奏场景保留推进感。"
          : "Re-plan: fewer shots when the pacing is slow and more momentum when it is fast; the total must stay within the scene limit.",
      };
    }
    return {
      text: input.locale === "zh"
        ? `节拍：${shotLabel} 中，角色先完成一次可见的停顿与呼吸，再继续动作。`
        : `Beat: in ${shotLabel}, the character holds a visible pause with breath before the next action.`,
    };
  }
}

/** 获取 AI Provider：有 Key 时用远程（未实现，占位），否则本地建议 */
export function getAssistant(): AIAssistant {
  return new LocalSuggestionProvider();
}
