/**
 * AI 辅助层（P3）
 * 规则：AI 只生成「结构化建议」，用户确认后才写资产/状态；禁止直接返回大段 Prompt。
 * compilePrompt 始终本地执行。
 */
import type { AssetKind, ProjectV2, SceneV2, ShotV2 } from "../../shared-types";
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
  /** 受限的候选修改；缺省表示只能给出建议，不能自动写回。 */
  patch?: ContinuityRepairPatch;
}

export interface ContinuityRepairIssue {
  code: string;
  severity: "error" | "warning" | "info";
  label: string;
  detail: string;
  detailZh?: string;
  entityId?: string;
  shotId?: string;
  layerKey?: string;
}

/** AI 修复允许返回的最小补丁，不允许整场重写。 */
export interface ContinuityRepairPatch {
  sceneUpdates?: {
    environmentLock?: boolean;
    weather?: string;
    negativePrompt?: string;
    audioPlan?: {
      diegeticMusic?: string[];
      sfx?: string[];
      score?: "none" | "original-score";
      subtitles?: boolean;
    };
  };
  shotUpdates?: Array<{
    shotId: string;
    participantUpdates?: Array<{
      characterId: string;
      position?: string;
      entrance?: "already-in-frame" | "enters-left" | "enters-right";
      facing?: string;
      eyeline?: string;
    }>;
    characterOrder?: string[];
    intentionalAxisBreak?: boolean;
    direction?: "left-to-right" | "right-to-left";
  }>;
  beatUpdates?: Array<{
    shotId: string;
    beatId: string;
    targetCharacterId?: string;
    targetPropId?: string;
  }>;
  directorLayerUpdates?: Array<{
    layerKey: "firstFrame" | "locationMap";
    text: string;
  }>;
}

export interface AIAssistant {
  analyzeReferenceImage(input: { assetKind: AssetKind; name?: string; imageHint?: string }): Promise<AssetSuggestion>;
  generateStructuredScene(input: { logline: string; assets: { id: string; name: string; kind: AssetKind }[]; shotCount: number }): Promise<SceneSuggestion>;
  generateBeats(input: { logline: string; scene: SceneV2; participants: string[]; props: string[] }): Promise<BeatSuggestion[]>;
  repairContinuity(input: { issue: ContinuityRepairIssue; project: ProjectV2; scene: SceneV2; shot?: ShotV2 }): Promise<FixSuggestion>;
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

function replaceFirstFrameBlock(text: string, shotIndex: number, transform: (block: string) => string): string {
  const lines = text.split("\n");
  const starts = lines.map((line, index) => ({ line, index })).filter(({ line }) => /(?:第\s*)?\d+\s*(?:段|镜头|shot)\s*(?:首帧|first\s*frame)?/i.test(line));
  if (starts.length === 0) return transform(text);
  const start = starts[shotIndex]?.index;
  if (start === undefined) return text;
  const end = starts.find(({ index }) => index > start)?.index ?? lines.length;
  lines.splice(start, end - start, transform(lines.slice(start, end).join("\n")));
  return lines.join("\n");
}

function localDirectorPatch(input: { issue: ContinuityRepairIssue; project: ProjectV2; scene: SceneV2 }): ContinuityRepairPatch | undefined {
  const { issue, scene } = input;
  const shotIndex = scene.shots.findIndex((shot) => shot.id === issue.shotId);
  const shot = shotIndex >= 0 ? scene.shots[shotIndex] : undefined;
  if (!shot || !issue.layerKey) return undefined;
  const asset = (input.project.assets ?? []).find((candidate) => issue.detail.includes(candidate.name) && candidate.kind === "character");
  if (!asset) return undefined;
  if (issue.code === "DIRECTOR.FIRST_FRAME_PARTICIPANT_CONFLICT") {
    // 首帧与场景地图已合并为 locationMap 层；首帧块位于该文本的首帧行。
    const current = scene.directorLayers?.locationMap ?? "";
    const text = replaceFirstFrameBlock(current, shotIndex, (block) => {
      const keptLines = block.split("\n").flatMap((line, index) => {
        if (!line.includes(asset.name)) return [line];
        if (index === 0) return [line.split(asset.name).join("").replace(/[：:]\s*$/, "：").trim()];
        return [];
      });
      return keptLines.length > 0 ? keptLines.join("\n") : `第 ${shotIndex + 1} 段首帧：该角色不在第一可见画面中。`;
    });
    return { directorLayerUpdates: [{ layerKey: "locationMap", text }] };
  }
  if (issue.code === "DIRECTOR.LOCATION_MAP_POSITION_CONFLICT") {
    const participant = shot.participants?.find((candidate) => candidate.characterId === asset.id);
    if (!participant?.position?.trim()) return undefined;
    const current = scene.directorLayers?.locationMap ?? "";
    const text = replaceFirstFrameBlock(current, shotIndex, (block) => block.split("\n").map((line) => line.includes(asset.name) ? `第 ${shotIndex + 1} 段：${asset.name} 位于${participant.position}。` : line).join("\n"));
    return { directorLayerUpdates: [{ layerKey: "locationMap", text }] };
  }
  return undefined;
}

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

  async repairContinuity(input: { issue: ContinuityRepairIssue; project: ProjectV2; scene: SceneV2; shot?: ShotV2 }): Promise<FixSuggestion> {
    const { issue, shot } = input;
    const fixes: Record<string, { label: string; detail: string; apply: string; patch?: ContinuityRepairPatch }> = {
      "SCENE.ENVIRONMENT_UNLOCKED": { label: "Environment lock", detail: "Enable the environment lock so the model keeps the location stable.", apply: "Set scene.environmentLock = true.", patch: { sceneUpdates: { environmentLock: true } } },
      "SCENE.WEATHER_MISSING": { label: "Weather", detail: "Declare weather for the scene from the existing scene context.", apply: "Fill scene.weather before export." },
      "TECHNICAL.NEGATIVE_EMPTY": { label: "Negative prompt", detail: "A default negative prompt constrains drift terms.", apply: "Use the built-in default negative prompt.", patch: { sceneUpdates: { negativePrompt: "no extra characters, no extra limbs, no text, no subtitles, no watermark" } } },
      "AUDIO.PLAN_MISSING": { label: "Audio plan", detail: "A minimal audio plan makes the sound design explicit.", apply: "Create a default audio plan (score none, subtitles off).", patch: { sceneUpdates: { audioPlan: { score: "none", subtitles: false, diegeticMusic: [], sfx: [] } } } },
      "SPATIAL.AXIS_CONFLICT": { label: "Axis conflict", detail: "Screen direction reverses across the 180° line.", apply: "Mark the affected shot as an intentional axis break.", patch: input.issue.entityId ? { shotUpdates: [{ shotId: input.issue.entityId, intentionalAxisBreak: true }] } : undefined },
    };
    const currentIndex = input.issue.entityId ? input.scene.shots.findIndex((item) => item.id === input.issue.entityId) : -1;
    const previousShot = currentIndex > 0 ? input.scene.shots[currentIndex - 1] : undefined;
    const currentShot = currentIndex >= 0 ? input.scene.shots[currentIndex] : shot;
    const currentParticipant = currentShot?.participants?.find((item) => {
      const asset = input.project.assets?.find((candidate) => candidate.id === item.characterId);
      return Boolean(asset && (issue.detail.includes(asset.name) || issue.detail.includes(item.characterId)));
    });
    const spatialShotId = input.issue.shotId ?? input.issue.entityId ?? currentShot?.id;
    if (spatialShotId && currentShot) {
      const previousParticipant = previousShot?.participants?.find((item) => item.characterId === currentParticipant?.characterId);
      const spatialParticipant = currentParticipant ?? currentShot.participants?.[0];
      if (spatialParticipant && previousParticipant && ["SPATIAL.POSITION_JUMP", "SPATIAL.DEPTH_JUMP"].includes(issue.code)) {
        fixes[issue.code] = { label: "Restore spatial position", detail: "Restore the affected character's position to the preceding shot's established position.", apply: "Match the current shot position to the preceding shot.", patch: { shotUpdates: [{ shotId: spatialShotId, participantUpdates: [{ characterId: spatialParticipant.characterId, ...(previousParticipant.position ? { position: previousParticipant.position } : {}) }] }] } };
      }
      if (spatialParticipant && ["SPATIAL.REENTRY_UNMARKED", "SPATIAL.ENTRANCE_POSITION_CONFLICT"].includes(issue.code)) {
        const side = /(?:right|右)/i.test(spatialParticipant.position ?? "") ? "enters-right" : "enters-left";
        fixes[issue.code] = { label: "Declare entrance", detail: "Declare the affected character's entrance direction at the shot boundary.", apply: "Add an explicit left/right entrance to the affected participant.", patch: { shotUpdates: [{ shotId: spatialShotId, participantUpdates: [{ characterId: spatialParticipant.characterId, entrance: side }] }] } };
      }
      if (issue.code === "SPATIAL.ORDER_JUMP") {
        const order = previousShot?.layout?.characterOrder ?? previousShot?.participants?.map((item) => item.characterId) ?? [];
        fixes[issue.code] = { label: "Restore character order", detail: "Restore the preceding shot's left-to-right order for shared participants.", apply: "Match the current shot order to the preceding shot.", patch: { shotUpdates: [{ shotId: spatialShotId, characterOrder: order }] } };
      }
    }
    if (issue.code === "CAUSALITY.TARGET_MISSING" && issue.entityId) {
      const beatShot = input.scene.shots.find((item) => item.beats?.some((beat) => beat.id === issue.entityId));
      const beat = beatShot?.beats?.find((item) => item.id === issue.entityId);
      const fallbackTarget = beatShot?.participants?.find((item) => item.characterId !== beat?.actorId)?.characterId;
      if (beatShot && beat && fallbackTarget) {
        fixes[issue.code] = { label: "Add attack target", detail: "Use an existing participant as the missing target; no new asset is created.", apply: "Set the attack beat target to the other existing participant.", patch: { beatUpdates: [{ shotId: beatShot.id, beatId: beat.id, targetCharacterId: fallbackTarget }] } };
      }
    }
    const directorPatch = localDirectorPatch(input);
    if (directorPatch) {
      fixes[issue.code] = { label: "Repair director layer", detail: "Rewrite only the affected first-frame or location-map block from the existing structured shot facts.", apply: "Update the affected director-document block and rerun the checks.", patch: directorPatch };
    }
    const known = fixes[issue.code];
    if (known) {
      return { code: issue.code, label: known.label, detail: known.detail, apply: known.apply, patch: known.patch };
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
