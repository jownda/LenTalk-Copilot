import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import { Handle, Position, useStore, useUpdateNodeInternals } from "@xyflow/react";
import {
  AudioLines,
  ChevronDown,
  Clapperboard,
  ImagePlus,
  LoaderCircle,
  Play,
  Plus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  CANVAS_NODE_TYPES,
  EXPORT_RESULT_NODE_MIN_HEIGHT,
  EXPORT_RESULT_NODE_MIN_WIDTH,
  type VideoGenNodeData,
} from "@/features/canvas/domain/canvasNodes";
import { resolveNodeDisplayName } from "@/features/canvas/domain/nodeDisplay";
import { resolveVideoNodeDuration, snapVideoDurationOption } from "@/features/canvas/domain/videoNodeDefaults";
import { canvasAiGateway, graphImageResolver } from "@/features/canvas/application/canvasServices";
import { resolveErrorContent, showErrorDialog } from "@/features/canvas/application/errorDialog";
import {
  buildGenerationErrorReport,
  createReferenceImagePlaceholders,
  CURRENT_RUNTIME_SESSION_ID,
  getRuntimeDiagnostics,
  type GenerationDebugContext,
} from "@/features/canvas/application/generationErrorReport";
import { mergeMediaReferenceSources } from "@/features/canvas/application/mediaReferenceSources";
import { filterExcludedReferences } from "@/features/canvas/application/referenceExclusions";
import { collectActiveGenerationNodeIds } from "@/features/canvas/application/videoGenActiveTasks";
import {
  closeVideoCancellationWindow,
  isVideoCancellationRequested,
  isVideoGenerationCanceledError,
  openVideoCancellationWindow,
} from "@/features/canvas/application/videoGenerationCancel";
import { recordGenerationOutcome } from "@/features/canvas/application/usageRecording";
import { resolveMinEdgeFittedSize } from "@/features/canvas/application/imageNodeSizing";
import {
  getDefaultVideoModelId,
  getModelProvider,
  getVideoModelProfile,
  resolveVideoModelProfile,
  JIMENG_CANVAS_CLI_PROVIDER_ID,
  JIMENG_CLI_PROVIDER_ID,
  RUNNINGHUB_CLI_PROVIDER_ID,
  listVideoModels,
} from "@/features/canvas/models";
import { resolveVideoReferenceSupport } from "@/features/canvas/models/videoReferenceSupport";
import { resolveModelPriceDisplay } from "@/features/canvas/pricing";
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from "@/features/canvas/ui/NodeHeader";
import { CanvasRefThumb } from "@/features/canvas/ui/CanvasRefThumb";
import { NodePriceBadge } from "@/features/canvas/ui/NodePriceBadge";
import { resolveRecommendedApiPriceBadge } from "./nodePriceBadge";
import { NodeResizeHandle } from "@/features/canvas/ui/NodeResizeHandle";
import { CanvasNodeImage } from "@/features/canvas/ui/CanvasNodeImage";
import { NodeReferencePicker } from "@/features/canvas/ui/NodeReferencePicker";
import { AudioViewerModal } from "@/features/canvas/ui/AudioViewerModal";
import { VideoViewerModal } from "@/features/canvas/ui/VideoViewerModal";
import {
  PICKER_FALLBACK_ANCHOR,
  resolvePickerAnchor,
  type PickerAnchor,
} from "@/features/canvas/ui/nodeReferencePickerLayout";
import { prepareNodeImageFromFile, resolveImageDisplayUrl } from "@/features/canvas/application/imageData";
import { useJimengCatalogRevision } from '@/features/canvas/models/jimengCatalog';
import {
  findReferenceTokens,
  insertReferenceToken,
  remapAudioReferenceTokens,
  remapImageReferenceTokens,
  remapVideoReferenceTokens,
  removeTextRange,
  resolveReferenceAwareDeleteRange,
  samePromptIgnoringReferenceTokens,
  syncImageReferenceTokens,
} from "@/features/canvas/application/referenceTokenEditing";
import { useDebouncedNodeTextCommit } from "@/features/canvas/application/useDebouncedNodeTextCommit";
import { applyLocalReferenceSection, type LocalReferenceAsset } from "@/features/canvas/domain/referenceSection";
import { anchorImageReferenceTags } from "@/features/canvas/domain/referenceTagAnchors";
import { readLiveInputText } from "@/features/canvas/application/liveInputText";
import {
  isVideoSubmitThrottled,
  markVideoSubmit,
  remainingVideoSubmitCooldown,
  VIDEO_SUBMIT_COOLDOWN_MS,
} from "@/features/canvas/application/videoSubmitThrottle";
import { useCanvasInputGraph } from "@/features/canvas/application/useCanvasInputGraph";
import { useCanvasStore } from "@/stores/canvasStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { registerNodeGenerationHandler } from "@/features/canvas/application/nodeGenerationRegistry";
import { getFloatingPanelPosition, type FloatingPanelPosition } from "@/features/canvas/ui/floatingPanelPosition";
import { isZzdhLipSyncModel } from "@/commands/zzdhApi";
import {
  isRunningHubDedicatedVideoEndpoint,
  isRunningHubBaseUrl,
  resolveRunningHubVideoEndpoint,
  resolveRunningHubVideoEndpointForInput,
  runningHubEndpointSupportsInput,
} from "@/commands/runningHubProtocol";

type VideoGenNodeProps = { id: string; data: VideoGenNodeData; selected?: boolean; width?: number; height?: number };

const VIDEO_GEN_NODE_MIN_WIDTH = 320;
const VIDEO_GEN_NODE_MIN_HEIGHT = 320;
const VIDEO_GEN_NODE_MAX_WIDTH = 720;
const VIDEO_GEN_NODE_MAX_HEIGHT = 560;
const VIDEO_GEN_NODE_DEFAULT_WIDTH = 420;
const VIDEO_GEN_NODE_DEFAULT_HEIGHT = 360;
const JIMENG_CLI_MAX_REFERENCE_IMAGES = 9;

interface ReferencePickerItem {
  kind: "image" | "audio" | "video";
  index: number;
  label: string;
  source: string;
}

/** 输入框下方展示的一条「已引用素材」缩略图。 */
interface ReferenceTile {
  key: string;
  kind: "image" | "audio" | "video";
  source: string;
  /** 与该素材在提示词里的引用序号一致(图N / 音频N)；视频只做展示与提交顺序 */
  label: string;
  displayUrl: string | null;
  /** false = 当前模型不会使用它(即梦忽略工作室音频 / 本地 CLI 不吃视频参考), 仅展示以便删除 */
  used: boolean;
}

type FrameSlot = "first" | "last";

type JimengCliStatus = {
  /** `retrying` = 提交阶段的网络失败正在自动重试(参考图上传超时等), 任务尚未创建。 */
  status: "queued" | "running" | "retrying" | "succeeded" | "failed";
  queueCount?: number | null;
  message?: string | null;
};

/** 缩略图轻量预览浮层状态: 图片地址 + 鼠标点击位置(用于定位) */
interface ReferencePreviewState {
  url: string;
  x: number;
  y: number;
}

const REFERENCE_PREVIEW_WIDTH = 180;
const REFERENCE_PREVIEW_ESTIMATED_HEIGHT = 160;
const REFERENCE_PREVIEW_MARGIN = 8;
const REFERENCE_PREVIEW_OFFSET = 12;
const REFERENCE_PREVIEW_MAX_SIZE = 200;
const REFERENCE_PREVIEW_MIN_SIZE = 80;

/** 按图片原始比例计算预览显示尺寸(等比缩放, 限制在最大尺寸内, 不小于最小尺寸) */
function resolvePreviewDisplaySize(naturalWidth: number, naturalHeight: number): { width: number; height: number } {
  const safeWidth = Math.max(1, naturalWidth);
  const safeHeight = Math.max(1, naturalHeight);
  const scale = Math.min(REFERENCE_PREVIEW_MAX_SIZE / safeWidth, REFERENCE_PREVIEW_MAX_SIZE / safeHeight, 1);
  let width = Math.max(REFERENCE_PREVIEW_MIN_SIZE, Math.round(safeWidth * scale));
  let height = Math.max(REFERENCE_PREVIEW_MIN_SIZE, Math.round(safeHeight * scale));
  if (width > REFERENCE_PREVIEW_MAX_SIZE) {
    height = Math.round((height * REFERENCE_PREVIEW_MAX_SIZE) / width);
    width = REFERENCE_PREVIEW_MAX_SIZE;
  }
  if (height > REFERENCE_PREVIEW_MAX_SIZE) {
    width = Math.round((width * REFERENCE_PREVIEW_MAX_SIZE) / height);
    height = REFERENCE_PREVIEW_MAX_SIZE;
  }
  return { width, height };
}

function resolvePreviewLeft(clientX: number, width: number): number {
  if (typeof window === "undefined") {
    return clientX + REFERENCE_PREVIEW_OFFSET;
  }
  let left = clientX + REFERENCE_PREVIEW_OFFSET;
  if (left + width > window.innerWidth - REFERENCE_PREVIEW_MARGIN) {
    left = clientX - width - REFERENCE_PREVIEW_OFFSET;
  }
  return Math.max(REFERENCE_PREVIEW_MARGIN, Math.min(left, window.innerWidth - width - REFERENCE_PREVIEW_MARGIN));
}

function resolvePreviewTop(clientY: number, height: number): number {
  if (typeof window === "undefined") {
    return clientY + REFERENCE_PREVIEW_OFFSET;
  }
  let top = clientY + REFERENCE_PREVIEW_OFFSET;
  if (top + height > window.innerHeight - REFERENCE_PREVIEW_MARGIN) {
    top = clientY - height - REFERENCE_PREVIEW_OFFSET;
  }
  return Math.max(REFERENCE_PREVIEW_MARGIN, Math.min(top, window.innerHeight - height - REFERENCE_PREVIEW_MARGIN));
}

interface PromptHighlightOptions {
  maxImageCount: number;
  maxAudioCount: number;
  /** 视频参考额度；不给就按 0 处理（标记仍会显示成普通文字）。 */
  maxVideoCount?: number;
  imageUrls: string[];
  audioSources: string[];
  videoSources?: string[];
  resolveAudioLabel: (source: string, index: number) => string;
  resolveVideoLabel?: (source: string, index: number) => string;
  onThumbnailClick?: (displayUrl: string, event: { clientX: number; clientY: number }) => void;
  onAudioChipClick?: (source: string, label: string) => void;
  onVideoChipClick?: (source: string, label: string) => void;
  audioChipHint?: string;
  videoChipHint?: string;
}

function renderPromptWithHighlights(prompt: string, options: PromptHighlightOptions): ReactNode {
  const {
    maxImageCount,
    maxAudioCount,
    maxVideoCount,
    imageUrls,
    audioSources,
    videoSources,
    resolveAudioLabel,
    resolveVideoLabel,
    onThumbnailClick,
    onAudioChipClick,
    onVideoChipClick,
    audioChipHint,
    videoChipHint,
  } = options;

  if (!prompt) {
    return " ";
  }

  const segments: ReactNode[] = [];
  let lastIndex = 0;
  const referenceTokens = findReferenceTokens(prompt, maxImageCount, maxAudioCount, maxVideoCount);
  for (const token of referenceTokens) {
    const matchStart = token.start;
    const matchText = token.token;
    const imageUrl = token.kind === "image" ? (imageUrls[token.value - 1] ?? null) : null;

    if (matchStart > lastIndex) {
      segments.push(<span key={`plain-${lastIndex}`}>{prompt.slice(lastIndex, matchStart)}</span>);
    }

    if (token.kind === "audio" || token.kind === "video") {
      // 音频 / 视频胶囊必须限制在原始 token 的行内占位宽度中，否则会盖住后续文字。
      const isVideo = token.kind === "video";
      const sources = isVideo ? (videoSources ?? []) : audioSources;
      const source = sources[token.value - 1];
      const label = source
        ? isVideo
          ? (resolveVideoLabel?.(source, token.value - 1) ?? `视频${token.value}`)
          : resolveAudioLabel(source, token.value - 1)
        : matchText;
      // 与图片小方块对齐：图片点了能放大，音频/视频胶囊以前是纯装饰，
      // 用户无法确认「@视频1 到底是哪条」。有来源时让它可点，点了直接预览。
      const onChipClick = isVideo ? onVideoChipClick : onAudioChipClick;
      const chipHint = isVideo ? videoChipHint : audioChipHint;
      const clickable = Boolean(source && onChipClick);
      segments.push(
        <span key={`ref-${matchStart}`} className="relative z-0 text-transparent">
          {matchText}
          <span
            title={clickable ? `${label} · ${chipHint ?? ""}`.trim() : label}
            className={`absolute left-0 top-1/2 inline-flex h-[18px] max-w-full -translate-y-1/2 items-center gap-0.5 overflow-hidden rounded-[5px] px-1 text-[10px] font-medium leading-none text-white ${
              isVideo ? "bg-sky-600" : "bg-accent"
            } ${clickable ? "pointer-events-auto cursor-zoom-in hover:opacity-85" : "pointer-events-none"}`}
            onClick={
              clickable
                ? (event) => {
                    event.stopPropagation();
                    onChipClick?.(source, label);
                  }
                : undefined
            }
            onMouseDown={clickable ? (event) => event.stopPropagation() : undefined}
          >
            {isVideo ? <Clapperboard className="h-3 w-3 shrink-0" /> : <AudioLines className="h-3 w-3 shrink-0" />}
            <span className="truncate">{label}</span>
          </span>
        </span>,
      );
    } else if (imageUrl) {
      // 保留 token 占位以保持光标位置一致(token 文字透明, 只显示缩略图)。
      // 缩略图固定 20×20 正方形居中, 尺寸稳定不影响行高排版。
      segments.push(
        <span key={`ref-${matchStart}`} className="relative z-0 text-transparent">
          {matchText}
          <span
            className="pointer-events-auto absolute left-1/2 top-1/2 inline-flex h-[20px] w-[20px] -translate-x-1/2 -translate-y-1/2 cursor-zoom-in items-center justify-center overflow-hidden rounded-[5px] bg-accent/70"
            onClick={(event) => {
              event.stopPropagation();
              onThumbnailClick?.(imageUrl, event);
            }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <CanvasRefThumb source={imageUrl} alt={matchText} className="h-full w-full shrink-0 object-cover" />
          </span>
        </span>,
      );
    } else {
      segments.push(
        <span key={`ref-${matchStart}`} className="relative z-0 text-transparent">
          {matchText}
        </span>,
      );
    }

    lastIndex = matchStart + matchText.length;
  }

  if (lastIndex < prompt.length) {
    segments.push(<span key={`plain-${lastIndex}`}>{prompt.slice(lastIndex)}</span>);
  }

  return segments;
}

export const VideoGenNode = memo(({ id, data, selected, width, height }: VideoGenNodeProps) => {
  const { t, i18n } = useTranslation();
  const updateNodeInternals = useUpdateNodeInternals();
  const { nodes, edges } = useCanvasInputGraph();
  const inputImages = useMemo(() => graphImageResolver.collectInputImages(id, nodes, edges), [edges, id, nodes]);
  const inputAudio = useMemo(() => graphImageResolver.collectInputAudio(id, nodes, edges), [edges, id, nodes]);
  const inputVideos = useMemo(() => graphImageResolver.collectInputVideos(id, nodes, edges), [edges, id, nodes]);
  const inputText = useMemo(() => graphImageResolver.collectInputText(id, nodes, edges), [edges, id, nodes]);
  const audioNodes = useMemo(() => nodes.filter((node) => node.type === CANVAS_NODE_TYPES.audio), [nodes]);
  const addNode = useCanvasStore((state) => state.addNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const processingRevision = useCanvasStore((state) => state.processingRevision);
  const updateNodeSize = useCanvasStore((state) => state.updateNodeSize);
  const findNodePosition = useCanvasStore((state) => state.findNodePosition);
  const openImageViewer = useCanvasStore((state) => state.openImageViewer);
  /** 引用素材条上的音频试听弹窗（音频没有原生缩略图，只能靠一个播放入口确认是哪条）。 */
  const [audioPreview, setAudioPreview] = useState<{ url: string; title: string } | null>(null);
  /** 引用素材条上的视频全屏预览（点击 tile 播放，确认「这条视频就是我要参考的那条」）。 */
  const [videoPreviewUrl, setVideoPreviewUrl] = useState<string | null>(null);
  const apiKeys = useSettingsStore((state) => state.apiKeys);
  const customApis = useSettingsStore((state) => state.customApis);
  const customModelPrices = useSettingsStore((state) => state.customModelPrices);
  const setCustomModelPrice = useSettingsStore((state) => state.setCustomModelPrice);
  const showNodePrice = useSettingsStore((state) => state.showNodePrice);
  const priceDisplayCurrencyMode = useSettingsStore((state) => state.priceDisplayCurrencyMode);
  const usdToCnyRate = useSettingsStore((state) => state.usdToCnyRate);
  const preferDiscountedPrice = useSettingsStore((state) => state.preferDiscountedPrice);
  const grsaiCreditTierId = useSettingsStore((state) => state.grsaiCreditTierId);
  const setLastVideoDuration = useSettingsStore((state) => state.setLastVideoDuration);
  const setLastVideoModelId = useSettingsStore((state) => state.setLastVideoModelId);
  const setLastVideoAspectRatio = useSettingsStore((state) => state.setLastVideoAspectRatio);
  const setLastVideoResolution = useSettingsStore((state) => state.setLastVideoResolution);
  const [isGenerating, setIsGenerating] = useState(() => collectActiveGenerationNodeIds(data).length > 0);
  /** 在跑的下游任务 id 列表（旧工程里可能是单个 activeGenerationNodeId）。 */
  const activeGenerationNodeIds = collectActiveGenerationNodeIds(data);
  const activeGenerationKey = activeGenerationNodeIds.join("\u0000");
  /** 已提交、还没跑完的任务数——允许连点后会 > 1。 */
  const activeTaskCount = activeGenerationNodeIds.length;
  /**
   * 有任务在跑时，按钮文案改成「再生成一个」。
   *
   * 注意这只影响**文案**，不影响能否点击：产品口径是「点一次生成一次，
   * 过几秒可以再点一次生成新的」。挡住重复提交靠的是防误点时间窗
   * （`videoSubmitThrottle`），不是任务锁。
   */
  const isGenerationInFlight = activeTaskCount > 0;
  /**
   * 本节点开出去的「可取消窗口」(下游结果节点 id)。
   *
   * 窗口是模块级内存态, 不该被节点卸载悄悄漏掉 —— 卸载时统一收干净, 否则一个早就
   * 没有入口的窗口会一直挂在表里。
   */
  const cancelWindowNodeIdsRef = useRef<Set<string>>(new Set());
  useEffect(
    () => () => {
      for (const outputId of cancelWindowNodeIdsRef.current) closeVideoCancellationWindow(outputId);
      cancelWindowNodeIdsRef.current.clear();
    },
    [],
  );
  const [jimengCliStatus, setJimengCliStatus] = useState<JimengCliStatus | null>(null);
  // 初始值从模块级记录读：节点滚出视口再滚回来会重挂载，组件内 state 会清零，
  // 那样按钮立刻变回「生成视频」，手一抖就是重复提交。
  const [cooldownRemainingMs, setCooldownRemainingMs] = useState(() =>
    remainingVideoSubmitCooldown(id),
  );
  const isCoolingDown = cooldownRemainingMs > 0;
  const cooldownSeconds = Math.max(1, Math.ceil(cooldownRemainingMs / 1000));

  useEffect(() => {
    if (!isCoolingDown) return;
    const timer = window.setInterval(() => {
      setCooldownRemainingMs(remainingVideoSubmitCooldown(id));
    }, 100);
    return () => window.clearInterval(timer);
  }, [id, isCoolingDown]);

  const beginCooldown = useCallback(() => {
    markVideoSubmit(id);
    setCooldownRemainingMs(VIDEO_SUBMIT_COOLDOWN_MS);
  }, [id]);

  // 下游媒体节点才持有真正的平台任务状态，所以逐个核对：已经进入终态（或被删掉）的
  // 从列表里摘掉，只要还剩一个就让源节点维持「生成中」。
  //
  // 这个列表现在**同时是提交互斥锁**（见 `handleGenerate` 顶部与按钮的 disabled）：
  // 视频一单几十秒到几分钟，2s 冷却挡不住「滚动画布 → 节点重挂载 → 冷却丢失 → 再点一次」，
  // 那种情况会实打实地跑两单、扣两份钱。
  useEffect(() => {
    void activeGenerationKey;
    // 下游任务状态更新走 processingRevision，不一定刷新 inputGraphRevision；
    // 直接读 store 确保慢平台完成/失败后能及时把源节点摘出「生成中」。
    void processingRevision;
    const state = useCanvasStore.getState();
    const tracked = collectActiveGenerationNodeIds(state.nodes.find((node) => node.id === id)?.data);
    const stillRunning = tracked.filter((outputId) => {
      const outputNode = state.nodes.find((node) => node.id === outputId);
      return outputNode ? (outputNode.data as { isGenerating?: unknown }).isGenerating === true : false;
    });
    if (stillRunning.length !== tracked.length) {
      updateNodeData(id, { activeGenerationNodeIds: stillRunning, activeGenerationNodeId: null });
    }
    // 下游节点被删掉时顺手收掉它的取消窗口, 免得在模块表里长期占着一个没人能点的入口。
    for (const outputId of tracked) {
      if (state.nodes.some((node) => node.id === outputId)) continue;
      cancelWindowNodeIdsRef.current.delete(outputId);
      closeVideoCancellationWindow(outputId);
    }
    setIsGenerating(stillRunning.length > 0);
    // 下游全部结束（含被用户取消）时收掉 CLI 的「排队中」—— 取消走的是后端检查点，
    // 不会有任何 CLI 事件回来，不清的话源节点会永远挂着一个排队标记。
    if (stillRunning.length === 0) setJimengCliStatus(null);
  }, [activeGenerationKey, id, nodes, processingRevision, updateNodeData]);
  const [error, setError] = useState<string | null>(null);
  const [showImagePicker, setShowImagePicker] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showDurationSlider, setShowDurationSlider] = useState(false);
  const [pickerCursor, setPickerCursor] = useState<number | null>(null);
  const [pickerActiveIndex, setPickerActiveIndex] = useState(0);
  const [pickerAnchor, setPickerAnchor] = useState<PickerAnchor>(PICKER_FALLBACK_ANCHOR);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const promptHighlightRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // 画布缩放：@ 候选面板的锚点换算与视觉间距都要靠它折算。
  // 用 useStore 选择器而不是 useViewport —— 后者在平移画布时也会触发重渲染，拖画布会变卡。
  const zoom = useStore((state) => state.transform[2]);
  const modelTriggerRef = useRef<HTMLDivElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const [modelPickerPosition, setModelPickerPosition] = useState<FloatingPanelPosition | null>(null);
  const firstFrameInputRef = useRef<HTMLInputElement>(null);
  const lastFrameInputRef = useRef<HTMLInputElement>(null);
  const [promptDraft, setPromptDraft] = useState(() => data.prompt ?? "");
  const promptDraftRef = useRef(promptDraft);
  /** 缩略图轻量预览: 从鼠标点击位置左侧滑出, 点击空白处关闭 */
  const [previewState, setPreviewState] = useState<ReferencePreviewState | null>(null);
  /** 预览图按图片比例自适应后的显示尺寸(加载完成前为 null) */
  const [previewSize, setPreviewSize] = useState<{ width: number; height: number } | null>(null);
  const {
    cancelCommit: cancelPromptCommit,
    flushCommit: flushPromptCommit,
    scheduleCommit: schedulePromptCommit,
  } = useDebouncedNodeTextCommit({
    nodeId: id,
    field: "prompt",
    valueRef: promptDraftRef,
    updateNodeData,
  });

  // 模型目录同步完成后重渲染（并让下面的 useMemo 重算），新模型才会出现在下拉里。
  const catalogRevision = useJimengCatalogRevision();
  const imageMode = data.imageMode === "first-last" ? "first-last" : "reference";
  const models = useMemo(
    () =>
      listVideoModels().filter((model) => {
        if (isZzdhLipSyncModel(model.id)) return false;
        const endpoint = model.id.split("/").slice(1).join("/");
        const normalized = model.id.toLowerCase();
        const providerId = model.providerId.replace(/^custom:/, "");
        const api = customApis.find((item) => item.id === providerId);
        if (isRunningHubBaseUrl(api?.baseUrl) && endpoint) {
          const spec = resolveRunningHubVideoEndpoint(endpoint);
          // 普通节点只显示有文生能力的 canonical 家族。图生/多模态由实际输入路由。
          if (spec && !runningHubEndpointSupportsInput(spec, "text")) return false;
          if (imageMode === "first-last" && spec && !resolveRunningHubVideoEndpointForInput(endpoint, "first-last")) {
            return false;
          }
        }
        return (
          !isRunningHubDedicatedVideoEndpoint(endpoint) &&
          !normalized.includes("motion-control") &&
          !normalized.includes("lip-sync") &&
          !normalized.includes("对口型")
        );
      }),
    [customApis, imageMode, catalogRevision],
  );
  const selectedModel =
    models.find((model) => model.id === data.model) ??
    models.find((model) => model.id === getDefaultVideoModelId()) ??
    models[0];
  const isJimengCli = selectedModel?.providerId === JIMENG_CLI_PROVIDER_ID;
  // 画布 CLI 同样是本地命令、没有 API Key, 必须一起跳过密钥校验, 否则报「请在设置中填写 API Key」。
  const isJimengCanvasCli = selectedModel?.providerId === JIMENG_CANVAS_CLI_PROVIDER_ID;
  const isWanCli = selectedModel?.providerId === "wan-cli";
  const isRunningHubCli = selectedModel?.providerId === RUNNINGHUB_CLI_PROVIDER_ID;
  // 参考图上限：优先读模型自带的 `maxReferenceImages`（知鸟 muse-video 只收 4 张），
  // 没有声明时退回「即梦 CLI 固定 9 张」这条老规则，其余模型不显示上限。
  const referenceImageLimit =
    selectedModel?.maxReferenceImages ?? (isJimengCli ? JIMENG_CLI_MAX_REFERENCE_IMAGES : undefined);
  /**
   * 协议档案：优先用模型自带的 `profileId`；内置 CLI 模型偶尔会漏这个字段，
   * 那就按模型 id 再兜一层 —— 否则会静默掉进「通用 OpenAI Video」，
   * 参考视频判定与协议标签会一起判错。
   */
  const selectedProfile = selectedModel
    ? selectedModel.profileId
      ? getVideoModelProfile(selectedModel.profileId)
      : resolveVideoModelProfile(selectedModel.id)
    : null;
  /**
   * 参考视频支持度。视频输入只有上游连线一个来源（不提供手动上传），
   * 但**不是每个协议都真的会把 `reference_videos` 提交上去** —— 不支持时节点上要
   * 明确标出来，而不是让用户以为传上去了。
   *
   * 即梦画布 CLI 这类「同一协议里按模型分档」的链路靠 `maxReferenceVideos` 判定，
   * 它来自 `model list` 的 `references.types[video].max`。
   */
  const videoReferenceSupport = useMemo(
    () =>
      resolveVideoReferenceSupport(
        selectedProfile?.id,
        selectedModel?.id,
        selectedModel?.maxReferenceVideos,
      ),
    [selectedModel?.id, selectedModel?.maxReferenceVideos, selectedProfile?.id],
  );
  useEffect(() => {
    if (isZzdhLipSyncModel(data.model) && selectedModel && data.model !== selectedModel.id) {
      updateNodeData(id, { model: selectedModel.id });
    }
  }, [data.model, id, selectedModel, updateNodeData]);
  const [modelPickerProviderId, setModelPickerProviderId] = useState(selectedModel?.providerId ?? "");
  const durationOptions = selectedModel?.durationOptions ?? Array.from({ length: 30 }, (_, index) => index + 1);
  const durationMinimum = durationOptions[0] ?? 1;
  const durationMaximum = durationOptions[durationOptions.length - 1] ?? 30;
  const resolutionOptions = selectedModel?.resolutions ?? [];
  const selectedVideoResolution = resolutionOptions.some((option) => option.value === data.resolution)
    ? data.resolution!
    : (selectedModel?.defaultResolution ?? resolutionOptions[0]?.value ?? "720p");
  // 时长必须落在模型声明的枚举里：可灵 v4 这类离散档位(5/10/15/30)的平台校验很严，
  // 拖到 17 秒会被直接拒，所以这里统一吸附到最近的合法档，而不是简单夹取。
  const rawDuration = Number(data.duration);
  const selectedDuration = snapVideoDurationOption(
    durationOptions,
    Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : (selectedModel?.defaultDuration ?? 5),
  );
  const videoModelProviders = useMemo(
    () => Array.from(new Set(models.map((model) => model.providerId))).map(getModelProvider),
    [models],
  );
  const pickerProviderModels = useMemo(
    () => models.filter((model) => model.providerId === modelPickerProviderId),
    [modelPickerProviderId, models],
  );
  const selectedModelName = useMemo(() => {
    if (!selectedModel) return "";
    const providerName = getModelProvider(selectedModel.providerId).label;
    const prefix = `${providerName} · `;
    return selectedModel.displayName.startsWith(prefix)
      ? selectedModel.displayName.slice(prefix.length)
      : selectedModel.displayName;
  }, [selectedModel]);
  // “发送到视频节点”会把附件直接写入新节点；同时保留连线输入，覆盖状态回传尚在防抖的瞬间。
  const directReferenceImages = useMemo(
    () =>
      Array.isArray(data.studioReferenceImages)
        ? data.studioReferenceImages.map((value) => value.trim()).filter(Boolean)
        : [],
    [data.studioReferenceImages],
  );
  const directReferenceAudio = useMemo(
    () =>
      Array.isArray(data.studioReferenceAudio)
        ? data.studioReferenceAudio.map((value) => value.trim()).filter(Boolean)
        : [],
    [data.studioReferenceAudio],
  );
  // 用户在本节点手动移除过的来源要一直剔除: 其中一部分来自上游连线, 只清空
  // studioReference* 是删不掉的(上游会把同一份素材再喂回来)。
  const excludedReferenceSources = useMemo(
    () =>
      Array.isArray(data.excludedReferenceSources)
        ? data.excludedReferenceSources.filter(
            (value): value is string => typeof value === "string" && value.length > 0,
          )
        : [],
    [data.excludedReferenceSources],
  );
  const excludedReferenceSourceSet = useMemo(() => new Set(excludedReferenceSources), [excludedReferenceSources]);
  const inputImagesFiltered = useMemo(
    () => filterExcludedReferences(inputImages, excludedReferenceSources),
    [excludedReferenceSources, inputImages],
  );
  const inputAudioFiltered = useMemo(
    () => filterExcludedReferences(inputAudio, excludedReferenceSources),
    [excludedReferenceSources, inputAudio],
  );
  // 视频参考只有上游连线一个来源（没有 studio 快照、也不做手动上传），
  // 所以只需过一遍「用户移除过」这层过滤。
  const usableInputVideos = useMemo(
    () => filterExcludedReferences(inputVideos, excludedReferenceSources),
    [excludedReferenceSources, inputVideos],
  );
  const resolvedInputImages = useMemo(
    () => mergeMediaReferenceSources(directReferenceImages, inputImagesFiltered),
    [directReferenceImages, inputImagesFiltered],
  );
  const resolvedInputAudio = useMemo(
    () => mergeMediaReferenceSources(directReferenceAudio, inputAudioFiltered),
    [directReferenceAudio, inputAudioFiltered],
  );
  // 即梦 CLI 只接受通过画布连接进来的本地音频节点；工作室快照仅供
  // 其他支持直接音频附件的模型使用。
  const usableInputAudio = isJimengCli ? inputAudioFiltered : resolvedInputAudio;
  // 文本引用预览现在按行渲染(每行一个上游文本), 不再需要合并字符串
  // 首尾帧与上游参考图是两种互斥输入方式。首尾帧只使用节点内上传的两张图。
  const referenceInputImages = useMemo(
    () => (imageMode === "reference" ? resolvedInputImages : []),
    [imageMode, resolvedInputImages],
  );
  const previousReferenceImagesRef = useRef(referenceInputImages);
  const firstLastFrameImages = useMemo(
    () =>
      [data.firstFrameImageUrl, data.lastFrameImageUrl].filter(
        (imageUrl): imageUrl is string => typeof imageUrl === "string" && imageUrl.trim().length > 0,
      ),
    [data.firstFrameImageUrl, data.lastFrameImageUrl],
  );
  const videoReferenceImages = useMemo(
    () => (imageMode === "first-last" ? firstLastFrameImages : referenceInputImages),
    [firstLastFrameImages, imageMode, referenceInputImages],
  );

  useEffect(() => {
    if (selectedModel?.providerId) {
      setModelPickerProviderId(selectedModel.providerId);
    }
  }, [selectedModel?.providerId]);

  useLayoutEffect(() => {
    if (!showModelPicker || !modelTriggerRef.current || !modelPickerRef.current) return;
    const updatePosition = () => {
      const next = getFloatingPanelPosition(modelTriggerRef.current, modelPickerRef.current, {
        align: "start",
        preferredSide: "below",
        fallbackSize: { width: 320, height: 340 },
      });
      if (next) setModelPickerPosition(next);
    };
    updatePosition();
    const observer = new ResizeObserver(updatePosition);
    observer.observe(modelTriggerRef.current);
    observer.observe(modelPickerRef.current);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [modelPickerProviderId, showModelPicker]);
  // 音频引用标签: 优先用音频节点自己的标题(素材名/文件名), 避免"音频1/音频2"分不清。
  // 默认标题"媒体"没有区分度, 视为未命名, 回退到文件名。
  const audioLabelBySource = useMemo(() => {
    const labelBySource = new Map<string, string>();
    for (const node of audioNodes) {
      if (node.type !== CANVAS_NODE_TYPES.audio || typeof node.data.sourcePath !== "string") {
        continue;
      }
      const sourcePath = node.data.sourcePath;
      if (labelBySource.has(sourcePath)) {
        continue;
      }
      const rawName = typeof node.data.displayName === "string" ? node.data.displayName.trim() : "";
      const customName = rawName && rawName !== "媒体" ? rawName : "";
      labelBySource.set(sourcePath, customName);
    }
    return labelBySource;
  }, [audioNodes]);
  const resolveAudioLabel = useCallback(
    (source: string, index: number): string => {
      const customName = audioLabelBySource.get(source);
      if (customName) {
        return customName;
      }
      // 回退: 从路径取文件名(去掉扩展名), 仍无则用"音频N"
      const fileName = source.split(/[\\/]/).pop() ?? "";
      const baseName = fileName.replace(/\.[^.]+$/, "").trim();
      return baseName || `音频${index + 1}`;
    },
    [audioLabelBySource],
  );
  /**
   * 视频引用标签。
   *
   * 与音频不同：视频结果节点的 `displayName` 通常是整段提示词（生成时直接写进去的），
   * 拿来当 36px 小方块的标签只会糊成一团，所以视频只认文件名，取不到才退成「视频N」。
   */
  /**
   * 视频的展示名固定成「视频N」，和「图N / 音频N」同一套命名。
   *
   * 原先优先用文件名：上游视频节点的落盘名常是 UUID（`416a56d-daded7…`），
   * 一排格子看过去全是乱码，也没法和提示词里的 @视频N 对上号。
   */
  const resolveVideoLabel = useCallback((_source: string, index: number): string => {
    return `视频${index + 1}`;
  }, []);
  const inputImageItems = useMemo(
    () =>
      referenceInputImages.map((imageUrl, index) => ({
        imageUrl,
        label: `图${index + 1}`,
      })),
    [referenceInputImages],
  );
  const inputImageViewerList = useMemo(
    () => inputImageItems.map((item) => resolveImageDisplayUrl(item.imageUrl)),
    [inputImageItems],
  );
  const inputImageDisplayUrls = useMemo(
    () => inputImageItems.map((item) => resolveImageDisplayUrl(item.imageUrl)),
    [inputImageItems],
  );
  const referencePickerItems = useMemo<ReferencePickerItem[]>(
    () => [
      ...inputImageItems.map((item, index) => ({
        kind: "image" as const,
        index,
        label: item.label,
        source: item.imageUrl,
      })),
      ...usableInputAudio.map((source, index) => ({
        kind: "audio" as const,
        index,
        label: resolveAudioLabel(source, index),
        source,
      })),
      // 视频只在「当前模型真的会提交」时放进 @ 列表：模型不收还让用户 @ 上去，
      // 等于承诺一件不会发生的事。
      ...(videoReferenceSupport.supported
        ? usableInputVideos.map((source, index) => ({
            kind: "video" as const,
            index,
            label: resolveVideoLabel(source, index),
            source,
          }))
        : []),
    ],
    [
      inputImageItems,
      resolveAudioLabel,
      resolveVideoLabel,
      usableInputAudio,
      usableInputVideos,
      videoReferenceSupport.supported,
    ],
  );
  /**
   * 移除一条引用素材。两个来源都要处理:
   * - 节点自身附件(studioReference*)→ 从数组里摘掉;
   * - 上游连线喂进来的(如提示词工作室的 studioReference*)→ 记进
   *   excludedReferenceSources, 否则上游会把同一份素材再喂回来。
   * 图片 token 由监听 referenceInputImages 的 effect 自动重映射;
   * 音频没有对应 effect, 这里同步处理 @音频N。
   */
  const removeReferenceTile = useCallback(
    (tile: ReferenceTile) => {
      const nextExcluded = excludedReferenceSourceSet.has(tile.source)
        ? excludedReferenceSources
        : [...excludedReferenceSources, tile.source];
      const nextExcludedSet = new Set(nextExcluded);
      const nextDirectImages = directReferenceImages.filter((item) => item !== tile.source);
      const nextDirectAudio = directReferenceAudio.filter((item) => item !== tile.source);

      const patch: Partial<VideoGenNodeData> = { excludedReferenceSources: nextExcluded };
      if (nextDirectImages.length !== directReferenceImages.length) {
        patch.studioReferenceImages = nextDirectImages;
      }
      if (tile.kind === 'image') {
        // 显式删这一条的标记。自动同步（上面的 effect）只在「来源确实少了」时删，
        // 而且它跑在下一帧；用户点了「移除该引用素材」，提示词必须当场就对上，
        // 否则输入框里还留着一个指向已删图片的 `[imageN]`。
        const nextImages = referenceInputImages.filter((item) => item !== tile.source);
        const nextPrompt = remapImageReferenceTokens(
          promptDraftRef.current,
          referenceInputImages,
          nextImages,
        );
        if (nextPrompt !== promptDraftRef.current) {
          promptDraftRef.current = nextPrompt;
          setPromptDraft(nextPrompt);
          cancelPromptCommit();
          patch.prompt = nextPrompt;
        }
      }
      // 视频现在也有提示词标记（@视频N）：移除后必须当场重编号，
      // 否则输入框里会留着一个指向已删视频的 @视频3。
      if (tile.kind === "video") {
        const nextUsableVideo = usableInputVideos.filter((item) => !nextExcludedSet.has(item));
        const nextPrompt = remapVideoReferenceTokens(
          promptDraftRef.current,
          usableInputVideos,
          nextUsableVideo,
        );
        if (nextPrompt !== promptDraftRef.current) {
          promptDraftRef.current = nextPrompt;
          setPromptDraft(nextPrompt);
          cancelPromptCommit();
          patch.prompt = nextPrompt;
        }
      }
      if (tile.kind === "audio") {
        const nextUsableAudio = isJimengCli
          ? inputAudio.filter((item) => !nextExcludedSet.has(item))
          : mergeMediaReferenceSources(
              nextDirectAudio,
              inputAudio.filter((item) => !nextExcludedSet.has(item)),
            );
        const nextPrompt = remapAudioReferenceTokens(promptDraftRef.current, usableInputAudio, nextUsableAudio);
        promptDraftRef.current = nextPrompt;
        setPromptDraft(nextPrompt);
        cancelPromptCommit();
        patch.prompt = nextPrompt;
        if (nextDirectAudio.length !== directReferenceAudio.length) {
          patch.studioReferenceAudio = nextDirectAudio;
        }
      }
      // 视频: 只走排除表（上面的 nextExcluded 已经带上这条来源），无需再写别的字段。
      updateNodeData(id, patch);
    },
    [
      cancelPromptCommit,
      directReferenceAudio,
      directReferenceImages,
      excludedReferenceSourceSet,
      excludedReferenceSources,
      id,
      inputAudio,
      isJimengCli,
      referenceInputImages,
      usableInputAudio,
      usableInputVideos,
      updateNodeData,
    ],
  );
  /**
   * 上游有视频、但这次不会提交，分两种原因：
   * - `unsupported`：协议/模型不读参考视频；
   * - `first-last`：首尾帧模式的 `--ref` 只放首帧、尾帧两张图，多挂的视频会被 CLI 拒，
   *   所以这里主动不传，而不是让用户提交后收到一句含糊的失败。
   */
  const videoReferenceBlockReason: "unsupported" | "first-last" | null =
    usableInputVideos.length === 0
      ? null
      : !videoReferenceSupport.supported
        ? "unsupported"
        : imageMode === "first-last"
          ? "first-last"
          : null;
  const videoReferenceIgnored = videoReferenceBlockReason !== null;
  /** 输入框下方要显示的「实际会随请求上传的引用素材」清单。 */
  const referenceTiles = useMemo<ReferenceTile[]>(() => {
    const tiles: ReferenceTile[] = referenceInputImages.map((source, index) => ({
      key: `image-${source}`,
      kind: "image" as const,
      source,
      label: `图${index + 1}`,
      displayUrl: inputImageDisplayUrls[index] ?? null,
      used: true,
    }));
    usableInputAudio.forEach((source, index) => {
      tiles.push({
        key: `audio-${source}`,
        kind: "audio" as const,
        source,
        // 与提示词胶囊同一套命名：素材名/文件名比「音频1」更容易对上号，
        // 试听弹窗的标题也用它。
        label: resolveAudioLabel(source, index),
        displayUrl: null,
        used: true,
      });
    });
    // 即梦不读工作室音频, 但这些素材仍留在节点上, 要让用户看得见并能删掉。
    if (isJimengCli) {
      const usedSources = new Set(usableInputAudio);
      directReferenceAudio.forEach((source, index) => {
        if (usedSources.has(source)) {
          return;
        }
        tiles.push({
          key: `audio-${source}`,
          kind: "audio" as const,
          source,
          label: resolveAudioLabel(source, index),
          displayUrl: null,
          used: false,
        });
      });
    }
    // 视频参考：来源只有上游连线，但必须让用户看见 —— 之前它悄悄进了
    // `reference_videos`，节点上却一个字都没有，既无法确认也没法单独撤掉。
    usableInputVideos.forEach((source, index) => {
      tiles.push({
        key: `video-${source}`,
        kind: "video" as const,
        source,
        label: resolveVideoLabel(source, index),
        displayUrl: null,
        used: !videoReferenceIgnored,
      });
    });
    return tiles;
  }, [
    directReferenceAudio,
    inputImageDisplayUrls,
    isJimengCli,
    referenceInputImages,
    resolveAudioLabel,
    resolveVideoLabel,
    usableInputAudio,
    usableInputVideos,
    videoReferenceIgnored,
  ]);
  const title = useMemo(() => resolveNodeDisplayName(CANVAS_NODE_TYPES.videoGen, data), [data]);
  const resolvedWidth = Math.max(VIDEO_GEN_NODE_MIN_WIDTH, Math.round(width ?? VIDEO_GEN_NODE_DEFAULT_WIDTH));
  const resolvedHeight = Math.max(VIDEO_GEN_NODE_MIN_HEIGHT, Math.round(height ?? VIDEO_GEN_NODE_DEFAULT_HEIGHT));
  const price = useMemo(
    () =>
      selectedModel && showNodePrice
        ? resolveModelPriceDisplay(selectedModel, {
            resolution: selectedVideoResolution,
            extraParams: { duration: selectedDuration },
            language: i18n.language,
            settings: {
              displayCurrencyMode: priceDisplayCurrencyMode,
              usdToCnyRate,
              preferDiscountedPrice,
              grsaiCreditTierId,
            },
          })
        : null,
    [
      grsaiCreditTierId,
      i18n.language,
      preferDiscountedPrice,
      priceDisplayCurrencyMode,
      selectedDuration,
      selectedModel,
      selectedVideoResolution,
      showNodePrice,
      usdToCnyRate,
    ],
  );

  // 推荐平台（如知鸟 AI / 炳火）在 registry 里没注册精确 pricing,
  // 但 recommendedApis.pricingRange 仍登记了图片/视频/音频三类区间,
  // 这里消费同一份数据到节点右上角,作为「精确价缺失时」的区间兜底。
  const recommendedPriceBadge = useMemo(
    () => (price ? null : resolveRecommendedApiPriceBadge(selectedModel?.providerId, customApis, "video")),
    [customApis, price, selectedModel?.providerId],
  );
  const nodePrice = price ?? recommendedPriceBadge;
  const customPrice =
    data.customPrice !== undefined
      ? typeof data.customPrice === "string"
        ? data.customPrice.trim()
        : ""
      : selectedModel
        ? (customModelPrices[selectedModel.id] ?? "")
        : "";
  const priceBadgeLabel = customPrice || nodePrice?.label || "[无价格]";

  const handlePriceChange = useCallback(
    (value: string | null) => {
      if (!selectedModel) return;
      updateNodeData(id, { customPrice: value });
      setCustomModelPrice(selectedModel.id, value);
    },
    [id, selectedModel, setCustomModelPrice, updateNodeData],
  );

  useEffect(() => {
    if (!selectedModel) return;
    const legacyPrice = typeof data.customPrice === "string" ? data.customPrice.trim() : "";
    if (legacyPrice && !customModelPrices[selectedModel.id]) {
      setCustomModelPrice(selectedModel.id, legacyPrice);
    }
  }, [customModelPrices, data.customPrice, selectedModel, setCustomModelPrice]);

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, resolvedHeight, resolvedWidth, updateNodeInternals]);

  useEffect(() => {
    const externalPrompt = data.prompt ?? "";
    if (externalPrompt !== promptDraftRef.current) {
      promptDraftRef.current = externalPrompt;
      setPromptDraft(externalPrompt);
    }
  }, [data.prompt]);

  useEffect(() => {
    if (imageMode !== "reference") {
      return;
    }
    const previousImages = previousReferenceImagesRef.current;
    // 只按**变化类型**决定要不要删标记：真正的断连由 remap 精确删掉它自己的标记。
    // 绝不再按「当前数量」删越界标记 —— 参考图是异步解析的，节点挂载后数量会经历
    // 5 → 0 → 5 这种抖动，任何一次抖动都会把 `[imageN]` 整段删掉并写回节点，
    // 等图片到齐也不会恢复，表现为「引用刚生成就全掉了」。
    //
    // 走 `syncImageReferenceTokens` 而不是 `remapImageReferenceTokens`：后者把
    // 「找不到这个来源」一律当断开，但本地化 / 资产库路径重映射会把同一个来源换成
    // 另一个地址（http → 落盘路径），那属于**改写**，标记必须原样保留。
    const remappedPrompt = syncImageReferenceTokens(
      promptDraftRef.current,
      previousImages,
      referenceInputImages,
    );
    previousReferenceImagesRef.current = referenceInputImages;
    if (remappedPrompt !== promptDraftRef.current) {
      promptDraftRef.current = remappedPrompt;
      setPromptDraft(remappedPrompt);
      cancelPromptCommit();
      updateNodeData(id, { prompt: remappedPrompt });
    }
  }, [cancelPromptCommit, id, imageMode, referenceInputImages, usableInputAudio.length, updateNodeData]);

  /**
   * 自愈：提示词里的引用标记与节点挂着的参考图对不上 —— 说明标记被某条链路删过
   * （历史版本的「按来源身份 remap」在路径被改写时就干过这事）。
   * 用户不必重新生成一遍。
   *
   * 三条路，从精确到宽松，任何一条都只在「确实缺标记」时才写回：
   * ① 有资产清单且条数与当前参考图一致 → 按清单重建引用段；
   * ② 没有可用清单 → 从上游工作室的 `quickPrompt` 整段借回，但必须「去掉标记后逐字相同」；
   * ③ 都不满足 → 一个字都不动。
   */
  useEffect(() => {
    const current = data.prompt ?? "";
    if (!current.trim()) return;

    const anchors = (Array.isArray(data.referenceAnchors) ? data.referenceAnchors : [])
      .map((item) => {
        const record = (item ?? {}) as Record<string, unknown>;
        const name = typeof record.name === "string" ? record.name.trim() : "";
        const imageIndex = Number(record.imageIndex);
        const description = typeof record.description === "string" ? record.description : "";
        return { name, imageIndex, description };
      })
      .filter((item) => item.name && Number.isFinite(item.imageIndex) && item.imageIndex >= 1);

    // 清单条数与当前参考图数量必须一致（顺序才对得上）。用户手动加过 / 删过图之后
    // 清单会过时，按过时清单重建会把序号补错 —— 那比缺标记更糟，所以直接放弃这条路。
    if (anchors.length > 0 && anchors.length === referenceInputImages.length) {
      const present = new Set(findReferenceTokens(current).map((token) => token.value));
      const missing = anchors.filter((item) => !present.has(item.imageIndex));
      if (missing.length > 0) {
        const healed = anchorImageReferenceTags(
          applyLocalReferenceSection(current, anchors as LocalReferenceAsset[]),
          anchors.map(({ name, imageIndex }) => ({ name, imageIndex })),
        );
        if (healed !== current) {
          promptDraftRef.current = healed;
          setPromptDraft(healed);
          updateNodeData(id, { prompt: healed });
          return;
        }
      }
    }

    // ② 没有可用清单：从上游提示词工作室节点整段借回（它的 quickPrompt 是本地生成的、
    //    标记完整）。只有「去掉标记后逐字相同」才借 —— 也就是说，正文一个字都没被
    //    用户改过，缺的只是标记；用户改过内容就不动，绝不覆盖他的编辑。
    const presentValues = new Set(findReferenceTokens(current).map((token) => token.value));
    const hasUnreferencedImage = referenceInputImages.some((_, index) => !presentValues.has(index + 1));
    if (!hasUnreferencedImage) {
      return;
    }

    const upstreamStudio = edges
      .filter((edge) => edge.target === id)
      .map((edge) => nodes.find((node) => node.id === edge.source))
      .find((node) => node?.type === CANVAS_NODE_TYPES.cinematicStudio);
    const upstreamPrompt =
      typeof upstreamStudio?.data?.quickPrompt === "string" ? upstreamStudio.data.quickPrompt : "";
    if (!upstreamPrompt.trim()) return;
    if (findReferenceTokens(upstreamPrompt).length === 0) return;
    if (!samePromptIgnoringReferenceTokens(upstreamPrompt, current)) return;

    promptDraftRef.current = upstreamPrompt;
    setPromptDraft(upstreamPrompt);
    updateNodeData(id, { prompt: upstreamPrompt });
  }, [data.prompt, data.referenceAnchors, edges, id, nodes, referenceInputImages.length, updateNodeData]);

  useEffect(() => {
    if (referencePickerItems.length === 0) {
      setShowImagePicker(false);
      setPickerCursor(null);
      setPickerActiveIndex(0);
      return;
    }
    setPickerActiveIndex((current) => Math.min(current, referencePickerItems.length - 1));
  }, [referencePickerItems.length]);

  // 轻量预览浮层: Esc 关闭
  useEffect(() => {
    if (!previewState) {
      return;
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setPreviewState(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [previewState]);

  useEffect(() => {
    if (!isGenerating || !isJimengCli) {
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{
      client_job_id?: string;
      status?: JimengCliStatus["status"];
      queue_count?: number | null;
      message?: string | null;
    }>("jimeng-cli-status", (event) => {
      const payload = event.payload;
      if (payload.client_job_id !== id || !payload.status) {
        return;
      }
      setJimengCliStatus({
        status: payload.status,
        queueCount: payload.queue_count,
        message: payload.message,
      });
      // 收到 queued 就代表 submit_id 已经拿到、任务已在平台创建并预缴积分：
      // 本地 CLI 的「取消生成」入口到此为止，再取消只会把已计费的结果丢掉。
      if (payload.status === "queued") {
        for (const outputId of cancelWindowNodeIdsRef.current) closeVideoCancellationWindow(outputId);
        cancelWindowNodeIdsRef.current.clear();
      }
    }).then((remove) => {
      if (disposed) {
        remove();
      } else {
        unlisten = remove;
      }
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [id, isGenerating, isJimengCli]);

  // 浮层: 点击节点外部关闭
  useEffect(() => {
    const handleOutside = (event: MouseEvent) => {
      const target = event.target as globalThis.Node;
      if (rootRef.current?.contains(target) || modelPickerRef.current?.contains(target)) {
        return;
      }
      setShowImagePicker(false);
      setPickerCursor(null);
      setShowModelPicker(false);
      setShowDurationSlider(false);
    };
    document.addEventListener("mousedown", handleOutside, true);
    return () => {
      document.removeEventListener("mousedown", handleOutside, true);
    };
  }, []);

  const syncPromptHighlightScroll = () => {
    if (!promptRef.current || !promptHighlightRef.current) {
      return;
    }
    promptHighlightRef.current.scrollTop = promptRef.current.scrollTop;
    promptHighlightRef.current.scrollLeft = promptRef.current.scrollLeft;
  };

  /**
   * 插入 / 删除引用 token 后，光标与视图必须停在原处。
   *
   * 受控 textarea 的 value 一变，浏览器会把选区丢到文末、把视图滚到最后一行；
   * 原先用 requestAnimationFrame 补救，但那会先让用户看到一帧「字跳到最后一行」，
   * 且同一批里若再有第二次 value 更新（节点数据回写）会把光标重新冲掉。
   * 改为：记下操作前的光标与 scrollTop，在 layout 阶段（浏览器绘制前）写回，
   * 并在用户下一次真实交互之前持续钉住 —— 插入点之外的内容原地不动。
   */
  const pendingPromptCaretRef = useRef<{ cursor: number; scrollTop: number | null } | null>(null);

  const clearPendingPromptCaret = useCallback(() => {
    pendingPromptCaretRef.current = null;
  }, []);

  useLayoutEffect(() => {
    const pending = pendingPromptCaretRef.current;
    const textarea = promptRef.current;
    if (!pending || !textarea) {
      return;
    }
    textarea.focus();
    textarea.setSelectionRange(pending.cursor, pending.cursor);
    // scrollTop 只写回一次：之后用户自己滚动时不再被程序抢回去。
    if (pending.scrollTop !== null) {
      textarea.scrollTop = pending.scrollTop;
      syncPromptHighlightScroll();
      pending.scrollTop = null;
    }
  });

  const insertReference = useCallback(
    (item: ReferencePickerItem) => {
      const marker =
        item.kind === "image"
          ? `@图${item.index + 1}`
          : item.kind === "video"
            ? `@视频${item.index + 1}`
            : `@音频${item.index + 1}`;
      let basePrompt = promptDraftRef.current;
      // 优先用按 @ 时记录的光标；异常路径（没记录到）退回 textarea 当前光标，
      // 绝不退回「文末」—— 否则引用会凭空插到最后一行，光标也跟着跳到末尾。
      let baseCursor = pickerCursor ?? promptRef.current?.selectionStart ?? basePrompt.length;
      // 兜底: 光标前(忽略尾部空格)已是 '@' 时先移除, 避免插入后出现 '@@图N'
      const trimmedBefore = basePrompt.slice(0, baseCursor).replace(/\s+$/, "");
      if (trimmedBefore.endsWith("@")) {
        const atIndex = trimmedBefore.length - 1;
        basePrompt = basePrompt.slice(0, atIndex) + basePrompt.slice(atIndex + 1);
        baseCursor = atIndex;
      }
      const { nextText, nextCursor } = insertReferenceToken(basePrompt, baseCursor, marker);
      pendingPromptCaretRef.current = {
        cursor: nextCursor,
        scrollTop: promptRef.current?.scrollTop ?? 0,
      };
      promptDraftRef.current = nextText;
      setPromptDraft(nextText);
      cancelPromptCommit();
      updateNodeData(id, { prompt: nextText });
      setShowImagePicker(false);
      setPickerCursor(null);
      setPickerActiveIndex(0);
    },
    [cancelPromptCommit, id, pickerCursor, updateNodeData],
  );

  const handlePromptKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      // 只要用户开始敲键盘，就由浏览器接管光标，不再回钉插入位置。
      clearPendingPromptCaret();
      if (event.key === "Backspace" || event.key === "Delete") {
        const currentPrompt = promptDraftRef.current;
        const selectionStart = event.currentTarget.selectionStart ?? currentPrompt.length;
        const selectionEnd = event.currentTarget.selectionEnd ?? selectionStart;
        const deletionDirection = event.key === "Backspace" ? "backward" : "forward";
        const deleteRange = resolveReferenceAwareDeleteRange(
          currentPrompt,
          selectionStart,
          selectionEnd,
          deletionDirection,
          referenceInputImages.length,
          usableInputAudio.length,
          // 模型不收视频时 @视频N 只是普通文字，别让退格"整个吃掉"这段内容。
          videoReferenceSupport.supported ? usableInputVideos.length : 0,
        );
        if (deleteRange) {
          event.preventDefault();
          const { nextText, nextCursor } = removeTextRange(currentPrompt, deleteRange);
          pendingPromptCaretRef.current = {
            cursor: nextCursor,
            scrollTop: promptRef.current?.scrollTop ?? 0,
          };
          promptDraftRef.current = nextText;
          setPromptDraft(nextText);
          cancelPromptCommit();
          updateNodeData(id, { prompt: nextText });
          return;
        }
      }

      if (showImagePicker && referencePickerItems.length > 0) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setPickerActiveIndex((current) => (current + 1) % referencePickerItems.length);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setPickerActiveIndex((current) => (current + referencePickerItems.length - 1) % referencePickerItems.length);
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          const activeItem = referencePickerItems[pickerActiveIndex];
          if (activeItem) {
            insertReference(activeItem);
          }
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setShowImagePicker(false);
          setPickerCursor(null);
          return;
        }
      }

      const isAtKey = event.key === "@" || (event.shiftKey && event.code === "Digit2");
      if (isAtKey && !event.ctrlKey && !event.metaKey && !event.altKey && referencePickerItems.length > 0) {
        event.preventDefault();
        const cursor = event.currentTarget.selectionStart ?? promptDraftRef.current.length;
        setPickerAnchor(resolvePickerAnchor(rootRef.current, event.currentTarget, cursor, zoom));
        setPickerCursor(cursor);
        setPickerActiveIndex(0);
        setShowImagePicker(true);
      }
    },
    [
      cancelPromptCommit,
      clearPendingPromptCaret,
      id,
      insertReference,
      pickerActiveIndex,
      referenceInputImages.length,
      referencePickerItems,
      showImagePicker,
      usableInputAudio.length,
      usableInputVideos.length,
      updateNodeData,
      videoReferenceSupport.supported,
      zoom,
    ],
  );

  const handleFrameFileChange = useCallback(
    async (slot: FrameSlot, event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file || !file.type.startsWith("image/")) {
        return;
      }
      try {
        const prepared = await prepareNodeImageFromFile(file);
        updateNodeData(
          id,
          slot === "first"
            ? {
                firstFrameImageUrl: prepared.imageUrl,
                firstFramePreviewImageUrl: prepared.previewImageUrl,
              }
            : {
                lastFrameImageUrl: prepared.imageUrl,
                lastFramePreviewImageUrl: prepared.previewImageUrl,
              },
        );
        setError(null);
      } catch (uploadError) {
        const resolved = resolveErrorContent(uploadError, "图片上传失败");
        setError(resolved.message);
        void showErrorDialog(resolved.message, t("common.error"), resolved.details);
      }
    },
    [id, t, updateNodeData],
  );

  const openFrameFilePicker = useCallback((slot: FrameSlot) => {
    if (slot === "first") {
      firstFrameInputRef.current?.click();
      return;
    }
    lastFrameInputRef.current?.click();
  }, []);

  const clearFrame = useCallback(
    (slot: FrameSlot) => {
      updateNodeData(
        id,
        slot === "first"
          ? {
              firstFrameImageUrl: null,
              firstFramePreviewImageUrl: null,
            }
          : {
              lastFrameImageUrl: null,
              lastFramePreviewImageUrl: null,
            },
      );
      setError(null);
    },
    [id, updateNodeData],
  );

  const handleGenerate = useCallback(async () => {
    // 冷却期内的连点直接丢弃（按钮此时也是灰的）。校验失败不消耗冷却，
    // 用户改完提示词/密钥可以立刻重试。
    // 防误点：双击、手滑、以及"滚回来冷却丢失后再点一下"都在这个时间窗里被丢掉。
    // 窗口只有 2 秒，正常「过几秒再点一次生成新的」完全不受影响。
    if (isVideoSubmitThrottled(id)) {
      return;
    }
    if (!selectedModel) {
      const message = "请先在设置中添加视频模型";
      setError(message);
      void showErrorDialog(message, t("common.error"));
      return;
    }
    // 生成前把「这一单实际用的参数」全部记进 settings。
    //
    // 只记时长是不够的: `lastVideoModelId` 以前只有用户**手动拉动模型下拉**时才写,
    // 节点是「提示词工作室」建出来的时候从来不写 —— 于是工作室下次建节点时
    // `resolveVideoNodeModelId` 发现记忆为空, 退到全局默认模型, 连带分辨率/画幅都换成
    // 那个模型的默认值(用户刚选的 480p 被改回 720p)。生成这一刻同步, 语义也正是
    // 「上次使用」。
    setLastVideoDuration(selectedDuration);
    setLastVideoModelId(selectedModel.id);
    if (data.aspectRatio) setLastVideoAspectRatio(data.aspectRatio);
    if (selectedVideoResolution) setLastVideoResolution(selectedVideoResolution);
    flushPromptCommit();
    // 上游文本节点的编辑同样是防抖提交的: 先补交欠账, 再从 store 现取一次。
    // 直接用 render 期的 inputText 会在「上游文本刚改完」时把上一版内容拼进提示词。
    const liveInputText = readLiveInputText(id);
    const prompt = [promptDraftRef.current.trim(), ...liveInputText].filter(Boolean).join("\n\n").trim();
    if (!prompt) {
      return;
    }
    if (imageMode === "first-last" && firstLastFrameImages.length < 2) {
      const message = t("node.videoGen.firstLastNeedImages");
      setError(message);
      void showErrorDialog(message, t("common.error"));
      return;
    }
    if (isWanCli && (usableInputAudio.length > 0 || videoReferenceImages.length > 5)) {
      const message = t(usableInputAudio.length > 0 ? "wanCli.audioUnsupported" : "wanCli.referenceLimit");
      setError(message);
      void showErrorDialog(message, t("common.error"));
      return;
    }
    const apiKey = apiKeys[selectedModel.providerId] ?? "";
    if (!isJimengCli && !isJimengCanvasCli && !isWanCli && !isRunningHubCli && !apiKey) {
      const message = "请在设置中填写 API Key";
      setError(message);
      void showErrorDialog(message, t("common.error"));
      return;
    }
    // 校验全部通过、即将真正提交——从这里开始同步地占用冷却窗口。
    // 这段到 addNode 之间没有 await，所以连点不可能插进来重复提交。
    beginCooldown();
    const customId = selectedModel.providerId.slice("custom:".length);
    const baseUrl =
      isJimengCli || isJimengCanvasCli || isWanCli || isRunningHubCli
        ? undefined
        : customApis.find((api) => api.id === customId)?.baseUrl;
    const manualReferenceVideos = Array.isArray(data.binghuoReferenceVideos)
      ? data.binghuoReferenceVideos.filter(
          (source): source is string => typeof source === "string" && source.trim().length > 0,
        )
      : [];
    /**
     * 上游连进来的视频（「AI 视频节点支持视频输入」）。
     *
     * 只在**当前协议真的会读这个字段**时才发：其余协议的后端代码里根本没有
     * `reference_videos` 这一项，发过去要么被丢掉（多数），要么被严格网关当成
     * 非法字段退单。上限按协议登记值截断（炳火 3 / 方舟 2.0 系 3 / 2.5 系 10 …），
     * 让「节点上显示几条」与「实际提交几条」始终一致。
     */
    const upstreamReferenceVideos = videoReferenceSupport.supported ? usableInputVideos : [];
    const referenceVideoLimit = videoReferenceSupport.supported
      ? Math.max(1, videoReferenceSupport.maxVideos)
      : 0;
    const referenceVideos =
      referenceVideoLimit > 0
        ? Array.from(new Set([...upstreamReferenceVideos, ...manualReferenceVideos])).slice(
            0,
            referenceVideoLimit,
          )
        : [];
    const generationExtraParams = {
      ...(referenceVideos.length > 0 ? { reference_videos: referenceVideos } : {}),
      ...(data.binghuoSkipReview === true ? { skip_review: true } : {}),
    };
    const baseGenerationDebugContext: GenerationDebugContext = {
      sourceType: "videoGen",
      providerId: selectedModel.providerId,
      requestModel: selectedModel.id,
      requestAspectRatio: data.aspectRatio,
      prompt,
      extraParams: {
        ...(baseUrl ? { provider_base_url: baseUrl } : {}),
        video_resolution: selectedVideoResolution,
        image_mode: imageMode,
        ...generationExtraParams,
      },
      referenceImageCount: videoReferenceImages.length,
      referenceImagePlaceholders: createReferenceImagePlaceholders(videoReferenceImages.length),
      referenceAudioCount: usableInputAudio.length,
      referenceVideoCount: referenceVideos.length,
    };
    const runtimeDiagnosticsPromise = getRuntimeDiagnostics().catch(() => null);
    // 立即创建下游视频节点(生成中状态), 成功后再填充视频地址, 失败时把错误写入节点。
    // 与 AI 图片节点一致: 点击生成即出现结果节点 + 连线, 报错信息显示在节点上。
    // 尺寸采用与图片结果节点相同的紧凑算法, 避免下游节点过大。
    const generationStartedAt = Date.now();
    const clientJobId = isWanCli ? crypto.randomUUID() : id;
    const compactSize = resolveMinEdgeFittedSize(data.aspectRatio, {
      minWidth: EXPORT_RESULT_NODE_MIN_WIDTH,
      minHeight: EXPORT_RESULT_NODE_MIN_HEIGHT,
    });
    const outputId = addNode(CANVAS_NODE_TYPES.audio, findNodePosition(id, 360, 240), {
      displayName: prompt,
      mediaType: "video",
      aspectRatio: data.aspectRatio,
      isGenerating: true,
      generationStartedAt,
      // 标记本次运行会话, 避免 Canvas 的"生成中节点自动恢复"逻辑把本次正常提交
      // 误判为重启残留任务而重复提交(重复扣费)
      generationClientSessionId: CURRENT_RUNTIME_SESSION_ID,
      generationDurationMs: selectedModel.expectedDurationMs ?? 180000,
      generationProviderId: selectedModel.providerId,
      generationModel: selectedModel.id,
      providerBaseUrl: baseUrl,
      generationDebugContext: baseGenerationDebugContext,
      generationRequest: {
        kind: "video",
        // 作为支持幂等提交的平台的稳定请求键。重试同一个节点时复用，避免
        // 网络超时后重复创建任务或重复扣费。
        clientJobId,
        prompt,
        model: selectedModel.id,
        duration: selectedDuration,
        aspectRatio: data.aspectRatio,
        videoResolution: selectedVideoResolution,
        imageMode,
        referenceImages: videoReferenceImages,
        referenceAudio: usableInputAudio,
        extraParams: generationExtraParams,
      },
    });
    void runtimeDiagnosticsPromise.then((runtimeDiagnostics) => {
      if (!runtimeDiagnostics) return;
      const outputNode = useCanvasStore.getState().nodes.find((node) => node.id === outputId);
      if (outputNode) {
        updateNodeData(outputId, {
          generationDebugContext: { ...baseGenerationDebugContext, ...runtimeDiagnostics },
        });
      }
    });
    // 追加而非覆盖：连点会同时挂多个下游任务，覆盖会让先提交的那个丢掉记账，
    // 从而在下游还在跑的时候把源节点的「生成中」误清掉。
    const trackedBefore = collectActiveGenerationNodeIds(
      useCanvasStore.getState().nodes.find((node) => node.id === id)?.data,
    );
    updateNodeData(id, { activeGenerationNodeIds: [...trackedBefore, outputId], activeGenerationNodeId: null });
    updateNodeSize(outputId, compactSize.width, compactSize.height);
    addEdge(id, outputId);
    // 打开「可取消窗口」: 从这一刻到平台受理为止, 下游节点上显示「取消生成」。
    // 必须在第一个 await 之前开 —— 后面的素材规整/上传才是这个窗口的主要内容。
    openVideoCancellationWindow(outputId);
    cancelWindowNodeIdsRef.current.add(outputId);
    setIsGenerating(true);
    setJimengCliStatus(isJimengCli ? { status: "queued" } : null);
    setError(null);
    try {
      if (!isJimengCli && !isWanCli && !isRunningHubCli) {
        await canvasAiGateway.setApiKey(selectedModel.providerId, apiKey);
      }
      const { jobId: generationJobId, cancelable } = await canvasAiGateway.submitGenerateVideoJob(
        {
          clientJobId,
          prompt,
          model: selectedModel.id,
          duration: selectedDuration,
          aspectRatio: data.aspectRatio,
          videoResolution: selectedVideoResolution,
          imageMode,
          referenceImages: videoReferenceImages,
          referenceAudio: usableInputAudio,
          extraParams: generationExtraParams,
        },
        { cancellationNodeId: outputId },
      );
      updateNodeData(outputId, {
        generationJobId,
        generationError: null,
        generationErrorDetails: null,
      });
      // 本地 CLI 类平台(jimeng / wan / runninghub)拦不住已经交出去的进程, 窗口到此为止。
      if (!cancelable) {
        closeVideoCancellationWindow(outputId);
        cancelWindowNodeIdsRef.current.delete(outputId);
        return;
      }
      // 竞态: 用户点取消时请求已经交出去了, 检查点来不及拦。立刻让后端中止 ——
      // 若后端回 too_late(平台已受理), 就收掉按钮让任务正常跑完。
      if (isVideoCancellationRequested(outputId)) {
        const outcome = await canvasAiGateway.cancelGenerateVideoJob(generationJobId).catch(() => "too_late" as const);
        if (outcome !== "canceled") {
          closeVideoCancellationWindow(outputId);
          cancelWindowNodeIdsRef.current.delete(outputId);
        }
      }
    } catch (generationError) {
      // 用户主动取消不是失败: 下游节点要显示「已取消」而不是红色报错, 更不能弹错误框。
      if (isVideoGenerationCanceledError(generationError)) {
        closeVideoCancellationWindow(outputId);
        cancelWindowNodeIdsRef.current.delete(outputId);
        // CLI 链路的状态靠引擎回推事件更新; 这次提交根本没跑出去, 没有事件会回来,
        // 不清掉就会在源节点上留一个永不消失的「排队中」。
        setJimengCliStatus(null);
        updateNodeData(outputId, {
          isGenerating: false,
          generationStartedAt: null,
          generationJobId: null,
          generationClientSessionId: null,
          generationCanceled: true,
          generationError: null,
          generationErrorDetails: null,
        });
        return;
      }
      closeVideoCancellationWindow(outputId);
      cancelWindowNodeIdsRef.current.delete(outputId);
      const resolved = resolveErrorContent(generationError, "视频生成失败");
      setError(resolved.message);
      recordGenerationOutcome({
        nodeId: outputId,
        kind: "video",
        providerId: selectedModel.providerId,
        modelId: selectedModel.id,
        size: selectedVideoResolution,
        duration: selectedDuration,
        referenceCount: videoReferenceImages.length,
        status: "failed",
        errorMessage: resolved.message,
        durationMs: Date.now() - generationStartedAt,
      });
      const runtimeDiagnostics = await runtimeDiagnosticsPromise;
      const generationDebugContext: GenerationDebugContext = {
        ...baseGenerationDebugContext,
        ...(runtimeDiagnostics ?? {}),
      };
      updateNodeData(outputId, {
        isGenerating: false,
        generationStartedAt: null,
        generationError: resolved.message,
        generationErrorDetails: resolved.details ?? null,
        generationClientSessionId: null,
        generationDebugContext,
      });
      // 不用手动从 activeGenerationNodeIds 里摘自己：上面已把下游节点标成终态，
      // 源节点的核对 effect 会把它清掉（连点场景下也只会摘掉这一个）。
      void showErrorDialog(
        resolved.message,
        t("common.error"),
        resolved.details,
        buildGenerationErrorReport({
          errorMessage: resolved.message,
          errorDetails: resolved.details,
          context: generationDebugContext,
        }),
      );
    }
  }, [
    addEdge,
    addNode,
    apiKeys,
    beginCooldown,
    customApis,
    data.aspectRatio,
    data.binghuoReferenceVideos,
    data.binghuoSkipReview,
    findNodePosition,
    firstLastFrameImages.length,
    flushPromptCommit,
    id,
    imageMode,
    inputText,
    isWanCli,
    selectedDuration,
    selectedModel,
    selectedProfile,
    selectedVideoResolution,
    setLastVideoAspectRatio,
    setLastVideoDuration,
    setLastVideoModelId,
    setLastVideoResolution,
    t,
    usableInputAudio,
    // 参考视频：上游来源与协议支持度都参与提交，漏进依赖会让「刚接上的视频」不生效。
    usableInputVideos,
    videoReferenceSupport.supported,
    videoReferenceSupport.maxVideos,
    updateNodeData,
    updateNodeSize,
    videoReferenceImages,
  ]);

  // 把「生成」登记给 AI Agent：它按节点名触发时走的就是这个函数 ——
  // 与用户亲手点按钮完全同一条路径，计费/取消/错误处理都不会被绕开。
  useEffect(() => registerNodeGenerationHandler(id, () => void handleGenerate()), [id, handleGenerate]);

  // 炳火高级字段: 仅当当前模型是炳火 API 时显示折叠面板。
  // 字段名固定 reference_videos(手册 3.3 红字强调: videos / video_urls 部分模型被忽略)。
  const binghuoReferenceVideos = data.binghuoReferenceVideos ?? [];
  const binghuoSkipReview = data.binghuoSkipReview === true;
  const isBinghuoModel =
    typeof selectedModel?.providerId === "string" &&
    selectedModel.providerId.startsWith("custom:") &&
    (customApis.find((api) => api.id === selectedModel.providerId.slice("custom:".length))?.baseUrl ?? "").includes(
      "7tai.cc",
    );

  return (
    <div
      ref={rootRef}
      className={`relative flex h-full flex-col gap-2 overflow-visible rounded-[var(--node-radius)] border bg-surface-dark/90 p-3 ${selected ? "border-accent shadow-[0_0_0_1px_rgba(59,130,246,0.32)]" : "border-[rgba(255,255,255,0.18)]"}`}
      style={{ width: `${resolvedWidth}px`, height: `${resolvedHeight}px` }}
    >
      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<Clapperboard className="h-4 w-4" />}
        titleText={title}
        editable
        onTitleChange={(displayName) => updateNodeData(id, { displayName })}
        rightSlot={
          showNodePrice ? (
            <NodePriceBadge
              label={priceBadgeLabel}
              customPrice={customPrice || null}
              editable
              onPriceChange={handlePriceChange}
              title={nodePrice?.nativeLabel}
            />
          ) : null
        }
      />
      <div className="relative min-h-0 flex-1 rounded-md border border-border-dark bg-bg-dark/60">
        <div className="relative h-full min-h-0">
          <div
            ref={promptHighlightRef}
            aria-hidden="true"
            className="ui-scrollbar pointer-events-none absolute inset-0 z-20 overflow-y-auto overflow-x-hidden text-xs leading-5 text-text-dark"
            style={{ scrollbarGutter: "stable" }}
          >
            <div className="min-h-full whitespace-pre-wrap break-words p-2">
              {renderPromptWithHighlights(promptDraft, {
                maxImageCount: referenceInputImages.length,
                maxAudioCount: usableInputAudio.length,
                // 视频额度为 0 时标记退化成普通文字：模型不收，就不该在这里装作能用。
                maxVideoCount: videoReferenceSupport.supported ? usableInputVideos.length : 0,
                imageUrls: inputImageDisplayUrls,
                audioSources: usableInputAudio,
                videoSources: usableInputVideos,
                resolveAudioLabel,
                resolveVideoLabel,
                onThumbnailClick: (displayUrl, event) => {
                  setPreviewState({ url: displayUrl, x: event.clientX, y: event.clientY });
                  setPreviewSize(null);
                },
                onAudioChipClick: (source, label) => setAudioPreview({ url: source, title: label }),
                onVideoChipClick: (source) => setVideoPreviewUrl(source),
                audioChipHint: t("node.videoGen.previewReferenceAudio", "点击试听"),
                videoChipHint: t("node.videoGen.previewReferenceVideo", "点击播放"),
              })}
            </div>
          </div>
          <textarea
            ref={promptRef}
            value={promptDraft}
            onChange={(event) => {
              clearPendingPromptCaret();
              const nextValue = event.target.value;
              promptDraftRef.current = nextValue;
              setPromptDraft(nextValue);
              schedulePromptCommit();
            }}
            onBlur={() => {
              clearPendingPromptCaret();
              flushPromptCommit();
            }}
            onKeyDown={handlePromptKeyDown}
            onScroll={syncPromptHighlightScroll}
            onMouseDown={(event) => {
              // 用户自己点选光标位置时不再回钉。
              clearPendingPromptCaret();
              event.stopPropagation();
            }}
            placeholder="描述要生成的视频"
            className={`ui-scrollbar nodrag nowheel relative z-10 h-full w-full resize-none overflow-y-auto overflow-x-hidden border-none bg-transparent p-2 text-xs leading-5 text-transparent caret-text-dark outline-none placeholder:text-text-muted/80 focus:border-transparent whitespace-pre-wrap break-words [font-family:inherit] ${inputText.length > 0 ? "pb-20" : ""}`}
            style={{ scrollbarGutter: "stable" }}
          />
          {inputText.length > 0 && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute bottom-0 left-0 right-0 z-30 flex flex-col gap-0 bg-bg-dark/90 p-2 text-xs leading-5 text-text-muted"
            >
              {inputText.slice(0, 3).map((text, index) => (
                <div
                  key={`input-text-${index}`}
                  className="overflow-hidden text-ellipsis whitespace-nowrap"
                  title={text}
                >
                  {text}
                </div>
              ))}
            </div>
          )}
        </div>
        {showImagePicker && referencePickerItems.length > 0 && (
          <NodeReferencePicker
            anchor={pickerAnchor}
            containerRef={rootRef}
            zoom={zoom}
            entries={referencePickerItems.map((item, index) => ({
              key: `${item.kind}-${item.source}-${index}`,
              kind: item.kind,
              label: item.label,
              thumbUrl: item.kind === "image" ? inputImageDisplayUrls[item.index] : null,
              viewerSourceUrl: item.kind === "image" ? resolveImageDisplayUrl(item.source) : null,
              viewerImageList: inputImageViewerList,
            }))}
            activeIndex={pickerActiveIndex}
            onSelect={(index) => {
              const item = referencePickerItems[index];
              if (item) {
                insertReference(item);
              }
            }}
            onHover={setPickerActiveIndex}
            previewAudioTitle={t("node.videoGen.previewReferenceAudio", "点击试听")}
            onPreviewAudio={(index) => {
              const item = referencePickerItems[index];
              if (item?.kind !== "audio") return;
              setAudioPreview({ url: item.source, title: item.label });
            }}
            onPreviewVideo={(index) => {
              const item = referencePickerItems[index];
              if (item?.kind !== "video") return;
              setVideoPreviewUrl(item.source);
            }}
            previewVideoTitle={t("node.videoGen.previewReferenceVideo", "点击播放")}
          />
        )}
      </div>
      {referenceTiles.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" data-video-reference-strip>
          <span className="text-[11px] text-text-muted">{t("node.videoGen.referenceAssets", "引用素材")}</span>
          {referenceTiles.map((tile) => {
            const previewable = tile.kind === "image" ? Boolean(tile.displayUrl) : Boolean(tile.source);
            const previewHint =
              tile.kind === "image"
                ? t("node.videoGen.previewReferenceImage", "点击放大预览")
                : tile.kind === "video"
                  ? t("node.videoGen.previewReferenceVideo", "点击播放")
                  : t("node.videoGen.previewReferenceAudio", "点击试听");
            const ignoredHint = t("node.videoGen.ignoredByModel", "当前模型不使用这项参考");
            const togglePreview = () => {
              if (!previewable) return;
              if (tile.kind === "image") {
                // 一格的缩略图看不清是哪张，和图片节点一样开大图查看器；列表带上全部引用图，
                // 查看器里可以直接左右翻。
                const viewerUrl = tile.displayUrl ?? resolveImageDisplayUrl(tile.source);
                if (!viewerUrl) return;
                openImageViewer(viewerUrl, inputImageViewerList);
                return;
              }
              if (tile.kind === "video") {
                setVideoPreviewUrl(tile.source);
                return;
              }
              setAudioPreview({ url: tile.source, title: tile.label });
            };
            return (
              <div
                key={tile.key}
                role={previewable ? "button" : undefined}
                tabIndex={previewable ? 0 : undefined}
                className={`nodrag group/ref relative h-9 w-9 shrink-0 overflow-hidden rounded border ${
                  previewable ? "cursor-pointer" : ""
                } ${
                  tile.used ? "border-border-dark bg-black/40" : "border-dashed border-border-dark/70 opacity-60"
                }`}
                title={`${tile.label} · ${previewHint}${tile.used ? "" : ` · ${ignoredHint}`}`}
                onClick={(event) => {
                  event.stopPropagation();
                  togglePreview();
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  event.stopPropagation();
                  togglePreview();
                }}
                data-reference-tile={tile.kind}
              >
                {tile.kind === "image" && tile.displayUrl ? (
                  <CanvasNodeImage
                    src={tile.displayUrl}
                    alt={tile.label}
                    disableViewer
                    draggable={false}
                    className="pointer-events-none h-full w-full object-cover"
                  />
                ) : tile.kind === "video" ? (
                  // 视频格不放 `<video>`：36px 里解码一路视频只为画一帧太贵，
                  // 用胶片图标 + 播放小三角表达「这是视频」，点开就是全屏播放。
                  <span className="pointer-events-none relative flex h-full w-full items-center justify-center bg-accent/10 text-accent">
                    <Clapperboard className="h-4 w-4" aria-hidden="true" />
                    <span className="absolute inset-0 flex items-center justify-center">
                      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-black/55">
                        <Play className="ml-[1px] h-2 w-2 text-white" aria-hidden="true" />
                      </span>
                    </span>
                  </span>
                ) : (
                  <span className="flex h-full w-full items-center justify-center text-accent">
                    <AudioLines className="h-4 w-4" aria-hidden="true" />
                  </span>
                )}
                <span className="pointer-events-none absolute bottom-0 left-0 right-0 bg-black/65 text-center text-[9px] leading-[11px] text-white">
                  {tile.label}
                </span>
                <button
                  type="button"
                  className="nodrag absolute right-0 top-0 flex h-4 w-4 items-center justify-center rounded-bl bg-black/70 text-white opacity-70 transition-opacity hover:bg-red-700/90 hover:opacity-100 group-hover/ref:opacity-100"
                  onClick={(event) => {
                    event.stopPropagation();
                    removeReferenceTile(tile);
                  }}
                  onMouseDown={(event) => event.stopPropagation()}
                  title={t("node.videoGen.removeReferenceAsset", "移除该引用素材(不再上传给模型)")}
                  aria-label={t("node.videoGen.removeReferenceAsset", "移除该引用素材(不再上传给模型)")}
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              </div>
            );
          })}
          {videoReferenceIgnored && (
            <span
              className="w-full text-[10px] leading-4 text-amber-400/80"
              title={
                videoReferenceBlockReason === "first-last"
                  ? t(
                      "node.videoGen.videoReferenceFirstLastHint",
                      "首尾帧模式的 --ref 只放首帧、尾帧两张图，视频参考不会被提交；切回「参考图」才会带上视频",
                    )
                  : t(
                      "node.videoGen.videoReferenceUnsupportedHint",
                      "参考视频只对支持 reference_videos 的协议生效：炳火、字子 -video 型号、WGSPAI 视频系列、筷子 / likeai / RunningHub、即梦画布 CLI 的 Seedance 2.0 / 2.5 系列（m2v）、即梦 CLI 的 multimodal2video 型号",
                    )
              }
            >
              {videoReferenceBlockReason === "first-last"
                ? t(
                    "node.videoGen.videoReferenceFirstLastIgnored",
                    "首尾帧模式不提交视频参考（切回「参考图」才会带上）",
                  )
                : t(
                    "node.videoGen.videoReferenceUnsupported",
                    "当前模型不读取视频参考（换支持视频参考的模型才会提交）",
                  )}
            </span>
          )}
        </div>
      )}
      <div className="flex items-center gap-1" role="group" aria-label={t("node.videoGen.imageMode")}>
        <button
          type="button"
          className={`nodrag h-7 rounded-md border px-2 text-[11px] transition-colors ${
            imageMode === "reference"
              ? "border-accent/50 bg-accent/15 text-text-dark"
              : "border-border-dark bg-bg-dark text-text-muted hover:text-text-dark"
          }`}
          onClick={(event) => {
            event.stopPropagation();
            updateNodeData(id, { imageMode: "reference" });
          }}
        >
          {t("node.videoGen.referenceMode")}
        </button>
        <button
          type="button"
          className={`nodrag h-7 rounded-md border px-2 text-[11px] transition-colors ${
            imageMode === "first-last"
              ? "border-accent/50 bg-accent/15 text-text-dark"
              : "border-border-dark bg-bg-dark text-text-muted hover:text-text-dark"
          }`}
          onClick={(event) => {
            event.stopPropagation();
            updateNodeData(id, { imageMode: "first-last" });
          }}
        >
          {t("node.videoGen.firstLastMode")}
        </button>
        {imageMode === "first-last" && (
          <span className="min-w-0 truncate text-[11px] text-text-muted">{t("node.videoGen.firstLastHint")}</span>
        )}
        <span
          className={`ml-auto shrink-0 text-[11px] ${
            referenceImageLimit !== undefined && videoReferenceImages.length > referenceImageLimit
              ? "text-red-400"
              : "text-text-muted"
          }`}
          title={referenceImageLimit !== undefined ? t("node.videoGen.referenceImageLimit") : undefined}
        >
          {t("node.videoGen.referenceImageCount", { count: videoReferenceImages.length })}
          {referenceImageLimit !== undefined ? ` / ${referenceImageLimit}` : ""}
        </span>
      </div>
      {imageMode === "first-last" && (
        <div className="grid grid-cols-2 gap-2">
          <div className="min-w-0">
            <span className="mb-1 block text-[11px] text-text-muted">{t("node.videoGen.firstFrame")}</span>
            <div className="relative h-[68px]">
              <button
                type="button"
                className="nodrag flex h-full w-full items-center justify-center overflow-hidden rounded-md border border-dashed border-border-dark bg-bg-dark text-text-muted transition-colors hover:border-accent/60 hover:bg-accent/5 hover:text-text-dark"
                onClick={(event) => {
                  event.stopPropagation();
                  openFrameFilePicker("first");
                }}
                onMouseDown={(event) => event.stopPropagation()}
                title={
                  data.firstFrameImageUrl ? t("node.videoGen.replaceFirstFrame") : t("node.videoGen.uploadFirstFrame")
                }
                aria-label={
                  data.firstFrameImageUrl ? t("node.videoGen.replaceFirstFrame") : t("node.videoGen.uploadFirstFrame")
                }
              >
                {data.firstFrameImageUrl ? (
                  <CanvasNodeImage
                    src={resolveImageDisplayUrl(data.firstFramePreviewImageUrl || data.firstFrameImageUrl)}
                    alt={t("node.videoGen.firstFrame")}
                    disableViewer
                    draggable={false}
                    className="pointer-events-none h-full w-full object-contain"
                  />
                ) : (
                  <Plus className="h-5 w-5" aria-hidden="true" />
                )}
              </button>
              {data.firstFrameImageUrl && (
                <div className="absolute right-1 top-1 flex gap-1">
                  <button
                    type="button"
                    className="nodrag flex h-6 w-6 items-center justify-center rounded border border-white/20 bg-black/65 text-white transition-colors hover:bg-black/85"
                    onClick={(event) => {
                      event.stopPropagation();
                      openFrameFilePicker("first");
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    title={t("node.videoGen.replaceFirstFrame")}
                    aria-label={t("node.videoGen.replaceFirstFrame")}
                  >
                    <ImagePlus className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="nodrag flex h-6 w-6 items-center justify-center rounded border border-white/20 bg-black/65 text-white transition-colors hover:bg-red-700/85"
                    onClick={(event) => {
                      event.stopPropagation();
                      clearFrame("first");
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    title={t("node.videoGen.removeFirstFrame")}
                    aria-label={t("node.videoGen.removeFirstFrame")}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="min-w-0">
            <span className="mb-1 block text-[11px] text-text-muted">{t("node.videoGen.lastFrame")}</span>
            <div className="relative h-[68px]">
              <button
                type="button"
                className="nodrag flex h-full w-full items-center justify-center overflow-hidden rounded-md border border-dashed border-border-dark bg-bg-dark text-text-muted transition-colors hover:border-accent/60 hover:bg-accent/5 hover:text-text-dark"
                onClick={(event) => {
                  event.stopPropagation();
                  openFrameFilePicker("last");
                }}
                onMouseDown={(event) => event.stopPropagation()}
                title={
                  data.lastFrameImageUrl ? t("node.videoGen.replaceLastFrame") : t("node.videoGen.uploadLastFrame")
                }
                aria-label={
                  data.lastFrameImageUrl ? t("node.videoGen.replaceLastFrame") : t("node.videoGen.uploadLastFrame")
                }
              >
                {data.lastFrameImageUrl ? (
                  <CanvasNodeImage
                    src={resolveImageDisplayUrl(data.lastFramePreviewImageUrl || data.lastFrameImageUrl)}
                    alt={t("node.videoGen.lastFrame")}
                    disableViewer
                    draggable={false}
                    className="pointer-events-none h-full w-full object-contain"
                  />
                ) : (
                  <Plus className="h-5 w-5" aria-hidden="true" />
                )}
              </button>
              {data.lastFrameImageUrl && (
                <div className="absolute right-1 top-1 flex gap-1">
                  <button
                    type="button"
                    className="nodrag flex h-6 w-6 items-center justify-center rounded border border-white/20 bg-black/65 text-white transition-colors hover:bg-black/85"
                    onClick={(event) => {
                      event.stopPropagation();
                      openFrameFilePicker("last");
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    title={t("node.videoGen.replaceLastFrame")}
                    aria-label={t("node.videoGen.replaceLastFrame")}
                  >
                    <ImagePlus className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="nodrag flex h-6 w-6 items-center justify-center rounded border border-white/20 bg-black/65 text-white transition-colors hover:bg-red-700/85"
                    onClick={(event) => {
                      event.stopPropagation();
                      clearFrame("last");
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    title={t("node.videoGen.removeLastFrame")}
                    aria-label={t("node.videoGen.removeLastFrame")}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              )}
            </div>
          </div>
          <input
            ref={firstFrameInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(event) => void handleFrameFileChange("first", event)}
          />
          <input
            ref={lastFrameInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(event) => void handleFrameFileChange("last", event)}
          />
        </div>
      )}
      <div
        className={`grid gap-1.5 ${
          imageMode === "first-last"
            ? resolutionOptions.length > 0
              ? "grid-cols-[minmax(0,1fr)_58px_72px]"
              : "grid-cols-[minmax(0,1fr)_78px]"
            : resolutionOptions.length > 0
              ? "grid-cols-[minmax(0,1fr)_58px_58px_72px]"
              : "grid-cols-[minmax(0,1fr)_72px_78px]"
        }`}
      >
        <div ref={modelTriggerRef} className="relative min-w-0">
          <button
            type="button"
            className="nodrag flex h-8 w-full min-w-0 items-center justify-between gap-1 rounded border border-border-dark bg-bg-dark px-2 text-left text-xs text-text-dark"
            onClick={(event) => {
              event.stopPropagation();
              setShowImagePicker(false);
              setShowDurationSlider(false);
              setShowModelPicker((current) => !current);
            }}
            onMouseDown={(event) => event.stopPropagation()}
            aria-expanded={showModelPicker}
            aria-label={t("modelParams.model")}
          >
            <span className="min-w-0 truncate">
              {selectedModelName || (models.length === 0 ? "请先配置视频模型" : "")}
            </span>
            <ChevronDown
              className={`h-3.5 w-3.5 shrink-0 transition-transform ${showModelPicker ? "rotate-180" : ""}`}
            />
          </button>
          {showModelPicker &&
            typeof document !== "undefined" &&
            createPortal(
              <div
                ref={modelPickerRef}
                className="nodrag nowheel fixed z-[160] w-[320px] max-w-[calc(100vw-32px)] rounded-lg border border-[rgba(255,255,255,0.16)] bg-surface-dark p-3 shadow-xl"
                style={modelPickerPosition ?? undefined}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                onWheelCapture={(event) => event.stopPropagation()}
              >
                {models.length === 0 ? (
                  <div className="text-xs text-text-muted">请先在设置中配置视频模型</div>
                ) : (
                  <div className="ui-scrollbar max-h-[300px] space-y-3 overflow-y-auto">
                    <section>
                      <div className="mb-2 text-xs font-medium text-text-muted">{t("modelParams.provider")}</div>
                      <div className="flex flex-wrap gap-1.5">
                        {videoModelProviders.map((provider) => {
                          const active = provider.id === modelPickerProviderId;
                          return (
                            <button
                              key={provider.id}
                              type="button"
                              className={`h-8 rounded-lg border px-3 text-xs transition-colors ${
                                active
                                  ? "border-accent/50 bg-accent/15 text-text-dark"
                                  : "border-[rgba(255,255,255,0.12)] bg-bg-dark/65 text-text-muted hover:border-[rgba(255,255,255,0.2)]"
                              }`}
                              onClick={(event) => {
                                event.stopPropagation();
                                setModelPickerProviderId(provider.id);
                              }}
                            >
                              {provider.label || provider.name}
                            </button>
                          );
                        })}
                      </div>
                    </section>
                    <section>
                      <div className="mb-2 text-xs font-medium text-text-muted">{t("modelParams.model")}</div>
                      <div className="flex flex-wrap gap-1.5">
                        {pickerProviderModels.map((model) => {
                          const providerName = getModelProvider(model.providerId).label;
                          const label = model.displayName.startsWith(`${providerName} · `)
                            ? model.displayName.slice(providerName.length + 3)
                            : model.displayName;
                          const active = model.id === selectedModel?.id;
                          return (
                            <button
                              key={model.id}
                              type="button"
                              className={`min-h-8 max-w-full rounded-lg border px-3 py-1.5 text-xs leading-4 transition-colors ${
                                active
                                  ? "border-accent/50 bg-accent/15 text-text-dark"
                                  : "border-[rgba(255,255,255,0.12)] bg-bg-dark/65 text-text-muted hover:border-[rgba(255,255,255,0.2)] hover:bg-[rgba(255,255,255,0.05)]"
                              }`}
                              onClick={(event) => {
                                event.stopPropagation();
                                updateNodeData(id, {
                                  model: model.id,
                                  customPrice: customModelPrices[model.id] ?? null,
                                  // 换模型时把时长落到新模型的合法档位上；声明了
                                  // defaultDuration 的新模型（如可灵 v4 = 30s）直接用它。
                                  duration: resolveVideoNodeDuration(model, data.duration),
                                });
                                setLastVideoModelId(model.id);
                                setShowModelPicker(false);
                              }}
                            >
                              <span className="break-words">{label}</span>
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  </div>
                )}
              </div>,
              document.body,
            )}
        </div>
        {imageMode !== "first-last" && (
          <select
            className="nodrag h-8 rounded border border-border-dark bg-bg-dark px-1 text-xs text-text-dark"
            value={data.aspectRatio}
            onChange={(event) => {
              setShowModelPicker(false);
              updateNodeData(id, { aspectRatio: event.target.value });
              setLastVideoAspectRatio(event.target.value);
            }}
          >
            {(selectedModel?.aspectRatios ?? []).map((ratio) => (
              <option key={ratio.value} value={ratio.value}>
                {ratio.label}
              </option>
            ))}
          </select>
        )}
        {resolutionOptions.length > 0 && (
          <select
            className="nodrag h-8 rounded border border-border-dark bg-bg-dark px-1 text-xs text-text-dark"
            value={selectedVideoResolution}
            onChange={(event) => {
              setShowModelPicker(false);
              updateNodeData(id, { resolution: event.target.value });
              setLastVideoResolution(event.target.value);
            }}
            aria-label="视频分辨率"
          >
            {resolutionOptions.map((resolution) => (
              <option key={resolution.value} value={resolution.value}>
                {resolution.label}
              </option>
            ))}
          </select>
        )}
        <div className="relative">
          <button
            type="button"
            className="nodrag flex h-8 w-full items-center justify-between rounded border border-border-dark bg-bg-dark px-2 text-xs text-text-dark"
            onClick={(event) => {
              event.stopPropagation();
              setShowImagePicker(false);
              setShowModelPicker(false);
              setShowDurationSlider((current) => !current);
            }}
            onMouseDown={(event) => event.stopPropagation()}
            aria-expanded={showDurationSlider}
            aria-label="视频时长"
          >
            <span>{selectedDuration}s</span>
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showDurationSlider ? "rotate-180" : ""}`} />
          </button>
          {showDurationSlider && (
            <div
              className="nodrag nowheel absolute right-0 top-[calc(100%+6px)] z-30 w-52 rounded-lg border border-[rgba(255,255,255,0.16)] bg-surface-dark p-3 shadow-xl"
              onMouseDown={(event) => event.stopPropagation()}
              onWheelCapture={(event) => event.stopPropagation()}
            >
              <div className="mb-2 flex items-center justify-between text-[11px] text-text-muted">
                <span>{durationMinimum}秒</span>
                <span className="font-medium text-text-dark">{selectedDuration} 秒</span>
                <span>{durationMaximum}秒</span>
              </div>
              <input
                type="range"
                min={durationMinimum}
                max={durationMaximum}
                step="1"
                value={selectedDuration}
                onChange={(event) => {
                  const duration = snapVideoDurationOption(durationOptions, Number(event.target.value));
                  updateNodeData(id, { duration });
                  setLastVideoDuration(duration);
                }}
                className="nodrag nowheel h-1.5 w-full cursor-pointer appearance-none rounded-full bg-border-dark [accent-color:var(--color-accent)]"
                aria-label="视频时长（秒）"
              />
            </div>
          )}
        </div>
      </div>
      {isJimengCli && isGenerating && jimengCliStatus && (
        <div className="text-[11px] text-text-muted">
          {jimengCliStatus.status === "queued"
            ? `排队中${typeof jimengCliStatus.queueCount === "number" ? ` · 当前排队 ${jimengCliStatus.queueCount}` : ""}`
            : jimengCliStatus.status === "running"
              ? "已进入生成阶段，无法取消"
              : jimengCliStatus.status === "retrying"
                ? (jimengCliStatus.message ?? "正在重试")
                : "即梦 CLI 处理中"}
          {jimengCliStatus.status === "queued" && (
            <span className="ml-1 text-text-muted/70">（CLI 未提供远端取消功能）</span>
          )}
        </div>
      )}
      {isWanCli && imageMode === "first-last" && (
        <span className="text-[11px] text-text-muted">{t("wanCli.frameRatio")}</span>
      )}
      {selectedProfile && !isJimengCli && (
        <span className={`text-[11px] ${selectedProfile.status === "verified" ? "text-text-muted" : "text-amber-400"}`}>
          {selectedProfile.protocolLabel}
        </span>
      )}
      {error && <span className="line-clamp-2 text-[11px] text-red-400">{error}</span>}
      {isBinghuoModel && (
        <details
          className="nodrag rounded-md border border-border-dark/70 bg-bg-dark/40 px-2 py-1 text-[11px] text-text-muted open:pb-2"
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <summary className="nodrag cursor-pointer select-none text-text-dark">
            {t("node.videoGen.binghuoAdvanced")}
          </summary>
          <div className="nodrag mt-2 flex flex-col gap-2">
            <label className="flex flex-col gap-1">
              <span className="flex items-center justify-between">
                <span>{t("node.videoGen.binghuoReferenceVideosLabel")}</span>
                <span className="text-text-muted">
                  {t("node.videoGen.binghuoReferenceVideosCount", { count: binghuoReferenceVideos.length })}
                </span>
              </span>
              <textarea
                className="nodrag min-h-[64px] resize-y rounded-md border border-border-dark/70 bg-bg-dark px-2 py-1 font-mono text-[11px] text-text-dark focus:border-accent/60 focus:outline-none"
                placeholder="https://…/clip1.mp4&#10;https://…/clip2.mp4"
                value={binghuoReferenceVideos.join("\n")}
                spellCheck={false}
                onChange={(event) => {
                  const urls = event.target.value
                    .split(/\r?\n/)
                    .map((line) => line.trim())
                    .filter(Boolean)
                    .slice(0, 3);
                  updateNodeData(id, { binghuoReferenceVideos: urls });
                }}
                onClick={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
              />
              <span className="leading-snug text-text-muted/90">{t("node.videoGen.binghuoReferenceVideosHint")}</span>
            </label>
            <label className="flex flex-col gap-1">
              <span className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="nodrag h-3.5 w-3.5 accent-accent"
                  checked={binghuoSkipReview}
                  onChange={(event) => updateNodeData(id, { binghuoSkipReview: event.target.checked })}
                  onClick={(event) => event.stopPropagation()}
                  onMouseDown={(event) => event.stopPropagation()}
                />
                <span>{t("node.videoGen.binghuoSkipReviewLabel")}</span>
              </span>
              <span className="leading-snug text-text-muted/90">{t("node.videoGen.binghuoSkipReviewHint")}</span>
            </label>
          </div>
        </details>
      )}
      <button
        type="button"
        disabled={
          isCoolingDown || !selectedModel || (!promptDraft.trim() && inputText.length === 0)
        }
        onClick={() => void handleGenerate()}
        className="nodrag mt-auto flex h-8 items-center justify-center gap-1.5 rounded-md bg-accent text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-45"
        title={
          isCoolingDown
            ? "刚刚提交过，稍等一下再点（防误点）"
            : isGenerationInFlight
              ? `已提交 ${activeTaskCount} 个任务；再点会生成新的一单`
              : undefined
        }
      >
        {isCoolingDown ? (
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Sparkles className="h-3.5 w-3.5" />
        )}
        {isCoolingDown
          ? `冷却 ${cooldownSeconds}s`
          : isGenerationInFlight
            ? "再生成一个"
            : "生成视频"}
        {activeTaskCount > 0 && (
          <span
            className="rounded-full bg-white/25 px-1.5 text-[10px] leading-4"
            title={`已提交 ${activeTaskCount} 个任务，生成中`}
          >
            {activeTaskCount}
          </span>
        )}
      </button>
      <Handle
        id="target"
        type="target"
        position={Position.Left}
        className="!h-2 !w-2 !border-surface-dark !bg-accent"
      />
      <Handle
        id="source"
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-surface-dark !bg-accent"
      />
      <NodeResizeHandle
        minWidth={VIDEO_GEN_NODE_MIN_WIDTH}
        minHeight={VIDEO_GEN_NODE_MIN_HEIGHT}
        maxWidth={VIDEO_GEN_NODE_MAX_WIDTH}
        maxHeight={VIDEO_GEN_NODE_MAX_HEIGHT}
      />
      {previewState &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[190]" onClick={() => setPreviewState(null)} />
            <div
              className="fixed z-[200] overflow-hidden rounded-lg border border-[rgba(255,255,255,0.16)] bg-black/60 shadow-2xl"
              style={{
                width: previewSize?.width ?? REFERENCE_PREVIEW_WIDTH,
                height: previewSize?.height ?? REFERENCE_PREVIEW_ESTIMATED_HEIGHT,
                left: resolvePreviewLeft(previewState.x, previewSize?.width ?? REFERENCE_PREVIEW_WIDTH),
                top: resolvePreviewTop(previewState.y, previewSize?.height ?? REFERENCE_PREVIEW_ESTIMATED_HEIGHT),
                transformOrigin: "left center",
                animation: "reference-preview-pop 0.16s ease-out",
              }}
              onClick={(event) => event.stopPropagation()}
            >
              <img
                src={previewState.url}
                alt="参考图预览"
                draggable={false}
                className="h-full w-full object-contain"
                onLoad={(event) => {
                  const img = event.currentTarget;
                  setPreviewSize(resolvePreviewDisplaySize(img.naturalWidth, img.naturalHeight));
                }}
              />
            </div>
            <style>{`@keyframes reference-preview-pop { from { transform: translateX(-12px) scaleX(0.75); opacity: 0; } to { transform: translateX(0) scaleX(1); opacity: 1; } }`}</style>
          </>,
          document.body,
        )}
      <AudioViewerModal
        open={audioPreview !== null}
        audioUrl={audioPreview?.url ?? ""}
        title={audioPreview?.title}
        onClose={() => setAudioPreview(null)}
      />
      {/* VideoViewerModal 是 `fixed` 全屏层，节点在 React Flow 的 transform 容器里会被
          当成包含块 → 必须 portal 到 body，否则弹窗跟着画布缩放偏移。 */}
      {videoPreviewUrl !== null &&
        createPortal(
          <VideoViewerModal
            open
            videoUrl={videoPreviewUrl}
            title={referenceTiles.find((tile) => tile.kind === "video" && tile.source === videoPreviewUrl)?.label}
            onClose={() => setVideoPreviewUrl(null)}
          />,
          document.body,
        )}
    </div>
  );
});

VideoGenNode.displayName = "VideoGenNode";
