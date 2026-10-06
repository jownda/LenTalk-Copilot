/**
 * Agent 的 LLM 传输端口：把"一段对话消息"变成"逐段返回的文本增量"。
 *
 * 设计要点：
 * - **零后端改动**。复用既有的 `request_provider_stream`（Rust 侧只做字节搬运，
 *   解析 SSE 是前端的职责），模型地址/Key 直接读 LenTalk「设置 → 自定义平台」，
 *   与 cinematicStudio 共用同一份配置，不新增设置项。
 * - 只依赖 `sseParser` 一个纯函数模块，所以整个端口可以用 mock 事件做确定性单测。
 * - 未来要换成外部 harness（或把循环搬到 Rust）时，只需替换本文件，
 *   AgentPanel 与 agentStore 不受影响。
 */

import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import {
  openAICompatibleBaseUrl,
  type AISettings,
} from "@/features/cinematicStudio/app/providers/aiSettings";

import { createSseChatParser } from "./sseParser";
import type { AgentChatTurn } from "./types";

const DEFAULT_TEMPERATURE = 0.7;

/** Rust 侧 `request_provider_stream` 推回的事件形状（与 ai.ts 内部同构） */
interface ProviderStreamEvent {
  kind: "start" | "chunk" | "done" | "error";
  status?: number;
  chunk_base64?: string;
  message?: string;
}

export interface StreamChatParams {
  settings: AISettings;
  messages: AgentChatTurn[];
  temperature?: number;
  signal?: AbortSignal;
  /** 每收到一段增量就调一次；调用方据此刻画"正在打字" */
  onDelta: (delta: string) => void;
}

export interface StreamChatResult {
  /** 本轮完整文本 */
  text: string;
  status: number;
}

/** 构造 OpenAI 兼容的 chat/completions 请求体。导出以便单测覆盖参数拼装。 */
export function buildChatRequestBody(
  settings: AISettings,
  messages: AgentChatTurn[],
  temperature?: number,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: settings.model.trim(),
    messages,
    stream: true,
    temperature: temperature ?? settings.temperature ?? DEFAULT_TEMPERATURE,
  };
  // 推理强度只对支持的模型有意义；为空时不发送，避免非推理模型报错。
  if (settings.reasoningEffort) body.reasoning_effort = settings.reasoningEffort;
  return body;
}

function abortError(): Error {
  const message = "已取消生成";
  if (typeof DOMException === "function") return new DOMException(message, "AbortError");
  return Object.assign(new Error(message), { name: "AbortError" });
}

function decodeBase64Chunk(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function httpErrorText(status: number, raw: string): string {
  const detail = raw.trim();
  return `模型返回 HTTP ${status}${detail ? `：${detail.slice(0, 300)}` : ""}`;
}

/**
 * 发起一轮流式对话。
 * 成功返回完整文本；失败抛错（取消时抛 name === "AbortError" 的错误，
 * 调用方应保留已经收到的部分文本）。
 */
export async function streamChat(params: StreamChatParams): Promise<StreamChatResult> {
  const { settings, messages, signal, onDelta } = params;
  const base = openAICompatibleBaseUrl(settings.baseUrl);
  if (!base) {
    throw new Error("尚未选择可用的 Chat 模型，请到「设置 → 自定义平台」添加 Chat 模型");
  }
  if (!settings.model.trim()) throw new Error("尚未选择模型");

  const url = `${base}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = settings.apiKey.trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const body = buildChatRequestBody(settings, messages, params.temperature);

  if (signal?.aborted) throw abortError();

  return isTauri()
    ? streamViaTauri({ url, headers, body, signal, onDelta })
    : streamViaFetch({ url, headers, body, signal, onDelta });
}

interface TransportOptions {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal?: AbortSignal;
  onDelta: (delta: string) => void;
}

/**
 * Tauri 路径：`request_provider_stream` 把上游响应当作任意边界的字节块 base64 推回，
 * 我们在此解码 → 喂给 SSE 解析器。
 *
 * 取消语义（须如实认知）：取消只是**前端停止接收**，Rust 侧那一次 HTTP 请求
 * 仍会跑到结束。对聊天来说代价是上游可能白算几个 token，不会产生额外计费提交，
 * 因此无需为此在 Rust 侧引入中断通道。
 */
async function streamViaTauri(options: TransportOptions): Promise<StreamChatResult> {
  const { url, headers, body, signal, onDelta } = options;
  const eventName = `agent-chat-stream-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const parser = createSseChatParser(onDelta);
  const decoder = new TextDecoder();

  let status = 200;
  let failure: Error | null = null;
  let finished = false;
  let resolveFinished: () => void = () => undefined;
  const finishedPromise = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });

  const finish = () => {
    if (finished) return;
    finished = true;
    // 冲掉 TextDecoder 与解析器里可能残留的最后半个字符 / 半行
    parser.push(decoder.decode());
    parser.flush();
    resolveFinished();
  };

  const onAbort = () => {
    failure = abortError();
    finish();
  };

  signal?.addEventListener("abort", onAbort, { once: true });

  // 必须先 listen 再 invoke：上游若回得极快，start/chunk 事件可能先于监听建立而丢失。
  const unlisten = await listen<ProviderStreamEvent>(eventName, (event) => {
    const payload = event.payload;
    if (payload.kind === "start") {
      status = payload.status ?? 200;
      return;
    }
    if (payload.kind === "chunk") {
      if (payload.chunk_base64) {
        parser.push(decoder.decode(decodeBase64Chunk(payload.chunk_base64), { stream: true }));
      }
      return;
    }
    if (payload.kind === "error") {
      failure = new Error(payload.message || "模型流式响应失败");
      finish();
      return;
    }
    // done
    finish();
  });

  void invoke<void>("request_provider_stream", {
    url,
    method: "POST",
    headers,
    body,
    eventName,
  }).catch((error: unknown) => {
    failure = error instanceof Error ? error : new Error(String(error));
    finish();
  });

  try {
    await finishedPromise;
  } finally {
    unlisten();
    signal?.removeEventListener("abort", onAbort);
  }

  if (failure) throw failure;
  if (status >= 400) throw new Error(httpErrorText(status, parser.text));
  return { text: parser.text, status };
}

/**
 * 浏览器路径（`npm run dev` 直接在浏览器里打开时走这里）。
 * 打包后的应用永远走 Tauri 路径；这条分支只为本地调试保留。
 */
async function streamViaFetch(options: TransportOptions): Promise<StreamChatResult> {
  const { url, headers, body, signal, onDelta } = options;
  const parser = createSseChatParser(onDelta);
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.body) {
    const raw = await response.text();
    parser.push(raw);
    parser.flush();
    if (!response.ok) throw new Error(httpErrorText(response.status, raw));
    return { text: parser.text, status: response.status };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    raw += text;
    parser.push(text);
  }
  parser.push(decoder.decode());
  parser.flush();

  if (!response.ok) throw new Error(httpErrorText(response.status, raw));
  return { text: parser.text, status: response.status };
}
