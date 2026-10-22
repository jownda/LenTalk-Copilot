import { memo, useMemo } from 'react';
import { Handle, Position } from '@xyflow/react';
import { LayoutGrid, Lock } from 'lucide-react';

import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { CANVAS_NODE_TYPES, type GroupNodeData } from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { useCanvasStore } from '@/stores/canvasStore';

type GroupNodeProps = {
  id: string;
  data: GroupNodeData;
  selected?: boolean;
};

/** 冻结组统一走灰阶配色, 与可编辑状态(蓝色系)在视觉上明确区分 */
const FROZEN_BG = 'rgba(148, 163, 184, 0.14)';
const FROZEN_BG_HOVER = 'rgba(148, 163, 184, 0.22)';

export const GroupNode = memo(({ id, data, selected }: GroupNodeProps) => {
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
  const isFrozen = data.frozen === true;
  // 冻结组不会再成为拖入目标(charging 不会命中), 这里只做视觉兜底
  const isHighlighted = isHovered || isFlash || isCharging || Boolean(selected);

  const borderClassName = isFrozen
    ? isHighlighted
      ? 'border-[rgba(148,163,184,0.72)] shadow-[0_0_0_2px_rgba(148,163,184,0.30)]'
      : 'border-[rgba(148,163,184,0.38)]'
    : isCharging || isHovered || isFlash
      ? 'border-accent shadow-[0_0_0_2px_rgba(59,130,246,0.45)]'
      : selected
        ? 'border-accent shadow-[0_0_0_1px_rgba(59,130,246,0.35)]'
        : 'border-[rgba(15,23,42,0.2)] dark:border-[rgba(255,255,255,0.26)]';

  const backgroundColor = isFrozen
    ? isHighlighted
      ? FROZEN_BG_HOVER
      : FROZEN_BG
    : isCharging
      ? 'rgba(59,130,246,0.14)'
      : isHovered
        ? 'rgba(59,130,246,0.10)'
        : isFlash
          ? 'rgba(59,130,246,0.16)'
          : 'var(--group-node-bg)';

  return (
    <div
      className={`group relative h-full w-full overflow-visible rounded-[18px] border transition-colors duration-150 ${borderClassName}`}
      style={{
        backgroundColor,
        animation: isCharging && !isFrozen ? 'group-charge-pulse 0.8s ease-in-out infinite' : undefined,
      }}
    >
      {isCharging && !isFrozen && (
        <style>{`@keyframes group-charge-pulse { 0%,100% { box-shadow: 0 0 0 2px rgba(59,130,246,0.30), 0 0 10px 1px rgba(59,130,246,0.20); } 50% { box-shadow: 0 0 0 3px rgba(59,130,246,0.65), 0 0 22px 6px rgba(59,130,246,0.45); } }`}</style>
      )}
      {isFrozen ? (
        <Lock className="pointer-events-none absolute left-3 top-3 z-0 h-4 w-4 text-slate-400/80" />
      ) : (
        <LayoutGrid className="pointer-events-none absolute left-3 top-3 z-0 h-4 w-4 text-text-muted/60" />
      )}
      <span
        className={`pointer-events-none absolute bottom-3 right-4 z-0 max-w-[75%] truncate text-right text-5xl font-semibold ${
          isFrozen ? 'text-slate-400/45' : 'text-text-muted/45'
        }`}
      >
        {resolvedTitle}
      </span>
      {/* 冻结组位置与尺寸均已锁定, 不提供缩放手柄 */}
      {!isFrozen && <NodeResizeHandle minWidth={220} minHeight={140} maxWidth={2200} maxHeight={1600} />}

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
