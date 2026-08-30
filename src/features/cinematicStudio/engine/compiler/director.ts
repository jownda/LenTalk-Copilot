/**
 * 导演级分段编译器（CINEDANCE V4 / P0.1）。
 * 与 legacy `compileProSequence` 的区别：
 * - 按导演分段顺序输出（SCENE CONTEXT → … → POSITIVE CONSTRAINTS）；
 * - 段头硬编码英文 canonical（进 i18n 待 P0 后续字段补齐）；
 * - 光线 / 物理从技术 Profile 拆出为优先级锁段；
 * - 负面词局部锁：就近挂到 PHYSICS / LIGHTING / POSITIVE CONSTRAINTS，仅全局失败模式保留精简尾段（P0.3）。
 */
import type { Asset, CameraBehavior, LightingDirection, ProjectV2, SceneV2, ShotV2 } from "../../shared-types";
import { assetCanonicalDescription } from "../asset-naming";
import { finalStyleDescription, getStyle, localizedStyleBrief } from "../styles";
import {
  buildAssetRegistry, buildSceneAssetRegistry, renderAxisBreakNote, renderCharacterCountLock, renderPropDefaults, renderStateChain, resolveCharacterOrder,
} from "./renderer";
import { renderLocalLocks, type PromptLocale, type ReferenceSyntax } from "./sections";
import { getCamera, getLens } from "../gear";
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
  { key: "physics", zh: "物理", en: "PHYSICS" },
  { key: "lighting", zh: "光线", en: "LIGHTING" },
  { key: "audio", zh: "音频", en: "AUDIO" },
  { key: "style", zh: "风格", en: "STYLE" },
  { key: "positiveConstraints", zh: "正向约束", en: "POSITIVE CONSTRAINTS" },
  { key: "negativeLocks", zh: "负面局部锁", en: "NEGATIVE LOCKS" },
] as const;

export type DirectorLayerKey = (typeof DIRECTOR_LAYERS)[number]["key"];
export const DIRECTOR_LAYER_ORDER: readonly DirectorLayerKey[] = DIRECTOR_LAYERS.map((layer) => layer.key);
const SHOT_EXECUTION_LAYER = { zh: "镜头执行", en: "SHOT EXECUTION" } as const;

export function directorLayerLabel(key: DirectorLayerKey, locale: "zh" | "en"): string {
  const found = DIRECTOR_LAYERS.find((layer) => layer.key === key);
  return found ? found[locale] : key;
}

/**
 * LOCATION MAP：把地点参考和结构化站位转换成可执行的空间地图。
 * 这里描述的是空间状态，不是参考图的构图；角色是否实际入镜仍由每个镜头的
 * participants 决定，避免把场景角色候选名单扩散到所有镜头。
 */
function renderLocationMap(project: ProjectV2, scene: SceneV2, locale: PromptLocale): string {
  const zh = locale === "zh";
  const staging = scene.staging ?? {};
  const assets = new Map((project.assets ?? []).map((asset) => [asset.id, asset]));
  const ref = (id: string) => assets.get(id)?.name?.trim() || id;
  const firstShot = scene.shots?.[0];
  const firstBehavior = firstShot?.cameraBehavior;
  const positionText = (value: string | undefined) => value?.trim() || "";
  const join = (items: string[]) => items.filter(Boolean).join(zh ? "；" : "; ");
  const cameraPosition = [
    firstBehavior?.height ? `${zh ? "高度" : "height"} ${firstBehavior.height.trim()}` : "",
    firstBehavior?.distance ? `${zh ? "距离" : "distance"} ${firstBehavior.distance.trim()}` : "",
    firstBehavior?.side ? `${zh ? "位于" : "on"} ${firstBehavior.side.trim()}` : "",
  ];
  const cameraFacing = [
    firstBehavior?.angle ? `${zh ? "角度" : "angle"} ${firstBehavior.angle.trim()}` : "",
    firstBehavior?.screenPlacement ? `${zh ? "主体落在" : "subject placement"} ${firstBehavior.screenPlacement.trim()}` : "",
    staging.axisDirection
      ? (zh ? `沿${staging.axisDirection === "left-to-right" ? "左到右" : "右到左"}屏幕轴观察` : `observe along the ${staging.axisDirection} screen axis`)
      : "",
  ];
  const stagedCharacterNames = (staging.characterOrder ?? [])
    .map((id) => assets.get(id)?.name?.trim() || id)
    .filter(Boolean);
  const participantBuckets = { foreground: [] as string[], midground: [] as string[], background: [] as string[] };
  const shotOverrides: string[] = [];
  for (const [index, shot] of (scene.shots ?? []).entries()) {
    const participantIds = new Set((shot.participants ?? []).map((participant) => participant.characterId));
    const orderedParticipantIds = resolveCharacterOrder(scene, shot).filter((id) => participantIds.has(id));
    const participants = orderedParticipantIds.flatMap((id) => {
      const participant = shot.participants?.find((item) => item.characterId === id);
      return participant && assets.get(participant.characterId)?.kind === "character" ? [participant] : [];
    });
    for (const participant of participants) {
      const name = assets.get(participant.characterId)?.name?.trim() || participant.characterId;
      const position = positionText(participant.position).toLowerCase();
      const bucket = position.includes("front") || position.includes("前") ? "foreground"
        : position.includes("back") || position.includes("后") ? "background" : "midground";
      participantBuckets[bucket].push(name);
    }
    const localPositions = participants.map((participant) => {
      const name = assets.get(participant.characterId)?.name?.trim() || participant.characterId;
      const detail = [
        participant.position ? (zh ? `位置：${participant.position.trim()}` : `position: ${participant.position.trim()}`) : "",
        participant.facing ? (zh ? `朝向：${participant.facing.trim()}` : `facing: ${participant.facing.trim()}`) : "",
        participant.torsoFacing ? (zh ? `身体朝向：${participant.torsoFacing.trim()}` : `torso facing: ${participant.torsoFacing.trim()}`) : "",
        participant.eyeline ? (zh ? `视线：${participant.eyeline.trim()}` : `eyeline: ${participant.eyeline.trim()}`) : "",
        participant.anchorDistance ? (zh ? `距离锚点：${participant.anchorDistance.trim()}` : `anchor distance: ${participant.anchorDistance.trim()}`) : "",
      ].filter(Boolean).join(zh ? "，" : ", ");
      return detail ? `${name}（${detail}）` : name;
    });
    if (localPositions.length > 0) shotOverrides.push(`${zh ? `镜头${index + 1}` : `shot ${index + 1}`}: ${localPositions.join(zh ? "、" : ", ")}`);
  }
  const unique = (items: string[]) => [...new Set(items)];
  const foreground = unique(participantBuckets.foreground);
  const midground = unique(participantBuckets.midground);
  const background = unique(participantBuckets.background);
  const landmark = staging.anchorDescription?.trim();
  const movement = [
    staging.axisDirection
      ? (zh ? `沿${staging.axisDirection === "left-to-right" ? "左到右" : "右到左"}轴向移动` : `move along the ${staging.axisDirection} axis`)
      : "",
    ...(scene.shots ?? []).filter((shot) => shot.movement?.trim() && shot.movement.toLowerCase() !== "static").map((shot, index) => zh
      ? `镜头${index + 1}的镜头路径为${shot.movement.trim()}`
      : `shot ${index + 1} camera path: ${shot.movement.trim()}`),
    ...(scene.shots ?? []).flatMap((shot, index) => (shot.participants ?? []).filter((participant) => participant.entrance && participant.entrance !== "already-in-frame").map((participant) => {
      const name = assets.get(participant.characterId)?.name?.trim() || participant.characterId;
      const entrance = participant.entrance === "enters-left" ? (zh ? "从左侧入画" : "enters from left") : (zh ? "从右侧入画" : "enters from right");
      return zh ? `镜头${index + 1}中${name}${entrance}` : `${name} ${entrance} in shot ${index + 1}`;
    })),
  ];
  const lightDirection = scene.lightingDirection?.direction?.trim();
  const lightSource = scene.lightingDirection?.primarySource?.trim() || scene.lighting?.trim();
  const depth = [
    staging.spacing?.trim() ? (zh ? `人物间距：${staging.spacing.trim()}` : `character spacing: ${staging.spacing.trim()}`) : "",
    firstBehavior?.depthOfField?.trim() ? (zh ? firstBehavior.depthOfField.trim() : firstBehavior.depthOfField.trim()) : "",
    firstBehavior?.focusBehavior?.trim() ? (zh ? `焦点关系：${firstBehavior.focusBehavior.trim()}` : `focus relationship: ${firstBehavior.focusBehavior.trim()}`) : "",
  ];
  const lines: string[] = [];
  if (staging.locationAssetId) lines.push(zh ? `地点参考：${ref(staging.locationAssetId)}` : `Location reference: ${ref(staging.locationAssetId)}`);
  if (staging.locationAssetId) lines.push(zh
    ? "空间基准：使用地点参考的真实地理关系、材质、地标和相关光线方向；不继承参考图的相机角度、取景或构图。"
    : "Spatial basis: use the location reference for geography, materials, landmarks and relevant light direction; do not inherit its camera angle, framing or composition.");
  if (cameraPosition.some(Boolean)) lines.push(zh ? `相机位置：${join(cameraPosition)}` : `Camera position: ${join(cameraPosition)}`);
  if (cameraFacing.some(Boolean)) lines.push(zh ? `相机朝向：${join(cameraFacing)}` : `Camera facing: ${join(cameraFacing)}`);
  if (foreground.length > 0) lines.push(zh ? `前景：${foreground.join("、")}` : `Foreground: ${foreground.join(", ")}`);
  if (midground.length > 0) lines.push(zh ? `中景：${midground.join("、")}` : `Midground: ${midground.join(", ")}`);
  if (background.length > 0) lines.push(zh ? `后景：${background.join("、")}` : `Background: ${background.join(", ")}`);
  if (landmark) lines.push(zh ? `主要地标位置：${landmark}` : `Main landmark positions: ${landmark}`);
  if (stagedCharacterNames.length > 0) lines.push(zh
    ? `场景人物基准位置（仅作空间参考，实际入镜以各镜头参与者为准）：从画面左到右为${stagedCharacterNames.join("、")}`
    : `Scene character baseline (spatial reference only; actual presence follows each shot's participants): left to right ${stagedCharacterNames.join(", ")}`);
  if (shotOverrides.length > 0) lines.push(zh ? `镜头人物位置覆盖：${shotOverrides.join("；")}` : `Shot-level character position overrides: ${shotOverrides.join("; ")}`);
  if (movement.some(Boolean)) lines.push(zh ? `移动路径：${join(movement)}` : `Movement path: ${join(movement)}`);
  if (lightSource || lightDirection) lines.push(zh
    ? `光线方向：${[lightSource ? `主光源为${lightSource}` : "", lightDirection ? `方向为${lightDirection}` : ""].filter(Boolean).join("，")}`
    : `Lighting direction: ${[lightSource ? `source ${lightSource}` : "", lightDirection ? `direction ${lightDirection}` : ""].filter(Boolean).join(", ")}`);
  if (depth.some(Boolean)) lines.push(zh ? `景深关系：${join(depth)}` : `Depth relationships: ${join(depth)}`);
  if (staging.spacing?.trim()) lines.push(zh ? `间距：${staging.spacing.trim()}` : `Spacing: ${staging.spacing.trim()}`);
  if (staging.axisDirection) lines.push(zh
    ? `屏幕方向：${staging.axisDirection === "left-to-right" ? "从左到右" : "从右到左"}`
    : `Screen direction: ${staging.axisDirection}`);
  return lines.join("\n");
}

/** Each reference is introduced under the first shot that actually needs it. */
function renderActiveReferences(project: ProjectV2, scene: SceneV2, locale: PromptLocale, syntax: ReferenceSyntax): string {
  const zh = locale === "zh";
  const seenAssetIds = new Set<string>();
  let imageIndex = 0;
  let audioIndex = 0;
  const profileText = (asset: Asset, key: "masterProfile" | "voicePrompt") => {
    const profile = asset.actingProfile;
    if (key === "masterProfile") {
      return zh
        ? (profile?.masterProfileZh?.trim() || profile?.masterProfile?.trim() || "")
        : (profile?.masterProfile?.trim() || profile?.masterProfileZh?.trim() || "");
    }
    return zh
      ? (profile?.voicePromptZh?.trim() || profile?.voicePrompt?.trim() || "")
      : (profile?.voicePrompt?.trim() || profile?.voicePromptZh?.trim() || "");
  };
  const renderReferenceLines = (shot: ShotV2) => {
    const registry = buildAssetRegistry(project, scene, shot);
    return registry.orderedAssets.flatMap((asset) => {
    if (seenAssetIds.has(asset.id)) return [];
    seenAssetIds.add(asset.id);
    const referenceName = asset.referenceTag?.trim() || asset.name.trim() || asset.id;
    const tag = syntax === "plain-text" ? referenceName : `@${referenceName}`;
    const displayName = asset.name.trim() || asset.id;
    const description = assetCanonicalDescription(asset, locale);
    const nameAndDescription = description === displayName
      ? displayName
      : `${displayName}${zh ? "，" : " — "}${description}`;
    const normalizeForComparison = (value: string) => value.toLocaleLowerCase()
      .replace(/[\s，,；;。.!！?？:："'“”‘’（）()-]/g, "")
      .replace(/有一道|有个|一个|一条|的/g, "");
    const descriptionKey = normalizeForComparison(description);
    const anchors = asset.lockLevel === "strict"
      ? [...new Set([...(asset.uniqueMarkers ?? []), ...(asset.alwaysVisible ?? [])]
        .map((item) => item.trim())
        .filter((item) => item && !descriptionKey.includes(normalizeForComparison(item))))]
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
    const acting = asset.kind === "character" ? profileText(asset, "masterProfile") : "";
    const voiceLock = asset.kind === "character" ? profileText(asset, "voicePrompt") : "";
    const actingToken = acting ? (zh ? `；表演模板：${acting}` : `; Acting template: ${acting}`) : "";
    const voiceLockToken = voiceLock ? (zh ? `；声音锁：${voiceLock}` : `; Voice lock: ${voiceLock}`) : "";
    const voiceToken = asset.voiceClip?.trim()
      ? (zh ? `；声音参考：@audio${++audioIndex}` : `; Voice reference: @audio${++audioIndex}`)
      : "";
    return [zh
      ? `${tag}${imageToken}：${nameAndDescription}${anchorText}${locationScope}${propScope}${actingToken}${voiceLockToken}${voiceToken}。`
      : `${tag}${imageToken}: ${nameAndDescription}${anchorText}${locationScope}${propScope}${actingToken}${voiceLockToken}${voiceToken}.`];
    }).join("\n");
  };
  return scene.shots
    .map((shot, index) => {
      const lines = renderReferenceLines(shot);
      if (!lines) return "";
      const prefix = zh ? `镜头 ${index + 1}（${shot.label}）` : `SHOT ${index + 1} (${shot.label})`;
      return `${prefix}:\n${lines}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

function push(list: string[], header: string, body: string): void {
  if (!body?.trim()) return;
  const separator = /^[\u0020-\u007E\s]+$/.test(header) ? ":" : "：";
  list.push(header ? `${header}${/[：:]$/.test(header) ? "" : separator}\n${body.trim()}` : body.trim());
}

/** 场景上下文：AI 层文本可能自带段头，统一剥掉只保留正文。 */
function stripSceneContextHeading(text: string): string {
  return text
    .replace(/^\s*(?:场景上下文|场景语境|SCENE CONTEXT)\s*[:：]\s*/i, "")
    .trim();
}

/** 场景上下文中出现规划类元信息即视为不可导出，回退到结构化事实。 */
function hasPlanningMeta(text: string): boolean {
  return /前情|故事梗概|梗概|上集|回顾|continuity|连续性问题|连续性：|警告|warning|AI\s*编译|编译说明|user reference|logline|prior context|previous episode|评分|参考/iu.test(text);
}

/** 场景语境是面向当前界面的成片文本；不让另一种语言的自由文本穿透回退。 */
function hasLocaleMismatch(text: string, locale: PromptLocale): boolean {
  return locale === "zh" ? /[A-Za-z]{2,}/.test(text) : /[\u3400-\u9fff]/.test(text);
}

function localeText(value: string | undefined, locale: PromptLocale): string {
  const text = value?.trim() ?? "";
  return text && !hasLocaleMismatch(text, locale) ? text : "";
}

function durationText(value: string | undefined, locale: PromptLocale): string {
  const text = value?.trim() ?? "";
  const match = text.match(/\d+(?:\.\d+)?/);
  if (!match) return locale === "zh" ? text : "";
  return locale === "zh" ? `${match[0]}秒` : `${match[0]} seconds`;
}

function firstSentence(value: string): string {
  return value.split(/[。！？.!?]/, 1)[0]?.trim() ?? "";
}

function countSceneContextSentences(text: string): number {
  if (!text.trim()) return 0;
  const ends = (text.match(/[。！？]/g) ?? []).length + (text.match(/[.!?](?![0-9])/g) ?? []).length;
  return ends + (/[。！？.!?]$/.test(text.trim()) ? 0 : 1);
}

/** 取第一个可见动作：优先首镜首节拍，其次首镜动作。 */
function firstVisibleAction(scene: SceneV2): string | undefined {
  for (const shot of scene.shots ?? []) {
    const beat = [...(shot.beats ?? [])]
      .sort((a, b) => a.order - b.order)
      .find((item) => item.actionText?.trim() || item.verb?.trim());
    const text = beat?.actionText?.trim() || beat?.verb?.trim();
    if (text) return text;
    if (shot.action?.trim()) return shot.action.trim();
  }
  return undefined;
}

/**
 * P0 场景上下文：最终提示词第一段。
 * 优先使用 AI 生成的 sceneContext（剥掉段头、剔除规划元信息）；
 * 无可用内容时从结构化数据确定性回退：场景名 + 总时长 + 地点/时间/天气 + 首帧参与角色 + 第一个可见动作。
 * 绝不允许使用用户前情/故事梗概原文。
 */
function renderSceneContext(project: ProjectV2, scene: SceneV2, locale: PromptLocale): string {
  const zh = locale === "zh";
  const explicit = stripSceneContextHeading(scene.sceneContext?.trim() ?? "");
  if (explicit && !hasPlanningMeta(explicit) && !hasLocaleMismatch(explicit, locale)
    && countSceneContextSentences(explicit) <= 3) return explicit;

  const facts: string[] = [];
  const name = localeText(scene.name, locale);
  const duration = durationText(scene.duration, locale);
  const opening = [name, duration].filter(Boolean).join(zh ? "，" : ", ");
  if (opening) facts.push(zh ? `${opening}。` : `${opening}.`);
  const where = [scene.location, scene.time, scene.weather].map((value) => localeText(value, locale)).filter(Boolean).join(zh ? "，" : ", ");
  if (where) facts.push(zh ? `发生在${where}。` : `It takes place in ${where}.`);
  const firstShot = scene.shots?.[0];
  const visibleIds = firstShot?.participants?.map((participant) => participant.characterId).filter(Boolean)
    ?? (firstShot?.characterId ? [firstShot.characterId] : []);
  const byId = new Map((project.assets ?? []).map((asset) => [asset.id, asset]));
  const visible = visibleIds.map((id) => localeText(byId.get(id)?.name, locale)).filter(Boolean);
  const visibleText = visible.length > 0
    ? (zh ? `画面内有：${visible.join("、")}` : `In frame: ${visible.join(", ")}`)
    : (zh ? "画面内有主要角色" : "The visible characters are in frame");
  const firstAction = localeText(firstSentence(firstVisibleAction(scene) ?? ""), locale);
  facts.push(`${visibleText}${firstAction ? (zh ? `，${firstAction}` : `, ${firstAction}`) : ""}${zh ? "。" : "."}`);
  return facts.join(zh ? "" : " ");
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
    const lens = getLens(shot.lensModel);
    const lensText = lens
      ? (zh ? `镜头型号：${lens.brand} ${lens.model}（${lens.focal}；${lens.effect}）` : `lens model: ${lens.brand} ${lens.model} (${lens.focal}; ${lens.effect})`)
      : "";
    return [base, outcomeText, lensText].filter(Boolean).join(zh ? "；" : ". ");
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
  return lines.join("\n");
}

/** P1.3 CAMERA 层：物理操作员行为与有意越轴指令。 */
function renderCameraLayer(scene: SceneV2, locale: PromptLocale): string {
  const allShots = scene.shots ?? [];
  const hasCameraInstructions = (shot: ShotV2) => Boolean(
    shot.camera || shot.lensModel || shot.cameraBehavior || shot.layout?.intentionalAxisBreak,
  );
  const shots = scene.shootingMode === "long-take"
    ? allShots.slice(0, 1).filter(hasCameraInstructions)
    : allShots.filter(hasCameraInstructions);
  if (shots.length === 0) return "";
  const zh = locale === "zh";
  const fields: [keyof CameraBehavior, string][] = [
    ["height", "高度"], ["distance", "距离"], ["angle", "角度"], ["side", "机位边"],
    ["subjectSize", "画面大小"], ["screenPlacement", "画面位置"], ["focusBehavior", "对焦"],
    ["depthOfField", "景深"], ["handheldQuality", "手持质感"],
  ];
  const render = (shot: ShotV2): string => {
    const parts: string[] = [];
    const behavior = shot.cameraBehavior ?? {};
    const camera = getCamera(shot.camera);
    if (camera) parts.push(zh ? `相机型号：${camera.brand} ${camera.model}（${camera.effect}）` : `camera model: ${camera.brand} ${camera.model} (${camera.effect})`);
    for (const [key, zhLabel] of fields) {
      const value = behavior[key]?.trim();
      if (value) parts.push(zh ? `${zhLabel}：${value}` : `${key}: ${value}`);
    }
    const axisBreak = renderAxisBreakNote(shot, locale);
    if (axisBreak) parts.push(axisBreak);
    return parts.join(zh ? "；" : "; ");
  };
  if (scene.shootingMode === "long-take") {
    return scene.shots[0] ? render(scene.shots[0]) : "";
  }
  return shots.map((shot) => `${zh ? "镜头" : "SHOT"} ${shot.label}：${render(shot)}`).join("\n");
}

/** P1.4 首帧占位锁：确保首帧已含所有必需主体，无空镜开场。 */
function renderFirstFrameLayer(project: ProjectV2, scene: SceneV2, locale: PromptLocale): string {
  const lock = scene.firstFrameLock;
  if (!lock) return "";
  const zh = locale === "zh";
  const body = lock.occupancyStatement?.trim() || (zh
    ? "第一帧已包含所有必需主体，且处于正确位置。无空镜建立镜头。无延迟角色亮相。首帧不得缺少必需主体。空间关系在第一帧立即可读。"
    : "The first visible frame already contains all required subjects in their correct positions. No empty establishing frame. No delayed character reveal. No opening frame without the required subjects. The spatial relationship is readable immediately in frame one.");
  const activeAssetImageCount = buildSceneAssetRegistry(project, scene).orderedAssets
    .filter((asset) => asset.referencePaths?.[0]?.trim()).length;
  const referenceImages = (lock.referenceImages ?? []).map((source) => source.trim()).filter(Boolean);
  if (referenceImages.length === 0) return body;
  const tokens = referenceImages.map((_, index) => `[image${activeAssetImageCount + index + 1}]`).join(zh ? "、" : ", ");
  return `${body}\n${zh ? `首帧参考图：${tokens}` : `First-frame reference images: ${tokens}`}`;
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
  syntax: ReferenceSyntax,
  shotTimes: Map<string, { startSeconds: number; endSeconds: number }>,
): string {
  const zh = locale === "zh";
  const assetById = new Map((project.assets ?? []).map((asset) => [asset.id, asset]));
  const displayName = (id: string) => assetById.get(id)?.name?.trim() || id;
  const fmt = (sec: number) => {
    const total = Math.round(sec);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  };
  const characterReference = (id: string) => {
    const asset = assetById.get(id);
    if (!asset) return id;
    if (syntax !== "plain-text") return `@${asset.referenceTag?.trim() || asset.name.trim() || asset.id}`;
    return asset.name.trim() || asset.id;
  };
  const fragment = (text: string) => text.trim().replace(/[。．.!！?？][”」』)）"']?$/, "");
  const renderShotDetails = (shot: ShotV2): string[] => {
    const beats = [...(shot.beats ?? [])].sort((a, b) => a.order - b.order);
    const participants = shot.participants ?? [];
    const participantIds = new Set(participants.map((participant) => participant.characterId));
    const actorIds = [...new Set([
      ...participants.map((participant) => participant.characterId),
      ...beats.map((beat) => beat.actorId).filter((id): id is string => typeof id === "string" && participantIds.has(id)),
    ])];
    const generalDetails = [shot.acting?.trim(), shot.eyeLife?.trim()].filter(Boolean).map((value) => fragment(value!));
    const actionFallback = beats.length === 0 && shot.action?.trim() ? fragment(shot.action) : "";
    const lines: string[] = [];

    if (shot.propChangeDescription?.trim()) lines.push(zh
      ? `道具变化：${fragment(shot.propChangeDescription)}`
      : `Prop changes: ${fragment(shot.propChangeDescription)}`);
    lines.push(...renderStateChain(project, shot, locale, syntax));

    for (const actorId of actorIds) {
      const participant = participants.find((item) => item.characterId === actorId);
      const parts: string[] = [];
      if (generalDetails.length > 0 && actorId === actorIds[0]) parts.push(...generalDetails);
      if (participant?.acting?.trim()) parts.push(fragment(participant.acting));
      if (participant?.eyeLife?.trim()) parts.push(fragment(participant.eyeLife));
      for (const beat of beats.filter((item) => item.actorId === actorId)) {
        const action = beat.actionText?.trim() || beat.verb?.trim();
        const targetId = beat.targetCharacterId ?? beat.targetPropId;
        const target = targetId && targetId !== actorId ? displayName(targetId) : "";
        if (action) parts.push(fragment(action));
        if (target) parts.push(zh ? `朝向${target}` : `toward ${target}`);
        if (beat.targetBodyPart?.trim()) parts.push(zh ? `目标部位：${fragment(beat.targetBodyPart)}` : `target body part: ${fragment(beat.targetBodyPart)}`);
        if (beat.duration != null && beat.duration > 0) parts.push(zh ? `节拍时长：${beat.duration}秒` : `beat duration: ${beat.duration}s`);
        if (beat.tactic?.trim()) parts.push(zh ? `策略：${fragment(beat.tactic)}` : `tactic: ${fragment(beat.tactic)}`);
        if (beat.subtext?.trim()) parts.push(zh ? `潜台词：${fragment(beat.subtext)}` : `subtext: ${fragment(beat.subtext)}`);
        if (beat.beatChange?.trim()) parts.push(fragment(beat.beatChange));
        if (beat.reactionBeforeLine?.trim()) parts.push(fragment(beat.reactionBeforeLine));
        if (beat.dialogue?.trim()) parts.push(zh ? `说：“${beat.dialogue.trim()}”` : `says, "${beat.dialogue.trim()}"`);
        if (beat.required) parts.push(zh ? "必须发生" : "MUST occur");
        const forbidden = (beat.forbiddenTargets ?? []).filter((id) => id !== targetId).map(displayName);
        if (forbidden.length > 0) parts.push(zh ? `禁止目标：${forbidden.join("、")}` : `never target: ${forbidden.join(", ")}`);
        if (beat.cutRule?.trim()) parts.push(zh ? `剪辑规则：${fragment(beat.cutRule)}` : `cut rule: ${fragment(beat.cutRule)}`);
        if (beat.note?.trim()) parts.push(zh ? `备注：${fragment(beat.note)}` : `note: ${fragment(beat.note)}`);
      }
      if (actionFallback && actorId === actorIds[0]) parts.push(actionFallback);
      if (parts.length > 0) lines.push(`${characterReference(actorId)}${zh ? "：" : ": "}${parts.join(zh ? "；" : " ")}${zh ? "。" : "."}`);
    }

    if (lines.length === 0) {
      const fallback = [...generalDetails, actionFallback].filter(Boolean);
      if (fallback.length > 0) lines.push(`${zh ? "镜头保持" : "The shot holds"}${zh ? "：" : ": "}${fallback.join(zh ? "；" : " ")}${zh ? "。" : "."}`);
    }
    return lines;
  };

  const blocks: string[] = [];
  for (const [index, shot] of (scene.shots ?? []).entries()) {
    const time = shotTimes.get(shot.id);
    if (!time) continue;
    const details = renderShotDetails(shot);
    const range = `${fmt(time.startSeconds)}${zh ? "–" : "-"}${fmt(time.endSeconds)}`;
    const prefix = scene.shootingMode === "multi-shot"
      ? (zh ? `镜头 ${index + 1} ${range}：` : `SHOT ${index + 1} ${range}:`)
      : (zh ? `${range}：` : `${range}:`);
    const cut = index > 0 && scene.shootingMode === "multi-shot"
      ? ({
          "hard-cut": zh ? `硬切进入镜头 ${index + 1}；` : `Hard cut into shot ${index + 1}; `,
          "match-cut": zh ? `动作匹配剪辑进入镜头 ${index + 1}；` : `Match cut into shot ${index + 1}; `,
          overlap: zh ? `以声音或动作重叠进入镜头 ${index + 1}；` : `Enter shot ${index + 1} on sound or action overlap; `,
        }[shot.cutStyle ?? scene.cutStyleDefault ?? "hard-cut"])
      : "";
    blocks.push(`${prefix}${cut}${details.length > 0 ? `\n${details.join("\n")}` : ""}`);
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

/** STYLE：只承接导演/画面风格，不重复 OPTICS、CAMERA 和 LIGHTING 的执行锁。 */
function renderStyleLayer(project: ProjectV2, locale: PromptLocale): string {
  const style = getStyle(project.styleId);
  const brief = localizedStyleBrief(project, locale).trim();
  const detail = style ? finalStyleDescription(style, locale) : brief;
  if (!detail) return "";
  if (!style) return detail;
  return locale === "zh"
    ? `${style.nameZh}风格：${detail}`
    : `${style.name} style: ${detail}`;
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
  push(sections, header("sceneContext"), renderSceneContext(project, scene, locale));
  push(sections, header("activeReferences"), renderActiveReferences(project, scene, locale, syntax));

  push(sections, header("locationMap"), renderLocationMap(project, scene, locale));

  push(sections, header("firstFrame"), renderFirstFrameLayer(project, scene, locale));

  // FORMAT MODE：长镜头 = 单连续镜头；多镜头 = 受控多镜序列。
  push(sections, header("formatMode"), scene.shootingMode === "multi-shot"
    ? (locale === "zh" ? "受控多镜头序列；仅在明确镜头边界处切换。" : "CONTROLLED MULTI-SHOT SEQUENCE. Cut only at explicit shot boundaries.")
    : (locale === "zh" ? "单一连续长镜头；全段保持同一摄影机、FOV 与轴线。" : "SINGLE CONTINUOUS TAKE. Keep one camera, FOV and screen axis throughout."));

  push(sections, header("optics"), renderOpticsLayer(scene, locale));
  push(sections, header("camera"), renderCameraLayer(scene, locale));
  // Shot execution is compiled only from structured shots, beats, and
  // participants. It is intentionally not an editable director-document layer.
  push(sections, SHOT_EXECUTION_LAYER[locale], renderShotExecutionLayer(project, scene, locale, syntax, shotTimes));

  // PHYSICS / LIGHTING 优先级锁（正向先写，负向骨折就近内联）。
  const physicsBits = [locks.physics.join(locale === "zh" ? "；" : "; "), ...renderPhysicsAnchors(scene, locale)].filter(Boolean);
  push(sections, header("physics"), physicsBits.join(locale === "zh" ? "；" : "; "));
  const lightingBits = [renderLightingDirection(scene.lightingDirection, locale), locks.lighting.join(locale === "zh" ? "；" : "; ")].filter(Boolean);
  push(sections, header("lighting"), lightingBits.join(locale === "zh" ? "；" : "; "));

  if (options.audioEnabled !== false) push(sections, header("audio"), renderDialogueSoundLayer(project, scene, locale));
  push(sections, header("style"), renderStyleLayer(project, locale));
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

/**
 * Rebuild the editable, scene-level director document from structured data.
 * SHOT EXECUTION is deliberately excluded: it belongs to the shot execution
 * module, where actions and per-character acting remain editable together.
 */
export function buildDirectorDocumentLayers(
  project: ProjectV2,
  scene: SceneV2,
  options: DirectorOptions = {},
): Partial<Record<DirectorLayerKey, string>> {
  const locale: PromptLocale = options.locale ?? "zh";
  const source = compileDirectorSequence(project, scene, options);
  const labels = [
    ...DIRECTOR_LAYERS.map((layer) => ({ key: layer.key, label: layer[locale] })),
    { key: undefined, label: SHOT_EXECUTION_LAYER[locale] },
  ];
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const starts = labels.flatMap(({ key, label }) => {
    const match = new RegExp(`(?:^|\\n\\n)${escape(label)}[：:]\\n`, "m").exec(source);
    return match ? [{ key, bodyStart: match.index + match[0].length, sectionStart: match.index }] : [];
  }).sort((a, b) => a.sectionStart - b.sectionStart);
  const layers: Partial<Record<DirectorLayerKey, string>> = {};
  for (const [index, section] of starts.entries()) {
    if (!section.key) continue;
    const body = source.slice(section.bodyStart, starts[index + 1]?.sectionStart).trim();
    if (body) layers[section.key] = body;
  }
  return layers;
}
