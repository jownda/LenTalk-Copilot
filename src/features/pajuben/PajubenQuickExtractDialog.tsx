// ---------------------------------------------------------------------------
// 画布「扒视频」：从视频节点的工具栏一键跑一次最精简的单集扒取，
// 扒完直接把剧本落到画布右边新生成的文本节点上，不用进全屏的扒剧本工作台。
//
// 复用与「扒剧本」工作台相同的引擎、参数与事件协议（pajuben://log|progress|finish），
// 区别仅是界面上只留模型选择，并把成功结果自动落到视频节点右侧的文本节点。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleAlert, LoaderCircle, Play, Square } from "lucide-react";

import { UiButton, UiModal } from "@/components/ui/primitives";
import { useCanvasStore } from "@/stores/canvasStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { CANVAS_NODE_TYPES, type CanvasNode } from "@/features/canvas/domain/canvasNodes";
import {
  cancelPajuben,
  onPajubenFinish,
  onPajubenLog,
  onPajubenProgress,
  probePajubenEnvironment,
  readPajubenScript,
  runPajuben,
  type PajubenRunRequest,
} from "@/commands/pajuben";

import {
  groupPajubenModelOptions,
  isPajubenAudioInputModel,
  pickPajubenAudioDefault,
  resolvePajubenVisionKey,
  usePajubenModelOptions,
} from "./pajubenModels";
import { guessEpisodeFromVideoName } from "./pajubenEpisode";
import { isLocalVideoPath } from "./pajubenLocalPath";
import {
  PAJUBEN_QUALITY_TIERS,
  resolvePajubenQualityPreset,
} from "./pajubenQuality";

/** 剧本正文节点的初始版面：文本节点默认 300×180，读整集剧本太挤。 */
const SCRIPT_NODE_WIDTH = 460;
const SCRIPT_NODE_HEIGHT = 420;

/** `pajuben_run` 只负责拉起子进程，正常几百毫秒内回包；超时说明 Rust 侧没响应。 */
const SPAWN_TIMEOUT_MS = 30_000;
/** 首次补装 FFmpeg 要下载/安装，不能沿用普通拉起的 30 秒兜底。 */
const FFMPEG_INSTALL_TIMEOUT_MS = 10 * 60_000;

/**
 * 某些 OpenAI 兼容中转会静默丢弃 `input_audio`。模型会返回一段“请上传音频”
 * 的说明文字，进程却正常退出；这不是可用剧本，不能当成功结果落到画布。
 */
function isAudioInputRejected(script: string): boolean {
  const normalized = script.replace(/\s+/g, "");
  return [/未收到.*音频/, /没有.*音频/, /未提供.*音频/, /请补充.*音频/, /无法.*(?:台词|听写|转写)/].some((pattern) =>
    pattern.test(normalized),
  );
}

const FIELD_CLASS =
  "h-9 w-full rounded-lg border border-border-dark bg-bg-dark px-3 text-sm text-text-dark outline-none transition-colors placeholder:text-text-muted focus:border-accent";

interface PajubenQuickExtractDialogProps {
  node: CanvasNode;
  onClose: () => void;
}

export function PajubenQuickExtractDialog({ node, onClose }: PajubenQuickExtractDialogProps) {
  const { t } = useTranslation();
  const modelOptions = usePajubenModelOptions();
  const modelGroups = useMemo(() => groupPajubenModelOptions(modelOptions), [modelOptions]);
  // 音频下拉把「能听声的模型」排到每个渠道的最前面，省得用户在几十个模型里翻。
  const audioModelGroups = useMemo(
    () => groupPajubenModelOptions(modelOptions, { audioFirst: true }),
    [modelOptions],
  );
  // 视觉模型：新字段优先，回落到拆分前的老字段（工作台仍写 pajubenModelKey）。
  const storedVisionKey = useSettingsStore((state) => state.pajubenVisionModelKey);
  const legacyVisionKey = useSettingsStore((state) => state.pajubenModelKey);
  const visionKey = resolvePajubenVisionKey(storedVisionKey, legacyVisionKey);
  const setVisionKey = useSettingsStore((state) => state.setPajubenVisionModelKey);
  const audioKey = useSettingsStore((state) => state.pajubenAudioModelKey) ?? "";
  const setAudioKey = useSettingsStore((state) => state.setPajubenAudioModelKey);
  const qualityTier = useSettingsStore((state) => state.pajubenQualityTier);
  const setQualityTier = useSettingsStore((state) => state.setPajubenQualityTier);
  // 脏值/缺省由 resolve 兜底；档位同时决定 fps / 清晰度 / 每集帧数上限。
  const qualityPreset = useMemo(() => resolvePajubenQualityPreset(qualityTier), [qualityTier]);
  const addNode = useCanvasStore((state) => state.addNode);
  const findNodePosition = useCanvasStore((state) => state.findNodePosition);

  const videoPath =
    typeof (node.data as { sourcePath?: unknown }).sourcePath === "string"
      ? ((node.data as { sourcePath: string }).sourcePath ?? "").trim()
      : "";
  const canExtract = isLocalVideoPath(videoPath);
  const episode = useMemo(() => guessEpisodeFromVideoName(videoPath), [videoPath]);
  const videoName = videoPath.split(/[\\/]/).pop() ?? videoPath;

  const [running, setRunning] = useState(false);
  const [percent, setPercent] = useState(0);
  const [statusText, setStatusText] = useState("");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  /** 已经发出 runPajuben、但还没收到 finish —— 用来把「秒失败」的 finish 认领回来。 */
  const armedRef = useRef(false);
  /** finish 早于 runPajuben 回包时先存这里，拿到 runId 立刻补处理。 */
  const pendingFinishRef = useRef<{ success: boolean; message: string } | null>(null);
  /**
   * 取出「先到一步」的 finish 并立即清空。
   *
   * 单独包一层是为了躲开 TS 的别名收窄：直接写
   * `const queued = pendingFinishRef.current; if (queued) { ... }` 时，
   * 上面那句 `pendingFinishRef.current = null` 会把整个后续流程里的
   * `pendingFinishRef.current` 收窄成 `null`，`queued` 被判成 `never`。
   */
  const takePendingFinish = useCallback((): { success: boolean; message: string } | null => {
    const pending = pendingFinishRef.current;
    pendingFinishRef.current = null;
    return pending;
  }, []);

  const visionOption = useMemo(
    () => modelOptions.find((option) => option.key === visionKey) ?? null,
    [modelOptions, visionKey],
  );
  /**
   * 音频模型：优先用用户选过的；没选过就给一个默认值（同渠道音频模型 →
   * 全局第一个音频模型）。默认值同样显示在下拉里，不偷偷替换用户的意图。
   */
  const audioOption = useMemo(() => {
    const stored = modelOptions.find((option) => option.key === audioKey) ?? null;
    return stored ?? pickPajubenAudioDefault(modelOptions, visionOption);
  }, [audioKey, modelOptions, visionOption]);
  const audioModelLooksUnsupported = Boolean(
    audioOption && !isPajubenAudioInputModel(audioOption.model),
  );

  /** 上次选的渠道被删掉后存储里的 key 会悬空 —— 清掉，别让「生成」一直灰着不说原因。 */
  useEffect(() => {
    if (!visionKey) return;
    if (!modelOptions.some((option) => option.key === visionKey)) setVisionKey(null);
  }, [modelOptions, setVisionKey, visionKey]);

  useEffect(() => {
    if (!audioKey) return;
    if (!modelOptions.some((option) => option.key === audioKey)) setAudioKey(null);
  }, [audioKey, modelOptions, setAudioKey]);

  /**
   * 扒完：把 `第N集.txt` 读回来，直接在视频节点右侧开一个文本节点。
   *
   * 刻意不走 finish 事件的 message —— 那里面只有落盘路径，整篇剧本几万字，
   * 塞进事件负载会把 IPC 撑得很大；正文走 `pajuben_read_script` 单独取。
   */
  const handleFinished = useCallback(
    async (success: boolean, message: string) => {
      runIdRef.current = null;
      armedRef.current = false;
      pendingFinishRef.current = null;
      setRunning(false);
      if (!success) {
        setNotice(message);
        return;
      }
      try {
        const script = await readPajubenScript({ target: videoPath, episode });
        if (isAudioInputRejected(script)) {
          setNotice(
            t(
              "pajuben.quickAudioUnsupported",
              "所选模型或渠道没有接收到视频音频，无法生成完整台词剧本。请改用支持音频输入/视频理解的模型后重试。",
            ),
          );
          return;
        }
        addNode(
          CANVAS_NODE_TYPES.textAnnotation,
          findNodePosition(node.id, SCRIPT_NODE_WIDTH, SCRIPT_NODE_HEIGHT),
          {
            displayName: t("pajuben.quickNodeName", "第 {{n}} 集 剧本", { n: episode }),
            content: script,
          },
          { width: SCRIPT_NODE_WIDTH, height: SCRIPT_NODE_HEIGHT },
        );
        onClose();
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error));
      }
    },
    [addNode, episode, findNodePosition, node.id, onClose, t, videoPath],
  );

  useEffect(() => {
    const pending = Promise.all([
      onPajubenLog((payload) => {
        if (!runIdRef.current || payload.runId !== runIdRef.current) return;
        setStatusText(payload.line);
      }),
      onPajubenProgress((payload) => {
        if (!runIdRef.current || payload.runId !== runIdRef.current) return;
        if (payload.kind === "overall") {
          const total = payload.total ?? 0;
          if (total > 0) setPercent(Math.min(100, Math.round(((payload.done ?? 0) / total) * 100)));
          return;
        }
        if (payload.kind === "episode" && typeof payload.percent === "number") {
          setPercent(payload.percent);
        }
        if (payload.text) setStatusText(payload.text);
      }),
      onPajubenFinish((payload) => {
        if (!armedRef.current) return;
        if (!runIdRef.current) {
          // runId 还没回包：引擎起手就失败（解释器/密钥/路径问题）时 finish 会先到，
          // 丢掉它就等于让弹窗永久卡在「扒取中…」。
          pendingFinishRef.current = { success: payload.success, message: payload.message };
          return;
        }
        if (payload.runId !== runIdRef.current) return;
        void handleFinished(payload.success, payload.message);
      }),
    ]);
    return () => {
      void pending.then((unlisteners) => unlisteners.forEach((unlisten) => unlisten()));
    };
  }, [handleFinished]);

  useEffect(() => {
    if (!running) {
      setElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [running]);

  const handleGenerate = useCallback(async () => {
    if (running) return;
    if (!canExtract) {
      setNotice(t("pajuben.quickNeedLocal", "这个视频不是本机文件（是网络地址），请先下载到本地再扒"));
      return;
    }
    // 两个模型各自校验、各自报错：只说「请选择模型」时，用户不知道该补哪一个。
    if (!visionOption) {
      setNotice(t("pajuben.quickNeedVisionModel", "请先选择视觉模型（负责识别场景、人物着装与动作）"));
      return;
    }
    if (!audioOption) {
      setNotice(
        t(
          "pajuben.quickNeedAudioModel",
          "请先选择音频模型（负责识别台词与音效）。当前渠道里没有能听声的模型，请到「设置 → 密钥」添加 Gemini、Qwen-Omni 等支持音频的模型",
        ),
      );
      return;
    }
    if (!visionOption.apiKey.trim()) {
      setNotice(
        t("pajuben.quickVisionNoKey", "视觉模型所在的渠道（{{provider}}）没有可用密钥，请先在「设置 → 密钥」里填写", {
          provider: visionOption.providerName,
        }),
      );
      return;
    }
    if (!audioOption.apiKey.trim()) {
      setNotice(
        t("pajuben.quickAudioNoKey", "音频模型所在的渠道（{{provider}}）没有可用密钥，请先在「设置 → 密钥」里填写", {
          provider: audioOption.providerName,
        }),
      );
      return;
    }
    setNotice(null);
    setPercent(0);
    setStatusText(t("pajuben.quickPreparing", "正在准备视频和模型请求…"));
    setElapsedSeconds(0);
    setRunning(true);
    // 先武装再发命令：引擎起手就失败时 finish 事件可能早于 runPajuben 回包
    armedRef.current = true;
    pendingFinishRef.current = null;
    try {
      setStatusText(t("pajuben.quickCheckingFfmpeg", "正在检查 FFmpeg…"));
      const environment = await probePajubenEnvironment();
      const needsFfmpegInstall = !environment.ffmpegDir;
      if (needsFfmpegInstall) {
        setStatusText(
          t(
            "pajuben.quickInstallingFfmpeg",
            "未检测到 FFmpeg，正在下载并自动安装；请保持网络连接，首次安装可能需要几分钟…",
          ),
        );
      } else {
        setStatusText(t("pajuben.quickPreparing", "正在准备视频和模型请求…"));
      }
      const spawnRequest: PajubenRunRequest = {
        target: videoPath,
        batch: false,
        // 顶层渠道 = 视觉模型渠道；音频模型自带自己的 base/key，可以分属另一家。
        baseUrl: visionOption.baseUrl,
        apiKey: visionOption.apiKey,
        model: visionOption.model,
        provider: "",
        proxy: "",
        episode,
        // 抽帧参数取自画质档位(快速/标准/精细)；这里只是把成功结果自动落为文本节点。
        fps: qualityPreset.fps,
        resolution: qualityPreset.resolution,
        maxFrames: qualityPreset.maxFrames,
        workers: 3,
        // 双模型流程里台词由音频模型单独听写，这一位只表示「这一集需要台词」。
        audio: true,
        animeMode: false,
        faceEnabled: environment.faceReady,
        outputDir: null,
        roleSheet: null,
        dualVisionModel: visionOption.model,
        dualAudioModel: audioOption.model,
        dualVisionBaseUrl: visionOption.baseUrl,
        dualAudioBaseUrl: audioOption.baseUrl,
        dualVisionApiKey: visionOption.apiKey,
        dualAudioApiKey: audioOption.apiKey,
        fromEpisode: null,
        toEpisode: null,
        limit: null,
        overwrite: false,
        skipAliasVerify: false,
        // 固定两步走：画面识别与音频识别各用各的模型，再合并成剧情。
        forceDualFallback: true,
        disableDualFallback: false,
      };
      // 超时兜底：Rust 侧一旦不回包（例如命令 panic），await 永不 settle，
      // 界面就会永久停在「扒取中…」且按钮一直禁用。
      const id = await Promise.race([
        runPajuben(spawnRequest),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(t("pajuben.quickSpawnTimeout", "启动扒取超时，请重试"))),
            needsFfmpegInstall ? FFMPEG_INSTALL_TIMEOUT_MS : SPAWN_TIMEOUT_MS,
          ),
        ),
      ]);
      runIdRef.current = id;
      // finish 早于回包时先补处理一次
      const queued = takePendingFinish();
      if (queued) {
        void handleFinished(queued.success, queued.message);
      }
    } catch (error) {
      armedRef.current = false;
      setRunning(false);
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }, [audioOption, canExtract, episode, qualityPreset, running, t, videoPath, visionOption]);

  const handleCancel = useCallback(async () => {
    try {
      await cancelPajuben();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }, []);

  // 扒取过程中不允许关窗：监听器一卸，扒完的剧本就没人接、节点也落不下来
  const handleRequestClose = useCallback(() => {
    if (running) return;
    onClose();
  }, [onClose, running]);

  return (
    <UiModal
      isOpen
      title={t("pajuben.quickTitle", "扒视频")}
      onClose={handleRequestClose}
      widthClassName="w-[520px]"
      footer={
        <>
          <UiButton type="button" variant="ghost" size="sm" disabled={running} onClick={handleRequestClose}>
            {t("common.close", "关闭")}
          </UiButton>
          {running && (
            <UiButton type="button" variant="muted" size="sm" onClick={() => void handleCancel()}>
              <Square className="mr-1.5 h-3.5 w-3.5" />
              {t("pajuben.stop", "停止")}
            </UiButton>
          )}
          <UiButton
            type="button"
            variant="primary"
            size="sm"
            disabled={running || !canExtract}
            onClick={() => void handleGenerate()}
          >
            {running ? (
              <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="mr-1.5 h-3.5 w-3.5" />
            )}
            {running ? t("pajuben.running", "扒取中…") : t("pajuben.quickGenerate", "生成")}
          </UiButton>
        </>
      }
    >
      <div className="space-y-3">
        <div className="rounded-lg border border-border-dark bg-bg-dark/60 px-3 py-2">
          <p className="truncate text-xs text-text-dark" title={videoPath}>
            {videoName || t("pajuben.quickNoSource", "这个视频节点还没有视频")}
          </p>
          <p className="mt-1 text-[11px] text-text-muted">
            {t("pajuben.quickEpisode", "按第 {{n}} 集出剧本", { n: episode })}
            {" · "}
            {t("pajuben.quickTargetHint", "剧本落在视频同目录的「剧本」文件夹，并同步成右侧文本节点")}
          </p>
        </div>

        <div>
          {/* 两个模型同一行：左边看画面，右边听声音，选完再交给引擎合并成剧情。 */}
          <div className="grid grid-cols-2 gap-2">
            <div className="min-w-0">
              <span className="mb-1.5 block text-xs font-medium text-text-muted">
                {t("pajuben.quickVisionModel", "视觉模型")}
              </span>
              <select
                className={`nodrag nowheel ${FIELD_CLASS}`}
                value={visionOption?.key ?? ""}
                onChange={(event) => setVisionKey(event.target.value || null)}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                disabled={running}
                title={t("pajuben.quickVisionModel", "视觉模型")}
              >
                <option value="">
                  {modelOptions.length > 0
                    ? t("pajuben.quickVisionPlaceholder", "请选择视觉模型")
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
              <p className="mt-1.5 text-[11px] leading-relaxed text-text-muted">
                {t("pajuben.quickVisionHint", "看画面：场景、人物着装、动作与神态")}
              </p>
            </div>

            <div className="min-w-0">
              <span className="mb-1.5 block text-xs font-medium text-text-muted">
                {t("pajuben.quickAudioModel", "音频模型")}
              </span>
              <select
                className={`nodrag nowheel ${FIELD_CLASS}`}
                value={audioOption?.key ?? ""}
                onChange={(event) => setAudioKey(event.target.value || null)}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                disabled={running}
                title={t("pajuben.quickAudioModel", "音频模型")}
              >
                <option value="">
                  {modelOptions.length > 0
                    ? t("pajuben.quickAudioPlaceholder", "请选择音频模型")
                    : t("pajuben.modelEmpty", "尚未配置任何渠道，请先到「设置 → 密钥」添加")}
                </option>
                {audioModelGroups.map((group) => (
                  <optgroup key={group.providerName} label={group.providerName}>
                    {group.options.map((option) => (
                      <option key={option.key} value={option.key}>
                        {isPajubenAudioInputModel(option.model)
                          ? option.model
                          : `${option.model} · ${t("pajuben.quickAudioUncertain", "可能不支持音频")}`}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <p className="mt-1.5 text-[11px] leading-relaxed text-text-muted">
                {t("pajuben.quickAudioHint", "听声音：台词、旁白与音效")}
              </p>
            </div>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-text-muted">
            {t(
              "pajuben.quickDualHint",
              "画面和声音分开识别，再合并成剧情：视觉模型看场景与动作，音频模型听台词与音效，两个模型可以来自不同渠道。",
            )}
          </p>
          {audioModelLooksUnsupported && (
            <p className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-400">
              <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {t(
                "pajuben.quickAudioSuspect",
                "这个模型看起来不能接收音频，运行后可能直接报错。建议改选 Gemini、Qwen-Omni、GPT-4o-Audio 等能听声的模型。",
              )}
            </p>
          )}
        </div>

        <div>
          <span className="mb-1.5 block text-xs font-medium text-text-muted">
            {t("pajuben.qualityLabel", "画质档位")}
          </span>
          <div className="grid grid-cols-3 gap-1.5">
            {PAJUBEN_QUALITY_TIERS.map((tier) => {
              const active = qualityPreset.tier === tier;
              return (
                <button
                  key={tier}
                  type="button"
                  className={`nodrag nowheel h-9 rounded-lg border text-xs transition-colors ${
                    active
                      ? "border-accent text-accent"
                      : "border-border-dark bg-bg-dark text-text-muted hover:text-text-dark"
                  }`}
                  disabled={running}
                  onClick={() => setQualityTier(tier)}
                  onPointerDown={(event) => event.stopPropagation()}
                  onMouseDown={(event) => event.stopPropagation()}
                >
                  {t(`pajuben.qualityTier.${tier}`)}
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-text-muted">
            {t(
              "pajuben.qualityHint",
              "档位决定抽帧密度与画面清晰度：标准档已明显提升情节完整度与场景细节，精细档更清晰但更耗时。",
            )}
          </p>
        </div>

        {running && (
          <div className="space-y-1.5">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-dark">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-300"
                style={{ width: `${percent}%` }}
              />
            </div>
            <p className="truncate text-[11px] text-text-muted" title={statusText}>
              {statusText || t("pajuben.consoleEmpty", "等待开始…引擎的输出会实时显示在这里")}
            </p>
            <p className="text-[11px] text-text-muted">
              {t("pajuben.quickElapsed", "已等待 {{seconds}} 秒；处理规则与「扒剧本」工作台一致", {
                seconds: elapsedSeconds,
              })}
            </p>
          </div>
        )}

        {!canExtract && videoPath && (
          <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-400">
            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {t("pajuben.quickNeedLocal", "这个视频不是本机文件（是网络地址），请先下载到本地再扒")}
          </p>
        )}

        {notice && (
          <p className="flex items-start gap-1.5 whitespace-pre-wrap break-words rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-400">
            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1">{notice}</span>
          </p>
        )}
      </div>
    </UiModal>
  );
}
