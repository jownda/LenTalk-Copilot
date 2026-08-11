import { memo, useMemo } from 'react';
import { Handle, Position } from '@xyflow/react';
import { LayoutGrid } from 'lucide-react';

import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { CANVAS_NODE_TYPES, type GroupNodeData } from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { useCanvasStore } from '@/stores/canvasStore';

type GroupNodeProps = {
  id: string;
  data: GroupNodeData;
  selected?: boolean;
};

export const GroupNode = memo(({ id, data, selected }: GroupNodeProps) => {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const hoveredGroupId = useCanvasStore((state) => state.hoveredGroupId);
  const flashGroupId = useCanvasStore((state) => state.flashGroupId);
  const chargingGroupId = useCanvasStore((state) => state.chargingGroupId);
  const resolvedTitle = useMemo(
    () => resolveNodeDisplayName(CANVAS_NODE_TYPES.group, data),
    [data]
  );

  const isHovered = hoveredGroupId === id;
  const isFlash = flashGroupId === id;
  const isCharging = chargingGroupId === id;

  return (
    <div
      className={`group relative h-full w-full overflow-visible rounded-[18px] border transition-colors duration-150 ${
        isCharging
          ? 'border-accent shadow-[0_0_0_2px_rgba(59,130,246,0.45)]'
          : isHovered || isFlash
            ? 'border-accent shadow-[0_0_0_2px_rgba(59,130,246,0.45)]'
            : selected
              ? 'border-accent shadow-[0_0_0_1px_rgba(59,130,246,0.35)]'
              : 'border-[rgba(15,23,42,0.2)] dark:border-[rgba(255,255,255,0.26)]'
      }`}
      style={{
        backgroundColor: isCharging
          ? 'rgba(59,130,246,0.14)'
          : isHovered
            ? 'rgba(59,130,246,0.10)'
            : isFlash
              ? 'rgba(59,130,246,0.16)'
              : 'var(--group-node-bg)',
        animation: isCharging ? 'group-charge-pulse 0.8s ease-in-out infinite' : undefined,
      }}
    >
      {isCharging && (
        <style>{`@keyframes group-charge-pulse { 0%,100% { box-shadow: 0 0 0 2px rgba(59,130,246,0.30), 0 0 10px 1px rgba(59,130,246,0.20); } 50% { box-shadow: 0 0 0 3px rgba(59,130,246,0.65), 0 0 22px 6px rgba(59,130,246,0.45); } }`}</style>
      )}
      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<LayoutGrid className="h-4 w-4" />}
        titleText={resolvedTitle}
        editable
        onTitleChange={(nextTitle) => updateNodeData(id, {
          displayName: nextTitle,
          label: nextTitle,
        })}
      />
      <NodeResizeHandle minWidth={220} minHeight={140} maxWidth={2200} maxHeight={1600} />

      <Handle
        type="source"
        id="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-surface-dark !bg-accent"
      />
    </div>
  );
});

GroupNode.displayName = 'GroupNode';
