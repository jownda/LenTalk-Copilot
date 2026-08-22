import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Handle,
  Position,
  useUpdateNodeInternals,
  type NodeProps,
} from '@xyflow/react';
import { Box, Camera, ImageIcon, MousePointer2 } from 'lucide-react';

import {
  CANVAS_NODE_TYPES,
  type DirectorDeskNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { CanvasNodeImage } from '@/features/canvas/ui/CanvasNodeImage';
import { graphImageResolver } from '@/features/canvas/application/canvasServices';
import {
  prepareNodeImage,
  resolveImageDisplayUrl,
} from '@/features/canvas/application/imageData';
import { persistLibraryAssetBinary } from '@/commands/assetLibrary';
import { useCanvasStore } from '@/stores/canvasStore';
import { ThreeDDirectorDesk } from '@/features/threeDDirector/ThreeDDirectorDesk';
import { registerHostCaptureSourceNode } from '@/features/threeDDirector/editor/io/hostBridge';

type DirectorDeskNodeProps = NodeProps & {
  id: string;
  data: DirectorDeskNodeData;
  selected?: boolean;
};

const DIRECTOR_DESK_NODE_MIN_WIDTH = 240;
const DIRECTOR_DESK_NODE_MIN_HEIGHT = 180;

const CAPTURES_SENT_MESSAGE_TYPE = 'storyai:director-desk-captures-sent';
const REFERENCE_VIDEO_SENT_MESSAGE_TYPE = 'storyai:director-desk-reference-video-sent';
const PANORAMA_MESSAGE_TYPE = 'storyai:director-desk-panorama';

interface HostCaptureItem {
  dataUrl?: unknown;
  fileName?: unknown;
}

interface HostReferenceVideo {
  dataUrl?: unknown;
  fileName?: unknown;
  sourceNodeId?: unknown;
}

function getFileExtension(fileName: string) {
  const extension = fileName.split('.').pop()?.trim().toLowerCase();
  return extension && /^[a-z0-9]{1,10}$/.test(extension) ? extension : 'mp4';
}

export const DirectorDeskNode = memo(({ id, data, selected, width, height }: DirectorDeskNodeProps) => {
  const updateNodeInternals = useUpdateNodeInternals();
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const addDerivedExportNode = useCanvasStore((state) => state.addDerivedExportNode);
  const addNode = useCanvasStore((state) => state.addNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const findNodePosition = useCanvasStore((state) => state.findNodePosition);
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);

  const [isDeskOpen, setIsDeskOpen] = useState(false);
  const [isHandlingCaptures, setIsHandlingCaptures] = useState(false);

  const resolvedWidth = typeof width === 'number' && width > 1
    ? Math.round(width)
    : DIRECTOR_DESK_NODE_MIN_WIDTH;
  const resolvedHeight = typeof height === 'number' && height > 1
    ? Math.round(height)
    : DIRECTOR_DESK_NODE_MIN_HEIGHT;

  const displayName = useMemo(
    () => resolveNodeDisplayName(CANVAS_NODE_TYPES.directorDesk, data),
    [data]
  );

  const lastCaptureSource = useMemo(() => {
    const picked = data.lastCapturePreviewUrl || data.lastCaptureUrl;
    return picked ? resolveImageDisplayUrl(picked) : null;
  }, [data.lastCapturePreviewUrl, data.lastCaptureUrl]);

  // 上游图片:自动作为导演台的全景图背景
  const inputImages = useMemo(
    () => graphImageResolver.collectInputImages(id, nodes, edges),
    [edges, id, nodes]
  );
  const panoramaImageUrl = inputImages[0] ?? null;
  const panoramaEdge = useMemo(() => {
    if (!panoramaImageUrl) {
      return null;
    }
    return edges.find((edge) => edge.target === id) ?? null;
  }, [edges, id, panoramaImageUrl]);

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, resolvedHeight, resolvedWidth, updateNodeInternals]);

  const handleCaptures = useCallback(
    async (captures: HostCaptureItem[]) => {
      if (isHandlingCaptures) {
        return;
      }
      setIsHandlingCaptures(true);
      try {
        for (const capture of captures) {
          const dataUrl = typeof capture?.dataUrl === 'string' ? capture.dataUrl : '';
          if (!dataUrl) {
            continue;
          }
          const prepared = await prepareNodeImage(dataUrl);
          const createdNodeId = addDerivedExportNode(
            id,
            prepared.imageUrl,
            prepared.aspectRatio,
            prepared.previewImageUrl,
            {
              defaultTitle: '3D 导演台截图',
              resultKind: 'generic',
              aspectRatioStrategy: 'provided',
            }
          );
          if (createdNodeId) {
            addEdge(id, createdNodeId);
          }
          // 同步更新节点缩略图,便于下次进入前预览最近截图
          updateNodeData(id, {
            lastCaptureUrl: prepared.imageUrl,
            lastCapturePreviewUrl: prepared.previewImageUrl,
            lastCaptureAspectRatio: prepared.aspectRatio,
          });
        }
      } catch (error) {
        console.warn('[directorDeskNode] handle captures failed', error);
      } finally {
        setIsHandlingCaptures(false);
      }
    },
    [addDerivedExportNode, addEdge, id, isHandlingCaptures, updateNodeData]
  );

  const handleReferenceVideo = useCallback(async (video: HostReferenceVideo) => {
    const dataUrl = typeof video.dataUrl === 'string' ? video.dataUrl : '';
    if (!dataUrl) {
      return;
    }

    const fileName = typeof video.fileName === 'string' && video.fileName.trim()
      ? video.fileName.trim()
      : '3D导演台运镜.mp4';
    try {
      const response = await fetch(dataUrl);
      if (!response.ok) {
        throw new Error(`视频数据读取失败 (${response.status})`);
      }
      const sourcePath = await persistLibraryAssetBinary(
        new Uint8Array(await response.arrayBuffer()),
        getFileExtension(fileName)
      );
      const placement = findNodePosition(id, 320, 250);
      const mediaNodeId = addNode(CANVAS_NODE_TYPES.audio, placement, {
        displayName: fileName.replace(/\.[^.]+$/, '').trim() || fileName,
        mediaType: 'video',
        previewImageUrl: null,
        sourcePath,
      });
      addEdge(id, mediaNodeId);
    } catch (error) {
      console.warn('[directorDeskNode] handle reference video failed', error);
    }
  }, [addEdge, addNode, findNodePosition, id]);

  // 打开导演台期间:注册 sourceNodeId + 监听导演台发来的截图消息
  useEffect(() => {
    if (!isDeskOpen) {
      return;
    }

    registerHostCaptureSourceNode(id);

    const handleMessage = (event: MessageEvent) => {
      const messageType = event.data?.type;
      if (messageType !== CAPTURES_SENT_MESSAGE_TYPE && messageType !== REFERENCE_VIDEO_SENT_MESSAGE_TYPE) {
        return;
      }
      const payload = event.data?.payload;
      const sourceNodeId = typeof payload?.sourceNodeId === 'string' ? payload.sourceNodeId : null;
      // 内嵌模式下产物应只属于当前节点;若带其他 sourceNodeId 则忽略
      if (sourceNodeId && sourceNodeId !== id) {
        return;
      }
      if (messageType === CAPTURES_SENT_MESSAGE_TYPE) {
        const captures = Array.isArray(payload?.captures) ? (payload.captures as HostCaptureItem[]) : [];
        if (captures.length > 0) {
          void handleCaptures(captures);
        }
        return;
      }
      void handleReferenceVideo(payload as HostReferenceVideo);
    };

    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
      registerHostCaptureSourceNode(null);
    };
  }, [handleCaptures, handleReferenceVideo, id, isDeskOpen]);

  // 打开导演台期间:上游图片变化时自动同步为全景图背景
  useEffect(() => {
    if (!isDeskOpen || !panoramaImageUrl) {
      return;
    }

    // 等导演台 host bridge 初始化完成后再发送
    const timer = window.setTimeout(() => {
      window.postMessage(
        {
          type: PANORAMA_MESSAGE_TYPE,
          payload: {
            // 画布图片在 Tauri 下可能保存为本地路径，导演台纹理需要可加载的 asset URL。
            imageUrl: resolveImageDisplayUrl(panoramaImageUrl),
            fileName: '画布全景图.png',
            edgeId: panoramaEdge?.id,
            sourceNodeId: panoramaEdge?.source,
          },
        },
        window.location.origin
      );
    }, 0);

    return () => window.clearTimeout(timer);
  }, [isDeskOpen, panoramaEdge, panoramaImageUrl]);

  const handleOpenDesk = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      setSelectedNode(id);
      setIsDeskOpen(true);
    },
    [id, setSelectedNode]
  );

  const handleCloseDesk = useCallback(() => {
    setIsDeskOpen(false);
  }, []);

  return (
    <div
      className={`
        group relative flex h-full flex-col overflow-visible rounded-[var(--node-radius)] border bg-surface-dark/90 p-2 transition-colors duration-150
        ${selected
          ? 'border-accent shadow-[0_0_0_1px_rgba(59,130,246,0.32)]'
          : 'border-[rgba(15,23,42,0.22)] hover:border-[rgba(15,23,42,0.34)] dark:border-[rgba(255,255,255,0.22)] dark:hover:border-[rgba(255,255,255,0.34)]'}
      `}
      style={{ width: resolvedWidth, height: resolvedHeight }}
      onClick={() => setSelectedNode(id)}
      onDoubleClick={handleOpenDesk}
    >
      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<Box className="h-4 w-4" />}
        titleText={displayName}
        editable
        onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
      />

      <button
        type="button"
        className="nodrag relative flex min-h-0 flex-1 flex-col items-center justify-center gap-2 overflow-hidden rounded-lg border border-[rgba(255,255,255,0.12)] bg-bg-dark/70 transition-colors hover:border-[rgba(255,255,255,0.24)]"
        onClick={handleOpenDesk}
        title="双击进入 3D 导演台"
      >
        {lastCaptureSource ? (
          <CanvasNodeImage
            src={lastCaptureSource}
            alt="最近截图"
            viewerSourceUrl={lastCaptureSource}
            className="h-full w-full object-cover"
            draggable={false}
          />
        ) : (
          <Box className="h-10 w-10 text-text-muted/60" />
        )}

        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-center gap-1.5 bg-gradient-to-t from-black/70 to-transparent px-2 pb-2 pt-6">
          <MousePointer2 className="h-3.5 w-3.5 text-white/85" />
          <span className="text-[11px] text-white/90">双击进入 3D 导演台</span>
        </div>

        {lastCaptureSource && (
          <div className="pointer-events-none absolute left-2 top-2 flex items-center gap-1 rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-white/90 backdrop-blur-sm">
            <Camera className="h-3 w-3" />
            最近截图
          </div>
        )}

        {panoramaImageUrl && (
          <div className="pointer-events-none absolute right-2 top-2 flex items-center gap-1 rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-white/90 backdrop-blur-sm">
            <ImageIcon className="h-3 w-3" />
            全景背景
          </div>
        )}
      </button>

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
      <NodeResizeHandle minWidth={DIRECTOR_DESK_NODE_MIN_WIDTH} minHeight={DIRECTOR_DESK_NODE_MIN_HEIGHT} />

      {isDeskOpen && typeof document !== 'undefined'
        ? createPortal(
          <ThreeDDirectorDesk onClose={handleCloseDesk} />,
          document.body
        )
        : null}
    </div>
  );
});

DirectorDeskNode.displayName = 'DirectorDeskNode';
