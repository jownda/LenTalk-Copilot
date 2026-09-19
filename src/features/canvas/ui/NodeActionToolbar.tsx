import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NodeToolbar as ReactFlowNodeToolbar } from '@xyflow/react';
import { Camera, Copy, Crop, Download, FileText, Library, Maximize2, PenLine, RefreshCw, RotateCw, Scissors, SlidersHorizontal, Sparkles, Trash2, Unlink2, LayoutTemplate } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  CANVAS_NODE_TYPES,
  DEFAULT_ASPECT_RATIO,
  EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  NODE_TOOL_TYPES,
  isExportImageNode,
  isGroupNode,
  isImageEditNode,
  isAudioNode,
  isStoryboardGenNode,
  isStoryboardSplitNode,
  isUploadNode,
  type CanvasNode,
  type NodeToolType,
} from '@/features/canvas/domain/canvasNodes';
import { canvasAiGateway, canvasEventBus } from '@/features/canvas/application/canvasServices';
import { getNodeToolPlugins } from '@/features/canvas/tools';
import type { ToolIconKey } from '@/features/canvas/tools';
import { UiChipButton, UiPanel, UiModal, UiButton } from '@/components/ui';
import { useSettingsStore } from '@/stores/settingsStore';
import { resolveZhiniaoUpscaleCredentials } from '@/commands/ai';
import { useCanvasStore } from '@/stores/canvasStore';
import { sanitizeStoryboardText } from '@/features/canvas/application/storyboardText';
import {
  buildGenerationErrorReport,
  CURRENT_RUNTIME_SESSION_ID,
} from '@/features/canvas/application/generationErrorReport';
import { showErrorDialog } from '@/features/canvas/application/errorDialog';
import { saveMediaSourceWithDialog } from '@/features/canvas/application/mediaDownload';
import { importVideoUrlToAsset } from '@/features/library/importAssets';
import { buildTemplateFromCanvas, createTemplateFromCanvas, validateTemplateChain } from '@/features/templates/createTemplate';
import { UiInput, UiTextArea } from '@/components/ui/primitives';
import { PajubenQuickExtractDialog } from '@/features/pajuben/PajubenQuickExtractDialog';
import { useAssetLibraryStore } from '@/features/library/assetStore';
import {
  JIMENG_CLI_IMAGE_UPSCALE_MODEL_ID,
  listImageUpscaleModels,
  resolveImageModelResolutions,
  type ImageModelDefinition,
} from '@/features/canvas/models';
import {
  NODE_TOOLBAR_ALIGN,
  NODE_TOOLBAR_CLASS,
  NODE_TOOLBAR_OFFSET,
  NODE_TOOLBAR_POSITION,
} from './nodeToolbarConfig';

interface NodeActionToolbarProps {
  node: CanvasNode;
}

const REFERENCE_ENCODINGS = ['data_url', 'raw_base64', 'url'] as const;

function isReferenceEncodingError(message: string): boolean {
  return /(invalid\s+base64|base64\s+(?:format|decode)|invalid\s+(?:image|media)\s+format|failed\s+to\s+parse\s+request\s+body|unsupported\s+(?:image|reference)\s+(?:field|format)|(?:编码|格式).*(?:不匹配|错误|base64|参考图)|(?:base64|参考图).*(?:编码|格式))/i.test(message);
}

function prepareEncodingRetry(node: CanvasNode, errorMessage: string): Record<string, unknown> | undefined {
  if (!isReferenceEncodingError(errorMessage)) return undefined;
  const data = node.data as Record<string, unknown>;
  const request = data.generationRequest;
  if (!request || typeof request !== 'object') return undefined;
  const requestRecord = request as Record<string, unknown>;
  const extras = requestRecord.extraParams && typeof requestRecord.extraParams === 'object'
    ? { ...(requestRecord.extraParams as Record<string, unknown>) }
    : {};
  const isVideo = requestRecord.kind === 'video';
  const key = isVideo ? 'video_reference_encoding' : 'reference_image_encoding';
  const fieldKey = isVideo ? undefined : 'reference_image_field';
  const configured = typeof extras[key] === 'string' ? String(extras[key]).toLowerCase() : 'auto';
  const field = fieldKey && extras[fieldKey] === 'input_image' ? 'input_image' : 'image';
  const current = configured === 'raw_base64' || configured === 'data_url' || configured === 'url'
    ? configured
    : field === 'input_image' ? 'raw_base64' : 'data_url';
  const currentIndex = REFERENCE_ENCODINGS.indexOf(current as (typeof REFERENCE_ENCODINGS)[number]);
  const retryCount = typeof data.generationEncodingRetryCount === 'number'
    ? data.generationEncodingRetryCount
    : 0;
  if (retryCount >= REFERENCE_ENCODINGS.length - 1 || currentIndex < 0) return undefined;
  extras[key] = REFERENCE_ENCODINGS[currentIndex + 1];
  return {
    generationRequest: { ...requestRecord, extraParams: extras },
    generationEncodingRetryCount: retryCount + 1,
  };
}

const toolIconMap: Record<ToolIconKey, typeof Crop> = {
  crop: Crop,
  annotate: PenLine,
  split: Scissors,
  rotate: RotateCw,
  adjust: SlidersHorizontal,
};

const TOOLBAR_BUTTON_RADIUS_CLASS = 'rounded-full';
const TOOLBAR_NEUTRAL_BUTTON_CLASS =
  'border-[rgba(255,255,255,0.18)] bg-bg-dark/70 text-text-dark hover:border-[rgba(255,255,255,0.32)] hover:bg-bg-dark';

export const NodeActionToolbar = memo(({ node }: NodeActionToolbarProps) => {
  const { t, i18n } = useTranslation();
  const isImageEdit = isImageEditNode(node);
  // AI 生成视频与本地上传视频最终都落在同一个媒体节点，统一开放视频工具栏。
  const isVideoMediaNode = isAudioNode(node) && node.data.mediaType === 'video';
  const isStoryboardGen = isStoryboardGenNode(node);
  const isStoryboardSplit = isStoryboardSplitNode(node);
  const canCopyStoryboardText = isStoryboardGen || isStoryboardSplit;
  const tools = useMemo(() => getNodeToolPlugins(node), [node]);
  const deleteNode = useCanvasStore((state) => state.deleteNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const canvasNodes = useCanvasStore((state) => state.nodes);
  const canvasEdges = useCanvasStore((state) => state.edges);
  const ungroupNode = useCanvasStore((state) => state.ungroupNode);
  const addNode = useCanvasStore((state) => state.addNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const findNodePosition = useCanvasStore((state) => state.findNodePosition);
  const apiKeys = useSettingsStore((state) => state.apiKeys);
  const canReupload = isUploadNode(node) && Boolean(node.data.imageUrl);
  const canReuploadMedia = isAudioNode(node) && Boolean(node.data.sourcePath);
  const libraries = useAssetLibraryStore((state) => state.libraries);
  const categories = useAssetLibraryStore((state) => state.categories);
  const activeLibraryId = useAssetLibraryStore((state) => state.activeLibraryId);
  const addAssets = useAssetLibraryStore((state) => state.addAssets);
  const ignoreAtTagWhenCopyingAndGenerating = useSettingsStore(
    (state) => state.ignoreAtTagWhenCopyingAndGenerating
  );
  const [isLibraryDialogOpen, setIsLibraryDialogOpen] = useState(false);
  const [isUpscaleDialogOpen, setIsUpscaleDialogOpen] = useState(false);
  const [isImageUpscaleDialogOpen, setIsImageUpscaleDialogOpen] = useState(false);
  const [videoUpscaleTier, setVideoUpscaleTier] = useState<string>('1080p');
  const [isUpscalingVideo, setIsUpscalingVideo] = useState(false);
  // 超分模型固定为知鸟 aliyun-video-superres。
  const VIDEO_UPSCALE_MODEL_ID = 'custom:zhiniao/aliyun-video-superres';
  const [imageUpscaleModelId, setImageUpscaleModelId] = useState<string>(
    JIMENG_CLI_IMAGE_UPSCALE_MODEL_ID
  );
  const [imageUpscaleResolution, setImageUpscaleResolution] = useState<string>('');
  // 「更换模型」列表默认收起: 弹窗只显示当前高清模型, 避免一屏模型铺开。
  const [isUpscaleModelPickerOpen, setIsUpscaleModelPickerOpen] = useState(false);
  const [isUpscalingImage, setIsUpscalingImage] = useState(false);
  const [isSavingToLibrary, setIsSavingToLibrary] = useState(false);
  const [isCopyTextSuccess, setIsCopyTextSuccess] = useState(false);
  // 「扒视频」：从视频节点直接跑一次最精简的扒剧本，结果落成右侧文本节点
  const [isScriptDialogOpen, setIsScriptDialogOpen] = useState(false);
  const [isCopyErrorSuccess, setIsCopyErrorSuccess] = useState(false);
  const [isTemplateDialogOpen, setIsTemplateDialogOpen] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [templateDescription, setTemplateDescription] = useState('');
  const [isSavingTemplate, setIsSavingTemplate] = useState(false);
  const [templateNotice, setTemplateNotice] = useState<string | null>(null);
  const copyTextFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyErrorFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const imageSource = useMemo(() => {
    if (isUploadNode(node) || isImageEditNode(node) || isExportImageNode(node)) {
      return node.data.imageUrl || node.data.previewImageUrl || null;
    }
    return null;
  }, [node]);
  const videoSource = isVideoMediaNode
    ? ((node.data as { sourcePath?: string | null }).sourcePath ?? null)
    : null;
  const canSaveVideoTemplate = isVideoMediaNode
    && Boolean(videoSource)
    && Boolean((node.data as { generationModel?: string | null }).generationModel || (node.data as { generationResultProtected?: boolean }).generationResultProtected);
  const templateDraft = useMemo(() => {
    if (!canSaveVideoTemplate || !videoSource) return null;
    try { return validateTemplateChain(buildTemplateFromCanvas(node, canvasNodes, canvasEdges)); } catch { return { valid: false, missing: ['生成链路'] }; }
  }, [canSaveVideoTemplate, canvasEdges, canvasNodes, node, videoSource]);
  const downloadSource = imageSource || videoSource;
  const canHandleMedia = Boolean(downloadSource);
  // 「图片高清」只对带图的图片类节点开放(AI 图片节点自己那排按钮走的是另一套渲染)。
  const canUpscaleImage = !isImageEdit && Boolean(imageSource) && !videoSource;
  const upscaleModelOptions = useMemo<ImageModelDefinition[]>(
    () => (isImageUpscaleDialogOpen ? listImageUpscaleModels() : []),
    [isImageUpscaleDialogOpen]
  );
  const selectedUpscaleModel = useMemo(
    () =>
      upscaleModelOptions.find((model) => model.id === imageUpscaleModelId)
      ?? upscaleModelOptions[0]
      ?? null,
    [imageUpscaleModelId, upscaleModelOptions]
  );
  const upscaleResolutionOptions = useMemo(
    () => (selectedUpscaleModel ? resolveImageModelResolutions(selectedUpscaleModel) : []),
    [selectedUpscaleModel]
  );
  // 档位随模型变 —— 换模型后原档位可能不被支持, 这里收敛到该模型的首档。
  const resolvedUpscaleResolution = upscaleResolutionOptions.some(
    (option) => option.value === imageUpscaleResolution
  )
    ? imageUpscaleResolution
    : (selectedUpscaleModel?.defaultResolution ?? upscaleResolutionOptions[0]?.value ?? '2K');
  const handleUpscaleImage = useCallback(async () => {
    if (!imageSource || !selectedUpscaleModel || isUpscalingImage) {
      return;
    }

    const isJimengUpscale = selectedUpscaleModel.id === JIMENG_CLI_IMAGE_UPSCALE_MODEL_ID;
    if (!isJimengUpscale && !(apiKeys[selectedUpscaleModel.providerId] ?? '').trim()) {
      const message = t('nodeToolbar.imageUpscaleApiKeyMissing');
      void showErrorDialog(message, t('common.error'));
      return;
    }

    setIsUpscalingImage(true);
    // 超分要保住原图比例: 优先沿用节点自身的画幅, 没有就用默认值。
    const aspectRatio =
      typeof node.data.aspectRatio === 'string' && node.data.aspectRatio.trim()
        ? node.data.aspectRatio
        : DEFAULT_ASPECT_RATIO;
    const prompt = isJimengUpscale ? '' : t('nodeToolbar.imageUpscalePrompt');
    const requestModel = selectedUpscaleModel.resolveRequest({ referenceImageCount: 1 }).requestModel;
    const newNodeId = addNode(
      CANVAS_NODE_TYPES.exportImage,
      findNodePosition(node.id, EXPORT_RESULT_NODE_DEFAULT_WIDTH, EXPORT_RESULT_NODE_LAYOUT_HEIGHT),
      {
        isGenerating: true,
        generationStartedAt: Date.now(),
        generationDurationMs: selectedUpscaleModel.expectedDurationMs ?? 60000,
        // 先认领本次运行会话, 避免提交拿到 jobId 前被当成重启残留任务重复提交。
        generationClientSessionId: CURRENT_RUNTIME_SESSION_ID,
        generationRequest: {
          kind: 'image',
          prompt,
          model: requestModel,
          size: resolvedUpscaleResolution,
          aspectRatio,
          referenceImages: [imageSource],
        },
        resultKind: 'generic',
        displayName: `${t('nodeToolbar.imageUpscale')} ${resolvedUpscaleResolution}`,
      }
    );
    addEdge(node.id, newNodeId);

    try {
      const jobId = await canvasAiGateway.submitGenerateImageJob({
        prompt,
        model: requestModel,
        size: resolvedUpscaleResolution,
        aspectRatio,
        referenceImages: [imageSource],
      });
      updateNodeData(newNodeId, {
        generationJobId: jobId,
        generationSourceType: 'imageEdit',
        generationProviderId: selectedUpscaleModel.providerId,
        generationClientSessionId: CURRENT_RUNTIME_SESSION_ID,
      });
      setIsUpscaleModelPickerOpen(false);
      setIsImageUpscaleDialogOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateNodeData(newNodeId, {
        isGenerating: false,
        generationStartedAt: null,
        generationError: message,
      });
      void showErrorDialog(message, t('common.error'));
    } finally {
      setIsUpscalingImage(false);
    }
  }, [
    addEdge,
    addNode,
    apiKeys,
    findNodePosition,
    imageSource,
    isUpscalingImage,
    node.data.aspectRatio,
    node.id,
    resolvedUpscaleResolution,
    selectedUpscaleModel,
    t,
    updateNodeData,
  ]);
  const handleUpscaleVideo = useCallback(async () => {
    if (!videoSource || isUpscalingVideo) return;
    const credentials = resolveZhiniaoUpscaleCredentials('custom:zhiniao', '');
    if (!credentials) {
      void showErrorDialog(t('nodeToolbar.videoUpscaleApiKeyMissing'), t('common.error'));
      return;
    }
    setIsUpscalingVideo(true);
    const newNodeId = addNode(
      CANVAS_NODE_TYPES.audio,
      findNodePosition(node.id, 360, 240),
      {
        displayName: `${t('nodeToolbar.upscale')} ${videoUpscaleTier}`,
        mediaType: 'video',
        aspectRatio: typeof node.data.aspectRatio === 'string' && node.data.aspectRatio.trim()
          ? node.data.aspectRatio
          : DEFAULT_ASPECT_RATIO,
        isGenerating: true,
        generationStartedAt: Date.now(),
        generationDurationMs: 120000,
        generationClientSessionId: CURRENT_RUNTIME_SESSION_ID,
        generationRequest: {
          kind: 'video-upscale',
          model: VIDEO_UPSCALE_MODEL_ID,
          videoSource,
          tier: videoUpscaleTier,
        },
      },
    );
    addEdge(node.id, newNodeId);
    try {
      const videoUrl = await canvasAiGateway.upscaleVideo({
        videoSource,
        model: VIDEO_UPSCALE_MODEL_ID,
        tier: videoUpscaleTier,
      });
      updateNodeData(newNodeId, {
        sourcePath: videoUrl,
        generationResultProtected: true,
        isGenerating: false,
        generationStartedAt: null,
        generationError: null,
        generationClientSessionId: null,
      });
      setIsUpscaleDialogOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateNodeData(newNodeId, {
        isGenerating: false,
        generationStartedAt: null,
        generationError: message,
      });
      void showErrorDialog(message, t('common.error'));
    } finally {
      setIsUpscalingVideo(false);
    }
  }, [
    addEdge,
    addNode,
    findNodePosition,
    isUpscalingVideo,
    node.data.aspectRatio,
    node.id,
    t,
    updateNodeData,
    videoSource,
    videoUpscaleTier,
  ]);
  const handleDownloadMedia = useCallback(async () => {
    if (!downloadSource) {
      return;
    }

    const mediaType = videoSource ? 'video' : 'image';
    try {
      await saveMediaSourceWithDialog({
        source: downloadSource,
        nodeId: node.id,
        mediaType,
      });
    } catch (error) {
      console.error('Failed to save media from node toolbar', error);
      void showErrorDialog(
        mediaType === 'video' ? '视频下载失败' : '图片下载失败',
        '下载失败',
        error instanceof Error ? error.message : String(error),
      );
    }
  }, [downloadSource, node.id, videoSource]);
  const libraryCategories = useMemo(
    () => categories.filter((category) => category.libraryId === (activeLibraryId || libraries[0]?.id)),
    [activeLibraryId, categories, libraries]
  );
  const generationError =
    (isExportImageNode(node) || isVideoMediaNode)
    && typeof (node.data as { generationError?: unknown }).generationError === 'string'
      ? ((node.data as { generationError?: string }).generationError ?? '').trim()
      : '';
  const generationErrorDetails =
    (isExportImageNode(node) || isVideoMediaNode)
    && typeof (node.data as { generationErrorDetails?: unknown }).generationErrorDetails === 'string'
      ? ((node.data as { generationErrorDetails?: string }).generationErrorDetails ?? '').trim()
      : '';
  const canCopyGenerationError =
    (isExportImageNode(node) || isVideoMediaNode) && generationError.length > 0;
  const canRetryGeneration = canCopyGenerationError
    && Boolean((node.data as { generationRequest?: unknown }).generationRequest);
  const encodingRetryAvailable = Boolean(
    prepareEncodingRetry(node, `${generationError}\n${generationErrorDetails}`)
  );
  const generationErrorReport = useMemo(
    () =>
      buildGenerationErrorReport({
        errorMessage: generationError || t('ai.error'),
        errorDetails: generationErrorDetails || undefined,
        context: (node.data as { generationDebugContext?: unknown }).generationDebugContext,
      }),
    [generationError, generationErrorDetails, node.data, t]
  );

  const resolveToolLabel = useCallback((toolType: NodeToolType) => {
    if (toolType === NODE_TOOL_TYPES.crop) {
      return t('tool.crop');
    }
    if (toolType === NODE_TOOL_TYPES.annotate) {
      return t('tool.annotate');
    }
    if (toolType === NODE_TOOL_TYPES.splitStoryboard) {
      return t('tool.split');
    }
    if (toolType === NODE_TOOL_TYPES.rotate) {
      return t('tool.rotate.title');
    }
    if (toolType === NODE_TOOL_TYPES.adjust) {
      return t('tool.adjust');
    }
    return '';
  }, [t]);

  useEffect(() => {
    return () => {
      if (copyTextFeedbackTimerRef.current) {
        clearTimeout(copyTextFeedbackTimerRef.current);
      }
      if (copyErrorFeedbackTimerRef.current) {
        clearTimeout(copyErrorFeedbackTimerRef.current);
      }
    };
  }, []);

  const storyboardText = useMemo(() => {
    if (isStoryboardGen) {
      return node.data.frames
        .map((frame, index) => t('nodeToolbar.storyboardLine', {
          index: String(index + 1).padStart(2, '0'),
          content: sanitizeStoryboardText(
            frame.description ?? '',
            ignoreAtTagWhenCopyingAndGenerating
          ),
        }))
        .join('\n');
    }
    if (isStoryboardSplit) {
      const orderedFrames = [...node.data.frames].sort((a, b) => a.order - b.order);
      return orderedFrames
        .map((frame, index) => t('nodeToolbar.storyboardLine', {
          index: String(index + 1).padStart(2, '0'),
          content: sanitizeStoryboardText(frame.note ?? '', ignoreAtTagWhenCopyingAndGenerating),
        }))
        .join('\n');
    }
    return '';
  }, [ignoreAtTagWhenCopyingAndGenerating, isStoryboardGen, isStoryboardSplit, node, t, i18n.language]);

  const handleCopyStoryboardText = useCallback(async () => {
    if (!storyboardText) {
      return;
    }

    setIsCopyTextSuccess(true);
    if (copyTextFeedbackTimerRef.current) {
      clearTimeout(copyTextFeedbackTimerRef.current);
    }
    copyTextFeedbackTimerRef.current = setTimeout(() => {
      setIsCopyTextSuccess(false);
      copyTextFeedbackTimerRef.current = null;
    }, 1100);

    try {
      await navigator.clipboard.writeText(storyboardText);
    } catch (error) {
      console.error('Failed to copy storyboard text', error);
    }
  }, [storyboardText]);

  const handleCopyGenerationError = useCallback(async () => {
    if (!canCopyGenerationError) {
      return;
    }

    setIsCopyErrorSuccess(true);
    if (copyErrorFeedbackTimerRef.current) {
      clearTimeout(copyErrorFeedbackTimerRef.current);
    }
    copyErrorFeedbackTimerRef.current = setTimeout(() => {
      setIsCopyErrorSuccess(false);
      copyErrorFeedbackTimerRef.current = null;
    }, 1100);

    try {
      await navigator.clipboard.writeText(generationErrorReport);
    } catch (error) {
      console.error('Failed to copy generation error report', error);
    }
  }, [canCopyGenerationError, generationErrorReport]);

  const handleRetryGeneration = useCallback(() => {
    if (!canRetryGeneration) {
      return;
    }
    const encodingRetry = prepareEncodingRetry(node, `${generationError}\n${generationErrorDetails}`);
    if (encodingRetry && !window.confirm(t(
      'nodeToolbar.confirmEncodingRetry',
      '将使用另一种参考图编码提交新的生成请求，平台可能计费。继续吗？'
    ))) {
      return;
    }
    updateNodeData(node.id, {
      ...(encodingRetry ?? {}),
      isGenerating: true,
      generationStartedAt: Date.now(),
      generationError: null,
      generationErrorDetails: null,
      generationJobId: null,
      generationClientSessionId: null,
      generationRetryRequested: true,
    });
  }, [canRetryGeneration, generationError, generationErrorDetails, node, node.id, t, updateNodeData]);

  const handleAddVideoToLibrary = useCallback(async (categoryId: string | null) => {
    if (!videoSource || isSavingToLibrary) {
      return;
    }
    const libraryId = activeLibraryId || libraries[0]?.id;
    if (!libraryId) {
      return;
    }
    setIsSavingToLibrary(true);
    try {
      const asset = await importVideoUrlToAsset(videoSource, libraryId, categoryId);
      if (asset) {
        addAssets([asset]);
        setIsLibraryDialogOpen(false);
      }
    } catch (error) {
      console.error('Failed to add video to asset library', error);
    } finally {
      setIsSavingToLibrary(false);
    }
  }, [activeLibraryId, addAssets, isSavingToLibrary, libraries, videoSource]);

  const handleSaveTemplate = useCallback(async () => {
    if (!templateDraft?.valid || isSavingTemplate) return;
    setIsSavingTemplate(true);
    setTemplateNotice(null);
    try {
      await createTemplateFromCanvas(node, canvasNodes, canvasEdges, templateName, templateDescription);
      setTemplateNotice(t('nodeToolbar.templateSaved'));
      setIsTemplateDialogOpen(false);
      setTemplateName('');
      setTemplateDescription('');
    } catch (error) {
      setTemplateNotice(error instanceof Error ? error.message : t('nodeToolbar.templateSaveFailed'));
    } finally {
      setIsSavingTemplate(false);
    }
  }, [canvasEdges, canvasNodes, isSavingTemplate, node, t, templateDescription, templateDraft?.valid, templateName]);

  return (
    <ReactFlowNodeToolbar
      nodeId={node.id}
      isVisible
      position={NODE_TOOLBAR_POSITION}
      align={NODE_TOOLBAR_ALIGN}
      offset={NODE_TOOLBAR_OFFSET}
      className={NODE_TOOLBAR_CLASS}
    >
      <UiPanel className="flex items-center gap-1 rounded-full p-1">
        {!isImageEdit && tools.map((tool) => {
          const Icon = toolIconMap[tool.icon] ?? Crop;

          return (
            <UiChipButton
              key={tool.type}
              className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
              onClick={() =>
                canvasEventBus.publish('tool-dialog/open', {
                  nodeId: node.id,
                  toolType: tool.type,
                })
              }
            >
              <Icon className="h-3.5 w-3.5" />
              {resolveToolLabel(tool.type)}
            </UiChipButton>
          );
        })}
        {!isImageEdit && canReupload && (
          <UiChipButton
            key="upload-reupload"
            className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
            onClick={() =>
              canvasEventBus.publish('upload-node/reupload', {
                nodeId: node.id,
              })
            }
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t('nodeToolbar.reupload')}
          </UiChipButton>
        )}
        {!isImageEdit && canCopyStoryboardText && (
          <UiChipButton
            key="storyboard-text-copy"
            className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS} ${
              isCopyTextSuccess
                ? '!border-emerald-400/70 !bg-emerald-500/20 !text-emerald-200 hover:!bg-emerald-500/30'
                : ''
            }`}
            onClick={() => {
              void handleCopyStoryboardText();
            }}
          >
            <Copy className="h-3.5 w-3.5" />
            {t('nodeToolbar.copyText')}
          </UiChipButton>
        )}
        {!isImageEdit && canCopyGenerationError && (
          <UiChipButton
            key="generation-error-copy"
            className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS} ${
              isCopyErrorSuccess
                ? '!border-emerald-400/70 !bg-emerald-500/20 !text-emerald-200 hover:!bg-emerald-500/30'
                : '!border-red-500/45 !bg-red-500/15 !text-red-200 hover:!bg-red-500/25'
            }`}
            onClick={() => {
              void handleCopyGenerationError();
            }}
          >
            <Copy className="h-3.5 w-3.5" />
            {isCopyErrorSuccess ? t('nodeToolbar.copied') : t('nodeToolbar.copyErrorReport')}
          </UiChipButton>
        )}
        {!isImageEdit && canRetryGeneration && (
          <UiChipButton
            key="generation-retry"
            className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} border-amber-400/50 bg-amber-500/15 px-2.5 text-xs text-amber-200 hover:bg-amber-500/25`}
            onClick={(event) => {
              event.stopPropagation();
              handleRetryGeneration();
            }}
            title={encodingRetryAvailable
              ? t('nodeToolbar.retryWithEncoding', '切换编码并重试')
              : t('nodeToolbar.retryGeneration')}
            >
            <RefreshCw className="h-3.5 w-3.5" />
            {encodingRetryAvailable
              ? t('nodeToolbar.retryWithEncoding', '切换编码并重试')
              : t('nodeToolbar.retryGeneration')}
          </UiChipButton>
        )}
        {!isImageEdit && canHandleMedia && (
          <>
            {canReuploadMedia && (
              <UiChipButton
                key="media-reupload"
                className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
                onClick={(event) => {
                  event.stopPropagation();
                  canvasEventBus.publish('upload-node/reupload', { nodeId: node.id });
                }}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                {t('nodeToolbar.reupload')}
              </UiChipButton>
            )}
            <UiChipButton
              key="image-download"
              className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
              onClick={(event) => {
                event.stopPropagation();
                void handleDownloadMedia();
              }}
            >
              <Download className="h-3.5 w-3.5" />
              {t('nodeToolbar.download')}
            </UiChipButton>
            {isVideoMediaNode && videoSource && (
              <UiChipButton
                key="video-capture-frame"
                className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
                onClick={(event) => {
                  event.stopPropagation();
                  // 截图需要读节点内 <video> 的当前时间点, 由 AudioNode 订阅后执行。
                  canvasEventBus.publish('media-node/capture-frame', { nodeId: node.id });
                }}
              >
                <Camera className="h-3.5 w-3.5" />
                {t('nodeToolbar.captureFrame')}
              </UiChipButton>
            )}
            {isVideoMediaNode && videoSource && (
              <UiChipButton
                key="video-extract-script"
                className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
                onClick={(event) => {
                  event.stopPropagation();
                  // 一键扒剧本: 弹窗里只选模型, 扒完把剧本落成右侧文本节点。
                  setIsScriptDialogOpen(true);
                }}
                title={t('pajuben.quickTitle', '扒视频')}
              >
                <FileText className="h-3.5 w-3.5" />
                {t('pajuben.quickTitle', '扒视频')}
              </UiChipButton>
            )}
            {canUpscaleImage && (
              <UiChipButton
                key="image-upscale"
                className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
                onClick={(event) => {
                  event.stopPropagation();
                  // 把本节点的图交给所选模型放大, 结果作为新的结果图片节点接入画布。
                  setIsUpscaleModelPickerOpen(false);
                  setIsImageUpscaleDialogOpen(true);
                }}
              >
                <Maximize2 className="h-3.5 w-3.5" />
                {t('nodeToolbar.imageUpscale')}
              </UiChipButton>
            )}
            {isVideoMediaNode && videoSource && (
              <UiChipButton
                key="video-upscale"
                className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
                onClick={(event) => {
                  event.stopPropagation();
                  // 将本节点视频交给超分专用链路，结果作为新的视频节点接入画布。
                  setIsUpscaleDialogOpen(true);
                }}
                title={t('nodeToolbar.upscale')}
              >
                <Sparkles className="h-3.5 w-3.5" />
                {t('nodeToolbar.upscale')}
              </UiChipButton>
            )}
          </>
        )}
        {!isImageEdit && canSaveVideoTemplate && videoSource && (
          <>
            <UiChipButton
              key="save-video-template"
              disabled={!templateDraft?.valid || isSavingTemplate}
              className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
              title={templateDraft?.valid ? t('nodeToolbar.saveAsTemplate') : `${t('nodeToolbar.incompleteChain')}: ${templateDraft?.missing.join('、') ?? ''}`}
              onClick={(event) => {
                event.stopPropagation();
                setTemplateName(node.data.displayName?.trim() || '');
                setIsTemplateDialogOpen(true);
              }}
            >
              <LayoutTemplate className="h-3.5 w-3.5" />
              {t('nodeToolbar.saveAsTemplate')}
            </UiChipButton>
            {templateNotice && <span className="px-2 text-[11px] text-emerald-300">{templateNotice}</span>}
          </>
        )}
        {!isImageEdit && isVideoMediaNode && videoSource && (
          <UiChipButton
            key="video-library"
            className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
            disabled={isSavingToLibrary}
            onClick={(event) => {
              event.stopPropagation();
              setIsLibraryDialogOpen(true);
            }}
          >
            <Library className="h-3.5 w-3.5" />
            {isSavingToLibrary ? '保存中…' : '添加到素材库'}
          </UiChipButton>
        )}
        {!isImageEdit && isGroupNode(node) && (
          <>
            <UiChipButton
              key="group-rename"
              className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
              onClick={(event) => {
                event.stopPropagation();
                canvasEventBus.publish('group-node/rename', { nodeId: node.id });
              }}
            >
              <PenLine className="h-3.5 w-3.5" />
              {t('nodeToolbar.rename')}
            </UiChipButton>
            <UiChipButton
              key="group-ungroup"
              className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS} hover:!border-amber-400/60 hover:!bg-amber-500/20 hover:!text-amber-200`}
              onClick={(event) => {
                event.stopPropagation();
                ungroupNode(node.id);
              }}
            >
              <Unlink2 className="h-3.5 w-3.5" />
              {t('nodeToolbar.ungroup')}
            </UiChipButton>
          </>
        )}
        <UiChipButton
          key="node-delete"
          className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} border-red-500/45 bg-red-500/15 px-2.5 text-xs text-red-300 hover:bg-red-500/25`}
          onClick={(event) => {
            event.stopPropagation();
            deleteNode(node.id);
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
          {t('common.delete')}
        </UiChipButton>
      </UiPanel>

      {!isImageEdit && isScriptDialogOpen && (
        <PajubenQuickExtractDialog node={node} onClose={() => setIsScriptDialogOpen(false)} />
      )}

      {!isImageEdit && (
        <UiModal
          isOpen={isTemplateDialogOpen}
          title={t('nodeToolbar.saveAsTemplate')}
          onClose={() => setIsTemplateDialogOpen(false)}
          widthClassName="w-[420px]"
          footer={<>
            <UiButton type="button" variant="ghost" size="sm" onClick={() => setIsTemplateDialogOpen(false)}>{t('common.cancel')}</UiButton>
            <UiButton type="button" variant="primary" size="sm" disabled={isSavingTemplate || !templateDraft?.valid} onClick={() => void handleSaveTemplate()}>{isSavingTemplate ? t('nodeToolbar.templateSaving') : t('common.confirm')}</UiButton>
          </>}
        >
          <div className="space-y-3">
            <label className="block text-xs text-text-muted">{t('nodeToolbar.templateName')}<UiInput value={templateName} onChange={(event) => setTemplateName(event.target.value)} className="mt-1.5" /></label>
            <label className="block text-xs text-text-muted">{t('nodeToolbar.templateDescription')}<UiTextArea value={templateDescription} onChange={(event) => setTemplateDescription(event.target.value)} rows={3} className="mt-1.5" /></label>
            {!templateDraft?.valid && <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">{t('nodeToolbar.incompleteChain')}: {templateDraft?.missing.join('、')}</p>}
          </div>
        </UiModal>
      )}

      {!isImageEdit && (
        <UiModal
          isOpen={isLibraryDialogOpen}
          title="添加到素材库"
          onClose={() => setIsLibraryDialogOpen(false)}
          widthClassName="w-[360px]"
        >
          <div className="space-y-2">
            {!activeLibraryId && libraries.length === 0 ? (
              <p className="py-4 text-center text-xs text-text-muted/70">
                请先在素材库面板创建一个素材库
              </p>
            ) : (
              <>
                <button
                  type="button"
                  disabled={isSavingToLibrary}
                  className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs text-text-dark transition-colors hover:bg-bg-dark disabled:opacity-50"
                  onClick={() => void handleAddVideoToLibrary(null)}
                >
                  <Library className="h-3.5 w-3.5 text-text-muted" />
                  未分类
                </button>
                <div className="max-h-60 space-y-1 overflow-y-auto border-t border-white/10 pt-2">
                  {libraryCategories.map((category) => (
                    <button
                      key={category.id}
                      type="button"
                      disabled={isSavingToLibrary}
                      className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs text-text-dark transition-colors hover:bg-bg-dark disabled:opacity-50"
                      onClick={() => void handleAddVideoToLibrary(category.id)}
                    >
                      <Library className="h-3.5 w-3.5 text-accent" />
                      <span className="truncate">{category.name}</span>
                    </button>
                  ))}
                  {libraryCategories.length === 0 && (
                    <p className="py-3 text-center text-xs text-text-muted/60">暂无分组, 将保存到未分类</p>
                  )}
                </div>
              </>
            )}
          </div>
        </UiModal>
      )}

      {!isImageEdit && (
        <UiModal
          isOpen={isUpscaleDialogOpen}
          title={t('nodeToolbar.upscale')}
          onClose={() => setIsUpscaleDialogOpen(false)}
          widthClassName="w-[380px]"
        >
          <div className="space-y-3">
            <p className="text-xs leading-relaxed text-text-muted">{t('nodeToolbar.upscaleDesc')}</p>
            <div className="space-y-1">
              <label className="text-xs text-text-muted">{t('nodeToolbar.videoUpscaleModel')}</label>
              <div className="rounded-lg border border-white/10 bg-bg-dark/60 px-2.5 py-2 text-xs">
                aliyun-video-superres（2x）
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-text-muted">{t('nodeToolbar.videoUpscaleTier')}</label>
              <div className="flex gap-2">
                {['720p', '1080p', '4K'].map((tier) => (
                  <UiChipButton
                    key={tier}
                    className={`h-8 px-3 text-xs ${videoUpscaleTier === tier ? 'ring-1 ring-primary' : ''}`}
                    onClick={() => setVideoUpscaleTier(tier)}
                  >
                    {tier}
                  </UiChipButton>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <UiButton type="button" variant="ghost" size="sm" onClick={() => setIsUpscaleDialogOpen(false)}>
                {t('common.cancel')}
              </UiButton>
              <UiButton
                type="button"
                variant="primary"
                size="sm"
                disabled={isUpscalingVideo || !videoSource}
                onClick={() => void handleUpscaleVideo()}
              >
                {isUpscalingVideo ? t('nodeToolbar.videoUpscaleRunning') : t('canvas.generate')}
              </UiButton>
            </div>
          </div>
        </UiModal>
      )}

      {!isImageEdit && (
        <UiModal
          isOpen={isImageUpscaleDialogOpen}
          title={t('nodeToolbar.imageUpscale')}
          onClose={() => {
            setIsUpscaleModelPickerOpen(false);
            setIsImageUpscaleDialogOpen(false);
          }}
          widthClassName="w-[420px]"
        >
          <div className="space-y-3">
            <div>
              <span className="mb-1.5 block text-xs text-text-muted">
                {t('nodeToolbar.imageUpscaleModel')}
              </span>
              <div className="flex items-center gap-2">
                <span className="flex h-9 min-w-0 flex-1 items-center rounded-lg border border-white/10 bg-bg-dark/50 px-2.5 text-xs text-text-dark">
                  <span className="min-w-0 truncate">
                    {selectedUpscaleModel?.displayName ?? t('nodeToolbar.imageUpscaleNoModel')}
                  </span>
                </span>
                <UiButton
                  type="button"
                  variant="muted"
                  size="sm"
                  className="shrink-0"
                  onClick={() => setIsUpscaleModelPickerOpen((open) => !open)}
                >
                  {t('nodeToolbar.imageUpscaleChangeModel')}
                </UiButton>
              </div>
              {isUpscaleModelPickerOpen && (
                <div className="ui-scrollbar mt-2 max-h-52 space-y-1 overflow-y-auto rounded-lg border border-white/10 p-1">
                  {upscaleModelOptions.map((model) => {
                    const isActive = model.id === selectedUpscaleModel?.id;
                    return (
                      <button
                        key={model.id}
                        type="button"
                        onClick={() => {
                          setImageUpscaleModelId(model.id);
                          setIsUpscaleModelPickerOpen(false);
                        }}
                        className={`flex h-8 w-full items-center justify-between gap-2 rounded-md px-2 text-left text-xs transition-colors ${
                          isActive
                            ? 'bg-accent/20 text-text-dark'
                            : 'text-text-muted hover:bg-bg-dark'
                        }`}
                      >
                        <span className="min-w-0 truncate">{model.displayName}</span>
                        <span className="shrink-0 text-[11px] text-text-muted/70">{model.providerId}</span>
                      </button>
                    );
                  })}
                  {upscaleModelOptions.length === 0 && (
                    <p className="px-2 py-3 text-center text-xs text-text-muted/60">
                      {t('nodeToolbar.imageUpscaleNoModel')}
                    </p>
                  )}
                </div>
              )}
            </div>

            <div>
              <span className="mb-1.5 block text-xs text-text-muted">
                {t('nodeToolbar.imageUpscaleResolution')}
              </span>
              <div className="flex flex-wrap gap-1.5">
                {upscaleResolutionOptions.map((option) => {
                  const isActive = option.value === resolvedUpscaleResolution;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setImageUpscaleResolution(option.value)}
                      className={`h-7 rounded-full border px-3 text-xs transition-colors ${
                        isActive
                          ? 'border-accent bg-accent/20 text-text-dark'
                          : 'border-white/15 bg-bg-dark/60 text-text-muted hover:border-white/30'
                      }`}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t border-white/10 pt-3">
              <UiButton
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setIsImageUpscaleDialogOpen(false)}
              >
                {t('common.cancel')}
              </UiButton>
              <UiButton
                type="button"
                variant="primary"
                size="sm"
                disabled={isUpscalingImage || !selectedUpscaleModel}
                onClick={() => void handleUpscaleImage()}
              >
                {isUpscalingImage
                  ? t('nodeToolbar.imageUpscaleRunning')
                  : t('canvas.generate')}
              </UiButton>
            </div>
          </div>
        </UiModal>
      )}
    </ReactFlowNodeToolbar>
  );
});

NodeActionToolbar.displayName = 'NodeActionToolbar';
