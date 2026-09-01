import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { listen } from '@tauri-apps/api/event';
import { Handle, Position, useUpdateNodeInternals } from '@xyflow/react';
import { AudioLines, ChevronDown, Clapperboard, ImagePlus, LoaderCircle, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { CANVAS_NODE_TYPES, EXPORT_RESULT_NODE_MIN_HEIGHT, EXPORT_RESULT_NODE_MIN_WIDTH, type VideoGenNodeData } from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { canvasAiGateway, graphImageResolver } from '@/features/canvas/application/canvasServices';
import { resolveErrorContent, showErrorDialog } from '@/features/canvas/application/errorDialog';
import { CURRENT_RUNTIME_SESSION_ID } from '@/features/canvas/application/generationErrorReport';
import { mergeMediaReferenceSources } from '@/features/canvas/application/mediaReferenceSources';
import { recordGenerationOutcome } from '@/features/canvas/application/usageRecording';
import { resolveMinEdgeFittedSize } from '@/features/canvas/application/imageNodeSizing';
import { getDefaultVideoModelId, getModelProvider, getVideoModel, JIMENG_CLI_PROVIDER_ID, listVideoModels, resolveVideoModelProfile } from '@/features/canvas/models';
import { resolveModelPriceDisplay } from '@/features/canvas/pricing';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodePriceBadge } from '@/features/canvas/ui/NodePriceBadge';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { CanvasNodeImage } from '@/features/canvas/ui/CanvasNodeImage';
import { prepareNodeImageFromFile, resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import {
  findReferenceTokens,
  insertReferenceToken,
  remapAudioReferenceTokens,
  removeOutOfRangeReferenceTokens,
  removeTextRange,
  resolveReferenceAwareDeleteRange,
} from '@/features/canvas/application/referenceTokenEditing';
import { useDebouncedNodeTextCommit } from '@/features/canvas/application/useDebouncedNodeTextCommit';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';

type VideoGenNodeProps = { id: string; data: VideoGenNodeData; selected?: boolean; width?: number; height?: number };

const VIDEO_GEN_NODE_MIN_WIDTH = 320;
const VIDEO_GEN_NODE_MIN_HEIGHT = 320;
const VIDEO_GEN_NODE_MAX_WIDTH = 720;
const VIDEO_GEN_NODE_MAX_HEIGHT = 560;
const VIDEO_GEN_NODE_DEFAULT_WIDTH = 420;
const VIDEO_GEN_NODE_DEFAULT_HEIGHT = 360;

interface PickerAnchor {
  left: number;
  top: number;
}

interface ReferencePickerItem {
  kind: 'image' | 'audio';
  index: number;
  label: string;
  source: string;
}

type FrameSlot = 'first' | 'last';

type JimengCliStatus = {
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  queueCount?: number | null;
  message?: string | null;
};

const PICKER_FALLBACK_ANCHOR: PickerAnchor = { left: 8, top: 8 };
const PICKER_Y_OFFSET_PX = 20;

function getTextareaCaretOffset(
  textarea: HTMLTextAreaElement,
  caretIndex: number
): PickerAnchor {
  const mirror = document.createElement('div');
  const computed = window.getComputedStyle(textarea);
  const mirrorStyle = mirror.style;

  mirrorStyle.position = 'absolute';
  mirrorStyle.visibility = 'hidden';
  mirrorStyle.pointerEvents = 'none';
  mirrorStyle.whiteSpace = 'pre-wrap';
  mirrorStyle.overflowWrap = 'break-word';
  mirrorStyle.wordBreak = 'break-word';
  mirrorStyle.boxSizing = computed.boxSizing;
  mirrorStyle.width = `${textarea.clientWidth}px`;
  mirrorStyle.font = computed.font;
  mirrorStyle.lineHeight = computed.lineHeight;
  mirrorStyle.letterSpacing = computed.letterSpacing;
  mirrorStyle.padding = computed.padding;
  mirrorStyle.border = computed.border;
  mirrorStyle.textTransform = computed.textTransform;
  mirrorStyle.textIndent = computed.textIndent;

  mirror.textContent = textarea.value.slice(0, caretIndex);

  const marker = document.createElement('span');
  marker.textContent = textarea.value.slice(caretIndex, caretIndex + 1) || ' ';
  mirror.appendChild(marker);

  document.body.appendChild(mirror);

  const left = marker.offsetLeft - textarea.scrollLeft;
  const top = marker.offsetTop - textarea.scrollTop;

  document.body.removeChild(mirror);

  return {
    left: Math.max(0, left),
    top: Math.max(0, top),
  };
}

function resolvePickerAnchor(
  container: HTMLDivElement | null,
  textarea: HTMLTextAreaElement,
  caretIndex: number
): PickerAnchor {
  if (!container) {
    return PICKER_FALLBACK_ANCHOR;
  }

  const containerRect = container.getBoundingClientRect();
  const textareaRect = textarea.getBoundingClientRect();
  const caretOffset = getTextareaCaretOffset(textarea, caretIndex);

  return {
    left: Math.max(0, textareaRect.left - containerRect.left + caretOffset.left),
    top: Math.max(0, textareaRect.top - containerRect.top + caretOffset.top + PICKER_Y_OFFSET_PX),
  };
}

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
function resolvePreviewDisplaySize(
  naturalWidth: number,
  naturalHeight: number
): { width: number; height: number } {
  const safeWidth = Math.max(1, naturalWidth);
  const safeHeight = Math.max(1, naturalHeight);
  const scale = Math.min(
    REFERENCE_PREVIEW_MAX_SIZE / safeWidth,
    REFERENCE_PREVIEW_MAX_SIZE / safeHeight,
    1
  );
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
  if (typeof window === 'undefined') {
    return clientX + REFERENCE_PREVIEW_OFFSET;
  }
  let left = clientX + REFERENCE_PREVIEW_OFFSET;
  if (left + width > window.innerWidth - REFERENCE_PREVIEW_MARGIN) {
    left = clientX - width - REFERENCE_PREVIEW_OFFSET;
  }
  return Math.max(
    REFERENCE_PREVIEW_MARGIN,
    Math.min(left, window.innerWidth - width - REFERENCE_PREVIEW_MARGIN)
  );
}

function resolvePreviewTop(clientY: number, height: number): number {
  if (typeof window === 'undefined') {
    return clientY + REFERENCE_PREVIEW_OFFSET;
  }
  let top = clientY + REFERENCE_PREVIEW_OFFSET;
  if (top + height > window.innerHeight - REFERENCE_PREVIEW_MARGIN) {
    top = clientY - height - REFERENCE_PREVIEW_OFFSET;
  }
  return Math.max(
    REFERENCE_PREVIEW_MARGIN,
    Math.min(top, window.innerHeight - height - REFERENCE_PREVIEW_MARGIN)
  );
}

function renderPromptWithHighlights(
  prompt: string,
  maxImageCount: number,
  maxAudioCount: number,
  imageUrls: string[],
  audioSources: string[],
  resolveAudioLabel: (source: string, index: number) => string,
  onThumbnailClick?: (displayUrl: string, event: { clientX: number; clientY: number }) => void
): ReactNode {
  if (!prompt) {
    return ' ';
  }

  const segments: ReactNode[] = [];
  let lastIndex = 0;
  const referenceTokens = findReferenceTokens(prompt, maxImageCount, maxAudioCount);
  for (const token of referenceTokens) {
    const matchStart = token.start;
    const matchText = token.token;
    const imageUrl = token.kind === 'image' ? imageUrls[token.value - 1] ?? null : null;

    if (matchStart > lastIndex) {
      segments.push(
        <span key={`plain-${lastIndex}`}>{prompt.slice(lastIndex, matchStart)}</span>
      );
    }

    if (token.kind === 'audio') {
      // 音频胶囊必须限制在原始 token 的行内占位宽度中，否则会盖住后续文字。
      const source = audioSources[token.value - 1];
      const label = source ? resolveAudioLabel(source, token.value - 1) : matchText;
      segments.push(
        <span key={`ref-${matchStart}`} className="relative z-0 text-transparent">
          {matchText}
          <span
            title={label}
            className="pointer-events-none absolute left-0 top-1/2 inline-flex h-[18px] max-w-full -translate-y-1/2 items-center gap-0.5 overflow-hidden rounded-[5px] bg-accent px-1 text-[10px] font-medium leading-none text-white"
          >
            <AudioLines className="h-3 w-3 shrink-0" />
            <span className="truncate">{label}</span>
          </span>
        </span>
      );
    } else if (imageUrl) {
      // 保留 token 占位以保持光标位置一致(token 文字透明, 只显示缩略图)。
      // 缩略图固定 20×20 正方形居中, 尺寸稳定不影响行高排版。
      segments.push(
        <span
          key={`ref-${matchStart}`}
          className="relative z-0 text-transparent"
        >
          {matchText}
          <span
            className="pointer-events-auto absolute left-1/2 top-1/2 inline-flex h-[20px] w-[20px] -translate-x-1/2 -translate-y-1/2 cursor-zoom-in items-center justify-center overflow-hidden rounded-[5px] bg-accent/70"
            onClick={(event) => {
              event.stopPropagation();
              onThumbnailClick?.(imageUrl, event);
            }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <img
              src={imageUrl}
              alt={matchText}
              draggable={false}
              className="h-full w-full shrink-0 object-cover"
            />
          </span>
        </span>
      );
    } else {
      segments.push(
        <span
          key={`ref-${matchStart}`}
          className="relative z-0 text-transparent"
        >
          {matchText}
        </span>
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
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const addNode = useCanvasStore((state) => state.addNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const updateNodeSize = useCanvasStore((state) => state.updateNodeSize);
  const findNodePosition = useCanvasStore((state) => state.findNodePosition);
  const apiKeys = useSettingsStore((state) => state.apiKeys);
  const customApis = useSettingsStore((state) => state.customApis);
  const showNodePrice = useSettingsStore((state) => state.showNodePrice);
  const priceDisplayCurrencyMode = useSettingsStore((state) => state.priceDisplayCurrencyMode);
  const usdToCnyRate = useSettingsStore((state) => state.usdToCnyRate);
  const [isGenerating, setIsGenerating] = useState(false);
  const [jimengCliStatus, setJimengCliStatus] = useState<JimengCliStatus | null>(null);
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
  const firstFrameInputRef = useRef<HTMLInputElement>(null);
  const lastFrameInputRef = useRef<HTMLInputElement>(null);
  const [promptDraft, setPromptDraft] = useState(() => data.prompt ?? '');
  const promptDraftRef = useRef(promptDraft);
  /** 缩略图轻量预览: 从鼠标点击位置左侧滑出, 点击空白处关闭 */
  const [previewState, setPreviewState] = useState<ReferencePreviewState | null>(null);
  /** 预览图按图片比例自适应后的显示尺寸(加载完成前为 null) */
  const [previewSize, setPreviewSize] = useState<{ width: number; height: number } | null>(null);
  const { cancelCommit: cancelPromptCommit, flushCommit: flushPromptCommit, scheduleCommit: schedulePromptCommit } =
    useDebouncedNodeTextCommit({
      nodeId: id,
      field: 'prompt',
      valueRef: promptDraftRef,
      updateNodeData,
    });

  const models = listVideoModels();
  const selectedModel = getVideoModel(data.model) ?? getVideoModel(getDefaultVideoModelId());
  const imageMode = data.imageMode === 'first-last' ? 'first-last' : 'reference';
  const isJimengCli = selectedModel?.providerId === JIMENG_CLI_PROVIDER_ID;
  const selectedProfile = selectedModel ? resolveVideoModelProfile(selectedModel.id) : null;
  const [modelPickerProviderId, setModelPickerProviderId] = useState(
    selectedModel?.providerId ?? ''
  );
  const durationOptions = selectedModel?.durationOptions ?? Array.from({ length: 30 }, (_, index) => index + 1);
  const durationMinimum = durationOptions[0] ?? 1;
  const durationMaximum = durationOptions[durationOptions.length - 1] ?? 30;
  const resolutionOptions = selectedModel?.resolutions ?? [];
  const selectedVideoResolution = resolutionOptions.some((option) => option.value === data.resolution)
    ? data.resolution!
    : (selectedModel?.defaultResolution ?? resolutionOptions[0]?.value ?? '720p');
  const selectedDuration = Math.max(
    durationMinimum,
    Math.min(durationMaximum, Math.round(Number(data.duration) || 5))
  );
  const videoModelProviders = useMemo(
    () => Array.from(new Set(models.map((model) => model.providerId))).map(getModelProvider),
    [models]
  );
  const pickerProviderModels = useMemo(
    () => models.filter((model) => model.providerId === modelPickerProviderId),
    [modelPickerProviderId, models]
  );
  const selectedModelName = useMemo(() => {
    if (!selectedModel) return '';
    const providerName = getModelProvider(selectedModel.providerId).label;
    const prefix = `${providerName} · `;
    return selectedModel.displayName.startsWith(prefix)
      ? selectedModel.displayName.slice(prefix.length)
      : selectedModel.displayName;
  }, [selectedModel]);
  const inputImages = useMemo(
    () => graphImageResolver.collectInputImages(id, nodes, edges),
    [edges, id, nodes]
  );
  const inputAudio = useMemo(
    () => graphImageResolver.collectInputAudio(id, nodes, edges),
    [edges, id, nodes]
  );
  const inputText = useMemo(
    () => graphImageResolver.collectInputText(id, nodes, edges),
    [edges, id, nodes]
  );
  // “发送到视频节点”会把附件直接写入新节点；同时保留连线输入，覆盖状态回传尚在防抖的瞬间。
  const directReferenceImages = useMemo(
    () => Array.isArray(data.studioReferenceImages)
      ? data.studioReferenceImages.map((value) => value.trim()).filter(Boolean)
      : [],
    [data.studioReferenceImages]
  );
  const directReferenceAudio = useMemo(
    () => Array.isArray(data.studioReferenceAudio)
      ? data.studioReferenceAudio.map((value) => value.trim()).filter(Boolean)
      : [],
    [data.studioReferenceAudio]
  );
  const resolvedInputImages = useMemo(
    () => mergeMediaReferenceSources(directReferenceImages, inputImages),
    [directReferenceImages, inputImages]
  );
  const resolvedInputAudio = useMemo(
    () => mergeMediaReferenceSources(directReferenceAudio, inputAudio),
    [directReferenceAudio, inputAudio]
  );
  // 即梦 CLI 只接受通过画布连接进来的本地音频节点；工作室快照仅供
  // 其他支持直接音频附件的模型使用。
  const usableInputAudio = isJimengCli ? inputAudio : resolvedInputAudio;
  // 文本引用预览现在按行渲染(每行一个上游文本), 不再需要合并字符串
  // 首尾帧与上游参考图是两种互斥输入方式。首尾帧只使用节点内上传的两张图。
  const referenceInputImages = imageMode === 'reference' ? resolvedInputImages : [];
  const firstLastFrameImages = useMemo(
    () => [data.firstFrameImageUrl, data.lastFrameImageUrl]
      .filter((imageUrl): imageUrl is string => typeof imageUrl === 'string' && imageUrl.trim().length > 0),
    [data.firstFrameImageUrl, data.lastFrameImageUrl]
  );
  const videoReferenceImages = useMemo(
    () => imageMode === 'first-last' ? firstLastFrameImages : referenceInputImages,
    [firstLastFrameImages, imageMode, referenceInputImages]
  );

  useEffect(() => {
    if (selectedModel?.providerId) {
      setModelPickerProviderId(selectedModel.providerId);
    }
  }, [selectedModel?.providerId]);
  // 音频引用标签: 优先用音频节点自己的标题(素材名/文件名), 避免"音频1/音频2"分不清。
  // 默认标题"媒体"没有区分度, 视为未命名, 回退到文件名。
  const audioLabelBySource = useMemo(() => {
    const labelBySource = new Map<string, string>();
    for (const node of nodes) {
      if (node.type !== CANVAS_NODE_TYPES.audio || typeof node.data.sourcePath !== 'string') {
        continue;
      }
      const sourcePath = node.data.sourcePath;
      if (labelBySource.has(sourcePath)) {
        continue;
      }
      const rawName = typeof node.data.displayName === 'string' ? node.data.displayName.trim() : '';
      const customName = rawName && rawName !== '媒体' ? rawName : '';
      labelBySource.set(sourcePath, customName);
    }
    return labelBySource;
  }, [nodes]);
  const resolveAudioLabel = useCallback((source: string, index: number): string => {
    const customName = audioLabelBySource.get(source);
    if (customName) {
      return customName;
    }
    // 回退: 从路径取文件名(去掉扩展名), 仍无则用"音频N"
    const fileName = source.split(/[\\/]/).pop() ?? '';
    const baseName = fileName.replace(/\.[^.]+$/, '').trim();
    return baseName || `音频${index + 1}`;
  }, [audioLabelBySource]);
  const inputImageItems = useMemo(
    () => referenceInputImages.map((imageUrl, index) => ({
      imageUrl,
      label: `图${index + 1}`,
    })),
    [referenceInputImages]
  );
  const inputImageViewerList = useMemo(
    () => inputImageItems.map((item) => resolveImageDisplayUrl(item.imageUrl)),
    [inputImageItems]
  );
  const inputImageDisplayUrls = useMemo(
    () => inputImageItems.map((item) => resolveImageDisplayUrl(item.imageUrl)),
    [inputImageItems]
  );
  const referencePickerItems = useMemo<ReferencePickerItem[]>(
    () => [
      ...inputImageItems.map((item, index) => ({
        kind: 'image' as const,
        index,
        label: item.label,
        source: item.imageUrl,
      })),
      ...usableInputAudio.map((source, index) => ({
        kind: 'audio' as const,
        index,
        label: resolveAudioLabel(source, index),
        source,
      })),
    ],
    [inputImageItems, resolveAudioLabel, usableInputAudio]
  );
  const removeStudioAudio = useCallback((source: string) => {
    const nextDirectAudio = directReferenceAudio.filter((item) => item !== source);
    const nextUsableAudio = isJimengCli
      ? inputAudio
      : mergeMediaReferenceSources(nextDirectAudio, inputAudio);
    const nextPrompt = remapAudioReferenceTokens(promptDraftRef.current, usableInputAudio, nextUsableAudio);
    promptDraftRef.current = nextPrompt;
    setPromptDraft(nextPrompt);
    cancelPromptCommit();
    updateNodeData(id, { studioReferenceAudio: nextDirectAudio, prompt: nextPrompt });
  }, [cancelPromptCommit, directReferenceAudio, id, inputAudio, isJimengCli, usableInputAudio, updateNodeData]);
  const title = useMemo(() => resolveNodeDisplayName(CANVAS_NODE_TYPES.videoGen, data), [data]);
  const resolvedWidth = Math.max(VIDEO_GEN_NODE_MIN_WIDTH, Math.round(width ?? VIDEO_GEN_NODE_DEFAULT_WIDTH));
  const resolvedHeight = Math.max(VIDEO_GEN_NODE_MIN_HEIGHT, Math.round(height ?? VIDEO_GEN_NODE_DEFAULT_HEIGHT));
  const price = useMemo(
    () => selectedModel && showNodePrice
      ? resolveModelPriceDisplay(selectedModel, {
        resolution: 'video',
        extraParams: { duration: selectedDuration },
        language: i18n.language,
        settings: { displayCurrencyMode: priceDisplayCurrencyMode, usdToCnyRate },
      })
      : null,
    [i18n.language, priceDisplayCurrencyMode, selectedDuration, selectedModel, showNodePrice, usdToCnyRate]
  );

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, resolvedHeight, resolvedWidth, updateNodeInternals]);

  useEffect(() => {
    const externalPrompt = data.prompt ?? '';
    if (externalPrompt !== promptDraftRef.current) {
      promptDraftRef.current = externalPrompt;
      setPromptDraft(externalPrompt);
    }
  }, [data.prompt]);

  useEffect(() => {
    if (imageMode !== 'reference') {
      return;
    }
    const cleanedPrompt = removeOutOfRangeReferenceTokens(
      promptDraftRef.current,
      referenceInputImages.length,
      usableInputAudio.length
    );
    if (cleanedPrompt !== promptDraftRef.current) {
      promptDraftRef.current = cleanedPrompt;
      setPromptDraft(cleanedPrompt);
      cancelPromptCommit();
      updateNodeData(id, { prompt: cleanedPrompt });
    }
  }, [cancelPromptCommit, id, imageMode, referenceInputImages.length, usableInputAudio.length, updateNodeData]);

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
      if (event.key === 'Escape') {
        setPreviewState(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [previewState]);

  useEffect(() => {
    if (!isGenerating || !isJimengCli) {
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{
      client_job_id?: string;
      status?: JimengCliStatus['status'];
      queue_count?: number | null;
      message?: string | null;
    }>('jimeng-cli-status', (event) => {
      const payload = event.payload;
      if (payload.client_job_id !== id || !payload.status) {
        return;
      }
      setJimengCliStatus({
        status: payload.status,
        queueCount: payload.queue_count,
        message: payload.message,
      });
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
      if (rootRef.current?.contains(event.target as globalThis.Node)) {
        return;
      }
      setShowImagePicker(false);
      setPickerCursor(null);
      setShowModelPicker(false);
      setShowDurationSlider(false);
    };
    document.addEventListener('mousedown', handleOutside, true);
    return () => {
      document.removeEventListener('mousedown', handleOutside, true);
    };
  }, []);

  const syncPromptHighlightScroll = () => {
    if (!promptRef.current || !promptHighlightRef.current) {
      return;
    }
    promptHighlightRef.current.scrollTop = promptRef.current.scrollTop;
    promptHighlightRef.current.scrollLeft = promptRef.current.scrollLeft;
  };

  const insertReference = useCallback((item: ReferencePickerItem) => {
    const marker = item.kind === 'image' ? `@图${item.index + 1}` : `@音频${item.index + 1}`;
    let basePrompt = promptDraftRef.current;
    let baseCursor = pickerCursor ?? basePrompt.length;
    // 兜底: 光标前(忽略尾部空格)已是 '@' 时先移除, 避免插入后出现 '@@图N'
    const trimmedBefore = basePrompt.slice(0, baseCursor).replace(/\s+$/, '');
    if (trimmedBefore.endsWith('@')) {
      const atIndex = trimmedBefore.length - 1;
      basePrompt = basePrompt.slice(0, atIndex) + basePrompt.slice(atIndex + 1);
      baseCursor = atIndex;
    }
    const { nextText, nextCursor } = insertReferenceToken(basePrompt, baseCursor, marker);
    promptDraftRef.current = nextText;
    setPromptDraft(nextText);
    cancelPromptCommit();
    updateNodeData(id, { prompt: nextText });
    setShowImagePicker(false);
    setPickerCursor(null);
    setPickerActiveIndex(0);
    requestAnimationFrame(() => {
      promptRef.current?.focus();
      promptRef.current?.setSelectionRange(nextCursor, nextCursor);
      syncPromptHighlightScroll();
    });
  }, [cancelPromptCommit, id, pickerCursor, updateNodeData]);

  const handlePromptKeyDown = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Backspace' || event.key === 'Delete') {
      const currentPrompt = promptDraftRef.current;
      const selectionStart = event.currentTarget.selectionStart ?? currentPrompt.length;
      const selectionEnd = event.currentTarget.selectionEnd ?? selectionStart;
      const deletionDirection = event.key === 'Backspace' ? 'backward' : 'forward';
      const deleteRange = resolveReferenceAwareDeleteRange(
        currentPrompt,
        selectionStart,
        selectionEnd,
        deletionDirection,
        referenceInputImages.length,
        usableInputAudio.length
      );
      if (deleteRange) {
        event.preventDefault();
        const { nextText, nextCursor } = removeTextRange(currentPrompt, deleteRange);
        promptDraftRef.current = nextText;
        setPromptDraft(nextText);
        cancelPromptCommit();
        updateNodeData(id, { prompt: nextText });
        requestAnimationFrame(() => {
          promptRef.current?.focus();
          promptRef.current?.setSelectionRange(nextCursor, nextCursor);
          syncPromptHighlightScroll();
        });
        return;
      }
    }

    if (showImagePicker && referencePickerItems.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setPickerActiveIndex((current) => (current + 1) % referencePickerItems.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setPickerActiveIndex((current) => (current + referencePickerItems.length - 1) % referencePickerItems.length);
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const activeItem = referencePickerItems[pickerActiveIndex];
        if (activeItem) {
          insertReference(activeItem);
        }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setShowImagePicker(false);
        setPickerCursor(null);
        return;
      }
    }

    const isAtKey = event.key === '@' || (event.shiftKey && event.code === 'Digit2');
    if (isAtKey && !event.ctrlKey && !event.metaKey && !event.altKey && referencePickerItems.length > 0) {
      event.preventDefault();
      const cursor = event.currentTarget.selectionStart ?? promptDraftRef.current.length;
      setPickerAnchor(resolvePickerAnchor(rootRef.current, event.currentTarget, cursor));
      setPickerCursor(cursor);
      setPickerActiveIndex(0);
      setShowImagePicker(true);
    }
  }, [cancelPromptCommit, id, insertReference, pickerActiveIndex, referenceInputImages.length, referencePickerItems, showImagePicker, usableInputAudio.length, updateNodeData]);

  const handleFrameFileChange = useCallback(async (
    slot: FrameSlot,
    event: ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !file.type.startsWith('image/')) {
      return;
    }
    try {
      const prepared = await prepareNodeImageFromFile(file);
      updateNodeData(id, slot === 'first'
        ? {
          firstFrameImageUrl: prepared.imageUrl,
          firstFramePreviewImageUrl: prepared.previewImageUrl,
        }
        : {
          lastFrameImageUrl: prepared.imageUrl,
          lastFramePreviewImageUrl: prepared.previewImageUrl,
        });
      setError(null);
    } catch (uploadError) {
      const resolved = resolveErrorContent(uploadError, '图片上传失败');
      setError(resolved.message);
      void showErrorDialog(resolved.message, t('common.error'), resolved.details);
    }
  }, [id, t, updateNodeData]);

  const openFrameFilePicker = useCallback((slot: FrameSlot) => {
    if (slot === 'first') {
      firstFrameInputRef.current?.click();
      return;
    }
    lastFrameInputRef.current?.click();
  }, []);

  const clearFrame = useCallback((slot: FrameSlot) => {
    updateNodeData(id, slot === 'first'
      ? {
        firstFrameImageUrl: null,
        firstFramePreviewImageUrl: null,
      }
      : {
        lastFrameImageUrl: null,
        lastFramePreviewImageUrl: null,
      });
    setError(null);
  }, [id, updateNodeData]);

  const handleGenerate = useCallback(async () => {
    if (!selectedModel) {
      const message = '请先在设置中添加视频模型';
      setError(message);
      void showErrorDialog(message, t('common.error'));
      return;
    }
    flushPromptCommit();
    const prompt = [
      promptDraftRef.current.trim(),
      ...inputText,
    ].filter(Boolean).join('\n\n').trim();
    if (!prompt) return;
    if (imageMode === 'first-last' && firstLastFrameImages.length < 2) {
      const message = t('node.videoGen.firstLastNeedImages');
      setError(message);
      void showErrorDialog(message, t('common.error'));
      return;
    }
    const apiKey = apiKeys[selectedModel.providerId] ?? '';
    if (!isJimengCli && !apiKey) {
      const message = '请在设置中填写 API Key';
      setError(message);
      void showErrorDialog(message, t('common.error'));
      return;
    }
    const customId = selectedModel.providerId.slice('custom:'.length);
    const baseUrl = isJimengCli ? undefined : customApis.find((api) => api.id === customId)?.baseUrl;
    // 立即创建下游视频节点(生成中状态), 成功后再填充视频地址, 失败时把错误写入节点。
    // 与 AI 图片节点一致: 点击生成即出现结果节点 + 连线, 报错信息显示在节点上。
    // 尺寸采用与图片结果节点相同的紧凑算法, 避免下游节点过大。
    const generationStartedAt = Date.now();
    const compactSize = resolveMinEdgeFittedSize(data.aspectRatio, {
      minWidth: EXPORT_RESULT_NODE_MIN_WIDTH,
      minHeight: EXPORT_RESULT_NODE_MIN_HEIGHT,
    });
    const outputId = addNode(CANVAS_NODE_TYPES.audio, findNodePosition(id, 360, 240), {
      displayName: prompt,
      mediaType: 'video',
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
      generationRequest: {
        kind: 'video',
        // 作为支持幂等提交的平台的稳定请求键。重试同一个节点时复用，避免
        // 网络超时后重复创建任务或重复扣费。
        clientJobId: id,
        prompt,
        model: selectedModel.id,
        duration: selectedDuration,
        aspectRatio: data.aspectRatio,
        videoResolution: selectedVideoResolution,
        imageMode,
        referenceImages: videoReferenceImages,
        referenceAudio: resolvedInputAudio,
        extraParams: {},
      },
    });
    updateNodeSize(outputId, compactSize.width, compactSize.height);
    addEdge(id, outputId);
    setIsGenerating(true);
    setJimengCliStatus(isJimengCli ? { status: 'queued' } : null);
    setError(null);
    try {
      if (!isJimengCli) {
        await canvasAiGateway.setApiKey(selectedModel.providerId, apiKey);
      }
      const videoUrl = await canvasAiGateway.generateVideo({
        clientJobId: id,
        prompt,
        model: selectedModel.id,
        duration: selectedDuration,
        aspectRatio: data.aspectRatio,
        videoResolution: selectedVideoResolution,
        imageMode,
        referenceImages: videoReferenceImages,
        referenceAudio: resolvedInputAudio,
        extraParams: {},
      });
      recordGenerationOutcome({
        nodeId: outputId,
        kind: 'video',
        providerId: selectedModel.providerId,
        modelId: selectedModel.id,
        size: selectedVideoResolution,
        duration: selectedDuration,
        referenceCount: videoReferenceImages.length,
        status: 'succeeded',
        durationMs: Date.now() - generationStartedAt,
      });
      updateNodeData(outputId, {
        sourcePath: videoUrl,
        generationResultProtected: true,
        isGenerating: false,
        generationStartedAt: null,
        generationError: null,
        generationErrorDetails: null,
        generationClientSessionId: null,
        generationRequest: undefined,
      });
    } catch (generationError) {
      const resolved = resolveErrorContent(generationError, '视频生成失败');
      setError(resolved.message);
      recordGenerationOutcome({
        nodeId: outputId,
        kind: 'video',
        providerId: selectedModel.providerId,
        modelId: selectedModel.id,
        size: selectedVideoResolution,
        duration: selectedDuration,
        referenceCount: videoReferenceImages.length,
        status: 'failed',
        errorMessage: resolved.message,
        durationMs: Date.now() - generationStartedAt,
      });
      updateNodeData(outputId, {
        isGenerating: false,
        generationStartedAt: null,
        generationError: resolved.message,
        generationErrorDetails: resolved.details ?? null,
        generationClientSessionId: null,
      });
      void showErrorDialog(resolved.message, t('common.error'), resolved.details);
    } finally {
      setIsGenerating(false);
    }
  }, [addEdge, addNode, apiKeys, customApis, data.aspectRatio, findNodePosition, firstLastFrameImages.length, flushPromptCommit, id, imageMode, inputText, resolvedInputAudio, selectedDuration, selectedModel, selectedProfile, selectedVideoResolution, t, updateNodeData, updateNodeSize, videoReferenceImages]);

  return (
    <div
      ref={rootRef}
      className={`relative flex h-full flex-col gap-2 overflow-visible rounded-[var(--node-radius)] border bg-surface-dark/90 p-3 ${selected ? 'border-accent shadow-[0_0_0_1px_rgba(59,130,246,0.32)]' : 'border-[rgba(255,255,255,0.18)]'}`}
      style={{ width: `${resolvedWidth}px`, height: `${resolvedHeight}px` }}
    >
      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<Clapperboard className="h-4 w-4" />}
        titleText={title}
        editable
        onTitleChange={(displayName) => updateNodeData(id, { displayName })}
        rightSlot={price ? <NodePriceBadge label={price.label} title={price.nativeLabel} /> : null}
      />
      <div className="relative min-h-0 flex-1 rounded-md border border-border-dark bg-bg-dark/60">
        <div className="relative h-full min-h-0">
          <div
            ref={promptHighlightRef}
            aria-hidden="true"
            className="ui-scrollbar pointer-events-none absolute inset-0 z-20 overflow-y-auto overflow-x-hidden text-xs leading-5 text-text-dark"
            style={{ scrollbarGutter: 'stable' }}
          >
            <div className="min-h-full whitespace-pre-wrap break-words p-2">
              {renderPromptWithHighlights(
                promptDraft,
                referenceInputImages.length,
                resolvedInputAudio.length,
                inputImageDisplayUrls,
                usableInputAudio,
                resolveAudioLabel,
                (displayUrl, event) => {
                  setPreviewState({ url: displayUrl, x: event.clientX, y: event.clientY });
                  setPreviewSize(null);
                }
              )}
            </div>
          </div>
          <textarea
            ref={promptRef}
            value={promptDraft}
            onChange={(event) => {
              const nextValue = event.target.value;
              promptDraftRef.current = nextValue;
              setPromptDraft(nextValue);
              schedulePromptCommit();
            }}
            onBlur={flushPromptCommit}
            onKeyDown={handlePromptKeyDown}
            onScroll={syncPromptHighlightScroll}
            onMouseDown={(event) => event.stopPropagation()}
            placeholder="描述要生成的视频"
            className={`ui-scrollbar nodrag nowheel relative z-10 h-full w-full resize-none overflow-y-auto overflow-x-hidden border-none bg-transparent p-2 text-xs leading-5 text-transparent caret-text-dark outline-none placeholder:text-text-muted/80 focus:border-transparent whitespace-pre-wrap break-words [font-family:inherit] ${inputText.length > 0 ? 'pb-20' : ''}`}
            style={{ scrollbarGutter: 'stable' }}
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
          <div
            className="nowheel absolute z-30 w-[120px] overflow-hidden rounded-xl border border-[rgba(255,255,255,0.16)] bg-surface-dark shadow-xl"
            style={{ left: pickerAnchor.left, top: pickerAnchor.top }}
            onMouseDown={(event) => event.stopPropagation()}
            onWheelCapture={(event) => event.stopPropagation()}
          >
            {referencePickerItems.map((item, index) => (
              <button
                key={`${item.kind}-${item.source}-${index}`}
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  insertReference(item);
                }}
                onMouseEnter={() => setPickerActiveIndex(index)}
                className={`flex w-full items-center gap-2 border border-transparent bg-bg-dark/70 px-2 py-2 text-left text-xs text-text-dark transition-colors hover:border-[rgba(255,255,255,0.18)] ${pickerActiveIndex === index
                    ? 'border-[rgba(255,255,255,0.24)] bg-bg-dark'
                    : ''
                  }`}
              >
                {item.kind === 'image' ? (
                  <CanvasNodeImage
                    src={inputImageDisplayUrls[item.index]}
                    alt={item.label}
                    viewerSourceUrl={resolveImageDisplayUrl(item.source)}
                    viewerImageList={inputImageViewerList}
                    className="h-7 w-7 rounded object-cover"
                    draggable={false}
                  />
                ) : (
                  <span className="flex h-7 w-7 items-center justify-center rounded bg-accent/15 text-accent">
                    <AudioLines className="h-4 w-4" />
                  </span>
                )}
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {directReferenceAudio.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-[11px] text-text-muted">
          <AudioLines className="h-3.5 w-3.5 text-accent" />
          <span>{isJimengCli ? '工作室音频（即梦不使用）' : '工作室音频'}</span>
          {directReferenceAudio.map((source, index) => (
            <button
              key={`${source}-${index}`}
              type="button"
              className="nodrag inline-flex max-w-[150px] items-center gap-1 rounded border border-border-dark px-1.5 py-0.5 text-[10px] text-text-dark hover:border-accent"
              title="移除这段工作室音频引用"
              onClick={(event) => {
                event.stopPropagation();
                removeStudioAudio(source);
              }}
            >
              <span className="truncate">{resolveAudioLabel(source, index)}</span>
              <Trash2 className="h-3 w-3 shrink-0" />
            </button>
          ))}
        </div>
      )}
      {usableInputAudio.length > 0 && (
        <div className="flex items-center gap-1 text-[11px] text-text-muted">
          <AudioLines className="h-3.5 w-3.5 text-accent" />
          <span>已连接 {usableInputAudio.length} 段音频</span>
        </div>
      )}
      <div className="flex items-center gap-1" role="group" aria-label={t('node.videoGen.imageMode')}>
        <button
          type="button"
          className={`nodrag h-7 rounded-md border px-2 text-[11px] transition-colors ${imageMode === 'reference'
            ? 'border-accent/50 bg-accent/15 text-text-dark'
            : 'border-border-dark bg-bg-dark text-text-muted hover:text-text-dark'
            }`}
          onClick={(event) => {
            event.stopPropagation();
            updateNodeData(id, { imageMode: 'reference' });
          }}
        >
          {t('node.videoGen.referenceMode')}
        </button>
        <button
          type="button"
          className={`nodrag h-7 rounded-md border px-2 text-[11px] transition-colors ${imageMode === 'first-last'
            ? 'border-accent/50 bg-accent/15 text-text-dark'
            : 'border-border-dark bg-bg-dark text-text-muted hover:text-text-dark'
            }`}
          onClick={(event) => {
            event.stopPropagation();
            updateNodeData(id, { imageMode: 'first-last' });
          }}
        >
          {t('node.videoGen.firstLastMode')}
        </button>
        {imageMode === 'first-last' && (
          <span className="min-w-0 truncate text-[11px] text-text-muted">
            {t('node.videoGen.firstLastHint')}
          </span>
        )}
      </div>
      {imageMode === 'first-last' && (
        <div className="grid grid-cols-2 gap-2">
          <div className="min-w-0">
            <span className="mb-1 block text-[11px] text-text-muted">{t('node.videoGen.firstFrame')}</span>
            <div className="relative h-[68px]">
              <button
                type="button"
                className="nodrag flex h-full w-full items-center justify-center overflow-hidden rounded-md border border-dashed border-border-dark bg-bg-dark text-text-muted transition-colors hover:border-accent/60 hover:bg-accent/5 hover:text-text-dark"
                onClick={(event) => {
                  event.stopPropagation();
                  openFrameFilePicker('first');
                }}
                onMouseDown={(event) => event.stopPropagation()}
                title={data.firstFrameImageUrl
                  ? t('node.videoGen.replaceFirstFrame')
                  : t('node.videoGen.uploadFirstFrame')}
                aria-label={data.firstFrameImageUrl
                  ? t('node.videoGen.replaceFirstFrame')
                  : t('node.videoGen.uploadFirstFrame')}
              >
                {data.firstFrameImageUrl ? (
                  <CanvasNodeImage
                    src={resolveImageDisplayUrl(data.firstFramePreviewImageUrl || data.firstFrameImageUrl)}
                    alt={t('node.videoGen.firstFrame')}
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
                      openFrameFilePicker('first');
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    title={t('node.videoGen.replaceFirstFrame')}
                    aria-label={t('node.videoGen.replaceFirstFrame')}
                  >
                    <ImagePlus className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="nodrag flex h-6 w-6 items-center justify-center rounded border border-white/20 bg-black/65 text-white transition-colors hover:bg-red-700/85"
                    onClick={(event) => {
                      event.stopPropagation();
                      clearFrame('first');
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    title={t('node.videoGen.removeFirstFrame')}
                    aria-label={t('node.videoGen.removeFirstFrame')}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="min-w-0">
            <span className="mb-1 block text-[11px] text-text-muted">{t('node.videoGen.lastFrame')}</span>
            <div className="relative h-[68px]">
              <button
                type="button"
                className="nodrag flex h-full w-full items-center justify-center overflow-hidden rounded-md border border-dashed border-border-dark bg-bg-dark text-text-muted transition-colors hover:border-accent/60 hover:bg-accent/5 hover:text-text-dark"
                onClick={(event) => {
                  event.stopPropagation();
                  openFrameFilePicker('last');
                }}
                onMouseDown={(event) => event.stopPropagation()}
                title={data.lastFrameImageUrl
                  ? t('node.videoGen.replaceLastFrame')
                  : t('node.videoGen.uploadLastFrame')}
                aria-label={data.lastFrameImageUrl
                  ? t('node.videoGen.replaceLastFrame')
                  : t('node.videoGen.uploadLastFrame')}
              >
                {data.lastFrameImageUrl ? (
                  <CanvasNodeImage
                    src={resolveImageDisplayUrl(data.lastFramePreviewImageUrl || data.lastFrameImageUrl)}
                    alt={t('node.videoGen.lastFrame')}
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
                      openFrameFilePicker('last');
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    title={t('node.videoGen.replaceLastFrame')}
                    aria-label={t('node.videoGen.replaceLastFrame')}
                  >
                    <ImagePlus className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="nodrag flex h-6 w-6 items-center justify-center rounded border border-white/20 bg-black/65 text-white transition-colors hover:bg-red-700/85"
                    onClick={(event) => {
                      event.stopPropagation();
                      clearFrame('last');
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    title={t('node.videoGen.removeLastFrame')}
                    aria-label={t('node.videoGen.removeLastFrame')}
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
            onChange={(event) => void handleFrameFileChange('first', event)}
          />
          <input
            ref={lastFrameInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(event) => void handleFrameFileChange('last', event)}
          />
        </div>
      )}
      <div className={`grid gap-1.5 ${imageMode === 'first-last'
        ? (resolutionOptions.length > 0 ? 'grid-cols-[minmax(0,1fr)_58px_72px]' : 'grid-cols-[minmax(0,1fr)_78px]')
        : (resolutionOptions.length > 0 ? 'grid-cols-[minmax(0,1fr)_58px_58px_72px]' : 'grid-cols-[minmax(0,1fr)_72px_78px]')}`}>
        <div className="relative min-w-0">
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
            aria-label={t('modelParams.model')}
          >
            <span className="min-w-0 truncate">
              {selectedModelName || (models.length === 0 ? '请先配置视频模型' : '')}
            </span>
            <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${showModelPicker ? 'rotate-180' : ''}`} />
          </button>
          {showModelPicker && (
            <div
              className="nodrag nowheel absolute left-0 top-[calc(100%+6px)] z-30 w-[320px] max-w-[calc(100vw-32px)] rounded-lg border border-[rgba(255,255,255,0.16)] bg-surface-dark p-3 shadow-xl"
              onMouseDown={(event) => event.stopPropagation()}
              onWheelCapture={(event) => event.stopPropagation()}
            >
              {models.length === 0 ? (
                <div className="text-xs text-text-muted">请先在设置中配置视频模型</div>
              ) : (
                <div className="ui-scrollbar max-h-[300px] space-y-3 overflow-y-auto">
                  <section>
                    <div className="mb-2 text-xs font-medium text-text-muted">{t('modelParams.provider')}</div>
                    <div className="flex flex-wrap gap-1.5">
                      {videoModelProviders.map((provider) => {
                        const active = provider.id === modelPickerProviderId;
                        return (
                          <button
                            key={provider.id}
                            type="button"
                            className={`h-8 rounded-lg border px-3 text-xs transition-colors ${active
                              ? 'border-accent/50 bg-accent/15 text-text-dark'
                              : 'border-[rgba(255,255,255,0.12)] bg-bg-dark/65 text-text-muted hover:border-[rgba(255,255,255,0.2)]'
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
                    <div className="mb-2 text-xs font-medium text-text-muted">{t('modelParams.model')}</div>
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
                            className={`min-h-8 max-w-full rounded-lg border px-3 py-1.5 text-xs leading-4 transition-colors ${active
                              ? 'border-accent/50 bg-accent/15 text-text-dark'
                              : 'border-[rgba(255,255,255,0.12)] bg-bg-dark/65 text-text-muted hover:border-[rgba(255,255,255,0.2)] hover:bg-[rgba(255,255,255,0.05)]'
                              }`}
                            onClick={(event) => {
                              event.stopPropagation();
                              updateNodeData(id, { model: model.id });
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
            </div>
          )}
        </div>
        {imageMode !== 'first-last' && (
          <select className="nodrag h-8 rounded border border-border-dark bg-bg-dark px-1 text-xs text-text-dark" value={data.aspectRatio} onChange={(event) => {
            setShowModelPicker(false);
            updateNodeData(id, { aspectRatio: event.target.value });
          }}>
            {(selectedModel?.aspectRatios ?? []).map((ratio) => <option key={ratio.value} value={ratio.value}>{ratio.label}</option>)}
          </select>
        )}
        {resolutionOptions.length > 0 && (
          <select
            className="nodrag h-8 rounded border border-border-dark bg-bg-dark px-1 text-xs text-text-dark"
            value={selectedVideoResolution}
            onChange={(event) => {
              setShowModelPicker(false);
              updateNodeData(id, { resolution: event.target.value });
            }}
            aria-label="视频分辨率"
          >
            {resolutionOptions.map((resolution) => (
              <option key={resolution.value} value={resolution.value}>{resolution.label}</option>
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
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showDurationSlider ? 'rotate-180' : ''}`} />
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
                onChange={(event) => updateNodeData(id, { duration: Number(event.target.value) })}
                className="nodrag nowheel h-1.5 w-full cursor-pointer appearance-none rounded-full bg-border-dark [accent-color:var(--color-accent)]"
                aria-label="视频时长（秒）"
              />
            </div>
          )}
        </div>
      </div>
      {isJimengCli && isGenerating && jimengCliStatus && (
        <div className="text-[11px] text-text-muted">
          {jimengCliStatus.status === 'queued'
            ? `排队中${typeof jimengCliStatus.queueCount === 'number' ? ` · 当前排队 ${jimengCliStatus.queueCount}` : ''}`
            : jimengCliStatus.status === 'running'
              ? '已进入生成阶段，无法取消'
              : '即梦 CLI 处理中'}
          {jimengCliStatus.status === 'queued' && (
            <span className="ml-1 text-text-muted/70">（CLI 未提供远端取消功能）</span>
          )}
        </div>
      )}
      {selectedProfile && !isJimengCli && (
        <span className={`text-[11px] ${selectedProfile.status === 'verified' ? 'text-text-muted' : 'text-amber-400'}`}>
          {selectedProfile.protocolLabel}
        </span>
      )}
      {error && <span className="line-clamp-2 text-[11px] text-red-400">{error}</span>}
      <button type="button" disabled={isGenerating || !selectedModel || (!promptDraft.trim() && inputText.length === 0)} onClick={() => void handleGenerate()} className="nodrag mt-auto flex h-8 items-center justify-center gap-1.5 rounded-md bg-accent text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-45">
        {isGenerating ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
        {isGenerating ? '生成中…' : '生成视频'}
      </button>
      <Handle id="target" type="target" position={Position.Left} className="!h-2 !w-2 !border-surface-dark !bg-accent" />
      <Handle id="source" type="source" position={Position.Right} className="!h-2 !w-2 !border-surface-dark !bg-accent" />
      <NodeResizeHandle minWidth={VIDEO_GEN_NODE_MIN_WIDTH} minHeight={VIDEO_GEN_NODE_MIN_HEIGHT} maxWidth={VIDEO_GEN_NODE_MAX_WIDTH} maxHeight={VIDEO_GEN_NODE_MAX_HEIGHT} />
      {previewState && createPortal(
        <>
          <div className="fixed inset-0 z-[190]" onClick={() => setPreviewState(null)} />
          <div
            className="fixed z-[200] overflow-hidden rounded-lg border border-[rgba(255,255,255,0.16)] bg-black/60 shadow-2xl"
            style={{
              width: previewSize?.width ?? REFERENCE_PREVIEW_WIDTH,
              height: previewSize?.height ?? REFERENCE_PREVIEW_ESTIMATED_HEIGHT,
              left: resolvePreviewLeft(
                previewState.x,
                previewSize?.width ?? REFERENCE_PREVIEW_WIDTH
              ),
              top: resolvePreviewTop(
                previewState.y,
                previewSize?.height ?? REFERENCE_PREVIEW_ESTIMATED_HEIGHT
              ),
              transformOrigin: 'left center',
              animation: 'reference-preview-pop 0.16s ease-out',
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
        document.body
      )}
    </div>
  );
});

VideoGenNode.displayName = 'VideoGenNode';
