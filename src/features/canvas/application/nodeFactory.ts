import type { XYPosition } from '@xyflow/react';

import type { CanvasNode, CanvasNodeData, CanvasNodeType } from '../domain/canvasNodes';
import type { IdGenerator, NodeCatalog, NodeFactory } from './ports';

export class CanvasNodeFactory implements NodeFactory {
  constructor(
    private readonly idGenerator: IdGenerator,
    private readonly nodeCatalog: NodeCatalog
  ) {}

  createNode(
    type: CanvasNodeType,
    position: XYPosition,
    data: Partial<CanvasNodeData> = {},
    size?: { width: number; height: number }
  ): CanvasNode {
    const definition = this.nodeCatalog.getDefinition(type);
    const nodeData = {
      ...definition.createDefaultData(),
      ...data,
    } as CanvasNodeData;

    // 显式尺寸优先于节点类型的默认尺寸：文本节点在菜单里新建时是紧凑尺寸，
    // 但「扒视频」落下来的剧本节点需要更大一块版面。
    const resolvedSize = size ?? definition.defaultSize;

    return {
      id: this.idGenerator.next(),
      type,
      position,
      data: nodeData,
      ...(resolvedSize
        ? { style: { width: resolvedSize.width, height: resolvedSize.height } }
        : {}),
    };
  }
}
