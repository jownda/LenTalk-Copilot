/**
 * 画布工具协议：把「模型的文本输出」与「画布命令」互相翻译。
 *
 * 为什么走文本协议而不是原生 function calling：
 * - 本应用的 Chat 模型来自用户自配的各类中转平台，对请求体里 `tools` 参数的支持参差不齐，
 *   不支持时上游直接 400，等于把「画布能力」绑死在模型选型上；
 * - `llmClient` 的 SSE 解析器只处理纯文本增量（`sseParser` 有单测），
 *   为一个可选能力去改它、还要处理 tool_calls 的分片拼接，风险与收益不成比例。
 *
 * 于是约定：模型在回复里嵌入 `<canvas_tool>{"tool":…,"arguments":…}</canvas_tool>` 块。
 * 任何模型都能输出；解析是纯函数可单测；块写坏了还能把错误回灌给模型自我纠正。
 *
 * 本文件**不含任何 IO 与副作用**（除别名表这个显式的可变容器），全部可单测。
 */

import { CANVAS_NODE_TYPES, type CanvasNodeType } from "@/features/canvas/domain/canvasNodes";
import { DEFAULT_NODE_DISPLAY_NAME } from "@/features/canvas/domain/nodeDisplay";

import { buildCanvasRefNames, type CanvasAgentSnapshot } from "./canvasContext";
import { canvasAgentTools, type CanvasAgentPermission } from "./canvasTools";
import {
  DEFAULT_CANVAS_ACCESS_LEVEL,
  type AgentToolCallRecord,
  type CanvasAgentAccessLevel,
} from "./types";

export { CANVAS_ACCESS_HINTS, CANVAS_ACCESS_LABELS, DEFAULT_CANVAS_ACCESS_LEVEL } from "./types";
export type { CanvasAgentAccessLevel } from "./types";

export const CANVAS_TOOL_OPEN = "<canvas_tool>";
export const CANVAS_TOOL_CLOSE = "</canvas_tool>";

export interface ParsedCanvasToolCall {
  tool: string;
  arguments: Record<string, unknown>;
}

export interface ParsedCanvasReply {
  /** 剥掉工具块之后、给用户看的自然语言部分 */
  text: string;
  calls: ParsedCanvasToolCall[];
  /** 工具块解析失败的原因，会回灌给模型让它纠正 */
  errors: string[];
}

const TOOL_BLOCK_PATTERN = /<canvas_tool>([\s\S]*?)<\/canvas_tool>/gi;

/** 去掉模型可能顺手加的 ```json 围栏 */
function stripCodeFence(value: string): string {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(value);
  return fenced ? fenced[1].trim() : value;
}

/**
 * 从模型的一轮输出里抽出工具调用，并返回剥掉工具块后的可见文本。
 * 容错优先：单个块写坏不影响其它块，坏块的原因进 `errors`。
 */
export function parseCanvasReply(raw: string): ParsedCanvasReply {
  const calls: ParsedCanvasToolCall[] = [];
  const errors: string[] = [];

  const stripped = raw.replace(TOOL_BLOCK_PATTERN, (_match, body: string) => {
    const payload = stripCodeFence(String(body).trim());
    if (!payload) {
      errors.push("工具块是空的");
      return "";
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch (error) {
      errors.push(`工具块不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`);
      return "";
    }
    if (!parsed || typeof parsed !== "object") {
      errors.push("工具块必须是一个 JSON 对象");
      return "";
    }
    const record = parsed as { tool?: unknown; arguments?: unknown };
    const tool = typeof record.tool === "string" ? record.tool.trim() : "";
    if (!tool) {
      errors.push("工具块缺少 tool 字段");
      return "";
    }
    const rawArguments = record.arguments;
    const args =
      rawArguments && typeof rawArguments === "object" && !Array.isArray(rawArguments)
        ? (rawArguments as Record<string, unknown>)
        : {};
    calls.push({ tool, arguments: args });
    return "";
  });

  return {
    text: stripped.replace(/\n{3,}/g, "\n\n").trim(),
    calls,
    errors,
  };
}

/**
 * 流式渲染用：把工具块从"正在打字的文本"里剥掉。
 *
 * 与 `parseCanvasReply` 的差别是它必须容忍**写了一半的块**：
 * 增量到达时 `</canvas_tool>` 可能还没出现，若原样上屏，用户会看到
 * 半截 JSON 闪一下再消失。所以未闭合的块连同标签本身一起隐藏。
 */
export function stripCanvasToolBlocks(text: string): string {
  let next = text.replace(TOOL_BLOCK_PATTERN, "");
  // 未闭合的工具块：从最后一个开标签起全部隐藏
  next = next.replace(/<canvas_tool>[\s\S]*$/i, "");
  // 标签自己也可能被切成两半（"<canvas_to"）：从最后一个 "<" 起若是标签前缀则砍掉
  const lastOpen = next.lastIndexOf("<");
  if (lastOpen >= 0) {
    const tail = next.slice(lastOpen).toLowerCase();
    if (CANVAS_TOOL_OPEN.toLowerCase().startsWith(tail)) next = next.slice(0, lastOpen);
  }
  return next.replace(/\n{3,}/g, "\n\n").trim();
}

/** 判断某档位下能否执行某权限级别的工具 */
export function isCanvasToolAllowed(
  level: CanvasAgentAccessLevel,
  permission: CanvasAgentPermission,
): boolean {
  if (permission === "destructive" || permission === "paid-operation") return level === "full";
  if (permission === "write") return level === "edit" || level === "full";
  return true;
}

// ---------------------------------------------------------------------------
// 快照 → 提示词
// ---------------------------------------------------------------------------

export interface CanvasSnapshotFormatOptions {
  /** 最多列出多少个节点，超出只给数量 */
  maxNodes?: number;
  /** 单个字段值的最大字符数（节点里可能塞着上万字的提示词） */
  maxFieldChars?: number;
}

export const DEFAULT_MAX_SNAPSHOT_NODES = 60;
export const DEFAULT_MAX_FIELD_CHARS = 160;

function truncate(value: string, maxChars: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maxChars ? `${compact.slice(0, maxChars)}…` : compact;
}

function formatFieldValue(value: unknown, maxChars: number): string {
  if (typeof value === "string") return `"${truncate(value, maxChars)}"`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  let json: string;
  try {
    json = JSON.stringify(value) ?? String(value);
  } catch {
    json = "[无法序列化]";
  }
  return truncate(json, maxChars);
}

function formatNodeData(data: Record<string, unknown>, maxChars: number): string {
  const entries = Object.entries(data);
  if (entries.length === 0) return "";
  return entries.map(([key, value]) => ` ${key}=${formatFieldValue(value, maxChars)}`).join("");
}

/**
 * 把画布现状渲染成一段紧凑文本，注入 system prompt。
 * 节点以**名称**呈现（同名带 ` #2`），工具参数里也用这套名字引用。
 */
export function formatCanvasSnapshotForPrompt(
  snapshot: CanvasAgentSnapshot,
  options: CanvasSnapshotFormatOptions = {},
): string {
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_SNAPSHOT_NODES;
  const maxFieldChars = options.maxFieldChars ?? DEFAULT_MAX_FIELD_CHARS;

  if (snapshot.nodes.length === 0) {
    return "【画面现状】画布上还没有任何节点。";
  }

  // 名称必须按**全量**节点算（后缀取决于它排第几），与执行侧的解析规则一致
  const refNames = buildCanvasRefNames(snapshot.nodes);
  const shown = snapshot.nodes.slice(0, maxNodes);
  const selectedNames = snapshot.nodes
    .filter((node) => node.selected)
    .map((node) => refNames.get(node.id) ?? node.id);

  const lines: string[] = ["【画面现状】"];
  lines.push(
    `节点 ${snapshot.nodes.length} 个 · 连线 ${snapshot.edges.length} 条 · ` +
      (selectedNames.length > 0
        ? `当前选中：${selectedNames.join("、")}`
        : "当前没有选中节点"),
  );
  lines.push(
    `视口：x=${Math.round(snapshot.viewport.x)} y=${Math.round(snapshot.viewport.y)} zoom=${snapshot.viewport.zoom.toFixed(2)}`,
  );

  lines.push("节点（引用时一律用这里的名称）：");
  for (const node of shown) {
    const name = refNames.get(node.id) ?? node.id;
    const position = `@(${Math.round(node.position.x)},${Math.round(node.position.y)})`;
    const size =
      typeof node.size?.width === "number" && typeof node.size?.height === "number"
        ? ` ${Math.round(node.size.width)}x${Math.round(node.size.height)}`
        : "";
    const selected = node.selected ? " [已选中]" : "";
    lines.push(
      `- 「${name}」${node.type}${position}${size}${selected}` +
        formatNodeData(node.data, maxFieldChars),
    );
  }
  if (snapshot.nodes.length > shown.length) {
    lines.push(
      `（另有 ${snapshot.nodes.length - shown.length} 个节点未列出；需要全量时调用 canvas.get_snapshot）`,
    );
  }

  if (snapshot.edges.length > 0) {
    lines.push("连线（上游 → 下游）：");
    for (const edge of snapshot.edges.slice(0, maxNodes * 2)) {
      const from = refNames.get(edge.source) ?? edge.source;
      const to = refNames.get(edge.target) ?? edge.target;
      lines.push(`- 「${from}」 → 「${to}」`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 工具说明（给模型看）
// ---------------------------------------------------------------------------

const TOOL_USAGE: Record<string, string> = {
  "canvas.get_snapshot": "无参数",
  "canvas.get_selected_nodes": "无参数",
  "canvas.create_node":
    '{"type":"节点类型","position":{"x":0,"y":0},"data":{"displayName":"给它的名字"}}',
  "canvas.create_nodes":
    '{"nodes":[{"type":"节点类型","data":{"displayName":"名字"}},{"type":"节点类型","data":{"displayName":"名字"}}]}（批量建节点用这个，别循环调 create_node；省略 position 会自动排布）',
  "canvas.update_node": '{"nodeName":"AI 图片","data":{"prompt":"新的提示词"}}（只写要改的字段）',
  "canvas.move_node": '{"nodeName":"AI 图片","position":{"x":0,"y":0}}',
  "canvas.resize_node": '{"nodeName":"AI 图片","width":320,"height":240}',
  "canvas.connect_nodes": '{"sourceName":"本地上传","targetName":"AI 视频"}',
  "canvas.delete_node": '{"nodeName":"AI 图片 #2"}',
  "canvas.run_node": '{"nodeName":"AI 视频"}（需用户确认后才真正执行）',
  "canvas.run_nodes": '{"nodeNames":["AI 图片","AI 图片 #2"]}（批量触发用这个，用户确认一次即可整批执行）',
  "canvas.undo": "无参数",
  "canvas.redo": "无参数",
  "canvas.auto_layout": "无参数",
};

/**
 * 可直接改的节点参数字段（`canvas.update_node` 的 data 键）。
 * 只给字段名不足以让模型用对，所以三类分开说明：
 * 通用 / 生成类节点 / 文本类节点。
 */
const MUTABLE_FIELDS: string[] = [
  "displayName：节点在画布上显示的名称（改名后引用名随之变化）",
  "prompt：节点自己的提示词",
  "content：文本节点的正文",
  "model：生成用的模型 id（取值见节点的 model 字段现状，一般不要乱改）",
  "imageMode：图生视频模式，reference（参考图，默认）或 first-last（首尾帧，需两张图）",
  "aspectRatio：画面比例，如 1:1 / 16:9 / 9:16 / 4:3 / 3:4 / 21:9",
  "resolution：分辨率档位，如 720p / 1080p / 1K / 2K / 4K",
  "duration：视频时长（秒），取值必须在该模型支持范围内",
  "imageCount：一次生成的图片张数",
  "quickStyle / quickSynopsis / quickStaging：提示词工作室内对应的快捷字段",
  "excludedReferenceSources：要排除的上游素材",
];

/** 工具名的中文短标签，用于 UI 卡片 */
const TOOL_LABELS: Record<string, string> = {
  "canvas.get_snapshot": "读取画布",
  "canvas.get_selected_nodes": "读取选中节点",
  "canvas.create_node": "创建节点",
  "canvas.create_nodes": "批量创建节点",
  "canvas.update_node": "更新节点参数",
  "canvas.move_node": "移动节点",
  "canvas.resize_node": "调整节点尺寸",
  "canvas.connect_nodes": "连接节点",
  "canvas.delete_node": "删除节点",
  "canvas.run_node": "触发节点生成",
  "canvas.run_nodes": "批量触发生成",
  "canvas.undo": "撤销",
  "canvas.redo": "重做",
  "canvas.auto_layout": "自动布局",
};

export function canvasToolLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? tool;
}

/** 节点类型清单：给模型挑 type 用 */
export function describeNodeTypes(): string {
  return Object.values(CANVAS_NODE_TYPES)
    .map((type) => `${type}（${DEFAULT_NODE_DISPLAY_NAME[type as CanvasNodeType]}）`)
    .join("、");
}

/**
 * 生成注入 system prompt 的「画布操作」章节。
 * 按权限档位过滤工具清单 —— 让模型压根看不到没授权的工具，
 * 比让它调用后再被拒绝更省一轮往返，也少一次失败体验。
 */
export function buildCanvasToolPrompt(level: CanvasAgentAccessLevel = DEFAULT_CANVAS_ACCESS_LEVEL): string {
  const tools = Object.values(canvasAgentTools).filter((tool) =>
    isCanvasToolAllowed(level, tool.permission as CanvasAgentPermission),
  );

  const lines: string[] = ["", "【画布操作】"];
  lines.push(
    "你可以通过工具读写用户的画布。需要操作画布时，在回复里嵌入这样的块（可与正常文字混排，一次可写多个）：",
  );
  lines.push(`${CANVAS_TOOL_OPEN}{"tool":"canvas.get_selected_nodes","arguments":{}}${CANVAS_TOOL_CLOSE}`);
  lines.push("规则：");
  lines.push("1. 块内必须是**严格 JSON**：双引号、无注释、无省略号、无多余字符。");
  lines.push(
    "2. 节点一律用上文「画面现状」里的**名称**引用（写在 nodeName / sourceName / targetName 里），" +
      "名称要逐字照抄，包括 ` #2` 这种同名后缀；不要编造名称，也不要用 id。",
  );
  lines.push(
    "3. 同名节点靠 ` #2`、` #3` 区分（按画布上的排列顺序）。拿不准是哪一个时，先调 canvas.get_snapshot 看清名称。",
  );
  lines.push(
    "4. 改参数只写要改的字段，没提到的字段保持不动；名字写错时我会把画布上现有的名称列给你，据此重试。",
  );
  lines.push("5. 需要先了解画布再决策时，先调用读取类工具，等我回给你结果后再继续。");
  lines.push("6. 不要把工具块本身展示或解释给用户，也不要在正文里复述这段 JSON。");
  lines.push("7. 画布操作失败时如实说明失败原因，不要假装已经成功。");

  // ⚠️ 批量提示必须按档位分开写：低档位的提示词里出现它无权使用的工具名，
  // 会诱使模型写出一个注定被拒的块（有用例守着「只读档不出现写工具」）。
  if (isCanvasToolAllowed(level, "write")) {
    lines.push(
      "8. **批量优先**：一次要建多个节点用 canvas.create_nodes（nodes 数组），" +
        "不要为每个节点各写一个块 —— 那样既慢又容易中途出错。",
    );
  }

  if (level === "read-only") {
    lines.push(
      "注意：当前是**只读**模式，你只能读取画布，不能修改。用户要求改动画布时，如实说明未开启修改权限，并给出建议的手动步骤。",
    );
  }

  // 只有拿得到生成权限时才提这一条 —— 否则低档位的提示词里会冒出一个它用不了的工具名
  if (isCanvasToolAllowed(level, "paid-operation")) {
    lines.push(
      "关于 canvas.run_node / canvas.run_nodes：它们会让节点真正开始生成并产生费用，" +
        "**必须等用户确认后才执行**（批量卡片上会显示这批的预计花费）。" +
        "一次要跑多个节点时用 canvas.run_nodes（nodeNames 数组），用户确认一次即可整批执行；" +
        "你只负责发起，不要写成「已经生成好了」，也不要在正文里催用户——确认与否是用户的事。",
    );
  }

  lines.push("可用工具：");
  for (const tool of tools) {
    const usage = TOOL_USAGE[tool.name];
    lines.push(`- ${tool.name}：${tool.description}${usage ? ` 参数：${usage}` : ""}`);
  }
  lines.push(`节点类型（create_node / create_nodes 的 type 取值）：${describeNodeTypes()}`);

  // 只有拿得到改参数权限时才列字段清单，否则纯属噪音
  if (isCanvasToolAllowed(level, "write")) {
    lines.push("可用 canvas.update_node 修改的字段（未列出的字段不要动）：");
    for (const field of MUTABLE_FIELDS) lines.push(`- ${field}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 执行结果 → 回灌文本
// ---------------------------------------------------------------------------

/**
 * 把一轮工具执行的结果整理成回灌消息。
 * 用 `user` 角色而不是 `tool` 角色：部分中转平台不认 `tool` 角色，
 * 用 user 是兼容性最好的做法。
 */
export function formatCanvasToolResults(
  records: AgentToolCallRecord[],
  errors: string[] = [],
): string {
  const lines: string[] = ["[画布工具执行结果]"];
  for (const record of records) {
    lines.push(`- ${record.tool} → ${record.ok ? "成功" : "失败"}：${record.message}`);
  }
  for (const error of errors) {
    lines.push(`- 工具块无法解析：${error}`);
  }
  lines.push(
    "以上是画布的真实返回。还需要操作就继续输出 canvas_tool 块；否则直接用自然语言回复用户。",
  );
  return lines.join("\n");
}
