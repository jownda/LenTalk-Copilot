/**
 * 连续性面板（P0.5）
 * 问题按规则组分组（Identity/Spatial/Prop/Causality/Technical/Audio）、组内按严重级别排序；
 * 可一键修复（fixLabel 存在时）；风险评分条（整体 + 每镜头 0-10）。
 */
import { useMemo } from "react";
import type { ContinuityIssueV2, ProjectV2, SceneV2 } from "../../shared-types";
import { computeRiskScores } from "../../engine";
import { CheckCircle2, ChevronDown, CircleAlert, Info, ShieldAlert, Sparkles, Wrench, XCircle } from "lucide-react";
import { useState } from "react";
import { issueLabels, type CopyZh, type Locale } from "../i18n";

type GroupKey = "identity" | "spatial" | "prop" | "causality" | "technical" | "audio" | "acting" | "context";

const GROUP_ORDER: GroupKey[] = ["identity", "spatial", "prop", "causality", "technical", "audio", "acting", "context"];

function groupOf(code: string): GroupKey {
  if (code.startsWith("IDENTITY.")) return "identity";
  if (code.startsWith("SPATIAL.")) return "spatial";
  if (code.startsWith("PROP.")) return "prop";
  if (code.startsWith("CAUSALITY.")) return "causality";
  if (code.startsWith("AUDIO.")) return "audio";
  if (code.startsWith("ACTING.")) return "acting";
  if (code.startsWith("CONTEXT.")) return "context";
  return "technical"; // SCENE.* / TECHNICAL.*
}

/** 导出前清单：按检查族映射（P3 §5.2），error 未清零时导出被锁定 */
type ChecklistKey = "identity" | "spatial" | "prop" | "causality" | "technical" | "audio" | "acting" | "optics" | "camera" | "dialogue" | "context" | "lighting" | "physics";
const CHECKLIST: { key: ChecklistKey; prefixes: string[] }[] = [
  { key: "identity", prefixes: ["IDENTITY."] },
  { key: "spatial", prefixes: ["SPATIAL."] },
  { key: "prop", prefixes: ["PROP."] },
  { key: "causality", prefixes: ["CAUSALITY."] },
  { key: "technical", prefixes: ["TECHNICAL.", "SCENE.", "FILM."] },
  { key: "audio", prefixes: ["AUDIO."] },
  { key: "acting", prefixes: ["ACTING."] },
  { key: "optics", prefixes: ["OPTICS."] },
  { key: "camera", prefixes: ["CAMERA."] },
  { key: "dialogue", prefixes: ["DIALOGUE."] },
  { key: "context", prefixes: ["CONTEXT."] },
  { key: "lighting", prefixes: ["LIGHTING."] },
  { key: "physics", prefixes: ["PHYSICS."] },
];
const CHECKLIST_LABEL = (key: ChecklistKey, t: CopyZh) => ({
  identity: t.groupIdentity, spatial: t.groupSpatial, prop: t.groupProp, causality: t.groupCausality, technical: t.groupTechnical, audio: t.groupAudio, acting: t.groupActing, optics: t.groupOptics, camera: t.groupCamera, dialogue: t.groupDialogue, context: t.groupContext, lighting: t.groupLighting, physics: t.groupPhysics,
}[key]);

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

interface ContinuityPanelProps {
  project: ProjectV2;
  scene: SceneV2;
  issues: ContinuityIssueV2[];
  t: CopyZh;
  locale: Locale;
  onFix(issue: ContinuityIssueV2): void;
  /** P3：AI 结构化修复建议（只建议，不直接改数据） */
  onAiAdvice?(issue: ContinuityIssueV2): void;
}

export default function ContinuityPanel({ project, scene, issues, t, locale, onFix, onAiAdvice }: ContinuityPanelProps) {
  const risks = useMemo(() => computeRiskScores(project, scene), [project, scene]);
  const groups = useMemo(() => {
    const map = new Map<GroupKey, ContinuityIssueV2[]>();
    for (const key of GROUP_ORDER) map.set(key, []);
    for (const issue of issues) {
      const key = groupOf(issue.code);
      map.get(key)!.push(issue);
    }
    for (const list of map.values()) list.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
    return map;
  }, [issues]);

  const groupLabel = (key: GroupKey) => ({ identity: t.groupIdentity, spatial: t.groupSpatial, prop: t.groupProp, causality: t.groupCausality, technical: t.groupTechnical, audio: t.groupAudio, acting: t.groupActing, context: t.groupContext })[key];
  const [checklistOpen, setChecklistOpen] = useState(false);
  const checklist = useMemo(() => CHECKLIST.map(({ key, prefixes }) => {
    const list = issues.filter((issue) => prefixes.some((prefix) => issue.code.startsWith(prefix)));
    const errors = list.filter((issue) => issue.severity === "error").map((issue) => issue.code);
    const warnings = list.filter((issue) => issue.severity === "warning").length;
    return { key, errors, warnings, total: list.length };
  }), [issues]);
  const blockedCount = checklist.filter((item) => item.errors.length > 0).length;
  const passedCount = checklist.filter((item) => item.total === 0).length;
  const levelLabel = (level: "low" | "medium" | "high") => ({ low: t.riskLevelLow, medium: t.riskLevelMedium, high: t.riskLevelHigh })[level];

  return <div className="continuity-panel">
    {/* 风险评分条 */}
    <div className="risk-bar">
      <div className="risk-overall">
        <span className="risk-label">{t.riskOverall}</span>
        <span className={`risk-score ${risks.overall.level}`}>{risks.overall.score}</span>
        <span className={`risk-level ${risks.overall.level}`}>{levelLabel(risks.overall.level)}</span>
        <span className="risk-bar-track"><i className={risks.overall.level} style={{ width: `${risks.overall.score * 10}%` }} /></span>
      </div>
      <div className="risk-per-shot">
        {scene.shots.map((shot) => {
          const risk = risks.perShot.get(shot.id);
          if (!risk) return null;
          return <span className="risk-shot" key={shot.id} title={`${shot.label}: ${risk.score}`}>
            <b>{shot.label}</b>
            <span className="risk-bar-track mini"><i className={risk.level} style={{ width: `${risk.score * 10}%` }} /></span>
            <em className={risk.level}>{risk.score}</em>
          </span>;
        })}
      </div>
    </div>

    {/* 分组问题列表 */}
    <div className="issue-groups">
      {GROUP_ORDER.map((key) => {
        const list = groups.get(key)!;
        if (list.length === 0) return null;
        const errorCount = list.filter((issue) => issue.severity === "error").length;
        return <div className="issue-group" key={key}>
          <div className="issue-group-head">
            <span>{groupLabel(key)}</span>
            <em>{list.length}{errorCount > 0 ? ` · ${errorCount} ${t.issueError}` : ""}</em>
          </div>
          {list.map((issue, issueIndex) => <IssueRow key={`${issue.code}-${issue.entityId ?? ""}-${issueIndex}`} issue={issue} t={t} locale={locale} onFix={onFix} onAiAdvice={onAiAdvice} />)}
        </div>;
      })}
      {issues.length === 0 && <div className="issue-all-clear"><CheckCircle2 size={14} /> {t.continuityOk}</div>}
    </div>

    {/* P3 导出前清单：按检查族逐项打勾/报错；error 未清零时导出按钮在提示词卡片置灰 */}
    <div className={`pre-export-checklist${blockedCount > 0 ? " blocked" : ""}`}>
      <button className="checklist-toggle" onClick={() => setChecklistOpen((open) => !open)} aria-expanded={checklistOpen}>
        <span><ShieldAlert size={13} /> {t.preExportChecklist}</span>
        <em className={blockedCount > 0 ? "bad" : "ok"}>{blockedCount > 0 ? `${blockedCount} · ${t.checklistBlocked}` : `${passedCount}/${checklist.length} · ${t.checklistPassed}`}</em>
        <ChevronDown size={13} className={`chevron${checklistOpen ? " open" : ""}`} />
      </button>
      {checklistOpen && <div className="checklist-body">
        <div className="checklist-row">
        {checklist.map((item) => {
          const label = CHECKLIST_LABEL(item.key, t);
          const icon = item.errors.length > 0
            ? <XCircle size={13} className="check-error" />
            : item.total > 0
              ? <CircleAlert size={13} className={`check-warn${item.warnings > 0 ? "" : " check-info"}`} />
              : <CheckCircle2 size={13} className="check-ok" />;
          return <div className={`checklist-item${item.errors.length > 0 ? " error" : item.total > 0 ? " warn" : " ok"}`} key={item.key}>
            {icon}
            <span className="check-label">{label}</span>
            {item.errors.length > 0
              ? <em className="check-errors" title={item.errors.join(", ")}>{item.errors.join(" / ")}</em>
              : item.total > 0
                ? <em className="check-count">{item.warnings} {t.issueWarning}</em>
                : <em className="check-count">✓</em>}
          </div>;
        })}
        </div>
        {blockedCount > 0 && <p className="checklist-hint"><XCircle size={12} /> {t.exportBlockedHint}</p>}
      </div>}
    </div>
  </div>;
}

function IssueRow({ issue, t, locale, onFix, onAiAdvice }: { issue: ContinuityIssueV2; t: CopyZh; locale: Locale; onFix(issue: ContinuityIssueV2): void; onAiAdvice?(issue: ContinuityIssueV2): void }) {
  const Icon = issue.severity === "error" ? CircleAlert : issue.severity === "warning" ? CircleAlert : Info;
  const label = locale === "zh" ? (issueLabels.zh[issue.code] ?? issue.label) : issue.label;
  const detail = locale === "zh" ? (issue.detailZh ?? issue.detail) : issue.detail;
  return <div className={`issue-row ${issue.severity}`}>
    <Icon size={13} className="issue-icon" />
    <div className="issue-main">
      <span className="issue-label">{label}</span>
      <span className="issue-detail">{detail}</span>
    </div>
    {onAiAdvice && <button className="issue-fix ai" title={t.aiFixLabel} onClick={() => onAiAdvice(issue)}><Sparkles size={11} /> AI</button>}
    {issue.fixLabel && <button className="issue-fix" onClick={() => onFix(issue)}><Wrench size={11} /> {t.fix}</button>}
  </div>;
}
