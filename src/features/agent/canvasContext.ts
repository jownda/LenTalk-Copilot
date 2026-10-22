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
  "excludedReferenceSources",
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

// ---------------------------------------------------------------------------
// 节点引用名
// ---------------------------------------------------------------------------

export interface NamedCanvasNode {
  id: string;
  title: string;
}

/**
 * 引用名规则的**唯一实现**：同名节点按出现顺序追加 ` #2`、` #3`。
 *
 * 两条链路都要用它，所以核心规则抽在这里、只认 `{id, title}`：
 * - 执行侧 `findCanvasNodeByRefName` 拿的是真实 `CanvasNode`（title 现算）；
 * - 提示词侧拿到的是快照里的节点摘要（title 已经算好）。
 * 两处各写一遍必然漂移，而漂移的表现是「AI 说的名字解析不到」。
 */
export function buildCanvasRefNames(nodes: NamedCanvasNode[]): Map<string, string> {
  const seen = new Map<string, number>();
  const names = new Map<string, string>();
  for (const node of nodes) {
    const base = node.title;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    names.set(node.id, count === 1 ? base : `${base} #${count}`);
  }
  return names;
}

/**
 * 节点的「引用名」：就是画布上显示的名称；同名节点按画布顺序追加 ` #2`、` #3`。
 *
 * 为什么不用 id：uuid 让模型逐字抄必然出错。
 * 为什么不另造别名（n1/n2）：名称是**用户自己认得的东西**——
 * AI 说「AI 图片 #2」用户一眼知道是哪个，说「n2」就得回头数。
 *
 * 后缀不是可选项：默认名只有「本地上传」「AI 图片」「AI 视频」这几种，
 * 一张画布上重名是常态，没有后缀就根本没法确定指的是谁。
 */
export function buildCanvasNodeRefNames(nodes: CanvasNode[]): Map<string, string> {
  return buildCanvasRefNames(
    nodes.map((node) => ({
      id: node.id,
      title: resolveNodeDisplayName(node.type as CanvasNodeType, node.data),
    })),
  );
}

export interface CanvasNodeLookup {
  node?: CanvasNode;
  error?: string;
}

/**
 * 按引用名找节点。找不到时把当前可用名称列出来 ——
 * 模型第一次猜错名字是常有的事，直接给它候选比让它再瞎试一轮便宜得多。
 */
export function findCanvasNodeByRefName(
  refName: string,
  state = useCanvasStore.getState(),
): CanvasNodeLookup {
  const target = refName.trim();
  if (!target) return { error: "节点名称不能为空。" };

  const names = buildCanvasNodeRefNames(state.nodes);
  for (const node of state.nodes) {
    if (names.get(node.id) === target) return { node };
  }
  // 兼容：模型如果手里恰好有真实 id（例如工具返回里带过），也认
  const byId = state.nodes.find((node) => node.id === target);
  if (byId) return { node: byId };

  const available = [...new Set(names.values())];
  const preview = available.slice(0, 20).join("、");
  return {
    error: available.length
      ? `找不到名为「${target}」的节点。当前画布上的节点：${preview}${available.length > 20 ? "…" : ""}`
      : `找不到名为「${target}」的节点（画布上还没有节点）。`,
  };
}

/**
 * 从工具返回的 `data` 里取出「这次操作碰过哪些节点」。
 *
 * 卡片上的「定位」按钮靠它决定显示与目标。字段不统一是有历史原因的：
 * 单节点操作回 `nodeId`、批量回 `nodeIds`、连线回 `source`/`target`
 * （连线两头都值得看一眼），所以一律认。
 */
export function extractToolResultNodeIds(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const record = data as {
    nodeId?: unknown;
    nodeIds?: unknown;
    source?: unknown;
    target?: unknown;
  };
  const ids: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value.trim()) ids.push(value.trim());
  };
  if (Array.isArray(record.nodeIds)) record.nodeIds.forEach(push);
  push(record.nodeId);
  push(record.source);
  push(record.target);
  return Array.from(new Set(ids));
}

/** 节点生成的媒体地址：结果可能落在不同字段上，按优先级取第一个可用的 */
export function extractNodeMediaUrl(data: Record<string, unknown>): string | null {
  const keys = [
    "outputPreviewImageUrl",
    "outputImageUrl",
    "previewImageUrl",
    "imageUrl",
    "outputVideoUrl",
    "videoUrl",
    "previewVideoUrl",
    "outputAudioUrl",
    "audioUrl",
  ];
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}
