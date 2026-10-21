/**
 * 超长历史自动压缩。
 *
 * 为什么需要：`agentStore` 只按**条数**裁消息（200 条），不估算 token。几十轮之后
 * 历史轻松超过十万字符，小上下文模型会直接报 `context_length_exceeded`，
 * 大上下文模型则白白多付输入费。
 *
 * 策略（三段式）：
 * 1. **规划**（纯函数）：把历史切成「早期（要压缩）」+「最近（原样保留）」。
 *    保留量按 token 预算算，并向 user 消息对齐 —— 把提问和它的回答切开，
 *    模型会看到一个没头没尾的回答。
 * 2. **摘要**：早期消息交给模型压成结构化备忘。**分批**推进（滚动摘要），
 *    否则一次性把 1 万 token 的旧历史塞进摘要请求，小模型同样会爆窗。
 * 3. **落盘**：摘要连同「吸收到哪一条消息」一起写进会话，下一轮直接复用 ——
 *    不能每轮都重压一遍，那等于每次都多花一次请求。
 *
 * 失败兜底由调用方决定（见 `AgentPanel`）：摘要失败就只做机械裁剪，
 * **不推进** `throughMessageId`，下一轮还能重试。
 */

import type { AISettings } from "@/features/cinematicStudio/app/providers/aiSettings";

import { streamChat } from "./llmClient";
import type {
  AgentChatTurn,
  AgentContextSummary,
  AgentMessage,
  AgentToolCallRecord,
} from "./types";

/** 历史（摘要 + 原样保留的消息）允许占用的 token 估算上限 */
export const CONTEXT_TOKEN_BUDGET = 12_000;
/** 压缩后原样保留的最近消息允许占用的 token 估算上限 */
export const CONTEXT_KEEP_TOKEN_BUDGET = 5_000;
/** 无论预算如何，至少保留这么多条最近消息 */
export const CONTEXT_MIN_KEEP_MESSAGES = 4;
/** 单次摘要请求的输入预算：分批推进，保证小上下文模型也能跑 */
export const SUMMARY_BATCH_TOKEN_BUDGET = 4_000;
/** 摘要正文（备忘）的期望上限，写进提示词约束模型 */
export const SUMMARY_MAX_CHARS = 700;
/** 送进摘要请求的单条消息截断长度，防止一条巨型消息独占整个批次 */
const SUMMARY_TURN_CHAR_LIMIT = 2_400;
/** 单批摘要的超时（毫秒）；一批卡住就放弃整次压缩，而不是陪着它干等 */
export const SUMMARY_REQUEST_TIMEOUT_MS = 90_000;
/**
 * 整次压缩的总时限。分批是串行的（滚动合并），单批 90 秒 × 4 批 = 6 分钟，
 * 用户在输入框前等 6 分钟只会以为又卡死了 —— 超过总时限就退化成机械裁剪。
 */
export const SUMMARY_TOTAL_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------------------
// 估算
// ---------------------------------------------------------------------------

/**
 * 粗略 token 估算。
 *
 * 刻意不引入 tokenizer 依赖（每个模型词表都不同，装了也只对其中一家的模型准）。
 * 中日韩字符按 1 token/字，拉丁与数字按 0.28 token/字符（约 3.5 字符一个 token），
 * 中文对话场景下误差通常在 ±15% 以内，用来判断"要不要压缩"足够。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    tokens += code > 0x2e7f ? 1 : 0.28;
  }
  // 加一点每条消息的 role / 分隔开销
  return Math.ceil(tokens) + 4;
}

/** 估算一组消息的 token；工具调用记录按条补一点（它们会被格式化成额外文本） */
export function estimateMessagesTokens(messages: AgentMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateTokens(message.content);
    if (message.toolCalls?.length) total += message.toolCalls.length * 24;
  }
  return total;
}

// ---------------------------------------------------------------------------
// 规划
// ---------------------------------------------------------------------------

export interface CompressionPlan {
  /** 是否值得压缩（超过预算且有可压缩的早期消息） */
  needed: boolean;
  /** 要被摘要吸收的早期消息（按时间顺序，可能为空） */
  toSummarize: AgentMessage[];
  /** 原样保留的最近消息 */
  keep: AgentMessage[];
  /** 当前历史（摘要 + 全部未压缩尾部）的估算 token */
  estimatedTokens: number;
  /** 压缩后（新摘要 + keep）的估算 token */
  projectedTokens: number;
}

/**
 * 找出「摘要已经覆盖到哪一条之后」。
 *
 * 优先按 id 定位；消息因为 200 条上限被从头裁掉时 id 会找不到，
 * 此时退回按 `throughCreatedAt` 定位，避免把已经写进摘要的内容重复带入。
 */
export function resolveSummaryTailStart(
  messages: AgentMessage[],
  summary: AgentContextSummary | null,
): number {
  if (!summary) return 0;
  if (summary.throughMessageId) {
    const index = messages.findIndex((message) => message.id === summary.throughMessageId);
    if (index >= 0) return index + 1;
  }
  if (summary.throughCreatedAt > 0) {
    const index = messages.findIndex((message) => message.createdAt > summary.throughCreatedAt);
    return index >= 0 ? index : messages.length;
  }
  return 0;
}

export interface PlanOptions {
  budget?: number;
  keepBudget?: number;
  minKeep?: number;
}

/** 规划一次压缩；纯函数，不发起任何请求 */
export function planContextCompression(
  messages: AgentMessage[],
  summary: AgentContextSummary | null = null,
  options: PlanOptions = {},
): CompressionPlan {
  const budget = options.budget ?? CONTEXT_TOKEN_BUDGET;
  const keepBudget = options.keepBudget ?? CONTEXT_KEEP_TOKEN_BUDGET;
  const minKeep = options.minKeep ?? CONTEXT_MIN_KEEP_MESSAGES;

  const tailStart = resolveSummaryTailStart(messages, summary);
  // 空白消息（例如失败轮次留下的空回答）不该占预算，也不值得写进摘要
  const tail = messages
    .slice(tailStart)
    .filter((message) => message.role !== "system" && (message.content.trim() || message.toolCalls?.length));

  const summaryTokens = summary ? estimateTokens(summary.text) : 0;
  const tailTokens = estimateMessagesTokens(tail);
  const estimatedTokens = summaryTokens + tailTokens;

  const unchanged: CompressionPlan = {
    needed: false,
    toSummarize: [],
    keep: tail,
    estimatedTokens,
    projectedTokens: estimatedTokens,
  };
  if (tail.length === 0 || estimatedTokens <= budget) return unchanged;

  // 从后往前攒够 keepBudget；即使没攒够也至少留 minKeep 条
  let keepStart = tail.length;
  let keptTokens = 0;
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    keptTokens += estimateTokens(tail[index].content);
    keepStart = index;
    if (keptTokens >= keepBudget && tail.length - index >= minKeep) break;
  }
  // 向 user 消息对齐：保留段从「提问」开始，而不是从中途的回答开始。
  // 最多回退 2 条 —— 再往前就是把本该压缩的内容也一起留下了，压缩会变成空转。
  if (keepStart > 0 && tail[keepStart].role !== "user") {
    const floor = Math.max(1, keepStart - 2);
    for (let index = keepStart - 1; index >= floor; index -= 1) {
      if (tail[index].role === "user") {
        keepStart = index;
        break;
      }
    }
  }
  // 兜底：仅当尾部就只有几条消息、且首条本身超预算时才会走到这里，
  // 这时强行保留最后 minKeep 条，把前面的拿去压缩。
  if (keepStart === 0 && tail.length > minKeep) keepStart = tail.length - minKeep;

  const toSummarize = tail.slice(0, keepStart);
  const keep = tail.slice(keepStart);
  return {
    needed: toSummarize.length > 0,
    toSummarize,
    keep,
    estimatedTokens,
    projectedTokens: summaryTokens + estimateMessagesTokens(keep),
  };
}

/**
 * 兜底：不做摘要，直接砍掉最早的尾部消息，直到落回预算内。
 * 只在摘要请求失败时使用 —— 宁可丢细节，也不能让请求因为超窗直接失败。
 */
export function mechanicalTrim(
  messages: AgentMessage[],
  summary: AgentContextSummary | null,
  options: PlanOptions = {},
): AgentMessage[] {
  const budget = options.budget ?? CONTEXT_TOKEN_BUDGET;
  const minKeep = options.minKeep ?? CONTEXT_MIN_KEEP_MESSAGES;
  const tailStart = resolveSummaryTailStart(messages, summary);
  const tail = messages.slice(tailStart);
  if (summary && estimateTokens(summary.text) + estimateMessagesTokens(tail) <= budget) {
    return tail;
  }
  let start = tail.length;
  let tokens = summary ? estimateTokens(summary.text) : 0;
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    tokens += estimateTokens(tail[index].content);
    start = index;
    if (tokens > budget && tail.length - index >= minKeep) break;
  }
  return tail.slice(start);
}

// ---------------------------------------------------------------------------
// 摘要
// ---------------------------------------------------------------------------

const SUMMARY_SYSTEM_PROMPT = [
  "你是对话记忆压缩器：把给定的早期对话压缩成一份结构化中文备忘，供后续对话继续使用。",
  "只输出备忘正文，不要寒暄，不要解释你在做什么，不要复述指令。",
].join("");

const SUMMARY_RULES = [
  "要求：",
  "1. 用五个固定小节输出：目标与进展 / 已确认的设定与决策 / 画布相关 / 未完成事项 / 用户偏好与禁忌。",
  "2. 具体名词一律照抄：人物名、项目名、画布节点名（含 #2 这类后缀）、模型名、文件名、数字与参数。",
  "   不要概括成「某个节点」「某个模型」—— 后续对话要靠这些名字精确定位。",
  "3. 后来被明确推翻或改掉的设定，标成「（已废弃）」并说明改成了什么，不要与现行设定并列。",
  "4. 省略寒暄、重复解释与客套话；事实、决定、待办不能丢。",
  `5. 总长不超过 ${SUMMARY_MAX_CHARS} 字，直接输出备忘正文，不要写「以下是」。`,
].join("\n");

/** 把消息摊平成角色文本；工具调用用一行短标签带过（摘要不需要参数细节） */
export function messagesToTurns(
  messages: AgentMessage[],
  describeTools?: (records: AgentToolCallRecord[]) => string,
): AgentChatTurn[] {
  const turns: AgentChatTurn[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.content.trim()) {
      turns.push({ role: message.role, content: message.content });
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      const text = describeTools
        ? describeTools(message.toolCalls)
        : message.toolCalls
            .map((record) => `[画布操作] ${record.label || record.tool}（${record.ok ? "成功" : "失败"}）`)
            .join("\n");
      if (text.trim()) turns.push({ role: "user", content: text });
    }
  }
  return turns;
}

function clipTurn(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > SUMMARY_TURN_CHAR_LIMIT
    ? `${normalized.slice(0, SUMMARY_TURN_CHAR_LIMIT)}…（后文略）`
    : normalized;
}

export function buildSummaryPrompt(previousSummary: string, turns: AgentChatTurn[]): string {
  const transcript = turns
    .map((turn) => `${turn.role === "user" ? "用户" : "助手"}：${clipTurn(turn.content)}`)
    .join("\n\n");
  return [
    "【已有备忘】",
    previousSummary.trim() || "（无）",
    "",
    "【新增对话】",
    transcript,
    "",
    "把「新增对话」的信息合并进「已有备忘」，输出更新后的完整备忘。",
    SUMMARY_RULES,
  ].join("\n");
}

/** 按输入预算切批；单条超预算的消息独占一批（截断由 `clipTurn` 负责） */
export function splitTurnsIntoBatches(
  turns: AgentChatTurn[],
  budget: number = SUMMARY_BATCH_TOKEN_BUDGET,
): AgentChatTurn[][] {
  const batches: AgentChatTurn[][] = [];
  let current: AgentChatTurn[] = [];
  let tokens = 0;
  for (const turn of turns) {
    const cost = estimateTokens(turn.content);
    if (current.length > 0 && tokens + cost > budget) {
      batches.push(current);
      current = [];
      tokens = 0;
    }
    current.push(turn);
    tokens += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export interface SummarizeHistoryParams {
  settings: AISettings;
  /** 待吸收的消息（已经格式化成送入模型的形状） */
  turns: AgentChatTurn[];
  /** 上一次的备忘，用于滚动合并 */
  previousSummary?: string;
  signal?: AbortSignal;
  /** 分批进度回调，用于在输入框上方显示「正在压缩（1/2）」 */
  onProgress?: (message: string) => void;
  timeoutMs?: number;
  /** 单批输入预算；默认 4000，测试与特殊模型可覆盖 */
  batchTokens?: number;
  /** 整次压缩的总时限（毫秒）；默认 180 秒 */
  totalTimeoutMs?: number;
}

async function requestSummary(
  settings: AISettings,
  prompt: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let text = "";
  try {
    const result = await streamChat({
      settings,
      messages: [
        { role: "system", content: SUMMARY_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      signal: controller.signal,
      onDelta: (delta) => {
        text += delta;
      },
    });
    // 正常情况下增量已经把全文攒齐了；少数实现只在结束时给出整段文本，兜一下
    return text || result.text;
  } catch (error) {
    if (timedOut) throw new Error(`压缩早期上下文超时（${Math.round(timeoutMs / 1000)} 秒）`);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * 把早期消息压成备忘。分批滚动推进：第 N 批的输入是「第 N-1 批的备忘 + 本批对话」，
 * 所以最终结果仍然是一份连贯的备忘，而不是若干段彼此不知情的摘要。
 */
export async function summarizeHistory(params: SummarizeHistoryParams): Promise<string> {
  const {
    settings,
    turns,
    signal,
    onProgress,
    timeoutMs = SUMMARY_REQUEST_TIMEOUT_MS,
    totalTimeoutMs = SUMMARY_TOTAL_TIMEOUT_MS,
  } = params;
  let memo = (params.previousSummary ?? "").trim();
  const batches = splitTurnsIntoBatches(turns, params.batchTokens);
  const deadline = Date.now() + totalTimeoutMs;
  for (let index = 0; index < batches.length; index += 1) {
    if (signal?.aborted) {
      const aborted = new Error("已取消生成");
      aborted.name = "AbortError";
      throw aborted;
    }
    if (Date.now() >= deadline) {
      throw new Error(`压缩早期上下文超时（超过 ${Math.round(totalTimeoutMs / 1000)} 秒）`);
    }
    onProgress?.(
      batches.length > 1
        ? `正在压缩早期对话记忆（${index + 1}/${batches.length}）…`
        : "正在压缩早期对话记忆…",
    );
    const next = (
      await requestSummary(
        settings,
        buildSummaryPrompt(memo, batches[index]),
        signal,
        // 单批超时不能超过总时限的剩余量，否则最后一批能把总时限顶穿
        Math.max(5_000, Math.min(timeoutMs, deadline - Date.now())),
      )
    ).trim();
    // 空结果不覆盖旧备忘：宁可少一次合并，也不能把已有记忆清空
    if (next) memo = next;
  }
  return memo;
}

// ---------------------------------------------------------------------------
// 编排
// ---------------------------------------------------------------------------

export interface PrepareHistoryParams {
  messages: AgentMessage[];
  summary: AgentContextSummary | null;
  /** 注入摘要实现，便于单测直接给定结果 */
  summarize: (turns: AgentChatTurn[], previousSummary: string) => Promise<string>;
  plan?: PlanOptions;
}

export interface PrepareHistoryResult {
  /** 原样送入模型的最近消息 */
  keep: AgentMessage[];
  /** 最新的备忘（压缩成功时是新的，否则原样返回） */
  summary: AgentContextSummary | null;
  /** 本轮是否真的压缩了 */
  compressed: boolean;
  estimatedTokens: number;
  keptTokens: number;
}

/** 在发送前决定「这一轮要带哪些历史」，必要时先做一次压缩 */
export async function prepareHistory(params: PrepareHistoryParams): Promise<PrepareHistoryResult> {
  const { messages, summary, summarize, plan: options } = params;
  const plan = planContextCompression(messages, summary, options);

  if (!plan.needed || plan.toSummarize.length === 0) {
    return {
      keep: plan.keep,
      summary,
      compressed: false,
      estimatedTokens: plan.estimatedTokens,
      keptTokens: plan.projectedTokens,
    };
  }

  const turns = messagesToTurns(plan.toSummarize);
  const text = (await summarize(turns, summary?.text ?? "")).trim();
  if (!text) throw new Error("压缩早期上下文没有返回内容");

  const last = plan.toSummarize[plan.toSummarize.length - 1];
  const next: AgentContextSummary = {
    text,
    throughMessageId: last.id,
    throughCreatedAt: last.createdAt,
    messageCount: (summary?.messageCount ?? 0) + plan.toSummarize.length,
    createdAt: Date.now(),
    tokens: estimateTokens(text),
  };

  return {
    keep: plan.keep,
    summary: next,
    compressed: true,
    estimatedTokens: plan.estimatedTokens,
    keptTokens: estimateTokens(text) + estimateMessagesTokens(plan.keep),
  };
}

/** 把备忘拼进 system prompt（而不是伪装成一条 user 消息，避免模型把它当成用户在说话） */
export function formatSummaryForSystemPrompt(summary: AgentContextSummary | null): string {
  if (!summary?.text.trim()) return "";
  return [
    "【早期对话备忘】",
    "以下是本次会话较早部分的压缩记录（原文已不再随请求发送）。它是既定事实，",
    "与「画面现状」冲突时以画面现状为准，其余设定、决定与待办一律以它为准确认，",
    "不要要求用户重复已经说过的内容。",
    summary.text.trim(),
  ].join("\n");
}
