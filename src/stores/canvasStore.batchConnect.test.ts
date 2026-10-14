import { describe, it, expect, beforeEach } from 'vitest';

import { useCanvasStore } from './canvasStore';

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

/** 框选批量连线：一次把 N 个素材接到同一个下游节点。 */
describe('canvasStore.onConnectMany', () => {
  beforeEach(resetStore);

  it('建立多条连接时只压一个历史快照（撤销一次全部回退）', () => {
    const store = useCanvasStore.getState();
    const img1 = store.addNode('uploadNode', { x: 0, y: 0 });
    const img2 = store.addNode('uploadNode', { x: 0, y: 200 });
    const aud1 = store.addNode('audioNode', { x: 0, y: 400 });
    const video = store.addNode('videoGenNode', { x: 400, y: 0 });

    const pastBefore = useCanvasStore.getState().history.past.length;

    useCanvasStore.getState().onConnectMany([
      { source: img1, target: video, sourceHandle: 'source', targetHandle: 'target' },
      { source: img2, target: video, sourceHandle: 'source', targetHandle: 'target' },
      { source: aud1, target: video, sourceHandle: 'source', targetHandle: 'target' },
    ]);

    const state = useCanvasStore.getState();
    expect(state.edges).toHaveLength(3);
    expect(state.edges.map((edge) => `${edge.source}->${edge.target}`)).toEqual([
      `${img1}->${video}`,
      `${img2}->${video}`,
      `${aud1}->${video}`,
    ]);
    expect(state.edges.every((edge) => edge.type === 'disconnectableEdge')).toBe(true);
    // 关键：三条边只留一个快照，撤销一次就回到连线前。
    expect(state.history.past.length).toBe(pastBefore + 1);

    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().edges).toHaveLength(0);
  });

  it('全部是已存在的连接时不写历史（免得用户白撤一次）', () => {
    const store = useCanvasStore.getState();
    const img1 = store.addNode('uploadNode', { x: 0, y: 0 });
    const video = store.addNode('videoGenNode', { x: 400, y: 0 });

    const connection = { source: img1, target: video, sourceHandle: 'source', targetHandle: 'target' };
    useCanvasStore.getState().onConnectMany([connection]);

    const pastBefore = useCanvasStore.getState().history.past.length;
    const edgesBefore = useCanvasStore.getState().edges;

    useCanvasStore.getState().onConnectMany([connection, { ...connection }]);

    expect(useCanvasStore.getState().edges).toBe(edgesBefore);
    expect(useCanvasStore.getState().history.past.length).toBe(pastBefore);
  });

  it('新边与重复边混合时只补新边，仍然只压一个快照', () => {
    const store = useCanvasStore.getState();
    const img1 = store.addNode('uploadNode', { x: 0, y: 0 });
    const img2 = store.addNode('uploadNode', { x: 0, y: 200 });
    const video = store.addNode('videoGenNode', { x: 400, y: 0 });

    useCanvasStore.getState().onConnectMany([
      { source: img1, target: video, sourceHandle: 'source', targetHandle: 'target' },
    ]);

    const pastBefore = useCanvasStore.getState().history.past.length;

    useCanvasStore.getState().onConnectMany([
      { source: img1, target: video, sourceHandle: 'source', targetHandle: 'target' },
      { source: img2, target: video, sourceHandle: 'source', targetHandle: 'target' },
    ]);

    expect(useCanvasStore.getState().edges).toHaveLength(2);
    expect(useCanvasStore.getState().history.past.length).toBe(pastBefore + 1);
  });

  it('空数组什么都不做', () => {
    const video = useCanvasStore.getState().addNode('videoGenNode', { x: 400, y: 0 });
    expect(video).toBeTruthy();

    const before = useCanvasStore.getState();
    useCanvasStore.getState().onConnectMany([]);
    const after = useCanvasStore.getState();

    expect(after.edges).toBe(before.edges);
    expect(after.history.past.length).toBe(before.history.past.length);
  });
});
