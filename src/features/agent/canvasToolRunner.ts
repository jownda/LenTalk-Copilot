/**
 * 执行一次画布工具调用。
 *
 * 单独成文件而不是塞在 `AgentPanel.tsx` 里：这里的每一条分支都是**错了也很难看出来**的类型
 * ——名称解析错会让 AI 悄悄操作了另一个节点，权限拦截漏了会让只读档也能改画布，
 * 需确认的操作漏拦会**直接花掉用户的钱**。
 * 放在这里就能被 vitest 直接驱动（`canvasStore` 在 node 环境下可跑）。
 */

import { getCanvasAgentSnapshot, findCanvasNodeByRefName, type CanvasAgentSnapshot } from "./canvasContext";
import { lenTalkCanvasPlugin } from "./canvasPlugin";
import { estimateNodePrice, summarizeNodePrices, type NodePriceEstimate } from "./agentNodePrice";
import { useCanvasStore } from "@/stores/canvasStore";
import {
  CANVAS_ACCESS_LABELS,
  canvasToolLabel,
  formatCanvasSnapshotForPrompt,
  isCanvasToolAllowed,
  type CanvasAgentAccessLevel,
  type ParsedCanvasToolCall,
} from "./canvasToolProtocol";
import { canvasAgentTools, type CanvasAgentPermission, type CanvasAgentToolName } from "./canvasTools";
import type { AgentToolCallRecord } from "./types";

/** 一轮对话里最多允许的工具往返次数，防止模型陷入「调用 → 结果 → 再调用」的死循环 */
export const MAX_CANVAS_TOOL_ROUNDS = 5;

function buildRecord(
  call: ParsedCanvasToolCall,
  patch: Partial<AgentToolCallRecord>,
): AgentToolCallRecord {
  return {
    tool: call.tool,
    label: canvasToolLabel(call.tool),
    arguments: call.arguments,
    ok: false,
    message: "",
    ...patch,
  };
}

function resolveDefinition(call: ParsedCanvasToolCall) {
  return Object.values(canvasAgentTools).find((tool) => tool.name === call.tool);
}

/**
 * 会花钱 / 具破坏性的操作**一律不自动执行**，交给用户在卡片上点确认。
 *
 * 刻意不在这里调 `canvasPlugin.execute(..., { confirmed: true })`：
 * 权限档位决定的是「AI 有没有资格碰这类工具」，点不点确认是另一回事 ——
 * 两者混同就等于「档位开高了就自动扣费」，那正是用户明确否掉的行为。
 */
function requiresUserConfirmation(permission: CanvasAgentPermission): boolean {
  return permission === "destructive" || permission === "paid-operation";
}

/**
 * 待确认的生成操作：列出要跑的节点 + 这批的预计花费。
 *
 * 只有 `run_node` / `run_nodes` 会走到这里（另一个 pending 工具是 delete_node，
 * 它没有「花费」这个概念）。名称找不到的单独计数，不要混进合计里 ——
 * 把未知当成 0 会给出一个偏低的报价，比不报价更糟。
 */
function describePendingGenerationQuote(call: ParsedCanvasToolCall): string | null {
  const args = (call.arguments ?? {}) as Record<string, unknown>;
  const names: string[] = Array.isArray(args.nodeNames)
    ? args.nodeNames.filter((item): item is string => typeof item === "string")
    : typeof args.nodeName === "string"
      ? [args.nodeName]
      : [];
  if (names.length === 0) return null;

  const store = useCanvasStore.getState();
  const estimates: NodePriceEstimate[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const found = findCanvasNodeByRefName(name, store);
    if (!found.node) {
      missing.push(name);
      continue;
    }
    estimates.push(estimateNodePrice(found.node));
  }
  if (estimates.length === 0) return null;

  const preview =
    names.slice(0, 6).join("、") + (names.length > 6 ? ` 等 ${names.length} 个` : "");
  const lines = [`将对 ${estimates.length} 个节点执行：${preview}`];
  lines.push(`预计 ${summarizeNodePrices(estimates)}`);
  if (missing.length > 0) {
    lines.push(`另有 ${missing.length} 个名称找不到，会被跳过：${missing.slice(0, 3).join("、")}`);
  }
  return lines.join("\n");
}

/** 走一轮工具调用：判断能不能做、要不要问；能做的直接做掉 */
export function runCanvasToolCall(
  call: ParsedCanvasToolCall,
  level: CanvasAgentAccessLevel,
): AgentToolCallRecord {
  const definition = resolveDefinition(call);
  if (!definition) return buildRecord(call, { message: `未知的画布工具：${call.tool}` });

  const permission = definition.permission as CanvasAgentPermission;
  if (!isCanvasToolAllowed(level, permission)) {
    return buildRecord(call, {
      message: `当前画布权限是「${CANVAS_ACCESS_LABELS[level]}」，不允许该操作。`,
    });
  }

  if (requiresUserConfirmation(permission)) {
    // 会花钱的操作在卡片上先报价 —— 一次跑 12 张图时，没有总价等于让用户盲签。
    const quote = describePendingGenerationQuote(call);
    return buildRecord(call, {
      pending: true,
      message: quote ?? "需要你确认后才会执行。",
    });
  }

  const result = lenTalkCanvasPlugin.execute(
    { tool: call.tool as CanvasAgentToolName, arguments: call.arguments },
    { confirmed: false },
  );

  let message = result.message;
  if (result.ok && call.tool === "canvas.get_snapshot") {
    // 「已读取当前画布」这句本身不含任何信息，必须把内容真的回给模型。
    // 优先用工具返回的快照；没有则现取一份（等价，只是后者多一次读取）。
    const data = (result.data as CanvasAgentSnapshot | undefined) ?? getCanvasAgentSnapshot();
    message = formatCanvasSnapshotForPrompt(data);
  }
  if (result.ok && call.tool === "canvas.get_selected_nodes" && Array.isArray(result.data)) {
    const names = result.data
      .map((node) => (node as { title?: string }).title)
      .filter((title): title is string => Boolean(title));
    message = names.length ? `选中的节点：${names.join("、")}` : "当前没有选中任何节点。";
  }

  return buildRecord(call, { ok: result.ok, message, data: result.data });
}

/**
 * 用户在卡片上点了「执行」之后，真正把这个待确认的工具跑掉。
 *
 * 与 `runCanvasToolCall` 分开是有意的：那条路只决定「要不要问」，
 * 这条只在拿到肯定答复后执行，并且必须把 `confirmed` 透传给 plugin ——
 * 否则 plugin 自己那层闸门又会拦下来，按钮点了等于没点。
 */
export function confirmAndRunCanvasToolCall(
  call: ParsedCanvasToolCall,
  level: CanvasAgentAccessLevel,
): AgentToolCallRecord {
  const definition = resolveDefinition(call);
  if (!definition) return buildRecord(call, { message: `未知的画布工具：${call.tool}` });

  const permission = definition.permission as CanvasAgentPermission;
  if (!isCanvasToolAllowed(level, permission)) {
    return buildRecord(call, {
      message: `当前画布权限是「${CANVAS_ACCESS_LABELS[level]}」，不允许该操作。`,
    });
  }

  const result = lenTalkCanvasPlugin.execute(
    { tool: call.tool as CanvasAgentToolName, arguments: call.arguments },
    { confirmed: true },
  );

  return buildRecord(call, { ok: result.ok, message: result.message, data: result.data });
}
