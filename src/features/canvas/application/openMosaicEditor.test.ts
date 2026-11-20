import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import { useCanvasStore } from "@/stores/canvasStore";

import { canvasEventBus, graphImageResolver } from "./canvasServices";
import {
  openMosaicEditorForNode,
  restoreNodeAfterMosaicEdit,
} from "./openMosaicEditor";

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

/**
 * 让 `loadImageElement` 立刻拿到固定尺寸：node 环境没有 `Image`，
 * 而画幅校正恰恰依赖 `naturalWidth/naturalHeight`。
 */
function stubImageSize(width: number, height: number) {
  class FakeImage {
    naturalWidth = width;
    naturalHeight = height;
    crossOrigin = "";
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal("Image", FakeImage as unknown as typeof Image);
}

/** 让图片解码那条 Promise 链彻底跑完（`loadImageElement` 内部还有一层 queueMicrotask）。 */
async function flushAsyncWork() {
  for (let i = 0; i < 12; i += 1) {
    await Promise.resolve();
  }
}

function findNode(id: string) {
  const node = useCanvasStore.getState().nodes.find((item) => item.id === id);
  if (!node) {
    throw new Error(`node ${id} missing`);
  }
  return node;
}

/**
 * 「图片编辑」入口：点击后**就地**进入全屏编辑器，不再新建下游节点。
 */
describe("openMosaicEditorForNode", () => {
  beforeEach(() => {
    resetStore();
    // 入口里有一次补发事件用的 setTimeout，测试里不想等它真的跑 180ms。
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("图片节点就地转成图片编辑节点，原图成为首个图层", () => {
    const imageNodeId = useCanvasStore.getState().addNode("uploadNode", {
      x: 0,
      y: 0,
    });
    useCanvasStore.getState().updateNodeData(imageNodeId, {
      imageUrl: "file:///tmp/a.png",
      previewImageUrl: "file:///tmp/a-preview.png",
      aspectRatio: "16:9",
    });

    openMosaicEditorForNode(findNode(imageNodeId));

    const state = useCanvasStore.getState();
    // 节点数量不变：没有多出来的下游节点。
    expect(state.nodes).toHaveLength(1);
    const converted = findNode(imageNodeId);
    expect(converted.type).toBe(CANVAS_NODE_TYPES.seamlessMosaic);
    const convertedData = converted.data as {
      canvasWidth?: number;
      canvasHeight?: number;
      layers?: Array<{ imageUrl: string; width: number; height: number; x: number; y: number }>;
    };
    const layers = convertedData.layers ?? [];
    expect(layers).toHaveLength(1);
    expect(layers[0].imageUrl).toBe("file:///tmp/a.png");
    // 图层必须铺满画幅：否则编辑器里就是「一张小图贴在大画布里」。
    expect(layers[0].width).toBe(convertedData.canvasWidth);
    expect(layers[0].height).toBe(convertedData.canvasHeight);
    expect(layers[0].x).toBe(0);
    expect(layers[0].y).toBe(0);
  });

  it("转换后下游仍能取到这张图（outputImageUrl 接着用原图）", () => {
    const imageNodeId = useCanvasStore.getState().addNode("uploadNode", { x: 0, y: 0 });
    useCanvasStore.getState().updateNodeData(imageNodeId, { imageUrl: "file:///tmp/a.png" });
    const downstreamId = useCanvasStore.getState().addNode("videoGenNode", { x: 400, y: 0 });
    useCanvasStore.getState().addEdge(imageNodeId, downstreamId);

    openMosaicEditorForNode(findNode(imageNodeId));

    const state = useCanvasStore.getState();
    // 下游只认 outputImageUrl：就地转换若不补这个字段，下游瞬间变成"没有输入"。
    expect(graphImageResolver.collectInputImages(downstreamId, state.nodes, state.edges)).toEqual([
      "file:///tmp/a.png",
    ]);
  });

  it("上游已有图会被记成已导入，避免同一张图变成两层", () => {
    const upstreamId = useCanvasStore.getState().addNode("uploadNode", { x: 0, y: 0 });
    useCanvasStore.getState().updateNodeData(upstreamId, { imageUrl: "file:///tmp/up.png" });
    const targetId = useCanvasStore.getState().addNode("uploadNode", { x: 400, y: 0 });
    useCanvasStore.getState().updateNodeData(targetId, {
      imageUrl: "file:///tmp/up.png",
      previewImageUrl: "file:///tmp/up.png",
    });
    useCanvasStore.getState().addEdge(upstreamId, targetId);

    openMosaicEditorForNode(findNode(targetId));

    const data = findNode(targetId).data as { importedSourceKeys?: string[] };
    expect(data.importedSourceKeys).toContain("file:///tmp/up.png");
  });

  it("连线不受影响：下游边仍指向同一个节点 id", () => {
    const imageNodeId = useCanvasStore.getState().addNode("uploadNode", { x: 0, y: 0 });
    useCanvasStore.getState().updateNodeData(imageNodeId, { imageUrl: "file:///tmp/a.png" });
    const downstreamId = useCanvasStore.getState().addNode("videoGenNode", { x: 400, y: 0 });
    useCanvasStore.getState().addEdge(imageNodeId, downstreamId);

    openMosaicEditorForNode(findNode(imageNodeId));

    const edges = useCanvasStore.getState().edges;
    expect(edges.some((edge) => edge.source === imageNodeId && edge.target === downstreamId)).toBe(
      true,
    );
  });

  it("画幅按图片真实像素校正（512 占位只是过渡）", async () => {
    stubImageSize(1024, 768);
    const imageNodeId = useCanvasStore.getState().addNode("uploadNode", { x: 0, y: 0 });
    useCanvasStore.getState().updateNodeData(imageNodeId, {
      imageUrl: "file:///tmp/a.png",
      aspectRatio: "16:9",
    });

    openMosaicEditorForNode(findNode(imageNodeId));
    // 转换是同步的，真实尺寸要等图片解码完（这里由 stub 的 Image 立刻 onload）。
    await flushAsyncWork();

    const data = findNode(imageNodeId).data as {
      canvasWidth: number;
      canvasHeight: number;
      layers: Array<{ width: number; height: number; aspectRatio?: string }>;
    };
    expect(data.canvasWidth).toBe(1024);
    expect(data.canvasHeight).toBe(768);
    expect(data.layers[0]).toMatchObject({ width: 1024, height: 768, aspectRatio: "4:3" });
  });

  it("用户已经改过画幅时不再校正，绝不吃掉手动调整", async () => {
    stubImageSize(1024, 768);
    const imageNodeId = useCanvasStore.getState().addNode("uploadNode", { x: 0, y: 0 });
    useCanvasStore.getState().updateNodeData(imageNodeId, {
      imageUrl: "file:///tmp/a.png",
      aspectRatio: "16:9",
    });

    openMosaicEditorForNode(findNode(imageNodeId));
    // 模拟"校正回来之前用户已经把画幅拉成 3000×3000"。
    useCanvasStore.getState().updateNodeData(imageNodeId, { canvasWidth: 3000, canvasHeight: 3000 });
    await flushAsyncWork();

    const data = findNode(imageNodeId).data as { canvasWidth: number; canvasHeight: number };
    expect(data.canvasWidth).toBe(3000);
    expect(data.canvasHeight).toBe(3000);
  });

  it("关闭编辑器后还原成原来的图片节点（临时会话，不改节点类型）", () => {
    const imageNodeId = useCanvasStore.getState().addNode("uploadNode", { x: 0, y: 0 });
    useCanvasStore.getState().updateNodeData(imageNodeId, {
      imageUrl: "file:///tmp/a.png",
      previewImageUrl: "file:///tmp/a-preview.png",
      aspectRatio: "16:9",
    });

    openMosaicEditorForNode(findNode(imageNodeId));
    // 编辑期间是图片编辑节点（编辑器需要这个数据格式）。
    expect(findNode(imageNodeId).type).toBe(CANVAS_NODE_TYPES.seamlessMosaic);

    restoreNodeAfterMosaicEdit(imageNodeId);

    const restored = findNode(imageNodeId);
    expect(restored.type).toBe(CANVAS_NODE_TYPES.upload);
    expect((restored.data as { imageUrl?: string }).imageUrl).toBe("file:///tmp/a.png");
    // 编辑器的临时字段不能残留到图片节点上。
    expect((restored.data as { layers?: unknown }).layers).toBeUndefined();
  });

  it("关闭编辑器后原样还原，绝不回写编辑结果（应用是新建节点）", () => {
    const imageNodeId = useCanvasStore.getState().addNode("uploadNode", { x: 0, y: 0 });
    useCanvasStore.getState().updateNodeData(imageNodeId, { imageUrl: "file:///tmp/a.png" });

    openMosaicEditorForNode(findNode(imageNodeId));
    // 即使编辑期间被写入了 outputImageUrl（历史数据），还原也不该把它回写到原节点。
    useCanvasStore.getState().updateNodeData(imageNodeId, {
      outputImageUrl: "file:///tmp/merged.png",
      outputPreviewImageUrl: "file:///tmp/merged-preview.png",
    });

    restoreNodeAfterMosaicEdit(imageNodeId);

    const data = findNode(imageNodeId).data as { imageUrl?: string };
    expect(data.imageUrl).toBe("file:///tmp/a.png");
  });

  it("真正的图片编辑节点没有快照，还原是空操作", () => {
    const mosaicId = useCanvasStore.getState().addNode("seamlessMosaicNode", { x: 0, y: 0 });

    restoreNodeAfterMosaicEdit(mosaicId);

    expect(findNode(mosaicId).type).toBe(CANVAS_NODE_TYPES.seamlessMosaic);
  });

  it("「应用」完整序列：转换期间不碰母节点尺寸，还原类型后对齐不受影响", () => {
    const imageNodeId = useCanvasStore.getState().addNode("uploadNode", { x: 0, y: 0 });
    useCanvasStore.getState().updateNodeData(imageNodeId, { imageUrl: "file:///tmp/a.png" });
    const beforeWidth = (findNode(imageNodeId) as { width?: number }).width;
    const beforeHeight = (findNode(imageNodeId) as { height?: number }).height;

    openMosaicEditorForNode(findNode(imageNodeId));
    expect(findNode(imageNodeId).type).toBe(CANVAS_NODE_TYPES.seamlessMosaic);
    // 关键：转换期间母节点尺寸不变，这样 findNodePosition 对齐才正确。
    expect((findNode(imageNodeId) as { width?: number }).width).toBe(beforeWidth);
    expect((findNode(imageNodeId) as { height?: number }).height).toBe(beforeHeight);

    restoreNodeAfterMosaicEdit(imageNodeId);

    expect(findNode(imageNodeId).type).toBe(CANVAS_NODE_TYPES.upload);
  });

  it("已经是图片编辑节点：不重复转换，直接通知它打开编辑器", () => {
    const mosaicId = useCanvasStore.getState().addNode("seamlessMosaicNode", { x: 0, y: 0 });
    const received: Array<{ nodeId: string }> = [];
    const unsubscribe = canvasEventBus.subscribe("mosaic-editor/open", (payload) => {
      received.push(payload);
    });

    openMosaicEditorForNode(findNode(mosaicId));

    expect(received).toEqual([{ nodeId: mosaicId }]);
    expect(findNode(mosaicId).type).toBe(CANVAS_NODE_TYPES.seamlessMosaic);
    unsubscribe();
  });
});
