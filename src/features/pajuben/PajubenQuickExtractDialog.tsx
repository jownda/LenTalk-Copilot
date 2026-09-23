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
  findPajubenAudioFallbackModel,
  groupPajubenModelOptions,
  isPajubenAudioInputModel,
  usePajubenModelOptions,
} from "./pajubenModels";
import { guessEpisodeFromVideoName } from "./pajubenEpisode";
import { isLocalVideoPath } from "./pajubenLocalPath";

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
  const modelKey = useSettingsStore((state) => state.pajubenModelKey) ?? "";
  const setModelKey = useSettingsStore((state) => state.setPajubenModelKey);
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

  const selectedOption = useMemo(
    () => modelOptions.find((option) => option.key === modelKey) ?? null,
    [modelKey, modelOptions],
  );
  const audioFallbackOption = useMemo(
    () => findPajubenAudioFallbackModel(modelOptions, selectedOption),
    [modelOptions, selectedOption],
  );

  /** 上次选的渠道被删掉后存储里的 key 会悬空 —— 清掉，别让「生成」一直灰着不说原因。 */
  useEffect(() => {
    if (!modelKey) return;
    if (!modelOptions.some((option) => option.key === modelKey)) setModelKey(null);
  }, [modelKey, modelOptions, setModelKey]);

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
    if (!selectedOption) {
      setNotice(t("pajuben.needModel", "请先选择模型"));
      return;
    }
    if (!selectedOption.apiKey.trim()) {
      setNotice(t("pajuben.needApiKey", "所选渠道没有可用密钥，请先在「设置 → 密钥」里填写"));
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
        baseUrl: selectedOption.baseUrl,
        apiKey: selectedOption.apiKey,
        model: selectedOption.model,
        provider: "",
        proxy: "",
        episode,
        // 与「扒剧本」工作台的单集默认参数完全一致；这里只是把成功结果自动落为文本节点。
        fps: 1,
        resolution: "low",
        maxFrames: 120,
        workers: 3,
        audio: isPajubenAudioInputModel(selectedOption.model) || Boolean(audioFallbackOption),
        animeMode: false,
        faceEnabled: environment.faceReady,
        outputDir: null,
        roleSheet: null,
        dualAudioModel: audioFallbackOption?.model ?? null,
        dualVisionModel: selectedOption.model,
        fromEpisode: null,
        toEpisode: null,
        limit: null,
        overwrite: false,
        skipAliasVerify: false,
        forceDualFallback: Boolean(audioFallbackOption) && !isPajubenAudioInputModel(selectedOption.model),
        disableDualFallback: !isPajubenAudioInputModel(selectedOption.model) && !audioFallbackOption,
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
  }, [audioFallbackOption, canExtract, episode, running, selectedOption, t, videoPath]);

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
      widthClassName="w-[440px]"
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
            disabled={running || !canExtract || !selectedOption}
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
          <span className="mb-1.5 block text-xs font-medium text-text-muted">{t("pajuben.model", "模型")}</span>
          <select
            className={`nodrag nowheel ${FIELD_CLASS}`}
            value={modelKey}
            onChange={(event) => setModelKey(event.target.value)}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            disabled={running}
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
          <p className="mt-1.5 text-[11px] leading-relaxed text-text-muted">
            {t(
              "pajuben.quickAudioModelHint",
              "支持音频的模型直接听声；普通视觉模型优先使用同渠道音频模型，没有音频模型时改用视频字幕提取台词。",
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
