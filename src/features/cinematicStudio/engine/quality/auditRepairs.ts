/**
 * AI 审核冲突修复规划（P4.5）
 * 把最终审核发现的每一条冲突映射成可执行的修复方案：
 *  - auto   确定性能修改：点一下直接写入数据
 *  - ai     AI 生成候选文本，预览后由用户确认应用
 *  - options 用户决策型冲突：给出 2-3 个选项，点击即生效
 * 全部在审核详情内完成，不需要用户跳回左侧面板找字段。
 */
import type { ActionBeat, ContinuityIssueV2, ProjectV2, SceneV2, ShotV2 } from "../../shared-types";
import { normalizeOpticsText } from "./finalAudit";

export type AuditRepairSource = "final" | "continuity";
export type AuditRepairMode = "auto" | "options" | "ai";

export interface AuditRepairChoice {
  /** 稳定 id，App 通过它分发实际修改 */
  id: string;
  label: string;
  labelEn?: string;
  detailZh?: string;
  detail?: string;
  /** data：确定性写入数据；ai：先由 AI 生成文本再应用 */
  mode: "data" | "ai";
  /** AI 模式下给生成 prompt 的字段提示，用于决定生成什么内容 */
  generateFor?: "acting" | "first-frame" | "voice" | "beats" | "replan";
}

export interface AuditRepairPlan {
  key: string;
  code: string;
  entityId?: string;
  severity: "error" | "warning" | "info";
  source: AuditRepairSource;
  mode: AuditRepairMode;
  titleZh: string;
  title: string;
  summaryZh: string;
  summary: string;
  choices: AuditRepairChoice[];
}

const FINAL_TITLES: Record<string, { zh: string; en: string }> = {
  "FINAL.CUT_STYLE_DEFAULTED": { zh: "镜头缺少切点", en: "Shot missing cut style" },
  "FINAL.OPTICS_TERMS_NORMALIZED": { zh: "光学结果与视场角冲突", en: "Optical result conflicts with FOV" },
  "FINAL.ABSTRACT_PERFORMANCE": { zh: "只有抽象情绪，缺少可拍摄行为", en: "Abstract emotion without visible behavior" },
  "FINAL.ACTION_BEATS_MISSING": { zh: "镜头缺少动作内容", en: "Shot has no visible action" },
  "FINAL.FIRST_FRAME_MISSING": { zh: "缺少首帧占位锁", en: "First-frame lock missing" },
  "FINAL.SPEAKER_VOICE_LOCK_MISSING": { zh: "开口角色缺少声音锁", en: "Speaker missing voice lock" },
  "FINAL.WINDOW_LIGHT_FACT_CONFLICT": { zh: "窗外光线与窗外纯黑冲突", en: "Window light conflicts with black window" },
  "FINAL.EXTERIOR_LIGHT_PATH_MISSING": { zh: "窗外光源缺少进入画面的路径", en: "Exterior light needs a path into frame" },
  "FINAL.DURATION_EXCEEDED": { zh: "镜头总长超过场景时长上限", en: "Shot plan exceeds scene duration limit" },
};

/** 已具备确定性一键修复的连续性代码（与 App.fixIssue 保持一致） */
const CONTINUITY_FIXABLE_CODES = new Set([
  "SCENE.ENVIRONMENT_UNLOCKED",
  "TECHNICAL.PROFILE_MISSING",
  "TECHNICAL.NEGATIVE_EMPTY",
  "AUDIO.PLAN_MISSING",
  "AUDIO.CONFLICT",
  "SPATIAL.AXIS_CONFLICT",
]);

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function planKey(code: string, entityId?: string): string {
  return `${code}::${entityId ?? "scene"}`;
}

function shotSummary(shot: ShotV2 | undefined, zh: string, en: string): { zh: string; en: string } {
  return { zh: shot ? `${zh}（镜头：${shot.label}）` : zh, en: shot ? `${en} (shot: ${shot.label})` : en };
}

/**
 * 构建审核详情内的修复计划。
 * 自动修正（长镜头合并/时间轴归一）已经在导出时生效，不重复列出；
 * 其余冲突都给出可在详情内直接执行的方案。
 */
export function buildAuditRepairPlans(
  project: ProjectV2,
  scene: SceneV2,
  finalIssues: readonly { code: string; severity: "error" | "warning" | "info"; detail: string; detailZh?: string; shotId?: string }[],
  continuityIssues: ContinuityIssueV2[],
): AuditRepairPlan[] {
  const plans: AuditRepairPlan[] = [];
  const shotById = new Map(scene.shots.map((shot) => [shot.id, shot]));
  const seen = new Set<string>();

  for (const issue of finalIssues) {
    if (!(issue.code in FINAL_TITLES)) continue;
    const titles = FINAL_TITLES[issue.code];
    const shot = issue.shotId ? shotById.get(issue.shotId) : undefined;
    const key = planKey(issue.code, issue.shotId);
    if (seen.has(key)) continue;
    seen.add(key);
    const base = shotSummary(shot, titles.zh, titles.en);
    const summaryZh = issue.detailZh ?? base.zh;
    const summary = issue.detail ?? base.en;
    const common = {
      key,
      code: issue.code,
      entityId: issue.shotId,
      severity: issue.severity,
      source: "final" as const,
      titleZh: base.zh,
      title: base.en,
      summaryZh,
      summary,
    };

    switch (issue.code) {
      case "FINAL.CUT_STYLE_DEFAULTED":
        plans.push({ ...common, mode: "auto", choices: [
          { id: "apply-cut", label: "一键应用硬切", labelEn: "Apply hard cut", mode: "data", detailZh: "把该镜头的切点写入数据，并作为导出事实。", detail: "Writes a hard cut into the shot data." },
        ] });
        break;
      case "FINAL.OPTICS_TERMS_NORMALIZED":
        plans.push({ ...common, mode: "auto", choices: [
          { id: "apply-optics", label: "应用规范后的光学结果", labelEn: "Apply normalized optics", mode: "data", detailZh: "把与视场角一致的可见光学结果写回镜头数据。", detail: "Writes the FOV-compatible visible optics back to the shot." },
        ] });
        break;
      case "FINAL.ABSTRACT_PERFORMANCE":
        plans.push({ ...common, mode: "ai", choices: [
          { id: "ai-rewrite-acting", label: "AI 重写为可拍摄行为", labelEn: "AI rewrite as visible behavior", mode: "ai", generateFor: "acting", detailZh: "AI 根据剧情与情绪，输出眼神/呼吸/手部/姿势等可拍摄描述。", detail: "The model rewrites the performance into observable behavior." },
        ] });
        break;
      case "FINAL.ACTION_BEATS_MISSING":
        plans.push({ ...common, mode: "options", choices: [
          { id: "default-beat", label: "添加默认节拍", labelEn: "Add default beat", mode: "data", detailZh: "角色静止，呼吸与视线清晰，先让镜头有可见动作基础。", detail: "Adds a steady presence beat with visible breath and eye life." },
          { id: "ai-beats", label: "AI 按剧情生成动作节拍", labelEn: "AI generate beats", mode: "ai", generateFor: "beats", detailZh: "由 AI 根据场景与参与角色生成 1-6 个动作节拍。", detail: "AI generates 1-6 action beats from the scene context." },
        ] });
        break;
      case "FINAL.FIRST_FRAME_MISSING":
        plans.push({ ...common, mode: "options", choices: [
          { id: "ai-first-frame", label: "AI 生成首帧占位", labelEn: "AI first-frame lock", mode: "ai", generateFor: "first-frame", detailZh: "AI 根据参与者与位置生成首帧占位文案。", detail: "AI writes a first-frame occupancy statement from the participants." },
          { id: "default-first-frame", label: "使用默认占位", labelEn: "Default first frame", mode: "data", detailZh: "首镜参与者位于画面中央，先完成视线建立，再开始运镜。", detail: "Centers the primary participants and builds eyeline before camera moves." },
        ] });
        break;
      case "FINAL.SPEAKER_VOICE_LOCK_MISSING": {
        const character = issue.shotId
          ? scene.shots.find((item) => item.id === issue.shotId)?.beats?.find((beat) => beat.dialogue?.trim() && beat.actorId)?.actorId
          : undefined;
        const name = character ? (project.assets ?? []).find((asset) => asset.id === character)?.name : undefined;
        plans.push({ ...common, mode: "options", choices: [
          { id: "ai-voice", label: "AI 生成声音锁", labelEn: "AI voice lock", mode: "ai", generateFor: "voice", detailZh: name ? `为「${name}」生成一段稳定的声音锁公式并写入角色资产。` : "为开口角色生成一段稳定的声音锁公式并写入角色资产。", detail: "AI writes a stable voice-lock formula into the character asset." },
          { id: "skip-voice", label: "本次不强制声音锁", labelEn: "Leave as-is", mode: "data", detailZh: "保留原样继续导出；此问题作为建议保留。", detail: "Keeps the current state; the suggestion remains visible." },
        ] });
        break;
      }
      case "FINAL.WINDOW_LIGHT_FACT_CONFLICT":
      case "FINAL.EXTERIOR_LIGHT_PATH_MISSING":
        plans.push({ ...common, mode: "options", choices: [
          { id: "keep-window-light", label: "保留窗光并补写路径", labelEn: "Keep light, add path", mode: "data", detailZh: "在场景光线中补写“窗外光源透过车窗/窗户进入画面”。", detail: "Appends a visible path for the exterior light into the scene lighting." },
          { id: "remove-window-light", label: "移除窗外光源描述", labelEn: "Remove exterior light", mode: "data", detailZh: "从场景光线相关字段中移除窗外霓虹/街灯描述，保留室内光。", detail: "Removes exterior neon/street-light phrases from lighting fields." },
        ] });
        break;
      case "FINAL.DURATION_EXCEEDED":
        plans.push({ ...common, mode: "options", choices: [
          { id: "scale-times", label: "按比例压缩到上限内", labelEn: "Scale to limit", mode: "data", detailZh: "保持镜头比例，把总时长压缩到场景上限内并写入时间轴。", detail: "Scales shot durations proportionally into the scene limit." },
          { id: "replan-shots", label: "重新 AI 分镜", labelEn: "Re-plan with AI", mode: "ai", generateFor: "replan", detailZh: "让 AI 根据剧情节奏重新规划镜头数量与时长，不超过上限。", detail: "AI re-plans shots and timing within the scene limit." },
        ] });
        break;
      default:
        break;
    }
  }

  for (const issue of continuityIssues) {
    if (!CONTINUITY_FIXABLE_CODES.has(issue.code)) continue;
    const key = planKey(issue.code, issue.entityId);
    if (seen.has(key)) continue;
    seen.add(key);
    plans.push({
      key,
      code: issue.code,
      entityId: issue.entityId,
      severity: issue.severity,
      source: "continuity",
      mode: "auto",
      titleZh: issue.label,
      title: issue.label,
      summaryZh: issue.detailZh ?? issue.detail,
      summary: issue.detail,
      choices: [
        { id: "apply-fix", label: "一键修复", labelEn: "Fix now", mode: "data", detailZh: issue.detailZh ?? issue.detail, detail: issue.detail },
      ],
    });
  }

  return plans;
}

/** 按比例压缩镜头时间轴到场景上限（保持相对节奏）。 */
export function scaleShotTimesToLimit(scene: SceneV2, maxDuration: number): { id: string; time: { startSeconds: number; endSeconds: number } }[] {
  const shots = scene.shots ?? [];
  if (shots.length === 0) return [];
  const durations = shots.map((shot) => {
    if (shot.time && shot.time.endSeconds > shot.time.startSeconds) return shot.time.endSeconds - shot.time.startSeconds;
    return Math.max(0.1, (shot.beats ?? []).reduce((total, beat) => total + (beat.duration ?? 0), 0) || 1);
  });
  const total = durations.reduce((sum, duration) => sum + duration, 0);
  if (total <= 0) return [];
  const factor = Math.min(maxDuration, total) / total;
  let cursor = 0;
  return shots.map((shot, index) => {
    const duration = Math.max(0.1, round1(durations[index] * factor));
    const start = round1(cursor);
    cursor = round1(start + duration);
    return { id: shot.id, time: { startSeconds: start, endSeconds: cursor } };
  });
}

/** 把光学规范化结果写回镜头（与导出时同一套规则）。 */
export function normalizedOpticsPatch(shot: ShotV2): Pick<ShotV2, "optics"> | undefined {
  const fov = shot.optics?.fieldOfViewDegrees;
  const outcomes = shot.optics?.lensOutcome ?? [];
  if (fov == null || outcomes.length === 0) return undefined;
  const next = outcomes.map((outcome) => normalizeOpticsText(outcome, fov).text);
  const changed = next.some((text, index) => text !== outcomes[index]);
  if (!changed) return undefined;
  return { optics: { ...(shot.optics ?? {}), lensOutcome: next } };
}

const EXTERIOR_LIGHT_RE = /[，,；;。]\s*(?:窗外|车窗)[^。；;！!]{0,40}(?:霓虹|街灯|路灯|neon|street\s*light|streetlamp)|[，,；;。]\s*(?:霓虹|街灯|路灯|neon|street\s*light|streetlamp)[^。；;！!]{0,40}(?:窗外|车窗)/gi;

/** 移除场景光线字段中的窗外光源描述（含以“，”分隔的部分），保留其余室内光。 */
export function removeExteriorLightPhrases(lighting: string | undefined): string | undefined {
  if (!lighting?.trim()) return undefined;
  const cleaned = lighting.replace(EXTERIOR_LIGHT_RE, "").replace(/[，,；;]+$/, "").trim();
  return cleaned || undefined;
}

/** 补写窗外光源进入画面的可见路径。 */
export function appendWindowLightPath(lighting: string | undefined, locale: "zh" | "en"): string {
  const suffix = locale === "zh" ? "。窗外光源透过车窗/窗户进入画面，保留方向感。" : ". The exterior light enters the frame through the window, keeping a clear direction.";
  return lighting ? `${lighting.replace(/[。.\s]+$/, "")}${suffix}` : `室内顶光为主${suffix.replace(/^。/,"")}`;
}

/** 默认动作节拍：保证镜头至少有一个可拍摄的可见动作。 */
export function defaultActionBeat(shot: ShotV2): ActionBeat {
  const actor = shot.participants?.[0]?.characterId;
  return {
    id: crypto.randomUUID(),
    order: 1,
    duration: Math.max(1, Math.min(5, Math.round((shotTimeSeconds(shot) || 4) / 3))),
    actorId: actor,
    verb: "pauses",
    actionText: "角色保持静止，呼吸起伏清晰可见，视线先落定再完成微小的眼神移动",
    required: true,
    forbiddenTargets: [],
  };
}

function shotTimeSeconds(shot: ShotV2): number {
  if (shot.time && shot.time.endSeconds > shot.time.startSeconds) return shot.time.endSeconds - shot.time.startSeconds;
  const beats = shot.beats ?? [];
  return beats.reduce((total, beat) => total + (beat.duration ?? 0), 0) || 4;
}

/** 默认首帧占位锁文案（确定性回退，避免 AI 未配置时无法修复）。 */
export function defaultFirstFrameLock(scene: SceneV2, project: ProjectV2): { requiredSubjectIds: string[]; occupancyStatement: string } {
  const firstShot = scene.shots?.[0];
  const participants = firstShot?.participants?.map((participant) => participant.characterId).filter(Boolean) ?? [];
  const names = participants
    .map((id) => (project.assets ?? []).find((asset) => asset.id === id)?.name)
    .filter(Boolean);
  const subject = names.length > 0 ? names.join("、") : "主要角色";
  return {
    requiredSubjectIds: participants,
    occupancyStatement: `首帧锁定：${subject}位于画面主体位置，先完成视线建立，再开始摄影机运动；首帧不得出现未引用的资产。`,
  };
}
