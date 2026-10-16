import { getNodeGenerationHandler } from "@/features/canvas/application/nodeGenerationRegistry";
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
