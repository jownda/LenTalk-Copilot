import { describe, expect, it, vi, beforeEach } from "vitest";

import type { AgentChatTurn, AgentContextSummary, AgentMessage } from "./types";

vi.mock("./llmClient", () => ({ streamChat: vi.fn() }));

import { streamChat } from "./llmClient";
import {
  buildSummaryPrompt,
  estimateMessagesTokens,
  estimateTokens,
  formatSummaryForSystemPrompt,
  mechanicalTrim,
  messagesToTurns,
  planContextCompression,
  prepareHistory,
  resolveSummaryTailStart,
  splitTurnsIntoBatches,
  summarizeHistory,
  CONTEXT_KEEP_TOKEN_BUDGET,
  CONTEXT_MIN_KEEP_MESSAGES,
  CONTEXT_TOKEN_BUDGET,
} from "./contextCompression";

const mockedStreamChat = vi.mocked(streamChat);

let seq = 0;
function msg(role: AgentMessage["role"], content: string, createdAt?: number): AgentMessage {
  seq += 1;
  return { id: `m${seq}`, role, content, createdAt: createdAt ?? seq * 1000 };
}

/** 一段 n 个汉字的正文（≈ n 个 token） */
function cjk(length: number): string {
  return "字".repeat(length);
}

function summaryOf(text: string, throughMessageId: string, count = 4): AgentContextSummary {
  return {
    text,
    throughMessageId,
    throughCreatedAt: 1000,
    messageCount: count,
    createdAt: 1,
    tokens: estimateTokens(text),
  };
}

describe("estimateTokens", () => {
  it("中文按字计、英文按字符折算", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens(cjk(100))).toBe(104);
    // 400 个拉丁字符 ≈ 112 token + 4 固定开销
    const latin = estimateTokens("a".repeat(400));
    expect(latin).toBeGreaterThan(100);
    expect(latin).toBeLessThan(130);
  });

  it("同样字符数下中文比英文贵数倍", () => {
    expect(estimateTokens(cjk(300))).toBeGreaterThan(estimateTokens("a".repeat(300)) * 2);
  });
});

describe("resolveSummaryTailStart", () => {
  it("没有备忘时从头发送", () => {
    expect(resolveSummaryTailStart([msg("user", "a")], null)).toBe(0);
  });

  it("按 id 跳过已吸收的消息", () => {
    const messages = [msg("user", "a"), msg("assistant", "b"), msg("user", "c")];
    expect(resolveSummaryTailStart(messages, summaryOf("备忘", messages[1].id))).toBe(2);
  });

  it("水位线那条被 200 条上限裁掉时按时间兜底", () => {
    const messages = [msg("user", "a", 5000), msg("assistant", "b", 6000)];
    const summary = { ...summaryOf("备忘", "已经不存在了"), throughCreatedAt: 4000 };
    expect(resolveSummaryTailStart(messages, summary)).toBe(0);
    expect(resolveSummaryTailStart(messages, { ...summary, throughCreatedAt: 5500 })).toBe(1);
  });
});

describe("planContextCompression", () => {
  it("短对话不压缩", () => {
    const messages = [msg("user", cjk(20)), msg("assistant", cjk(30))];
    const plan = planContextCompression(messages);
    expect(plan.needed).toBe(false);
    expect(plan.keep).toHaveLength(2);
    expect(plan.toSummarize).toHaveLength(0);
  });

  it("超预算时保留最近对话、压缩早期对话", () => {
    const messages = Array.from({ length: 8 }, (_, index) =>
      msg(index % 2 === 0 ? "user" : "assistant", cjk(100)),
    );
    const plan = planContextCompression(messages, null, { budget: 300, keepBudget: 150, minKeep: 2 });
    expect(plan.needed).toBe(true);
    expect(plan.toSummarize.length).toBeGreaterThan(0);
    expect(plan.keep.length).toBeGreaterThanOrEqual(2);
    // 保留段必须以提问开头，不能从半截回答开始
    expect(plan.keep[0].role).toBe("user");
    expect(plan.projectedTokens).toBeLessThan(plan.estimatedTokens);
    // 早期 + 最近 = 全部
    expect(plan.toSummarize.length + plan.keep.length).toBe(8);
  });

  it("已经压缩过的部分不再重复计入", () => {
    const messages = [msg("user", cjk(100)), msg("assistant", cjk(100)), msg("user", cjk(100))];
    const summary = summaryOf(cjk(50), messages[0].id, 1);
    const plan = planContextCompression(messages, summary, { budget: 1000 });
    // 尾部两条 ≈ 208 token，加备忘 ~54，未超 1000
    expect(plan.needed).toBe(false);
    expect(plan.keep.map((item) => item.id)).toEqual([messages[1].id, messages[2].id]);
    expect(plan.estimatedTokens).toBeGreaterThan(200);
  });

  it("备忘本身过大时也会触发合并压缩", () => {
    const messages = Array.from({ length: 4 }, (_, index) =>
      msg(index % 2 === 0 ? "user" : "assistant", cjk(100)),
    );
    const summary = summaryOf(cjk(600), "gone", 30);
    const plan = planContextCompression(messages, summary, { budget: 600, keepBudget: 120, minKeep: 2 });
    expect(plan.needed).toBe(true);
    expect(plan.toSummarize.length).toBeGreaterThan(0);
  });

  it("默认预算下 200 条长消息一定触发压缩", () => {
    const messages = Array.from({ length: 200 }, (_, index) =>
      msg(index % 2 === 0 ? "user" : "assistant", cjk(200)),
    );
    const plan = planContextCompression(messages, null);
    expect(plan.needed).toBe(true);
    // 5000 token 的保留预算 ≈ 24 条 200 字的消息
    expect(plan.keep.length).toBeGreaterThanOrEqual(CONTEXT_MIN_KEEP_MESSAGES);
    expect(plan.keep.length).toBeLessThan(40);
    expect(plan.projectedTokens).toBeLessThan(CONTEXT_TOKEN_BUDGET);
    expect(plan.estimatedTokens).toBeGreaterThan(CONTEXT_TOKEN_BUDGET);
  });
});

describe("mechanicalTrim", () => {
  it("砍到预算内且保留最近的消息", () => {
    const messages = Array.from({ length: 10 }, (_, index) =>
      msg(index % 2 === 0 ? "user" : "assistant", cjk(100)),
    );
    const keep = mechanicalTrim(messages, null, { budget: 300, minKeep: 2 });
    expect(keep.length).toBeLessThan(messages.length);
    expect(keep[keep.length - 1].id).toBe(messages[9].id);
  });

  it("没超预算就原样返回", () => {
    const messages = [msg("user", cjk(10))];
    expect(mechanicalTrim(messages, null, { budget: 1000 })).toHaveLength(1);
  });
});

describe("messagesToTurns", () => {
  it("把工具调用摊成一行短标签，供摘要参考", () => {
    const toolMessage: AgentMessage = {
      ...msg("assistant", "已经建好了节点"),
      toolCalls: [
        { tool: "canvas.create_node", label: "创建节点", arguments: {}, ok: true, message: "成功" },
        { tool: "canvas.run_node", label: "执行节点", arguments: {}, ok: false, message: "失败" },
      ],
    };
    const turns = messagesToTurns([msg("user", "建两个节点"), toolMessage]);
    expect(turns).toHaveLength(3);
    expect(turns[1].role).toBe("assistant");
    expect(turns[2].content).toContain("创建节点（成功）");
    expect(turns[2].content).toContain("执行节点（失败）");
  });

  it("跳过空消息与 system 消息", () => {
    const turns = messagesToTurns([msg("system", "系统"), msg("user", "  "), msg("user", "好")]);
    expect(turns).toHaveLength(1);
  });
});

describe("splitTurnsIntoBatches", () => {
  it("按预算切批，保证小模型也能跑", () => {
    const turns: AgentChatTurn[] = Array.from({ length: 6 }, () => ({
      role: "user" as const,
      content: cjk(100),
    }));
    const batches = splitTurnsIntoBatches(turns, 220);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(estimateMessagesTokens(batch.map((turn) => ({ ...turn, id: "x", createdAt: 0 })))).toBeLessThan(400);
    }
    expect(batches.flat()).toHaveLength(6);
  });
});

describe("buildSummaryPrompt", () => {
  it("带上旧备忘、角色与规则", () => {
    const prompt = buildSummaryPrompt("旧备忘内容", [{ role: "user", content: "帮我写开场" }]);
    expect(prompt).toContain("旧备忘内容");
    expect(prompt).toContain("用户：帮我写开场");
    expect(prompt).toContain("未完成事项");
  });

  it("没有旧备忘时明确写无，避免模型以为被省略了", () => {
    expect(buildSummaryPrompt("", [{ role: "user", content: "a" }])).toContain("（无）");
  });
});

describe("formatSummaryForSystemPrompt", () => {
  it("没有备忘时返回空串（不能平白多一段空标题）", () => {
    expect(formatSummaryForSystemPrompt(null)).toBe("");
    expect(formatSummaryForSystemPrompt(summaryOf("   ", "x"))).toBe("");
  });

  it("有备忘时带上「以画面现状为准」的冲突规则", () => {
    const text = formatSummaryForSystemPrompt(summaryOf("主角叫林岸", "x"));
    expect(text).toContain("早期对话备忘");
    expect(text).toContain("主角叫林岸");
    expect(text).toContain("画面现状");
  });
});

describe("prepareHistory", () => {
  beforeEach(() => {
    mockedStreamChat.mockReset();
  });

  it("不超预算时不调用模型", async () => {
    const summarize = vi.fn();
    const messages = [msg("user", "你好"), msg("assistant", "在的")];
    const result = await prepareHistory({ messages, summary: null, summarize });
    expect(summarize).not.toHaveBeenCalled();
    expect(result.compressed).toBe(false);
    expect(result.keep).toHaveLength(2);
  });

  it("超预算时压缩早期对话并推进水位线", async () => {
    const messages = Array.from({ length: 8 }, (_, index) =>
      msg(index % 2 === 0 ? "user" : "assistant", cjk(100)),
    );
    const summarize = vi.fn(async () => "## 目标与进展\n在写开场");
    const result = await prepareHistory({
      messages,
      summary: null,
      summarize,
      plan: { budget: 300, keepBudget: 150, minKeep: 2 },
    });

    expect(summarize).toHaveBeenCalledTimes(1);
    const [turns, previous] = summarize.mock.calls[0] as unknown as [AgentChatTurn[], string];
    expect(previous).toBe("");
    expect(turns.length).toBeGreaterThan(0);
    expect(result.compressed).toBe(true);
    expect(result.summary?.text).toContain("在写开场");
    expect(result.summary?.messageCount).toBeGreaterThan(0);
    // 水位线落在被压缩的最后一条上，下一轮不会重复带上它
    expect(result.summary?.throughMessageId).toBe(messages[result.summary!.messageCount - 1].id);
    expect(result.keep.map((item) => item.id)).not.toContain(result.summary?.throughMessageId);
  });

  it("累加已压缩条数而不是覆盖", async () => {
    const messages = Array.from({ length: 6 }, (_, index) =>
      msg(index % 2 === 0 ? "user" : "assistant", cjk(100)),
    );
    const previous = summaryOf("旧备忘", messages[1].id, 2);
    const result = await prepareHistory({
      messages,
      summary: previous,
      summarize: async () => "新备忘",
      plan: { budget: 300, keepBudget: 150, minKeep: 2 },
    });
    expect(result.compressed).toBe(true);
    expect(result.summary?.messageCount).toBeGreaterThan(2);
    expect(result.summary?.text).toBe("新备忘");
  });

  it("摘要为空视为失败，不覆盖已有备忘", async () => {
    const messages = Array.from({ length: 8 }, (_, index) =>
      msg(index % 2 === 0 ? "user" : "assistant", cjk(100)),
    );
    await expect(
      prepareHistory({
        messages,
        summary: null,
        summarize: async () => "   ",
        plan: { budget: 300, keepBudget: 150, minKeep: 2 },
      }),
    ).rejects.toThrow("没有返回内容");
  });
});

describe("summarizeHistory", () => {
  beforeEach(() => {
    mockedStreamChat.mockReset();
  });

  it("分批滚动推进：后一批能读到前一批的备忘", async () => {
    mockedStreamChat
      .mockResolvedValueOnce({ text: "备忘 A", status: 200 })
      .mockResolvedValueOnce({ text: "备忘 B", status: 200 });

    const turns: AgentChatTurn[] = Array.from({ length: 6 }, () => ({
      role: "user" as const,
      content: cjk(100),
    }));
    const progress: string[] = [];
    const result = await summarizeHistory({
      settings: { provider: "p", model: "m", baseUrl: "", apiKey: "" } as never,
      turns,
      batchTokens: 350,
      onProgress: (message) => progress.push(message),
    });

    expect(mockedStreamChat).toHaveBeenCalledTimes(2);
    const secondCall = mockedStreamChat.mock.calls[1][0];
    const secondPrompt = secondCall.messages[1].content;
    expect(secondPrompt).toContain("备忘 A");
    expect(result).toBe("备忘 B");
    expect(progress[0]).toContain("1/2");
  });

  it("单批时直接把结果作为备忘", async () => {
    mockedStreamChat.mockResolvedValueOnce({ text: "一份备忘", status: 200 });
    const result = await summarizeHistory({
      settings: { provider: "p", model: "m", baseUrl: "", apiKey: "" } as never,
      turns: [{ role: "user", content: "短对话" }],
    });
    expect(result).toBe("一份备忘");
    expect(mockedStreamChat).toHaveBeenCalledTimes(1);
  });

  it("某一批返回空串时保留已有备忘", async () => {
    mockedStreamChat
      .mockResolvedValueOnce({ text: "第一份", status: 200 })
      .mockResolvedValueOnce({ text: "", status: 200 });
    const turns: AgentChatTurn[] = Array.from({ length: 6 }, () => ({
      role: "user" as const,
      content: cjk(100),
    }));
    const result = await summarizeHistory({
      settings: { provider: "p", model: "m", baseUrl: "", apiKey: "" } as never,
      turns,
      batchTokens: 350,
    });
    expect(result).toBe("第一份");
  });

  it("外部取消时抛 AbortError", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      summarizeHistory({
        settings: { provider: "p", model: "m", baseUrl: "", apiKey: "" } as never,
        turns: [{ role: "user", content: "a" }],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mockedStreamChat).not.toHaveBeenCalled();
  });
});

describe("默认预算常量", () => {
  it("保留预算明显小于总预算，否则压缩没有意义", () => {
    expect(CONTEXT_KEEP_TOKEN_BUDGET).toBeLessThan(CONTEXT_TOKEN_BUDGET);
  });
});

describe("总时限", () => {
  beforeEach(() => {
    mockedStreamChat.mockReset();
  });

  it("超过总时限就不再发起下一批（避免用户干等几分钟）", async () => {
    await expect(
      summarizeHistory({
        settings: { provider: "p", model: "m", baseUrl: "", apiKey: "" } as never,
        turns: [{ role: "user", content: cjk(200) }],
        totalTimeoutMs: 0,
      }),
    ).rejects.toThrow("超时");
    expect(mockedStreamChat).not.toHaveBeenCalled();
  });
});
