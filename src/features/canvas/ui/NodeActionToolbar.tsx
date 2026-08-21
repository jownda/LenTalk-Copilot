import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NodeToolbar as ReactFlowNodeToolbar } from '@xyflow/react';
import { Copy, Crop, Download, FolderOpen, Library, PenLine, RefreshCw, RotateCw, Scissors, SlidersHorizontal, Trash2, Unlink2 } from 'lucide-react';
import { save } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';

import {
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
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { getNodeToolPlugins } from '@/features/canvas/tools';
import type { ToolIconKey } from '@/features/canvas/tools';
import { UiChipButton, UiPanel, UiModal } from '@/components/ui';
import {
  saveImageSourceToDirectory,
  saveImageSourceToPath,
} from '@/commands/image';
import { useSettingsStore } from '@/stores/settingsStore';
import { useCanvasStore } from '@/stores/canvasStore';
import { UI_POPOVER_TRANSITION_MS } from '@/components/ui/motion';
import { sanitizeStoryboardText } from '@/features/canvas/application/storyboardText';
import { buildGenerationErrorReport } from '@/features/canvas/application/generationErrorReport';
import { importVideoUrlToAsset } from '@/features/library/importAssets';
import { useAssetLibraryStore } from '@/features/library/assetStore';
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
  const isGeneratedVideoNode = isAudioNode(node) && node.data.mediaType === 'video';
  const isStoryboardGen = isStoryboardGenNode(node);
  const isStoryboardSplit = isStoryboardSplitNode(node);
  const canCopyStoryboardText = isStoryboardGen || isStoryboardSplit;
  const tools = useMemo(() => getNodeToolPlugins(node), [node]);
  const deleteNode = useCanvasStore((state) => state.deleteNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const ungroupNode = useCanvasStore((state) => state.ungroupNode);
  const canReupload = isUploadNode(node) && Boolean(node.data.imageUrl);
  const canReuploadMedia = isAudioNode(node) && Boolean(node.data.sourcePath);
  const downloadPresetPaths = useSettingsStore((state) => state.downloadPresetPaths);
  const libraries = useAssetLibraryStore((state) => state.libraries);
  const categories = useAssetLibraryStore((state) => state.categories);
  const activeLibraryId = useAssetLibraryStore((state) => state.activeLibraryId);
  const addAssets = useAssetLibraryStore((state) => state.addAssets);
  const ignoreAtTagWhenCopyingAndGenerating = useSettingsStore(
    (state) => state.ignoreAtTagWhenCopyingAndGenerating
  );
  const [downloadMenu, setDownloadMenu] = useState<{ x: number; y: number } | null>(null);
  const [isDownloadMenuVisible, setIsDownloadMenuVisible] = useState(false);
  const [isLibraryDialogOpen, setIsLibraryDialogOpen] = useState(false);
  const [isSavingToLibrary, setIsSavingToLibrary] = useState(false);
  const [isCopyTextSuccess, setIsCopyTextSuccess] = useState(false);
  const [isCopyErrorSuccess, setIsCopyErrorSuccess] = useState(false);
  const downloadMenuRef = useRef<HTMLDivElement | null>(null);
  const copyTextFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyErrorFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const downloadMenuCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const imageSource = useMemo(() => {
    if (isUploadNode(node) || isImageEditNode(node) || isExportImageNode(node)) {
      return node.data.imageUrl || node.data.previewImageUrl || null;
    }
    return null;
  }, [node]);
  const videoSource = isGeneratedVideoNode
    ? ((node.data as { sourcePath?: string | null }).sourcePath ?? null)
    : null;
  const downloadSource = imageSource || videoSource;
  const canHandleMedia = Boolean(downloadSource);
  const libraryCategories = useMemo(
    () => categories.filter((category) => category.libraryId === (activeLibraryId || libraries[0]?.id)),
    [activeLibraryId, categories, libraries]
  );
  const generationError =
    (isExportImageNode(node) || isGeneratedVideoNode)
    && typeof (node.data as { generationError?: unknown }).generationError === 'string'
      ? ((node.data as { generationError?: string }).generationError ?? '').trim()
      : '';
  const generationErrorDetails =
    (isExportImageNode(node) || isGeneratedVideoNode)
    && typeof (node.data as { generationErrorDetails?: unknown }).generationErrorDetails === 'string'
      ? ((node.data as { generationErrorDetails?: string }).generationErrorDetails ?? '').trim()
      : '';
  const canCopyGenerationError =
    (isExportImageNode(node) || isGeneratedVideoNode) && generationError.length > 0;
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

  const closeDownloadMenu = useCallback(() => {
    setIsDownloadMenuVisible(false);
    if (downloadMenuCloseTimerRef.current) {
      clearTimeout(downloadMenuCloseTimerRef.current);
    }
    downloadMenuCloseTimerRef.current = setTimeout(() => {
      setDownloadMenu(null);
      downloadMenuCloseTimerRef.current = null;
    }, UI_POPOVER_TRANSITION_MS);
  }, []);

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
    if (!downloadMenu) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      const menuElement = downloadMenuRef.current;
      if (!menuElement) {
        closeDownloadMenu();
        return;
      }
      if (menuElement.contains(event.target as Node)) {
        return;
      }
      closeDownloadMenu();
    };

    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [closeDownloadMenu, downloadMenu]);

  useEffect(() => {
    if (!downloadMenu) {
      return;
    }
    const frameId = requestAnimationFrame(() => {
      setIsDownloadMenuVisible(true);
    });
    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [downloadMenu]);

  useEffect(() => {
    return () => {
      if (copyTextFeedbackTimerRef.current) {
        clearTimeout(copyTextFeedbackTimerRef.current);
      }
      if (copyErrorFeedbackTimerRef.current) {
        clearTimeout(copyErrorFeedbackTimerRef.current);
      }
      if (downloadMenuCloseTimerRef.current) {
        clearTimeout(downloadMenuCloseTimerRef.current);
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

  const handleDownloadSaveAs = useCallback(async () => {
    if (!downloadSource) {
      return;
    }

    try {
      const selectedPath = await save({
        defaultPath: `node-${node.id}.${videoSource ? 'mp4' : 'png'}`,
      });
      if (!selectedPath || Array.isArray(selectedPath)) {
        return;
      }
      await saveImageSourceToPath(downloadSource, selectedPath);
      closeDownloadMenu();
    } catch (error) {
      console.error('Failed to save image with save-as', error);
    }
  }, [closeDownloadMenu, downloadSource, node.id, videoSource]);

  const handleDownloadToPreset = useCallback(
    async (targetDir: string) => {
      if (!downloadSource) {
        return;
      }
      try {
        await saveImageSourceToDirectory(downloadSource, targetDir, `node-${node.id}`);
        closeDownloadMenu();
      } catch (error) {
        console.error('Failed to save image to preset dir', error);
      }
    },
    [closeDownloadMenu, downloadSource, node.id]
  );

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
              if (downloadPresetPaths.length === 0) {
                void handleDownloadSaveAs();
                return;
              }
              setDownloadMenu({
                x: event.clientX,
                y: event.clientY,
              });
              setIsDownloadMenuVisible(false);
            }}
          >
            <Download className="h-3.5 w-3.5" />
            {t('nodeToolbar.download')}
          </UiChipButton>
          </>
        )}
        {!isImageEdit && isGeneratedVideoNode && videoSource && (
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
                closeDownloadMenu();
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
                closeDownloadMenu();
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
            closeDownloadMenu();
            deleteNode(node.id);
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
          {t('common.delete')}
        </UiChipButton>
      </UiPanel>

      {!isImageEdit && downloadMenu && (
        <div
          ref={downloadMenuRef}
          className={`fixed z-[120] min-w-[280px] rounded-xl border border-[rgba(255,255,255,0.18)] bg-surface-dark/95 p-2 shadow-2xl backdrop-blur-sm transition-opacity duration-150 ${isDownloadMenuVisible ? 'opacity-100' : 'opacity-0'}`}
          style={{ left: `${downloadMenu.x}px`, top: `${downloadMenu.y}px` }}
        >
          <button
            type="button"
            className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm text-text-dark transition-colors hover:bg-bg-dark"
            onClick={() => {
              void handleDownloadSaveAs();
            }}
          >
            <Download className="h-4 w-4" />
            {t('nodeToolbar.saveAs')}
          </button>

          {downloadPresetPaths.length > 0 ? (
            <div className="mt-1 space-y-1 border-t border-[rgba(255,255,255,0.1)] pt-2">
              {downloadPresetPaths.map((path) => (
                <button
                  key={path}
                  type="button"
                  className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs text-text-dark transition-colors hover:bg-bg-dark"
                  onClick={() => {
                    void handleDownloadToPreset(path);
                  }}
                  title={path}
                >
                  <FolderOpen className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                  <span className="truncate">{path}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="mt-1 border-t border-[rgba(255,255,255,0.1)] px-2.5 pt-2 text-xs text-text-muted">
              {t('nodeToolbar.noDownloadPresetPathsHint')}
            </div>
          )}
        </div>
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
    </ReactFlowNodeToolbar>
  );
});

NodeActionToolbar.displayName = 'NodeActionToolbar';
