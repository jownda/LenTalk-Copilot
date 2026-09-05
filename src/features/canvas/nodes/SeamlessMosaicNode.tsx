import { memo, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
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
import { useCanvasStore } from "@/stores/canvasStore";
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from "@/features/canvas/ui/NodeHeader";
import { NodeResizeHandle } from "@/features/canvas/ui/NodeResizeHandle";
import { layoutMosaicLayers, SeamlessMosaicEditor } from "@/features/canvas/ui/SeamlessMosaicEditor";

const NODE_DEFAULT_WIDTH = 280;
const NODE_MIN_WIDTH = 220;
const NODE_MIN_HEIGHT = 170;

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
  return {
    id: uuidv4(),
    imageUrl: source.imageUrl,
    previewImageUrl: source.previewImageUrl,
    aspectRatio: source.aspectRatio,
    sourceName: source.sourceName,
    x: 0,
    y: 0,
    width: 512,
    height: 512,
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

function MosaicCardPreview({ data }: { data: SeamlessMosaicNodeData }) {
  const layers = useMemo(
    () => [...(data.layers ?? [])].filter((layer) => layer.visible).sort((a, b) => a.order - b.order),
    [data.layers],
  );
  const canvasWidth = Math.max(1, data.canvasWidth || 1920);
  const canvasHeight = Math.max(1, data.canvasHeight || 1080);

  if (data.outputImageUrl || data.outputPreviewImageUrl) {
    return (
      <img
        src={resolveImageDisplayUrl(data.outputPreviewImageUrl || data.outputImageUrl || "")}
        alt="无缝拼图输出"
        className="h-full w-full object-contain"
        draggable={false}
      />
    );
  }

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#11151d]">
      {layers.map((layer) => (
        <img
          key={layer.id}
          src={resolveImageDisplayUrl(layer.previewImageUrl || layer.imageUrl)}
          alt=""
          draggable={false}
          className="absolute object-contain"
          style={{
            left: `${(layer.x / canvasWidth) * 100}%`,
            top: `${(layer.y / canvasHeight) * 100}%`,
            width: `${(layer.width / canvasWidth) * 100}%`,
            height: `${(layer.height / canvasHeight) * 100}%`,
            opacity: layer.opacity ?? 1,
          }}
        />
      ))}
    </div>
  );
}

export const SeamlessMosaicNode = memo(({ id, data, selected, width, height }: SeamlessMosaicNodeProps) => {
  const updateNodeInternals = useUpdateNodeInternals();
  const { nodes, edges } = useCanvasInputGraph();
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const importingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

      updateNodeData(id, {
        layers: layoutMosaicLayers(
          nextLayers,
          data.template ?? "grid",
          Math.max(64, data.canvasWidth || 1920),
          Math.max(64, data.canvasHeight || 1080),
          data.gridCols ?? 3,
          gridRows,
          Math.max(0, data.gap ?? 8),
        ),
        gridRows,
        importedSourceKeys: importedKeys ?? data.importedSourceKeys ?? [],
        outputImageUrl: null,
        outputPreviewImageUrl: null,
      });
    },
    [data, id, updateNodeData],
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
          metaText={layerCount > 0 ? `${layerCount} 张图片` : "待添加图片"}
          editable
          onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
        />

        {layerCount > 0 ? (
          <div className="h-full w-full overflow-hidden rounded-[var(--node-radius)]">
            <MosaicCardPreview data={data} />
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
              <button
                type="button"
                className="nodrag h-7 rounded-md bg-black/60 px-2 text-[11px] text-white backdrop-blur-sm transition-colors hover:bg-black/80"
                onClick={(event) => {
                  event.stopPropagation();
                  openEditor();
                }}
              >
                编辑拼图
              </button>
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
        <NodeResizeHandle minWidth={NODE_MIN_WIDTH} minHeight={NODE_MIN_HEIGHT} maxWidth={1400} maxHeight={1400} />
      </div>

      {isEditorOpen && <SeamlessMosaicEditor nodeId={id} data={data} onClose={() => setIsEditorOpen(false)} />}
    </>
  );
});

SeamlessMosaicNode.displayName = "SeamlessMosaicNode";
