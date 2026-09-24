import { create } from 'zustand';
import {
  Connection,
  EdgeChange,
  NodeChange,
  type Viewport,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
} from '@xyflow/react';

import {
  CANVAS_NODE_TYPES,
  DEFAULT_ASPECT_RATIO,
  DEFAULT_NODE_WIDTH,
  EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  EXPORT_RESULT_NODE_MIN_HEIGHT,
  EXPORT_RESULT_NODE_MIN_WIDTH,
  type ActiveToolDialog,
  type CanvasEdge,
  type CanvasNode,
  type CanvasNodeData,
  type CanvasNodeType,
  type ExportImageNodeResultKind,
  type GroupNodeData,
  type NodeToolType,
  type StoryboardExportOptions,
  type StoryboardFrameItem,
  collectFrozenLockedNodeIds,
  isStoryboardSplitNode,
} from '@/features/canvas/domain/canvasNodes';
import {
  nodeHasSourceHandle,
  nodeHasTargetHandle,
} from '@/features/canvas/domain/nodeRegistry';
import { EXPORT_RESULT_DISPLAY_NAME } from '@/features/canvas/domain/nodeDisplay';
import { nodeCatalog } from '@/features/canvas/application/nodeCatalog';
import { canvasNodeFactory } from '@/features/canvas/application/canvasServices';
import { computeAutoLayout, computeAlignment, computeSmartSnapLayout } from '@/features/canvas/application/canvasLayout';
import type { NodeAlignMode } from '@/features/canvas/application/canvasLayout';
import {
  ensureAtLeastOneMinEdge,
  resolveMinEdgeFittedSize,
  resolveSizeInsideTargetBox,
} from '@/features/canvas/application/imageNodeSizing';
import {
  resolveAspectLockedResize,
  resolveMediaNodeAspectLock,
  type AspectLockedSize,
} from '@/features/canvas/application/aspectLockedResize';

export type {
  ActiveToolDialog,
  CanvasEdge,
  CanvasNode,
  CanvasNodeData,
  CanvasNodeType,
  NodeToolType,
  StoryboardFrameItem,
};

export interface CanvasHistorySnapshot {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export interface CanvasHistoryState {
  past: CanvasHistorySnapshot[];
  future: CanvasHistorySnapshot[];
}

/**
 * 内存中保留的 undo 步数。每步快照持有当时的 nodes/edges 数组, 大画布(单节点带
 * base64 参考图)下 50 步会让编辑期常驻数百 MB 并拖慢每次入栈的内容去重比较。
 * 20 步足够覆盖正常编辑节奏, 同时显著降低主线程压力。
 */
const MAX_HISTORY_STEPS = 20;
const IMAGE_NODE_VISUAL_MIN_EDGE = 96;

interface CanvasState {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /**
   * Changes only when node geometry can affect an orthogonal route. Keeping
   * this separate from node data prevents every prompt edit from recalculating
   * every edge on a large canvas.
   */
  routingRevision: number;
  /** Changes only when an edge may need to show or hide its processing state. */
  processingRevision: number;
  /** Changes when connected image, audio, or text inputs may need to be resolved again. */
  inputGraphRevision: number;
  selectedNodeId: string | null;
  activeToolDialog: ActiveToolDialog | null;
  history: CanvasHistoryState;
  dragHistorySnapshot: CanvasHistorySnapshot | null;
  /** 拖拽悬停的目标分组 id(高亮用, 不持久化) */
  hoveredGroupId: string | null;
  /** 拖入成功后的闪烁反馈分组 id(不持久化) */
  flashGroupId: string | null;
  /** 拖出蓄力(穿结界)中的分组 id: 节点越出组边界蓄力时高亮, 不持久化 */
  chargingGroupId: string | null;
  currentViewport: Viewport;
  canvasViewportSize: { width: number; height: number };
  imageViewer: {
    isOpen: boolean;
    currentImageUrl: string | null;
    imageList: string[];
    currentIndex: number;
  };

  onNodesChange: (changes: NodeChange<CanvasNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<CanvasEdge>[]) => void;
  onConnect: (connection: Connection) => void;

  setCanvasData: (nodes: CanvasNode[], edges: CanvasEdge[], history?: CanvasHistoryState) => void;
  addNode: (
    type: CanvasNodeType,
    position: { x: number; y: number; parentId?: string; groupResize?: { id: string; width: number; height: number } },
    data?: Partial<CanvasNodeData>,
    /** 显式初始尺寸；省略则用节点类型注册的 defaultSize。 */
    size?: { width: number; height: number }
  ) => string;
  replaceNodeType: (nodeId: string, type: CanvasNodeType, data?: Partial<CanvasNodeData>) => boolean;
  addEdge: (source: string, target: string, sourceHandle?: string, targetHandle?: string) => string | null;
  findNodePosition: (
    sourceNodeId: string,
    newNodeWidth: number,
    newNodeHeight: number
  ) => { x: number; y: number; parentId?: string; groupResize?: { id: string; width: number; height: number } };
  addDerivedUploadNode: (
    sourceNodeId: string,
    imageUrl: string,
    aspectRatio: string,
    previewImageUrl?: string
  ) => string | null;
  addDerivedExportNode: (
    sourceNodeId: string,
    imageUrl: string,
    aspectRatio: string,
    previewImageUrl?: string,
    options?: {
      defaultTitle?: string;
      resultKind?: ExportImageNodeResultKind;
      aspectRatioStrategy?: 'provided' | 'derivedFromSource';
      sizeStrategy?: 'generated' | 'autoMinEdge' | 'matchSource';
      matchSourceNodeSize?: boolean;
    }
  ) => string | null;
  addStoryboardSplitNode: (
    sourceNodeId: string,
    rows: number,
    cols: number,
    frames: StoryboardFrameItem[],
    frameAspectRatio?: string
  ) => string | null;

  updateNodeData: (nodeId: string, data: Partial<CanvasNodeData>) => void;
  updateNodeDataTransient: (nodeId: string, data: Partial<CanvasNodeData>) => void;
  updateNodePosition: (nodeId: string, position: { x: number; y: number }) => void;
  updateNodeSize: (nodeId: string, width: number, height: number) => void;
  updateStoryboardFrame: (
    nodeId: string,
    frameId: string,
    data: Partial<StoryboardFrameItem>
  ) => void;
  reorderStoryboardFrame: (
    nodeId: string,
    draggedFrameId: string,
    targetFrameId: string
  ) => void;

  deleteNode: (nodeId: string) => void;
  deleteNodes: (nodeIds: string[]) => void;
  groupNodes: (nodeIds: string[], groupName?: string) => string | null;
  ungroupNode: (groupNodeId: string) => boolean;
  /** 冻结/解冻组: 冻结后组与其内部节点位置锁定, 不可拖动与缩放。返回是否发生变更 */
  setGroupFrozen: (groupNodeId: string, frozen: boolean) => boolean;
  /** 把节点加入已有分组(拖入), 返回是否发生变更 */
  addNodesToGroup: (nodeIds: string[], groupId: string) => boolean;
  /** 把节点移出分组(拖出), 返回是否发生变更 */
  removeNodesFromGroup: (nodeIds: string[]) => boolean;
  /** 自动布局: 全画布顶层节点按连线拓扑分层排列, 返回是否发生变更 */
  autoLayoutCanvas: () => boolean;
  /** 对齐选中节点(左/中/右/上/垂直中/下/水平等距/垂直等距), 返回是否发生变更 */
  alignNodes: (nodeIds: string[], mode: NodeAlignMode) => boolean;
  /** 全画布智能对齐 + 防重叠: 顶层节点吸附到附近节点/组边框的边缘或中心线, 重叠时自动错开 */
  snapAllNodesToNeighbors: (threshold?: number) => boolean;
  deleteEdge: (edgeId: string) => void;
  setSelectedNode: (nodeId: string | null) => void;
  setHoveredGroupId: (groupId: string | null) => void;
  setFlashGroupId: (groupId: string | null) => void;
  setChargingGroupId: (groupId: string | null) => void;

  openToolDialog: (dialog: ActiveToolDialog) => void;
  closeToolDialog: () => void;
  setViewportState: (viewport: Viewport) => void;
  setCanvasViewportSize: (size: { width: number; height: number }) => void;
  openImageViewer: (imageUrl: string, imageList?: string[]) => void;
  closeImageViewer: () => void;
  navigateImageViewer: (direction: 'prev' | 'next') => void;

  undo: () => boolean;
  redo: () => boolean;

  clearCanvas: () => void;
}

function normalizeHandleId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'null' || trimmed === 'undefined') {
    return undefined;
  }
  return trimmed;
}

function normalizeEdgesWithNodes(rawEdges: CanvasEdge[], nodes: CanvasNode[]): CanvasEdge[] {
  const nodeMap = new Map(nodes.map((node) => [node.id, node] as const));

  return rawEdges
    .filter((edge) => {
      const sourceNode = nodeMap.get(edge.source);
      const targetNode = nodeMap.get(edge.target);
      if (!sourceNode || !targetNode) {
        return false;
      }
      return nodeHasSourceHandle(sourceNode.type) && nodeHasTargetHandle(targetNode.type);
    })
    .map((edge) => ({
      ...edge,
      type: edge.type ?? 'disconnectableEdge',
      sourceHandle:
        normalizeHandleId((edge as CanvasEdge & { sourceHandle?: unknown }).sourceHandle) ?? 'source',
      targetHandle:
        normalizeHandleId((edge as CanvasEdge & { targetHandle?: unknown }).targetHandle) ?? 'target',
    }));
}

function applyCinematicStudioPromptToTarget(
  nodes: CanvasNode[],
  sourceId: string | null | undefined,
  targetId: string | null | undefined
): CanvasNode[] {
  if (!sourceId || !targetId) {
    return nodes;
  }

  const source = nodes.find((node) => node.id === sourceId);
  const target = nodes.find((node) => node.id === targetId);
  if (
    source?.type !== CANVAS_NODE_TYPES.cinematicStudio
    || !target
    || (target.type !== CANVAS_NODE_TYPES.videoGen && target.type !== CANVAS_NODE_TYPES.textAnnotation)
  ) {
    return nodes;
  }

  const prompt = typeof (source.data as { lastPromptPreview?: unknown }).lastPromptPreview === 'string'
    ? (source.data as { lastPromptPreview: string }).lastPromptPreview.trim()
    : '';
  if (!prompt) {
    return nodes;
  }
  const referenceImages = Array.isArray((source.data as { studioReferenceImages?: unknown }).studioReferenceImages)
    ? (source.data as { studioReferenceImages: unknown[] }).studioReferenceImages.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : [];
  const referenceAudio = Array.isArray((source.data as { studioReferenceAudio?: unknown }).studioReferenceAudio)
    ? (source.data as { studioReferenceAudio: unknown[] }).studioReferenceAudio.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : [];

  return nodes.map((node) => {
    if (node.id !== targetId) {
      return node;
    }

    if (node.type === CANVAS_NODE_TYPES.videoGen) {
      // 工作室重新推送引用素材时, 把这些来源从「已移除」名单里摘掉 —— 否则
      // 用户重新发送后素材会被自己的删除记录继续挡住, 看起来像没生效。
      const excluded = Array.isArray((node.data as { excludedReferenceSources?: unknown }).excludedReferenceSources)
        ? (node.data as { excludedReferenceSources: unknown[] }).excludedReferenceSources.filter((value): value is string => typeof value === 'string')
        : [];
      const nextExcluded = excluded.filter(
        (source) => !referenceImages.includes(source) && !referenceAudio.includes(source)
      );
      return {
        ...node,
        data: {
          ...node.data,
          prompt,
          studioReferenceImages: referenceImages,
          studioReferenceAudio: referenceAudio,
          ...(nextExcluded.length !== excluded.length ? { excludedReferenceSources: nextExcluded } : {}),
        },
      } as CanvasNode;
    }

    return { ...node, data: { ...node.data, content: prompt } } as CanvasNode;
  });
}

function normalizeNodes(rawNodes: CanvasNode[]): CanvasNode[] {
  return rawNodes
    .map((node) => {
      if (!Object.values(CANVAS_NODE_TYPES).includes(node.type as CanvasNodeType)) {
        return null;
      }

      const definition = nodeCatalog.getDefinition(node.type as CanvasNodeType);
      const mergedData = {
        ...definition.createDefaultData(),
        ...(node.data as Partial<CanvasNodeData>),
      } as CanvasNodeData;

      if (node.type === CANVAS_NODE_TYPES.storyboardSplit) {
        const frames = (mergedData as { frames?: StoryboardFrameItem[] }).frames ?? [];
        const firstFrameAspectRatio = frames.find((frame) => typeof frame.aspectRatio === 'string')
          ?.aspectRatio;
        const normalizedFrameAspectRatio =
          (typeof (mergedData as { frameAspectRatio?: unknown }).frameAspectRatio === 'string'
            ? (mergedData as { frameAspectRatio?: string }).frameAspectRatio
            : null) ??
          firstFrameAspectRatio ??
          DEFAULT_ASPECT_RATIO;

        (mergedData as { frameAspectRatio: string }).frameAspectRatio = normalizedFrameAspectRatio;
        (mergedData as { frames: StoryboardFrameItem[] }).frames = frames.map((frame, index) => ({
          id: frame.id,
          imageUrl: frame.imageUrl ?? null,
          previewImageUrl: frame.previewImageUrl ?? null,
          aspectRatio:
            typeof frame.aspectRatio === 'string'
              ? frame.aspectRatio
              : normalizedFrameAspectRatio,
          note: frame.note ?? '',
          order: Number.isFinite(frame.order) ? frame.order : index,
        }));

        const rawExportOptions = (mergedData as { exportOptions?: Partial<StoryboardExportOptions> })
          .exportOptions;
        const rawFontSize = Number.isFinite(rawExportOptions?.fontSize)
          ? Number(rawExportOptions?.fontSize)
          : createDefaultStoryboardExportOptions().fontSize;
        const normalizedFontSize = rawFontSize > 20
          ? Math.round(rawFontSize / 6)
          : rawFontSize;
        (mergedData as { exportOptions: StoryboardExportOptions }).exportOptions = {
          ...createDefaultStoryboardExportOptions(),
          ...(rawExportOptions ?? {}),
          fontSize: Math.max(1, Math.min(20, Math.round(normalizedFontSize))),
        };
      }

      if ('aspectRatio' in mergedData && !mergedData.aspectRatio) {
        mergedData.aspectRatio = DEFAULT_ASPECT_RATIO;
      }

      // Keep the original request when there is no provider job id so the user
      // can explicitly retry an interrupted generation after restarting.
      if ('isGenerating' in mergedData && mergedData.isGenerating) {
        const generationJobId =
          typeof (mergedData as { generationJobId?: unknown }).generationJobId === 'string'
            ? (mergedData as { generationJobId?: string }).generationJobId?.trim() ?? ''
            : '';
        const generationRequest = (mergedData as { generationRequest?: unknown }).generationRequest;
        if (!generationJobId && (!generationRequest || typeof generationRequest !== 'object')) {
          mergedData.isGenerating = false;
          if ('generationStartedAt' in mergedData) {
            mergedData.generationStartedAt = null;
          }
        } else if (!generationJobId) {
          mergedData.isGenerating = false;
          if ('generationStartedAt' in mergedData) {
            mergedData.generationStartedAt = null;
          }
          if (!mergedData.generationError) {
            mergedData.generationError = '应用重启时生成被中断，请点击重试生成';
            mergedData.generationErrorDetails = 'generation interrupted by app restart';
          }
        }
      }

      // 统一剥离 extent(旧数据可能残留 'parent'): 分组子节点不应被锁死在组内
      const { extent: _ignoredExtent, ...nodeWithoutExtent } = node;
      return {
        ...nodeWithoutExtent,
        type: node.type as CanvasNodeType,
        data: mergedData,
      };
    })
    .filter((node): node is CanvasNode => Boolean(node));
}

function normalizeHistory(history?: CanvasHistoryState): CanvasHistoryState {
  if (!history) {
    return { past: [], future: [] };
  }

  const normalizeSnapshot = (snapshot: CanvasHistorySnapshot): CanvasHistorySnapshot => {
    const normalizedNodes = normalizeNodes(snapshot.nodes);
    return {
      nodes: normalizedNodes,
      edges: normalizeEdgesWithNodes(snapshot.edges, normalizedNodes),
    };
  };

  return {
    past: dedupeSnapshots(history.past.slice(-MAX_HISTORY_STEPS).map(normalizeSnapshot)),
    future: dedupeSnapshots(history.future.slice(-MAX_HISTORY_STEPS).map(normalizeSnapshot)),
  };
}

function createSnapshot(nodes: CanvasNode[], edges: CanvasEdge[]): CanvasHistorySnapshot {
  return { nodes, edges };
}

function isCompletedGenerationResultNode(node: CanvasNode): boolean {
  const data = node.data as Record<string, unknown>;
  if (data.generationResultProtected !== true || data.isGenerating === true) {
    return false;
  }

  if (node.type === CANVAS_NODE_TYPES.exportImage) {
    return typeof data.imageUrl === 'string' && data.imageUrl.trim().length > 0;
  }

  return (
    node.type === CANVAS_NODE_TYPES.audio &&
    (data.mediaType === 'video' || data.mediaType === 'audio') &&
    typeof data.sourcePath === 'string' &&
    data.sourcePath.trim().length > 0
  );
}

/**
 * 生成态是否发生"需要重新扫描画布"的变化。
 *
 * 两个字段都要看:
 * - `isGenerating` 的翻转决定"生成中"光效与观察循环的启停;
 * - `generationJobId` 的落库是**观察循环唯一入口** —— 画布的视频/图片轮询 effect
 *   都以 `processingRevision` 为依赖, 过滤器要求 `isGenerating === true` **且**
 *   `generationJobId` 非空。
 *
 * 只把 `isGenerating` 计入会漏掉一个致命窗口: 提交方先建出 `isGenerating: true`
 * 的结果节点, 稍后再把 job id 写上去, 这时 `isGenerating` 没有变化 ⇒
 * `processingRevision` 不 bump ⇒ 观察循环不会重新扫描 ⇒ 节点带着
 * "生成中 + jobId"停在原地, 永远不被轮询。表现出来就是任务在平台侧照跑照计费、
 * 界面一直转圈, 最后只能报「视频任务等待超时」(实机 2026-09-22 的知鸟任务)。
 */
function nodeDataChangesProcessingState(
  before: CanvasNodeData,
  after: CanvasNodeData
): boolean {
  return (
    (before as { isGenerating?: unknown }).isGenerating
      !== (after as { isGenerating?: unknown }).isGenerating
    || (before as { generationJobId?: unknown }).generationJobId
      !== (after as { generationJobId?: unknown }).generationJobId
  );
}

/**
 * Downstream media/text consumers only need a graph refresh when a node's
 * exported payload changes. Keeping ordinary form fields out of this path
 * prevents a prompt keystroke from making every media node rescan the canvas.
 */
function nodeDataAffectsInputGraph(node: CanvasNode, data: Partial<CanvasNodeData>): boolean {
  const changedKeys = new Set(
    Object.entries(data)
      .filter(([key, nextValue]) => !Object.is((node.data as Record<string, unknown>)[key], nextValue))
      .map(([key]) => key)
  );
  const includesAny = (...keys: string[]) => keys.some((key) => changedKeys.has(key));

  switch (node.type) {
    case CANVAS_NODE_TYPES.upload:
    case CANVAS_NODE_TYPES.imageEdit:
    case CANVAS_NODE_TYPES.exportImage:
    case CANVAS_NODE_TYPES.storyboardGen:
      return includesAny('imageUrl');
    case CANVAS_NODE_TYPES.panorama:
      return includesAny('inputImageUrl', 'outputImageUrl');
    case CANVAS_NODE_TYPES.seamlessMosaic:
      return includesAny('outputImageUrl');
    case CANVAS_NODE_TYPES.storyboardSplit:
      return includesAny('frames');
    case CANVAS_NODE_TYPES.directorDesk:
      return includesAny('lastCaptureUrl');
    case CANVAS_NODE_TYPES.cinematicStudio:
      return includesAny('studioReferenceImages', 'studioReferenceAudio');
    case CANVAS_NODE_TYPES.audio:
      return includesAny('mediaType', 'sourcePath');
    case CANVAS_NODE_TYPES.textAnnotation:
      return includesAny('content');
    case CANVAS_NODE_TYPES.promptOptimizer:
      return includesAny('optimizedPrompt', 'purpose');
    default:
      return false;
  }
}

/**
 * Generation completion is transient, while node creation and request state
 * are historical. Keep a completed AI result when undo targets one of those
 * older snapshots, so undo cannot turn a finished result back into a spinner.
 */
function preserveCompletedGenerationResults(
  currentNodes: CanvasNode[],
  currentEdges: CanvasEdge[],
  targetNodes: CanvasNode[],
  targetEdges: CanvasEdge[],
): CanvasHistorySnapshot {
  const protectedNodes = currentNodes.filter(isCompletedGenerationResultNode);
  if (protectedNodes.length === 0) {
    return { nodes: targetNodes, edges: targetEdges };
  }

  const targetNodeIds = new Set(targetNodes.map((node) => node.id));
  const nextNodes = targetNodes.map((targetNode) => {
    const currentNode = protectedNodes.find((node) => node.id === targetNode.id);
    if (!currentNode) {
      return targetNode;
    }

    const currentData = currentNode.data as Record<string, unknown>;
    const targetData = targetNode.data as Record<string, unknown>;
    const mediaData = currentNode.type === CANVAS_NODE_TYPES.exportImage
      ? {
          imageUrl: currentData.imageUrl,
          previewImageUrl: currentData.previewImageUrl,
          aspectRatio: currentData.aspectRatio,
        }
      : {
          sourcePath: currentData.sourcePath,
          previewImageUrl: currentData.previewImageUrl,
          mediaType: currentData.mediaType,
          aspectRatio: currentData.aspectRatio,
        };

    return {
      ...targetNode,
      data: {
        ...targetData,
        ...mediaData,
        isGenerating: false,
        generationStartedAt: null,
        generationJobId: null,
        generationRequest: undefined,
        generationError: null,
        generationErrorDetails: null,
        generationResultProtected: true,
      },
    } as CanvasNode;
  });

  const missingProtectedNodes = protectedNodes.filter((node) => !targetNodeIds.has(node.id));
  const resultNodes = [...nextNodes, ...missingProtectedNodes];
  const resultNodeIds = new Set(resultNodes.map((node) => node.id));
  const targetEdgeIds = new Set(targetEdges.map((edge) => edge.id));
  const preservedEdges = currentEdges.filter(
    (edge) =>
      !targetEdgeIds.has(edge.id) &&
      resultNodeIds.has(edge.source) &&
      resultNodeIds.has(edge.target),
  );

  return {
    nodes: resultNodes,
    edges: [...targetEdges, ...preservedEdges],
  };
}

/** 深度比较两个快照/任意结构的内容是否一致(用于历史栈内容级去重) */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== typeof b || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    for (let index = 0; index < a.length; index += 1) {
      if (!deepEqual(a[index], b[index])) {
        return false;
      }
    }
    return true;
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const aRecord = a as Record<string, unknown>;
    const bRecord = b as Record<string, unknown>;
    const aKeys = Object.keys(aRecord);
    const bKeys = Object.keys(bRecord);
    if (aKeys.length !== bKeys.length) {
      return false;
    }
    for (const key of aKeys) {
      if (!deepEqual(aRecord[key], bRecord[key])) {
        return false;
      }
    }
    return true;
  }
  return false;
}

/**
 * 比较前后节点是否发生了"用户可感知"的几何变化(位置/尺寸)。
 * 忽略 selected 等非几何字段: 单击选中节点也会触发 drag 起止(position change),
 * 但位置没变就不应写入历史, 否则 undo 会被"无变化"的快照塞满而看起来失效。
 */
function nodesGeometryEqual(before: CanvasNode[], after: CanvasNode[]): boolean {
  if (before.length !== after.length) {
    return false;
  }
  const afterMap = new Map(after.map((node) => [node.id, node] as const));
  for (const nodeBefore of before) {
    const nodeAfter = afterMap.get(nodeBefore.id);
    if (!nodeAfter) {
      return false;
    }
    if (
      nodeBefore.position.x !== nodeAfter.position.x
      || nodeBefore.position.y !== nodeAfter.position.y
    ) {
      return false;
    }
    const widthBefore = nodeBefore.measured?.width ?? nodeBefore.width;
    const widthAfter = nodeAfter.measured?.width ?? nodeAfter.width;
    if (widthBefore !== widthAfter) {
      return false;
    }
    const heightBefore = nodeBefore.measured?.height ?? nodeBefore.height;
    const heightAfter = nodeAfter.measured?.height ?? nodeAfter.height;
    if (heightBefore !== heightAfter) {
      return false;
    }
  }
  return true;
}

function collectNodeIdsWithDescendants(nodes: CanvasNode[], seedIds: string[]): Set<string> {
  const deleteSet = new Set(seedIds);
  let changed = true;

  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (!node.parentId || deleteSet.has(node.id)) {
        continue;
      }
      if (deleteSet.has(node.parentId)) {
        deleteSet.add(node.id);
        changed = true;
      }
    }
  }

  return deleteSet;
}

/**
 * 丢弃冻结节点上的几何变更(position 位移与手动缩放),
 * 保留选中 / 尺寸测量等非几何变更。
 */
function dropFrozenNodeGeometryChanges(
  changes: NodeChange<CanvasNode>[],
  nodes: CanvasNode[]
): NodeChange<CanvasNode>[] {
  const lockedIds = collectFrozenLockedNodeIds(nodes);
  if (lockedIds.size === 0) {
    return changes;
  }
  return changes.filter((change) => {
    if (change.type === 'position') {
      return !lockedIds.has(change.id);
    }
    // 手动缩放带的 resizing 标记; 首次渲染的尺寸测量没有该字段, 必须放行
    if (change.type === 'dimensions' && 'resizing' in change) {
      return !lockedIds.has(change.id);
    }
    return true;
  });
}

function getNodeSize(node: CanvasNode): { width: number; height: number } {
  return {
    width:
      typeof node.measured?.width === 'number'
        ? node.measured.width
        : typeof node.width === 'number'
          ? node.width
          : DEFAULT_NODE_WIDTH,
    height:
      typeof node.measured?.height === 'number'
        ? node.measured.height
        : typeof node.height === 'number'
          ? node.height
          : 200,
  };
}

function isImageAutoResizableType(type: CanvasNodeType): boolean {
  return type === CANVAS_NODE_TYPES.upload
    || type === CANVAS_NODE_TYPES.imageEdit
    || type === CANVAS_NODE_TYPES.exportImage;
}

/**
 * 本次拖拽缩放手势的起始尺寸, 按节点 id 缓存。
 *
 * React Flow 的 resize 手柄在 pointerdown 时缓存一次起始尺寸(`startValues`), 之后每帧
 * 都基于这个固定起点加指针位移算出候选尺寸。等比修正若拿"上一帧已被修正的输出"当基准,
 * 基准会随每帧输出漂移, 主导轴判定于是在相邻两帧之间反复翻转, 输出尺寸在两个分支之间
 * 跳变 —— 表现为拖拽"一抖一抖"。这里让基准与手柄同源: 手势第一帧登记, 手势结束时清理。
 */
const aspectLockResizeGestureStartSizes = new Map<string, AspectLockedSize>();

/** 取本次手势的起始尺寸; 第一帧用 store 当前尺寸登记(此时尚未被本次手势改写)。 */
function resolveResizeGestureStartSize(nodeId: string, node: CanvasNode): AspectLockedSize {
  const cached = aspectLockResizeGestureStartSizes.get(nodeId);
  if (cached) {
    return cached;
  }

  const startSize = getNodeSize(node);
  aspectLockResizeGestureStartSizes.set(nodeId, startSize);
  return startSize;
}

/**
 * 把用户拖拽产生的自由尺寸修正为媒体比例。
 *
 * 图片/视频节点的边框必须与画面同比例, 否则画面会被拉伸或留黑边。这里在尺寸变更
 * 进入 store 的唯一入口处做等比修正, 因此无论从哪个角拖动、起始比例是否正确,
 * 结果都会收敛到目标比例。
 */
function applyAspectLockedResizeToChanges(
  changes: NodeChange<CanvasNode>[],
  nodes: CanvasNode[]
): NodeChange<CanvasNode>[] {
  const hasResizingChange = changes.some(
    (change) => change.type === 'dimensions' && 'resizing' in change
  );
  if (!hasResizingChange) {
    return changes;
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  return changes.map((change) => {
    if (change.type !== 'dimensions' || !('resizing' in change)) {
      return change;
    }

    const node = nodeById.get(change.id);
    if (!node) {
      return change;
    }

    // 结束帧同样使用手势起始尺寸: 基准只有全程恒定, 最后一帧才不会相对前一帧跳变。
    const previous = resolveResizeGestureStartSize(change.id, node);
    if (change.resizing === false) {
      aspectLockResizeGestureStartSizes.delete(change.id);
    }

    if (!change.dimensions) {
      return change;
    }

    const lock = resolveMediaNodeAspectLock(node.type, node.data as Record<string, unknown>);
    if (!lock) {
      return change;
    }

    const locked = resolveAspectLockedResize({
      previous,
      next: change.dimensions,
      ratio: lock.ratio,
      bounds: lock.bounds,
    });

    if (locked.width === change.dimensions.width && locked.height === change.dimensions.height) {
      return change;
    }

    return {
      ...change,
      dimensions: { ...change.dimensions, ...locked },
    } as NodeChange<CanvasNode>;
  });
}

function withManualSizeLock(node: CanvasNode): CanvasNode {
  const nodeData = node.data as CanvasNodeData & { isSizeManuallyAdjusted?: boolean };
  if (nodeData.isSizeManuallyAdjusted) {
    return node;
  }

  return {
    ...node,
    data: {
      ...node.data,
      isSizeManuallyAdjusted: true,
    } as CanvasNodeData,
  };
}

function resolveAutoImageNodeDimensions(
  aspectRatio: string,
  options?: {
    minWidth?: number;
    minHeight?: number;
  }
): { width: number; height: number } {
  const minWidth = options?.minWidth ?? EXPORT_RESULT_NODE_MIN_WIDTH;
  const minHeight = options?.minHeight ?? EXPORT_RESULT_NODE_MIN_HEIGHT;
  return resolveMinEdgeFittedSize(aspectRatio, { minWidth, minHeight });
}

function resolveGeneratedImageNodeDimensions(
  aspectRatio: string,
  options?: {
    minWidth?: number;
    minHeight?: number;
  }
): { width: number; height: number } {
  const size = resolveSizeInsideTargetBox(aspectRatio, {
    width: EXPORT_RESULT_NODE_DEFAULT_WIDTH,
    height: EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  });
  const minWidth = options?.minWidth ?? IMAGE_NODE_VISUAL_MIN_EDGE;
  const minHeight = options?.minHeight ?? IMAGE_NODE_VISUAL_MIN_EDGE;

  return ensureAtLeastOneMinEdge(size, { minWidth, minHeight });
}

function resolveDerivedAspectRatio(
  sourceNode: CanvasNode | undefined,
  fallbackAspectRatio: string
): string {
  if (!sourceNode) {
    return fallbackAspectRatio;
  }

  if (sourceNode.type === CANVAS_NODE_TYPES.storyboardGen) {
    const data = sourceNode.data as { requestAspectRatio?: string; aspectRatio?: string };
    const preferred = data.requestAspectRatio && data.requestAspectRatio !== 'auto'
      ? data.requestAspectRatio
      : data.aspectRatio;
    return preferred || fallbackAspectRatio;
  }

  if (sourceNode.type === CANVAS_NODE_TYPES.storyboardSplit) {
    const data = sourceNode.data as { frameAspectRatio?: string; aspectRatio?: string };
    return data.frameAspectRatio || data.aspectRatio || fallbackAspectRatio;
  }

  if (sourceNode.type === CANVAS_NODE_TYPES.imageEdit) {
    const data = sourceNode.data as { requestAspectRatio?: string; aspectRatio?: string };
    const preferred = data.requestAspectRatio && data.requestAspectRatio !== 'auto'
      ? data.requestAspectRatio
      : data.aspectRatio;
    return preferred || fallbackAspectRatio;
  }

  const imageLikeAspect = (sourceNode.data as { aspectRatio?: string }).aspectRatio;
  return imageLikeAspect || fallbackAspectRatio;
}

function maybeApplyImageAutoResize(node: CanvasNode, patch: Partial<CanvasNodeData>): CanvasNode {
  if (!isImageAutoResizableType(node.type)) {
    return node;
  }

  const nodeData = node.data as CanvasNodeData & {
    imageUrl?: string | null;
    aspectRatio?: string;
    isSizeManuallyAdjusted?: boolean;
  };
  const patchData = patch as Partial<CanvasNodeData> & {
    imageUrl?: string | null;
    aspectRatio?: string;
    isSizeManuallyAdjusted?: boolean;
  };

  const hasImageRelatedChange = 'imageUrl' in patchData || 'previewImageUrl' in patchData || 'aspectRatio' in patchData;
  if (!hasImageRelatedChange) {
    return node;
  }

  const isSizeManuallyAdjusted = patchData.isSizeManuallyAdjusted ?? nodeData.isSizeManuallyAdjusted ?? false;
  if (isSizeManuallyAdjusted) {
    return node;
  }

  const nextImageUrl = patchData.imageUrl ?? nodeData.imageUrl;
  if (typeof nextImageUrl !== 'string' || nextImageUrl.trim().length === 0) {
    return node;
  }

  const nextAspectRatio = patchData.aspectRatio ?? nodeData.aspectRatio ?? DEFAULT_ASPECT_RATIO;
  const nextSize = node.type === CANVAS_NODE_TYPES.exportImage
    ? resolveAutoImageNodeDimensions(nextAspectRatio, {
      minWidth: EXPORT_RESULT_NODE_MIN_WIDTH,
      minHeight: EXPORT_RESULT_NODE_MIN_HEIGHT,
    })
    : resolveAutoImageNodeDimensions(nextAspectRatio);

  return {
    ...node,
    width: nextSize.width,
    height: nextSize.height,
    style: {
      ...(node.style ?? {}),
      width: nextSize.width,
      height: nextSize.height,
    },
  };
}

/** 组内生成下游节点时的内边距(组扩容时保留的呼吸空间) */
const GROUP_PADDING = 24;

/** 生成下游节点时，边缘对齐保留的最小像素间距。 */
const DOWNSTREAM_ALIGNMENT_GAP = 8;

/**
 * 组内生成下游节点: 返回组内相对坐标 + parentId + 可选扩组信息。
 * - 锚定在来源节点右侧(最近 24px), 碰撞检测仅与同组兄弟节点比较;
 * - 组内空间不足时返回 groupResize, 由创建节点的调用方在同一个 set 中应用
 *   (与节点创建一起入历史快照, 避免独立扩组快照)。
 */
function placeNodeInsideGroup(
  state: { nodes: CanvasNode[] },
  groupNode: CanvasNode,
  sourceNode: CanvasNode,
  newNodeWidth: number,
  newNodeHeight: number
): { x: number; y: number; parentId: string; groupResize?: { id: string; width: number; height: number } } {
  const groupSize = getNodeSize(groupNode);
  const siblingIds = new Set<string>();
  for (const node of state.nodes) {
    if (node.parentId === groupNode.id && node.id !== sourceNode.id) {
      siblingIds.add(node.id);
    }
  }

  const collides = (x: number, y: number, width: number, height: number): boolean => {
    const margin = 8;
    for (const node of state.nodes) {
      if (!siblingIds.has(node.id)) {
        continue;
      }
      const nodeWidth = node.measured?.width ?? DEFAULT_NODE_WIDTH;
      const nodeHeight = node.measured?.height ?? 200;
      if (
        x < node.position.x + nodeWidth + margin
        && x + width + margin > node.position.x
        && y < node.position.y + nodeHeight + margin
        && y + height + margin > node.position.y
      ) {
        return true;
      }
    }
    return false;
  };

  // 来源节点在组内的相对坐标(position 已是相对组坐标)
  const sourceWidth = sourceNode.measured?.width ?? DEFAULT_NODE_WIDTH;
  const sourceHeight = sourceNode.measured?.height ?? 200;
  const anchorX = sourceNode.position.x + sourceWidth + 24;
  const anchorY = sourceNode.position.y;

  const stepX = Math.max(newNodeWidth + 16, 110);
  const stepY = Math.max(newNodeHeight + 16, 112);
  const rightSideOffsets = [0, 1, -1, 2, -2];
  let best: { x: number; y: number; score: number } | null = null;

  const evaluate = (x: number, y: number) => {
    if (x < GROUP_PADDING || y < GROUP_PADDING) {
      return;
    }
    if (collides(x, y, newNodeWidth, newNodeHeight)) {
      return;
    }
    const dx = x - anchorX;
    const dy = y - anchorY;
    const distanceScore = Math.hypot(dx, dy);
    const nonRightPenalty = x < anchorX ? Math.max(80, Math.round(newNodeWidth * 0.75)) : 0;
    const upwardPenalty = dy < 0 ? Math.round(newNodeHeight * 0.35) : 0;
    const score = distanceScore + nonRightPenalty + upwardPenalty;
    if (!best || score < best.score) {
      best = { x, y, score };
    }
  };

  for (const offsetY of rightSideOffsets) {
    evaluate(anchorX, anchorY + offsetY * stepY);
  }
  // 从来源右侧开始逐列搜索; 空间不足时扩组, 不用大偏移把结果甩远。
  for (let column = 1; column <= 2; column += 1) {
    for (const offsetY of rightSideOffsets) {
      evaluate(anchorX + column * stepX, anchorY + offsetY * stepY);
    }
  }
  if (!best) {
    evaluate(sourceNode.position.x, sourceNode.position.y + sourceHeight + 20);
    evaluate(sourceNode.position.x - newNodeWidth - 20, sourceNode.position.y);
    evaluate(sourceNode.position.x, sourceNode.position.y - newNodeHeight - 20);
  }

  const resolved = best ?? {
    x: Math.max(GROUP_PADDING, anchorX + stepX),
    y: Math.max(GROUP_PADDING, anchorY),
  };
  const needRight = resolved.x + newNodeWidth;
  const needBottom = resolved.y + newNodeHeight;

  let groupResize: { id: string; width: number; height: number } | undefined;
  // 组空间不足 → 自适应扩组(仅扩右下, 保持组左上锚点不动)
  if (needRight > groupSize.width - GROUP_PADDING || needBottom > groupSize.height - GROUP_PADDING) {
    groupResize = {
      id: groupNode.id,
      width: Math.max(groupSize.width, Math.ceil(needRight + GROUP_PADDING)),
      height: Math.max(groupSize.height, Math.ceil(needBottom + GROUP_PADDING)),
    };
  }

  return { x: Math.round(resolved.x), y: Math.round(resolved.y), parentId: groupNode.id, groupResize };
}

function resolveAbsolutePosition(
  node: CanvasNode,
  nodeMap: Map<string, CanvasNode>
): { x: number; y: number } {
  let x = node.position.x;
  let y = node.position.y;
  let currentParentId = node.parentId;
  const visited = new Set<string>();

  while (currentParentId && !visited.has(currentParentId)) {
    visited.add(currentParentId);
    const parent = nodeMap.get(currentParentId);
    if (!parent) {
      break;
    }
    x += parent.position.x;
    y += parent.position.y;
    currentParentId = parent.parentId;
  }

  return { x, y };
}

function pushSnapshot(
  snapshots: CanvasHistorySnapshot[],
  snapshot: CanvasHistorySnapshot
): CanvasHistorySnapshot[] {
  const last = snapshots[snapshots.length - 1];
  // 内容级去重: 仅引用不同但内容相同(如纯选中/测量/重复点击)时不重复入栈,
  // 否则 undo 会被无意义快照塞满, 按很多次都看不到实际变化
  if (last && deepEqual(last, snapshot)) {
    return snapshots;
  }

  const next = [...snapshots, snapshot];
  if (next.length > MAX_HISTORY_STEPS) {
    next.shift();
  }
  return next;
}

/** 相邻内容相同的快照去重(用于清理旧项目持久化历史中的垃圾条目) */
function dedupeSnapshots(snapshots: CanvasHistorySnapshot[]): CanvasHistorySnapshot[] {
  const result: CanvasHistorySnapshot[] = [];
  for (const snapshot of snapshots) {
    const last = result[result.length - 1];
    if (last && deepEqual(last, snapshot)) {
      continue;
    }
    result.push(snapshot);
  }
  return result;
}

function resolveSelectedNodeId(selectedNodeId: string | null, nodes: CanvasNode[]): string | null {
  if (!selectedNodeId) {
    return null;
  }
  return nodes.some((node) => node.id === selectedNodeId) ? selectedNodeId : null;
}

function resolveActiveToolDialog(
  activeToolDialog: ActiveToolDialog | null,
  nodes: CanvasNode[]
): ActiveToolDialog | null {
  if (!activeToolDialog) {
    return null;
  }
  return nodes.some((node) => node.id === activeToolDialog.nodeId) ? activeToolDialog : null;
}

function createDefaultStoryboardExportOptions(): StoryboardExportOptions {
  return {
    showFrameIndex: false,
    showFrameNote: false,
    notePlacement: 'overlay',
    imageFit: 'cover',
    frameIndexPrefix: 'S',
    cellGap: 8,
    outerPadding: 0,
    fontSize: 4,
    backgroundColor: '#0f1115',
    textColor: '#f8fafc',
  };
}

export const useCanvasStore = create<CanvasState>((set, get) => ({
  nodes: [],
  edges: [],
  routingRevision: 0,
  processingRevision: 0,
  inputGraphRevision: 0,
  selectedNodeId: null,
  activeToolDialog: null,
  history: { past: [], future: [] },
  dragHistorySnapshot: null,
  hoveredGroupId: null,
  flashGroupId: null,
  chargingGroupId: null,
  currentViewport: { x: 0, y: 0, zoom: 1 },
  canvasViewportSize: { width: 0, height: 0 },
  imageViewer: {
    isOpen: false,
    currentImageUrl: null,
    imageList: [],
    currentIndex: 0,
  },

  onNodesChange: (changes) => {
    set((state) => {
      const lockedChanges = applyAspectLockedResizeToChanges(
        dropFrozenNodeGeometryChanges(changes, state.nodes),
        state.nodes
      );
      const resizedNodeIds = new Set(
        lockedChanges
          .filter(
            (change): change is NodeChange<CanvasNode> & { id: string } =>
              change.type === 'dimensions'
              && 'resizing' in change
              && change.resizing === false
              && typeof change.id === 'string'
          )
          .map((change) => change.id)
      );

      let nextNodes = applyNodeChanges<CanvasNode>(lockedChanges, state.nodes);
      if (resizedNodeIds.size > 0) {
        nextNodes = nextNodes.map((node) => {
          if (!resizedNodeIds.has(node.id) || !isImageAutoResizableType(node.type)) {
            return node;
          }
          return withManualSizeLock(node);
        });
      }
      // 首次渲染/内容变化触发的尺寸测量(dimensions 无 resizing 字段)不是用户操作, 不写入历史
      const isMeasurementChange = (change: NodeChange<CanvasNode>): boolean =>
        change.type === 'dimensions' && !('resizing' in change);
      const hasMeaningfulChange = changes.some(
        (change) => change.type !== 'select' && !isMeasurementChange(change)
      );
      const hasDragMove = changes.some(
        (change) =>
          change.type === 'position' &&
          'dragging' in change &&
          Boolean(change.dragging)
      );
      const hasDragEnd = changes.some(
        (change) =>
          change.type === 'position' &&
          'dragging' in change &&
          change.dragging === false
      );
      const hasResizeMove = changes.some(
        (change) =>
          change.type === 'dimensions' &&
          'resizing' in change &&
          Boolean(change.resizing)
      );
      const hasResizeEnd = changes.some(
        (change) =>
          change.type === 'dimensions' &&
          'resizing' in change &&
          change.resizing === false
      );
      const hasInteractionMove = hasDragMove || hasResizeMove;
      const hasInteractionEnd = hasDragEnd || hasResizeEnd;
      const hasGeometryChange = changes.some(
        (change) =>
          change.type === 'position'
          || change.type === 'dimensions'
          || change.type === 'add'
          || change.type === 'remove'
          || change.type === 'replace'
      );
      // XY Flow already updates the endpoints of edges attached to a dragged
      // node. Defer the expensive all-edge obstacle pass until release.
      const hasRoutingChange = hasGeometryChange && (!hasInteractionMove || hasInteractionEnd);
      const hasInputGraphChange = changes.some(
        (change) => change.type === 'add' || change.type === 'remove' || change.type === 'replace'
      );

      let nextHistory = state.history;
      let nextDragHistorySnapshot = state.dragHistorySnapshot;

      if (hasInteractionMove && !nextDragHistorySnapshot) {
        nextDragHistorySnapshot = createSnapshot(state.nodes, state.edges);
      }

      if (hasInteractionEnd) {
        const snapshot = nextDragHistorySnapshot ?? createSnapshot(state.nodes, state.edges);
        // 拖/缩没有产生实际位置/尺寸变化(如单击选中节点、点到 resize 角即松开):
        // 不写历史, 且保留 redo 栈, 否则 undo 后随便点一下 redo 就失效了
        const currentSnapshot: CanvasHistorySnapshot = { nodes: nextNodes, edges: state.edges };
        if (!nodesGeometryEqual(snapshot.nodes, currentSnapshot.nodes)) {
          nextHistory = {
            past: pushSnapshot(state.history.past, snapshot),
            future: [],
          };
        }
        nextDragHistorySnapshot = null;
      } else if (hasMeaningfulChange && !hasInteractionMove) {
        nextHistory = {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        };
        nextDragHistorySnapshot = null;
      }

      return {
        nodes: nextNodes,
        selectedNodeId: resolveSelectedNodeId(state.selectedNodeId, nextNodes),
        activeToolDialog: resolveActiveToolDialog(state.activeToolDialog, nextNodes),
        history: nextHistory,
        dragHistorySnapshot: nextDragHistorySnapshot,
        ...(hasRoutingChange ? { routingRevision: state.routingRevision + 1 } : {}),
        ...(hasInputGraphChange ? { inputGraphRevision: state.inputGraphRevision + 1 } : {}),
      };
    });
  },

  onEdgesChange: (changes) => {
    set((state) => {
      const nextEdges = applyEdgeChanges<CanvasEdge>(changes, state.edges);
      const hasMeaningfulChange = changes.some((change) => change.type !== 'select');

      if (!hasMeaningfulChange) {
        return { edges: nextEdges };
      }

      return {
        edges: nextEdges,
        history: {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        },
        dragHistorySnapshot: null,
        inputGraphRevision: state.inputGraphRevision + 1,
      };
    });
  },

  onConnect: (connection) => {
    const sourceHandle = normalizeHandleId(connection.sourceHandle) ?? 'source';
    const targetHandle = normalizeHandleId(connection.targetHandle) ?? 'target';
    set((state) => {
      const nextNodes = applyCinematicStudioPromptToTarget(state.nodes, connection.source, connection.target);
      return {
        nodes: nextNodes,
        edges: addEdge<CanvasEdge>(
          { ...connection, sourceHandle, targetHandle, type: 'disconnectableEdge' },
          state.edges
        ),
        history: {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        },
        dragHistorySnapshot: null,
        inputGraphRevision: state.inputGraphRevision + 1,
      };
    });
  },

  setCanvasData: (nodes, edges, history) => {
    // normalizeNodes 已统一剥离 extent, 保证分组子节点可拖出组
    const normalizedNodes = normalizeNodes(nodes);
    const normalizedEdges = normalizeEdgesWithNodes(edges, normalizedNodes);

    set({
      nodes: normalizedNodes,
      edges: normalizedEdges,
      routingRevision: get().routingRevision + 1,
      processingRevision: get().processingRevision + 1,
      inputGraphRevision: get().inputGraphRevision + 1,
      selectedNodeId: null,
      activeToolDialog: null,
      history: normalizeHistory(history),
      dragHistorySnapshot: null,
    });
  },

  setViewportState: (viewport) => {
    const currentViewport = get().currentViewport;
    if (
      currentViewport.x === viewport.x &&
      currentViewport.y === viewport.y &&
      currentViewport.zoom === viewport.zoom
    ) {
      return;
    }
    set({ currentViewport: viewport });
  },

  setCanvasViewportSize: (size) => {
    const currentSize = get().canvasViewportSize;
    if (currentSize.width === size.width && currentSize.height === size.height) {
      return;
    }
    set({ canvasViewportSize: size });
  },

  openImageViewer: (imageUrl, imageList = []) => {
    const list = imageList.length > 0 ? imageList : [imageUrl];
    const index = list.indexOf(imageUrl);
    set({
      imageViewer: {
        isOpen: true,
        currentImageUrl: imageUrl,
        imageList: list,
        currentIndex: index >= 0 ? index : 0,
      },
    });
  },

  closeImageViewer: () => {
    set({
      imageViewer: {
        isOpen: false,
        currentImageUrl: null,
        imageList: [],
        currentIndex: 0,
      },
    });
  },

  navigateImageViewer: (direction) => {
    const state = get();
    const { currentIndex, imageList } = state.imageViewer;
    if (direction === 'prev' && currentIndex > 0) {
      const newIndex = currentIndex - 1;
      set({
        imageViewer: {
          ...state.imageViewer,
          currentIndex: newIndex,
          currentImageUrl: imageList[newIndex],
        },
      });
    } else if (direction === 'next' && currentIndex < imageList.length - 1) {
      const newIndex = currentIndex + 1;
      set({
        imageViewer: {
          ...state.imageViewer,
          currentIndex: newIndex,
          currentImageUrl: imageList[newIndex],
        },
      });
    }
  },

  addNode: (type, position, data = {}, size) => {
    const state = get();
    const nodePosition = { x: position.x, y: position.y };
    const newNode = canvasNodeFactory.createNode(type, nodePosition, data, size);
    if (position.parentId) {
      newNode.parentId = position.parentId;
    }
    // 组内生成: 组空间不足时随节点一起扩组(同一 set, 同入历史快照)
    let nextNodes = [...state.nodes, newNode];
    if (position.groupResize) {
      nextNodes = nextNodes.map((node) =>
        node.id === position.groupResize?.id
          ? {
              ...node,
              width: position.groupResize!.width,
              height: position.groupResize!.height,
              style: {
                ...(node.style ?? {}),
                width: position.groupResize!.width,
                height: position.groupResize!.height,
              },
            }
          : node
      );
    }
    set({
      nodes: nextNodes,
      routingRevision: state.routingRevision + 1,
      inputGraphRevision: state.inputGraphRevision + 1,
      ...((newNode.data as { isGenerating?: unknown }).isGenerating === true
        ? { processingRevision: state.processingRevision + 1 }
        : {}),
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
    });
    return newNode.id;
  },

  replaceNodeType: (nodeId, type, data = {}) => {
    let changed = false;
    set((state) => {
      const currentNode = state.nodes.find((node) => node.id === nodeId);
      if (!currentNode || currentNode.type === type) {
        return {};
      }

      const definition = nodeCatalog.getDefinition(type);
      const nextData = {
        ...definition.createDefaultData(),
        ...data,
      } as CanvasNodeData;
      changed = true;

      const shouldUseCompactMediaSize =
        currentNode.type === CANVAS_NODE_TYPES.upload &&
        type === CANVAS_NODE_TYPES.audio &&
        Boolean(definition.defaultSize);
      const nextDimensions = shouldUseCompactMediaSize ? definition.defaultSize : undefined;

      return {
        nodes: state.nodes.map((node) =>
          node.id === nodeId
            ? {
                ...node,
                type,
                data: nextData,
                ...(nextDimensions
                  ? {
                      width: nextDimensions.width,
                      height: nextDimensions.height,
                      style: {
                        ...(node.style ?? {}),
                        width: nextDimensions.width,
                        height: nextDimensions.height,
                      },
                    }
                  : {}),
              }
            : node
        ),
        history: {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        },
        dragHistorySnapshot: null,
        routingRevision: state.routingRevision + 1,
        inputGraphRevision: state.inputGraphRevision + 1,
      };
    });
    return changed;
  },

  addEdge: (source, target, sourceHandle = 'source', targetHandle = 'target') => {
    const state = get();
    // Check if both nodes exist
    const sourceNode = state.nodes.find((n) => n.id === source);
    const targetNode = state.nodes.find((n) => n.id === target);
    if (!sourceNode || !targetNode) {
      return null;
    }
    if (!nodeHasSourceHandle(sourceNode.type) || !nodeHasTargetHandle(targetNode.type)) {
      return null;
    }

    const edgeId = sourceHandle === 'source' && targetHandle === 'target'
      ? `e-${source}-${target}`
      : `e-${source}-${sourceHandle ?? 'source'}-${target}-${targetHandle ?? 'target'}`;
    // Check if edge already exists
    if (state.edges.some((e) => e.id === edgeId)) {
      return edgeId;
    }

    const newEdge: CanvasEdge = {
      id: edgeId,
      source,
      target,
      sourceHandle,
      targetHandle,
      type: 'disconnectableEdge',
    };

    set({
      nodes: applyCinematicStudioPromptToTarget(state.nodes, source, target),
      edges: [...state.edges, newEdge],
      inputGraphRevision: state.inputGraphRevision + 1,
    });

    return edgeId;
  },

  findNodePosition: (sourceNodeId, newNodeWidth, newNodeHeight) => {
    const state = get();
    const sourceNode = state.nodes.find((n) => n.id === sourceNodeId);
    if (!sourceNode) {
      return { x: 100, y: 100 };
    }

    // ---- 组内生成: 下游节点保持在组内, 组空间不足自动扩组 ----
    if (sourceNode.parentId) {
      const groupNode = state.nodes.find((n) => n.id === sourceNode.parentId && n.type === CANVAS_NODE_TYPES.group);
      // 冻结组不吸收新节点: 否则新节点一诞生就被锁死, 也无法自动扩组
      if (groupNode && (groupNode.data as GroupNodeData).frozen !== true) {
        return placeNodeInsideGroup(state, groupNode, sourceNode, newNodeWidth, newNodeHeight);
      }
    }

    const sourceWidth = sourceNode.measured?.width ?? DEFAULT_NODE_WIDTH;
    // 下游节点采用稳定的“首个右侧、后续向下”布局:
    // 1. 第一个下游节点与母节点顶边对齐, 右侧只留最小间距;
    // 2. 第二个及后续节点与第一个下游节点左边对齐, 上下只留最小间距;
    // 3. 目标位置若被其它节点挡住, 就把对齐基准换成挡住的节点, 继续向右/向下吸附。
    // 这段优先于旧的环形搜索, 因而生成结果不会因为附近有节点而跳到较远位置。
    const downstreamNodes = state.edges
      .filter((edge) => edge.source === sourceNodeId)
      .map((edge) => state.nodes.find((node) => node.id === edge.target))
      .filter((node): node is CanvasNode => Boolean(node));
    const getNodeSize = (node: CanvasNode) => ({
      width: node.measured?.width ?? node.width ?? DEFAULT_NODE_WIDTH,
      height: node.measured?.height ?? node.height ?? 200,
    });
    const collidingNode = (x: number, y: number): CanvasNode | null => {
      return (
        state.nodes.find((node) => {
          // 顶层下游节点的坐标是画布绝对坐标, 组内子节点则是相对父组坐标,
          // 不能把后者误当成画布上的挡板。
          if (node.id === sourceNodeId || node.parentId) {
            return false;
          }
          const size = getNodeSize(node);
          return (
            x < node.position.x + size.width &&
            x + newNodeWidth > node.position.x &&
            y < node.position.y + size.height &&
            y + newNodeHeight > node.position.y
          );
        }) ?? null
      );
    };
    const resolveDownstreamPosition = (
      initial: { x: number; y: number },
      axis: "horizontal" | "vertical",
    ) => {
      let position = initial;
      const visited = new Set<string>();
      // 最多沿所有现有节点走一遍, 防止极端重叠数据造成死循环。
      for (let index = 0; index <= state.nodes.length; index += 1) {
        const blocker = collidingNode(position.x, position.y);
        if (!blocker || visited.has(blocker.id)) {
          return position;
        }
        visited.add(blocker.id);
        const blockerSize = getNodeSize(blocker);
        position =
          axis === "horizontal"
            ? { x: blocker.position.x + blockerSize.width + DOWNSTREAM_ALIGNMENT_GAP, y: blocker.position.y }
            : { x: blocker.position.x, y: blocker.position.y + blockerSize.height + DOWNSTREAM_ALIGNMENT_GAP };
      }
      return position;
    };

    if (downstreamNodes.length === 0) {
      return resolveDownstreamPosition(
        { x: sourceNode.position.x + sourceWidth + DOWNSTREAM_ALIGNMENT_GAP, y: sourceNode.position.y },
        "horizontal",
      );
    }

    const firstDownstream = downstreamNodes[0];
    const lastDownstream = downstreamNodes[downstreamNodes.length - 1];
    const lastSize = getNodeSize(lastDownstream);
    return resolveDownstreamPosition(
      {
        x: firstDownstream.position.x,
        y: lastDownstream.position.y + lastSize.height + DOWNSTREAM_ALIGNMENT_GAP,
      },
      "vertical",
    );

  },

  addDerivedUploadNode: (sourceNodeId, imageUrl, aspectRatio, previewImageUrl) => {
    const state = get();
    const sourceNode = state.nodes.find((node) => node.id === sourceNodeId);
    const resolvedAspectRatio = resolveDerivedAspectRatio(sourceNode, aspectRatio);
    const derivedSize = resolveGeneratedImageNodeDimensions(resolvedAspectRatio);
    const placement = state.findNodePosition(sourceNodeId, derivedSize.width, derivedSize.height);
    const position = { x: placement.x, y: placement.y };
    const node = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.upload, position, {
      imageUrl,
      previewImageUrl: previewImageUrl ?? null,
      aspectRatio: resolvedAspectRatio,
    });
    if (placement.parentId) {
      node.parentId = placement.parentId;
    }
    node.width = derivedSize.width;
    node.height = derivedSize.height;
    node.style = {
      ...(node.style ?? {}),
      width: derivedSize.width,
      height: derivedSize.height,
    };

    // 组内生成: 组空间不足时随节点一起扩组(同一 set, 同入历史快照)
    let nextNodes = [...state.nodes, node];
    if (placement.groupResize) {
      nextNodes = nextNodes.map((item) =>
        item.id === placement.groupResize?.id
          ? {
              ...item,
              width: placement.groupResize!.width,
              height: placement.groupResize!.height,
              style: {
                ...(item.style ?? {}),
                width: placement.groupResize!.width,
                height: placement.groupResize!.height,
              },
            }
          : item
      );
    }

    set({
      nodes: nextNodes,
      selectedNodeId: node.id,
      routingRevision: state.routingRevision + 1,
      activeToolDialog: null,
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
    });

    return node.id;
  },

  addDerivedExportNode: (sourceNodeId, imageUrl, aspectRatio, previewImageUrl, options) => {
    const state = get();
    const sourceNode = state.nodes.find((node) => node.id === sourceNodeId);
    const aspectRatioStrategy = options?.aspectRatioStrategy ?? 'provided';
    const resolvedAspectRatio = aspectRatioStrategy === 'derivedFromSource'
      ? resolveDerivedAspectRatio(sourceNode, aspectRatio)
      : (aspectRatio || resolveDerivedAspectRatio(sourceNode, DEFAULT_ASPECT_RATIO));
    const autoSize = resolveAutoImageNodeDimensions(resolvedAspectRatio, {
      minWidth: EXPORT_RESULT_NODE_MIN_WIDTH,
      minHeight: EXPORT_RESULT_NODE_MIN_HEIGHT,
    });
    const generatedSize = resolveGeneratedImageNodeDimensions(resolvedAspectRatio, {
      minWidth: EXPORT_RESULT_NODE_MIN_WIDTH,
      minHeight: EXPORT_RESULT_NODE_MIN_HEIGHT,
    });
    const sourceSize = sourceNode ? getNodeSize(sourceNode) : null;
    const sizeStrategy = options?.sizeStrategy
      ?? (options?.matchSourceNodeSize ? 'matchSource' : 'generated');
    let derivedSize = generatedSize;
    if (sizeStrategy === 'autoMinEdge') {
      derivedSize = autoSize;
    } else if (sizeStrategy === 'matchSource' && sourceSize) {
      derivedSize = {
        width: Math.max(1, Math.round(sourceSize.width)),
        height: Math.max(1, Math.round(sourceSize.height)),
      };
    }
    const placement = state.findNodePosition(
      sourceNodeId,
      derivedSize.width,
      derivedSize.height
    );
    const position = { x: placement.x, y: placement.y };
    const exportNodeData: Partial<CanvasNodeData> = {
      imageUrl,
      previewImageUrl: previewImageUrl ?? null,
      aspectRatio: resolvedAspectRatio,
    };
    if (options?.defaultTitle) {
      (exportNodeData as { displayName?: string }).displayName = options.defaultTitle;
    }
    if (options?.resultKind) {
      (exportNodeData as { resultKind?: ExportImageNodeResultKind }).resultKind = options.resultKind;
      if (!options.defaultTitle) {
        (exportNodeData as { displayName?: string }).displayName =
          EXPORT_RESULT_DISPLAY_NAME[options.resultKind];
      }
    }
    const node = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.exportImage, position, {
      ...exportNodeData,
    });
    if (placement.parentId) {
      node.parentId = placement.parentId;
    }
    node.width = derivedSize.width;
    node.height = derivedSize.height;
    node.style = {
      ...(node.style ?? {}),
      width: derivedSize.width,
      height: derivedSize.height,
    };

    // 组内生成: 组空间不足时随节点一起扩组(同一 set, 同入历史快照)
    let nextNodes = [...state.nodes, node];
    if (placement.groupResize) {
      nextNodes = nextNodes.map((item) =>
        item.id === placement.groupResize?.id
          ? {
              ...item,
              width: placement.groupResize!.width,
              height: placement.groupResize!.height,
              style: {
                ...(item.style ?? {}),
                width: placement.groupResize!.width,
                height: placement.groupResize!.height,
              },
            }
          : item
      );
    }

    set({
      nodes: nextNodes,
      selectedNodeId: node.id,
      routingRevision: state.routingRevision + 1,
      activeToolDialog: null,
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
    });

    return node.id;
  },

  addStoryboardSplitNode: (sourceNodeId, rows, cols, frames, frameAspectRatio) => {
    const state = get();
    const placement = state.findNodePosition(sourceNodeId, 320, 240);
    const position = { x: placement.x, y: placement.y };
    const resolvedFrameAspectRatio =
      frameAspectRatio ??
      frames.find((frame) => typeof frame.aspectRatio === 'string')?.aspectRatio ??
      DEFAULT_ASPECT_RATIO;

    const node = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.storyboardSplit, position, {
      gridRows: rows,
      gridCols: cols,
      frames,
      aspectRatio: resolvedFrameAspectRatio,
      frameAspectRatio: resolvedFrameAspectRatio,
      exportOptions: createDefaultStoryboardExportOptions(),
    });
    if (placement.parentId) {
      node.parentId = placement.parentId;
    }

    // 组内生成: 组空间不足时随节点一起扩组(同一 set, 同入历史快照)
    let nextNodes = [...state.nodes, node];
    if (placement.groupResize) {
      nextNodes = nextNodes.map((item) =>
        item.id === placement.groupResize?.id
          ? {
              ...item,
              width: placement.groupResize!.width,
              height: placement.groupResize!.height,
              style: {
                ...(item.style ?? {}),
                width: placement.groupResize!.width,
                height: placement.groupResize!.height,
              },
            }
          : item
      );
    }

    set({
      nodes: nextNodes,
      selectedNodeId: node.id,
      routingRevision: state.routingRevision + 1,
      activeToolDialog: null,
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
    });

    return node.id;
  },

  updateNodeData: (nodeId, data) => {
    set((state) => {
      let changed = false;
      let geometryChanged = false;
      let processingChanged = false;
      let inputGraphChanged = false;
      const nextNodes = state.nodes.map((node) => {
        if (node.id !== nodeId) {
          return node;
        }

        const hasDataChange = Object.entries(data).some(([key, nextValue]) => {
          const previousValue = (node.data as Record<string, unknown>)[key];
          return !Object.is(previousValue, nextValue);
        });
        if (!hasDataChange) {
          return node;
        }

        const mergedData = {
          ...node.data,
          ...data,
        } as CanvasNodeData;
        const resizedNode = maybeApplyImageAutoResize(
          {
            ...node,
            data: mergedData,
          },
          data
        );

        geometryChanged = geometryChanged
          || resizedNode.width !== node.width
          || resizedNode.height !== node.height;
        processingChanged = processingChanged
          || nodeDataChangesProcessingState(
            node.data as CanvasNodeData,
            mergedData as CanvasNodeData
          );
        inputGraphChanged = inputGraphChanged || nodeDataAffectsInputGraph(node, data);
        changed = true;
        return resizedNode;
      });

      if (!changed) {
        return {};
      }

      return {
        nodes: nextNodes,
        history: {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        },
        dragHistorySnapshot: null,
        ...(geometryChanged ? { routingRevision: state.routingRevision + 1 } : {}),
        ...(processingChanged ? { processingRevision: state.processingRevision + 1 } : {}),
        ...(inputGraphChanged ? { inputGraphRevision: state.inputGraphRevision + 1 } : {}),
      };
    });
  },

  updateNodeDataTransient: (nodeId, data) => {
    set((state) => {
      let changed = false;
      let geometryChanged = false;
      let processingChanged = false;
      let inputGraphChanged = false;
      const nextNodes = state.nodes.map((node) => {
        if (node.id !== nodeId) return node;
        const hasDataChange = Object.entries(data).some(([key, nextValue]) =>
          !Object.is((node.data as Record<string, unknown>)[key], nextValue)
        );
        if (!hasDataChange) return node;
        changed = true;
        const mergedData = { ...node.data, ...data } as CanvasNodeData;
        const resizedNode = maybeApplyImageAutoResize({ ...node, data: mergedData }, data);
        geometryChanged = geometryChanged
          || resizedNode.width !== node.width
          || resizedNode.height !== node.height;
        processingChanged = processingChanged
          || nodeDataChangesProcessingState(
            node.data as CanvasNodeData,
            mergedData as CanvasNodeData
          );
        inputGraphChanged = inputGraphChanged || nodeDataAffectsInputGraph(node, data);
        return resizedNode;
      });
      return changed
        ? {
            nodes: nextNodes,
            ...(geometryChanged ? { routingRevision: state.routingRevision + 1 } : {}),
            ...(processingChanged ? { processingRevision: state.processingRevision + 1 } : {}),
            ...(inputGraphChanged ? { inputGraphRevision: state.inputGraphRevision + 1 } : {}),
          }
        : {};
    });
  },

  updateNodePosition: (nodeId, position) => {
    set((state) => {
      // 冻结组及其内部节点位置锁定(AI 助手 / 脚本调用同样受约束)
      if (collectFrozenLockedNodeIds(state.nodes).has(nodeId)) {
        return {};
      }

      let changed = false;
      const nextNodes = state.nodes.map((node) => {
        if (node.id !== nodeId) {
          return node;
        }

        if (node.position.x === position.x && node.position.y === position.y) {
          return node;
        }

        changed = true;
        return {
          ...node,
          position,
        };
      });

      if (!changed) {
        return {};
      }

      return { nodes: nextNodes, routingRevision: state.routingRevision + 1 };
    });
  },

  updateNodeSize: (nodeId, width, height) => {
    const safeWidth = Math.max(1, Math.round(width));
    const safeHeight = Math.max(1, Math.round(height));
    set((state) => {
      let changed = false;
      const nextNodes = state.nodes.map((node) => {
        if (node.id !== nodeId) {
          return node;
        }

        const nextWidth = Math.round(safeWidth);
        const nextHeight = Math.round(safeHeight);
        if (node.width === nextWidth && node.height === nextHeight) {
          return node;
        }

        changed = true;
        return {
          ...node,
          width: nextWidth,
          height: nextHeight,
          style: {
            ...(node.style ?? {}),
            width: nextWidth,
            height: nextHeight,
          },
        };
      });

      if (!changed) {
        return {};
      }

      return { nodes: nextNodes, routingRevision: state.routingRevision + 1 };
    });
  },

  updateStoryboardFrame: (nodeId, frameId, data) => {
    set((state) => {
      let changed = false;
      let inputGraphChanged = false;
      const nextNodes = state.nodes.map((node) => {
        if (node.id !== nodeId || !isStoryboardSplitNode(node)) {
          return node;
        }

        const nextFrames = node.data.frames.map((frame) => {
          if (frame.id !== frameId) {
            return frame;
          }

          const patchEntries = Object.entries(data) as Array<
            [keyof StoryboardFrameItem, StoryboardFrameItem[keyof StoryboardFrameItem]]
          >;
          const hasFrameChange = patchEntries.some(([key, nextValue]) =>
            !Object.is(frame[key], nextValue)
          );
          if (!hasFrameChange) {
            return frame;
          }

          inputGraphChanged = inputGraphChanged || Object.keys(data).some(
            (key) => key === 'imageUrl' || key === 'previewImageUrl'
          );
          changed = true;
          return {
            ...frame,
            ...data,
          };
        });

        return {
          ...node,
          data: {
            ...node.data,
            frames: nextFrames,
          },
        };
      });

      if (!changed) {
        return {};
      }

      return {
        nodes: nextNodes,
        history: {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        },
        dragHistorySnapshot: null,
        ...(inputGraphChanged ? { inputGraphRevision: state.inputGraphRevision + 1 } : {}),
      };
    });
  },

  reorderStoryboardFrame: (nodeId, draggedFrameId, targetFrameId) => {
    set((state) => {
      let changed = false;
      const nextNodes = state.nodes.map((node) => {
        if (node.id !== nodeId || !isStoryboardSplitNode(node)) {
          return node;
        }

        const frames = [...node.data.frames].sort((a, b) => a.order - b.order);
        const fromIndex = frames.findIndex((frame) => frame.id === draggedFrameId);
        const toIndex = frames.findIndex((frame) => frame.id === targetFrameId);

        if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
          return node;
        }

        changed = true;
        const [movedFrame] = frames.splice(fromIndex, 1);
        frames.splice(toIndex, 0, movedFrame);

        return {
          ...node,
          data: {
            ...node.data,
            frames: frames.map((frame, index) => ({
              ...frame,
              order: index,
            })),
          },
        };
      });

      if (!changed) {
        return {};
      }

      return {
        nodes: nextNodes,
        history: {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        },
        dragHistorySnapshot: null,
        inputGraphRevision: state.inputGraphRevision + 1,
      };
    });
  },

  deleteNode: (nodeId) => {
    get().deleteNodes([nodeId]);
  },

  deleteNodes: (nodeIds) => {
    const uniqueIds = Array.from(new Set(nodeIds.filter((nodeId) => nodeId.trim().length > 0)));
    if (uniqueIds.length === 0) {
      return;
    }

    set((state) => {
      const existingIds = uniqueIds.filter((nodeId) => state.nodes.some((node) => node.id === nodeId));
      if (existingIds.length === 0) {
        return {};
      }

      const deleteSet = collectNodeIdsWithDescendants(state.nodes, existingIds);
      const nextNodes = state.nodes.filter((node) => !deleteSet.has(node.id));
      const nextEdges = state.edges.filter(
        (edge) => !deleteSet.has(edge.source) && !deleteSet.has(edge.target)
      );

      return {
        nodes: nextNodes,
        edges: nextEdges,
        routingRevision: state.routingRevision + 1,
        inputGraphRevision: state.inputGraphRevision + 1,
        selectedNodeId:
          state.selectedNodeId && deleteSet.has(state.selectedNodeId) ? null : state.selectedNodeId,
        activeToolDialog:
          state.activeToolDialog && deleteSet.has(state.activeToolDialog.nodeId)
            ? null
            : state.activeToolDialog,
        history: {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        },
        dragHistorySnapshot: null,
      };
    });
  },

  groupNodes: (nodeIds, groupName) => {
    const uniqueIds = Array.from(new Set(nodeIds.filter((nodeId) => nodeId.trim().length > 0)));
    if (uniqueIds.length < 2) {
      return null;
    }

    const state = get();
    const nodeMap = new Map(state.nodes.map((node) => [node.id, node] as const));
    const existingIds = uniqueIds.filter((nodeId) => nodeMap.has(nodeId));
    if (existingIds.length < 2) {
      return null;
    }

    const selectedSet = new Set(existingIds);
    const memberIds = existingIds.filter((nodeId) => {
      let currentParentId = nodeMap.get(nodeId)?.parentId;
      const visited = new Set<string>();
      while (currentParentId && !visited.has(currentParentId)) {
        if (selectedSet.has(currentParentId)) {
          return false;
        }
        visited.add(currentParentId);
        currentParentId = nodeMap.get(currentParentId)?.parentId;
      }
      return true;
    });
    if (memberIds.length < 2) {
      return null;
    }

    // 冻结组及其内部节点不参与新建分组: 否则拖动外层组会连带移动已冻结的组
    const lockedIds = collectFrozenLockedNodeIds(state.nodes);
    const groupableIds = memberIds.filter((id) => !lockedIds.has(id));
    if (groupableIds.length < 2) {
      return null;
    }

    const memberSet = new Set(groupableIds);
    const members = groupableIds
      .map((id) => nodeMap.get(id))
      .filter((node): node is CanvasNode => Boolean(node));

    const absoluteBounds = members.reduce(
      (acc, node) => {
        const absolute = resolveAbsolutePosition(node, nodeMap);
        const size = getNodeSize(node);
        return {
          minX: Math.min(acc.minX, absolute.x),
          minY: Math.min(acc.minY, absolute.y),
          maxX: Math.max(acc.maxX, absolute.x + size.width),
          maxY: Math.max(acc.maxY, absolute.y + size.height),
        };
      },
      {
        minX: Number.POSITIVE_INFINITY,
        minY: Number.POSITIVE_INFINITY,
        maxX: Number.NEGATIVE_INFINITY,
        maxY: Number.NEGATIVE_INFINITY,
      }
    );

    if (!Number.isFinite(absoluteBounds.minX) || !Number.isFinite(absoluteBounds.minY)) {
      return null;
    }

    const SIDE_PADDING = 20;
    const TOP_PADDING = 34;
    const BOTTOM_PADDING = 20;
    const groupX = Math.round(absoluteBounds.minX - SIDE_PADDING);
    const groupY = Math.round(absoluteBounds.minY - TOP_PADDING);
    const groupWidth = Math.round(
      Math.max(220, absoluteBounds.maxX - absoluteBounds.minX + SIDE_PADDING * 2)
    );
    const groupHeight = Math.round(
      Math.max(140, absoluteBounds.maxY - absoluteBounds.minY + TOP_PADDING + BOTTOM_PADDING)
    );

    const existingGroupCount = state.nodes.filter((node) => node.type === CANVAS_NODE_TYPES.group).length;
    const groupDisplayName = groupName?.trim() || `组 ${existingGroupCount + 1}`;
    const groupNode = canvasNodeFactory.createNode(
      CANVAS_NODE_TYPES.group,
      { x: groupX, y: groupY },
      {
        label: groupDisplayName,
        displayName: groupDisplayName,
      }
    );
    groupNode.style = { width: groupWidth, height: groupHeight };
    groupNode.selected = true;

    const updatedMemberMap = new Map<string, CanvasNode>();
    for (const node of members) {
      const absolute = resolveAbsolutePosition(node, nodeMap);
      updatedMemberMap.set(node.id, {
        ...node,
        parentId: groupNode.id,
        // 不设 extent:'parent': 否则 React Flow 会把子节点拖拽锁死在组内, 无法实现「拖出组」
        position: {
          x: Math.round(absolute.x - groupX),
          y: Math.round(absolute.y - groupY),
        },
        selected: false,
      });
    }

    const firstMemberIndex = state.nodes.reduce((acc, node, index) => {
      if (!memberSet.has(node.id)) {
        return acc;
      }
      return acc === -1 ? index : Math.min(acc, index);
    }, -1);

    const nextNodes: CanvasNode[] = [];
    let insertedGroup = false;
    for (let index = 0; index < state.nodes.length; index += 1) {
      const node = state.nodes[index];
      if (!insertedGroup && index === firstMemberIndex) {
        nextNodes.push(groupNode);
        insertedGroup = true;
      }

      const updatedMember = updatedMemberMap.get(node.id);
      if (updatedMember) {
        nextNodes.push(updatedMember);
      } else {
        nextNodes.push({
          ...node,
          selected: false,
        });
      }
    }

    if (!insertedGroup) {
      nextNodes.push(groupNode);
    }

    set({
      nodes: nextNodes,
      routingRevision: state.routingRevision + 1,
      inputGraphRevision: state.inputGraphRevision + 1,
      selectedNodeId: groupNode.id,
      activeToolDialog:
        state.activeToolDialog && memberSet.has(state.activeToolDialog.nodeId)
          ? null
          : state.activeToolDialog,
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
    });

    return groupNode.id;
  },

  setGroupFrozen: (groupNodeId, frozen) => {
    const state = get();
    const groupNode = state.nodes.find(
      (node) => node.id === groupNodeId && node.type === CANVAS_NODE_TYPES.group
    );
    if (!groupNode) {
      return false;
    }
    if (((groupNode.data as GroupNodeData).frozen === true) === frozen) {
      return false;
    }

    // 只翻转组自身的数据标记; 组内节点靠 parentId 继承锁定状态,
    // 由 Canvas 派生的 draggable 与 onNodesChange 拦截共同生效。
    const nextNodes = state.nodes.map((node) => {
      if (node.id !== groupNodeId) {
        return node;
      }
      const nextData: GroupNodeData = { ...(node.data as GroupNodeData) };
      if (frozen) {
        nextData.frozen = true;
      } else {
        delete nextData.frozen;
      }
      return { ...node, data: nextData };
    });

    set({
      nodes: nextNodes,
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
    });

    return true;
  },

  ungroupNode: (groupNodeId) => {
    const state = get();
    const groupNode = state.nodes.find(
      (node) => node.id === groupNodeId && node.type === CANVAS_NODE_TYPES.group
    );
    if (!groupNode) {
      return false;
    }

    const nodeMap = new Map(state.nodes.map((node) => [node.id, node] as const));
    const children = state.nodes.filter((node) => node.parentId === groupNodeId);
    if (children.length === 0) {
      return false;
    }

    const nextNodes = state.nodes
      .filter((node) => node.id !== groupNodeId)
      .map((node) => {
        if (node.parentId !== groupNodeId) {
          return node;
        }

        const absolute = resolveAbsolutePosition(node, nodeMap);
        return {
          ...node,
          parentId: undefined,
          extent: undefined,
          position: {
            x: Math.round(absolute.x),
            y: Math.round(absolute.y),
          },
          selected: false,
        };
      });

    const nextEdges = state.edges.filter(
      (edge) => edge.source !== groupNodeId && edge.target !== groupNodeId
    );

    set({
      nodes: nextNodes,
      edges: nextEdges,
      routingRevision: state.routingRevision + 1,
      inputGraphRevision: state.inputGraphRevision + 1,
      selectedNodeId: state.selectedNodeId === groupNodeId ? null : state.selectedNodeId,
      activeToolDialog:
        state.activeToolDialog?.nodeId === groupNodeId ? null : state.activeToolDialog,
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
    });

    return true;
  },

  addNodesToGroup: (nodeIds, groupId) => {
    const state = get();
    const groupNode = state.nodes.find(
      (node) => node.id === groupId && node.type === CANVAS_NODE_TYPES.group
    );
    if (!groupNode || (groupNode.data as GroupNodeData).frozen === true) {
      // 冻结组不接受新节点: 否则新节点会被就地锁死, 用户无法再调整位置
      return false;
    }

    const nodeMap = new Map(state.nodes.map((node) => [node.id, node] as const));
    const groupAbsolute = resolveAbsolutePosition(groupNode, nodeMap);
    const ids = Array.from(new Set(
      (Array.isArray(nodeIds) ? nodeIds : [])
        .map((nodeId) => nodeId.trim())
        .filter((nodeId) => {
          const node = nodeMap.get(nodeId);
          if (!node || node.id === groupId || node.type === CANVAS_NODE_TYPES.group) {
            return false;
          }
          return node.parentId !== groupId;
        })
    ));
    if (ids.length === 0) {
      return false;
    }

    let changed = false;
    const nextNodes = state.nodes.map((node) => {
      if (!ids.includes(node.id)) {
        return node;
      }
      const absolute = resolveAbsolutePosition(node, nodeMap);
      changed = true;
      return {
        ...node,
        parentId: groupId,
        // 不设 extent:'parent': 否则子节点会被 React Flow 锁死在组内, 无法拖出
        position: {
          x: Math.round(absolute.x - groupAbsolute.x),
          y: Math.round(absolute.y - groupAbsolute.y),
        },
        selected: false,
      };
    });

    if (!changed) {
      return false;
    }

    set({
      nodes: nextNodes,
      routingRevision: state.routingRevision + 1,
      inputGraphRevision: state.inputGraphRevision + 1,
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
    });

    return true;
  },

  removeNodesFromGroup: (nodeIds) => {
    const state = get();
    const nodeMap = new Map(state.nodes.map((node) => [node.id, node] as const));
    const ids = new Set(
      (Array.isArray(nodeIds) ? nodeIds : [])
        .map((nodeId) => nodeId.trim())
        .filter((nodeId) => {
          const node = nodeMap.get(nodeId);
          if (!node || !node.parentId) {
            return false;
          }
          // 冻结组内的节点不允许被移出(位置已锁定)
          const parent = nodeMap.get(node.parentId);
          return !(parent && parent.type === CANVAS_NODE_TYPES.group && (parent.data as GroupNodeData).frozen === true);
        })
    );
    if (ids.size === 0) {
      return false;
    }

    let changed = false;
    const nextNodes = state.nodes.map((node) => {
      if (!ids.has(node.id)) {
        return node;
      }
      const absolute = resolveAbsolutePosition(node, nodeMap);
      changed = true;
      return {
        ...node,
        parentId: undefined,
        extent: undefined,
        position: {
          x: Math.round(absolute.x),
          y: Math.round(absolute.y),
        },
        selected: false,
      };
    });

    if (!changed) {
      return false;
    }

    set({
      nodes: nextNodes,
      routingRevision: state.routingRevision + 1,
      inputGraphRevision: state.inputGraphRevision + 1,
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
    });

    return true;
  },

  autoLayoutCanvas: () => {
    const state = get();
    const positions = computeAutoLayout(state.nodes, state.edges);
    if (positions.size === 0) {
      return false;
    }

    // 冻结组及其内部节点保持原位, 不参与自动整理
    const lockedIds = collectFrozenLockedNodeIds(state.nodes);
    let changed = false;
    const nextNodes = state.nodes.map((node) => {
      if (lockedIds.has(node.id)) {
        return node;
      }
      const position = positions.get(node.id);
      if (!position) {
        return node;
      }
      changed = true;
      return {
        ...node,
        position: { x: position.x, y: position.y },
      };
    });

    if (!changed) {
      return false;
    }

    set({
      nodes: nextNodes,
      routingRevision: state.routingRevision + 1,
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
    });

    return true;
  },

  alignNodes: (nodeIds, mode) => {
    const state = get();
    const nodeMap = new Map(state.nodes.map((node) => [node.id, node] as const));
    const ids = Array.from(new Set(
      (Array.isArray(nodeIds) ? nodeIds : [])
        .map((nodeId) => nodeId.trim())
        .filter((nodeId) => nodeId.length > 0 && nodeMap.has(nodeId))
    ));
    if (ids.length < 2) {
      return false;
    }

    const items = ids.map((id) => {
      const node = nodeMap.get(id) as CanvasNode;
      const absolute = resolveAbsolutePosition(node, nodeMap);
      const size = getNodeSize(node);
      return { id, x: absolute.x, y: absolute.y, width: size.width, height: size.height };
    });

    const targets = computeAlignment(items, mode);
    if (targets.size === 0) {
      return false;
    }

    // 冻结组及其内部节点不参与对齐
    const lockedIds = collectFrozenLockedNodeIds(state.nodes);
    let changed = false;
    const nextNodes = state.nodes.map((node) => {
      const target = targets.get(node.id);
      if (!target || lockedIds.has(node.id)) {
        return node;
      }
      let relative = target;
      if (node.parentId && nodeMap.has(node.parentId)) {
        const parentAbsolute = resolveAbsolutePosition(nodeMap.get(node.parentId) as CanvasNode, nodeMap);
        relative = { x: target.x - parentAbsolute.x, y: target.y - parentAbsolute.y };
      }
      const nextPosition = { x: Math.round(relative.x), y: Math.round(relative.y) };
      if (node.position.x === nextPosition.x && node.position.y === nextPosition.y) {
        return node;
      }
      changed = true;
      return { ...node, position: nextPosition };
    });

    if (!changed) {
      return false;
    }

    set({
      nodes: nextNodes,
      routingRevision: state.routingRevision + 1,
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
    });

    return true;
  },

  /** 全画布智能对齐 + 防重叠: 顶层节点吸附到附近节点/组边框的边缘或中心线 */
  snapAllNodesToNeighbors: (threshold) => {
    const state = get();
    const nodeMap = new Map(state.nodes.map((node) => [node.id, node] as const));
    const topLevelNodes = state.nodes.filter((node) => !node.parentId);
    if (topLevelNodes.length < 2) {
      return false;
    }

    const targets = computeSmartSnapLayout(state.nodes, threshold);
    if (targets.size === 0) {
      return false;
    }

    // 冻结组及其内部节点不参与智能对齐
    const lockedIds = collectFrozenLockedNodeIds(state.nodes);
    let changed = false;
    const nextNodes = state.nodes.map((node) => {
      const target = targets.get(node.id);
      if (!target || lockedIds.has(node.id)) {
        return node;
      }
      let relative = target;
      if (node.parentId && nodeMap.has(node.parentId)) {
        const parentAbsolute = resolveAbsolutePosition(nodeMap.get(node.parentId) as CanvasNode, nodeMap);
        relative = { x: target.x - parentAbsolute.x, y: target.y - parentAbsolute.y };
      }
      const nextPosition = { x: Math.round(relative.x), y: Math.round(relative.y) };
      if (node.position.x === nextPosition.x && node.position.y === nextPosition.y) {
        return node;
      }
      changed = true;
      return { ...node, position: nextPosition };
    });

    if (!changed) {
      return false;
    }

    set({
      nodes: nextNodes,
      routingRevision: state.routingRevision + 1,
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
    });
    return true;
  },

  deleteEdge: (edgeId) => {
    set((state) => {
      const hasEdge = state.edges.some((edge) => edge.id === edgeId);
      if (!hasEdge) {
        return {};
      }

      return {
        edges: state.edges.filter((edge) => edge.id !== edgeId),
        history: {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        },
        dragHistorySnapshot: null,
        inputGraphRevision: state.inputGraphRevision + 1,
      };
    });
  },

  setSelectedNode: (nodeId) => {
    if (get().selectedNodeId === nodeId) {
      return;
    }
    set({ selectedNodeId: nodeId });
  },

  setHoveredGroupId: (groupId) => {
    const state = get();
    if (state.hoveredGroupId === groupId) {
      return;
    }
    set({ hoveredGroupId: groupId });
  },

  setFlashGroupId: (groupId) => {
    const state = get();
    if (state.flashGroupId === groupId) {
      return;
    }
    set({ flashGroupId: groupId });
  },

  setChargingGroupId: (groupId) => {
    const state = get();
    if (state.chargingGroupId === groupId) {
      return;
    }
    set({ chargingGroupId: groupId });
  },

  openToolDialog: (dialog) => {
    set({ activeToolDialog: dialog });
  },

  closeToolDialog: () => {
    set({ activeToolDialog: null });
  },

  undo: () => {
    const state = get();
    const target = state.history.past[state.history.past.length - 1];
    if (!target) {
      return false;
    }

    const currentSnapshot = createSnapshot(state.nodes, state.edges);
    const nextPast = state.history.past.slice(0, -1);
    const restoredSnapshot = preserveCompletedGenerationResults(
      state.nodes,
      state.edges,
      target.nodes,
      target.edges,
    );

    set({
      nodes: restoredSnapshot.nodes,
      edges: restoredSnapshot.edges,
      routingRevision: state.routingRevision + 1,
      processingRevision: state.processingRevision + 1,
      inputGraphRevision: state.inputGraphRevision + 1,
      selectedNodeId: resolveSelectedNodeId(state.selectedNodeId, restoredSnapshot.nodes),
      activeToolDialog: resolveActiveToolDialog(state.activeToolDialog, restoredSnapshot.nodes),
      history: {
        past: nextPast,
        future: pushSnapshot(state.history.future, currentSnapshot),
      },
      dragHistorySnapshot: null,
    });
    return true;
  },

  redo: () => {
    const state = get();
    const target = state.history.future[state.history.future.length - 1];
    if (!target) {
      return false;
    }

    const currentSnapshot = createSnapshot(state.nodes, state.edges);
    const nextFuture = state.history.future.slice(0, -1);

    set({
      nodes: target.nodes,
      edges: target.edges,
      routingRevision: state.routingRevision + 1,
      processingRevision: state.processingRevision + 1,
      inputGraphRevision: state.inputGraphRevision + 1,
      selectedNodeId: resolveSelectedNodeId(state.selectedNodeId, target.nodes),
      activeToolDialog: resolveActiveToolDialog(state.activeToolDialog, target.nodes),
      history: {
        past: pushSnapshot(state.history.past, currentSnapshot),
        future: nextFuture,
      },
      dragHistorySnapshot: null,
    });
    return true;
  },

  clearCanvas: () => {
    set((state) => {
      if (state.nodes.length === 0 && state.edges.length === 0) {
        return {};
      }

      return {
        nodes: [],
        edges: [],
        routingRevision: state.routingRevision + 1,
        processingRevision: state.processingRevision + 1,
        inputGraphRevision: state.inputGraphRevision + 1,
        selectedNodeId: null,
        activeToolDialog: null,
        history: {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        },
        dragHistorySnapshot: null,
      };
    });
  },
}));
