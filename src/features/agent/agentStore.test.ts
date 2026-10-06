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
    };
    const restored = parseAgentState(serializeAgentState(state));
    expect(restored?.sessions[0].messages[0].content).toBe("你好");
    expect(restored?.activeSessionId).toBe("s1");
    expect(restored?.selection?.model).toBe("gpt-x");
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
