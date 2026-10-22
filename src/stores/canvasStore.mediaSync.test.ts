import { describe, it, expect, beforeEach } from 'vitest';

import { useCanvasStore } from './canvasStore';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';

/**
 * 媒体节点(结果图片 / 上传图片 / 视频)的边框不再允许用户拖动改尺寸,
 * 而是由画面实测宽高反推 —— 这组用例锁定 store 侧的行为。
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

function nodeOf(id: string): CanvasNode {
  const node = useCanvasStore.getState().nodes.find((item) => item.id === id);
  if (!node) {
    throw new Error(`节点不存在: ${id}`);
  }
  return node;
}

function makeNode(
  id: string,
  type: CanvasNode['type'],
  width: number,
  height: number,
  aspectRatio: string
): CanvasNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { aspectRatio } as never,
    width,
    height,
    measured: { width, height },
  };
}

describe('canvasStore.syncMediaNodeMediaSize: 边框跟着画面走', () => {
  beforeEach(resetStore);

  it('画面比例变了, 边框按面积重算成新比例并写回真实比例', () => {
    seedNode(makeNode('result', CANVAS_NODE_TYPES.exportImage, 171, 96, '16:9'));

    useCanvasStore.getState().syncMediaNodeMediaSize('result', 1024, 1024);

    const node = nodeOf('result');
    expect(node.width).toBe(128);
    expect(node.height).toBe(128);
    // style 也要同步, 否则 React Flow 的 wrapper 与组件内联样式会打架
    expect(node.style).toMatchObject({ width: 128, height: 128 });
    expect((node.data as { aspectRatio?: string }).aspectRatio).toBe('1:1');
  });

  it('同一画面重复同步不会改动节点(不会反复触发路由重算)', () => {
    seedNode(makeNode('result', CANVAS_NODE_TYPES.exportImage, 171, 96, '16:9'));

    useCanvasStore.getState().syncMediaNodeMediaSize('result', 1920, 1080);
    const revisionAfterFirst = useCanvasStore.getState().routingRevision;
    const sizeAfterFirst = nodeOf('result').width;

    useCanvasStore.getState().syncMediaNodeMediaSize('result', 1920, 1080);

    expect(nodeOf('result').width).toBe(sizeAfterFirst);
    expect(useCanvasStore.getState().routingRevision).toBe(revisionAfterFirst);
  });

  it('竖屏视频把原本横着的边框掰成竖的', () => {
    seedNode(makeNode('video', CANVAS_NODE_TYPES.audio, 200, 100, '16:9'));

    useCanvasStore.getState().syncMediaNodeMediaSize('video', 1080, 1920);

    const node = nodeOf('video');
    expect(node.height).toBeGreaterThan(node.width as number);
    expect((node.width as number) / (node.height as number)).toBeCloseTo(1080 / 1920, 1);
    expect((node.data as { aspectRatio?: string }).aspectRatio).toBe('9:16');
  });

  it('AI 图片面板节点(盒子是提示词面板)不参与画面反推', () => {
    seedNode(makeNode('panel', CANVAS_NODE_TYPES.imageEdit, 520, 320, '1:1'));

    useCanvasStore.getState().syncMediaNodeMediaSize('panel', 1920, 1080);

    expect(nodeOf('panel').width).toBe(520);
    expect(nodeOf('panel').height).toBe(320);
    expect((nodeOf('panel').data as { aspectRatio?: string }).aspectRatio).toBe('1:1');
  });

  it('媒体宽高不合法时原样返回', () => {
    seedNode(makeNode('result', CANVAS_NODE_TYPES.exportImage, 171, 96, '16:9'));

    useCanvasStore.getState().syncMediaNodeMediaSize('result', 0, 0);

    expect(nodeOf('result').width).toBe(171);
    expect(nodeOf('result').height).toBe(96);
  });

  it('同步尺寸不该进撤销栈(它只是渲染侧测量)', () => {
    seedNode(makeNode('result', CANVAS_NODE_TYPES.exportImage, 171, 96, '16:9'));
    const pastBefore = useCanvasStore.getState().history.past.length;

    useCanvasStore.getState().syncMediaNodeMediaSize('result', 1000, 1000);

    expect(useCanvasStore.getState().history.past.length).toBe(pastBefore);
  });
});
