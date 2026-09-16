import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  CAMERAS,
  LENSES,
  MODEL_PROFILES,
  compilePrompt,
  legacyFocalLengthToFov,
  lensByFov,
  lensById,
  modelProfileById,
  sanitizeDirectorText,
} from "../engine";
import type {
  CameraMovement,
  ProjectV2,
  PromptVersion,
  SceneV2,
  Shot,
  ShotV2,
} from "../shared-types";
import {
  ArrowLeft,
  AudioLines,
  ChevronDown,
  Copy,
  Download,
  FileJson,
  FileText,
  FolderOpen,
  Library,
  PenLine,
  Plus,
  Save,
  Send,
  X,
} from "lucide-react";
import {
  buildFinalGenerationSource,
  ChatCompletionInterruptedError,
  classifyError,
  collectSceneAssetIds,
  fillSceneDraft,
  generateFinalPrompt,
  optimizeSceneBrief,
  optimizeStyleDescription,
  planPerformance,
  type SceneCompileProgress,
  type SceneCompileProgressListener,
} from "./providers/ai";
import { resolveImageDisplayUrl } from "@/features/canvas/application/imageData";
import {
  isRemoteConfigured,
  listLenTalkChatModels,
  loadAISettings,
  resolveLenTalkChatModel,
  saveAISettings,
  type AISettings,
  type ReasoningEffort,
} from "./providers/aiSettings";
import { useSettingsStore } from "@/stores/settingsStore";
import { isTauri } from "@tauri-apps/api/core";
import {
  loadProjectFromDisk,
  recordVersionToSqlite,
  savePromptToDisk,
  saveProjectToDisk,
} from "./providers/projectStorage";
import {
  loadProjectById,
  loadProjectFromDatabaseById,
  loadSharedAssets,
  mergeAssetPool,
  migrateProject,
  persistProjectById,
  persistProjectToDatabaseById,
  persistSharedAssets,
} from "./model";
import { isDefaultCinematicProjectId } from "./projectId";
import { applyQuickStudioSync, quickSyncFromProject, quickSyncScene, type CinematicStudioQuickSync, type CinematicStudioUpstreamText } from "./quickStudioSync";
import { cameraLabels, copy, framingLabels, type CopyZh, type Locale } from "./i18n";
import {
  cameraMovementHint,
  cameraMovementLabel,
  cameraMovementSelectGroups,
} from "./cameraMovements";
import type { CanvasAudioSource } from "./components/AssetLibrary";
import BeatEditor from "./components/BeatEditor";
import DirectorBriefCard from "./components/DirectorBriefCard";
import DirectorLayersCard from "./components/DirectorLayersCard";
import type { CanvasImageSource } from "./components/DirectorLayersCard";
import ParticipantsEditor from "./components/ParticipantsEditor";
import PropStateEditor from "./components/PropStateEditor";
import OpticsCameraEditor from "./components/OpticsCameraEditor";
import { projectReducer, type ProjectAction } from "./store/projectReducer";
import { addVersion, loadHistory, loadHistoryFromDatabase, persistHistoryToDatabase } from "./store/promptHistory";
import { collectCinematicMediaReferences } from "../mediaReferences";
import { findReferenceTokens } from "@/features/canvas/application/referenceTokenEditing";
import { useAssetLibraryStore } from "@/features/library/assetStore";
import type { LibraryAsset } from "@/features/library/types";

const newId = () => crypto.randomUUID();
const DIRECTOR_SEQUENCE_TEMPLATE = "pro-sequence" as const;
const SHOT_PERF_TIPS = ["perf0Tip", "perf1Tip", "perf2Tip", "perf3Tip", "perf4Tip", "perf5Tip"] as const;
const SHOT_PERF_KEYS = ["perf0", "perf1", "perf2", "perf3", "perf4", "perf5"] as const;

type ResumeJobKind = "scene" | "final";
interface ResumeJob {
  kind: ResumeJobKind;
  run(): Promise<void>;
}

function download(name: string, contents: string, type: string) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([contents], { type }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

export interface CinematicStudioAppStateSnapshot {
  projectTitle?: string;
  projectDescription?: string;
  promptPreview?: string;
  referenceImages?: string[];
  referenceAudio?: string[];
  /** Compact-node fields mirrored from the active scene in advanced editing. */
  quickSync?: CinematicStudioQuickSync;
}

export interface CinematicStudioAppProps {
  onClose?: () => void;
  onStateChange?: (snapshot: CinematicStudioAppStateSnapshot) => void;
  onSendToVideo?: (payload: { prompt: string; referenceImages: string[]; referenceAudio: string[] }) => void;
  canvasAudioSources?: CanvasAudioSource[];
  canvasImageSources?: CanvasImageSource[];
  /**
   * 本实例对应的工程 id（画布上每个工作室节点一份独立工程）。
   * 缺省时落到历史全局工程，保证旧数据仍可打开。
   */
  projectId?: string;
  /** Values supplied by the compact canvas node before opening the workbench. */
  quickSync?: CinematicStudioQuickSync;
  /**
   * 画布上游接入的文本（风格 / 故事梗概两条口子各一份）。
   * 只做灰色只读回显，不写进工程文件——上游断联后由画布侧传空数组即可自动消失。
   */
  quickSyncUpstream?: CinematicStudioUpstreamText;
}

export default function App({
  onClose,
  onStateChange,
  onSendToVideo,
  canvasAudioSources: _canvasAudioSources = [],
  canvasImageSources = [],
  projectId,
  quickSync,
  quickSyncUpstream,
}: CinematicStudioAppProps = {}) {
  const [project, setProject] = useState<ProjectV2>(() => {
    const initial = loadProjectById(projectId);
    return quickSync ? applyQuickStudioSync(initial, quickSync) : initial;
  });
  const [projectStorageReady, setProjectStorageReady] = useState(false);
  /** 全局共享资产库是否已就绪（未就绪前不得写回，避免用空列表覆盖资产库）。 */
  const [sharedAssetsReady, setSharedAssetsReady] = useState(false);
  const [locale, setLocale] = useState<Locale>(() =>
    localStorage.getItem("cineprompt-locale") === "en" ? "en" : "zh",
  );
  const [sceneId, setSceneId] = useState(() => quickSync?.sceneId && project.scenes.some((scene) => scene.id === quickSync.sceneId)
    ? quickSync.sceneId
    : project.scenes[0].id);
  const [shotId, setShotId] = useState(project.scenes[0]?.shots[0]?.id ?? "");
  const [prompt, setPrompt] = useState(() => project.compiledPrompt ?? "");
  const [notice, setNotice] = useState("");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [sceneCompileBusy, setSceneCompileBusy] = useState(false);
  const [finalGenerateBusy, setFinalGenerateBusy] = useState(false);
  const [sceneCompileProgress, setSceneCompileProgress] = useState<SceneCompileProgress>("idle");
  const [compileReceivedChars, setCompileReceivedChars] = useState(0);
  const [briefOptimizeBusy, setBriefOptimizeBusy] = useState(false);
  const [styleOptimizeBusy, setStyleOptimizeBusy] = useState(false);
  const [aiCompileError, setAiCompileError] = useState("");
  const [aiCompileErrorDetail, setAiCompileErrorDetail] = useState("");
  const [aiErrorCopied, setAiErrorCopied] = useState(false);
  const [resumeAvailable, setResumeAvailable] = useState(false);
  const [resumeBusy, setResumeBusy] = useState(false);
  const template = DIRECTOR_SEQUENCE_TEMPLATE;
  const [modelProfileId, setModelProfileId] = useState<string>(() => localStorage.getItem("cineprompt-model") ?? "");
  const [, setHistory] = useState<PromptVersion[]>(loadHistory);
  const [aiSettings, setAiSettings] = useState<AISettings>(() => loadAISettings());
  const customApis = useSettingsStore((state) => state.customApis);
  /** 工作室选中的 Chat 模型（资产卡内切换模型时也要同步顶栏，故订阅 store 选择项） */
  const cinematicAiSelection = useSettingsStore((state) => state.cinematicAiSelection);
  const chatModels = listLenTalkChatModels();
  /** 手动覆写文本：编辑器内容与最近编译输出不一致时记录（P2.2） */
  const [manualOverride, setManualOverride] = useState<string | null>(null);
  const [mediaPreview, setMediaPreview] = useState<{ kind: "image" | "audio"; source: string } | null>(null);
  const [promptScrollTop, setPromptScrollTop] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const initialProjectRef = useRef(project);
  const appliedQuickSyncSignature = useRef(quickSync ? JSON.stringify(quickSync) : "");
  const resumeJobRef = useRef<ResumeJob | null>(null);
  const [projectCodeDraft, setProjectCodeDraft] = useState(() => project.projectCode ?? "");
  const scene = project.scenes.find((item) => item.id === sceneId) ?? project.scenes[0];
  const shot = scene.shots.find((item) => item.id === shotId) ?? scene.shots[0];
  const t: CopyZh = copy[locale] as CopyZh;
  const selectedChatModel = aiSettings.provider && aiSettings.model ? `${aiSettings.provider}:${aiSettings.model}` : "";
  const mediaReferences = useMemo(() => collectCinematicMediaReferences(project, scene), [project, scene]);
  const assetLibraryHydrated = useAssetLibraryStore((state) => state.isHydrated);
  const hydrateAssetLibrary = useAssetLibraryStore((state) => state.hydrate);

  useEffect(() => {
    void hydrateAssetLibrary();
  }, [hydrateAssetLibrary]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent("lentalk:register-cinematic-asset-library", {
      detail: {
        project,
        scene,
        dispatch,
        locale,
        t,
        setNotice,
        canvasAudioSources: _canvasAudioSources,
      },
    }));
  }, [project, scene, locale, t, _canvasAudioSources]);

  // The shared canvas library is the single media entry point. Keep a lightweight
  // mirror of cinematic reference media there while retaining full cinematic
  // asset records in the project for prompt compilation and scene references.
  useEffect(() => {
    // 资产库就绪前（assets 还没并入）绝不动素材库：
    // 否则空列表会被当成「资产已删除」，把镜像条目整批清掉。
    if (!assetLibraryHydrated || !sharedAssetsReady) return;
    const cinematicAssets = project.assets ?? [];
    if (cinematicAssets.length === 0) return;
    const state = useAssetLibraryStore.getState();
    const libraryId = state.activeLibraryId || state.libraries[0]?.id;
    if (!libraryId) return;
    const categoryByKind = new Map(
      state.categories
        .filter((category) => category.libraryId === libraryId)
        .map((category) => [category.name, category.id]),
    );
    const mirrored: LibraryAsset[] = [];
    for (const asset of cinematicAssets) {
      const sources = [...(asset.referencePaths ?? [])];
      if (asset.kind === "character" && asset.voiceClip?.trim()) sources.push(asset.voiceClip);
      sources.filter(Boolean).forEach((source, index) => {
        const mediaType = asset.kind === "character" && index === sources.length - 1 && asset.voiceClip === source
          ? "audio" as const
          : "image" as const;
        const categoryName = asset.kind === "character" ? "角色" : asset.kind === "location" ? "场景" : "道具";
        mirrored.push({
          id: `cinematic-${asset.id}-${index}`,
          libraryId,
          categoryId: categoryByKind.get(categoryName) ?? null,
          // 多张参考图仍属于同一个电影资产，名称必须保持与工程资产一致；
          // 序号只体现在镜像 id / 图片顺序中，不能污染候选和最终提示词里的 @标签。
          name: asset.name || "未命名资产",
          mediaType,
          sourcePath: source,
          previewImageUrl: mediaType === "image" ? source : null,
          aspectRatio: "1:1",
          sourceFileName: null,
          tags: ["电影资产", categoryName],
          createdAt: 0,
          cinematicAssetId: asset.id,
          cinematicKind: asset.kind === "character" || asset.kind === "location" || asset.kind === "prop" ? asset.kind : undefined,
          cinematicDescription: asset.description,
          cinematicDescriptionZh: asset.descriptionZh,
          cinematicNotes: asset.notesZh || asset.notes,
        });
      });
    }
    const mirroredIds = new Set(mirrored.map((asset) => asset.id));
    const staleIds = state.assets
      .filter((asset) => asset.id.startsWith("cinematic-") && !mirroredIds.has(asset.id))
      .map((asset) => asset.id);
    if (staleIds.length) state.deleteAssets(staleIds);
    if (mirrored.length) state.upsertAssets(mirrored);
  }, [assetLibraryHydrated, project.assets, sharedAssetsReady]);

  const clearResume = () => {
    resumeJobRef.current = null;
    setResumeAvailable(false);
    setCompileReceivedChars(0);
  };
  const updateCompileProgress: SceneCompileProgressListener = (stage, receivedChars = 0) => {
    setSceneCompileProgress(stage);
    if (stage === "preparing") setCompileReceivedChars(0);
    if (receivedChars > 0) setCompileReceivedChars(receivedChars);
  };
  const registerResume = (
    error: unknown,
    kind: ResumeJobKind,
    apply: (value: unknown) => Promise<void> | void,
  ): boolean => {
    if (!(error instanceof ChatCompletionInterruptedError) || !error.resume) return false;
    const interrupted = error;
    resumeJobRef.current = {
      kind,
      run: async () => {
        try {
          await apply(await interrupted.resume!());
        } catch (nextError) {
          if (nextError instanceof ChatCompletionInterruptedError && nextError.resume) {
            registerResume(nextError, kind, apply);
          }
          throw nextError;
        }
      },
    };
    setResumeAvailable(true);
    setCompileReceivedChars(interrupted.partialText.length);
    setAiCompileError(t.aiResumeAvailable);
    setAiCompileErrorDetail(interrupted.message);
    return true;
  };
  const resumeInterrupted = async () => {
    const job = resumeJobRef.current;
    if (!job || resumeBusy) return;
    setResumeBusy(true);
    setResumeAvailable(false);
    resumeJobRef.current = null;
    if (job.kind === "scene") {
      setSceneCompileBusy(true);
      updateCompileProgress("resuming");
    } else {
      setFinalGenerateBusy(true);
      updateCompileProgress("resuming");
    }
    try {
      await job.run();
      resumeJobRef.current = null;
      setAiCompileError("");
      setAiCompileErrorDetail("");
    } catch (error) {
      if (error instanceof ChatCompletionInterruptedError && error.resume) {
        setNotice(t.aiResumeAvailable);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        const classified = classifyError(error);
        const friendly =
          classified.kind === "gateway-timeout"
            ? t.aiGatewayTimeout
            : classified.kind === "timeout" || classified.kind === "network"
              ? t.aiRequestInterrupted
              : message;
        setNotice(`${job.kind === "scene" ? t.aiCompileFailed : t.aiFinalFailed}${friendly}`);
        setAiCompileError(friendly);
        setAiCompileErrorDetail(message);
      }
    } finally {
      if (job.kind === "scene") setSceneCompileBusy(false);
      else setFinalGenerateBusy(false);
      updateCompileProgress("idle");
      if (!resumeJobRef.current) setCompileReceivedChars(0);
      setResumeBusy(false);
    }
  };

  /** 结构更新统一走 reducer（Compiler/Continuity 只读不可变快照） */
  const dispatch = (action: ProjectAction) => setProject((prev) => projectReducer(prev, action));

  useEffect(() => {
    let active = true;
    void (async () => {
      // 节点工程（场景/镜头等结构）与全局共享资产库并行加载：
      // 资产库独立于节点，加载时并入、保存时剥离，保证任何节点看到的都是同一份资产。
      const [stored, shared] = await Promise.all([
        loadProjectFromDatabaseById(projectId),
        loadSharedAssets(),
      ]);
      if (!active) return;
      const resolvedBase = stored ?? initialProjectRef.current;
      const resolved = quickSync ? applyQuickStudioSync(resolvedBase, quickSync) : resolvedBase;
      setProject({ ...resolved, assets: mergeAssetPool(shared, resolved.assets ?? []) });
      if (stored) {
        if (isDefaultCinematicProjectId(projectId)) localStorage.removeItem("cineprompt-project");
        const resolvedScene = quickSyncScene(resolved, quickSync?.sceneId);
        setSceneId(resolvedScene?.id ?? "");
        setShotId(resolvedScene?.shots[0]?.id ?? "");
        setPrompt(resolved.compiledPrompt ?? "");
      } else if (isTauri() && isDefaultCinematicProjectId(projectId)) {
        // 仅历史全局工程需要把本地草稿迁移进 SQLite；节点工程没有旧数据可迁。
        const migrated = await persistProjectToDatabaseById(projectId, initialProjectRef.current);
        if (migrated) localStorage.removeItem("cineprompt-project");
      }
      if (!active) return;
      setSharedAssetsReady(true);
      setProjectStorageReady(true);
    })();
    return () => {
      active = false;
    };
  }, [projectId]);

  /** Apply compact-node edits while the advanced workbench is already open. */
  useEffect(() => {
    if (!quickSync || !projectStorageReady) return;
    const signature = JSON.stringify(quickSync);
    if (signature === appliedQuickSyncSignature.current) return;
    appliedQuickSyncSignature.current = signature;
    setProject((current) => applyQuickStudioSync(current, quickSync));
    const nextScene = quickSyncScene(project, quickSync.sceneId);
    if (nextScene) setSceneId(nextScene.id);
  }, [project, projectStorageReady, quickSync]);
  useEffect(() => {
    let active = true;
    void (async () => {
      const stored = await loadHistoryFromDatabase();
      if (!active) return;
      if (stored) {
        setHistory(stored);
        localStorage.removeItem("cineprompt-prompt-history");
      } else if (isTauri()) {
        const legacy = loadHistory();
        if (await persistHistoryToDatabase(legacy)) localStorage.removeItem("cineprompt-prompt-history");
      }
    })();
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!projectStorageReady) return;
    // 资产库独立于节点工程：节点工程落库前剥离 assets（避免每个节点复制一份资产、撑爆存储），
    // 资产本身的持久化见下方 persistSharedAssets。
    const payload = isDefaultCinematicProjectId(projectId) ? project : { ...project, assets: [] };
    void persistProjectToDatabaseById(projectId, payload).then((saved) => {
      if (!saved) persistProjectById(projectId, payload);
    });
  }, [project, projectId, projectStorageReady]);
  // 资产库写回：任何节点里对资产的增删改都同步到全局资产库（唯一数据源）。
  useEffect(() => {
    if (!sharedAssetsReady) return;
    void persistSharedAssets(project.assets ?? []);
  }, [project.assets, sharedAssetsReady]);
  useEffect(() => {
    localStorage.setItem("cineprompt-locale", locale);
  }, [locale]);
  useEffect(() => {
    setProjectCodeDraft(project.projectCode ?? "");
  }, [project.projectCode]);
  /** LenTalk Chat 配置变更、或资产卡内切换了填写模型时，同步刷新工作室选中的模型（地址/Key 同源） */
  useEffect(() => {
    setAiSettings(loadAISettings());
  }, [customApis, cinematicAiSelection]);
  const selectChatModel = (value: string) => {
    const separator = value.indexOf(":");
    const providerId = separator >= 0 ? value.slice(0, separator) : "";
    const model = separator >= 0 ? value.slice(separator + 1) : "";
    const option = chatModels.find((item) => item.providerId === providerId && item.model === model);
    if (!option) return;
    setAiSettings(
      saveAISettings({
        ...resolveLenTalkChatModel(option.providerId, option.model),
        reasoningEffort: aiSettings.reasoningEffort,
      }),
    );
    setNotice(t.settingsSaved);
  };
  const selectReasoningEffort = (value: ReasoningEffort) => {
    setAiSettings(saveAISettings({ ...aiSettings, reasoningEffort: value }));
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
        quickSync: quickSyncFromProject(project, scene.id),
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [
    mediaReferences.referenceAudio,
    mediaReferences.referenceImages,
    onStateChange,
    project.description,
    project.styleBrief,
    project.styleBriefEn,
    project.styleBriefZh,
    scene,
    project.title,
    prompt,
  ]);
  useEffect(() => {
    if ((project.compiledPrompt ?? "") === prompt) return;
    dispatch({ type: "PATCH_PROJECT", patch: { compiledPrompt: prompt } });
  }, [project.compiledPrompt, prompt]);
  /** P1：当前打开的项目包目录（成功保存后记录，用于版本落盘） */
  const [projectPackageDir, setProjectPackageDir] = useState<string | null>(() =>
    sessionStorage.getItem("cineprompt-package-dir"),
  );
  /** P3/P1.2：保存工程到 .cineprompt 目录包（父目录选择 + slug.cineprompt） */
  const handleSaveProject = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const parent = (await open({ title: t.saveProject, directory: true })) as string | null;
      if (!parent) return;
      const slug =
        ((project as { name?: string }).name || "my-movie")
          .toLowerCase()
          .replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, "-")
          .replace(/^-+|-+$/g, "") || "movie";
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
      const dir = (await open({ title: t.openProject, directory: true })) as string | null;
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
  const updateShot = (updates: Partial<ShotV2>, targetId?: string) => {
    const target = targetId ?? shot.id;
    setProject((current) => ({
      ...current,
      scenes: current.scenes.map((item) =>
        item.id !== scene.id
          ? item
          : {
              ...item,
              shots: item.shots.map((candidate) =>
                candidate.id === target ? { ...candidate, ...updates } : candidate,
              ),
            },
      ),
    }));
  };
  /** 更新镜头时间（结构化 time）并联动下一个镜头：下一镜 start = 当前 end（自动吸附） */
  const updateShotRange = (id: string, start: number, end: number) => {
    const index = scene.shots.findIndex((item) => item.id === id);
    setProject((current) => ({
      ...current,
      scenes: current.scenes.map((item) => {
        if (item.id !== scene.id) return item;
        return {
          ...item,
          shots: item.shots.map((candidate, i) => {
            if (candidate.id === id) {
              const next = {
                ...candidate,
                time: { startSeconds: start, endSeconds: end },
                duration: `${start}-${end}${t.seconds}`,
              };
              return next;
            }
            if (i === index + 1) {
              const nextEnd =
                candidate.time?.endSeconds ??
                (() => {
                  const m = candidate.duration.match(/(\d+)\s*-\s*(\d+)/);
                  return m ? Number(m[2]) : end;
                })();
              return {
                ...candidate,
                time: { startSeconds: end, endSeconds: nextEnd },
                duration: `${end}-${nextEnd}${t.seconds}`,
              };
            }
            return candidate;
          }),
        };
      }),
    }));
  };
  const updateScene = (updates: Partial<SceneV2>) =>
    setProject((current) => ({
      ...current,
      scenes: current.scenes.map((item) => {
        if (item.id !== scene.id) return item;
        const requiresReplan = ["logline", "location", "time", "weather", "duration", "shootingMode", "staging", "directorIntentRefinement"].some((key) => key in updates);
        return {
          ...item,
          ...updates,
          ...(requiresReplan && item.performancePlan ? { performancePlan: { ...item.performancePlan, status: "stale" as const } } : {}),
          ...(requiresReplan ? { shots: item.shots.map((shot) => shot.planningMeta ? { ...shot, planningMeta: { ...shot.planningMeta, status: "stale" as const } } : shot) } : {}),
        };
      }),
    }));
  const clearGeneratedContent = () => {
    clearResume();
    setManualOverride(null);
    setPrompt("");
    setShotId("");
    setAiCompileError("");
    setAiCompileErrorDetail("");
    setAiErrorCopied(false);
    setProject((current) => ({
      ...current,
      compiledPrompt: undefined,
      audioPlan: undefined,
      scenes: current.scenes.map((item) =>
        item.id !== scene.id
          ? item
          : {
              ...item,
              mustHappen: undefined,
              forbid: undefined,
              dialogue: undefined,
              emotionArc: undefined,
              actingObjectives: undefined,
              storyNotes: undefined,
              directorIntentRefinement: undefined,
              directorIntentRefinementSource: undefined,
              performancePlan: undefined,
              directorLayers: undefined,
              lockedDirectorLayers: undefined,
              firstFrameLock: undefined,
              lightingDirection: undefined,
              shots: [],
            },
      ),
    }));
    setNotice(t.briefCleared);
  };
  const updateSceneName = (id: string, name: string) =>
    setProject((current) => ({
      ...current,
      scenes: current.scenes.map((item) => (item.id === id ? { ...item, name } : item)),
    }));
  const addBlankShot = () => {
    const last = scene.shots[scene.shots.length - 1];
    const end =
      last?.time?.endSeconds ??
      (() => {
        const m = last?.duration.match(/(\d+)\s*-\s*(\d+)/);
        return m ? Number(m[2]) : 0;
      })();
    const step = 8; // 每个镜头默认 8 秒
    const created: ShotV2 = {
      id: newId(),
      label: String(scene.shots.length + 1).padStart(2, "0"),
      duration: `${end}-${end + step}${t.seconds}`,
      time: { startSeconds: end, endSeconds: end + step },
      framing: "Medium close-up",
      lens: "50mm",
      optics: { lensCharacter: "47-standard", fieldOfViewDegrees: 47 },
      movement: "Static",
      action: t.defineAction,
      acting: t.naturalPerformance,
      direction: scene.shots[scene.shots.length - 1]?.direction ?? "left-to-right",
      cutStyle: scene.cutStyleDefault ?? "hard-cut",
    };
    setProject((current) => ({
      ...current,
      scenes: current.scenes.map((item) =>
        item.id === scene.id ? { ...item, shots: [...item.shots, created] } : item,
      ),
    }));
    setShotId(created.id);
  };

  const applySceneDraft = (draft: Awaited<ReturnType<typeof fillSceneDraft>>) => {
    const targetScene = draft.scene;
    const lockedKeys = (scene.lockedDirectorLayers ?? []).filter((key) => (scene.directorLayers?.[key] ?? "").trim());
    // The planner returns shots plus macro decisions. Director layers on the
    // draft are deterministic local output; only user-locked layers are kept.
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
      scenes: project.scenes.map((item) => (item.id === mergedScene.id ? mergedScene : item)),
    };
    setProject(nextProject);
    setManualOverride(null);
    setShotId(mergedScene.shots[0]?.id ?? "");
    setNotice(t.aiCompileDone);
  };

  /** AI 智能分镜：只生成导演文档与镜头分镜，不再做最终审核门禁。 */
  const aiCompileScene = async () => {
    if (sceneCompileBusy) return;
    if (!isRemoteConfigured()) {
      setNotice(t.aiNotConfigured);
      return;
    }
    clearResume();
    setSceneCompileBusy(true);
    updateCompileProgress("preparing");
    setAiCompileError("");
    try {
      const draft = await fillSceneDraft(project, scene, {
        seconds: t.seconds,
        locale,
        onProgress: updateCompileProgress,
      });
      applySceneDraft(draft);
    } catch (error) {
      if (
        registerResume(error, "scene", (value) => applySceneDraft(value as Awaited<ReturnType<typeof fillSceneDraft>>))
      ) {
        setNotice(`${t.aiCompileFailed}${t.aiResumeAvailable}`);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const classified = classifyError(error);
      const friendly =
        classified.kind === "gateway-timeout"
          ? t.aiGatewayTimeout
          : classified.kind === "timeout" || classified.kind === "network"
            ? t.aiRequestInterrupted
            : message;
      setNotice(`${t.aiCompileFailed}${friendly}`);
      setAiCompileError(friendly);
      setAiCompileErrorDetail(message);
    } finally {
      setSceneCompileBusy(false);
      updateCompileProgress("idle");
      setCompileReceivedChars(0);
    }
  };
  /** 仅补齐导演简报中的 AI 参考字段，不生成镜头或最终提示词。 */
  const aiOptimizeBrief = async () => {
    if (briefOptimizeBusy || sceneCompileBusy) return;
    if (!isRemoteConfigured()) {
      setNotice(t.aiNotConfigured);
      return;
    }
    setBriefOptimizeBusy(true);
    try {
      const optimized = await optimizeSceneBrief(project, scene, locale);
      const optimizedScene: SceneV2 = {
        ...scene,
        directorIntentRefinement: optimized || undefined,
        directorIntentRefinementSource: "ai",
      };
      const hasCharacters = collectSceneAssetIds(project, optimizedScene)
        .some((id) => project.assets?.some((asset) => asset.id === id && asset.kind === "character"));
      let performancePlan: Awaited<ReturnType<typeof planPerformance>> | undefined;
      let performancePlanError = "";
      if (hasCharacters) {
        try {
          performancePlan = await planPerformance(project, optimizedScene, locale);
        } catch (error) {
          performancePlanError = error instanceof Error ? error.message : String(error);
        }
      }
      setProject((current) => ({
        ...current,
        scenes: current.scenes.map((item) =>
          item.id === scene.id
            ? {
                ...item,
                directorIntentRefinement: optimized || undefined,
                directorIntentRefinementSource: "ai",
                performancePlan: performancePlan ?? (item.performancePlan ? { ...item.performancePlan, status: "stale" } : undefined),
                shots: item.shots.map((shot) => shot.planningMeta ? { ...shot, planningMeta: { ...shot.planningMeta, status: "stale" } } : shot),
              }
            : item,
        ),
      }));
      setNotice(performancePlanError
        ? `${t.aiBriefOptimized}${locale === "zh" ? " 表演计划未生成：" : " Performance plan was not generated: "}${performancePlanError}`
        : locale === "zh"
          ? "AI 已生成导演意图深化；场景有角色时，表演计划也已同步生成。"
          : "AI generated the director intent refinement and also generated the performance plan when scene characters are available.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const classified = classifyError(error);
      const friendly =
        classified.kind === "gateway-timeout"
          ? t.aiGatewayTimeout
          : classified.kind === "timeout" || classified.kind === "network"
            ? t.aiRequestInterrupted
            : message;
      setNotice(`${t.aiOptimizeBriefFailed}${friendly}`);
    } finally {
      setBriefOptimizeBusy(false);
    }
  };
  /** 仅优化导演简报中的风格描述，不改动预制风格选择或其他字段。 */
  const aiOptimizeStyle = async () => {
    if (styleOptimizeBusy || sceneCompileBusy || finalGenerateBusy || briefOptimizeBusy) return;
    if (!isRemoteConfigured()) {
      setNotice(t.aiNotConfigured);
      return;
    }
    setStyleOptimizeBusy(true);
    try {
      const optimized = await optimizeStyleDescription(project, locale);
      setProject((current) => ({
        ...current,
        styleBrief: optimized,
        ...(locale === "zh" ? { styleBriefZh: optimized } : { styleBriefEn: optimized }),
      }));
      setNotice(t.aiStyleOptimized);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const classified = classifyError(error);
      const friendly =
        classified.kind === "gateway-timeout"
          ? t.aiGatewayTimeout
          : classified.kind === "timeout" || classified.kind === "network"
            ? t.aiRequestInterrupted
            : message;
      setNotice(`${t.aiOptimizeStyleFailed}${friendly}`);
    } finally {
      setStyleOptimizeBusy(false);
    }
  };
  /** 最终生成：先本地生成 canonical source，再由 AI 组织最终提示词。 */
  const localCompileScene = async () => {
    if (sceneCompileBusy || finalGenerateBusy) return;
    if (!isRemoteConfigured()) {
      setNotice(t.aiNotConfigured);
      return;
    }
    clearResume();
    setFinalGenerateBusy(true);
    setAiCompileError("");
    const applyFinalPrompt = (value: unknown) => {
      if (typeof value !== "string") throw new Error("续写结果不是最终提示词文本");
      const text = value;
      setManualOverride(null);
      setPrompt(text);
      const record = addVersion({
        template,
        modelProfileId: modelProfileId || undefined,
        outputText: text,
        projectSnapshot: structuredClone(project),
        continuitySummary: { total: 0, errors: 0, warnings: 0 },
      });
      setHistory(record);
      void persistHistoryToDatabase(record);
      if (projectPackageDir) {
        const latest = record[0];
        if (latest) {
          void savePromptToDisk(projectPackageDir, latest.id, text);
          void recordVersionToSqlite(projectPackageDir, latest.id, template, JSON.stringify(latest.continuitySummary));
        }
      }
      setNotice(t.promptLocalCompiled);
    };
    try {
      const canonical = buildFinalGenerationSource(project, scene, locale);
      const text = await generateFinalPrompt(canonical, locale, updateCompileProgress);
      applyFinalPrompt(text);
    } catch (error) {
      if (registerResume(error, "final", applyFinalPrompt)) {
        setNotice(`${t.aiFinalFailed}${t.aiResumeAvailable}`);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const classified = classifyError(error);
      const friendly =
        classified.kind === "gateway-timeout"
          ? t.aiGatewayTimeout
          : classified.kind === "timeout" || classified.kind === "network"
            ? t.aiRequestInterrupted
            : message;
      setNotice(`${t.aiFinalFailed}${friendly}`);
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
    setProject((current) => ({ ...current, scenes: [...current.scenes, created] }));
    setSceneId(created.id);
    setShotId("");
  };
  const deleteScene = (id: string) => {
    if (project.scenes.length <= 1) {
      setNotice(t.keepOneScene);
      return;
    }
    const remaining = project.scenes.filter((item) => item.id !== id);
    setProject((current) => ({ ...current, scenes: remaining }));
    if (sceneId === id) {
      setSceneId(remaining[0].id);
      setShotId(remaining[0].shots[0]?.id ?? "");
    }
  };
  const copyPrompt = async () => {
    await navigator.clipboard.writeText(sanitizeDirectorText(prompt));
    setNotice(t.promptCopied);
  };
  const exportProject = (format: "txt" | "md" | "json") => {
    const scopeLabel =
      template === "pro-sequence"
        ? locale === "zh"
          ? "当前场景全部镜头"
          : "all scene shots"
        : template === "shot-cards"
          ? locale === "zh"
            ? "当前场景逐镜"
            : "one card per shot"
          : locale === "zh"
            ? "当前选中镜头"
            : "current shot";
    const header =
      format === "json"
        ? ""
        : `${locale === "zh" ? "# 提示词工作室导出" : "# Prompt Studio export"}\n模板/Template: ${template}\n语言/Language: ${locale}\n范围/Scope: ${scopeLabel}\n\n`;
    const exportText = sanitizeDirectorText(prompt);
    const content =
      format === "json"
        ? JSON.stringify(project, null, 2)
        : format === "md"
          ? `${header}# ${project.title}\n\n${project.description}\n\n## ${scene.name}\n\n\`\`\`text\n${exportText}\n\`\`\``
          : `${header}${exportText}`;
    download(
      `${project.title.replace(/ /g, "-").toLowerCase()}.${format}`,
      content,
      format === "json" ? "application/json" : "text/plain",
    );
    setNotice(`${format.toUpperCase()} ${locale === "zh" ? "导出已下载。" : "export downloaded."}`);
  };
  const importProject = (file?: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = migrateProject(JSON.parse(String(reader.result)));
        setProject(imported);
        setSceneId(imported.scenes[0]?.id || "");
        setShotId(imported.scenes[0]?.shots[0]?.id || "");
        setNotice(t.projectImported);
      } catch {
        setNotice(t.invalidProject);
      }
    };
    reader.readAsText(file);
  };
  return (
    <main className="app-shell">
      <section className="content">
        <div className="content-main">
          {/* ── 1. 导演简报卡（P0.4：合并风格配方 / 场景 / 音频计划）── */}
          <div id="cinematic-director-brief">
            <DirectorBriefCard
              project={project}
              scene={scene}
              t={t}
              locale={locale}
              canvasImageSources={canvasImageSources}
              compileBusy={sceneCompileBusy}
              finalGenerateBusy={finalGenerateBusy}
              compileProgress={sceneCompileProgress}
              compileReceivedChars={compileReceivedChars}
              briefOptimizeBusy={briefOptimizeBusy}
              styleOptimizeBusy={styleOptimizeBusy}
              aiCompileError={aiCompileError}
              aiCompileErrorDetail={aiCompileErrorDetail}
              aiErrorCopied={aiErrorCopied}
              resumeAvailable={resumeAvailable}
              resumeBusy={resumeBusy}
              onSelectScene={(id) => {
                clearResume();
                setSceneId(id);
                setShotId(project.scenes.find((item) => item.id === id)?.shots[0]?.id ?? "");
              }}
              onAddScene={addScene}
              onDeleteScene={deleteScene}
              onRenameScene={updateSceneName}
              onUpdateScene={updateScene}
              onUpdateStaging={(patch) => updateScene({ staging: { ...scene.staging, ...patch } })}
              onUpdateProject={(patch) => setProject((current) => ({ ...current, ...patch }))}
              onClearGeneratedContent={clearGeneratedContent}
              onAiCompile={() => void aiCompileScene()}
              onAiOptimizeBrief={() => void aiOptimizeBrief()}
              onAiOptimizeStyle={() => void aiOptimizeStyle()}
              onLocalCompile={localCompileScene}
              onCopyAiError={() => void copyAiError()}
              onResumeInterrupted={() => void resumeInterrupted()}
              chatModels={chatModels}
              selectedChatModel={selectedChatModel}
              onSelectChatModel={selectChatModel}
              selectedReasoningEffort={aiSettings.reasoningEffort}
              onSelectReasoningEffort={selectReasoningEffort}
              upstreamText={quickSyncUpstream}
            />
          </div>

          {scene.performancePlan && (
            <section className={`card performance-plan-card ${scene.performancePlan.status}`}>
              <details open>
                <summary className="performance-plan-head">
                  <span className="eyebrow">{locale === "zh" ? "表演输入摘要" : "Performance input summary"}</span>
                  <span className="performance-plan-status">
                    {scene.performancePlan.status === "stale"
                      ? (locale === "zh" ? "需要重新规划分镜" : "Storyboard needs replanning")
                      : (locale === "zh" ? "已供分镜规划使用" : "Ready for storyboard planning")}
                  </span>
                </summary>
                <div className="performance-plan-body">
                  {scene.performancePlan.emotionArc && (
                    <p><b>{locale === "zh" ? "情绪弧线" : "Emotion arc"}</b>{scene.performancePlan.emotionArc}</p>
                  )}
                  {scene.performancePlan.characterPlans.length > 0 && (
                    <div className="performance-plan-characters">
                      {scene.performancePlan.characterPlans.map((plan) => {
                        const name = project.assets?.find((asset) => asset.id === plan.characterId)?.name ?? plan.characterId;
                        return (
                          <p key={plan.characterId}>
                            <b>{name}</b>{plan.objective}
                            {plan.obstacle ? ` · ${locale === "zh" ? "阻碍：" : "Obstacle: "}${plan.obstacle}` : ""}
                            {plan.stakes ? ` · ${locale === "zh" ? "代价：" : "Stakes: "}${plan.stakes}` : ""}
                          </p>
                        );
                      })}
                    </div>
                  )}
                  {scene.performancePlan.beats.length > 0 && (
                    <ol className="performance-plan-beats">
                      {scene.performancePlan.beats.map((beat) => (
                        <li key={beat.id}>
                          {beat.action}
                          {beat.dialogue ? ` · ${beat.dialogue}` : ""}
                          {beat.beatChange ? ` · ${beat.beatChange}` : ""}
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              </details>
            </section>
          )}

          {/* ── 2. 分层导演文档卡（P0.6：本地规则预填各层，可展开编辑 + 锁定）── */}
          <DirectorLayersCard
            project={project}
            scene={scene}
            t={t}
            locale={locale}
            canvasImageSources={canvasImageSources}
            onUpdateScene={updateScene}
            setNotice={setNotice}
            focusLayerKey={null}
          />

          {/* ── 4. 镜头执行：时间线、动作、角色表演与节拍共用同一结构化数据 ── */}
          <section className="card shots-card">
            <div className="card-head">
              <div className="card-head-title">
                <span className="eyebrow">{locale === "zh" ? "镜头执行" : "Shot execution"}</span>
                <strong>
                  {scene.shots.length} {t.cuts}
                </strong>
              </div>
              <div className="shot-actions">
                <button className="outline-button" onClick={addBlankShot}>
                  <Plus size={14} /> {t.addShot}
                </button>
              </div>
            </div>
            <div className="shots-row">
              {scene.shots.map((item, index) => {
                const range = (() => {
                  if (item.time) return { start: item.time.startSeconds, end: item.time.endSeconds };
                  const m = item.duration.match(/(\d+)\s*-\s*(\d+)/);
                  return { start: m ? Number(m[1]) : 0, end: m ? Number(m[2]) : 8 };
                })();
                return (
                  <div
                    key={item.id}
                    className={`shot-card ${item.id === shot?.id ? "selected" : ""}`}
                    onClick={() => setShotId(item.id)}
                  >
                    <span className="shot-index">{String(index + 1).padStart(2, "0")}</span>
                    <span className="shot-info">
                      <b>{item.label}</b>
                      <small>{framingLabels[locale][item.framing] ?? item.framing}</small>
                    </span>
                    <span className="shot-time-row" onClick={(event) => event.stopPropagation()}>
                      <input
                        type="number"
                        min={0}
                        value={range.start}
                        title={t.startSec}
                        onChange={(event) => updateShotRange(item.id, Number(event.target.value) || 0, range.end)}
                      />
                      <em>–</em>
                      <input
                        type="number"
                        min={0}
                        value={range.end}
                        title={t.endSec}
                        onChange={(event) =>
                          updateShotRange(item.id, range.start, Number(event.target.value) || range.start)
                        }
                      />
                      <span className="select-wrap mini">
                        <select
                          value={item.cutStyle ?? "hard-cut"}
                          onChange={(event) =>
                            updateShot({ cutStyle: event.target.value as ShotV2["cutStyle"] }, item.id)
                          }
                          title={t.cutStyle}
                        >
                          <option value="hard-cut">{t.cutHard}</option>
                          <option value="overlap">{t.cutOverlap}</option>
                          <option value="match-cut">{t.cutMatch}</option>
                        </select>
                        <ChevronDown size={10} />
                      </span>
                    </span>
                    <span className="shot-camera">
                      {(() => {
                        const fov =
                          item.optics?.fieldOfViewDegrees ??
                          lensById(item.optics?.lensCharacter)?.fov ??
                          lensByFov(legacyFocalLengthToFov(item.lens))?.fov;
                        return fov == null ? "—" : `${fov}°`;
                      })()}
                      <small>{cameraLabels[locale][item.movement]}</small>
                    </span>
                    <span
                      className={`shot-cast ${(item.participants ?? []).length === 0 ? "empty" : ""}`}
                      title={t.participants}
                    >
                      {(item.participants ?? []).length === 0
                        ? t.noShotParticipants
                        : (item.participants ?? [])
                            .map(
                              (participant) =>
                                project.assets?.find((asset) => asset.id === participant.characterId)?.name ??
                                participant.characterId,
                            )
                            .join(" · ")}
                    </span>
                    <button
                      className="shot-delete"
                      title={t.deleteShot}
                      onClick={(event) => {
                        event.stopPropagation();
                        deleteShot(item.id);
                      }}
                    >
                      <X size={13} />
                    </button>
                  </div>
                );
              })}
            </div>
          </section>

          {/* ── 5. 镜头执行详情：编辑当前镜头的动作、角色表演、节拍与空间 ── */}
          <section id="cinematic-shot-inspector" className="card inspector-card">
            <div className="card-head inspector-toggle" onClick={() => setInspectorOpen((open) => !open)}>
              <div className="card-head-title">
                <span className="eyebrow">{locale === "zh" ? "镜头执行详情" : "Shot execution details"}</span>
                <h2>{shot?.label || t.noShot}</h2>
              </div>
              {inspectorOpen ? (
                <ChevronDown size={16} className="inspector-caret" />
              ) : (
                <ChevronDown size={16} className="inspector-caret collapsed" />
              )}
            </div>
            {inspectorOpen &&
              (shot ? (
                <div className="inspector-body">
                  <InspectorSection>
                    <div className="fields-grid three">
                      <LabeledSelect
                        label={t.cameraModel}
                        value={shot.camera ?? ""}
                        values={["", ...CAMERAS.map((camera) => camera.id)]}
                        displayValue={(value) =>
                          value
                            ? `${CAMERAS.find((camera) => camera.id === value)?.brand} ${CAMERAS.find((camera) => camera.id === value)?.model}`
                            : t.none
                        }
                        onChange={(value) => updateShot({ camera: value || undefined })}
                      />
                      <LabeledSelect
                        label={t.lensModel}
                        value={shot.lensModel ?? ""}
                        values={["", ...LENSES.map((lens) => lens.id)]}
                        displayValue={(value) =>
                          value
                            ? `${LENSES.find((lens) => lens.id === value)?.brand} ${LENSES.find((lens) => lens.id === value)?.model}`
                            : t.none
                        }
                        onChange={(value) => updateShot({ lensModel: value || undefined })}
                      />
                      <LabeledSelect
                        label={t.movement}
                        value={shot.movement}
                        groups={cameraMovementSelectGroups(shot.movement, locale)}
                        displayValue={(value) => cameraMovementLabel(value, locale)}
                        onChange={(value) => updateShot({ movement: value as CameraMovement })}
                      />
                    </div>
                    {shot.movement && <p className="hint-text">{cameraMovementHint(shot.movement, locale)}</p>}
                  </InspectorSection>
                  <OpticsCameraEditor shot={shot} framing={shot.framing} locale={locale} onUpdate={updateShot} />
                  <InspectorSection>
                    <label className="field-label">
                      {locale === "zh" ? "动作、表演与眼神执行" : "Action, performance & eye execution"}
                      <textarea
                        className="modal-textarea"
                        rows={5}
                        value={shot.performanceDescription ?? [shot.action, shot.acting, shot.eyeLife].filter(Boolean).join("\n")}
                        placeholder={locale === "zh" ? "用自然语言写清本镜动作、身体反应、呼吸、微表情、眼神与节拍变化…" : "Describe the shot's action, body response, breath, micro-expression, eye life, and beat change in natural language…"}
                        onChange={(event) => updateShot({ performanceDescription: event.target.value || undefined })}
                      />
                    </label>
                  </InspectorSection>
                  <InspectorSection title={t.performance}>
                    <div className="fields-grid two">
                      <div className="field-label">
                        {t.shotPerformanceLevel}
                        <div className="perf-options">
                          {[0, 1, 2, 3, 4, 5].map((n) => (
                            <button
                              key={n}
                              className={`perf-option ${shot.performanceLevel === n ? "active" : ""}`}
                              title={t[SHOT_PERF_TIPS[n]]}
                              onClick={() =>
                                updateShot({
                                  performanceLevel:
                                    shot.performanceLevel === n ? undefined : (n as 0 | 1 | 2 | 3 | 4 | 5),
                                })
                              }
                            >
                              {t[SHOT_PERF_KEYS[n]]}
                            </button>
                          ))}
                        </div>
                        <p className="hint-text">
                          {t.shotPerformanceLevel} · {t.performanceTargetHint}
                        </p>
                      </div>
                    </div>
                  </InspectorSection>
                  <InspectorSection>
                    <ParticipantsEditor project={project} scene={scene} shot={shot} t={t} onUpdate={updateShot} />
                  </InspectorSection>
                  <InspectorSection title={t.shotStates}>
                    <PropStateEditor project={project} shot={shot} t={t} onUpdate={updateShot} />
                  </InspectorSection>
                  <InspectorSection title={t.beats}>
                    <BeatEditor project={project} shot={shot} t={t} onUpdate={updateShot} />
                  </InspectorSection>
                  <InspectorSection title={t.shotLocks}>
                    <div className="fields-grid">
                      <div className="locked-character">
                        <span className="avatar large">
                          {(shot.participants ?? []).length > 0 ? (shot.participants ?? []).length : 1}
                        </span>
                        <div>
                          <b>
                            {(shot.participants ?? []).length} {t.character}
                          </b>
                          <small>{t.characterLocked}</small>
                        </div>
                      </div>
                      <LabeledSelect
                        label={t.screenDirection}
                        value={shot.direction}
                        values={["left-to-right", "right-to-left"]}
                        displayValue={(value) => (value === "left-to-right" ? t.directionLTR : t.directionRTL)}
                        onChange={(value) => updateShot({ direction: value as Shot["direction"] })}
                      />
                    </div>
                  </InspectorSection>
                </div>
              ) : (
                <div className="empty">{t.addShotHint}</div>
              ))}
          </section>
        </div>

        <aside className="content-side">
          <section className="side-project-toolbar" aria-label={locale === "zh" ? "工程设置" : "Project controls"}>
            {onClose && (
              <button className="outline-button studio-back-button" onClick={onClose}>
                <ArrowLeft size={15} /> {locale === "zh" ? "返回画布" : "Back to canvas"}
              </button>
            )}
            <label className="asset-project-code">
              {t.projectCode}
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
              <button className={locale === "zh" ? "active" : ""} onClick={() => setLocale("zh")}>
                中
              </button>
              <button className={locale === "en" ? "active" : ""} onClick={() => setLocale("en")}>
                EN
              </button>
            </div>
            <div className="side-project-actions">
              <button className="icon-button" title={t.openProject} onClick={handleOpenProject}>
                <FolderOpen size={16} />
              </button>
              <button className="icon-button" title={t.saveProject} onClick={handleSaveProject}>
                <Save size={16} />
              </button>
            </div>
            <input
              ref={fileInput}
              className="hidden"
              type="file"
              accept="application/json"
              onChange={(event) => importProject(event.target.files?.[0])}
            />
          </section>
          <button
            type="button"
            className="outline-button studio-library-button"
            onClick={() => window.dispatchEvent(new CustomEvent("lentalk:open-asset-library"))}
            title={locale === "zh" ? "打开画布右侧素材库" : "Open canvas asset library"}
          >
            <Library size={15} /> {locale === "zh" ? "打开画布素材库" : "Open canvas library"}
          </button>
          <section className="card prompt-card">
            <div className="card-head">
              <div className="card-head-title">
                <span className="eyebrow">{t.promptEditor}</span>
                <span className="provider-pill">
                  <span />{" "}
                  {aiSettings.provider !== "none" && aiSettings.apiKey && aiSettings.model
                    ? `${t.aiProviderRemote} · ${aiSettings.model}`
                    : t.localCompiler}
                </span>
              </div>
              <div className="dock-actions">
                <button className="icon-button" title={t.copyPrompt} onClick={copyPrompt}>
                  <Copy size={16} />
                </button>
                <div className="export-menu">
                  <button className="outline-button">
                    <Download size={15} /> {t.export} <ChevronDown size={14} />
                  </button>
                  <div className="export-options">
                    <button onClick={() => exportProject("txt")}>
                      <FileText size={14} /> TXT
                    </button>
                    <button onClick={() => exportProject("md")}>
                      <FileText size={14} /> Markdown
                    </button>
                    <button onClick={() => exportProject("json")}>
                      <FileJson size={14} /> JSON
                    </button>
                  </div>
                </div>
              </div>
            </div>
            <div className="compile-row">
              <span className="template-select model-select" title={t.targetModelHint}>
                <select
                  value={modelProfileId}
                  aria-label={t.targetModel}
                  onChange={(event) => {
                    const id = event.target.value;
                    setModelProfileId(id);
                    localStorage.setItem("cineprompt-model", id);
                  }}
                >
                  <option value="">{t.modelNone}</option>
                  {MODEL_PROFILES.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
                <ChevronDown size={14} />
              </span>
            </div>
            <div className="prompt-editor-toolbar">
              <div className="prompt-editor-status">
                <span className="output-language">
                  {locale === "zh" ? "输出语言：中文" : "Output language: English"}
                </span>
              </div>
              <button
                type="button"
                className="primary-button prompt-send-video-button"
                disabled={!onSendToVideo || !prompt.trim()}
                title={
                  !onSendToVideo
                    ? locale === "zh"
                      ? "请从画布中的提示词工作室节点打开"
                      : "Open this from a Prompt Studio node on the canvas"
                    : undefined
                }
                onClick={() => {
                  const nextPrompt = prompt.trim();
                  if (!nextPrompt || !onSendToVideo) return;
                  onSendToVideo({ prompt: nextPrompt, ...mediaReferences });
                  setNotice(t.sentToVideoNode);
                }}
              >
                <Send size={16} /> {t.sendToVideoNode}
              </button>
            </div>
            <div className="prompt-media-editor">
              <PromptMediaOverlay
                prompt={prompt}
                images={mediaReferences.referenceImages}
                audio={mediaReferences.referenceAudio}
                scrollTop={promptScrollTop}
                onPreview={(kind, source) => setMediaPreview({ kind, source })}
              />
              <textarea
                className="prompt-editor"
                value={prompt}
                onChange={(event) => {
                  setPrompt(event.target.value);
                  if (manualOverride === null && event.target.value.trim()) setManualOverride(event.target.value);
                }}
                onScroll={(event) => setPromptScrollTop(event.currentTarget.scrollTop)}
                spellCheck={false}
              />
            </div>
            {manualOverride !== null && (
              <div className="manual-override-bar">
                <span>
                  <PenLine size={13} /> {t.manualOverride}
                </span>
                <button
                  className="outline-button"
                  onClick={() => {
                    setManualOverride(null);
                    setPrompt(
                      compilePrompt(project, scene, shot, {
                        template,
                        profile: modelProfileById(modelProfileId),
                        locale,
                        director: true,
                      }).text,
                    );
                  }}
                >
                  {t.rebuild}
                </button>
                <button className="outline-button" onClick={() => setManualOverride(null)}>
                  {t.keepOverride}
                </button>
              </div>
            )}
          </section>
        </aside>
        {mediaPreview && (
          <div className="modal-overlay prompt-media-preview-overlay" onClick={() => setMediaPreview(null)}>
            <div className="prompt-media-preview" onClick={(event) => event.stopPropagation()}>
              <button className="modal-close" title={t.cancel} onClick={() => setMediaPreview(null)}>
                <X size={15} />
              </button>
              {mediaPreview.kind === "image" ? (
                <img src={resolveImageDisplayUrl(mediaPreview.source)} alt="" />
              ) : (
                <audio controls autoPlay src={mediaPreview.source} />
              )}
            </div>
          </div>
        )}
      </section>
      {notice && (
        <div className="toast">
          {notice}
          <button onClick={() => setNotice("")}>
            <X size={14} />
          </button>
        </div>
      )}
    </main>
  );
}

function PromptMediaOverlay({
  prompt,
  images,
  audio,
  scrollTop,
  onPreview,
}: {
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
      parts.push(
        <button
          key={`token-${token.start}`}
          type="button"
          className="prompt-media-image"
          title={token.token}
          onClick={() => onPreview("image", source)}
        >
          <img src={resolveImageDisplayUrl(source)} alt={token.token} />
        </button>,
      );
    } else {
      parts.push(
        <button
          key={`token-${token.start}`}
          type="button"
          className="prompt-media-audio"
          title={token.token}
          onClick={() => onPreview("audio", source)}
        >
          <AudioLines size={13} /> {token.token}
        </button>,
      );
    }
    cursor = token.end;
  }
  if (cursor < prompt.length) parts.push(<span key={`text-${cursor}`}>{prompt.slice(cursor)}</span>);
  return (
    <div className="prompt-media-overlay">
      <div className="prompt-media-overlay-content" style={{ transform: `translateY(-${scrollTop}px)` }}>
        {parts}
      </div>
    </div>
  );
}

function InspectorSection({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="inspector-section">
      {title ? <h3>{title}</h3> : null}
      {children}
    </section>
  );
}
function LabeledSelect({
  label,
  value,
  values,
  groups,
  onChange,
  displayValue = (item) => item,
}: {
  label: string;
  value: string;
  /** 平铺选项；与 groups 二选一 */
  values?: readonly string[];
  /** 分组选项（optgroup），用于选项较多的枚举（如镜头运动） */
  groups?: readonly { label: string; values: readonly string[] }[];
  onChange(value: string): void;
  displayValue?(item: string): string;
}) {
  return (
    <label className="field-label">
      {label}
      <span className="select-wrap">
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          {groups
            ? groups.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.values.map((item) => (
                    <option key={item} value={item}>
                      {displayValue(item)}
                    </option>
                  ))}
                </optgroup>
              ))
            : (values ?? []).map((item) => (
                <option key={item} value={item}>
                  {displayValue(item)}
                </option>
              ))}
        </select>
        <ChevronDown size={14} />
      </span>
    </label>
  );
}
