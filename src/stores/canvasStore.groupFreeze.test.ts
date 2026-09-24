import { describe, it, expect, beforeEach } from 'vitest';
import { useCanvasStore } from './canvasStore';
import {
  CANVAS_NODE_TYPES,
  collectFrozenLockedNodeIds,
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

function addTextNode(x = 100, y = 100): string {
  return useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.textAnnotation, { x, y });
}

/** 模拟 React Flow 拖动单个节点(dragging true → false) */
function emitDrag(nodeId: string, position: { x: number; y: number }) {
  const store = useCanvasStore.getState();
  store.onNodesChange([{ id: nodeId, type: 'position', position, dragging: true }]);
  store.onNodesChange([{ id: nodeId, type: 'position', position, dragging: false }]);
}

function findNode(id: string): CanvasNode {
  const node = useCanvasStore.getState().nodes.find((item) => item.id === id);
  if (!node) {
    throw new Error(`node not found: ${id}`);
  }
  return node;
}

function frozenFlag(id: string): boolean | undefined {
  return (findNode(id).data as GroupNodeData).frozen;
}

/** 造一个双节点分组, 返回组 id 与两个成员 id */
function createGroup() {
  const first = addTextNode(100, 100);
  const second = addTextNode(420, 100);
  const groupId = useCanvasStore.getState().groupNodes([first, second]);
  if (!groupId) {
    throw new Error('groupNodes failed');
  }
  return { groupId, first, second };
}

describe('canvasStore group freeze', () => {
  beforeEach(resetStore);

  it('冻结后组自身的位置变更被忽略, 解冻后恢复可移动', () => {
    const { groupId } = createGroup();
    const origin = findNode(groupId).position;

    expect(useCanvasStore.getState().setGroupFrozen(groupId, true)).toBe(true);
    expect(frozenFlag(groupId)).toBe(true);

    emitDrag(groupId, { x: origin.x + 120, y: origin.y + 80 });
    expect(findNode(groupId).position).toEqual(origin);

    // 重复冻结不产生变更
    expect(useCanvasStore.getState().setGroupFrozen(groupId, true)).toBe(false);

    expect(useCanvasStore.getState().setGroupFrozen(groupId, false)).toBe(true);
    expect(frozenFlag(groupId)).toBeUndefined();

    emitDrag(groupId, { x: origin.x + 120, y: origin.y + 80 });
    expect(findNode(groupId).position).toEqual({ x: origin.x + 120, y: origin.y + 80 });
  });

  it('冻结后组内节点的位移与手动缩放都被拦截', () => {
    const { groupId, first } = createGroup();
    useCanvasStore.getState().setGroupFrozen(groupId, true);

    const origin = findNode(first).position;
    emitDrag(first, { x: origin.x + 60, y: origin.y + 40 });
    expect(findNode(first).position).toEqual(origin);

    const widthBefore = findNode(first).width;
    useCanvasStore.getState().onNodesChange([
      {
        id: first,
        type: 'dimensions',
        dimensions: { width: 640, height: 480 },
        resizing: true,
        setAttributes: true,
      },
    ]);
    expect(findNode(first).width).toBe(widthBefore);
  });

  it('冻结节点的尺寸测量变更仍然放行(否则布局尺寸会失真)', () => {
    const { groupId } = createGroup();
    useCanvasStore.getState().setGroupFrozen(groupId, true);

    useCanvasStore.getState().onNodesChange([
      {
        id: groupId,
        type: 'dimensions',
        dimensions: { width: 520, height: 300 },
        setAttributes: true,
      },
    ]);
    expect(findNode(groupId).width).toBe(520);
  });

  it('未冻结的组与普通节点不受影响', () => {
    const { groupId } = createGroup();
    const loose = addTextNode(900, 900);

    const groupOrigin = findNode(groupId).position;
    emitDrag(groupId, { x: groupOrigin.x + 20, y: groupOrigin.y + 20 });
    expect(findNode(groupId).position).toEqual({ x: groupOrigin.x + 20, y: groupOrigin.y + 20 });

    emitDrag(loose, { x: 960, y: 940 });
    expect(findNode(loose).position).toEqual({ x: 960, y: 940 });
  });

  it('冻结组拒绝新节点加入, 也拒绝把内部节点移出', () => {
    const { groupId } = createGroup();
    const outsider = addTextNode(1200, 120);
    useCanvasStore.getState().setGroupFrozen(groupId, true);

    expect(useCanvasStore.getState().addNodesToGroup([outsider], groupId)).toBe(false);
    expect(findNode(outsider).parentId).toBeUndefined();

    const member = useCanvasStore.getState().nodes.find((item) => item.parentId === groupId);
    expect(member).toBeTruthy();
    expect(useCanvasStore.getState().removeNodesFromGroup([member!.id])).toBe(false);
    expect(findNode(member!.id).parentId).toBe(groupId);
  });

  it('冻结组不会被并入新建分组', () => {
    const { groupId: frozenGroupId } = createGroup();
    useCanvasStore.getState().setGroupFrozen(frozenGroupId, true);
    const loose = addTextNode(1400, 1400);

    // 剔除冻结组后只剩 1 个可成组节点 → 不成组
    expect(useCanvasStore.getState().groupNodes([frozenGroupId, loose])).toBeNull();
  });

  it('collectFrozenLockedNodeIds 覆盖嵌套子组的全部后代', () => {
    const frozenGroup = {
      id: 'g1',
      type: CANVAS_NODE_TYPES.group,
      position: { x: 0, y: 0 },
      data: { label: 'g1', frozen: true } as GroupNodeData,
    };
    const childGroup = {
      id: 'g2',
      type: CANVAS_NODE_TYPES.group,
      parentId: 'g1',
      position: { x: 0, y: 0 },
      data: { label: 'g2' } as GroupNodeData,
    };
    const leaf = {
      id: 'n1',
      type: CANVAS_NODE_TYPES.textAnnotation,
      parentId: 'g2',
      position: { x: 0, y: 0 },
      data: { label: 'n1' },
    };
    const loose = {
      id: 'n2',
      type: CANVAS_NODE_TYPES.textAnnotation,
      position: { x: 0, y: 0 },
      data: { label: 'n2' },
    };

    const locked = collectFrozenLockedNodeIds([
      frozenGroup,
      childGroup,
      leaf,
      loose,
    ] as unknown as CanvasNode[]);

    expect([...locked].sort()).toEqual(['g1', 'g2', 'n1']);
  });

  it('updateNodePosition 同样移不动冻结节点(覆盖 AI 助手等调用方)', () => {
    const { groupId, first } = createGroup();
    useCanvasStore.getState().setGroupFrozen(groupId, true);

    const groupOrigin = findNode(groupId).position;
    const memberOrigin = findNode(first).position;

    useCanvasStore.getState().updateNodePosition(groupId, { x: groupOrigin.x + 300, y: groupOrigin.y });
    useCanvasStore.getState().updateNodePosition(first, { x: memberOrigin.x + 300, y: memberOrigin.y });

    expect(findNode(groupId).position).toEqual(groupOrigin);
    expect(findNode(first).position).toEqual(memberOrigin);
  });

  it('冻结/解冻写入撤销历史, 可回滚', () => {    const { groupId } = createGroup();
    const pastBefore = useCanvasStore.getState().history.past.length;

    useCanvasStore.getState().setGroupFrozen(groupId, true);
    expect(useCanvasStore.getState().history.past.length).toBe(pastBefore + 1);

    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(frozenFlag(groupId)).toBeUndefined();
  });
});
