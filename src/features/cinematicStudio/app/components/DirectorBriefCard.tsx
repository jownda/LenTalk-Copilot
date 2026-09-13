/**
 * 导演简报卡（P0.4 · 左侧面板重构第一步）
 * 把原来的「风格配方 / 场景 / 音频计划」三张卡合并为一张导演简报卡：
 * - 剧情：故事梗概 + 前情续接 + 参与角色（@ 资产点选）
 * - 场景站位：复用 StagingEditor（地点 / 轴 / 排序 / 间距 / 空间锚点）
 * - 风格描述：可直接填写；预制风格仅作为填充描述的辅助入口
 * - 硬约束：长镜头 / 多镜头 + 时长 + 必须发生 / 禁止发生
 * - 对白 + 情绪走向（可选）
 * - 音频计划：复用 AudioPlanEditor
 * 底部保留「导演分镜规划器 / 最终生成」按钮与 AI 错误展示。
 */
import { useEffect, useState } from "react";
import type { ProjectV2, SceneStaging, SceneV2 } from "../../shared-types";
import { Check, ChevronDown, Clapperboard, Copy, Film, Plus, RefreshCw, Sparkles, Trash2, X } from "lucide-react";
import type { CopyZh, Locale } from "../i18n";
import type { LenTalkChatModelOption, ReasoningEffort } from "../providers/aiSettings";
import type { SceneCompileProgress } from "../providers/ai";
import AudioPlanEditor from "./AudioPlanEditor";
import StagingEditor from "./StagingEditor";
import { resolveImageDisplayUrl } from "@/features/canvas/application/imageData";
import type { CanvasImageSource } from "./DirectorLayersCard";
import { directorIntentRefinementText, getStyle, localizedStyleBrief, MASTER_STYLES, styleBriefDescription } from "../../engine";
import type { CinematicStudioUpstreamText } from "../quickStudioSync";

/**
 * 上游接入文本的灰色只读回显。与画布极简节点（CinematicStudioNode）保持同一套规则：
 * 最多 3 行、超出省略号、hover 看全文，白色输入框里的内容始终是本地手输的原文。
 * 这份内容不写进工程文件，画布上断开上游后会自动消失。
 */
function UpstreamTextEcho({ texts }: { texts?: string[] }) {
  const lines = (texts ?? []).map((text) => text.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  return (
    <div aria-hidden="true" className="upstream-text-echo">
      {lines.slice(0, 3).map((text, index) => (
        <div className="upstream-text-echo-line" key={`upstream-echo-${index}`} title={text}>
          {text}
        </div>
      ))}
    </div>
  );
}

interface DirectorBriefCardProps {
  project: ProjectV2;
  scene: SceneV2;
  t: CopyZh;
  locale: Locale;
  canvasImageSources: CanvasImageSource[];
  compileBusy: boolean;
  finalGenerateBusy: boolean;
  compileProgress: SceneCompileProgress;
  compileReceivedChars: number;
  briefOptimizeBusy: boolean;
  styleOptimizeBusy: boolean;
  aiCompileError: string;
  aiCompileErrorDetail: string;
  aiErrorCopied: boolean;
  resumeAvailable: boolean;
  resumeBusy: boolean;
  onSelectScene(id: string): void;
  onAddScene(): void;
  onDeleteScene(id: string): void;
  onRenameScene(id: string, name: string): void;
  onUpdateScene(patch: Partial<SceneV2>): void;
  onUpdateStaging(patch: Partial<SceneStaging>): void;
  onUpdateProject(patch: Partial<ProjectV2>): void;
  onClearGeneratedContent(): void;
  onAiCompile(): void;
  onAiOptimizeBrief(): void;
  onAiOptimizeStyle(): void;
  onLocalCompile(): void;
  onCopyAiError(): void;
  onResumeInterrupted(): void;
  chatModels: LenTalkChatModelOption[];
  selectedChatModel: string;
  onSelectChatModel(value: string): void;
  selectedReasoningEffort: ReasoningEffort;
  onSelectReasoningEffort(value: ReasoningEffort): void;
  /** 画布上游接入的文本，在风格 / 故事梗概输入框下方作灰色只读回显。 */
  upstreamText?: CinematicStudioUpstreamText;
}

export default function DirectorBriefCard(props: DirectorBriefCardProps) {
  const {
    project,
    scene,
    t,
    locale,
    canvasImageSources,
    compileBusy,
    finalGenerateBusy,
    compileProgress,
    compileReceivedChars,
    briefOptimizeBusy,
    styleOptimizeBusy,
    aiCompileError,
    aiCompileErrorDetail,
    aiErrorCopied,
    resumeAvailable,
    resumeBusy,
    onSelectScene,
    onAddScene,
    onDeleteScene,
    onRenameScene,
    onUpdateScene,
    onUpdateStaging,
    onUpdateProject,
    onClearGeneratedContent,
    onAiCompile,
    onAiOptimizeBrief,
    onAiOptimizeStyle,
    onLocalCompile,
    onCopyAiError,
    onResumeInterrupted,
    chatModels,
    selectedChatModel,
    onSelectChatModel,
    selectedReasoningEffort,
    onSelectReasoningEffort,
    upstreamText,
  } = props;
  const [pickingCharacter, setPickingCharacter] = useState(false);
  const [audioOpen, setAudioOpen] = useState(false);
  const [stylePresetOpen, setStylePresetOpen] = useState(false);
  const [busySeconds, setBusySeconds] = useState(0);
  const generationBusy = compileBusy || finalGenerateBusy;
  useEffect(() => {
    if (!generationBusy) {
      setBusySeconds(0);
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => setBusySeconds(Math.round((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [generationBusy]);
  const staging = scene.staging ?? {};
  const roster = staging.characterRoster ?? [];
  const characterAssets = (project.assets ?? []).filter((asset) => asset.kind === "character");
  const characterCandidates = characterAssets.filter((asset) => !roster.includes(asset.id));
  const nameOf = (id: string) => (project.assets ?? []).find((asset) => asset.id === id)?.name ?? id;
  const audio = project.audioPlan ?? { score: "none" as const, subtitles: false };
  const styleBrief = localizedStyleBrief(project, locale);
  const audioSummary = `${t.score} ${audio.score === "original-score" ? t.scoreOriginal : t.scoreNone} · ${t.subtitles} ${audio.subtitles ? t.subtitlesBurned : t.subtitlesNone} · ${t.diegeticMusic} ${(audio.diegeticMusic ?? []).length} · ${t.sfx} ${(audio.sfx ?? []).length}`;
  const receivedText =
    compileReceivedChars > 0
      ? locale === "zh"
        ? ` · 已接收 ${compileReceivedChars.toLocaleString()} 字`
        : ` · ${compileReceivedChars.toLocaleString()} chars received`
      : "";
  const compileProgressText =
    locale === "zh"
      ? (
          {
            preparing: "正在整理场景、资产与约束",
            waiting: finalGenerateBusy
              ? t.aiFinalWaiting
              : busySeconds >= 15
                ? "仍在等待模型返回，连接保持中"
                : "请求已发出，正在等待模型生成",
            streaming: "正在接收模型输出",
            resuming: "检测到连接中断，正在从已收到内容继续生成",
            parsing: finalGenerateBusy ? "模型已返回，正在整理最终提示词" : "模型已返回，正在解析分镜数据",
            validating: finalGenerateBusy ? "正在整理最终提示词的最终格式" : "正在校验时长、镜头和资产引用",
            idle: "",
          } satisfies Record<SceneCompileProgress, string>
        )[compileProgress] + receivedText
      : (
          {
            preparing: "Preparing scene, assets, and constraints",
            waiting: finalGenerateBusy
              ? t.aiFinalWaiting
              : busySeconds >= 15
                ? "Still waiting for the model; the connection remains open"
                : "Request sent; waiting for model generation",
            streaming: "Receiving model output",
            resuming: "Connection interrupted; continuing from the received content",
            parsing: finalGenerateBusy
              ? "Model returned; assembling the final prompt"
              : "Model returned; parsing storyboard data",
            validating: finalGenerateBusy
              ? "Formatting the final prompt"
              : "Validating timing, shots, and asset references",
            idle: "",
          } satisfies Record<SceneCompileProgress, string>
        )[compileProgress] + receivedText;

  const addRosterCharacter = (id: string) => {
    if (roster.includes(id)) return;
    onUpdateStaging({ characterRoster: [...roster, id] });
    setPickingCharacter(false);
  };
  const removeRosterCharacter = (id: string) =>
    onUpdateStaging({
      characterRoster: roster.filter((item) => item !== id),
      // Existing shot participants remain intact and are never removed implicitly.
      characterOrder: (staging.characterOrder ?? []).filter((item) => item !== id),
    });

  return (
    <section className="card director-brief-card">
      <div className="card-head">
        <div className="card-head-title">
          <span className="eyebrow">{t.briefing}</span>
        </div>
      </div>

      {/* 场景 tabs */}
      <div className="scene-tabs">
        <span className="tab-label">{t.scenes}</span>
        {project.scenes.map((item) => (
          <span
            key={item.id}
            className={`scene-tab ${item.id === scene.id ? "active" : ""}`}
            onClick={() => onSelectScene(item.id)}
          >
            <Clapperboard size={12} />
            <input
              className="scene-name-input"
              value={item.name}
              aria-label={t.sceneName}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => onRenameScene(item.id, event.target.value)}
            />
            <em>{item.shots.length}</em>
            <button
              className="scene-delete"
              title={t.deleteScene}
              onClick={(event) => {
                event.stopPropagation();
                onDeleteScene(item.id);
              }}
            >
              <X size={11} />
            </button>
          </span>
        ))}
        <button className="scene-tab add" onClick={onAddScene} title={t.addScene}>
          <Plus size={13} />
        </button>
      </div>

      {/* 剧情 */}
      <div className="brief-group">
        <div className="brief-group-head">
          <span className="eyebrow">{t.storyGroup}</span>
        </div>
        <div className="scene-top">
          <span className="field-label">{t.loglineTitle}</span>
          <textarea
            className="logline-input"
            value={scene.logline}
            aria-label={t.loglineTitle}
            placeholder={t.loglinePlaceholder}
            rows={2}
            onChange={(event) => onUpdateScene({ logline: event.target.value })}
          />
          <UpstreamTextEcho texts={upstreamText?.storySynopsis} />
        </div>
        <div className="fields-grid three">
          <label className="field-label">
            <span>{t.metaLocation}</span>
            <input
              className="modal-input"
              value={scene.location ?? ""}
              placeholder={t.sceneLocationPlaceholder}
              onChange={(event) => onUpdateScene({ location: event.target.value })}
            />
          </label>
          <label className="field-label">
            <span>{t.metaTime}</span>
            <input
              className="modal-input"
              value={scene.time ?? ""}
              placeholder={t.sceneTimePlaceholder}
              onChange={(event) => onUpdateScene({ time: event.target.value })}
            />
          </label>
          <label className="field-label">
            <span>{t.metaWeather}</span>
            <input
              className="modal-input"
              value={scene.weather ?? ""}
              placeholder={t.sceneWeatherPlaceholder}
              onChange={(event) => onUpdateScene({ weather: event.target.value })}
            />
          </label>
        </div>
        <label className="field-label">
          {t.priorContext}
          <textarea
            className="modal-textarea"
            value={staging.priorContext ?? ""}
            placeholder={t.priorContextPlaceholder}
            onChange={(event) => onUpdateStaging({ priorContext: event.target.value || undefined })}
          />
        </label>

        <div className="field-label">
          {t.sceneCharacterRoster}
          <div className="stage-row scene-character-roster-input">
            {roster.map((id) => (
              <span className="stage-chip order-chip" key={id}>
                <span className="avatar small">{nameOf(id).slice(0, 1)}</span>
                <b>{nameOf(id)}</b>
                <button title={t.deleteParticipant} onClick={() => removeRosterCharacter(id)}>
                  <X size={11} />
                </button>
              </span>
            ))}
            <button
              type="button"
              className="scene-character-add"
              title={t.stagingAddCharacter}
              aria-label={t.stagingAddCharacter}
              onClick={() => setPickingCharacter((value) => !value)}
            >
              <Plus size={16} />
            </button>
            <span className="scene-character-add-hint">{t.stagingAddCharacter}</span>
          </div>
          {pickingCharacter && (
            <div className="staging-location-picker">
              {characterCandidates.length === 0 ? (
                <p className="hint-text">
                  {characterAssets.length === 0 ? t.stagingNoCharacterHint : t.stagingAllCharactersAdded}
                </p>
              ) : (
                <div className="staging-location-picker-grid">
                  {characterCandidates.map((asset) => (
                    <button key={asset.id} onClick={() => addRosterCharacter(asset.id)}>
                      {asset.referencePaths?.[0] ? (
                        <img src={resolveImageDisplayUrl(asset.referencePaths[0])} alt={asset.name} />
                      ) : (
                        <span className="staging-location-fallback">{asset.name.slice(0, 1)}</span>
                      )}
                      <span>{asset.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <p className="hint-text">{t.sceneCharacterRosterHint}</p>
        </div>
      </div>

      {/* 场景站位 */}
      <div className="brief-group">
        <StagingEditor
          project={project}
          scene={scene}
          t={t}
          canvasImageSources={canvasImageSources}
          onChange={onUpdateStaging}
        />
      </div>

      {/* 风格描述：预制风格只辅助填充文本，不再占用独立的大型配方卡 */}
      <div className="brief-group brief-style-group">
        <div className="brief-group-head">
          <span className="eyebrow">{t.styleBrief}</span>
        </div>
        <div className="style-brief-editor">
          <textarea
            className="modal-textarea"
            value={styleBrief}
            placeholder={t.styleBriefPlaceholder}
            onChange={(event) => {
              const value = event.target.value || undefined;
              onUpdateProject({
                styleBrief: value,
                ...(locale === "zh" ? { styleBriefZh: value } : { styleBriefEn: value }),
              });
            }}
          />
          <button
            type="button"
            className="style-ai-optimize-button"
            disabled={styleOptimizeBusy || briefOptimizeBusy || generationBusy}
            onClick={onAiOptimizeStyle}
            title={t.aiOptimizeStyle}
            aria-label={t.aiOptimizeStyle}
          >
            {styleOptimizeBusy ? <span className="spin-dot" /> : <Sparkles size={13} />}
            {styleOptimizeBusy ? t.aiOptimizingStyle : t.aiOptimizeStyle}
          </button>
        </div>
        {/* 放在 .style-brief-editor 之外：那张卡里的 AI 按钮是 absolute 定位，
            灰字块若进容器会把按钮顶到它右下角。 */}
        <UpstreamTextEcho texts={upstreamText?.styleBrief} />
        <div className="style-preset-row">
          <button
            className="outline-button style-preset-button"
            type="button"
            aria-expanded={stylePresetOpen}
            onClick={() => setStylePresetOpen((open) => !open)}
          >
            {getStyle(project.styleId)?.[locale === "zh" ? "nameZh" : "name"] ?? t.selectStylePreset}
            <ChevronDown size={13} className={stylePresetOpen ? "open" : ""} />
          </button>
          {stylePresetOpen && (
            <div className="style-preset-menu" role="listbox" aria-label={t.selectStylePreset}>
              {MASTER_STYLES.map((style) => (
                <button
                  key={style.id}
                  type="button"
                  role="option"
                  aria-selected={project.styleId === style.id}
                  className={project.styleId === style.id ? "active" : ""}
                  onClick={() => {
                    const generated = styleBriefDescription(style, locale);
                    onUpdateProject({
                      styleId: style.id,
                      styleBrief: generated,
                      ...(locale === "zh" ? { styleBriefZh: generated } : { styleBriefEn: generated }),
                    });
                    setStylePresetOpen(false);
                  }}
                >
                  {locale === "zh" ? style.nameZh : style.name}
                </button>
              ))}
              <button
                type="button"
                className="style-preset-clear"
                onClick={() => {
                  onUpdateProject({ styleId: undefined });
                  setStylePresetOpen(false);
                }}
              >
                {t.clearStylePreset}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 硬约束 */}
      <div className="brief-group">
        <div className="brief-group-head">
          <span className="eyebrow">{t.constraintGroup}</span>
          <span className="brief-user-badge">{t.userInputAiReference}</span>
        </div>
        <div className="shooting-mode">
          <span className="eyebrow">{t.shootingMode}</span>
          <div className="shooting-mode-toggle" role="radiogroup" aria-label={t.shootingMode}>
            <button
              className={scene.shootingMode === "long-take" ? "active" : ""}
              onClick={() => onUpdateScene({ shootingMode: "long-take" })}
            >
              <Film size={13} /> {t.shootingModeLongTake}
              <small>{t.shootingModeLongTakeHint}</small>
            </button>
            <button
              className={!scene.shootingMode || scene.shootingMode === "multi-shot" ? "active" : ""}
              onClick={() => onUpdateScene({ shootingMode: "multi-shot" })}
            >
              <Clapperboard size={13} /> {t.shootingModeMultiShot}
              <small>{t.shootingModeMultiShotHint}</small>
            </button>
          </div>
        </div>
        <div className="fields-grid two brief-duration-grid">
          <label className="field-label">
            <span>{t.metaDuration}</span>
            <input
              className="modal-input"
              value={scene.duration}
              onChange={(event) => onUpdateScene({ duration: event.target.value })}
            />
          </label>
          <div className="brief-duration-action">
            <button
              className="outline-button danger brief-clear-button"
              disabled={generationBusy || briefOptimizeBusy}
              onClick={onClearGeneratedContent}
              title={t.clearBrief}
            >
              <Trash2 size={14} /> {t.clearBrief}
            </button>
            <button
              className="primary-button brief-optimize-button"
              disabled={briefOptimizeBusy || compileBusy}
              onClick={onAiOptimizeBrief}
            >
              {briefOptimizeBusy ? <span className="spin-dot" /> : <Sparkles size={14} />}{" "}
              {briefOptimizeBusy ? t.aiOptimizingBrief : t.aiOptimizeBrief}
            </button>
          </div>
        </div>
        {/* AI 生成、用户可编辑的第一层结果。 */}
        <label className="field-label">
          {t.storyNotes}
          <textarea
            className="modal-textarea"
            value={directorIntentRefinementText(scene, characterAssets)}
            placeholder={t.storyNotesPlaceholder}
            rows={6}
            onChange={(event) => onUpdateScene({ directorIntentRefinement: event.target.value || undefined, directorIntentRefinementSource: "edited" })}
          />
        </label>
        {scene.performancePlan && (
          <div className="brief-hint">
            {t.performancePlanSummary.replace("{characters}", String(scene.performancePlan.characterPlans.length)).replace("{beats}", String(scene.performancePlan.beats.length))}
          </div>
        )}
      </div>

      {/* 音频计划 */}
      <div className="brief-group">
        <div className="brief-group-head">
          <span className="eyebrow">{t.audioPlan}</span>
          <span className="brief-user-badge">{t.userInputAiReference}</span>
          <button
            className="brief-audio-toggle"
            onClick={() => setAudioOpen((open) => !open)}
            title={audioOpen ? t.audioCollapse : t.audioExpand}
          >
            <span className="audio-summary">{audioSummary}</span>
            <ChevronDown size={14} className={audioOpen ? "" : "collapsed"} />
          </button>
        </div>
        {audioOpen && (
          <AudioPlanEditor project={project} t={t} onChange={(plan) => onUpdateProject({ audioPlan: plan })} />
        )}
      </div>

      {/* 编译动作 */}
      <div className="scene-actions">
        <span className="compile-boundary">{t.aiOutputBoundary}</span>
        <label className="brief-model-select">
          <span>{t.chatModel}</span>
          <select
            value={selectedChatModel}
            aria-label={t.chatModel}
            disabled={chatModels.length === 0}
            onChange={(event) => onSelectChatModel(event.target.value)}
          >
            {chatModels.length === 0 ? (
              <option value="">{t.noChatModels}</option>
            ) : (
              chatModels.map((option) => (
                <option key={`${option.providerId}:${option.model}`} value={`${option.providerId}:${option.model}`}>
                  {option.providerName} · {option.model}
                </option>
              ))
            )}
          </select>
          <ChevronDown size={13} />
        </label>
        <label className="brief-model-select brief-effort-select" title={t.reasoningEffortHint}>
          <span>{t.reasoningEffort}</span>
          <select
            value={selectedReasoningEffort}
            aria-label={t.reasoningEffort}
            onChange={(event) => onSelectReasoningEffort(event.target.value as ReasoningEffort)}
          >
            <option value="">{t.reasoningDefault}</option>
            <option value="low">{t.reasoningLow}</option>
            <option value="medium">{t.reasoningMedium}</option>
            <option value="high">{t.reasoningHigh}</option>
            <option value="xhigh">{t.reasoningXHigh}</option>
          </select>
          <ChevronDown size={13} />
        </label>
        <button className="primary-button" disabled={compileBusy || finalGenerateBusy} onClick={onAiCompile}>
          {compileBusy ? <span className="spin-dot" /> : <Sparkles size={16} />}{" "}
          {compileBusy ? t.aiCompiling : t.aiCompilePrompt}
        </button>
        <button className="primary-button" disabled={compileBusy || finalGenerateBusy} onClick={onLocalCompile}>
          {finalGenerateBusy ? <span className="spin-dot" /> : <Sparkles size={16} />}{" "}
          {finalGenerateBusy ? t.finalGenerating : t.localCompile}
        </button>
        {generationBusy && (
          <span className="compile-progress" role="status" aria-live="polite">
            <span className="compile-progress-dot" />
            {compileProgressText}
            <time>{busySeconds}s</time>
          </span>
        )}
        {aiCompileError && (
          <span className="ai-error-wrap">
            <span className="ai-error-badge" title={aiCompileErrorDetail || aiCompileError}>
              <span className="ai-error-dot" /> {aiCompileError}
            </span>
            <button
              className={`ai-error-copy${aiErrorCopied ? " copied" : ""}`}
              title={t.copyAiError}
              onClick={onCopyAiError}
            >
              {aiErrorCopied ? <Check size={12} /> : <Copy size={12} />}
            </button>
          </span>
        )}
        {resumeAvailable && (
          <button
            type="button"
            className="outline-button resume-interrupted-button"
            disabled={resumeBusy || generationBusy}
            title={t.resumeInterrupted}
            onClick={onResumeInterrupted}
          >
            <RefreshCw size={14} className={resumeBusy ? "spin-icon" : ""} />{" "}
            {resumeBusy ? t.resumeInProgress : t.resumeInterrupted}
          </button>
        )}
      </div>
    </section>
  );
}
