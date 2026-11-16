import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from "@xyflow/react";
import { Grid3x3, Images, Plus } from "lucide-react";
import { v4 as uuidv4 } from "uuid";

import {
  CANVAS_NODE_TYPES,
  type MosaicLayerItem,
  type SeamlessMosaicNodeData,
} from "@/features/canvas/domain/canvasNodes";
import { graphImageResolver } from "@/features/canvas/application/canvasServices";
import { useCanvasInputGraph } from "@/features/canvas/application/useCanvasInputGraph";
import {
  prepareNodeImage,
  prepareNodeImageFromFile,
  resolveImageDisplayUrl,
} from "@/features/canvas/application/imageData";
import { resolveNodeDisplayName } from "@/features/canvas/domain/nodeDisplay";
import { normalizeRotation } from "@/features/canvas/domain/mosaicBlend";
import {
  fitCanvasToSingleLayer,
  initialLayerBox,
  layerFillRect,
  layerImageAspect,
  nodeSizeForCanvasAspect,
  snugLayerToImage,
} from "@/features/canvas/application/mosaicFit";
import {
  renderMosaicToCanvas,
  resolveCanvasExpansion,
  scaleCanvasForNodeResize,
  scaleNodeFrameForCanvasExpansion,
} from "@/features/canvas/application/mosaicRender";
import { useCanvasStore } from "@/stores/canvasStore";
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from "@/features/canvas/ui/NodeHeader";
import { NodeResizeHandle } from "@/features/canvas/ui/NodeResizeHandle";
import { useAdjustedPreview } from "@/features/canvas/ui/useAdjustedPreview";
import { layoutMosaicLayers, SeamlessMosaicEditor } from "@/features/canvas/ui/SeamlessMosaicEditor";

const NODE_DEFAULT_WIDTH = 280;
const NODE_MIN_WIDTH = 220;
const NODE_MIN_HEIGHT = 170;
const NODE_MAX_WIDTH = 1400;
const NODE_MAX_HEIGHT = 1400;
const NODE_BOUNDS = {
  minWidth: NODE_MIN_WIDTH,
  minHeight: NODE_MIN_HEIGHT,
  maxWidth: NODE_MAX_WIDTH,
  maxHeight: NODE_MAX_HEIGHT,
};

type SeamlessMosaicNodeProps = NodeProps & {
  data: SeamlessMosaicNodeData;
};

type PreparedLayerSource = {
  imageUrl: string;
  previewImageUrl: string;
  aspectRatio: string;
  sourceName?: string;
};

function createLayer(source: PreparedLayerSource, order: number): MosaicLayerItem {
  // 框按图片真实比例给，别一律正方形 —— 正方形框配 4:3 的图，上下必然被
  // object-contain 留出黑边，用户怎么拖都消不掉。
  const box = initialLayerBox(source.aspectRatio);
  return {
    id: uuidv4(),
    imageUrl: source.imageUrl,
    previewImageUrl: source.previewImageUrl,
    aspectRatio: source.aspectRatio,
    sourceName: source.sourceName,
    x: 0,
    y: 0,
    width: box.width,
    height: box.height,
    crop: null,
    visible: true,
    order,
    opacity: 1,
  };
}

function resolveGridRows(layerCount: number, gridCols: number, currentRows: number): number {
  const cols = Math.min(Math.max(1, gridCols), Math.max(1, layerCount));
  return Math.max(1, currentRows, Math.ceil(layerCount / cols));
}

/**
 * 节点内可直接拖的舞台。
 *
 * 即梦画布的图层编辑好在「不用点进去」：节点上直接拖就能摆图，想精修再点开全屏。
 * 这里照同一套做：图层元素带 `nodrag`，在图层上拖 = 移动该图层，在空白处拖 = 移动节点。
 * 拖动过程只写本地草稿（每帧都写 store 会把撤销栈冲爆），松手才提交一次。
 */
interface MosaicLayerViewProps {
  layer: MosaicLayerItem;
  canvasWidth: number;
  canvasHeight: number;
  active: boolean;
  onImageRatioResolved: (layerId: string, aspectRatio: string) => void;
  onPointerDown: (event: ReactPointerEvent, layer: MosaicLayerItem) => void;
}

/**
 * 单个图层的渲染。
 *
 * 外层框 = 图层框（`overflow-hidden`，蓝框画在这里），内层 img 按「框 ÷ 裁剪比例」
 * 放大并偏移，裁剪区因此正好铺满框 —— 看到的和导出的才是同一块内容。
 * 真实宽高比走 `<img>` 的 `naturalWidth/Height`：既补 onLoad，也在挂载时用
 * `complete` 补一次（HMR / 重新挂载时不会再有 onLoad）。
 */
const MosaicLayerView = memo(function MosaicLayerView({
  layer,
  canvasWidth,
  canvasHeight,
  active,
  onImageRatioResolved,
  onPointerDown,
}: MosaicLayerViewProps) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const fill = layerFillRect(layer);
  // 图层调整后的预览图（曲线/色阶等），源文件不动。
  const displaySource = useAdjustedPreview(layer);

  const reportRatio = useCallback(() => {
    const image = imageRef.current;
    if (!image || !image.naturalWidth || !image.naturalHeight) return;
    onImageRatioResolved(layer.id, `${image.naturalWidth}:${image.naturalHeight}`);
  }, [layer.id, onImageRatioResolved]);

  useEffect(() => {
    reportRatio();
  }, [reportRatio, layer.imageUrl, layer.previewImageUrl]);

  return (
    <div
      className="nodrag absolute cursor-move overflow-hidden"
      style={{
        left: `${(layer.x / canvasWidth) * 100}%`,
        top: `${(layer.y / canvasHeight) * 100}%`,
        width: `${(layer.width / canvasWidth) * 100}%`,
        height: `${(layer.height / canvasHeight) * 100}%`,
        opacity: layer.opacity ?? 1,
        // 混合模式的枚举名与 CSS `mix-blend-mode` 取值一致，节点上直接看得到效果。
        mixBlendMode: layer.blendMode ?? "normal",
        transform: layer.rotation ? `rotate(${layer.rotation}deg)` : undefined,
        transformOrigin: "center",
        // 蓝框画在「框」上 —— 框贴合图片时，它就正好贴着画面四边。
        outline: active ? "1.5px solid rgba(59,130,246,0.9)" : undefined,
        outlineOffset: 1,
        cursor: layer.locked ? "default" : "move",
      }}
      onPointerDown={(event) => onPointerDown(event, layer)}
    >
      <img
        ref={imageRef}
        src={resolveImageDisplayUrl(displaySource)}
        alt=""
        draggable={false}
        className="pointer-events-none absolute object-contain"
        onLoad={reportRatio}
        style={{
          left: `${((fill.x - layer.x) / layer.width) * 100}%`,
          top: `${((fill.y - layer.y) / layer.height) * 100}%`,
          width: `${(fill.width / layer.width) * 100}%`,
          height: `${(fill.height / layer.height) * 100}%`,
        }}
      />
    </div>
  );
});

interface MosaicInlineStageProps {
  data: SeamlessMosaicNodeData;
  layers: MosaicLayerItem[];
  onCommit: (layers: MosaicLayerItem[]) => void;
  onOpenEditor: () => void;
  /** 图片真正加载出来后回报真实宽高比（`2048:1536`），用来修掉历史数据里错的框比例。 */
  onImageRatioResolved: (layerId: string, aspectRatio: string) => void;
}

function MosaicInlineStage({
  data,
  layers,
  onCommit,
  onOpenEditor,
  onImageRatioResolved,
}: MosaicInlineStageProps) {
  const canvasWidth = Math.max(1, data.canvasWidth || 1920);
  const canvasHeight = Math.max(1, data.canvasHeight || 1080);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef<MosaicLayerItem[] | null>(null);
  const [, forceRender] = useState(0);
  const dragRef = useRef<{
    id: string;
    mode: "move" | "resize" | "rotate";
    startX: number;
    startY: number;
    /** 旋转模式下的初始角度（以图层中心为极点）。 */
    startAngle: number;
    originRotation: number;
    origin: MosaicLayerItem;
    scaleX: number;
    scaleY: number;
    /** 是否真的移动过：只点一下不写 store，否则每次点击都会把导出结果清掉。 */
    moved: boolean;
  } | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const rendered = draftRef.current ?? layers;

  useEffect(() => {
    const handleMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      event.preventDefault();
      drag.moved = true;
      const dx = (event.clientX - drag.startX) / (drag.scaleX || 1);
      const dy = (event.clientY - drag.startY) / (drag.scaleY || 1);
      const base = draftRef.current ?? layers;
      // 旋转：用指针相对图层中心的角度差，比按水平位移换算更符合直觉。
      const stageRect = stageRef.current?.getBoundingClientRect();
      const angleNow =
        drag.mode === "rotate" && stageRect
          ? (Math.atan2(
              event.clientY - (stageRect.top + (drag.origin.y + drag.origin.height / 2) * drag.scaleY),
              event.clientX - (stageRect.left + (drag.origin.x + drag.origin.width / 2) * drag.scaleX),
            ) *
              180) /
            Math.PI
          : 0;
      const next = base.map((layer) => {
        if (layer.id !== drag.id) return layer;
        if (drag.mode === "rotate") {
          return {
            ...layer,
            rotation: normalizeRotation(drag.originRotation + (angleNow - drag.startAngle)),
          };
        }
        if (drag.mode === "move") {
          // 左 / 上钳到 0：贴住边框就停，不再把画幅往左、往上撑开
          // （撑开会连画幅比例一起变，用户只是想把图推到边上）。
          return {
            ...layer,
            x: Math.max(0, Math.round(drag.origin.x + dx)),
            y: Math.max(0, Math.round(drag.origin.y + dy)),
          };
        }
        // 右下角缩放：等比，锚点保持在左上角，避免拖角时图层乱跑。
        // 比例取**图片真实比例**（不是框当前的比例）：框一开始不是图片比例的话，
        // 按框比例缩放会把黑边一起放大，永远消不掉。
        const ratio = layerImageAspect(drag.origin);
        const width = Math.max(16, Math.round(drag.origin.width + dx));
        return {
          ...layer,
          width,
          height: Math.max(16, Math.round(width / (ratio > 0 ? ratio : 1))),
        };
      });
      draftRef.current = next;
      forceRender((value) => value + 1);
    };

    const handleUp = () => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag) return;
      const next = draftRef.current;
      draftRef.current = null;
      // 只点一下（没拖动）不提交，避免白白清空导出结果与撤销栈。
      if (next && drag.moved) onCommit(next);
      forceRender((value) => value + 1);
    };

    window.addEventListener("pointermove", handleMove, { passive: false });
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
    };
  }, [layers, onCommit]);

  const beginDrag = useCallback(
    (event: ReactPointerEvent, layer: MosaicLayerItem, mode: "move" | "resize" | "rotate") => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      setActiveId(layer.id);
      // 锁定的图层在节点上只允许选中，不能拖动/缩放/旋转。
      if (layer.locked) return;
      const rect = stageRef.current?.getBoundingClientRect();
      if (!rect) return;
      const scaleX = rect.width / canvasWidth;
      const scaleY = rect.height / canvasHeight;
      const centerX = rect.left + (layer.x + layer.width / 2) * scaleX;
      const centerY = rect.top + (layer.y + layer.height / 2) * scaleY;
      const startAngle = (Math.atan2(event.clientY - centerY, event.clientX - centerX) * 180) / Math.PI;
      draftRef.current = layers;
      dragRef.current = {
        id: layer.id,
        mode,
        startX: event.clientX,
        startY: event.clientY,
        startAngle,
        originRotation: layer.rotation ?? 0,
        origin: layer,
        scaleX,
        scaleY,
        moved: false,
      };
    },
    [canvasHeight, canvasWidth, layers],
  );

  const activeLayer = rendered.find((layer) => layer.id === activeId) ?? null;

  return (
    <div
      ref={stageRef}
      className="relative isolate h-full w-full overflow-hidden bg-[#11151d]"
      onDoubleClick={onOpenEditor}
    >
      {[...rendered]
        .filter((layer) => layer.visible)
        .sort((a, b) => a.order - b.order)
        .map((layer) => (
          <MosaicLayerView
            key={layer.id}
            layer={layer}
            canvasWidth={canvasWidth}
            canvasHeight={canvasHeight}
            active={layer.id === activeId}
            onImageRatioResolved={onImageRatioResolved}
            onPointerDown={(event, target) => beginDrag(event, target, "move")}
          />
        ))}

      {activeLayer && !activeLayer.locked && (
        <>
          <div
            className="nodrag absolute h-3 w-3 cursor-nwse-resize rounded-sm border border-white bg-accent"
            style={{
              left: `calc(${((activeLayer.x + activeLayer.width) / canvasWidth) * 100}% - 6px)`,
              top: `calc(((activeLayer.y + activeLayer.height) / canvasHeight) * 100% - 6px)`,
              touchAction: "none",
            }}
            title="拖动缩放（等比）"
            onPointerDown={(event) => beginDrag(event, activeLayer, "resize")}
          />
          <div
            className="nodrag absolute h-3 w-3 cursor-grab rounded-full border border-white bg-white/90"
            style={{
              left: `calc(${((activeLayer.x + activeLayer.width / 2) / canvasWidth) * 100}% - 6px)`,
              top: `calc(${(activeLayer.y / canvasHeight) * 100}% - 14px)`,
              touchAction: "none",
            }}
            title="拖动旋转"
            onPointerDown={(event) => beginDrag(event, activeLayer, "rotate")}
          />
        </>
      )}
    </div>
  );
}

export const SeamlessMosaicNode = memo(({ id, data, selected, width, height }: SeamlessMosaicNodeProps) => {
  const updateNodeInternals = useUpdateNodeInternals();
  const { nodes, edges } = useCanvasInputGraph();
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const updateNodeSize = useCanvasStore((state) => state.updateNodeSize);
  const addDerivedExportNode = useCanvasStore((state) => state.addDerivedExportNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const importingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** 上一次生效的节点框尺寸，用来算「拖了多大比例」。 */
  const lastNodeSizeRef = useRef<{ width: number; height: number } | null>(null);
  /** 我们自己改的节点尺寸（扩画幅时），别再当成用户拖边框二次缩放画幅。 */
  const selfResizedRef = useRef<{ width: number; height: number } | null>(null);

  const resolvedWidth = typeof width === "number" && width > 1 ? Math.round(width) : NODE_DEFAULT_WIDTH;
  const resolvedHeight = typeof height === "number" && height > 1 ? Math.round(height) : 200;
  const displayName = useMemo(() => resolveNodeDisplayName(CANVAS_NODE_TYPES.seamlessMosaic, data), [data]);
  const layerCount = data.layers?.length ?? 0;
  const incomingImages = useMemo(() => graphImageResolver.collectInputImages(id, nodes, edges), [edges, id, nodes]);

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, resolvedHeight, resolvedWidth, updateNodeInternals]);

  const appendLayers = useCallback(
    (sources: PreparedLayerSource[], importedKeys?: string[]) => {
      if (sources.length === 0) return;
      const existingLayers = data.layers ?? [];
      const existingUrls = new Set(existingLayers.map((layer) => layer.imageUrl));
      const addedLayers = sources
        .filter((source) => !existingUrls.has(source.imageUrl))
        .map((source, index) => createLayer(source, existingLayers.length + index));
      const nextLayers = [...existingLayers, ...addedLayers];
      const gridRows = resolveGridRows(nextLayers.length, data.gridCols ?? 3, data.gridRows ?? 2);
      const canvasWidth = Math.max(64, data.canvasWidth || 1920);
      const canvasHeight = Math.max(64, data.canvasHeight || 1080);
      const laidOut = layoutMosaicLayers(
        nextLayers,
        data.template ?? "grid",
        canvasWidth,
        canvasHeight,
        data.gridCols ?? 3,
        gridRows,
        Math.max(0, data.gap ?? 8),
      );
      // 只有一张图时画幅直接贴住它 —— 否则框里上下会各留一条黑边。
      const fitted = fitCanvasToSingleLayer(laidOut, canvasWidth, canvasHeight);

      updateNodeData(id, {
        layers: fitted?.layers ?? laidOut,
        ...(fitted ? { canvasWidth: fitted.width, canvasHeight: fitted.height, canvasFitted: true } : {}),
        gridRows,
        importedSourceKeys: importedKeys ?? data.importedSourceKeys ?? [],
        outputImageUrl: null,
        outputPreviewImageUrl: null,
      });
      if (fitted) {
        const frame = nodeSizeForCanvasAspect(fitted.width / fitted.height, resolvedWidth, NODE_BOUNDS);
        if (frame.width !== resolvedWidth || frame.height !== resolvedHeight) {
          selfResizedRef.current = frame;
          updateNodeSize(id, frame.width, frame.height);
        }
      }
    },
    [data, id, resolvedWidth, updateNodeData, updateNodeSize],
  );

  useEffect(() => {
    if (importingRef.current || incomingImages.length === 0) return;
    const imported = new Set(data.importedSourceKeys ?? []);
    const pending = incomingImages.filter((imageUrl) => !imported.has(imageUrl));
    if (pending.length === 0) return;

    let cancelled = false;
    importingRef.current = true;
    void (async () => {
      const prepared: PreparedLayerSource[] = [];
      const nextImported = new Set(imported);
      for (const imageUrl of pending) {
        try {
          const image = await prepareNodeImage(imageUrl);
          if (!cancelled) {
            prepared.push({ ...image, sourceName: imageUrl.split(/[\\/]/).pop()?.split("?")[0] });
            nextImported.add(imageUrl);
          }
        } catch (error) {
          console.warn("[Mosaic] import image failed", imageUrl, error);
        }
      }
      if (!cancelled) appendLayers(prepared, Array.from(nextImported));
      importingRef.current = false;
    })();

    return () => {
      cancelled = true;
      importingRef.current = false;
    };
  }, [appendLayers, data.importedSourceKeys, incomingImages]);

  const handleFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []).filter((file) => file.type.startsWith("image/"));
      event.target.value = "";
      if (files.length === 0) return;

      setUploadError(null);
      const prepared: PreparedLayerSource[] = [];
      for (const file of files) {
        try {
          prepared.push({ ...(await prepareNodeImageFromFile(file)), sourceName: file.name });
        } catch (error) {
          console.error("[Mosaic] upload image failed", file.name, error);
        }
      }
      if (prepared.length === 0) {
        setUploadError("图片添加失败");
        return;
      }
      appendLayers(prepared);
    },
    [appendLayers],
  );

  const openEditor = useCallback(() => {
    setSelectedNode(id);
    setIsEditorOpen(true);
  }, [id, setSelectedNode]);

  /**
   * 节点内拖动/缩放图层后提交。
   *
   * 顺带把上一次的导出结果作废：否则节点缩略图与下游取图仍是「挪动前」的那张 PNG，
   * 用户会以为拖动没生效。
   */
  const commitInlineLayers = useCallback(
    (nextLayers: MosaicLayerItem[]) => {
      const canvasWidth = Math.max(1, data.canvasWidth || 1920);
      const canvasHeight = Math.max(1, data.canvasHeight || 1080);
      // 只有本次真正被拖动/缩放的图层才参与「要不要扩画幅」的判断。
      // 否则把画幅往小里拖（等于裁掉右/下边）之后，随便动一下别的图，
      // 那些本来就落在画外的图层会把画幅又撑回去 —— 白裁了。
      const previousById = new Map((data.layers ?? []).map((layer) => [layer.id, layer]));
      const touchedLayers = nextLayers.filter((layer) => {
        const before = previousById.get(layer.id);
        return (
          !before ||
          before.x !== layer.x ||
          before.y !== layer.y ||
          before.width !== layer.width ||
          before.height !== layer.height
        );
      });
      // 往外推越界 => 画幅跟着长（即梦图层编辑的手感）；只往右/下扩，
      // 左/上在拖动处就钳到 0，免得「贴左边框」把整个节点的比例带跑。
      const expansion = resolveCanvasExpansion(touchedLayers, canvasWidth, canvasHeight);
      if (expansion) {
        // 节点框按轴跟着画幅一起长，绝不用「宽度反推高度」（反推会在只向右推时算出更矮的高度）。
        const frame = scaleNodeFrameForCanvasExpansion(
          { width: resolvedWidth, height: resolvedHeight },
          { width: canvasWidth, height: canvasHeight },
          { width: expansion.width, height: expansion.height },
          { minWidth: NODE_MIN_WIDTH, minHeight: NODE_MIN_HEIGHT, maxWidth: NODE_MAX_WIDTH, maxHeight: NODE_MAX_HEIGHT },
        );
        updateNodeData(id, {
          layers: nextLayers,
          canvasWidth: expansion.width,
          canvasHeight: expansion.height,
          outputImageUrl: null,
          outputPreviewImageUrl: null,
        });
        if (frame.width !== resolvedWidth || frame.height !== resolvedHeight) {
          // 画幅已经按扩出来的尺寸算好了，别让尺寸监听再按比例缩一遍。
          selfResizedRef.current = frame;
          updateNodeSize(id, frame.width, frame.height);
        }
        return;
      }
      updateNodeData(id, {
        layers: nextLayers,
        outputImageUrl: null,
        outputPreviewImageUrl: null,
      });
    },
    [data.canvasHeight, data.canvasWidth, data.layers, id, resolvedWidth, resolvedHeight, updateNodeData, updateNodeSize],
  );

  /**
   * 节点框 = 画幅窗口。
   *
   * 拖边框只改画幅尺寸，里面每张图的坐标与尺寸一个都不动 —— 即梦图层编辑的手感：
   * 边框往外拉就多出一块空白画布，图还在原地；往里收就是把右/下边裁掉。
   * 画幅按节点框的变化比例缩放，两边一起变，所以图层在节点上的显示位置与大小恒定。
   * 首次挂载跳过 —— 老工程里节点框和画幅比例本来就未必一致，不能一打开就改人家的稿。
   */
  useEffect(() => {
    const previous = lastNodeSizeRef.current;
    lastNodeSizeRef.current = { width: resolvedWidth, height: resolvedHeight };

    const selfResized = selfResizedRef.current;
    // 只有尺寸真的变成「我们自己设的那个」才吞掉这次变化。
    if (selfResized && selfResized.width === resolvedWidth && selfResized.height === resolvedHeight) {
      selfResizedRef.current = null;
      return;
    }
    if (!previous) return;
    if (previous.width === resolvedWidth && previous.height === resolvedHeight) return;

    const canvasWidth = Math.max(1, data.canvasWidth || 1920);
    const canvasHeight = Math.max(1, data.canvasHeight || 1080);
    const next = scaleCanvasForNodeResize(
      previous,
      { width: resolvedWidth, height: resolvedHeight },
      canvasWidth,
      canvasHeight,
    );
    if (!next) return;

    // 只替换画幅，图层原样保留。
    updateNodeData(id, {
      canvasWidth: next.width,
      canvasHeight: next.height,
      outputImageUrl: null,
      outputPreviewImageUrl: null,
    });
  }, [data.canvasHeight, data.canvasWidth, id, resolvedHeight, resolvedWidth, updateNodeData]);

  /**
   * 老工程一次性自愈：单图层的节点，把画幅从「比图片大一圈」收成贴合图片。
   *
   * 早期图层框一律给 512×512、画幅又按版面给，于是 `<img>` 的 object-contain
   * 必然在上下留黑边。只在没有 `canvasFitted` 标记时跑一次 —— 之后用户自己拖边框
   * 加出来的空白是刻意为之，不能被每次打开都抹掉。
   */
  useEffect(() => {
    if (data.canvasFitted) return;
    // 还没图：别写标记，等导入时那条路径自己贴（导入一定会走一次）。
    if ((data.layers?.length ?? 0) === 0) return;
    const canvasWidth = Math.max(1, data.canvasWidth || 1920);
    const canvasHeight = Math.max(1, data.canvasHeight || 1080);
    const fitted = fitCanvasToSingleLayer(data.layers ?? [], canvasWidth, canvasHeight);
    if (!fitted) {
      updateNodeData(id, { canvasFitted: true });
      return;
    }
    const frame = nodeSizeForCanvasAspect(fitted.width / fitted.height, resolvedWidth, NODE_BOUNDS);
    updateNodeData(id, {
      layers: fitted.layers,
      canvasWidth: fitted.width,
      canvasHeight: fitted.height,
      canvasFitted: true,
      outputImageUrl: null,
      outputPreviewImageUrl: null,
    });
    if (frame.width !== resolvedWidth || frame.height !== resolvedHeight) {
      selfResizedRef.current = frame;
      updateNodeSize(id, frame.width, frame.height);
    }
  }, [
    data.canvasFitted,
    data.canvasHeight,
    data.canvasWidth,
    data.layers,
    id,
    resolvedWidth,
    updateNodeData,
    updateNodeSize,
  ]);

  /** 写入图层 + 单图层时把画幅收到框上（保证「框贴合图片」，框外不留底色）。 */
  const applyLayersAndFitCanvas = useCallback(
    (nextLayers: MosaicLayerItem[]) => {
      const canvasWidth = Math.max(1, data.canvasWidth || 1920);
      const canvasHeight = Math.max(1, data.canvasHeight || 1080);
      const fitted = fitCanvasToSingleLayer(nextLayers, canvasWidth, canvasHeight);
      updateNodeData(id, {
        layers: fitted?.layers ?? nextLayers,
        ...(fitted
          ? { canvasWidth: fitted.width, canvasHeight: fitted.height, canvasFitted: true }
          : {}),
        outputImageUrl: null,
        outputPreviewImageUrl: null,
      });
      if (!fitted) return;
      const frame = nodeSizeForCanvasAspect(fitted.width / fitted.height, resolvedWidth, NODE_BOUNDS);
      if (frame.width !== resolvedWidth || frame.height !== resolvedHeight) {
        selfResizedRef.current = frame;
        updateNodeSize(id, frame.width, frame.height);
      }
    },
    [data.canvasHeight, data.canvasWidth, id, resolvedWidth, updateNodeData, updateNodeSize],
  );

  /**
   * 图片真正加载出来后，用浏览器量到的真实宽高比修框。
   *
   * 不信 store 里的 `aspectRatio`，直接信 `naturalWidth/Height`；单图层时顺带把画幅收到框上。
   */
  const handleImageRatioResolved = useCallback(
    (layerId: string, aspectRatio: string) => {
      const layers = data.layers ?? [];
      const layer = layers.find((item) => item.id === layerId);
      if (!layer) return;
      const aspectChanged = layer.aspectRatio !== aspectRatio;
      // 先把真实比例写回图层，再让它自己贴框（含裁剪比例与画幅边界判断）。
      const relabeled = aspectChanged ? { ...layer, aspectRatio } : layer;
      const snug = snugLayerToImage(relabeled, {
        width: Math.max(1, data.canvasWidth || 1920),
        height: Math.max(1, data.canvasHeight || 1080),
      });
      if (!snug && !aspectChanged) return;
      applyLayersAndFitCanvas(layers.map((item) => (item.id === layerId ? snug ?? relabeled : item)));
    },
    [applyLayersAndFitCanvas, data.canvasHeight, data.canvasWidth, data.layers],
  );

  /** 节点上直接导出：合成 → 落盘 → 在下游生成一个图片节点并连线。 */
  const handleExport = useCallback(async () => {
    if (isExporting) return;
    setIsExporting(true);
    setUploadError(null);
    try {
      const { canvas } = await renderMosaicToCanvas(data);
      const prepared = await prepareNodeImage(canvas.toDataURL("image/png"));
      const createdNodeId = addDerivedExportNode(
        id,
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
      if (createdNodeId) addEdge(id, createdNodeId);
      updateNodeData(id, {
        outputImageUrl: prepared.imageUrl,
        outputPreviewImageUrl: prepared.previewImageUrl,
      });
    } catch (error) {
      console.error("[Mosaic] export failed", error);
      setUploadError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsExporting(false);
    }
  }, [addDerivedExportNode, addEdge, data, id, isExporting, updateNodeData]);

  return (
    <>
      <div
        className={`group relative overflow-visible rounded-[var(--node-radius)] border bg-surface-dark/90 p-0 transition-colors duration-150 ${
          selected
            ? "border-accent shadow-[0_0_0_1px_rgba(59,130,246,0.32)]"
            : "border-[rgba(15,23,42,0.22)] hover:border-[rgba(15,23,42,0.34)] dark:border-[rgba(255,255,255,0.22)] dark:hover:border-[rgba(255,255,255,0.34)]"
        }`}
        style={{ width: resolvedWidth, height: resolvedHeight }}
        onClick={() => setSelectedNode(id)}
        onDoubleClick={openEditor}
      >
        <NodeHeader
          className={NODE_HEADER_FLOATING_POSITION_CLASS}
          icon={<Grid3x3 className="h-4 w-4" />}
          titleText={displayName}
          metaText={
            layerCount > 0
              ? `${layerCount} 张 · ${Math.round(data.canvasWidth || 1920)}×${Math.round(data.canvasHeight || 1080)}`
              : "待添加图片"
          }
          editable
          onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
        />

        {layerCount > 0 ? (
          <div className="h-full w-full overflow-hidden rounded-[var(--node-radius)]">
            <MosaicInlineStage
              data={data}
              layers={data.layers ?? []}
              onCommit={commitInlineLayers}
              onOpenEditor={openEditor}
              onImageRatioResolved={handleImageRatioResolved}
            />
            <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between gap-2">
              <button
                type="button"
                className="nodrag inline-flex h-7 items-center gap-1 rounded-md bg-black/60 px-2 text-[11px] text-white backdrop-blur-sm transition-colors hover:bg-black/80"
                title="添加图片"
                onClick={(event) => {
                  event.stopPropagation();
                  fileInputRef.current?.click();
                }}
              >
                <Plus className="h-3.5 w-3.5" />
                添加
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={isExporting}
                  className="nodrag h-7 rounded-md bg-accent/90 px-2 text-[11px] text-white backdrop-blur-sm transition-colors hover:bg-accent disabled:opacity-60"
                  title="按当前画幅导出，并在右侧生成拼好的图片节点"
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleExport();
                  }}
                >
                  {isExporting ? "导出中…" : "导出"}
                </button>
                <button
                  type="button"
                  className="nodrag h-7 rounded-md bg-black/60 px-2 text-[11px] text-white backdrop-blur-sm transition-colors hover:bg-black/80"
                  onClick={(event) => {
                    event.stopPropagation();
                    openEditor();
                  }}
                >
                  编辑
                </button>
              </div>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="nodrag flex h-full w-full flex-col items-center justify-center gap-2 rounded-[var(--node-radius)] bg-bg-dark text-text-muted/85 transition-colors hover:text-text-dark"
            onClick={(event) => {
              event.stopPropagation();
              fileInputRef.current?.click();
            }}
          >
            <Images className="h-7 w-7 opacity-60" />
            <span className="text-[12px]">添加图片或连接上游节点</span>
            {uploadError && <span className="text-[10px] text-red-400">{uploadError}</span>}
          </button>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={handleFileChange}
        />
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
        <NodeResizeHandle
          minWidth={NODE_MIN_WIDTH}
          minHeight={NODE_MIN_HEIGHT}
          maxWidth={NODE_MAX_WIDTH}
          maxHeight={NODE_MAX_HEIGHT}
        />
      </div>

      {isEditorOpen && (
        <SeamlessMosaicEditor
          nodeId={id}
          data={data}
          onClose={() => setIsEditorOpen(false)}
          onSyncFrame={(aspect) => {
            // 画布裁剪后比例变了：节点框跟着换，预览才不会被拉扁；
            // 记进 selfResizedRef，免得尺寸监听再把画幅缩放一遍。
            const frame = nodeSizeForCanvasAspect(aspect, resolvedWidth, NODE_BOUNDS);
            if (frame.width !== resolvedWidth || frame.height !== resolvedHeight) {
              selfResizedRef.current = frame;
              updateNodeSize(id, frame.width, frame.height);
            }
          }}
        />
      )}
    </>
  );
});

SeamlessMosaicNode.displayName = "SeamlessMosaicNode";
