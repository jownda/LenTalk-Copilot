import { describe, it, expect, beforeEach } from 'vitest';
import { useCanvasStore } from './canvasStore';
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';

function resetStore() {
  useCanvasStore.setState({
    nodes: [],
    edges: [],
    selectedNodeId: null,
    activeToolDialog: null,
    history: { past: [], future: [] },
    dragHistorySnapshot: null,
    hoveredGroupId: null,
    flashGroupId: null,
    chargingGroupId: null,
  });
}

function addTextNode(x = 100, y = 100): string {
  return useCanvasStore.getState().addNode('textAnnotationNode', { x, y });
}

/** 模拟 React Flow 对单个节点的 drag 起止(position change, dragging true → false) */
function emitDrag(nodeId: string, position: { x: number; y: number }) {
  const store = useCanvasStore.getState();
  store.onNodesChange([
    { id: nodeId, type: 'position', position, dragging: true },
  ]);
  store.onNodesChange([
    { id: nodeId, type: 'position', position, dragging: false },
  ]);
}

describe('canvasStore history (undo/redo)', () => {
  beforeEach(resetStore);

  it('点击节点(无实际移动)不写入历史, 也不清空 redo 栈', () => {
    const id = addTextNode(100, 100);
    // 真实操作: 拖动节点
    emitDrag(id, { x: 150, y: 100 });
    expect(useCanvasStore.getState().history.past.length).toBeGreaterThan(0);

    // undo → 恢复到拖前位置
    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().nodes[0].position.x).toBe(100);
    expect(useCanvasStore.getState().history.future.length).toBe(1);

    // 点击节点(选中, 无移动): 不应新增历史条目, 也不应清空 redo 栈
    const pastBefore = useCanvasStore.getState().history.past.length;
    emitDrag(id, { x: 100, y: 100 });
    expect(useCanvasStore.getState().history.past.length).toBe(pastBefore);
    expect(useCanvasStore.getState().history.future.length).toBe(1);

    // redo 仍然可用
    expect(useCanvasStore.getState().redo()).toBe(true);
    expect(useCanvasStore.getState().nodes[0].position.x).toBe(150);
  });

  it('真正拖动节点后 undo/redo 正确恢复位置', () => {
    const id = addTextNode(100, 100);
    emitDrag(id, { x: 200, y: 220 });

    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().nodes[0].position).toEqual({ x: 100, y: 100 });

    expect(useCanvasStore.getState().redo()).toBe(true);
    expect(useCanvasStore.getState().nodes[0].position).toEqual({ x: 200, y: 220 });
  });

  it('dimensions 测量变化(无 resizing 字段)不写入历史', () => {
    const id = addTextNode();
    const pastBefore = useCanvasStore.getState().history.past.length;

    useCanvasStore.getState().onNodesChange([
      { id, type: 'dimensions', dimensions: { width: 320, height: 200 } },
    ]);

    expect(useCanvasStore.getState().history.past.length).toBe(pastBefore);
  });

  it('resize 结束(有 resizing: false)且尺寸变化时写入历史', () => {
    const id = addTextNode();
    const pastBefore = useCanvasStore.getState().history.past.length;

    useCanvasStore.getState().onNodesChange([
      { id, type: 'dimensions', dimensions: { width: 400, height: 260 }, resizing: true },
    ]);
    useCanvasStore.getState().onNodesChange([
      { id, type: 'dimensions', dimensions: { width: 400, height: 260 }, resizing: false },
    ]);

    expect(useCanvasStore.getState().history.past.length).toBe(pastBefore + 1);
  });

  it('addNode 可被 undo/redo 撤销恢复', () => {
    const id = addTextNode();
    expect(useCanvasStore.getState().nodes.some((node) => node.id === id)).toBe(true);

    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().nodes.length).toBe(0);

    expect(useCanvasStore.getState().redo()).toBe(true);
    expect(useCanvasStore.getState().nodes.some((node) => node.id === id)).toBe(true);
  });

  it('电影提示词工作室连接到视频或文本节点时写入当前提示词', () => {
    const store = useCanvasStore.getState();
    const studioId = store.addNode('cinematicStudioNode', { x: 0, y: 0 }, {
      lastPromptPreview: '完整电影提示词',
    });
    const videoId = store.addNode('videoGenNode', { x: 400, y: 0 });
    const textId = store.addNode('textAnnotationNode', { x: 400, y: 280 });

    store.onConnect({ source: studioId, target: videoId, sourceHandle: 'source', targetHandle: 'target' });
    store.addEdge(studioId, textId);

    const nodes = useCanvasStore.getState().nodes;
    expect(nodes.find((node) => node.id === videoId)?.data.prompt).toBe('完整电影提示词');
    expect(nodes.find((node) => node.id === textId)?.data.content).toBe('完整电影提示词');
  });

  it('setCanvasData 对持久化历史做相邻内容去重', () => {
    const id = addTextNode(50, 60);
    const node = useCanvasStore.getState().nodes.find((item) => item.id === id) as CanvasNode;
    const snapshot = { nodes: [node], edges: [] };

    useCanvasStore.getState().setCanvasData([node], [], {
      past: [snapshot, { nodes: [node], edges: [] }, snapshot],
      future: [{ nodes: [node], edges: [] }],
    });

    const state = useCanvasStore.getState();
    expect(state.history.past.length).toBe(1);
    expect(state.history.future.length).toBe(1);
  });

  it('图片生成完成后 undo 不会恢复生成中节点或删除图片', () => {
    const sourceId = addTextNode();
    const resultId = useCanvasStore.getState().addNode('exportImageNode', { x: 400, y: 100 }, {
      isGenerating: true,
      generationRequest: {
        kind: 'image',
        prompt: '生成一张图',
        model: 'test/image',
        size: '1K',
        aspectRatio: '1:1',
      },
    });
    useCanvasStore.getState().addEdge(sourceId, resultId);
    useCanvasStore.getState().updateNodeData(resultId, { generationJobId: 'job-1' });
    useCanvasStore.getState().updateNodeDataTransient(resultId, {
      imageUrl: 'file:///generated.png',
      isGenerating: false,
      generationResultProtected: true,
    });

    expect(useCanvasStore.getState().undo()).toBe(true);
    const result = useCanvasStore.getState().nodes.find((node) => node.id === resultId);
    expect(result?.data.imageUrl).toBe('file:///generated.png');
    expect(result?.data.isGenerating).toBe(false);
    expect(useCanvasStore.getState().nodes.some((node) => node.id === resultId)).toBe(true);
  });

  it('视频生成完成后 undo 不会删除视频结果', () => {
    const sourceId = addTextNode();
    const resultId = useCanvasStore.getState().addNode('audioNode', { x: 400, y: 100 }, {
      mediaType: 'video',
      isGenerating: true,
      generationRequest: {
        kind: 'video',
        prompt: '生成一段视频',
        model: 'test/video',
        duration: 5,
        aspectRatio: '16:9',
      },
    });
    useCanvasStore.getState().addEdge(sourceId, resultId);
    useCanvasStore.getState().updateNodeDataTransient(resultId, {
      sourcePath: 'file:///generated.mp4',
      isGenerating: false,
      generationResultProtected: true,
    });

    expect(useCanvasStore.getState().undo()).toBe(true);
    const result = useCanvasStore.getState().nodes.find((node) => node.id === resultId);
    expect(result?.data.sourcePath).toBe('file:///generated.mp4');
    expect(useCanvasStore.getState().nodes.some((node) => node.id === resultId)).toBe(true);
  });

  it('普通上传图片不受生成结果保护影响', () => {
    const resultId = useCanvasStore.getState().addNode('uploadNode', { x: 100, y: 100 }, {
      imageUrl: 'file:///uploaded.png',
    });

    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().nodes.some((node) => node.id === resultId)).toBe(false);
  });
});
