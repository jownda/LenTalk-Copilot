import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  ChevronUp,
  Crop,
  Download,
  Eye,
  EyeOff,
  Grid3x3,
  ImagePlus,
  LayoutGrid,
  Move,
  Trash2,
  X,
} from "lucide-react";
import { v4 as uuidv4 } from "uuid";

import type { MosaicLayerItem, MosaicTemplateId, SeamlessMosaicNodeData } from "@/features/canvas/domain/canvasNodes";
import { useCanvasStore } from "@/stores/canvasStore";
import { UiButton } from "@/components/ui";
import {
  loadImageElement,
  prepareNodeImage,
  prepareNodeImageFromFile,
  resolveImageDisplayUrl,
} from "@/features/canvas/application/imageData";

export const MOSAIC_TEMPLATES: { id: MosaicTemplateId; label: string }[] = [
  { id: "grid", label: "网格" },
  { id: "h-strip", label: "横向长图" },
  { id: "v-strip", label: "竖向长图" },
  { id: "free", label: "自由" },
];

const CANVAS_SIZE_PRESETS = [
  { id: "landscape", label: "横屏", width: 1920, height: 1080 },
  { id: "portrait", label: "竖屏", width: 1080, height: 1920 },
  { id: "square", label: "正方形", width: 1080, height: 1080 },
] as const;

function parseAspectRatio(value: string | undefined): number {
  const match = value?.match(/^(\d+(?:\.\d+)?)\s*[:：/]\s*(\d+(?:\.\d+)?)$/);
  if (!match) return 1;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? width / height : 1;
}

function getLayerAspectRatio(layer: MosaicLayerItem): number {
  const crop = layer.crop;
  return parseAspectRatio(layer.aspectRatio) * ((crop?.width ?? 1) / Math.max(0.01, crop?.height ?? 1));
}

function fitLayerWithinBounds(
  layer: MosaicLayerItem,
  x: number,
  y: number,
  maxWidth: number,
  maxHeight: number,
): MosaicLayerItem {
  const aspectRatio = getLayerAspectRatio(layer);
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

function getLayerDisplayName(layer: MosaicLayerItem, index: number): string {
  if (layer.sourceName?.trim()) return layer.sourceName.trim();
  const source = layer.imageUrl.split(/[\\/]/).pop()?.split("?")[0]?.trim();
  return source || `图层 ${index + 1}`;
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

function fitFreeformLayersToCanvas(
  layers: MosaicLayerItem[],
  canvasWidth: number,
  canvasHeight: number,
  padding: number,
): MosaicLayerItem[] {
  if (layers.length === 0) return layers;

  const minX = Math.min(...layers.map((layer) => layer.x));
  const minY = Math.min(...layers.map((layer) => layer.y));
  const maxX = Math.max(...layers.map((layer) => layer.x + layer.width));
  const maxY = Math.max(...layers.map((layer) => layer.y + layer.height));
  const contentWidth = Math.max(1, maxX - minX);
  const contentHeight = Math.max(1, maxY - minY);
  const availableWidth = Math.max(1, canvasWidth - padding * 2);
  const availableHeight = Math.max(1, canvasHeight - padding * 2);
  const scale = Math.min(1, availableWidth / contentWidth, availableHeight / contentHeight);
  const offsetX = (canvasWidth - contentWidth * scale) / 2;
  const offsetY = (canvasHeight - contentHeight * scale) / 2;

  return layers.map((layer) => ({
    ...layer,
    x: offsetX + (layer.x - minX) * scale,
    y: offsetY + (layer.y - minY) * scale,
    width: layer.width * scale,
    height: layer.height * scale,
  }));
}

interface SeamlessMosaicEditorProps {
  nodeId: string;
  data: SeamlessMosaicNodeData;
  onClose: () => void;
}

interface DragState {
  mode: "move" | "resize" | "crop";
  layerId: string;
  startX: number;
  startY: number;
  origin: { x: number; y: number; width: number; height: number };
  crop?: { x: number; y: number; width: number; height: number };
  part?: "top" | "right" | "bottom" | "left";
  baseCrop?: { x: number; y: number; width: number; height: number } | null;
}

interface CropDraft {
  layerId: string;
  crop: { x: number; y: number; width: number; height: number };
}

/** 渲染单个图层(加载源图后按 crop 精确显示裁切区域) */
function MosaicLayerView({
  layer,
  fitScale,
  selected,
  cropMode,
  onPointerDown,
  onEnterCropMode,
  onImageRatioResolved,
}: {
  layer: MosaicLayerItem;
  fitScale: number;
  selected: boolean;
  cropMode: boolean;
  onPointerDown: (event: React.PointerEvent, mode: "move" | "resize") => void;
  onEnterCropMode: () => void;
  onImageRatioResolved: (layerId: string, aspectRatio: string) => void;
}) {
  const displaySrc = useMemo(() => resolveImageDisplayUrl(layer.imageUrl), [layer.imageUrl]);

  useEffect(() => {
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (!cancelled && image.naturalWidth > 0 && image.naturalHeight > 0) {
        onImageRatioResolved(layer.id, `${image.naturalWidth}:${image.naturalHeight}`);
      }
    };
    image.src = displaySrc;
    return () => {
      cancelled = true;
    };
  }, [displaySrc, layer.id, onImageRatioResolved]);

  const visibleCrop = layer.crop ?? { x: 0, y: 0, width: 1, height: 1 };

  return (
    <div
      className={`absolute cursor-move ${selected ? "z-20" : "z-10"}`}
      style={{
        left: layer.x * fitScale,
        top: layer.y * fitScale,
        width: layer.width * fitScale,
        height: layer.height * fitScale,
        border: selected ? "2px solid rgb(96,165,250)" : "1px solid rgba(15,23,42,0.32)",
        boxShadow: selected ? "0 0 0 2px rgba(37,99,235,0.55), 0 0 16px rgba(59,130,246,0.32)" : undefined,
        opacity: typeof layer.opacity === "number" ? layer.opacity : 1,
      }}
      onPointerDown={(event) => {
        if (!cropMode) onPointerDown(event, "move");
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onEnterCropMode();
      }}
    >
      <div
        className="absolute overflow-hidden"
        style={{
          left: `${visibleCrop.x * 100}%`,
          top: `${visibleCrop.y * 100}%`,
          width: `${visibleCrop.width * 100}%`,
          height: `${visibleCrop.height * 100}%`,
        }}
      >
        <img
          src={displaySrc}
          alt=""
          draggable={false}
          className="absolute max-w-none"
          style={{
            left: `${(-visibleCrop.x / visibleCrop.width) * 100}%`,
            top: `${(-visibleCrop.y / visibleCrop.height) * 100}%`,
            width: `${100 / visibleCrop.width}%`,
            height: `${100 / visibleCrop.height}%`,
          }}
        />
      </div>
      {selected && (
        <>
          <Move className="absolute -left-6 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-blue-400" />
          {/* 右下角缩放柄 */}
          <div
            className="absolute -bottom-2 -right-2 h-4 w-4 cursor-nwse-resize rounded-full border-2 border-white bg-blue-500"
            onPointerDown={(event) => onPointerDown(event, "resize")}
          />
        </>
      )}
    </div>
  );
}

export function SeamlessMosaicEditor({ nodeId, data, onClose }: SeamlessMosaicEditorProps) {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const addDerivedExportNode = useCanvasStore((state) => state.addDerivedExportNode);
  const addEdge = useCanvasStore((state) => state.addEdge);

  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  const [cropMode, setCropMode] = useState(false);
  const [cropDraft, setCropDraft] = useState<CropDraft | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [canvasWidthDraft, setCanvasWidthDraft] = useState(String(data.canvasWidth || 1920));
  const [canvasHeightDraft, setCanvasHeightDraft] = useState(String(data.canvasHeight || 1080));
  const dragRef = useRef<DragState | null>(null);
  const canvasAreaRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fitScale, setFitScale] = useState(0.4);

  const layers = useMemo(() => {
    return [...(data.layers ?? [])].sort((a, b) => a.order - b.order);
  }, [data.layers]);
  const canvasWidth = Math.max(1, data.canvasWidth || 1920);
  const canvasHeight = Math.max(1, data.canvasHeight || 1080);
  const gridCols = Math.max(1, data.gridCols || 3);
  const gridRows = Math.max(1, data.gridRows || 2);
  const gap = Math.max(0, data.gap ?? 8);

  useEffect(() => {
    setCanvasWidthDraft(String(canvasWidth));
    setCanvasHeightDraft(String(canvasHeight));
  }, [canvasHeight, canvasWidth]);

  const applyCanvasSize = useCallback(
    (width: number, height: number) => {
      const safeWidth = Math.min(8192, Math.max(64, Math.round(width)));
      const safeHeight = Math.min(8192, Math.max(64, Math.round(height)));
      const sourceLayers = data.layers ?? [];
      const nextLayers =
        data.template === "free"
          ? fitFreeformLayersToCanvas(sourceLayers, safeWidth, safeHeight, Math.max(16, data.gap ?? 8))
          : layoutMosaicLayers(
              sourceLayers,
              data.template,
              safeWidth,
              safeHeight,
              data.gridCols ?? 3,
              Math.max(data.gridRows ?? 2, Math.ceil(sourceLayers.length / Math.max(1, data.gridCols ?? 3))),
              Math.max(0, data.gap ?? 8),
            );
      updateNodeData(nodeId, {
        canvasWidth: safeWidth,
        canvasHeight: safeHeight,
        layers: nextLayers,
        outputImageUrl: null,
        outputPreviewImageUrl: null,
      });
    },
    [data.gap, data.gridCols, data.gridRows, data.layers, data.template, nodeId, updateNodeData],
  );

  const applyCustomCanvasSize = useCallback(() => {
    const width = Number(canvasWidthDraft);
    const height = Number(canvasHeightDraft);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 64 || height < 64) {
      setExportError("请输入 64 到 8192 之间的画布宽高");
      return;
    }
    setExportError(null);
    applyCanvasSize(width, height);
  }, [applyCanvasSize, canvasHeightDraft, canvasWidthDraft]);

  // 画布等比缩放适配可视区域
  useEffect(() => {
    const el = canvasAreaRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      const scale = Math.min((rect.width - 48) / canvasWidth, (rect.height - 48) / canvasHeight, 1);
      setFitScale(Math.max(0.05, scale));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [canvasHeight, canvasWidth]);

  const updateLayers = useCallback(
    (updater: (previous: MosaicLayerItem[]) => MosaicLayerItem[]) => {
      updateNodeData(nodeId, {
        layers: updater(data.layers ?? []),
        outputImageUrl: null,
        outputPreviewImageUrl: null,
      });
    },
    [data.layers, nodeId, updateNodeData],
  );

  const patchLayer = useCallback(
    (layerId: string, patch: Partial<MosaicLayerItem>) => {
      updateLayers((previous) => previous.map((layer) => (layer.id === layerId ? { ...layer, ...patch } : layer)));
    },
    [updateLayers],
  );

  const handleImageRatioResolved = useCallback(
    (layerId: string, aspectRatio: string) => {
      const layer = data.layers?.find((item) => item.id === layerId);
      if (!layer || layer.crop || layer.aspectRatio === aspectRatio) return;
      const ratio = parseAspectRatio(aspectRatio);
      patchLayer(layerId, {
        aspectRatio,
        width: Math.max(16, layer.height * ratio),
      });
    },
    [data.layers, patchLayer],
  );

  const moveLayerOrder = useCallback(
    (layerId: string, delta: number) => {
      updateLayers((previous) => {
        const sorted = [...previous].sort((a, b) => a.order - b.order);
        const index = sorted.findIndex((layer) => layer.id === layerId);
        const target = index + delta;
        if (index < 0 || target < 0 || target >= sorted.length) {
          return previous;
        }
        const [item] = sorted.splice(index, 1);
        sorted.splice(target, 0, item);
        return sorted.map((layer, order) => ({ ...layer, order }));
      });
    },
    [updateLayers],
  );

  const removeLayer = useCallback(
    (layerId: string) => {
      updateLayers((previous) => {
        const next = previous.filter((layer) => layer.id !== layerId);
        return next.map((layer, index) => ({ ...layer, order: index }));
      });
      if (selectedLayerId === layerId) {
        setSelectedLayerId(null);
      }
    },
    [selectedLayerId, updateLayers],
  );

  const toggleLayerVisible = useCallback(
    (layerId: string) => {
      const layer = data.layers?.find((item) => item.id === layerId);
      if (!layer) return;
      patchLayer(layerId, { visible: !layer.visible });
    },
    [data.layers, patchLayer],
  );

  const applyTemplate = useCallback(
    (template: MosaicTemplateId) => {
      const nextLayers = layoutMosaicLayers(
        data.layers ?? [],
        template,
        canvasWidth,
        canvasHeight,
        gridCols,
        gridRows,
        gap,
      );
      updateNodeData(nodeId, {
        template,
        layers: nextLayers,
        gridRows: Math.max(gridRows, Math.ceil((data.layers?.length ?? 0) / Math.max(1, gridCols))),
        outputImageUrl: null,
        outputPreviewImageUrl: null,
      });
    },
    [canvasHeight, canvasWidth, data.layers, gap, gridCols, gridRows, nodeId, updateNodeData],
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
          added.push({
            id: uuidv4(),
            imageUrl: prepared.imageUrl,
            previewImageUrl: prepared.previewImageUrl,
            sourceName: file.name,
            aspectRatio: prepared.aspectRatio,
            x: 0,
            y: 0,
            width: 512,
            height: 512,
            crop: null,
            visible: true,
            order: (data.layers?.length ?? 0) + added.length,
            opacity: 1,
          });
        } catch (error) {
          console.warn("[Mosaic] add image failed", file.name, error);
        }
      }
      if (added.length === 0) {
        setExportError("图片添加失败，请重试");
        return;
      }

      const existing = data.layers ?? [];
      const nextLayers = [...existing, ...added];
      const nextRows = Math.max(gridRows, Math.ceil(nextLayers.length / Math.max(1, gridCols)));
      updateNodeData(nodeId, {
        layers: layoutMosaicLayers(nextLayers, data.template, canvasWidth, canvasHeight, gridCols, nextRows, gap),
        gridRows: nextRows,
        outputImageUrl: null,
        outputPreviewImageUrl: null,
      });
    },
    [canvasHeight, canvasWidth, data.layers, data.template, gap, gridCols, gridRows, nodeId, updateNodeData],
  );

  // 画布指针事件: 拖拽移动 / 缩放手柄
  const handlePointerDown = useCallback(
    (event: React.PointerEvent, layer: MosaicLayerItem, mode: "move" | "resize") => {
      event.preventDefault();
      event.stopPropagation();
      setSelectedLayerId(layer.id);
      setCropMode(false);
      dragRef.current = {
        mode,
        layerId: layer.id,
        startX: event.clientX,
        startY: event.clientY,
        origin: { x: layer.x, y: layer.y, width: layer.width, height: layer.height },
      };
    },
    [],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = (event.clientX - drag.startX) / fitScale;
      const dy = (event.clientY - drag.startY) / fitScale;
      const layer = data.layers?.find((item) => item.id === drag.layerId);
      if (!layer) return;

      if (drag.mode === "move") {
        patchLayer(drag.layerId, {
          x: Math.max(0, drag.origin.x + dx),
          y: Math.max(0, drag.origin.y + dy),
        });
        return;
      }

      if (drag.mode === "resize") {
        const aspectRatio = drag.origin.width / Math.max(1, drag.origin.height);
        const nextWidth = Math.max(16, drag.origin.width + dx);
        patchLayer(drag.layerId, {
          width: nextWidth,
          height: Math.max(16, nextWidth / aspectRatio),
        });
      }
    },
    [data.layers, fitScale, patchLayer],
  );

  const handlePointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  const enterCropMode = useCallback((layer: MosaicLayerItem) => {
    setSelectedLayerId(layer.id);
    setCropDraft({
      layerId: layer.id,
      crop: layer.crop ?? { x: 0, y: 0, width: 1, height: 1 },
    });
    setCropMode(true);
  }, []);

  const applyCropDraft = useCallback(() => {
    if (!cropDraft) return;
    patchLayer(cropDraft.layerId, { crop: cropDraft.crop });
    setCropDraft(null);
    setCropMode(false);
  }, [cropDraft, patchLayer]);

  // 裁切框状态: 在草稿中调整四条边，点击画布空白处后再一次性写入图层。
  const cropRect = useMemo(() => {
    const layer = data.layers?.find((item) => item.id === selectedLayerId);
    if (!layer || !cropMode || cropDraft?.layerId !== layer.id) return null;
    const crop = cropDraft.crop;
    return { crop, layer };
  }, [cropDraft, cropMode, data.layers, selectedLayerId]);

  const handleCropPointerDown = useCallback(
    (event: React.PointerEvent, part: "top" | "right" | "bottom" | "left") => {
      event.preventDefault();
      event.stopPropagation();
      const layer = data.layers?.find((item) => item.id === cropDraft?.layerId);
      if (!layer || !cropDraft) return;
      dragRef.current = {
        mode: "crop",
        layerId: layer.id,
        startX: event.clientX,
        startY: event.clientY,
        origin: { x: layer.x, y: layer.y, width: layer.width, height: layer.height },
        part,
        baseCrop: cropDraft.crop,
      };
    },
    [cropDraft, data.layers],
  );

  const handleCropPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const drag = dragRef.current;
      const layer = data.layers?.find((item) => item.id === drag?.layerId);
      if (!drag || drag.mode !== "crop" || !layer || !drag.baseCrop) return;
      const dx = (event.clientX - drag.startX) / fitScale;
      const dy = (event.clientY - drag.startY) / fitScale;
      const part = drag.part;
      const ndx = dx / Math.max(1, layer.width);
      const ndy = dy / Math.max(1, layer.height);
      const base = drag.baseCrop;

      const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

      let nextX = base.x;
      let nextY = base.y;
      let nextW = base.width;
      let nextH = base.height;
      if (part === "left") {
        nextX = clamp(base.x + ndx, 0, base.x + base.width - 0.05);
        nextW = base.width + (base.x - nextX);
      } else if (part === "right") {
        nextW = clamp(base.width + ndx, 0.05, 1 - base.x);
      }
      if (part === "top") {
        nextY = clamp(base.y + ndy, 0, base.y + base.height - 0.05);
        nextH = base.height + (base.y - nextY);
      } else if (part === "bottom") {
        nextH = clamp(base.height + ndy, 0.05, 1 - base.y);
      }
      setCropDraft({ layerId: layer.id, crop: { x: nextX, y: nextY, width: nextW, height: nextH } });
    },
    [data.layers, fitScale],
  );

  const resetCrop = useCallback(
    (layerId: string) => {
      patchLayer(layerId, { crop: null });
      setCropMode(false);
      setCropDraft(null);
    },
    [patchLayer],
  );

  // 导出: canvas 合成所有可见图层
  const handleExport = useCallback(async () => {
    setIsExporting(true);
    setExportError(null);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("无法创建画布上下文");
      }
      context.fillStyle = data.backgroundColor ?? "#0f1115";
      context.fillRect(0, 0, canvasWidth, canvasHeight);

      const sorted = [...(data.layers ?? [])].filter((layer) => layer.visible).sort((a, b) => a.order - b.order);
      if (sorted.length === 0) {
        throw new Error("请先添加至少一张可见图片");
      }

      let renderedLayerCount = 0;
      for (const layer of sorted) {
        try {
          const image = await loadImageElement(layer.imageUrl);
          const crop = layer.crop ?? { x: 0, y: 0, width: 1, height: 1 };
          const scale = Math.min(
            layer.width / Math.max(1, image.naturalWidth),
            layer.height / Math.max(1, image.naturalHeight),
          );
          const targetWidth = image.naturalWidth * scale;
          const targetHeight = image.naturalHeight * scale;
          const targetX = layer.x + (layer.width - targetWidth) / 2;
          const targetY = layer.y + (layer.height - targetHeight) / 2;
          context.globalAlpha = typeof layer.opacity === "number" ? layer.opacity : 1;
          context.save();
          context.beginPath();
          context.rect(
            targetX + crop.x * targetWidth,
            targetY + crop.y * targetHeight,
            crop.width * targetWidth,
            crop.height * targetHeight,
          );
          context.clip();
          context.drawImage(image, targetX, targetY, targetWidth, targetHeight);
          context.restore();
          renderedLayerCount += 1;
        } catch (error) {
          console.warn("[Mosaic] layer draw failed, skipped", layer.id, error);
        }
      }
      context.globalAlpha = 1;
      if (renderedLayerCount === 0) {
        throw new Error("图片无法加载，暂时不能导出");
      }

      const dataUrl = canvas.toDataURL("image/png");
      const prepared = await prepareNodeImage(dataUrl);
      const createdNodeId = addDerivedExportNode(
        nodeId,
        prepared.imageUrl,
        prepared.aspectRatio,
        prepared.previewImageUrl,
        {
          defaultTitle: "无缝拼图",
          resultKind: "generic",
          aspectRatioStrategy: "provided",
          sizeStrategy: "autoMinEdge",
        },
      );
      if (createdNodeId) {
        addEdge(nodeId, createdNodeId);
      }
      updateNodeData(nodeId, {
        outputImageUrl: prepared.imageUrl,
        outputPreviewImageUrl: prepared.previewImageUrl,
      });
      onClose();
    } catch (error) {
      setExportError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsExporting(false);
    }
  }, [
    addDerivedExportNode,
    addEdge,
    canvasHeight,
    canvasWidth,
    data.backgroundColor,
    data.layers,
    nodeId,
    onClose,
    updateNodeData,
  ]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-[#0a0c10]/97 text-text-dark backdrop-blur-sm">
      {/* 顶部工具栏 */}
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-white/10 bg-surface-dark/80 px-4">
        <div className="flex items-center gap-2">
          <Grid3x3 className="h-4 w-4 text-accent" />
          <span className="text-sm font-medium">无缝拼图编辑器</span>
          <span className="text-[11px] text-text-muted">
            {data.layers?.length ?? 0} 层 · {canvasWidth}×{canvasHeight}
          </span>
        </div>

        <div className="ml-4 flex items-center gap-1 rounded-lg border border-white/10 bg-bg-dark p-0.5">
          {MOSAIC_TEMPLATES.map((template) => (
            <button
              key={template.id}
              type="button"
              onClick={() => applyTemplate(template.id)}
              className={`rounded-md px-2.5 py-1 text-[11px] transition-colors ${
                data.template === template.id ? "bg-accent text-white" : "text-text-muted hover:text-text-dark"
              }`}
            >
              {template.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-bg-dark p-0.5">
          {CANVAS_SIZE_PRESETS.map((preset) => {
            const active = canvasWidth === preset.width && canvasHeight === preset.height;
            return (
              <button
                key={preset.id}
                type="button"
                className={`rounded-md px-2 py-1 text-[11px] transition-colors ${
                  active ? "bg-accent text-white" : "text-text-muted hover:text-text-dark"
                }`}
                onClick={() => applyCanvasSize(preset.width, preset.height)}
              >
                {preset.label}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-1.5 text-[11px] text-text-muted">
          <label className="flex items-center gap-1">
            画布宽
            <input
              type="number"
              min={64}
              max={8192}
              step={64}
              value={canvasWidthDraft}
              onChange={(event) => setCanvasWidthDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") applyCustomCanvasSize();
              }}
              className="w-20 rounded border border-white/10 bg-bg-dark px-2 py-1 text-text-dark"
            />
          </label>
          <label className="flex items-center gap-1">
            高
            <input
              type="number"
              min={64}
              max={8192}
              step={64}
              value={canvasHeightDraft}
              onChange={(event) => setCanvasHeightDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") applyCustomCanvasSize();
              }}
              className="w-20 rounded border border-white/10 bg-bg-dark px-2 py-1 text-text-dark"
            />
          </label>
          <button
            type="button"
            className="rounded bg-accent px-2 py-1 font-medium text-white transition-colors hover:bg-accent/85"
            onClick={applyCustomCanvasSize}
          >
            确定
          </button>
          <label className="flex items-center gap-1">
            背景
            <input
              type="color"
              value={data.backgroundColor ?? "#0f1115"}
              onChange={(event) =>
                updateNodeData(nodeId, {
                  backgroundColor: event.target.value,
                  outputImageUrl: null,
                  outputPreviewImageUrl: null,
                })
              }
              className="h-6 w-8 cursor-pointer rounded border border-white/10 bg-bg-dark"
            />
          </label>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {exportError && <span className="text-[11px] text-red-400">{exportError}</span>}
          <UiButton size="sm" variant="ghost" onClick={() => fileInputRef.current?.click()} disabled={isExporting}>
            <ImagePlus className="h-3.5 w-3.5" />
            添加图片
          </UiButton>
          <UiButton size="sm" variant="ghost" onClick={onClose} disabled={isExporting}>
            <X className="h-3.5 w-3.5" />
            关闭
          </UiButton>
          <UiButton size="sm" variant="primary" onClick={() => void handleExport()} disabled={isExporting}>
            <Download className="h-3.5 w-3.5" />
            {isExporting ? "导出中…" : "导出拼图"}
          </UiButton>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 画布区域 */}
        <div
          ref={canvasAreaRef}
          className="relative flex min-w-0 flex-1 items-center justify-center overflow-hidden p-6"
        >
          <div
            className="relative overflow-hidden rounded-lg border border-white/10 shadow-2xl"
            style={{
              width: canvasWidth * fitScale,
              height: canvasHeight * fitScale,
              backgroundColor: data.backgroundColor ?? "#0f1115",
              touchAction: "none",
            }}
            onPointerMove={(event) => {
              if (dragRef.current?.mode === "crop") {
                handleCropPointerMove(event);
              } else {
                handlePointerMove(event);
              }
            }}
            onPointerDown={(event) => {
              if (event.target === event.currentTarget && cropMode) {
                applyCropDraft();
              }
            }}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
            onPointerCancel={handlePointerUp}
          >
            {layers
              .filter((layer) => layer.visible)
              .map((layer) => (
                <MosaicLayerView
                  key={layer.id}
                  layer={layer}
                  fitScale={fitScale}
                  selected={layer.id === selectedLayerId}
                  cropMode={cropMode && layer.id === selectedLayerId}
                  onPointerDown={(event, mode) => handlePointerDown(event, layer, mode)}
                  onEnterCropMode={() => enterCropMode(layer)}
                  onImageRatioResolved={handleImageRatioResolved}
                />
              ))}

            {/* 裁切框覆盖层 */}
            {cropRect && cropRect.layer && (
              <div
                className="pointer-events-none absolute z-30"
                style={{
                  left: (cropRect.layer.x + cropRect.crop.x * cropRect.layer.width) * fitScale,
                  top: (cropRect.layer.y + cropRect.crop.y * cropRect.layer.height) * fitScale,
                  width: cropRect.crop.width * cropRect.layer.width * fitScale,
                  height: cropRect.crop.height * cropRect.layer.height * fitScale,
                }}
              >
                <div className="absolute -inset-px border-2 border-dashed border-amber-400/90" />
                <div className="absolute -top-6 left-0 whitespace-nowrap rounded bg-amber-500/90 px-1.5 py-0.5 text-[10px] text-white">
                  拖动四条边裁切 · 点击画布空白处应用
                </div>
                {(["top", "right", "bottom", "left"] as const).map((edge) => (
                  <div
                    key={edge}
                    className={`pointer-events-auto absolute bg-amber-400/70 ${
                      edge === "top" || edge === "bottom"
                        ? "h-2 w-full cursor-ns-resize"
                        : "h-full w-2 cursor-ew-resize"
                    }`}
                    style={
                      {
                        [edge]: -4,
                      } as React.CSSProperties
                    }
                    onPointerDown={(event) => handleCropPointerDown(event, edge)}
                  />
                ))}
              </div>
            )}

            {layers.length === 0 && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-text-muted">
                <Grid3x3 className="h-8 w-8 opacity-40" />
                <span className="text-xs">把画布上的图片连到此节点即可自动导入</span>
              </div>
            )}
          </div>
        </div>

        {/* 图层面板 */}
        <div className="flex w-60 shrink-0 flex-col border-l border-white/10 bg-surface-dark/60">
          <div className="flex items-center justify-between px-3 py-2.5">
            <span className="text-xs font-medium text-text-dark">图层</span>
            <span className="text-[10px] text-text-muted">双击图层进入裁切</span>
          </div>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-2">
            {layers.map((layer, index) => (
              <div
                key={layer.id}
                className={`group flex items-center gap-1.5 rounded-lg border px-2 py-1.5 ${
                  layer.id === selectedLayerId
                    ? "border-accent/60 bg-accent/10"
                    : "border-white/8 bg-bg-dark/60 hover:border-white/20"
                }`}
                onClick={() => setSelectedLayerId(layer.id)}
              >
                <div
                  className="h-9 w-9 shrink-0 overflow-hidden rounded border border-white/10"
                  style={{
                    backgroundImage: `url(${resolveImageDisplayUrl(layer.imageUrl)})`,
                    backgroundSize: "contain",
                    backgroundRepeat: "no-repeat",
                    backgroundPosition: "center",
                    opacity: layer.visible ? 1 : 0.35,
                  }}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[11px] text-text-dark" title={getLayerDisplayName(layer, index)}>
                    {getLayerDisplayName(layer, index)}
                  </div>
                  <div className="text-[10px] text-text-muted">
                    {Math.round(layer.width)}×{Math.round(layer.height)}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
                  <button
                    type="button"
                    title="上移一层"
                    onClick={(event) => {
                      event.stopPropagation();
                      moveLayerOrder(layer.id, -1);
                    }}
                    className="rounded p-1 text-text-muted hover:bg-white/10 hover:text-text-dark"
                  >
                    <ChevronUp className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    title="下移一层"
                    onClick={(event) => {
                      event.stopPropagation();
                      moveLayerOrder(layer.id, 1);
                    }}
                    className="rounded p-1 text-text-muted hover:bg-white/10 hover:text-text-dark"
                  >
                    <ChevronDown className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    title={layer.visible ? "隐藏" : "显示"}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleLayerVisible(layer.id);
                    }}
                    className="rounded p-1 text-text-muted hover:bg-white/10 hover:text-text-dark"
                  >
                    {layer.visible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                  </button>
                  <button
                    type="button"
                    title="裁切图片"
                    onClick={(event) => {
                      event.stopPropagation();
                      enterCropMode(layer);
                    }}
                    className="rounded p-1 text-text-muted hover:bg-white/10 hover:text-text-dark"
                  >
                    <Crop className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    title="删除图层"
                    onClick={(event) => {
                      event.stopPropagation();
                      removeLayer(layer.id);
                    }}
                    className="rounded p-1 text-text-muted hover:bg-red-500/20 hover:text-red-400"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </div>
            ))}
            {layers.length === 0 && (
              <div className="rounded-lg border border-dashed border-white/10 p-4 text-center text-[11px] text-text-muted">
                暂无图层
              </div>
            )}
          </div>
          {selectedLayerId && (
            <div className="shrink-0 border-t border-white/10 px-3 py-2.5 text-[11px] text-text-muted">
              {(() => {
                const layer = data.layers?.find((item) => item.id === selectedLayerId);
                if (!layer) return null;
                return (
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span className="w-8 shrink-0">缩放</span>
                      <input
                        type="range"
                        min={16}
                        max={canvasWidth}
                        value={Math.round(layer.width)}
                        onChange={(event) => {
                          const width = Number(event.target.value);
                          const ratio = width / layer.width;
                          patchLayer(layer.id, {
                            width,
                            height: Math.max(16, layer.height * ratio),
                          });
                        }}
                        className="w-full"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-8 shrink-0">不透明</span>
                      <input
                        type="range"
                        min={5}
                        max={100}
                        value={Math.round((layer.opacity ?? 1) * 100)}
                        onChange={(event) => patchLayer(layer.id, { opacity: Number(event.target.value) / 100 })}
                        className="w-full"
                      />
                    </div>
                    <div className="flex items-center gap-1 pt-0.5">
                      <LayoutGrid className="h-3 w-3" />
                      <span>{layer.crop ? "已裁切" : "整图显示"}</span>
                      <button
                        type="button"
                        onClick={() => resetCrop(layer.id)}
                        className="ml-auto rounded border border-white/10 px-1.5 py-0.5 hover:border-white/30"
                      >
                        重置
                      </button>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(event) => void handleAddImages(event)}
      />
    </div>,
    document.body,
  );
}
