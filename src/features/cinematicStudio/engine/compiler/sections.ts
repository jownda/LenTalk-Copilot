/**
 * 共享渲染段（P0.2 双语）
 * 三个模板（asset-id-tagged / pro-sequence / shot-cards）共用的段渲染器。
 * locale 默认 zh（产品默认语言）；结构化枚举本地化，用户文本保持原文。
 */
import type { ProjectV2, SceneV2, ShotV2 } from "../../shared-types";
import { getCamera, getLens } from "../gear";
import { legacyFocalLengthToFov, lensByFov, renderTechnicalProfile } from "../presets";
import { beatVerbZh } from "../beats";
import {
  canonicalNegativeId, classifyNegative, renderDefaultNegative, DEFAULT_NEGATIVE_IDS,
  type NegativeCategory,
} from "../constants";
import { fillTemplate, localizePromptValue, promptLexicon, type PromptLocale } from "../i18n/lexicon";
import {
  assetRefName, buildAssetRegistry, renderAssetLine, renderAxisBreakNote, renderCharacterCountLock,
  renderParticipantsLine, renderShotTime, renderSpatialLayoutLine, renderStagingDetails,
  renderStrictIdentityLock, resolveAnchor, resolveCharacterOrder,
  type AssetRegistry, type ReferenceSyntax,
} from "./renderer";

export type { ReferenceSyntax, PromptLocale };

const sentence = (text: string) => {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (/[。．.!！?？]$/.test(trimmed)) return trimmed;
  return `${trimmed}.`;
};

/** 场景段（P0.2 双语；自由文本保持原文） */
export function renderSceneSection(scene: SceneV2, locale: PromptLocale = "zh"): string {
  const sceneParts = [scene.name, scene.duration, scene.location, scene.time, scene.weather].filter((part) => part.trim());
  const priorContext = scene.staging?.priorContext?.trim();
  const sceneLine = locale === "zh"
    ? `场景：${sceneParts.join("，")}${scene.logline?.trim() ? `。${sentence(scene.logline.trim())}` : ""}`
    : `SCENE: ${sceneParts.join(", ")}${scene.logline?.trim() ? `. ${sentence(scene.logline.trim())}` : ""}`;
  const lines = [sceneLine];
  if (priorContext) lines.push(locale === "zh" ? `前情提要：${sentence(priorContext)}` : `Prior context: ${sentence(priorContext)}`);
  if (scene.shootingMode === "long-take" && (scene.shots?.length ?? 0) > 1) {
    lines.push(locale === "zh"
      ? "拍摄模式：长镜头（全镜统一相机参数）"
      : "Shooting mode: long take (unified camera parameters across all shots)");
  }
  return lines.join("\n");
}

/** 角色数量锁（EXACTLY N / 画面中恰好 N 名） */
export function renderCountSection(project: ProjectV2, locale: PromptLocale = "zh"): string {
  return renderCharacterCountLock(project, locale);
}

/** 资产段：按引用顺序编号，语法由 ReferenceSyntax 决定（P0.2 双语） */
export function renderAssetSection(registry: AssetRegistry, syntax: ReferenceSyntax = "asset-id", locale: PromptLocale = "zh"): string {
  if (registry.orderedAssets.length === 0) return "";
  const heading = promptLexicon(locale).headings.assets;
  const holderName = (id: string) => {
    const holder = registry.orderedAssets.find((asset) => asset.id === id);
    if (!holder) return id;
    const name = holder.referenceTag?.trim() || holder.name.trim() || holder.id;
    return syntax === "at-mention" ? `@${name}` : name;
  };
  let imageIndex = 0;
  let audioIndex = 0;
  const assetLines = registry.orderedAssets.map((asset) => renderAssetLine(
    asset,
    asset.referencePaths?.[0]?.trim() ? ++imageIndex : undefined,
    syntax,
    locale,
    holderName,
    asset.voiceClip?.trim() ? ++audioIndex : undefined,
  ));
  return `${heading}:\n${assetLines.join("\n")}`;
}

/** 强锁段（不允许用户手工删掉） */
export function renderStrictSection(registry: AssetRegistry, project: ProjectV2, locale: PromptLocale = "zh"): string {
  return renderStrictIdentityLock(registry, project.identityRules ?? [], locale);
}

/** 技术段 */
export function renderTechnicalSection(project: ProjectV2, locale: PromptLocale = "zh"): string {
  const techText = renderTechnicalProfile(project, locale);
  return techText ? `${promptLexicon(locale).headings.technical}:\n${techText}` : "";
}

/** 相机参数覆写（长镜头模式用于全镜统一） */
export type ShotCameraOverride = Partial<Pick<ShotV2, "framing" | "movement" | "camera" | "lensModel">>;

export function unifiedCameraForScene(scene: SceneV2): ShotCameraOverride | undefined {
  if (scene.shootingMode !== "long-take") return undefined;
  const first = scene.shots[0];
  if (!first) return undefined;
  return { framing: first.framing, movement: first.movement, camera: first.camera, lensModel: first.lensModel };
}

/** 单镜头段（时间、相机、参与者、站位、状态链、Beats、NOTE；P2.1 引用语法） */
export function renderShotSection(project: ProjectV2, scene: SceneV2, shot: ShotV2, locale: PromptLocale = "zh", syntax: ReferenceSyntax = "asset-id", cameraOverride?: ShotCameraOverride): string {
  const lex = promptLexicon(locale);
  const shotLines = [renderShotTime(shot, locale)];
  const shotBit: string[] = [];
  const framing = cameraOverride && cameraOverride.framing !== undefined ? cameraOverride.framing : shot.framing;
  const movement = cameraOverride && cameraOverride.movement !== undefined ? cameraOverride.movement : shot.movement;
  const cameraId = cameraOverride && cameraOverride.camera !== undefined ? cameraOverride.camera : shot.camera;
  const lensModelId = cameraOverride && cameraOverride.lensModel !== undefined ? cameraOverride.lensModel : shot.lensModel;
  if (framing?.trim()) shotBit.push(localizePromptValue(framing.trim(), locale));
  const fov = shot.optics?.fieldOfViewDegrees ?? lensByFov(legacyFocalLengthToFov(shot.lens))?.fov;
  if (fov != null) shotBit.push(locale === "zh" ? `视场角 ${fov}°` : `FOV ${fov}°`);
  if (movement) shotBit.push(`${localizePromptValue(movement, locale)}${locale === "zh" ? "" : " movement"}`);
  const camera = getCamera(cameraId);
  if (camera) shotBit.push(`${locale === "zh" ? "相机" : "Camera"}: ${camera.brand} ${camera.model}`);
  const lens = getLens(lensModelId);
  if (lens) shotBit.push(`${locale === "zh" ? "镜头" : "Lens"}: ${lens.brand} ${lens.model}`);
  if (shotBit.length > 0) shotLines.push(locale === "zh" ? `相机与景别：${shotBit.join("，")}。` : `Camera & framing: ${shotBit.join(", ")}.`);
  const axisBreak = renderAxisBreakNote(shot, locale);
  if (axisBreak) shotLines.push(locale === "zh" ? `相机行为：${axisBreak}` : `Camera behavior: ${axisBreak}`);
  if (shot.direction) shotLines.push(locale === "zh" ? `屏幕方向：${shot.direction}。` : `Screen direction: ${shot.direction}.`);

  // 参与者与空间站位
  const characterOrder = resolveCharacterOrder(scene, shot);
  const participants = shot.participants ?? [];
  if (participants.length > 0 || characterOrder.length > 0) {
    const participantsLine = renderParticipantsLine(project, shot, characterOrder, locale, syntax);
    if (participantsLine) shotLines.push(participantsLine);
    const layoutLine = renderSpatialLayoutLine(project, shot, characterOrder, locale, syntax);
    if (layoutLine) shotLines.push(layoutLine);
    const details = renderStagingDetails(project, shot, locale, syntax);
    if (details) shotLines.push(details);
    const anchor = resolveAnchor(scene, shot);
    if (anchor) shotLines.push(sentence(anchor));
  } else if (shot.characterId) {
    const name = assetRefName(project, syntax);
    shotLines.push(locale === "zh" ? `角色：${name(shot.characterId)}。` : `Participant: ${name(shot.characterId)}.`);
  }

  // 道具变化只保留一段镜头级自然语言，避免开始/结束状态互相冲突。
  if (shot.propChangeDescription?.trim()) {
    shotLines.push(locale === "zh"
      ? `道具变化：${sentence(shot.propChangeDescription.trim())}`
      : `Prop changes: ${sentence(shot.propChangeDescription.trim())}`);
  }

  // Beats
  if ((shot.beats ?? []).length > 0) {
    const assetName = assetRefName(project, syntax);
    for (const beat of [...(shot.beats ?? [])].sort((a, b) => a.order - b.order)) {
      const bits: string[] = [];
      if (beat.actorId) bits.push(assetName(beat.actorId));
      if (beat.verb) bits.push(locale === "zh" ? (beatVerbZh[beat.verb as keyof typeof beatVerbZh] ?? beat.verb) : beat.verb);
      if (beat.targetCharacterId) bits.push(assetName(beat.targetCharacterId));
      if (beat.targetPropId) bits.push(assetName(beat.targetPropId));
      if (beat.targetBodyPart) bits.push(beat.targetBodyPart);
      if (beat.actionText?.trim()) bits.push(beat.actionText.trim());
      let line = fillTemplate(lex.templates.beatLine, { order: String(beat.order), content: `${bits.join(" ")}${bits.length ? "." : ""}` });
      const targetId = beat.targetCharacterId ?? beat.targetPropId;
      const never = (beat.forbiddenTargets ?? []).filter((id) => id !== targetId).map(assetName);
      if (targetId) {
        const targetOnly = fillTemplate(lex.labels.targetOnly, { name: assetName(targetId) });
        line += locale === "zh"
          ? ` 目标：${assetName(targetId)} 仅此${never.length > 0 ? `，禁止 ${never.join("、")}` : ""}。`
          : ` ${targetOnly}${never.length > 0 ? `; never ${never.join(", ")}` : ""}.`;
      } else if (never.length > 0) {
        line += locale === "zh" ? ` 禁止目标：${never.join("、")}。` : ` Never target: ${never.join(", ")}.`;
      }
      if (beat.cutRule?.trim()) line += ` ${sentence(beat.cutRule.trim())}`;
      if (beat.tactic?.trim()) line += locale === "zh" ? ` 策略：${sentence(beat.tactic.trim())}` : ` Tactic: ${sentence(beat.tactic.trim())}`;
      if (beat.subtext?.trim()) line += locale === "zh" ? ` 潜台词：${sentence(beat.subtext.trim())}` : ` Subtext: ${sentence(beat.subtext.trim())}`;
      if (beat.beatChange?.trim()) line += locale === "zh" ? ` 节拍变化：${sentence(beat.beatChange.trim())}` : ` Beat change: ${sentence(beat.beatChange.trim())}`;
      if (beat.reactionBeforeLine?.trim()) line += locale === "zh" ? ` 反应先于对方台词结束：${sentence(beat.reactionBeforeLine.trim())}` : ` Reacts before the other line ends: ${sentence(beat.reactionBeforeLine.trim())}`;
      if (beat.dialogue?.trim()) line += locale === "zh" ? ` 对白："${beat.dialogue.trim()}"。` : ` Dialogue: "${beat.dialogue.trim()}".`;
      if (beat.note?.trim()) line += locale === "zh" ? ` 备注：${sentence(beat.note.trim())}` : ` NOTE: ${sentence(beat.note.trim())}`;
      shotLines.push(line);
    }
  }

  // V0.1 兼容动作
  if (shot.action?.trim() && (shot.beats ?? []).length === 0) shotLines.push(locale === "zh" ? `动作：${sentence(shot.action.trim())}` : `Action: ${sentence(shot.action.trim())}`);
  const actingBits: string[] = [];
  if (shot.acting?.trim()) actingBits.push(sentence(shot.acting.trim()));
  if (shot.eyeLife?.trim()) actingBits.push(locale === "zh" ? `眼部生活：${sentence(shot.eyeLife.trim())}` : `Eye life: ${sentence(shot.eyeLife.trim())}`);
  for (const participant of shot.participants ?? []) {
    const performance = participant.acting?.trim();
    const eyeLife = participant.eyeLife?.trim();
    if (!performance && !eyeLife) continue;
    const name = assetRefName(project, syntax)(participant.characterId);
    const details = [performance ? sentence(performance) : "", eyeLife ? (locale === "zh" ? `眼部生活：${sentence(eyeLife)}` : `Eye life: ${sentence(eyeLife)}`) : ""].filter(Boolean);
    actingBits.push(locale === "zh" ? `${name}：${details.join(" ")}` : `${name}: ${details.join(" ")}`);
  }
  if (actingBits.length > 0) shotLines.push(locale === "zh" ? `表演：${actingBits.join(" ")}` : `Acting: ${actingBits.join(" ")}`);
  if (shot.note?.trim()) shotLines.push(locale === "zh" ? `备注：${sentence(shot.note.trim())}` : `NOTE: ${sentence(shot.note.trim())}`);
  return shotLines.join("\n");
}

/** 场景表演目标段（P2 五支柱）：每参与角色目的/阻碍/代价/贯穿目标。 */
export function renderActingSection(project: ProjectV2, scene: SceneV2, locale: PromptLocale = "zh"): string {
  const objectives = scene.actingObjectives ?? [];
  if (objectives.length === 0) return "";
  const lex = promptLexicon(locale);
  const zh = locale === "zh";
  const assets = new Map((project.assets ?? []).map((asset) => [asset.id, asset]));
  const lines: string[] = [zh ? `${lex.headings.acting} 目标：` : `${lex.headings.acting} OBJECTIVES:`];
  for (const objective of objectives) {
    if (!objective.objective?.trim()) continue;
    const name = assets.get(objective.characterId)?.name?.trim() || objective.characterId;
    const bits: string[] = [zh ? `目的：${objective.objective.trim()}` : `Objective: ${objective.objective.trim()}`];
    if (objective.obstacle?.trim()) bits.push(zh ? `阻碍：${objective.obstacle.trim()}` : `Obstacle: ${objective.obstacle.trim()}`);
    if (objective.stakes?.trim()) bits.push(zh ? `代价：${objective.stakes.trim()}` : `Stakes: ${objective.stakes.trim()}`);
    if (objective.superObjective?.trim()) bits.push(zh ? `贯穿目标：${objective.superObjective.trim()}` : `Super-objective: ${objective.superObjective.trim()}`);
    lines.push(zh ? `${name}：${bits.join("；")}。` : `${name}: ${bits.join("; ")}.`);
  }
  return lines.join("\n");
}

/** 音频段（P0.2 双语；P5.3 注入镜头含对白时的声音锁） */
export function renderAudioSection(project: ProjectV2, scene: SceneV2, locale: PromptLocale = "zh", enabled = true): string {
  if (!enabled) return "";
  const lex = promptLexicon(locale);
  const audioLines = [lex.headings.audio + ":"];
  const joinList = (list: string[]) => list.join(locale === "zh" ? "、" : ", ");
  const audio = project.audioPlan;
  if (audio) {
    if ((audio.diegeticMusic ?? []).length > 0) audioLines.push(locale === "zh" ? `画内音乐：${joinList(audio.diegeticMusic!)}。` : `Diegetic music: ${joinList(audio.diegeticMusic!)}.`);
    if ((audio.sfx ?? []).length > 0) audioLines.push(locale === "zh" ? `音效：${joinList(audio.sfx!)}。` : `SFX: ${joinList(audio.sfx!)}.`);
    const score = localizePromptValue(audio.score, locale);
    const subs = audio.subtitles ? (locale === "zh" ? "烧录字幕" : "burned-in") : (locale === "zh" ? "无字幕" : "none");
    audioLines.push(locale === "zh" ? `配乐：${score}。字幕：${subs}。` : `Score: ${score}. Subtitles: ${subs}.`);
  }
  const voiceLines = renderVoiceLockLines(project, scene, locale);
  if (voiceLines.length > 0) audioLines.push(...voiceLines);
  if (audioLines.length === 1) return "";
  return audioLines.join("\n");
}

/** 镜头含对白讲出来的角色 → 其声音锁按 locale 逐字贴进 AUDIO 段（P5.3） */
function renderVoiceLockLines(project: ProjectV2, scene: SceneV2, locale: PromptLocale): string[] {
  const byId = new Map((project.assets ?? []).map((asset) => [asset.id, asset]));
  const speakers = new Set<string>();
  for (const shot of scene.shots ?? []) {
    for (const beat of shot.beats ?? []) {
      if (beat.dialogue?.trim() && beat.actorId) speakers.add(beat.actorId);
    }
  }
  const lines: string[] = [];
  for (const id of speakers) {
    const asset = byId.get(id);
    if (!asset || asset.kind !== "character") continue;
    const prof = asset.actingProfile;
    const voice = locale === "zh"
      ? (prof?.voicePromptZh?.trim() || prof?.voicePrompt?.trim())
      : (prof?.voicePrompt?.trim() || prof?.voicePromptZh?.trim());
    if (!voice) continue;
    const name = asset.name.trim() || asset.id;
    const punctuation = /[。．.!！?？]$/.test(voice) ? "" : (locale === "zh" ? "。" : ".");
    lines.push(locale === "zh" ? `声音锁（${name}）：${voice}${punctuation}` : `Voice lock (${name}): ${voice}${punctuation}`);
  }
  return lines;
}

/** 仅渲染声音锁，供导演分层与结构化检查器合并输出时复用。 */
export function renderVoiceLockSection(project: ProjectV2, scene: SceneV2, locale: PromptLocale = "zh"): string {
  const lines = renderVoiceLockLines(project, scene, locale);
  if (lines.length === 0) return "";
  return `${locale === "zh" ? "声音锁：" : "VOICE LOCKS:"}\n${lines.join("\n")}`;
}

/** 负面段（P0.3 双语 renderNegativeItems） */
export function renderNegativeSection(project: ProjectV2, locale: PromptLocale = "zh", enabled = true): string {
  if (!enabled) return "";
  const heading = promptLexicon(locale).headings.negative;
  const custom = project.negativePrompt?.trim();
  const items = custom
    ? custom.split(/[,，]/)
    : [...DEFAULT_NEGATIVE_IDS];
  // 内置 ID 走双语词条；自由文本按原文（不额外加前缀）
  const hasCustomFreeText = custom && items.some((item) => item.trim() && !item.trim().startsWith("不要") && !item.trim().startsWith("no ") && !item.trim().startsWith("禁止"));
  if (hasCustomFreeText) {
    // 混合场景：默认词 + 用户自由文本
    const defaults = renderDefaultNegative(locale).split(", ");
    return `${heading}:\n${[...defaults, ...items.map((i) => i.trim()).filter(Boolean)].join(locale === "zh" ? "，" : ", ")}`;
  }
  return `${heading}:\n${renderDefaultNegative(locale)}`;
}

/** 负面局部锁的分层结果：就近挂到宿主段，global 保留精简尾段（P0.3） */
export interface NegativeLocks {
  character: string[];
  physics: string[];
  lighting: string[];
  camera: string[];
  global: string[];
}

function renderPositiveLock(item: string, locale: PromptLocale): string {
  const canonical = canonicalNegativeId(item);
  if (!canonical) return item.trim();
  const zh = locale === "zh";
  const locks: Record<string, { zh: string; en: string }> = {
    "character-drift": {
      zh: "所有角色始终与活动引用中的身份锚一致",
      en: "every character remains consistent with the identity anchors in active references",
    },
    "wardrobe-changes": {
      zh: "服装在全段保持不变",
      en: "wardrobe remains unchanged throughout the sequence",
    },
    "extra-limbs": {
      zh: "每位角色仅保留一组正常、完整的肢体",
      en: "each character retains one anatomically normal, complete set of limbs",
    },
    "no-gravity-movement": {
      zh: "人物与物体遵循重力、重量和惯性",
      en: "people and objects obey gravity, weight and inertia",
    },
    "floating-props": {
      zh: "所有道具始终有明确的接触点、重量和位置",
      en: "every prop keeps an explicit contact point, weight and position",
    },
    "text-or-watermarks": {
      zh: "画面保持干净，不出现界面文字、logo 或水印",
      en: "the image stays clean with no interface text, logos or watermarks",
    },
  };
  return locks[canonical]?.[zh ? "zh" : "en"] ?? item.trim();
}

/**
 * 负面词局部锁（P0.3，替代 director 模式的整段负面）。
 * 读取 project.negativePrompt（自由文本或内置 ID），按类别拆到宿主：
 * - character → 身份强锁区（外观漂移 / 多余肢体）
 * - physics → PHYSICS（漂浮道具等）
 * - lighting / camera → 对应宿主段（P1 落位，现仅返回待宿主拼接）
 * - global → 身份漂移 / 悬浮运动 / 文字水印，保留精简尾段
 */
export function renderLocalLocks(project: ProjectV2, locale: PromptLocale = "zh"): NegativeLocks {
  const custom = project.negativePrompt?.trim();
  const items = custom
    ? custom.split(/[,，]/).map((item) => item.trim()).filter(Boolean)
    : [...DEFAULT_NEGATIVE_IDS];
  const locks: NegativeLocks = { character: [], physics: [], lighting: [], camera: [], global: [] };
  for (const item of items) {
    const category: NegativeCategory = classifyNegative(item);
    const canonical = canonicalNegativeId(item);
    const rendered = renderPositiveLock(canonical ?? item, locale);
    if (!rendered) continue;
    locks[category].push(rendered);
  }
  return locks;
}

/** 当前镜头引用的资产注册表（便捷函数） */
export function registryForShot(project: ProjectV2, scene: SceneV2, shot: ShotV2): AssetRegistry {
  return buildAssetRegistry(project, scene, shot);
}
