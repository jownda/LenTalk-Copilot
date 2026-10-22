import { describe, expect, it } from "vitest";

import { buildCanvasRefNames, type CanvasAgentSnapshot } from "./canvasContext";
import {
  buildCanvasToolPrompt,
  canvasToolLabel,
  formatCanvasSnapshotForPrompt,
  formatCanvasToolResults,
  isCanvasToolAllowed,
  parseCanvasReply,
  stripCanvasToolBlocks,
} from "./canvasToolProtocol";

function snapshot(partial: Partial<CanvasAgentSnapshot> = {}): CanvasAgentSnapshot {
  return {
    nodes: [],
    edges: [],
    selectedNodeIds: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    ...partial,
  };
}

function node(id: string, overrides: Partial<CanvasAgentSnapshot["nodes"][number]> = {}) {
  return {
    id,
    type: "uploadNode",
    title: "本地上传",
    position: { x: 0, y: 0 },
    size: { width: 220, height: 120 },
    selected: false,
    data: {},
    ...overrides,
  };
}

describe("parseCanvasReply", () => {
  it("抽出工具调用，并把工具块从可见文本里剥掉", () => {
    const raw = [
      "好的，我先看一下画布。",
      '<canvas_tool>{"tool":"canvas.get_snapshot","arguments":{}}</canvas_tool>',
      "然后给你建议。",
    ].join("\n");

    const parsed = parseCanvasReply(raw);
    expect(parsed.calls).toEqual([{ tool: "canvas.get_snapshot", arguments: {} }]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.text).toBe("好的，我先看一下画布。\n\n然后给你建议。");
    expect(parsed.text).not.toContain("canvas_tool");
  });

  it("一轮里可以带多个工具块", () => {
    const raw =
      '<canvas_tool>{"tool":"canvas.create_node","arguments":{"type":"uploadNode","position":{"x":0,"y":0}}}</canvas_tool>' +
      '<canvas_tool>{"tool":"canvas.auto_layout","arguments":{}}</canvas_tool>';
    const parsed = parseCanvasReply(raw);
    expect(parsed.calls.map((call) => call.tool)).toEqual([
      "canvas.create_node",
      "canvas.auto_layout",
    ]);
    expect(parsed.text).toBe("");
  });

  it("容忍模型顺手加的 ```json 围栏", () => {
    const raw = '<canvas_tool>\n```json\n{"tool":"canvas.undo","arguments":{}}\n```\n</canvas_tool>';
    expect(parseCanvasReply(raw).calls).toEqual([{ tool: "canvas.undo", arguments: {} }]);
  });

  it("单个块写坏不影响其它块，坏块原因进 errors", () => {
    const raw =
      '<canvas_tool>{"tool":"canvas.undo",}</canvas_tool>' +
      '<canvas_tool>{"tool":"canvas.redo","arguments":{}}</canvas_tool>';
    const parsed = parseCanvasReply(raw);
    expect(parsed.calls.map((call) => call.tool)).toEqual(["canvas.redo"]);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toContain("不是合法 JSON");
  });

  it("缺少 tool 字段的块被记成错误而不是静默丢弃", () => {
    const parsed = parseCanvasReply('<canvas_tool>{"arguments":{}}</canvas_tool>');
    expect(parsed.calls).toEqual([]);
    expect(parsed.errors[0]).toContain("缺少 tool");
  });

  it("arguments 缺失或不是对象时按空对象处理", () => {
    const parsed = parseCanvasReply(
      '<canvas_tool>{"tool":"canvas.undo","arguments":"nope"}</canvas_tool>',
    );
    expect(parsed.calls).toEqual([{ tool: "canvas.undo", arguments: {} }]);
  });

  it("没有工具块时原样返回文本", () => {
    const parsed = parseCanvasReply("就是一段普通回答。");
    expect(parsed.calls).toEqual([]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.text).toBe("就是一段普通回答。");
  });
});

describe("stripCanvasToolBlocks", () => {
  it("剥掉闭合的工具块", () => {
    expect(stripCanvasToolBlocks('前面<canvas_tool>{"tool":"canvas.undo"}</canvas_tool>后面')).toBe(
      "前面后面",
    );
  });

  it("未闭合的块连同内容一起隐藏（流式期间不能闪出半截 JSON）", () => {
    expect(stripCanvasToolBlocks('开始\n<canvas_tool>{"tool":"canvas.cr')).toBe("开始");
  });

  it("标签本身被切成两半时也不显示", () => {
    expect(stripCanvasToolBlocks("开始\n<canvas_to")).toBe("开始");
    expect(stripCanvasToolBlocks("开始\n<c")).toBe("开始");
  });

  it("普通的尖括号不受影响", () => {
    expect(stripCanvasToolBlocks("1 < 2 且 a <b> c")).toBe("1 < 2 且 a <b> c");
  });
});

describe("buildCanvasRefNames", () => {
  it("同名节点按出现顺序加后缀", () => {
    const names = buildCanvasRefNames([
      { id: "a", title: "AI 图片" },
      { id: "b", title: "AI 图片" },
      { id: "c", title: "AI 图片" },
      { id: "d", title: "AI 视频" },
    ]);
    expect(names.get("a")).toBe("AI 图片");
    expect(names.get("b")).toBe("AI 图片 #2");
    expect(names.get("c")).toBe("AI 图片 #3");
    expect(names.get("d")).toBe("AI 视频");
  });

  it("名称全部唯一时不加任何后缀", () => {
    const names = buildCanvasRefNames([
      { id: "a", title: "封面" },
      { id: "b", title: "镜头一" },
    ]);
    expect([...names.values()]).toEqual(["封面", "镜头一"]);
  });
});

describe("权限分档", () => {
  it("只读档只放行读取类", () => {
    expect(isCanvasToolAllowed("read-only", "read")).toBe(true);
    expect(isCanvasToolAllowed("read-only", "write")).toBe(false);
    expect(isCanvasToolAllowed("read-only", "destructive")).toBe(false);
    expect(isCanvasToolAllowed("read-only", "paid-operation")).toBe(false);
  });

  it("编辑档放行读与写，但不放行删除与生成", () => {
    expect(isCanvasToolAllowed("edit", "write")).toBe(true);
    expect(isCanvasToolAllowed("edit", "destructive")).toBe(false);
    expect(isCanvasToolAllowed("edit", "paid-operation")).toBe(false);
  });

  it("完全档全放行", () => {
    expect(isCanvasToolAllowed("full", "destructive")).toBe(true);
    expect(isCanvasToolAllowed("full", "paid-operation")).toBe(true);
  });
});

describe("formatCanvasSnapshotForPrompt", () => {
  it("空画布给出明确措辞，而不是空白", () => {
    const text = formatCanvasSnapshotForPrompt(snapshot());
    expect(text).toContain("还没有任何节点");
  });

  it("节点以名称呈现，同名带 #2 后缀", () => {
    const text = formatCanvasSnapshotForPrompt(
      snapshot({
        nodes: [
          node("uuid-a", { title: "封面", position: { x: 12, y: 34 }, selected: true }),
          node("uuid-b", { title: "封面", position: { x: 0, y: 300 } }),
        ],
      }),
    );
    expect(text).toContain("节点 2 个");
    expect(text).toContain("- 「封面」uploadNode@(12,34)");
    expect(text).toContain("- 「封面 #2」uploadNode@(0,300)");
    expect(text).toContain("[已选中]");
    expect(text).toContain("当前选中：封面");
  });

  it("超长字段被截断（节点里可能塞着上万字的提示词）", () => {
    const text = formatCanvasSnapshotForPrompt(
      snapshot({ nodes: [node("uuid-a", { data: { prompt: "长".repeat(500) } })] }),
      { maxFieldChars: 20 },
    );
    expect(text).toContain("…");
    expect(text).not.toContain("长".repeat(21));
  });

  it("节点过多时只列前 N 个并说明省略数量", () => {
    const nodes = Array.from({ length: 5 }, (_, index) =>
      node(`uuid-${index}`, { title: `节点${index}` }),
    );
    const text = formatCanvasSnapshotForPrompt(snapshot({ nodes }), { maxNodes: 2 });
    expect(text).toContain("节点 5 个");
    expect(text).toContain("另有 3 个节点未列出");
  });

  it("连线用名称表示", () => {
    const text = formatCanvasSnapshotForPrompt(
      snapshot({
        nodes: [node("uuid-a", { title: "素材" }), node("uuid-b", { title: "镜头" })],
        edges: [
          {
            id: "e1",
            source: "uuid-a",
            target: "uuid-b",
            sourceHandle: "source",
            targetHandle: "target",
          },
        ],
      }),
    );
    expect(text).toContain("- 「素材」 → 「镜头」");
  });
});

describe("buildCanvasToolPrompt", () => {
  it("只读档不给模型看写工具，并明确说明没有修改权限", () => {
    const prompt = buildCanvasToolPrompt("read-only");
    expect(prompt).toContain("只读");
    expect(prompt).toContain("canvas.get_snapshot");
    expect(prompt).not.toContain("canvas.create_node");
    expect(prompt).not.toContain("canvas.run_node");
  });

  it("编辑档给写工具，但不给生成与删除", () => {
    const prompt = buildCanvasToolPrompt("edit");
    expect(prompt).toContain("canvas.create_node");
    expect(prompt).toContain("canvas.connect_nodes");
    expect(prompt).toContain("canvas.resize_node");
    expect(prompt).not.toContain("canvas.delete_node");
    expect(prompt).not.toContain("canvas.run_node");
  });

  it("完全档列出全部工具，并带上节点类型清单与可改参数", () => {
    const prompt = buildCanvasToolPrompt("full");
    expect(prompt).toContain("canvas.delete_node");
    expect(prompt).toContain("canvas.run_node");
    expect(prompt).toContain("uploadNode");
    expect(prompt).toContain("videoGenNode");
    // 参数清单必须出现，否则模型不知道 update_node 能改什么
    expect(prompt).toContain("aspectRatio");
    expect(prompt).toContain("resolution");
  });

  it("明确说明生成要等用户确认，不许自称已完成", () => {
    const prompt = buildCanvasToolPrompt("full");
    expect(prompt).toContain("必须等用户确认");
  });

  it("引用方式是名称而非 id 或别名", () => {
    const prompt = buildCanvasToolPrompt("edit");
    expect(prompt).toContain("nodeName");
    expect(prompt).not.toContain("n1、n2");
  });
});

describe("formatCanvasToolResults", () => {
  it("逐条给出成功/失败，并带上解析错误", () => {
    const text = formatCanvasToolResults(
      [
        {
          tool: "canvas.create_node",
          label: "创建节点",
          arguments: {},
          ok: true,
          message: "已创建节点，名称为「封面」。",
        },
        {
          tool: "canvas.delete_node",
          label: "删除节点",
          arguments: {},
          ok: false,
          message: "权限不足。",
        },
      ],
      ["工具块是空的"],
    );
    expect(text).toContain("[画布工具执行结果]");
    expect(text).toContain("canvas.create_node → 成功：已创建节点，名称为「封面」。");
    expect(text).toContain("canvas.delete_node → 失败：权限不足。");
    expect(text).toContain("工具块是空的");
  });
});

describe("canvasToolLabel", () => {
  it("已知工具给中文标签，未知工具回落原名", () => {
    expect(canvasToolLabel("canvas.create_node")).toBe("创建节点");
    expect(canvasToolLabel("canvas.run_node")).toBe("触发节点生成");
    expect(canvasToolLabel("canvas.???")).toBe("canvas.???");
  });
});
