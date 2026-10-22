import { useMemo } from 'react';
import {
  ConnectionLineType,
  getBezierPath,
  getSmoothStepPath,
  getStraightPath,
  useStore,
  type ConnectionLineComponentProps,
  type InternalNode,
} from '@xyflow/react';

import { resolveBatchAnchorCandidates } from '@/features/canvas/application/batchNodeConnection';

interface LinePoint {
  x: number;
  y: number;
}

interface GhostLine {
  id: string;
  source: LinePoint;
}

/**
 * 取节点某个方向端口的绝对坐标（flow 坐标系）。
 *
 * 优先用 React Flow 量好的 `handleBounds`（像素精确、含节点内边距/边框）；
 * 还没量到（刚添加的节点）时退回「节点右/左边中点」，宁可近似一条也不要整条线消失。
 * 坐标一律基于 `positionAbsolute` —— 分组子节点的 `position` 是相对父级的，不能直接用。
 */
function resolveHandleAnchor(
  node: InternalNode | undefined,
  handleType: 'source' | 'target',
): LinePoint | null {
  if (!node) {
    return null;
  }

  const absolute = node.internals?.positionAbsolute ?? node.position;
  const bounds = node.internals?.handleBounds?.[handleType]?.[0];

  if (bounds) {
    return {
      x: absolute.x + bounds.x + bounds.width / 2,
      y: absolute.y + bounds.y + bounds.height / 2,
    };
  }

  const width = node.measured?.width ?? node.width ?? 0;
  const height = node.measured?.height ?? node.height ?? 0;

  return {
    x: handleType === 'source' ? absolute.x + width : absolute.x,
    y: absolute.y + height / 2,
  };
}

/** 与 React Flow 内置 ConnectionLine 同款路径生成，保证主连线看不出换过实现。 */
function buildPath(
  type: ConnectionLineType,
  params: {
    sourceX: number;
    sourceY: number;
    sourcePosition: ConnectionLineComponentProps['fromPosition'];
    targetX: number;
    targetY: number;
    targetPosition: ConnectionLineComponentProps['toPosition'];
  },
): string {
  switch (type) {
    case ConnectionLineType.Step:
      return getSmoothStepPath({ ...params, borderRadius: 0 })[0];
    case ConnectionLineType.SmoothStep:
      return getSmoothStepPath(params)[0];
    case ConnectionLineType.Straight:
      return getStraightPath(params)[0];
    default:
      return getBezierPath(params)[0];
  }
}

/**
 * 拖连接线时的「批量预览」——框选多个节点后从其中一个拉线，**拉出来就是好几条**，
 * 而不是松手落到目标上才突然变成多条。
 *
 * 怎么拿到「还有哪些节点要一起连」：直接读 React Flow 内部状态 —— `state.nodes` 提供
 * `selected`（与喂进来的 `nodes` prop 同一批对象），`state.nodeLookup` 提供量好的端口几何；
 * 不用再往 Canvas 里加一套 state，也不用在指针每次移动时去查 DOM。
 * 候选判定复用 `resolveBatchAnchorCandidates` —— 与松手后落地的 `buildBatchConnections`
 * 是同一份判据，所以「看到几条线就落地几条边」。
 *
 * 未框选时候选只有一个（锚点自己），这里只画原本那一条线，行为与默认实现一致。
 */
export function BatchConnectionLine({
  connectionLineStyle,
  connectionLineType,
  fromNode,
  fromHandle,
  fromX,
  fromY,
  fromPosition,
  toX,
  toY,
  toPosition,
}: ConnectionLineComponentProps) {
  const nodes = useStore((state) => state.nodes);
  const nodeLookup = useStore((state) => state.nodeLookup);
  // fromHandle 是「用户按住的那个端口」，它的 type 决定批量的是哪一端。
  const handleType = fromHandle?.type === 'target' ? 'target' : 'source';

  const ghostLines = useMemo<GhostLine[]>(() => {
    if (nodes.length === 0) {
      return [];
    }

    const candidates = resolveBatchAnchorCandidates({
      anchorNodeId: fromNode.id,
      anchorHandleType: handleType,
      nodes,
    });

    if (candidates.length < 2) {
      return [];
    }

    const lines: GhostLine[] = [];

    for (const candidate of candidates) {
      if (candidate.id === fromNode.id) {
        continue;
      }

      const source = resolveHandleAnchor(nodeLookup.get(candidate.id), handleType);
      if (source) {
        lines.push({ id: candidate.id, source });
      }
    }

    return lines;
  }, [nodes, nodeLookup, fromNode.id, handleType]);

  const mainPath = buildPath(connectionLineType, {
    sourceX: fromX,
    sourceY: fromY,
    sourcePosition: fromPosition,
    targetX: toX,
    targetY: toY,
    targetPosition: toPosition,
  });

  return (
    <>
      {ghostLines.map((line) => (
        <path
          key={line.id}
          d={buildPath(connectionLineType, {
            sourceX: line.source.x,
            sourceY: line.source.y,
            sourcePosition: fromPosition,
            targetX: toX,
            targetY: toY,
            targetPosition: toPosition,
          })}
          fill="none"
          className="react-flow__connection-path"
          style={connectionLineStyle}
          // 幽灵线比主线淡一档：一眼看得出主线在哪，又知道这几条也会一起连上。
          strokeOpacity={0.45}
        />
      ))}
      <path
        d={mainPath}
        fill="none"
        className="react-flow__connection-path"
        style={connectionLineStyle}
      />
    </>
  );
}
