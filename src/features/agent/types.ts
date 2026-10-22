/**
 * Agent 聊天的消息与会话类型。
 *
 * 这里只放"数据形状"，不放任何请求逻辑——传输在 llmClient.ts，
 * 状态在 agentStore.ts，渲染在 AgentPanel.tsx。
 */

export type AgentRole = "system" | "user" | "assistant";

/** 一次画布工具调用的落档记录，挂在 assistant 消息上供 UI 展示 */
export interface AgentToolCallRecord {
  /** 工具全名，如 canvas.create_node */
  tool: string;
  /** 中文短标签，如「创建节点」 */
  label: string;
  /** 模型给出的原始参数（节点用名称引用，不做 id 回译） */
  arguments: Record<string, unknown>;
  ok: boolean;
  /** 结果说明；待确认时是「需要你确认后才会执行」这类提示 */
  message: string;
  /** 等待用户确认（会花钱或具破坏性的操作）。确认后由 UI 改写该记录 */
  pending?: boolean;
  /** 用户主动跳过 */
  skipped?: boolean;
  /** 工具返回的原始数据（含 nodeId 等），供 UI 关联后续结果 */
  data?: unknown;
  /**
   * 生成完成后回填的媒体地址。
   * ⚠️ **只存引用，不复制文件** —— 复制一份会平白多占一份磁盘，
   * 而这些素材本来就在画布上，直接指向原地址即可。
   */
  mediaUrl?: string;
}

export interface AgentMessage {
  id: string;
  role: AgentRole;
  content: string;
  createdAt: number;
  /** 正在流式生成中：UI 显示光标，且**不写盘**（避免每个 token 触发一次持久化） */
  pending?: boolean;
  /** 生成失败时的原因；content 里保留已经收到的部分文本 */
  error?: string;
  /** 该轮实际使用的模型，便于回看是哪次调用产生的 */
  modelLabel?: string;
  /** 本轮 AI 对画布做过的操作（按执行顺序）。旧数据没有该字段，读取时按空数组处理 */
  toolCalls?: AgentToolCallRecord[];
}

/** 会话使用的模型选择（指向 LenTalk「设置 → 自定义平台」里已配置的 Chat 模型） */
export interface AgentModelSelection {
  providerId: string;
  model: string;
}

/**
 * AI 对画布的权限档位。
 * - `read-only`：只能读，改画布的要求会被拒绝并如实告知用户
 * - `edit`：可读可编辑（含创建 / 连线），**删除仍需更高档位**
 * - `full`：全量，含删除
 *
 * 定义在这里（而非 `canvasToolProtocol.ts`）是有意的：agentStore 也要用它，
 * 而 protocol 会 import canvasStore，让 store 反向依赖整条画布链路会绕成环。
 */
export type CanvasAgentAccessLevel = "read-only" | "edit" | "full";

export const DEFAULT_CANVAS_ACCESS_LEVEL: CanvasAgentAccessLevel = "edit";

export const CANVAS_ACCESS_LABELS: Record<CanvasAgentAccessLevel, string> = {
  "read-only": "只看画布",
  edit: "可编辑画布",
  full: "可编辑与删除",
};

export const CANVAS_ACCESS_HINTS: Record<CanvasAgentAccessLevel, string> = {
  "read-only": "AI 只能读取画布内容；任何修改请求都会被告知没有权限。",
  edit: "AI 可以读取节点、创建节点、改参数、移动与连线；删除动作会被拒绝。",
  full: "AI 还可以删除节点。删除走画布历史，可用撤销回退。",
};

export function isCanvasAgentAccessLevel(value: unknown): value is CanvasAgentAccessLevel {
  return value === "read-only" || value === "edit" || value === "full";
}

/**
 * 一段会话早期的压缩备忘。
 *
 * 为什么要落盘：压缩是一次真实的模型请求，不能每轮都重做。
 * `throughMessageId` / `throughCreatedAt` 是「已经吸收到哪一条」的水位线 ——
 * 两者都存是因为消息有 200 条上限，水位线那条可能已被从头裁掉，届时只能按时间兜底。
 */
export interface AgentContextSummary {
  /** 备忘正文（模型产出的结构化中文） */
  text: string;
  /** 已吸收的最后一条消息 id；被裁掉时退化为 null */
  throughMessageId: string | null;
  /** 已吸收的最后一条消息的时间戳，用于 id 失效时的兜底定位 */
  throughCreatedAt: number;
  /** 累计被吸收的消息条数，用于 UI 展示 */
  messageCount: number;
  createdAt: number;
  /** 备忘自身的估算 token，用于 UI 展示压缩效果 */
  tokens: number;
}

export interface AgentSession {
  id: string;
  title: string;
  /** 归属项目；null 表示不属于任何项目。按此字段隔离，切换项目时历史不串 */
  projectId: string | null;
  messages: AgentMessage[];
  selection: AgentModelSelection | null;
  /**
   * 本会话已加载的 SKILL id；null = 未加载。
   * 按会话隔离而不是全局：同一个模型上并跑「仙宫场景」和「不加载 SKILL」两条线时互不污染。
   */
  skillId: string | null;
  createdAt: number;
  updatedAt: number;
  /**
   * 早期对话的压缩备忘；null / 缺失表示整个会话仍按原文发送。
   * 由 `contextCompression.prepareHistory` 在历史超预算时生成。
   */
  contextSummary?: AgentContextSummary | null;
}

/** 送入模型的最小消息形状（剥掉 id / pending / error 等纯 UI 字段） */
export interface AgentChatTurn {
  role: AgentRole;
  content: string;
}
