import { beforeEach, describe, expect, it } from "vitest";

import type { CanvasNodeType } from "@/features/canvas/domain/canvasNodes";
import { useCanvasStore } from "@/stores/canvasStore";

import { buildCanvasNodeRefNames } from "./canvasContext";
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
    focusRequest: null,
  });
}

/**
 * 造一个**已有节点**当锚点，并回传它的引用名（工具对外一律用名称）。
 * 直接写 store：位置是测试给定的前置条件，不是被测行为 ——
 * 走 canvas.create_node 反而会被「自动排布」覆盖掉。
 */
function createNode(
  type: string,
  position: { x: number; y: number },
  displayName?: string,
): string {
  const store = useCanvasStore.getState();
  const id = store.addNode(
    type as CanvasNodeType,
    position,
    (displayName ? { displayName } : {}) as Parameters<typeof store.addNode>[2],
  );
  const names = buildCanvasNodeRefNames(useCanvasStore.getState().nodes);
  return names.get(id) ?? id;
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
    const created = executeCanvasAgentCommand({
      tool: "canvas.create_node",
      arguments: { type: "uploadNode", data: { displayName: "封面" } },
    });
    expect(created.ok).toBe(true);
    expect((created.data as { nodeName: string }).nodeName).toBe("封面");

    const nodes = useCanvasStore.getState().nodes;
    expect(nodes).toHaveLength(1);
    expect(nodes[0].data.displayName).toBe("封面");
    // 空画布上第一个节点从原点起
    expect(nodes[0].position).toEqual({ x: 0, y: 0 });
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

  describe("canvas.create_nodes（批量建节点）", () => {
    it("一次建多个，名称按画布顺序给出（同名带 #2 后缀）", () => {
      const created = executeCanvasAgentCommand({
        tool: "canvas.create_nodes",
        arguments: {
          nodes: [
            { type: "uploadNode", data: { displayName: "锚点" } },
            { type: "uploadNode", data: { displayName: "锚点" } },
            { type: "uploadNode", data: { displayName: "锚点" } },
          ],
        },
      });

      expect(created.ok).toBe(true);
      const data = created.data as { nodeIds: string[]; nodeNames: string[] };
      expect(data.nodeIds).toHaveLength(3);
      expect(data.nodeNames).toEqual(["锚点", "锚点 #2", "锚点 #3"]);
      expect(useCanvasStore.getState().nodes).toHaveLength(3);
    });

    /**
     * 这是这层存在的全部理由：逐条 create_node 会让用户按住销 12 次才能退回原状。
     */
    it("整批只压一个历史快照 —— 撤销一次全部消失", () => {
      executeCanvasAgentCommand({
        tool: "canvas.create_nodes",
        arguments: {
          nodes: Array.from({ length: 5 }, (_, index) => ({
            type: "uploadNode",
            data: { displayName: `锚点${index}` },
          })),
        },
      });
      expect(useCanvasStore.getState().nodes).toHaveLength(5);
      expect(useCanvasStore.getState().history.past).toHaveLength(1);

      expect(executeCanvasAgentCommand({ tool: "canvas.undo", arguments: {} }).ok).toBe(true);
      expect(useCanvasStore.getState().nodes).toHaveLength(0);
    });

    it("接在最后一个节点右侧，并与它顶边对齐", () => {
      createNode("uploadNode", { x: 100, y: 200 }, "已有");
      const anchor = useCanvasStore.getState().nodes[0];

      executeCanvasAgentCommand({
        tool: "canvas.create_nodes",
        arguments: {
          nodes: [
            { type: "uploadNode", data: { displayName: "新A" } },
            { type: "uploadNode", data: { displayName: "新B" } },
          ],
        },
      });

      const nodes = useCanvasStore.getState().nodes;
      const created = nodes.filter((node) => node.id !== anchor.id);
      expect(created).toHaveLength(2);
      // y 与锚点完全齐平 —— 这就是「对齐」的含义
      for (const node of created) {
        expect(node.position.y).toBe(anchor.position.y);
        expect(node.position.x).toBeGreaterThan(anchor.position.x);
      }
      // 同一行两个不能重合
      expect(created[0].position.x).not.toBe(created[1].position.x);
    });

    it("空数组被判参数无效", () => {
      const result = executeCanvasAgentCommand({
        tool: "canvas.create_nodes",
        arguments: { nodes: [] },
      });
      expect(result.ok).toBe(false);
    });
  });

  describe("单节点创建的位置", () => {
    it("模型硬塞的坐标会被忽略（位置只由程序决定）", () => {
      createNode("uploadNode", { x: 0, y: 0 }, "已有");

      executeCanvasAgentCommand({
        tool: "canvas.create_node",
        // 老版本 prompt 可能仍在给 position，不能让它把节点扔到几千像素外
        arguments: {
          type: "imageNode",
          position: { x: 9800, y: -4200 },
          data: { displayName: "新节点" },
        },
      });

      const created = useCanvasStore.getState().nodes[1];
      expect(created.position.y).toBe(0);
      expect(created.position.x).toBeGreaterThan(0);
      expect(created.position.x).toBeLessThan(1000);
    });

    it("连续创建时始终贴着上一个节点，不会越排越散", () => {
      createNode("uploadNode", { x: 50, y: 300 }, "已有");
      for (const name of ["一", "二", "三"]) {
        executeCanvasAgentCommand({
          tool: "canvas.create_node",
          arguments: { type: "uploadNode", data: { displayName: name } },
        });
      }

      const nodes = useCanvasStore.getState().nodes;
      expect(nodes).toHaveLength(4);
      // 前三个都在锚点那一行；第四个按每行 4 个的规则换行，因此仍在第一行结束
      const xs = nodes.map((node) => node.position.x);
      const ys = nodes.map((node) => node.position.y);
      expect(new Set(ys).size).toBe(1);
      // 严格向右递增，间距一致
      for (let index = 1; index < xs.length; index += 1) {
        expect(xs[index]).toBeGreaterThan(xs[index - 1]);
      }
    });

    it("一行排满后换行，且新行不压住下方的节点", () => {
      // 先在下方摆一个占位节点，再摆一整行 4 个（行满 → 下一个必须换行）
      createNode("uploadNode", { x: 0, y: 500 }, "占位");
      for (let index = 0; index < 4; index += 1) {
        createNode("uploadNode", { x: index * 420, y: 0 }, `行内${index}`);
      }

      executeCanvasAgentCommand({
        tool: "canvas.create_node",
        arguments: { type: "uploadNode", data: { displayName: "换行后" } },
      });

      const nodes = useCanvasStore.getState().nodes;
      const created = nodes.find((node) => node.data.displayName === "换行后")!;
      const blocker = nodes.find((node) => node.data.displayName === "占位")!;
      // 换行后必须落在占位节点下方（不能压住它）
      expect(created.position.y).toBeGreaterThan(blocker.position.y);
    });
  });

  describe("canvas.focus_node（定位到画布）", () => {
    it("按名称投递视口请求，且不动节点数据", () => {
      const first = createNode("uploadNode", { x: 0, y: 0 }, "封面");
      const second = createNode("imageNode", { x: 900, y: 0 }, "配图");
      const positionsBefore = useCanvasStore.getState().nodes.map((node) => ({ ...node.position }));
      const historyBefore = useCanvasStore.getState().history.past.length;

      const focused = executeCanvasAgentCommand({
        tool: "canvas.focus_node",
        arguments: { nodeNames: [first, second] },
      });

      expect(focused.ok).toBe(true);
      const request = useCanvasStore.getState().focusRequest;
      expect(request?.nodeIds).toEqual(useCanvasStore.getState().nodes.map((node) => node.id));
      // 定位不该改节点、也不该压历史（否则一次「找找它在哪」就能占掉一步撤销）
      expect(useCanvasStore.getState().nodes.map((node) => ({ ...node.position }))).toEqual(positionsBefore);
      expect(useCanvasStore.getState().history.past).toHaveLength(historyBefore);
    });

    it("同一个节点连点两次也能再次触发（nonce 递增）", () => {
      const name = createNode("uploadNode", { x: 0, y: 0 }, "封面");

      executeCanvasAgentCommand({ tool: "canvas.focus_node", arguments: { nodeNames: [name] } });
      expect(useCanvasStore.getState().focusRequest?.nonce).toBe(1);

      executeCanvasAgentCommand({ tool: "canvas.focus_node", arguments: { nodeNames: [name] } });
      // 没有 nonce，effect 会认为依赖没变而不再执行 —— 按钮只能生效一次
      expect(useCanvasStore.getState().focusRequest?.nonce).toBe(2);
    });

    it("重名请求去重：同一个节点写两遍只算一个", () => {
      const name = createNode("uploadNode", { x: 0, y: 0 }, "封面");
      executeCanvasAgentCommand({
        tool: "canvas.focus_node",
        arguments: { nodeNames: [name, name] },
      });
      expect(useCanvasStore.getState().focusRequest?.nodeIds).toHaveLength(1);
    });

    it("全部名称都找不到时失败，并把现有名称回给模型", () => {
      createNode("uploadNode", { x: 0, y: 0 }, "封面");
      const failed = executeCanvasAgentCommand({
        tool: "canvas.focus_node",
        arguments: { nodeNames: ["不存在的节点"] },
      });
      expect(failed.ok).toBe(false);
      expect(failed.message).toContain("找不到");
      expect(failed.message).toContain("封面");
      // 失败了就不该投递任何请求，否则画布会莫名跳一下
      expect(useCanvasStore.getState().focusRequest).toBeNull();
    });

    it("部分找不到时仍定位命中的那些，并说明跳过了几个", () => {
      const name = createNode("uploadNode", { x: 0, y: 0 }, "封面");
      const partial = executeCanvasAgentCommand({
        tool: "canvas.focus_node",
        arguments: { nodeNames: [name, "不存在"] },
      });
      expect(partial.ok).toBe(true);
      expect(partial.message).toContain("跳过");
      expect(useCanvasStore.getState().focusRequest?.nodeIds).toHaveLength(1);
    });
  });
});
