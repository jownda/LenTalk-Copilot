/**
 * 导演级分段编译器（CINEDANCE V4 / P0.1）。
 * 与 legacy `compileProSequence` 的区别：
 * - 按导演分段顺序输出（SCENE CONTEXT → … → POSITIVE CONSTRAINTS）；
 * - 段头硬编码英文 canonical（进 i18n 待 P0 后续字段补齐）；
 * - 光线 / 物理从技术 Profile 拆出为优先级锁段；
 * - 负面词局部锁：就近挂到 PHYSICS / LIGHTING / POSITIVE CONSTRAINTS，仅全局失败模式保留精简尾段（P0.3）。
 */
import type { CameraBehavior, LightingDirection, ProjectV2, SceneV2 } from "../../shared-types";
import {
  assetRefName, buildSceneAssetRegistry, renderAssetLine, renderCharacterCountLock, renderStrictIdentityLock,
} from "./renderer";
import {
  renderActingSection, renderAudioSection, renderLocalLocks, renderShotSection, type PromptLocale, type ReferenceSyntax, unifiedCameraForScene,
} from "./sections";
import { lensById, lensByFov, physicsAnchorById, renderLightingLayer, renderPhysicsLayer, renderTechnicalProfile } from "../presets";
import { validateDirectorLayers } from "../quality";

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
  { key: "locationMap", zh: "位置图", en: "LOCATION MAP" },
  { key: "firstFrame", zh: "首帧与站位", en: "FIRST FRAME AND SPATIAL BLOCKING" },
  { key: "formatMode", zh: "格式模式", en: "FORMAT MODE" },
  { key: "optics", zh: "光学", en: "OPTICS" },
  { key: "camera", zh: "相机", en: "CAMERA" },
  { key: "actionTiming", zh: "动作时间", en: "ACTION TIMING" },
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

const sentence = (text: string): string => {
  const t = text.trim();
  if (!t) return "";
  if (/[。．.!！?？]$/.test(t)) return t;
  return `${t}.`;
};

/** SCENE CONTEXT：仅当前场景一句话到两句，无场景编号。 */
function renderSceneContext(scene: SceneV2): string {
  const parts = [scene.name, scene.duration, scene.location, scene.time, scene.weather].filter((part) => part.trim());
  const line = parts.join(", ") + (scene.logline?.trim() ? `. ${sentence(scene.logline.trim())}` : "");
  const body = [line];
  const prior = scene.staging?.priorContext?.trim();
  if (prior) body.push(`Prior context: ${sentence(prior)}`);
  return body.join("\n");
}

/** LOCATION MAP：从场景站位派生（位置参考 → 锚点 → 角色顺序 → 间距 → 屏幕方向）。 */
function renderLocationMap(project: ProjectV2, scene: SceneV2, syntax: ReferenceSyntax): string {
  const staging = scene.staging;
  if (!staging) return "";
  const ref = assetRefName(project, syntax);
  const lines: string[] = [];
  if (staging.locationAssetId) lines.push(`Location reference: ${ref(staging.locationAssetId)}`);
  if (staging.anchorDescription?.trim()) lines.push(`Anchor: ${staging.anchorDescription.trim()}`);
  if ((staging.characterOrder ?? []).length > 0) lines.push(`Character order, left to right: ${staging.characterOrder!.map(ref).join(", ")}`);
  if (staging.spacing?.trim()) lines.push(`Spacing: ${staging.spacing.trim()}`);
  if (staging.axisDirection) lines.push(`Screen direction: ${staging.axisDirection}`);
  return lines.join("\n");
}

function push(list: string[], header: string, body: string): void {
  if (body?.trim()) list.push(`${header}\n${body.trim()}`);
}

/** P1.2 OPTICS 层：可观测结果优先于焦距与品牌。长镜头统一 FOV 锁；多镜头逐镜锁定。 */
function renderOpticsLayer(scene: SceneV2, locale: PromptLocale): string {
  const shots = (scene.shots ?? []).filter((shot) => shot.optics);
  if (shots.length === 0) return "";
  const zh = locale === "zh";
  const lines: string[] = [];
  if (scene.shootingMode === "long-take") {
    const optics = shots[0].optics!;
    const preset = lensById(optics.lensCharacter) ?? lensByFov(optics.fieldOfViewDegrees);
    const anti = optics.antiDriftLock?.trim() || (preset ? (zh ? preset.antiDriftZh : preset.antiDrift) : "");
    if (anti) lines.push(anti);
    const outcome = optics.lensOutcome?.length ? optics.lensOutcome : (preset ? (zh ? preset.outcomeZh : preset.outcome) : []);
    lines.push(...outcome);
  } else {
    for (const shot of shots) {
      const optics = shot.optics!;
      const preset = lensById(optics.lensCharacter) ?? lensByFov(optics.fieldOfViewDegrees);
      const fov = preset?.fov ?? optics.fieldOfViewDegrees;
      if (fov != null) {
        lines.push(zh ? `镜头锁定 ${shot.label} = ${fov}°。` : `LENS LOCK SHOT ${shot.label} = ${fov}°.`);
        lines.push(zh ? `镜头检查 ${shot.label}：${fov}° 保持，不漂移。` : `LENS CHECK SHOT ${shot.label}: ${fov}° maintained, no drift.`);
      }
    }
  }
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
  if (scene.shootingMode === "long-take") return render(shots[0].cameraBehavior!);
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

/** P1.5 动作时间块：按 startSeconds + duration 生成墙钟区间。 */
function renderActionTimingLayer(scene: SceneV2, locale: PromptLocale): string {
  const zh = locale === "zh";
  const blocks: string[] = [];
  for (const shot of scene.shots ?? []) {
    for (const beat of shot.beats ?? []) {
      if (beat.startSeconds == null) continue;
      const start = beat.startSeconds;
      const end = start + (beat.duration ?? 0);
      const fmt = (sec: number) => {
        const total = Math.round(sec);
        return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
      };
      const verb = beat.verb || beat.actionText?.trim() || "";
      blocks.push(zh ? `时间块 ${fmt(start)} 至 ${fmt(end)}：${verb}。` : `TIME BLOCK ${fmt(start)} to ${fmt(end)}: ${verb}.`);
    }
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
  // P0.5：若场景已存有 AI 产出的分层导演文档，则按 canonical 层序直接拼接；
  // 这样用户编辑/锁定过的层文本能原样进入最终提示词（P0.6 锁定语义的落点）。
  const storedLayers = scene.directorLayers;
  if (storedLayers) {
    // V2.2：AI 分层文本在进入最终提示词前必须过质量门；
    // error 级结构冲突 → 丢弃整份分层文档，回退结构化编译（每镜一卡，天然分块）。
    const issues = validateDirectorLayers(storedLayers, project, scene);
    const hasBlockingErrors = issues.some((issue) => issue.severity === "error");
    if (!hasBlockingErrors) {
      const joined = DIRECTOR_LAYER_ORDER
        .map((key) => (storedLayers[key] ?? "").trim())
        .filter(Boolean)
        .join("\n\n");
      if (joined) return joined;
    }
  }
  /* 结构化编译路径（V2.2 起作为 AI 分层文档的校验回退兜底） */
  const registry = buildSceneAssetRegistry(project, scene);
  const locks = renderLocalLocks(project, locale);
  const sections: string[] = [];

  push(sections, "SCENE CONTEXT", renderSceneContext(scene));

  push(sections, "LOCATION MAP", renderLocationMap(project, scene, syntax));

  push(sections, "FIRST FRAME", renderFirstFrameLayer(scene, locale));

  // FORMAT MODE：长镜头 = 单连续镜头；多镜头 = 受控多镜序列。
  push(sections, "FORMAT MODE", scene.shootingMode === "multi-shot" ? "CONTROLLED MULTI-SHOT SEQUENCE" : "SINGLE CONTINUOUS TAKE");

  // STYLE PROFILE：光学 / 相机 / 风格母版（尚未拆落到 OPTICS/CAMERA，P1 精化）。
  const styleProfile = renderTechnicalProfile(project, locale, ["lighting", "physics"]);
  push(sections, "STYLE PROFILE", styleProfile);

  push(sections, "OPTICS", renderOpticsLayer(scene, locale));
  push(sections, "CAMERA", renderCameraLayer(scene, locale));
  push(sections, "ACTION TIMING", renderActionTimingLayer(scene, locale));
  push(sections, locale === "zh" ? "表演" : "ACTING", renderActingSection(project, scene, locale));

  // 每个镜头是一份密封文档：只列本镜活动引用（上下文隔离），再附动作 / 空间 / 相机细节。
  const cameraOverride = unifiedCameraForScene(scene);
  for (const shot of scene.shots) {
    const shotRegistry = buildSceneAssetRegistry(project, scene, "shot", shot);
    if (shotRegistry.orderedAssets.length > 0) {
      const lines = shotRegistry.orderedAssets.map((asset, index) => renderAssetLine(asset, index + 1, syntax, locale));
      push(sections, "ACTIVE REFERENCES", lines.join("\n"));
    }
    push(sections, "", renderShotSection(project, scene, shot, locale, syntax, cameraOverride));
  }

  // PHYSICS / LIGHTING 优先级锁（正向先写，负向骨折就近内联）。
  const physicsBits = [renderPhysicsLayer(project, locale), locks.physics.join(locale === "zh" ? "；" : "; "), ...renderPhysicsAnchors(scene, locale)].filter(Boolean);
  push(sections, "PHYSICS", physicsBits.join(locale === "zh" ? "；" : "; "));
  const lightingBits = [renderLightingDirection(scene.lightingDirection, locale), renderLightingLayer(project, locale), scene.lighting?.trim(), locks.lighting.join(locale === "zh" ? "；" : "; ")].filter(Boolean);
  push(sections, "LIGHTING", lightingBits.join(locale === "zh" ? "；" : "; "));

  // AUDIO
  const audio = renderAudioSection(project, scene, locale, options.audioEnabled !== false);
  if (audio?.trim()) sections.push(audio.trim());

  // POSITIVE CONSTRAINTS：数量锁 + 身份强锁 + 外观漂移/多余肢体内联锁 + 用户正向硬约束。
  const positives: string[] = [];
  const count = renderCharacterCountLock(project, locale);
  if (count) positives.push(count);
  const strict = renderStrictIdentityLock(registry, project.identityRules ?? [], locale).replace(/^[^\n]+\n/, "").trim();
  if (strict) positives.push(strict);
  if (locks.character.length) positives.push(locks.character.join(locale === "zh" ? "；" : "; "));
  for (const item of project.positiveConstraints ?? []) if (item.trim()) positives.push(item.trim());
  push(sections, "POSITIVE CONSTRAINTS", positives.join("\n"));

  // 全局失败模式（身份漂移 / 悬浮运动 / 文字水印）保留精简尾段；camera 词待 P1 CAMERA 段落位前暂归尾段。
  const globalLocks = [...locks.global, ...locks.camera];
  if (globalLocks.length > 0) {
    push(sections, "NEGATIVE LOCKS (GLOBAL ONLY)", globalLocks.join(locale === "zh" ? "；" : "; "));
  }

  return sections.filter(Boolean).join("\n\n");
}
