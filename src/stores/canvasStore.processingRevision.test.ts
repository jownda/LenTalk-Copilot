import { describe, it, expect, beforeEach } from 'vitest';
import { useCanvasStore } from './canvasStore';

/**
 * 回归背景（实机 2026-09-22 知鸟任务）:
 *
 * 画布的视频/图片观察循环都以 `processingRevision` 为 effect 依赖, 过滤器要求
 * 节点同时满足 `isGenerating === true` 且 `generationJobId` 非空。
 *
 * 而提交方的顺序是: 先 `addNode(audioNode, { isGenerating: true })` 建出结果节点,
 * 等后端返回后再 `updateNodeData(outputId, { generationJobId })`。
 * 如果 `processingRevision` 只在 `isGenerating` 翻转时才 bump, 那么第二次写入
 * 不会触发任何重新扫描 —— 节点会带着「生成中 + jobId」永远停在原地, 任务在平台侧
 * 照跑照计费、界面一直转圈, 最后只能报「视频任务等待超时」。
 *
 * 所以 `generationJobId` 的落库必须计入 processing 变化。
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

/** 复刻视频提交路径: 结果节点先以 isGenerating=true 建出, 之后再写 job id。 */
function addGeneratingResultNode(): string {
  return useCanvasStore.getState().addNode('audioNode', { x: 0, y: 0 }, {
    isGenerating: true,
    mediaType: 'video',
  });
}

describe('canvasStore processingRevision (观察循环触发)', () => {
  beforeEach(resetStore);

  it('落库 generationJobId 必须 bump processingRevision —— 否则观察循环永不启动', () => {
    const id = addGeneratingResultNode();
    // 建节点这一步已经把 revision 推到某个值; 以它为基准看"写 jobId"这一步。
    const before = useCanvasStore.getState().processingRevision;

    useCanvasStore.getState().updateNodeData(id, { generationJobId: 'job-123' });

    expect(useCanvasStore.getState().processingRevision).toBeGreaterThan(before);
  });

  it('updateNodeDataTransient 落库 generationJobId 同样要 bump', () => {
    const id = addGeneratingResultNode();
    const before = useCanvasStore.getState().processingRevision;

    useCanvasStore.getState().updateNodeDataTransient(id, { generationJobId: 'job-456' });

    expect(useCanvasStore.getState().processingRevision).toBeGreaterThan(before);
  });

  it('清空 generationJobId(终态回写)也要 bump, 让循环能重新评估', () => {
    const id = addGeneratingResultNode();
    useCanvasStore.getState().updateNodeData(id, { generationJobId: 'job-789' });
    const before = useCanvasStore.getState().processingRevision;

    useCanvasStore.getState().updateNodeDataTransient(id, {
      isGenerating: false,
      generationJobId: null,
    });

    expect(useCanvasStore.getState().processingRevision).toBeGreaterThan(before);
  });

  it('isGenerating 翻转仍然要 bump(保持既有行为)', () => {
    const id = addGeneratingResultNode();
    const before = useCanvasStore.getState().processingRevision;

    useCanvasStore.getState().updateNodeDataTransient(id, { isGenerating: false });

    expect(useCanvasStore.getState().processingRevision).toBeGreaterThan(before);
  });

  it('无关字段(displayName)不应 bump —— 避免每次改表单都全画布重扫', () => {
    const id = addGeneratingResultNode();
    const before = useCanvasStore.getState().processingRevision;

    useCanvasStore.getState().updateNodeDataTransient(id, { displayName: '新名字' });

    expect(useCanvasStore.getState().processingRevision).toBe(before);
  });

  it('写入同一个 jobId(值未变)不应 bump', () => {
    const id = addGeneratingResultNode();
    useCanvasStore.getState().updateNodeData(id, { generationJobId: 'job-same' });
    const before = useCanvasStore.getState().processingRevision;

    useCanvasStore.getState().updateNodeData(id, { generationJobId: 'job-same' });

    expect(useCanvasStore.getState().processingRevision).toBe(before);
  });
});
