import {
  DEFAULT_NODE_WIDTH,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';

interface FramePlacementSize {
  width: number;
  height: number;
}

interface ViewportState {
  x: number;
  y: number;
  zoom: number;
}

interface ViewportSize {
  width: number;
  height: number;
}

const PLACEMENT_GAP = 24;
const COLLISION_GAP = 12;
const MAX_SEARCH_RING = 16;

function resolveDimension(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return fallback;
}

function resolveNodeSize(node: CanvasNode): FramePlacementSize {
  const style = node.style as { width?: unknown; height?: unknown } | undefined;
  return {
    width: resolveDimension(node.measured?.width ?? node.width ?? style?.width, DEFAULT_NODE_WIDTH),
    height: resolveDimension(node.measured?.height ?? node.height ?? style?.height, 200),
  };
}

function resolveAbsolutePosition(node: CanvasNode, nodeMap: Map<string, CanvasNode>): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let current: CanvasNode | undefined = node;
  const visited = new Set<string>();

  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    x += current.position.x;
    y += current.position.y;
    current = current.parentId ? nodeMap.get(current.parentId) : undefined;
  }

  return { x, y };
}

function overlaps(
  first: { x: number; y: number; width: number; height: number },
  second: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    first.x < second.x + second.width + COLLISION_GAP
    && first.x + first.width + COLLISION_GAP > second.x
    && first.y < second.y + second.height + COLLISION_GAP
    && first.y + first.height + COLLISION_GAP > second.y
  );
}

function buildSearchOffsets(ring: number): Array<{ x: number; y: number }> {
  if (ring === 0) {
    return [{ x: 0, y: 0 }];
  }

  const offsets: Array<{ x: number; y: number }> = [];
  for (let y = -ring; y <= ring; y += 1) {
    for (let x = -ring; x <= ring; x += 1) {
      if (Math.max(Math.abs(x), Math.abs(y)) !== ring) {
        continue;
      }
      offsets.push({ x, y });
    }
  }

  return offsets.sort((first, second) => {
    const distanceDifference = Math.hypot(first.x, first.y) - Math.hypot(second.x, second.y);
    if (distanceDifference !== 0) {
      return distanceDifference;
    }
    // Keep the first few frames in a readable left-to-right, top-to-bottom layout.
    return first.y - second.y || first.x - second.x;
  });
}

function resolveViewportCenter(
  viewport: ViewportState,
  viewportSize: ViewportSize,
  nodeSize: FramePlacementSize,
): { x: number; y: number } {
  const zoom = Math.max(0.01, viewport.zoom || 1);
  const width = viewportSize.width > 0 ? viewportSize.width : 1024;
  const height = viewportSize.height > 0 ? viewportSize.height : 768;
  return {
    x: (width / 2 - viewport.x) / zoom - nodeSize.width / 2,
    y: (height / 2 - viewport.y) / zoom - nodeSize.height / 2,
  };
}

/** Finds compact, non-overlapping positions around the visible canvas center. */
export function resolveFrameInsertPositions(
  nodes: CanvasNode[],
  viewport: ViewportState,
  viewportSize: ViewportSize,
  frameSizes: FramePlacementSize[],
): Array<{ x: number; y: number }> {
  const nodeMap = new Map(nodes.map((node) => [node.id, node] as const));
  const occupied = nodes.map((node) => {
    const position = resolveAbsolutePosition(node, nodeMap);
    const size = resolveNodeSize(node);
    return { ...position, ...size };
  });
  const positions: Array<{ x: number; y: number }> = [];

  frameSizes.forEach((frameSize) => {
    const center = resolveViewportCenter(viewport, viewportSize, frameSize);
    const stepX = frameSize.width + PLACEMENT_GAP;
    const stepY = frameSize.height + PLACEMENT_GAP;
    let selected: { x: number; y: number } | null = null;

    for (let ring = 0; ring <= MAX_SEARCH_RING && !selected; ring += 1) {
      for (const offset of buildSearchOffsets(ring)) {
        const candidate = {
          x: Math.round(center.x + offset.x * stepX),
          y: Math.round(center.y + offset.y * stepY),
        };
        const candidateRect = { ...candidate, ...frameSize };
        const isOccupied = occupied.some((rect) => overlaps(candidateRect, rect))
          || positions.some((position, index) => overlaps(candidateRect, {
            ...position,
            ...frameSizes[index],
          }));
        if (!isOccupied) {
          selected = candidate;
          break;
        }
      }
    }

    // A heavily packed canvas should still receive the frame instead of falling back
    // to a distant random coordinate.
    const resolved = selected ?? {
      x: Math.round(center.x),
      y: Math.round(center.y),
    };
    positions.push(resolved);
  });

  return positions;
}
