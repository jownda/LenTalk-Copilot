import { getNodeGenerationHandler } from "@/features/canvas/application/nodeGenerationRegistry";
import type { CanvasNodeType } from "@/features/canvas/domain/canvasNodes";
import { useCanvasStore } from "@/stores/canvasStore";
import {
  buildCanvasNodeRefNames,
  findCanvasNodeByRefName,
  getCanvasAgentSnapshot,
  type CanvasNodeLookup,
} from "./canvasContext";
import { canvasAgentTools, type CanvasAgentToolName } from "./canvasTools";

export interface CanvasAgentToolResult {
  ok: boolean;
  message: string;
  data?: unknown;
}

export interface CanvasAgentCommand {
  tool: CanvasAgentToolName;
  arguments: unknown;
}

function result(message: string, data?: unknown): CanvasAgentToolResult {
  return { ok: true, message, data };
}

function failure(message: string): CanvasAgentToolResult {
  return { ok: false, message };
}

/** 节点引用解析失败时，把原因（含可用名称清单）直接当结果返回 */
function lookupFailure(found: CanvasNodeLookup, refName: string): CanvasAgentToolResult | null {
  if (found.node) return null;
  return failure(found.error ?? `找不到名为「${refName}」的节点。`);
}

/**
 * 批量创建时没给位置的那些节点，统一排在**现有内容的下方**成网格。
 *
 * 为什么不是排在视口中心：那会直接盖住用户已经在看的东西。
 * 排在下方既不会压到已有节点，用户「缩小画布」一下就能看到整批。
 */
function autoBatchPositions(
  nodes: Array<{ position: { x: number; y: number }; measured?: { width?: number; height?: number }; width?: number; height?: number }>,
  count: number,
): Array<{ x: number; y: number }> {
  const GAP = 60;
  const CELL_W = 400;
  const CELL_H = 560;
  const COLS = 4;
  if (count <= 0) return [];

  const baseX = nodes.length ? Math.min(...nodes.map((node) => node.position.x)) : 0;
  const baseY = nodes.length
    ? Math.max(
        ...nodes.map(
          (node) =>
            node.position.y + (node.measured?.height ?? node.height ?? CELL_H),
        ),
      ) + GAP
    : 0;

  return Array.from({ length: count }, (_, index) => ({
    x: baseX + (index % COLS) * (CELL_W + GAP),
    y: baseY + Math.floor(index / COLS) * (CELL_H + GAP),
  }));
}

export function executeCanvasAgentCommand(command: CanvasAgentCommand): CanvasAgentToolResult {
  const definition = Object.values(canvasAgentTools).find((tool) => tool.name === command.tool);
  if (!definition) return failure(`未知画布工具：${command.tool}`);
  const parsed = definition.schema.safeParse(command.arguments ?? {});
  if (!parsed.success) {
    return failure(`工具参数无效：${parsed.error.issues.map((issue) => issue.message).join("；")}`);
  }
  const input = parsed.data as Record<string, unknown>;
  const store = useCanvasStore.getState();

  switch (command.tool) {
    case "canvas.get_snapshot":
      return result("已读取当前画布。", getCanvasAgentSnapshot(store));
    case "canvas.get_selected_nodes": {
      const snapshot = getCanvasAgentSnapshot(store);
      return result("已读取选中节点。", snapshot.nodes.filter((node) => node.selected));
    }
    case "canvas.create_node": {
      const type = input.type as Parameters<typeof store.addNode>[0];
      const nodeId = store.addNode(
        type,
        input.position as Parameters<typeof store.addNode>[1],
        input.data as Parameters<typeof store.addNode>[2],
      );
      // 名称要按**创建后**的画布现算：同名节点的后缀取决于它排第几
      const refName = buildCanvasNodeRefNames(useCanvasStore.getState().nodes).get(nodeId);
      return result(`已创建节点，名称为「${refName ?? nodeId}」。`, { nodeId, nodeName: refName });
    }
    case "canvas.create_nodes": {
      const entries = input.nodes as Array<{
        type: string;
        position?: { x: number; y: number };
        data?: Record<string, unknown>;
      }>;
      const state = useCanvasStore.getState();
      const fallback = autoBatchPositions(state.nodes, entries.length);
      const nodeIds = state.addNodes(
        entries.map((entry, index) => ({
          type: entry.type as CanvasNodeType,
          position: entry.position ?? fallback[index],
          data: entry.data as Record<string, never> | undefined,
        })),
      );
      // 名称同样按**创建后**的画布现算：同名节点带 ` #2` 后缀，取决于它排第几
      const names = buildCanvasNodeRefNames(useCanvasStore.getState().nodes);
      const nodeNames = nodeIds.map((id) => names.get(id) ?? id);
      return result(`已创建 ${nodeIds.length} 个节点：${nodeNames.join("、")}。`, {
        nodeIds,
        nodeNames,
      });
    }
    case "canvas.update_node": {
      const refName = input.nodeName as string;
      const found = findCanvasNodeByRefName(refName, store);
      const failed = lookupFailure(found, refName);
      if (failed) return failed;
      store.updateNodeData(found.node!.id, input.data as Parameters<typeof store.updateNodeData>[1]);
      return result(`已更新「${refName}」的参数。`, { nodeId: found.node!.id });
    }
    case "canvas.move_node": {
      const refName = input.nodeName as string;
      const found = findCanvasNodeByRefName(refName, store);
      const failed = lookupFailure(found, refName);
      if (failed) return failed;
      store.updateNodePosition(found.node!.id, input.position as { x: number; y: number });
      return result(`已移动「${refName}」。`, { nodeId: found.node!.id });
    }
    case "canvas.resize_node": {
      const refName = input.nodeName as string;
      const found = findCanvasNodeByRefName(refName, store);
      const failed = lookupFailure(found, refName);
      if (failed) return failed;
      const width = input.width as number;
      const height = input.height as number;
      store.updateNodeSize(found.node!.id, width, height);
      return result(
        `已把「${refName}」调整为 ${Math.round(width)}x${Math.round(height)}。`,
        { nodeId: found.node!.id },
      );
    }
    case "canvas.connect_nodes": {
      const sourceName = input.sourceName as string;
      const targetName = input.targetName as string;
      const source = findCanvasNodeByRefName(sourceName, store);
      const sourceFailed = lookupFailure(source, sourceName);
      if (sourceFailed) return sourceFailed;
      const target = findCanvasNodeByRefName(targetName, store);
      const targetFailed = lookupFailure(target, targetName);
      if (targetFailed) return targetFailed;
      const edgeId = store.addEdge(
        source.node!.id,
        target.node!.id,
        input.sourceHandle as string | undefined,
        input.targetHandle as string | undefined,
      );
      return edgeId
        ? result(`已把「${sourceName}」连到「${targetName}」。`, {
            edgeId,
            source: source.node!.id,
            target: target.node!.id,
          })
        : failure("连接未建立，可能已存在或节点不支持连接。");
    }
    case "canvas.delete_node": {
      const refName = input.nodeName as string;
      const found = findCanvasNodeByRefName(refName, store);
      const failed = lookupFailure(found, refName);
      if (failed) return failed;
      store.deleteNode(found.node!.id);
      return result(`已删除「${refName}」。`, { nodeId: found.node!.id });
    }
    case "canvas.run_node": {
      const refName = input.nodeName as string;
      const found = findCanvasNodeByRefName(refName, store);
      const failed = lookupFailure(found, refName);
      if (failed) return failed;

      const handler = getNodeGenerationHandler(found.node!.id);
      if (!handler) {
        return failure(
          `「${refName}」当前不在可视区域内 —— 画布只为可见的节点渲染组件。` +
            "请先把它拖到可见范围（或缩小画布）再触发；也可能是该节点类型不支持外部触发生成。",
        );
      }
      // 生成是长任务（几十秒起）：这里只负责点火，不等它跑完。
      // 结果由 AgentPanel 订阅画布变化后回填到卡片上（只记 URL 引用，不复制文件）。
      void handler();
      return result(`已触发「${refName}」开始生成。`, {
        nodeId: found.node!.id,
        nodeName: refName,
      });
    }
    case "canvas.run_nodes": {
      const nodeNames = input.nodeNames as string[];
      const started: string[] = [];
      const startedIds: string[] = [];
      const skipped: Array<{ name: string; reason: string }> = [];

      for (const refName of nodeNames) {
        const found = findCanvasNodeByRefName(refName, store);
        if (!found.node) {
          skipped.push({ name: refName, reason: found.error ?? "找不到该节点" });
          continue;
        }
        const handler = getNodeGenerationHandler(found.node.id);
        if (!handler) {
          skipped.push({ name: refName, reason: "不在可视区域，或该类型不支持外部触发生成" });
          continue;
        }
        // 生成是长任务：只点火，不等它跑完；结果由 AgentPanel 订阅画布回填。
        void handler();
        started.push(refName);
        startedIds.push(found.node.id);
      }

      const parts: string[] = [];
      if (started.length > 0) parts.push(`已触发 ${started.length} 个节点开始生成：${started.join("、")}`);
      if (skipped.length > 0) {
        parts.push(
          `跳过 ${skipped.length} 个：${skipped.map((item) => `${item.name}（${item.reason}）`).join("、")}`,
        );
      }
      const message = parts.join("；") || "没有可触发的节点。";
      // 一个都没跑起来就是失败（否则模型会以为已经开始了）
      return started.length > 0
        ? result(message, { started, skipped, nodeIds: startedIds })
        : failure(message);
    }
    case "canvas.undo":
      return store.undo() ? result("已撤销最近一次画布变更。") : failure("没有可撤销的画布变更。");
    case "canvas.redo":
      return store.redo() ? result("已重做画布变更。") : failure("没有可重做的画布变更。");
    case "canvas.auto_layout":
      return store.autoLayoutCanvas() ? result("已完成画布自动布局。") : result("画布布局无需改变。");
    default:
      return failure(`未实现的画布工具：${command.tool}`);
  }
}
