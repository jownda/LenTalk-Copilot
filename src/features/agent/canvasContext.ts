import { resolveNodeDisplayName } from "@/features/canvas/domain/nodeDisplay";
import { type CanvasEdge, type CanvasNode, type CanvasNodeData, type CanvasNodeType } from "@/features/canvas/domain/canvasNodes";
import { useCanvasStore } from "@/stores/canvasStore";

export interface CanvasAgentNodeSummary {
  id: string;
  type: string;
  title: string;
  position: { x: number; y: number };
  size?: { width?: number; height?: number };
  selected: boolean;
  data: Record<string, unknown>;
}

export interface CanvasAgentEdgeSummary {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

export interface CanvasAgentSnapshot {
  nodes: CanvasAgentNodeSummary[];
  edges: CanvasAgentEdgeSummary[];
  selectedNodeIds: string[];
  viewport: { x: number; y: number; zoom: number };
}

const SAFE_DATA_KEYS = [
  "displayName", "prompt", "content", "quickStyle", "quickSynopsis", "quickStaging",
  "quickStudioSceneId", "model", "imageMode", "aspectRatio", "resolution", "sourcePath",
  "mediaType", "imageUrl", "outputImageUrl", "inputImageUrl", "studioReferenceImages", "studioReferenceAudio",
] as const;

function summarizeData(data: CanvasNodeData): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const key of SAFE_DATA_KEYS) {
    const value = (data as Record<string, unknown>)[key];
    if (value !== undefined && value !== null && value !== "") summary[key] = value;
  }
  return summary;
}

function summarizeNode(node: CanvasNode, selectedNodeIds: Set<string>): CanvasAgentNodeSummary {
  const width = typeof node.measured?.width === "number" ? node.measured.width : node.width;
  const height = typeof node.measured?.height === "number" ? node.measured.height : node.height;
  return {
    id: node.id,
    type: node.type ?? "unknown",
    title: resolveNodeDisplayName(node.type as CanvasNodeType, node.data),
    position: { x: node.position.x, y: node.position.y },
    size: { width, height },
    selected: selectedNodeIds.has(node.id),
    data: summarizeData(node.data),
  };
}

export function getCanvasAgentSnapshot(state = useCanvasStore.getState()): CanvasAgentSnapshot {
  const selectedNodeIds = new Set(state.nodes.filter((node) => node.selected || node.id === state.selectedNodeId).map((node) => node.id));
  return {
    nodes: state.nodes.map((node) => summarizeNode(node, selectedNodeIds)),
    edges: state.edges.map((edge: CanvasEdge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
    })),
    selectedNodeIds: [...selectedNodeIds],
    viewport: {
      x: state.currentViewport.x,
      y: state.currentViewport.y,
      zoom: state.currentViewport.zoom,
    },
  };
}

export function getCanvasNode(nodeId: string, state = useCanvasStore.getState()): CanvasNode | undefined {
  return state.nodes.find((node) => node.id === nodeId);
}
