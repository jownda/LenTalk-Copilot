import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isTauri } from '@tauri-apps/api/core';
import { Handle, Position } from '@xyflow/react';
import { AlertTriangle, AudioLines, Camera, LoaderCircle, Music2, Upload, Video, X } from 'lucide-react';

import { CANVAS_NODE_TYPES, type AudioNodeData } from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { prepareNodeImage, resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { extractVideoThumbnail, persistLibraryAssetBinary } from '@/commands/assetLibrary';
import { useCanvasStore } from '@/stores/canvasStore';

type AudioNodeProps = {
  id: string;
  data: AudioNodeData;
  selected?: boolean;
};

function waitForDecodedVideoFrame(video: HTMLVideoElement, timeoutMs = 5000): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const events = ['loadeddata', 'canplay', 'playing', 'seeked'];
    const cleanup = () => {
      window.clearTimeout(timeoutId);
      events.forEach((event) => video.removeEventListener(event, onFrameReady));
      video.removeEventListener('error', onError);
    };
    const onFrameReady = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        cleanup();
        resolve();
      }
    };
    const onError = () => {
      cleanup();
      reject(new Error('视频帧无法解码'));
    };
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error('视频帧尚未准备好'));
    }, timeoutMs);
    events.forEach((event) => video.addEventListener(event, onFrameReady));
    video.addEventListener('error', onError);
    onFrameReady();
  });
}

export const AudioNode = memo(({ id, data, selected }: AudioNodeProps) => {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const addDerivedExportNode = useCanvasStore((state) => state.addDerivedExportNode);
  const addEdge = useCanvasStore((state) => state.addEdge);

  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isVideoViewerOpen, setIsVideoViewerOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const resolvedTitle = useMemo(
    () => resolveNodeDisplayName(CANVAS_NODE_TYPES.audio, data),
    [data]
  );
  const isVideo = data.mediaType === 'video';
  const mediaSrc = data.sourcePath ? resolveImageDisplayUrl(data.sourcePath) : null;
  const isGenerating = typeof data.isGenerating === 'boolean' ? data.isGenerating : false;
  const generationError =
    typeof data.generationError === 'string' ? data.generationError.trim() : '';
  const hasGenerationError = isGenerating === false && !mediaSrc && generationError.length > 0;
  const generationStartedAt =
    typeof data.generationStartedAt === 'number' ? data.generationStartedAt : null;
  const generationDurationMs =
    typeof data.generationDurationMs === 'number' ? data.generationDurationMs : 180000;

  // 生成中: 定时刷新以驱动模拟进度条(与 AI 图片结果节点一致)
  useEffect(() => {
    if (!isGenerating) {
      return;
    }
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 120);
    return () => {
      window.clearInterval(timer);
    };
  }, [isGenerating]);

  useEffect(() => {
    if (!isVideoViewerOpen) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsVideoViewerOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isVideoViewerOpen]);

  const simulatedProgress = useMemo(() => {
    if (!isGenerating) {
      return 0;
    }
    const startedAt = generationStartedAt ?? Date.now();
    const duration = Math.max(1000, generationDurationMs);
    const elapsed = Math.max(0, now - startedAt);
    return Math.min(elapsed / duration, 0.96);
  }, [generationDurationMs, generationStartedAt, isGenerating, now]);

  const waitedMinutes = useMemo(() => {
    if (!isGenerating || generationStartedAt === null) {
      return 0;
    }
    return Math.floor(Math.max(0, now - generationStartedAt) / 60000);
  }, [generationStartedAt, isGenerating, now]);

  const waitingResultText = useMemo(() => {
    if (!isGenerating || waitedMinutes < 2) {
      return '生成中…';
    }
    return `生成中…（已等待 ${waitedMinutes} 分钟）`;
  }, [isGenerating, waitedMinutes]);

  /** 上传媒体文件(点击选择或拖拽), 持久化后写入节点 */
  const handleMediaFiles = useCallback(async (files: FileList | File[]) => {
    const file = Array.from(files)[0];
    if (!file) {
      return;
    }
    const mediaType = file.type.startsWith('video/')
      ? 'video'
      : file.type.startsWith('audio/')
        ? 'audio'
        : null;
    if (!mediaType) {
      return;
    }
    setIsUploading(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const extension = file.name.split('.').pop()?.trim() || (mediaType === 'video' ? 'mp4' : 'mp3');
      const sourcePath = await persistLibraryAssetBinary(bytes, extension);
      updateNodeData(id, {
        sourcePath,
        mediaType,
        previewImageUrl: null,
        aspectRatio: undefined,
        // 导入媒体时用文件原名作为节点标题, 避免显示默认的"媒体"导致分不清
        displayName: file.name.replace(/\.[^.]+$/, '').trim() || file.name,
      });
    } catch (error) {
      console.warn('[mediaNode] upload failed', error);
    } finally {
      setIsUploading(false);
    }
  }, [id, updateNodeData]);

  /** 视频截图: 当前帧绘制到 canvas → 生成图片节点到下游(右侧)并连线 */
  /** 视频加载后自动截首帧作为缩略图(存 previewImageUrl), 生成过则跳过。 */
  const handleAutoCaptureThumbnail = useCallback(async () => {
    const videoEl = videoRef.current;
    if (!videoEl || data.previewImageUrl) {
      return;
    }
    try {
      await waitForDecodedVideoFrame(videoEl);
      if (!videoEl.videoWidth || !videoEl.videoHeight) {
        return;
      }
      const canvas = document.createElement('canvas');
      canvas.width = videoEl.videoWidth;
      canvas.height = videoEl.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return;
      }
      ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/png');
      const prepared = await prepareNodeImage(dataUrl);
      updateNodeData(id, {
        previewImageUrl: prepared.previewImageUrl ?? prepared.imageUrl ?? dataUrl,
      });
    } catch {
      // 首帧截图失败时保持 video 播放器显示
    }
  }, [data.previewImageUrl, id, updateNodeData]);

  // 本地桌面视频优先使用系统抽帧，避免 WKWebView 对视频 canvas 截图的限制。
  useEffect(() => {
    if (!isVideo || !isTauri() || data.previewImageUrl || !data.sourcePath) {
      return;
    }
    let disposed = false;
    void extractVideoThumbnail(data.sourcePath).then((thumbnail) => {
      if (!disposed && thumbnail) {
        updateNodeData(id, { previewImageUrl: thumbnail });
      }
    });
    return () => {
      disposed = true;
    };
  }, [data.previewImageUrl, data.sourcePath, id, isVideo, updateNodeData]);

  const handleCaptureFrame = useCallback(async () => {
    const videoEl = videoRef.current;
    if (!videoEl) {
      return;
    }
    setIsCapturing(true);
    setCaptureError(null);
    try {
      await waitForDecodedVideoFrame(videoEl);
      const width = videoEl.videoWidth;
      const height = videoEl.videoHeight;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('canvas 2d context unavailable');
      }
      ctx.drawImage(videoEl, 0, 0, width, height);
      const dataUrl = canvas.toDataURL('image/png');
      const prepared = await prepareNodeImage(dataUrl);
      const createdNodeId = addDerivedExportNode(
        id,
        prepared.imageUrl,
        prepared.aspectRatio,
        prepared.previewImageUrl,
        {
          defaultTitle: '视频截图',
          resultKind: 'generic',
          aspectRatioStrategy: 'provided',
        }
      );
      if (createdNodeId) {
        addEdge(id, createdNodeId);
      }
    } catch (error) {
      console.warn('[mediaNode] capture frame failed', error);
      setCaptureError(
        error instanceof DOMException && error.name === 'SecurityError'
          ? '视频源未授权跨域截图'
          : error instanceof Error
            ? error.message
            : '截图失败'
      );
    } finally {
      setIsCapturing(false);
    }
  }, [addDerivedExportNode, addEdge, id]);

  const dropHandlers = {
    onDragOver: (event: React.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
    },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      void handleMediaFiles(event.dataTransfer.files);
    },
  };

  return (
    <div
      className={`flex h-full w-full flex-col rounded-[var(--node-radius)] border bg-surface-dark/90 p-2 transition-colors duration-150 ${
        hasGenerationError
          ? (selected
            ? 'border-red-400 shadow-[0_0_0_1px_rgba(248,113,113,0.42)]'
            : 'border-red-500/70 bg-[rgba(127,29,29,0.12)] hover:border-red-400/80 dark:border-red-500/70 dark:hover:border-red-400/80')
          : selected
          ? 'border-accent shadow-[0_0_0_1px_rgba(59,130,246,0.32)]'
          : 'border-[rgba(15,23,42,0.22)] dark:border-[rgba(255,255,255,0.22)]'
      }`}
      {...dropHandlers}
    >
      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={isVideo ? <Video className="h-4 w-4" /> : <Music2 className="h-4 w-4" />}
        titleText={resolvedTitle}
        editable
        onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
      />

      {mediaSrc ? (
        isVideo ? (
          <>
            {/* 视频画面顶到上部, 铺满可用空间; 缩略图作为 poster, 单击使用节点内播放器 */}
            <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg border border-[rgba(255,255,255,0.1)] bg-black/45">
              <video
                ref={videoRef}
                controls
                src={mediaSrc}
                preload="metadata"
                poster={data.previewImageUrl ? resolveImageDisplayUrl(data.previewImageUrl) : undefined}
                className="nodrag h-full w-full object-contain"
                onLoadedData={() => void handleAutoCaptureThumbnail()}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  setIsVideoViewerOpen(true);
                }}
              />
            </div>
            {/* 底部操作行 */}
            <div className="mt-1.5 flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  disabled={isCapturing}
                  onClick={() => void handleCaptureFrame()}
                  className="flex h-7 items-center gap-1.5 rounded-md border border-border-dark bg-bg-dark px-2.5 text-xs text-text-dark transition-colors hover:border-accent/60 hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Camera className="h-3.5 w-3.5" />
                  {isCapturing ? '截图…' : '截图'}
                </button>
                {captureError && <span className="text-[11px] text-red-400">{captureError}</span>}
            </div>
          </>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2.5 rounded-lg border border-[rgba(255,255,255,0.1)] bg-bg-dark/45 p-2">
            <AudioLines className="h-8 w-8 text-accent/70" />
            <audio
              controls
              src={mediaSrc}
              preload="metadata"
              className="nodrag w-full max-w-[280px]"
            />
          </div>
        )
      ) : hasGenerationError ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-red-500/40 bg-[rgba(127,29,29,0.2)] px-4 text-red-300">
          <AlertTriangle className="h-7 w-7 opacity-90" />
          <span className="text-center text-[12px] font-medium leading-5 text-red-200">生成失败</span>
          <span className="max-h-[88px] overflow-y-auto break-words text-center text-[11px] leading-5 text-red-200/90">
            {generationError}
          </span>
        </div>
      ) : isGenerating ? (
        <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-2 overflow-hidden rounded-lg border border-[rgba(255,255,255,0.1)] bg-bg-dark/45 p-2 text-text-muted/85">
          <LoaderCircle className="h-7 w-7 animate-spin text-accent/70" />
          <span className="px-4 text-center text-[12px] leading-6">{waitingResultText}</span>
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            <div className="absolute inset-0 bg-bg-dark/30" />
            <div
              className="absolute left-0 top-0 h-full bg-gradient-to-r from-[rgba(255,255,255,0.28)] to-[rgba(255,255,255,0.05)] transition-[width] duration-100 ease-linear"
              style={{ width: `${simulatedProgress * 100}%` }}
            />
          </div>
        </div>
      ) : (
        /* 空状态: 点击或拖拽上传媒体 */
        <button
          type="button"
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border-dark text-text-muted transition-colors hover:border-accent/60 hover:bg-accent/5 hover:text-text-dark"
          onClick={() => fileInputRef.current?.click()}
        >
          {isVideo ? (
            <Video className="h-9 w-9 opacity-60" />
          ) : (
            <AudioLines className="h-9 w-9 opacity-60" />
          )}
          <span className="flex items-center gap-1.5 text-xs">
            <Upload className="h-3.5 w-3.5" />
            {isUploading ? '上传中…' : isVideo ? '点击或拖拽上传视频' : '点击或拖拽上传音频'}
          </span>
        </button>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="video/*,audio/*"
        className="hidden"
        onChange={(event) => {
          if (event.target.files) {
            void handleMediaFiles(event.target.files);
          }
          event.target.value = '';
        }}
      />

      <Handle
        type="target"
        id="target"
        position={Position.Left}
        className="!h-2 !w-2 !border-surface-dark !bg-accent"
      />
      <Handle
        type="source"
        id="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-surface-dark !bg-accent"
      />
      <NodeResizeHandle minWidth={180} minHeight={150} maxWidth={520} maxHeight={400} />
      {isVideoViewerOpen && mediaSrc && createPortal(
        <div
          className="fixed inset-0 z-[180] flex items-center justify-center bg-black/90 p-6 backdrop-blur-sm"
          onClick={() => setIsVideoViewerOpen(false)}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="absolute right-5 top-5 z-10 flex h-10 w-10 items-center justify-center rounded-full border border-white/20 bg-black/60 text-white transition-colors hover:bg-white/15"
            onClick={() => setIsVideoViewerOpen(false)}
            title="关闭视频预览"
            aria-label="关闭视频预览"
          >
            <X className="h-5 w-5" />
          </button>
          <video
            controls
            autoPlay
            src={mediaSrc}
            preload="auto"
            className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          />
        </div>,
        document.body
      )}
    </div>
  );
});

AudioNode.displayName = 'AudioNode';
