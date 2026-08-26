import { useEffect, useMemo, useRef, useState } from "react";
import { CAMERAS, LENSES, MODEL_PROFILES, DEFAULT_NEGATIVE, SHOT_TEMPLATES, checkContinuityV2, compilePrompt, modelProfileById, sanitizeDirectorText, shotTemplateById, validateDirectorLayers } from "../engine";
import type { CameraMovement, ContinuityIssueV2, ProjectV2, PromptVersion, SceneV2, Shot, ShotV2 } from "../shared-types";
import { ChevronDown, Clapperboard, Copy, Download, FileJson, FileText, FolderOpen, History, PenLine, Plus, Save, Settings2, Sparkles, X } from "lucide-react";
import { classifyError, fillSceneDraft, getAssistant } from "./providers/ai";
import { isRemoteConfigured, loadAISettings, type AISettings } from "./providers/aiSettings";
import { useSettingsStore } from "@/stores/settingsStore";
import { loadProjectFromDisk, recordVersionToSqlite, savePromptToDisk, saveProjectToDisk } from "./providers/projectStorage";
import { loadProject, migrateProject, bakeryRescueProject, museumRedDoorsProject, persistProject } from "./model";
import { cameraLabels, copy, framingLabels, type CopyZh, type Locale } from "./i18n";
import AssetLibrary from "./components/AssetLibrary";
import SettingsModal from "./components/SettingsModal";
import BeatEditor from "./components/BeatEditor";
import ContinuityPanel from "./components/ContinuityPanel";
import DirectorBriefCard from "./components/DirectorBriefCard";
import DirectorLayersCard from "./components/DirectorLayersCard";
import ParticipantsEditor from "./components/ParticipantsEditor";
import PropStateEditor from "./components/PropStateEditor";
import OpticsCameraEditor from "./components/OpticsCameraEditor";
import { projectReducer, type ProjectAction } from "./store/projectReducer";
import { addVersion, deleteVersion, loadHistory } from "./store/promptHistory";

const movements: CameraMovement[] = ["Static", "Handheld", "Steadicam", "Dolly", "Tracking", "Crane", "POV", "OTS"];
const newId = () => crypto.randomUUID();
const SHOT_PERF_TIPS = ["perf0Tip", "perf1Tip", "perf2Tip", "perf3Tip", "perf4Tip", "perf5Tip"] as const;
const SHOT_PERF_KEYS = ["perf0", "perf1", "perf2", "perf3", "perf4", "perf5"] as const;

function download(name: string, contents: string, type: string) {
  const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([contents], { type })); link.download = name; link.click(); URL.revokeObjectURL(link.href);
}

export interface CinematicStudioAppStateSnapshot {
  projectTitle?: string;
  promptPreview?: string;
}

export interface CinematicStudioAppProps {
  onClose?: () => void;
  onStateChange?: (snapshot: CinematicStudioAppStateSnapshot) => void;
}

export default function App({ onClose, onStateChange }: CinematicStudioAppProps = {}) {
  const [project, setProject] = useState<ProjectV2>(loadProject);
  const [locale, setLocale] = useState<Locale>(() => localStorage.getItem("cineprompt-locale") === "en" ? "en" : "zh");
  const [sceneId, setSceneId] = useState(project.scenes[0].id);
  const [shotId, setShotId] = useState(project.scenes[0].shots[0].id);
  const [prompt, setPrompt] = useState("");
  const [notice, setNotice] = useState("");
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [exampleOpen, setExampleOpen] = useState(false);
  const [templateMenuOpen, setTemplateMenuOpen] = useState(false);
  const [sceneCompileBusy, setSceneCompileBusy] = useState(false);
  const [aiCompileError, setAiCompileError] = useState("");
  const [aiCompileErrorDetail, setAiCompileErrorDetail] = useState("");
  const [aiErrorCopied, setAiErrorCopied] = useState(false);
  const [template, setTemplate] = useState<"pro-sequence" | "shot-cards" | "asset-id-tagged">("pro-sequence");
  const [modelProfileId, setModelProfileId] = useState<string>(() => localStorage.getItem("cineprompt-model") ?? "");
  const [history, setHistory] = useState<PromptVersion[]>(loadHistory);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aiSettings, setAiSettings] = useState<AISettings>(() => loadAISettings());
  const customApis = useSettingsStore((state) => state.customApis);
  /** 手动覆写文本：编辑器内容与最近编译输出不一致时记录（P2.2） */
  const [manualOverride, setManualOverride] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const scene = project.scenes.find((item) => item.id === sceneId) ?? project.scenes[0];
  const shot = scene.shots.find((item) => item.id === shotId) ?? scene.shots[0];
  const issues = useMemo(() => checkContinuityV2(project, scene), [project, scene]);
  const directorLayerIssues = useMemo(() => scene.directorLayers ? validateDirectorLayers(scene.directorLayers, project, scene) : [], [project, scene]);
  const hasExportErrors = issues.some((i) => i.severity === "error");
  const t: CopyZh = copy[locale] as CopyZh;

  /** 结构更新统一走 reducer（Compiler/Continuity 只读不可变快照） */
  const dispatch = (action: ProjectAction) => setProject((prev) => projectReducer(prev, action));

  useEffect(() => { persistProject(project); }, [project]);
  useEffect(() => { localStorage.setItem("cineprompt-locale", locale); }, [locale]);
  /** LenTalk Chat 配置变更时同步刷新工作室选中的模型（地址/Key 同源） */
  useEffect(() => { setAiSettings(loadAISettings()); }, [customApis]);
  /** 节点嵌入：把工程标题与提示词摘要回传给宿主节点（防抖 400ms，避免逐键同步） */
  useEffect(() => {
    const timer = window.setTimeout(() => {
      onStateChange?.({ projectTitle: project.title, promptPreview: prompt });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [onStateChange, project.title, prompt]);
  /** P2.2/P0/P1.4：编译入口（生成 + 存档版本历史；locale 决定输出语言；项目包内落盘） */
  const runCompile = (noticeKey: "promptCompiled" | "promptRebuilt" | "promptLocalCompiled", targetScene: SceneV2 = scene) => {
    const result = compilePrompt(project, targetScene, shot, { template, profile: modelProfileById(modelProfileId), locale, director: true });
    const issues = checkContinuityV2(project, targetScene);
    const text = manualOverride !== null ? manualOverride : result.text;
    setPrompt(text);
    const record = addVersion({
      template,
      modelProfileId: modelProfileId || undefined,
      outputText: result.text,
      projectSnapshot: structuredClone({ ...project, scenes: project.scenes.map((item) => item.id === targetScene.id ? targetScene : item) }),
      continuitySummary: { total: issues.length, errors: issues.filter((i) => i.severity === "error").length, warnings: issues.filter((i) => i.severity === "warning").length },
      manualOverride: manualOverride ?? undefined,
    });
    setHistory(record);
    // P1.4：项目包已打开时落盘 prompts/<id>.md + SQLite 摘要
    if (projectPackageDir) {
      const latest = record[0];
      if (latest) {
        void savePromptToDisk(projectPackageDir, latest.id, result.text);
        void recordVersionToSqlite(projectPackageDir, latest.id, template, JSON.stringify(latest.continuitySummary));
      }
    }
    setNotice(t[noticeKey]);
  };
  /** 从历史版本恢复结构（而非纯文本） */
  const restoreVersion = (version: PromptVersion) => {
    setProject(version.projectSnapshot as ProjectV2);
    setPrompt(version.outputText);
    setManualOverride(version.manualOverride ?? null);
    setNotice(t.versionRestored);
  };
  /** P1：当前打开的项目包目录（成功保存后记录，用于版本落盘） */
  const [projectPackageDir, setProjectPackageDir] = useState<string | null>(() => sessionStorage.getItem("cineprompt-package-dir"));
  /** P3/P1.2：保存工程到 .cineprompt 目录包（父目录选择 + slug.cineprompt） */
  const handleSaveProject = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const parent = await open({ title: t.saveProject, directory: true }) as string | null;
      if (!parent) return;
      const slug = ((project as { name?: string }).name || "my-movie").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, "-").replace(/^-+|-+$/g, "") || "movie";
      const dir = `${parent}/${slug}.cineprompt`;
      const assets: Record<string, string[]> = {};
      for (const asset of project.assets ?? []) {
        const refs = (asset.referencePaths ?? []).filter((r) => r?.startsWith("data:"));
        if (refs.length > 0) assets[asset.id] = refs;
      }
      const ok = await saveProjectToDisk(dir, project, assets);
      if (ok) {
        setProjectPackageDir(dir);
        sessionStorage.setItem("cineprompt-package-dir", dir);
        setNotice(`${t.projectSaved} ${dir}`);
      } else {
        exportProject("json");
        setNotice(t.projectSaveFallback);
      }
    } catch {
      exportProject("json");
      setNotice(t.projectSaveFallback);
    }
  };
  /** P1.2：从磁盘打开 .cineprompt 目录包 */
  const handleOpenProject = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const dir = await open({ title: t.openProject, directory: true }) as string | null;
      if (!dir) return;
      const loaded = await loadProjectFromDisk(dir);
      if (loaded) {
        setProject(migrateProject(loaded));
        setProjectPackageDir(dir);
        sessionStorage.setItem("cineprompt-package-dir", dir);
        setNotice(t.projectLoaded);
      } else {
        setNotice(t.projectOpenInvalid);
      }
    } catch {
      fileInput.current?.click();
    }
  };
  /** P3：AI 修复建议（连续性面板回调） */
  const aiAdvice = async (issue: ContinuityIssueV2) => {
    const fix = await getAssistant().repairContinuity({ issue, project, scene, shot });
    setNotice(`${t.aiFixLabel}: ${fix.apply}`);
  };

  const updateShot = (updates: Partial<ShotV2>, targetId?: string) => { const target = targetId ?? shot.id; setProject((current) => ({ ...current, scenes: current.scenes.map((item) => item.id !== scene.id ? item : { ...item, shots: item.shots.map((candidate) => candidate.id === target ? { ...candidate, ...updates } : candidate) }) })); };
  /** 一键修复：根据 issue.code 应用对应修复（P0.5） */
  const fixIssue = (issue: ContinuityIssueV2) => {
    switch (issue.code) {
      case "SCENE.ENVIRONMENT_UNLOCKED":
        updateScene({ environmentLock: true });
        break;
      case "TECHNICAL.PROFILE_MISSING":
        setProject((current) => ({ ...current, technicalProfile: { format: "photoreal", resolution: "4K", fps: 24, shutterAngle: 180, filmStock: "35mm Kodak Vision3 250D" } }));
        break;
      case "TECHNICAL.NEGATIVE_EMPTY":
        setProject((current) => ({ ...current, negativePrompt: DEFAULT_NEGATIVE }));
        break;
      case "AUDIO.PLAN_MISSING":
        setProject((current) => ({ ...current, audioPlan: { score: "none", subtitles: false } }));
        break;
      case "AUDIO.DIALOGUE_UNSUBTITLED":
        setProject((current) => ({ ...current, audioPlan: { ...(current.audioPlan ?? { score: "none" as const, subtitles: false }), subtitles: true } }));
        break;
      case "AUDIO.CONFLICT":
        setProject((current) => {
          const audio = current.audioPlan;
          if (!audio) return current;
          const MUSIC_TOKENS = ["boombox", "beat", "radio", "band", "music", "playback", "jingle", "melody"];
          const moved = (audio.sfx ?? []).filter((sfx) => MUSIC_TOKENS.some((token) => sfx.toLowerCase().includes(token)));
          return { ...current, audioPlan: { ...audio, sfx: (audio.sfx ?? []).filter((sfx) => !moved.includes(sfx)), diegeticMusic: [...(audio.diegeticMusic ?? []), ...moved] } };
        });
        break;
      case "SPATIAL.AXIS_CONFLICT":
        if (issue.entityId) updateShot({ layout: { ...shot.layout, intentionalAxisBreak: true } }, issue.entityId);
        break;
      default:
        return;
    }
    setNotice(t.fixed);
  };
  /** 更新镜头时间（结构化 time）并联动下一个镜头：下一镜 start = 当前 end（自动吸附） */
  const updateShotRange = (id: string, start: number, end: number) => {
    const index = scene.shots.findIndex((item) => item.id === id);
    setProject((current) => ({
      ...current,
      scenes: current.scenes.map((item) => {
        if (item.id !== scene.id) return item;
        return { ...item, shots: item.shots.map((candidate, i) => {
          if (candidate.id === id) {
            const next = { ...candidate, time: { startSeconds: start, endSeconds: end }, duration: `${start}-${end}${t.seconds}` };
            return next;
          }
          if (i === index + 1) {
            const nextEnd = candidate.time?.endSeconds ?? (() => { const m = candidate.duration.match(/(\d+)\s*-\s*(\d+)/); return m ? Number(m[2]) : end; })();
            return { ...candidate, time: { startSeconds: end, endSeconds: nextEnd }, duration: `${end}-${nextEnd}${t.seconds}` };
          }
          return candidate;
        }) };
      }),
    }));
  };
  const shotRange = (() => { if (shot?.time) return { start: shot.time.startSeconds, end: shot.time.endSeconds }; const m = shot?.duration.match(/(\d+)\s*-\s*(\d+)/); return { start: m ? Number(m[1]) : 0, end: m ? Number(m[2]) : 8 }; })();
  const updateScene = (updates: Partial<SceneV2>) => setProject((current) => ({ ...current, scenes: current.scenes.map((item) => item.id === scene.id ? { ...item, ...updates } : item) }));
  const updateSceneName = (id: string, name: string) => setProject((current) => ({ ...current, scenes: current.scenes.map((item) => item.id === id ? { ...item, name } : item) }));
  /** 一键镜头模板（P1.2） */
  const addShotFromTemplate = (templateId: string) => {
    const template = shotTemplateById(templateId);
    if (!template) return;
    const { shot: created, requiredFields } = template.create(project, scene);
    setProject((current) => ({ ...current, scenes: current.scenes.map((item) => item.id === scene.id ? { ...item, shots: [...item.shots, created] } : item) }));
    setShotId(created.id);
    setNotice(requiredFields.length > 0 ? `${t.templateApplied} ${t.templateRequired}: ${requiredFields.join("；")}` : t.templateApplied);
  };
  const addBlankShot = () => {
    const last = scene.shots[scene.shots.length - 1];
    const end = last?.time?.endSeconds ?? (() => { const m = last?.duration.match(/(\d+)\s*-\s*(\d+)/); return m ? Number(m[2]) : 0; })();
    const step = 8; // 每个镜头默认 8 秒
    const created: ShotV2 = { id: newId(), label: String(scene.shots.length + 1).padStart(2, "0"), duration: `${end}-${end + step}${t.seconds}`, time: { startSeconds: end, endSeconds: end + step }, framing: "Medium close-up", lens: "50mm", movement: "Static", action: t.defineAction, acting: t.naturalPerformance, direction: scene.shots[scene.shots.length - 1]?.direction ?? "left-to-right", cutStyle: scene.cutStyleDefault ?? "hard-cut" };
    setProject((current) => ({ ...current, scenes: current.scenes.map((item) => item.id === scene.id ? { ...item, shots: [...item.shots, created] } : item) })); setShotId(created.id);
  };
  /** AI 智能分镜：根据场景卡片内容生成剧情分镜并填入音频计划/镜头列表/检查器，最后编译到提示词编辑器 */
  const aiCompileScene = async () => {
    if (sceneCompileBusy) return;
    if (!isRemoteConfigured()) { setNotice(t.aiNotConfigured); return; }
    setSceneCompileBusy(true);
    setAiCompileError("");
    try {
      const draft = await fillSceneDraft(project, scene, { seconds: t.seconds });
      const targetScene = draft.scene;
      // P0.6：用户锁定的导演文档层在再次 AI 编译时保留，不被新生成覆盖。
      const lockedKeys = (scene.lockedDirectorLayers ?? []).filter((key) => (scene.directorLayers?.[key] ?? "").trim());
      const incomingLayers = targetScene.directorLayers ?? {};
      const mergedLayers: Record<string, string> = { ...incomingLayers };
      for (const key of lockedKeys) {
        const kept = scene.directorLayers?.[key];
        if (kept !== undefined) mergedLayers[key] = kept;
      }
      const mergedScene: SceneV2 = {
        ...targetScene,
        directorLayers: mergedLayers,
        lockedDirectorLayers: scene.lockedDirectorLayers,
      };
      const nextProject: ProjectV2 = {
        ...project,
        scenes: project.scenes.map((item) => item.id === mergedScene.id ? mergedScene : item),
        ...(draft.audioPlan ? { audioPlan: draft.audioPlan } : {}),
        ...(draft.negativePrompt !== undefined ? { negativePrompt: draft.negativePrompt } : {}),
      };
      setProject(nextProject);
      setManualOverride(null);
      setShotId(mergedScene.shots[0]?.id ?? "");
      const result = compilePrompt(nextProject, mergedScene, mergedScene.shots[0] ?? shot, { template, profile: modelProfileById(modelProfileId), locale, director: true });
      setPrompt(result.text);
      setNotice(t.aiCompileDone);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const classified = classifyError(error);
      const friendly = classified.kind === "timeout" || classified.kind === "network"
        ? t.aiRequestInterrupted
        : message;
      setNotice(`${t.aiCompileFailed}${friendly}`);
      setAiCompileError(friendly);
      setAiCompileErrorDetail(message);
    } finally {
      setSceneCompileBusy(false);
    }
  };
  /** 本地编译：不调用 AI，直接按当前已填写内容编译到提示词编辑器（含存档/落盘） */
  const localCompileScene = () => {
    setManualOverride(null);
    runCompile("promptLocalCompiled");
  };
  const copyAiError = async () => {
    const detail = aiCompileErrorDetail || aiCompileError;
    if (!detail) return;
    try {
      await navigator.clipboard.writeText(detail);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = detail;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    setAiErrorCopied(true);
    setNotice(t.aiErrorCopied);
    window.setTimeout(() => setAiErrorCopied(false), 2000);
  };
  const deleteShot = (id: string) => {
    const remaining = scene.shots.filter((item) => item.id !== id);
    updateScene({ shots: remaining });
    if (shotId === id) { const next = remaining.find((item) => item.id !== id) ?? remaining[0]; setShotId(next?.id ?? ""); }
  };
  const addScene = () => {
    const created = { ...scene, id: newId(), name: t.newSceneName, shots: [] };
    setProject((current) => ({ ...current, scenes: [...current.scenes, created] })); setSceneId(created.id); setShotId("");
  };
  const deleteScene = (id: string) => {
    if (project.scenes.length <= 1) { setNotice(t.keepOneScene); return; }
    const remaining = project.scenes.filter((item) => item.id !== id);
    setProject((current) => ({ ...current, scenes: remaining }));
    if (sceneId === id) { setSceneId(remaining[0].id); setShotId(remaining[0].shots[0]?.id ?? ""); }
  };
  const copyPrompt = async () => { await navigator.clipboard.writeText(sanitizeDirectorText(prompt)); setNotice(t.promptCopied); };
  const exportProject = (format: "txt" | "md" | "json") => {
    if (format !== "json") {
      const exportErrors = issues.filter((i) => i.severity === "error");
      if (exportErrors.length > 0) { setNotice(t.exportBlockedHint); return; }
    }
    const scopeLabel = template === "pro-sequence" ? (locale === "zh" ? "当前场景全部镜头" : "all scene shots") : template === "shot-cards" ? (locale === "zh" ? "当前场景逐镜" : "one card per shot") : (locale === "zh" ? "当前选中镜头" : "current shot");
    const header = format === "json" ? "" : `${locale === "zh" ? "# Cinematic Prompt Studio 导出" : "# Cinematic Prompt Studio export"}\n模板/Template: ${template}\n语言/Language: ${locale}\n范围/Scope: ${scopeLabel}\n\n`;
    const exportText = sanitizeDirectorText(prompt);
    const content = format === "json" ? JSON.stringify(project, null, 2) : format === "md" ? `${header}# ${project.title}\n\n${project.description}\n\n## ${scene.name}\n\n\`\`\`text\n${exportText}\n\`\`\`` : `${header}${exportText}`;
    download(`${project.title.replace(/ /g, "-").toLowerCase()}.${format}`, content, format === "json" ? "application/json" : "text/plain"); setNotice(`${format.toUpperCase()} ${locale === "zh" ? "导出已下载。" : "export downloaded."}`);
  };
  const importProject = (file?: File) => { if (!file) return; const reader = new FileReader(); reader.onload = () => { try { const imported = migrateProject(JSON.parse(String(reader.result))); setProject(imported); setSceneId(imported.scenes[0]?.id || ""); setShotId(imported.scenes[0]?.shots[0]?.id || ""); setNotice(t.projectImported); } catch { setNotice(t.invalidProject); } }; reader.readAsText(file); };
  const loadExample = (example: ProjectV2) => {
    const copy = structuredClone(example);
    setProject(copy); setSceneId(copy.scenes[0].id); setShotId(copy.scenes[0].shots[0]?.id ?? ""); setNotice(t.exampleLoaded); setExampleOpen(false);
  };
  return <main className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-mark"><Clapperboard size={17} /></span><span>CINEMATIC PROMPT STUDIO</span><span className="version">V0.2</span></div><div className="top-actions"><div className="example-menu"><button className="example-button" onClick={() => setExampleOpen((v) => !v)}><Sparkles size={14} /> {t.openExample} <ChevronDown size={12} /></button>{exampleOpen && <div className="example-options"><button onClick={() => loadExample(museumRedDoorsProject)}>{t.exampleMuseum}</button><button onClick={() => loadExample(bakeryRescueProject)}>{t.exampleBakery}</button></div>}</div><div className="locale-switch" aria-label="Language"><button className={locale === "zh" ? "active" : ""} onClick={() => setLocale("zh")}>中</button><button className={locale === "en" ? "active" : ""} onClick={() => setLocale("en")}>EN</button></div><button className="icon-button" title={t.saveProject} onClick={handleSaveProject}><Save size={17} /></button><button className="icon-button" title={t.openProject} onClick={handleOpenProject}><FolderOpen size={17} /></button><button className="icon-button" title={t.settings} onClick={() => setSettingsOpen(true)}><Settings2 size={17} /></button>{onClose && <button className="icon-button" title={locale === "zh" ? "退出" : "Exit"} onClick={onClose}><X size={17} /></button>}<input ref={fileInput} className="hidden" type="file" accept="application/json" onChange={(event) => importProject(event.target.files?.[0])} /></div></header>
    {settingsOpen && <SettingsModal
      t={t}
      onClose={() => setSettingsOpen(false)}
      onSaved={(settings) => {
        setAiSettings(settings);
        setNotice(!settings.provider ? t.settingsCleared : t.settingsSaved);
      }}
    />}

    <section className="content">
      <div className="content-main">
      {/* ── 1. 导演简报卡（P0.4：合并风格配方 / 场景 / 音频计划）── */}
      <DirectorBriefCard
        project={project}
        scene={scene}
        t={t}
        locale={locale}
        compileBusy={sceneCompileBusy}
        aiCompileError={aiCompileError}
        aiCompileErrorDetail={aiCompileErrorDetail}
        aiErrorCopied={aiErrorCopied}
        onSelectScene={(id) => { setSceneId(id); setShotId(project.scenes.find((item) => item.id === id)?.shots[0]?.id ?? ""); }}
        onAddScene={addScene}
        onDeleteScene={deleteScene}
        onRenameScene={updateSceneName}
        onUpdateScene={updateScene}
        onUpdateStaging={(patch) => updateScene({ staging: { ...scene.staging, ...patch } })}
        onUpdateProject={(patch) => setProject((current) => ({ ...current, ...patch }))}
        onAiCompile={() => void aiCompileScene()}
        onLocalCompile={localCompileScene}
        onCopyAiError={() => void copyAiError()}
      />

      {/* ── 2. 分层导演文档卡（P0.6：AI 编译产出各层，可展开编辑 + 锁定）── */}
      <DirectorLayersCard scene={scene} t={t} locale={locale} onUpdateScene={updateScene} />

      {/* ── 4. 镜头列表（时间线横排，P1.2）── */}
      <section className="card shots-card">
        <div className="card-head">
          <div className="card-head-title"><span className="eyebrow">{t.shotList}</span><strong>{scene.shots.length} {t.cuts}</strong></div>
          <div className="shot-actions">
            <div className="template-menu">
              <button className="outline-button" onClick={() => setTemplateMenuOpen((v) => !v)}><Plus size={14} /> {t.addShot} <ChevronDown size={13} /></button>
              {templateMenuOpen && <div className="template-options">
                <button onClick={() => { addBlankShot(); setTemplateMenuOpen(false); }}>{t.addBlankShot}</button>
                {SHOT_TEMPLATES.map((tpl) => <button key={tpl.id} onClick={() => { addShotFromTemplate(tpl.id); setTemplateMenuOpen(false); }}>
                  <b>{tpl.name}</b><small>{tpl.description}</small>
                </button>)}
              </div>}
            </div>
          </div>
        </div>
        <div className="shots-row">
          {scene.shots.map((item, index) => {
            const range = (() => { if (item.time) return { start: item.time.startSeconds, end: item.time.endSeconds }; const m = item.duration.match(/(\d+)\s*-\s*(\d+)/); return { start: m ? Number(m[1]) : 0, end: m ? Number(m[2]) : 8 }; })();
            return <div key={item.id} className={`shot-card ${item.id === shot?.id ? "selected" : ""}`} onClick={() => setShotId(item.id)}>
              <span className="shot-index">{String(index + 1).padStart(2, "0")}</span>
              <span className="shot-info"><b>{item.label}</b><small>{framingLabels[locale][item.framing] ?? item.framing}</small></span>
              <span className="shot-time-row" onClick={(event) => event.stopPropagation()}>
                <input type="number" min={0} value={range.start} title={t.startSec} onChange={(event) => updateShotRange(item.id, Number(event.target.value) || 0, range.end)} />
                <em>–</em>
                <input type="number" min={0} value={range.end} title={t.endSec} onChange={(event) => updateShotRange(item.id, range.start, Number(event.target.value) || range.start)} />
                <span className="select-wrap mini"><select value={item.cutStyle ?? "hard-cut"} onChange={(event) => updateShot({ cutStyle: event.target.value as ShotV2["cutStyle"] }, item.id)} title={t.cutStyle}>
                  <option value="hard-cut">{t.cutHard}</option>
                  <option value="overlap">{t.cutOverlap}</option>
                  <option value="match-cut">{t.cutMatch}</option>
                </select><ChevronDown size={10} /></span>
              </span>
              <span className="shot-camera">{item.lens}<small>{cameraLabels[locale][item.movement]}</small></span>
              <button className="shot-delete" title={t.deleteShot} onClick={(event) => { event.stopPropagation(); deleteShot(item.id); }}><X size={13} /></button>
            </div>;
          })}
        </div>
      </section>

      {/* ── 5. 镜头检查器（竖向）── */}
      <section className="card inspector-card">
        <div className="card-head inspector-toggle" onClick={() => setInspectorOpen((open) => !open)}>
          <div className="card-head-title"><span className="eyebrow">{t.inspector}</span><h2>{shot?.label || t.noShot}</h2></div>
          {inspectorOpen ? <ChevronDown size={16} className="inspector-caret" /> : <ChevronDown size={16} className="inspector-caret collapsed" />}
        </div>
        {inspectorOpen && (shot ? <div className="inspector-body">
          <InspectorSection>
            <div className="fields-grid two">
              <label className="field-label">{t.startSec}<span className="select-wrap"><select value={shotRange.start} onChange={(event) => updateShotRange(shot.id, Number(event.target.value), shotRange.end)}>{Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>{i} {t.seconds}</option>)}</select><ChevronDown size={14} /></span></label>
              <label className="field-label">{t.endSec}<span className="select-wrap"><select value={shotRange.end} onChange={(event) => updateShotRange(shot.id, shotRange.start, Number(event.target.value))}>{Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>{i} {t.seconds}</option>)}</select><ChevronDown size={14} /></span></label>
            </div>
          </InspectorSection>
          <InspectorSection>
            <div className="fields-grid two">
              <LabeledSelect label={t.cameraModel} value={shot.camera ?? ""} values={["", ...CAMERAS.map((camera) => camera.id)]} displayValue={(value) => value ? `${CAMERAS.find((camera) => camera.id === value)?.brand} ${CAMERAS.find((camera) => camera.id === value)?.model}` : t.none} onChange={(value) => updateShot({ camera: value || undefined })} />
              <LabeledSelect label={t.lensModel} value={shot.lensModel ?? ""} values={["", ...LENSES.map((lens) => lens.id)]} displayValue={(value) => value ? `${LENSES.find((lens) => lens.id === value)?.brand} ${LENSES.find((lens) => lens.id === value)?.model}` : t.none} onChange={(value) => updateShot({ lensModel: value || undefined })} />
            </div>
            <div className="fields-grid">
              <LabeledSelect label={t.framing} value={shot.framing} values={["Wide", "3/4 medium, behind subject", "Medium close-up", "Extreme close-up, profile"]} displayValue={(value) => framingLabels[locale][value]} onChange={(value) => updateShot({ framing: value })} />
              <LabeledSelect label={t.lens} value={shot.lens} values={["24mm", "28mm", "35mm", "50mm", "65mm", "85mm", "100mm", "135mm"]} onChange={(value) => updateShot({ lens: value })} />
              <LabeledSelect label={t.movement} value={shot.movement} values={movements} displayValue={(value) => cameraLabels[locale][value]} onChange={(value) => updateShot({ movement: value as CameraMovement })} />
            </div>
          </InspectorSection>
          <OpticsCameraEditor shot={shot} locale={locale} onUpdate={updateShot} />
          <InspectorSection>
            <div className="fields-grid two">
              <label className="field-label">{t.action}<textarea value={shot.action} onChange={(event) => updateShot({ action: event.target.value })} /></label>
              <label className="field-label">{t.acting}<textarea value={shot.acting} onChange={(event) => updateShot({ acting: event.target.value })} /></label>
            </div>
          </InspectorSection>
          <InspectorSection title={t.performance}>
            <div className="fields-grid two">
              <div className="field-label">{t.shotPerformanceLevel}
                <div className="perf-options">
                  {[0, 1, 2, 3, 4, 5].map((n) => (
                    <button key={n} className={`perf-option ${shot.performanceLevel === n ? "active" : ""}`} title={t[SHOT_PERF_TIPS[n]]} onClick={() => updateShot({ performanceLevel: shot.performanceLevel === n ? undefined : n as 0 | 1 | 2 | 3 | 4 | 5 })}>
                      {t[SHOT_PERF_KEYS[n]]}
                    </button>
                  ))}
                </div>
                <p className="hint-text">{t.shotPerformanceLevel} · {t.performanceTargetHint}</p>
              </div>
              <label className="field-label">{t.shotEyeLife}<textarea value={shot.eyeLife ?? ""} placeholder={t.shotEyeLifePlaceholder} onChange={(event) => updateShot({ eyeLife: event.target.value || undefined })} /></label>
            </div>
          </InspectorSection>
          <InspectorSection title={t.participants}>
            <ParticipantsEditor project={project} scene={scene} shot={shot} t={t} onUpdate={updateShot} />
          </InspectorSection>
          <InspectorSection title={t.shotStates}>
            <PropStateEditor project={project} shot={shot} t={t} onUpdate={updateShot} />
          </InspectorSection>
          <InspectorSection title={t.beats}>
            <BeatEditor project={project} shot={shot} t={t} onUpdate={updateShot} />
          </InspectorSection>
          <InspectorSection title={t.continuity}>
            <div className="fields-grid">
              <div className="locked-character"><span className="avatar large">{(shot.participants ?? []).length > 0 ? (shot.participants ?? []).length : 1}</span><div><b>{(shot.participants ?? []).length} {t.character}</b><small>{t.characterLocked}</small></div></div>
              <LabeledSelect label={t.screenDirection} value={shot.direction} values={["left-to-right", "right-to-left"]} displayValue={(value) => value === "left-to-right" ? t.directionLTR : t.directionRTL} onChange={(value) => updateShot({ direction: value as Shot["direction"] })} />
            </div>
          </InspectorSection>
        </div> : <div className="empty">{t.addShotHint}</div>)}
      </section>

      {/* ── 5.5 连续性面板（P0.5：分组 + 修复 + 风险评分）── */}
      <section className="card continuity-card">
        <div className="card-head">
          <div className="card-head-title"><span className="eyebrow">{t.continuity}</span><strong>{issues.length}</strong></div>
        </div>
        <ContinuityPanel project={project} scene={scene} issues={issues} directorIssues={directorLayerIssues} t={t} locale={locale} onFix={fixIssue} onAiAdvice={aiAdvice} />
      </section>
      </div>

      <aside className="content-side">
      {/* ── 资产库（右侧固定栏）── */}
      <div id="asset-library-card">
        <AssetLibrary project={project} dispatch={dispatch} locale={locale} t={t} setNotice={setNotice} />
      </div>
      <section className="card prompt-card">
        <div className="card-head">
          <div className="card-head-title"><span className="eyebrow">{t.promptEditor}</span><span className="provider-pill"><span /> {aiSettings.provider !== "none" && aiSettings.apiKey && aiSettings.model ? `${t.aiProviderRemote} · ${aiSettings.model}` : t.localCompiler}</span></div>
          <div className="dock-actions">
            <button className="icon-button" title={t.copyPrompt} onClick={copyPrompt}><Copy size={16} /></button>
            <div className="export-menu"><button className={hasExportErrors ? "outline-button export-blocked" : "outline-button"} title={hasExportErrors ? t.exportBlockedHint : undefined}><Download size={15} /> {t.export} <ChevronDown size={14} /></button><div className="export-options">
              <button disabled={hasExportErrors} title={hasExportErrors ? t.exportBlockedHint : undefined} onClick={() => exportProject("txt")}><FileText size={14} /> TXT</button>
              <button disabled={hasExportErrors} title={hasExportErrors ? t.exportBlockedHint : undefined} onClick={() => exportProject("md")}><FileText size={14} /> Markdown</button>
              <button onClick={() => exportProject("json")}><FileJson size={14} /> JSON</button>
            </div></div>
          </div>
        </div>
        <div className="compile-row">
          <span className="chip-label">{t.compileTarget}</span>
          <span className="template-select">
            <select value={template} aria-label={t.compileTarget} onChange={(event) => setTemplate(event.target.value as typeof template)}>
              <option value="asset-id-tagged">{t.assetIdTemplate}</option>
              <option value="pro-sequence">{t.proSequenceTemplate}</option>
              <option value="shot-cards">{t.shotCardsTemplate}</option>
            </select>
            <ChevronDown size={14} />
          </span>
          <span className="template-select model-select">
            <select value={modelProfileId} aria-label={t.targetModel} onChange={(event) => {
              const id = event.target.value;
              setModelProfileId(id);
              localStorage.setItem("cineprompt-model", id);
              const profile = modelProfileById(id);
              if (profile?.preferredTemplate) setTemplate(profile.preferredTemplate);
            }}>
              <option value="">{t.modelNone}</option>
              {MODEL_PROFILES.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
            </select>
            <ChevronDown size={14} />
          </span>
          <button className="outline-button history-toggle" onClick={() => setHistoryOpen((v) => !v)}><History size={14} /> {t.promptHistory} <em>{history.length}</em></button>
        </div>
        <span className="template-scope">{template === "pro-sequence" ? (locale === "zh" ? "输出范围：当前场景全部镜头" : "Scope: all scene shots") : template === "shot-cards" ? (locale === "zh" ? "输出范围：当前场景逐镜分卡" : "Scope: one card per shot") : (locale === "zh" ? "输出范围：仅当前选中镜头" : "Scope: current shot only")}</span>
        {historyOpen && <div className="history-panel">
          {history.length === 0 ? <span className="history-empty">{t.historyEmpty}</span> : history.map((version) => (
            <div className="history-row" key={version.id}>
              <span className="history-time">{new Date(version.createdAt).toLocaleTimeString()}</span>
              <span className="history-meta">
                <b>{version.template === "pro-sequence" ? t.proSequenceTemplate : version.template === "shot-cards" ? t.shotCardsTemplate : t.assetIdTemplate}</b>
                <em className={`history-severity ${version.continuitySummary.errors > 0 ? "bad" : ""}`}>{version.continuitySummary.total} · {version.continuitySummary.errors} {t.issueError}</em>
              </span>
              <span className="history-actions">
                <button className="history-restore" onClick={() => restoreVersion(version)}>{t.restore}</button>
                <button className="history-delete" title={t.deleteVersion} onClick={() => setHistory(deleteVersion(version.id))}><X size={12} /></button>
              </span>
            </div>
          ))}
        </div>}
        <span className="output-language">{locale === "zh" ? "输出语言：中文" : "Output language: English"}</span>
        <textarea className="prompt-editor" value={prompt} onChange={(event) => { setPrompt(event.target.value); if (manualOverride === null && event.target.value.trim()) setManualOverride(event.target.value); }} spellCheck={false} />
        {manualOverride !== null && <div className="manual-override-bar">
          <span><PenLine size={13} /> {t.manualOverride}</span>
          <button className="outline-button" onClick={() => { setManualOverride(null); setPrompt(compilePrompt(project, scene, shot, { template, profile: modelProfileById(modelProfileId), locale, director: true }).text); }}>{t.rebuild}</button>
          <button className="outline-button" onClick={() => setManualOverride(null)}>{t.keepOverride}</button>
        </div>}
        <div className="prompt-footer">
          <button className="primary-button" onClick={() => runCompile("promptRebuilt")}><Sparkles size={15} /> {t.generate}</button>
        </div>
      </section>
      </aside>
    </section>
    {notice && <div className="toast">{notice}<button onClick={() => setNotice("")}><X size={14} /></button></div>}
  </main>;
}

function InspectorSection({ title, children }: { title?: string; children: React.ReactNode }) { return <section className="inspector-section">{title ? <h3>{title}</h3> : null}{children}</section>; }
function LabeledSelect({ label, value, values, onChange, displayValue = (item) => item }: { label: string; value: string; values: readonly string[]; onChange(value: string): void; displayValue?(item: string): string }) { return <label className="field-label">{label}<span className="select-wrap"><select value={value} onChange={(event) => onChange(event.target.value)}>{values.map((item) => <option key={item} value={item}>{displayValue(item)}</option>)}</select><ChevronDown size={14} /></span></label>; }
