/**
 * 导演级分段编译器（CINEDANCE V4 / P0.1）。
 * 与 legacy `compileProSequence` 的区别：
 * - 按导演分段顺序输出（ACTIVE REFERENCES → … → POSITIVE CONSTRAINTS）；
 * - 段头硬编码英文 canonical（进 i18n 待 P0 后续字段补齐）；
 * - 光线 / 物理从技术 Profile 拆出为优先级锁段；
 * - 负面词局部锁：就近挂到 PHYSICS / LIGHTING / POSITIVE CONSTRAINTS，仅全局失败模式保留精简尾段（P0.3）。
 */
import type { ActionBeat, CameraBehavior, LightingDirection, ProjectV2, SceneV2, ShotV2 } from "../../shared-types";
import { assetCanonicalDescription } from "../asset-naming";
import { finalStyleDescription, getStyle, localizedStyleBrief } from "../styles";
import {
  buildSceneAssetRegistry, renderAxisBreakNote, renderCharacterCountLock, renderPropDefaults,
} from "./renderer";
import { localizePromptValue } from "../i18n/lexicon";
import { renderLocalLocks, type PromptLocale, type ReferenceSyntax } from "./sections";
import { getCamera, getLens } from "../gear";
import { legacyFocalLengthToFov, lensById, lensByFov, physicsAnchorById } from "../presets";
import { auditFinalPromptWithProject, createFinalPromptDocument, normalizeOpticsText, sanitizeDirectorText } from "../quality";
import { extractFirstPersonPovLock, renderFirstPersonPovLock } from "../story-supplement";

export interface DirectorOptions {
  syntax?: ReferenceSyntax;
  locale?: PromptLocale;
  audioEnabled?: boolean;
}

/**
 * 导演文档分层（P0.5）：canonical 层序 + 双语标题。
 * 层 key 稳定，供本地编译器 / UI 编辑 / 最终生成三处共用。
 * 每个 directorLayers[key] 的值是「含段头在内的完整文本块」。
 */
export const DIRECTOR_LAYERS = [
  { key: "activeReferences", zh: "活动引用", en: "ACTIVE REFERENCES" },
  { key: "locationMap", zh: "场景地图和站位", en: "SCENE MAP AND STAGING" },
  { key: "formatMode", zh: "格式模式", en: "FORMAT MODE" },
  { key: "optics", zh: "光学", en: "OPTICS" },
  { key: "camera", zh: "相机", en: "CAMERA" },
  { key: "performance", zh: "表演", en: "PERFORMANCE" },
  { key: "physics", zh: "物理", en: "PHYSICS" },
  { key: "lighting", zh: "光线", en: "LIGHTING" },
  { key: "audio", zh: "音频", en: "AUDIO" },
  { key: "style", zh: "风格", en: "STYLE" },
  { key: "positiveConstraints", zh: "正向约束", en: "POSITIVE CONSTRAINTS" },
  { key: "negativeLocks", zh: "负面局部锁", en: "NEGATIVE LOCKS" },
] as const;

export type DirectorLayerKey = (typeof DIRECTOR_LAYERS)[number]["key"];
export const DIRECTOR_LAYER_ORDER: readonly DirectorLayerKey[] = DIRECTOR_LAYERS.map((layer) => layer.key);
/** 只在最终生成时根据结构化分镜和资产库重建，不作为导演文档的填写层。
 *  camera 也在此列：型号/行为来自镜头检查器的结构化字段（shot.camera 等），
 *  若沿用规划时预填的快照，用户之后手动选择的相机型号将永远进不了最终提示词。 */
export const FINAL_GENERATED_DIRECTOR_LAYER_KEYS: ReadonlySet<DirectorLayerKey> = new Set(["activeReferences", "optics", "camera", "performance"]);
const SHOT_EXECUTION_LAYER = { zh: "镜头执行", en: "SHOT EXECUTION" } as const;

export function directorLayerLabel(key: DirectorLayerKey, locale: "zh" | "en"): string {
  const found = DIRECTOR_LAYERS.find((layer) => layer.key === key);
  return found ? found[locale] : key;
}

/** 台词或非语言人声事件（叹息、喘息、笑、哭、咳嗽等）会被模型听到。 */
const VOCAL_AUDIO_RE = /叹息|喘息|呼吸|呻吟|喊|叫|笑|哭|咳嗽|哼|sigh|breath|groan|shout|yell|laugh|cry|cough|hum/i;

/** 去掉句尾标点：段内用「；」拼接，末尾标点由该行统一补，避免出现「。。」。 */
const fragment = (text: string) => text.trim().replace(/[。．.!！?？][”」』)）"']?$/, "");

/**
 * LOCATION MAP：输出一份场景级空间总图，不重复任何镜头的站位、入画或路径。
 * 具体人物出镜和变化只由镜头执行与动作节奏描述。
 */
function renderLocationMap(project: ProjectV2, scene: SceneV2, locale: PromptLocale): string {
  const zh = locale === "zh";
  const staging = scene.staging ?? {};
  const assets = new Map((project.assets ?? []).map((asset) => [asset.id, asset]));
  const imageTokensByAssetId = buildSceneImageTokenMap(project, scene);
  // 资产引用统一带 @ 与 [imageN]：与活动引用一致，避免最终生成时人物/地点裸名与带图引用混杂。
  const ref = (id: string) => {
    const asset = assets.get(id);
    if (!asset) return id;
    const referenceName = asset.referenceTag?.trim() || asset.name.trim() || asset.id;
    const imageToken = imageTokensByAssetId.get(id);
    return `@${referenceName}${imageToken ? ` ${imageToken}` : ""}`;
  };
  const firstShot = scene.shots?.[0];
  const firstBehavior = firstShot?.cameraBehavior;
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
    .map((id) => ref(id))
    .filter(Boolean);
  const landmark = staging.anchorDescription?.trim();
  const movement = [
    staging.axisDirection
      ? (zh ? `沿${staging.axisDirection === "left-to-right" ? "左到右" : "右到左"}轴向移动` : `move along the ${staging.axisDirection} axis`)
      : "",
  ];
  const lightDirection = scene.lightingDirection?.direction?.trim();
  const lightSource = scene.lightingDirection?.primarySource?.trim() || scene.lighting?.trim();
  const stagingImageToken = stagingReferenceImageToken(project, scene);
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
  if (stagingImageToken) lines.push(zh
    ? `站位参考图：${stagingImageToken}；仅用于人物位置、180°轴方向、人物间距、从左到右排序和空间锚点，不控制地点材质、光线、氛围、机位或取景。`
    : `Staging reference image: ${stagingImageToken}; controls character positions, the 180-degree axis, spacing, left-to-right order and spatial anchors only, not location materials, lighting, atmosphere, camera position or framing.`);
  if (cameraPosition.some(Boolean)) lines.push(zh ? `相机位置：${join(cameraPosition)}` : `Camera position: ${join(cameraPosition)}`);
  if (cameraFacing.some(Boolean)) lines.push(zh ? `相机朝向：${join(cameraFacing)}` : `Camera facing: ${join(cameraFacing)}`);
  if (landmark) lines.push(zh ? `主要地标位置：${landmark}` : `Main landmark positions: ${landmark}`);
  if (stagedCharacterNames.length > 0) lines.push(zh
    ? `场景人物基准位置（仅作空间参考，实际入镜以各镜头参与者为准）：从画面左到右为${stagedCharacterNames.join("、")}`
    : `Scene character baseline (spatial reference only; actual presence follows each shot's participants): left to right ${stagedCharacterNames.join(", ")}`);
  if (movement.some(Boolean)) lines.push(zh ? `移动路径：${join(movement)}` : `Movement path: ${join(movement)}`);
  if (lightSource || lightDirection) lines.push(zh
    ? `光线方向：${[lightSource ? `主光源为${lightSource}` : "", lightDirection ? `方向为${lightDirection}` : ""].filter(Boolean).join("，")}`
    : `Lighting direction: ${[lightSource ? `source ${lightSource}` : "", lightDirection ? `direction ${lightDirection}` : ""].filter(Boolean).join(", ")}`);
  if (depth.some(Boolean)) lines.push(zh ? `景深关系：${join(depth)}` : `Depth relationships: ${join(depth)}`);
  if (staging.spacing?.trim()) lines.push(zh ? `间距：${staging.spacing.trim()}` : `Spacing: ${staging.spacing.trim()}`);
  if (staging.axisDirection) lines.push(zh
    ? `屏幕方向：${staging.axisDirection === "left-to-right" ? "从左到右" : "从右到左"}`
    : `Screen direction: ${staging.axisDirection}`);
  // 逐镜背景活动从动作节奏移到这里：它是「现场有什么在发生」的场景事实，
  // 不是某个时间块内的动作，放在时间轴里只会稀释节拍。
  for (const [index, shot] of (scene.shots ?? []).entries()) {
    const activity = shot.backgroundActivity?.trim();
    if (activity) lines.push(zh ? `镜头 ${index + 1} 背景活动：${fragment(activity)}` : `SHOT ${index + 1} background activity: ${fragment(activity)}`);
  }
  return lines.join("\n");
}

/**
 * PERFORMANCE 层：逐镜的表演基调（谁怎么演）。
 * 原先它作为「镜头基调 / 镜头保持」混在动作节奏里，和机位、现场光、背景人流
 * 挤在同一条时间轴上。拆出来后四者各写一次：
 *   机位 → CAMERA；景别与 FOV → OPTICS；现场光 → LIGHTING；
 *   背景人流 → SCENE MAP AND STAGING；表演 → 这里；时间轴 → ACTION TIMING。
 */
function renderPerformanceLayer(
  project: ProjectV2,
  scene: SceneV2,
  locale: PromptLocale,
  syntax: ReferenceSyntax,
): string {
  const zh = locale === "zh";
  const shots = scene.shots ?? [];
  // 纯景色场景（全程没有任何角色参与）不出表演段 —— 没有人就没有表演可写。
  // 闸门开在「场景有没有角色」而不是「有没有表演文本」上：没有角色的镜头
  // 仍可能残留 acting 字段，那时输出一段无主语表演只会让模型凭空造人。
  const hasCast = shots.some((shot) => (shot.participants ?? []).length > 0);
  if (!hasCast) return "";
  const assetById = new Map((project.assets ?? []).map((asset) => [asset.id, asset]));
  const imageTokensByAssetId = buildSceneImageTokenMap(project, scene);
  const characterReference = (id: string) => {
    const asset = assetById.get(id);
    if (!asset) return id;
    const imageToken = imageTokensByAssetId.get(id);
    if (syntax !== "plain-text") return `@${asset.referenceTag?.trim() || asset.name.trim() || asset.id}${imageToken ? ` ${imageToken}` : ""}`;
    return asset.name.trim() || asset.id;
  };
  const lines: string[] = [];
  for (const shot of shots) {
    const participants = shot.participants ?? [];
    const participantIds = new Set(participants.map((participant) => participant.characterId));
    const actorIds = [...new Set([
      ...participants.map((participant) => participant.characterId),
      ...(shot.beats ?? []).map((beat) => beat.actorId).filter((id): id is string => typeof id === "string" && participantIds.has(id)),
    ])];
    const details = (shot.performanceDescription?.trim()
      ? [shot.performanceDescription.trim()]
      : [shot.acting?.trim(), shot.eyeLife?.trim()].filter(Boolean)
    ).map((value) => fragment(value!));
    // 引用写法与动作节奏保持一致：@资产名（站位）。
    const subject = (actorId: string) => {
      const position = fragment(participants.find((item) => item.characterId === actorId)?.position ?? "");
      const reference = characterReference(actorId);
      return position ? `${reference}${zh ? `（${position}）` : ` (${position})`}` : reference;
    };
    for (const actorId of actorIds) {
      const participant = participants.find((item) => item.characterId === actorId);
      const parts: string[] = [];
      // 镜头级表演基调挂在首位出场角色身上，与逐角色表演合并成一句。
      if (details.length > 0 && actorId === actorIds[0]) parts.push(...details);
      if (participant?.acting?.trim()) parts.push(fragment(participant.acting));
      if (participant?.eyeLife?.trim()) parts.push(fragment(participant.eyeLife));
      if (participant?.eyeline?.trim()) parts.push(zh ? `视线：${fragment(participant.eyeline)}` : `eyeline: ${fragment(participant.eyeline)}`);
      if (parts.length > 0) lines.push(`${subject(actorId)}${zh ? "：" : ": "}${parts.join(zh ? "；" : " ")}${zh ? "。" : "."}`);
    }
  }
  return lines.join("\n");
}

/** 活动引用按场景级资产注册表平铺输出一次，不再按镜头分组加前缀。 */
function renderActiveReferences(project: ProjectV2, scene: SceneV2, locale: PromptLocale, syntax: ReferenceSyntax): string {
  const zh = locale === "zh";
  const seenAssetIds = new Set<string>();
  const imageTokensByAssetId = buildSceneImageTokenMap(project, scene);
  const registry = buildSceneAssetRegistry(project, scene);
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
      const imageToken = imageTokensByAssetId.get(holder.id);
      return `@${holderReference}${imageToken ? ` ${imageToken}` : ""}`;
    };
    const propDefaults = renderPropDefaults(asset, locale, holderName);
    const propScope = propDefaults ? `；${propDefaults}` : "";
    const imageToken = imageTokensByAssetId.get(asset.id) ? ` ${imageTokensByAssetId.get(asset.id)}` : "";
    return [zh
      ? `${tag}${imageToken}：${nameAndDescription}${anchorText}${locationScope}${propScope}。`
      : `${tag}${imageToken}: ${nameAndDescription}${anchorText}${locationScope}${propScope}.`];
  }).join("\n");
}

/** 场景内图片引用编号只生成一次，所有重复出现的 @资产都复用同一个 [imageN]。 */
function buildSceneImageTokenMap(project: ProjectV2, scene: SceneV2): Map<string, string> {
  const result = new Map<string, string>();
  let imageIndex = 0;
  for (const asset of buildSceneAssetRegistry(project, scene).orderedAssets) {
    if (asset.referencePaths?.[0]?.trim()) result.set(asset.id, `[image${++imageIndex}]`);
  }
  return result;
}

/** 站位参考图紧跟活动资产图片，随后才是首帧参考图；顺序须与 mediaReferences 保持一致。 */
function stagingReferenceImageToken(project: ProjectV2, scene: SceneV2): string | undefined {
  if (!scene.staging?.stagingReferenceImage?.trim()) return undefined;
  const assetImageCount = buildSceneAssetRegistry(project, scene).orderedAssets
    .filter((asset) => asset.referencePaths?.[0]?.trim()).length;
  return `[image${assetImageCount + 1}]`;
}

function push(list: string[], header: string, body: string): void {
  if (!body?.trim()) return;
  const separator = /^[\u0020-\u007E\s]+$/.test(header) ? ":" : "：";
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
    const lens = getLens(shot.lensModel);
    const lensText = lens
      ? (zh ? `镜头型号：${lens.brand} ${lens.model}（${lens.focal}；${lens.effect}）` : `lens model: ${lens.brand} ${lens.model} (${lens.focal}; ${lens.effect})`)
      : "";
    const framing = shot.framing?.trim()
      ? (zh ? `景别：${localizePromptValue(shot.framing.trim(), locale)}` : `framing: ${localizePromptValue(shot.framing.trim(), locale)}`)
      : "";
    return [base, framing, outcomeText, lensText].filter(Boolean).join(zh ? "；" : ". ");
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
 * plan fields are authoritative, while character voice locks remain attached
 * to every active character that has voice configuration, including silent shots.
 */
function renderDialogueSoundLayer(project: ProjectV2, scene: SceneV2, locale: PromptLocale): string {
  const zh = locale === "zh";
  const assetsById = new Map((project.assets ?? []).map((asset) => [asset.id, asset]));
  const imageTokensByAssetId = buildSceneImageTokenMap(project, scene);
  // 对白归属名统一带 @ 与 [imageN]，与活动引用一致。
  const ref = (assetId: string) => {
    const asset = assetsById.get(assetId);
    if (!asset) return assetId;
    const referenceName = asset.referenceTag?.trim() || asset.name.trim() || asset.id;
    const imageToken = imageTokensByAssetId.get(assetId);
    return `@${referenceName}${imageToken ? ` ${imageToken}` : ""}`;
  };
  const dialogueOrder: string[] = [];
  const voiceEvents: Array<{ characterId: string; shotIndex: number; beat: ActionBeat }> = [];
  for (const shot of scene.shots ?? []) {
    const shotIndex = scene.shots.indexOf(shot);
    for (const beat of [...(shot.beats ?? [])].sort((a, b) => a.order - b.order)) {
      if (!beat.dialogue?.trim() || !beat.actorId) continue;
      const name = ref(beat.actorId);
      dialogueOrder.push(zh ? `${name}说“${beat.dialogue.trim()}”` : `${name} says "${beat.dialogue.trim()}"`);
      voiceEvents.push({ characterId: beat.actorId, shotIndex, beat });
    }
    for (const beat of [...(shot.beats ?? [])].sort((a, b) => a.order - b.order)) {
      if (beat.dialogue?.trim() || !beat.actorId || !beat.audio?.trim() || !VOCAL_AUDIO_RE.test(beat.audio)) continue;
      voiceEvents.push({ characterId: beat.actorId, shotIndex, beat });
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

  // Voice locks belong beside their shot-local delivery, not inside the asset
  // identity line. This preserves the stable acoustic identity while making
  // the actual line, sigh, and silence executable in the AUDIO section.
  // 声音参考顺序与媒体引用共用同一全量注册表顺序（sceneVoiceCharacterIds），
  // 保证 @audioN 与上传的音频一一对应，不随对白出现顺序漂移。
  // 场景内有声音配置的角色必须保留声音锁，即使本镜头暂时没有对白；
  // @audioN 仍按全量清单位置编号，保证声音参考不会因对白顺序漂移。
  const allVoiceCharacterIds = sceneVoiceCharacterIds(project, scene);
  const audioAssets = (project.assets ?? []).filter((candidate) => candidate.kind === "audio-reference");
  const audioAssetsById = new Map(audioAssets.map((candidate) => [candidate.id, candidate]));
  const audioAssetsBySource = new Map(
    audioAssets.flatMap((candidate) => {
      const source = candidate.referencePaths?.[0]?.trim();
      return source ? [[source, candidate] as const] : [];
    }),
  );
  const voiceEventsByCharacter = new Map<string, typeof voiceEvents>(allVoiceCharacterIds.map((id) => [id, []]));
  for (const event of voiceEvents) {
    voiceEventsByCharacter.get(event.characterId)?.push(event);
  }
  const activeCharacterIds = buildSceneAssetRegistry(project, scene).orderedAssets
    .filter((asset) => asset.kind === "character")
    .map((asset) => asset.id);
  for (const characterId of activeCharacterIds) {
    const asset = assetsById.get(characterId);
    if (!asset || asset.kind !== "character") continue;
    const characterEvents = voiceEventsByCharacter.get(characterId) ?? [];
    const referenceName = asset.referenceTag?.trim() || asset.name.trim() || asset.id;
    const imageToken = imageTokensByAssetId.get(asset.id);
    const tag = `@${referenceName}${imageToken ? ` ${imageToken}` : ""}`;
    const voicePrompt = locale === "zh"
      ? (asset.actingProfile?.voicePromptZh?.trim() || asset.actingProfile?.voicePrompt?.trim() || "")
      : (asset.actingProfile?.voicePrompt?.trim() || asset.actingProfile?.voicePromptZh?.trim() || "");
    const audioIndex = allVoiceCharacterIds.indexOf(characterId);
    const voiceAsset = asset.voiceClip?.trim()
      ? (asset.voiceAssetId ? audioAssetsById.get(asset.voiceAssetId) : undefined)
        ?? audioAssetsBySource.get(asset.voiceClip.trim())
      : undefined;
    const voiceName = voiceAsset?.name?.trim() || asset.voiceAssetName?.trim();
    const voiceReference = asset.voiceClip?.trim() && audioIndex >= 0
      ? voiceName
        ? `@${voiceName} [audio${audioIndex + 1}]`
        : `@audio${audioIndex + 1}`
      : "";
    if (characterEvents.length === 0 && !voicePrompt && !voiceReference) continue;
    const label = zh ? `${asset.name.trim() || asset.id}声音` : `${asset.name.trim() || asset.id} VOICE`;
    const linesForCharacter = [
      `${label}${zh ? "：" : ": "}${tag}${voicePrompt ? (zh ? `；声音锁：${voicePrompt}` : `; voice lock: ${voicePrompt}`) : ""}${voiceReference ? (zh ? `；声音参考：${voiceReference}` : `; voice reference: ${voiceReference}`) : ""}${zh ? "。" : "."}`,
    ];
    for (const event of characterEvents) {
      const beat = event.beat;
      const shotLabel = scene.shots[event.shotIndex]?.label || `${event.shotIndex + 1}`;
      const localCues = [
        beat.tactic?.trim() ? (zh ? `策略为${beat.tactic.trim()}` : `the tactic is ${beat.tactic.trim()}`) : "",
        beat.beatChange?.trim() ? beat.beatChange.trim() : "",
      ].filter(Boolean).join(zh ? "，" : ", ");
      const delivery = localCues ? (zh ? `；本镜头${localCues}` : `; in this shot ${localCues}`) : "";
      const content = beat.dialogue?.trim()
        ? (zh ? `台词：“${beat.dialogue.trim()}”` : `line: "${beat.dialogue.trim()}"`)
        : (zh ? `非语言人声：${beat.audio!.trim()}` : `non-verbal vocalization: ${beat.audio!.trim()}`);
      linesForCharacter.push(zh
        ? `镜头 ${event.shotIndex + 1}（${shotLabel}）：${content}${delivery}。`
        : `SHOT ${event.shotIndex + 1} (${shotLabel}): ${content}${delivery}.`);
    }
    const lastEvent = characterEvents[characterEvents.length - 1];
    if (lastEvent?.beat.dialogue?.trim()) {
      linesForCharacter.push(zh ? "最后一句台词结束后保持沉默，不添加额外对白。" : "After the final line, remain silent with no extra dialogue.");
    }
    lines.push(...linesForCharacter);
  }
  return lines.join("\n");
}

/**
 * 场景内所有带声音参考（voiceClip）的角色，顺序与活动引用注册表一致。
 * 这是媒体上传清单（mediaReferences.referenceAudio）的全量顺序；
 * 导演 AUDIO 段的 @audioN 按此全量位置编号，避免声音张冠李戴。
 */
export function sceneVoiceCharacterIds(project: ProjectV2, scene: SceneV2): string[] {
  return buildSceneAssetRegistry(project, scene).orderedAssets
    .filter((asset) => asset.kind === "character" && asset.voiceClip?.trim())
    .map((asset) => asset.id);
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
  const viewpointLock = extractFirstPersonPovLock(scene.logline);
  if (shots.length === 0) return viewpointLock ? renderFirstPersonPovLock(viewpointLock, locale) : "";
  const zh = locale === "zh";
  const fields: [keyof CameraBehavior, string][] = [
    ["height", "高度"], ["distance", "距离"], ["angle", "角度"], ["side", "机位边"],
    ["subjectSize", "画面大小"], ["screenPlacement", "画面位置"], ["focusBehavior", "对焦"],
    ["depthOfField", "景深"], ["handheldQuality", "手持质感"],
  ];
  const conflictsWithPovLock = (text: string) => {
    if (!viewpointLock) return false;
    const operator = viewpointLock.operatorName?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return /第三人称|旁观(?:者)?|反打|third[- ]person|observer|reverse[- ]angle/i.test(text)
      || Boolean(operator && new RegExp(`(?:拍到|看见|show(?:s|ing)?|visible|入镜|出镜).{0,24}${operator}|${operator}.{0,24}(?:入镜|出镜|visible|in frame)`, "i").test(text));
  };
  const render = (shot: ShotV2): string => {
    const parts: string[] = [];
    const behavior = shot.cameraBehavior ?? {};
    const camera = getCamera(shot.camera);
    if (camera) parts.push(zh ? `相机型号：${camera.brand} ${camera.model}（${camera.effect}）` : `camera model: ${camera.brand} ${camera.model} (${camera.effect})`);
    if (behavior.description?.trim() && !conflictsWithPovLock(behavior.description)) {
      parts.push(zh ? `相机行为：${behavior.description.trim()}` : `camera behavior: ${behavior.description.trim()}`);
    } else {
      for (const [key, zhLabel] of fields) {
        const value = behavior[key]?.trim();
        if (value) parts.push(zh ? `${zhLabel}：${value}` : `${key}: ${value}`);
      }
    }
    const axisBreak = renderAxisBreakNote(shot, locale);
    if (axisBreak) parts.push(axisBreak);
    return parts.join(zh ? "；" : "; ");
  };
  const body = scene.shootingMode === "long-take"
    ? (scene.shots[0] ? render(scene.shots[0]) : "")
    : shots.map((shot) => `${zh ? "镜头" : "SHOT"} ${shot.label}：${render(shot)}`).join("\n");
  return [viewpointLock ? renderFirstPersonPovLock(viewpointLock, locale) : "", body].filter(Boolean).join("\n");
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
  const imageTokensByAssetId = buildSceneImageTokenMap(project, scene);
  const fmt = (sec: number) => {
    const totalHundredths = Math.max(0, Math.round(sec * 100));
    const minutes = Math.floor(totalHundredths / 6000);
    const seconds = (totalHundredths % 6000) / 100;
    const wholeSeconds = String(Math.floor(seconds)).padStart(2, "0");
    const fraction = seconds % 1 === 0
      ? ""
      : `.${String(Math.round((seconds % 1) * 100)).padStart(2, "0").replace(/0+$/, "")}`;
    return `${minutes}:${wholeSeconds}${fraction}`;
  };
  const characterReference = (id: string) => {
    const asset = assetById.get(id);
    if (!asset) return id;
    const imageToken = imageTokensByAssetId.get(id);
    if (syntax !== "plain-text") return `@${asset.referenceTag?.trim() || asset.name.trim() || asset.id}${imageToken ? ` ${imageToken}` : ""}`;
    return asset.name.trim() || asset.id;
  };
  /**
   * 动作节奏里每个镜头只用一句「相机起手式」交代它在时间轴上独有的机位信息：
   * 运镜 + 触发 + 落点。
   *
   * 相机型号、POV 锁、高度/距离/角度/机位边、主体占幅、画面位置、对焦、景深、
   * 手持质感由独立 CAMERA 段承担；FOV 与景别由 OPTICS 段承担 —— 多镜头模式下
   * 那两段本来就是逐镜列出的。这里再抄一遍会让同一套机位信息在最终提示词里
   * 重复三次（相机段 / 光学段 / 每个镜头开头），既挤占时长也让模型分不清
   * 哪一处才是相机行为的最终指令。
   *
   * 越轴说明同理留在 CAMERA 段（renderAxisBreakNote 在那里输出），不在此重复。
   */
  const renderShotCameraLead = (shot: ShotV2): string => {
    const viewpointLock = extractFirstPersonPovLock(scene.logline);
    const movement = viewpointLock ? "POV" : shot.movement?.trim();
    const movementText = movement ? localizePromptValue(movement, locale) : "";
    const parts: string[] = [];
    if (movementText) {
      parts.push(movement?.toLowerCase() === "static"
        ? (zh ? "固定机位" : "static camera")
        : (zh ? `${movementText}运镜` : movementText));
    }
    if (shot.planningMeta?.cameraTrigger?.trim()) {
      parts.push(zh ? `触发：${fragment(shot.planningMeta.cameraTrigger)}` : `trigger: ${fragment(shot.planningMeta.cameraTrigger)}`);
    }
    if (shot.planningMeta?.cameraEndState?.trim()) {
      parts.push(zh ? `落点：${fragment(shot.planningMeta.cameraEndState)}` : `end state: ${fragment(shot.planningMeta.cameraEndState)}`);
    }
    return parts.join(zh ? "；" : "; ");
  };
  const renderShotDetails = (shot: ShotV2, shotWindow: { startSeconds: number; endSeconds: number }): string[] => {
    const beats = [...(shot.beats ?? [])].sort((a, b) => a.order - b.order);
    const participants = shot.participants ?? [];
    const participantIds = new Set(participants.map((participant) => participant.characterId));
    const actorIds = [...new Set([
      ...participants.map((participant) => participant.characterId),
      ...beats.map((beat) => beat.actorId).filter((id): id is string => typeof id === "string" && participantIds.has(id)),
    ])];
    // 表演基调已移至 PERFORMANCE 层、现场光移至 LIGHTING、背景移至场景地图：
    // 本段只保留时间块，是「动作节奏」而不是「整场复述」。
    const lines: string[] = [];
    const legacyPropAction = fragment(shot.propChangeDescription ?? "");
    let legacyPropActionAttached = false;

    // Action timing 规范：有节拍的镜头按事件切成时间块（0:00 to 0:03 式），
    // 块内 = 主体位置 + 动作 + 节拍级事实；持续性的表演基调作为块外基线行。
    const subjectWithPosition = (actorId: string) => {
      const position = fragment(participants.find((item) => item.characterId === actorId)?.position ?? "");
      const reference = characterReference(actorId);
      return position ? `${reference}${zh ? `（${position}）` : ` (${position})`}` : reference;
    };
    const renderBeatParts = (beat: ActionBeat, actorId: string): string[] => {
      const parts: string[] = [];
      const action = beat.actionText?.trim() || beat.verb?.trim();
      const targetId = beat.targetCharacterId ?? beat.targetPropId;
      const target = targetId && targetId !== actorId ? characterReference(targetId) : "";
      if (action) parts.push(fragment(action));
      if (legacyPropAction && !legacyPropActionAttached && (beat.targetPropId || beat === beats[0])) {
        parts.push(legacyPropAction);
        legacyPropActionAttached = true;
      }
      if (target) parts.push(zh ? `朝向${target}` : `toward ${target}`);
      if (beat.targetBodyPart?.trim()) parts.push(zh ? `目标部位：${fragment(beat.targetBodyPart)}` : `target body part: ${fragment(beat.targetBodyPart)}`);
      const beatPhysics = (shot.physicsAnchors ?? []).map((anchor) => {
        const preset = physicsAnchorById(anchor.kind);
        if (!preset) return "";
        const points = (zh ? preset.pointsZh : preset.pointsEn).join(zh ? "、" : ", ");
        const extra = anchor.detail?.trim();
        return zh ? `${points}${extra ? `；${extra}` : ""}` : `${points}${extra ? `; ${extra}` : ""}`;
      }).filter(Boolean);
      if (beatPhysics.length > 0) parts.push(zh ? `物理：${beatPhysics.join("；")}` : `physics: ${beatPhysics.join("; ")}`);
      if (beat.propState?.trim()) {
        const prop = beat.targetPropId ? characterReference(beat.targetPropId) : "";
        const propState = prop ? `${prop}，${fragment(beat.propState)}` : fragment(beat.propState);
        parts.push(zh ? `关键道具状态：${propState}` : `critical prop state: ${propState}`);
      }
      if (beat.audio?.trim()) parts.push(zh ? `声音：${fragment(beat.audio)}` : `audio: ${fragment(beat.audio)}`);
      const beatStates = [
        ...(beat.stateBefore ?? []).map((state) => ({ label: zh ? "道具前置状态" : "prop state before", state })),
        ...(beat.stateAfter ?? []).map((state) => ({ label: zh ? "道具后置状态" : "prop state after", state })),
      ];
      if (beatStates.length > 0) {
        const stateText = beatStates.map(({ label, state }) => {
          const stateBits = [
            characterReference(state.propId),
            state.holderCharacterId ? (zh ? `由${characterReference(state.holderCharacterId)}持有` : `held by ${characterReference(state.holderCharacterId)}`) : "",
            state.position?.trim() ?? "",
            state.state?.trim() ? localizePromptValue(state.state.trim(), locale) : "",
          ].filter(Boolean).join(zh ? "，" : ", ");
          return `${label}：${stateBits}`;
        }).join(zh ? "；" : "; ");
        parts.push(zh ? `关键${stateText}` : `critical ${stateText}`);
      }
      if (beat.tactic?.trim()) parts.push(zh ? `策略：${fragment(beat.tactic)}` : `tactic: ${fragment(beat.tactic)}`);
      if (beat.subtext?.trim()) parts.push(zh ? `潜台词：${fragment(beat.subtext)}` : `subtext: ${fragment(beat.subtext)}`);
      if (beat.beatChange?.trim()) parts.push(fragment(beat.beatChange));
      if (beat.reactionBeforeLine?.trim()) parts.push(fragment(beat.reactionBeforeLine));
      if (beat.dialogue?.trim()) parts.push(zh ? `说：“${beat.dialogue.trim()}”` : `says, "${beat.dialogue.trim()}"`);
      const forbidden = (beat.forbiddenTargets ?? []).filter((id) => id !== targetId).map(characterReference);
      if (forbidden.length > 0) parts.push(zh ? `禁止目标：${forbidden.join("、")}` : `never target: ${forbidden.join(", ")}`);
      if (beat.cutRule?.trim()) parts.push(zh ? `剪辑规则：${fragment(beat.cutRule)}` : `cut rule: ${fragment(beat.cutRule)}`);
      if (beat.note?.trim()) parts.push(zh ? `备注：${fragment(beat.note)}` : `note: ${fragment(beat.note)}`);
      return parts;
    };

    if (beats.length === 0) {
      // 无节拍镜头没有可切分的事件，只剩动作本身；表演基调在 PERFORMANCE 段。
      // performanceDescription 是 UI 里的「动作、表演与眼神执行」合并字段，常与
      // shot.action 同源。只有两者确为同一句话时才去重，否则会把独立填写的动作
      // 一起吞掉，让这个镜头在动作节奏里变成空块。
      const action = shot.action?.trim() ?? "";
      const performance = shot.performanceDescription?.trim() ?? "";
      const duplicated = Boolean(performance) && Boolean(action)
        && (performance.includes(action) || action.includes(performance));
      const actionFallback = action && !duplicated ? fragment(action) : "";
      const fallback = [actionFallback, legacyPropAction].filter(Boolean);
      if (fallback.length > 0) lines.push(`${zh ? "镜头保持" : "The shot holds"}${zh ? "：" : ": "}${fallback.join(zh ? "；" : " ")}${zh ? "。" : "."}`);
      return lines;
    }


    // 节拍时间优先使用场景绝对时间 startSeconds；未填写时才按 order 连续累计。
    // 因此显式时间可以表达非连续事件和重叠事件，旧数据仍保持原有结果。
    const windowSeconds = Math.max(0, shotWindow.endSeconds - shotWindow.startSeconds);
    const knownDurations = beats.filter((beat) => beat.duration != null && beat.duration > 0);
    const totalKnown = knownDurations.reduce((total, beat) => total + (beat.duration ?? 0), 0);
    const unknownCount = beats.length - knownDurations.length;
    const unknownShare = unknownCount > 0 ? (windowSeconds > totalKnown ? (windowSeconds - totalKnown) / unknownCount : 1) : 0;
    let cursor = shotWindow.startSeconds;
    const timedBeats: Array<{ beat: ActionBeat; actorId: string; blockStart: number; blockEnd: number; parts: string[] }> = [];
    for (const beat of beats) {
      const duration = beat.duration != null && beat.duration > 0 ? beat.duration : unknownShare;
      const explicitStart = typeof beat.startSeconds === "number" && Number.isFinite(beat.startSeconds)
        ? beat.startSeconds
        : undefined;
      const requestedStart = explicitStart ?? cursor;
      // Explicit wall-clock times are user-authored facts. Preserve them even
      // when the audit reports that they fall outside the shot window; never
      // silently move a precisely timed event.
      const blockStart = explicitStart === undefined
        ? Math.max(shotWindow.startSeconds, Math.min(requestedStart, shotWindow.endSeconds))
        : requestedStart;
      const blockEnd = blockStart + duration;
      cursor = Math.max(cursor, blockEnd);
      if (!beat.actorId || !participantIds.has(beat.actorId)) continue;
      const parts = renderBeatParts(beat, beat.actorId);
      if (parts.length === 0) continue;
      timedBeats.push({ beat, actorId: beat.actorId, blockStart, blockEnd, parts });
    }
    timedBeats.sort((a, b) => a.blockStart - b.blockStart || a.beat.order - b.beat.order);

    // Explicit beat starts can intentionally leave pauses, but an unlabelled
    // pause must still occupy the shot timeline. Emit a lightweight hold block
    // for every uncovered interval so the final prompt never skips seconds.
    const holdActorId = actorIds[0];
    const holdSubject = holdActorId ? subjectWithPosition(holdActorId) : "";
    const renderHold = (start: number, end: number, reason: string) => {
      if (end - start < 0.001) return;
      const blockLabel = `${fmt(start)}${zh ? "–" : " to "}${fmt(end)}`;
      const text = holdSubject
        ? (zh ? `${holdSubject}：${reason}。` : `${holdSubject}: ${reason}.`)
        : (zh ? `${reason}。` : `${reason}.`);
      lines.push(`${blockLabel}${zh ? "：" : ": "}${text}`);
    };
    let coveredUntil = shotWindow.startSeconds;
    for (const timed of timedBeats) {
      const visibleStart = Math.min(shotWindow.endSeconds, Math.max(shotWindow.startSeconds, timed.blockStart));
      if (visibleStart > coveredUntil) {
        renderHold(coveredUntil, visibleStart, coveredUntil === shotWindow.startSeconds
          ? (zh ? "保持当前状态，等待下一动作" : "hold the current state until the next action")
          : (zh ? "上一动作余韵持续，保持当前姿态与空间关系" : "let the previous action resolve while holding the current pose and spatial relationship"));
      }
      const blockLabel = `${fmt(timed.blockStart)}${zh ? "–" : " to "}${fmt(timed.blockEnd)}`;
      lines.push(`${blockLabel}${zh ? "：" : ": "}${subjectWithPosition(timed.actorId)}${zh ? "：" : ": "}${timed.parts.join(zh ? "；" : " ")}${zh ? "。" : "."}`);
      coveredUntil = Math.max(coveredUntil, timed.blockEnd);
    }
    if (coveredUntil < shotWindow.endSeconds) {
      renderHold(coveredUntil, shotWindow.endSeconds, zh
        ? "保持当前动作与镜头状态直到本镜头结束"
        : "hold the current action and camera state until the end of the shot");
    }
    return lines;
  };

  const blocks: string[] = [];
  for (const [index, shot] of (scene.shots ?? []).entries()) {
    const time = shotTimes.get(shot.id);
    if (!time) continue;
    const details = renderShotDetails(shot, time);
    const range = `${fmt(time.startSeconds)}${zh ? "–" : "-"}${fmt(time.endSeconds)}`;
    const cameraLead = renderShotCameraLead(shot);
    // 只写相机起手式的镜头保持「时间范围 — 镜头 N（相机：…）」的标题形式，
    // 不补冒号：冒号后面没内容会看起来像漏写了一段。
    const head = `${range} — ${zh ? `镜头 ${index + 1}` : `SHOT ${index + 1}`}${cameraLead ? (zh ? `（相机：${cameraLead}）` : ` (Camera: ${cameraLead})`) : ""}`;
    let cut = "";
    if (index > 0 && scene.shootingMode === "multi-shot") {
      const label = ({
        "hard-cut": zh ? `硬切进入镜头 ${index + 1}` : `Hard cut into shot ${index + 1}`,
        "match-cut": zh ? `动作匹配剪辑进入镜头 ${index + 1}` : `Match cut into shot ${index + 1}`,
        overlap: zh ? `以声音或动作重叠进入镜头 ${index + 1}` : `Enter shot ${index + 1} on sound or action overlap`,
      }[shot.cutStyle ?? scene.cutStyleDefault ?? "hard-cut"]);
      // 每个切点必须有理由：优先复用上一镜节拍上写的剪辑规则。
      const previousShot = (scene.shots ?? [])[index - 1];
      const previousCutRule = [...(previousShot?.beats ?? [])]
        .sort((a, b) => a.order - b.order)
        .reverse()
        .find((beat) => beat.cutRule?.trim())?.cutRule?.trim();
      cut = `${label}${zh ? "；" : "; "}${previousCutRule ? `${zh ? "切换依据" : "cut reason"}：${fragment(previousCutRule)}${zh ? "；" : "; "}` : ""}`;
    }
    const body = `${cut}${details.length > 0 ? `\n${details.join("\n")}` : ""}`;
    blocks.push(body ? `${head}${zh ? "：" : ":"}${body}` : head);
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

/**
 * STYLE：单真源 = 导演简报的风格描述（手改 / AI 优化即时生效）。
 * 预制风格只负责往简报里填充文本；仅当简报为空时才回退预制风格终稿
 * （兼容 styleId 存在但从未填写风格描述的旧项目），此时才附加预设名前缀。
 * 本层只承接导演/画面风格，不重复 OPTICS、CAMERA 和 LIGHTING 的执行锁。
 */
function renderStyleLayer(project: ProjectV2, locale: PromptLocale): string {
  const brief = localizedStyleBrief(project, locale).trim();
  if (brief) return brief;
  const style = getStyle(project.styleId);
  const detail = style ? finalStyleDescription(style, locale) : "";
  if (!detail || !style) return detail;
  return locale === "zh"
    ? `${style.nameZh}风格：${detail}`
    : `${style.name} style: ${detail}`;
}

export function compileDirectorSequence(project: ProjectV2, scene: SceneV2, options: DirectorOptions = {}): string {
  const syntax = options.syntax ?? "asset-id";
  const locale: PromptLocale = options.locale ?? "zh";
  // The final export is always rebuilt from structured scene data so raw
  // inspector text and stale generated prose cannot leak into executable data.
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

  // FORMAT MODE：长镜头 = 单连续镜头；多镜头 = 受控多镜序列。
  push(sections, header("formatMode"), scene.shootingMode === "multi-shot"
    ? (locale === "zh" ? "受控多镜头序列；仅在明确镜头边界处切换。" : "CONTROLLED MULTI-SHOT SEQUENCE. Cut only at explicit shot boundaries.")
    : (locale === "zh" ? "单一连续长镜头；全段保持同一摄影机、FOV 与轴线。" : "SINGLE CONTINUOUS TAKE. Keep one camera, FOV and screen axis throughout."));

  push(sections, header("optics"), renderOpticsLayer(scene, locale));
  push(sections, header("camera"), renderCameraLayer(scene, locale));
  // PERFORMANCE：逐镜表演基调。动作节奏只留时间块，这里承担「谁怎么演」。
  push(sections, header("performance"), renderPerformanceLayer(project, scene, locale, syntax));
  // Shot execution is compiled only from structured shots, beats, and
  // participants. It is intentionally not an editable director-document layer.
  push(sections, SHOT_EXECUTION_LAYER[locale], renderShotExecutionLayer(project, scene, locale, syntax, shotTimes));

  // PHYSICS / LIGHTING 优先级锁（正向先写，负向骨折就近内联）。
  const physicsBits = [locks.physics.join(locale === "zh" ? "；" : "; "), ...renderPhysicsAnchors(scene, locale)].filter(Boolean);
  push(sections, header("physics"), physicsBits.join(locale === "zh" ? "；" : "; "));
  // 逐镜现场光从动作节奏移到光线段：光是场景事实，不占时间轴的行。
  const shotLighting = (scene.shots ?? []).flatMap((shot, index) => {
    const value = shot.lightingBehavior?.trim();
    if (!value) return [];
    return [locale === "zh" ? `镜头 ${index + 1} 光影：${fragment(value)}` : `SHOT ${index + 1} lighting: ${fragment(value)}`];
  });
  const lightingBits = [renderLightingDirection(scene.lightingDirection, locale), ...shotLighting, locks.lighting.join(locale === "zh" ? "；" : "; ")].filter(Boolean);
  push(sections, header("lighting"), lightingBits.join(locale === "zh" ? "；" : "; "));

  if (options.audioEnabled !== false) push(sections, header("audio"), renderDialogueSoundLayer(project, scene, locale));
  push(sections, header("style"), renderStyleLayer(project, locale));
  // Identity anchors already appear once in ACTIVE REFERENCES. Keep only
  // count and user-authored positive constraints here.
  const positives: string[] = [];
  const viewpointLock = extractFirstPersonPovLock(scene.logline);
  if (viewpointLock) positives.push(renderFirstPersonPovLock(viewpointLock, locale));
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
    if (!section.key || FINAL_GENERATED_DIRECTOR_LAYER_KEYS.has(section.key)) continue;
    const body = source.slice(section.bodyStart, starts[index + 1]?.sectionStart).trim();
    if (body) layers[section.key] = body;
  }
  return layers;
}
