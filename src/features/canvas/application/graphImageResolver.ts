import {
  isDirectorDeskNode,
  isExportImageNode,
  isGroupNode,
  isImageEditNode,
  isPanoramaNode,
  isStoryboardGenNode,
  isStoryboardSplitNode,
  isUploadNode,
  type CanvasEdge,
  type CanvasNode,
} from '../domain/canvasNodes';
import type { GraphImageResolver } from './ports';

export class DefaultGraphImageResolver implements GraphImageResolver {
  collectInputImages(nodeId: string, nodes: CanvasNode[], edges: CanvasEdge[]): string[] {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const sourceNodeIds = edges
      .filter((edge) => edge.target === nodeId)
      .map((edge) => edge.source);

    const images = sourceNodeIds
      .map((sourceId) => nodeById.get(sourceId))
      .flatMap((node) => this.extractImages(node, nodeById));

    return [...new Set(images)];
  }

  private extractImages(
    node: CanvasNode | undefined,
    nodeById: Map<string, CanvasNode>
  ): string[] {
    if (!node) {
      return [];
    }

    // 分组节点: 展开为组内所有子节点的图片(递归, 支持嵌套组), 作为多张参考图输出
    if (isGroupNode(node)) {
      const children = Array.from(nodeById.values()).filter((item) => item.parentId === node.id);
      return children.flatMap((child) => this.extractImages(child, nodeById));
    }

    if (isPanoramaNode(node)) {
      // 全景节点对外输出「取景画面」；未取景时回退到输入全景图。
      if (node.data.outputImageUrl) {
        return [node.data.outputImageUrl];
      }
      return node.data.inputImageUrl ? [node.data.inputImageUrl] : [];
    }

    if (isStoryboardSplitNode(node)) {
      return [...node.data.frames]
        .sort((left, right) => left.order - right.order)
        .map((frame) => frame.imageUrl ?? frame.previewImageUrl ?? null)
        .filter((imageUrl): imageUrl is string => Boolean(imageUrl));
    }

    if (isStoryboardGenNode(node)) {
      return node.data.imageUrl ? [node.data.imageUrl] : [];
    }

    if (isDirectorDeskNode(node)) {
      return node.data.lastCaptureUrl ? [node.data.lastCaptureUrl] : [];
    }

    if (isUploadNode(node) || isImageEditNode(node) || isExportImageNode(node)) {
      return node.data.imageUrl ? [node.data.imageUrl] : [];
    }

    return [];
  }
}
