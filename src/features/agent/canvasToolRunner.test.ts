import { beforeEach, describe, expect, it } from "vitest";

import { registerNodeGenerationHandler, resetNodeGenerationHandlers } from "@/features/canvas/application/nodeGenerationRegistry";
import { useCanvasStore } from "@/stores/canvasStore";

import { buildCanvasRefNames } from "./canvasContext";
import { confirmAndRunCanvasToolCall, runCanvasToolCall } from "./canvasToolRunner";

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
 * 这组测试守的是「AI 到底动了哪个节点」以及「有没有偷偷花用户的钱」。
 * 名称解析错、同名后缀错位，症状都是「AI 改了一个看起来对、其实不对的节点」；
 * 确认闸门漏了，症状是账户在用户没同意的情况下被扣费。
 */
describe("画布工具（按名称引用）", () => {
  beforeEach(() => {
    resetStore();
    resetNodeGenerationHandlers();
  });

  it("创建节点后用它的名称引用，不做 id 回译", () => {
    const created = runCanvasToolCall(
      {
        tool: "canvas.create_node",
        arguments: { type: "uploadNode", position: { x: 0, y: 0 }, data: { displayName: "封面" } },
      },
      "edit",
    );
    expect(created.ok).toBe(true);
    expect(created.message).toContain("封面");

    const updated = runCanvasToolCall(
      { tool: "canvas.update_node", arguments: { nodeName: "封面", data: { prompt: "一只猫" } } },
      "edit",
    );
    expect(updated.ok).toBe(true);
    expect(useCanvasStore.getState().nodes[0].data.prompt).toBe("一只猫");
  });

  it("同名节点靠 #2 区分，且指向的是正确的那一个", () => {
    runCanvasToolCall(
      { tool: "canvas.create_node", arguments: { type: "uploadNode", position: { x: 0, y: 0 } } },
      "edit",
    );
    runCanvasToolCall(
      { tool: "canvas.create_node", arguments: { type: "uploadNode", position: { x: 0, y: 200 } } },
      "edit",
    );

    const nodes = useCanvasStore.getState().nodes;
    const names = buildCanvasRefNames(nodes.map((node) => ({ id: node.id, title: "本地上传" })));
    expect([...names.values()]).toEqual(["本地上传", "本地上传 #2"]);

    const moved = runCanvasToolCall(
      {
        tool: "canvas.move_node",
        arguments: { nodeName: "本地上传 #2", position: { x: 900, y: 900 } },
      },
      "edit",
    );
    expect(moved.ok).toBe(true);
    // 动的是第二个，第一个原封不动
    expect(useCanvasStore.getState().nodes[1].position).toEqual({ x: 900, y: 900 });
    expect(useCanvasStore.getState().nodes[0].position).toEqual({ x: 0, y: 0 });
  });

  it("名称写错时把现有名称列出来，方便模型重试", () => {
    runCanvasToolCall(
      {
        tool: "canvas.create_node",
        arguments: { type: "imageNode", position: { x: 0, y: 0 }, data: { displayName: "镜头一" } },
      },
      "edit",
    );

    const failed = runCanvasToolCall(
      { tool: "canvas.move_node", arguments: { nodeName: "镜头二", position: { x: 1, y: 1 } } },
      "edit",
    );
    expect(failed.ok).toBe(false);
    expect(failed.message).toContain("镜头一");
  });

  it("按名称连线", () => {
    runCanvasToolCall(
      {
        tool: "canvas.create_node",
        arguments: { type: "uploadNode", position: { x: 0, y: 0 }, data: { displayName: "素材" } },
      },
      "edit",
    );
    runCanvasToolCall(
      {
        tool: "canvas.create_node",
        arguments: { type: "videoGenNode", position: { x: 400, y: 0 }, data: { displayName: "镜头" } },
      },
      "edit",
    );

    const linked = runCanvasToolCall(
      { tool: "canvas.connect_nodes", arguments: { sourceName: "素材", targetName: "镜头" } },
      "edit",
    );
    expect(linked.ok).toBe(true);

    const [first, second] = useCanvasStore.getState().nodes;
    const edge = useCanvasStore.getState().edges[0];
    expect(edge.source).toBe(first.id);
    expect(edge.target).toBe(second.id);
  });

  it("可以改节点尺寸", () => {
    runCanvasToolCall(
      {
        tool: "canvas.create_node",
        arguments: { type: "uploadNode", position: { x: 0, y: 0 }, data: { displayName: "封面" } },
      },
      "edit",
    );
    const resized = runCanvasToolCall(
      { tool: "canvas.resize_node", arguments: { nodeName: "封面", width: 320, height: 240 } },
      "edit",
    );
    expect(resized.ok).toBe(true);
    const node = useCanvasStore.getState().nodes[0];
    expect(node.measured?.width ?? node.width).toBe(320);
  });

  it("只读档拒绝写操作，画布不变", () => {
    const record = runCanvasToolCall(
      { tool: "canvas.create_node", arguments: { type: "uploadNode", position: { x: 0, y: 0 } } },
      "read-only",
    );
    expect(record.ok).toBe(false);
    expect(record.message).toContain("只看画布");
    expect(useCanvasStore.getState().nodes).toHaveLength(0);
  });

  it("编辑档放行写入，但删除仍被拒", () => {
    runCanvasToolCall(
      {
        tool: "canvas.create_node",
        arguments: { type: "uploadNode", position: { x: 0, y: 0 }, data: { displayName: "封面" } },
      },
      "edit",
    );
    const denied = runCanvasToolCall(
      { tool: "canvas.delete_node", arguments: { nodeName: "封面" } },
      "edit",
    );
    expect(denied.ok).toBe(false);
    expect(useCanvasStore.getState().nodes).toHaveLength(1);
  });

  it("删除在完全档下也要先问一句，确认后才真的删", () => {
    runCanvasToolCall(
      {
        tool: "canvas.create_node",
        arguments: { type: "uploadNode", position: { x: 0, y: 0 }, data: { displayName: "封面" } },
      },
      "full",
    );

    const asked = runCanvasToolCall(
      { tool: "canvas.delete_node", arguments: { nodeName: "封面" } },
      "full",
    );
    expect(asked.pending).toBe(true);
    // 只是问了一句，节点还在
    expect(useCanvasStore.getState().nodes).toHaveLength(1);

    const done = confirmAndRunCanvasToolCall(
      { tool: "canvas.delete_node", arguments: { nodeName: "封面" } },
      "full",
    );
    expect(done.ok).toBe(true);
    expect(useCanvasStore.getState().nodes).toHaveLength(0);
  });

  it("触发节点生成：有权限也必须先停在确认，绝不自动扣费", () => {
    runCanvasToolCall(
      {
        tool: "canvas.create_node",
        arguments: { type: "imageNode", position: { x: 0, y: 0 }, data: { displayName: "封面" } },
      },
      "full",
    );

    let fired = 0;
    registerNodeGenerationHandler(useCanvasStore.getState().nodes[0].id, () => {
      fired += 1;
    });

    const asked = runCanvasToolCall({ tool: "canvas.run_node", arguments: { nodeName: "封面" } }, "full");
    expect(asked.pending).toBe(true);
    expect(fired).toBe(0);

    const done = confirmAndRunCanvasToolCall(
      { tool: "canvas.run_node", arguments: { nodeName: "封面" } },
      "full",
    );
    expect(done.ok).toBe(true);
    expect(fired).toBe(1);
  });

  it("节点不在可视区（组件未挂载）时如实说明，而不是静默什么都不做", () => {
    runCanvasToolCall(
      {
        tool: "canvas.create_node",
        arguments: { type: "imageNode", position: { x: 0, y: 0 }, data: { displayName: "封面" } },
      },
      "full",
    );
    // 没有注册 handler ＝ 组件没挂载（画布只渲染可见节点）
    const done = confirmAndRunCanvasToolCall(
      { tool: "canvas.run_node", arguments: { nodeName: "封面" } },
      "full",
    );
    expect(done.ok).toBe(false);
    expect(done.message).toContain("可视区域");
  });

  describe("canvas.run_nodes（批量触发）", () => {
    /** 一次建 3 个同名节点（名称就是 锚点 / 锚点 #2 / 锚点 #3） */
    function seedThree() {
      runCanvasToolCall(
        {
          tool: "canvas.create_nodes",
          arguments: {
            nodes: [
              { type: "imageNode", data: { displayName: "锚点" } },
              { type: "imageNode", data: { displayName: "锚点" } },
              { type: "imageNode", data: { displayName: "锚点" } },
            ],
          },
        },
        "full",
      );
      return useCanvasStore.getState().nodes.map((node) => node.id);
    }

    it("即便有 full 权限，也先停在确认、一个都不点火", () => {
      const ids = seedThree();
      let fired = 0;
      for (const id of ids) registerNodeGenerationHandler(id, () => { fired += 1; });

      const asked = runCanvasToolCall(
        {
          tool: "canvas.run_nodes",
          arguments: { nodeNames: ["锚点", "锚点 #2", "锚点 #3"] },
        },
        "full",
      );
      expect(asked.pending).toBe(true);
      expect(fired).toBe(0);
    });

    it("确认后整批一起跑，每个节点只触发一次", () => {
      const ids = seedThree();
      const firedByNode = new Map<string, number>();
      for (const id of ids) {
        registerNodeGenerationHandler(id, () => {
          firedByNode.set(id, (firedByNode.get(id) ?? 0) + 1);
        });
      }

      const done = confirmAndRunCanvasToolCall(
        {
          tool: "canvas.run_nodes",
          arguments: { nodeNames: ["锚点", "锚点 #2", "锚点 #3"] },
        },
        "full",
      );
      expect(done.ok).toBe(true);
      expect(firedByNode.size).toBe(3);
      expect([...firedByNode.values()]).toEqual([1, 1, 1]);
    });

    it("部分名称找不到时，能跑照跑、跳过的逐个说明原因", () => {
      const ids = seedThree();
      let fired = 0;
      registerNodeGenerationHandler(ids[0], () => { fired += 1; });

      const done = confirmAndRunCanvasToolCall(
        { tool: "canvas.run_nodes", arguments: { nodeNames: ["锚点", "锚点 #2"] } },
        "full",
      );
      expect(done.ok).toBe(true);
      expect(fired).toBe(1);
      // 第二个没注册 handler（＝不在可视区），必须如实报出来
      expect(done.message).toContain("跳过 1 个");
      expect(done.message).toContain("锚点 #2");
    });

    it("一个都跑不起来时判失败，不让模型以为已经开始", () => {
      seedThree();
      const done = confirmAndRunCanvasToolCall(
        { tool: "canvas.run_nodes", arguments: { nodeNames: ["锚点"] } },
        "full",
      );
      expect(done.ok).toBe(false);
      expect(done.message).toContain("跳过");
    });

    /**
     * 确认卡片上必须有总价：12 张图一起跑时，没有合计等于让用户盲签一张账单。
     * 测试里的模型没有价格数据，所以出现的是「价格未知」——重点是**这句必须存在**。
     */
    it("待确认的卡片上给出节点数与预计花费", () => {
      seedThree();
      const asked = runCanvasToolCall(
        {
          tool: "canvas.run_nodes",
          arguments: { nodeNames: ["锚点", "锚点 #2", "锚点 #3"] },
        },
        "full",
      );
      expect(asked.pending).toBe(true);
      expect(asked.message).toContain("将对 3 个节点执行");
      expect(asked.message).toContain("预计");
      expect(asked.message).toContain("锚点 #2");
    });
  });

  it("读快照时把真实内容回给模型", () => {
    runCanvasToolCall(
      {
        tool: "canvas.create_node",
        arguments: { type: "uploadNode", position: { x: 8, y: 9 }, data: { displayName: "封面" } },
      },
      "edit",
    );
    const record = runCanvasToolCall({ tool: "canvas.get_snapshot", arguments: {} }, "edit");
    expect(record.message).toContain("画面现状");
    expect(record.message).toContain("「封面」");
    expect(record.message).toContain("@(8,9)");
  });

  it("未知工具记成失败，不抛错中断整轮", () => {
    const record = runCanvasToolCall({ tool: "canvas.explode", arguments: {} }, "full");
    expect(record.ok).toBe(false);
    expect(record.message).toContain("未知的画布工具");
  });

  it("节点不存在时失败，界面仍能正常显示这张卡片", () => {
    const record = runCanvasToolCall(
      { tool: "canvas.move_node", arguments: { nodeName: "不存在的节点", position: { x: 1, y: 1 } } },
      "edit",
    );
    expect(record.ok).toBe(false);
    expect(record.label).toBe("移动节点");
    expect(record.message).toContain("找不到");
  });
});
