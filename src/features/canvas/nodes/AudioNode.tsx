import { memo, useCallback, useEffect, useMemo, useRef, useState, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { isTauri } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { Handle, Position } from '@xyflow/react';
import { AlertTriangle, AudioLines, LoaderCircle, Music2, Upload, Video, X } from 'lucide-react';

import { CANVAS_NODE_TYPES, type AudioNodeData } from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { MediaDimensionsLabel, useHoverIntent, useMediaByteSize, type MediaDimensions } from '@/features/canvas/ui/MediaDimensions';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { prepareNodeImage, reduceAspectRatio, resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { resolveMediaNodeResizeBounds } from '@/features/canvas/application/aspectLockedResize';
import { captureVideoFrame } from '@/features/canvas/application/videoFrameCapture';
import { showErrorDialog } from '@/features/canvas/application/errorDialog';
import {
  extractVideoThumbnail,
  persistLibraryAssetBinary,
  persistLibraryAssetFile,
} from '@/commands/assetLibrary';
import { useCanvasStore } from '@/stores/canvasStore';

type AudioNodeProps = {
  id: string;
  data: AudioNodeData;
  selected?: boolean;
};

/**
 * 远端视频兜底抽帧的宽度上限。
 * 节点封面用不到全分辨率, 先限宽再交给 prepareNodeImage, 能显著降低 canvas
 * 与 dataURL 的内存占用(4K 帧按原尺寸绘制可达数十 MB)。
 */
const REMOTE_VIDEO_THUMBNAIL_MAX_WIDTH = 640;

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
  const updateNodeDataTransient = useCanvasStore((state) => state.updateNodeDataTransient);
  const addDerivedExportNode = useCanvasStore((state) => state.addDerivedExportNode);
  const addEdge = useCanvasStore((state) => state.addEdge);

  const videoRef = useRef<HTMLVideoElement>(null);
  const viewerVideoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isVideoViewerOpen, setIsVideoViewerOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [videoDimensions, setVideoDimensions] = useState<MediaDimensions | null>(null);

  const resolvedTitle = useMemo(
    () => resolveNodeDisplayName(CANVAS_NODE_TYPES.audio, data),
    [data]
  );
  const isVideo = data.mediaType === 'video';
  const mediaSrc = data.sourcePath ? resolveImageDisplayUrl(data.sourcePath) : null;
  // 体积标注只跟随视频画面; 音频节点不显示, 传 null 避免无谓的探测请求。
  const mediaByteSize = useMediaByteSize(isVideo ? data.sourcePath : null);
  // 尺寸/体积标注改为悬停延迟显示, 避免常驻文字干扰画面。
  const mediaHover = useHoverIntent();
  const isGenerating = typeof data.isGenerating === 'boolean' ? data.isGenerating : false;
  const generationError =
    typeof data.generationError === 'string' ? data.generationError.trim() : '';
  const hasGenerationError = isGenerating === false && !mediaSrc && generationError.length > 0;
  const generationStartedAt =
    typeof data.generationStartedAt === 'number' ? data.generationStartedAt : null;
  const generationDurationMs =
    typeof data.generationDurationMs === 'number' ? data.generationDurationMs : 180000;

  useEffect(() => {
    setVideoDimensions(null);
  }, [mediaSrc]);

  const handleVideoMetadata = useCallback((event: SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      setVideoDimensions({ width: video.videoWidth, height: video.videoHeight });
    }
  }, []);

  // 视频解码出真实尺寸后, 把宽高比写回节点数据: 拖拽缩放据此保持画面比例。
  // 只是补充元信息, 不参与历史记录, 因此走 transient 写入。
  useEffect(() => {
    if (!isVideo || !videoDimensions) {
      return;
    }

    const actualAspectRatio = reduceAspectRatio(videoDimensions.width, videoDimensions.height);
    if (data.aspectRatio === actualAspectRatio) {
      return;
    }

    updateNodeDataTransient(id, { aspectRatio: actualAspectRatio });
  }, [data.aspectRatio, id, isVideo, updateNodeDataTransient, videoDimensions]);

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

  // Chromium 的媒体控件自带「双击 <video> 进入原生全屏」的默认行为。
  // 该处理位于 UA shadow DOM 内, 会在事件冒泡到 React root 之前执行, 因此仅靠
  // JSX 的 onDoubleClick(合成事件, 挂在 root 上) 拦不住 —— 结果是双击同时触发
  // 原生全屏与下面的自定义查看器, 表现为"全屏播放两层、要关两次"。
  // 只有在 video 元素自身以捕获阶段注册监听, 才能先于 UA 处理取消默认行为。
  useEffect(() => {
    const video = videoRef.current;
    if (!isVideo || !video) {
      return;
    }
    const blockNativeDoubleClickFullscreen = (event: MouseEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      setIsVideoViewerOpen(true);
    };
    video.addEventListener('dblclick', blockNativeDoubleClickFullscreen, true);
    return () => {
      video.removeEventListener('dblclick', blockNativeDoubleClickFullscreen, true);
    };
  }, [isVideo, mediaSrc]);

  // 查看器内的视频本身就是一个"全屏视图", 双击不该再叠一层原生全屏。
  useEffect(() => {
    const video = viewerVideoRef.current;
    if (!isVideoViewerOpen || !video) {
      return;
    }
    const blockNativeDoubleClickFullscreen = (event: MouseEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    video.addEventListener('dblclick', blockNativeDoubleClickFullscreen, true);
    return () => {
      video.removeEventListener('dblclick', blockNativeDoubleClickFullscreen, true);
    };
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

  const applyMediaSource = useCallback((sourcePath: string, mediaType: 'audio' | 'video', fileName: string) => {
    updateNodeData(id, {
      sourcePath,
      mediaType,
      previewImageUrl: null,
      aspectRatio: undefined,
      displayName: fileName.replace(/\.[^.]+$/, '').trim() || fileName,
    });
  }, [id, updateNodeData]);

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
      const extension = file.name.split('.').pop()?.trim() || (mediaType === 'video' ? 'mp4' : 'mp3');
      const nativePath = (file as File & { path?: unknown }).path;
      const sourcePath = isTauri() && typeof nativePath === 'string' && nativePath.trim()
        ? await persistLibraryAssetFile(nativePath, extension)
        : await persistLibraryAssetBinary(new Uint8Array(await file.arrayBuffer()), extension);
      applyMediaSource(sourcePath, mediaType, file.name);
    } catch (error) {
      console.warn('[mediaNode] upload failed', error);
    } finally {
      setIsUploading(false);
    }
  }, [applyMediaSource]);

  const handleUploadClick = useCallback(async () => {
    if (!isTauri()) {
      fileInputRef.current?.click();
      return;
    }

    const selectedPath = await open({
      multiple: false,
      filters: [{ name: '媒体文件', extensions: ['mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv', 'mp3', 'm4a', 'wav', 'aac', 'flac', 'ogg'] }],
    });
    if (!selectedPath || Array.isArray(selectedPath)) {
      return;
    }

    const fileName = selectedPath.split(/[\\/]/).pop() || 'media';
    const extension = fileName.split('.').pop()?.trim() || 'bin';
    const videoExtensions = new Set(['mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv']);
    const mediaType = videoExtensions.has(extension.toLowerCase()) ? 'video' : 'audio';
    setIsUploading(true);
    try {
      const sourcePath = await persistLibraryAssetFile(selectedPath, extension);
      applyMediaSource(sourcePath, mediaType, fileName);
    } catch (error) {
      console.warn('[mediaNode] native upload failed', error);
    } finally {
      setIsUploading(false);
    }
  }, [applyMediaSource]);

  useEffect(() => {
    return canvasEventBus.subscribe('upload-node/reupload', ({ nodeId }) => {
      if (nodeId === id) {
        void handleUploadClick();
      }
    });
  }, [handleUploadClick, id]);

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
  // 但 QuickLook 只认本地文件路径(AI 视频节点生成的结果是远端 CDN 地址), 因此再加一级
  // captureVideoFrame 兜底: 它会先尝试带 crossOrigin 直连, 不行就让 Rust 取回字节转同源
  // blob 后再抽帧, 既不污染画布也不受 CDN 的 CORS 配置影响。
  useEffect(() => {
    // 存成局部常量: data.sourcePath 是属性访问, 跨 async 边界后 TS 无法保持窄化。
    const sourcePath = data.sourcePath;
    if (!isVideo || !isTauri() || data.previewImageUrl || !sourcePath) {
      return;
    }
    let disposed = false;
    const commitThumbnail = (thumbnail: string | null | undefined): boolean => {
      if (disposed || !thumbnail) {
        return false;
      }
      updateNodeData(id, { previewImageUrl: thumbnail });
      return true;
    };
    void (async () => {
      const localThumbnail = await extractVideoThumbnail(sourcePath).catch(() => null);
      if (commitThumbnail(localThumbnail) || disposed) {
        return;
      }
      try {
        const dataUrl = await captureVideoFrame({
          source: sourcePath,
          maxWidth: REMOTE_VIDEO_THUMBNAIL_MAX_WIDTH,
        });
        const prepared = await prepareNodeImage(dataUrl);
        commitThumbnail(prepared.previewImageUrl ?? prepared.imageUrl ?? dataUrl);
      } catch (error) {
        // 三级取帧都失败时保持 video 播放器显示, 不打断用户。
        console.warn('[mediaNode] remote video thumbnail fallback failed', error);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [data.previewImageUrl, data.sourcePath, id, isVideo, updateNodeData]);

  const handleCaptureFrame = useCallback(async () => {
    const source = data.sourcePath;
    if (!source) {
      return;
    }
    setIsCapturing(true);
    try {
      // 抽帧统一走 captureVideoFrame: 远端 CDN 的视频不能直接绘制到 canvas(画布会被污染),
      // 该函数会回退到 Rust 取字节转同源 blob。取用户当前停留的时间点作为截图画面。
      const dataUrl = await captureVideoFrame({
        source,
        timeSec: videoRef.current?.currentTime ?? 0,
      });
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
      // 截图结果节点无法创建时, 用全局错误弹窗反馈(按钮已移到节点工具栏, 节点内不再有错误行)。
      void showErrorDialog(
        error instanceof DOMException && error.name === 'SecurityError'
          ? '视频源未授权跨域截图'
          : error instanceof Error
            ? error.message
            : '截图失败',
        '截图失败'
      );
    } finally {
      setIsCapturing(false);
    }
  }, [addDerivedExportNode, addEdge, data.sourcePath, id]);

  /** 截图入口已移到节点工具栏(下载旁), 通过事件总线触发, 与 upload-node/reupload 一致。 */
  useEffect(() => {
    return canvasEventBus.subscribe('media-node/capture-frame', ({ nodeId }) => {
      if (nodeId === id) {
        void handleCaptureFrame();
      }
    });
  }, [handleCaptureFrame, id]);

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
      className={`relative flex h-full w-full flex-col rounded-[var(--node-radius)] border bg-surface-dark/90 p-2 transition-colors duration-150 ${
        hasGenerationError
          ? (selected
            ? 'border-red-400 shadow-[0_0_0_1px_rgba(248,113,113,0.42)]'
            : 'border-red-500/70 bg-[rgba(127,29,29,0.12)] hover:border-red-400/80 dark:border-red-500/70 dark:hover:border-red-400/80')
          : selected
          ? 'border-accent shadow-[0_0_0_1px_rgba(59,130,246,0.32)]'
          : 'border-[rgba(15,23,42,0.22)] dark:border-[rgba(255,255,255,0.22)]'
      }`}
      {...dropHandlers}
      {...mediaHover.hoverProps}
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
              {/* 媒体元素默认 draggable: 不关掉时按住画面拖动会触发浏览器原生拖拽,
                  生成一个跟随鼠标的拖影, 与 React Flow 的节点拖动争夺同一个指针,
                  表现为节点粘在鼠标上甩不掉。项目内所有 <img> 都已 draggable={false},
                  此处补齐 video/audio。 */}
              <video
                ref={videoRef}
                controls
                draggable={false}
                onDragStart={(event) => event.preventDefault()}
                src={mediaSrc}
                preload="metadata"
                poster={data.previewImageUrl ? resolveImageDisplayUrl(data.previewImageUrl) : undefined}
                className="nodrag h-full w-full object-contain"
                onLoadedMetadata={handleVideoMetadata}
                onLoadedData={() => void handleAutoCaptureThumbnail()}
                onDoubleClick={(event) => {
                  // 兜底: 若元素级捕获监听未生效, 这里仍取消原生全屏并打开查看器。
                  // (捕获阶段拦下时本回调不会执行 —— 事件已被拦截。)
                  event.preventDefault();
                  event.stopPropagation();
                  setIsVideoViewerOpen(true);
                }}
              />
              {/* 截图进行中的轻量反馈: 按钮在节点工具栏, 这里只显示进度 */}
              {isCapturing && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/35">
                  <span className="flex items-center gap-1.5 rounded-full bg-bg-dark/85 px-2.5 py-1 text-[11px] text-text-dark">
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin text-accent/80" />
                    截图中…
                  </span>
                </div>
              )}
            </div>
            <MediaDimensionsLabel
              dimensions={videoDimensions}
              fileSize={mediaByteSize}
              visible={mediaHover.visible}
            />
          </>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2.5 rounded-lg border border-[rgba(255,255,255,0.1)] bg-bg-dark/45 p-2">
            <AudioLines className="h-8 w-8 text-accent/70" />
            {/* 与视频同理: 音频元素默认 draggable, 需关掉原生拖拽。 */}
            <audio
              controls
              draggable={false}
              onDragStart={(event) => event.preventDefault()}
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
          onClick={() => void handleUploadClick()}
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
      <NodeResizeHandle {...resolveMediaNodeResizeBounds(CANVAS_NODE_TYPES.audio, data)} />
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
            ref={viewerVideoRef}
            controls
            autoPlay
            draggable={false}
            onDragStart={(event) => event.preventDefault()}
            onDoubleClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
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
