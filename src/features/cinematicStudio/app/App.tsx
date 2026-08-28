import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CAMERAS, LENSES, MODEL_PROFILES, DEFAULT_NEGATIVE, SHOT_TEMPLATES, auditFinalPromptWithProject, checkContinuityV2, compilePrompt, legacyFocalLengthToFov, lensByFov, lensById, modelProfileById, sanitizeDirectorText, shotTemplateById, validateDirectorLayers, type FinalPromptAuditIssue } from "../engine";
import type { CameraMovement, ContinuityIssueV2, FinalAuditLogEntry, ProjectV2, PromptVersion, SceneV2, Shot, ShotV2 } from "../shared-types";
import { ArrowLeft, AudioLines, ChevronDown, Copy, Download, FileJson, FileText, FolderOpen, PenLine, Plus, Save, Send, X } from "lucide-react";
import { buildFinalGenerationSource, classifyError, fillSceneDraft, generateFinalPrompt, getAssistant, optimizeSceneBrief, type SceneCompileProgress } from "./providers/ai";
import { isRemoteConfigured, listLenTalkChatModels, loadAISettings, resolveLenTalkChatModel, saveAISettings, type AISettings } from "./providers/aiSettings";
import { useSettingsStore } from "@/stores/settingsStore";
import { loadProjectFromDisk, recordVersionToSqlite, savePromptToDisk, saveProjectToDisk } from "./providers/projectStorage";
import { loadProject, migrateProject, persistProject } from "./model";
import { cameraLabels, copy, framingLabels, type CopyZh, type Locale } from "./i18n";
import AssetLibrary from "./components/AssetLibrary";
import type { CanvasAudioSource } from "./components/AssetLibrary";
import BeatEditor from "./components/BeatEditor";
import ContinuityPanel from "./components/ContinuityPanel";
import DirectorBriefCard from "./components/DirectorBriefCard";
import DirectorLayersCard from "./components/DirectorLayersCard";
import ParticipantsEditor from "./components/ParticipantsEditor";
import PropStateEditor from "./components/PropStateEditor";
import OpticsCameraEditor from "./components/OpticsCameraEditor";
import { projectReducer, type ProjectAction } from "./store/projectReducer";
import { addVersion, loadHistory } from "./store/promptHistory";
import { collectCinematicMediaReferences } from "../mediaReferences";
import { findReferenceTokens } from "@/features/canvas/application/referenceTokenEditing";

const movements: CameraMovement[] = ["Static", "Handheld", "Steadicam", "Dolly", "Tracking", "Crane", "POV", "OTS"];
const newId = () => crypto.randomUUID();
const DIRECTOR_SEQUENCE_TEMPLATE = "pro-sequence" as const;
const SHOT_PERF_TIPS = ["perf0Tip", "perf1Tip", "perf2Tip", "perf3Tip", "perf4Tip", "perf5Tip"] as const;
const SHOT_PERF_KEYS = ["perf0", "perf1", "perf2", "perf3", "perf4", "perf5"] as const;

function download(name: string, contents: string, type: string) {
  const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([contents], { type })); link.download = name; link.click(); URL.revokeObjectURL(link.href);
}

export interface CinematicStudioAppStateSnapshot {
  projectTitle?: string;
  projectDescription?: string;
  promptPreview?: string;
  referenceImages?: string[];
  referenceAudio?: string[];
}

export interface CinematicStudioAppProps {
  onClose?: () => void;
  onStateChange?: (snapshot: CinematicStudioAppStateSnapshot) => void;
  onSendToVideo?: (payload: { prompt: string; referenceImages: string[]; referenceAudio: string[] }) => void;
  canvasAudioSources?: CanvasAudioSource[];
}

export default function App({ onClose, onStateChange, onSendToVideo, canvasAudioSources = [] }: CinematicStudioAppProps = {}) {
  const [project, setProject] = useState<ProjectV2>(loadProject);
  const [locale, setLocale] = useState<Locale>(() => localStorage.getItem("cineprompt-locale") === "en" ? "en" : "zh");
  const [sceneId, setSceneId] = useState(project.scenes[0].id);
  const [shotId, setShotId] = useState(project.scenes[0].shots[0].id);
  const [prompt, setPrompt] = useState(() => project.compiledPrompt ?? "");
  const [notice, setNotice] = useState("");
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [templateMenuOpen, setTemplateMenuOpen] = useState(false);
  const [sceneCompileBusy, setSceneCompileBusy] = useState(false);
  const [finalGenerateBusy, setFinalGenerateBusy] = useState(false);
  const [sceneCompileProgress, setSceneCompileProgress] = useState<SceneCompileProgress>("idle");
  const [briefOptimizeBusy, setBriefOptimizeBusy] = useState(false);
  const [aiCompileError, setAiCompileError] = useState("");
  const [aiCompileErrorDetail, setAiCompileErrorDetail] = useState("");
  const [aiErrorCopied, setAiErrorCopied] = useState(false);
  const template = DIRECTOR_SEQUENCE_TEMPLATE;
  const [modelProfileId, setModelProfileId] = useState<string>(() => localStorage.getItem("cineprompt-model") ?? "");
  const [, setHistory] = useState<PromptVersion[]>(loadHistory);
  const [aiSettings, setAiSettings] = useState<AISettings>(() => loadAISettings());
  const customApis = useSettingsStore((state) => state.customApis);
  const chatModels = useMemo(() => listLenTalkChatModels(), [customApis]);
  /** 手动覆写文本：编辑器内容与最近编译输出不一致时记录（P2.2） */
  const [manualOverride, setManualOverride] = useState<string | null>(null);
  const [mediaPreview, setMediaPreview] = useState<{ kind: "image" | "audio"; source: string } | null>(null);
  const [promptScrollTop, setPromptScrollTop] = useState(0);
  const [auditDetailsOpen, setAuditDetailsOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [projectCodeDraft, setProjectCodeDraft] = useState(() => project.projectCode ?? "");
  const scene = project.scenes.find((item) => item.id === sceneId) ?? project.scenes[0];
  const shot = scene.shots.find((item) => item.id === shotId) ?? scene.shots[0];
  const issues = useMemo(() => checkContinuityV2(project, scene), [project, scene]);
  const directorLayerIssues = useMemo(() => scene.directorLayers ? validateDirectorLayers(scene.directorLayers, project, scene) : [], [project, scene]);
  const finalAudit = useMemo(() => auditFinalPromptWithProject(scene, project.assets ?? []), [project.assets, scene]);
  const finalAuditErrors = finalAudit.issues.filter((issue) => issue.severity === "error");
  const continuityExportErrors = issues.filter((issue) => issue.severity === "error");
  const exportBlockingIssues = [...finalAuditErrors, ...continuityExportErrors];
  const hasExportErrors = exportBlockingIssues.length > 0;
  const auditStatusDetails = [
    ...finalAudit.issues.map((issue) => locale === "zh" ? issue.detailZh : issue.detail),
    ...issues.map((issue) => locale === "zh" ? (issue.detailZh ?? issue.detail) : issue.detail),
  ].filter(Boolean).join("\n");
  const t: CopyZh = copy[locale] as CopyZh;
  const selectedChatModel = aiSettings.provider && aiSettings.model ? `${aiSettings.provider}:${aiSettings.model}` : "";
  const mediaReferences = useMemo(() => collectCinematicMediaReferences(project, scene), [project, scene]);

  /** 结构更新统一走 reducer（Compiler/Continuity 只读不可变快照） */
  const dispatch = (action: ProjectAction) => setProject((prev) => projectReducer(prev, action));

  const recordFinalAudit = (targetScene: SceneV2, audit = auditFinalPromptWithProject(targetScene, project.assets ?? []), continuity = checkContinuityV2(project, targetScene)) => {
    const allIssues = [
      ...audit.issues,
      ...continuity.map((issue) => ({ code: issue.code, severity: issue.severity, detail: issue.detail, detailZh: issue.detailZh, shotId: issue.entityId })),
    ];
    const record: FinalAuditLogEntry = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      sceneId: targetScene.id,
      status: allIssues.some((issue) => issue.severity === "error") ? "blocked" : "passed",
      automaticFixes: audit.adjustments,
      issues: allIssues,
    };
    dispatch({ type: "RECORD_FINAL_AUDIT", record });
    return record;
  };

  const focusAuditIssue = (issue: Pick<FinalPromptAuditIssue, "shotId" | "field">) => {
    if (issue.shotId && scene.shots.some((candidate) => candidate.id === issue.shotId)) {
      setShotId(issue.shotId);
      setInspectorOpen(true);
      window.requestAnimationFrame(() => document.getElementById("cinematic-shot-inspector")?.scrollIntoView({ behavior: "smooth", block: "start" }));
      return;
    }
    const target = issue.field === "lighting" || issue.field === "staging" ? "cinematic-director-brief" : "cinematic-shot-inspector";
    window.requestAnimationFrame(() => document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  const auditRecommendation = (action: FinalPromptAuditIssue["action"] | undefined): string | undefined => {
    if (!action) return undefined;
    const labels = locale === "zh"
      ? {
          "review-staging": "建议：返回场景地图补充首帧与站位。",
          "review-lighting": "建议：返回场景光线，保留一种可同时成立的事实。",
          "review-optics": "建议：检查该镜头的 FOV 与可见结果。",
          "review-acting": "建议：改为可拍摄的眼神、呼吸、手部或姿势变化。",
          "review-voice": "建议：为开口角色补充声音锁。",
          "review-action": "建议：补充可见动作节拍，或重新 AI 编译。",
          recompile: "建议：根据当前结构化数据重新 AI 编译。",
        }
      : {
          "review-staging": "Recommended: return to the scene map and complete first-frame blocking.",
          "review-lighting": "Recommended: return to lighting and keep one compatible visual fact.",
          "review-optics": "Recommended: review this shot's FOV and visible result.",
          "review-acting": "Recommended: use visible eye, breath, hand, or posture behavior.",
          "review-voice": "Recommended: add a voice lock for the speaking character.",
          "review-action": "Recommended: add visible action beats or recompile with AI.",
          recompile: "Recommended: recompile from the current structured data.",
        };
    return labels[action];
  };

  useEffect(() => { persistProject(project); }, [project]);
  useEffect(() => { localStorage.setItem("cineprompt-locale", locale); }, [locale]);
  useEffect(() => { setProjectCodeDraft(project.projectCode ?? ""); }, [project.projectCode]);
  /** LenTalk Chat 配置变更时同步刷新工作室选中的模型（地址/Key 同源） */
  useEffect(() => { setAiSettings(loadAISettings()); }, [customApis]);
  const selectChatModel = (value: string) => {
    const separator = value.indexOf(":");
    const providerId = separator >= 0 ? value.slice(0, separator) : "";
    const model = separator >= 0 ? value.slice(separator + 1) : "";
    const option = chatModels.find((item) => item.providerId === providerId && item.model === model);
    if (!option) return;
    setAiSettings(saveAISettings(resolveLenTalkChatModel(option.providerId, option.model)));
    setNotice(t.settingsSaved);
  };
  const commitProjectCode = () => {
    const nextCode = projectCodeDraft.trim();
    if (!nextCode) {
      setProjectCodeDraft(project.projectCode ?? "");
      return;
    }
    if (nextCode !== project.projectCode) {
      dispatch({ type: "PATCH_PROJECT", patch: { projectCode: nextCode } });
    }
  };
  /** 节点嵌入：把工程标题与提示词摘要回传给宿主节点（防抖 400ms，避免逐键同步） */
  useEffect(() => {
    const timer = window.setTimeout(() => {
      onStateChange?.({
        projectTitle: project.title,
        projectDescription: project.description,
        promptPreview: prompt,
        referenceImages: mediaReferences.referenceImages,
        referenceAudio: mediaReferences.referenceAudio,
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [mediaReferences.referenceAudio, mediaReferences.referenceImages, onStateChange, project.description, project.title, prompt]);
  useEffect(() => {
    if ((project.compiledPrompt ?? "") === prompt) return;
    dispatch({ type: "PATCH_PROJECT", patch: { compiledPrompt: prompt } });
  }, [project.compiledPrompt, prompt]);
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
    const created: ShotV2 = { id: newId(), label: String(scene.shots.length + 1).padStart(2, "0"), duration: `${end}-${end + step}${t.seconds}`, time: { startSeconds: end, endSeconds: end + step }, framing: "Medium close-up", lens: "50mm", optics: { lensCharacter: "47-standard", fieldOfViewDegrees: 47 }, movement: "Static", action: t.defineAction, acting: t.naturalPerformance, direction: scene.shots[scene.shots.length - 1]?.direction ?? "left-to-right", cutStyle: scene.cutStyleDefault ?? "hard-cut" };
    setProject((current) => ({ ...current, scenes: current.scenes.map((item) => item.id === scene.id ? { ...item, shots: [...item.shots, created] } : item) })); setShotId(created.id);
  };
  /** AI 智能分镜：只生成导演文档与镜头分镜，审核冲突后停在结构化编辑阶段。 */
  const aiCompileScene = async () => {
    if (sceneCompileBusy) return;
    if (!isRemoteConfigured()) { setNotice(t.aiNotConfigured); return; }
    setSceneCompileBusy(true);
    setSceneCompileProgress("preparing");
    setAiCompileError("");
    try {
      const draft = await fillSceneDraft(project, scene, { seconds: t.seconds, locale, onProgress: setSceneCompileProgress });
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
      };
      setProject(nextProject);
      setManualOverride(null);
      setShotId(mergedScene.shots[0]?.id ?? "");
      setSceneCompileProgress("validating");
      const audit = auditFinalPromptWithProject(mergedScene, project.assets ?? []);
      const nextIssues = checkContinuityV2(nextProject, mergedScene);
      const layerIssues = validateDirectorLayers(mergedScene.directorLayers ?? {}, nextProject, mergedScene);
      const blockers = audit.issues.filter((issue) => issue.severity === "error").length
        + nextIssues.filter((issue) => issue.severity === "error").length
        + layerIssues.filter((issue) => issue.severity === "error").length;
      recordFinalAudit(mergedScene, audit, nextIssues);
      if (blockers > 0) {
        setNotice(locale === "zh"
          ? `AI 已生成可编辑分镜草案，但最终审核发现 ${blockers} 项事实冲突。修正后继续生成，最后一次有效提示词不会被覆盖。`
          : `AI generated an editable storyboard draft, but final review found ${blockers} factual conflict(s). Fix them and continue; the last valid prompt was preserved.`);
        return;
      }
      setNotice(t.aiCompileDone);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const classified = classifyError(error);
      const friendly = classified.kind === "gateway-timeout"
        ? t.aiGatewayTimeout
        : classified.kind === "timeout" || classified.kind === "network"
          ? t.aiRequestInterrupted
          : message;
      setNotice(`${t.aiCompileFailed}${friendly}`);
      setAiCompileError(friendly);
      setAiCompileErrorDetail(message);
    } finally {
      setSceneCompileBusy(false);
      setSceneCompileProgress("idle");
    }
  };
  /** 仅补齐导演简报中的 AI 参考字段，不生成镜头或最终提示词。 */
  const aiOptimizeBrief = async () => {
    if (briefOptimizeBusy || sceneCompileBusy) return;
    if (!isRemoteConfigured()) { setNotice(t.aiNotConfigured); return; }
    setBriefOptimizeBusy(true);
    try {
      const optimized = await optimizeSceneBrief(project, scene, locale);
      setProject((current) => ({
        ...current,
        scenes: current.scenes.map((item) => item.id === scene.id ? {
          ...item,
          mustHappen: optimized.mustHappen,
          forbid: optimized.forbid,
          ...(optimized.dialogue ? { dialogue: optimized.dialogue } : {}),
          ...(optimized.emotionArc ? { emotionArc: optimized.emotionArc } : {}),
          actingObjectives: optimized.actingObjectives,
        } : item),
        audioPlan: optimized.audioPlan,
      }));
      setNotice(t.aiBriefOptimized);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const classified = classifyError(error);
      const friendly = classified.kind === "gateway-timeout"
        ? t.aiGatewayTimeout
        : classified.kind === "timeout" || classified.kind === "network"
          ? t.aiRequestInterrupted
          : message;
      setNotice(`${t.aiOptimizeBriefFailed}${friendly}`);
    } finally {
      setBriefOptimizeBusy(false);
    }
  };
  /** 最终生成：审核当前结构化内容后，先本地生成 canonical source，再由 AI 组织最终提示词。 */
  const localCompileScene = async () => {
    if (sceneCompileBusy || finalGenerateBusy) return;
    if (!isRemoteConfigured()) { setNotice(t.aiNotConfigured); return; }
    const issues = checkContinuityV2(project, scene);
    const audit = auditFinalPromptWithProject(scene, project.assets ?? []);
    const layerIssues = validateDirectorLayers(scene.directorLayers ?? {}, project, scene);
    const blockers = audit.issues.filter((issue) => issue.severity === "error").length
      + issues.filter((issue) => issue.severity === "error").length
      + layerIssues.filter((issue) => issue.severity === "error").length;
    recordFinalAudit(scene, audit, issues);
    if (blockers > 0) {
      setNotice(locale === "zh"
        ? `最终审核发现 ${blockers} 项事实冲突，请修正后再最终生成。`
        : `Final review found ${blockers} factual conflict(s). Fix them before final generation.`);
      return;
    }
    setFinalGenerateBusy(true);
    setAiCompileError("");
    try {
      const canonical = buildFinalGenerationSource(project, scene);
      const text = await generateFinalPrompt(canonical, locale);
      setManualOverride(null);
      setPrompt(text);
      const record = addVersion({
        template,
        modelProfileId: modelProfileId || undefined,
        outputText: text,
        projectSnapshot: structuredClone(project),
        continuitySummary: { total: issues.length, errors: issues.filter((issue) => issue.severity === "error").length, warnings: issues.filter((issue) => issue.severity === "warning").length },
      });
      setHistory(record);
      if (projectPackageDir) {
        const latest = record[0];
        if (latest) {
          void savePromptToDisk(projectPackageDir, latest.id, text);
          void recordVersionToSqlite(projectPackageDir, latest.id, template, JSON.stringify(latest.continuitySummary));
        }
      }
      setNotice(t.promptLocalCompiled);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const classified = classifyError(error);
      const friendly = classified.kind === "gateway-timeout"
        ? t.aiGatewayTimeout
        : classified.kind === "timeout" || classified.kind === "network"
          ? t.aiRequestInterrupted
          : message;
      setNotice(`${t.aiCompileFailed}${friendly}`);
      setAiCompileError(friendly);
      setAiCompileErrorDetail(message);
    } finally {
      setFinalGenerateBusy(false);
    }
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
    if (scene.shots.length <= 1) {
      setNotice(t.keepOneShot);
      return;
    }
    const remaining = scene.shots.filter((item) => item.id !== id);
    updateScene({ shots: remaining });
    if (shotId === id) setShotId(remaining[0].id);
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
  const copyPrompt = async () => {
    if (hasExportErrors) {
      setNotice(locale === "zh" ? "最终审计未通过，不能复制提示词。" : "Final audit has blocking issues; prompt copy is disabled.");
      return;
    }
    await navigator.clipboard.writeText(sanitizeDirectorText(prompt));
    setNotice(t.promptCopied);
  };
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
  return <main className="app-shell">
    <section className="content">
      <div className="content-main">
      {/* ── 1. 导演简报卡（P0.4：合并风格配方 / 场景 / 音频计划）── */}
      <div id="cinematic-director-brief">
      <DirectorBriefCard
        project={project}
        scene={scene}
        t={t}
        locale={locale}
        compileBusy={sceneCompileBusy}
        finalGenerateBusy={finalGenerateBusy}
        compileProgress={sceneCompileProgress}
        briefOptimizeBusy={briefOptimizeBusy}
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
        onAiOptimizeBrief={() => void aiOptimizeBrief()}
        onLocalCompile={localCompileScene}
        onCopyAiError={() => void copyAiError()}
        chatModels={chatModels}
        selectedChatModel={selectedChatModel}
        onSelectChatModel={selectChatModel}
      />
      </div>

      {/* ── 2. 分层导演文档卡（P0.6：AI 编译产出各层，可展开编辑 + 锁定）── */}
      <DirectorLayersCard scene={scene} t={t} locale={locale} onUpdateScene={updateScene} />

      {/* ── 4. 镜头执行：时间线、动作、角色表演与节拍共用同一结构化数据 ── */}
      <section className="card shots-card">
        <div className="card-head">
          <div className="card-head-title"><span className="eyebrow">{locale === "zh" ? "镜头执行" : "Shot execution"}</span><strong>{scene.shots.length} {t.cuts}</strong></div>
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
              <span className="shot-camera">{(() => { const fov = item.optics?.fieldOfViewDegrees ?? lensById(item.optics?.lensCharacter)?.fov ?? lensByFov(legacyFocalLengthToFov(item.lens))?.fov; return fov == null ? "—" : `${fov}°`; })()}<small>{cameraLabels[locale][item.movement]}</small></span>
              <span className={`shot-cast ${(item.participants ?? []).length === 0 ? "empty" : ""}`} title={t.participants}>
                {(item.participants ?? []).length === 0
                  ? t.noShotParticipants
                  : (item.participants ?? []).map((participant) => project.assets?.find((asset) => asset.id === participant.characterId)?.name ?? participant.characterId).join(" · ")}
              </span>
              <button className="shot-delete" title={t.deleteShot} onClick={(event) => { event.stopPropagation(); deleteShot(item.id); }}><X size={13} /></button>
            </div>;
          })}
        </div>
      </section>

      {/* ── 5. 镜头执行详情：编辑当前镜头的动作、角色表演、节拍与空间 ── */}
      <section id="cinematic-shot-inspector" className="card inspector-card">
        <div className="card-head inspector-toggle" onClick={() => setInspectorOpen((open) => !open)}>
          <div className="card-head-title"><span className="eyebrow">{locale === "zh" ? "镜头执行详情" : "Shot execution details"}</span><h2>{shot?.label || t.noShot}</h2></div>
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
      <section className="side-project-toolbar" aria-label={locale === "zh" ? "工程设置" : "Project controls"}>
        {onClose && <button className="outline-button studio-back-button" onClick={onClose}><ArrowLeft size={15} /> {locale === "zh" ? "返回画布" : "Back to canvas"}</button>}
        <label className="asset-project-code">{t.projectCode}
          <input
            value={projectCodeDraft}
            placeholder={t.projectCodePlaceholder}
            onChange={(event) => setProjectCodeDraft(event.target.value)}
            onBlur={commitProjectCode}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </label>
        <div className="locale-switch" aria-label="Language">
          <button className={locale === "zh" ? "active" : ""} onClick={() => setLocale("zh")}>中</button>
          <button className={locale === "en" ? "active" : ""} onClick={() => setLocale("en")}>EN</button>
        </div>
        <div className="side-project-actions">
          <button className="icon-button" title={t.openProject} onClick={handleOpenProject}><FolderOpen size={16} /></button>
          <button className="icon-button" title={t.saveProject} onClick={handleSaveProject}><Save size={16} /></button>
        </div>
        <input ref={fileInput} className="hidden" type="file" accept="application/json" onChange={(event) => importProject(event.target.files?.[0])} />
      </section>
      {/* ── 资产库（右侧固定栏）── */}
      <div id="asset-library-card">
        <AssetLibrary project={project} scene={scene} dispatch={dispatch} locale={locale} t={t} setNotice={setNotice} canvasAudioSources={canvasAudioSources} />
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
          <span className="template-select model-select" title={t.targetModelHint}>
            <select value={modelProfileId} aria-label={t.targetModel} onChange={(event) => {
              const id = event.target.value;
              setModelProfileId(id);
              localStorage.setItem("cineprompt-model", id);
            }}>
              <option value="">{t.modelNone}</option>
              {MODEL_PROFILES.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
            </select>
            <ChevronDown size={14} />
          </span>
        </div>
        <div className="prompt-editor-toolbar">
          <div className="prompt-editor-status">
            <div className="audit-action-row">
              <button type="button" className="outline-button audit-details-toggle" onClick={() => setAuditDetailsOpen((open) => !open)}>
                {auditDetailsOpen
                  ? (locale === "zh" ? "收起审计详情" : "Hide audit details")
                  : (locale === "zh" ? "查看审计详情" : "View audit details")}
              </button>
              {hasExportErrors && <button
                type="button"
                className="outline-button audit-continue-button"
                onClick={localCompileScene}
                title={locale === "zh" ? "根据当前已修正的数据重新生成最终提示词" : "Regenerate the final prompt from the corrected current data"}
              >
                {locale === "zh" ? "修正后继续生成" : "Continue after fixing"}
              </button>}
            </div>
            <div className="audit-status-row">
              <span className="output-language">{locale === "zh" ? "输出语言：中文" : "Output language: English"}</span>
              <span
                className={`final-audit-status ${hasExportErrors ? "error" : finalAudit.issues.length > 0 ? "warning" : "passed"}`}
                title={auditStatusDetails}
              >
                {hasExportErrors
                  ? (locale === "zh" ? `最终审核：整体规则已整理，${exportBlockingIssues.length} 项冲突待修正` : `Final review: overall rules are organized; ${exportBlockingIssues.length} conflict(s) to fix`)
                  : finalAudit.issues.length > 0
                    ? (locale === "zh" ? `最终审核：整体规则符合，已整理 ${finalAudit.issues.length} 项` : `Final review: overall rules conform; ${finalAudit.issues.length} item(s) organized`)
                    : (locale === "zh" ? "最终审核：整体规则符合" : "Final review: overall rules conform")}
              </span>
            </div>
          </div>
          <button
            type="button"
            className="primary-button prompt-send-video-button"
            disabled={!onSendToVideo || !prompt.trim() || hasExportErrors}
            title={hasExportErrors
              ? (locale === "zh" ? "最终审计未通过，请先修正场景中的阻断问题。" : "Final audit has blocking issues. Fix the scene before sending.")
              : !onSendToVideo ? (locale === "zh" ? "请从画布中的电影提示词工作室节点打开" : "Open this from a Cinematic Prompt Studio node on the canvas") : undefined}
            onClick={() => {
              const nextPrompt = prompt.trim();
              if (!nextPrompt || !onSendToVideo || hasExportErrors) return;
              onSendToVideo({ prompt: nextPrompt, ...mediaReferences });
              setNotice(t.sentToVideoNode);
            }}
          >
            <Send size={16} /> {t.sendToVideoNode}
          </button>
        </div>
        {auditDetailsOpen && <div className="final-audit-details">
          <section>
            <h3>{locale === "zh" ? "自动修正" : "Automatic corrections"}</h3>
            {finalAudit.adjustments.length > 0 ? <ul>
              {finalAudit.adjustments.map((adjustment, index) => <li key={`${adjustment.code}-${adjustment.shotId ?? "scene"}-${index}`}>
                <span>{locale === "zh" ? adjustment.detailZh : adjustment.detail}</span>
                {adjustment.shotId && <button type="button" className="text-button" onClick={() => focusAuditIssue({ shotId: adjustment.shotId })}>{locale === "zh" ? "定位镜头" : "Locate shot"}</button>}
              </li>)}
            </ul> : <p>{locale === "zh" ? "本次没有需要自动修正的格式或术语。" : "No format or terminology corrections were needed."}</p>}
          </section>
          <section>
            <h3>{locale === "zh" ? "待处理问题" : "Issues to review"}</h3>
            {([...finalAudit.issues, ...issues] as Array<FinalPromptAuditIssue | ContinuityIssueV2>).length > 0 ? <ul>
              {[...finalAudit.issues, ...issues].map((issue, index) => {
                const shotTargetId = "shotId" in issue
                  ? (issue as FinalPromptAuditIssue).shotId
                  : (issue as ContinuityIssueV2).entityId;
                const field = "field" in issue ? issue.field : undefined;
                const recommendation = auditRecommendation("action" in issue ? issue.action : undefined)
                  ?? ("fixLabel" in issue ? issue.fixLabel : undefined);
                return <li key={`${issue.code}-${shotTargetId ?? "scene"}-${index}`} className={issue.severity}>
                  <span><b>{issue.severity === "error" ? (locale === "zh" ? "必须修正" : "Blocking") : (locale === "zh" ? "建议检查" : "Review")}</b>{locale === "zh" ? (issue.detailZh ?? issue.detail) : issue.detail}{recommendation && <small className="audit-recommendation">{recommendation}</small>}</span>
                  {(shotTargetId || field) && <button type="button" className="text-button" onClick={() => focusAuditIssue({ shotId: shotTargetId, field })}>{locale === "zh" ? "定位" : "Locate"}</button>}
                </li>;
              })}
            </ul> : <p>{locale === "zh" ? "没有待处理问题。" : "No issues require review."}</p>}
          </section>
          {(project.finalAuditLog ?? []).length > 0 && <section>
            <h3>{locale === "zh" ? "审计变更记录" : "Audit change log"}</h3>
            <ul className="audit-history-list">
              {(project.finalAuditLog ?? []).slice(0, 3).map((entry) => <li key={entry.id} className={entry.status}>
                <span>{new Date(entry.createdAt).toLocaleString(locale === "zh" ? "zh-CN" : "en-US")} · {entry.status === "blocked" ? (locale === "zh" ? "需修正" : "Blocked") : (locale === "zh" ? "已通过" : "Passed")} · {entry.automaticFixes.length} {locale === "zh" ? "项自动修正" : "automatic correction(s)"}</span>
              </li>)}
            </ul>
          </section>}
        </div>}
        <div className="prompt-media-editor">
          <PromptMediaOverlay prompt={prompt} images={mediaReferences.referenceImages} audio={mediaReferences.referenceAudio} scrollTop={promptScrollTop} onPreview={(kind, source) => setMediaPreview({ kind, source })} />
          <textarea className="prompt-editor" value={prompt} onChange={(event) => { setPrompt(event.target.value); if (manualOverride === null && event.target.value.trim()) setManualOverride(event.target.value); }} onScroll={(event) => setPromptScrollTop(event.currentTarget.scrollTop)} spellCheck={false} />
        </div>
        {manualOverride !== null && <div className="manual-override-bar">
          <span><PenLine size={13} /> {t.manualOverride}</span>
          <button className="outline-button" onClick={() => { setManualOverride(null); setPrompt(compilePrompt(project, scene, shot, { template, profile: modelProfileById(modelProfileId), locale, director: true }).text); }}>{t.rebuild}</button>
          <button className="outline-button" onClick={() => setManualOverride(null)}>{t.keepOverride}</button>
        </div>}
      </section>
      </aside>
      {mediaPreview && <div className="modal-overlay prompt-media-preview-overlay" onClick={() => setMediaPreview(null)}>
        <div className="prompt-media-preview" onClick={(event) => event.stopPropagation()}>
          <button className="modal-close" title={t.cancel} onClick={() => setMediaPreview(null)}><X size={15} /></button>
          {mediaPreview.kind === "image" ? <img src={mediaPreview.source} alt="" /> : <audio controls autoPlay src={mediaPreview.source} />}
        </div>
      </div>}
    </section>
    {notice && <div className="toast">{notice}<button onClick={() => setNotice("")}><X size={14} /></button></div>}
  </main>;
}

function PromptMediaOverlay({ prompt, images, audio, scrollTop, onPreview }: {
  prompt: string;
  images: string[];
  audio: string[];
  scrollTop: number;
  onPreview(kind: "image" | "audio", source: string): void;
}) {
  const tokens = findReferenceTokens(prompt, images.length, audio.length);
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const token of tokens) {
    if (token.start > cursor) parts.push(<span key={`text-${cursor}`}>{prompt.slice(cursor, token.start)}</span>);
    const source = token.kind === "image" ? images[token.value - 1] : audio[token.value - 1];
    if (!source) {
      parts.push(<span key={`token-${token.start}`}>{token.token}</span>);
    } else if (token.kind === "image") {
      parts.push(<button key={`token-${token.start}`} type="button" className="prompt-media-image" title={token.token} onClick={() => onPreview("image", source)}><img src={source} alt={token.token} /></button>);
    } else {
      parts.push(<button key={`token-${token.start}`} type="button" className="prompt-media-audio" title={token.token} onClick={() => onPreview("audio", source)}><AudioLines size={13} /> {token.token}</button>);
    }
    cursor = token.end;
  }
  if (cursor < prompt.length) parts.push(<span key={`text-${cursor}`}>{prompt.slice(cursor)}</span>);
  return <div className="prompt-media-overlay"><div className="prompt-media-overlay-content" style={{ transform: `translateY(-${scrollTop}px)` }}>{parts}</div></div>;
}

function InspectorSection({ title, children }: { title?: string; children: React.ReactNode }) { return <section className="inspector-section">{title ? <h3>{title}</h3> : null}{children}</section>; }
function LabeledSelect({ label, value, values, onChange, displayValue = (item) => item }: { label: string; value: string; values: readonly string[]; onChange(value: string): void; displayValue?(item: string): string }) { return <label className="field-label">{label}<span className="select-wrap"><select value={value} onChange={(event) => onChange(event.target.value)}>{values.map((item) => <option key={item} value={item}>{displayValue(item)}</option>)}</select><ChevronDown size={14} /></span></label>; }
