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
/**
 * 节点引用一律用**名称**（见 `buildCanvasNodeRefNames`），不用 id：
 * uuid 让模型逐字抄会出错，也让用户在卡片上看不懂它指的是哪个节点。
 */
const nodeNameSchema = z.string().min(1);

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
  focusNode: {
    name: "canvas.focus_node",
    description:
      "把画布镜头移动到指定节点（只移动视野，不改任何数据）。用户说「找不到节点」「跑哪去了」时用它，别只报坐标。",
    permission: "read",
    schema: z.object({
      nodeNames: z.array(nodeNameSchema).min(1).max(40),
    }),
  },
  createNode: {
    name: "canvas.create_node",
    description:
      "创建一个节点。位置不用你算 —— 新节点会自动接在画布上最后一个节点的右侧，并与它顶边对齐。",
    permission: "write",
    schema: z.object({
      type: nodeTypeSchema,
      data: z.record(z.string(), z.unknown()).optional(),
    }),
  },
  createNodes: {
    name: "canvas.create_nodes",
    description:
      "一次创建多个节点（整批只占一个撤销步）。批量落锚点、批量加参考图时用它，别重复调 create_node。位置不用你算 —— 整批从画布最后一个节点右侧接着排，与它顶边对齐，每行 4 个。",
    permission: "write",
    schema: z.object({
      nodes: z
        .array(
          z.object({
            type: nodeTypeSchema,
            data: z.record(z.string(), z.unknown()).optional(),
          }),
        )
        .min(1)
        .max(40),
    }),
  },
  updateNode: {
    name: "canvas.update_node",
    description: "更新节点参数（提示词、模型、比例、分辨率等），不改变节点类型或连线。",
    permission: "write",
    schema: z.object({
      nodeName: nodeNameSchema,
      data: z.record(z.string(), z.unknown()),
    }),
  },
  moveNode: {
    name: "canvas.move_node",
    description: "移动节点位置。",
    permission: "write",
    schema: z.object({
      nodeName: nodeNameSchema,
      position: z.object({ x: z.number(), y: z.number() }),
    }),
  },
  resizeNode: {
    name: "canvas.resize_node",
    description: "调整节点在画布上的显示尺寸（像素，只影响画布排版，不影响出图分辨率）。",
    permission: "write",
    schema: z.object({
      nodeName: nodeNameSchema,
      width: z.number().positive(),
      height: z.number().positive(),
    }),
  },
  connectNodes: {
    name: "canvas.connect_nodes",
    description: "连接两个节点；可指定 source/target handle。",
    permission: "write",
    schema: z.object({
      sourceName: nodeNameSchema,
      targetName: nodeNameSchema,
      sourceHandle: z.string().optional(),
      targetHandle: z.string().optional(),
    }),
  },
  deleteNode: {
    name: "canvas.delete_node",
    description: "删除节点及其相关连线。",
    permission: "destructive",
    requiresConfirmation: true,
    schema: z.object({ nodeName: nodeNameSchema }),
  },
  runNode: {
    name: "canvas.run_node",
    description:
      "触发某个节点开始生成（会真正调用模型并产生费用）。需要用户确认后才会执行。",
    permission: "paid-operation",
    requiresConfirmation: true,
    schema: z.object({ nodeName: nodeNameSchema }),
  },
  runNodes: {
    name: "canvas.run_nodes",
    description:
      "一次触发多个节点开始生成（会真正调用模型并产生费用，卡片上会先给出这批的预计花费）。需要用户确认后才会执行。",
    permission: "paid-operation",
    requiresConfirmation: true,
    schema: z.object({
      nodeNames: z.array(nodeNameSchema).min(1).max(40),
    }),
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
