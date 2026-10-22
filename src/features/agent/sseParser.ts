/**
 * OpenAI 兼容流式响应的增量解析器（纯逻辑，无 IO、无 DOM，便于单测）。
 *
 * 为什么必须自己写：
 * `request_provider_stream` 把上游响应当作**边界任意**的字节块推给前端——
 * 一次 HTTP chunk 完全可能从某行 SSE 的中间切开（`data: {"cho` + `ices":[...]}`），
 * 所以必须自己缓冲、按行切分、跨块拼接。这是整条 Agent 链路上最容易写错的地方。
 *
 * 另外两类必须容忍的畸形输入：
 * 1. 个别网关在 `stream: true` 时仍然返回**整段 JSON**（一行 `data:` 都没有）；
 * 2. 上游偶尔在 `data:` 行里塞非 JSON 内容（心跳、错误文本）。
 *    —— 这两类都不能让整轮生成崩掉。
 */

export interface SseChatParser {
  /** 喂入一段**可能被任意切断**的文本 */
  push(text: string): void;
  /** 响应结束时调用：处理残留行，并做非流式兜底 */
  flush(): void;
  /** 是否已收到 `[DONE]` */
  readonly done: boolean;
  /** 到目前为止累计吐出的文本 */
  readonly text: string;
  /** 是否出现过合法的 `data:` 行（用于判断"是不是真流式"） */
  readonly sawDataLine: boolean;
}

/**
 * 从一条 OpenAI 兼容的 JSON 载荷里抽取增量文本。
 * 兼容：`choices[0].delta.content`（标准流式）、`choices[0].message.content`
 * （少数网关流式仍给 message）、`choices[0].text`（补全式端点）。
 */
export function extractDeltaText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const choice = choices[0];
  if (!choice || typeof choice !== "object") return "";
  const item = choice as {
    delta?: { content?: unknown };
    message?: { content?: unknown };
    text?: unknown;
  };
  return contentToText(item.delta?.content ?? item.message?.content ?? item.text);
}

/** 把 content 归一化成字符串：可能是 string，也可能是多模态分段数组 */
export function contentToText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const text = (part as { text?: unknown }).text;
          if (typeof text === "string") return text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

export function createSseChatParser(onDelta: (text: string) => void): SseChatParser {
  let buffer = "";
  let rawAll = "";
  let emitted = "";
  let sawDataLine = false;
  let done = false;

  const emit = (text: string) => {
    if (!text) return;
    emitted += text;
    onDelta(text);
  };

  const consumeLine = (line: string) => {
    // 去掉行尾 \r（SSE 允许 CRLF）
    const trimmed = line.replace(/\r$/, "").trim();
    if (!trimmed) return;
    // 以冒号开头的是 SSE 注释/心跳
    if (trimmed.startsWith(":")) return;
    if (!trimmed.startsWith("data:")) return;

    sawDataLine = true;
    const payload = trimmed.slice(5).trim();
    if (!payload) return;
    if (payload === "[DONE]") {
      done = true;
      return;
    }
    try {
      emit(extractDeltaText(JSON.parse(payload)));
    } catch {
      // 非 JSON 的 data 行：跳过，不中断整轮生成
    }
  };

  const consumeBuffer = () => {
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      consumeLine(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
  };

  return {
    get done() {
      return done;
    },
    get text() {
      return emitted;
    },
    get sawDataLine() {
      return sawDataLine;
    },
    push(text: string) {
      if (!text) return;
      rawAll += text;
      buffer += text;
      consumeBuffer();
    },
    flush() {
      if (buffer) {
        consumeLine(buffer);
        buffer = "";
      }
      // 非流式兜底：一行 data: 都没有，但确实有内容 —— 按整段 JSON 再试一次。
      // 否则用户会看到"一个字都不显示"，而实际上上游把完整答案给全了。
      if (!sawDataLine && !done && rawAll.trim()) {
        try {
          emit(extractDeltaText(JSON.parse(rawAll.trim())));
        } catch {
          // 确实不是 JSON：交给上层按错误处理
        }
      }
    },
  };
}
