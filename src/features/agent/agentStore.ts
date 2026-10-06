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

import type { AgentMessage, AgentModelSelection, AgentSession } from "./types";

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
  /** 当前正在流式生成的那条消息；null 表示空闲 */
  streaming: AgentStreamingState | null;

  hydrate: () => void;
  createSession: (projectId: string | null, selection?: AgentModelSelection | null) => string;
  deleteSession: (sessionId: string) => void;
  renameSession: (sessionId: string, title: string) => void;
  setActiveSession: (sessionId: string | null) => void;
  setSelection: (selection: AgentModelSelection | null) => void;

  appendMessage: (sessionId: string, message: AgentMessage) => void;
  patchMessage: (
    sessionId: string,
    messageId: string,
    patch: Partial<AgentMessage>,
    options?: { persist?: boolean },
  ) => void;
  removeMessage: (sessionId: string, messageId: string) => void;

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
  } satisfies PersistedAgentState & { version: number });
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

function persist(state: PersistedAgentState): void {
  try {
    storage.setItem(AGENT_STORAGE_KEY, serializeAgentState(state));
  } catch {
    // 配额溢出等异常不阻断对话
  }
}

export const useAgentStore = create<AgentState>((set, get) => ({
  hydrated: false,
  sessions: [],
  activeSessionId: null,
  selection: null,
  streaming: null,

  hydrate: () => {
    if (get().hydrated) return;
    const parsed = parseAgentState(storage.getItem(AGENT_STORAGE_KEY));
    set({
      hydrated: true,
      sessions: parsed?.sessions ?? [],
      activeSessionId: parsed?.activeSessionId ?? null,
      selection: get().selection ?? parsed?.selection ?? null,
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
      persist({ sessions, activeSessionId: session.id, selection: state.selection });
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
      persist({ sessions, activeSessionId, selection: state.selection });
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
      persist({ sessions, activeSessionId: state.activeSessionId, selection: state.selection });
      return { sessions };
    });
  },

  setActiveSession: (sessionId) => {
    set((state) => {
      persist({ sessions: state.sessions, activeSessionId: sessionId, selection: state.selection });
      return { activeSessionId: sessionId };
    });
  },

  setSelection: (selection) => {
    set((state) => {
      const sessions = state.sessions.map((session) =>
        session.id === state.activeSessionId ? { ...session, selection } : session,
      );
      persist({ sessions, activeSessionId: state.activeSessionId, selection });
      return { selection, sessions };
    });
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
      persist({ sessions, activeSessionId: state.activeSessionId, selection: state.selection });
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
        persist({ sessions, activeSessionId: state.activeSessionId, selection: state.selection });
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
      persist({ sessions, activeSessionId: state.activeSessionId, selection: state.selection });
      return { sessions };
    });
  },

  beginStreaming: (sessionId, messageId) => set({ streaming: { sessionId, messageId } }),
  endStreaming: () => set({ streaming: null }),

  clearProjectSessions: (projectId) => {
    set((state) => {
      const key = projectId ?? GLOBAL_PROJECT_KEY;
      const sessions = state.sessions.filter(
        (session) => (session.projectId ?? GLOBAL_PROJECT_KEY) !== key,
      );
      const activeSessionId = sessions.some((session) => session.id === state.activeSessionId)
        ? state.activeSessionId
        : null;
      persist({ sessions, activeSessionId, selection: state.selection });
      return { sessions, activeSessionId, streaming: null };
    });
  },
}));
