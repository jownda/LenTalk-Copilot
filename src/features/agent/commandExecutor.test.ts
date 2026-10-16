import { beforeEach, describe, expect, it } from "vitest";

import { useCanvasStore } from "@/stores/canvasStore";

import { executeCanvasAgentCommand } from "./commandExecutor";

/** 与 canvasStore 既有测试同一套复位方式 */
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

/** 建节点并回传它的**引用名**（工具对外一律用名称） */
function createNode(
  type: string,
  position: { x: number; y: number },
  displayName?: string,
): string {
  const created = executeCanvasAgentCommand({
    tool: "canvas.create_node",
    arguments: { type, position, data: displayName ? { displayName } : {} },
  });
  expect(created.ok).toBe(true);
  return (created.data as { nodeName: string }).nodeName;
}

describe("executeCanvasAgentCommand", () => {
  beforeEach(resetStore);

  it("读取空画布快照", () => {
    const result = executeCanvasAgentCommand({ tool: "canvas.get_snapshot", arguments: {} });
    expect(result.ok).toBe(true);
    expect((result.data as { nodes: unknown[] }).nodes).toEqual([]);
    expect((result.data as { edges: unknown[] }).edges).toEqual([]);
  });

  it("创建节点后画布上真的有它，并回传名称", () => {
    const name = createNode("uploadNode", { x: 120, y: 40 }, "封面");
    expect(name).toBe("封面");

    const nodes = useCanvasStore.getState().nodes;
    expect(nodes).toHaveLength(1);
    expect(nodes[0].position).toEqual({ x: 120, y: 40 });
    expect(nodes[0].data.displayName).toBe("封面");
  });

  it("更新节点参数（按名称定位）", () => {
    const name = createNode("imageNode", { x: 0, y: 0 }, "封面");
    const updated = executeCanvasAgentCommand({
      tool: "canvas.update_node",
      arguments: { nodeName: name, data: { displayName: "封面图", prompt: "一只猫" } },
    });
    expect(updated.ok).toBe(true);

    const node = useCanvasStore.getState().nodes[0];
    expect(node.data.displayName).toBe("封面图");
    expect(node.data.prompt).toBe("一只猫");
  });

  it("改节点尺寸", () => {
    const name = createNode("uploadNode", { x: 0, y: 0 }, "封面");
    const resized = executeCanvasAgentCommand({
      tool: "canvas.resize_node",
      arguments: { nodeName: name, width: 360, height: 200 },
    });
    expect(resized.ok).toBe(true);
    const node = useCanvasStore.getState().nodes[0];
    expect(node.measured?.width ?? node.width).toBe(360);
  });

  it("移动节点", () => {
    const name = createNode("uploadNode", { x: 0, y: 0 }, "封面");
    const moved = executeCanvasAgentCommand({
      tool: "canvas.move_node",
      arguments: { nodeName: name, position: { x: 300, y: 220 } },
    });
    expect(moved.ok).toBe(true);
    expect(useCanvasStore.getState().nodes[0].position).toEqual({ x: 300, y: 220 });
  });

  it("连接两个节点（按名称）", () => {
    const source = createNode("uploadNode", { x: 0, y: 0 }, "素材");
    const target = createNode("videoGenNode", { x: 400, y: 0 }, "镜头");

    const connected = executeCanvasAgentCommand({
      tool: "canvas.connect_nodes",
      arguments: { sourceName: source, targetName: target },
    });
    expect(connected.ok).toBe(true);

    const edges = useCanvasStore.getState().edges;
    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe(useCanvasStore.getState().nodes[0].id);
    expect(edges[0].target).toBe(useCanvasStore.getState().nodes[1].id);
  });

  it("删除节点", () => {
    const name = createNode("uploadNode", { x: 0, y: 0 }, "封面");
    const deleted = executeCanvasAgentCommand({
      tool: "canvas.delete_node",
      arguments: { nodeName: name },
    });
    expect(deleted.ok).toBe(true);
    expect(useCanvasStore.getState().nodes).toHaveLength(0);
  });

  it("撤销能回退刚创建、重做能再放回来", () => {
    createNode("uploadNode", { x: 0, y: 0 }, "封面");
    expect(useCanvasStore.getState().nodes).toHaveLength(1);

    expect(executeCanvasAgentCommand({ tool: "canvas.undo", arguments: {} }).ok).toBe(true);
    expect(useCanvasStore.getState().nodes).toHaveLength(0);

    expect(executeCanvasAgentCommand({ tool: "canvas.redo", arguments: {} }).ok).toBe(true);
    expect(useCanvasStore.getState().nodes).toHaveLength(1);
  });

  it("读取选中节点", () => {
    createNode("uploadNode", { x: 0, y: 0 }, "封面");
    const nodeId = useCanvasStore.getState().nodes[0].id;
    useCanvasStore.setState({ selectedNodeId: nodeId });

    const result = executeCanvasAgentCommand({
      tool: "canvas.get_selected_nodes",
      arguments: {},
    });
    expect(result.ok).toBe(true);
    expect((result.data as { id: string }[]).map((node) => node.id)).toEqual([nodeId]);
  });

  it("未知工具如实失败，而不是抛错", () => {
    const result = executeCanvasAgentCommand({
      tool: "canvas.not_a_tool" as never,
      arguments: {},
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("未知画布工具");
  });

  it("参数不符合 schema 时失败并说明原因", () => {
    const result = executeCanvasAgentCommand({
      tool: "canvas.create_node",
      arguments: { type: "不存在的节点类型", position: { x: 0, y: 0 } },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("工具参数无效");
  });

  it("节点不存在时失败，且不产生副作用", () => {
    const missing = executeCanvasAgentCommand({
      tool: "canvas.move_node",
      arguments: { nodeName: "不存在的节点", position: { x: 10, y: 10 } },
    });
    expect(missing.ok).toBe(false);
    expect(missing.message).toContain("找不到");
    expect(useCanvasStore.getState().nodes).toHaveLength(0);
  });

  it("连线端点不存在时失败", () => {
    const name = createNode("uploadNode", { x: 0, y: 0 }, "封面");
    const result = executeCanvasAgentCommand({
      tool: "canvas.connect_nodes",
      arguments: { sourceName: name, targetName: "不存在的节点" },
    });
    expect(result.ok).toBe(false);
    expect(useCanvasStore.getState().edges).toHaveLength(0);
  });
});
