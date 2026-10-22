import { describe, expect, it } from "vitest";

import {
  AGENT_STORAGE_KEY,
  createMemoryStorage,
  deriveSessionTitle,
  GLOBAL_PROJECT_KEY,
  MAX_MESSAGES_PER_SESSION,
  parseAgentState,
  selectSessionsForProject,
  serializeAgentState,
  trimMessages,
  useAgentStore,
} from "./agentStore";
import type { AgentMessage, AgentSession } from "./types";

function message(partial: Partial<AgentMessage> & { id: string }): AgentMessage {
  return { role: "user", content: "hi", createdAt: 0, ...partial };
}

function session(partial: Partial<AgentSession> & { id: string }): AgentSession {
  return {
    title: "t",
    projectId: null,
    messages: [],
    selection: null,
    skillId: null,
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

describe("deriveSessionTitle", () => {
  it("collapses whitespace and trims", () => {
    expect(deriveSessionTitle("  写一段\n\n关于  星空的文字 ")).toBe("写一段 关于 星空的文字");
  });

  it("returns a placeholder for blank input", () => {
    expect(deriveSessionTitle("   ")).toBe("新对话");
  });

  it("truncates long input with an ellipsis", () => {
    const long = "一".repeat(60);
    const title = deriveSessionTitle(long);
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBe(25); // 24 字 + 省略号
  });
});

describe("trimMessages", () => {
  it("leaves short histories untouched", () => {
    const messages = [message({ id: "1" }), message({ id: "2" })];
    expect(trimMessages(messages)).toHaveLength(2);
  });

  it("keeps the most recent messages when over the cap", () => {
    const messages = Array.from({ length: MAX_MESSAGES_PER_SESSION + 5 }, (_, index) =>
      message({ id: `m${index}`, content: `c${index}` }),
    );
    const trimmed = trimMessages(messages);
    expect(trimmed).toHaveLength(MAX_MESSAGES_PER_SESSION);
    expect(trimmed[0].id).toBe("m5");
    expect(trimmed[trimmed.length - 1].id).toBe(`m${MAX_MESSAGES_PER_SESSION + 4}`);
  });
});

describe("serializeAgentState / parseAgentState", () => {
  it("round-trips a normal state", () => {
    const state = {
      sessions: [session({ id: "s1", messages: [message({ id: "m1", content: "你好" })] })],
      activeSessionId: "s1",
      selection: { providerId: "p1", model: "gpt-x" },
      skillId: "tiangonxieyi",
      canvasAccess: "edit" as const,
    };
    const restored = parseAgentState(serializeAgentState(state));
    expect(restored?.sessions[0].messages[0].content).toBe("你好");
    expect(restored?.activeSessionId).toBe("s1");
    expect(restored?.selection?.model).toBe("gpt-x");
    // 顶层「待用 SKILL」也要能落盘回读，否则重启后按钮就退回「加载 SKILL」
    expect(restored?.skillId).toBe("tiangonxieyi");
  });

  it("drops messages that are still streaming so a half answer never lands on disk", () => {
    const state = {
      sessions: [
        session({
          id: "s1",
          messages: [
            message({ id: "done", content: "完整回答" }),
            message({ id: "streaming", content: "半截", pending: true }),
          ],
        }),
      ],
      activeSessionId: "s1",
      selection: null,
      skillId: null,
      canvasAccess: "edit" as const,
    };
    const raw = serializeAgentState(state);
    expect(raw).not.toContain("半截");
    expect(parseAgentState(raw)?.sessions[0].messages.map((m) => m.id)).toEqual(["done"]);
  });

  it("clears stale pending flags on load", () => {
    const raw = JSON.stringify({
      sessions: [session({ id: "s1", messages: [message({ id: "m", pending: true })] })],
    });
    expect(parseAgentState(raw)?.sessions[0].messages[0].pending).toBe(false);
  });

  it("returns null for missing or corrupt payloads instead of throwing", () => {
    expect(parseAgentState(null)).toBeNull();
    expect(parseAgentState("")).toBeNull();
    expect(parseAgentState("{not json")).toBeNull();
    expect(parseAgentState('{"sessions":"nope"}')).toBeNull();
  });

  it("filters out malformed session and message records", () => {
    const raw = JSON.stringify({
      sessions: [
        { id: "good", messages: [{ id: "m1", role: "user", content: "ok" }, { nope: true }] },
        { notAnId: true },
        null,
      ],
    });
    const restored = parseAgentState(raw);
    expect(restored?.sessions).toHaveLength(1);
    expect(restored?.sessions[0].id).toBe("good");
    expect(restored?.sessions[0].messages).toHaveLength(1);
  });

  it("backfills missing fields with safe defaults", () => {
    const raw = JSON.stringify({ sessions: [{ id: "s1" }] });
    const restored = parseAgentState(raw);
    expect(restored?.sessions[0].title).toBe("新对话");
    expect(restored?.sessions[0].projectId).toBeNull();
    expect(restored?.sessions[0].messages).toEqual([]);
    // 旧版本落盘的数据里没有 skillId，缺字段必须补 null 而不是 undefined
    expect(restored?.sessions[0].skillId).toBeNull();
  });

  it("round-trips the loaded SKILL id and neutralises non-string values", () => {
    const state = {
      sessions: [session({ id: "s1", skillId: "tiangonxieyi" })],
      activeSessionId: "s1",
      selection: null,
      skillId: "tiangonxieyi",
      canvasAccess: "edit" as const,
    };
    expect(parseAgentState(serializeAgentState(state))?.sessions[0].skillId).toBe("tiangonxieyi");
    expect(parseAgentState(serializeAgentState(state))?.skillId).toBe("tiangonxieyi");

    const dirty = JSON.stringify({
      sessions: [{ id: "s1", skillId: { nope: true } }, { id: "s2" }],
      skillId: 42,
    });
    const restored = parseAgentState(dirty);
    expect(restored?.sessions.map((item) => item.skillId)).toEqual([null, null]);
    // 顶层待用值同样要兜底，否则脏数据会让按钮显示成 "42"
    expect(restored?.skillId).toBeNull();
  });
});

describe("selectSessionsForProject", () => {
  const sessions = [
    session({ id: "a", projectId: "p1", updatedAt: 100 }),
    session({ id: "b", projectId: "p2", updatedAt: 300 }),
    session({ id: "c", projectId: "p1", updatedAt: 200 }),
    session({ id: "d", projectId: null, updatedAt: 400 }),
  ];

  it("isolates sessions by project and sorts by recency", () => {
    expect(selectSessionsForProject(sessions, "p1").map((s) => s.id)).toEqual(["c", "a"]);
    expect(selectSessionsForProject(sessions, "p2").map((s) => s.id)).toEqual(["b"]);
  });

  it("treats an absent project as the global bucket", () => {
    expect(selectSessionsForProject(sessions, null).map((s) => s.id)).toEqual(["d"]);
    expect(GLOBAL_PROJECT_KEY).toBe("__global__");
  });

  it("does not mutate the input array", () => {
    const before = sessions.map((s) => s.id);
    selectSessionsForProject(sessions, "p1");
    expect(sessions.map((s) => s.id)).toEqual(before);
  });
});

describe("createMemoryStorage", () => {
  it("behaves like a minimal Storage", () => {
    const storage = createMemoryStorage();
    expect(storage.getItem(AGENT_STORAGE_KEY)).toBeNull();
    storage.setItem(AGENT_STORAGE_KEY, "v");
    expect(storage.getItem(AGENT_STORAGE_KEY)).toBe("v");
    storage.removeItem(AGENT_STORAGE_KEY);
    expect(storage.getItem(AGENT_STORAGE_KEY)).toBeNull();
  });
});

/**
 * 回归：曾经 `setSkill` 在没有活动会话时直接 `return {}` 空转 ——
 * 「新项目里还没聊过任何一条消息」点加载 SKILL 毫无反应（按钮文案也不变）。
 * 现在它与 `selection` 对称：顶层始终有一个"待用值"。
 */
describe("setSkill", () => {
  it("没有活动会话时落到顶层待用值", () => {
    useAgentStore.setState({ hydrated: true, sessions: [], activeSessionId: null, skillId: null });
    useAgentStore.getState().setSkill("tiangonxieyi");
    expect(useAgentStore.getState().skillId).toBe("tiangonxieyi");
  });

  it("有活动会话时同时写到会话上", () => {
    useAgentStore.setState({
      hydrated: true,
      sessions: [session({ id: "s1" })],
      activeSessionId: "s1",
      skillId: null,
    });
    useAgentStore.getState().setSkill("tiangonxieyi");
    expect(useAgentStore.getState().sessions[0].skillId).toBe("tiangonxieyi");
    expect(useAgentStore.getState().skillId).toBe("tiangonxieyi");
  });

  it("传 null 即卸载（两层一起清）", () => {
    useAgentStore.setState({
      hydrated: true,
      sessions: [session({ id: "s1", skillId: "tiangonxieyi" })],
      activeSessionId: "s1",
      skillId: "tiangonxieyi",
    });
    useAgentStore.getState().setSkill(null);
    expect(useAgentStore.getState().sessions[0].skillId).toBeNull();
    expect(useAgentStore.getState().skillId).toBeNull();
  });

  it("新建会话继承待用 SKILL（否则先选 SKILL 再发第一条会静默丢掉）", () => {
    useAgentStore.setState({
      hydrated: true,
      sessions: [],
      activeSessionId: null,
      skillId: "tiangonxieyi",
    });
    const id = useAgentStore.getState().createSession(null);
    const created = useAgentStore.getState().sessions.find((item) => item.id === id);
    expect(created?.skillId).toBe("tiangonxieyi");
  });
});

/** 画布权限档位：安全开关，必须跨会话记住，且旧数据不能把它读成脏值 */
describe("canvasAccess", () => {
  it("随会话状态一起往返", () => {
    const state = {
      sessions: [],
      activeSessionId: null,
      selection: null,
      skillId: null,
      canvasAccess: "read-only" as const,
    };
    expect(parseAgentState(serializeAgentState(state))?.canvasAccess).toBe("read-only");
  });

  it("旧数据（没有该字段）与脏值都兜底成默认档", () => {
    expect(parseAgentState(JSON.stringify({ sessions: [] }))?.canvasAccess).toBe("edit");
    expect(
      parseAgentState(JSON.stringify({ sessions: [], canvasAccess: "root" }))?.canvasAccess,
    ).toBe("edit");
  });

  it("setCanvasAccess 立即改状态", () => {
    useAgentStore.getState().setCanvasAccess("read-only");
    expect(useAgentStore.getState().canvasAccess).toBe("read-only");
    useAgentStore.getState().setCanvasAccess("full");
    expect(useAgentStore.getState().canvasAccess).toBe("full");
  });

  it("其它动作不会把档位冲掉（persist 已改为只传变化字段，其余从 state 补齐）", () => {
    useAgentStore.setState({ hydrated: true, sessions: [], activeSessionId: null });
    useAgentStore.getState().setCanvasAccess("full");
    useAgentStore.getState().setSkill("tiangonxieyi");
    useAgentStore.getState().createSession(null);
    expect(useAgentStore.getState().canvasAccess).toBe("full");
  });
});

/** 早期对话压缩备忘：水位线必须能往返，否则模型会收到重复内容或漏掉历史 */
describe("contextSummary", () => {
  const summary = {
    text: "## 目标与进展\n写一个悬疑短片",
    throughMessageId: "m2",
    throughCreatedAt: 1700000000000,
    messageCount: 12,
    createdAt: 1700000001000,
    tokens: 20,
  };

  it("随会话一起落盘与读回", () => {
    const state = {
      sessions: [session({ id: "s1", contextSummary: summary })],
      activeSessionId: "s1",
      selection: null,
      skillId: null,
      canvasAccess: "edit" as const,
    };
    expect(parseAgentState(serializeAgentState(state))?.sessions[0].contextSummary).toEqual(summary);
  });

  it("缺字段或没有水位线的脏数据一律丢弃", () => {
    expect(parseAgentState(JSON.stringify({ sessions: [session({ id: "s1" })] }))?.sessions[0].contextSummary).toBeNull();
    expect(
      parseAgentState(
        JSON.stringify({
          sessions: [session({ id: "s1", contextSummary: { text: "x" } as never })],
        }),
      )?.sessions[0].contextSummary,
    ).toBeNull();
    expect(
      parseAgentState(
        JSON.stringify({
          sessions: [session({ id: "s1", contextSummary: { ...summary, text: "   " } as never })],
        }),
      )?.sessions[0].contextSummary,
    ).toBeNull();
  });

  it("setContextSummary 写入后可以撤销", () => {
    useAgentStore.setState({
      hydrated: true,
      sessions: [session({ id: "s1" })],
      activeSessionId: "s1",
    });
    useAgentStore.getState().setContextSummary("s1", summary as never);
    expect(useAgentStore.getState().sessions[0].contextSummary).toEqual(summary);
    useAgentStore.getState().setContextSummary("s1", null);
    expect(useAgentStore.getState().sessions[0].contextSummary).toBeNull();
  });

  it("撤销压缩不会动消息本身", () => {
    useAgentStore.setState({
      hydrated: true,
      sessions: [
        session({ id: "s1", messages: [message({ id: "m1" }), message({ id: "m2" })] }),
      ],
      activeSessionId: "s1",
    });
    useAgentStore.getState().setContextSummary("s1", summary as never);
    useAgentStore.getState().setContextSummary("s1", null);
    expect(useAgentStore.getState().sessions[0].messages).toHaveLength(2);
  });
});
