/**
 * 成片质量检查：只显示整体状态和需要处理的问题。
 * 详细规则仍由 continuity engine 执行，本组件只负责把结果转成可操作的 UI。
 */
import type { ContinuityIssueV2, ProjectV2, SceneV2 } from "../../shared-types";
import type { DirectorLayerIssue } from "../../engine/quality";
import { Check, CheckCircle2, CircleAlert, Copy, Info, Sparkles, Wrench, XCircle } from "lucide-react";
import { useState } from "react";
import { issueLabels, type CopyZh, type Locale } from "../i18n";

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

interface ContinuityPanelProps {
  project: ProjectV2;
  scene: SceneV2;
  issues: ContinuityIssueV2[];
  t: CopyZh;
  locale: Locale;
  directorIssues?: DirectorLayerIssue[];
  onFix(issue: ContinuityIssueV2): void;
  onAiAdvice?(issue: ContinuityIssueV2): void;
}

export default function ContinuityPanel({ issues, t, locale, directorIssues = [], onFix, onAiAdvice }: ContinuityPanelProps) {
  const allIssues = [
    ...directorIssues.map((issue) => ({ kind: "director" as const, issue })),
    ...issues.map((issue) => ({ kind: "continuity" as const, issue })),
  ].sort((a, b) => SEVERITY_ORDER[a.issue.severity] - SEVERITY_ORDER[b.issue.severity]);
  const errorCount = allIssues.filter(({ issue }) => issue.severity === "error").length;
  const warningCount = allIssues.filter(({ issue }) => issue.severity === "warning").length;
  const status = errorCount > 0 ? "error" : warningCount > 0 ? "warning" : "passed";

  return <div className="continuity-panel">
    <div className={`quality-summary ${status}`}>
      <span className="quality-summary-icon">
        {status === "error" ? <XCircle size={16} /> : status === "warning" ? <CircleAlert size={16} /> : <CheckCircle2 size={16} />}
      </span>
      <div>
        <strong>{status === "error" ? t.qualityNeedsFix : status === "warning" ? t.qualityNeedsReview : t.qualityPassed}</strong>
        <span>{allIssues.length === 0 ? t.qualityNoIssues : [
          errorCount > 0 ? `${errorCount} ${t.issueError}` : "",
          warningCount > 0 ? `${warningCount} ${t.issueWarning}` : "",
        ].filter(Boolean).join(" · ")}</span>
      </div>
    </div>

    {allIssues.length > 0 && <div className="issue-groups">
      <div className="quality-issues-title">{t.qualityIssues}</div>
      {allIssues.map(({ kind, issue }, issueIndex) => kind === "director"
        ? <DirectorIssueRow key={`${issue.code}-${issue.layerKey ?? ""}-${issueIndex}`} issue={issue} locale={locale} t={t} />
        : <IssueRow key={`${issue.code}-${issue.entityId ?? ""}-${issueIndex}`} issue={issue} t={t} locale={locale} onFix={onFix} onAiAdvice={onAiAdvice} />)}
    </div>}
  </div>;
}

function DirectorIssueRow({ issue, locale, t }: { issue: DirectorLayerIssue; locale: Locale; t: CopyZh }) {
  const Icon = issue.severity === "error" ? XCircle : CircleAlert;
  const label = locale === "zh" ? issue.detailZh.split("；")[0] || issue.label : issue.label;
  const detail = locale === "zh" ? issue.detailZh : issue.detail;
  const suggestion = locale === "zh" ? issue.suggestionZh : issue.suggestion;
  const source = issue.layerKey ? ` · ${issue.layerKey}${issue.line ? `:${issue.line}` : ""}` : "";
  return <div className={`issue-row ${issue.severity}`}>
    <Icon size={13} className="issue-icon" />
    <div className="issue-main">
      <span className="issue-label">{label}</span>
      <span className="issue-detail">{detail}{source}</span>
      {suggestion && <span className="issue-detail">{suggestion}</span>}
    </div>
    <span className="issue-quality-code">{issue.code}</span>
    <CopyIssueButton text={[label, `${detail}${source}`, suggestion, issue.code].filter(Boolean).join("\n")} t={t} />
  </div>;
}

function IssueRow({ issue, t, locale, onFix, onAiAdvice }: { issue: ContinuityIssueV2; t: CopyZh; locale: Locale; onFix(issue: ContinuityIssueV2): void; onAiAdvice?(issue: ContinuityIssueV2): void }) {
  const Icon = issue.severity === "error" ? XCircle : issue.severity === "warning" ? CircleAlert : Info;
  const label = locale === "zh" ? (issueLabels.zh[issue.code] ?? issue.label) : issue.label;
  const detail = locale === "zh" ? (issue.detailZh ?? issue.detail) : issue.detail;
  return <div className={`issue-row ${issue.severity}`}>
    <Icon size={13} className="issue-icon" />
    <div className="issue-main">
      <span className="issue-label">{label}</span>
      <span className="issue-detail">{detail}</span>
    </div>
    <CopyIssueButton text={[label, detail, issue.code].filter(Boolean).join("\n")} t={t} />
    {onAiAdvice && <button className="issue-fix ai" title={t.aiFixLabel} onClick={() => onAiAdvice(issue)}><Sparkles size={11} /> AI</button>}
    {issue.fixLabel && <button className="issue-fix" onClick={() => onFix(issue)}><Wrench size={11} /> {t.fix}</button>}
  </div>;
}

function CopyIssueButton({ text, t }: { text: string; t: CopyZh }) {
  const [copied, setCopied] = useState(false);
  const copyLabel = t.copyIssue;
  const copiedLabel = t.issueCopied;

  const copyIssue = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (error) {
      console.error("Failed to copy continuity issue", error);
    }
  };

  return <button
    type="button"
    className={`issue-copy${copied ? " copied" : ""}`}
    title={copied ? copiedLabel : copyLabel}
    aria-label={copied ? copiedLabel : copyLabel}
    onClick={() => void copyIssue()}
  >
    {copied ? <Check size={13} /> : <Copy size={13} />}
  </button>;
}
