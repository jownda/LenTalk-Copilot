import { memo, useCallback, useEffect, useMemo, useRef, useState, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { isTauri } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { Handle, Position } from '@xyflow/react';
import {
  AlertTriangle,
  AudioLines,
  LoaderCircle,
  Maximize2,
  Music2,
  Pause,
  Play,
  Upload,
  Video,
  X,
} from 'lucide-react';

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

/** 已判定为空白(全透明)的缩略图地址缓存, 避免同一会话里反复解码同一张图。 */
const blankThumbnailCache = new Set<string>();

/**
 * 判断缩略图是否为空白图。
 *
 * 早期版本在视频帧尚未提交到合成器时就抽帧, 全透明画布被当成缩略图存了下来, 又因为内容
 * 完全一致被引用池复用 —— 表现就是一批视频节点"没有封面"。这里把图读回来采样 alpha 做一次
 * 判定, 命中即清空重抽。
 *
 * 读像素受同源限制: 本地路径经 resolveImageDisplayUrl 转成 asset 协议后同源可读; 若某张图
 * 跨域而抛 SecurityError, 按"正常"处理, 不影响原有显示。
 */
async function isBlankThumbnail(source: string): Promise<boolean> {
  if (blankThumbnailCache.has(source)) {
    return true;
  }
  return new Promise<boolean>((resolve) => {
    const image = new Image();
    image.onload = () => {
      try {
        const side = 32;
        const canvas = document.createElement('canvas');
        canvas.width = side;
        canvas.height = side;
        const context = canvas.getContext('2d');
        if (!context) {
          resolve(false);
          return;
        }
        context.drawImage(image, 0, 0, side, side);
        const pixels = context.getImageData(0, 0, side, side).data;
        let opaque = 0;
        for (let index = 3; index < pixels.length; index += 4) {
          if (pixels[index] > 8) {
            opaque += 1;
          }
        }
        const blank = opaque === 0;
        if (blank) {
          blankThumbnailCache.add(source);
        }
        resolve(blank);
      } catch {
        // 跨域或解码失败时无法判定, 保持原样。
        resolve(false);
      }
    };
    image.onerror = () => resolve(false);
    image.src = resolveImageDisplayUrl(source);
  });
}

/** 秒 -> `m:ss`; 未加载完/非法值(NaN, Infinity)统一显示 0:00。 */
function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return '0:00';
  }
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export const AudioNode = memo(({ id, data, selected }: AudioNodeProps) => {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const updateNodeDataTransient = useCanvasStore((state) => state.updateNodeDataTransient);
  const addDerivedExportNode = useCanvasStore((state) => state.addDerivedExportNode);
  const addEdge = useCanvasStore((state) => state.addEdge);

  const videoRef = useRef<HTMLVideoElement>(null);
  const viewerVideoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** 画面上的透明交互层: 承接指针事件并冒泡到节点, 实现"画面任意位置左键拖动节点"。 */
  const videoSurfaceRef = useRef<HTMLDivElement>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isVideoViewerOpen, setIsVideoViewerOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [videoDimensions, setVideoDimensions] = useState<MediaDimensions | null>(null);
  // 播放状态一律由 video 的 play/pause/ended 事件回写, 不做本地乐观更新,
  // 否则"自动播放被拒"或"源不可用"时按钮会显示成正在播放。
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  /** 指针是否在画面上: 控制条仅在悬停(或播放中)出现, 其余时间完全让位给拖动。 */
  const [isVideoHovered, setIsVideoHovered] = useState(false);

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
    setVideoDuration(0);
    setPlaybackTime(0);
    setIsPlaying(false);
  }, [mediaSrc]);

  const handleVideoMetadata = useCallback((event: SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      setVideoDimensions({ width: video.videoWidth, height: video.videoHeight });
    }
    // 时长用于控制条进度: 流式/未探测到时长时 duration 为 NaN 或 Infinity, 需挡掉。
    if (Number.isFinite(video.duration) && video.duration > 0) {
      setVideoDuration(video.duration);
    }
  }, []);

  /** 控制条播放/暂停按钮。播放失败(自动播放策略/源不可用)时保持暂停, 不打断用户。 */
  const toggleVideoPlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    if (video.paused) {
      void video.play().catch((error: unknown) => {
        console.warn('[mediaNode] video play failed', error);
      });
      return;
    }
    video.pause();
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
    // 放大播放器接管播放: 先停掉节点内的播放, 避免两路声音叠在一起。
    videoRef.current?.pause();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsVideoViewerOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isVideoViewerOpen]);

  // 双击画面 = 打开放大播放器。
  //
  // 现在画面上的指针事件全部落在覆盖层(videoSurfaceRef)上, <video> 自身是
  // pointer-events:none, 所以这里监听覆盖层而非 video 元素。
  // 仍必须挂在**捕获阶段**: React Flow 的"双击缩放"监听挂在 pane(祖先)上且在
  // 冒泡阶段执行, 早于 React root 的合成事件派发 —— JSX onDoubleClick 拦不住它,
  // 结果会是"双击既打开播放器又把画布缩放了"。目标元素上的捕获监听先执行, 就地
  // stopImmediatePropagation 可一并取消 UA 默认行为(原生全屏)与画布缩放。
  useEffect(() => {
    const surface = videoSurfaceRef.current;
    if (!isVideo || !surface) {
      return;
    }
    const handleDoubleClick = (event: MouseEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      setIsVideoViewerOpen(true);
    };
    surface.addEventListener('dblclick', handleDoubleClick, true);
    return () => {
      surface.removeEventListener('dblclick', handleDoubleClick, true);
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

  // 历史版本抽帧时视频帧尚未呈现, 在引用池里留下一批全透明"空白封面"(还被多个节点按内容复用)。
  // 拿到缩略图先做一次空白判定, 命中就清空, 由下面的抽帧流程重新生成(失败也不会再写空白图)。
  useEffect(() => {
    const thumbnail = data.previewImageUrl;
    if (!isVideo || !thumbnail) {
      return;
    }
    let disposed = false;
    void (async () => {
      const blank = await isBlankThumbnail(thumbnail);
      if (!disposed && blank) {
        updateNodeData(id, { previewImageUrl: null });
      }
    })();
    return () => {
      disposed = true;
    };
  }, [data.previewImageUrl, id, isVideo, updateNodeData]);

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
            {/* 视频画面顶到上部, 铺满可用空间; 缩略图作为 poster。
                交互约定: 画面任意位置左键拖拽 = 移动节点; 播放/暂停/进度在底部控制条;
                双击画面(或点放大按钮) 进放大播放器。 */}
            <div
              className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg border border-[rgba(255,255,255,0.1)] bg-black/45"
              onPointerEnter={() => setIsVideoHovered(true)}
              onPointerLeave={() => setIsVideoHovered(false)}
            >
              {/* 媒体元素默认 draggable: 不关掉时按住画面拖动会触发浏览器原生拖拽,
                  生成一个跟随鼠标的拖影, 与 React Flow 的节点拖动争夺同一个指针,
                  表现为节点粘在鼠标上甩不掉。项目内所有 <img> 都已 draggable={false},
                  此处补齐 video/audio。 */}
              <video
                ref={videoRef}
                draggable={false}
                onDragStart={(event) => event.preventDefault()}
                src={mediaSrc}
                preload="metadata"
                poster={data.previewImageUrl ? resolveImageDisplayUrl(data.previewImageUrl) : undefined}
                className="pointer-events-none h-full w-full object-contain"
                onLoadedMetadata={handleVideoMetadata}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onEnded={() => setIsPlaying(false)}
                onTimeUpdate={(event) => setPlaybackTime(event.currentTarget.currentTime)}
              />
              {/* 透明交互层: 画面上的指针事件落在这里并冒泡到节点, 于是画面任意位置
                  左键拖拽都能移动节点。刻意不加 nodrag —— 加了就拖不动了。 */}
              <div ref={videoSurfaceRef} className="absolute inset-0" />
              {/* 截图进行中的轻量反馈: 按钮在节点工具栏, 这里只显示进度 */}
              {isCapturing && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/35">
                  <span className="flex items-center gap-1.5 rounded-full bg-bg-dark/85 px-2.5 py-1 text-[11px] text-text-dark">
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin text-accent/80" />
                    截图中…
                  </span>
                </div>
              )}
              {/* 播放控制条: 带 nodrag, 在其上的指针不会拖动节点, 因此进度条可正常拖拽。
                  节点内不再使用原生 controls —— 原生控件会吃掉画面上的指针, 与"任意位置拖动节点"冲突。
                  仅悬停/播放中出现: 其余时间 opacity-0 + pointer-events-none, 画面整块都能拖。 */}
              <div
                className={`nodrag absolute inset-x-0 bottom-0 z-10 flex items-center gap-1.5 bg-gradient-to-t from-black/80 via-black/40 to-transparent px-2 pb-1.5 pt-6 text-white transition-opacity duration-150 ${
                  isVideoHovered || isPlaying ? 'opacity-100' : 'pointer-events-none opacity-0'
                }`}
              >
                <button
                  type="button"
                  onClick={toggleVideoPlayback}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/20 transition-colors hover:bg-white/40"
                  title={isPlaying ? '暂停' : '播放'}
                  aria-label={isPlaying ? '暂停' : '播放'}
                >
                  {isPlaying ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                </button>
                <input
                  type="range"
                  min={0}
                  max={videoDuration > 0 ? videoDuration : 1}
                  step={0.01}
                  value={videoDuration > 0 ? Math.min(playbackTime, videoDuration) : 0}
                  onChange={(event) => {
                    const video = videoRef.current;
                    const next = Number(event.target.value);
                    if (video && Number.isFinite(next)) {
                      video.currentTime = next;
                    }
                    setPlaybackTime(next);
                  }}
                  className="h-3 min-w-0 flex-1 cursor-pointer accent-white"
                  title="播放进度"
                  aria-label="播放进度"
                />
                <span className="shrink-0 text-[10px] tabular-nums text-white/80">
                  {formatClock(playbackTime)} / {formatClock(videoDuration)}
                </span>
                <button
                  type="button"
                  onClick={() => setIsVideoViewerOpen(true)}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-white/20 transition-colors hover:bg-white/40"
                  title="放大播放（双击画面同样可打开）"
                  aria-label="放大播放"
                >
                  <Maximize2 className="h-3 w-3" />
                </button>
              </div>
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
