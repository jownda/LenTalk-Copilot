/**
 * AI 辅助层（P3）— 桌面端实现
 * 配置了 API Key 时使用远程 OpenAI 兼容 Chat Completions（OpenAI / DeepSeek / Kimi / 通义 / 智谱 / 自定义），
 * 未配置或请求失败时自动回退本地模板建议。
 */
import { buildDirectorDocumentLayers, compileDirectorSequence, DIRECTOR_LAYERS, DIRECTOR_LAYER_ORDER, getStyle, LocalSuggestionProvider, SHOT_TEMPLATES, localizedStyleBrief } from "../../engine";
import type { AIAssistant, AssetSuggestion, BeatSuggestion, ContinuityRepairIssue, ContinuityRepairPatch, FixSuggestion, SceneSuggestion } from "../../engine";
import { buildSceneAssetRegistry } from "../../engine/compiler/renderer";
import { fovToLegacyFocalLength, legacyFocalLengthToFov, lensByFov, lensById } from "../../engine/presets";
import { resolveImageDisplayUrl } from "@/features/canvas/application/imageData";
import { listen } from "@tauri-apps/api/event";
import { auditFinalPrompt, validateDirectorLayers } from "../../engine/quality";
import type {
  ActingObjective, ActionBeat, Asset, AssetActingProfile, AssetKind, AudioPlan, CameraBehavior, CameraMovement, CutStyle,
  LightingDirection, LockLevel, Optics, PhysicsAnchor, ProjectV2, SceneV2, ShotParticipant, ShotV2,
} from "../../shared-types";
import { isRemoteConfigured, loadAISettings, normalizeBaseUrl, openAICompatibleBaseUrl, type AISettings } from "./aiSettings";
import type { Locale } from "../i18n";

const localProvider = new LocalSuggestionProvider();


/** AI 编译 schema：只要求镜头执行结构和少量宏观决策。 */
export const SCENE_DRAFT_JSON_SCHEMA = `{
  "shots": [
    {
      "time": { "startSeconds": number, "endSeconds": number },
      "label": string,
      "framing": string,
      "lensModel": string | null,
      "camera": string | null,
      "optics": { "lensCharacter": "180-panoramic" | "135-immersive" | "107-ultrawide" | "84-wide" | "63-moderate-wide" | "47-standard" | "29-short-tele" | "18-tele" | "12-long-tele" | "8-supertele" | null, "fieldOfViewDegrees": number | null, "lensOutcome": string[] | null, "antiDriftLock": string | null },
      "cameraBehavior": { "height": string | null, "distance": string | null, "angle": string | null, "side": string | null, "subjectSize": string | null, "screenPlacement": string | null, "focusBehavior": string | null, "depthOfField": string | null, "handheldQuality": string | null },
      "physicsAnchors": [ { "kind": "walk" | "run" | "weapon" | "liquid" | "particle", "detail": string | null } ],
      "movement": string,
      "action": string,
      "acting": string,
      "performanceLevel": number,
      "eyeLife": string,
      "direction": "left-to-right" | "right-to-left",
      "cutStyle": "hard-cut" | "overlap" | "match-cut",
      "participants": [ { "characterId": string, "role": "primary" | "supporting" | "target" | "background", "position": string | null, "entrance": "already-in-frame" | "enters-left" | "enters-right" | null, "facing": string | null, "eyeline": string | null, "torsoFacing": string | null, "anchorDistance": string | null, "acting": string | null, "eyeLife": string | null } ],
      "beats": [ { "order": number, "startSeconds": number | null, "duration": number, "verb": string, "actorId": string | null, "targetCharacterId": string | null, "targetPropId": string | null, "targetBodyPart": string | null, "actionText": string | null, "dialogue": string | null, "propState": string | null, "audio": string | null, "tactic": string | null, "subtext": string | null, "beatChange": string | null, "reactionBeforeLine": string | null, "required": boolean, "forbiddenTargets": string[], "cutRule": string | null, "note": string | null } ],
      "propChangeDescription": string | null,
      "note": string | null
    }
  ],
  "macro": {
    "emotionArc": string | null,
    "lightingDirection": { "primarySource": string | null, "direction": string | null, "exposurePriority": string | null, "allowHighlights": string[], "forbid": string[] } | null
  }
}`;

export const CLEAN_SCENE_DRAFT_PROMPT_SCHEMA = SCENE_DRAFT_JSON_SCHEMA;

export type SceneCompileProgress = "idle" | "preparing" | "waiting" | "streaming" | "resuming" | "parsing" | "validating";
export type SceneCompileProgressListener = (stage: SceneCompileProgress, receivedChars?: number) => void;

/**
 * 长提示词生成允许模型持续返回较长时间。这个值只限制本地客户端等待，
 * 无法覆盖 API 中转平台自身的网关上限；stream=true 会尽量避免连接空闲。
 */
export const AI_RESPONSE_TIMEOUT_MS = 15 * 60 * 1000;

interface AIModelProxyPayload {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

interface ProviderStreamEvent {
  kind: "start" | "chunk" | "done" | "error";
  status?: number;
  chunk_base64?: string;
  message?: string;
}

function decodeBase64Chunk(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** 流式响应在生成中断时携带已经收到的内容，供用户反复续写直到完成。 */
export class ChatCompletionInterruptedError extends Error {
  readonly partialText: string;
  readonly resume?: () => Promise<unknown>;

  constructor(partialText: string, resume?: () => Promise<unknown>, message = "模型流式响应中断，已收到部分内容") {
    super(message);
    this.name = "ChatCompletionInterruptedError";
    this.partialText = partialText;
    this.resume = resume;
  }
}

/**
 * 本地预览（Vite / Tauri dev）下把请求转发给 dev server 的 /__ai_proxy，
 * 由本地中间件代替浏览器请求外部 API，绕过浏览器 CORS 限制；
 * 非浏览器环境（Tauri 打包版原生上下文）仍然使用原生 fetch。
 */
async function remoteFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    let body: unknown;
    if (typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const headers: Record<string, string> = {};
    if (init.headers instanceof Headers) {
      init.headers.forEach((value, key) => { headers[key] = value; });
    } else if (init.headers) {
      Object.assign(headers, init.headers);
    }

    const streamRequested = !!body && typeof body === "object" && (body as { stream?: unknown }).stream === true;
    if (streamRequested) {
      const eventName = `ai-provider-stream-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
      let unlisten: (() => void) | undefined;
      let started = false;
      let settled = false;
      let resolveStart: (status: number) => void = () => undefined;
      let rejectStart: (error: Error) => void = () => undefined;
      const startPromise = new Promise<number>((resolve, reject) => {
        resolveStart = resolve;
        rejectStart = reject;
      });
      const cleanup = () => {
        unlisten?.();
        unlisten = undefined;
      };
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controllerRef = controller;
        },
        cancel() {
          cleanup();
        },
      });

      try {
        unlisten = await listen<ProviderStreamEvent>(eventName, (event) => {
          const payload = event.payload;
          if (payload.kind === "start") {
            started = true;
            resolveStart(payload.status ?? 200);
            return;
          }
          if (payload.kind === "chunk" && payload.chunk_base64 && !settled) {
            controllerRef?.enqueue(decodeBase64Chunk(payload.chunk_base64));
            return;
          }
          if (payload.kind === "error") {
            const error = new Error(payload.message || "Provider stream failed");
            settled = true;
            if (!started) rejectStart(error);
            else controllerRef?.error(error);
            cleanup();
            return;
          }
          if (payload.kind === "done") {
            settled = true;
            if (!started) resolveStart(payload.status ?? 200);
            controllerRef?.close();
            cleanup();
          }
        });

        void invoke<void>("request_provider_stream", {
          url,
          method: init.method ?? "GET",
          headers,
          body,
          eventName,
        }).catch((error: unknown) => {
          const requestError = error instanceof Error ? error : new Error(String(error));
          settled = true;
          if (!started) rejectStart(requestError);
          else controllerRef?.error(requestError);
          cleanup();
        });

        const status = await startPromise;
        return new Response(stream, {
          status,
          statusText: status >= 200 && status < 300 ? "OK" : "Error",
          headers: { "Content-Type": "text/event-stream" },
        });
      } catch (error) {
        cleanup();
        throw error;
      }
    }

    // Do not fall through to fetch after a native request error: the provider
    // may already have accepted the billable request.
    const result = await invoke<{ status: number; body: string }>("request_provider_json", {
      url,
      method: init.method ?? "GET",
      headers,
      body,
    });
    return new Response(result.body, {
      status: result.status,
      statusText: result.status >= 200 && result.status < 300 ? "OK" : "Error",
      headers: { "Content-Type": "application/json" },
    });
  }
  const isEmbedded = typeof window !== "undefined" && window.self !== window.top;
  const useProxy = typeof window !== "undefined" && !isEmbedded && window.location.protocol.startsWith("http");
  if (!useProxy) return fetch(url, init);

  const headers: Record<string, string> = {};
  if (init.headers instanceof Headers) {
    init.headers.forEach((value, key) => { headers[key] = value; });
  } else if (init.headers) {
    Object.assign(headers, init.headers);
  }
  const controller = new AbortController();
  const abortFromSignal = () => controller.abort();
  if (init.signal?.aborted) controller.abort();
  else init.signal?.addEventListener("abort", abortFromSignal);
  const timer = setTimeout(() => controller.abort(), AI_RESPONSE_TIMEOUT_MS);
  try {
    const proxyResponse = await fetch("/__ai_proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        method: init.method ?? "GET",
        headers,
        body: typeof init.body === "string" ? init.body : undefined,
      } satisfies AIModelProxyPayload),
      signal: controller.signal,
    });
    const data = await proxyResponse.json().catch(() => ({})) as {
      status?: unknown;
      statusText?: unknown;
      headers?: Record<string, string>;
      bodyText?: unknown;
      error?: unknown;
    };
    // 本地代理已拿到上游响应（无论成功或 4xx/5xx）：
    // 原样透传状态码与正文，让上层能看到上游返回的真实错误内容，而不是只剩一个裸状态码。
    if (typeof data.status === "number" && typeof data.bodyText === "string") {
      return new Response(data.bodyText, {
        status: data.status,
        statusText: String(data.statusText ?? ""),
        headers: data.headers ?? {},
      });
    }
    // 本地代理本身失败（上游不可达 / 超时 / 解析失败）：抛出代理返回的具体原因。
    if (!proxyResponse.ok) {
      throw new Error(data.error ? String(data.error) : `本地代理 HTTP ${proxyResponse.status}`);
    }
    throw new Error(String(data.error ?? "本地代理响应异常"));
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", abortFromSignal);
  }
}

/** 从模型输出中提取 JSON（容忍 markdown fence / 前后杂质） */
function extractJSON<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  const arrayStart = candidate.indexOf("[");
  const arrayEnd = candidate.lastIndexOf("]");
  const objectStart = candidate.indexOf("{");
  const objectEnd = candidate.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    return JSON.parse(candidate.slice(objectStart, objectEnd + 1)) as T;
  }
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    return JSON.parse(candidate.slice(arrayStart, arrayEnd + 1)) as T;
  }
  throw new Error("模型返回内容不是有效 JSON");
}

/** 从 OpenAI 兼容的普通 JSON 或 SSE 流中提取模型文本。 */
export async function readChatCompletionText(response: Response, onChunk?: (receivedChars: number) => void): Promise<string> {
  const extractContent = (value: unknown): string => {
    if (!value || typeof value !== "object") return "";
    const choice = (value as { choices?: unknown[] }).choices?.[0];
    if (!choice || typeof choice !== "object") return "";
    const item = choice as { delta?: { content?: unknown }; message?: { content?: unknown }; text?: unknown };
    // `text` is used by a few OpenAI-compatible gateways even when the
    // endpoint is named /chat/completions. Keep it as a compatibility fallback
    // without exposing reasoning-only fields to the prompt.
    const content = item.delta?.content ?? item.message?.content ?? item.text;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") return (part as { text: string }).text;
        return "";
      }).join("");
    }
    return "";
  };

  if (!response.body) {
    const raw = await response.text();
    return extractContent(JSON.parse(raw) as unknown);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let raw = "";
  let content = "";
  let sawStreamEvent = false;
  let completed = false;
  const consumeLine = (line: string) => {
    raw += `${line}\n`;
    const payload = line.trim().startsWith("data:") ? line.trim().slice(5).trim() : "";
    if (!payload) return;
    if (line.trim().startsWith("data:")) sawStreamEvent = true;
    if (payload === "[DONE]") { completed = true; return; }
    try {
      const data = JSON.parse(payload) as { choices?: { finish_reason?: unknown }[] };
      content += extractContent(data);
      if (content) onChunk?.(content.length);
      if (data.choices?.[0]?.finish_reason) completed = true;
    } catch {
      // Keep the complete body for the ordinary JSON fallback below.
    }
  };

  try {
    while (true) {
      const chunk = await reader.read();
      pending += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      lines.forEach(consumeLine);
      // Some gateways send [DONE] and keep the HTTP connection alive with
      // heartbeat bytes. The model response is complete at this marker; do
      // not wait for the gateway to close the socket.
      if (completed) {
        await reader.cancel().catch(() => undefined);
        break;
      }
      if (chunk.done) break;
    }
  } catch (error) {
    if (content) throw new ChatCompletionInterruptedError(content);
    throw error;
  }
  if (pending) consumeLine(pending);
  if (sawStreamEvent && !completed) {
    // Without [DONE] we cannot distinguish a gateway that omits the marker
    // from a response truncated at EOF. Preserve the partial text so the
    // caller can use the existing continuation flow instead of silently
    // accepting an incomplete final prompt.
    if (content) throw new ChatCompletionInterruptedError(content);
    throw new Error("模型流式响应未正常结束");
  }
  if (content) return content;

  try {
    return extractContent(JSON.parse(raw.trim()) as unknown);
  } catch {
    return "";
  }
}

const STREAM_UNSUPPORTED_RE = /stream(?:ing)?(?:\s+parameter|\s+field)?[^\n]{0,80}(?:unsupported|not supported|unknown|invalid)|(?:unsupported|not supported|unknown|invalid)[^\n]{0,80}stream/i;

function continuationMessages(messages: unknown[], partialText: string): unknown[] {
  return [
    ...messages,
    { role: "assistant", content: partialText },
    {
      role: "user",
      content: "上一个回答的流式连接在此处中断。请从上一个 assistant 回答的最后一个字符之后继续，只输出尚未完成的后缀，不要重复已有内容，不要添加说明、代码围栏或开场白。",
    },
  ];
}

function mergeContinuationText(partialText: string, continuation: string): string {
  if (!partialText) return continuation;
  if (!continuation) return partialText;
  if (continuation.startsWith(partialText)) return continuation;
  const maxOverlap = Math.min(partialText.length, continuation.length);
  for (let length = maxOverlap; length >= 20; length -= 1) {
    if (partialText.slice(-length) === continuation.slice(0, length)) {
      return partialText + continuation.slice(length);
    }
  }
  return partialText + continuation;
}

async function chatCompletionsJSON(
  settings: AISettings,
  system: string,
  user: string,
  imageUrls: string[] = [],
  onProgress?: SceneCompileProgressListener,
  audioUrls: string[] = [],
): Promise<unknown> {
  const endpoint = `${openAICompatibleBaseUrl(settings.baseUrl)}/chat/completions`;
  const audioParts = await Promise.all(audioUrls.map((source) => audioSourceToInputPart(source)));
  const messages = [
    { role: "system", content: system },
    {
      role: "user",
      content: imageUrls.length > 0 || audioParts.length > 0
        ? [
            { type: "text", text: user },
            ...imageUrls.map((url) => ({ type: "image_url", image_url: { url } })),
            ...audioParts,
          ]
        : user,
    },
  ];
  const buildBody = (withJsonMode: boolean, streaming: boolean, requestMessages: unknown[] = messages) => ({
    model: settings.model.trim(),
    temperature: settings.temperature ?? 0.4,
    messages: requestMessages,
    stream: streaming,
    // 推理强度仅在选择 low/medium/high 时发送；默认不传，兼容非推理模型
    ...(settings.reasoningEffort ? { reasoning_effort: settings.reasoningEffort } : {}),
    ...(withJsonMode ? { response_format: { type: "json_object" as const } } : {}),
  });
  const request = (withJsonMode: boolean, streaming = true, requestMessages: unknown[] = messages) => remoteFetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey.trim()}`,
    },
    body: JSON.stringify(buildBody(withJsonMode, streaming, requestMessages)),
  });
  onProgress?.("waiting");
  let response = await request(true);
  // 部分 OpenAI 兼容服务/中转站不支持 response_format：
  // 有的直接返回 400，有的会把内层 400 包装成 502（Bad Gateway）。
  // 400 且正文提及 response_format 时，或 502 时，去掉 JSON 模式重试一次。
  if (response.status === 400 || response.status === 502) {
    const raw = await response.clone().text();
    if (response.status === 502 || /response_format|json_object/i.test(raw)) {
      onProgress?.("waiting");
      response = await request(false);
    } else if (STREAM_UNSUPPORTED_RE.test(raw)) {
      onProgress?.("waiting");
      response = await request(true, false);
    }
  } else if (response.status === 422) {
    const raw = await response.clone().text();
    if (STREAM_UNSUPPORTED_RE.test(raw)) {
      onProgress?.("waiting");
      response = await request(true, false);
    }
  }
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}${raw ? `：${raw.slice(0, 260)}` : ""}`);
  }
  try {
    const content = await readChatCompletionText(response, (receivedChars) => onProgress?.("streaming", receivedChars));
    if (!content) throw new Error("响应中没有文本内容");
    onProgress?.("parsing");
    try {
      return extractJSON(content);
    } catch (error) {
      // A gateway can close after sending a syntactically incomplete JSON
      // document. Keep it resumable instead of exposing a bare JSON.parse
      // error and losing the already received storyboard.
      const detail = error instanceof Error ? error.message : "JSON 解析失败";
      throw new ChatCompletionInterruptedError(content, undefined, `JSON 解析失败，已收到 ${content.length} 个字符：${detail}`);
    }
  } catch (error) {
    if (!(error instanceof ChatCompletionInterruptedError) || !error.partialText.trim()) throw error;
    const continueFrom = async (partialText: string): Promise<unknown> => {
      onProgress?.("resuming");
      let resumedResponse: Response;
      try {
        resumedResponse = await request(true, true, continuationMessages(messages, partialText));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new ChatCompletionInterruptedError(partialText, () => continueFrom(partialText), `续写请求失败，已保留 ${partialText.length} 个字符：${detail}`);
      }
      if (!resumedResponse.ok) {
        const raw = await resumedResponse.text().catch(() => "");
        throw new ChatCompletionInterruptedError(
          partialText,
          () => continueFrom(partialText),
          `续写请求 HTTP ${resumedResponse.status}${raw ? `：${raw.slice(0, 260)}` : ""}`,
        );
      }
      let resumed: string;
      try {
        resumed = await readChatCompletionText(resumedResponse, (receivedChars) => onProgress?.("resuming", partialText.length + receivedChars));
      } catch (resumeError) {
        if (resumeError instanceof ChatCompletionInterruptedError) {
          const merged = mergeContinuationText(partialText, resumeError.partialText);
          throw new ChatCompletionInterruptedError(merged, () => continueFrom(merged));
        }
        throw new ChatCompletionInterruptedError(partialText, () => continueFrom(partialText));
      }
      const merged = mergeContinuationText(partialText, resumed);
      try {
        return extractJSON(merged);
      } catch (parseError) {
        const detail = parseError instanceof Error ? parseError.message : "JSON 解析失败";
        throw new ChatCompletionInterruptedError(merged, () => continueFrom(merged), `JSON 解析仍未完成，已收到 ${merged.length} 个字符：${detail}`);
      }
    };
    return continueFrom(error.partialText);
  }
}

interface AudioInputPart {
  type: "input_audio";
  input_audio: { data: string; format: "wav" | "mp3" | "m4a" | "ogg" | "flac" };
}

function audioFormatFromSource(source: string, mimeType = ""): AudioInputPart["input_audio"]["format"] {
  const normalized = `${mimeType} ${source}`.toLowerCase();
  if (normalized.includes("wav")) return "wav";
  if (normalized.includes("m4a") || normalized.includes("mp4")) return "m4a";
  if (normalized.includes("ogg") || normalized.includes("oga")) return "ogg";
  if (normalized.includes("flac")) return "flac";
  return "mp3";
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function audioSourceToInputPart(source: string): Promise<AudioInputPart> {
  const trimmed = source.trim();
  if (!trimmed) throw new Error("声音音色音频为空，无法分析。");

  if (trimmed.startsWith("data:audio/")) {
    const match = trimmed.match(/^data:([^;,]+);base64,(.+)$/s);
    if (!match) throw new Error("声音音色音频不是有效的 Base64 音频数据。");
    return {
      type: "input_audio",
      input_audio: { data: match[2], format: audioFormatFromSource(trimmed, match[1]) },
    };
  }

  const response = await fetch(resolveImageDisplayUrl(trimmed));
  if (!response.ok) throw new Error(`无法读取声音音色音频（HTTP ${response.status}）。`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    type: "input_audio",
    input_audio: { data: bytesToBase64(bytes), format: audioFormatFromSource(trimmed, response.headers.get("content-type") ?? "") },
  };
}

/** Final delivery is prose, so it deliberately skips JSON mode and returns only the model text. */
async function chatCompletionsText(settings: AISettings, system: string, user: string, onProgress?: SceneCompileProgressListener, sourcePrompt = "", locale: Locale = "zh"): Promise<string> {
  const endpoint = `${openAICompatibleBaseUrl(settings.baseUrl)}/chat/completions`;
  const baseMessages = [{ role: "system", content: system }, { role: "user", content: user }];
  const request = (streaming: boolean, messages: unknown[] = baseMessages) => remoteFetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey.trim()}`,
    },
    body: JSON.stringify({
      model: settings.model.trim(),
      temperature: settings.temperature ?? 0.4,
      stream: streaming,
      ...(settings.reasoningEffort ? { reasoning_effort: settings.reasoningEffort } : {}),
      messages,
    }),
  });
  onProgress?.("waiting");
  let response = await request(true);
  if (!response.ok) {
    const raw = await response.clone().text().catch(() => "");
    if ((response.status === 400 || response.status === 422) && STREAM_UNSUPPORTED_RE.test(raw)) {
      response = await request(false);
    }
  }
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}${raw ? `：${raw.slice(0, 260)}` : ""}`);
  }
  try {
    const content = (await readChatCompletionText(response, (receivedChars) => onProgress?.("streaming", receivedChars))).trim();
    if (!content) throw new Error("响应中没有最终提示词文本");
    onProgress?.("parsing");
    return sanitizeFinalPromptResponse(content, sourcePrompt, locale);
  } catch (error) {
    if (!(error instanceof ChatCompletionInterruptedError) || !error.partialText.trim()) throw error;
    const continueFrom = async (partialText: string): Promise<string> => {
      onProgress?.("resuming");
      let resumedResponse: Response;
      try {
        resumedResponse = await request(true, continuationMessages(baseMessages, partialText));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new ChatCompletionInterruptedError(partialText, () => continueFrom(partialText), `续写请求失败，已保留 ${partialText.length} 个字符：${detail}`);
      }
      if (!resumedResponse.ok) {
        const raw = await resumedResponse.text().catch(() => "");
        throw new ChatCompletionInterruptedError(
          partialText,
          () => continueFrom(partialText),
          `续写请求 HTTP ${resumedResponse.status}${raw ? `：${raw.slice(0, 260)}` : ""}`,
        );
      }
      let resumed: string;
      try {
        resumed = await readChatCompletionText(resumedResponse, (receivedChars) => onProgress?.("resuming", partialText.length + receivedChars));
      } catch (resumeError) {
        if (resumeError instanceof ChatCompletionInterruptedError) {
          const merged = mergeContinuationText(partialText, resumeError.partialText);
          throw new ChatCompletionInterruptedError(merged, () => continueFrom(merged));
        }
        throw new ChatCompletionInterruptedError(partialText, () => continueFrom(partialText));
      }
      onProgress?.("parsing");
      return sanitizeFinalPromptResponse(mergeContinuationText(partialText, resumed).trim(), sourcePrompt, locale);
    };
    return continueFrom(error.partialText);
  }
}

/** Remove hidden reasoning emitted by models before the text reaches the prompt editor. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function promptClockToSeconds(value: string): number | undefined {
  const match = /^(\d+):(\d+(?:\.\d+)?)$/.exec(value.trim());
  if (!match) return undefined;
  const seconds = Number(match[2]);
  return Number.isFinite(seconds) ? Number(match[1]) * 60 + seconds : undefined;
}

interface CanonicalShotRange {
  number: number;
  start: number;
  end: number;
  startLabel: string;
  endLabel: string;
}

function canonicalShotRanges(sourcePrompt: string): CanonicalShotRange[] {
  const actionSource = extractPromptSection(sourcePrompt, sourcePrompt.includes("镜头执行：") ? "镜头执行" : "SHOT EXECUTION");
  const ranges: CanonicalShotRange[] = [];
  const pattern = /(?:^|\n)(?:SHOT\s+(\d+)|(镜头\s*)(\d+))\s+(\d+:\d+(?:\.\d+)?)[-–](\d+:\d+(?:\.\d+)?)[：:]/g;
  for (const match of actionSource.matchAll(pattern)) {
    const start = promptClockToSeconds(match[4]);
    const end = promptClockToSeconds(match[5]);
    if (start == null || end == null) continue;
    ranges.push({ number: Number(match[1] ?? match[3]), start, end, startLabel: match[4], endLabel: match[5] });
  }
  return ranges;
}

/** 最终模型偶尔会把分镜时间块压成平面时间线；按 canonical 镜头边界补回分段。 */
function restoreActionTimingSegments(text: string, sourcePrompt: string, locale: Locale): string {
  const ranges = canonicalShotRanges(sourcePrompt);
  if (ranges.length < 2) return text;
  const headingMatch = /(^|\n)(ACTION TIMING|动作节奏)\s*[:：]\s*\n/i.exec(text);
  if (!headingMatch) return text;
  const bodyStart = headingMatch.index + headingMatch[0].length;
  const nextHeading = /\n\n(?:活动引用|场景地图(?:和站位)?|首帧(?:与空间走位|与站位)?|格式模式|光学|摄像机|动作节奏|物理|光线|音频|风格|正向约束|负向约束|ACTIVE REFERENCES|SCENE MAP AND STAGING|LOCATION MAP|FIRST FRAME(?: AND SPATIAL BLOCKING)?|FORMAT MODE|OPTICS|CAMERA|ACTION TIMING|PHYSICS|LIGHTING|AUDIO|STYLE|POSITIVE CONSTRAINTS|NEGATIVE CONSTRAINTS)\s*[:：]\s*\n/igu;
  nextHeading.lastIndex = bodyStart;
  const nextMatch = nextHeading.exec(text);
  const bodyEnd = nextMatch?.index ?? text.length;
  const body = text.slice(bodyStart, bodyEnd);
  const hasAllSegmentHeadings = ranges.every((range) => new RegExp(
    locale === "zh" ? `第\\s*${range.number}\\s*段(?:\\s*[（(：:]|\\s*$)` : `SHOT\\s+${range.number}\\b`,
    "i",
  ).test(body));
  if (hasAllSegmentHeadings) return text;

  const lines = body.split("\n");
  const output: string[] = [];
  let lastRange = -1;
  for (const line of lines) {
    const existingHeading = locale === "zh"
      ? /^\s*第\s*(\d+)\s*段(?=\s|[（(：:]|$)/.exec(line)
      : /^\s*SHOT\s+(\d+)\b/i.exec(line);
    if (existingHeading) {
      const existingIndex = ranges.findIndex((range) => range.number === Number(existingHeading[1]));
      if (existingIndex >= 0) lastRange = existingIndex;
      output.push(line);
      continue;
    }
    const timeMatch = /^\s*(\d+:\d+(?:\.\d+)?)[–-](\d+:\d+(?:\.\d+)?)\s*[:：]/.exec(line);
    if (timeMatch) {
      const start = promptClockToSeconds(timeMatch[1]);
      const rangeIndex = start == null ? -1 : ranges.findIndex((range, index) => (
        start >= range.start - 0.001
        && (index === ranges.length - 1 ? start <= range.end + 0.001 : start < range.end - 0.001)
      ));
      if (rangeIndex >= 0 && rangeIndex !== lastRange) {
        const range = ranges[rangeIndex];
        output.push(locale === "zh"
          ? `第 ${range.number} 段（${range.startLabel}–${range.endLabel}）：`
          : `SHOT ${range.number} (${range.startLabel} to ${range.endLabel}):`);
        lastRange = rangeIndex;
      }
    }
    output.push(line);
  }
  return `${text.slice(0, bodyStart)}${output.join("\n")}${text.slice(bodyEnd)}`;
}

/** 将 canonical 活动引用中的图片标记同步到最终提示词的所有重复 @资产引用。 */
function restoreAssetImageTokens(text: string, sourcePrompt: string): string {
  const imageTokens = new Map<string, string>();
  const pattern = /@([^\s\x5b\x5d：:，,；;。.!！？?（）()]+)\s+\[image(\d+)\]/g;
  for (const match of sourcePrompt.matchAll(pattern)) imageTokens.set(match[1], `[image${match[2]}]`);
  let result = text;
  for (const [tag, token] of imageTokens) {
    const reference = new RegExp(`@${escapeRegExp(tag)}(?!\\s*\\[image\\d+\\])`, "g");
    result = result.replace(reference, `@${tag} ${token}`);
  }
  return result;
}

export function sanitizeFinalPromptResponse(text: string, sourcePrompt = "", locale: Locale = "zh"): string {
  let cleaned = text.replace(/\r\n?/g, "\n");
  cleaned = cleaned.replace(/<(think|analysis|reasoning)\b[^>]*>[\s\S]*?<\/\1>/gi, "");

  // Some reasoning models omit the closing tag. If the response contains a
  // canonical first heading, discard everything before that heading.
  if (/^\s*<(?:think|analysis|reasoning)\b[^>]*>/i.test(cleaned)) {
    const firstHeading = cleaned.search(/(?:^|\n)(?:风格|STYLE)\s*[:：]?\s*\n/i);
    cleaned = firstHeading >= 0 ? cleaned.slice(firstHeading).trim() : "";
  }

  cleaned = restoreCanonicalStyle(cleaned, sourcePrompt, locale);
  cleaned = restoreAssetImageTokens(restoreActionTimingSegments(cleaned, sourcePrompt, locale), sourcePrompt);
  return cleaned
    .replace(/^\s*```(?:text|markdown)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

async function chatJSON(settings: AISettings, system: string, user: string, onProgress?: SceneCompileProgressListener): Promise<unknown> {
  return chatCompletionsJSON(settings, system, user, [], onProgress);
}

const JSON_SYSTEM = "You are the structured planning engine for a cinematic AI video prompt studio. "
  + "Always answer with ONLY valid JSON matching the schema in the user message. "
  + "Do not add prose, markdown fences, or keys outside the schema.";

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** 解析 AI 修复补丁；只读取白名单字段，未知字段永不进入项目状态。 */
export function normalizeContinuityRepairPatch(value: unknown): ContinuityRepairPatch | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const patch = (raw.patch && typeof raw.patch === "object" && !Array.isArray(raw.patch) ? raw.patch : raw) as Record<string, unknown>;
  const result: ContinuityRepairPatch = {};
  const rawScene = patch.sceneUpdates;
  if (rawScene && typeof rawScene === "object" && !Array.isArray(rawScene)) {
    const scene = rawScene as Record<string, unknown>;
    const sceneUpdates: NonNullable<ContinuityRepairPatch["sceneUpdates"]> = {};
    if (typeof scene.environmentLock === "boolean") sceneUpdates.environmentLock = scene.environmentLock;
    if (typeof scene.weather === "string") sceneUpdates.weather = scene.weather.trim();
    if (typeof scene.negativePrompt === "string") sceneUpdates.negativePrompt = scene.negativePrompt.trim();
    if (scene.audioPlan && typeof scene.audioPlan === "object" && !Array.isArray(scene.audioPlan)) {
      const audio = scene.audioPlan as Record<string, unknown>;
      sceneUpdates.audioPlan = {
        ...(Array.isArray(audio.diegeticMusic) ? { diegeticMusic: asStringArray(audio.diegeticMusic) } : {}),
        ...(Array.isArray(audio.sfx) ? { sfx: asStringArray(audio.sfx) } : {}),
        ...(audio.score === "none" || audio.score === "original-score" ? { score: audio.score } : {}),
        ...(typeof audio.subtitles === "boolean" ? { subtitles: audio.subtitles } : {}),
      };
    }
    if (Object.keys(sceneUpdates).length > 0) result.sceneUpdates = sceneUpdates;
  }
  if (Array.isArray(patch.shotUpdates)) {
    type RepairShotUpdate = NonNullable<ContinuityRepairPatch["shotUpdates"]>[number];
    const shotUpdates: RepairShotUpdate[] = patch.shotUpdates.flatMap((item): RepairShotUpdate[] => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const rawShot = item as Record<string, unknown>;
      if (typeof rawShot.shotId !== "string" || !rawShot.shotId.trim()) return [];
      const next: NonNullable<ContinuityRepairPatch["shotUpdates"]>[number] = { shotId: rawShot.shotId.trim() };
      if (Array.isArray(rawShot.participantUpdates)) {
        next.participantUpdates = rawShot.participantUpdates.flatMap((participant) => {
          if (!participant || typeof participant !== "object" || Array.isArray(participant)) return [];
          const rawParticipant = participant as Record<string, unknown>;
          if (typeof rawParticipant.characterId !== "string" || !rawParticipant.characterId.trim()) return [];
          const update: NonNullable<NonNullable<ContinuityRepairPatch["shotUpdates"]>[number]["participantUpdates"]>[number] = { characterId: rawParticipant.characterId.trim() };
          for (const key of ["position", "facing", "eyeline"] as const) {
            if (typeof rawParticipant[key] === "string") update[key] = rawParticipant[key].trim();
          }
          if (rawParticipant.entrance === "already-in-frame" || rawParticipant.entrance === "enters-left" || rawParticipant.entrance === "enters-right") update.entrance = rawParticipant.entrance;
          return [update];
        });
      }
      if (Array.isArray(rawShot.characterOrder)) next.characterOrder = asStringArray(rawShot.characterOrder);
      if (typeof rawShot.intentionalAxisBreak === "boolean") next.intentionalAxisBreak = rawShot.intentionalAxisBreak;
      if (rawShot.direction === "left-to-right" || rawShot.direction === "right-to-left") next.direction = rawShot.direction;
      return [next];
    }) ?? [];
    if (shotUpdates.length > 0) result.shotUpdates = shotUpdates;
  }
  if (Array.isArray(patch.beatUpdates)) {
    const beatUpdates = patch.beatUpdates.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const rawBeat = item as Record<string, unknown>;
      if (typeof rawBeat.shotId !== "string" || typeof rawBeat.beatId !== "string") return [];
      const update: NonNullable<ContinuityRepairPatch["beatUpdates"]>[number] = { shotId: rawBeat.shotId.trim(), beatId: rawBeat.beatId.trim() };
      if (typeof rawBeat.targetCharacterId === "string") update.targetCharacterId = rawBeat.targetCharacterId.trim();
      if (typeof rawBeat.targetPropId === "string") update.targetPropId = rawBeat.targetPropId.trim();
      return [update];
    });
    if (beatUpdates.length > 0) result.beatUpdates = beatUpdates;
  }
  if (Array.isArray(patch.directorLayerUpdates)) {
    const directorLayerUpdates = patch.directorLayerUpdates.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const rawLayer = item as Record<string, unknown>;
      if ((rawLayer.layerKey !== "firstFrame" && rawLayer.layerKey !== "locationMap") || typeof rawLayer.text !== "string" || !rawLayer.text.trim()) return [];
      return [{ layerKey: rawLayer.layerKey as "firstFrame" | "locationMap", text: rawLayer.text.trim() }];
    });
    if (directorLayerUpdates.length > 0) result.directorLayerUpdates = directorLayerUpdates;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** 生成稳定随机 id */
function newId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `gen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 远程 AI Assistant：所有能力走 OpenAI 兼容接口，失败回退本地规则 */
class RemoteAssistant implements AIAssistant {
  private settings: AISettings;

  constructor(settings: AISettings) {
    this.settings = settings;
  }

  private async fallback<T>(action: (provider: AIAssistant) => Promise<T>): Promise<T> {
    try {
      return await action(this);
    } catch (error) {
      // 524 means the billable upstream request may have been accepted. Do not
      // silently submit a second local/remote attempt or hide that state.
      if (classifyError(error).kind === "gateway-timeout") throw error;
      return action(localProvider);
    }
  }

  async analyzeReferenceImage(input: { assetKind: AssetKind; name?: string; imageHint?: string }): Promise<AssetSuggestion> {
    return this.fallback(async () => {
      const data = await chatJSON(this.settings, JSON_SYSTEM, [
        "Return a JSON object for analyzing a reference image. Schema:",
        `{ "name": string, "description": string, "descriptionZh": string, "useFor": string[], "uniqueMarkers": string[], "lockLevel": "none" | "soft" | "strict" }`,
        "",
        `Asset kind: ${input.assetKind}${input.name ? `, suggested name: ${input.name}` : ""}${input.imageHint ? `, visual hint: ${input.imageHint}` : ""}`,
      ].join("\n"));
      const obj = data as Record<string, unknown>;
      return {
        name: asString(obj.name, input.name?.trim() || "UNNAMED ASSET"),
        description: asString(obj.description, `Canonical reference of ${input.name ?? "this asset"}.`),
        descriptionZh: asString(obj.descriptionZh, input.name ?? "资产基准参考"),
        useFor: asStringArray(obj.useFor),
        uniqueMarkers: asStringArray(obj.uniqueMarkers),
        lockLevel: obj.lockLevel === "strict" || obj.lockLevel === "soft" ? obj.lockLevel : "none",
      };
    });
  }

  async generateStructuredScene(input: { logline: string; assets: { id: string; name: string; kind: AssetKind }[]; shotCount: number }): Promise<SceneSuggestion> {
    return this.fallback(async () => {
      const allowedIds = SHOT_TEMPLATES.map((template) => template.id);
      const data = await chatJSON(this.settings, JSON_SYSTEM, [
        "Return structured storyboard advice. Schema:",
        `{ "name": string, "logline": string, "emotionArc": string, "locationHint": string, "characterOrder": string[], "shotTemplateIds": string[] }`,
        "",
        `Logline: ${input.logline || "(not provided)"}`,
        `Available assets: ${JSON.stringify(input.assets)}`,
        `Allowed shot template IDs: ${allowedIds.join(", ")}`,
        `Target shot count: ${input.shotCount}`,
        "Only use allowed shot template IDs, respect the target shot count, and order characters by on-screen priority.",
      ].join("\n"));
      const obj = data as Record<string, unknown>;
      const shotIds = asStringArray(obj.shotTemplateIds).filter((id) => allowedIds.includes(id));
      while (shotIds.length < Math.max(1, input.shotCount)) {
        shotIds.push(allowedIds[(shotIds.length - 1) % allowedIds.length]);
      }
      const characterIds = new Set(input.assets.map((asset) => asset.id));
      return {
        name: asString(obj.name),
        logline: asString(obj.logline, input.logline),
        emotionArc: asString(obj.emotionArc),
        locationHint: asString(obj.locationHint),
        characterOrder: asStringArray(obj.characterOrder).filter((id) => characterIds.has(id)),
        shotTemplateIds: shotIds.slice(0, Math.max(1, input.shotCount)),
      };
    });
  }

  async generateBeats(input: { logline: string; scene: SceneV2; participants: string[]; props: string[] }): Promise<BeatSuggestion[]> {
    return this.fallback(async () => {
      const data = await chatJSON(this.settings, JSON_SYSTEM, [
        "Return an array of dramatic beats. Schema:",
        `[{ "order": number, "verb": string, "actorId"?: string, "targetCharacterId"?: string, "targetPropId"?: string, "targetBodyPart"?: string, "actionText"?: string, "required"?: boolean, "forbiddenTargets": string[], "stateBefore"?: [{ "propId": string, "state": string }], "stateAfter"?: [{ "propId": string, "state": string }] }]`,
        "",
        `Logline: ${input.logline}`,
        `Scene: ${JSON.stringify(input.scene)}`,
        `Participants: ${JSON.stringify(input.participants)}`,
        `Props: ${JSON.stringify(input.props)}`,
        "Return 2-6 beats with sequential order starting at 1.",
      ].join("\n"));
      if (!Array.isArray(data)) throw new Error("模型未返回节拍数组");
      return data.map((beat, index): BeatSuggestion => {
        const obj = (beat ?? {}) as Record<string, unknown>;
        return {
          order: asNumber(obj.order, index + 1),
          verb: asString(obj.verb, "acts"),
          actorId: asString(obj.actorId, undefined),
          targetCharacterId: asString(obj.targetCharacterId, undefined),
          targetPropId: asString(obj.targetPropId, undefined),
          targetBodyPart: asString(obj.targetBodyPart, undefined),
          actionText: asString(obj.actionText, undefined),
          required: obj.required === true,
          forbiddenTargets: asStringArray(obj.forbiddenTargets),
          stateBefore: Array.isArray(obj.stateBefore) ? obj.stateBefore.map((item) => ({ propId: asString((item as Record<string, unknown>).propId), state: asString((item as Record<string, unknown>).state) })) : undefined,
          stateAfter: Array.isArray(obj.stateAfter) ? obj.stateAfter.map((item) => ({ propId: asString((item as Record<string, unknown>).propId), state: asString((item as Record<string, unknown>).state) })) : undefined,
        };
      });
    });
  }

  async repairContinuity(input: { issue: ContinuityRepairIssue; project: ProjectV2; scene: SceneV2; shot?: ShotV2 }): Promise<FixSuggestion> {
    return this.fallback(async () => {
      const data = await chatJSON(this.settings, JSON_SYSTEM, [
        "Return one narrowly scoped continuity repair. Schema:",
        `{ "code": string, "label": string, "detail": string, "apply": string, "patch": { "sceneUpdates"?: { "environmentLock"?: boolean, "weather"?: string, "negativePrompt"?: string, "audioPlan"?: { "diegeticMusic"?: string[], "sfx"?: string[], "score"?: "none" | "original-score", "subtitles"?: boolean } }, "shotUpdates"?: [{ "shotId": string, "participantUpdates"?: [{ "characterId": string, "position"?: string, "entrance"?: "already-in-frame" | "enters-left" | "enters-right", "facing"?: string, "eyeline"?: string }], "characterOrder"?: string[], "intentionalAxisBreak"?: boolean, "direction"?: "left-to-right" | "right-to-left" }], "beatUpdates"?: [{ "shotId": string, "beatId": string, "targetCharacterId"?: string, "targetPropId"?: string }], "directorLayerUpdates"?: [{ "layerKey": "firstFrame" | "locationMap", "text": string }] } | null }`,
        "",
        `Issue: ${JSON.stringify(input.issue)}`,
        `Scene: ${JSON.stringify({ id: input.scene.id, name: input.scene.name, shootingMode: input.scene.shootingMode, environmentLock: input.scene.environmentLock, weather: input.scene.weather, audioPlan: input.project.audioPlan, shots: input.scene.shots.map((candidate) => ({ id: candidate.id, label: candidate.label, direction: candidate.direction, participants: candidate.participants, layout: candidate.layout, beats: candidate.beats, action: candidate.action, note: candidate.note })) })}`,
        `Assets: ${JSON.stringify((input.project.assets ?? []).map((asset) => ({ id: asset.id, name: asset.name, kind: asset.kind, referenceTag: asset.referenceTag })))}`,
        `Relevant director layer: ${input.issue.layerKey ? JSON.stringify(input.scene.directorLayers?.[input.issue.layerKey] ?? "") : "none"}`,
        `Shot label: ${input.shot?.label ?? input.scene.shots.find((candidate) => candidate.id === input.issue.shotId || candidate.id === input.issue.entityId)?.label ?? input.scene.name}`,
        "Keep code identical to the issue code. Return patch=null when a safe local change cannot be determined.",
        "The patch may touch only the fields shown in the schema, only the current scene, only existing shot/beat/character/prop IDs, and only firstFrame or locationMap text when the issue layerKey matches. Never add assets, characters, props, IDs, unrelated prose, or a whole-scene rewrite.",
        "For a spatial conflict, prefer a precise participant position/entrance/order change. For a director-layer conflict, return only the corrected layer text and preserve all unrelated facts.",
      ].join("\n"));
      const obj = data as Record<string, unknown>;
      return {
        code: input.issue.code,
        label: asString(obj.label, input.issue.label ?? input.issue.code),
        detail: asString(obj.detail, "Review this continuity issue before export."),
        apply: asString(obj.apply, "Manually resolve the conflicting fields before export."),
        patch: normalizeContinuityRepairPatch(obj.patch),
      };
    });
  }

  async generateAuditRepairText(input: { code: string; locale: "zh" | "en"; generateFor: "acting" | "first-frame" | "voice" | "beats" | "replan"; scene: SceneV2; shot?: ShotV2; characterName?: string; issueSummary: string }): Promise<{ text: string }> {
    return this.fallback(async () => {
      const language = input.locale === "zh" ? "中文，短句，可直接粘贴" : "English, short clauses, ready to paste";
      const target = input.generateFor === "acting"
        ? "把当前镜头唯一的抽象情绪重写为可拍摄行为：眼神落点、呼吸节拍、手部/肩部动作、姿势转折。只输出一段表演描述，不输出其他字段。"
        : input.generateFor === "first-frame"
          ? "为场景生成一个首帧占位锁语句：明确谁可见、位于何处、先完成什么，再开始运镜。只输出占位文案。"
          : input.generateFor === "voice"
            ? `为开口角色生成一段稳定的声音锁公式（音色、语速、重音、情绪变化时的处理），保证跨镜头声音稳定。只输出声音锁文本。${input.characterName ? `角色：${input.characterName}` : ""}`
            : input.generateFor === "replan"
              ? "给出重新分镜的原则性安排：控制镜头数量与总时长使其符合场景上限，慢节奏少分镜、长镜头一镜到底。只输出分镜原则，不输出最终提示词。"
              : "为镜头生成 1-3 个简洁动作节拍描述，每个节拍都是可见动作。只输出节拍文本。";
      const data = await chatJSON(this.settings, JSON_SYSTEM, [
        "Return JSON text for auditing repair. Schema:",
        `{ "text": string }`,
        "",
        `Language: ${language}`,
        `Issue: [${input.code}] ${input.issueSummary}`,
        `Scene name: ${input.scene.name}`,
        `Shot label: ${input.shot?.label ?? "(whole scene)"}`,
        `Scene context: ${input.scene.logline || input.scene.duration || "(none)"}`,
        `Task: ${target}`,
        "Rules: return only the replacement text; keep it below 120 words; no markdown, no surrounding explanation.",
      ].join("\n"));
      const obj = data as Record<string, unknown>;
      const text = asString(obj.text, "").trim();
      if (!text) throw new Error("模型未返回修复文本");
      return { text };
    });
  }
}

export interface AIConnectionTestResult {
  ok: boolean;
  model?: string;
  error?: string;
  errorKind?: AIModelErrorKind;
}

export interface AvailableModelsResult {
  ok: boolean;
  models?: string[];
  error?: string;
  errorKind?: AIModelErrorKind;
}

export type AIModelErrorKind = "base" | "network" | "timeout" | "gateway-timeout" | "http" | "empty" | "other";

/** 图片 / 视频生成类模型特征词；名称不含这些特征的多模态大模型保留 */
const NON_CHAT_MODEL_RE = /(gpt-image|dall-e|dalle|sora|\bveo\b|seedance|flux|stable-diffusion|midjourney|imagen|jimeng|kling|runway|pika|pixeldance|pixel-dance|muse|nano-banana|wanx|wan[.\d-]|hailuo|luma|hunyuan-image|hunyuan-video|cogview|cogvideo|kolors|marigold|deepfloyd|wuerstchen|sana|pixart|sd\d+|sdxl|image-preview|image-generation|text-to-video|image-to-video|\bt2v\b|\bi2v\b|\btts\b|whisper|\bttv\b|video)/i;

function isLikelyLanguageModel(id: string): boolean {
  return !NON_CHAT_MODEL_RE.test(id);
}

/** 兼容 OpenAI「{data:[{id}]}」与部分中转「顶层数组 / 字符串数组 / models 字段」的返回结构 */
function extractModelIds(raw: unknown): string[] {
  const candidates: unknown[][] = [];
  if (Array.isArray(raw)) candidates.push(raw);
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const key of ["data", "models", "list", "items", "result"]) {
      if (Array.isArray(obj[key])) candidates.push(obj[key] as unknown[]);
    }
  }
  const ids: string[] = [];
  for (const candidate of candidates) {
    for (const item of candidate) {
      if (typeof item === "string" && item.trim()) ids.push(item.trim());
      else if (item && typeof item === "object") {
        const id = (item as Record<string, unknown>).id;
        if (typeof id === "string" && id.trim()) ids.push(id.trim());
      }
    }
  }
  return Array.from(new Set(ids));
}

export function classifyError(error: unknown): { kind: AIModelErrorKind; message: string } {
  const err = error instanceof Error ? error : new Error(String(error));
  const message = err.message || String(error);
  let kind: AIModelErrorKind = "other";
  // 504 is the standard gateway timeout and 524 is Cloudflare's upstream
  // timeout. Either may mean the provider received the request, so callers
  // must not silently retry or fall back and risk duplicate billing.
  if (/^HTTP (?:504|524)(?:\D|$)/i.test(message)) kind = "gateway-timeout";
  else if (/^HTTP \d+/.test(message)) kind = "http";
  else if (err.name === "AbortError" || /time\s*out|abort|被中止|操作已取消|操作已中止|请求被取消/i.test(message)) kind = "timeout";
  else if (err instanceof TypeError || /failed to fetch|networkerror|load failed|fetch failed|network request failed/i.test(message)) kind = "network";
  else if (/未返回|empty|no models/i.test(message)) kind = "empty";
  return { kind, message };
}

const MODEL_LIST_TIMEOUT_MS = 45_000;

async function fetchModelList(
  url: string,
  apiKey: string,
): Promise<{ ok: true; ids: string[] } | { ok: false; error: unknown }> {
  try {
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), MODEL_LIST_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const response = await remoteFetch(url, { method: "GET", headers, signal: controller.signal });
      if (!response.ok) {
        const raw = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status}${raw ? `：${raw.slice(0, 220)}` : ""}`);
      }
      const raw = await response.json().catch(() => ({}));
      const ids = extractModelIds(raw).filter(isLikelyLanguageModel);
      if (ids.length === 0) throw new Error("接口未返回可用模型");
      return { ok: true, ids };
    } finally {
      globalThis.clearTimeout(timer);
    }
  } catch (error) {
    return { ok: false, error };
  }
}

/** 拉取接口可用语言模型（GET {baseUrl}/v1/models 等）；Key 为空时也允许尝试（部分中转不需要鉴权） */
export async function fetchAvailableModels(settings: AISettings): Promise<AvailableModelsResult> {
  const base = normalizeBaseUrl(settings.baseUrl);
  if (!base) return { ok: false, errorKind: "base", error: "Base URL 为空" };
  const candidates = Array.from(new Set([
    `${openAICompatibleBaseUrl(base)}/models`,
    `${base}/models`,
  ].filter(Boolean)));
  const apiKey = settings.apiKey.trim();
  let lastError: unknown = new Error("unknown");
  for (const url of candidates) {
    const result = await fetchModelList(url, apiKey);
    if (result.ok) return { ok: true, models: result.ids };
    lastError = result.error;
  }
  const classified = classifyError(lastError);
  return { ok: false, errorKind: classified.kind, error: classified.message };
}

/** 用最小请求测试连接（不保存配置） */
export async function testAIConnection(settings: AISettings): Promise<AIConnectionTestResult> {
  const endpoint = `${openAICompatibleBaseUrl(settings.baseUrl)}/chat/completions`;
  try {
    const response = await remoteFetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey.trim()}`,
      },
      body: JSON.stringify({
        model: settings.model.trim(),
        temperature: 0,
        messages: [{ role: "user", content: "Ping. Reply with exactly: OK" }],
      }),
    });
    if (!response.ok) {
      const raw = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}${raw ? `：${raw.slice(0, 220)}` : ""}`);
    }
    const data = await response.json() as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content ?? "";
    return { ok: /ok/i.test(content), model: settings.model.trim() };
  } catch (error) {
    const classified = classifyError(error);
    return { ok: false, error: classified.message, errorKind: classified.kind };
  }
}

/** 获取 AI Provider：有 Key 时用远程模型，否则本地建议 */
export function getAssistant(): AIAssistant {
  const settings = loadAISettings();
  if (settings.provider === "none" || !settings.apiKey.trim() || !settings.model.trim() || !settings.baseUrl.trim()) {
    return new LocalSuggestionProvider();
  }
  return new RemoteAssistant(settings);
}

const FILL_ASSET_KIND_HINTS: Record<AssetKind, string> = {
  character: "This is a CHARACTER. Describe the person strictly by what is visible in the reference image(s): identity/anatomy, face, hair, build, outfit, and any permanent or recurring markers. Ignore transient pose, background, lighting, and camera setup.",
  location: "This is a LOCATION / ENVIRONMENT. Describe the physical space strictly by what is visible: architecture, materials, layout, lighting fixtures, color palette, period, and atmosphere. Ignore people, props that are not part of the space, and camera setup.",
  prop: "This is a PROP object. Describe the object strictly by what is visible: shape, size, material, texture, colors, branding/text (if legible), and state. Ignore the background and any people.",
  "style-reference": "This is a STYLE / VISUAL REFERENCE. Describe the consistent visual style, palette, lighting logic, texture/grain, and composition principles visible in the image, not the specific subjects.",
  "audio-reference": "This is an AUDIO / VOICE REFERENCE. The user has uploaded images only if visual notes exist; describe the audible or intended tone, texture, pacing and aesthetic goals, otherwise return the name and a neutral description.",
};

const LOCK_LEVEL_VALUES: LockLevel[] = ["none", "soft", "strict"];

/**
 * AI 填写详细：结合已上传参考图，把资产卡片中的描述类字段一次填完整。
 * 返回可直接 UPDATE_ASSET 的 Partial<Asset>（不含 id / kind）。
 * @throws 未配置远程模型 / 没有参考图 / 请求失败
 */
export async function fillAssetDetails(asset: Asset, locale: Locale): Promise<Partial<Asset>> {
  const settings = loadAISettings();
  if (!isRemoteConfigured(settings)) {
    throw new Error("AI 未配置，请先在 LenTalk「设置 → 密钥」中配置 Chat 模型与 API Key。");
  }
  const images = (asset.referencePaths ?? []).slice(0, 4);
  const audioUrls = asset.kind === "character" && asset.voiceClip?.trim() ? [asset.voiceClip.trim()] : [];
  if (images.length === 0 && audioUrls.length === 0) {
    throw new Error("请先添加参考图或角色声音音色音频，AI 才能填写详细。");
  }

  const isZh = locale === "zh";
  const language = isZh ? "Simplified Chinese (中文)" : "English";
  const descriptionField = isZh ? "descriptionZh" : "description";
  const masterField = isZh ? "masterProfileZh" : "masterProfile";
  const voiceField = isZh ? "voicePromptZh" : "voicePrompt";
  const isCharacter = asset.kind === "character";

  const existing = {
    name: asset.name?.trim() || "",
    description: asset.description?.trim() || "",
    descriptionZh: asset.descriptionZh?.trim() || "",
    notes: asset.notes?.trim() || "",
    notesZh: asset.notesZh?.trim() || "",
    useFor: asset.useFor ?? [],
    ignore: asset.ignore ?? [],
    uniqueMarkers: asset.uniqueMarkers ?? [],
    alwaysVisible: asset.alwaysVisible ?? [],
    forbiddenConfusions: asset.forbiddenConfusions ?? [],
    tags: asset.tags ?? [],
    lockLevel: asset.lockLevel,
  };

  const actingSchema = isCharacter
    ? `, "actingProfile": { "${masterField}": string, "${voiceField}": string, "performanceTarget": number }`
    : "";
  const characterRules = isCharacter
    ? [
        `- actingProfile.${masterField}: the character's compact acting master template in ${language}. It must contain 5-7 concise clauses about observable face, body, voice, and movement only; never include wardrobe, costume, camera, framing, lens, lighting, color, or grade.`,
        `- actingProfile.${voiceField}: the character's voice-lock formula in ${language} (paste it verbatim when the character speaks).`,
        "- actingProfile.performanceTarget: integer 0-5. After writing the master profile, self-score it (0 mannequin / 1 reciting / 2 diligent / 3 craftsman / 4 alive / 5 magnet). If your self-score is below 4, rewrite the master profile until it reaches 4, then set performanceTarget to that final score (default 4).",
      ]
    : [];

  const data = await chatCompletionsJSON(settings, JSON_SYSTEM, [
    "You are filling in a production asset card for a cinematic AI video prompt studio.",
    `Answer ONLY in ${language}.`,
    "Analyze the attached reference image(s) carefully. Every visual field must be grounded in what you can see (or, for style refs, derive consistently) — no invented details.",
    "",
    FILL_ASSET_KIND_HINTS[asset.kind],
    `User notes (${language}, AI reference only; never copy this field into the final prompt): ${isZh ? (asset.notesZh?.trim() || "(none)") : (asset.notes?.trim() || "(none)")}`,
    "",
    "Return ONLY a JSON object with this exact schema:",
    `{ "name": string, "${descriptionField}": string, "useFor": string[], "ignore": string[], "uniqueMarkers": string[], "alwaysVisible": string[], "forbiddenConfusions": string[], "tags": string[], "lockLevel": "none" | "soft" | "strict"${actingSchema} }`,
    "",
    "Field rules:",
    "- name: short production name; keep it in ALL-CAPS style like REIN / BAKERY INTERIOR / BOOMBOX.",
    `- ${descriptionField}: canonical description in ${language}, 1-3 sentences, precise and reusable in a prompt.`,
    "- useFor: pick from the asset-type vocabulary — character: [\"face\",\"body\",\"wardrobe\",\"appearance\"], location: [\"environment\",\"appearance\"], prop / style-reference / audio-reference: [\"appearance\"]. Keep these tokens in English.",
    "- ignore: pick only what should be ignored, from [\"pose\",\"background\",\"lighting\",\"composition\",\"expression\"]. Keep these tokens in English.",
    `- uniqueMarkers: distinctive permanent visual markers, each a short phrase in ${language}.`,
    `- alwaysVisible: objects/clothing that must always remain visible, each a short phrase in ${language}.`,
    `- forbiddenConfusions: other known assets this one is easily confused with, in ${language}, or empty if none.`,
    `- tags: 2-5 short production tags in ${language}.`,
    "- lockLevel: \"strict\" only for a character whose identity must be exact, \"soft\" for suggested lock, else \"none\".",
    ...(isCharacter
      ? [
          "ACTING MASTER PROFILE RULES (mandatory):",
          "1. Only observable behavior. Translate every inner state into a body marker: breath, swallow, lip, jaw, eyes, blink, hands, shoulders, posture, weight, tempo, distance, or voice delivery. Never leave an emotion as an unsupported label such as nervous or angry.",
          "2. Every habit or tic must include its trigger in the same clause: [visible tic] + [when/why]. A generic trigger category is enough; do not invent a long scene event.",
          "3. Name the gait with a short quoted name, then unpack its biomechanics: weight distribution, step length, torso and arms, and head position.",
          "4. Include one compact mask-and-crack clause: [stable facade]. However, when [short trigger type such as challenged / loss of control / core relationship touched] — [visible change]. The trigger may be general, not a specific plot event.",
          "5. Give exactly one softening target when it fits the character; omit it when it does not. Never list two or more targets.",
          "6. No wardrobe or costume. No camera, framing, optics, lens, lighting, color, grade, or visual style. Those belong elsewhere in the prompt.",
          "7. Use physique as biography: age or age impression, build, and posture should reveal profession, past injury, past struggle, or self-image where supported by the user's notes. Keep it compact.",
        ]
      : []),
    ...characterRules,
    ...(isCharacter && audioUrls.length > 0
      ? [
          "VOICE LOCK PRIORITY: The attached voice audio is the primary evidence for acoustic traits. Listen to and sample the audio first. If the user's notes explicitly state the character's age or accent, use those stated facts directly; otherwise infer them only when reasonably supported by the audio, and state that they cannot be determined when they are not reliable. User notes may add explicit creative constraints, but must not override audible pitch, register, resonance, timbre, articulation, or delivery.",
          isZh
            ? "voicePromptZh 必须只输出一段简洁、准确、可执行的中文声音锁，并严格按此顺序：年龄/年龄感，口音，成年男性或女性及声部，基频约多少 Hz 及常态集中区间，声音重心，音色与明暗，中低频共鸣，泛音密度，高频气声与齿音，整体听感与压力下的说话变化，最后写保持项与避免项。基频和区间必须根据音频估计并使用 Hz；如果用户备注明确标明年龄或口音，直接采用备注中的表述；如果备注没有标明，再根据音频判断，无法可靠判断时写‘无法从音频确定’，不要臆造。参考格式：26岁，南方闽南口音，成年男性低男中音，基频约103–150 Hz，常态集中在110–120 Hz。声音重心位于低频至中低频，音色温厚、偏暗、稳定，不明亮尖锐；中低频共鸣明显，泛音密度适中，高频气声与齿音较弱，整体听感沉着、克制、理性，压力下会加快吐字。保持低男中音和一致的声带厚度，避免变尖、变薄或出现少年感。"
            : "voicePrompt must be one concise, accurate, executable voice-lock paragraph in this order: age or perceived age, accent, adult gender and register, estimated fundamental frequency in Hz and normal concentration range, vocal-weight center, timbre brightness, low-mid resonance, overtone density, breathiness and sibilance, overall impression and pressure delivery change, then preserve and avoid constraints. Estimate F0 from the audio and state it in Hz. If the user notes explicitly state the age or accent, use those stated facts directly; if they do not, infer only when reasonably supported by the audio, otherwise say it cannot be determined instead of inventing it.",
        ]
      : []),
    ...(isCharacter
      ? ["For a character, absorb the user's personality, motivation, speaking habits, and voice notes into actingProfile.masterProfile and actingProfile.voicePrompt; do not output the notes field itself."]
      : ["For this asset, use the user notes only to disambiguate the image and improve the canonical description; do not output the notes field itself."]),
    "",
    `Asset kind: ${asset.kind}`,
    "Current values already filled by the user (keep them unless the reference evidence clearly contradicts them): " + JSON.stringify(existing),
    "",
    "Do NOT add prose or keys outside the schema.",
  ].join("\n"), images, undefined, audioUrls);

  const obj = (data ?? {}) as Record<string, unknown>;
  const lockLevel = asString(obj.lockLevel, "none") as LockLevel;
  const actingRaw = (obj.actingProfile ?? {}) as Record<string, unknown>;

  const patch: Partial<Asset> = {
    name: asString(obj.name, existing.name),
    useFor: asStringArray(obj.useFor).filter((value) => ["face", "body", "wardrobe", "appearance", "environment"].includes(value)),
    ignore: asStringArray(obj.ignore).filter((value) => ["pose", "background", "lighting", "composition", "expression"].includes(value)),
    uniqueMarkers: asStringArray(obj.uniqueMarkers).slice(0, 12),
    alwaysVisible: asStringArray(obj.alwaysVisible).slice(0, 12),
    forbiddenConfusions: asStringArray(obj.forbiddenConfusions).slice(0, 8),
    tags: asStringArray(obj.tags).slice(0, 8),
    lockLevel: LOCK_LEVEL_VALUES.includes(lockLevel) ? lockLevel : "none",
  };

  if (isZh) {
    patch.descriptionZh = asString(obj.descriptionZh, existing.descriptionZh);
  } else {
    patch.description = asString(obj.description, existing.description);
  }

  if (isCharacter) {
    const performanceTarget = Math.max(0, Math.min(5, Math.round(asNumber(actingRaw.performanceTarget, 4))));
    const actingProfile: AssetActingProfile = { performanceTarget };
    if (isZh) {
      actingProfile.masterProfileZh = asString(actingRaw.masterProfileZh);
      actingProfile.voicePromptZh = asString(actingRaw.voicePromptZh);
    } else {
      actingProfile.masterProfile = asString(actingRaw.masterProfile);
      actingProfile.voicePrompt = asString(actingRaw.voicePrompt);
    }
    patch.actingProfile = actingProfile;
  }

  return patch;
}

/** User-facing brief fields are AI planning reference only and never compile directly into the final prompt. */
export interface SceneBriefOptimization {
  mustHappen: string[];
  forbid: string[];
  dialogue?: string;
  emotionArc?: string;
  actingObjectives: ActingObjective[];
  audioPlan: AudioPlan;
}

export async function optimizeSceneBrief(project: ProjectV2, scene: SceneV2, locale: Locale): Promise<SceneBriefOptimization> {
  const settings = loadAISettings();
  if (!isRemoteConfigured(settings)) {
    throw new Error("AI 未配置，请先在 LenTalk「设置 → 自定义平台」配置 Chat 模型与 API Key，再在「AI编译提示词」左侧选择模型。");
  }
  const language = locale === "zh" ? "Simplified Chinese (中文)" : "English";
  const assets = new Map((project.assets ?? []).map((asset) => [asset.id, asset]));
  const characterIds = new Set(collectSceneAssetIds(project, scene).filter((id) => assets.get(id)?.kind === "character"));
  const propIds = new Set(collectSceneAssetIds(project, scene).filter((id) => assets.get(id)?.kind === "prop"));
  const existing = {
    mustHappen: scene.mustHappen ?? [],
    forbid: scene.forbid ?? [],
    dialogue: scene.dialogue ?? "",
    emotionArc: scene.emotionArc ?? "",
    actingObjectives: scene.actingObjectives ?? [],
    audioPlan: project.audioPlan ?? { score: "none", subtitles: false },
  };
  const data = await chatJSON(settings, JSON_SYSTEM, [
    "You optimize the user-reference fields of a cinematic scene brief. Do NOT create a shot list, director layers, final prompt, negative prompt, camera plan, or asset descriptions.",
    `Return ONLY ${language}. These fields help the later storyboard AI understand intent; none of them is copied directly into the final prompt.`,
    "Preserve useful user input, fill missing information, and keep every suggestion concrete, concise, and consistent with the current story.",
    "",
    `Scene logline: ${scene.logline?.trim() || "(empty)"}`,
    `Prior context: ${scene.staging?.priorContext?.trim() || "(empty)"}`,
    `Location and staging: ${scene.location}; ${scene.staging?.anchorDescription?.trim() || "(none)"}`,
    `Duration / shooting mode: ${scene.duration}; ${scene.shootingMode === "multi-shot" ? "multi-shot" : "one continuous long take"}`,
    `Available characters: ${[...characterIds].map((id) => `${assets.get(id)?.name ?? id}(${id})`).join(", ") || "(none)"}`,
    `Available props: ${[...propIds].map((id) => `${assets.get(id)?.name ?? id}(${id})`).join(", ") || "(none)"}`,
    `Current user-reference values: ${JSON.stringify(existing)}`,
    "",
    "Return exactly this JSON schema:",
    '{ "mustHappen": string[], "forbid": string[], "dialogue": string, "emotionArc": string, "actingObjectives": [{ "characterId": string, "objective": string, "superObjective": string | null, "obstacle": string | null, "stakes": string | null }], "audioPlan": { "diegeticMusic": string[], "sfx": string[], "score": "none" | "original-score", "subtitles": boolean, "musicSourcePropId": string | null } }',
    "Rules: mustHappen and forbid each contain at most 6 visible, story-relevant items. dialogue contains only lines intended for this scene. emotionArc describes a concise, camera-readable progression. actingObjectives use only available character IDs and give each active character a playable objective; omit inactive characters. Audio is planning reference only: use score none when no music is justified, and musicSourcePropId only when it is one of the available prop IDs.",
  ].join("\n"));
  const value = (data ?? {}) as Record<string, unknown>;
  const objectives: ActingObjective[] = [];
  for (const raw of Array.isArray(value.actingObjectives) ? value.actingObjectives : []) {
    const item = (raw ?? {}) as Record<string, unknown>;
    const characterId = asString(item.characterId);
    const objective = asString(item.objective);
    if (!characterIds.has(characterId) || !objective) continue;
    const superObjective = asString(item.superObjective, undefined);
    const obstacle = asString(item.obstacle, undefined);
    const stakes = asString(item.stakes, undefined);
    objectives.push({
      characterId,
      objective,
      ...(superObjective ? { superObjective } : {}),
      ...(obstacle ? { obstacle } : {}),
      ...(stakes ? { stakes } : {}),
    });
  }
  const audioRaw = (value.audioPlan ?? {}) as Record<string, unknown>;
  const sourcePropId = asString(audioRaw.musicSourcePropId, undefined);
  const score = asString(audioRaw.score, "none");
  return {
    mustHappen: asStringArray(value.mustHappen).slice(0, 6),
    forbid: asStringArray(value.forbid).slice(0, 6),
    dialogue: asString(value.dialogue, undefined),
    emotionArc: asString(value.emotionArc, undefined),
    actingObjectives: objectives,
    audioPlan: {
      diegeticMusic: asStringArray(audioRaw.diegeticMusic).slice(0, 6),
      sfx: asStringArray(audioRaw.sfx).slice(0, 8),
      score: score === "original-score" ? "original-score" : "none",
      subtitles: audioRaw.subtitles === true,
      ...(sourcePropId && propIds.has(sourcePropId) ? { musicSourcePropId: sourcePropId } : {}),
    },
  };
}

/** 风格描述专用优化：只返回一段可执行的视觉风格语言，不改动其他导演简报字段。 */
export async function optimizeStyleDescription(project: ProjectV2, locale: Locale): Promise<string> {
  const settings = loadAISettings();
  if (!isRemoteConfigured(settings)) {
    throw new Error("AI 未配置，请先在 LenTalk「设置 → 自定义平台」配置 Chat 模型与 API Key，再在「AI编译提示词」左侧选择模型。");
  }

  const zh = locale === "zh";
  const language = zh ? "简体中文" : "English";
  const currentStyle = localizedStyleBrief(project, locale).trim();
  const preset = getStyle(project.styleId);
  const presetDescription = preset
    ? (zh ? preset.descriptionZh : preset.description).trim()
    : "";
  const checklist = zh
    ? "整体视觉处理；色彩层级与可量化比例；饱和度、阴影和黑位关系；写实画质与材质细节；空气介质；暗角、运动模糊等画面效果；光线质感；最后写所有镜头的统一性。"
    : "overall visual treatment; named color hierarchy with controllable ratios; saturation, shadow, and black-level behavior; photographic quality and material detail; atmospheric medium; vignette and motion-blur behavior; light quality; and the cross-shot consistency lock.";
  const data = await chatJSON(settings, JSON_SYSTEM, [
    "You are optimizing one visual style description for a cinematic AI video prompt studio.",
    `Return exactly one compact paragraph in ${language}; do not use headings, bullets, markdown, explanations, or a preface.`,
    "Rewrite the current description into executable image-style parameters that a video model can follow consistently across every shot.",
    "The output must be visual style language only. Do not output story, characters, props, dialogue, acting, shot size, focal length, FOV, camera body, camera movement, exposure settings, named lenses, or named directors.",
    "Do not blindly copy a preset or poetic mood adjectives. Preserve concrete user facts, make them measurable where the source supports it, and do not invent a period, color ratio, grain treatment, or technical specification that has no basis in the source.",
    "Include, when relevant: overall realistic / photographic treatment; a primary-secondary-accent color hierarchy with percentages; saturation range; shadow and black-level behavior; skin texture and material detail; sparse particles or other air effects; vignette strength; motion blur limited to moving edges; soft diffuse light without flattening all detail; and a final all-shots consistency statement.",
    `Use this output structure as a writing checklist: ${checklist}`,
    "A good Chinese-style result may read like: 青绿色与墨色哑光低饱和调色，青绿色约 60%、墨色冷灰约 30%、自然肤色与环境色约 10%；饱和度约 20%–35%，阴影偏青绿，黑位偏墨黑但保留暗部细节。超写实真人实景质感，皮肤保留自然毛孔、细微纹理和自然光泽，禁止过度磨皮与塑料感。空气中只有稀疏细微灰尘；轻微 5%–8% 镜头暗角；快速运动边缘有自然轻微运动模糊，静止区域保持清晰；柔和漫反射光，低对比度但保留完整层次。所有镜头保持统一色调。",
    "A good English-style result must express the same kind of concrete controls in English, not translate the example's Chinese wording literally.",
    "Current style description:",
    currentStyle || "(empty)",
    "Selected preset description for reference only; do not copy its name or wording verbatim:",
    presetDescription || "(none)",
    "Return exactly this JSON schema:",
    '{ "styleDescription": string }',
  ].join("\n"));

  const value = data && typeof data === "object" ? data as Record<string, unknown> : {};
  const result = asString(value.styleDescription);
  if (!result) {
    throw new Error("AI 未返回有效的风格描述。");
  }
  return result.replace(/\s+/g, " ").trim();
}

interface GeneratedShotResult {
  label?: unknown;
  time?: { startSeconds?: unknown; endSeconds?: unknown };
  framing?: unknown;
  lens?: unknown;
  lensModel?: unknown;
  camera?: unknown;
  optics?: unknown;
  cameraBehavior?: unknown;
  physicsAnchors?: unknown;
  movement?: unknown;
  action?: unknown;
  acting?: unknown;
  performanceLevel?: unknown;
  eyeLife?: unknown;
  direction?: unknown;
  participants?: unknown;
  beats?: unknown;
  propChangeDescription?: unknown;
  note?: unknown;
  cutStyle?: unknown;
}

/** V2.3：收集本场景明确引用的资产，供 AI 输入侧和后续审计共用。 */
export function collectSceneAssetIds(project: ProjectV2, scene: SceneV2): string[] {
  const byId = new Map((project.assets ?? []).map((asset) => [asset.id, asset]));
  const shotIds = buildSceneAssetRegistry(project, scene).orderedAssets.map((asset) => asset.id);
  const rosterCharacterIds = (scene.staging?.characterRoster ?? [])
    .filter((id) => byId.get(id)?.kind === "character");
  const stagingCharacterIds = (scene.staging?.characterOrder ?? [])
    .filter((id) => byId.get(id)?.kind === "character");
  return Array.from(new Set([...shotIds, ...rosterCharacterIds, ...stagingCharacterIds]));
}


/**
 * 导演分镜规划器：读取场景卡片和必要的资产摘要，只生成镜头执行结构。
 * 导演文档由本地编译器预填，最终提示词由后续最终生成步骤组织。
 * @throws 未配置远程模型 / 请求失败
 */
export async function fillSceneDraft(project: ProjectV2, scene: SceneV2, t?: { seconds?: string; locale?: Locale; onProgress?: SceneCompileProgressListener }): Promise<{
  scene: SceneV2;
  directorLayers?: Record<string, string>;
}> {
  const settings = loadAISettings();
  if (!isRemoteConfigured(settings)) {
    throw new Error("AI 未配置，请先在 LenTalk「设置 → 自定义平台」配置 Chat 模型与 API Key，再在「AI编译提示词」左侧选择模型。");
  }

  t?.onProgress?.("preparing");

  const assets = project.assets ?? [];
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  // V2.3：AI 只接收本场景已有引用，不把项目资产库全集暴露给模型。
  // 场景站位角色即使尚未进入某个镜头，也属于用户明确指定的场景资产。
  const sceneAssetIds = collectSceneAssetIds(project, scene);
  const characterIds = sceneAssetIds.filter((id) => byId.get(id)?.kind === "character");
  const propIds = sceneAssetIds.filter((id) => byId.get(id)?.kind === "prop");
  const locationAsset = scene.staging?.locationAssetId ? byId.get(scene.staging.locationAssetId) : undefined;
  const rosterIds = [...(scene.staging?.characterRoster ?? [])].filter((id) => byId.has(id) && byId.get(id)?.kind === "character");
  const orderIds = [...(scene.staging?.characterOrder ?? [])].filter((id) => byId.has(id) && byId.get(id)?.kind === "character");
  const seconds = t?.seconds ?? "s";
  const locale = t?.locale ?? "zh";
  const durationLimit = Number(scene.duration.match(/(\d+(?:\.\d+)?)/)?.[1]) || 15;
  const isLongTake = scene.shootingMode !== "multi-shot";

  const compact = (value: string, limit: number) => {
    const text = value.replace(/\s+/g, " ").trim();
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
  };
  const assetSummary = (ids: string[]): string => ids
    .map((id) => {
      const asset = byId.get(id);
      if (!asset) return "";
      const desc = compact(asset.description?.trim() || asset.descriptionZh?.trim() || asset.name, 180);
      const markers = [...(asset.uniqueMarkers ?? []), ...(asset.alwaysVisible ?? [])].slice(0, 4).join("; ");
      return `${asset.name}(${id}) — ${desc}${markers ? `; markers: ${compact(markers, 120)}` : ""}`;
    })
    .filter(Boolean)
    .join(" | ");
  const actingMasterSummary = characterIds
    .map((id) => {
      const asset = byId.get(id);
      if (!asset) return "";
      const master = locale === "zh"
        ? (asset.actingProfile?.masterProfileZh?.trim() || asset.actingProfile?.masterProfile?.trim() || "")
        : (asset.actingProfile?.masterProfile?.trim() || asset.actingProfile?.masterProfileZh?.trim() || "");
      return master ? `${asset.name}(${id}) — ${compact(master, 520)}` : "";
    })
    .filter(Boolean)
    .join(" | ");

  const vocabLines = [
    "Available camera IDs: arri-alexa-35, arri-alexa-mini-lf, red-v-raptor, sony-venice-2, bmd-ursa-cine, canon-c300-iii, panasonic-s1h, kinefinity-mavo-edge",
    "Available lensModel IDs: arri-master-prime, zeiss-supreme-prime, zeiss-cp4, cooke-s7i, leica-summicron-c, angenieux-optimo, canon-cne, sigma-cine-ff, cooke-panchro, helios-44-2",
    "framing: pick one clear shot size: Extreme wide / establishing, Wide, Full shot, Medium full / cowboy, Medium, Medium close-up, Close-up, Big close-up, Extreme close-up, Insert / detail, Two-shot, Tight two-shot, Over-the-shoulder, or 3/4 medium behind subject (free English framing phrases are also allowed)",
    "movement: pick from Static, Handheld, Steadicam, Dolly, Tracking, Crane, POV, OTS",
    "direction: \"left-to-right\" or \"right-to-left\"; cutStyle: \"hard-cut\" | \"overlap\" | \"match-cut\"",
  ];

  const allowedBeats: string[] = [];
  for (const shot of scene.shots) {
    for (const beat of shot.beats ?? []) {
      if (beat.actorId) allowedBeats.push(beat.actorId);
      if (beat.targetCharacterId) allowedBeats.push(beat.targetCharacterId);
      if (beat.targetPropId) allowedBeats.push(beat.targetPropId);
    }
  }

  const data = await chatJSON(settings, JSON_SYSTEM, [
    "You are the director storyboard planner of a cinematic AI video prompt studio.",
    "Your primary job is to plan the shot execution structure. Return structured shots first, with shot-local participants and observable beats. Make only the small macro decisions explicitly allowed by the schema. Do not write a director document or a final prompt.",
    "",
    "SCENE CARD CONTENT:",
    `Logline (故事梗概): ${scene.logline?.trim() || "(empty)"}`,
    `Prior context (前情续接): ${scene.staging?.priorContext?.trim() || "(empty)"}`,
    `Current location (当前场景地点，仅限本场景): ${scene.location?.trim() || "(empty)"}`,
    `Current time (当前场景时间，仅限本场景): ${scene.time?.trim() || "(empty)"}`,
    `Current weather (当前场景天气，仅限本场景): ${scene.weather?.trim() || "(empty)"}`,
    `Current duration (当前场景时长): ${scene.duration?.trim() || "(empty)"}`,
    `Must happen (user reference only): ${JSON.stringify(scene.mustHappen ?? [])}`,
    `Forbid (user reference only): ${JSON.stringify(scene.forbid ?? [])}`,
    `Scene dialogue (user reference only): ${scene.dialogue?.trim() || "(empty)"}`,
    `Spatial anchor (空间锚点): ${scene.staging?.anchorDescription?.trim() || "(empty)"}`,
    `Staging reference image (站位参考图): ${scene.staging?.stagingReferenceImage?.trim() ? "provided; use it only for character positions, screen axis, spacing, left-to-right order and spatial anchors" : "(none)"}`,
    `Scene character roster (本场可用角色，不等于每镜出场角色): ${rosterIds.length > 0 ? assetSummary(rosterIds) : "(none)"}`,
    `Character order (左到右站位, left-to-right): ${orderIds.length > 0 ? assetSummary(orderIds) : "(none/empty)"}`,
    `Performance objectives (表演目标, per character): ${JSON.stringify(scene.actingObjectives ?? [])}`,
    `Axis direction: ${scene.staging?.axisDirection ?? "left-to-right"}; Spacing: ${scene.staging?.spacing?.trim() || "(default)"}`,
    `Scene emotion arc: ${scene.emotionArc?.trim() || "(not set)"}`,
    `User audio plan (AI reference only; do not return or overwrite the audio plan card, and do not copy it directly into the final prompt): ${JSON.stringify(project.audioPlan ?? { score: "none", subtitles: false })}`,
    "",
    `LOCATION ASSET: ${locationAsset ? `${locationAsset.name}(${locationAsset.id}) — ${compact(locationAsset.description?.trim() || locationAsset.descriptionZh?.trim() || "", 240)}` : "(none)"}`,
    `CHARACTER ASSETS (scene references only): ${assetSummary(characterIds) || "(none)"}`,
    `CHARACTER ACTING MASTERS (AI-only reference; never output in ACTIVE REFERENCES): ${actingMasterSummary || "(none)"}`,
    `PROP ASSETS (scene references only): ${assetSummary(propIds) || "(none)"}`,
    `Existing beats may reference: ${allowedBeats.join(", ") || "(none)"}`,
    `Technical profile: ${JSON.stringify(project.technicalProfile ?? {})}`,
    "",
    "STORYBOARD RULES:",
    `Output language: ${locale === "zh" ? "Chinese" : "English"}. Keep all free-text shot fields in this language.`,
    "Only the structured shots are the execution plan. Do not return scene context, active references, location map, first frame, format mode, audio, style, positive/negative constraints, acting objectives, asset descriptions, voice locks, or directorLayers; those are either retained from user data or generated locally from the resulting shots and asset library.",
    isLongTake
      ? `Shooting mode is LONG TAKE. Return EXACTLY ONE shot, starting at 0 and ending no later than ${durationLimit}s. Put the complete story progression into continuous beats inside that one shot, splitting by observable events rather than a fixed beat count; do not merge or omit events to fit a limit. Do not create cut points, alternate camera setups, or additional shot entries.`
      : `Shooting mode is MULTI-SHOT. Select 1-8 shots only when the story rhythm needs a new viewpoint. Slow, observational, or dialogue-led scenes normally use 1-3 shots; do not add coverage just to fill a template. Use more shots only for a clear change of information, action, or emotional beat.`,
    `Timeline hard limit: all shots are sequential; shot 1 starts at 0; shot N starts where shot N-1 ends; beat startSeconds values are absolute scene times and must stay inside their shot window; the final endSeconds MUST be less than or equal to ${durationLimit}s. Never exceed the user's ${durationLimit}${seconds} limit. Duration label uses "${seconds}" suffix.`,
    "Every shot needs action, acting, framing, optics.lensCharacter, optics.fieldOfViewDegrees, movement, direction, and participants (only existing character IDs). Framing and optics are a linked pair: Extreme wide / establishing normally uses 135-immersive; Wide uses 84-wide; Full shot and Medium full use 63-moderate-wide or 47-standard; Medium uses 47-standard; Medium close-up and Close-up use 29-short-tele; Big close-up, Extreme close-up, and Insert / detail use 18-tele; Tight two-shot may use 12-long-tele; distant observation uses 8-supertele. Never return a close framing with a broad environmental lens or a wide framing with a portrait telephoto unless the user explicitly asks for that contrast. Participants are shot-local: add only people visible in frame or required to perform, speak, or receive an on-screen action in that exact shot. Do not copy the scene roster into every shot. Every beat actor and targetCharacterId MUST be listed in that same shot's participants. Local normalization supplies safe defaults when a field is not specified.",
    "Performance (P2): the CHARACTER ACTING MASTERS block is an AI-only reference. It is the character's identity and behavioral baseline, not text to paste into the prompt. Use the matching master profile to understand who the character is, then write the character performing on top of that baseline in this exact shot's moment. Do not copy, concatenate, or paraphrase the master line by line. Present characters only: write an acting paragraph only for characters in that shot's participants; no character in frame means no paragraph for that character. Keep the constant core (identity, vocal profile, signature tics, eye life, emotional through-line) and never contradict the master. Re-express it for this shot's posture, action, beat, emotional pressure, and time of day. Transform behaviors that cannot physically happen instead of deleting them: preserve the same engine while changing its outlet. For each participant, write acting as one flowing paragraph in the character's register, with no bullets, headers, dial labels, or abstract emotion-only wording; use observable face, body, breath, voice, gaze, timing, distance, and reaction. If the pipeline uses asset references, begin the paragraph with that character's reference tag. Set performanceLevel (0-5, 4 default whenever the acting master profile is strong) and eyeLife (micro glances / blink quality / eye glint / eyes leading the turn). Never copy the master profile into ACTIVE REFERENCES, directorLayers, or any separate CHARACTER ACTING section; only its shot-specific, observable adaptation belongs in the corresponding participant and beat. Do not use wardrobe, camera, color, or abstract emotion labels. Fill the beats' P2 fields: tactic (press / charm / provoke...), subtext (true intent opposite to the line), beatChange (visible shift: pause / posture / tempo / eye-line cut), reactionBeforeLine (reaction starting before the other speaker finishes). Every visible action must have its real performer in actorId; a listener or reacting character must get a separate beat with that character's actorId. Use targetCharacterId only for the person being watched, addressed, or reacted to. Never assign a listener's prop action, eye movement, hand movement, or body reaction to the speaker.",
    "Photography (P1): prefer observable lens character over focal-length-only strings. Per shot set optics.lensCharacter from the 10 presets (180-panoramic / 135-immersive / 107-ultrawide / 84-wide / 63-moderate-wide / 47-standard / 29-short-tele / 18-tele / 12-long-tele / 8-supertele) with optics.fieldOfViewDegrees 8-180 matching the preset. The 12° long-tele preset is approximately a 200mm full-frame equivalent and is valid for tight portrait or two-person coverage from a distant camera position. Add lensOutcome + antiDriftLock when the look must stay locked. Set cameraBehavior as physical operator behavior (height / distance / angle / side / subjectSize / screenPlacement / focusBehavior / depthOfField / handheldQuality). Add physicsAnchors for walk / run / weapon / liquid / particle. Per participant set torsoFacing when the body turns away from the eyeline, and anchorDistance when a landmark anchors the scene.",
    "State, not transition: write mid-action states (jaw clenched, strides lengthening), never transition chains (starts to... / begins to...). Groups react in staggered waves with different intensities, never in unison.",
    "Dialogue: write only scripted lines for this scene; when a character speaks, everyone else stays quiet. For an intentional silence, hold 1 second of quiet before and after the line; for an immediate interruption, start the line within 0.3 seconds.",
    "Beats: create 1-8 ordered beats per shot by default (start order at 1), but use more than 8 whenever the shot contains more than 8 distinct visible events; never merge events or omit them just to meet a count. One beat represents one observable event, subject change, or reaction, with a physically clear performer and target. Each beat has verb + actorId + targetCharacterId/targetPropId (only existing IDs) when applicable, actionText in the scene language, optional dialogue (include dialogue text in the same language as the scene), optional propState for a critical prop state in this beat, optional audio for a non-dialogue sound in this beat, optional required flag, and optional cutRule. When an event has a precise cue or must overlap another event, set startSeconds to its absolute scene time in seconds; omit it when ordinary sequential timing is sufficient. Keep duration as the event length. Do not return stateBefore or stateAfter. If a supporting character visibly tightens a grip, changes eyeline, shifts posture, reacts before dialogue, enters, exits, or performs a separate prop action, create a separate beat for that supporting character instead of burying the action in the lead character's beat text. Dense multi-character shots should preserve each person's readable reaction and exit timing as separate beats.",
    "Prop changes: return one natural-language propChangeDescription for each shot. Describe only visible prop use, contact, movement, or change in the scene language. Do not plan or return starting/ending prop states; those fields are legacy and ignored.",
    "Macro decisions: return only macro.emotionArc when the current scene needs a concise, camera-readable progression, and macro.lightingDirection when the lighting direction cannot be determined from the scene/location data. Omit a macro field when it is already clear or not needed. Do not use macro fields to restate shot actions or asset facts.",
    "",
    "Return ONLY a JSON object matching this schema. Put the shots array first in the object and return no other keys:",
    CLEAN_SCENE_DRAFT_PROMPT_SCHEMA,
    ...vocabLines,
    "Do NOT invent character/prop IDs. Do NOT add prose, markdown, directorLayers, or keys outside the schema.",
  ].join("\n"), t?.onProgress);

  const normalized = normalizeSceneDraft(project, scene, data, seconds, locale);
  t?.onProgress?.("validating");
  const durationIssue = auditFinalPrompt(normalized.scene).issues.find((issue) => issue.code === "FINAL.DURATION_EXCEEDED");
  if (durationIssue) {
    throw new Error(locale === "zh"
      ? `AI 分镜总时长超过用户设置的 ${durationLimit}${seconds}，本次规划未应用，请重新编译。`
      : `The AI storyboard exceeds the user's ${durationLimit}${seconds} limit. This plan was not applied; compile again.`);
  }
  return normalized;
}

/**
 * Second-stage delivery: re-organize already audited canonical prompt facts.
 * It must not plan shots, alter assets, or use user-planning fields as source material.
 */
export async function generateFinalPrompt(sourcePrompt: string, locale: Locale, onProgress?: SceneCompileProgressListener): Promise<string> {
  const settings = loadAISettings();
  if (!isRemoteConfigured(settings)) {
    throw new Error("AI 未配置，请先在 LenTalk「设置 → 自定义平台」配置 Chat 模型与 API Key。");
  }
  const request = buildFinalPromptRequest(sourcePrompt, locale);
  return chatCompletionsText(settings, request.system, request.user, onProgress, sourcePrompt, locale);
}

export function buildFinalPromptRequest(sourcePrompt: string, locale: Locale): { system: string; user: string } {
  const zh = locale === "zh";
  const languageRule = zh
    ? "只用清晰、电影级的中文输出。即使规范源包含英文，也必须将其忠实转换为自然、直接、可拍摄、可执行的中文提示词；避免翻译腔、空泛形容词和散文化抒情。"
    : "Output only clear, cinematic-grade English. Even if the canonical source contains Chinese, faithfully convert it into natural, direct, shootable, executable English; avoid literal translation, vague adjectives, and poetic prose.";
  const headingsRule = zh
    ? "只输出以下非空类别，必须使用这些中文标题，并严格按此顺序：风格、活动引用、场景地图和站位、光学、摄像机、动作节奏、格式模式、物理、光线、音频、正向约束。仅当源中存在时才输出：负向约束。"
    : "Output only the following non-empty categories, using exactly these English headings and this order: STYLE, ACTIVE REFERENCES, SCENE MAP AND STAGING, OPTICS, CAMERA, ACTION TIMING, FORMAT MODE, PHYSICS, LIGHTING, AUDIO, POSITIVE CONSTRAINTS. Output NEGATIVE CONSTRAINTS only when present in the source.";
  /* The previous style-writing instructions are retained below only as history;
   * final STYLE text is now copied from the local director document. */
  /* const legacyStyleRule = zh
    ? "空间锁定必须在摄像机之前，光学必须在一般美术语言之前，光线必须作为优先级锁。STYLE 必须位于光线之后、正向约束之前，并写成一段可执行的画面风格描述：先说整体写实/照片级或其他明确视觉处理，再写环境材质与表面质感、画面色彩层级（源中有比例时保留 60:30:10，并明确主色/次色/点缀色）、画质特征（清晰度、对比度、颗粒/无颗粒、噪点、帧面洁净度、真实感）以及时代或地域还原要求。风格应服务于控制，不要只写诗意情绪或空泛的“电影感”；每个形容词都要落到可见的颜色、材质、纹理、画面质量或时代质感上。可以保留“写实的照片级英国社会现实主义犯罪喜剧”“公屋的污垢感”“紧张而富身体性的视觉质感”这类画面风格信息，但不得照抄导演简报中的风格描述或风格预设名称，应将其转化为简洁、具体的最终画面语言。STYLE 不得重复 OPTICS、CAMERA、ACTION TIMING 或 LIGHTING：ARRI/摄影机型号、镜头型号、焦段、FOV、景深、运动、曝光、光线方向和光源归入对应类别；STYLE 只保留它们造成的可见画质结果，例如锐利清晰、均衡曝光感、无颗粒、年代准确。源中没有确定的色彩比例、颗粒、时代或地域信息时不得臆造。不要新增 QUALITY、CHARACTER ACTING 或其他标题；角色表演必须附着在动作节奏中对应的镜头和人物之后。参考格式：写实的照片级英国社会现实主义犯罪喜剧；公屋的污垢感，紧张而富身体性的视觉质感，叠加反派的威胁气场。60:30:10——主色、次色、点缀色分别写清。画面锐利清晰、帧面干净、无颗粒，准确还原 2011 年或更早的影像质感。"
    : "Keep spatial locks before camera, optics before general visual language, and lighting as a priority lock. STYLE must come after LIGHTING and before POSITIVE CONSTRAINTS. Write one executable image-style description: first state the overall realistic / photographic or otherwise explicit visual treatment, then the environment materials and surface texture, the color hierarchy (preserve a source-defined 60:30:10 ratio and name the primary / secondary / accent colors), image-quality traits (clarity, contrast, grain / no grain, noise, clean frames, realism), and any period or regional reconstruction requirement. Style must support control, not replace it: avoid purely poetic mood language or vague ‘cinematic’ adjectives; connect every descriptor to a visible color, material, texture, image-quality property, or period treatment. Preserve visual information such as ‘photorealistic British social-realist crime comedy’, ‘the grime of public housing’, and a tense, physically grounded image texture, but do not copy the director brief’s style description or preset name verbatim; distill it into compact, concrete final image language. Do not repeat OPTICS, CAMERA, ACTION TIMING, or LIGHTING: camera body, lens model, focal length, FOV, depth of field, movement, exposure, light direction, and light sources belong in their own categories. STYLE may retain their visible image-quality result, such as sharp clarity, balanced exposure appearance, no grain, or period accuracy. Never invent a color ratio, grain treatment, period, or regional requirement absent from the source. Do not add QUALITY, CHARACTER ACTING, or any other heading; attach acting to the corresponding shot and character inside ACTION TIMING. Example: photorealistic British social-realist crime comedy; public-housing grime with a tense, physically grounded image texture and a theatrical villain threat. 60:30:10 with the primary, secondary, and accent colors named explicitly. Sharp, clean frames with no grain, accurately reconstructing the image quality of 2011 or earlier.";
  */
  const styleRule = zh
    ? "风格锁放在所有类别最前，先输出 STYLE 再输出其他类别。STYLE 是导演文档中的本地风格原文，必须逐字复制规范源 STYLE 段的正文，不得翻译、改写、润色、压缩、补充、删除或重新解释；保留原有标点、比例、数值和句序。不得让 AI 重新生成风格，也不得把风格预设名称或风格描述改写成另一段文字。STYLE 不得重复 ACTIVE REFERENCES、OPTICS、CAMERA、ACTION TIMING 或 LIGHTING；其他类别中的信息仍按各自类别输出。"
    : "Style lock comes first: output STYLE before every other category. STYLE is the local style text from the director document: copy the STYLE body from the canonical source character-for-character. Do not translate, rewrite, polish, shorten, expand, delete, or reinterpret it; preserve its punctuation, ratios, numbers, and sentence order. Do not regenerate the style with AI or turn a preset name or style description into different wording. Do not repeat ACTIVE REFERENCES, OPTICS, CAMERA, ACTION TIMING, or LIGHTING inside STYLE; other information remains in its own category.";
  const actingPlacementRule = zh
    ? "角色表演只能写在 ACTION TIMING 中对应镜头和人物之后；不要新增 CHARACTER ACTING 标题。"
    : "Important: attach acting to the corresponding shot and character inside ACTION TIMING; do not add a separate CHARACTER ACTING heading.";
  const locationMapRule = zh
    ? "场景地图和站位合并为同一段：段首只输出一份场景级空间总图（地点几何、材质与主要地标、总体 180° 轴与屏幕方向、站位参考图所定义的左到右排序和间距、全场共用的空间锚点、主光方向及总体景深关系；可保留相机相对空间的总体基准，但不得写成某一镜头的构图或运动），段末输出第 1 镜头的开场首帧。场景地图不得复述活动引用中的场景描述，也不得输出“镜头 1/第 1 段”等逐镜人物位置覆盖、逐镜镜头路径、人物入画、表演或时间线；这些信息只属于 ACTION TIMING。首帧只写第 1 镜头第一个可见画面中的实际人物和道具：景别或角度、人物在画面左/中/右及前/中/后景的位置、人物之间的距离和遮挡关系、主要背景地标、身体朝向和视线方向；没有出镜的人物绝不能写入。首帧是静态占位与空间状态，不要写后续动作、表演过程或完整时间线；第一帧必须与第 1 镜头 ACTION TIMING 的参与人物、位置和入画方式一致；后续镜头的人物位置、入画、构图变化和空间关系只在各自的 ACTION TIMING 时间块中写出，不得回填到首帧。无论是多镜头还是长镜头，都只保留一次开场首帧。参考格式：第 1 段首帧：特写人物躺在黄沙中，双眼紧闭，身后是棕砖楼墙；画面里没有其他人物。"
    : "SCENE MAP AND STAGING is one section: first output one scene-level master map only (location geometry, materials and main landmarks; the overall 180-degree axis and screen direction; the left-to-right order and spacing established by the staging reference; shared spatial anchors; key-light direction; and overall depth relationships; it may retain a global camera-to-space baseline, but never present it as a shot composition or movement), then, at the end of the section, output the opening first frame of SHOT 1. Do not repeat the scene description from ACTIVE REFERENCES, and never output per-shot position overrides, per-shot camera paths, entrances, acting, or timing under this section; those facts belong only in ACTION TIMING. The first frame names only the people and props actually visible in that first visible picture: framing or angle, left/center/right and foreground/midground/background placement, distance and occlusion between subjects, main background landmarks, body orientation, and eyelines; never include a character who is not visible. The first frame is static occupancy and spatial state only; do not turn it into later action, performance progression, or a full timeline. It must agree with SHOT 1 ACTION TIMING participants, positions, and entrances. Later-shot positions, entrances, composition changes, and spatial relationships belong only in their own ACTION TIMING blocks and must not be repeated here. Both multi-shot sequences and long takes retain one opening first-frame statement only. Example: SHOT 1 FIRST FRAME: tight close-up of a figure lying in yellow sand, eyes closed, brown-brick wall behind; no other person shares the frame.";
  const formatModeRule = zh
    ? "FORMAT MODE 是本次生成的整体执行格式摘要，必须完整承接源中已确定的格式事实，不得只写“单一连续长镜头”或“受控多镜头序列”。按源内容明确写出：生成方式（单次生成或其他明确方式）、段数、总时长及各段时长分配（如 4 秒 / 4 秒）、画幅（如 16:9）、速度（实时、慢动作或其他已指定速度）、段间连接方式和连接动作、现场声/配乐范围、每句台词属于哪个角色或对象、字幕与画面帧限制。多段格式必须说明每一段如何结束、下一段如何开始，以及甩切、whip cut、甩镜上摇/下摇、推拉变焦等连接的方向、发生段落和连续因果；不要把明确的甩切泛化成“快速剪辑”。“单次生成”表示整段内容一次生成，不等于只能有一个镜头。各段时长必须与镜头时间轴一致；未在源中确定的时长、画幅、速度、转场、声音或对白归属不得臆造。格式模式只总结生成和段落组织方式，不重复 OPTICS、CAMERA、ACTION TIMING 的具体执行细节。示例：单次生成，两个段落，一次甩切，总长约 8 秒（4 秒 / 4 秒），画幅 16:9。实时速度。快速甩镜上摇结束第 1 段并顺势冲入急推变焦开启第 2 段；快速甩镜下摇结束第 2 段。仅现场音，无配乐；台词只属于提卡；干净的纯画面帧。"
    : "FORMAT MODE is the overall execution-format summary for this generation. It must carry forward every format fact established in the source, rather than outputting only ‘SINGLE CONTINUOUS TAKE’ or ‘CONTROLLED MULTI-SHOT SEQUENCE’. When supported by the source, state: generation mode (single generation or another explicit mode), segment count, total duration and per-segment allocation (for example, 4 seconds / 4 seconds), aspect ratio (for example, 16:9), speed (real time, slow motion, or another specified speed), the connection between segments and its physical transition, the diegetic-sound / score scope, which character or object owns each line, and subtitle / clean-frame limits. For multi-segment formats, explain how each segment ends and the next begins. Preserve the direction, segment placement, and causal continuity of whip cuts, whip pans up/down, push-ins, zooms, and other stated transitions; do not flatten an explicit whip cut into ‘fast editing’. ‘Single generation’ means one generated output for the whole piece, not a single shot. Segment durations must agree with the shot timeline. Never invent an unprovided duration, aspect ratio, speed, transition, sound rule, or dialogue ownership. FORMAT MODE summarizes generation and segment organization only; do not repeat the detailed OPTICS, CAMERA, or ACTION TIMING instructions. Example: single generation, two segments, one whip cut, approximately 8 seconds total (4 seconds / 4 seconds), 16:9. Real time. A fast whip pan upward ends segment 1 and flows directly into a rapid push-zoom that opens segment 2; a fast whip pan downward ends segment 2. Diegetic sound only, no score; the line belongs only to Tika; clean picture frames.";
  const cameraRule = zh
    ? "CAMERA 必须先写一段适用于全程的总摄影机描述，再按镜头段落分别展开，不能直接从第 1 段开始。总描述先锁定全程共用的摄影机语法：是否手持、整体稳定性或晃动质感、统一的倾斜/荷兰角、轴线、机位高度与距离，以及贯穿全程的观察或跟随原则；只有源中明确的信息才能写入，不得臆造导演风格或摄影机行为。总描述之后按“第 1 段：……”“第 2 段：……”逐段写出该段的实际摄影机行为，包括起始状态、运动方向、速度/力度、何时停止或保持不动、如何承接上一段和如何进入下一段。必须把甩镜上摇、甩镜下摇、急推变焦、停机观察等明确动作保留为可执行的摄影机动作及其触发事件，不得笼统改写成“镜头跟随”或“快速移动”。全程统一的摄影机规则只在总描述中说明；段落中只补充该段的变化和执行结果。CAMERA 只写摄影机位置、运动、方向、稳定性和与事件的响应，不重复 OPTICS 的焦段/FOV/景深，也不复制 ACTION TIMING 的完整动作与表演；但可用一句话说明摄影机正在捕捉哪个关键事件。参考格式：全程手持，略带倾斜形成轻度荷兰角。第 1 段：特写人物醒来并在甩沙后快速甩镜上摇冲向破窗。第 2 段：甩镜顺势冲入对窗口人群的硬急推变焦；随后保持不动观察搜寻，最后快速甩镜下摇离开窗口。"
    : "CAMERA must begin with one overall camera-language paragraph that applies across the entire generation, then expand segment by segment; do not begin directly with shot 1. The overall paragraph first locks the shared camera grammar: handheld or mounted operation, overall stability or shake quality, a consistent tilt / Dutch angle, screen axis, camera height and distance, and the rule for observing or following throughout. Include only information established by the source; never invent a director style or camera behavior. After the overall paragraph, write separate lines labeled ‘SHOT 1: ...’, ‘SHOT 2: ...’, and so on. For each segment, state the actual camera behavior, starting state, movement direction, speed / force, when it stops or holds, how it inherits the previous segment, and how it enters the next one. Preserve explicit actions such as a whip pan up, whip pan down, hard push-zoom, or locked-off observation as executable camera actions with their trigger events; do not flatten them into ‘the camera follows’ or ‘moves quickly’. State shared camera rules once in the overall paragraph; use segment lines only for changes and execution results. CAMERA covers camera position, movement, direction, stability, and response to events. Do not repeat OPTICS focal length / FOV / depth of field or copy the full ACTION TIMING action and acting; one short phrase may identify the key event being captured. Example: full-take handheld operation with a slight tilt creating a mild Dutch angle. SHOT 1: a close-up of the figure waking and shaking off sand, followed by a fast whip pan upward toward the broken window. SHOT 2: the whip pan flows directly into a hard push-zoom on the people at the window; hold still while they search, then finish with a fast whip pan downward away from the window.";
  const actionTimingRule = zh
    ? "动作节奏必须按镜头段分组输出，不能把所有镜头的时间块合并成一条平面时间线。多镜头序列先分别写“第 1 段（起止时间）：”“第 2 段（起止时间）：”等段落标题，再在每个段落标题下写该段自己的时间块；段落标题必须保留，即使某段只有一个事件。每个时间块必须保留精确时间（如 0:01.5–0:02.5），只写一个事件的主体位置、动作和该拍结果，并在相关时写入相机行为、关键道具状态、物理锚点和音频/对白；显式起始时间必须按场景绝对时间保留，并允许表达非连续或重叠事件。时间块中的人物和道具目标必须保留源中的 @ 资产引用及其对应 [imageN]，同一资产重复出现时复用同一个图片编号，不得输出裸的 @资产名。长镜头中只写一个连续段落；多镜头序列中每个切点都要保留源里的切换依据，没有依据不得输出切点。"
    : "ACTION TIMING must remain grouped by shot segment; never flatten all shot events into one timeline. For a multi-shot sequence, first write separate segment headings such as ‘SHOT 1 (start to end):’ and ‘SHOT 2 (start to end):’, then place only that segment's time blocks beneath its heading. Keep every segment heading even when it contains one event. Each time block must preserve its precise time (for example, 0:01.5 to 0:02.5), state one event's subject position, action, and outcome, and include camera behavior, critical prop state, physics anchors, and audio/dialogue when relevant. Preserve explicit absolute start times, including non-contiguous or overlapping events. Every character or prop @ asset reference inside a time block must retain its matching [imageN] token; reuse the same image number for repeated references and never emit a bare @asset tag. A long take gets one continuous segment group. In multi-shot sequences, keep the stated cut reason on every cut and never emit a cut without one.";
  return {
    system: "You are CINEDANCE V4, an elite AI film prompt director for Seedance 2.0 and Higgsfield Seedance. "
      + "Your job is to convert the provided canonical scene input into a clean, production-ready, high-budget cinematic video prompt that works on the first generation as often as possible. "
      + "You do not simply write beautiful prose: you operate as a film-director agent with internal reasoning, scene diagnosis, spatial blocking, optics selection, physics validation, reference control, continuity control, and silent QA before output. "
      + "Use simple direct words; avoid abstract poetic language when it weakens control; prefer concrete physical instructions, visible actions, measurable positions, explicit timing, camera-readable behavior, and observable visual outcomes. "
      + (zh
        ? "Return only the finished prompt in clear, cinematic-grade Chinese, with no commentary, markdown fence, rationale, audit note, or greeting."
        : "Return only the finished prompt in clear, cinematic-grade English, with no commentary, markdown fence, rationale, audit note, or greeting."),
    user: [
      languageRule,
      "The canonical source below combines the concise editable director guide with the structured shot execution. ACTIVE REFERENCES and SCENE MAP AND STAGING are compiler-generated from the current asset library and shot participants; treat those sections as the source of truth. Preserve every concrete fact, active reference, timing, character action, acting behavior, and constraint.",
      "Every @asset_tag, matching [imageN], and @audioN token is an opaque Seedance platform reference. Copy each one exactly as supplied: never translate, delete, rename, normalize, or invent one. Whenever an asset has a matching [imageN] in ACTIVE REFERENCES, every repeated @asset_tag occurrence in ACTION TIMING, SCENE MAP AND STAGING, and AUDIO must keep the same [imageN] immediately after the tag; never emit a bare version of that @asset_tag. Reusing the same @asset_tag and [imageN] is required and is not an accidental duplication. Keep each asset's appearance and prop description exclusively in ACTIVE REFERENCES. Acting master profiles are AI-only references: do not output them in ACTIVE REFERENCES or add a separate CHARACTER ACTING heading; preserve only their shot-specific, observable adaptation in the corresponding ACTION TIMING participant or beat. Keep each speaking or vocal character's voice lock and voice reference in the AUDIO section's character voice block, followed by the shot-local delivery, exact dialogue or non-verbal vocalization, and silence rule; do not repeat the full voice lock elsewhere.",
      "Do not invent, remove, reinterpret, or contradict any fact. Do not add prior context, story summaries, user notes, AI instructions, warnings, scores, or diagnostics.",
      zh
        ? "OPTICS 是镜头执行的结构化真源。逐镜保留其中的景别、FOV、镜头语言和可观测光学结果；不得因为风格、内容类别或你自己的判断替换、归一化或补写另一种镜头。"
        : "OPTICS is the structured source of truth for shot execution. Preserve every shot's framing, FOV, lens character, and observable optical outcome; never replace, normalize, or add a different lens because of style, content class, or your own judgment.",
      headingsRule,
      styleRule,
      locationMapRule,
      formatModeRule,
      cameraRule,
      actingPlacementRule,
      actionTimingRule,
      "",
      "CANONICAL AUDITED SOURCE:",
      sourcePrompt,
    ].join("\n"),
  };
}

const FINAL_SOURCE_SECTIONS = [
  { key: "style", heading: "STYLE" },
  { key: "activeReferences", heading: "ACTIVE REFERENCES" },
  { key: "locationMap", heading: "SCENE MAP AND STAGING" },
  { key: "optics", heading: "OPTICS" },
  { key: "camera", heading: "CAMERA" },
  { key: "actionTiming", heading: "ACTION TIMING" },
  { key: "formatMode", heading: "FORMAT MODE" },
  { key: "physics", heading: "PHYSICS" },
  { key: "lighting", heading: "LIGHTING" },
  { key: "audio", heading: "AUDIO" },
  { key: "positiveConstraints", heading: "POSITIVE CONSTRAINTS" },
  { key: "negativeLocks", heading: "NEGATIVE CONSTRAINTS" },
] as const;

const PROMPT_SECTION_HEADINGS = [
  ...FINAL_SOURCE_SECTIONS.map((section) => section.heading),
  "SHOT EXECUTION", "活动引用", "场景地图和站位", "场景地图", "首帧与空间走位", "首帧与站位", "格式模式", "光学", "摄像机", "动作节奏", "镜头执行", "物理", "光线", "音频", "风格", "正向约束", "负向约束",
];

function extractPromptSection(source: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n\\n)${escaped}[:：]\\n`, "m").exec(source);
  if (!match) return "";
  const start = match.index + match[0].length;
  const nextStarts = PROMPT_SECTION_HEADINGS
    .filter((item) => item !== heading)
    .map((item) => {
      const next = new RegExp(`\\n\\n${item.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}[:：]\\n`).exec(source.slice(start));
      return next ? start + next.index : -1;
    })
    .filter((index) => index >= 0);
  const end = nextStarts.length > 0 ? Math.min(...nextStarts) : source.length;
  return source.slice(start, end).trim();
}

/** 移除模型多输出的未知分段，保持最终提示词按 canonical 顺序。 */
function removePromptSection(text: string, heading: string): string {
  const escaped = escapeRegExp(heading);
  let result = text;
  for (;;) {
    // 标题可带可不带冒号（如“风格：”或裸“风格”），并允许同段出现多次。
    const match = new RegExp(`(^|\\n)${escaped}\\s*[:：]?\\s*\\n`, "i").exec(result);
    if (!match) return result;
    const bodyStart = match.index + match[0].length;
    const next = new RegExp(`\\n\\n(?:${PROMPT_SECTION_HEADINGS.map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})[:：]?\\n`, "iu").exec(result.slice(bodyStart));
    const bodyEnd = next ? bodyStart + next.index : result.length;
    result = `${result.slice(0, match.index)}${result.slice(bodyEnd)}`.replace(/\n{3,}/g, "\n\n").trim();
  }
}

/** STYLE is a local director-document value; never let final delivery rewrite it. */
function restoreCanonicalStyle(text: string, sourcePrompt: string, locale: Locale): string {
  const heading = locale === "zh" ? "风格" : "STYLE";
  // The canonical source always uses English section headings, but accept
  // either variant so this guard also works on hand-written sources.
  const canonical = extractPromptSection(sourcePrompt, "STYLE") || extractPromptSection(sourcePrompt, "风格");
  if (!canonical) return text;
  let rest = removePromptSection(text, "STYLE");
  rest = removePromptSection(rest, "风格");
  return `${heading}${locale === "zh" ? "：" : ":"}\n${canonical}\n\n${rest}`;
}

function withoutLayerHeading(text: string, heading: string, chineseHeading: string): string {
  return text.trim().replace(new RegExp(`^(?:${heading}|${chineseHeading})[：:]\\s*`, "i"), "").trim();
}

/**
 * Final delivery source is a single canonical sequence, not a director-document
 * dump followed by another full prompt. Editable director layers remain primary;
 * ACTIVE REFERENCES and SCENE MAP AND STAGING are always rebuilt from current
 * assets and structured shots so stale prose cannot override executable scene data.
 */
export function buildFinalGenerationSource(project: ProjectV2, scene: SceneV2, locale: Locale = "en"): string {
  const generatedLayers = buildDirectorDocumentLayers(project, scene, { locale });
  const editedLayers = scene.directorLayers ?? {};
  const spatialLayerConflicts = new Set(
    validateDirectorLayers(editedLayers, project, scene)
      .filter((issue) => issue.severity === "error" && (
        issue.code === "DIRECTOR.FIRST_FRAME_PARTICIPANT_CONFLICT" ||
        issue.code === "DIRECTOR.LOCATION_MAP_POSITION_CONFLICT"
      ))
      .map((issue) => issue.layerKey)
      .filter((key): key is string => Boolean(key)),
  );
  const canonicalSequence = compileDirectorSequence(project, scene, { locale });
  const labelsByKey = new Map(DIRECTOR_LAYERS.map((layer) => [layer.key, layer]));
  const sections: string[] = [];

  for (const section of FINAL_SOURCE_SECTIONS) {
    let body: string;
    if (section.key === "actionTiming") {
      body = extractPromptSection(canonicalSequence, locale === "zh" ? "镜头执行" : "SHOT EXECUTION");
    } else if (section.key === "activeReferences" || section.key === "optics") {
      // These sections are executable data, not editable director prose.
      const layer = labelsByKey.get(section.key as typeof DIRECTOR_LAYER_ORDER[number]);
      body = extractPromptSection(canonicalSequence, layer?.[locale] ?? section.heading);
    } else {
      const layer = labelsByKey.get(section.key as typeof DIRECTOR_LAYER_ORDER[number]);
      const edited = layer ? withoutLayerHeading(editedLayers[section.key] ?? "", section.heading, layer.zh) : "";
      const generated = generatedLayers[section.key as typeof DIRECTOR_LAYER_ORDER[number]] || "";
      body = spatialLayerConflicts.has(section.key) ? generated : edited || generated;
    }
    if (body.trim()) sections.push(`${section.heading}:\n${body.trim()}`);
  }
  return sections.join("\n\n");
}

export function normalizeSceneDraft(project: ProjectV2, scene: SceneV2, data: unknown, seconds: string, locale: Locale = "zh"): {
  scene: SceneV2;
  directorLayers?: Record<string, string>;
} {
  const obj = (data ?? {}) as Record<string, unknown>;
  const assets = project.assets ?? [];
  const characterIds = new Set(assets.filter((asset) => asset.kind === "character").map((asset) => asset.id));
  const propIds = new Set(assets.filter((asset) => asset.kind === "prop").map((asset) => asset.id));
  const orderIds = [...(scene.staging?.characterOrder ?? [])].filter((id) => characterIds.has(id));
  const macro = obj.macro && typeof obj.macro === "object" && !Array.isArray(obj.macro)
    ? obj.macro as Record<string, unknown>
    : {};
  const macroValue = (key: string) => macro[key] ?? obj[key];

  const LENS_CHARACTERS = new Set(["180-panoramic", "135-immersive", "107-ultrawide", "84-wide", "63-moderate-wide", "47-standard", "29-short-tele", "18-tele", "12-long-tele", "8-supertele"]);
  const PHYSICS_ANCHOR_KINDS = new Set(["walk", "run", "weapon", "liquid", "particle"]);
  const normalizeOptics = (raw: unknown): Optics | undefined => {
    const part = (raw ?? {}) as Record<string, unknown>;
    const result: Optics = {};
    const lensCharacter = asString(part.lensCharacter, undefined);
    if (lensCharacter && LENS_CHARACTERS.has(lensCharacter)) result.lensCharacter = lensCharacter as Optics["lensCharacter"];
    const fov = asNumber(part.fieldOfViewDegrees, NaN);
    if (Number.isFinite(fov)) result.fieldOfViewDegrees = Math.max(8, Math.min(180, Math.round(fov)));
    const lensOutcome = asStringArray(part.lensOutcome).slice(0, 6);
    if (lensOutcome.length > 0) result.lensOutcome = lensOutcome;
    const antiDriftLock = asString(part.antiDriftLock, undefined);
    if (antiDriftLock) result.antiDriftLock = antiDriftLock;
    return Object.keys(result).length > 0 ? result : undefined;
  };
  const CAMERA_BEHAVIOR_KEYS = ["height", "distance", "angle", "side", "subjectSize", "screenPlacement", "focusBehavior", "depthOfField", "handheldQuality"] as const;
  const normalizeCameraBehavior = (raw: unknown): CameraBehavior | undefined => {
    const part = (raw ?? {}) as Record<string, unknown>;
    const result: CameraBehavior = {};
    for (const key of CAMERA_BEHAVIOR_KEYS) {
      const value = asString(part[key], undefined);
      if (value) result[key] = value;
    }
    return Object.keys(result).length > 0 ? result : undefined;
  };
  const normalizePhysicsAnchors = (raw: unknown): PhysicsAnchor[] | undefined => {
    if (!Array.isArray(raw)) return undefined;
    const list: PhysicsAnchor[] = [];
    for (const rawItem of raw.slice(0, 6)) {
      const item = (rawItem ?? {}) as Record<string, unknown>;
      const kind = asString(item.kind, undefined);
      if (!kind || !PHYSICS_ANCHOR_KINDS.has(kind)) continue;
      list.push({ kind: kind as PhysicsAnchor["kind"], ...(asString(item.detail, undefined) ? { detail: asString(item.detail) } : {}) });
    }
    return list.length > 0 ? list : undefined;
  };
  const normalizeLightingDirection = (raw: unknown): LightingDirection | undefined => {
    const part = (raw ?? {}) as Record<string, unknown>;
    const result: LightingDirection = {};
    const primarySource = asString(part.primarySource, undefined);
    const direction = asString(part.direction, undefined);
    const exposurePriority = asString(part.exposurePriority, undefined);
    if (primarySource) result.primarySource = primarySource;
    if (direction) result.direction = direction;
    if (exposurePriority) result.exposurePriority = exposurePriority;
    const allowHighlights = asStringArray(part.allowHighlights).slice(0, 6);
    const forbid = asStringArray(part.forbid).slice(0, 8);
    if (allowHighlights.length > 0) result.allowHighlights = allowHighlights;
    if (forbid.length > 0) result.forbid = forbid;
    return Object.keys(result).length > 0 ? result : undefined;
  };

  const rawShots = Array.isArray(obj.shots) ? obj.shots : [];
  // Long take is structurally one shot. Ignore extra AI coverage rather than
  // letting a non-compliant response turn into a multi-shot final export.
  const generated: GeneratedShotResult[] = rawShots.slice(0, scene.shootingMode !== "multi-shot" ? 1 : 8).map((raw) => ((raw ?? {}) as GeneratedShotResult));
  const shots: ShotV2[] = [];
  let cursor = 0;
  for (const raw of generated) {
    const start = raw.time && typeof raw.time.startSeconds === "number" && Number.isFinite(raw.time.startSeconds)
      ? Math.max(0, raw.time.startSeconds)
      : cursor;
    const end = raw.time && typeof raw.time.endSeconds === "number" && Number.isFinite(raw.time.endSeconds) && raw.time.endSeconds > start
      ? raw.time.endSeconds
      : Math.max(start + 1, cursor + 8);
    cursor = end;

    const participants: ShotParticipant[] = [];
    const rawParticipants = Array.isArray(raw.participants) ? raw.participants : [];
    for (const rawPartial of rawParticipants.slice(0, 12)) {
      const partial = (rawPartial ?? {}) as Record<string, unknown>;
      const characterId = asString(partial.characterId);
      if (!characterIds.has(characterId) || participants.some((participant) => participant.characterId === characterId)) continue;
      const role = asString(partial.role, "supporting");
      participants.push({
        characterId,
        role: ["primary", "supporting", "target", "background"].includes(role) ? role as ShotParticipant["role"] : "supporting",
        position: asString(partial.position, undefined),
        entrance: ["already-in-frame", "enters-left", "enters-right"].includes(asString(partial.entrance))
          ? asString(partial.entrance) as ShotParticipant["entrance"]
          : undefined,
        facing: asString(partial.facing, undefined),
        eyeline: asString(partial.eyeline, undefined),
        ...(asString(partial.torsoFacing, undefined) ? { torsoFacing: asString(partial.torsoFacing) } : {}),
        ...(asString(partial.anchorDistance, undefined) ? { anchorDistance: asString(partial.anchorDistance) } : {}),
        ...(asString(partial.acting, undefined) ? { acting: asString(partial.acting) } : {}),
        ...(asString(partial.eyeLife, undefined) ? { eyeLife: asString(partial.eyeLife) } : {}),
      });
    }

    const participantIds = new Set(participants.map((participant) => participant.characterId));
    const beats: ActionBeat[] = [];
    const rawBeats = Array.isArray(raw.beats) ? raw.beats : [];
    let beatOrder = 1;
    // 节拍数量由可见事件决定，不设人为上限；最终时长闸门仍会校验每个节拍是否落在镜头窗口内。
    for (const rawBeat of rawBeats) {
      const beat = (rawBeat ?? {}) as Record<string, unknown>;
      const actorId = asString(beat.actorId, undefined);
      const targetCharacterId = asString(beat.targetCharacterId, undefined);
      const targetPropId = asString(beat.targetPropId, undefined);
      if (actorId && !participantIds.has(actorId)) continue;
      if (targetCharacterId && !participantIds.has(targetCharacterId)) continue;
      if (targetPropId && !propIds.has(targetPropId)) continue;
      const rawStartSeconds = beat.startSeconds;
      const parsedStartSeconds = typeof rawStartSeconds === "number"
        ? rawStartSeconds
        : typeof rawStartSeconds === "string" && rawStartSeconds.trim()
          ? Number(rawStartSeconds)
          : Number.NaN;
      beats.push({
        id: newId(),
        order: beatOrder++,
        ...(Number.isFinite(parsedStartSeconds) ? { startSeconds: Math.max(0, parsedStartSeconds) } : {}),
        duration: asNumber(beat.duration, 4),
        actorId,
        verb: asString(beat.verb, "acts"),
        targetCharacterId,
        targetPropId,
        targetBodyPart: asString(beat.targetBodyPart, undefined),
        actionText: asString(beat.actionText, undefined),
        dialogue: asString(beat.dialogue, undefined),
        propState: asString(beat.propState, undefined),
        audio: asString(beat.audio, undefined),
        tactic: asString(beat.tactic, undefined),
        subtext: asString(beat.subtext, undefined),
        beatChange: asString(beat.beatChange, undefined),
        reactionBeforeLine: asString(beat.reactionBeforeLine, undefined),
        note: asString(beat.note, undefined),
        required: beat.required === true,
        forbiddenTargets: asStringArray(beat.forbiddenTargets).filter((id) => participantIds.has(id) || propIds.has(id)),
        cutRule: asString(beat.cutRule, undefined),
      });
    }

    const movement = asString(raw.movement, "Static") as CameraMovement;
    const cutStyle = asString(raw.cutStyle, scene.cutStyleDefault ?? "hard-cut") as CutStyle;
    const framing = asString(raw.framing, "Medium close-up");
    const legacyLens = asString(raw.lens, undefined);
    const lensModel = asString(raw.lensModel, undefined);
    const camera = asString(raw.camera, undefined);
    const shotOptics = normalizeOptics(raw.optics);
    const legacyFov = shotOptics?.fieldOfViewDegrees ?? legacyFocalLengthToFov(legacyLens) ?? 47;
    const recommendedLensId = /extreme\s*wide|establishing|大远景|建立镜头/i.test(framing)
      ? "135-immersive"
      : /extreme\s*close|big\s*close|极近特写|大特写|细节|macro|insert/i.test(framing)
        ? "18-tele"
        : /tight\s*two|紧凑双人/i.test(framing)
          ? "12-long-tele"
          : /close[- ]?up|portrait|特写|肖像|面部|面孔|中近景|过肩/i.test(framing)
            ? "29-short-tele"
            : /wide|full|全景|远景|广角|全身|牛仔|中全景/i.test(framing)
              ? "84-wide"
              : "47-standard";
    const recommendedLens = lensById(recommendedLensId);
    const selectedLensId = shotOptics?.lensCharacter ?? lensByFov(legacyFov)?.id;
    const selectedLens = selectedLensId ? lensById(selectedLensId) : undefined;
    const needsNarrowLens = /extreme\s*close|big\s*close|close[- ]?up|portrait|tight\s*two|特写|肖像|面部|面孔|中近景|紧凑双人|细节|macro|insert/i.test(framing);
    const needsBroadLens = /extreme\s*wide|wide|full|establishing|大远景|建立镜头|全景|远景|广角|全身|牛仔|中全景/i.test(framing);
    const lensIsNarrow = (selectedLens?.contentClasses ?? []).some((item) => item === "face-portrait" || item === "detail-closeup");
    const lensIsBroad = (selectedLens?.contentClasses ?? []).some((item) => item === "environment-action" || item === "distant-observation");
    const framingLensMismatch = (needsNarrowLens && !lensIsNarrow) || (needsBroadLens && !lensIsBroad);
    const normalizedOptics = framingLensMismatch && recommendedLens
      ? { lensCharacter: recommendedLens.id, fieldOfViewDegrees: recommendedLens.fov }
      : shotOptics ?? { fieldOfViewDegrees: legacyFov, lensCharacter: lensByFov(legacyFov)?.id };
    const effectiveFov = normalizedOptics.fieldOfViewDegrees ?? legacyFov;
    const lens = framingLensMismatch && recommendedLens
      ? fovToLegacyFocalLength(recommendedLens.fov)
      : legacyLens || fovToLegacyFocalLength(effectiveFov);
    const shotCameraBehavior = normalizeCameraBehavior(raw.cameraBehavior);
    const shotPhysicsAnchors = normalizePhysicsAnchors(raw.physicsAnchors);
    const direction = asString(raw.direction, "left-to-right") as ShotV2["direction"];
    const index = shots.length + 1;
    const label = asString(raw.label, String(index).padStart(2, "0"));
    shots.push({
      id: newId(),
      label,
      duration: `${start}-${end}${seconds}`,
      time: { startSeconds: start, endSeconds: end },
      framing,
      lens,
      ...(lensModel ? { lensModel } : {}),
      ...(camera ? { camera } : {}),
      ...(normalizedOptics ? { optics: normalizedOptics } : {}),
      ...(shotCameraBehavior ? { cameraBehavior: shotCameraBehavior } : {}),
      ...(shotPhysicsAnchors ? { physicsAnchors: shotPhysicsAnchors } : {}),
      movement,
      action: asString(raw.action, "Continue the scene naturally."),
      acting: asString(raw.acting, "Natural, restrained performance."),
      ...(typeof raw.performanceLevel === "number" && Number.isFinite(raw.performanceLevel) ? { performanceLevel: Math.max(0, Math.min(5, Math.round(raw.performanceLevel))) as 0 | 1 | 2 | 3 | 4 | 5 } : {}),
      ...(asString(raw.eyeLife) ? { eyeLife: asString(raw.eyeLife) } : {}),
      direction,
      cutStyle,
      participants,
      beats,
      propChangeDescription: asString(raw.propChangeDescription, undefined),
      note: asString(raw.note, undefined),
      layout: {
        useSceneStaging: true,
        ...(orderIds.length > 0 ? { characterOrder: orderIds } : {}),
        axisDirection: scene.staging?.axisDirection ?? "left-to-right",
        ...(scene.staging?.anchorDescription?.trim() ? { anchorDescription: scene.staging.anchorDescription.trim() } : {}),
      },
    } as ShotV2);
  }

  const lightingDirection = normalizeLightingDirection(macroValue("lightingDirection"));

  const structuredScene: SceneV2 = {
      ...scene,
      name: scene.name,
      emotionArc: asString(macroValue("emotionArc"), scene.emotionArc ?? ""),
      ...(lightingDirection ? { lightingDirection } : {}),
      shots,
  };
  // The editable director document is always generated locally from the
  // normalized shots and current assets. There is no second AI prose channel.
  const generatedLayers = buildDirectorDocumentLayers(project, structuredScene, { locale });
  const directorLayers: Record<string, string> = { ...generatedLayers };

  return {
    scene: { ...structuredScene, directorLayers },
    directorLayers,
  };
}
