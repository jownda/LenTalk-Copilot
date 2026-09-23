// ---------------------------------------------------------------------------
// 扒剧本工作台：把短剧视频扒成标准拉片剧本。
//
// 布局对齐原软件的卡片式主界面；渠道不走独立设置页，而是直接读 LenTalk
// 「设置 → 密钥」里已配置的模型（见 usePajubenModelOptions）。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { CircleAlert, Clapperboard, FolderOpen, LoaderCircle, Play, ScanFace, Square, X } from "lucide-react";

import { UI_CONTENT_OVERLAY_INSET_CLASS } from "@/components/ui/motion";
import { UiButton, UiGhostIconButton } from "@/components/ui/primitives";
import {
  cancelPajuben,
  onPajubenFinish,
  onPajubenLog,
  onPajubenProgress,
  probePajubenEnvironment,
  resolvePajubenOutputDir,
  runPajuben,
  type PajubenEnvironment,
  type PajubenProgressPayload,
} from "@/commands/pajuben";
import { useSettingsStore } from "@/stores/settingsStore";

import {
  findPajubenAudioFallbackModel,
  groupPajubenModelOptions,
  isPajubenAudioInputModel,
  usePajubenModelOptions,
} from "./pajubenModels";
import { describeEpisodeGuess } from "./pajubenEpisode";

const LOG_LIMIT = 600;
const VIDEO_EXTENSIONS = ["mp4", "mkv", "mov", "avi", "flv", "ts", "m4v", "wmv"];

interface LogEntry {
  id: number;
  line: string;
  isError: boolean;
}

interface EpisodeState {
  percent: number;
  text: string;
  status: "running" | "done" | "failed";
  reason?: string;
}

interface Notice {
  kind: "error" | "success" | "info";
  text: string;
}

const CARD_CLASS = "rounded-xl border border-border-dark bg-surface-dark p-4";
const FIELD_CLASS =
  "h-9 w-full rounded-lg border border-border-dark bg-bg-dark px-3 text-sm text-text-dark outline-none transition-colors placeholder:text-text-muted focus:border-accent";
const LABEL_CLASS = "text-xs font-medium text-text-muted";

function toNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function PajubenStudio({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const modelOptions = usePajubenModelOptions();
  const modelGroups = useMemo(() => groupPajubenModelOptions(modelOptions), [modelOptions]);

  const [environment, setEnvironment] = useState<PajubenEnvironment | null>(null);
  const [probing, setProbing] = useState(true);

  const [target, setTarget] = useState("");
  const [batch, setBatch] = useState(false);
  const [episode, setEpisode] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [sendAudio, setSendAudio] = useState(true);
  const [animeMode, setAnimeMode] = useState(false);
  const [fromEpisode, setFromEpisode] = useState("");
  const [toEpisode, setToEpisode] = useState("");
  const [limit, setLimit] = useState("");
  const [skipAliasVerify, setSkipAliasVerify] = useState(false);

  // 模型选择固定下来：直接读写设置存储（zustand persist → SQLite），
  // 关掉页面再打开不用重新选。存储里的 key 失效（平台被删）时下拉自然是空，
  // 会被下面那个 effect 清掉，避免带着一个不存在的模型去跑。
  const modelKey = useSettingsStore((state) => state.pajubenModelKey) ?? "";
  const setModelKey = useSettingsStore((state) => state.setPajubenModelKey);
  const [fps, setFps] = useState("1");
  const [resolution, setResolution] = useState("low");
  const [maxFrames, setMaxFrames] = useState("120");
  const [workers, setWorkers] = useState("3");
  const [outputDir, setOutputDir] = useState("");
  const [roleSheet, setRoleSheet] = useState("");

  /** 人物识别（预留开关）：依赖人脸组件是否可用。 */
  const [faceEnabled, setFaceEnabled] = useState(true);

  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [overall, setOverall] = useState({ done: 0, total: 0 });
  const [episodes, setEpisodes] = useState<Record<number, EpisodeState>>({});
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);

  const logViewRef = useRef<HTMLDivElement>(null);
  const logSeqRef = useRef(0);
  const activeRunRef = useRef<string | null>(null);

  const selectedOption = useMemo(
    () => modelOptions.find((option) => option.key === modelKey) ?? null,
    [modelKey, modelOptions],
  );
  const audioFallbackOption = useMemo(
    () => findPajubenAudioFallbackModel(modelOptions, selectedOption),
    [modelOptions, selectedOption],
  );
  const selectedModelAcceptsAudio = Boolean(selectedOption && isPajubenAudioInputModel(selectedOption.model));
  const shouldSendAudio = sendAudio && (selectedModelAcceptsAudio || Boolean(audioFallbackOption));
  const shouldUseDualAudio = shouldSendAudio && Boolean(audioFallbackOption) && !selectedModelAcceptsAudio;
  const faceAvailable = environment?.faceReady ?? false;

  /**
   * 单集模式留空「集号」时的自动识别结果 —— 界面上直接显示出来，
   * 免得跑完才发现落盘的是「第16集」（曾因 uuid 文件名里抠出 16）。
   * 同时也把这个结果当作 --ep 传给引擎，保证「界面显示什么就写什么」。
   */
  const autoEpisode = useMemo(() => (!batch && target.trim() ? describeEpisodeGuess(target) : null), [batch, target]);

  /** 上次选的渠道被删掉后，存储里的 key 会悬空 —— 清掉，别留着拦住开始按钮。 */
  useEffect(() => {
    if (!modelKey) return;
    if (!modelOptions.some((option) => option.key === modelKey)) setModelKey(null);
  }, [modelKey, modelOptions, setModelKey]);

  useEffect(() => {
    let cancelled = false;
    setProbing(true);
    probePajubenEnvironment()
      .then((result) => {
        if (!cancelled) setEnvironment(result);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setEnvironment(null);
          setNotice({
            kind: "error",
            text: error instanceof Error ? error.message : String(error),
          });
        }
      })
      .finally(() => {
        if (!cancelled) setProbing(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 人物识别依赖缺失时不静默假装可用：关掉开关并说明原因。
  useEffect(() => {
    if (environment && !environment.faceReady) setFaceEnabled(false);
  }, [environment]);

  useEffect(() => {
    if (!target.trim()) {
      setOutputDir("");
      return;
    }
    let cancelled = false;
    resolvePajubenOutputDir(target)
      .then((dir) => {
        if (!cancelled) setOutputDir(dir);
      })
      .catch(() => {
        if (!cancelled) setOutputDir("");
      });
    return () => {
      cancelled = true;
    };
  }, [target]);

  const appendLog = useCallback((line: string, isError: boolean) => {
    setLogs((previous) => {
      const next = [...previous, { id: (logSeqRef.current += 1), line, isError }];
      return next.length > LOG_LIMIT ? next.slice(next.length - LOG_LIMIT) : next;
    });
  }, []);

  const handleProgress = useCallback((payload: PajubenProgressPayload) => {
    setEpisodes((previous) => {
      if (payload.kind === "overall") {
        setOverall({ done: payload.done ?? 0, total: payload.total ?? 0 });
        return previous;
      }
      const episodeNumber = payload.episode;
      if (episodeNumber === null || episodeNumber === undefined) return previous;
      const current = previous[episodeNumber];
      if (payload.kind === "episode") {
        return {
          ...previous,
          [episodeNumber]: {
            percent: payload.percent ?? current?.percent ?? 0,
            text: payload.text || current?.text || "",
            status: "running",
          },
        };
      }
      if (payload.kind === "episodeDone") {
        return {
          ...previous,
          [episodeNumber]: {
            percent: 100,
            text: current?.text ?? "",
            status: "done",
          },
        };
      }
      return {
        ...previous,
        [episodeNumber]: {
          percent: current?.percent ?? 0,
          text: current?.text ?? "",
          status: "failed",
          reason: payload.text,
        },
      };
    });
  }, []);

  const handleFinish = useCallback(() => {
    setRunning(false);
    setRunId(null);
    activeRunRef.current = null;
  }, []);

  useEffect(() => {
    const pending = Promise.all([
      onPajubenLog((payload) => {
        if (activeRunRef.current && payload.runId !== activeRunRef.current) return;
        appendLog(payload.line, payload.isError);
      }),
      onPajubenProgress((payload) => {
        if (activeRunRef.current && payload.runId !== activeRunRef.current) return;
        handleProgress(payload);
      }),
      onPajubenFinish((payload) => {
        if (activeRunRef.current && payload.runId !== activeRunRef.current) return;
        handleFinish();
        if (payload.success) {
          appendLog(payload.message, false);
          setNotice({ kind: "success", text: payload.message });
        } else if (payload.cancelled) {
          appendLog(payload.message, true);
          setNotice({ kind: "info", text: payload.message });
        } else {
          appendLog(payload.message, true);
          setNotice({ kind: "error", text: payload.message });
        }
      }),
    ]);
    return () => {
      void pending.then((unlisteners) => unlisteners.forEach((unlisten) => unlisten()));
    };
  }, [appendLog, handleFinish, handleProgress]);

  useEffect(() => {
    const element = logViewRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [logs]);

  const handlePickTarget = useCallback(async () => {
    try {
      const selected = await open(
        batch
          ? { directory: true, multiple: false, title: t("pajuben.pickFolder", "选择剧集文件夹") }
          : {
              multiple: false,
              title: t("pajuben.pickVideo", "选择视频文件"),
              filters: [{ name: t("pajuben.videoFiles", "视频"), extensions: VIDEO_EXTENSIONS }],
            },
      );
      if (typeof selected === "string") {
        setTarget(selected);
        setNotice(null);
      }
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }, [batch, t]);

  const handlePickOutputDir = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t("pajuben.pickOutputDir", "选择输出目录"),
      });
      if (typeof selected === "string") setOutputDir(selected);
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }, [t]);

  const handleRevealOutput = useCallback(async () => {
    if (!outputDir.trim()) return;
    try {
      await revealItemInDir(outputDir);
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }, [outputDir]);

  const handleStart = useCallback(async () => {
    if (running) return;
    if (!environment?.engineReady) {
      setNotice({ kind: "error", text: environment?.message || t("pajuben.engineMissing", "扒剧本引擎不可用") });
      return;
    }
    if (!target.trim()) {
      setNotice({ kind: "error", text: t("pajuben.needTarget", "请先选择视频文件或文件夹") });
      return;
    }
    if (!selectedOption) {
      setNotice({ kind: "error", text: t("pajuben.needModel", "请先选择模型") });
      return;
    }
    if (!selectedOption.apiKey.trim()) {
      setNotice({
        kind: "error",
        text: t("pajuben.needApiKey", "所选渠道没有可用密钥，请先在「设置 → 密钥」里填写"),
      });
      return;
    }

    setNotice(null);
    setLogs([]);
    setEpisodes({});
    setOverall({ done: 0, total: 0 });
    setRunning(true);

    try {
      const id = await runPajuben({
        target: target.trim(),
        batch,
        baseUrl: selectedOption.baseUrl,
        apiKey: selectedOption.apiKey,
        model: selectedOption.model,
        provider: "",
        proxy: "",
        episode: batch ? null : (toNumber(episode) ?? autoEpisode?.episode ?? null),
        fps: toNumber(fps),
        resolution,
        maxFrames: toNumber(maxFrames),
        workers: toNumber(workers),
        audio: shouldSendAudio,
        animeMode,
        faceEnabled: faceEnabled && faceAvailable,
        outputDir: outputDir.trim() || null,
        roleSheet: roleSheet.trim() || null,
        fromEpisode: batch ? toNumber(fromEpisode) : null,
        toEpisode: batch ? toNumber(toEpisode) : null,
        limit: batch ? toNumber(limit) : null,
        overwrite,
        skipAliasVerify,
        dualAudioModel: audioFallbackOption?.model ?? null,
        dualVisionModel: selectedOption.model,
        forceDualFallback: shouldUseDualAudio,
        disableDualFallback: !shouldSendAudio,
      });
      activeRunRef.current = id;
      setRunId(id);
    } catch (error) {
      setRunning(false);
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }, [
    animeMode,
    autoEpisode,
    batch,
    environment,
    episode,
    faceAvailable,
    faceEnabled,
    fps,
    fromEpisode,
    limit,
    maxFrames,
    outputDir,
    overwrite,
    resolution,
    roleSheet,
    running,
    audioFallbackOption,
    shouldSendAudio,
    shouldUseDualAudio,
    selectedOption,
    sendAudio,
    skipAliasVerify,
    t,
    target,
    toEpisode,
    workers,
  ]);

  const handleStop = useCallback(async () => {
    try {
      await cancelPajuben();
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  const overallPercent = overall.total > 0 ? Math.min(100, Math.round((overall.done / overall.total) * 100)) : 0;
  const episodeRows = Object.entries(episodes)
    .map(([key, value]) => ({ episode: Number(key), ...value }))
    .sort((a, b) => a.episode - b.episode);

  return (
    // 与设置/云盘弹窗同一套让位规则：不覆盖顶部标题栏（最小化/最大化/关闭那一行）。
    // 窗口是 decorations:false，自定义标题栏就是唯一的窗口控制，盖住等于关不掉。
    // onDoubleClick 阻断冒泡：项目管理页靠双击空白处新建项目，工作台内双击不该触发。
    <div
      data-pajuben-studio
      className={`fixed ${UI_CONTENT_OVERLAY_INSET_CLASS} z-[150] flex flex-col bg-bg-dark`}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <header className="flex shrink-0 items-center justify-between border-b border-border-dark px-6 py-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-medium text-text-dark">{t("pajuben.title", "PAJUBEN / 扒剧本")}</h1>
          <span className="text-[11px] font-medium uppercase tracking-wider text-accent">
            {t("pajuben.subtitle", "AI SCRIPT CONTROL")}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <EnvironmentBadge environment={environment} probing={probing} />
          <UiGhostIconButton onClick={onClose} title={t("common.close", "关闭")}>
            <X className="h-4 w-4" />
          </UiGhostIconButton>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 py-4">
        {notice && (
          <div
            className={`flex shrink-0 items-start gap-2 rounded-lg border px-3 py-2 text-sm ${
              notice.kind === "error"
                ? "border-red-500/40 bg-red-500/10 text-red-400"
                : notice.kind === "success"
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                  : "border-border-dark bg-surface-dark text-text-muted"
            }`}
          >
            {notice.kind === "error" ? <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" /> : null}
            {/* 引擎的失败信息是多行诊断（状态码/请求地址/响应开头），
                必须保留换行，否则挤成一行看不出层次。 */}
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{notice.text}</span>
          </div>
        )}

        <section className={CARD_CLASS}>
          <h2 className="mb-3 text-sm font-medium text-text-dark">{t("pajuben.cardSource", "视频来源")}</h2>
          <div className="flex items-center gap-2">
            <input
              className={FIELD_CLASS}
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              placeholder={t("pajuben.targetPlaceholder", "选择视频文件，或整部剧的文件夹")}
              spellCheck={false}
            />
            <UiButton type="button" variant="muted" className="shrink-0" onClick={() => void handlePickTarget()}>
              <FolderOpen className="mr-1.5 h-4 w-4" />
              {t("pajuben.pick", "选择…")}
            </UiButton>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-text-dark">
              <input type="radio" className="accent-accent" checked={batch} onChange={() => setBatch(true)} />
              {t("pajuben.modeBatch", "批量整部剧（选文件夹）")}
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-text-dark">
              <input type="radio" className="accent-accent" checked={!batch} onChange={() => setBatch(false)} />
              {t("pajuben.modeSingle", "单集扒取（选视频文件）")}
            </label>
            {!batch && (
              <>
                <span className={LABEL_CLASS}>{t("pajuben.episode", "集号")}</span>
                <input
                  className={`${FIELD_CLASS} w-16`}
                  value={episode}
                  onChange={(event) => setEpisode(event.target.value)}
                  placeholder="1"
                  inputMode="numeric"
                />
                <span className="text-[11px] text-text-muted">
                  {t("pajuben.episodeHint", "（留空＝按文件名自动识别，也可直接填）")}
                </span>
                {!episode.trim() && autoEpisode && (
                  <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[11px] text-accent">
                    {autoEpisode.recognized
                      ? t("pajuben.episodeAuto", "识别为第 {{n}} 集", { n: autoEpisode.episode })
                      : t("pajuben.episodeAutoFallback", "文件名没有集号，按第 {{n}} 集处理", {
                          n: autoEpisode.episode,
                        })}
                  </span>
                )}
              </>
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-text-dark">
              <input
                type="checkbox"
                className="accent-accent"
                checked={overwrite}
                onChange={(event) => setOverwrite(event.target.checked)}
              />
              {t("pajuben.overwrite", "覆盖已扒过的集")}
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-text-dark">
              <input
                type="checkbox"
                className="accent-accent"
                checked={!sendAudio}
                onChange={(event) => setSendAudio(!event.target.checked)}
              />
              {t("pajuben.noAudio", "不发送音频")}
            </label>
            <span className={`${LABEL_CLASS} ml-1`}>{t("pajuben.mediaType", "人物画面")}</span>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-text-dark">
              <input type="radio" className="accent-accent" checked={!animeMode} onChange={() => setAnimeMode(false)} />
              {t("pajuben.mediaReal", "真人")}
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-text-dark">
              <input type="radio" className="accent-accent" checked={animeMode} onChange={() => setAnimeMode(true)} />
              {t("pajuben.mediaAnime", "3D AI 动漫")}
            </label>
          </div>
        </section>

        <section className={CARD_CLASS}>
          <h2 className="mb-3 text-sm font-medium text-text-dark">{t("pajuben.cardModel", "模型与扒取范围")}</h2>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[260px] flex-1">
              <span className={LABEL_CLASS}>{t("pajuben.model", "模型")}</span>
              <select
                className={`${FIELD_CLASS} mt-1`}
                value={modelKey}
                onChange={(event) => setModelKey(event.target.value)}
              >
                <option value="">
                  {modelOptions.length > 0
                    ? t("pajuben.modelPlaceholder", "请选择模型（来自「设置 → 密钥」）")
                    : t("pajuben.modelEmpty", "尚未配置任何渠道，请先到「设置 → 密钥」添加")}
                </option>
                {modelGroups.map((group) => (
                  <optgroup key={group.providerName} label={group.providerName}>
                    {group.options.map((option) => (
                      <option key={option.key} value={option.key}>
                        {option.model}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
            <div className="w-20">
              <span className={LABEL_CLASS}>{t("pajuben.fps", "抽帧 fps")}</span>
              <input
                className={`${FIELD_CLASS} mt-1`}
                value={fps}
                onChange={(event) => setFps(event.target.value)}
                inputMode="decimal"
              />
            </div>
            <div className="w-28">
              <span className={LABEL_CLASS}>{t("pajuben.resolution", "画面清晰度")}</span>
              <select
                className={`${FIELD_CLASS} mt-1`}
                value={resolution}
                onChange={(event) => setResolution(event.target.value)}
              >
                <option value="low">{t("pajuben.resLow", "低（省 token）")}</option>
                <option value="medium">{t("pajuben.resMedium", "中")}</option>
                <option value="high">{t("pajuben.resHigh", "高")}</option>
              </select>
            </div>
            <div className="w-24">
              <span className={LABEL_CLASS}>{t("pajuben.maxFrames", "每集帧数上限")}</span>
              <input
                className={`${FIELD_CLASS} mt-1`}
                value={maxFrames}
                onChange={(event) => setMaxFrames(event.target.value)}
                inputMode="numeric"
              />
            </div>
            <div className="w-20">
              <span className={LABEL_CLASS}>{t("pajuben.workers", "并发")}</span>
              <input
                className={`${FIELD_CLASS} mt-1`}
                value={workers}
                onChange={(event) => setWorkers(event.target.value)}
                inputMode="numeric"
              />
            </div>
          </div>

          <div className="mt-4 border-t border-border-dark pt-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <label
                className={`flex items-center gap-2 text-sm ${faceAvailable ? "cursor-pointer text-text-dark" : "cursor-not-allowed text-text-muted"}`}
                title={
                  faceAvailable
                    ? t("pajuben.faceHint", "用本地人物库给每帧标注角色名，减少跨集改名")
                    : t("pajuben.faceUnavailable", "人物识别组件未安装，此开关不可用")
                }
              >
                <input
                  type="checkbox"
                  className="accent-accent"
                  disabled={!faceAvailable}
                  checked={faceEnabled && faceAvailable}
                  onChange={(event) => setFaceEnabled(event.target.checked)}
                />
                <ScanFace className="h-4 w-4" />
                {t("pajuben.face", "人物识别")}
              </label>
              {animeMode && (
                <span className="text-[11px] text-amber-400">
                  {t("pajuben.faceAnimeHint", "3D 动漫画面不启用人脸比对，改用造型与轨迹判断")}
                </span>
              )}
              <label className="flex cursor-pointer items-center gap-2 text-sm text-text-dark">
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={skipAliasVerify}
                  disabled={!batch}
                  onChange={(event) => setSkipAliasVerify(event.target.checked)}
                />
                {t("pajuben.skipVerify", "跳过片尾别名核验")}
              </label>
            </div>
          </div>

          {batch && (
            <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border-dark pt-3">
              <span className={LABEL_CLASS}>{t("pajuben.range", "扒取范围")}</span>
              <span className="text-sm text-text-dark">{t("pajuben.from", "从第")}</span>
              <input
                className={`${FIELD_CLASS} w-16`}
                value={fromEpisode}
                onChange={(event) => setFromEpisode(event.target.value)}
                inputMode="numeric"
              />
              <span className="text-sm text-text-dark">{t("pajuben.to", "集到第")}</span>
              <input
                className={`${FIELD_CLASS} w-16`}
                value={toEpisode}
                onChange={(event) => setToEpisode(event.target.value)}
                inputMode="numeric"
              />
              <span className="text-sm text-text-dark">{t("pajuben.limit", "集，最多")}</span>
              <input
                className={`${FIELD_CLASS} w-16`}
                value={limit}
                onChange={(event) => setLimit(event.target.value)}
                inputMode="numeric"
              />
              <span className="text-sm text-text-dark">{t("pajuben.limitSuffix", "集")}</span>
              <span className="text-[11px] text-text-muted">
                {t("pajuben.rangeHint", "（留空 = 全部；第一次建议先「最多 1 集」试跑）")}
              </span>
            </div>
          )}

          <div className="mt-4 flex items-end gap-2 border-t border-border-dark pt-3">
            <div className="min-w-[260px] flex-1">
              <span className={LABEL_CLASS}>{t("pajuben.outputDir", "输出目录")}</span>
              <input
                className={`${FIELD_CLASS} mt-1`}
                value={outputDir}
                onChange={(event) => setOutputDir(event.target.value)}
                placeholder={t("pajuben.outputDirPlaceholder", "默认与视频同目录下的「剧本」文件夹")}
                spellCheck={false}
              />
            </div>
            <UiButton type="button" variant="muted" className="shrink-0" onClick={() => void handlePickOutputDir()}>
              {t("pajuben.pick", "选择…")}
            </UiButton>
            <UiButton
              type="button"
              variant="muted"
              className="shrink-0"
              disabled={!outputDir.trim()}
              onClick={() => void handleRevealOutput()}
            >
              <FolderOpen className="mr-1.5 h-4 w-4" />
              {t("pajuben.openDir", "打开目录")}
            </UiButton>
          </div>

          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-text-muted">
              {t("pajuben.advanced", "高级：已知角色表")}
            </summary>
            <textarea
              className="mt-2 h-20 w-full rounded-lg border border-border-dark bg-bg-dark px-3 py-2 text-xs text-text-dark outline-none focus:border-accent"
              value={roleSheet}
              onChange={(event) => setRoleSheet(event.target.value)}
              placeholder={t("pajuben.roleSheetPlaceholder", "每行一个「角色名：身份」，可留空")}
              spellCheck={false}
            />
          </details>
        </section>

        <section className="flex shrink-0 flex-wrap items-center gap-3">
          <UiButton
            type="button"
            variant="primary"
            className="gap-2"
            disabled={running || probing || !environment?.engineReady}
            onClick={() => void handleStart()}
          >
            {running ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {running ? t("pajuben.running", "扒取中…") : t("pajuben.start", "开始扒剧本")}
          </UiButton>
          <UiButton
            type="button"
            variant="muted"
            className="gap-2"
            disabled={!running}
            onClick={() => void handleStop()}
          >
            <Square className="h-4 w-4" />
            {t("pajuben.stop", "停止")}
          </UiButton>
          <div className="min-w-[200px] flex-1">
            <div className="h-2 w-full overflow-hidden rounded-full bg-bg-dark">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-300"
                style={{ width: `${overallPercent}%` }}
              />
            </div>
          </div>
          <span className="w-24 shrink-0 text-right text-xs tabular-nums text-text-muted">
            {overall.done}/{overall.total} · {overallPercent}%
          </span>
          {runId ? null : null}
        </section>

        {episodeRows.length > 0 && (
          <section className={`${CARD_CLASS} max-h-40 shrink-0 overflow-y-auto`}>
            <div className="space-y-1.5">
              {episodeRows.map((row) => (
                <div key={row.episode} className="flex items-center gap-3 text-xs">
                  <span className="w-16 shrink-0 text-text-dark">
                    {t("pajuben.episodeShort", "第 {{n}} 集", { n: row.episode })}
                  </span>
                  <div className="h-1.5 w-40 shrink-0 overflow-hidden rounded-full bg-bg-dark">
                    <div
                      className={`h-full rounded-full transition-[width] duration-300 ${
                        row.status === "failed" ? "bg-red-500" : row.status === "done" ? "bg-emerald-500" : "bg-accent"
                      }`}
                      style={{ width: `${row.percent}%` }}
                    />
                  </div>
                  <span className="shrink-0 tabular-nums text-text-muted">{row.percent}%</span>
                  <span className="min-w-0 flex-1 truncate text-text-muted">
                    {row.status === "failed" ? `${t("pajuben.failed", "失败")}：${row.reason ?? ""}` : row.text}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="flex min-h-[160px] flex-1 flex-col overflow-hidden rounded-xl border border-border-dark">
          <div className="flex shrink-0 items-center justify-between border-b border-border-dark bg-surface-dark px-3 py-2">
            <span className="text-xs font-medium text-text-muted">{t("pajuben.console", "运行日志")}</span>
            <span className="text-[11px] text-text-muted">
              {t("pajuben.consoleHint", "共 {{n}} 行", { n: logs.length })}
            </span>
          </div>
          <div
            ref={logViewRef}
            className="min-h-0 flex-1 overflow-y-auto bg-black/40 px-3 py-2 font-mono text-[11px] leading-relaxed"
          >
            {logs.length === 0 ? (
              <p className="text-text-muted">{t("pajuben.consoleEmpty", "等待开始…引擎的输出会实时显示在这里")}</p>
            ) : (
              logs.map((entry) => (
                <div
                  key={entry.id}
                  className={`whitespace-pre-wrap break-all ${entry.isError ? "text-red-400" : "text-text-muted"}`}
                >
                  {entry.line}
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function EnvironmentBadge({ environment, probing }: { environment: PajubenEnvironment | null; probing: boolean }) {
  const { t } = useTranslation();

  if (probing) {
    return (
      <span className="rounded-full border border-border-dark px-2.5 py-1 text-[11px] text-text-muted">
        {t("pajuben.envProbing", "正在检测运行环境…")}
      </span>
    );
  }
  if (!environment?.engineReady) {
    return (
      <span className="rounded-full border border-red-500/40 bg-red-500/10 px-2.5 py-1 text-[11px] text-red-400">
        {environment?.message || t("pajuben.envUnavailable", "引擎不可用")}
      </span>
    );
  }
  const pythonLabel = environment.pythonBundled
    ? t("pajuben.envBundled", "随包 Python")
    : t("pajuben.envSystem", "系统 Python");
  return (
    <span
      className="flex items-center gap-1.5 rounded-full border border-border-dark px-2.5 py-1 text-[11px] text-text-muted"
      title={[environment.pythonPath, environment.ffmpegDir].filter(Boolean).join("\n")}
    >
      <Clapperboard className="h-3.5 w-3.5" />
      {pythonLabel} {environment.pythonVersion ?? ""}
      <span className={environment.faceReady ? "text-emerald-400" : "text-amber-400"}>
        · {environment.faceReady ? t("pajuben.envFaceOn", "人物识别可用") : t("pajuben.envFaceOff", "无人物识别")}
      </span>
    </span>
  );
}
