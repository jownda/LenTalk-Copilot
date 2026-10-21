/**
 * Agent 会话状态（会话 / 消息 / 流式标记）。
 *
 * 两条刻意的设计约束：
 * 1. **持久化逻辑是纯函数**（`serializeAgentState` / `parseAgentState`），
 *    存储介质通过 `AgentStorage` 接口注入 —— 才能在 node 环境的 vitest 里直接测，
 *    不必拉起 jsdom 或 mock 掉全局 localStorage。
 * 2. **流式过程中的增量不写盘**。一轮回答有几百个 token，逐个写 localStorage
 *    会造成明显卡顿；`pending` 消息在序列化时被剔除，只有生成完成才落盘。
 */

import { create } from "zustand";

import {
  DEFAULT_CANVAS_ACCESS_LEVEL,
  isCanvasAgentAccessLevel,
  type AgentContextSummary,
  type AgentMessage,
  type AgentModelSelection,
  type AgentSession,
  type CanvasAgentAccessLevel,
} from "./types";

export const AGENT_STORAGE_KEY = "lentalk.agent.sessions.v1";
/** 单个项目的会话上限，防止 localStorage 无限膨胀 */
export const MAX_SESSIONS_PER_PROJECT = 40;
/** 单会话消息上限；超出时从头裁剪（保留最近的内容） */
export const MAX_MESSAGES_PER_SESSION = 200;
const MAX_TITLE_LENGTH = 24;
/** 用同一个桶装"不属于任何项目"的会话 */
export const GLOBAL_PROJECT_KEY = "__global__";

export interface AgentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PersistedAgentState {
  sessions: AgentSession[];
  activeSessionId: string | null;
  selection: AgentModelSelection | null;
  /**
   * 尚未绑定到任何会话时使用的 SKILL（"待用值"）。
   *
   * 与 `selection` 对称：没有活动会话时用户也能先选好 SKILL，
   * 之后新建的会话会继承它 —— 否则"还没开始聊就加载 SKILL"会静默失效。
   */
  skillId: string | null;
  /**
   * AI 对画布的权限档位（全局，不按会话）。
   * 权限是安全开关，不该因为换了个会话就悄悄放宽，所以只存一份。
   */
  canvasAccess: CanvasAgentAccessLevel;
}

export interface AgentStreamingState {
  sessionId: string;
  messageId: string;
}

export interface AgentState {
  hydrated: boolean;
  sessions: AgentSession[];
  activeSessionId: string | null;
  selection: AgentModelSelection | null;
  /** 没有活动会话时选定的 SKILL；有活动会话时以会话上的 `skillId` 为准 */
  skillId: string | null;
  /** AI 对画布的权限档位（全局） */
  canvasAccess: CanvasAgentAccessLevel;
  /** 当前正在流式生成的那条消息；null 表示空闲 */
  streaming: AgentStreamingState | null;

  hydrate: () => void;
  createSession: (projectId: string | null, selection?: AgentModelSelection | null) => string;
  deleteSession: (sessionId: string) => void;
  renameSession: (sessionId: string, title: string) => void;
  setActiveSession: (sessionId: string | null) => void;
  setSelection: (selection: AgentModelSelection | null) => void;
  /** 加载 / 切换 / 卸载当前会话的 SKILL（传 null 即卸载） */
  setSkill: (skillId: string | null) => void;
  /** 设置 AI 对画布的权限档位（全局，立即落盘） */
  setCanvasAccess: (level: CanvasAgentAccessLevel) => void;

  appendMessage: (sessionId: string, message: AgentMessage) => void;
  patchMessage: (
    sessionId: string,
    messageId: string,
    patch: Partial<AgentMessage>,
    options?: { persist?: boolean },
  ) => void;
  removeMessage: (sessionId: string, messageId: string) => void;
  /**
   * 写入 / 清除会话的早期对话备忘。
   * 传 null 表示撤销压缩 —— 下一轮发送会按原文重新判断要不要压。
   */
  setContextSummary: (sessionId: string, summary: AgentContextSummary | null) => void;

  beginStreaming: (sessionId: string, messageId: string) => void;
  endStreaming: () => void;

  clearProjectSessions: (projectId: string | null) => void;
}

// ---------------------------------------------------------------------------
// 纯函数区（可单测）
// ---------------------------------------------------------------------------

/** 由首条用户消息派生会话标题 */
export function deriveSessionTitle(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "新对话";
  return normalized.length > MAX_TITLE_LENGTH
    ? `${normalized.slice(0, MAX_TITLE_LENGTH)}…`
    : normalized;
}

/** 裁剪会话消息数量，保留最近的部分 */
export function trimMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.length > MAX_MESSAGES_PER_SESSION
    ? messages.slice(messages.length - MAX_MESSAGES_PER_SESSION)
    : messages;
}

/**
 * 序列化：剔除仍在流式中的消息。
 * 半截内容写进磁盘，下次启动会以"完整消息"的身份出现，反而误导用户。
 */
export function serializeAgentState(state: PersistedAgentState): string {
  const sessions = state.sessions.map((session) => ({
    ...session,
    messages: session.messages.filter((message) => !message.pending),
  }));
  return JSON.stringify({
    version: 1,
    sessions,
    activeSessionId: state.activeSessionId,
    selection: state.selection,
    skillId: state.skillId ?? null,
    canvasAccess: state.canvasAccess ?? DEFAULT_CANVAS_ACCESS_LEVEL,
  } satisfies PersistedAgentState & { version: number });
}

/**
 * 校验磁盘上的压缩备忘。字段缺一个就不能用 —— 水位线错位会让模型重复收到
 * 已经压缩过的旧消息，比没有备忘更糟。
 */
export function parseContextSummary(value: unknown): AgentContextSummary | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<AgentContextSummary>;
  if (typeof raw.text !== "string" || !raw.text.trim()) return null;
  const throughCreatedAt =
    typeof raw.throughCreatedAt === "number" && Number.isFinite(raw.throughCreatedAt)
      ? raw.throughCreatedAt
      : 0;
  const throughMessageId = typeof raw.throughMessageId === "string" ? raw.throughMessageId : null;
  // 两个水位线都没有 ⇒ 无法判断覆盖范围，只能丢弃
  if (!throughMessageId && throughCreatedAt <= 0) return null;
  return {
    text: raw.text,
    throughMessageId,
    throughCreatedAt,
    messageCount:
      typeof raw.messageCount === "number" && Number.isFinite(raw.messageCount)
        ? raw.messageCount
        : 0,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
    tokens: typeof raw.tokens === "number" && Number.isFinite(raw.tokens) ? raw.tokens : 0,
  };
}

/** 反序列化：对磁盘上的历史数据做防御性校验，任何一条坏记录都不该拖垮整个 store */
export function parseAgentState(raw: string | null): PersistedAgentState | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Partial<PersistedAgentState>;
    if (!data || typeof data !== "object" || !Array.isArray(data.sessions)) return null;
    const sessions: AgentSession[] = data.sessions
      .filter((session): session is AgentSession => Boolean(session) && typeof session.id === "string")
      .map((session) => ({
        ...session,
        title: typeof session.title === "string" && session.title ? session.title : "新对话",
        projectId: typeof session.projectId === "string" ? session.projectId : null,
        createdAt: typeof session.createdAt === "number" ? session.createdAt : Date.now(),
        updatedAt: typeof session.updatedAt === "number" ? session.updatedAt : Date.now(),
        selection: session.selection ?? null,
        // 旧版本落盘的数据没有这个字段，必须兜底成 null，否则会话打开就崩
        skillId: typeof session.skillId === "string" ? session.skillId : null,
        contextSummary: parseContextSummary(session.contextSummary),
        messages: Array.isArray(session.messages)
          ? session.messages
              .filter(
                (message) =>
                  Boolean(message) &&
                  typeof message.id === "string" &&
                  typeof message.content === "string",
              )
              .map((message) => ({ ...message, pending: false }))
          : [],
      }));
    return {
      sessions,
      activeSessionId:
        typeof data.activeSessionId === "string" ? data.activeSessionId : null,
      selection: data.selection ?? null,
      // 旧数据没有这个字段，兜底成 null
      skillId: typeof data.skillId === "string" ? data.skillId : null,
      // 同理；取值还要防脏（历史数据里可能被写成任意字符串）
      canvasAccess: isCanvasAgentAccessLevel(data.canvasAccess)
        ? data.canvasAccess
        : DEFAULT_CANVAS_ACCESS_LEVEL,
    };
  } catch {
    return null;
  }
}

/** 按项目过滤会话，最近更新的排在前面 */
export function selectSessionsForProject(
  sessions: AgentSession[],
  projectId: string | null,
): AgentSession[] {
  const key = projectId ?? GLOBAL_PROJECT_KEY;
  return sessions
    .filter((session) => (session.projectId ?? GLOBAL_PROJECT_KEY) === key)
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function createMemoryStorage(): AgentStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

/** 优先用 localStorage；隐私模式或被禁用时退回内存（功能不中断，只是不持久化） */
export function resolveAgentStorage(): AgentStorage {
  try {
    if (typeof localStorage !== "undefined") {
      const probe = "__agent_storage_probe__";
      localStorage.setItem(probe, "1");
      localStorage.removeItem(probe);
      return localStorage;
    }
  } catch {
    // 忽略：走内存兜底
  }
  return createMemoryStorage();
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

const storage = resolveAgentStorage();

/**
 * 落盘。调用点只需传**本次真正改动的字段**，其余从当前 store 现取。
 *
 * 早先每个调用点都逐字重复 `selection` / `skillId`（十处），加一个顶层字段就要
 * 回头改十遍，漏一处就变成「某个操作之后设置莫名丢失」这种极难复现的 bug。
 * ⚠️ 补齐必须走 `getState()`：`set()` 回调里的 `state` 是**旧值**，
 * 显式传入的字段优先级最高，所以本次改动的字段仍要老老实实传进来。
 */
function persist(patch: Partial<PersistedAgentState> = {}): void {
  const state = useAgentStore.getState();
  const snapshot: PersistedAgentState = {
    sessions: patch.sessions ?? state.sessions,
    activeSessionId:
      patch.activeSessionId !== undefined ? patch.activeSessionId : state.activeSessionId,
    selection: patch.selection !== undefined ? patch.selection : state.selection,
    skillId: patch.skillId !== undefined ? patch.skillId : state.skillId,
    canvasAccess: patch.canvasAccess !== undefined ? patch.canvasAccess : state.canvasAccess,
  };
  try {
    storage.setItem(AGENT_STORAGE_KEY, serializeAgentState(snapshot));
  } catch {
    // 配额溢出等异常不阻断对话
  }
}

export const useAgentStore = create<AgentState>((set, get) => ({
  hydrated: false,
  sessions: [],
  activeSessionId: null,
  selection: null,
  skillId: null,
  canvasAccess: DEFAULT_CANVAS_ACCESS_LEVEL,
  streaming: null,

  hydrate: () => {
    if (get().hydrated) return;
    const parsed = parseAgentState(storage.getItem(AGENT_STORAGE_KEY));
    set({
      hydrated: true,
      sessions: parsed?.sessions ?? [],
      activeSessionId: parsed?.activeSessionId ?? null,
      selection: get().selection ?? parsed?.selection ?? null,
      skillId: get().skillId ?? parsed?.skillId ?? null,
      canvasAccess: parsed?.canvasAccess ?? DEFAULT_CANVAS_ACCESS_LEVEL,
    });
  },

  createSession: (projectId, selection) => {
    const now = Date.now();
    const session: AgentSession = {
      id: crypto.randomUUID(),
      title: "新对话",
      projectId: projectId ?? null,
      messages: [],
      selection: selection ?? get().selection,
      // 继承当前选定的 SKILL —— 与 `selection` 一致。
      // 若继承为 null，"还没建会话就加载 SKILL" 会在发送第一条消息时静默丢掉。
      skillId: get().skillId,
      createdAt: now,
      updatedAt: now,
    };
    set((state) => {
      const key = session.projectId ?? GLOBAL_PROJECT_KEY;
      // 只对同一项目做数量限制，避免把别的项目的会话挤掉
      const siblings = state.sessions.filter(
        (item) => (item.projectId ?? GLOBAL_PROJECT_KEY) === key,
      );
      const overflow = new Set(
        siblings
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(MAX_SESSIONS_PER_PROJECT - 1)
          .map((item) => item.id),
      );
      const sessions = [session, ...state.sessions.filter((item) => !overflow.has(item.id))];
      persist({ sessions, activeSessionId: session.id });
      return { sessions, activeSessionId: session.id };
    });
    return session.id;
  },

  deleteSession: (sessionId) => {
    set((state) => {
      const sessions = state.sessions.filter((session) => session.id !== sessionId);
      const activeSessionId =
        state.activeSessionId === sessionId
          ? (sessions[0]?.id ?? null)
          : state.activeSessionId;
      persist({ sessions, activeSessionId });
      return {
        sessions,
        activeSessionId,
        streaming: state.streaming?.sessionId === sessionId ? null : state.streaming,
      };
    });
  },

  renameSession: (sessionId, title) => {
    set((state) => {
      const sessions = state.sessions.map((session) =>
        session.id === sessionId
          ? { ...session, title: title.trim() || session.title, updatedAt: Date.now() }
          : session,
      );
      persist({ sessions });
      return { sessions };
    });
  },

  setActiveSession: (sessionId) => {
    set({ activeSessionId: sessionId });
    // set 之后再落盘：persist 内部从 getState() 补齐其余字段，拿到的才是新值
    persist({ activeSessionId: sessionId });
  },

  setSelection: (selection) => {
    set((state) => {
      const sessions = state.sessions.map((session) =>
        session.id === state.activeSessionId ? { ...session, selection } : session,
      );
      persist({ sessions, selection });
      return { selection, sessions };
    });
  },

  setSkill: (skillId) => {
    set((state) => {
      // 顶层 `skillId` 始终要更新：**没有活动会话时也有落脚点**。
      // 早先这里 `if (!state.activeSessionId) return {}` 直接空转，
      // 导致"新项目里点加载 SKILL"毫无反应（按钮文案不变、也没加载上）。
      const sessions = state.activeSessionId
        ? state.sessions.map((session) =>
            session.id === state.activeSessionId ? { ...session, skillId } : session,
          )
        : state.sessions;
      persist({ sessions, skillId });
      return { sessions, skillId };
    });
  },

  setCanvasAccess: (canvasAccess) => {
    set({ canvasAccess });
    persist({ canvasAccess });
  },

  appendMessage: (sessionId, message) => {
    set((state) => {
      const sessions = state.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              messages: trimMessages([...session.messages, message]),
              title:
                session.messages.length === 0 && message.role === "user"
                  ? deriveSessionTitle(message.content)
                  : session.title,
              updatedAt: Date.now(),
            }
          : session,
      );
      persist({ sessions });
      return { sessions };
    });
  },

  patchMessage: (sessionId, messageId, patch, options) => {
    set((state) => {
      const sessions = state.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              updatedAt: Date.now(),
              messages: session.messages.map((message) =>
                message.id === messageId ? { ...message, ...patch } : message,
              ),
            }
          : session,
      );
      if (options?.persist !== false) {
        persist({ sessions });
      }
      return { sessions };
    });
  },

  removeMessage: (sessionId, messageId) => {
    set((state) => {
      const sessions = state.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              messages: session.messages.filter((message) => message.id !== messageId),
              updatedAt: Date.now(),
            }
          : session,
      );
      persist({ sessions });
      return { sessions };
    });
  },

  beginStreaming: (sessionId, messageId) => set({ streaming: { sessionId, messageId } }),
  endStreaming: () => set({ streaming: null }),

  setContextSummary: (sessionId, summary) => {
    set((state) => {
      const sessions = state.sessions.map((session) =>
        session.id === sessionId ? { ...session, contextSummary: summary } : session,
      );
      persist({ sessions });
      return { sessions };
    });
  },

  clearProjectSessions: (projectId) => {
    set((state) => {
      const key = projectId ?? GLOBAL_PROJECT_KEY;
      const sessions = state.sessions.filter(
        (session) => (session.projectId ?? GLOBAL_PROJECT_KEY) !== key,
      );
      const activeSessionId = sessions.some((session) => session.id === state.activeSessionId)
        ? state.activeSessionId
        : null;
      persist({ sessions, activeSessionId });
      return { sessions, activeSessionId, streaming: null };
    });
  },
}));
