/**
 * Agent 聊天的消息与会话类型。
 *
 * 这里只放"数据形状"，不放任何请求逻辑——传输在 llmClient.ts，
 * 状态在 agentStore.ts，渲染在 AgentPanel.tsx。
 */

export type AgentRole = "system" | "user" | "assistant";

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
}

/** 会话使用的模型选择（指向 LenTalk「设置 → 自定义平台」里已配置的 Chat 模型） */
export interface AgentModelSelection {
  providerId: string;
  model: string;
}

export interface AgentSession {
  id: string;
  title: string;
  /** 归属项目；null 表示不属于任何项目。按此字段隔离，切换项目时历史不串 */
  projectId: string | null;
  messages: AgentMessage[];
  selection: AgentModelSelection | null;
  createdAt: number;
  updatedAt: number;
}

/** 送入模型的最小消息形状（剥掉 id / pending / error 等纯 UI 字段） */
export interface AgentChatTurn {
  role: AgentRole;
  content: string;
}
