import type { SceneV2, ShotV2, TimeRange } from "../../shared-types";

export interface FinalPromptAuditIssue {
  code:
    | "FINAL.MODE_SHOT_CONFLICT"
    | "FINAL.TIMELINE_NORMALIZED"
    | "FINAL.DURATION_EXCEEDED"
    | "FINAL.CUT_STYLE_DEFAULTED"
    | "FINAL.WINDOW_LIGHT_FACT_CONFLICT"
    | "FINAL.OPTICS_TERMS_NORMALIZED"
    | "FINAL.ABSTRACT_PERFORMANCE"
    | "FINAL.SPEAKER_VOICE_LOCK_MISSING"
    | "FINAL.FIRST_FRAME_MISSING"
    | "FINAL.ACTION_BEATS_MISSING"
    | "FINAL.EXTERIOR_LIGHT_PATH_MISSING"
    | "FINAL.SCENE_CONTEXT_MISSING"
    | "FINAL.SCENE_CONTEXT_META_LEAK"
    | "FINAL.SCENE_CONTEXT_TOO_LONG";
  severity: "error" | "warning";
  detail: string;
  detailZh: string;
  /** Allows the editor to return to the affected shot instead of leaving an opaque error. */
  shotId?: string;
  field?: "staging" | "lighting" | "optics" | "acting" | "voice" | "action";
  action?: "review-staging" | "review-lighting" | "review-optics" | "review-acting" | "review-voice" | "review-action" | "recompile";
}

export interface FinalPromptAuditAdjustment {
  code: "FINAL.OPTICS_TERMS_NORMALIZED" | "FINAL.TIMELINE_NORMALIZED" | "FINAL.CUT_STYLE_DEFAULTED" | "FINAL.MODE_SHOT_CONFLICT";
  detail: string;
  detailZh: string;
  shotId?: string;
}

export interface FinalPromptAuditResult {
  issues: FinalPromptAuditIssue[];
  adjustments: FinalPromptAuditAdjustment[];
  shotTimes: Map<string, TimeRange>;
  totalDurationSeconds: number;
  maxDurationSeconds?: number;
}

/**
 * Export-only scene model. It deliberately excludes inspector scores, notes,
 * and AI layer prose so the final renderer cannot accidentally leak UI data.
 */
export interface FinalPromptShotDocument {
  id: string;
  label: string;
  time: TimeRange;
  participantIds: string[];
  speakerIds: string[];
  propIds: string[];
  hasVisibleAction: boolean;
}

export interface FinalPromptDocument {
  formatMode: "long-take" | "multi-shot";
  totalDurationSeconds: number;
  maxDurationSeconds?: number;
  firstFrameSubjectIds: string[];
  shots: FinalPromptShotDocument[];
  shotTimes: Map<string, TimeRange>;
}

function parseSeconds(value?: string): number | undefined {
  const match = value?.match(/(\d+(?:\.\d+)?)/);
  if (!match) return undefined;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

function shotDurationSeconds(shot: ShotV2): number {
  if (shot.time) {
    const duration = shot.time.endSeconds - shot.time.startSeconds;
    if (Number.isFinite(duration) && duration > 0) return duration;
  }
  const beatDuration = (shot.beats ?? []).reduce((total, beat) => total + (beat.duration ?? 0), 0);
  return beatDuration > 0 ? beatDuration : (parseSeconds(shot.duration) ?? 1);
}

interface TextSource {
  label: string;
  labelZh: string;
  text?: string;
}

interface OpticsNormalization {
  text: string;
  changed: boolean;
}

/**
 * Keeps only deterministic optical corrections. It deliberately does not invent
 * a lens choice or camera move; it just removes a result that contradicts a
 * user-selected FOV.
 */
export function normalizeOpticsText(text: string, fov?: number): OpticsNormalization {
  if (!text.trim() || fov == null) return { text, changed: false };
  const isWide = fov >= 70;
  const isTele = fov <= 35;
  let next = text;
  if (isWide) {
    next = next
      .replace(/短焦压缩感|广角压缩感/g, "纵深拉开，近景略大于远景")
      .replace(/压缩感/g, "纵深拉开，近景略大于远景")
      .replace(/wide[- ]angle compression/gi, "expanded depth with foreground slightly larger than the distance")
      .replace(/\bcompression\b/gi, "expanded depth");
  }
  if (isTele) {
    next = next
      .replace(/近大远小|广角透视夸张/g, "背景压缩，人物比例自然")
      .replace(/wide[- ]angle perspective exaggeration/gi, "compressed background with natural subject proportions")
      .replace(/near objects (?:look )?larger than distant objects/gi, "compressed background with natural subject proportions");
  }
  return { text: next, changed: next !== text };
}

function hasObservablePerformance(text: string): boolean {
  return /眼|呼吸|手|指|停|看|转|站|坐|走|抬|低头|嘴|肩|步|吞咽|眨|姿势|身体|动作|目光|blink|breath|hand|finger|pause|look|turn|walk|raise|lower|mouth|shoulder|posture|body|eye/i.test(text);
}

function isAbstractPerformance(text?: string): boolean {
  const trimmed = text?.trim();
  if (!trimmed || hasObservablePerformance(trimmed)) return false;
  return /恐惧|害怕|紧张|愤怒|悲伤|不安|痛苦|焦虑|开心|兴奋|克制|恐慌|fear|afraid|anxious|angry|sad|uneasy|pain|happy|excited|restrained|panic/i.test(trimmed);
}

/** Only detect explicitly incompatible exterior facts; never infer a light source from atmosphere alone. */
function findWindowLightFactConflict(scene: SceneV2): { black: TextSource & { text: string }; light: TextSource & { text: string } } | undefined {
  const sources = [
    { label: "scene logline", labelZh: "场景梗概", text: scene.logline },
    { label: "scene lighting", labelZh: "场景光线", text: scene.lighting },
    { label: "lighting key", labelZh: "主光源", text: scene.lightingDirection?.primarySource },
    { label: "lighting direction", labelZh: "光线方向", text: scene.lightingDirection?.direction },
    ...((scene.shots ?? []).flatMap((shot, index) => [
      { label: `shot ${index + 1} action`, labelZh: `镜头 ${index + 1} 动作`, text: shot.action },
      { label: `shot ${index + 1} note`, labelZh: `镜头 ${index + 1} 备注`, text: shot.note },
      ...(shot.beats ?? []).flatMap((beat) => [
        { label: `shot ${index + 1} beat ${beat.order}`, labelZh: `镜头 ${index + 1} 节拍 ${beat.order}`, text: beat.actionText },
        { label: `shot ${index + 1} beat ${beat.order} note`, labelZh: `镜头 ${index + 1} 节拍 ${beat.order} 备注`, text: beat.note },
      ]),
    ])),
  ].filter((source): source is TextSource & { text: string } => Boolean(source.text?.trim()));
  const black = sources.find((source) => /窗外[^。；.!?]{0,24}(?:绝对(?:的)?黑|完全(?:的)?黑|一片(?:漆)?黑)|(?:absolute|complete|total)\s+black[^.!?]{0,24}(?:outside|window)|(?:outside|window)[^.!?]{0,24}(?:absolute|complete|total)\s+black/i.test(source.text ?? ""));
  const light = sources.find((source) => /(?:窗外|车窗|window|outside)[^。；.!?]{0,36}(?:霓虹|街灯|路灯|neon|street\s*light|streetlamp)|(?:霓虹|街灯|路灯|neon|street\s*light|streetlamp)[^。；.!?]{0,36}(?:窗外|车窗|window|outside)/i.test(source.text ?? ""));
  return black && light ? { black, light } : undefined;
}

/** Exterior light must have a visible route into the frame, not just a named color source. */
function findExteriorLightWithoutPath(scene: SceneV2): TextSource | undefined {
  const sources = [
    { label: "scene lighting", labelZh: "场景光线", text: scene.lighting },
    { label: "lighting key", labelZh: "主光源", text: scene.lightingDirection?.primarySource },
    { label: "lighting direction", labelZh: "光线方向", text: scene.lightingDirection?.direction },
  ].filter((source): source is TextSource & { text: string } => Boolean(source.text?.trim()));
  const exteriorLight = /(?:窗外|车窗|window|outside)[^。；.!?]{0,36}(?:霓虹|街灯|路灯|neon|street\s*light|streetlamp)|(?:霓虹|街灯|路灯|neon|street\s*light|streetlamp)[^。；.!?]{0,36}(?:窗外|车窗|window|outside)/i;
  const path = /透过|穿过|从车窗|由窗外|经由窗|through\s+(?:the\s+)?window|from\s+outside|via\s+(?:the\s+)?window/i;
  return sources.find((source) => exteriorLight.test(source.text) && !path.test(source.text));
}

/** 场景上下文只允许描述当前片段事实；出现规划类元信息即视为泄漏。 */
const SCENE_CONTEXT_META_RE = /前情|故事梗概|梗概|上集|回顾|continuity|连续性|警告|warning|AI\s*编译|编译说明|评分|logline|prior\s*context|previous\s*episode|user\s*reference/iu;

/** 以中文句号/英文句末标点计数；省略句末标点视为一个未闭合句子。 */
function countSceneContextSentences(text: string): number {
  if (!text.trim()) return 0;
  const ends = (text.match(/[。！？]/g) ?? []).length + (text.match(/[.!?](?![0-9])/g) ?? []).length;
  return ends + (/[。！？.!?]$/.test(text.trim()) ? 0 : 1);
}

/** Project brief duration is stored as human-readable text such as "15秒" / "15s". */
export function sceneMaxDurationSeconds(scene: SceneV2): number | undefined {
  return parseSeconds(scene.duration);
}

/**
 * Produce one monotonic scene timeline without mutating project data.
 * Explicit ranges are retained only when all shots are chronological and non-overlapping.
 */
export function normalizeSceneShotTimeline(scene: SceneV2): Map<string, TimeRange> {
  const shots = scene.shots ?? [];
  const hasUsableExplicitTimeline = shots.length > 0 && shots.every((shot, index) => {
    if (!shot.time || shot.time.endSeconds <= shot.time.startSeconds) return false;
    const previous = shots[index - 1]?.time;
    return !previous || shot.time.startSeconds >= previous.endSeconds;
  });

  if (hasUsableExplicitTimeline) {
    return new Map(shots.map((shot) => [shot.id, { ...shot.time! }]));
  }

  let cursor = 0;
  return new Map(shots.map((shot) => {
    const startSeconds = cursor;
    cursor += shotDurationSeconds(shot);
    return [shot.id, { startSeconds, endSeconds: cursor }];
  }));
}

/** Builds the renderer's authoritative, UI-metadata-free scene snapshot. */
export function createFinalPromptDocument(scene: SceneV2, audit: FinalPromptAuditResult = auditFinalPrompt(scene)): FinalPromptDocument {
  const shots = (scene.shots ?? []).map((shot) => ({
    id: shot.id,
    label: shot.label,
    time: audit.shotTimes.get(shot.id) ?? { startSeconds: 0, endSeconds: 0 },
    participantIds: (shot.participants ?? []).map((participant) => participant.characterId),
    speakerIds: (shot.beats ?? []).filter((beat) => beat.dialogue?.trim() && beat.actorId).map((beat) => beat.actorId as string),
    propIds: [...new Set([
      ...(shot.beats ?? []).map((beat) => beat.targetPropId).filter((id): id is string => Boolean(id)),
    ])],
    hasVisibleAction: Boolean(shot.action?.trim() || (shot.beats ?? []).some((beat) => beat.verb?.trim() || beat.actionText?.trim())),
  }));
  return {
    formatMode: scene.shootingMode === "multi-shot" ? "multi-shot" : "long-take",
    totalDurationSeconds: audit.totalDurationSeconds,
    maxDurationSeconds: audit.maxDurationSeconds,
    firstFrameSubjectIds: [...(scene.firstFrameLock?.requiredSubjectIds ?? [])],
    shots,
    shotTimes: audit.shotTimes,
  };
}

/**
 * Final-export audit. Deterministic conflicts are exposed here before rendering;
 * compiler callers use the normalized ranges so an AI draft cannot reset each shot to 0.
 */
export function auditFinalPrompt(scene: SceneV2): FinalPromptAuditResult {
  const issues: FinalPromptAuditIssue[] = [];
  const adjustments: FinalPromptAuditAdjustment[] = [];
  const shotTimes = normalizeSceneShotTimeline(scene);
  const totalDurationSeconds = Math.max(0, ...[...shotTimes.values()].map((time) => time.endSeconds));
  const maxDurationSeconds = sceneMaxDurationSeconds(scene);
  const hasMultipleShots = (scene.shots?.length ?? 0) > 1;
  const hasNonMonotonicTimes = (scene.shots ?? []).some((shot, index, shots) => {
    if (!shot.time || shot.time.endSeconds <= shot.time.startSeconds) return true;
    const previous = shots[index - 1]?.time;
    return Boolean(previous && shot.time.startSeconds < previous.endSeconds);
  });
  const formatRange = (time: TimeRange | undefined) => time
    ? `${time.startSeconds.toFixed(1)}–${time.endSeconds.toFixed(1)}s`
    : "unset";

  const sceneContext = scene.sceneContext?.trim() ?? "";
  if (!sceneContext) {
    issues.push({
      code: "FINAL.SCENE_CONTEXT_MISSING",
      severity: "warning",
      detail: "The final export has no scene context. Add one sentence that states what is happening now, who is in frame, where/when it takes place, and the clip duration.",
      detailZh: "最终提示词缺少第一段场景上下文。请补一句：当前正在发生什么、谁在画面内、在哪里/什么时间、共拍多久。",
      field: "staging",
      action: "review-staging",
    });
  } else {
    if (SCENE_CONTEXT_META_RE.test(sceneContext)) {
      issues.push({
        code: "FINAL.SCENE_CONTEXT_META_LEAK",
        severity: "error",
        detail: "Scene context must describe this clip only. It contains prior context, a story summary, AI instructions, or audit metadata and will not be exported.",
        detailZh: "场景上下文混入了前情/故事梗概/AI 说明等元信息，不能作为第一段导出，请改为只描述当前片段。",
        field: "staging",
        action: "review-staging",
      });
    }
    const sentenceCount = countSceneContextSentences(sceneContext);
    if (sentenceCount > 3) {
      issues.push({
        code: "FINAL.SCENE_CONTEXT_TOO_LONG",
        severity: "warning",
        detail: `Scene context uses ${sentenceCount} sentences. Keep it to 3 sentences; short clips should fit in 1-2.`,
        detailZh: `场景上下文有 ${sentenceCount} 个句子，超过 3 句上限；15 秒内的短片段请尽量压到 1–2 句。`,
        field: "staging",
        action: "review-staging",
      });
    }
  }

  if (scene.shootingMode === "long-take" && hasMultipleShots) {
    issues.push({
      code: "FINAL.MODE_SHOT_CONFLICT",
      severity: "warning",
      detail: "Multiple draft shot segments were consolidated into one continuous take with a unified camera and beat flow.",
      detailZh: "长镜头中的多个旧分段已合并为同一摄影机下的连续节拍，不作为阻断问题。",
    });
    adjustments.push({
      code: "FINAL.MODE_SHOT_CONFLICT",
      detail: `${scene.shots.length} legacy shot segment(s) -> one continuous take from 0:00 to ${totalDurationSeconds.toFixed(1)}s.`,
      detailZh: `${scene.shots.length} 个旧镜头分段 -> 一条从 0:00 到 ${totalDurationSeconds.toFixed(1)} 秒的连续长镜头。`,
    });
  }
  if (hasNonMonotonicTimes) {
    issues.push({
      code: "FINAL.TIMELINE_NORMALIZED",
      severity: "warning",
      detail: "Shot time ranges overlapped or reset and were normalized into a single monotonic timeline.",
      detailZh: "镜头时间存在重叠或从零重置，已按镜头顺序归一为一条连续时间轴。",
    });
    adjustments.push({
      code: "FINAL.TIMELINE_NORMALIZED",
      detail: `${(scene.shots ?? []).map((shot) => `${shot.label} ${formatRange(shot.time)}`).join(", ")} -> ${(scene.shots ?? []).map((shot) => `${shot.label} ${formatRange(shotTimes.get(shot.id))}`).join(", ")}.`,
      detailZh: `${(scene.shots ?? []).map((shot) => `${shot.label} ${formatRange(shot.time)}`).join("，")} -> ${(scene.shots ?? []).map((shot) => `${shot.label} ${formatRange(shotTimes.get(shot.id))}`).join("，")}。`,
    });
  }
  if (scene.shootingMode === "multi-shot") {
    for (const [index, shot] of (scene.shots ?? []).entries()) {
      if (index === 0 || shot.cutStyle || scene.cutStyleDefault) continue;
      issues.push({
        code: "FINAL.CUT_STYLE_DEFAULTED",
        severity: "warning",
        detail: `Shot ${index + 1} had no cut style and exports with a hard cut by default.`,
        detailZh: `镜头 ${index + 1} 未设置切点，最终输出已默认使用硬切。`,
      });
      adjustments.push({
        code: "FINAL.CUT_STYLE_DEFAULTED",
        shotId: shot.id,
        detail: `Shot ${index + 1} cut style: unset -> hard cut.`,
        detailZh: `镜头 ${index + 1} 切点：未设置 -> 硬切。`,
      });
    }
  }
  const windowLightConflict = findWindowLightFactConflict(scene);
  if (windowLightConflict) {
    issues.push({
      code: "FINAL.WINDOW_LIGHT_FACT_CONFLICT",
      severity: "error",
      detail: `${windowLightConflict.black.label}: "${windowLightConflict.black.text}" conflicts with ${windowLightConflict.light.label}: "${windowLightConflict.light.text}". Choose one exterior fact before export.`,
      detailZh: `${windowLightConflict.black.labelZh}：“${windowLightConflict.black.text}” 与 ${windowLightConflict.light.labelZh}：“${windowLightConflict.light.text}”相互冲突。导出前必须确定一种窗外事实。`,
      field: "lighting",
      action: "review-lighting",
    });
  }
  const exteriorLightWithoutPath = findExteriorLightWithoutPath(scene);
  if (exteriorLightWithoutPath) {
    issues.push({
      code: "FINAL.EXTERIOR_LIGHT_PATH_MISSING",
      severity: "warning",
      detail: `${exteriorLightWithoutPath.label} names exterior neon or street light but does not state how it reaches the frame. Specify that it passes through the window or comes from outside.`,
      detailZh: `${exteriorLightWithoutPath.labelZh}写了窗外霓虹或街灯，但没有说明它如何进入画面。请明确光线透过车窗或从窗外进入。`,
      field: "lighting",
      action: "review-lighting",
    });
  }

  if (!scene.firstFrameLock?.occupancyStatement?.trim() && (scene.firstFrameLock?.requiredSubjectIds?.length ?? 0) === 0) {
    issues.push({
      code: "FINAL.FIRST_FRAME_MISSING",
      severity: "warning",
      detail: "The scene has no first-frame occupancy lock. Define who is visible and where they are before the first camera movement.",
      detailZh: "场景缺少首帧占位锁。请先明确第一帧谁可见、位于何处，再描述摄影机运动。",
      field: "staging",
      action: "review-staging",
    });
  }

  for (const shot of scene.shots ?? []) {
    const fov = shot.optics?.fieldOfViewDegrees;
    for (const outcome of shot.optics?.lensOutcome ?? []) {
      const normalized = normalizeOpticsText(outcome, fov);
      if (!normalized.changed) continue;
      issues.push({
        code: "FINAL.OPTICS_TERMS_NORMALIZED",
        severity: "warning",
        detail: `Shot ${shot.label} contained an optical result incompatible with ${fov}° and will use a normalized visible result.`,
        detailZh: `镜头 ${shot.label} 的光学结果与 ${fov}° 不一致，最终输出会使用已规范的可见结果。`,
        shotId: shot.id,
        field: "optics",
        action: "review-optics",
      });
      adjustments.push({
        code: "FINAL.OPTICS_TERMS_NORMALIZED",
        shotId: shot.id,
        detail: `Normalized "${outcome}" to "${normalized.text}".`,
        detailZh: `已将“${outcome}”规范为“${normalized.text}”。`,
      });
    }
    if (isAbstractPerformance(shot.acting)) {
      issues.push({
        code: "FINAL.ABSTRACT_PERFORMANCE",
        severity: "warning",
        detail: `Shot ${shot.label} uses an abstract performance label without a visible action. Add eye line, breath, hand business, pause, or posture.`,
        detailZh: `镜头 ${shot.label} 只有抽象情绪，没有可拍摄行为。请补充眼神、呼吸、手部业务、停顿或姿势。`,
        shotId: shot.id,
        field: "acting",
        action: "review-acting",
      });
    }
    if ((shot.beats ?? []).length === 0 && !shot.action?.trim()) {
      issues.push({
        code: "FINAL.ACTION_BEATS_MISSING",
        severity: "warning",
        detail: `Shot ${shot.label} has no action beats or fallback action. Add a visible action before final delivery.`,
        detailZh: `镜头 ${shot.label} 没有动作节拍或备用动作。请先补充可见动作，再进行最终交付。`,
        shotId: shot.id,
        field: "action",
        action: "review-action",
      });
    }
  }

  if (maxDurationSeconds && totalDurationSeconds > maxDurationSeconds + 0.01) {
    issues.push({
      code: "FINAL.DURATION_EXCEEDED",
      severity: "error",
      detail: `The ${totalDurationSeconds.toFixed(1)}s shot plan exceeds the ${maxDurationSeconds.toFixed(1)}s scene limit.`,
      detailZh: `镜头计划总长 ${totalDurationSeconds.toFixed(1)} 秒，超过场景上限 ${maxDurationSeconds.toFixed(1)} 秒；需要重新分镜，不能静默截断。`,
    });
  }

  return { issues, adjustments, shotTimes, totalDurationSeconds, maxDurationSeconds };
}

/** Adds speaker/voice-lock checks without making `auditFinalPrompt` depend on a project store. */
export function auditFinalPromptWithProject(scene: SceneV2, assets: { id: string; kind: string; actingProfile?: { voicePrompt?: string; voicePromptZh?: string } }[]): FinalPromptAuditResult {
  const audit = auditFinalPrompt(scene);
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  const checked = new Set<string>();
  for (const shot of scene.shots ?? []) {
    for (const beat of shot.beats ?? []) {
      if (!beat.dialogue?.trim() || !beat.actorId || checked.has(beat.actorId)) continue;
      checked.add(beat.actorId);
      const speaker = assetsById.get(beat.actorId);
      const hasVoiceLock = Boolean(speaker?.actingProfile?.voicePrompt?.trim() || speaker?.actingProfile?.voicePromptZh?.trim());
      if (speaker?.kind === "character" && !hasVoiceLock) {
        audit.issues.push({
          code: "FINAL.SPEAKER_VOICE_LOCK_MISSING",
          severity: "warning",
          detail: `The speaking character ${speaker.id} has dialogue but no voice lock. Add one before final delivery for a stable voice.`,
          detailZh: `开口角色缺少声音锁。为获得稳定音色，请在最终交付前补充声音锁。`,
          shotId: shot.id,
          field: "voice",
          action: "review-voice",
        });
      }
    }
  }
  return audit;
}
