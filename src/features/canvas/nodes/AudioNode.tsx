import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import { AudioLines, Camera, Music2, Upload, Video } from 'lucide-react';

import { CANVAS_NODE_TYPES, type AudioNodeData } from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { prepareNodeImage, resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { persistLibraryAssetBinary } from '@/commands/assetLibrary';
import { useCanvasStore } from '@/stores/canvasStore';

type AudioNodeProps = {
  id: string;
  data: AudioNodeData;
  selected?: boolean;
};

export const AudioNode = memo(({ id, data, selected }: AudioNodeProps) => {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const addDerivedExportNode = useCanvasStore((state) => state.addDerivedExportNode);
  const addEdge = useCanvasStore((state) => state.addEdge);

  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const resolvedTitle = useMemo(
    () => resolveNodeDisplayName(CANVAS_NODE_TYPES.audio, data),
    [data]
  );
  const isVideo = data.mediaType === 'video';
  const mediaSrc = data.sourcePath ? resolveImageDisplayUrl(data.sourcePath) : null;

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
      });
    } catch (error) {
      console.warn('[mediaNode] upload failed', error);
    } finally {
      setIsUploading(false);
    }
  }, [id, updateNodeData]);

  /** 视频截图: 当前帧绘制到 canvas → 生成图片节点到下游(右侧)并连线 */
  const handleCaptureFrame = useCallback(async () => {
    const videoEl = videoRef.current;
    if (!videoEl) {
      return;
    }
    setIsCapturing(true);
    setCaptureError(null);
    try {
      const width = videoEl.videoWidth > 0 ? videoEl.videoWidth : videoEl.clientWidth || 640;
      const height = videoEl.videoHeight > 0 ? videoEl.videoHeight : videoEl.clientHeight || 360;
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
      setCaptureError('截图失败');
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
        selected
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
            {/* 视频画面顶到上部, 铺满可用空间 */}
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg border border-[rgba(255,255,255,0.1)] bg-black/45">
              <video
                ref={videoRef}
                controls
                src={mediaSrc}
                preload="metadata"
                className="nodrag h-full w-full object-contain"
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
    </div>
  );
});

AudioNode.displayName = 'AudioNode';
