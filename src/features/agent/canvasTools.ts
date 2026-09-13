import { z } from "zod";
import { CANVAS_NODE_TYPES, type CanvasNodeType } from "@/features/canvas/domain/canvasNodes";

export type CanvasAgentPermission = "read" | "write" | "destructive" | "paid-operation";

export interface CanvasAgentToolDefinition<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  permission: CanvasAgentPermission;
  requiresConfirmation?: boolean;
  schema: TSchema;
}

const nodeTypes = Object.values(CANVAS_NODE_TYPES) as [string, ...string[]];
const nodeTypeSchema = z.enum(nodeTypes as [CanvasNodeType, ...CanvasNodeType[]]);

export const canvasAgentTools = {
  getSnapshot: {
    name: "canvas.get_snapshot",
    description: "读取当前画布的节点、连线、选中状态和视口。",
    permission: "read",
    schema: z.object({}),
  },
  getSelectedNodes: {
    name: "canvas.get_selected_nodes",
    description: "读取当前选中的节点摘要。",
    permission: "read",
    schema: z.object({}),
  },
  createNode: {
    name: "canvas.create_node",
    description: "在画布指定位置创建一个节点。",
    permission: "write",
    schema: z.object({
      type: nodeTypeSchema,
      position: z.object({ x: z.number(), y: z.number() }),
      data: z.record(z.string(), z.unknown()).optional(),
    }),
  },
  updateNode: {
    name: "canvas.update_node",
    description: "更新节点参数，不改变节点类型或连线。",
    permission: "write",
    schema: z.object({ nodeId: z.string().min(1), data: z.record(z.string(), z.unknown()) }),
  },
  moveNode: {
    name: "canvas.move_node",
    description: "移动节点位置。",
    permission: "write",
    schema: z.object({ nodeId: z.string().min(1), position: z.object({ x: z.number(), y: z.number() }) }),
  },
  connectNodes: {
    name: "canvas.connect_nodes",
    description: "连接两个节点；可指定 source/target handle。",
    permission: "write",
    schema: z.object({
      sourceNodeId: z.string().min(1),
      targetNodeId: z.string().min(1),
      sourceHandle: z.string().optional(),
      targetHandle: z.string().optional(),
    }),
  },
  deleteNode: {
    name: "canvas.delete_node",
    description: "删除节点及其相关连线。",
    permission: "destructive",
    requiresConfirmation: true,
    schema: z.object({ nodeId: z.string().min(1) }),
  },
  undo: {
    name: "canvas.undo",
    description: "撤销最近一次画布变更。",
    permission: "write",
    schema: z.object({}),
  },
  redo: {
    name: "canvas.redo",
    description: "重做最近一次已撤销的画布变更。",
    permission: "write",
    schema: z.object({}),
  },
  autoLayout: {
    name: "canvas.auto_layout",
    description: "根据连线拓扑自动排列画布节点。",
    permission: "write",
    schema: z.object({}),
  },
} as const satisfies Record<string, CanvasAgentToolDefinition>;

export type CanvasAgentToolName = typeof canvasAgentTools[keyof typeof canvasAgentTools]["name"];
