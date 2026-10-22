import { describe, it, expect, beforeEach } from 'vitest';

import { useCanvasStore } from './canvasStore';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';

/**
 * store 层的缩放回归测试。
 *
 * AI 图片节点(imageEdit → `imageNode`)建节点时自带 `aspectRatio: '1:1'`,
 * 但它的盒子是提示词面板(默认 520x320)。它一旦落进等比锁定:
 *  - 指针还没移动的那一帧就会把 520x320 强行拉成 1:1(高度瞬间 320 → 520);
 *  - 之后每帧都拿宽度反推高度, 拖起来完全不跟手。
 * 这里从 onNodesChange 这个唯一入口验证它已经放行, 同时确认结果图片节点仍然等比。
 */

function resetStore() {
  useCanvasStore.setState({
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
  });
}

function seedNode(node: CanvasNode) {
  useCanvasStore.setState({ nodes: [node] });
}

function currentSize(nodeId: string): { width: number; height: number } {
  const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId);
  if (!node) {
    throw new Error(`节点不存在: ${nodeId}`);
  }
  return {
    width: node.measured?.width ?? node.width ?? 0,
    height: node.measured?.height ?? node.height ?? 0,
  };
}

function resizeStep(
  nodeId: string,
  size: { width: number; height: number },
  resizing: boolean,
  setAttributes?: true | 'width' | 'height'
) {
  useCanvasStore.getState().onNodesChange([
    {
      id: nodeId,
      type: 'dimensions',
      dimensions: size,
      resizing,
      ...(setAttributes ? { setAttributes } : {}),
    },
  ] as never);
}

function imageNode(id: string, width: number, height: number, aspectRatio: string): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.imageEdit,
    position: { x: 0, y: 0 },
    data: { aspectRatio } as never,
    width,
    height,
    measured: { width, height },
  };
}

function exportImageNode(id: string, width: number, height: number, aspectRatio: string): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.exportImage,
    position: { x: 0, y: 0 },
    data: { aspectRatio } as never,
    width,
    height,
    measured: { width, height },
  };
}

describe('canvasStore 缩放: AI 图片节点不再被 data.aspectRatio 拖住', () => {
  beforeEach(resetStore);

  it('指针未移动的第一帧原样保留面板尺寸(不会 520x320 变 520x520)', () => {
    seedNode(imageNode('ai-first', 520, 320, '1:1'));

    resizeStep('ai-first', { width: 520, height: 320 }, true);

    expect(currentSize('ai-first')).toEqual({ width: 520, height: 320 });
  });

  it('右边框只改宽度, 高度不被画幅比例反推', () => {
    seedNode(imageNode('ai-right', 520, 320, '16:9'));

    resizeStep('ai-right', { width: 580, height: 320 }, true, 'width');
    expect(currentSize('ai-right')).toEqual({ width: 580, height: 320 });

    resizeStep('ai-right', { width: 580, height: 320 }, false);
    expect(currentSize('ai-right')).toEqual({ width: 580, height: 320 });
  });

  it('下边框只改高度, 宽度不被画幅比例反推', () => {
    seedNode(imageNode('ai-bottom', 520, 320, '1:1'));

    resizeStep('ai-bottom', { width: 520, height: 420 }, true, 'height');
    expect(currentSize('ai-bottom')).toEqual({ width: 520, height: 420 });
  });

  it('结果图片节点仍然按媒体比例等比缩放', () => {
    seedNode(exportImageNode('result-locked', 200, 200, '1:1'));

    resizeStep('result-locked', { width: 300, height: 200 }, true, 'width');

    expect(currentSize('result-locked')).toEqual({ width: 300, height: 300 });
  });
});
