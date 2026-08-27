/**
 * 导演级分段编译器（CINEDANCE V4 / P0.1）。
 * 与 legacy `compileProSequence` 的区别：
 * - 按导演分段顺序输出（SCENE CONTEXT → … → POSITIVE CONSTRAINTS）；
 * - 段头硬编码英文 canonical（进 i18n 待 P0 后续字段补齐）；
 * - 光线 / 物理从技术 Profile 拆出为优先级锁段；
 * - 负面词局部锁：就近挂到 PHYSICS / LIGHTING / POSITIVE CONSTRAINTS，仅全局失败模式保留精简尾段（P0.3）。
 */
import type { CameraBehavior, LightingDirection, ProjectV2, SceneV2, ShotV2 } from "../../shared-types";
import { assetCanonicalDescription } from "../asset-naming";
import {
  buildSceneAssetRegistry, renderCharacterCountLock, renderPropDefaults,
} from "./renderer";
import {
  renderLocalLocks, renderVoiceLockSection,
  type PromptLocale, type ReferenceSyntax,
} from "./sections";
import { legacyFocalLengthToFov, lensById, lensByFov, physicsAnchorById } from "../presets";
import { auditFinalPromptWithProject, createFinalPromptDocument, normalizeOpticsText, sanitizeDirectorText } from "../quality";

export interface DirectorOptions {
  syntax?: ReferenceSyntax;
  locale?: PromptLocale;
  audioEnabled?: boolean;
}

/**
 * 导演文档分层（P0.5）：canonical 层序 + 双语标题。
 * 层 key 稳定，供 AI 生成 / UI 编辑 / 编译器消费三处共用。
 * 每个 directorLayers[key] 的值是「含段头在内的完整文本块」。
 */
export const DIRECTOR_LAYERS = [
  { key: "sceneContext", zh: "场景上下文", en: "SCENE CONTEXT" },
  { key: "activeReferences", zh: "活动引用", en: "ACTIVE REFERENCES" },
  { key: "locationMap", zh: "场景地图", en: "LOCATION MAP" },
  { key: "firstFrame", zh: "首帧与站位", en: "FIRST FRAME AND SPATIAL BLOCKING" },
  { key: "formatMode", zh: "格式模式", en: "FORMAT MODE" },
  { key: "optics", zh: "光学", en: "OPTICS" },
  { key: "camera", zh: "相机", en: "CAMERA" },
  { key: "actionTiming", zh: "镜头执行", en: "SHOT EXECUTION" },
  { key: "physics", zh: "物理", en: "PHYSICS" },
  { key: "lighting", zh: "光线", en: "LIGHTING" },
  { key: "audio", zh: "音频", en: "AUDIO" },
  { key: "positiveConstraints", zh: "正向约束", en: "POSITIVE CONSTRAINTS" },
  { key: "negativeLocks", zh: "负面局部锁", en: "NEGATIVE LOCKS" },
] as const;

export type DirectorLayerKey = (typeof DIRECTOR_LAYERS)[number]["key"];
export const DIRECTOR_LAYER_ORDER: readonly DirectorLayerKey[] = DIRECTOR_LAYERS.map((layer) => layer.key);

export function directorLayerLabel(key: DirectorLayerKey, locale: "zh" | "en"): string {
  const found = DIRECTOR_LAYERS.find((layer) => layer.key === key);
  return found ? found[locale] : key;
}

/** LOCATION MAP：从场景站位派生（位置参考 → 锚点 → 角色顺序 → 间距 → 屏幕方向）。 */
function renderLocationMap(project: ProjectV2, scene: SceneV2, locale: PromptLocale): string {
  const staging = scene.staging;
  if (!staging) return "";
  const zh = locale === "zh";
  const ref = (id: string) => project.assets?.find((asset) => asset.id === id)?.name?.trim() || id;
  const lines: string[] = [];
  if (staging.locationAssetId) lines.push(zh ? `地点参考：${ref(staging.locationAssetId)}` : `Location reference: ${ref(staging.locationAssetId)}`);
  if (staging.anchorDescription?.trim()) lines.push(zh ? `空间锚点：${staging.anchorDescription.trim()}` : `Anchor: ${staging.anchorDescription.trim()}`);
  if ((staging.characterOrder ?? []).length > 0) lines.push(zh ? `角色从左到右：${staging.characterOrder!.map(ref).join("、")}` : `Character order, left to right: ${staging.characterOrder!.map(ref).join(", ")}`);
  if (staging.spacing?.trim()) lines.push(zh ? `间距：${staging.spacing.trim()}` : `Spacing: ${staging.spacing.trim()}`);
  if (staging.axisDirection) lines.push(zh
    ? `屏幕方向：${staging.axisDirection === "left-to-right" ? "从左到右" : "从右到左"}`
    : `Screen direction: ${staging.axisDirection}`);
  return lines.join("\n");
}

/** Final prompts register every reference once; later shot prose uses untagged names. */
function renderActiveReferences(project: ProjectV2, scene: SceneV2, locale: PromptLocale, syntax: ReferenceSyntax): string {
  const registry = buildSceneAssetRegistry(project, scene);
  if (registry.orderedAssets.length === 0) return "";
  const zh = locale === "zh";
  let imageIndex = 0;
  let audioIndex = 0;
  return registry.orderedAssets.map((asset) => {
    const referenceName = asset.referenceTag?.trim() || asset.name.trim() || asset.id;
    const tag = syntax === "plain-text" ? referenceName : `@${referenceName}`;
    const description = assetCanonicalDescription(asset, locale) || referenceName;
    const anchors = asset.lockLevel === "strict"
      ? [...(asset.uniqueMarkers ?? []), ...(asset.alwaysVisible ?? [])].filter(Boolean)
      : [];
    const anchorText = anchors.length > 0
      ? (zh ? `；身份锚：${anchors.join("；")}` : `; identity anchors: ${anchors.join("; ")}`)
      : "";
    const locationScope = asset.kind === "location"
      ? (zh ? "；仅控制空间几何、材质、光线和氛围，不控制取景" : "; controls geometry, materials, light and atmosphere only, not framing")
      : "";
    const holderName = (id: string) => {
      const holder = registry.orderedAssets.find((candidate) => candidate.id === id);
      if (!holder) return id;
      const holderReference = holder.referenceTag?.trim() || holder.name.trim() || holder.id;
      return `@${holderReference}`;
    };
    const propDefaults = renderPropDefaults(asset, locale, holderName);
    const propScope = propDefaults ? `；${propDefaults}` : "";
    const imageToken = asset.referencePaths?.[0]?.trim() ? ` [image${++imageIndex}]` : "";
    const voiceToken = asset.voiceClip?.trim() ? (zh ? `；声音参考：[audio${++audioIndex}]` : `; Voice reference: [audio${++audioIndex}]`) : "";
    return zh
      ? `${tag}${imageToken}：${description}${anchorText}${locationScope}${propScope}${voiceToken}。`
      : `${tag}${imageToken}: ${description}${anchorText}${locationScope}${propScope}${voiceToken}.`;
  }).join("\n");
}

function push(list: string[], header: string, body: string): void {
  if (!body?.trim()) return;
  const separator = /^[\x00-\x7F\s]+$/.test(header) ? ":" : "：";
  list.push(header ? `${header}${/[：:]$/.test(header) ? "" : separator}\n${body.trim()}` : body.trim());
}

/** P1.2 OPTICS 层：可观测结果优先于焦距与品牌。长镜头统一 FOV 锁；多镜头逐镜锁定。 */
function renderOpticsLayer(scene: SceneV2, locale: PromptLocale): string {
  const shots = scene.shots ?? [];
  if (shots.length === 0) return "";
  const zh = locale === "zh";
  const fovFor = (shot: ShotV2) => shot.optics?.fieldOfViewDegrees ?? lensByFov(legacyFocalLengthToFov(shot.lens))?.fov;
  const lines: string[] = [];
  const renderShotOptics = (shot: ShotV2, prefix: string) => {
    const optics = shot.optics;
    const preset = lensById(optics?.lensCharacter) ?? lensByFov(fovFor(shot));
    const fov = preset?.fov ?? fovFor(shot);
    if (fov == null) return "";
    const outcome = optics?.lensOutcome?.length ? optics.lensOutcome : (preset ? (zh ? preset.outcomeZh : preset.outcome) : []);
    const lensName = preset
      ? (zh ? preset.zh : preset.en).replace(/\s*\d+°\s*$/, "")
      : (zh ? "视场角" : "FOV");
    const outcomeText = outcome.map((item) => normalizeOpticsText(item, fov).text).filter(Boolean).join(zh ? "；" : "; ");
    const base = `${prefix}${zh ? "：" : ": "}${fov}° ${lensName}`;
    return outcomeText ? `${base}${zh ? "；" : ". "}${outcomeText}` : base;
  };
  if (scene.shootingMode === "long-take") {
    const optics = shots[0].optics;
    const fov = fovFor(shots[0]);
    const preset = lensById(optics?.lensCharacter) ?? lensByFov(fov);
    const anti = optics?.antiDriftLock?.trim() || (preset ? (zh ? preset.antiDriftZh : preset.antiDrift) : "");
    const visibleResult = renderShotOptics(shots[0], zh ? "全段统一" : "ONE FOV THROUGHOUT");
    if (visibleResult) lines.push(visibleResult);
    if (anti) lines.push(anti);
  } else {
    for (const [index, shot] of shots.entries()) {
      const line = renderShotOptics(shot, zh ? `镜头 ${index + 1}` : `SHOT ${index + 1}`);
      if (line) lines.push(`${line}${/[。.!！?？]$/.test(line) ? "" : (zh ? "。" : ".")}`);
    }
  }
  return lines.join("\n");
}

/**
 * Audio defaults are explicit: no score and no subtitles. User-selected audio
 * plan fields are authoritative, while character voice locks remain tied to
 * actual dialogue instead of being emitted for silent characters.
 */
function renderDialogueSoundLayer(project: ProjectV2, scene: SceneV2, locale: PromptLocale): string {
  const zh = locale === "zh";
  const names = new Map((project.assets ?? []).map((asset) => [asset.id, asset.name.trim() || asset.id]));
  const dialogueOrder: string[] = [];
  for (const shot of scene.shots ?? []) {
    for (const beat of [...(shot.beats ?? [])].sort((a, b) => a.order - b.order)) {
      if (!beat.dialogue?.trim() || !beat.actorId) continue;
      const name = names.get(beat.actorId) ?? beat.actorId;
      dialogueOrder.push(zh ? `${name}说“${beat.dialogue.trim()}”` : `${name} says "${beat.dialogue.trim()}"`);
    }
  }
  const voiceLocks = renderVoiceLockSection(project, scene, locale)
    .replace(/^(声音锁：|VOICE LOCKS:)\n?/, "").trim();
  const audio = project.audioPlan;
  const lines: string[] = [];
  lines.push(zh
    ? "默认环境声：保留与地点和天气一致的连续环境底噪；人物呼吸、衣料、脚步、道具接触、摩擦与碰撞仅在画面实际发生时同步出现，具有真实距离、重量和材质。"
    : "Default environmental sound: retain continuous ambience consistent with the location and weather; breathing, cloth, footsteps, prop contact, friction, and impacts occur only when visible on screen, with credible distance, weight, and material.");
  if ((audio?.diegeticMusic ?? []).length > 0) {
    lines.push(zh ? `画内音乐：${audio!.diegeticMusic!.join("、")}。` : `Diegetic music: ${audio!.diegeticMusic!.join(", ")}.`);
  }
  if ((audio?.sfx ?? []).length > 0) {
    lines.push(zh ? `环境音效：${audio!.sfx!.join("、")}。` : `Environmental SFX: ${audio!.sfx!.join(", ")}.`);
  }
  const hasScore = audio?.score === "original-score";
  const hasSubtitles = audio?.subtitles === true;
  lines.push(zh
    ? `配乐：${hasScore ? "原始配乐" : "无"}。字幕：${hasSubtitles ? "烧录字幕" : "无"}。`
    : `Score: ${hasScore ? "original score" : "none"}. Subtitles: ${hasSubtitles ? "burned-in" : "none"}.`);
  if (dialogueOrder.length > 0) {
    lines.push(zh ? `对白顺序：${dialogueOrder.join("；")}。` : `Dialogue order: ${dialogueOrder.join("; ")}.`);
    lines.push(zh
      ? "每句对白结束后保留约 0.5–1 秒环境声尾巴；只有明确的抢话或即时打断才省略该尾巴。"
      : "After each line, retain roughly 0.5–1 second of environmental sound tail; omit it only for an explicit interruption or immediate overlap.");
  }
  if (voiceLocks) lines.push(voiceLocks);
  return lines.join("\n");
}

/** P1.3 CAMERA 层：物理操作员行为（高度/距离/角度/机位边/画面位置/对焦/景深/手持质感）。 */
function renderCameraLayer(scene: SceneV2, locale: PromptLocale): string {
  const shots = (scene.shots ?? []).filter((shot) => shot.cameraBehavior);
  if (shots.length === 0) return "";
  const zh = locale === "zh";
  const fields: [keyof CameraBehavior, string][] = [
    ["height", "高度"], ["distance", "距离"], ["angle", "角度"], ["side", "机位边"],
    ["subjectSize", "画面大小"], ["screenPlacement", "画面位置"], ["focusBehavior", "对焦"],
    ["depthOfField", "景深"], ["handheldQuality", "手持质感"],
  ];
  const render = (behavior: CameraBehavior): string => {
    const parts: string[] = [];
    for (const [key, zhLabel] of fields) {
      const value = behavior[key]?.trim();
      if (value) parts.push(zh ? `${zhLabel}：${value}` : `${key}: ${value}`);
    }
    return parts.join(zh ? "；" : "; ");
  };
  if (scene.shootingMode === "long-take") {
    return scene.shots[0]?.cameraBehavior ? render(scene.shots[0].cameraBehavior) : "";
  }
  return shots.map((shot) => `${zh ? "镜头" : "SHOT"} ${shot.label}：${render(shot.cameraBehavior!)}`).join("\n");
}

/** P1.4 首帧占位锁：确保首帧已含所有必需主体，无空镜开场。 */
function renderFirstFrameLayer(scene: SceneV2, locale: PromptLocale): string {
  const lock = scene.firstFrameLock;
  if (!lock) return "";
  const zh = locale === "zh";
  return lock.occupancyStatement?.trim() || (zh
    ? "第一帧已包含所有必需角色，且身处正确位置。无空镜开场。无延迟角色亮相。"
    : "The first visible frame already contains all required characters in their correct positions. No empty establishing frame. No delayed character reveal.");
}

/**
 * 最终交付把动作时间与角色表演合并为同一镜头执行表。
 * UI 仍独立维护节拍/表演字段；导出时每个动作仅写一次，避免模型把
 * 同一动作理解为二次执行。
 */
function renderShotExecutionLayer(
  project: ProjectV2,
  scene: SceneV2,
  locale: PromptLocale,
  shotTimes: Map<string, { startSeconds: number; endSeconds: number }>,
): string {
  const zh = locale === "zh";
  const displayName = (id: string) => project.assets?.find((asset) => asset.id === id)?.name?.trim() || id;
  const sentenceEnd = /[。．.!！?？][”」』)）\"']?$/;
  const sentence = (text: string) => {
    const trimmed = text.trim();
    return trimmed ? (sentenceEnd.test(trimmed) ? trimmed : `${trimmed}${zh ? "。" : "."}`) : "";
  };
  const fragment = (text: string) => text.trim().replace(/[。．.!！?？][”」』)）\"']?$/, "");
  const fmt = (sec: number) => {
    const total = Math.round(sec);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  };

  const renderShotDetails = (shot: ShotV2): string[] => {
    const lines: string[] = [];
    const beats = [...(shot.beats ?? [])].sort((a, b) => a.order - b.order);
    if (shot.acting?.trim()) lines.push(zh ? `表演基调：${sentence(shot.acting)}` : `Performance tone: ${sentence(shot.acting)}`);
    if (shot.eyeLife?.trim()) lines.push(zh ? `镜头眼神：${sentence(shot.eyeLife)}` : `Eye line: ${sentence(shot.eyeLife)}`);

    const actorIds = [...new Set(beats.map((beat) => beat.actorId).filter((id): id is string => Boolean(id)))];
    for (const actorId of actorIds) {
      const parts: string[] = [];
      for (const beat of beats.filter((item) => item.actorId === actorId)) {
        const action = beat.actionText?.trim() || beat.verb?.trim();
        const targetId = beat.targetCharacterId ?? beat.targetPropId;
        const target = targetId && targetId !== actorId ? displayName(targetId) : "";
        if (action) parts.push(zh ? `动作：${fragment(action)}` : `Action: ${fragment(action)}`);
        if (target) parts.push(zh ? `对象：${target}` : `Target: ${target}`);
        if (beat.beatChange?.trim()) parts.push(zh ? `节拍变化：${fragment(beat.beatChange)}` : `Beat change: ${fragment(beat.beatChange)}`);
        if (beat.reactionBeforeLine?.trim()) parts.push(zh
          ? `对白前反应：${fragment(beat.reactionBeforeLine)}`
          : `Reaction before the other line ends: ${fragment(beat.reactionBeforeLine)}`);
        if (beat.dialogue?.trim()) parts.push(zh ? `对白：“${beat.dialogue.trim()}”` : `Dialogue: "${beat.dialogue.trim()}"`);
      }
      if (parts.length > 0) lines.push(zh ? `${displayName(actorId)}：${parts.join("；")}。` : `${displayName(actorId)}: ${parts.join("; ")}.`);
    }

    if (beats.length === 0 && shot.action?.trim()) {
      lines.push(zh ? `镜头动作：${sentence(shot.action)}` : `Shot action: ${sentence(shot.action)}`);
    }
    return lines;
  };

  const blocks: string[] = [];
  const longTakeDetails: string[] = [];
  for (const [index, shot] of (scene.shots ?? []).entries()) {
    const time = shotTimes.get(shot.id);
    if (!time) continue;
    const details = renderShotDetails(shot);
    if (scene.shootingMode === "long-take") {
      longTakeDetails.push(...details);
      continue;
    }
    const prefix = scene.shootingMode === "multi-shot"
      ? (zh ? `镜头 ${index + 1} ${fmt(time.startSeconds)}–${fmt(time.endSeconds)}：` : `SHOT ${index + 1} ${fmt(time.startSeconds)}-${fmt(time.endSeconds)}:`)
      : (zh ? `${fmt(time.startSeconds)}–${fmt(time.endSeconds)}：` : `${fmt(time.startSeconds)}-${fmt(time.endSeconds)}:`);
    const cut = index > 0 && scene.shootingMode === "multi-shot"
      ? ({
          "hard-cut": zh ? `硬切进入镜头 ${index + 1}；` : `Hard cut into shot ${index + 1}; `,
          "match-cut": zh ? `动作匹配剪辑进入镜头 ${index + 1}；` : `Match cut into shot ${index + 1}; `,
          overlap: zh ? `以声音或动作重叠进入镜头 ${index + 1}；` : `Enter shot ${index + 1} on sound or action overlap; `,
        }[shot.cutStyle ?? scene.cutStyleDefault ?? "hard-cut"])
      : "";
    blocks.push(`${prefix}${cut}\n${details.map((line) => `- ${line}`).join("\n")}`);
  }
  if (scene.shootingMode === "long-take" && longTakeDetails.length > 0) {
    const end = Math.max(0, ...[...shotTimes.values()].map((time) => time.endSeconds));
    const uniqueDetails = [...new Set(longTakeDetails)];
    return `${fmt(0)}${zh ? "–" : "-"}${fmt(end)}${zh ? "：" : ":"}\n${uniqueDetails.map((line) => `- ${line}`).join("\n")}`;
  }
  return blocks.join("\n");
}

/** P1.6 光线方向结构：主光源/方向/曝光优先/高光/禁止。 */
function renderLightingDirection(lighting: LightingDirection | undefined, locale: PromptLocale): string {
  if (!lighting) return "";
  const zh = locale === "zh";
  const parts: string[] = [];
  if (lighting.primarySource?.trim()) parts.push(zh ? `主光源：${lighting.primarySource.trim()}` : `Key: ${lighting.primarySource.trim()}`);
  if (lighting.direction?.trim()) parts.push(zh ? `方向：${lighting.direction.trim()}` : `Direction: ${lighting.direction.trim()}`);
  if (lighting.exposurePriority?.trim()) parts.push(zh ? `曝光优先：${lighting.exposurePriority.trim()}` : `Exposure priority: ${lighting.exposurePriority.trim()}`);
  if ((lighting.allowHighlights ?? []).length) parts.push(zh ? `允许高光：${lighting.allowHighlights!.join("、")}` : `Allow highlights: ${lighting.allowHighlights!.join(", ")}`);
  if ((lighting.forbid ?? []).length) parts.push(zh ? `禁止：${lighting.forbid!.join("、")}` : `Forbid: ${lighting.forbid!.join(", ")}`);
  return parts.join(zh ? "；" : "; ");
}

/** P1.7 物理锚点：每镜按动作类别输出可观测锚点短语。 */
function renderPhysicsAnchors(scene: SceneV2, locale: PromptLocale): string[] {
  const zh = locale === "zh";
  const lines: string[] = [];
  for (const shot of scene.shots ?? []) {
    for (const anchor of shot.physicsAnchors ?? []) {
      const preset = physicsAnchorById(anchor.kind);
      if (!preset) continue;
      const points = (zh ? preset.pointsZh : preset.pointsEn).join(zh ? "、" : ", ");
      const extra = anchor.detail?.trim();
      lines.push(zh
        ? `镜头 ${shot.label} 物理锚点（${preset.zh}）：${points}${extra ? `；${extra}` : ""}。`
        : `SHOT ${shot.label} physics anchor (${preset.en}): ${points}${extra ? `; ${extra}` : ""}.`);
    }
  }
  return lines;
}

export function compileDirectorSequence(project: ProjectV2, scene: SceneV2, options: DirectorOptions = {}): string {
  const syntax = options.syntax ?? "asset-id";
  const locale: PromptLocale = options.locale ?? "zh";
  // AI directorLayers are source material only. The final export is always
  // rebuilt from structured scene data so raw UI/inspector text cannot leak.
  const finalAudit = auditFinalPromptWithProject(scene, project.assets ?? []);
  const finalDocument = createFinalPromptDocument(scene, finalAudit);
  const shotTimes = finalDocument.shotTimes;
  const locks = renderLocalLocks(project, locale);
  const sections: string[] = [];
  const header = (key: DirectorLayerKey) => directorLayerLabel(key, locale);

  // The scene brief, prior context, global technical profile, and style brief are
  // planning inputs. They guide AI compilation but must never be copied into final
  // delivery. The director document starts from executable scene data instead.
  push(sections, header("activeReferences"), renderActiveReferences(project, scene, locale, syntax));

  push(sections, header("locationMap"), renderLocationMap(project, scene, locale));

  push(sections, header("firstFrame"), renderFirstFrameLayer(scene, locale));

  // FORMAT MODE：长镜头 = 单连续镜头；多镜头 = 受控多镜序列。
  push(sections, header("formatMode"), scene.shootingMode === "multi-shot"
    ? (locale === "zh" ? "受控多镜头序列；仅在明确镜头边界处切换。" : "CONTROLLED MULTI-SHOT SEQUENCE. Cut only at explicit shot boundaries.")
    : (locale === "zh" ? "单一连续长镜头；全段保持同一摄影机、FOV 与轴线。" : "SINGLE CONTINUOUS TAKE. Keep one camera, FOV and screen axis throughout."));

  push(sections, header("optics"), renderOpticsLayer(scene, locale));
  push(sections, header("camera"), renderCameraLayer(scene, locale));
  push(sections, header("actionTiming"), renderShotExecutionLayer(project, scene, locale, shotTimes));

  // PHYSICS / LIGHTING 优先级锁（正向先写，负向骨折就近内联）。
  const physicsBits = [locks.physics.join(locale === "zh" ? "；" : "; "), ...renderPhysicsAnchors(scene, locale)].filter(Boolean);
  push(sections, header("physics"), physicsBits.join(locale === "zh" ? "；" : "; "));
  const lightingBits = [renderLightingDirection(scene.lightingDirection, locale), locks.lighting.join(locale === "zh" ? "；" : "; ")].filter(Boolean);
  push(sections, header("lighting"), lightingBits.join(locale === "zh" ? "；" : "; "));

  if (options.audioEnabled !== false) push(sections, header("audio"), renderDialogueSoundLayer(project, scene, locale));
  // Identity anchors already appear once in ACTIVE REFERENCES. Keep only
  // count and user-authored positive constraints here.
  const positives: string[] = [];
  const count = renderCharacterCountLock(project, locale);
  if (count) positives.push(count);
  if (locks.character.length) positives.push(locks.character.join(locale === "zh" ? "；" : "; "));
  for (const item of project.positiveConstraints ?? []) if (item.trim()) positives.push(item.trim());
  push(sections, header("positiveConstraints"), positives.join("\n"));

  return sanitizeDirectorText(sections.filter(Boolean).join("\n\n"));
}
