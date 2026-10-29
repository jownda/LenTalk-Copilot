import type { CanvasNode, CanvasNodeData, CanvasNodeType } from "@/features/canvas/domain/canvasNodes";
import { CANVAS_NODE_TYPES, DEFAULT_ASPECT_RATIO } from "@/features/canvas/domain/canvasNodes";

/**
 * 剪辑产物落回画布：新建一个视频节点并连到原节点。
 *
 * 基础剪辑窗口与高级剪辑共用这一份 —— 两边各写一套「节点类型 / 命名后缀 / 画幅继承」
 * 迟早会分叉（改了一边忘了另一边），而这种分叉在界面上完全看不出来。
 */
export function placeEditedVideoNode(options: {
  node: CanvasNode;
  outputPath: string;
  /** 节点名的后缀，如「· 剪辑」。 */
  suffix: string;
  /** 原节点没名字时的兜底名。 */
  fallbackName: string;
  addNode: (
    type: CanvasNodeType,
    position: { x: number; y: number },
    data: Partial<CanvasNodeData>,
  ) => string;
  addEdge: (source: string, target: string) => void;
  findNodePosition: (nodeId: string, width: number, height: number) => { x: number; y: number };
}): string {
  const { node, outputPath, suffix, fallbackName, addNode, addEdge, findNodePosition } = options;
  const baseName = node.data.displayName?.trim() || fallbackName;
  const placement = findNodePosition(node.id, 360, 240);
  const newNodeId = addNode(CANVAS_NODE_TYPES.audio, placement, {
    displayName: `${baseName} ${suffix}`,
    mediaType: "video",
    sourcePath: outputPath,
    previewImageUrl: null,
    aspectRatio:
      typeof node.data.aspectRatio === "string" && node.data.aspectRatio.trim()
        ? node.data.aspectRatio
        : DEFAULT_ASPECT_RATIO,
  });
  addEdge(node.id, newNodeId);
  return newNodeId;
}
