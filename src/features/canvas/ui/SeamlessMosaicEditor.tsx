import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  ChevronUp,
  CircleDashed,
  Crop,
  Download,
  Eye,
  EyeOff,
  ImagePlus,
  Lasso,
  Lock,
  LockOpen,
  Maximize2,
  Move,
  RotateCw,
  SquareDashedMousePointer,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { v4 as uuidv4 } from "uuid";

import type {
  MosaicBlendMode,
  MosaicLayerItem,
  MosaicTemplateId,
  SeamlessMosaicNodeData,
} from "@/features/canvas/domain/canvasNodes";
import { MOSAIC_BLEND_MODE_OPTIONS, normalizeRotation } from "@/features/canvas/domain/mosaicBlend";
import {
  fitCanvasToSingleLayer,
  initialLayerBox,
  layerFillRect,
  layerImageAspect,
} from "@/features/canvas/application/mosaicFit";
import { MosaicAdjustPanel } from "@/features/canvas/ui/MosaicAdjustPanel";
import { isAdjustIdentity } from "@/features/canvas/domain/mosaicAdjust";
import { useAdjustedPreview } from "@/features/canvas/ui/useAdjustedPreview";
import { renderMosaicToCanvas } from "@/features/canvas/application/mosaicRender";
import { snapLayerPosition } from "@/features/canvas/application/layerSnap";
import { restoreNodeAfterMosaicEdit } from "@/features/canvas/application/openMosaicEditor";
import {
  combineSelectionMasks,
  invertSelectionMask,
  maskToBoundaryPoints,
  maskToDataUrl,
  maskToLayerDataUrl,
  selectionToMask,
  type Mask,
  type Selection,
  type SelectionCombine,
} from "@/features/canvas/application/selection";
import { renderLayerToCanvas } from "@/features/canvas/application/mosaicRender";
import { SelectionOutline, SELECTION_ANTS_CSS } from "./SelectionOutline";
import {
  prepareNodeImage,
  prepareNodeImageFromFile,
  resolveImageDisplayUrl,
} from "@/features/canvas/application/imageData";
import { useCanvasStore } from "@/stores/canvasStore";

export const MOSAIC_TEMPLATES: { id: MosaicTemplateId; label: string }[] = [
  { id: "grid", label: "网格" },
  { id: "h-strip", label: "横向长图" },
  { id: "v-strip", label: "竖向长图" },
  { id: "free", label: "自由" },
];

function fitLayerWithinBounds(
  layer: MosaicLayerItem,
  x: number,
  y: number,
  maxWidth: number,
  maxHeight: number,
): MosaicLayerItem {
  const aspectRatio = layerImageAspect(layer);
  const width = Math.max(1, Math.min(maxWidth, maxHeight * aspectRatio));
  const height = Math.max(1, Math.min(maxHeight, maxWidth / aspectRatio));
  return {
    ...layer,
    x: x + (maxWidth - width) / 2,
    y: y + (maxHeight - height) / 2,
    width,
    height,
  };
}

/** 按模板重新计算图层位置(不改变 order/可见性) */
export function layoutMosaicLayers(
  layers: MosaicLayerItem[],
  template: MosaicTemplateId,
  canvasWidth: number,
  canvasHeight: number,
  gridCols: number,
  gridRows: number,
  gap: number,
): MosaicLayerItem[] {
  if (template === "free" || layers.length === 0) {
    return layers;
  }

  if (template === "grid") {
    const cols = Math.min(layers.length, Math.max(1, gridCols));
    const rows = Math.max(Math.ceil(layers.length / cols), Math.max(1, gridRows));
    const cellW = Math.max(16, (canvasWidth - gap * (cols + 1)) / cols);
    const cellH = Math.max(16, (canvasHeight - gap * (rows + 1)) / rows);
    return layers.map((layer, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      return fitLayerWithinBounds(layer, gap + col * (cellW + gap), gap + row * (cellH + gap), cellW, cellH);
    });
  }

  const horizontal = template === "h-strip";
  const count = Math.max(1, layers.length);
  const slot = Math.max(
    16,
    horizontal ? (canvasWidth - gap * (count + 1)) / count : (canvasHeight - gap * (count + 1)) / count,
  );
  return layers.map((layer, index) =>
    fitLayerWithinBounds(
      layer,
      horizontal ? gap + index * (slot + gap) : gap,
      horizontal ? gap : gap + index * (slot + gap),
      horizontal ? slot : canvasWidth - gap * 2,
      horizontal ? canvasHeight - gap * 2 : slot,
    ),
  );
}

interface CanvasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 裁剪画布：参考项目的 `crop_doc` —— 画布原点移到裁剪框左上角，所有图层整体平移。
 *
 * **不缩放、不改图层尺寸、不写 `layer.crop`**：裁掉的像素只是落在画布外，
 * 画面内容因此不会变形，往外移回来也还能看到。
 */
export function cropCanvasTo(
  layers: readonly MosaicLayerItem[],
  frame: CanvasRect,
): { layers: MosaicLayerItem[]; width: number; height: number } {
  const x = Math.round(frame.x);
  const y = Math.round(frame.y);
  return {
    layers: layers.map((layer) => ({ ...layer, x: layer.x - x, y: layer.y - y })),
    width: Math.max(1, Math.round(frame.width)),
    height: Math.max(1, Math.round(frame.height)),
  };
}

function rectFromPoints(ax: number, ay: number, bx: number, by: number): CanvasRect {
  return {
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    width: Math.abs(bx - ax),
    height: Math.abs(by - ay),
  };
}

interface CropRatioPreset {
  id: string;
  label: string;
  /** 输出宽高比；null = 自由。 */
  aspect: number | null;
}

const CROP_RATIOS: CropRatioPreset[] = [
  { id: "free", label: "自由", aspect: null },
  { id: "original", label: "原始比例", aspect: -1 },
  { id: "1:1", label: "1 : 1", aspect: 1 },
  { id: "4:3", label: "4 : 3", aspect: 4 / 3 },
  { id: "3:2", label: "3 : 2", aspect: 3 / 2 },
  { id: "16:9", label: "16 : 9", aspect: 16 / 9 },
  { id: "9:16", label: "9 : 16", aspect: 9 / 16 },
  { id: "3:4", label: "3 : 4", aspect: 3 / 4 },
  { id: "2:3", label: "2 : 3", aspect: 2 / 3 },
];

type ToolId =
  | "move"
  | "crop"
  | "select-rect"
  | "select-ellipse"
  | "select-lasso";

type DragKind =
  | "move"
  | "resize"
  | "crop-move"
  | "crop-handle"
  | "crop-draw"
  | "select-draw";

interface DragState {
  kind: DragKind;
  layerId?: string;
  startX: number;
  startY: number;
  origin: CanvasRect;
  handle?: string;
  baseFrame?: CanvasRect;
  anchorX?: number;
  anchorY?: number;
  baseLayers: MosaicLayerItem[];
  ratio: number;
  /** 套索绘制时的锚点轨迹（画布像素）。 */
  lassoPoints?: Array<{ x: number; y: number }>;
  /** 选择工具的布尔组合模式（Shift=加 / Alt=减 / Shift+Alt=交）。 */
  selectionCombine?: "new" | "add" | "subtract" | "intersect";
  /** 拖拽中实时更新的选区（松手时从这里取最终值做布尔合并）。 */
  currentSelection?: Selection | null;
}

const HANDLE_CURSOR: Record<string, string> = {
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  nw: "nwse-resize",
  se: "nwse-resize",
};

const MIN_FRAME = 8;

/** 移动图层时的吸附阈值（屏幕像素）。放大画布时阈值折算成更小的画布像素，手感一致。 */
const LAYER_SNAP_PX = 6;
/**
 * 编辑器里的单个图层。
 *
 * 单独抽出来是因为要调 `useAdjustedPreview`（hooks 不能写在 map 里）：
 * 调整参数变了就换成处理过的预览图，源文件不动。
 */
/**
 * 编辑器画布的「停手后清晰档」长边。
 *
 * 720（节点内预览的默认值）在铺满屏幕的画布上明显发糊 —— 用户的反馈就是
 * 「图片编辑里面画面比较模糊」。1600 够覆盖 2× 缩放的常见屏幕宽度，
 * 又不至于让调整管线的单帧耗时失控（720 约 160ms，1600 在一秒内）。
 */
const EDITOR_PREVIEW_MAX_EDGE = 1600;

function EditorLayerView({
  layer,
  scale,
  active,
  tool,
  onPointerDown,
}: {
  layer: MosaicLayerItem;
  scale: number;
  active: boolean;
  tool: ToolId;
  onPointerDown: (event: ReactPointerEvent) => void;
}) {
  const source = useAdjustedPreview(layer, { preferFullImage: true, maxEdge: EDITOR_PREVIEW_MAX_EDGE });
  const fill = layerFillRect(layer);
  // 光标随工具变化：移动工具才用抓手，选择/裁剪工具用十字准星（穿透到画板，框选不受图层阻挡）。
  const cursor =
    tool === "move"
      ? layer.locked
        ? "default"
        : "move"
      : tool === "crop" || tool === "select-rect" || tool === "select-ellipse" || tool === "select-lasso"
        ? "crosshair"
        : "default";
  return (
    <div
      className="absolute overflow-hidden"
      style={{
        left: layer.x * scale,
        top: layer.y * scale,
        width: Math.max(1, layer.width * scale),
        height: Math.max(1, layer.height * scale),
        opacity: layer.opacity ?? 1,
        mixBlendMode: layer.blendMode ?? "normal",
        transform: layer.rotation ? `rotate(${layer.rotation}deg)` : undefined,
        transformOrigin: "center",
        outline: active ? "1.5px solid #0a84ff" : undefined,
        cursor,
      }}
      onPointerDown={onPointerDown}
    >
      <img
        src={resolveImageDisplayUrl(source)}
        alt=""
        draggable={false}
        className="pointer-events-none absolute object-contain"
        style={{
          left: `${((fill.x - layer.x) / layer.width) * 100}%`,
          top: `${((fill.y - layer.y) / layer.height) * 100}%`,
          width: `${(fill.width / layer.width) * 100}%`,
          height: `${(fill.height / layer.height) * 100}%`,
        }}
      />
    </div>
  );
}

interface SeamlessMosaicEditorProps {
  nodeId: string;
  data: SeamlessMosaicNodeData;
  onClose: () => void;
  /** 画布比例变了（裁剪后）→ 让节点框跟着换比例，预览才不会被拉扁。 */
  onSyncFrame?: (aspect: number) => void;
}

/**
 * 图片编辑（全屏）。
 *
 * 版式照参考项目：顶部标题栏 / 选项栏、左侧工具条、中间画板、右侧属性 + 图层面板、底部状态栏。
 *
 * 裁剪照参考项目做成**画布级**（`crop_doc` 语义）：
 * 框默认等于整张画布，拖框 = 选范围，应用后画布尺寸变成框的大小、所有图层整体平移。
 * 图层自身尺寸与像素一个都不动，所以不会变形；裁掉的只是「落在画布外」。
 */
export function SeamlessMosaicEditor({ nodeId, data, onClose, onSyncFrame }: SeamlessMosaicEditorProps) {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const addDerivedExportNode = useCanvasStore((state) => state.addDerivedExportNode);
  const addEdge = useCanvasStore((state) => state.addEdge);

  // 默认是矩形选框（用户要求：打开编辑器先框选，而不是移动图层）。
  const [tool, setTool] = useState<ToolId>("select-rect");
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  const [frame, setFrame] = useState<CanvasRect | null>(null);
  /** 框被用户动过没有：没动过就是「整张画布」，应用等于什么都不做（同参考项目的 default frame）。 */
  const [frameEdited, setFrameEdited] = useState(false);
  const [cropRatioId, setCropRatioId] = useState("free");
  /** 选择工具的选区（蚂蚁线）。null = 没有选区。 */
  const [selection, setSelection] = useState<Selection | null>(null);
  /** 套索绘制中的临时轨迹（画布像素），用于实时显示正在画的套索轮廓。 */
  const [lassoDraft, setLassoDraft] = useState<Array<{ x: number; y: number }> | null>(null);
  /** 反选/布尔运算后的边界点集（掩码提取），优先于点阵渲染蚂蚁线。 */
  const [selectionBoundary, setSelectionBoundary] = useState<Array<{ x: number; y: number }> | null>(null);
  /** 当前选区固化的掩码（布尔运算的「旧选区」来源）。ref 避免每帧 setState。 */
  const selectionMaskRef = useRef<Mask | null>(null);
  /** 删除选中内容前的图层快照（会话内撤销用）。 */
  const eraseSnapshotRef = useRef<MosaicLayerItem | null>(null);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [fitScale, setFitScale] = useState(0.5);
  const [draftLayers, setDraftLayers] = useState<MosaicLayerItem[] | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [panelTab, setPanelTab] = useState<"props" | "adjust">("props");

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const artboardRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<DragState | null>(null);

  const canvasWidth = Math.max(1, data.canvasWidth || 1920);
  const canvasHeight = Math.max(1, data.canvasHeight || 1080);
  const layers = useMemo(
    () => [...(draftLayers ?? data.layers ?? [])].sort((a, b) => a.order - b.order),
    [data.layers, draftLayers],
  );
  const visibleCount = layers.filter((layer) => layer.visible).length;
  const selectedLayer = layers.find((layer) => layer.id === selectedLayerId) ?? null;
  const scale = zoom === "fit" ? fitScale : zoom;
  // 直方图要「已调整」的图：拿选中图层的缩略图算一份。
  const selectedPreviewUrl = useAdjustedPreview(
    selectedLayer ?? { imageUrl: "", previewImageUrl: null, adjust: undefined },
  );

  /**
   * 单图层历史数据自愈：画幅被节点缩放放大过、图片还留在原来的像素尺寸上。
   *
   * 打开编辑器就是「一张小图贴在大画布里」，与用户说的「图片和显示框尺寸不一致」
   * 完全是同一件事。只在挂载时跑一次，并且**必须**比例基本一致才动手 ——
   * 比例不同说明画幅是用户刻意做出来的版面，不能替他改。
   */
  const pageFitOnceRef = useRef(false);
  useEffect(() => {
    if (pageFitOnceRef.current) {
      return;
    }
    pageFitOnceRef.current = true;
    const list = data.layers ?? [];
    if (list.length !== 1 || !data.canvasFitted) {
      return;
    }
    const layer = list[0];
    const layerAspect = (layer.width || 1) / (layer.height || 1);
    const canvasAspect = (data.canvasWidth || 1) / (data.canvasHeight || 1);
    if (Math.abs(layerAspect - canvasAspect) > 0.02) {
      return;
    }
    // 已经铺满了就别动（含浮点误差）。
    if (layer.width >= data.canvasWidth * 0.99 && layer.height >= data.canvasHeight * 0.99) {
      return;
    }
    const fitted = fitCanvasToSingleLayer(list, data.canvasWidth, data.canvasHeight);
    if (!fitted) {
      return;
    }
    updateNodeData(nodeId, {
      layers: fitted.layers,
      canvasWidth: fitted.width,
      canvasHeight: fitted.height,
      canvasFitted: true,
    });
    onSyncFrame?.(fitted.width / fitted.height);
  }, [
    data.canvasFitted,
    data.canvasHeight,
    data.canvasWidth,
    data.layers,
    nodeId,
    onSyncFrame,
    updateNodeData,
  ]);

  /**
   * 默认选中一个图层。
   *
   * 调整面板、属性面板都只对「选中图层」生效，一进来什么都没选的话
   * 拖滑块完全没反应 —— 看起来就像坏了一样。所以打开就先选中顶层那张。
   */
  const autoSelectedRef = useRef(false);
  useEffect(() => {
    if (layers.length === 0) return;
    if (!autoSelectedRef.current) {
      autoSelectedRef.current = true;
      if (!selectedLayerId) {
        const top = [...layers].reverse().find((layer) => layer.visible) ?? layers[layers.length - 1];
        setSelectedLayerId(top?.id ?? null);
      }
      return;
    }
    // 当前选中的图层被删掉了 → 补选一个
    if (selectedLayerId && layers.some((layer) => layer.id === selectedLayerId)) return;
    const fallback = [...layers].reverse().find((layer) => layer.visible) ?? layers[layers.length - 1];
    setSelectedLayerId(fallback?.id ?? null);
  }, [layers, selectedLayerId]);

  /* ------------------------------- 视口自适应 ------------------------------- */
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      const next = Math.min((rect.width - 64) / canvasWidth, (rect.height - 64) / canvasHeight, 2);
      setFitScale(Number.isFinite(next) && next > 0.02 ? next : 0.2);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [canvasHeight, canvasWidth]);

  const writeLayers = useCallback(
    (next: MosaicLayerItem[]) => {
      updateNodeData(nodeId, {
        layers: next,
        outputImageUrl: null,
        outputPreviewImageUrl: null,
      });
    },
    [nodeId, updateNodeData],
  );

  /* -------------------------------- 裁剪操作 -------------------------------- */
  const ratioForPreset = useCallback(
    (presetId: string): number => {
      const preset = CROP_RATIOS.find((item) => item.id === presetId);
      if (!preset || preset.aspect === null) return 0;
      // 画布像素就是成片像素，预设比例可以直接用。
      return preset.aspect === -1 ? canvasWidth / canvasHeight : preset.aspect;
    },
    [canvasHeight, canvasWidth],
  );

  const startCrop = useCallback(() => {
    setTool("crop");
    setCropRatioId("free");
    // 进来就让裁剪框 = 整张画布，且直接处于「可编辑」状态：
    // 八向锚点立即显示，用户可以直接拖四边 / 四角精细调整，不用先手动拉一个框。
    setFrame({ x: 0, y: 0, width: canvasWidth, height: canvasHeight });
    setFrameEdited(true);
    setNotice("拖动边框上的锚点精细调整裁剪范围，Enter 应用，Esc 取消");
  }, [canvasHeight, canvasWidth]);

  const cancelCrop = useCallback(() => {
    setTool("move");
    setFrame(null);
    setFrameEdited(false);
    setNotice(null);
  }, []);

  /** 反选：把当前选区反转（画布内选区外变选中）。结果固化成掩码边界点。 */
  const invertSelection = useCallback(() => {
    if (!selection && !selectionBoundary) {
      return;
    }
    const mask = selection ? selectionToMask(selection, canvasWidth, canvasHeight) : selectionMaskRef.current!;
    const inverted = invertSelectionMask(mask);
    selectionMaskRef.current = inverted;
    setSelectionBoundary(maskToBoundaryPoints(inverted));
    setSelection(null);
    setNotice("已反选选区");
  }, [canvasHeight, canvasWidth, selection, selectionBoundary]);

  /** 调整羽化半径（画布像素）。改完同步固化掩码，后续布尔/反选基于带羽化的软边。 */
  const setSelectionFeather = useCallback(
    (feather: number) => {
      if (!selection) {
        return;
      }
      const next = { ...selection, feather: Math.max(0, feather) };
      setSelection(next);
      selectionMaskRef.current = selectionToMask(next, canvasWidth, canvasHeight);
    },
    [canvasHeight, canvasWidth, selection],
  );

  const applyRatioPreset = useCallback(
    (presetId: string) => {
      setCropRatioId(presetId);
      const ratio = ratioForPreset(presetId);
      if (!ratio || !frame) return;
      let width = frame.width;
      let height = width / ratio;
      if (height > canvasHeight) {
        height = canvasHeight;
        width = height * ratio;
      }
      if (width > canvasWidth) {
        width = canvasWidth;
        height = width / ratio;
      }
      const centerX = frame.x + frame.width / 2;
      const centerY = frame.y + frame.height / 2;
      setFrame({
        x: Math.min(canvasWidth - width, Math.max(0, centerX - width / 2)),
        y: Math.min(canvasHeight - height, Math.max(0, centerY - height / 2)),
        width,
        height,
      });
      setFrameEdited(true);
    },
    [canvasHeight, canvasWidth, frame, ratioForPreset],
  );

  /* -------------------------------- 拖拽交互 -------------------------------- */
  useEffect(() => {
    const handleMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      event.preventDefault();
      const dx = (event.clientX - drag.startX) / Math.max(0.0001, scale);
      const dy = (event.clientY - drag.startY) / Math.max(0.0001, scale);

      if (drag.kind === "move") {
        const moving = drag.baseLayers.find((item) => item.id === drag.layerId);
        if (!moving) return;
        // 先算无吸附的落点，再套吸附：吸附到画布四边 / 中心线 / 其它图层边缘。
        const rawX = drag.origin.x + dx;
        const rawY = drag.origin.y + dy;
        const others = drag.baseLayers.filter((item) => item.id !== drag.layerId);
        const snapped = snapLayerPosition(
          { ...moving, x: rawX, y: rawY },
          canvasWidth,
          canvasHeight,
          others,
          LAYER_SNAP_PX / Math.max(0.0001, scale),
        );
        setDraftLayers(
          drag.baseLayers.map((layer) =>
            layer.id === drag.layerId
              ? {
                  ...layer,
                  x: Math.round(snapped.x),
                  y: Math.round(snapped.y),
                }
              : layer,
          ),
        );
        return;
      }

      if (drag.kind === "resize") {
        const layer = drag.baseLayers.find((item) => item.id === drag.layerId);
        if (!layer) return;
        const aspect = layerImageAspect(layer);
        const width = Math.max(MIN_FRAME, Math.round(drag.origin.width + dx));
        setDraftLayers(
          drag.baseLayers.map((item) =>
            item.id === drag.layerId
              ? { ...item, width, height: Math.max(MIN_FRAME, Math.round(width / aspect)) }
              : item,
          ),
        );
        return;
      }

      if (drag.kind === "crop-draw") {
        const ax = drag.anchorX ?? 0;
        const ay = drag.anchorY ?? 0;
        const px = Math.min(canvasWidth, Math.max(0, ax + dx));
        const py = Math.min(canvasHeight, Math.max(0, ay + dy));
        let next = rectFromPoints(ax, ay, px, py);
        if (drag.ratio > 0 && next.width > 0) {
          // 锁比例时以按下的那个点为一角，高度由宽度反算。
          const height = next.width / drag.ratio;
          next = {
            x: px >= ax ? ax : ax - next.width,
            y: py >= ay ? ay : ay - height,
            width: next.width,
            height,
          };
          if (next.x < 0) next.x = 0;
          if (next.y < 0) next.y = 0;
          if (next.x + next.width > canvasWidth) next.width = canvasWidth - next.x;
          if (next.y + next.height > canvasHeight) next.height = canvasHeight - next.y;
        }
        setFrame(next);
        setFrameEdited(true);
        return;
      }

      if (drag.kind === "select-draw") {
        const ax = drag.anchorX ?? 0;
        const ay = drag.anchorY ?? 0;
        const px = Math.min(canvasWidth, Math.max(0, ax + dx));
        const py = Math.min(canvasHeight, Math.max(0, ay + dy));
        if (tool === "select-lasso") {
          // 套索：把当前指针位置追加到轨迹，实时显示轮廓。
          const points = [...(drag.lassoPoints ?? [{ x: ax, y: ay }])];
          points.push({ x: px, y: py });
          drag.lassoPoints = points;
          setLassoDraft(points);
          return;
        }
        // 矩形 / 椭圆：由对角点确定，实时更新选区，并把最新选区记进 drag（松手合并用）。
        const rect = rectFromPoints(ax, ay, px, py);
        const nextSelection: Selection = {
          shape:
            tool === "select-ellipse"
              ? { kind: "ellipse", ...rect }
              : { kind: "rect", ...rect },
          feather: 0,
        };
        drag.currentSelection = nextSelection;
        setSelection(nextSelection);
        return;
      }

      const base = drag.baseFrame;
      if (!base) return;

      if (drag.kind === "crop-move") {
        const maxX = canvasWidth - base.width;
        const maxY = canvasHeight - base.height;
        setFrame({
          ...base,
          x: Math.min(maxX, Math.max(0, Math.round(base.x + dx))),
          y: Math.min(maxY, Math.max(0, Math.round(base.y + dy))),
        });
        setFrameEdited(true);
        return;
      }

      // crop-handle
      const handle = drag.handle ?? "se";
      let left = base.x;
      let top = base.y;
      let right = base.x + base.width;
      let bottom = base.y + base.height;
      if (handle.includes("w")) left = Math.min(right - MIN_FRAME, base.x + dx);
      if (handle.includes("e")) right = Math.max(left + MIN_FRAME, base.x + base.width + dx);
      if (handle.includes("n")) top = Math.min(bottom - MIN_FRAME, base.y + dy);
      if (handle.includes("s")) bottom = Math.max(top + MIN_FRAME, base.y + base.height + dy);

      left = Math.max(0, left);
      top = Math.max(0, top);
      right = Math.min(canvasWidth, right);
      bottom = Math.min(canvasHeight, bottom);

      let width = Math.max(1, right - left);
      let height = Math.max(1, bottom - top);
      if (drag.ratio > 0) {
        height = width / drag.ratio;
        if (height > canvasHeight) {
          height = canvasHeight;
          width = height * drag.ratio;
        }
        if (handle.includes("n")) top = bottom - height;
        else if (handle.includes("s")) bottom = top + height;
        else top = base.y + (base.height - height) / 2;
        if (handle.includes("w")) left = right - width;
        else if (handle.includes("e")) right = left + width;
        else left = base.x + (base.width - width) / 2;
      }
      setFrame({
        x: Math.min(Math.max(0, left), Math.max(0, canvasWidth - width)),
        y: Math.min(Math.max(0, top), Math.max(0, canvasHeight - height)),
        width,
        height,
      });
      setFrameEdited(true);
    };

    const handleUp = () => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag) return;
      if (drag.kind === "move" || drag.kind === "resize") {
        const next = draftLayers;
        setDraftLayers(null);
        if (next) writeLayers(next);
      }
      if (drag.kind === "select-draw") {
        setLassoDraft(null);
        // 确定本次拖出的最终选区形状。
        let finalSelection: Selection | null = null;
        if (tool === "select-lasso") {
          const points = drag.lassoPoints ?? [];
          if (points.length >= 3) {
            finalSelection = { shape: { kind: "lasso", points }, feather: 0 };
          }
        } else {
          finalSelection = drag.currentSelection ?? null;
        }
        if (!finalSelection) {
          return;
        }
        // 布尔运算：Shift / Alt / Shift+Alt 时与旧选区掩码合并。
        const combine = drag.selectionCombine ?? "new";
        if (combine !== "new" && selectionMaskRef.current) {
          const nextMask = selectionToMask(finalSelection, canvasWidth, canvasHeight);
          const merged = combineSelectionMasks(selectionMaskRef.current, nextMask, combine);
          selectionMaskRef.current = merged;
          setSelectionBoundary(maskToBoundaryPoints(merged));
          setSelection(null);
        } else {
          // 新建选区：固化成掩码（后续布尔/反选都基于它）。
          selectionMaskRef.current = selectionToMask(finalSelection, canvasWidth, canvasHeight);
          setSelection(finalSelection);
          setSelectionBoundary(null);
        }
      }
    };

    window.addEventListener("pointermove", handleMove, { passive: false });
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
    };
  }, [canvasHeight, canvasWidth, draftLayers, scale, tool, writeLayers]);

  /** 画布上的 pointerdown：判定「抓手柄 / 框内移动 / 重新拖一个框 / 拉选区」。 */
  const handleCanvasPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      if (tool !== "crop" && tool !== "select-rect" && tool !== "select-ellipse" && tool !== "select-lasso") {
        setSelectedLayerId(null);
        return;
      }
      const rect = artboardRef.current?.getBoundingClientRect();
      if (!rect) return;

      // 选择工具：在画布上按下即开始拉一个选区（矩形 / 椭圆 / 套索）。
      if (tool === "select-rect" || tool === "select-ellipse" || tool === "select-lasso") {
        event.preventDefault();
        const px = (event.clientX - rect.left) / Math.max(0.0001, scale);
        const py = (event.clientY - rect.top) / Math.max(0.0001, scale);
        const anchorX = Math.max(0, Math.min(canvasWidth, px));
        const anchorY = Math.max(0, Math.min(canvasHeight, py));
        // 布尔组合：Shift 追加 / Alt 减选 / Shift+Alt 相交。有旧选区时才生效。
        const shift = event.shiftKey;
        const alt = event.altKey;
        const combine: SelectionCombine = shift && alt ? "intersect" : shift ? "add" : alt ? "subtract" : "new";
        if (combine === "new") {
          setSelection(null);
          setSelectionBoundary(null);
          selectionMaskRef.current = null;
        }
        setLassoDraft(null);
        dragRef.current = {
          kind: "select-draw",
          startX: event.clientX,
          startY: event.clientY,
          origin: { x: 0, y: 0, width: canvasWidth, height: canvasHeight },
          anchorX,
          anchorY,
          baseLayers: layers,
          ratio: 0,
          lassoPoints: tool === "select-lasso" ? [{ x: anchorX, y: anchorY }] : undefined,
          selectionCombine: combine,
        };
        return;
      }

      if (!frame) return;
      event.preventDefault();
      const px = (event.clientX - rect.left) / Math.max(0.0001, scale);
      const py = (event.clientY - rect.top) / Math.max(0.0001, scale);
      const hit = 10 / Math.max(0.0001, scale);
      const left = frame.x;
      const top = frame.y;
      const right = frame.x + frame.width;
      const bottom = frame.y + frame.height;
      const nearLeft = Math.abs(px - left) <= hit && py >= top - hit && py <= bottom + hit;
      const nearRight = Math.abs(px - right) <= hit && py >= top - hit && py <= bottom + hit;
      const nearTop = Math.abs(py - top) <= hit && px >= left - hit && px <= right + hit;
      const nearBottom = Math.abs(py - bottom) <= hit && px >= left - hit && px <= right + hit;

      const inFrame = px > left && px < right && py > top && py < bottom;

      // 未动过的默认框（整张画布）：在里面拖就是「重新拉一个框」，和参考项目一致。
      if (frameEdited && (nearLeft || nearRight || nearTop || nearBottom)) {
        const handle =
          (nearTop ? "n" : nearBottom ? "s" : "") + (nearLeft ? "w" : nearRight ? "e" : "");
        dragRef.current = {
          kind: "crop-handle",
          startX: event.clientX,
          startY: event.clientY,
          origin: { x: 0, y: 0, width: canvasWidth, height: canvasHeight },
          handle,
          baseFrame: frame,
          baseLayers: layers,
          ratio: ratioForPreset(cropRatioId),
        };
        return;
      }
      if (frameEdited && inFrame) {
        dragRef.current = {
          kind: "crop-move",
          startX: event.clientX,
          startY: event.clientY,
          origin: { x: 0, y: 0, width: canvasWidth, height: canvasHeight },
          baseFrame: frame,
          baseLayers: layers,
          ratio: 0,
        };
        return;
      }
      dragRef.current = {
        kind: "crop-draw",
        startX: event.clientX,
        startY: event.clientY,
        origin: { x: 0, y: 0, width: canvasWidth, height: canvasHeight },
        anchorX: Math.max(0, Math.min(canvasWidth, px)),
        anchorY: Math.max(0, Math.min(canvasHeight, py)),
        baseLayers: layers,
        ratio: ratioForPreset(cropRatioId),
      };
    },
    [canvasHeight, canvasWidth, cropRatioId, frame, frameEdited, layers, ratioForPreset, scale, tool],
  );

  /* ------------------------------- 图层操作 -------------------------------- */
  const patchLayer = useCallback(
    (layerId: string, patch: Partial<MosaicLayerItem>) => {
      // 从 store 读最新一份再合并。
      // 拖滑块时事件可能一帧来好几次，用渲染闭包里的 `layers` 会把上一次的修改盖掉，
      // 表现就是「跳、不跟手、松手才生效」。
      const latest = useCanvasStore.getState().nodes.find((node) => node.id === nodeId);
      const base = (latest?.data as SeamlessMosaicNodeData | undefined)?.layers ?? layers;
      writeLayers(
        (base ?? []).map((layer) => (layer.id === layerId ? { ...layer, ...patch } : layer)),
      );
    },
    [layers, nodeId, writeLayers],
  );

  /**
   * 破坏性删除选中内容：把选区覆盖的像素从「选中图层」抹成透明。
   *
   * 实现：把选中图层 bake 成一张平图（crop/adjust/rotation 都拍进去），
   * 在图层局部坐标上 `destination-out` 抹掉选区，生成的新图替换 `imageUrl`。
   * 删除前保存快照，会话内可撤销（Ctrl+Z / 状态栏「撤销删除」）。
   */
  const deleteSelection = useCallback(async () => {
    const mask = selection ? selectionToMask(selection, canvasWidth, canvasHeight) : selectionMaskRef.current;
    if (!mask) {
      return;
    }
    const target = selectedLayer ?? [...layers].reverse().find((layer) => layer.visible) ?? null;
    if (!target) {
      setNotice("没有可删除的图层");
      return;
    }
    try {
      const baked = await renderLayerToCanvas(target);
      const ctx = baked.getContext("2d");
      if (!ctx) {
        return;
      }
      // 选区掩码从画布坐标平移到图层局部坐标，再 destination-out 抹掉。
      const maskCanvas = maskToDataUrl(mask);
      ctx.globalCompositeOperation = "destination-out";
      ctx.drawImage(maskCanvas, -target.x, -target.y);
      ctx.globalCompositeOperation = "source-over";

      const nextImageUrl = baked.toDataURL("image/png");
      // 保存快照（会话内撤销）。
      eraseSnapshotRef.current = target;
      // bake 成平图后，crop/rotation/adjust 都已拍进像素，清空这些字段。
      patchLayer(target.id, {
        imageUrl: nextImageUrl,
        previewImageUrl: nextImageUrl,
        crop: null,
        rotation: 0,
        adjust: undefined,
      });
      setSelection(null);
      setSelectionBoundary(null);
      selectionMaskRef.current = null;
      setNotice("已删除选中内容（Ctrl+Z 撤销）");
    } catch (error) {
      console.error("[Mosaic] delete selection failed", error);
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }, [canvasHeight, canvasWidth, layers, patchLayer, selectedLayer, selection]);

  /** 撤销上一次删除选中内容（会话内）。 */
  const undoErase = useCallback(() => {
    const snapshot = eraseSnapshotRef.current;
    if (!snapshot) {
      setNotice("没有可撤销的删除");
      return;
    }
    eraseSnapshotRef.current = null;
    patchLayer(snapshot.id, snapshot);
    setNotice("已撤销删除");
  }, [patchLayer]);
  const moveLayerOrder = useCallback(
    (layerId: string, direction: -1 | 1) => {
      const sorted = [...layers].sort((a, b) => a.order - b.order);
      const index = sorted.findIndex((layer) => layer.id === layerId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= sorted.length) return;
      const a = sorted[index];
      const b = sorted[target];
      writeLayers(
        layers.map((layer) => {
          if (layer.id === a.id) return { ...layer, order: b.order };
          if (layer.id === b.id) return { ...layer, order: a.order };
          return layer;
        }),
      );
    },
    [layers, writeLayers],
  );

  const removeLayer = useCallback(
    (layerId: string) => {
      writeLayers(layers.filter((layer) => layer.id !== layerId));
      if (selectedLayerId === layerId) setSelectedLayerId(null);
    },
    [layers, selectedLayerId, writeLayers],
  );

  const applyTemplate = useCallback(
    (template: MosaicTemplateId) => {
      updateNodeData(nodeId, {
        template,
        layers: layoutMosaicLayers(
          layers,
          template,
          canvasWidth,
          canvasHeight,
          Math.max(1, data.gridCols ?? 3),
          Math.max(1, data.gridRows ?? 2),
          Math.max(0, data.gap ?? 8),
        ),
        outputImageUrl: null,
        outputPreviewImageUrl: null,
      });
    },
    [canvasHeight, canvasWidth, data.gap, data.gridCols, data.gridRows, layers, nodeId, updateNodeData],
  );

  const setCanvasSize = useCallback(
    (width: number, height: number) => {
      updateNodeData(nodeId, {
        canvasWidth: Math.min(8192, Math.max(64, Math.round(width))),
        canvasHeight: Math.min(8192, Math.max(64, Math.round(height))),
        outputImageUrl: null,
        outputPreviewImageUrl: null,
      });
    },
    [nodeId, updateNodeData],
  );

  const handleAddImages = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []).filter((file) => file.type.startsWith("image/"));
      event.target.value = "";
      if (files.length === 0) return;
      const added: MosaicLayerItem[] = [];
      for (const file of files) {
        try {
          const prepared = await prepareNodeImageFromFile(file);
          const box = initialLayerBox(prepared.aspectRatio);
          added.push({
            id: uuidv4(),
            imageUrl: prepared.imageUrl,
            previewImageUrl: prepared.previewImageUrl,
            sourceName: file.name,
            aspectRatio: prepared.aspectRatio,
            x: 0,
            y: 0,
            width: box.width,
            height: box.height,
            crop: null,
            visible: true,
            order: layers.length + added.length,
            opacity: 1,
          });
        } catch (error) {
          console.warn("[Mosaic] add image failed", file.name, error);
        }
      }
      if (added.length === 0) {
        setNotice("图片添加失败");
        return;
      }
      updateNodeData(nodeId, {
        layers: [...layers, ...added],
        outputImageUrl: null,
        outputPreviewImageUrl: null,
      });
    },
    [layers, nodeId, updateNodeData],
  );

  /* -------------------------------- 应用（导出成新节点） --------------------------------- */
  const handleExport = useCallback(async () => {
    if (isExporting) return;
    // 裁剪模式下先落实裁剪，再基于裁剪后的画布导出。
    let base = data;
    if (tool === "crop" && frame && frameEdited) {
      if (frame.width < 16 || frame.height < 16) {
        setNotice("裁剪框太小了，再拉大一点");
        return;
      }
      const cropped = cropCanvasTo(layers, frame);
      base = { ...data, layers: cropped.layers, canvasWidth: cropped.width, canvasHeight: cropped.height };
    }
    setIsExporting(true);
    setNotice(null);
    try {
      const { canvas } = await renderMosaicToCanvas(base);
      const prepared = await prepareNodeImage(canvas.toDataURL("image/png"));
      // 应用 = 把结果作为**新节点**生成到下游并连线，绝不替换/回写原节点。
      // 母节点尺寸与位置全程没动过，`findNodePosition` 对齐自然正确。
      const createdNodeId = addDerivedExportNode(
        nodeId,
        prepared.imageUrl,
        prepared.aspectRatio,
        prepared.previewImageUrl,
        {
          defaultTitle: "图片编辑",
          resultKind: "generic",
          aspectRatioStrategy: "provided",
          sizeStrategy: "autoMinEdge",
        },
      );
      if (createdNodeId) addEdge(nodeId, createdNodeId);
      // 先确定性还原节点类型（临时会话 → 原图片节点），再关编辑器。
      // 不能依赖 onClose 里的还原：onClose 是节点组件传进来的闭包，这里显式调一次最稳，
      // onClose 里的第二次调用会因快照已删而空操作。
      restoreNodeAfterMosaicEdit(nodeId);
      onClose();
    } catch (error) {
      console.error("[Mosaic] export failed", error);
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setIsExporting(false);
    }
  }, [
    addDerivedExportNode,
    addEdge,
    data,
    frame,
    frameEdited,
    isExporting,
    layers,
    nodeId,
    onClose,
    tool,
  ]);

  /* -------------------------------- 快捷键 -------------------------------- */
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (event.key === "Escape") {
        if (tool === "crop") cancelCrop();
        else if (tool === "select-rect" || tool === "select-ellipse" || tool === "select-lasso") {
          // 选择工具下 Esc 先取消选区，再 Esc 才关编辑器（和 Photoshop 一致）。
          if (selection || lassoDraft || selectionBoundary) {
            setSelection(null);
            setSelectionBoundary(null);
            setLassoDraft(null);
            selectionMaskRef.current = null;
          } else {
            onClose();
          }
        } else onClose();
        return;
      }
      if (event.key === "Enter" && tool === "crop") {
        event.preventDefault();
        // 与标题栏「应用」一致：裁剪生效并导出成新节点。
        void handleExport();
        return;
      }
      if (event.key === "v" || event.key === "V") setTool("move");
      if (event.key === "c" || event.key === "C") startCrop();
      if (event.key === "m" || event.key === "M") setTool("select-rect");
      if (event.key === "l" || event.key === "L") setTool("select-lasso");
      if (event.key === "Delete" || event.key === "Backspace") {
        // Delete 只删除选区内的内容（破坏性，会话内可 Ctrl+Z 撤销）；无选区时不做删图层。
        if (selection || selectionBoundary) {
          event.preventDefault();
          void deleteSelection();
        }
      }
      // Ctrl+Z：会话内撤销删除（破坏性删除的后悔药）。
      if ((event.ctrlKey || event.metaKey) && (event.key === "z" || event.key === "Z")) {
        event.preventDefault();
        undoErase();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [
    cancelCrop,
    deleteSelection,
    handleExport,
    lassoDraft,
    onClose,
    selection,
    selectionBoundary,
    startCrop,
    tool,
    undoErase,
  ]);

  const beginLayerDrag = useCallback(
    (event: ReactPointerEvent, kind: DragKind, layer: MosaicLayerItem) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      setSelectedLayerId(layer.id);
      dragRef.current = {
        kind,
        layerId: layer.id,
        startX: event.clientX,
        startY: event.clientY,
        origin: { x: layer.x, y: layer.y, width: layer.width, height: layer.height },
        baseLayers: layers,
        ratio: 0,
      };
    },
    [layers],
  );

  const frameSize = frame ? { width: Math.round(frame.width), height: Math.round(frame.height) } : null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-[#1e1e1e] text-[13px] text-[#d6d6d6]">
      <style>{SELECTION_ANTS_CSS}</style>
      {/* 标题栏 */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-black/50 bg-[#323233] px-3">
        <div className="flex items-center gap-2 text-[12px] text-[#a8a8a8]">
          <span className="rounded bg-[#3a3a3b] px-2 py-0.5 text-[#e6e6e6]">
            {data.displayName || "图片编辑"}
          </span>
          <span>
            {Math.round(canvasWidth)} × {Math.round(canvasHeight)} px · {visibleCount} 图层
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="inline-flex h-6 items-center gap-1 rounded bg-[#3a3a3b] px-2 text-[12px] text-[#d6d6d6] hover:bg-[#464648] disabled:opacity-50"
            disabled={isExporting}
            onClick={() => void handleExport()}
          >
            <Download className="h-3.5 w-3.5" />
            {/* 统一一个「应用」：把编辑结果作为新节点生成到下游并连线。 */}
            {isExporting ? "应用中…" : "应用"}
          </button>
          <button
            type="button"
            className="inline-flex h-6 w-6 items-center justify-center rounded text-[#a8a8a8] hover:bg-[#464648] hover:text-white"
            title="关闭（Esc）"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* 选项栏 */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-black/50 bg-[#2b2b2b] px-2">
        {tool === "crop" ? (
          <>
            <span className="px-1 text-[12px] text-[#9a9a9a]">裁剪</span>
            <select
              value={cropRatioId}
              onChange={(event) => applyRatioPreset(event.target.value)}
              className="h-6 rounded border border-[#3f3f41] bg-[#3a3a3b] px-1.5 text-[12px] text-[#ddd] outline-none"
            >
              {CROP_RATIOS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
            </select>
            <span className="text-[11px] text-[#8a8a8a]">
              {frameSize ? `${frameSize.width} × ${frameSize.height} px` : "拖动锚点调整裁剪范围"}
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              <button
                type="button"
                className="inline-flex h-6 items-center gap-1 rounded px-2 text-[12px] text-[#c9c9c9] hover:bg-[#3a3a3b]"
                onClick={cancelCrop}
              >
                <X className="h-3.5 w-3.5" /> 取消
              </button>
            </div>
          </>
        ) : (
          <>
            <span className="px-1 text-[12px] text-[#9a9a9a]">模板</span>
            <select
              value={data.template}
              onChange={(event) => applyTemplate(event.target.value as MosaicTemplateId)}
              className="h-6 rounded border border-[#3f3f41] bg-[#3a3a3b] px-1.5 text-[12px] text-[#ddd] outline-none"
            >
              {MOSAIC_TEMPLATES.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="inline-flex h-6 items-center gap-1 rounded px-2 text-[12px] text-[#c9c9c9] hover:bg-[#3a3a3b]"
              onClick={() => fileInputRef.current?.click()}
            >
              <ImagePlus className="h-3.5 w-3.5" /> 添加图片
            </button>
            <button
              type="button"
              className="inline-flex h-6 items-center gap-1 rounded px-2 text-[12px] text-[#c9c9c9] hover:bg-[#3a3a3b]"
              onClick={startCrop}
            >
              <Crop className="h-3.5 w-3.5" /> 裁剪
            </button>
            <button
              type="button"
              className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded text-[#c9c9c9] hover:bg-[#3a3a3b] disabled:opacity-40"
              disabled={!selectedLayer}
              title="旋转 90°"
              onClick={() =>
                selectedLayer &&
                patchLayer(selectedLayer.id, {
                  rotation: normalizeRotation((selectedLayer.rotation ?? 0) + 90),
                })
              }
            >
              <RotateCw className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 左工具条 */}
        <div className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-black/50 bg-[#2b2b2b] py-2">
          <button
            type="button"
            title="移动（V）"
            className={`flex h-8 w-8 items-center justify-center rounded ${
              tool === "move" ? "bg-[#3d3d3f] text-white" : "text-[#b8b8b8] hover:bg-[#3a3a3b]"
            }`}
            onClick={() => {
              setTool("move");
              setFrame(null);
              setFrameEdited(false);
            }}
          >
            <Move className="h-4 w-4" />
          </button>
          <button
            type="button"
            title="矩形选框（M）"
            className={`flex h-8 w-8 items-center justify-center rounded ${
              tool === "select-rect" ? "bg-[#3d3d3f] text-white" : "text-[#b8b8b8] hover:bg-[#3a3a3b]"
            }`}
            onClick={() => setTool("select-rect")}
          >
            <SquareDashedMousePointer className="h-4 w-4" />
          </button>
          <button
            type="button"
            title="椭圆选框（M）"
            className={`flex h-8 w-8 items-center justify-center rounded ${
              tool === "select-ellipse" ? "bg-[#3d3d3f] text-white" : "text-[#b8b8b8] hover:bg-[#3a3a3b]"
            }`}
            onClick={() => setTool("select-ellipse")}
          >
            <CircleDashed className="h-4 w-4" />
          </button>
          <button
            type="button"
            title="套索（L）"
            className={`flex h-8 w-8 items-center justify-center rounded ${
              tool === "select-lasso" ? "bg-[#3d3d3f] text-white" : "text-[#b8b8b8] hover:bg-[#3a3a3b]"
            }`}
            onClick={() => setTool("select-lasso")}
          >
            <Lasso className="h-4 w-4" />
          </button>
          <div className="my-1 h-px w-6 bg-white/10" />
          <button
            type="button"
            title="裁剪（C）"
            className={`flex h-8 w-8 items-center justify-center rounded ${
              tool === "crop" ? "bg-[#3d3d3f] text-white" : "text-[#b8b8b8] hover:bg-[#3a3a3b]"
            }`}
            onClick={startCrop}
          >
            <Crop className="h-4 w-4" />
          </button>
          <div className="my-1 h-px w-6 bg-white/10" />
          <button
            type="button"
            title="添加图片"
            className="flex h-8 w-8 items-center justify-center rounded text-[#b8b8b8] hover:bg-[#3a3a3b]"
            onClick={() => fileInputRef.current?.click()}
          >
            <ImagePlus className="h-4 w-4" />
          </button>
          <button
            type="button"
            title="适配窗口"
            className="flex h-8 w-8 items-center justify-center rounded text-[#b8b8b8] hover:bg-[#3a3a3b]"
            onClick={() => setZoom("fit")}
          >
            <Maximize2 className="h-4 w-4" />
          </button>
        </div>

        {/* 画布 */}
        <div
          ref={viewportRef}
          className="relative flex min-w-0 flex-1 items-center justify-center overflow-hidden bg-[#1a1a1a]"
        >
          <div
            ref={artboardRef}
            className="relative overflow-hidden shadow-[0_0_0_1px_rgba(255,255,255,0.08)]"
            style={{
              width: Math.round(canvasWidth * scale),
              height: Math.round(canvasHeight * scale),
              backgroundColor: data.backgroundColor ?? "#0f1115",
              // 鼠标指针随工具变化：选择/裁剪用十字，移动用默认（图层自带 move）。
              cursor:
                tool === "select-rect" || tool === "select-ellipse" || tool === "select-lasso" || tool === "crop"
                  ? "crosshair"
                  : "default",
            }}
            onPointerDown={handleCanvasPointerDown}
          >
            {layers
              .filter((layer) => layer.visible)
              .map((layer) => (
                <EditorLayerView
                  key={layer.id}
                  layer={layer}
                  scale={scale}
                  tool={tool}
                  active={layer.id === selectedLayerId && tool === "move"}
                  onPointerDown={(event) => {
                    // 裁剪模式下事件要冒泡到画板，否则拖不出裁剪框。
                    if (tool !== "move") return;
                    if (layer.locked) {
                      event.stopPropagation();
                      setSelectedLayerId(layer.id);
                      return;
                    }
                    beginLayerDrag(event, "move", layer);
                  }}
                />
              ))}

            {/* 选中图层的缩放点 */}
            {tool === "move" && selectedLayer && !selectedLayer.locked && (
              <div
                className="absolute h-2.5 w-2.5 cursor-nwse-resize border border-white bg-[#0a84ff]"
                style={{
                  left: (selectedLayer.x + selectedLayer.width) * scale - 5,
                  top: (selectedLayer.y + selectedLayer.height) * scale - 5,
                  touchAction: "none",
                }}
                title="拖动缩放（等比）"
                onPointerDown={(event) => beginLayerDrag(event, "resize", selectedLayer)}
              />
            )}

            {/* 裁剪框 */}
            {tool === "crop" && frame && (
              <>
                <div
                  className="pointer-events-none absolute border border-white/90"
                  style={{
                    left: frame.x * scale,
                    top: frame.y * scale,
                    width: Math.max(1, frame.width * scale),
                    height: Math.max(1, frame.height * scale),
                    boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)",
                  }}
                >
                  <div className="absolute inset-0">
                    {[1, 2].map((index) => (
                      <div
                        key={`v${index}`}
                        className="absolute top-0 h-full border-l border-white/35"
                        style={{ left: `${(index * 100) / 3}%` }}
                      />
                    ))}
                    {[1, 2].map((index) => (
                      <div
                        key={`h${index}`}
                        className="absolute left-0 w-full border-t border-white/35"
                        style={{ top: `${(index * 100) / 3}%` }}
                      />
                    ))}
                  </div>
                  {(
                      ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const
                    ).map((handle) => (
                      <div
                        key={handle}
                        className="pointer-events-none absolute h-2.5 w-2.5 border border-white bg-[#0a84ff]"
                        style={{
                          top: handle.includes("n")
                            ? -5
                            : handle.includes("s")
                              ? undefined
                              : "calc(50% - 5px)",
                          bottom: handle.includes("s") ? -5 : undefined,
                          left: handle.includes("w")
                            ? -5
                            : handle.includes("e")
                              ? undefined
                              : "calc(50% - 5px)",
                          right: handle.includes("e") ? -5 : undefined,
                          cursor: HANDLE_CURSOR[handle],
                        }}
                      />
                    ))}
                </div>
              </>
            )}

            {/* 蚂蚁线选区（选择工具） */}
            <SelectionOutline
              selection={selection}
              boundary={selectionBoundary}
              canvasWidth={canvasWidth}
              canvasHeight={canvasHeight}
              scale={scale}
            />
            {/* 套索绘制中的临时轨迹 */}
            {lassoDraft && lassoDraft.length > 1 && (
              <svg
                className="pointer-events-none absolute left-0 top-0"
                width="100%"
                height="100%"
                viewBox={`0 0 ${Math.max(1, canvasWidth)} ${Math.max(1, canvasHeight)}`}
              >
                <polyline
                  points={lassoDraft.map((point) => `${point.x},${point.y}`).join(" ")}
                  fill="none"
                  stroke="#fff"
                  strokeWidth={1.5 / Math.max(0.01, scale)}
                  strokeDasharray={`${4 / Math.max(0.01, scale)} ${4 / Math.max(0.01, scale)}`}
                />
              </svg>
            )}
          </div>
        </div>

        {/* 右侧面板 */}
        <div className="flex w-[296px] shrink-0 flex-col border-l border-black/50 bg-[#252526]">
          <div className="flex h-8 shrink-0 items-center gap-1 border-b border-black/40 px-2 text-[12px] text-[#c8c8c8]">
            {(
              [
                ["props", "属性"],
                ["adjust", "调整"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`h-6 flex-1 rounded text-[11px] transition-colors ${
                  panelTab === id ? "bg-[#3d3d3f] text-white" : "text-[#9a9a9a] hover:bg-[#333335]"
                }`}
                onClick={() => {
                  setPanelTab(id);
                  if (id === "adjust" && !selectedLayerId && layers.length > 0) {
                    const top = [...layers].reverse().find((layer) => layer.visible) ?? layers[0];
                    setSelectedLayerId(top?.id ?? null);
                  }
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {panelTab === "adjust" && (
            <div className="min-h-0 flex-1 overflow-y-auto p-3 text-[12px]">
              {(selection || selectionBoundary) && (
                <div className="mb-2 rounded bg-[#2b2b2c] px-2 py-1.5 text-[11px] text-[#9a9a9a]">
                  当前有选区：调整将只作用于框选范围内（选区外保持原样）。
                </div>
              )}
              <MosaicAdjustPanel
                adjust={selectedLayer?.adjust}
                previewUrl={selectedPreviewUrl}
                disabled={!selectedLayer}
                onChange={(next) => {
                  if (!selectedLayer) return;
                  // 有选区时：把选区掩码固化到图层的局部调色蒙版，渲染/导出只调选区内。
                  if (selection || selectionBoundary) {
                    const mask = selection
                      ? selectionToMask(selection, canvasWidth, canvasHeight)
                      : selectionMaskRef.current;
                    if (mask) {
                      patchLayer(selectedLayer.id, {
                        adjust: next,
                        adjustMask: maskToLayerDataUrl(mask, selectedLayer.x, selectedLayer.y, selectedLayer.width, selectedLayer.height),
                      });
                      return;
                    }
                  }
                  patchLayer(selectedLayer.id, { adjust: next });
                }}
              />
            </div>
          )}
          <div className={`min-h-0 flex-1 overflow-y-auto p-3 text-[12px] ${panelTab === "props" ? "" : "hidden"}`}>
            <div className="mb-3 space-y-2">
              <div className="text-[11px] uppercase tracking-wide text-[#8a8a8a]">画布</div>
              <div className="flex items-center gap-2">
                <span className="w-4 text-[#9a9a9a]">W</span>
                <input
                  type="number"
                  value={Math.round(canvasWidth)}
                  onChange={(event) => setCanvasSize(Number(event.target.value), canvasHeight)}
                  className="h-6 w-full rounded border border-[#3f3f41] bg-[#1f1f20] px-1.5 text-[12px] text-[#ddd] outline-none"
                />
                <span className="w-4 text-[#9a9a9a]">H</span>
                <input
                  type="number"
                  value={Math.round(canvasHeight)}
                  onChange={(event) => setCanvasSize(canvasWidth, Number(event.target.value))}
                  className="h-6 w-full rounded border border-[#3f3f41] bg-[#1f1f20] px-1.5 text-[12px] text-[#ddd] outline-none"
                />
              </div>
              <div className="flex gap-1.5">
                {[
                  { label: "横屏", width: 1920, height: 1080 },
                  { label: "竖屏", width: 1080, height: 1920 },
                  { label: "方形", width: 1080, height: 1080 },
                ].map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    className="h-6 flex-1 rounded border border-[#3f3f41] bg-[#2f2f30] text-[11px] text-[#c9c9c9] hover:bg-[#3a3a3b]"
                    onClick={() => setCanvasSize(preset.width, preset.height)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="mb-3 space-y-2 border-t border-white/10 pt-3">
              <div className="text-[11px] uppercase tracking-wide text-[#8a8a8a]">图层</div>
              {selectedLayer ? (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    {(
                      [
                        ["X", "x"],
                        ["Y", "y"],
                        ["宽", "width"],
                        ["高", "height"],
                      ] as const
                    ).map(([label, key]) => (
                      <div key={key} className="flex items-center gap-1">
                        <span className="w-5 text-[#9a9a9a]">{label}</span>
                        <input
                          type="number"
                          value={Math.round(selectedLayer[key])}
                          onChange={(event) =>
                            patchLayer(selectedLayer.id, {
                              [key]: Number(event.target.value) || 0,
                            } as Partial<MosaicLayerItem>)
                          }
                          className="h-6 w-full rounded border border-[#3f3f41] bg-[#1f1f20] px-1.5 text-[12px] text-[#ddd] outline-none"
                        />
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-8 text-[#9a9a9a]">旋转</span>
                    <input
                      type="number"
                      value={Math.round(selectedLayer.rotation ?? 0)}
                      onChange={(event) =>
                        patchLayer(selectedLayer.id, { rotation: Number(event.target.value) || 0 })
                      }
                      className="h-6 w-full rounded border border-[#3f3f41] bg-[#1f1f20] px-1.5 text-[12px] text-[#ddd] outline-none"
                    />
                    <span className="text-[#9a9a9a]">°</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-8 shrink-0 text-[#9a9a9a]">不透明</span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={Math.round((selectedLayer.opacity ?? 1) * 100)}
                      onChange={(event) =>
                        patchLayer(selectedLayer.id, { opacity: Number(event.target.value) / 100 })
                      }
                      className="w-full accent-[#0a84ff]"
                    />
                    <span className="w-8 text-right text-[11px] text-[#9a9a9a]">
                      {Math.round((selectedLayer.opacity ?? 1) * 100)}
                    </span>
                  </div>
                </>
              ) : (
                <div className="text-[11px] text-[#7a7a7a]">未选中图层</div>
              )}
            </div>

            <div className="space-y-2 border-t border-white/10 pt-3">
              <div className="text-[11px] uppercase tracking-wide text-[#8a8a8a]">网格</div>
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    ["列", "gridCols"],
                    ["行", "gridRows"],
                    ["间距", "gap"],
                  ] as const
                ).map(([label, key]) => (
                  <div key={key} className="flex items-center gap-1">
                    <span className="shrink-0 text-[#9a9a9a]">{label}</span>
                    <input
                      type="number"
                      value={Number(data[key] ?? (key === "gap" ? 8 : 3))}
                      onChange={(event) =>
                        updateNodeData(nodeId, {
                          [key]: Math.max(0, Number(event.target.value) || 0),
                        } as Partial<SeamlessMosaicNodeData>)
                      }
                      className="h-6 w-full rounded border border-[#3f3f41] bg-[#1f1f20] px-1.5 text-[12px] text-[#ddd] outline-none"
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* 图层面板 */}
          <div className="flex h-8 shrink-0 items-center justify-between border-y border-black/40 px-3 text-[12px] text-[#c8c8c8]">
            <span>图层</span>
            <span className="text-[11px] text-[#8a8a8a]">{layers.length}</span>
          </div>
          <div className="flex shrink-0 items-center gap-2 border-b border-black/30 px-3 py-2">
            <select
              value={selectedLayer?.blendMode ?? "normal"}
              onChange={(event) =>
                selectedLayer &&
                patchLayer(selectedLayer.id, { blendMode: event.target.value as MosaicBlendMode })
              }
              disabled={!selectedLayer}
              className="h-6 min-w-0 flex-1 rounded border border-[#3f3f41] bg-[#1f1f20] px-1 text-[11px] text-[#ddd] outline-none disabled:opacity-40"
            >
              {MOSAIC_BLEND_MODE_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <input
              type="number"
              value={Math.round((selectedLayer?.opacity ?? 1) * 100)}
              disabled={!selectedLayer}
              onChange={(event) =>
                selectedLayer &&
                patchLayer(selectedLayer.id, {
                  opacity: Math.min(1, Math.max(0, Number(event.target.value) / 100)),
                })
              }
              className="h-6 w-14 rounded border border-[#3f3f41] bg-[#1f1f20] px-1 text-[11px] text-[#ddd] outline-none disabled:opacity-40"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {[...layers].reverse().map((layer) => {
              const active = layer.id === selectedLayerId;
              return (
                <div
                  key={layer.id}
                  className={`flex items-center gap-1.5 border-b border-black/20 px-2 py-1.5 ${
                    active ? "bg-[#0a84ff]/20" : "hover:bg-white/5"
                  }`}
                  onClick={() => setSelectedLayerId(layer.id)}
                >
                  <button
                    type="button"
                    className="text-[#b8b8b8] hover:text-white"
                    title={layer.visible ? "隐藏" : "显示"}
                    onClick={(event) => {
                      event.stopPropagation();
                      patchLayer(layer.id, { visible: !layer.visible });
                    }}
                  >
                    {layer.visible ? (
                      <Eye className="h-3.5 w-3.5" />
                    ) : (
                      <EyeOff className="h-3.5 w-3.5 opacity-50" />
                    )}
                  </button>
                  <div className="h-7 w-7 shrink-0 overflow-hidden rounded border border-white/10 bg-black/40">
                    <img
                      src={resolveImageDisplayUrl(layer.previewImageUrl || layer.imageUrl)}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[11.5px] text-[#ddd]">
                      {layer.sourceName || `图层 ${layer.order + 1}`}
                    </div>
                    <div className="text-[10px] text-[#7f7f7f]">
                      {Math.round(layer.width)} × {Math.round(layer.height)}
                      {layer.crop ? " · 已裁剪" : ""}
                      {layer.adjust && !isAdjustIdentity(layer.adjust) ? " · 已调整" : ""}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="text-[#9a9a9a] hover:text-white"
                    title={layer.locked ? "解锁" : "锁定"}
                    onClick={(event) => {
                      event.stopPropagation();
                      patchLayer(layer.id, { locked: !layer.locked });
                    }}
                  >
                    {layer.locked ? (
                      <Lock className="h-3.5 w-3.5" />
                    ) : (
                      <LockOpen className="h-3.5 w-3.5 opacity-40" />
                    )}
                  </button>
                  <button
                    type="button"
                    className="text-[#9a9a9a] hover:text-white"
                    title="上移一层"
                    onClick={(event) => {
                      event.stopPropagation();
                      moveLayerOrder(layer.id, 1);
                    }}
                  >
                    <ChevronUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    className="text-[#9a9a9a] hover:text-white"
                    title="下移一层"
                    onClick={(event) => {
                      event.stopPropagation();
                      moveLayerOrder(layer.id, -1);
                    }}
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    className="text-[#9a9a9a] hover:text-[#ff6b6b]"
                    title="删除图层"
                    onClick={(event) => {
                      event.stopPropagation();
                      removeLayer(layer.id);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
            {layers.length === 0 && (
              <div className="px-3 py-6 text-center text-[11px] text-[#7a7a7a]">
                还没有图层，点左侧「添加图片」
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 状态栏 */}
      <div className="flex h-7 shrink-0 items-center gap-4 border-t border-black/50 bg-[#2b2b2b] px-3 text-[11px] text-[#9a9a9a]">
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="rounded px-1 hover:bg-[#3a3a3b]"
            onClick={() => setZoom(Math.max(0.05, scale / 1.25))}
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="min-w-[52px] rounded px-1 text-center hover:bg-[#3a3a3b]"
            onClick={() => setZoom("fit")}
            title="适配窗口"
          >
            {Math.round(scale * 100)}%
          </button>
          <button
            type="button"
            className="rounded px-1 hover:bg-[#3a3a3b]"
            onClick={() => setZoom(Math.min(8, scale * 1.25))}
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </button>
        </div>
        <span>
          画布 {Math.round(canvasWidth)} × {Math.round(canvasHeight)}
        </span>
        <span>{layers.length} 图层</span>
        {(selection || selectionBoundary) && (
          <span className="flex items-center gap-2">
            <button
              type="button"
              className="rounded px-1.5 py-0.5 text-[#c9c9c9] hover:bg-[#3a3a3b] hover:text-white"
              onClick={invertSelection}
              title="反选（选区内外互换）"
            >
              反选
            </button>
            {selection && (
              <label className="flex items-center gap-1 text-[#9a9a9a]">
                羽化
                <input
                  type="number"
                  min={0}
                  max={200}
                  value={selection.feather}
                  onChange={(event) => setSelectionFeather(Number(event.target.value) || 0)}
                  className="h-5 w-12 rounded border border-[#3f3f41] bg-[#3a3a3b] px-1 text-[11px] text-[#ddd] outline-none"
                  title="羽化半径（像素），软边过渡"
                />
              </label>
            )}
            <button
              type="button"
              className="rounded px-1.5 py-0.5 text-[#c9c9c9] hover:bg-[#3a3a3b] hover:text-white"
              onClick={() => void deleteSelection()}
              title="删除选中内容（选中图层上选区内的像素变透明）"
            >
              删除
            </button>
            {eraseSnapshotRef.current && (
              <button
                type="button"
                className="rounded px-1.5 py-0.5 text-[#c9c9c9] hover:bg-[#3a3a3b] hover:text-white"
                onClick={undoErase}
                title="撤销删除（会话内，Ctrl+Z）"
              >
                撤销删除
              </button>
            )}
            <button
              type="button"
              className="rounded px-1.5 py-0.5 text-[#c9c9c9] hover:bg-[#3a3a3b] hover:text-white"
              onClick={() => {
                setSelection(null);
                setSelectionBoundary(null);
                selectionMaskRef.current = null;
                setNotice(null);
              }}
              title="取消选区（Ctrl+D）"
            >
              取消选区
            </button>
          </span>
        )}
        <span className="ml-auto truncate">
          {notice ??
            (tool === "crop"
              ? "拖出裁剪框 · 框内拖动可平移 · Enter 应用 · Esc 取消"
              : "V 移动 · C 裁剪 · 拖动图层可移动")}
        </span>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={handleAddImages}
      />
    </div>,
    document.body,
  );
}
