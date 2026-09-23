import {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  ReactFlow,
  Background,
  MiniMap,
  BackgroundVariant,
  SelectionMode,
  useReactFlow,
  useUpdateNodeInternals,
  type Connection,
  type EdgeChange,
  type FinalConnectionState,
  type HandleType,
  type NodeChange,
  type OnConnectStartParams,
  type Viewport,
} from "@xyflow/react";
import { useTranslation } from "react-i18next";
import { isTauri } from "@tauri-apps/api/core";
import { AlignJustify, Bot, Crosshair, Film, Keyboard, LayoutTemplate, Library } from "lucide-react";
import "@xyflow/react/dist/style.css";

import { useCanvasStore } from "@/stores/canvasStore";
import { useProjectStore } from "@/stores/projectStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { matchesBinding, useKeyboardShortcutStore } from "@/stores/keyboardShortcutStore";
import { canvasAiGateway, canvasEventBus } from "@/features/canvas/application/canvasServices";
import { nodeCatalog } from "@/features/canvas/application/nodeCatalog";
import {
  CANVAS_NODE_TYPES,
  type CanvasEdge,
  type CanvasNode,
  type CanvasNodeType,
  DEFAULT_NODE_WIDTH,
  EXPORT_RESULT_NODE_MIN_HEIGHT,
  EXPORT_RESULT_NODE_MIN_WIDTH,
  isTextAnnotationNode,
} from "@/features/canvas/domain/canvasNodes";
import { resolveMinEdgeFittedSize } from "@/features/canvas/application/imageNodeSizing";
import { prepareNodeImage, prepareNodeImageFromFile } from "@/features/canvas/application/imageData";
import {
  buildGenerationErrorReport,
  CURRENT_RUNTIME_SESSION_ID,
} from "@/features/canvas/application/generationErrorReport";
import { showErrorDialog } from "@/features/canvas/application/errorDialog";
import { recordGenerationOutcome } from "@/features/canvas/application/usageRecording";
import {
  getConnectMenuNodeTypes,
  nodeHasSourceHandle,
  nodeHasTargetHandle,
} from "@/features/canvas/domain/nodeRegistry";
import { embedStoryboardImageMetadata } from "@/commands/image";
import { persistLibraryAssetFromFile } from "@/commands/assetLibrary";
import {
  ALIGNMENT_GUIDE_SNAP_THRESHOLD,
  computeDragAlignment,
  type AlignmentGuide,
  type NodeAlignMode,
} from "@/features/canvas/application/canvasLayout";
import { nodeTypes } from "./nodes";
import { edgeTypes } from "./edges";

const MAX_RECOVERY_POLLERS = 4;
const MAX_RECOVERY_DURATION_MS = 30 * 60 * 1000;
import { NodeSelectionMenu } from "./NodeSelectionMenu";
import { CANVAS_NODE_DRAG_DATA_TYPE, NodePaletteSidebar, NodePaletteToggle } from "./NodePaletteSidebar";
import { CanvasContextMenu } from "./CanvasContextMenu";
import { SelectedNodeOverlay } from "./ui/SelectedNodeOverlay";
import { NodeToolDialog } from "./ui/NodeToolDialog";
import { ImageViewerModal } from "./ui/ImageViewerModal";
import { saveMediaSourceWithDialog } from "./application/mediaDownload";
import { shouldFailRunningVideoJob } from "./application/videoJobPolling";
import { VideoFrameExtractDialog } from "./ui/VideoFrameExtractDialog";
import { ShortcutSettingsDialog } from "./ui/ShortcutSettingsDialog";
import { AssetLibraryPanel } from "@/features/library/AssetLibraryPanel";
import { AgentPanel } from "@/features/agent/AgentPanel";
import { useAssetLibraryStore } from "@/features/library/assetStore";
import {
  ASSET_DRAG_DATA_TYPE,
  importImageUrlToAssetDetailed,
  parseAssetDragPayload,
  PROMPT_DRAG_DATA_TYPE,
  parsePromptDragPayload,
} from "@/features/library/importAssets";
import { usePromptLibraryStore, type PromptTemplate } from "@/features/prompts/promptLibraryStore";
import { UiButton, UiInput, UiModal } from "@/components/ui";
import type { CinematicAssetLibraryBridge } from "@/features/library/AssetLibraryPanel";
import { TemplateSidebar } from "@/features/templates/TemplateSidebar";
import { TEMPLATE_DRAG_DATA_TYPE, parseTemplateDragPayload } from "@/features/templates/templateDrag";
import { resolveTemplatePlacement } from "@/features/templates/placeGraph";
import { browserTemplateRepository } from "@/features/templates/storage/templateRepository";
import { ensureTemplateGraph } from "@/features/templates/types";
import { duplicateCinematicProject } from "@/features/cinematicStudio/app/model";
import { createCinematicProjectId } from "@/features/cinematicStudio/app/projectId";

const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };

/** 兼容供应商返回的 JSON 图片数组；旧任务仍然直接返回单个图片源。 */
function parseImageResultSources(result: string): string[] {
  const trimmed = result.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const sources = parsed.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
        if (sources.length > 0) return sources;
      }
    } catch {
      // 不是数组结果时按旧版单图源继续处理。
    }
  }
  return [trimmed];
}

type LocalUploadMediaType = "image" | "video" | "audio";

function resolveLocalUploadMediaType(file: File): LocalUploadMediaType | null {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";

  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "heic", "heif"].includes(extension)) return "image";
  if (["mp4", "mov", "m4v", "webm", "avi", "mkv"].includes(extension)) return "video";
  if (["mp3", "m4a", "wav", "aac", "flac", "ogg"].includes(extension)) return "audio";
  return null;
}

async function persistLocalMediaFile(file: File, mediaType: "video" | "audio"): Promise<string> {
  const extension = file.name.split(".").pop()?.trim() || (mediaType === "video" ? "mp4" : "mp3");
  if (isTauri()) {
    return await persistLibraryAssetFromFile(file, extension);
  }
  return URL.createObjectURL(file);
}

const ALIGN_OPTIONS: Array<{ mode: NodeAlignMode; label: string }> = [
  { mode: "left", label: "左对齐" },
  { mode: "centerH", label: "水平居中" },
  { mode: "right", label: "右对齐" },
  { mode: "top", label: "顶对齐" },
  { mode: "centerV", label: "垂直居中" },
  { mode: "bottom", label: "底对齐" },
  { mode: "distributeH", label: "水平等距" },
  { mode: "distributeV", label: "垂直等距" },
];

function isFailedGenerationResultNode(node: CanvasNode): boolean {
  if (node.type !== CANVAS_NODE_TYPES.exportImage && node.type !== CANVAS_NODE_TYPES.audio) {
    return false;
  }

  const data = node.data as {
    imageUrl?: unknown;
    sourcePath?: unknown;
    isGenerating?: unknown;
    generationError?: unknown;
  };
  // 图片结果节点以 imageUrl 为准, 音频/视频结果节点以 sourcePath 为准。
  const hasGeneratedResult =
    node.type === CANVAS_NODE_TYPES.audio
      ? typeof data.sourcePath === "string" && data.sourcePath.trim().length > 0
      : typeof data.imageUrl === "string" && data.imageUrl.trim().length > 0;
  return (
    data.isGenerating !== true &&
    !hasGeneratedResult &&
    typeof data.generationError === "string" &&
    data.generationError.trim().length > 0
  );
}

function resolveContextMenuImageUrl(node: CanvasNode): string | null {
  const data = node.data as {
    imageUrl?: unknown;
    inputImageUrl?: unknown;
    outputImageUrl?: unknown;
  };
  const candidates = [data.imageUrl, data.outputImageUrl, data.inputImageUrl];
  return (
    candidates.find((imageUrl): imageUrl is string => typeof imageUrl === "string" && imageUrl.trim().length > 0) ??
    null
  );
}

function resolveContextMenuMedia(node: CanvasNode): { url: string; mediaType: "image" | "video" } | null {
  const data = node.data as {
    imageUrl?: unknown;
    outputImageUrl?: unknown;
    inputImageUrl?: unknown;
    sourcePath?: unknown;
    mediaType?: unknown;
  };
  if (node.type === CANVAS_NODE_TYPES.audio && data.mediaType === "video") {
    return typeof data.sourcePath === "string" && data.sourcePath.trim()
      ? { url: data.sourcePath.trim(), mediaType: "video" }
      : null;
  }
  const url = [data.imageUrl, data.outputImageUrl, data.inputImageUrl].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  return url ? { url: url.trim(), mediaType: "image" } : null;
}

function resolveCanvasNodeAbsolutePosition(nodeId: string, nodeMap: Map<string, CanvasNode>): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let currentId: string | null = nodeId;
  const visited = new Set<string>();
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const node = nodeMap.get(currentId);
    if (!node) {
      break;
    }
    x += node.position.x;
    y += node.position.y;
    currentId = node.parentId ?? null;
  }
  return { x, y };
}

function resolveCanvasNodeSize(node: CanvasNode): { width: number; height: number } {
  return {
    width: node.measured?.width ?? node.width ?? DEFAULT_NODE_WIDTH,
    height: node.measured?.height ?? node.height ?? 200,
  };
}

/** 穿结界三阶段: 接触边缘 →(500ms)→ 蓝色高亮 →(500ms)→ 解锁穿出 */
const CHARGE_HIGHLIGHT_DELAY_MS = 500;
const CHARGE_UNLOCK_DELAY_MS = 500;
/** 判定节点"明显回到组内"(取消蓄力)所需离开边缘的距离 */
const CHARGE_EDGE_MARGIN = 8;

/** 计算拖动节点当前悬停命中的目标分组 id(未命中返回 null) */
function resolveDragTargetGroupId(
  targets: CanvasNode[],
  nodeMap: Map<string, CanvasNode>,
  groups: CanvasNode[],
): string | null {
  for (const target of targets) {
    if (target.type === CANVAS_NODE_TYPES.group) {
      continue;
    }
    const absolute = resolveCanvasNodeAbsolutePosition(target.id, nodeMap);
    const size = resolveCanvasNodeSize(target);
    const centerX = absolute.x + size.width / 2;
    const centerY = absolute.y + size.height / 2;
    const targetGroup = groups.find((group) => {
      if (group.id === target.parentId) {
        return false;
      }
      const groupAbsolute = resolveCanvasNodeAbsolutePosition(group.id, nodeMap);
      const groupSize = resolveCanvasNodeSize(group);
      return (
        centerX >= groupAbsolute.x &&
        centerX <= groupAbsolute.x + groupSize.width &&
        centerY >= groupAbsolute.y &&
        centerY <= groupAbsolute.y + groupSize.height
      );
    });
    if (targetGroup) {
      return targetGroup.id;
    }
  }
  return null;
}

function resolveViewportCenterPosition(): { x: number; y: number } {
  const { currentViewport, canvasViewportSize } = useCanvasStore.getState();
  const zoom = Math.max(0.01, currentViewport.zoom || 1);
  return {
    x: Math.round((canvasViewportSize.width / 2 - currentViewport.x) / zoom - 110),
    y: Math.round((canvasViewportSize.height / 2 - currentViewport.y) / zoom - 90),
  };
}

interface PendingConnectStart {
  nodeId: string;
  handleType: HandleType;
  start?: {
    x: number;
    y: number;
  };
}

interface PreviewConnectionVisual {
  d: string;
  stroke: string;
  strokeWidth: number;
  strokeLinecap: "butt" | "round" | "square";
  left: number;
  top: number;
  width: number;
  height: number;
}

interface ClipboardSnapshot {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

interface DuplicateOptions {
  explicitOffset?: { x: number; y: number };
  targetPosition?: { x: number; y: number };
  disableOffsetIteration?: boolean;
  suppressSelect?: boolean;
  suppressPersist?: boolean;
}

interface DuplicateResult {
  firstNodeId: string | null;
  idMap: Map<string, string>;
}

const ALT_DRAG_COPY_Z_INDEX = 2000;
const GENERATION_JOB_POLL_INTERVAL_MS = 1400;
const CONNECTION_HANDLE_HIT_RADIUS = 18;

interface ConnectionHandlePosition {
  element: HTMLElement;
  centerX: number;
  centerY: number;
}

interface ConnectionHandleCache {
  isDirty: boolean;
  positions: ConnectionHandlePosition[];
}

interface GenerationStoryboardMetadata {
  gridRows: number;
  gridCols: number;
  frameNotes: string[];
}

function getNodeSize(node: CanvasNode): { width: number; height: number } {
  const styleWidth = typeof node.style?.width === "number" ? node.style.width : null;
  const styleHeight = typeof node.style?.height === "number" ? node.style.height : null;
  return {
    width: node.measured?.width ?? styleWidth ?? DEFAULT_NODE_WIDTH,
    height: node.measured?.height ?? styleHeight ?? 200,
  };
}

function hasRectCollision(
  candidateRect: { x: number; y: number; width: number; height: number },
  nodes: CanvasNode[],
  ignoreNodeIds: Set<string>,
): boolean {
  const margin = 18;
  return nodes.some((node) => {
    if (ignoreNodeIds.has(node.id)) {
      return false;
    }
    const size = getNodeSize(node);
    return (
      candidateRect.x < node.position.x + size.width + margin &&
      candidateRect.x + candidateRect.width + margin > node.position.x &&
      candidateRect.y < node.position.y + size.height + margin &&
      candidateRect.y + candidateRect.height + margin > node.position.y
    );
  });
}

function cloneNodeData<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) {
    return false;
  }
  const tagName = element.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || element.isContentEditable;
}

function isDirectorDeskOpen(): boolean {
  return typeof document !== "undefined" && document.querySelector("[data-director-desk]") !== null;
}

function resolveClipboardImageFile(event: ClipboardEvent): File | null {
  const clipboardItems = event.clipboardData?.items;
  if (!clipboardItems) {
    return null;
  }

  for (const item of Array.from(clipboardItems)) {
    if (!item.type.startsWith("image/")) {
      continue;
    }

    const file = item.getAsFile();
    if (!file) {
      continue;
    }

    const existingName = typeof file.name === "string" ? file.name.trim() : "";
    if (existingName) {
      return file;
    }

    const subtype = item.type.split("/")[1]?.split("+")[0] || "png";
    return new File([file], `pasted-image.${subtype}`, {
      type: file.type || item.type,
      lastModified: Date.now(),
    });
  }

  return null;
}

function resolveAllowedNodeTypes(handleType: HandleType): CanvasNodeType[] {
  return getConnectMenuNodeTypes(handleType);
}

function canNodeTypeBeManualConnectionSource(type: CanvasNodeType): boolean {
  return nodeHasSourceHandle(type);
}

function canNodeBeManualConnectionSource(nodeId: string | null | undefined, nodes: CanvasNode[]): boolean {
  if (!nodeId) {
    return false;
  }
  const node = nodes.find((item) => item.id === nodeId);
  return node ? canNodeTypeBeManualConnectionSource(node.type) : false;
}

function getClientPosition(event: MouseEvent | TouchEvent): { x: number; y: number } | null {
  if ("clientX" in event && "clientY" in event) {
    return { x: event.clientX, y: event.clientY };
  }

  const touch = "changedTouches" in event ? (event.changedTouches[0] ?? event.touches[0]) : null;
  if (!touch) {
    return null;
  }

  return { x: touch.clientX, y: touch.clientY };
}

function createPreviewPath(line: PreviewConnectionLine): string {
  const { start, end, handleType } = line;
  const deltaX = end.x - start.x;
  const curveStrength = Math.max(36, Math.min(120, Math.abs(deltaX) * 0.4));
  const handleDirection = handleType === "source" ? 1 : -1;
  const isReverseDrag = deltaX * handleDirection < 0;
  const effectiveDirection = isReverseDrag ? -handleDirection : handleDirection;
  const startControlX = start.x + effectiveDirection * curveStrength;
  const endControlX = end.x - effectiveDirection * curveStrength;

  return `M ${start.x} ${start.y} C ${startControlX} ${start.y}, ${endControlX} ${end.y}, ${end.x} ${end.y}`;
}

interface PreviewConnectionLine {
  start: { x: number; y: number };
  end: { x: number; y: number };
  handleType: HandleType;
}

export function Canvas() {
  const { t } = useTranslation();
  const reactFlowInstance = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();

  const wrapperRef = useRef<HTMLDivElement>(null);
  const nearbyConnectionHandleRef = useRef<HTMLElement | null>(null);
  const nearbyConnectionHandleCacheRef = useRef<ConnectionHandleCache>({
    isDirty: true,
    positions: [],
  });
  const nearbyConnectionHandleFrameRef = useRef<number | null>(null);
  const pendingNearbyConnectionPointerRef = useRef<{ x: number; y: number } | null>(null);
  const suppressNextPaneClickRef = useRef(false);
  // 框选成功后的 click/dblclick 抑制时间窗(ms 时间戳)。
  // 必须用 ref 而非 effect 闭包变量: setNodes 会触发 store 更新导致 effect 重建, 闭包变量值会丢失。
  const suppressClickUntilRef = useRef(0);
  const suppressNextEdgeClickRef = useRef(false);
  // 右键框选期间要吞掉随之而来的 contextmenu，否则一拖就跳出画布右键菜单。
  // Windows 的 contextmenu 在 mouseup 之后派发，正好被 pointerup 里置的时间窗挡住。
  const suppressContextMenuUntilRef = useRef(0);
  // macOS 的 contextmenu 在按下瞬间就派发，只能先压住，等 pointerup 判定「没拖动」
  // 再用这个回调把菜单补弹一次（详见框选 effect 里的注释）。
  const canvasContextMenuRef = useRef<((event: MouseEvent | ReactMouseEvent) => void) | null>(null);

  const [showNodeMenu, setShowNodeMenu] = useState(false);
  const [isNodePaletteOpen, setIsNodePaletteOpen] = useState(true);
  const [canvasContextMenu, setCanvasContextMenu] = useState<{
    position: { x: number; y: number };
    flowPosition: { x: number; y: number };
    imageUrl: string | null;
    downloadUrl: string | null;
    downloadMediaType: "image" | "video" | null;
    nodeId: string | null;
    textContent: string | null;
  } | null>(null);
  const [saveTextPromptDialog, setSaveTextPromptDialog] = useState<{
    name: string;
    content: string;
  } | null>(null);
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 });
  const [flowPosition, setFlowPosition] = useState({ x: 0, y: 0 });
  const [menuAllowedTypes, setMenuAllowedTypes] = useState<CanvasNodeType[] | undefined>(undefined);
  const [pendingConnectStart, setPendingConnectStart] = useState<PendingConnectStart | null>(null);
  const [previewConnectionVisual, setPreviewConnectionVisual] = useState<PreviewConnectionVisual | null>(null);
  const [alignmentGuides, setAlignmentGuides] = useState<AlignmentGuide[]>([]);
  // React Flow may emit the final `dragging: false` change using its raw pointer
  // position after the visual snap has already been applied. Keep the latest
  // snapped position around so that final change cannot undo the snap.
  const activeDragAlignmentRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  const [isTemplateOpen, setIsTemplateOpen] = useState(false);
  const [cinematicAssetLibrary, setCinematicAssetLibrary] = useState<CinematicAssetLibraryBridge | null>(null);
  const [isVideoExtractOpen, setIsVideoExtractOpen] = useState(false);
  const [isAgentOpen, setIsAgentOpen] = useState(false);
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
  /** 双击框选: 选择矩形(相对画布容器坐标) */
  const [dragSelectRect, setDragSelectRect] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const [isAlignMenuOpen, setIsAlignMenuOpen] = useState(false);
  const [groupNameDialog, setGroupNameDialog] = useState<{
    nodeIds: string[];
    name: string;
    mode: "create" | "rename";
    nodeId?: string;
  } | null>(null);
  const alignMenuRef = useRef<HTMLDivElement>(null);
  const flashTimerRef = useRef<number | null>(null);
  /** 拖出蓄力(穿结界)状态: nodeId -> { phase, timer }; phase0=接触边缘待高亮, phase1=高亮中待解锁 */
  const chargeOutTimersRef = useRef<Map<string, { phase: 0 | 1; timer: number }>>(new Map());
  const hasActiveGroupsDuringDragRef = useRef(false);
  const pendingGroupDragNodeRef = useRef<CanvasNode | null>(null);
  const groupDragFeedbackTimerRef = useRef<number | null>(null);

  const isRestoringCanvasRef = useRef(true);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedSnapshotRef = useRef<ClipboardSnapshot | null>(null);
  const pasteIterationRef = useRef(0);
  const pasteImageHandledRef = useRef(false);
  const activeGenerationPollNodeIdsRef = useRef(new Set<string>());
  const activeVideoRecoveryNodeIdsRef = useRef(new Set<string>());
  const recoveryPollerCountRef = useRef(0);
  const recoveryMountedRef = useRef(true);

  useEffect(() => {
    // StrictMode dev 下挂载会模拟一次卸载+重挂载, setup 必须把标志置回 true,
    // 否则轮询器启动即退出, 后台完成的生成任务永远不会同步回节点。
    recoveryMountedRef.current = true;
    return () => {
      recoveryMountedRef.current = false;
    };
  }, []);

  // Cinematic Studio reuses the canvas library as its sole asset entry point.
  useEffect(() => {
    const openLibrary = () => setIsLibraryOpen(true);
    const registerCinematicLibrary = (event: Event) => {
      const detail = (event as CustomEvent<CinematicAssetLibraryBridge>).detail;
      if (detail?.project && detail?.scene) setCinematicAssetLibrary(detail);
    };
    const unregisterCinematicLibrary = () => setCinematicAssetLibrary(null);
    window.addEventListener("lentalk:open-asset-library", openLibrary);
    window.addEventListener("lentalk:register-cinematic-asset-library", registerCinematicLibrary);
    window.addEventListener("lentalk:unregister-cinematic-asset-library", unregisterCinematicLibrary);
    return () => {
      window.removeEventListener("lentalk:open-asset-library", openLibrary);
      window.removeEventListener("lentalk:register-cinematic-asset-library", registerCinematicLibrary);
      window.removeEventListener("lentalk:unregister-cinematic-asset-library", unregisterCinematicLibrary);
    };
  }, []);

  useEffect(
    () => () => {
      if (groupDragFeedbackTimerRef.current !== null) {
        window.clearTimeout(groupDragFeedbackTimerRef.current);
      }
      if (nearbyConnectionHandleFrameRef.current !== null) {
        window.cancelAnimationFrame(nearbyConnectionHandleFrameRef.current);
      }
    },
    [],
  );
  const duplicateNodesRef = useRef<((sourceNodeIds: string[], options?: DuplicateOptions) => string | null) | null>(
    null,
  );
  const altDragCopyRef = useRef<{
    sourceNodeIds: string[];
    startPositions: Map<string, { x: number; y: number }>;
    copiedNodeIds: string[];
    sourceToCopyIdMap: Map<string, string>;
  } | null>(null);
  const edgePanGestureRef = useRef<{
    active: boolean;
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startViewportX: number;
    startViewportY: number;
    zoom: number;
    moved: boolean;
  } | null>(null);

  const invalidateNearbyConnectionHandleCache = useCallback(() => {
    const cache = nearbyConnectionHandleCacheRef.current;
    cache.isDirty = true;
    nearbyConnectionHandleRef.current?.classList.remove("connection-handle-nearby");
    nearbyConnectionHandleRef.current = null;
  }, []);

  const resolveNearbyConnectionHandle = useCallback((clientX: number, clientY: number): HTMLElement | null => {
    const wrapper = wrapperRef.current;
    if (!wrapper) {
      return null;
    }

    const cache = nearbyConnectionHandleCacheRef.current;
    if (cache.isDirty) {
      const positions: ConnectionHandlePosition[] = [];
      const handles = wrapper.querySelectorAll<HTMLElement>(".react-flow__handle.connectable.connectablestart");

      for (const handle of handles) {
        const rect = handle.getBoundingClientRect();
        positions.push({
          element: handle,
          centerX: rect.left + rect.width / 2,
          centerY: rect.top + rect.height / 2,
        });
      }

      cache.positions = positions;
      cache.isDirty = false;
    }

    let nearestHandle: ConnectionHandlePosition | null = null;
    let nearestDistance = CONNECTION_HANDLE_HIT_RADIUS;
    for (const handle of cache.positions) {
      if (!handle.element.isConnected) {
        continue;
      }
      const distance = Math.hypot(clientX - handle.centerX, clientY - handle.centerY);
      if (distance <= nearestDistance) {
        nearestDistance = distance;
        nearestHandle = handle;
      }
    }

    return nearestHandle?.element ?? null;
  }, []);

  const updateNearbyConnectionHandle = useCallback(
    (clientX: number, clientY: number) => {
      const nextHandle = resolveNearbyConnectionHandle(clientX, clientY);
      const previousHandle = nearbyConnectionHandleRef.current;
      if (previousHandle !== nextHandle) {
        previousHandle?.classList.remove("connection-handle-nearby");
        nextHandle?.classList.add("connection-handle-nearby");
        nearbyConnectionHandleRef.current = nextHandle;
      }
      return nextHandle;
    },
    [resolveNearbyConnectionHandle],
  );

  const handleCanvasMouseMoveCapture = useCallback(
    (event: ReactMouseEvent) => {
      // Nearby-handle hit testing is only needed before a connection starts.
      // Skipping it while a pointer button is down avoids scanning every
      // connectable handle during node drags on large canvases.
      if (event.buttons !== 0) {
        return;
      }

      pendingNearbyConnectionPointerRef.current = { x: event.clientX, y: event.clientY };
      if (nearbyConnectionHandleFrameRef.current !== null) {
        return;
      }

      nearbyConnectionHandleFrameRef.current = window.requestAnimationFrame(() => {
        nearbyConnectionHandleFrameRef.current = null;
        const pointer = pendingNearbyConnectionPointerRef.current;
        if (pointer) {
          updateNearbyConnectionHandle(pointer.x, pointer.y);
        }
      });
    },
    [updateNearbyConnectionHandle],
  );

  const handleCanvasMouseDownCapture = useCallback(
    (event: ReactMouseEvent) => {
      if (event.button !== 0) {
        return;
      }

      const eventTarget = event.target as Element | null;
      // 原生 select 和弹窗会在节点 DOM 树内冒泡。它们标记为 `nodrag` 后，
      // 不应再被画布的邻近 Handle 逻辑接管，否则会残留一次拖拽状态。
      if (eventTarget?.closest?.(".nodrag")) {
        return;
      }
      if (eventTarget?.closest?.(".react-flow__handle")) {
        return;
      }

      if (nearbyConnectionHandleFrameRef.current !== null) {
        window.cancelAnimationFrame(nearbyConnectionHandleFrameRef.current);
        nearbyConnectionHandleFrameRef.current = null;
      }
      const handle = updateNearbyConnectionHandle(event.clientX, event.clientY);
      if (!handle) {
        return;
      }

      // React Flow binds its connection start handler to the real Handle
      // element. Forward a synthetic mousedown so the enlarged nearby zone
      // follows the same native connection path as an exact Handle click.
      handle.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: 1,
          clientX: event.clientX,
          clientY: event.clientY,
          screenX: event.screenX,
          screenY: event.screenY,
          view: window,
        }),
      );
      event.preventDefault();
      event.stopPropagation();
    },
    [updateNearbyConnectionHandle],
  );

  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const history = useCanvasStore((state) => state.history);
  const dragHistorySnapshot = useCanvasStore((state) => state.dragHistorySnapshot);
  const processingRevision = useCanvasStore((state) => state.processingRevision);
  const applyNodesChange = useCanvasStore((state) => state.onNodesChange);
  const applyEdgesChange = useCanvasStore((state) => state.onEdgesChange);
  const connectNodes = useCanvasStore((state) => state.onConnect);
  const setCanvasData = useCanvasStore((state) => state.setCanvasData);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const updateNodeDataTransient = useCanvasStore((state) => state.updateNodeDataTransient);
  const addNode = useCanvasStore((state) => state.addNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const findNodePosition = useCanvasStore((state) => state.findNodePosition);
  const replaceNodeType = useCanvasStore((state) => state.replaceNodeType);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId);
  const deleteEdge = useCanvasStore((state) => state.deleteEdge);
  const deleteNode = useCanvasStore((state) => state.deleteNode);
  const deleteNodes = useCanvasStore((state) => state.deleteNodes);
  const groupNodes = useCanvasStore((state) => state.groupNodes);
  const addNodesToGroup = useCanvasStore((state) => state.addNodesToGroup);
  const removeNodesFromGroup = useCanvasStore((state) => state.removeNodesFromGroup);
  const setHoveredGroupId = useCanvasStore((state) => state.setHoveredGroupId);
  const setFlashGroupId = useCanvasStore((state) => state.setFlashGroupId);
  const setChargingGroupId = useCanvasStore((state) => state.setChargingGroupId);
  const alignNodes = useCanvasStore((state) => state.alignNodes);
  const snapAllNodesToNeighbors = useCanvasStore((state) => state.snapAllNodesToNeighbors);
  const undo = useCanvasStore((state) => state.undo);
  const redo = useCanvasStore((state) => state.redo);
  const openToolDialog = useCanvasStore((state) => state.openToolDialog);
  const closeToolDialog = useCanvasStore((state) => state.closeToolDialog);
  const setViewportState = useCanvasStore((state) => state.setViewportState);
  const setCanvasViewportSize = useCanvasStore((state) => state.setCanvasViewportSize);
  const imageViewer = useCanvasStore((state) => state.imageViewer);
  const closeImageViewer = useCanvasStore((state) => state.closeImageViewer);
  const navigateImageViewer = useCanvasStore((state) => state.navigateImageViewer);
  const apiKeys = useSettingsStore((state) => state.apiKeys);
  // 保留 settingsStore 的旧字段名以兼容已有配置; 在画布中它现在表示对齐辅助线/智能吸附开关。
  const alignmentGuidesEnabled = useSettingsStore((state) => state.snapToGrid);
  const setAlignmentGuidesEnabled = useSettingsStore((state) => state.setSnapToGrid);
  const assetLibraries = useAssetLibraryStore((state) => state.libraries);
  const activeAssetLibraryId = useAssetLibraryStore((state) => state.activeLibraryId);
  const assetCategories = useAssetLibraryStore((state) => state.categories);

  const failedGenerationNodeIds = useMemo(
    () => nodes.filter(isFailedGenerationResultNode).map((node) => node.id),
    [nodes],
  );
  const activeAssetLibraryCategories = useMemo(() => {
    const libraryId = activeAssetLibraryId || assetLibraries[0]?.id;
    return libraryId ? assetCategories.filter((category) => category.libraryId === libraryId) : [];
  }, [activeAssetLibraryId, assetCategories, assetLibraries]);

  const getCurrentProject = useProjectStore((state) => state.getCurrentProject);
  const saveCurrentProject = useProjectStore((state) => state.saveCurrentProject);
  const saveCurrentProjectViewport = useProjectStore((state) => state.saveCurrentProjectViewport);
  const cancelPendingViewportPersist = useProjectStore((state) => state.cancelPendingViewportPersist);

  const persistCanvasSnapshot = useCallback(() => {
    if (isRestoringCanvasRef.current) {
      return;
    }

    const currentProject = getCurrentProject();
    if (!currentProject) {
      return;
    }

    const currentNodes = useCanvasStore.getState().nodes;
    const currentEdges = useCanvasStore.getState().edges;
    const currentHistory = useCanvasStore.getState().history;
    saveCurrentProject(currentNodes, currentEdges, reactFlowInstance.getViewport(), currentHistory);
  }, [getCurrentProject, reactFlowInstance, saveCurrentProject]);

  const scheduleCanvasPersist = useCallback(
    (delayMs = 140) => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }

      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        persistCanvasSnapshot();
      }, delayMs);
    },
    [persistCanvasSnapshot],
  );

  /** 打开模板侧边栏: 先把当前画布快照落盘(取消未触发的延迟保存), 画布本身不离开 */
  const handleOpenTemplates = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    persistCanvasSnapshot();
    setIsTemplateOpen(true);
  }, [persistCanvasSnapshot]);

  useEffect(() => {
    const unsubscribeOpen = canvasEventBus.subscribe("tool-dialog/open", (payload) => {
      openToolDialog(payload);
    });
    const unsubscribeClose = canvasEventBus.subscribe("tool-dialog/close", () => {
      closeToolDialog();
    });

    return () => {
      unsubscribeOpen();
      unsubscribeClose();
    };
  }, [openToolDialog, closeToolDialog]);

  useEffect(() => {
    isRestoringCanvasRef.current = true;
    const project = getCurrentProject();
    if (project) {
      setCanvasData(project.nodes, project.edges, project.history);
      setViewportState(project.viewport ?? DEFAULT_VIEWPORT);
      requestAnimationFrame(() => {
        reactFlowInstance.setViewport(project.viewport ?? DEFAULT_VIEWPORT, { duration: 0 });
      });
    } else {
      setViewportState(DEFAULT_VIEWPORT);
    }
    const restoreTimer = setTimeout(() => {
      isRestoringCanvasRef.current = false;
    }, 0);

    return () => {
      clearTimeout(restoreTimer);
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      closeImageViewer();
      persistCanvasSnapshot();
    };
  }, [closeImageViewer, getCurrentProject, persistCanvasSnapshot, reactFlowInstance, setCanvasData, setViewportState]);

  useEffect(() => {
    if (isRestoringCanvasRef.current || dragHistorySnapshot) {
      return;
    }

    scheduleCanvasPersist();
  }, [nodes, edges, history, dragHistorySnapshot, scheduleCanvasPersist]);

  useEffect(() => {
    const sleep = (delayMs: number) =>
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, delayMs);
      });

    const pendingExportNodes = useCanvasStore.getState().nodes.filter((node) => {
      if (node.type !== CANVAS_NODE_TYPES.exportImage) {
        return false;
      }
      const data = node.data as Record<string, unknown>;
      const request = data.generationRequest;
      const hasRecoverableRequest =
        request && typeof request === "object" && (request as { kind?: unknown }).kind === "image";
      return (
        data.isGenerating === true &&
        ((typeof data.generationJobId === "string" && data.generationJobId.length > 0) || hasRecoverableRequest)
      );
    });

    for (const pendingNode of pendingExportNodes) {
      if (activeGenerationPollNodeIdsRef.current.has(pendingNode.id)) {
        continue;
      }
      activeGenerationPollNodeIdsRef.current.add(pendingNode.id);

      void (async () => {
        const startedAt = Date.now();
        let acquiredSlot = false;
        try {
          while (true) {
            if (!recoveryMountedRef.current || Date.now() - startedAt >= MAX_RECOVERY_DURATION_MS) {
              break;
            }
            while (recoveryMountedRef.current && recoveryPollerCountRef.current >= MAX_RECOVERY_POLLERS) {
              await sleep(250);
            }
            if (!acquiredSlot) {
              recoveryPollerCountRef.current += 1;
              acquiredSlot = true;
            }
            const currentNode = useCanvasStore.getState().nodes.find((node) => node.id === pendingNode.id);
            if (!currentNode) {
              break;
            }

            const currentData = currentNode.data as Record<string, unknown>;
            const jobId = typeof currentData.generationJobId === "string" ? currentData.generationJobId : "";
            const isGenerating = currentData.isGenerating === true;
            const generationRequest = currentData.generationRequest as
              | {
                  kind?: unknown;
                  prompt?: unknown;
                  negativePrompt?: unknown;
                  model?: unknown;
                  size?: unknown;
                  aspectRatio?: unknown;
                  imageCount?: unknown;
                  referenceImages?: unknown;
                  extraParams?: unknown;
                }
              | undefined;
            if (!isGenerating || (!jobId && generationRequest?.kind !== "image")) {
              break;
            }

            const requestModel = typeof generationRequest?.model === "string" ? generationRequest.model : "";
            const generationProviderId =
              typeof currentData.generationProviderId === "string"
                ? currentData.generationProviderId
                : (requestModel.split("/")[0] ?? "");
            if (generationProviderId) {
              const providerApiKey = apiKeys[generationProviderId] ?? "";
              if (providerApiKey) {
                await canvasAiGateway.setApiKey(generationProviderId, providerApiKey).catch((error) => {
                  console.warn("[GenerationJob] set_api_key failed before poll", {
                    nodeId: pendingNode.id,
                    generationProviderId,
                    error,
                  });
                });
              }
            }

            // A missing job id is only recoverable when the user explicitly
            // requested a retry. Never resubmit a persisted request merely
            // because the project was reopened: the previous request may
            // already have been billed upstream.
            if (!jobId && generationRequest?.kind === "image") {
              const isExplicitRetry = currentData.generationRetryRequested === true;
              // 当前运行会话正常提交的节点: 提交方马上会写入 jobId,
              // 无 jobId 只是窗口期, 直接等待下一轮轮询, 绝不重复提交(重复扣费)
              if (!isExplicitRetry && currentData.generationClientSessionId === CURRENT_RUNTIME_SESSION_ID) {
                await sleep(GENERATION_JOB_POLL_INTERVAL_MS);
                continue;
              }

              if (!isExplicitRetry) {
                const interruptedMessage = "应用退出时任务中断，可从节点重试";
                updateNodeDataTransient(pendingNode.id, {
                  isGenerating: false,
                  generationStartedAt: null,
                  generationError: interruptedMessage,
                  generationErrorDetails: interruptedMessage,
                });
                break;
              }

              try {
                const retryPayload = {
                  prompt: typeof generationRequest.prompt === "string" ? generationRequest.prompt : "",
                  negativePrompt:
                    typeof generationRequest.negativePrompt === "string" ? generationRequest.negativePrompt : undefined,
                  model: requestModel,
                  size: typeof generationRequest.size === "string" ? generationRequest.size : "1K",
                  aspectRatio:
                    typeof generationRequest.aspectRatio === "string" ? generationRequest.aspectRatio : "1:1",
                  imageCount:
                    typeof generationRequest.imageCount === "number" ? generationRequest.imageCount : undefined,
                  referenceImages: Array.isArray(generationRequest.referenceImages)
                    ? generationRequest.referenceImages.filter((value): value is string => typeof value === "string")
                    : [],
                  extraParams:
                    generationRequest.extraParams && typeof generationRequest.extraParams === "object"
                      ? (generationRequest.extraParams as Record<string, unknown>)
                      : undefined,
                };
                const submittedJobId = await canvasAiGateway.submitGenerateImageJob(retryPayload);
                updateNodeData(pendingNode.id, {
                  generationJobId: submittedJobId,
                  generationProviderId: generationProviderId || null,
                  generationClientSessionId: CURRENT_RUNTIME_SESSION_ID,
                  generationRetryRequested: false,
                });
                await sleep(GENERATION_JOB_POLL_INTERVAL_MS);
                continue;
              } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                updateNodeDataTransient(pendingNode.id, {
                  isGenerating: false,
                  generationStartedAt: null,
                  generationRetryRequested: false,
                  generationError: errorMessage,
                  generationErrorDetails: errorMessage,
                });
                break;
              }
            }

            const status = await canvasAiGateway.getGenerateImageJob(jobId).catch((error) => {
              console.warn("[GenerationJob] poll failed", { nodeId: pendingNode.id, jobId, error });
              return null;
            });
            if (!status) {
              await sleep(GENERATION_JOB_POLL_INTERVAL_MS);
              continue;
            }

            if (status.status === "queued" || status.status === "running") {
              await sleep(GENERATION_JOB_POLL_INTERVAL_MS);
              continue;
            }

            if (status.status === "succeeded" && typeof status.result === "string" && status.result.trim()) {
              const resultSources = parseImageResultSources(status.result);
              const resultSource = resultSources[0];
              recordGenerationOutcome({
                nodeId: pendingNode.id,
                kind: "image",
                providerId: generationProviderId,
                modelId: requestModel,
                size: typeof generationRequest?.size === "string" ? generationRequest.size : "1K",
                referenceCount: Array.isArray(generationRequest?.referenceImages)
                  ? generationRequest.referenceImages.length
                  : 0,
                status: "succeeded",
              });
              // Show the provider result immediately. Persisting the original
              // image and building a preview can take seconds for large data
              // URLs, and must not keep the result node on its placeholder.
              const storyboardMetadataRaw = currentData.generationStoryboardMetadata as
                GenerationStoryboardMetadata | undefined;
              const hasStoryboardMetadata = Boolean(
                storyboardMetadataRaw &&
                Number.isFinite(storyboardMetadataRaw.gridRows) &&
                Number.isFinite(storyboardMetadataRaw.gridCols) &&
                Array.isArray(storyboardMetadataRaw.frameNotes),
              );
              updateNodeDataTransient(pendingNode.id, {
                imageUrl: resultSource,
                previewImageUrl: resultSource,
                generationResultProtected: true,
                isGenerating: false,
                generationStartedAt: null,
                generationJobId: null,
                generationProviderId: null,
                generationClientSessionId: null,
                generationStoryboardMetadata: undefined,
                generationError: null,
                generationErrorDetails: null,
                generationDebugContext: undefined,
                generationRequest: undefined,
              });
              requestAnimationFrame(() => updateNodeInternals(pendingNode.id));

              // 多图结果拆成多个结果节点，保持每个节点只有一张图，
              // 这样下游引用、下载和后续编辑仍与单图结果完全一致。
              if (resultSources.length > 1) {
                const sourceNodeId = useCanvasStore
                  .getState()
                  .edges.find((edge) => edge.target === pendingNode.id)?.source;
                if (sourceNodeId) {
                  const baseTitle =
                    typeof (currentData as { displayName?: unknown }).displayName === "string"
                      ? String((currentData as { displayName?: unknown }).displayName)
                      : "结果图片";
                  resultSources.slice(1).forEach((source, index) => {
                    const extraNodeId = addNode(
                      CANVAS_NODE_TYPES.exportImage,
                      findNodePosition(sourceNodeId, EXPORT_RESULT_NODE_MIN_WIDTH, EXPORT_RESULT_NODE_MIN_HEIGHT),
                      {
                        imageUrl: source,
                        previewImageUrl: source,
                        aspectRatio: typeof currentData.aspectRatio === "string" ? currentData.aspectRatio : "1:1",
                        generationResultProtected: true,
                        resultKind: "generic",
                        displayName: `${baseTitle} (${index + 2})`,
                      },
                    );
                    addEdge(sourceNodeId, extraNodeId);
                    requestAnimationFrame(() => updateNodeInternals(extraNodeId));
                    void prepareNodeImage(source)
                      .then((prepared) => {
                        const latest = useCanvasStore.getState().nodes.find((node) => node.id === extraNodeId);
                        if (!latest || (latest.data as Record<string, unknown>).imageUrl !== source) return;
                        updateNodeDataTransient(extraNodeId, {
                          imageUrl: prepared.imageUrl,
                          previewImageUrl: prepared.previewImageUrl,
                          aspectRatio: prepared.aspectRatio,
                        });
                        requestAnimationFrame(() => updateNodeInternals(extraNodeId));
                      })
                      .catch((error) => {
                        console.warn("[GenerationJob] extra image persistence failed after result display", {
                          nodeId: extraNodeId,
                          error,
                        });
                      });
                  });
                }
              }

              // The immediate source keeps the canvas responsive. Replace it
              // with the durable local image and preview once preparation has
              // finished; a failure here must never hide the already visible
              // provider result.
              void (async () => {
                try {
                  const prepared = await prepareNodeImage(resultSource);
                  let imageWithMetadata = prepared.imageUrl;
                  if (hasStoryboardMetadata && storyboardMetadataRaw) {
                    imageWithMetadata = await embedStoryboardImageMetadata(prepared.imageUrl, {
                      gridRows: Math.max(1, Math.round(storyboardMetadataRaw.gridRows)),
                      gridCols: Math.max(1, Math.round(storyboardMetadataRaw.gridCols)),
                      frameNotes: storyboardMetadataRaw.frameNotes,
                    });
                  }
                  const previewWithMetadata =
                    prepared.previewImageUrl === prepared.imageUrl ? imageWithMetadata : prepared.previewImageUrl;
                  const latestNode = useCanvasStore.getState().nodes.find((node) => node.id === pendingNode.id);
                  const latestData = latestNode?.data as Record<string, unknown> | undefined;
                  if (latestData?.imageUrl !== resultSource || latestData?.isGenerating === true) {
                    return;
                  }
                  updateNodeDataTransient(pendingNode.id, {
                    imageUrl: imageWithMetadata,
                    previewImageUrl: previewWithMetadata,
                    aspectRatio: prepared.aspectRatio,
                  });
                  requestAnimationFrame(() => updateNodeInternals(pendingNode.id));
                } catch (error) {
                  console.warn("[GenerationJob] image persistence failed after result display", {
                    nodeId: pendingNode.id,
                    error,
                  });
                }
              })();
              break;
            }

            const errorMessage =
              status.error ?? (status.status === "not_found" ? "generation job not found" : "generation failed");
            recordGenerationOutcome({
              nodeId: pendingNode.id,
              kind: "image",
              providerId: generationProviderId,
              modelId: requestModel,
              size: typeof generationRequest?.size === "string" ? generationRequest.size : "1K",
              referenceCount: Array.isArray(generationRequest?.referenceImages)
                ? generationRequest.referenceImages.length
                : 0,
              status: "failed",
              errorMessage,
            });
            const generationClientSessionId =
              typeof currentData.generationClientSessionId === "string" ? currentData.generationClientSessionId : "";
            const shouldShowDialog = generationClientSessionId === CURRENT_RUNTIME_SESSION_ID;
            if (shouldShowDialog) {
              const reportText = buildGenerationErrorReport({
                errorMessage,
                errorDetails: status.error ?? undefined,
                context: currentData.generationDebugContext,
              });
              void showErrorDialog(errorMessage, t("common.error"), status.error ?? undefined, reportText);
            }
            updateNodeDataTransient(pendingNode.id, {
              isGenerating: false,
              generationStartedAt: null,
              generationJobId: null,
              generationProviderId: null,
              generationClientSessionId: null,
              generationStoryboardMetadata: undefined,
              generationError: errorMessage,
              generationErrorDetails: status.error ?? null,
            });
            break;
          }
        } finally {
          activeGenerationPollNodeIdsRef.current.delete(pendingNode.id);
          if (acquiredSlot) recoveryPollerCountRef.current = Math.max(0, recoveryPollerCountRef.current - 1);
        }
      })();
    }
  }, [
    addEdge,
    addNode,
    apiKeys,
    findNodePosition,
    processingRevision,
    updateNodeData,
    updateNodeDataTransient,
    updateNodeInternals,
  ]);

  // Video generation currently uses provider-specific HTTP flows without a
  // shared task-status command. A restart leaves the request available for
  // an explicit user-triggered retry from the result node toolbar.
  useEffect(() => {
    const pendingVideoNodes = useCanvasStore.getState().nodes.filter((node) => {
      if (node.type !== CANVAS_NODE_TYPES.audio) return false;
      const data = node.data as Record<string, unknown>;
      const request = data.generationRequest;
      // 新版视频已拥有后端任务 ID，由下面的统一状态轮询负责；这里只处理
      // 旧项目中没有任务 ID 的显式重试，避免重复提交、重复扣费。
      if (typeof data.generationJobId === "string" && data.generationJobId.length > 0) return false;
      const isExplicitRetry = data.generationRetryRequested === true;
      // 本次运行会话已提交的任务跳过自动恢复: 正常点击生成时节点刚创建,
      // 若不排除会与节点自身的提交重复(同一任务提交两次、重复扣费)。
      if (data.generationClientSessionId === CURRENT_RUNTIME_SESSION_ID && !isExplicitRetry) return false;
      return (
        data.isGenerating === true &&
        request &&
        typeof request === "object" &&
        (request as { kind?: unknown }).kind === "video"
      );
    });

    for (const pendingNode of pendingVideoNodes) {
      if (activeVideoRecoveryNodeIdsRef.current.has(pendingNode.id)) continue;
      activeVideoRecoveryNodeIdsRef.current.add(pendingNode.id);
      void (async () => {
        const startedAt = Date.now();
        let acquiredSlot = false;
        // 在 try 外解析恢复请求快照: catch 分支记账时也要用到(避免 try 作用域丢失)
        const recoveryNode = useCanvasStore.getState().nodes.find((node) => node.id === pendingNode.id);
        const recoveryData = recoveryNode?.data as Record<string, unknown> | undefined;
        const recoveryRequest = recoveryData?.generationRequest as
          | {
              kind?: unknown;
              clientJobId?: unknown;
              prompt?: unknown;
              model?: unknown;
              duration?: unknown;
              aspectRatio?: unknown;
              videoResolution?: unknown;
              imageMode?: unknown;
              referenceImages?: unknown;
              referenceAudio?: unknown;
              extraParams?: unknown;
            }
          | undefined;
        if (!recoveryRequest || recoveryRequest.kind !== "video") {
          activeVideoRecoveryNodeIdsRef.current.delete(pendingNode.id);
          return;
        }
        const recoveryModel = typeof recoveryRequest.model === "string" ? recoveryRequest.model : "";
        const recoveryProviderId =
          typeof recoveryData?.generationProviderId === "string"
            ? recoveryData.generationProviderId
            : (recoveryModel.split("/")[0] ?? "");
        const isExplicitRetry = recoveryData?.generationRetryRequested === true;
        if (!isExplicitRetry) {
          const interruptedMessage =
            "生成任务在应用重启时被中断。由于未保存可查询的任务 ID，未自动重新提交，请点击“重试生成”确认提交。";
          updateNodeDataTransient(pendingNode.id, {
            isGenerating: false,
            generationStartedAt: null,
            generationError: interruptedMessage,
            generationErrorDetails: interruptedMessage,
          });
          activeVideoRecoveryNodeIdsRef.current.delete(pendingNode.id);
          return;
        }
        updateNodeDataTransient(pendingNode.id, {
          generationRetryRequested: false,
          generationClientSessionId: CURRENT_RUNTIME_SESSION_ID,
        });
        try {
          while (recoveryMountedRef.current && recoveryPollerCountRef.current >= MAX_RECOVERY_POLLERS) {
            await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
          }
          if (!recoveryMountedRef.current) return;
          recoveryPollerCountRef.current += 1;
          acquiredSlot = true;
          if (!recoveryMountedRef.current || Date.now() - startedAt >= MAX_RECOVERY_DURATION_MS) return;
          const currentNode = useCanvasStore.getState().nodes.find((node) => node.id === pendingNode.id);
          const currentData = currentNode?.data as Record<string, unknown> | undefined;
          const request = currentData?.generationRequest as
            | {
                kind?: unknown;
                clientJobId?: unknown;
                prompt?: unknown;
                model?: unknown;
                duration?: unknown;
                aspectRatio?: unknown;
                videoResolution?: unknown;
                imageMode?: unknown;
                referenceImages?: unknown;
                referenceAudio?: unknown;
                extraParams?: unknown;
              }
            | undefined;
          if (!request || request.kind !== "video") return;

          const model = typeof request.model === "string" ? request.model : "";
          const providerId =
            typeof currentData?.generationProviderId === "string"
              ? currentData.generationProviderId
              : (model.split("/")[0] ?? "");
          if (providerId && !model.startsWith("jimeng-cli/") && !model.startsWith("wan-cli/")) {
            const providerApiKey = apiKeys[providerId] ?? "";
            if (providerApiKey) await canvasAiGateway.setApiKey(providerId, providerApiKey);
          }

          const videoUrl = await canvasAiGateway.generateVideo({
            clientJobId: typeof request.clientJobId === "string" ? request.clientJobId : undefined,
            prompt: typeof request.prompt === "string" ? request.prompt : "",
            model,
            duration: typeof request.duration === "number" ? request.duration : 5,
            aspectRatio: typeof request.aspectRatio === "string" ? request.aspectRatio : "16:9",
            videoResolution: typeof request.videoResolution === "string" ? request.videoResolution : undefined,
            imageMode: request.imageMode === "first-last" ? "first-last" : "reference",
            referenceImages: Array.isArray(request.referenceImages)
              ? request.referenceImages.filter((value): value is string => typeof value === "string")
              : [],
            referenceAudio: Array.isArray(request.referenceAudio)
              ? request.referenceAudio.filter((value): value is string => typeof value === "string")
              : [],
            extraParams:
              request.extraParams && typeof request.extraParams === "object"
                ? (request.extraParams as Record<string, unknown>)
                : undefined,
          });
          recordGenerationOutcome({
            nodeId: pendingNode.id,
            kind: "video",
            providerId,
            modelId: model,
            size: typeof request.videoResolution === "string" ? request.videoResolution : undefined,
            duration: typeof request.duration === "number" ? request.duration : 0,
            referenceCount: Array.isArray(request.referenceImages) ? request.referenceImages.length : 0,
            status: "succeeded",
          });
          updateNodeDataTransient(pendingNode.id, {
            sourcePath: videoUrl,
            generationResultProtected: true,
            isGenerating: false,
            generationStartedAt: null,
            generationError: null,
            generationErrorDetails: null,
            generationRequest: undefined,
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          recordGenerationOutcome({
            nodeId: pendingNode.id,
            kind: "video",
            providerId: recoveryProviderId,
            modelId: recoveryModel,
            size: typeof recoveryRequest.videoResolution === "string" ? recoveryRequest.videoResolution : undefined,
            duration: typeof recoveryRequest.duration === "number" ? recoveryRequest.duration : 0,
            referenceCount: Array.isArray(recoveryRequest.referenceImages) ? recoveryRequest.referenceImages.length : 0,
            status: "failed",
            errorMessage,
          });
          updateNodeDataTransient(pendingNode.id, {
            isGenerating: false,
            generationStartedAt: null,
            generationError: errorMessage,
            generationErrorDetails: errorMessage,
          });
        } finally {
          activeVideoRecoveryNodeIdsRef.current.delete(pendingNode.id);
          if (acquiredSlot) recoveryPollerCountRef.current = Math.max(0, recoveryPollerCountRef.current - 1);
        }
      })();
    }
  }, [apiKeys, processingRevision, updateNodeDataTransient]);

  // 视频与图片一样：节点只保存后端任务 ID，画布负责轮询并将最终媒体回写。
  useEffect(() => {
    const sleep = (delayMs: number) => new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));
    const pendingVideoNodes = useCanvasStore.getState().nodes.filter((node) => {
      if (node.type !== CANVAS_NODE_TYPES.audio) return false;
      const data = node.data as Record<string, unknown>;
      return data.isGenerating === true && typeof data.generationJobId === "string" && data.generationJobId.length > 0;
    });
    for (const pendingNode of pendingVideoNodes) {
      if (activeVideoRecoveryNodeIdsRef.current.has(pendingNode.id)) continue;
      activeVideoRecoveryNodeIdsRef.current.add(pendingNode.id);
      void (async () => {
        try {
          // 视频任务状态已由后端落库, 但画布仍需要足够宽的观察窗: 知鸟官方口径
          // p90 为 55~75 分钟, 原来的 900×2s=30 分钟会把长任务误判成"没结果"。
          //
          // 视频任务现在是可以跨重启续查的(后端已落平台 task_id), 而 provider 的
          // 密钥在后端是内存态: 应用重启后若不先推送一次, 续查会因为缺 key 而查不动,
          // 平台任务照跑照计费、结果却收不回。密钥可能晚于任务就绪, 所以放在循环内
          // 重试, 拿到即止, 不会每轮都发 IPC。
          let providerKeyPushed = false;
          for (let attempts = 0; recoveryMountedRef.current; attempts += 1) {
            const node = useCanvasStore.getState().nodes.find((item) => item.id === pendingNode.id);
            const data = node?.data as Record<string, unknown> | undefined;
            const jobId = typeof data?.generationJobId === "string" ? data.generationJobId : "";
            if (!node || !jobId || data?.isGenerating !== true) return;
            if (!providerKeyPushed) {
              const providerIdForPoll = typeof data?.generationProviderId === "string" ? data.generationProviderId : "";
              const providerApiKey = providerIdForPoll
                ? (useSettingsStore.getState().apiKeys[providerIdForPoll] ?? "")
                : "";
              if (providerApiKey) {
                await canvasAiGateway.setApiKey(providerIdForPoll, providerApiKey).catch((error) => {
                  console.warn("[VideoGenerationJob] set_api_key failed before poll", {
                    nodeId: pendingNode.id,
                    providerIdForPoll,
                    error,
                  });
                });
                providerKeyPushed = true;
              }
            }
            const status = await canvasAiGateway.getGenerateVideoJob(jobId).catch((error) => {
              // 临时 IPC/网络异常不能当作平台终态失败，否则已扣费的任务会被错误清掉 job id。
              console.warn("[VideoGenerationJob] poll failed; retaining resumable task", {
                nodeId: pendingNode.id,
                jobId,
                error,
              });
              return null;
            });
            if (!status) {
              await sleep(2_000);
              continue;
            }
            if (status.status === "running" || status.status === "queued") {
              // 后端已把「任务仍在跑, 这次查询只是临时失败(网络抖动 / 5xx)」显式标成
              // transient —— 此时 `error` 里是**诊断文本**, 不是终态依据, 只能继续等。
              // 2026-09-23: 旧代码对文本做 `includes("失败")` 匹配, 被诊断文本
              // `binghuo-video 查询失败(网络): ...` 命中, 一次网络抖动就把已计费、
              // 已在平台跑到 14 分钟的长任务判死并清掉 job id。判据见 videoJobPolling.ts。
              const statusError = typeof status.error === "string" ? status.error : "";
              const looksLikeFailure = shouldFailRunningVideoJob(status);
              if (looksLikeFailure) {
                const message = statusError || "视频生成失败";
                recordGenerationOutcome({
                  nodeId: pendingNode.id,
                  kind: "video",
                  providerId: typeof data.generationProviderId === "string" ? data.generationProviderId : "",
                  modelId:
                    typeof (data.generationRequest as { model?: unknown } | undefined)?.model === "string"
                      ? (data.generationRequest as { model: string }).model
                      : "",
                  status: "failed",
                  errorMessage: message,
                });
                updateNodeDataTransient(pendingNode.id, {
                  isGenerating: false,
                  generationStartedAt: null,
                  generationJobId: null,
                  generationClientSessionId: null,
                  generationError: message,
                  generationErrorDetails: message,
                });
                return;
              }
              await sleep(2000);
              continue;
            }
            if (status.status === "succeeded" && status.result) {
              const request = data.generationRequest as
                | { model?: unknown; videoResolution?: unknown; duration?: unknown; referenceImages?: unknown }
                | undefined;
              recordGenerationOutcome({
                nodeId: pendingNode.id,
                kind: "video",
                providerId: typeof data.generationProviderId === "string" ? data.generationProviderId : "",
                modelId: typeof request?.model === "string" ? request.model : "",
                size: typeof request?.videoResolution === "string" ? request.videoResolution : undefined,
                duration: typeof request?.duration === "number" ? request.duration : 0,
                referenceCount: Array.isArray(request?.referenceImages) ? request.referenceImages.length : 0,
                status: "succeeded",
              });
              updateNodeDataTransient(pendingNode.id, {
                sourcePath: status.result,
                generationResultProtected: true,
                isGenerating: false,
                generationStartedAt: null,
                generationJobId: null,
                generationClientSessionId: null,
                generationError: null,
                generationErrorDetails: null,
              });
              return;
            }
            const message = status.error ?? "视频生成失败";
            recordGenerationOutcome({
              nodeId: pendingNode.id,
              kind: "video",
              providerId: typeof data.generationProviderId === "string" ? data.generationProviderId : "",
              modelId:
                typeof (data.generationRequest as { model?: unknown } | undefined)?.model === "string"
                  ? (data.generationRequest as { model: string }).model
                  : "",
              status: "failed",
              errorMessage: message,
            });
            updateNodeDataTransient(pendingNode.id, {
              isGenerating: false,
              generationStartedAt: null,
              generationJobId: null,
              generationClientSessionId: null,
              generationError: message,
              generationErrorDetails: message,
            });
            return;
          }
        } catch (error) {
          // 非预期观察器异常同样保留 job id：下次 processingRevision 触发时可续查，
          // 不应把“观察失败”误判为“平台任务失败”。
          console.warn("[VideoGenerationJob] observer stopped; retaining resumable task", {
            nodeId: pendingNode.id,
            error,
          });
        } finally {
          activeVideoRecoveryNodeIdsRef.current.delete(pendingNode.id);
        }
      })();
    }
  }, [processingRevision, updateNodeDataTransient]);

  useEffect(() => {
    const element = wrapperRef.current;
    if (!element) {
      return;
    }

    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      invalidateNearbyConnectionHandleCache();
      setCanvasViewportSize({
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
      });
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [invalidateNearbyConnectionHandleCache, setCanvasViewportSize]);

  const handleNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      if (
        changes.some(
          (change) =>
            change.type === "position" ||
            change.type === "dimensions" ||
            change.type === "add" ||
            change.type === "remove" ||
            change.type === "replace",
        )
      ) {
        invalidateNearbyConnectionHandleCache();
      }

      const alignedChanges = changes.map((change) => {
        if (change.type !== "position" || change.dragging !== false) {
          return change;
        }
        const alignedPosition = activeDragAlignmentRef.current.get(change.id);
        return alignedPosition ? { ...change, position: alignedPosition } : change;
      });

      applyNodesChange(alignedChanges);
      for (const change of alignedChanges) {
        if (change.type === "position" && change.dragging === false) {
          activeDragAlignmentRef.current.delete(change.id);
        }
      }

      const hasDragMove = changes.some(
        (change) => change.type === "position" && "dragging" in change && Boolean(change.dragging),
      );
      const hasDragEnd = changes.some(
        (change) => change.type === "position" && "dragging" in change && change.dragging === false,
      );
      const hasResizeMove = changes.some(
        (change) => change.type === "dimensions" && "resizing" in change && Boolean(change.resizing),
      );
      const hasResizeEnd = changes.some(
        (change) => change.type === "dimensions" && "resizing" in change && change.resizing === false,
      );
      const hasInteractionMove = hasDragMove || hasResizeMove;
      const hasInteractionEnd = hasDragEnd || hasResizeEnd;

      if (hasInteractionMove) {
        return;
      }

      if (hasInteractionEnd) {
        scheduleCanvasPersist(0);
        return;
      }

      scheduleCanvasPersist();
    },
    [applyNodesChange, invalidateNearbyConnectionHandleCache, scheduleCanvasPersist],
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange<CanvasEdge>[]) => {
      applyEdgesChange(changes);
      scheduleCanvasPersist();
    },
    [applyEdgesChange, scheduleCanvasPersist],
  );

  const handleEdgeDoubleClick = useCallback(
    (event: ReactMouseEvent, edge: CanvasEdge) => {
      event.preventDefault();
      event.stopPropagation();
      deleteEdge(edge.id);
      scheduleCanvasPersist(0);
    },
    [deleteEdge, scheduleCanvasPersist],
  );

  const handleEdgeClick = useCallback((event: ReactMouseEvent) => {
    if (!suppressNextEdgeClickRef.current) {
      return;
    }
    suppressNextEdgeClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!canNodeBeManualConnectionSource(connection.source, nodes)) {
        return;
      }
      connectNodes(connection);
      scheduleCanvasPersist(0);
    },
    [connectNodes, nodes, scheduleCanvasPersist],
  );

  const handleMoveEnd = useCallback(
    (_event: unknown, viewport: Viewport) => {
      invalidateNearbyConnectionHandleCache();
      setViewportState(viewport);
      const project = getCurrentProject();
      if (!project || isRestoringCanvasRef.current) {
        return;
      }
      saveCurrentProjectViewport(viewport);
    },
    [getCurrentProject, invalidateNearbyConnectionHandleCache, saveCurrentProjectViewport, setViewportState],
  );

  const handleMove = useCallback(
    (_event: unknown, viewport: Viewport) => {
      invalidateNearbyConnectionHandleCache();
      setViewportState(viewport);
    },
    [invalidateNearbyConnectionHandleCache, setViewportState],
  );

  const handleMoveStart = useCallback(
    (event: unknown) => {
      cancelPendingViewportPersist();
      // 用户主动平移/缩放画布时收起素材库/模板栏; 程序化 setViewport 的 event 为 null, 不误伤
      if (event) {
        setIsLibraryOpen(false);
        setIsTemplateOpen(false);
      }
    },
    [cancelPendingViewportPersist],
  );

  useEffect(() => {
    const wrapperElement = wrapperRef.current;
    if (!wrapperElement) {
      return;
    }

    const edgePathSelector = ".react-flow__edge-path, .react-flow__edge-interaction";
    const dragThreshold = 4;

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (!target) {
        return;
      }

      if (target.closest(".react-flow__edgeupdater")) {
        return;
      }

      const edgePathElement = target.closest(edgePathSelector);
      if (!edgePathElement) {
        return;
      }

      const viewport = reactFlowInstance.getViewport();
      edgePanGestureRef.current = {
        active: true,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startViewportX: viewport.x,
        startViewportY: viewport.y,
        zoom: viewport.zoom,
        moved: false,
      };
      cancelPendingViewportPersist();
    };

    const handlePointerMove = (event: PointerEvent) => {
      const gesture = edgePanGestureRef.current;
      if (!gesture || !gesture.active || event.pointerId !== gesture.pointerId) {
        return;
      }

      const deltaX = event.clientX - gesture.startClientX;
      const deltaY = event.clientY - gesture.startClientY;

      if (!gesture.moved && Math.hypot(deltaX, deltaY) >= dragThreshold) {
        gesture.moved = true;
      }
      if (!gesture.moved) {
        return;
      }

      suppressNextEdgeClickRef.current = true;
      reactFlowInstance.setViewport(
        {
          x: gesture.startViewportX + deltaX,
          y: gesture.startViewportY + deltaY,
          zoom: gesture.zoom,
        },
        { duration: 0 },
      );
    };

    const completeEdgePanGesture = () => {
      const gesture = edgePanGestureRef.current;
      if (!gesture) {
        return;
      }

      edgePanGestureRef.current = null;
      if (!gesture.moved) {
        return;
      }

      const viewport = reactFlowInstance.getViewport();
      setViewportState(viewport);
      const project = getCurrentProject();
      if (!project || isRestoringCanvasRef.current) {
        return;
      }
      saveCurrentProjectViewport(viewport);
    };

    const handlePointerUp = (event: PointerEvent) => {
      const gesture = edgePanGestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return;
      }
      completeEdgePanGesture();
    };

    const handlePointerCancel = (event: PointerEvent) => {
      const gesture = edgePanGestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return;
      }
      completeEdgePanGesture();
    };

    wrapperElement.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("pointermove", handlePointerMove, true);
    window.addEventListener("pointerup", handlePointerUp, true);
    window.addEventListener("pointercancel", handlePointerCancel, true);

    return () => {
      wrapperElement.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("pointermove", handlePointerMove, true);
      window.removeEventListener("pointerup", handlePointerUp, true);
      window.removeEventListener("pointercancel", handlePointerCancel, true);
    };
  }, [
    cancelPendingViewportPersist,
    getCurrentProject,
    reactFlowInstance,
    saveCurrentProjectViewport,
    setViewportState,
  ]);

  const selectedNodeIds = useMemo(() => nodes.filter((node) => Boolean(node.selected)).map((node) => node.id), [nodes]);
  const selectedUploadNodeId = useMemo(() => {
    if (selectedNodeIds.length !== 1) {
      return null;
    }
    const selectedNode = nodes.find((node) => node.id === selectedNodeIds[0]);
    if (!selectedNode || selectedNode.type !== CANVAS_NODE_TYPES.upload) {
      return null;
    }
    return selectedNode.id;
  }, [nodes, selectedNodeIds]);

  const handleGroupSelected = useCallback(() => {
    if (selectedNodeIds.length < 2) {
      return;
    }
    setGroupNameDialog({ nodeIds: selectedNodeIds, name: "", mode: "create" });
  }, [selectedNodeIds]);

  useEffect(() => {
    return canvasEventBus.subscribe("group-node/rename", ({ nodeId }) => {
      const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId);
      if (!node || node.type !== CANVAS_NODE_TYPES.group) {
        return;
      }
      const data = node.data as { displayName?: unknown; label?: unknown };
      const name =
        typeof data.displayName === "string" && data.displayName.trim()
          ? data.displayName
          : typeof data.label === "string"
            ? data.label
            : "";
      setGroupNameDialog({ nodeIds: [], nodeId, name, mode: "rename" });
    });
  }, []);

  const confirmGroupCreation = useCallback(() => {
    if (!groupNameDialog?.name.trim()) {
      return;
    }
    if (groupNameDialog.mode === "rename" && groupNameDialog.nodeId) {
      updateNodeData(groupNameDialog.nodeId, {
        displayName: groupNameDialog.name.trim(),
        label: groupNameDialog.name.trim(),
      });
    } else {
      const createdGroupId = groupNodes(groupNameDialog.nodeIds, groupNameDialog.name.trim());
      if (createdGroupId) {
        scheduleCanvasPersist(0);
      }
    }
    setGroupNameDialog(null);
  }, [groupNameDialog, groupNodes, scheduleCanvasPersist]);

  const handleAlign = useCallback(
    (mode: NodeAlignMode) => {
      if (selectedNodeIds.length < 2) {
        return;
      }
      const changed = alignNodes(selectedNodeIds, mode);
      if (changed) {
        scheduleCanvasPersist(0);
      }
    },
    [alignNodes, scheduleCanvasPersist, selectedNodeIds],
  );

  // 框选节点，两个手势并存：
  //   1) 右键按住拖拽（主手势）—— 右键已从 panOnDrag 里摘掉，不再平移画布；
  //   2) 左键双击第二下按住拖拽（旧手势，左键单击拖拽仍留给平移）。
  // 判定「没拖动」时放行给原有逻辑：左键那次交给双击打开节点菜单，
  // 右键那次交给 contextmenu（或手动补弹，见下）。
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) {
      return;
    }
    let lastDownAt = 0;
    let lastDownPos = { x: 0, y: 0 };
    let selecting = false;
    /** 本次框选由哪个键触发：2=右键（按下即进入），0=左键（双击第二下）。 */
    let selectButton = -1;
    let startScreen = { x: 0, y: 0 };
    /** 是否已越过拖动阈值——没越过就还只是一次普通点击。 */
    let moved = false;
    /**
     * 右键按下期间 contextmenu 已被压住（macOS 会在按下瞬间派发）。
     * 记下来，等 pointerup 判定「确实没拖动」再手动补弹一次菜单。
     */
    let rightMenuSuppressed = false;

    const isBlankPaneTarget = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el || !(el instanceof HTMLElement) || !el.closest(".react-flow__pane")) {
        return false;
      }
      // 节点/边/控件/交互元素上不触发框选
      if (
        el.closest(
          ".react-flow__node, .react-flow__edge, .react-flow__minimap, .react-flow__controls, .react-flow__panel, .nokey, button, input, select, textarea, a",
        )
      ) {
        return false;
      }
      return true;
    };

    const beginSelection = (pos: { x: number; y: number }, button: number) => {
      selecting = true;
      selectButton = button;
      moved = false;
      startScreen = pos;
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (!isBlankPaneTarget(event.target)) {
        return;
      }

      // 右键按住 = 框选。这里**不能** preventDefault：还没拖动的右键必须让
      // 右键菜单照常弹出（该不该弹由 pointerup 判定）。
      if (event.button === 2) {
        beginSelection({ x: event.clientX, y: event.clientY }, 2);
        return;
      }

      if (event.button !== 0) {
        return;
      }

      const now = performance.now();
      const pos = { x: event.clientX, y: event.clientY };
      const isDoubleClick = now - lastDownAt < 320 && Math.hypot(pos.x - lastDownPos.x, pos.y - lastDownPos.y) < 10;
      lastDownAt = now;
      lastDownPos = pos;
      if (!isDoubleClick) {
        return;
      }
      // 双击第二下按住: 进入框选, 捕获阶段拦截阻止 React Flow 的 pan(pointerdown) 与 d3-drag 平移(mousedown)
      beginSelection(pos, 0);
      event.stopPropagation();
      event.preventDefault();
    };

    // React Flow 的 pan 由 d3-drag 绑定在 pane 的 mousedown 驱动, 必须额外拦截 mousedown。
    // 右键已经不在 panOnDrag 里了, d3-drag 不会再响应它, 所以只拦左键双击那一次。
    const handleMouseDown = (event: MouseEvent) => {
      if (selecting && selectButton === 0 && event.button === 0) {
        event.stopPropagation();
        event.preventDefault();
      }
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (!selecting) {
        return;
      }
      const distance = Math.hypot(event.clientX - startScreen.x, event.clientY - startScreen.y);
      // 未越过阈值：可能只是「点一下弹菜单」，先不画框也不吞事件
      if (!moved && distance < 4) {
        return;
      }
      moved = true;
      const wrapperRect = wrapper.getBoundingClientRect();
      setDragSelectRect({
        left: Math.min(startScreen.x, event.clientX) - wrapperRect.left,
        top: Math.min(startScreen.y, event.clientY) - wrapperRect.top,
        width: Math.abs(event.clientX - startScreen.x),
        height: Math.abs(event.clientY - startScreen.y),
      });
      event.stopPropagation();
      event.preventDefault();
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (!selecting) {
        return;
      }
      const button = selectButton;
      const didMove = moved;
      selecting = false;
      selectButton = -1;
      moved = false;

      const endScreen = { x: event.clientX, y: event.clientY };
      const width = Math.abs(endScreen.x - startScreen.x);
      const height = Math.abs(endScreen.y - startScreen.y);
      setDragSelectRect(null);

      // 几乎没拖动 → 视为普通点击(不框选)，放行后续逻辑打开菜单
      if (!didMove || (width < 5 && height < 5)) {
        if (button === 2 && rightMenuSuppressed) {
          // macOS 路径：菜单在按下时被压住了，这里补弹一次，
          // 否则「右键点空白 = 弹菜单」这个既有行为就丢了。
          rightMenuSuppressed = false;
          const synthetic = {
            clientX: startScreen.x,
            clientY: startScreen.y,
            preventDefault: () => {},
            stopPropagation: () => {},
          } as unknown as MouseEvent;
          canvasContextMenuRef.current?.(synthetic);
        }
        return;
      }

      const rect = {
        x: Math.min(startScreen.x, endScreen.x),
        y: Math.min(startScreen.y, endScreen.y),
        right: Math.max(startScreen.x, endScreen.x),
        bottom: Math.max(startScreen.y, endScreen.y),
      };
      const topLeft = reactFlowInstance.screenToFlowPosition({ x: rect.x, y: rect.y });
      const bottomRight = reactFlowInstance.screenToFlowPosition({ x: rect.right, y: rect.bottom });
      // 子节点 position 是相对父节点的局部坐标, 需换算为全局绝对坐标再做相交检测;
      // group 节点不参与框选(其包围盒覆盖全部子节点, 碰到即连带整组选中造成误选)
      const nodeMap = new Map(nodes.map((node) => [node.id, node]));
      const selectedByNode = new Map(
        nodes.map((node) => {
          if (node.type === CANVAS_NODE_TYPES.group) {
            return [node.id, false] as const;
          }
          const nodeWidth = node.measured?.width ?? node.width ?? 220;
          const nodeHeight = node.measured?.height ?? node.height ?? 200;
          const absolute = resolveCanvasNodeAbsolutePosition(node.id, nodeMap);
          const nx = absolute.x;
          const ny = absolute.y;
          const selected =
            nx < bottomRight.x && nx + nodeWidth > topLeft.x && ny < bottomRight.y && ny + nodeHeight > topLeft.y;
          return [node.id, selected] as const;
        }),
      );
      // setNodes 是 React Flow 受控模式下设置 selected 的官方方式;
      // 注意必须始终返回新对象(React Flow 以引用比较检测差异)
      reactFlowInstance.setNodes((nds) =>
        nds.map((node) => ({ ...node, selected: selectedByNode.get(node.id) ?? false })),
      );
      if (button === 0) {
        // 框选成功: 在时间窗口内拦截松开后的 click/dblclick,
        // 阻止 React Flow 的 Pane.onClick 调用 resetSelectedElements 取消框选结果。
        // 右键不产生 click, 这里不设窗口 —— 否则会把用户紧接着的一次左键点击一起吞掉。
        suppressClickUntilRef.current = performance.now() + 600;
      } else {
        // 右键框选结束后紧跟的 contextmenu 要吞掉（Windows 在 mouseup 之后派发）
        suppressContextMenuUntilRef.current = performance.now() + 600;
        rightMenuSuppressed = false;
      }
      event.stopPropagation();
      event.preventDefault();
    };

    // React Flow Pane 的 onClick 会调用 resetSelectedElements() 取消所有选中。
    // 框选(双击第二下拖拽)成功后, 在时间窗口内拦截 click/dblclick, 阻止 React 事件委托触发该逻辑。
    const handleClickCapture = (event: MouseEvent) => {
      if (performance.now() < suppressClickUntilRef.current) {
        suppressClickUntilRef.current = 0;
        event.stopPropagation();
        event.preventDefault();
      }
    };

    // 右键框选进行中 / 刚结束时的 contextmenu 一律压住：
    //  - 进行中(macOS 在按下瞬间派发)：先记下来，pointerup 判定没拖动再补弹；
    //  - 刚结束(Windows 在 mouseup 之后派发)：时间窗内直接吞掉。
    const handleContextMenuCapture = (event: MouseEvent) => {
      if (selecting && selectButton === 2) {
        rightMenuSuppressed = true;
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (performance.now() < suppressContextMenuUntilRef.current) {
        suppressContextMenuUntilRef.current = 0;
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };

    // document 捕获阶段拦截: 早于 React(root 委托) 与 d3-drag(pane bubble), 才能阻止平移
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("mousedown", handleMouseDown, true);
    window.addEventListener("pointermove", handlePointerMove, true);
    window.addEventListener("pointerup", handlePointerUp, true);
    document.addEventListener("click", handleClickCapture, true);
    document.addEventListener("dblclick", handleClickCapture, true);
    document.addEventListener("contextmenu", handleContextMenuCapture, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("mousedown", handleMouseDown, true);
      window.removeEventListener("pointermove", handlePointerMove, true);
      window.removeEventListener("pointerup", handlePointerUp, true);
      document.removeEventListener("click", handleClickCapture, true);
      document.removeEventListener("dblclick", handleClickCapture, true);
      document.removeEventListener("contextmenu", handleContextMenuCapture, true);
    };
  }, [nodes, reactFlowInstance]);

  useEffect(() => {
    if (!isAlignMenuOpen) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (!alignMenuRef.current?.contains(event.target as Node)) {
        setIsAlignMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [isAlignMenuOpen]);

  useEffect(() => {
    if (selectedNodeIds.length === 1) {
      if (selectedNodeId !== selectedNodeIds[0]) {
        setSelectedNode(selectedNodeIds[0]);
      }
      return;
    }

    if (selectedNodeId !== null) {
      setSelectedNode(null);
    }
  }, [selectedNodeId, selectedNodeIds, setSelectedNode]);

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      pasteImageHandledRef.current = false;
      if (!selectedUploadNodeId || isTypingTarget(event.target)) {
        return;
      }

      const imageFile = resolveClipboardImageFile(event);
      if (!imageFile) {
        return;
      }

      event.preventDefault();
      pasteImageHandledRef.current = true;
      canvasEventBus.publish("upload-node/paste-image", {
        nodeId: selectedUploadNodeId,
        file: imageFile,
      });
    };

    document.addEventListener("paste", handlePaste);
    return () => {
      document.removeEventListener("paste", handlePaste);
    };
  }, [selectedUploadNodeId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // 导演台通过 portal 覆盖画布时，内部快捷键不能再作用于被选中的画布节点。
      if (isTypingTarget(event.target) || isDirectorDeskOpen()) {
        return;
      }

      const shortcuts = useKeyboardShortcutStore.getState().bindings;
      const isUndo = matchesBinding(event, shortcuts.undo);
      const isRedo = matchesBinding(event, shortcuts.redo);
      const isGroup = matchesBinding(event, shortcuts.group);
      const isCopy = matchesBinding(event, shortcuts.copy);
      const isPaste = matchesBinding(event, shortcuts.paste);
      const isDelete = matchesBinding(event, shortcuts.delete);

      if (isCopy) {
        if (selectedNodeIds.length === 0) {
          return;
        }
        event.preventDefault();
        const selectedIdSet = new Set(selectedNodeIds);
        copiedSnapshotRef.current = {
          nodes: nodes.filter((node) => selectedIdSet.has(node.id)),
          edges: edges.filter((edge) => selectedIdSet.has(edge.source) && selectedIdSet.has(edge.target)),
        };
        return;
      }

      if (isPaste) {
        if (selectedUploadNodeId) {
          pasteImageHandledRef.current = false;
          window.setTimeout(() => {
            if (pasteImageHandledRef.current) {
              pasteImageHandledRef.current = false;
              return;
            }

            if (!copiedSnapshotRef.current || copiedSnapshotRef.current.nodes.length === 0) {
              return;
            }

            void duplicateNodesRef.current?.(copiedSnapshotRef.current.nodes.map((node) => node.id));
          }, 0);
          return;
        }

        if (!copiedSnapshotRef.current || copiedSnapshotRef.current.nodes.length === 0) {
          return;
        }
        event.preventDefault();
        void duplicateNodesRef.current?.(copiedSnapshotRef.current.nodes.map((node) => node.id));
        return;
      }

      if (isUndo || isRedo) {
        event.preventDefault();
        const changed = isUndo ? undo() : redo();
        if (changed) {
          scheduleCanvasPersist(0);
        }
        return;
      }

      if (isGroup) {
        if (selectedNodeIds.length < 2) {
          return;
        }
        event.preventDefault();
        handleGroupSelected();
        return;
      }

      if (!isDelete) {
        return;
      }

      const idsToDelete = selectedNodeIds.length > 0 ? selectedNodeIds : selectedNodeId ? [selectedNodeId] : [];
      if (idsToDelete.length === 0) {
        return;
      }

      event.preventDefault();
      if (idsToDelete.length === 1) {
        deleteNode(idsToDelete[0]);
      } else {
        deleteNodes(idsToDelete);
      }
      scheduleCanvasPersist(0);
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    edges,
    nodes,
    selectedNodeId,
    selectedNodeIds,
    deleteNode,
    deleteNodes,
    groupNodes,
    handleGroupSelected,
    undo,
    redo,
    scheduleCanvasPersist,
    selectedUploadNodeId,
  ]);

  const openNodeMenuAtClientPosition = useCallback(
    (clientX: number, clientY: number) => {
      const containerRect = wrapperRef.current?.getBoundingClientRect();
      if (!containerRect) {
        return;
      }

      const flowPos = reactFlowInstance.screenToFlowPosition({
        x: clientX,
        y: clientY,
      });

      setFlowPosition(flowPos);
      setMenuPosition({
        x: clientX - containerRect.left,
        y: clientY - containerRect.top,
      });
      setMenuAllowedTypes(undefined);
      setPendingConnectStart(null);
      setPreviewConnectionVisual(null);
      setShowNodeMenu(true);
    },
    [reactFlowInstance],
  );

  const handlePaneClick = useCallback(
    (event: ReactMouseEvent) => {
      // 点击画布区域自动收起素材库/模板侧边栏(面板内部点击不会走到 pane, 不误伤)
      setIsLibraryOpen(false);
      setIsTemplateOpen(false);
      setIsAgentOpen(false);

      if (suppressNextPaneClickRef.current) {
        suppressNextPaneClickRef.current = false;
        return;
      }

      if (event.detail >= 2) {
        openNodeMenuAtClientPosition(event.clientX, event.clientY);
        return;
      }

      setSelectedNode(null);
      setShowNodeMenu(false);
      setMenuAllowedTypes(undefined);
      setPendingConnectStart(null);
      setPreviewConnectionVisual(null);
      setCanvasContextMenu(null);
    },
    [openNodeMenuAtClientPosition, setSelectedNode],
  );

  const openCanvasContextMenu = useCallback(
    (event: MouseEvent | ReactMouseEvent, imageUrl: string | null, nodeId: string | null = null) => {
      event.preventDefault();
      const containerRect = wrapperRef.current?.getBoundingClientRect();
      if (!containerRect) {
        return;
      }

      setShowNodeMenu(false);
      setMenuAllowedTypes(undefined);
      setPendingConnectStart(null);
      setPreviewConnectionVisual(null);
      const contextNode = nodeId ? nodes.find((node) => node.id === nodeId) : null;
      const contextMedia = contextNode ? resolveContextMenuMedia(contextNode) : null;
      setCanvasContextMenu({
        position: {
          x: event.clientX - containerRect.left,
          y: event.clientY - containerRect.top,
        },
        flowPosition: reactFlowInstance.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
        imageUrl,
        downloadUrl: contextMedia?.url ?? null,
        downloadMediaType: contextMedia?.mediaType ?? null,
        nodeId,
        textContent: contextNode && isTextAnnotationNode(contextNode) ? contextNode.data.content : null,
      });
    },
    [nodes, reactFlowInstance],
  );

  const handleCanvasContextMenu = useCallback(
    (event: MouseEvent | ReactMouseEvent) => openCanvasContextMenu(event, null),
    [openCanvasContextMenu],
  );

  // 框选 effect 声明在上面，拿不到这个 useCallback，所以用 ref 转一手：
  // macOS 上右键菜单在按下瞬间被压住，需要在这里回放一次。
  useEffect(() => {
    canvasContextMenuRef.current = handleCanvasContextMenu;
  }, [handleCanvasContextMenu]);

  const handleNodeContextMenu = useCallback(
    (event: ReactMouseEvent, node: CanvasNode) => {
      openCanvasContextMenu(event, resolveContextMenuImageUrl(node), node.id);
    },
    [openCanvasContextMenu],
  );

  const handleClearFailedNodes = useCallback(() => {
    if (failedGenerationNodeIds.length === 0) {
      return;
    }
    deleteNodes(failedGenerationNodeIds);
    setCanvasContextMenu(null);
    scheduleCanvasPersist(0);
  }, [deleteNodes, failedGenerationNodeIds, scheduleCanvasPersist]);

  const handleContextCopyNode = useCallback(
    (nodeId: string) => {
      const node = nodes.find((item) => item.id === nodeId);
      if (!node) return;
      copiedSnapshotRef.current = { nodes: [node], edges: [] };
      setSelectedNode(nodeId);
      setCanvasContextMenu(null);
    },
    [nodes, setSelectedNode],
  );

  const handleContextPaste = useCallback(() => {
    const context = canvasContextMenu;
    const snapshot = copiedSnapshotRef.current;
    if (!context || !snapshot || snapshot.nodes.length === 0) return;
    duplicateNodesRef.current?.(
      snapshot.nodes.map((node) => node.id),
      {
        targetPosition: context.flowPosition,
        disableOffsetIteration: true,
      },
    );
    setCanvasContextMenu(null);
  }, [canvasContextMenu]);

  const handleContextDownloadMedia = useCallback(
    (url: string, mediaType: "image" | "video") => {
      const context = canvasContextMenu;
      if (!context) return;
      setCanvasContextMenu(null);
      void saveMediaSourceWithDialog({
        source: url,
        nodeId: context.nodeId ?? "canvas-media",
        mediaType,
      }).catch((error) => {
        console.error("Failed to save media from context menu", error);
        void showErrorDialog(
          mediaType === "video" ? "视频下载失败" : "图片下载失败",
          "下载失败",
          error instanceof Error ? error.message : String(error),
        );
      });
    },
    [canvasContextMenu],
  );

  const handleContextSaveTextToPrompt = useCallback(() => {
    const context = canvasContextMenu;
    if (!context || context.textContent === null) {
      return;
    }
    setCanvasContextMenu(null);
    setSaveTextPromptDialog({ name: "", content: context.textContent });
  }, [canvasContextMenu]);

  const handleSaveTextPrompt = useCallback(() => {
    const draft = saveTextPromptDialog;
    const name = draft?.name.trim() ?? "";
    const content = draft?.content.trim() ?? "";
    if (!draft || !name || !content) {
      return;
    }

    const promptStore = usePromptLibraryStore.getState();
    let targetLibrary = promptStore.libraries.find((library) => !library.readonly);
    if (!targetLibrary) {
      targetLibrary = promptStore.addLibrary(t("promptLibrary.myLib", "我的提示词")) ?? undefined;
    }
    if (!targetLibrary) {
      return;
    }

    promptStore.addTemplate(targetLibrary.id, {
      name,
      scene: "",
      positive: content,
      negative: "",
      category: "custom",
    });
    setSaveTextPromptDialog(null);
  }, [saveTextPromptDialog, t]);

  const handleAddImageToLibrary = useCallback(async (imageUrl: string, categoryId: string) => {
    setCanvasContextMenu(null);
    const assetLibraryState = useAssetLibraryStore.getState();
    const libraryId = assetLibraryState.activeLibraryId || assetLibraryState.libraries[0]?.id;
    if (!libraryId) {
      return;
    }

    const { asset, failure } = await importImageUrlToAssetDetailed(imageUrl, libraryId, categoryId);
    if (asset) {
      useAssetLibraryStore.getState().addAssets([asset]);
      return;
    }

    void showErrorDialog(
      failure?.reason ? `无法将该图片添加到素材库：${failure.reason}` : "无法将该图片添加到素材库",
      "添加失败",
      failure?.details,
    );
  }, []);

  const handleAssetLibraryDragOver = useCallback((event: ReactDragEvent) => {
    const types = event.dataTransfer.types;
    const hasAssetDrag = types.includes(ASSET_DRAG_DATA_TYPE) || types.includes(PROMPT_DRAG_DATA_TYPE);
    const hasTemplateDrag = types.includes(TEMPLATE_DRAG_DATA_TYPE);
    const hasNodeDrag = types.includes(CANVAS_NODE_DRAG_DATA_TYPE);
    // 系统文件拖入: dragOver 阶段 files 不可读(浏览器安全限制), 只能靠 types 里的 'Files'
    const hasFiles = types.includes("Files");
    if (hasAssetDrag || hasTemplateDrag || hasNodeDrag || hasFiles) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const handlePaletteNodeSelect = useCallback(
    (type: CanvasNodeType) => {
      const nodeId = addNode(type, resolveViewportCenterPosition());
      setSelectedNode(nodeId);
      scheduleCanvasPersist(0);
    },
    [addNode, scheduleCanvasPersist, setSelectedNode],
  );

  // 本地上传节点收到视频/音频后替换为媒体节点, 保留原节点 ID 和已有连线。
  useEffect(() => {
    return canvasEventBus.subscribe("upload-node/convert-media", ({ nodeId, file, mediaType }) => {
      void (async () => {
        try {
          const sourcePath = await persistLocalMediaFile(file, mediaType);
          const replaced = replaceNodeType(nodeId, CANVAS_NODE_TYPES.audio, {
            sourcePath,
            mediaType,
            previewImageUrl: null,
            aspectRatio: "1:1",
            displayName: file.name.replace(/\.[^.]+$/, "").trim() || file.name,
          });
          if (replaced) {
            setSelectedNode(nodeId);
            scheduleCanvasPersist(0);
          }
        } catch (error) {
          console.warn("[localUpload] media conversion failed", error);
          void showErrorDialog("本地媒体导入失败", "上传失败", error instanceof Error ? error.message : String(error));
        }
      })();
    });
  }, [replaceNodeType, scheduleCanvasPersist, setSelectedNode]);

  const handleAssetLibraryDrop = useCallback(
    (event: ReactDragEvent) => {
      const types = event.dataTransfer.types;

      // 模板拖拽 → 把模板保存的整套节点链路落到画布
      if (types.includes(TEMPLATE_DRAG_DATA_TYPE)) {
        const templateId = parseTemplateDragPayload(event.dataTransfer.getData(TEMPLATE_DRAG_DATA_TYPE));
        if (!templateId) return;
        event.preventDefault();
        const basePosition = reactFlowInstance.screenToFlowPosition({ x: event.clientX, y: event.clientY });
        void (async () => {
          try {
            const record = await browserTemplateRepository.get(templateId);
            if (!record) return;
            // 模板 graph 存的是保存时的绝对坐标, 必须先归一到左上角再平移到落点
            const placement = resolveTemplatePlacement(ensureTemplateGraph(record).graph, basePosition);
            if (placement.nodes.length === 0) return;

            // 节点 id 由 addNode 内部重新生成(uuid), 因此同模板可重复拖入, 只需记录新旧映射。
            const idMap = new Map<string, string>();
            for (const node of placement.nodes) {
              const newId = addNode(node.type, node.position, node.data);
              idMap.set(node.templateNodeId, newId);
            }
            for (const edge of placement.edges) {
              const source = idMap.get(edge.source);
              const target = idMap.get(edge.target);
              if (!source || !target) continue;
              addEdge(source, target, edge.sourceHandle ?? undefined, edge.targetHandle ?? undefined);
            }
            const focusId =
              (placement.outputTemplateNodeId ? idMap.get(placement.outputTemplateNodeId) : undefined) ??
              (placement.videoTemplateNodeId ? idMap.get(placement.videoTemplateNodeId) : undefined) ??
              placement.nodes.map((node) => idMap.get(node.templateNodeId)).find(Boolean);
            if (focusId) setSelectedNode(focusId);
            scheduleCanvasPersist(0);
          } catch (error) {
            console.warn("[template] drop failed", error);
          }
        })();
        return;
      }

      // 提示词拖拽 → 创建 AI 图片节点
      if (types.includes(PROMPT_DRAG_DATA_TYPE)) {
        const promptId = parsePromptDragPayload(event.dataTransfer.getData(PROMPT_DRAG_DATA_TYPE));
        if (!promptId) return;
        event.preventDefault();
        const allLibraries = usePromptLibraryStore.getState().libraries;
        const template = allLibraries.flatMap((lib) => lib.items).find((item) => item.id === promptId);
        if (!template) return;

        const positive = (template.positive || "").trim();
        const negative = (template.negative || "").trim();
        const mergedText = negative
          ? [positive, `Negative prompt:\n${negative}`].filter(Boolean).join("\n\n")
          : positive;

        const definition = nodeCatalog.getDefinition(CANVAS_NODE_TYPES.imageEdit);
        const position = reactFlowInstance.screenToFlowPosition({ x: event.clientX, y: event.clientY });
        const nodeId = addNode(CANVAS_NODE_TYPES.imageEdit, position, {
          ...definition.createDefaultData(),
          prompt: mergedText,
          displayName: template.name,
        });
        setSelectedNode(nodeId);
        scheduleCanvasPersist(0);
        return;
      }

      const assetId = parseAssetDragPayload(event.dataTransfer.getData(ASSET_DRAG_DATA_TYPE));
      if (!assetId) return;
      event.preventDefault();
      const asset = useAssetLibraryStore.getState().assets.find((item) => item.id === assetId);
      if (!asset) return;
      const position = reactFlowInstance.screenToFlowPosition({ x: event.clientX, y: event.clientY });

      if (asset.mediaType === "audio" || asset.mediaType === "video") {
        // 音/视频素材拖入 → 创建媒体节点(带播放器)
        const mediaDefinition = nodeCatalog.getDefinition(CANVAS_NODE_TYPES.audio);
        const mediaNodeId = addNode(CANVAS_NODE_TYPES.audio, position, {
          ...mediaDefinition.createDefaultData(),
          sourcePath: asset.sourcePath,
          previewImageUrl: asset.previewImageUrl ?? null,
          mediaType: asset.mediaType,
          displayName: asset.name,
        });
        setSelectedNode(mediaNodeId);
        scheduleCanvasPersist(0);
        return;
      }

      if (asset.mediaType !== "image") return;

      const definition = nodeCatalog.getDefinition(CANVAS_NODE_TYPES.upload);
      const nodeId = addNode(CANVAS_NODE_TYPES.upload, position, {
        ...definition.createDefaultData(),
        imageUrl: asset.sourcePath,
        previewImageUrl: asset.previewImageUrl ?? asset.sourcePath,
        aspectRatio: asset.aspectRatio ?? "1:1",
        sourceFileName: asset.sourceFileName ?? null,
        displayName: asset.name,
      });
      setSelectedNode(nodeId);
      scheduleCanvasPersist(0);
    },
    [addEdge, addNode, reactFlowInstance, scheduleCanvasPersist, setSelectedNode],
  );

  // 从系统文件管理器拖入本地文件 → 按类型创建图片或媒体节点。
  const handleFileDrop = useCallback(
    async (event: ReactDragEvent) => {
      const files = Array.from(event.dataTransfer?.files ?? []).filter((file) => resolveLocalUploadMediaType(file));
      if (files.length === 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();

      const basePosition = reactFlowInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      const imageFiles = files.filter((file) => resolveLocalUploadMediaType(file) === "image");
      const mediaFiles = files.filter((file) => {
        const type = resolveLocalUploadMediaType(file);
        return type === "video" || type === "audio";
      });
      const definition = nodeCatalog.getDefinition(CANVAS_NODE_TYPES.upload);

      // 先处理所有文件拿到宽高比, 再按网格对齐排列(每行 3 张, 行列对齐)
      const prepared = [];
      for (const file of imageFiles) {
        prepared.push(await prepareNodeImageFromFile(file));
      }

      const GAP = 24;
      const COLS = 3;
      const sizeFor = (aspectRatio: string) =>
        resolveMinEdgeFittedSize(aspectRatio, {
          minWidth: EXPORT_RESULT_NODE_MIN_WIDTH,
          minHeight: EXPORT_RESULT_NODE_MIN_HEIGHT,
        });

      let cursorX = basePosition.x;
      let cursorY = basePosition.y;
      let rowMaxHeight = 0;
      let lastNodeId: string | null = null;

      for (let index = 0; index < prepared.length; index += 1) {
        const item = prepared[index];
        const file = imageFiles[index];
        const size = sizeFor(item.aspectRatio ?? "1:1");
        if (index > 0 && index % COLS === 0) {
          // 换行: x 回到起点, y 下移上一行最大高度 + 间距
          cursorX = basePosition.x;
          cursorY += rowMaxHeight + GAP;
          rowMaxHeight = 0;
        }
        const nodeId = addNode(
          CANVAS_NODE_TYPES.upload,
          { x: cursorX, y: cursorY },
          {
            ...definition.createDefaultData(),
            imageUrl: item.imageUrl,
            previewImageUrl: item.previewImageUrl ?? item.imageUrl,
            aspectRatio: item.aspectRatio ?? "1:1",
            sourceFileName: file.name,
            displayName: file.name.replace(/\.[^.]+$/, ""),
          },
        );
        lastNodeId = nodeId;
        cursorX += size.width + GAP;
        rowMaxHeight = Math.max(rowMaxHeight, size.height);
      }

      // 视频/音频使用媒体节点, 从图片网格下方开始排列避免重叠。
      if (mediaFiles.length > 0) {
        const mediaDefinition = nodeCatalog.getDefinition(CANVAS_NODE_TYPES.audio);
        let mediaX = basePosition.x;
        const mediaY = imageFiles.length > 0 ? cursorY + rowMaxHeight + GAP : basePosition.y;
        for (const file of mediaFiles) {
          const mediaType = resolveLocalUploadMediaType(file);
          if (mediaType !== "video" && mediaType !== "audio") continue;
          try {
            const sourcePath = await persistLocalMediaFile(file, mediaType);
            const mediaNodeId = addNode(
              CANVAS_NODE_TYPES.audio,
              { x: mediaX, y: mediaY },
              {
                ...mediaDefinition.createDefaultData(),
                sourcePath,
                mediaType,
                displayName: file.name.replace(/\.[^.]+$/, "").trim() || file.name,
              },
            );
            lastNodeId = mediaNodeId;
            mediaX += 344;
          } catch (error) {
            console.warn("[localUpload] file drop failed", error);
            void showErrorDialog(
              "本地媒体导入失败",
              "上传失败",
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      }

      if (lastNodeId) {
        setSelectedNode(lastNodeId);
      }
      scheduleCanvasPersist(0);
    },
    [addNode, reactFlowInstance, scheduleCanvasPersist, setSelectedNode],
  );

  const handleCanvasDrop = useCallback(
    (event: ReactDragEvent) => {
      const droppedType = event.dataTransfer.getData(CANVAS_NODE_DRAG_DATA_TYPE) as CanvasNodeType;
      const isMenuNode = nodeCatalog.getMenuDefinitions().some((definition) => definition.type === droppedType);
      if (isMenuNode) {
        event.preventDefault();
        const position = reactFlowInstance.screenToFlowPosition({ x: event.clientX, y: event.clientY });
        const nodeId = addNode(droppedType, position);
        setSelectedNode(nodeId);
        scheduleCanvasPersist(0);
        return;
      }

      handleAssetLibraryDrop(event);
      void handleFileDrop(event);
    },
    [addNode, handleAssetLibraryDrop, handleFileDrop, reactFlowInstance, scheduleCanvasPersist, setSelectedNode],
  );

  const handleApplyPromptTemplate = useCallback(
    (template: PromptTemplate, mode: "positive" | "full" = "full") => {
      // 对齐 Infinite Canvas:完整应用时把正向 + 负向合并成一段文本输出
      // 格式: [正向]\n\nNegative prompt:\n[负向]
      const positive = (template.positive || "").trim();
      const negative = (template.negative || "").trim();
      const mergedText =
        mode === "full" && negative
          ? [positive, `Negative prompt:\n${negative}`].filter(Boolean).join("\n\n")
          : positive;

      const selectedNode = useCanvasStore.getState().nodes.find((node) => node.id === selectedNodeId);
      if (selectedNode?.type === CANVAS_NODE_TYPES.imageEdit) {
        const currentPrompt = String((selectedNode.data as Record<string, unknown>).prompt ?? "").trim();
        updateNodeData(selectedNode.id, {
          prompt: currentPrompt ? `${currentPrompt}\n\n${mergedText}` : mergedText,
        });
        scheduleCanvasPersist(0);
        return;
      }

      const definition = nodeCatalog.getDefinition(CANVAS_NODE_TYPES.imageEdit);
      const nodeId = addNode(CANVAS_NODE_TYPES.imageEdit, resolveViewportCenterPosition(), {
        ...definition.createDefaultData(),
        prompt: mergedText,
        displayName: template.name,
      });
      setSelectedNode(nodeId);
      scheduleCanvasPersist(0);
    },
    [addNode, scheduleCanvasPersist, selectedNodeId, setSelectedNode, updateNodeData],
  );

  const handleNodeSelect = useCallback(
    (type: CanvasNodeType) => {
      const newNodeId = addNode(type, flowPosition);
      if (pendingConnectStart) {
        if (pendingConnectStart.handleType === "source") {
          connectNodes({
            source: pendingConnectStart.nodeId,
            target: newNodeId,
            sourceHandle: "source",
            targetHandle: "target",
          });
        } else {
          connectNodes({
            source: newNodeId,
            target: pendingConnectStart.nodeId,
            sourceHandle: "source",
            targetHandle: "target",
          });
        }
      }

      scheduleCanvasPersist(0);
      setShowNodeMenu(false);
      setMenuAllowedTypes(undefined);
      setPendingConnectStart(null);
      setPreviewConnectionVisual(null);
    },
    [addNode, connectNodes, flowPosition, pendingConnectStart, scheduleCanvasPersist, setPreviewConnectionVisual],
  );

  const duplicateNodes = useCallback(
    (sourceNodeIds: string[], options: DuplicateOptions = {}) => {
      const dedupedIds = Array.from(new Set(sourceNodeIds));
      if (dedupedIds.length === 0) {
        return null as DuplicateResult | null;
      }

      const sourceNodes = nodes.filter((node) => dedupedIds.includes(node.id));
      if (sourceNodes.length === 0) {
        return null as DuplicateResult | null;
      }

      const sourceIdSet = new Set(sourceNodes.map((node) => node.id));
      const internalEdges = edges.filter((edge) => sourceIdSet.has(edge.source) && sourceIdSet.has(edge.target));

      const baseOffsets = [
        { x: 44, y: 30 },
        { x: 72, y: 8 },
        { x: 18, y: 68 },
        { x: 96, y: 42 },
      ];
      const existingNodes = useCanvasStore.getState().nodes;
      const ignoreNodeIds = new Set<string>();
      const offsetStep = options.disableOffsetIteration ? 0 : pasteIterationRef.current;
      let chosenOffset = options.targetPosition
        ? {
            x: options.targetPosition.x - sourceNodes[0].position.x,
            y: options.targetPosition.y - sourceNodes[0].position.y,
          }
        : (options.explicitOffset ?? baseOffsets[0]);

      const isOffsetAvailable = (offset: { x: number; y: number }) =>
        sourceNodes.every((node) => {
          const size = getNodeSize(node);
          return !hasRectCollision(
            {
              x: node.position.x + offset.x + offsetStep * 8,
              y: node.position.y + offset.y + offsetStep * 6,
              width: size.width,
              height: size.height,
            },
            existingNodes,
            ignoreNodeIds,
          );
        });

      if (!options.explicitOffset && !options.targetPosition) {
        const matchedBaseOffset = baseOffsets.find((offset) => isOffsetAvailable(offset));
        if (matchedBaseOffset) {
          chosenOffset = matchedBaseOffset;
        } else {
          const maxStep = 16;
          for (let step = 1; step <= maxStep; step += 1) {
            const candidate = { x: 24 + step * 26, y: 16 + step * 18 };
            if (isOffsetAvailable(candidate)) {
              chosenOffset = candidate;
              break;
            }
          }
        }
      }

      const idMap = new Map<string, string>();
      const sizeMap = new Map<string, { width: number; height: number }>();
      for (const sourceNode of sourceNodes) {
        const data = cloneNodeData(sourceNode.data);
        if ("isGenerating" in (data as Record<string, unknown>)) {
          (data as { isGenerating?: boolean }).isGenerating = false;
        }
        if ("generationStartedAt" in (data as Record<string, unknown>)) {
          (data as { generationStartedAt?: number | null }).generationStartedAt = null;
        }
        if ("generationJobId" in (data as Record<string, unknown>)) {
          (data as { generationJobId?: string | null }).generationJobId = null;
        }
        if ("generationProviderId" in (data as Record<string, unknown>)) {
          (data as { generationProviderId?: string | null }).generationProviderId = null;
        }
        if ("generationClientSessionId" in (data as Record<string, unknown>)) {
          (data as { generationClientSessionId?: string | null }).generationClientSessionId = null;
        }
        if ("generationStoryboardMetadata" in (data as Record<string, unknown>)) {
          (data as { generationStoryboardMetadata?: unknown }).generationStoryboardMetadata = undefined;
        }
        if ("generationError" in (data as Record<string, unknown>)) {
          (data as { generationError?: string | null }).generationError = null;
        }
        if ("generationErrorDetails" in (data as Record<string, unknown>)) {
          (data as { generationErrorDetails?: string | null }).generationErrorDetails = null;
        }
        if ("generationDebugContext" in (data as Record<string, unknown>)) {
          (data as { generationDebugContext?: unknown }).generationDebugContext = undefined;
        }
        if (sourceNode.type === CANVAS_NODE_TYPES.cinematicStudio) {
          // 工作室节点各自持有一份工程：复制节点时分配新工程并把内容复制过去，
          // 让副本能独立编辑，而不是和原节点共享同一份数据。
          const sourceProjectId =
            typeof (data as { studioProjectId?: unknown }).studioProjectId === "string"
              ? (data as { studioProjectId: string }).studioProjectId
              : "";
          const nextProjectId = createCinematicProjectId();
          if (sourceProjectId) void duplicateCinematicProject(sourceProjectId, nextProjectId);
          (data as { studioProjectId?: string }).studioProjectId = nextProjectId;
        }

        const nextNodeId = addNode(
          sourceNode.type as CanvasNodeType,
          {
            x: sourceNode.position.x + chosenOffset.x + offsetStep * 8,
            y: sourceNode.position.y + chosenOffset.y + offsetStep * 6,
          },
          { ...data },
        );
        idMap.set(sourceNode.id, nextNodeId);
        sizeMap.set(nextNodeId, getNodeSize(sourceNode));
      }

      const sizeSyncChanges = Array.from(sizeMap.entries()).map(([nodeId, size]) => ({
        id: nodeId,
        type: "dimensions" as const,
        dimensions: { width: size.width, height: size.height },
        resizing: false,
        setAttributes: true,
      }));
      if (sizeSyncChanges.length > 0) {
        applyNodesChange(sizeSyncChanges);
      }

      for (const edge of internalEdges) {
        const nextSource = idMap.get(edge.source);
        const nextTarget = idMap.get(edge.target);
        if (!nextSource || !nextTarget) {
          continue;
        }
        connectNodes({
          source: nextSource,
          target: nextTarget,
          sourceHandle: edge.sourceHandle ?? "source",
          targetHandle: edge.targetHandle ?? "target",
        });
      }

      if (!options.disableOffsetIteration) {
        pasteIterationRef.current += 1;
      }
      const firstNodeId = idMap.get(sourceNodes[0].id) ?? null;
      if (firstNodeId && !options.suppressSelect) {
        setSelectedNode(firstNodeId);
      }
      if (!options.suppressPersist) {
        scheduleCanvasPersist(0);
      }
      return { firstNodeId, idMap };
    },
    [addNode, applyNodesChange, connectNodes, edges, nodes, scheduleCanvasPersist, setSelectedNode],
  );

  useEffect(() => {
    duplicateNodesRef.current = (sourceNodeIds: string[], options?: DuplicateOptions) =>
      duplicateNodes(sourceNodeIds, options)?.firstNodeId ?? null;
  }, [duplicateNodes]);

  const handleConnectStart = useCallback(
    (event: MouseEvent | TouchEvent, params: OnConnectStartParams) => {
      setShowNodeMenu(false);
      setMenuAllowedTypes(undefined);
      setPreviewConnectionVisual(null);

      if (!params.nodeId || !params.handleType) {
        setPendingConnectStart(null);
        return;
      }

      if (params.handleType === "source" && !canNodeBeManualConnectionSource(params.nodeId, nodes)) {
        setPendingConnectStart(null);
        return;
      }

      const containerRect = wrapperRef.current?.getBoundingClientRect();
      const eventTarget = event.target as Element | null;
      const handleElement = eventTarget?.closest?.(".react-flow__handle") as HTMLElement | null;
      const clientPosition = getClientPosition(event);
      let start: { x: number; y: number } | undefined;
      if (containerRect && handleElement) {
        const handleRect = handleElement.getBoundingClientRect();
        start = {
          x: handleRect.left - containerRect.left + handleRect.width / 2,
          y: handleRect.top - containerRect.top + handleRect.height / 2,
        };
      } else if (containerRect && clientPosition) {
        start = {
          x: clientPosition.x - containerRect.left,
          y: clientPosition.y - containerRect.top,
        };
      }

      setPendingConnectStart({
        nodeId: params.nodeId,
        handleType: params.handleType,
        start,
      });
    },
    [nodes],
  );

  const handleNodeDragStart = useCallback(
    (event: ReactMouseEvent, node: CanvasNode) => {
      setAlignmentGuides([]);
      activeDragAlignmentRef.current.clear();
      // 拖拽画布节点也视为画布区交互, 收起素材库/模板侧边栏
      setIsLibraryOpen(false);
      setIsTemplateOpen(false);
      if (groupDragFeedbackTimerRef.current !== null) {
        window.clearTimeout(groupDragFeedbackTimerRef.current);
        groupDragFeedbackTimerRef.current = null;
      }
      pendingGroupDragNodeRef.current = null;
      hasActiveGroupsDuringDragRef.current =
        !event.altKey && useCanvasStore.getState().nodes.some((item) => item.type === CANVAS_NODE_TYPES.group);

      if (!event.altKey) {
        altDragCopyRef.current = null;
        return;
      }

      const sourceNodeIds = selectedNodeIds.includes(node.id) ? selectedNodeIds : [node.id];
      if (sourceNodeIds.length === 0) {
        altDragCopyRef.current = null;
        return;
      }
      const startPositions = new Map<string, { x: number; y: number }>();
      for (const sourceNodeId of sourceNodeIds) {
        const sourceNode = nodes.find((item) => item.id === sourceNodeId);
        if (!sourceNode) {
          continue;
        }
        startPositions.set(sourceNodeId, {
          x: sourceNode.position.x,
          y: sourceNode.position.y,
        });
      }
      if (startPositions.size === 0) {
        altDragCopyRef.current = null;
        return;
      }

      const duplicateResult = duplicateNodes(sourceNodeIds, {
        explicitOffset: { x: 0, y: 0 },
        disableOffsetIteration: true,
        suppressPersist: true,
        suppressSelect: true,
      });
      if (!duplicateResult) {
        altDragCopyRef.current = null;
        return;
      }

      const copiedNodeIds = sourceNodeIds
        .map((sourceId) => duplicateResult.idMap.get(sourceId))
        .filter((id): id is string => Boolean(id));
      if (copiedNodeIds.length === 0) {
        altDragCopyRef.current = null;
        return;
      }

      // Keep the duplicated nodes visually above the original dragged node.
      useCanvasStore.setState((state) => ({
        nodes: state.nodes.map((currentNode) => {
          if (!copiedNodeIds.includes(currentNode.id)) {
            return currentNode;
          }
          return {
            ...currentNode,
            zIndex: ALT_DRAG_COPY_Z_INDEX,
            style: {
              ...(currentNode.style ?? {}),
              zIndex: ALT_DRAG_COPY_Z_INDEX,
            },
          };
        }),
      }));

      altDragCopyRef.current = {
        sourceNodeIds,
        startPositions,
        copiedNodeIds,
        sourceToCopyIdMap: duplicateResult.idMap,
      };
    },
    [duplicateNodes, nodes, selectedNodeIds],
  );

  /**
   * 拖出蓄力(穿结界)检测:
   * - 节点中心越出父组边界 → 蓄力开始(阶段0), 未解锁期间把节点"顶住"在边界上(无法继续拖出);
   * - 接触边缘 500ms → 触发组边缘黄色高亮(阶段1);
   * - 高亮再持续 500ms → 解锁: 自动穿出移出分组;
   * - 节点明显回到组内(离开边缘 CHARGE_EDGE_MARGIN) → 取消蓄力。
   */
  const updateDragOutCharging = useCallback(
    (targets: CanvasNode[], nodeMap: Map<string, CanvasNode>) => {
      const charges = chargeOutTimersRef.current;
      const pendingIds = new Set<string>();
      const clampChanges: Array<{
        id: string;
        type: "position";
        position: { x: number; y: number };
        dragging: true;
      }> = [];

      for (const target of targets) {
        if (target.type === CANVAS_NODE_TYPES.group || !target.parentId) {
          continue;
        }
        const parent = nodeMap.get(target.parentId);
        if (!parent || parent.type !== CANVAS_NODE_TYPES.group) {
          continue;
        }
        const absolute = resolveCanvasNodeAbsolutePosition(target.id, nodeMap);
        const size = resolveCanvasNodeSize(target);
        const nodeLeft = absolute.x;
        const nodeRight = absolute.x + size.width;
        const nodeTop = absolute.y;
        const nodeBottom = absolute.y + size.height;
        const parentAbsolute = resolveCanvasNodeAbsolutePosition(parent.id, nodeMap);
        const parentSize = resolveCanvasNodeSize(parent);
        const left = parentAbsolute.x;
        const right = parentAbsolute.x + parentSize.width;
        const top = parentAbsolute.y;
        const bottom = parentAbsolute.y + parentSize.height;
        // 图片边缘接触/越过组边缘 → 结界触发(含贴边相等, 否则 clamp 后松手无法回弹)
        const touchingOutside = nodeLeft <= left || nodeRight >= right || nodeTop <= top || nodeBottom >= bottom;

        if (touchingOutside) {
          pendingIds.add(target.id);
          const existing = charges.get(target.id);
          if (!existing) {
            // 阶段0: 接触边缘, 500ms 后触发黄色高亮
            const phase0Timer = window.setTimeout(() => {
              const charge = charges.get(target.id);
              if (!charge || charge.phase !== 0) {
                return;
              }
              setChargingGroupId(parent.id);
              // 阶段1: 高亮中, 再 500ms 后解锁穿出
              const phase1Timer = window.setTimeout(() => {
                charges.delete(target.id);
                const latest = useCanvasStore.getState();
                const latestNode = latest.nodes.find((item) => item.id === target.id);
                if (latestNode && latestNode.parentId === parent.id) {
                  removeNodesFromGroup([target.id]);
                  scheduleCanvasPersist(0);
                }
                if (charges.size === 0) {
                  setChargingGroupId(null);
                }
              }, CHARGE_UNLOCK_DELAY_MS);
              charges.set(target.id, { phase: 1, timer: phase1Timer });
            }, CHARGE_HIGHLIGHT_DELAY_MS);
            charges.set(target.id, { phase: 0, timer: phase0Timer });
          } else {
            // 蓄力中(未解锁): 顶住——节点边缘 clamp 贴住组边缘(节点保持在组内), 制造阻力感
            let nextLeft = nodeLeft;
            let nextTop = nodeTop;
            if (nodeLeft < left) {
              nextLeft = left;
            } else if (nodeRight > right) {
              nextLeft = right - size.width;
            }
            if (nodeTop < top) {
              nextTop = top;
            } else if (nodeBottom > bottom) {
              nextTop = bottom - size.height;
            }
            if (nextLeft !== nodeLeft || nextTop !== nodeTop) {
              clampChanges.push({
                id: target.id,
                type: "position",
                position: {
                  x: Math.round(nextLeft - left),
                  y: Math.round(nextTop - top),
                },
                dragging: true,
              });
            }
          }
        } else {
          // 图片边缘明显离开组边缘 → 取消蓄力
          const clearlyInside =
            nodeLeft > left + CHARGE_EDGE_MARGIN &&
            nodeRight < right - CHARGE_EDGE_MARGIN &&
            nodeTop > top + CHARGE_EDGE_MARGIN &&
            nodeBottom < bottom - CHARGE_EDGE_MARGIN;
          if (clearlyInside) {
            const existing = charges.get(target.id);
            if (existing) {
              window.clearTimeout(existing.timer);
              charges.delete(target.id);
              if (charges.size === 0) {
                setChargingGroupId(null);
              }
            }
          }
        }
      }

      if (clampChanges.length > 0) {
        applyNodesChange(clampChanges);
      }

      // 拖拽目标集合之外的残留蓄力(理论不发生)清理
      for (const [nodeId, charge] of charges) {
        if (!pendingIds.has(nodeId)) {
          window.clearTimeout(charge.timer);
          charges.delete(nodeId);
        }
      }
      if (charges.size === 0) {
        setChargingGroupId(null);
      }
    },
    [applyNodesChange, removeNodesFromGroup, scheduleCanvasPersist, setChargingGroupId],
  );

  const scheduleGroupDragFeedback = useCallback(
    (node: CanvasNode) => {
      if (!hasActiveGroupsDuringDragRef.current) {
        return;
      }

      pendingGroupDragNodeRef.current = node;
      if (groupDragFeedbackTimerRef.current !== null) {
        return;
      }

      // Group hit testing is visual feedback. Capping it at roughly 20 fps
      // prevents large grouped canvases from scanning every node per pointer event.
      groupDragFeedbackTimerRef.current = window.setTimeout(() => {
        groupDragFeedbackTimerRef.current = null;
        const pendingNode = pendingGroupDragNodeRef.current;
        pendingGroupDragNodeRef.current = null;
        if (!pendingNode || !hasActiveGroupsDuringDragRef.current) {
          return;
        }

        const state = useCanvasStore.getState();
        const nodeMap = new Map(state.nodes.map((item) => [item.id, item] as const));
        const groups = state.nodes.filter((item) => item.type === CANVAS_NODE_TYPES.group);
        const draggingNodes = state.nodes.filter((item) => Boolean(item.dragging));
        const targets = draggingNodes.length > 0 ? draggingNodes : [pendingNode];

        if (groups.length === 0) {
          hasActiveGroupsDuringDragRef.current = false;
          if (state.hoveredGroupId) {
            setHoveredGroupId(null);
          }
          return;
        }

        setHoveredGroupId(resolveDragTargetGroupId(targets, nodeMap, groups));
        updateDragOutCharging(targets, nodeMap);
      }, 48);
    },
    [setHoveredGroupId, updateDragOutCharging],
  );

  const handleNodeDrag = useCallback(
    (_event: ReactMouseEvent, node: CanvasNode) => {
      const altCopyState = altDragCopyRef.current;
      if (!altCopyState) {
        let feedbackNode = node;

        // 只对顶层节点做实时对齐。组内节点使用 parent-relative 坐标，若直接参与
        // 计算会把组内位置误当成画布坐标；拖动整个组时则仍可与其他顶层节点对齐。
        if (alignmentGuidesEnabled && !node.parentId) {
          const state = useCanvasStore.getState();
          const nodeMap = new Map(state.nodes.map((item) => [item.id, item] as const));
          nodeMap.set(node.id, node);

          const movingAbsolute = resolveCanvasNodeAbsolutePosition(node.id, nodeMap);
          const movingSize = resolveCanvasNodeSize(node);
          const references = state.nodes
            .filter((reference) => {
              return reference.id !== node.id && !reference.parentId && !reference.dragging;
            })
            .map((reference) => {
              const absolute = resolveCanvasNodeAbsolutePosition(reference.id, nodeMap);
              const size = resolveCanvasNodeSize(reference);
              return {
                id: reference.id,
                x: absolute.x,
                y: absolute.y,
                width: size.width,
                height: size.height,
              };
            });

          const alignment = computeDragAlignment(
            {
              id: node.id,
              x: movingAbsolute.x,
              y: movingAbsolute.y,
              width: movingSize.width,
              height: movingSize.height,
            },
            references,
            ALIGNMENT_GUIDE_SNAP_THRESHOLD,
          );
          setAlignmentGuides(alignment.guides);

          if (alignment.position.x !== node.position.x || alignment.position.y !== node.position.y) {
            activeDragAlignmentRef.current.set(node.id, alignment.position);
            const alignedChange = {
              id: node.id,
              type: "position" as const,
              position: alignment.position,
              dragging: true as const,
            };
            applyNodesChange([alignedChange]);
            feedbackNode = { ...node, position: alignment.position };
          } else {
            activeDragAlignmentRef.current.delete(node.id);
          }
        } else {
          setAlignmentGuides([]);
          activeDragAlignmentRef.current.delete(node.id);
        }

        scheduleGroupDragFeedback(feedbackNode);
        return;
      }

      setAlignmentGuides([]);

      const startPosition = altCopyState.startPositions.get(node.id);
      if (!startPosition) {
        return;
      }

      const deltaX = node.position.x - startPosition.x;
      const deltaY = node.position.y - startPosition.y;

      const restoreSourceChanges = altCopyState.sourceNodeIds
        .map((sourceId) => {
          const sourceStart = altCopyState.startPositions.get(sourceId);
          if (!sourceStart) {
            return null;
          }
          return {
            id: sourceId,
            type: "position" as const,
            position: sourceStart,
            dragging: true,
          };
        })
        .filter(
          (
            change,
          ): change is {
            id: string;
            type: "position";
            position: { x: number; y: number };
            dragging: true;
          } => Boolean(change),
        );

      const moveCopyChanges = altCopyState.sourceNodeIds
        .map((sourceId) => {
          const sourceStart = altCopyState.startPositions.get(sourceId);
          const copyId = altCopyState.sourceToCopyIdMap.get(sourceId);
          if (!sourceStart || !copyId) {
            return null;
          }
          return {
            id: copyId,
            type: "position" as const,
            position: { x: sourceStart.x + deltaX, y: sourceStart.y + deltaY },
            dragging: true,
          };
        })
        .filter(
          (
            change,
          ): change is {
            id: string;
            type: "position";
            position: { x: number; y: number };
            dragging: true;
          } => Boolean(change),
        );

      const allChanges = [...restoreSourceChanges, ...moveCopyChanges];
      if (allChanges.length > 0) {
        applyNodesChange(allChanges);
      }
    },
    [alignmentGuidesEnabled, applyNodesChange, scheduleGroupDragFeedback],
  );

  const handleNodeDragStop = useCallback(
    (_event: ReactMouseEvent, node: CanvasNode) => {
      setAlignmentGuides([]);
      if (groupDragFeedbackTimerRef.current !== null) {
        window.clearTimeout(groupDragFeedbackTimerRef.current);
        groupDragFeedbackTimerRef.current = null;
      }
      pendingGroupDragNodeRef.current = null;
      hasActiveGroupsDuringDragRef.current = false;

      const altCopyState = altDragCopyRef.current;
      if (!altCopyState) {
        // 非 Alt 复制拖拽: 检测「拖入组 / 拖出组」
        const state = useCanvasStore.getState();
        const nodeMap = new Map(state.nodes.map((item) => [item.id, item] as const));
        const groups = state.nodes.filter((item) => item.type === CANVAS_NODE_TYPES.group);
        if (groups.length > 0) {
          const draggingNodes = state.nodes.filter((item) => Boolean(item.dragging));
          const targets = draggingNodes.length > 0 ? draggingNodes : [node];
          const actionable = targets.filter((item) => item.type !== CANVAS_NODE_TYPES.group);

          const toGroup = new Map<string, string[]>();
          const toRemove: string[] = [];
          const bounceChanges: Array<{
            id: string;
            type: "position";
            position: { x: number; y: number };
            dragging: false;
          }> = [];

          for (const target of actionable) {
            const absolute = resolveCanvasNodeAbsolutePosition(target.id, nodeMap);
            const size = resolveCanvasNodeSize(target);
            const centerX = absolute.x + size.width / 2;
            const centerY = absolute.y + size.height / 2;

            const targetGroup = groups.find((group) => {
              if (group.id === target.parentId) {
                return false;
              }
              const groupAbsolute = resolveCanvasNodeAbsolutePosition(group.id, nodeMap);
              const groupSize = resolveCanvasNodeSize(group);
              return (
                centerX >= groupAbsolute.x &&
                centerX <= groupAbsolute.x + groupSize.width &&
                centerY >= groupAbsolute.y &&
                centerY <= groupAbsolute.y + groupSize.height
              );
            });

            if (targetGroup) {
              const list = toGroup.get(targetGroup.id) ?? [];
              list.push(target.id);
              toGroup.set(targetGroup.id, list);
              continue;
            }

            // 拖出(穿结界): 节点边缘接触/越过父组边界
            if (target.parentId) {
              const parent = nodeMap.get(target.parentId);
              if (parent && parent.type === CANVAS_NODE_TYPES.group) {
                const parentAbsolute = resolveCanvasNodeAbsolutePosition(parent.id, nodeMap);
                const parentSize = resolveCanvasNodeSize(parent);
                const nodeLeft = absolute.x;
                const nodeRight = absolute.x + size.width;
                const nodeTop = absolute.y;
                const nodeBottom = absolute.y + size.height;
                // 含贴边相等: 未蓄满松手时(节点被 clamp 在贴边位置)也能触发回弹
                const outside =
                  nodeLeft <= parentAbsolute.x ||
                  nodeRight >= parentAbsolute.x + parentSize.width ||
                  nodeTop <= parentAbsolute.y ||
                  nodeBottom >= parentAbsolute.y + parentSize.height;
                if (outside) {
                  // 穿结界: 未解锁(仍有蓄力记录) → 取消蓄力, 图片边缘贴住组边框停留(不移出、不弹回组内);
                  // 已解锁 → 已由 timer 移出分组, 无需处理
                  const charge = chargeOutTimersRef.current.get(target.id);
                  if (charge) {
                    window.clearTimeout(charge.timer);
                    chargeOutTimersRef.current.delete(target.id);
                    // 节点边缘 clamp 到 [组左, 组右-宽] 区间: 越界则贴边, 组内则保持
                    const clampedLeft = Math.min(
                      Math.max(nodeLeft, parentAbsolute.x),
                      parentAbsolute.x + parentSize.width - size.width,
                    );
                    const clampedTop = Math.min(
                      Math.max(nodeTop, parentAbsolute.y),
                      parentAbsolute.y + parentSize.height - size.height,
                    );
                    bounceChanges.push({
                      id: target.id,
                      type: "position",
                      position: {
                        x: Math.round(clampedLeft - parentAbsolute.x),
                        y: Math.round(clampedTop - parentAbsolute.y),
                      },
                      dragging: false,
                    });
                  } else {
                    // 兜底: 无蓄力记录的越界节点直接移出
                    toRemove.push(target.id);
                  }
                }
              }
            }
          }

          if (bounceChanges.length > 0) {
            applyNodesChange(bounceChanges);
          }

          let changed = false;
          const flashedGroupIds = new Set<string>();
          for (const [groupId, ids] of toGroup) {
            if (addNodesToGroup(ids, groupId)) {
              changed = true;
              flashedGroupIds.add(groupId);
            }
          }
          if (toRemove.length > 0 && removeNodesFromGroup(toRemove)) {
            changed = true;
          }
          setHoveredGroupId(null);
          if (changed) {
            // 拖入成功: 目标组短暂闪烁反馈
            for (const groupId of flashedGroupIds) {
              setFlashGroupId(groupId);
            }
            if (flashTimerRef.current !== null) {
              window.clearTimeout(flashTimerRef.current);
            }
            flashTimerRef.current = window.setTimeout(() => {
              flashTimerRef.current = null;
              setFlashGroupId(null);
            }, 700);
            scheduleCanvasPersist(0);
          }
        } else {
          setHoveredGroupId(null);
        }
        // 拖拽结束: 清理所有拖出蓄力(未解锁的已回弹, 已解锁的已移出)
        for (const [, charge] of chargeOutTimersRef.current) {
          window.clearTimeout(charge.timer);
        }
        chargeOutTimersRef.current.clear();
        setChargingGroupId(null);
        return;
      }
      altDragCopyRef.current = null;

      const startPosition = altCopyState.startPositions.get(node.id);
      if (!startPosition) {
        return;
      }

      const offset = {
        x: node.position.x - startPosition.x,
        y: node.position.y - startPosition.y,
      };

      const restoreSourceChanges = altCopyState.sourceNodeIds
        .map((sourceId) => {
          const sourceStart = altCopyState.startPositions.get(sourceId);
          if (!sourceStart) {
            return null;
          }
          return {
            id: sourceId,
            type: "position" as const,
            position: sourceStart,
            dragging: false,
          };
        })
        .filter(
          (
            change,
          ): change is {
            id: string;
            type: "position";
            position: { x: number; y: number };
            dragging: false;
          } => Boolean(change),
        );

      const finalizeCopyChanges = altCopyState.sourceNodeIds
        .map((sourceId) => {
          const sourceStart = altCopyState.startPositions.get(sourceId);
          const copyId = altCopyState.sourceToCopyIdMap.get(sourceId);
          if (!sourceStart || !copyId) {
            return null;
          }
          return {
            id: copyId,
            type: "position" as const,
            position: { x: sourceStart.x + offset.x, y: sourceStart.y + offset.y },
            dragging: false,
          };
        })
        .filter(
          (
            change,
          ): change is {
            id: string;
            type: "position";
            position: { x: number; y: number };
            dragging: false;
          } => Boolean(change),
        );

      const allChanges = [...restoreSourceChanges, ...finalizeCopyChanges];
      if (allChanges.length > 0) {
        applyNodesChange(allChanges);
      }
      if (altCopyState.copiedNodeIds.length > 0) {
        setSelectedNode(altCopyState.copiedNodeIds[0]);
      }
      scheduleCanvasPersist(0);
    },
    [
      addNodesToGroup,
      applyNodesChange,
      removeNodesFromGroup,
      scheduleCanvasPersist,
      setChargingGroupId,
      setFlashGroupId,
      setHoveredGroupId,
      setSelectedNode,
    ],
  );

  const handleConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => {
      if (connectionState.isValid || !pendingConnectStart) {
        setPendingConnectStart(null);
        setPreviewConnectionVisual(null);
        return;
      }

      const clientPosition = getClientPosition(event);
      const containerRect = wrapperRef.current?.getBoundingClientRect();
      if (!clientPosition || !containerRect) {
        setPendingConnectStart(null);
        setPreviewConnectionVisual(null);
        return;
      }

      const eventTarget = event.target as Element | null;
      const nodeElementFromTarget = eventTarget?.closest?.(".react-flow__node[data-id]") as HTMLElement | null;
      const nodeElementFromPoint = document
        .elementFromPoint(clientPosition.x, clientPosition.y)
        ?.closest?.(".react-flow__node[data-id]") as HTMLElement | null;
      const dropNodeElement = nodeElementFromTarget ?? nodeElementFromPoint;
      const dropNodeId = dropNodeElement?.dataset?.id ?? null;

      if (dropNodeId && dropNodeId !== pendingConnectStart.nodeId) {
        const sourceNode =
          pendingConnectStart.handleType === "source"
            ? nodes.find((node) => node.id === pendingConnectStart.nodeId)
            : nodes.find((node) => node.id === dropNodeId);
        const targetNode =
          pendingConnectStart.handleType === "source"
            ? nodes.find((node) => node.id === dropNodeId)
            : nodes.find((node) => node.id === pendingConnectStart.nodeId);

        if (
          sourceNode &&
          targetNode &&
          canNodeTypeBeManualConnectionSource(sourceNode.type) &&
          nodeHasSourceHandle(sourceNode.type) &&
          nodeHasTargetHandle(targetNode.type)
        ) {
          connectNodes({
            source: sourceNode.id,
            target: targetNode.id,
            sourceHandle: "source",
            targetHandle: "target",
          });
          scheduleCanvasPersist(0);
          setPendingConnectStart(null);
          setPreviewConnectionVisual(null);
          return;
        }
      }

      const allowedTypes = resolveAllowedNodeTypes(pendingConnectStart.handleType);
      if (allowedTypes.length === 0) {
        setPendingConnectStart(null);
        setPreviewConnectionVisual(null);
        return;
      }

      const endX = clientPosition.x - containerRect.left;
      const endY = clientPosition.y - containerRect.top;
      let startX: number | null = pendingConnectStart.start?.x ?? null;
      let startY: number | null = pendingConnectStart.start?.y ?? null;

      if (startX === null || startY === null) {
        const nodeElement = wrapperRef.current?.querySelector<HTMLElement>(
          `.react-flow__node[data-id="${pendingConnectStart.nodeId}"]`,
        );
        const handleElement = nodeElement?.querySelector<HTMLElement>(
          `.react-flow__handle-${pendingConnectStart.handleType}`,
        );
        if (handleElement) {
          const handleRect = handleElement.getBoundingClientRect();
          startX = handleRect.left - containerRect.left + handleRect.width / 2;
          startY = handleRect.top - containerRect.top + handleRect.height / 2;
        } else if (nodeElement) {
          const nodeRect = nodeElement.getBoundingClientRect();
          startX =
            pendingConnectStart.handleType === "source"
              ? nodeRect.right - containerRect.left
              : nodeRect.left - containerRect.left;
          startY = nodeRect.top - containerRect.top + nodeRect.height / 2;
        } else if (connectionState.from) {
          startX = connectionState.from.x;
          startY = connectionState.from.y;
        }
      }

      if (startX === null || startY === null) {
        setPreviewConnectionVisual(null);
      } else {
        setPreviewConnectionVisual({
          d: createPreviewPath({
            start: { x: startX, y: startY },
            end: { x: endX, y: endY },
            handleType: pendingConnectStart.handleType,
          }),
          stroke: "rgba(255,255,255,0.9)",
          strokeWidth: 1,
          strokeLinecap: "round",
          left: 0,
          top: 0,
          width: containerRect.width,
          height: containerRect.height,
        });
      }

      const flowPos = reactFlowInstance.screenToFlowPosition(clientPosition);
      setFlowPosition(flowPos);
      setMenuPosition({
        x: clientPosition.x - containerRect.left,
        y: clientPosition.y - containerRect.top,
      });
      setMenuAllowedTypes(allowedTypes);
      suppressNextPaneClickRef.current = true;
      setShowNodeMenu(true);
    },
    [connectNodes, nodes, pendingConnectStart, reactFlowInstance, scheduleCanvasPersist],
  );

  const emptyHint = useMemo(
    () => (
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="flex max-w-3xl flex-col items-center gap-5 px-6 text-center">
          <div>
            <div className="mb-2 text-2xl text-text-muted">{t("canvas.emptyHintTitle")}</div>
            <div className="text-sm text-text-muted opacity-60">{t("canvas.emptyHintSubtitle")}</div>
          </div>
        </div>
      </div>
    ),
    [t],
  );

  const alignmentGuideLines = useMemo(() => {
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (!rect || alignmentGuides.length === 0) {
      return [];
    }

    return alignmentGuides.map((guide, index) => {
      if (guide.axis === "vertical") {
        const start = reactFlowInstance.flowToScreenPosition({ x: guide.position, y: guide.start });
        const end = reactFlowInstance.flowToScreenPosition({ x: guide.position, y: guide.end });
        return {
          key: `${guide.axis}-${guide.position}-${index}`,
          x1: start.x - rect.left,
          y1: start.y - rect.top,
          x2: end.x - rect.left,
          y2: end.y - rect.top,
        };
      }

      const start = reactFlowInstance.flowToScreenPosition({ x: guide.start, y: guide.position });
      const end = reactFlowInstance.flowToScreenPosition({ x: guide.end, y: guide.position });
      return {
        key: `${guide.axis}-${guide.position}-${index}`,
        x1: start.x - rect.left,
        y1: start.y - rect.top,
        x2: end.x - rect.left,
        y2: end.y - rect.top,
      };
    });
  }, [alignmentGuides, reactFlowInstance]);

  return (
    <div
      ref={wrapperRef}
      className="relative h-full w-full"
      onMouseMoveCapture={handleCanvasMouseMoveCapture}
      onMouseDownCapture={handleCanvasMouseDownCapture}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onEdgeClick={handleEdgeClick}
        onEdgeDoubleClick={handleEdgeDoubleClick}
        onConnect={handleConnect}
        onConnectStart={handleConnectStart}
        onConnectEnd={handleConnectEnd}
        onNodeDragStart={handleNodeDragStart}
        onNodeDrag={handleNodeDrag}
        onNodeDragStop={handleNodeDragStop}
        onPaneClick={handlePaneClick}
        // 点击画布上的节点同样收起素材库/模板侧边栏
        onNodeClick={() => {
          setIsLibraryOpen(false);
          setIsTemplateOpen(false);
          setIsAgentOpen(false);
        }}
        onNodeContextMenu={(event, node) => handleNodeContextMenu(event, node as CanvasNode)}
        onDragOver={handleAssetLibraryDragOver}
        onDrop={handleCanvasDrop}
        onMove={handleMove}
        onMoveStart={handleMoveStart}
        onMoveEnd={handleMoveEnd}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={{ type: "disconnectableEdge" }}
        // 让拖拽中的连接线在距离目标 Handle 36px 内自动吸附。
        connectionRadius={36}
        defaultViewport={DEFAULT_VIEWPORT}
        minZoom={0.1}
        maxZoom={5}
        // 左/中键拖拽平移画布; 右键按住拖拽 = 框选(自定义实现, 见上方框选 effect),
        // 左键双击第二下按住拖拽的旧框选手势一并保留
        panOnDrag={[0, 1]}
        // 拖拽阈值: 移动超过 4px 才算拖动, 避免单击(想进入编辑)时轻微手抖被误判成拖动
        nodeDragThreshold={4}
        // 禁用空格临时平移(默认 Space 会让光标随按键重复闪烁)
        panActivationKeyCode={null}
        onPaneContextMenu={handleCanvasContextMenu}
        selectionMode={SelectionMode.Partial}
        multiSelectionKeyCode={["Control", "Meta"]}
        selectionKeyCode={["Control", "Meta"]}
        deleteKeyCode={null}
        onlyRenderVisibleElements
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
        className="bg-bg-dark"
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#2a2a2a" />
        <MiniMap
          className="canvas-minimap nopan nowheel !border-border-dark !bg-surface-dark"
          style={{ pointerEvents: "all", zIndex: 10000 }}
          nodeColor="rgba(120, 120, 120, 0.92)"
          maskColor="rgba(0, 0, 0, 0.62)"
          pannable
          zoomable
        />

        <SelectedNodeOverlay />
      </ReactFlow>

      {alignmentGuideLines.length > 0 && (
        <svg className="pointer-events-none absolute inset-0 z-30 h-full w-full overflow-visible">
          {alignmentGuideLines.map((line) => (
            <line
              key={line.key}
              x1={line.x1}
              y1={line.y1}
              x2={line.x2}
              y2={line.y2}
              stroke="rgba(129, 140, 248, 0.9)"
              strokeWidth="1.5"
              strokeDasharray="6 4"
            />
          ))}
        </svg>
      )}

      {isNodePaletteOpen ? (
        <NodePaletteSidebar
          open={isNodePaletteOpen}
          onToggle={() => setIsNodePaletteOpen(false)}
          onSelect={handlePaletteNodeSelect}
        />
      ) : (
        <NodePaletteToggle onClick={() => setIsNodePaletteOpen(true)} />
      )}

      {dragSelectRect && (
        <div
          className="pointer-events-none absolute z-30 border border-accent/70 bg-accent/15"
          style={{
            left: dragSelectRect.left,
            top: dragSelectRect.top,
            width: dragSelectRect.width,
            height: dragSelectRect.height,
          }}
        />
      )}

      <div className="absolute right-4 top-4 z-10 flex items-center gap-2">
        <button
          onClick={() => setIsShortcutsOpen(true)}
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-border-dark bg-surface-dark shadow-lg transition-colors text-text-dark hover:bg-bg-dark"
          title={t("canvas.toolbar.shortcuts", "快捷键设置")}
        >
          <Keyboard className="h-4 w-4 text-text-muted" />
        </button>

        <div ref={alignMenuRef} className="relative">
          <button
            onClick={() => {
              if (selectedNodeIds.length < 2) {
                // 未选中多个节点:一键让全画布节点对齐附近节点/组边框并防重叠
                const changed = snapAllNodesToNeighbors();
                if (changed) {
                  scheduleCanvasPersist(0);
                }
                return;
              }
              setIsAlignMenuOpen((open) => !open);
            }}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-border-dark bg-surface-dark shadow-lg transition-colors text-text-dark hover:bg-bg-dark"
            title={
              selectedNodeIds.length < 2
                ? t("canvas.toolbar.alignAll", "一键整理:全部节点对齐到附近节点/组的上下左右边缘,自动防重叠")
                : t("canvas.toolbar.align", "对齐选中节点")
            }
          >
            <AlignJustify className="h-4 w-4 text-text-muted" />
          </button>
          {isAlignMenuOpen && (
            <div className="absolute right-0 top-full z-20 mt-1 w-[156px] rounded-lg border border-border-dark bg-surface-dark p-1 shadow-xl">
              <div className="grid grid-cols-2 gap-0.5">
                {ALIGN_OPTIONS.map((option) => (
                  <button
                    key={option.mode}
                    type="button"
                    className="rounded px-2 py-1.5 text-left text-xs text-text-dark transition-colors hover:bg-bg-dark"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleAlign(option.mode);
                      setIsAlignMenuOpen(false);
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <button
          onClick={() => setAlignmentGuidesEnabled(!alignmentGuidesEnabled)}
          className={`flex h-9 w-9 items-center justify-center rounded-lg border border-border-dark bg-surface-dark shadow-lg transition-colors ${
            alignmentGuidesEnabled ? "text-accent ring-1 ring-accent/50" : "text-text-dark hover:bg-bg-dark"
          }`}
          title={
            alignmentGuidesEnabled
              ? t("canvas.toolbar.alignmentGuidesOn", "关闭对齐辅助线")
              : t("canvas.toolbar.alignmentGuidesOff", "开启对齐辅助线")
          }
        >
          <Crosshair className="h-4 w-4 text-text-muted" />
        </button>

        <button
          type="button"
          onClick={handleOpenTemplates}
          className="flex h-9 items-center gap-1.5 rounded-lg border border-border-dark bg-surface-dark px-3 text-sm font-medium text-text-dark shadow-lg transition-colors hover:bg-bg-dark"
          title={t("canvas.toolbar.templates", "模板")}
        >
          <LayoutTemplate className="h-4 w-4 text-text-muted" />
          <span className="hidden sm:inline">{t("canvas.toolbar.templates", "模板")}</span>
        </button>
        <button
          onClick={() => setIsLibraryOpen(true)}
          className="flex h-9 items-center gap-1.5 rounded-lg border border-border-dark bg-surface-dark px-3 text-sm font-medium text-text-dark shadow-lg transition-colors hover:bg-bg-dark"
          title={t("canvas.toolbar.library", "素材库")}
        >
          <Library className="h-4 w-4 text-text-muted" />
          <span className="hidden sm:inline">{t("canvas.toolbar.library", "素材库")}</span>
        </button>
        <button
          type="button"
          onClick={() => setIsAgentOpen((open) => !open)}
          className={`flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium shadow-lg transition-colors ${isAgentOpen ? "border-accent bg-accent/15 text-accent" : "border-border-dark bg-surface-dark text-text-dark hover:bg-bg-dark"}`}
          title="AI Agent"
        >
          <Bot className="h-4 w-4 text-accent" />
          <span>AI Agent</span>
        </button>
        <button
          onClick={() => setIsVideoExtractOpen(true)}
          className="flex h-9 items-center gap-1.5 rounded-lg border border-border-dark bg-surface-dark px-3 text-sm font-medium text-text-dark shadow-lg transition-colors hover:bg-bg-dark"
          title={t("canvas.toolbar.videoExtract", "视频帧抽取")}
        >
          <Film className="h-4 w-4 text-text-muted" />
          <span className="hidden sm:inline">{t("canvas.toolbar.videoExtract", "视频帧抽取")}</span>
        </button>
      </div>

      {nodes.length === 0 && emptyHint}

      {showNodeMenu && previewConnectionVisual && (
        <svg
          className="pointer-events-none absolute z-40 overflow-visible"
          style={{
            left: previewConnectionVisual.left,
            top: previewConnectionVisual.top,
            width: previewConnectionVisual.width,
            height: previewConnectionVisual.height,
          }}
          width={previewConnectionVisual.width}
          height={previewConnectionVisual.height}
        >
          <path
            className="pointer-events-none"
            d={previewConnectionVisual.d}
            fill="none"
            stroke={previewConnectionVisual.stroke}
            strokeWidth={previewConnectionVisual.strokeWidth}
            strokeLinecap={previewConnectionVisual.strokeLinecap}
          />
        </svg>
      )}

      {showNodeMenu && (
        <NodeSelectionMenu
          position={menuPosition}
          allowedTypes={menuAllowedTypes}
          onSelect={handleNodeSelect}
          onClose={() => {
            setShowNodeMenu(false);
            setMenuAllowedTypes(undefined);
            setPendingConnectStart(null);
            setPreviewConnectionVisual(null);
          }}
        />
      )}

      {canvasContextMenu && (
        <CanvasContextMenu
          position={canvasContextMenu.position}
          imageUrl={canvasContextMenu.imageUrl}
          downloadUrl={canvasContextMenu.downloadUrl}
          downloadMediaType={canvasContextMenu.downloadMediaType}
          nodeId={canvasContextMenu.nodeId}
          textContent={canvasContextMenu.textContent}
          canPaste={Boolean(copiedSnapshotRef.current?.nodes.length)}
          categories={activeAssetLibraryCategories}
          failedNodeCount={failedGenerationNodeIds.length}
          onClearFailedNodes={handleClearFailedNodes}
          onCopyNode={handleContextCopyNode}
          onSaveTextToPrompt={handleContextSaveTextToPrompt}
          onPaste={handleContextPaste}
          onAddImageToLibrary={handleAddImageToLibrary}
          onDownloadMedia={handleContextDownloadMedia}
          onClose={() => setCanvasContextMenu(null)}
        />
      )}

      <NodeToolDialog />

      <ImageViewerModal
        open={imageViewer.isOpen}
        imageUrl={imageViewer.currentImageUrl || ""}
        imageList={imageViewer.imageList}
        currentIndex={imageViewer.currentIndex}
        onClose={closeImageViewer}
        onNavigate={navigateImageViewer}
      />

      <AssetLibraryPanel
        open={isLibraryOpen}
        onClose={() => setIsLibraryOpen(false)}
        onApplyPrompt={handleApplyPromptTemplate}
        cinematicAssetLibrary={cinematicAssetLibrary}
      />

      <TemplateSidebar open={isTemplateOpen} onClose={() => setIsTemplateOpen(false)} />

      <VideoFrameExtractDialog open={isVideoExtractOpen} onClose={() => setIsVideoExtractOpen(false)} />

      <AgentPanel open={isAgentOpen} onClose={() => setIsAgentOpen(false)} />

      <ShortcutSettingsDialog open={isShortcutsOpen} onClose={() => setIsShortcutsOpen(false)} />

      <UiModal
        isOpen={Boolean(saveTextPromptDialog)}
        title={t("canvas.saveTextPrompt.title", "保存到提示词库")}
        onClose={() => setSaveTextPromptDialog(null)}
        footer={
          <>
            <UiButton variant="muted" size="sm" onClick={() => setSaveTextPromptDialog(null)}>
              {t("common.cancel")}
            </UiButton>
            <UiButton
              variant="primary"
              size="sm"
              disabled={!saveTextPromptDialog?.name.trim() || !saveTextPromptDialog?.content.trim()}
              onClick={handleSaveTextPrompt}
            >
              {t("common.save")}
            </UiButton>
          </>
        }
      >
        <div className="space-y-3">
          <label className="block text-xs text-text-muted">
            {t("canvas.saveTextPrompt.name", "提示词名称")}
            <UiInput
              autoFocus
              value={saveTextPromptDialog?.name ?? ""}
              placeholder={t("promptLibrary.namePlaceholder", "提示词名称")}
              onChange={(event) =>
                setSaveTextPromptDialog((current) => (current ? { ...current, name: event.target.value } : current))
              }
              onKeyDown={(event) => {
                if (event.key === "Enter" && saveTextPromptDialog?.name.trim() && saveTextPromptDialog.content.trim()) {
                  event.preventDefault();
                  handleSaveTextPrompt();
                }
              }}
              className="mt-1.5"
            />
          </label>
          <div className="rounded-lg border border-border-dark bg-bg-dark/60 px-3 py-2">
            <div className="mb-1 text-[11px] text-text-muted">{t("canvas.saveTextPrompt.content", "提示词内容")}</div>
            <div className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-5 text-text-dark">
              {saveTextPromptDialog?.content ?? ""}
            </div>
          </div>
        </div>
      </UiModal>

      <UiModal
        isOpen={Boolean(groupNameDialog)}
        title={t(groupNameDialog?.mode === "rename" ? "canvas.groupDialog.renameTitle" : "canvas.groupDialog.title")}
        onClose={() => setGroupNameDialog(null)}
        footer={
          <>
            <UiButton variant="muted" size="sm" onClick={() => setGroupNameDialog(null)}>
              {t("common.cancel")}
            </UiButton>
            <UiButton
              variant="primary"
              size="sm"
              disabled={!groupNameDialog?.name.trim()}
              onClick={confirmGroupCreation}
            >
              {t("common.confirm")}
            </UiButton>
          </>
        }
      >
        <UiInput
          autoFocus
          value={groupNameDialog?.name ?? ""}
          placeholder={t("canvas.groupDialog.placeholder")}
          onChange={(event) =>
            setGroupNameDialog((current) => (current ? { ...current, name: event.target.value } : current))
          }
          onKeyDown={(event) => {
            if (event.key === "Enter" && groupNameDialog?.name.trim()) {
              event.preventDefault();
              confirmGroupCreation();
            }
          }}
        />
      </UiModal>
    </div>
  );
}
