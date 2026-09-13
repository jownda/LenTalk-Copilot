import { useCanvasStore } from "@/stores/canvasStore";
import { getCanvasAgentSnapshot, getCanvasNode } from "./canvasContext";
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

export function executeCanvasAgentCommand(command: CanvasAgentCommand): CanvasAgentToolResult {
  const definition = Object.values(canvasAgentTools).find((tool) => tool.name === command.tool);
  if (!definition) return failure(`未知画布工具：${command.tool}`);
  const parsed = definition.schema.safeParse(command.arguments ?? {});
  if (!parsed.success) return failure(`工具参数无效：${parsed.error.issues.map((issue) => issue.message).join("；")}`);
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
      const nodeId = store.addNode(type, input.position as Parameters<typeof store.addNode>[1], input.data as Parameters<typeof store.addNode>[2]);
      return result(`已创建节点 ${nodeId}。`, { nodeId });
    }
    case "canvas.update_node": {
      const nodeId = input.nodeId as string;
      if (!getCanvasNode(nodeId, store)) return failure(`找不到节点：${nodeId}`);
      store.updateNodeData(nodeId, input.data as Parameters<typeof store.updateNodeData>[1]);
      return result(`已更新节点 ${nodeId}。`, { nodeId });
    }
    case "canvas.move_node": {
      const nodeId = input.nodeId as string;
      if (!getCanvasNode(nodeId, store)) return failure(`找不到节点：${nodeId}`);
      store.updateNodePosition(nodeId, input.position as { x: number; y: number });
      return result(`已移动节点 ${nodeId}。`, { nodeId });
    }
    case "canvas.connect_nodes": {
      const source = input.sourceNodeId as string;
      const target = input.targetNodeId as string;
      if (!getCanvasNode(source, store) || !getCanvasNode(target, store)) return failure("源节点或目标节点不存在。");
      const edgeId = store.addEdge(source, target, input.sourceHandle as string | undefined, input.targetHandle as string | undefined);
      return edgeId ? result("已建立节点连接。", { edgeId, source, target, sourceHandle: input.sourceHandle, targetHandle: input.targetHandle }) : failure("连接未建立，可能已存在或节点不支持连接。");
    }
    case "canvas.delete_node": {
      const nodeId = input.nodeId as string;
      if (!getCanvasNode(nodeId, store)) return failure(`找不到节点：${nodeId}`);
      store.deleteNode(nodeId);
      return result(`已删除节点 ${nodeId}。`, { nodeId });
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
