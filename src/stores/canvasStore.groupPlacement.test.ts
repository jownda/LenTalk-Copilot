import { describe, it, expect, beforeEach } from 'vitest';
import { useCanvasStore } from './canvasStore';
import {
  CANVAS_NODE_TYPES,
  type CanvasNode,
  type GroupNodeData,
} from '@/features/canvas/domain/canvasNodes';

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

function store() {
  return useCanvasStore.getState();
}

function addText(x: number, y: number): string {
  return store().addNode(CANVAS_NODE_TYPES.textAnnotation, { x, y });
}

function findNode(id: string): CanvasNode {
  const node = store().nodes.find((item) => item.id === id);
  if (!node) {
    throw new Error(`node not found: ${id}`);
  }
  return node;
}

/** 给节点补上 React Flow 的测量尺寸, 让落位算法拿到真实几何。 */
function measure(nodeId: string, width: number, height: number) {
  useCanvasStore.setState({
    nodes: store().nodes.map((node) =>
      node.id === nodeId ? { ...node, measured: { width, height } } : node
    ),
  });
}

/** 造一个双节点分组, 返回组 id 与两个成员 id。 */
function createGroup() {
  const first = addText(100, 100);
  const second = addText(520, 100);
  const groupId = store().groupNodes([first, second]);
  if (!groupId) {
    throw new Error('groupNodes failed');
  }
  return { groupId, first, second };
}

describe('canvasStore 组内生成定位', () => {
  beforeEach(resetStore);

  it('组内节点派生的下游节点落在同一个组里', () => {
    const { groupId, first } = createGroup();
    measure(groupId, 1200, 700);
    measure(first, 300, 200);

    const placement = store().findNodePosition(first, 300, 200);

    expect(placement.parentId).toBe(groupId);
  });

  it('冻结组同样吸收生成出来的下游节点(回归: 曾经会被甩到组外)', () => {
    const { groupId, first } = createGroup();
    measure(groupId, 1200, 700);
    measure(first, 300, 200);
    store().setGroupFrozen(groupId, true);

    const placement = store().findNodePosition(first, 300, 200);

    // 关键断言: 冻结组不再把新节点推到顶层
    expect(placement.parentId).toBe(groupId);
    // 位置是组内相对坐标, 不再是"组内坐标当绝对坐标"那种错误落点
    expect(placement.x).toBeGreaterThanOrEqual(0);
    expect(placement.y).toBeGreaterThanOrEqual(0);
  });

  it('冻结组空间不足时随生成一起扩组', () => {
    const { groupId, first } = createGroup();
    // 组只有 700x400, 来源节点已贴着右边, 下游节点放不下
    measure(groupId, 700, 400);
    measure(first, 620, 200);

    const placement = store().findNodePosition(first, 420, 360);

    expect(placement.parentId).toBe(groupId);
    expect(placement.groupResize).toBeTruthy();
    expect(placement.groupResize?.id).toBe(groupId);
    expect(placement.groupResize!.width).toBeGreaterThan(700);
  });

  it('落进冻结组的新节点与老成员一样被锁住(不可拖动)', () => {
    const { groupId, first } = createGroup();
    measure(groupId, 1200, 700);
    measure(first, 300, 200);
    store().setGroupFrozen(groupId, true);

    const placement = store().findNodePosition(first, 300, 200);
    const newId = store().addNode(CANVAS_NODE_TYPES.audio, placement, { mediaType: 'video' });
    expect(findNode(newId).parentId).toBe(groupId);

    // 拖动应被冻结拦截(位置不变)
    const origin = findNode(newId).position;
    store().onNodesChange([{ id: newId, type: 'position', position: { x: origin.x + 200, y: origin.y + 200 }, dragging: true }]);
    store().onNodesChange([{ id: newId, type: 'position', position: { x: origin.x + 200, y: origin.y + 200 }, dragging: false }]);
    expect(findNode(newId).position).toEqual(origin);
  });

  it('组外节点派生的下游节点依旧不进组', () => {
    const loose = addText(2000, 2000);
    const placement = store().findNodePosition(loose, 300, 200);
    expect(placement.parentId).toBeUndefined();
  });

  it('手动把节点并入冻结组仍然被拒绝', () => {
    const { groupId } = createGroup();
    store().setGroupFrozen(groupId, true);
    const outsider = addText(2400, 200);

    expect(store().addNodesToGroup([outsider], groupId)).toBe(false);
    expect(findNode(outsider).parentId).toBeUndefined();
  });

  it('冻结组数据标记未被破坏(仍是 frozen)', () => {
    const { groupId, first } = createGroup();
    measure(groupId, 1200, 700);
    measure(first, 300, 200);
    store().setGroupFrozen(groupId, true);

    store().findNodePosition(first, 300, 200);

    expect((findNode(groupId).data as GroupNodeData).frozen).toBe(true);
  });
});
