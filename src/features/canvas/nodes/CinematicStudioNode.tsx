import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { Clapperboard, MousePointer2 } from 'lucide-react';

import {
  CANVAS_NODE_TYPES,
  type CinematicStudioNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { useCanvasStore } from '@/stores/canvasStore';
import { CinematicStudioWorkbench } from '@/features/cinematicStudio/CinematicStudioWorkbench';

type CinematicStudioNodeProps = NodeProps & {
  id: string;
  data: CinematicStudioNodeData;
  selected?: boolean;
};

const CINEMATIC_STUDIO_NODE_MIN_WIDTH = 240;
const CINEMATIC_STUDIO_NODE_MIN_HEIGHT = 160;

export const CinematicStudioNode = memo(({ id, data, selected, width, height }: CinematicStudioNodeProps) => {
  const updateNodeInternals = useUpdateNodeInternals();
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const addNode = useCanvasStore((state) => state.addNode);
  const findNodePosition = useCanvasStore((state) => state.findNodePosition);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const [isOpen, setIsOpen] = useState(false);

  const resolvedWidth = typeof width === 'number' && width > 1
    ? Math.round(width)
    : CINEMATIC_STUDIO_NODE_MIN_WIDTH;
  const resolvedHeight = typeof height === 'number' && height > 1
    ? Math.round(height)
    : CINEMATIC_STUDIO_NODE_MIN_HEIGHT;

  const displayName = useMemo(
    () => resolveNodeDisplayName(CANVAS_NODE_TYPES.cinematicStudio, data),
    [data]
  );

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, resolvedHeight, resolvedWidth, updateNodeInternals]);

  const handleOpen = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      setSelectedNode(id);
      setIsOpen(true);
    },
    [id, setSelectedNode]
  );

  const handleClose = useCallback(() => {
    setIsOpen(false);
  }, []);

  const handleStateChange = useCallback(
    (snapshot: { projectTitle?: string; projectDescription?: string; promptPreview?: string; referenceImages?: string[]; referenceAudio?: string[] }) => {
      updateNodeData(id, {
        lastProjectTitle: typeof snapshot.projectTitle === 'string' ? snapshot.projectTitle : null,
        lastProjectDescription: typeof snapshot.projectDescription === 'string' ? snapshot.projectDescription : null,
        lastPromptPreview: typeof snapshot.promptPreview === 'string' ? snapshot.promptPreview : null,
        studioReferenceImages: Array.isArray(snapshot.referenceImages) ? snapshot.referenceImages : [],
        studioReferenceAudio: Array.isArray(snapshot.referenceAudio) ? snapshot.referenceAudio : [],
      });
    },
    [id, updateNodeData]
  );

  const handleSendToVideo = useCallback((payload: { prompt: string; referenceImages: string[]; referenceAudio: string[] }) => {
    const nextPrompt = payload.prompt.trim();
    if (!nextPrompt) return;
    const placement = findNodePosition(id, 420, 360);
    const videoNodeId = addNode(CANVAS_NODE_TYPES.videoGen, placement, {
      prompt: nextPrompt,
      model: '',
      duration: 5,
      aspectRatio: '16:9',
      resolution: '720p',
      imageMode: 'reference',
      studioReferenceImages: payload.referenceImages,
      studioReferenceAudio: payload.referenceAudio,
    });
    addEdge(id, videoNodeId);
    setSelectedNode(videoNodeId);
  }, [addEdge, addNode, findNodePosition, id, setSelectedNode]);

  const cachedTitle = typeof data.lastProjectTitle === 'string' ? data.lastProjectTitle.trim() : '';
  const cachedDescription = typeof data.lastProjectDescription === 'string' ? data.lastProjectDescription.trim() : '';
  // Do not keep showing the bundled Rain Night demo in nodes created by older builds.
  const isLegacyPreview = (cachedTitle === '雨夜' || cachedTitle === 'Rain Night')
    && cachedDescription === '一个男人穿过暴雨中的城市，把所有情绪压在心底。';
  const projectTitle = cachedTitle && !isLegacyPreview ? cachedTitle : null;
  const projectDescription = cachedDescription && !isLegacyPreview ? cachedDescription : null;
  // 节点标题和简介必须反映工程元数据，不能把最终提示词片段误当作项目简介。
  const nodeTitle = projectTitle ?? displayName;

  return (
    <div
      className={`
        group relative flex h-full flex-col overflow-visible rounded-[var(--node-radius)] border bg-surface-dark/90 p-2 transition-colors duration-150
        ${selected
          ? 'border-accent shadow-[0_0_0_1px_rgba(59,130,246,0.32)]'
          : 'border-[rgba(15,23,42,0.22)] hover:border-[rgba(15,23,42,0.34)] dark:border-[rgba(255,255,255,0.22)] dark:hover:border-[rgba(255,255,255,0.34)]'}
      `}
      style={{ width: resolvedWidth, height: resolvedHeight }}
      onDoubleClick={(event) => {
        const target = event.target as HTMLElement | null;
        if (target?.closest('button, input, textarea, select, .react-flow__handle')) {
          return;
        }
        handleOpen(event);
      }}
    >
      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<Clapperboard className="h-4 w-4" />}
        titleText={nodeTitle}
        editable={false}
      />

      <button
        type="button"
        className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-2 overflow-hidden rounded-lg border border-[rgba(255,255,255,0.12)] bg-bg-dark/70 transition-colors hover:border-[rgba(255,255,255,0.24)]"
        onDoubleClick={handleOpen}
        title="双击进入电影提示词工作室"
      >
        <Clapperboard className="h-10 w-10 text-text-muted/60" />

        {projectDescription ? (
          <span className="line-clamp-2 max-w-[calc(100%-16px)] px-2 text-center text-[11px] leading-snug text-text-muted">
            {projectDescription}
          </span>
        ) : (
          <span className="px-2 text-center text-[11px] text-text-muted">暂无项目简介</span>
        )}

        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-center gap-1.5 bg-gradient-to-t from-black/70 to-transparent px-2 pb-2 pt-6">
          <MousePointer2 className="h-3.5 w-3.5 text-white/85" />
          <span className="text-[11px] text-white/90">双击进入</span>
        </div>
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
      <NodeResizeHandle minWidth={CINEMATIC_STUDIO_NODE_MIN_WIDTH} minHeight={CINEMATIC_STUDIO_NODE_MIN_HEIGHT} />

      {isOpen && typeof document !== 'undefined'
        ? createPortal(
          <CinematicStudioWorkbench onClose={handleClose} onStateChange={handleStateChange} onSendToVideo={handleSendToVideo} />,
          document.body
        )
        : null}
    </div>
  );
});

CinematicStudioNode.displayName = 'CinematicStudioNode';
