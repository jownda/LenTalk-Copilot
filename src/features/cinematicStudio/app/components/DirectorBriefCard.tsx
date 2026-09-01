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
import type { ActingObjective, ProjectV2, SceneStaging, SceneV2 } from "../../shared-types";
import { Check, ChevronDown, Clapperboard, Copy, Film, Plus, RefreshCw, Sparkles, Trash2, X } from "lucide-react";
import type { CopyZh, Locale } from "../i18n";
import type { LenTalkChatModelOption, ReasoningEffort } from "../providers/aiSettings";
import type { SceneCompileProgress } from "../providers/ai";
import AudioPlanEditor from "./AudioPlanEditor";
import StagingEditor from "./StagingEditor";
import type { CanvasImageSource } from "./DirectorLayersCard";
import { getStyle, localizedStyleBrief, MASTER_STYLES, styleBriefDescription } from "../../engine";

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
  onLocalCompile(): void;
  onCopyAiError(): void;
  onResumeInterrupted(): void;
  chatModels: LenTalkChatModelOption[];
  selectedChatModel: string;
  onSelectChatModel(value: string): void;
  selectedReasoningEffort: ReasoningEffort;
  onSelectReasoningEffort(value: ReasoningEffort): void;
}

/** 多行文本 → string[]（按行拆分，过滤空行） */
const splitLines = (text: string): string[] => text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);

export default function DirectorBriefCard(props: DirectorBriefCardProps) {
  const {
    project, scene, t, locale, canvasImageSources, compileBusy, finalGenerateBusy, compileProgress, compileReceivedChars, briefOptimizeBusy, aiCompileError, aiCompileErrorDetail, aiErrorCopied, resumeAvailable, resumeBusy,
    onSelectScene, onAddScene, onDeleteScene, onRenameScene, onUpdateScene,
    onUpdateStaging, onUpdateProject, onClearGeneratedContent, onAiCompile, onAiOptimizeBrief, onLocalCompile, onCopyAiError, onResumeInterrupted,
    chatModels, selectedChatModel, onSelectChatModel, selectedReasoningEffort, onSelectReasoningEffort,
  } = props;
  const [pickingCharacter, setPickingCharacter] = useState(false);
  const [audioOpen, setAudioOpen] = useState(false);
  const [stylePresetOpen, setStylePresetOpen] = useState(false);
  const [busySeconds, setBusySeconds] = useState(0);
  const generationBusy = compileBusy || finalGenerateBusy;
  useEffect(() => {
    if (!generationBusy) { setBusySeconds(0); return; }
    const startedAt = Date.now();
    const timer = window.setInterval(() => setBusySeconds(Math.round((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [generationBusy]);
  const staging = scene.staging ?? {};
  const order = staging.characterOrder ?? [];
  const characterAssets = (project.assets ?? []).filter((asset) => asset.kind === "character");
  const characterCandidates = characterAssets.filter((asset) => !order.includes(asset.id));
  const nameOf = (id: string) => (project.assets ?? []).find((asset) => asset.id === id)?.name ?? id;
  const audio = project.audioPlan ?? { score: "none" as const, subtitles: false };
  const styleBrief = localizedStyleBrief(project, locale);
  const audioSummary = `${t.score} ${audio.score === "original-score" ? t.scoreOriginal : t.scoreNone} · ${t.subtitles} ${audio.subtitles ? t.subtitlesBurned : t.subtitlesNone} · ${t.diegeticMusic} ${(audio.diegeticMusic ?? []).length} · ${t.sfx} ${(audio.sfx ?? []).length}`;
  const receivedText = compileReceivedChars > 0
    ? (locale === "zh" ? ` · 已接收 ${compileReceivedChars.toLocaleString()} 字` : ` · ${compileReceivedChars.toLocaleString()} chars received`)
    : "";
  const compileProgressText = locale === "zh"
    ? ({
        preparing: "正在整理场景、资产与约束",
        waiting: finalGenerateBusy ? t.aiFinalWaiting : busySeconds >= 15 ? "仍在等待模型返回，连接保持中" : "请求已发出，正在等待模型生成",
        streaming: "正在接收模型输出",
        resuming: "检测到连接中断，正在从已收到内容继续生成",
        parsing: finalGenerateBusy ? "模型已返回，正在整理最终提示词" : "模型已返回，正在解析分镜数据",
        validating: finalGenerateBusy ? "正在整理最终提示词的最终格式" : "正在校验时长、镜头和资产引用",
        idle: "",
      } satisfies Record<SceneCompileProgress, string>)[compileProgress] + receivedText
    : ({
        preparing: "Preparing scene, assets, and constraints",
        waiting: finalGenerateBusy ? t.aiFinalWaiting : busySeconds >= 15 ? "Still waiting for the model; the connection remains open" : "Request sent; waiting for model generation",
        streaming: "Receiving model output",
        resuming: "Connection interrupted; continuing from the received content",
        parsing: finalGenerateBusy ? "Model returned; assembling the final prompt" : "Model returned; parsing storyboard data",
        validating: finalGenerateBusy ? "Formatting the final prompt" : "Validating timing, shots, and asset references",
        idle: "",
      } satisfies Record<SceneCompileProgress, string>)[compileProgress] + receivedText;

  const addCharacter = (id: string) => {
    if (order.includes(id)) return;
    onUpdateStaging({ characterOrder: [...order, id] });
    setPickingCharacter(false);
  };
  const removeCharacter = (id: string) => onUpdateStaging({ characterOrder: order.filter((item) => item !== id) });

  return <section className="card director-brief-card">
    <div className="card-head">
      <div className="card-head-title"><span className="eyebrow">{t.briefing}</span></div>
    </div>

    {/* 场景 tabs */}
    <div className="scene-tabs">
      <span className="tab-label">{t.scenes}</span>
      {project.scenes.map((item) => (
        <span key={item.id} className={`scene-tab ${item.id === scene.id ? "active" : ""}`} onClick={() => onSelectScene(item.id)}>
          <Clapperboard size={12} />
          <input className="scene-name-input" value={item.name} aria-label={t.sceneName} onClick={(event) => event.stopPropagation()} onChange={(event) => onRenameScene(item.id, event.target.value)} />
          <em>{item.shots.length}</em>
          <button className="scene-delete" title={t.deleteScene} onClick={(event) => { event.stopPropagation(); onDeleteScene(item.id); }}><X size={11} /></button>
        </span>
      ))}
      <button className="scene-tab add" onClick={onAddScene} title={t.addScene}><Plus size={13} /></button>
    </div>

    {/* 剧情 */}
    <div className="brief-group">
      <div className="brief-group-head"><span className="eyebrow">{t.storyGroup}</span></div>
      <div className="scene-top">
        <span className="field-label">{t.loglineTitle}</span>
        <textarea className="logline-input" value={scene.logline} aria-label={t.loglineTitle} placeholder={t.loglinePlaceholder} rows={2} onChange={(event) => onUpdateScene({ logline: event.target.value })} />
      </div>
      <label className="field-label">{t.priorContext}<textarea className="modal-textarea" value={staging.priorContext ?? ""} placeholder={t.priorContextPlaceholder} onChange={(event) => onUpdateStaging({ priorContext: event.target.value || undefined })} /></label>

      <div className="field-label">{t.sceneCharacterRoster}
        <div className="stage-row scene-character-roster-input">
          {order.map((id) => (
            <span className="stage-chip order-chip" key={id}>
              <span className="avatar small">{nameOf(id).slice(0, 1)}</span>
              <b>{nameOf(id)}</b>
              <button title={t.deleteParticipant} onClick={() => removeCharacter(id)}><X size={11} /></button>
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
        {pickingCharacter && <div className="staging-location-picker">
          {characterCandidates.length === 0
            ? <p className="hint-text">{characterAssets.length === 0 ? t.stagingNoCharacterHint : t.stagingAllCharactersAdded}</p>
            : <div className="staging-location-picker-grid">
                {characterCandidates.map((asset) => (
                  <button key={asset.id} onClick={() => addCharacter(asset.id)}>
                    {asset.referencePaths?.[0] ? <img src={asset.referencePaths[0]} alt={asset.name} /> : <span className="staging-location-fallback">{asset.name.slice(0, 1)}</span>}
                    <span>{asset.name}</span>
                  </button>
                ))}
              </div>}
        </div>}
        <p className="hint-text">{t.sceneCharacterRosterHint}</p>
      </div>
    </div>

    {/* 场景站位 */}
    <div className="brief-group">
      <StagingEditor project={project} scene={scene} t={t} canvasImageSources={canvasImageSources} onChange={onUpdateStaging} />
    </div>

    {/* 风格描述：预制风格只辅助填充文本，不再占用独立的大型配方卡 */}
    <div className="brief-group brief-style-group">
      <div className="brief-group-head"><span className="eyebrow">{t.styleBrief}</span></div>
      <textarea className="modal-textarea" value={styleBrief} placeholder={t.styleBriefPlaceholder} onChange={(event) => {
        const value = event.target.value || undefined;
        onUpdateProject({ styleBrief: value, ...(locale === "zh" ? { styleBriefZh: value } : { styleBriefEn: value }) });
      }} />
      <div className="style-preset-row">
        <button className="outline-button style-preset-button" type="button" aria-expanded={stylePresetOpen} onClick={() => setStylePresetOpen((open) => !open)}>
          {getStyle(project.styleId)?.[locale === "zh" ? "nameZh" : "name"] ?? t.selectStylePreset}
          <ChevronDown size={13} className={stylePresetOpen ? "open" : ""} />
        </button>
        {stylePresetOpen && <div className="style-preset-menu" role="listbox" aria-label={t.selectStylePreset}>
          {MASTER_STYLES.map((style) => (
            <button key={style.id} type="button" role="option" aria-selected={project.styleId === style.id} className={project.styleId === style.id ? "active" : ""} onClick={() => {
              const generated = styleBriefDescription(style, locale);
              onUpdateProject({
                styleId: style.id,
                styleBrief: generated,
                ...(locale === "zh" ? { styleBriefZh: generated } : { styleBriefEn: generated }),
              });
              setStylePresetOpen(false);
            }}>{locale === "zh" ? style.nameZh : style.name}</button>
          ))}
          <button type="button" className="style-preset-clear" onClick={() => { onUpdateProject({ styleId: undefined }); setStylePresetOpen(false); }}>{t.clearStylePreset}</button>
        </div>}
      </div>
    </div>

    {/* 硬约束 */}
    <div className="brief-group">
      <div className="brief-group-head"><span className="eyebrow">{t.constraintGroup}</span><span className="brief-user-badge">{t.userInputAiReference}</span></div>
      <div className="shooting-mode">
        <span className="eyebrow">{t.shootingMode}</span>
        <div className="shooting-mode-toggle" role="radiogroup" aria-label={t.shootingMode}>
          <button className={scene.shootingMode === "long-take" ? "active" : ""} onClick={() => onUpdateScene({ shootingMode: "long-take" })}>
            <Film size={13} /> {t.shootingModeLongTake}<small>{t.shootingModeLongTakeHint}</small>
          </button>
          <button className={!scene.shootingMode || scene.shootingMode === "multi-shot" ? "active" : ""} onClick={() => onUpdateScene({ shootingMode: "multi-shot" })}>
            <Clapperboard size={13} /> {t.shootingModeMultiShot}<small>{t.shootingModeMultiShotHint}</small>
          </button>
        </div>
      </div>
      <div className="fields-grid two brief-duration-grid">
        <label className="field-label"><span>{t.metaDuration}</span><input className="modal-input" value={scene.duration} onChange={(event) => onUpdateScene({ duration: event.target.value })} /></label>
        <div className="brief-duration-action">
          <button className="outline-button danger brief-clear-button" disabled={generationBusy || briefOptimizeBusy} onClick={onClearGeneratedContent} title={t.clearBrief}><Trash2 size={14} /> {t.clearBrief}</button>
          <button className="primary-button brief-optimize-button" disabled={briefOptimizeBusy || compileBusy} onClick={onAiOptimizeBrief}>{briefOptimizeBusy ? <span className="spin-dot" /> : <Sparkles size={14} />} {briefOptimizeBusy ? t.aiOptimizingBrief : t.aiOptimizeBrief}</button>
        </div>
      </div>
      <label className="field-label">{t.mustHappen}<textarea className="modal-textarea" value={(scene.mustHappen ?? []).join("\n")} placeholder={t.mustHappenPlaceholder} onChange={(event) => onUpdateScene({ mustHappen: splitLines(event.target.value) })} /></label>
      <label className="field-label">{t.forbidLabel}<textarea className="modal-textarea" value={(scene.forbid ?? []).join("\n")} placeholder={t.forbidPlaceholder} onChange={(event) => onUpdateScene({ forbid: splitLines(event.target.value) })} /></label>
    </div>

    {/* 对白 + 情绪走向 */}
    <div className="brief-group">
      <div className="brief-group-head"><span className="brief-user-badge">{t.userInputAiReference}</span></div>
      <div className="fields-grid two">
        <label className="field-label">{t.dialogue}<textarea className="modal-textarea" value={scene.dialogue ?? ""} placeholder={t.dialoguePlaceholder} onChange={(event) => onUpdateScene({ dialogue: event.target.value || undefined })} /></label>
        <label className="field-label">{t.emotionArc}<textarea className="modal-textarea" value={scene.emotionArc ?? ""} placeholder={t.emotionArcPlaceholder} onChange={(event) => onUpdateScene({ emotionArc: event.target.value || undefined })} /></label>
      </div>
    </div>

    {/* 表演目标（P2）：每参与角色的目的/阻碍/代价/贯穿目标 */}
    <div className="brief-group">
      <div className="brief-group-head"><span className="eyebrow">{t.actingObjectives}</span><span className="brief-user-badge">{t.userInputAiReference}</span></div>
      <ActingObjectivesEditor
        t={t}
        characters={characterAssets}
        objectives={scene.actingObjectives ?? []}
        boundIds={[...new Set(scene.shots.flatMap((shot) => shot.participants?.map((participant) => participant.characterId) ?? []))]}
        onChange={(actingObjectives) => onUpdateScene({ actingObjectives })}
      />
    </div>

    {/* 音频计划 */}
    <div className="brief-group">
      <div className="brief-group-head">
        <span className="eyebrow">{t.audioPlan}</span>
        <span className="brief-user-badge">{t.userInputAiReference}</span>
        <button className="brief-audio-toggle" onClick={() => setAudioOpen((open) => !open)} title={audioOpen ? t.audioCollapse : t.audioExpand}>
          <span className="audio-summary">{audioSummary}</span>
          <ChevronDown size={14} className={audioOpen ? "" : "collapsed"} />
        </button>
      </div>
      {audioOpen && <AudioPlanEditor project={project} t={t} onChange={(plan) => onUpdateProject({ audioPlan: plan })} />}
    </div>

    {/* 编译动作 */}
    <div className="scene-actions">
      <span className="compile-boundary">{t.aiOutputBoundary}</span>
      <label className="brief-model-select">
        <span>{t.chatModel}</span>
        <select value={selectedChatModel} aria-label={t.chatModel} disabled={chatModels.length === 0} onChange={(event) => onSelectChatModel(event.target.value)}>
          {chatModels.length === 0
            ? <option value="">{t.noChatModels}</option>
            : chatModels.map((option) => <option key={`${option.providerId}:${option.model}`} value={`${option.providerId}:${option.model}`}>{option.providerName} · {option.model}</option>)}
        </select>
        <ChevronDown size={13} />
      </label>
      <label className="brief-model-select brief-effort-select" title={t.reasoningEffortHint}>
        <span>{t.reasoningEffort}</span>
        <select value={selectedReasoningEffort} aria-label={t.reasoningEffort} onChange={(event) => onSelectReasoningEffort(event.target.value as ReasoningEffort)}>
          <option value="">{t.reasoningDefault}</option>
          <option value="low">{t.reasoningLow}</option>
          <option value="medium">{t.reasoningMedium}</option>
          <option value="high">{t.reasoningHigh}</option>
          <option value="xhigh">{t.reasoningXHigh}</option>
        </select>
        <ChevronDown size={13} />
      </label>
      <button className="primary-button" disabled={compileBusy || finalGenerateBusy} onClick={onAiCompile}>{compileBusy ? <span className="spin-dot" /> : <Sparkles size={16} />} {compileBusy ? t.aiCompiling : t.aiCompilePrompt}</button>
      <button className="primary-button" disabled={compileBusy || finalGenerateBusy} onClick={onLocalCompile}>{finalGenerateBusy ? <span className="spin-dot" /> : <Sparkles size={16} />} {finalGenerateBusy ? t.finalGenerating : t.localCompile}</button>
      {generationBusy && <span className="compile-progress" role="status" aria-live="polite"><span className="compile-progress-dot" />{compileProgressText}<time>{busySeconds}s</time></span>}
      {aiCompileError && (
        <span className="ai-error-wrap">
          <span className="ai-error-badge" title={aiCompileErrorDetail || aiCompileError}><span className="ai-error-dot" /> {aiCompileError}</span>
          <button className={`ai-error-copy${aiErrorCopied ? " copied" : ""}`} title={t.copyAiError} onClick={onCopyAiError}>{aiErrorCopied ? <Check size={12} /> : <Copy size={12} />}</button>
        </span>
      )}
      {resumeAvailable && <button type="button" className="outline-button resume-interrupted-button" disabled={resumeBusy || generationBusy} title={t.resumeInterrupted} onClick={onResumeInterrupted}><RefreshCw size={14} className={resumeBusy ? "spin-icon" : ""} /> {resumeBusy ? t.resumeInProgress : t.resumeInterrupted}</button>}
    </div>
  </section>;
}

/** 表演目标编辑器（P2）：按参与角色逐条填写 目的/贯穿目标/阻碍/失败代价 */
function ActingObjectivesEditor({ t, characters, objectives, boundIds, onChange }: {
  t: CopyZh;
  characters: { id: string; name: string; referencePaths?: string[] }[];
  objectives: ActingObjective[];
  boundIds: string[];
  onChange(objectives: ActingObjective[]): void;
}) {
  const update = (index: number, patch: Partial<ActingObjective>) =>
    onChange(objectives.map((item, i) => i === index ? { ...item, ...patch } : item));
  const remove = (index: number) => onChange(objectives.filter((_, i) => i !== index));
  const add = (characterId: string) => {
    if (objectives.some((item) => item.characterId === characterId)) return;
    onChange([...objectives, { characterId, objective: "" }]);
  };
  const characterIds = [...new Set([...boundIds, ...objectives.map((item) => item.characterId)])];

  return <div className="acting-objectives">
    {characterIds.map((characterId) => {
      const character = characters.find((asset) => asset.id === characterId);
      const index = objectives.findIndex((item) => item.characterId === characterId);
      const item = index >= 0 ? objectives[index] : undefined;
      if (!character) return null;
      return <div className="acting-objective-row" key={characterId}>
        <div className="acting-objective-head">
          {character.referencePaths?.[0] ? <img className="acting-objective-avatar" src={character.referencePaths[0]} alt={character.name} /> : <span className="acting-objective-avatar fallback">{character.name.slice(0, 1)}</span>}
          <b>{character.name}</b>
          <button className="mini-del" title={t.deleteObjective} onClick={() => item ? remove(index) : undefined}><X size={11} /></button>
        </div>
        {item ? (
          <div className="fields-grid two">
            <label className="field-label">{t.objective}<input className="modal-input" value={item.objective ?? ""} placeholder={t.objectivePlaceholder} onChange={(event) => update(index, { objective: event.target.value })} /></label>
            <label className="field-label">{t.superObjective}<input className="modal-input" value={item.superObjective ?? ""} placeholder={t.superObjectivePlaceholder} onChange={(event) => update(index, { superObjective: event.target.value || undefined })} /></label>
            <label className="field-label">{t.obstacle}<input className="modal-input" value={item.obstacle ?? ""} placeholder={t.obstaclePlaceholder} onChange={(event) => update(index, { obstacle: event.target.value || undefined })} /></label>
            <label className="field-label">{t.stakes}<input className="modal-input" value={item.stakes ?? ""} placeholder={t.stakesPlaceholder} onChange={(event) => update(index, { stakes: event.target.value || undefined })} /></label>
          </div>
        ) : (
          <button className="mini-add" onClick={() => add(characterId)}><Plus size={11} /> {t.addItem}</button>
        )}
      </div>;
    })}
    {characterIds.length === 0 && <span className="hint-text">{t.noCharacterObjectiveHint}</span>}
  </div>;
}
