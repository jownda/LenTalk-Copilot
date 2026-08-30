/**
 * AI 辅助层（P3）— 桌面端实现
 * 配置了 API Key 时使用远程 OpenAI 兼容 Chat Completions（OpenAI / DeepSeek / Kimi / 通义 / 智谱 / 自定义），
 * 未配置或请求失败时自动回退本地模板建议。
 */
import { buildDirectorDocumentLayers, compileDirectorSequence, DIRECTOR_LAYERS, DIRECTOR_LAYER_ORDER, LocalSuggestionProvider, SHOT_TEMPLATES, localizedStyleBrief } from "../../engine";
import type { AIAssistant, AssetSuggestion, BeatSuggestion, FixSuggestion, SceneSuggestion } from "../../engine";
import { buildSceneAssetRegistry } from "../../engine/compiler/renderer";
import { fovToLegacyFocalLength, legacyFocalLengthToFov, lensByFov, lensById } from "../../engine/presets";
import { resolveImageDisplayUrl } from "@/features/canvas/application/imageData";
import { auditFinalPrompt, validateDirectorLayers, type DirectorLayerIssue } from "../../engine/quality";
import type {
  ActingObjective, ActionBeat, Asset, AssetActingProfile, AssetKind, AudioPlan, CameraBehavior, CameraMovement, ContinuityIssueV2, CutStyle,
  FirstFrameLock, LightingDirection, LockLevel, Optics, PhysicsAnchor, ProjectV2, SceneV2, ShotParticipant, ShotV2,
} from "../../shared-types";
import { isRemoteConfigured, loadAISettings, normalizeBaseUrl, openAICompatibleBaseUrl, type AISettings } from "./aiSettings";
import type { Locale } from "../i18n";

const localProvider = new LocalSuggestionProvider();

/** AI 分镜返回结构：FOV 为唯一镜头语言，音频计划只读且不在 AI 返回范围内。 */
const LEGACY_SCENE_DRAFT_JSON_SCHEMA = `{ "sceneName": string, "sceneContext": string, "directorLayers": { "sceneContext": string | null, "activeReferences": string | null, "locationMap": string | null, "firstFrame": string | null, "formatMode": string | null, "optics": string | null, "camera": string | null, "actionTiming": string | null, "physics": string | null, "lighting": string | null, "audio": string | null, "style": string | null, "positiveConstraints": string | null, "negativeLocks": string | null }, "emotionArc": string, "actingObjectives": [ { "characterId": string, "objective": string, "superObjective": string | null, "obstacle": string | null, "stakes": string | null } ], "firstFrameLock": { "requiredSubjectIds": string[], "occupancyStatement": string | null }, "lightingDirection": { "primarySource": string | null, "direction": string | null, "exposurePriority": string | null, "allowHighlights": string[], "forbid": string[] }, "negativePrompt": string, "shots": [ { "time": { "startSeconds": number, "endSeconds": number }, "label": string, "framing": string, "lensModel": string | null, "camera": string | null, "optics": { "lensCharacter": "47-standard" | "84-wide" | "107-ultrawide" | "29-short-tele" | "18-tele" | "8-supertele" | "135-immersive" | null, "fieldOfViewDegrees": number | null, "lensOutcome": string[] | null, "antiDriftLock": string | null }, "cameraBehavior": { "height": string | null, "distance": string | null, "angle": string | null, "side": string | null, "subjectSize": string | null, "screenPlacement": string | null, "focusBehavior": string | null, "depthOfField": string | null, "handheldQuality": string | null }, "physicsAnchors": [ { "kind": "walk" | "run" | "weapon" | "liquid" | "particle", "detail": string | null } ], "movement": string, "action": string, "acting": string, "performanceLevel": number, "eyeLife": string, "direction": "left-to-right" | "right-to-left", "cutStyle": "hard-cut" | "overlap" | "match-cut", "participants": [ { "characterId": string, "role": "primary" | "supporting" | "target" | "background", "position": string | null, "entrance": "already-in-frame" | "enters-left" | "enters-right" | null, "facing": string | null, "eyeline": string | null, "torsoFacing": string | null, "anchorDistance": string | null, "acting": string | null, "eyeLife": string | null } ], "beats": [ { "order": number, "duration": number, "verb": string, "actorId": string | null, "targetCharacterId": string | null, "targetPropId": string | null, "targetBodyPart": string | null, "actionText": string | null, "dialogue": string | null, "tactic": string | null, "subtext": string | null, "beatChange": string | null, "reactionBeforeLine": string | null, "required": boolean, "forbiddenTargets": string[], "stateBefore": [ { "propId": string, "state": string, "holderCharacterId": string | null, "position": string | null } ], "stateAfter": [ { "propId": string, "state": string, "holderCharacterId": string | null, "position": string | null } ], "cutRule": string | null, "note": string | null } ], "propStatesAtStart": [ { "propId": string, "state": string, "holderCharacterId": string | null, "position": string | null } ], "propStatesAtEnd": [ { "propId": string, "state": string, "holderCharacterId": string | null, "position": string | null } ], "note": string | null } ] }`;

/** 新版 AI 分镜 schema：不再要求任何开始/结束或节拍前后状态字段。 */
export const SCENE_DRAFT_JSON_SCHEMA = LEGACY_SCENE_DRAFT_JSON_SCHEMA
  .replace(/, "actionTiming": string \| null/, "")
  .replace(/, "stateBefore": \[ \{ "propId": string, "state": string, "holderCharacterId": string \| null, "position": string \| null \} \], "stateAfter": \[ \{ "propId": string, "state": string, "holderCharacterId": string \| null, "position": string \| null \} \]/g, "")
  .replace(/, "propStatesAtStart": \[ \{ "propId": string, "state": string, "holderCharacterId": string \| null, "position": string \| null \} \], "propStatesAtEnd": \[ \{ "propId": string, "state": string, "holderCharacterId": string \| null, "position": string \| null \} \]/g, "");

export const CLEAN_SCENE_DRAFT_PROMPT_SCHEMA = SCENE_DRAFT_JSON_SCHEMA;

export type SceneCompileProgress = "idle" | "preparing" | "waiting" | "resuming" | "parsing" | "validating";

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

/** 流式响应在生成中断时携带已经收到的内容，供同一请求续写一次。 */
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
export async function readChatCompletionText(response: Response): Promise<string> {
  const extractContent = (value: unknown): string => {
    if (!value || typeof value !== "object") return "";
    const choice = (value as { choices?: unknown[] }).choices?.[0];
    if (!choice || typeof choice !== "object") return "";
    const item = choice as { delta?: { content?: unknown }; message?: { content?: unknown } };
    const content = item.delta?.content ?? item.message?.content;
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
      if (chunk.done) break;
    }
  } catch (error) {
    if (content) throw new ChatCompletionInterruptedError(content);
    throw error;
  }
  if (pending) consumeLine(pending);
  if (sawStreamEvent && !completed) {
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
  onProgress?: (stage: SceneCompileProgress) => void,
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
    const content = await readChatCompletionText(response);
    if (!content) throw new Error("响应中没有文本内容");
    onProgress?.("parsing");
    return extractJSON(content);
  } catch (error) {
    if (!(error instanceof ChatCompletionInterruptedError) || !error.partialText.trim()) throw error;
    const continueFrom = async (partialText: string): Promise<unknown> => {
      onProgress?.("resuming");
      const resumedResponse = await request(true, true, continuationMessages(messages, partialText));
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
        resumed = await readChatCompletionText(resumedResponse);
      } catch (resumeError) {
        if (resumeError instanceof ChatCompletionInterruptedError) {
          const merged = mergeContinuationText(partialText, resumeError.partialText);
          throw new ChatCompletionInterruptedError(merged, () => continueFrom(merged));
        }
        throw new ChatCompletionInterruptedError(partialText, () => continueFrom(partialText));
      }
      return extractJSON(mergeContinuationText(partialText, resumed));
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
async function chatCompletionsText(settings: AISettings, system: string, user: string, onProgress?: (stage: SceneCompileProgress) => void): Promise<string> {
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
    const content = (await readChatCompletionText(response)).trim();
    if (!content) throw new Error("响应中没有最终提示词文本");
    onProgress?.("parsing");
    return sanitizeFinalPromptResponse(content);
  } catch (error) {
    if (!(error instanceof ChatCompletionInterruptedError) || !error.partialText.trim()) throw error;
    const continueFrom = async (partialText: string): Promise<string> => {
      onProgress?.("resuming");
      const resumedResponse = await request(true, continuationMessages(baseMessages, partialText));
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
        resumed = await readChatCompletionText(resumedResponse);
      } catch (resumeError) {
        if (resumeError instanceof ChatCompletionInterruptedError) {
          const merged = mergeContinuationText(partialText, resumeError.partialText);
          throw new ChatCompletionInterruptedError(merged, () => continueFrom(merged));
        }
        throw new ChatCompletionInterruptedError(partialText, () => continueFrom(partialText));
      }
      onProgress?.("parsing");
      return sanitizeFinalPromptResponse(mergeContinuationText(partialText, resumed).trim());
    };
    return continueFrom(error.partialText);
  }
}

/** Remove hidden reasoning emitted by models before the text reaches the prompt editor. */
export function sanitizeFinalPromptResponse(text: string): string {
  let cleaned = text.replace(/\r\n?/g, "\n");
  cleaned = cleaned.replace(/<(think|analysis|reasoning)\b[^>]*>[\s\S]*?<\/\1>/gi, "");

  // Some reasoning models omit the closing tag. If the response contains a
  // canonical first heading, discard everything before that heading.
  if (/^\s*<(?:think|analysis|reasoning)\b[^>]*>/i.test(cleaned)) {
    const firstHeading = cleaned.search(/(?:^|\n)(?:场景上下文|SCENE CONTEXT)\s*[:：]?\s*\n/i);
    cleaned = firstHeading >= 0 ? cleaned.slice(firstHeading).trim() : "";
  }

  return cleaned
    .replace(/^\s*```(?:text|markdown)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

async function chatJSON(settings: AISettings, system: string, user: string, onProgress?: (stage: SceneCompileProgress) => void): Promise<unknown> {
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

  async repairContinuity(input: { issue: ContinuityIssueV2; project: ProjectV2; scene: SceneV2; shot?: ShotV2 }): Promise<FixSuggestion> {
    return this.fallback(async () => {
      const data = await chatJSON(this.settings, JSON_SYSTEM, [
        "Return a structured continuity fix. Schema:",
        `{ "code": string, "label": string, "detail": string, "apply": string }`,
        "",
        `Issue: ${JSON.stringify(input.issue)}`,
        `Shot label: ${input.shot?.label ?? input.scene.name}`,
        "Keep code identical to the issue code. apply must be a short actionable instruction for the user.",
      ].join("\n"));
      const obj = data as Record<string, unknown>;
      return {
        code: input.issue.code,
        label: asString(obj.label, input.issue.label ?? input.issue.code),
        detail: asString(obj.detail, "Review this continuity issue before export."),
        apply: asString(obj.apply, "Manually resolve the conflicting fields before export."),
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
  const stagingCharacterIds = (scene.staging?.characterOrder ?? [])
    .filter((id) => byId.get(id)?.kind === "character");
  return Array.from(new Set([...shotIds, ...stagingCharacterIds]));
}

/**
 * AI 智能分镜：读取场景卡片的内容（地点站位、前情续接、故事梗概、角色/道具资产），
 * 生成完整的剧情分镜（镜头列表 + 各镜头检查器内容），供审核与最终生成阶段使用。
 * @throws 未配置远程模型 / 请求失败
 */
export async function fillSceneDraft(project: ProjectV2, scene: SceneV2, t?: { seconds?: string; locale?: Locale; onProgress?: (stage: SceneCompileProgress) => void }): Promise<{
  scene: SceneV2;
  negativePrompt?: string;
  directorLayers?: Record<string, string>;
  directorLayerIssues?: DirectorLayerIssue[];
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
  const orderIds = [...(scene.staging?.characterOrder ?? [])].filter((id) => byId.has(id) && byId.get(id)?.kind === "character");
  const seconds = t?.seconds ?? "s";
  const locale = t?.locale ?? "zh";
  const styleBrief = localizedStyleBrief(project, locale);
  const durationLimit = Number(scene.duration.match(/(\d+(?:\.\d+)?)/)?.[1]) || 15;
  const isLongTake = scene.shootingMode !== "multi-shot";

  const assetSummary = (ids: string[]): string => ids
    .map((id) => {
      const asset = byId.get(id);
      if (!asset) return "";
      const desc = asset.description?.trim() || asset.descriptionZh?.trim() || asset.name;
      const markers = [...(asset.uniqueMarkers ?? []), ...(asset.alwaysVisible ?? [])].join("; ");
      return `${asset.name}(${id}) — ${desc}${markers ? `; markers: ${markers}` : ""}`;
    })
    .filter(Boolean)
    .join(" | ");

  const vocabLines = [
    "Available camera IDs: arri-alexa-35, arri-alexa-mini-lf, red-v-raptor, sony-venice-2, bmd-ursa-cine, canon-c300-iii, panasonic-s1h, kinefinity-mavo-edge",
    "Available lensModel IDs: arri-master-prime, zeiss-supreme-prime, zeiss-cp4, cooke-s7i, leica-summicron-c, angenieux-optimo, canon-cne, sigma-cine-ff, cooke-panchro, helios-44-2",
    "framing: pick from Wide, Medium close-up, or Extreme close-up, profile (free English framing phrases also allowed)",
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
    "You are the AI storyboard planner of a cinematic AI video prompt studio.",
    "Read the scene card content below and plan a complete, professional storyboard and director document for this scene: shot list, every shot's camera/performance/participants/beats, and the directorLayers object. Treat the style direction as one coherent visual system; do not scatter it into contradictory style labels.",
    "",
    "SCENE CARD CONTENT:",
    `Logline (故事梗概): ${scene.logline?.trim() || "(empty)"}`,
    `Prior context (前情续接): ${scene.staging?.priorContext?.trim() || "(empty)"}`,
    `Must happen (user reference only): ${JSON.stringify(scene.mustHappen ?? [])}`,
    `Forbid (user reference only): ${JSON.stringify(scene.forbid ?? [])}`,
    `Scene dialogue (user reference only): ${scene.dialogue?.trim() || "(empty)"}`,
    `Spatial anchor (空间锚点): ${scene.staging?.anchorDescription?.trim() || "(empty)"}`,
    `Character order (左到右站位, left-to-right): ${orderIds.length > 0 ? assetSummary(orderIds) : "(none/empty)"}`,
    `Performance objectives (表演目标, per character): ${JSON.stringify(scene.actingObjectives ?? [])}`,
    `Axis direction: ${scene.staging?.axisDirection ?? "left-to-right"}; Spacing: ${scene.staging?.spacing?.trim() || "(default)"}`,
    `Scene emotion arc: ${scene.emotionArc?.trim() || "(not set)"}; Scene name: ${scene.name}`,
    `Style direction: ${styleBrief || "(not set)"}`,
    `User audio plan (AI reference only; do not return or overwrite the audio plan card, and do not copy it directly into the final prompt): ${JSON.stringify(project.audioPlan ?? { score: "none", subtitles: false })}`,
    "",
    `LOCATION ASSET: ${locationAsset ? `${locationAsset.name}(${locationAsset.id}) — ${locationAsset.description?.trim() || locationAsset.descriptionZh?.trim() || ""}` : "(none)"}`,
    `CHARACTER ASSETS (scene references only): ${assetSummary(characterIds) || "(none)"}`,
    `PROP ASSETS (scene references only): ${assetSummary(propIds) || "(none)"}`,
    `Existing beats may reference: ${allowedBeats.join(", ") || "(none)"}`,
    `Technical profile: ${JSON.stringify(project.technicalProfile ?? {})}`,
    "",
    "STORYBOARD RULES:",
    "Scene context (first section of the final export): write 1-3 sentences in the user language about this clip only. Cover what is currently happening, who is in frame, where/when it takes place, and the total duration. Never quote prior context, story summary, user notes, AI instructions, warnings, or @ tags.",
    "Director document: return every directorLayers key with concise scene-level direction in the scene language. Do not return actionTiming: all shot timing, actions, beats, and character acting belong exclusively in the shots array. These are editable planning layers, not the final prompt. Keep them consistent with the shots and do not include audit diagnostics or user-only planning text.",
    "LOCATION MAP is a practical spatial-state map, not a mood paragraph. Write it with these labeled fields in this order: camera position; camera facing direction; foreground; midground; background; main landmark positions; character positions; movement path; lighting direction; depth relationships. Use concrete relative positions, distances, axes, entrances, exits, and front/mid/back depth when known. If a location reference exists, use it for geography, materials, atmosphere, landmarks, and relevant lighting direction only; do not blindly inherit its camera angle, framing, or composition unless explicitly requested. The scene character roster is only a spatial baseline: actual characters remain shot-local and must not be copied into every shot.",
    "FIRST FRAME AND SPATIAL BLOCKING: if the first shot requires visible characters or props, state directly that the first visible frame already contains every required subject in its correct position, with no empty establishing frame, no delayed reveal, and no opening frame without the required subjects. Allow an empty opening only when the user explicitly requests it. Flash cuts and very short establishing cuts must still contain the required subject or location information immediately; never add an empty flash cut, abstract filler, or random landscape insert. Preserve the user's first-frame reference images and treat them as spatial occupancy references only.",
    isLongTake
      ? `Shooting mode is LONG TAKE. Return EXACTLY ONE shot, starting at 0 and ending no later than ${durationLimit}s. Put the complete story progression into 1-8 continuous beats inside that one shot. Do not create cut points, alternate camera setups, or additional shot entries.`
      : `Shooting mode is MULTI-SHOT. Select 1-8 shots only when the story rhythm needs a new viewpoint. Slow, observational, or dialogue-led scenes normally use 1-3 shots; do not add coverage just to fill a template. Use more shots only for a clear change of information, action, or emotional beat.`,
    `Timeline hard limit: all shots are sequential; shot 1 starts at 0; shot N starts where shot N-1 ends; the final endSeconds MUST be less than or equal to ${durationLimit}s. Never exceed the user's ${durationLimit}${seconds} limit. Duration label uses "${seconds}" suffix.`,
    "Every shot needs action, acting, framing, optics.lensCharacter, optics.fieldOfViewDegrees, movement, direction, and participants (only existing character IDs). Framing and optics are a linked pair: Wide / environmental action normally uses 47-standard or 84-wide; Medium close-up / face portrait uses 29-short-tele; Extreme close-up / detail uses 18-tele; distant observation uses 8-supertele. Never return a close framing with a broad environmental lens or a wide framing with a portrait telephoto unless the user explicitly asks for that contrast. Participants are shot-local: add only people visible in frame or required to perform, speak, or receive an on-screen action in that exact shot. Do not copy the scene roster into every shot. Every beat actor and targetCharacterId MUST be listed in that same shot's participants. Assign camera / lensModel from the available IDs when the scene benefits from a specific look, otherwise omit.",
    "Performance (P2): the master profile is who the character is; rewrite it into this exact shot's moment. Present characters only: write an acting paragraph only for characters in that shot's participants; no character in frame means no paragraph for that character. Keep the constant core (identity, vocal profile, signature tics, eye life, emotional through-line) and never contradict the master. Re-express it for this shot's posture, action, beat, emotional pressure, and time of day. Transform behaviors that cannot physically happen instead of deleting them: preserve the same engine while changing its outlet. For each participant, write acting as one flowing paragraph in the character's register, with no bullets, headers, dial labels, or abstract emotion-only wording; use observable face, body, breath, voice, gaze, timing, distance, and reaction. If the pipeline uses asset references, begin the paragraph with that character's reference tag. Set performanceLevel (0-5, 4 default whenever the acting master profile is strong) and eyeLife (micro glances / blink quality / eye glint / eyes leading the turn). Do not paste a master profile. Do not use wardrobe, camera, color, or abstract emotion labels. Fill the beats' P2 fields: tactic (press / charm / provoke...), subtext (true intent opposite to the line), beatChange (visible shift: pause / posture / tempo / eye-line cut), reactionBeforeLine (reaction starting before the other speaker finishes). Every visible action must have its real performer in actorId; a listener or reacting character must get a separate beat with that character's actorId. Use targetCharacterId only for the person being watched, addressed, or reacted to. Never assign a listener's prop action, eye movement, hand movement, or body reaction to the speaker.",
    "Photography (P1): prefer observable lens character over focal-length-only strings. Per shot set optics.lensCharacter from the 7 presets (47-standard / 84-wide / 107-ultrawide / 29-short-tele / 18-tele / 8-supertele / 135-immersive) with optics.fieldOfViewDegrees 8-135 matching the preset, and add lensOutcome + antiDriftLock when the look must stay locked. Set cameraBehavior as physical operator behavior (height / distance / angle / side / subjectSize / screenPlacement / focusBehavior / depthOfField / handheldQuality). Add physicsAnchors for walk / run / weapon / liquid / particle. Per participant set torsoFacing when the body turns away from the eyeline, and anchorDistance when a landmark anchors the scene. At scene level return firstFrameLock.requiredSubjectIds (only existing asset ids that MUST be on screen in frame one) and lightingDirection (primarySource / direction / exposurePriority / allowHighlights / forbid).",
    "State, not transition: write mid-action states (jaw clenched, strides lengthening), never transition chains (starts to... / begins to...). Groups react in staggered waves with different intensities, never in unison.",
    "Dialogue: write only scripted lines for this scene; when a character speaks, everyone else stays quiet. For an intentional silence, hold 1 second of quiet before and after the line; for an immediate interruption, start the line within 0.3 seconds.",
    "Beats: each shot gets 1-4 ordered beats (start order at 1). Each beat has verb + actorId + targetCharacterId/targetPropId (only existing IDs) when applicable, actionText in the scene language, optional dialogue (include dialogue text in the same language as the scene), optional required flag, and optional cutRule. Do not return stateBefore or stateAfter. If a supporting character visibly tightens a grip, changes eyeline, shifts posture, or reacts before dialogue, create a separate beat for that supporting character instead of burying the action in the lead character's beat text.",
    "Prop changes: return one natural-language propChangeDescription for each shot. Describe only visible prop use, contact, movement, or change in the scene language. Do not plan or return starting/ending prop states; those fields are legacy and ignored.",
    "Negative prompt: produce one comma-separated string of concrete negative constraints for this scene in the language of the scene (Chinese if the scene is Chinese), covering character/wardrobe drift, extra limbs, physics, floating props, water/dust on lens where relevant, and scene-specific artifacts to avoid.",
    "Audio: use the user audio plan above only to understand pacing and on-screen behavior. Do not invent a replacement plan, do not return a top-level audioPlan key, and do not change the user's audio settings. The compiler, not the AI layers, applies the user's explicitly selected music, SFX, score, and subtitle settings to final delivery.",
    "",
    "Return ONLY a JSON object matching this schema:",
    "The top-level object MUST also include \"negativePrompt\": string (see Negative prompt rule).",
    CLEAN_SCENE_DRAFT_PROMPT_SCHEMA,
    "Each shot also has propChangeDescription: string | null. Use it for one natural-language description of visible prop use or change. Do not return propStatesAtStart or propStatesAtEnd.",
    ...vocabLines,
    "Do NOT invent character/prop IDs. Do NOT add prose or keys outside the schema (the only exception is the top-level negativePrompt field).",
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
export async function generateFinalPrompt(sourcePrompt: string, locale: Locale, onProgress?: (stage: SceneCompileProgress) => void): Promise<string> {
  const settings = loadAISettings();
  if (!isRemoteConfigured(settings)) {
    throw new Error("AI 未配置，请先在 LenTalk「设置 → 自定义平台」配置 Chat 模型与 API Key。");
  }
  const request = buildFinalPromptRequest(sourcePrompt, locale);
  return chatCompletionsText(settings, request.system, request.user, onProgress);
}

export function buildFinalPromptRequest(sourcePrompt: string, locale: Locale): { system: string; user: string } {
  const zh = locale === "zh";
  const languageRule = zh
    ? "只用清晰、电影级的中文输出。即使规范源包含英文，也必须将其忠实转换为自然、直接、可拍摄、可执行的中文提示词；避免翻译腔、空泛形容词和散文化抒情。"
    : "Output only clear, cinematic-grade English. Even if the canonical source contains Chinese, faithfully convert it into natural, direct, shootable, executable English; avoid literal translation, vague adjectives, and poetic prose.";
  const headingsRule = zh
    ? "只输出以下非空类别，必须使用这些中文标题，并严格按此顺序：场景上下文、活动引用、场景地图、首帧与空间走位、格式模式、光学、摄像机、动作节奏、物理、光线、音频、风格、正向约束。仅当源中存在时才输出：负向约束。"
    : "Output only the following non-empty categories, using exactly these English headings and this order: SCENE CONTEXT, ACTIVE REFERENCES, LOCATION MAP, FIRST FRAME AND SPATIAL BLOCKING, FORMAT MODE, OPTICS, CAMERA, ACTION TIMING, PHYSICS, LIGHTING, AUDIO, STYLE, POSITIVE CONSTRAINTS. Output NEGATIVE CONSTRAINTS only when present in the source.";
  const styleRule = zh
    ? "空间锁定必须在摄像机之前，光学必须在一般美术语言之前，光线必须作为优先级锁。允许输出风格，但风格必须位于光线之后、正向约束之前，只描述画面质感、色彩、构图、材质和氛围，不重复光学、摄像机、动作或光线锁。不要新增质量、角色表演或其他标题；角色表演必须附着在动作节奏中对应的镜头和人物之后。"
    : "Keep spatial locks before camera, optics before general visual language, and lighting as a priority lock. STYLE must come after LIGHTING and before POSITIVE CONSTRAINTS; describe only image texture, color, composition, materials, and atmosphere, without repeating optics, camera, action, or lighting locks. Do not add QUALITY, CHARACTER ACTING, or any other heading; attach acting to the corresponding shot and character inside ACTION TIMING.";
  return {
    system: "You are CINEDANCE V4, the final delivery editor for Seedance and Higgsfield cinematic video prompts. "
      + (zh
        ? "Return only the finished prompt in clear, cinematic-grade Chinese, with no commentary, markdown fence, rationale, audit note, or greeting."
        : "Return only the finished prompt in clear, cinematic-grade English, with no commentary, markdown fence, rationale, audit note, or greeting."),
    user: [
      languageRule,
      "The canonical source below combines the editable director document with the structured shot execution. Preserve every concrete fact, active reference, timing, character action, acting behavior, and constraint.",
      "Every @asset_tag, [imageN], and @audioN token is an opaque Seedance platform reference. Copy each one exactly as supplied: never translate, delete, rename, normalize, duplicate, or invent one. Keep each asset's appearance, acting template, voice lock, voice reference, and prop description exclusively in ACTIVE REFERENCES; do not repeat those descriptions elsewhere.",
      "Do not invent, remove, reinterpret, or contradict any fact. Do not add prior context, story summaries, user notes, AI instructions, warnings, scores, or diagnostics.",
      headingsRule,
      styleRule,
      "",
      "CANONICAL AUDITED SOURCE:",
      sourcePrompt,
    ].join("\n"),
  };
}

const FINAL_SOURCE_SECTIONS = [
  { key: "sceneContext", heading: "SCENE CONTEXT" },
  { key: "activeReferences", heading: "ACTIVE REFERENCES" },
  { key: "locationMap", heading: "LOCATION MAP" },
  { key: "firstFrame", heading: "FIRST FRAME AND SPATIAL BLOCKING" },
  { key: "formatMode", heading: "FORMAT MODE" },
  { key: "optics", heading: "OPTICS" },
  { key: "camera", heading: "CAMERA" },
  { key: "actionTiming", heading: "ACTION TIMING" },
  { key: "physics", heading: "PHYSICS" },
  { key: "lighting", heading: "LIGHTING" },
  { key: "audio", heading: "AUDIO" },
  { key: "style", heading: "STYLE" },
  { key: "positiveConstraints", heading: "POSITIVE CONSTRAINTS" },
  { key: "negativeLocks", heading: "NEGATIVE CONSTRAINTS" },
] as const;

function extractPromptSection(source: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n\\n)${escaped}:\\n`, "m").exec(source);
  if (!match) return "";
  const start = match.index + match[0].length;
  const next = /\n\n[A-Z][A-Z ]+:\n/g;
  next.lastIndex = start;
  const end = next.exec(source)?.index ?? source.length;
  return source.slice(start, end).trim();
}

function withoutLayerHeading(text: string, heading: string, chineseHeading: string): string {
  return text.trim().replace(new RegExp(`^(?:${heading}|${chineseHeading})[：:]\\s*`, "i"), "").trim();
}

/**
 * Final delivery source is a single canonical sequence, not a director-document
 * dump followed by another full prompt. Edited director layers remain primary;
 * structured shots supply ACTION TIMING so acting and beats stay shot-local.
 */
export function buildFinalGenerationSource(project: ProjectV2, scene: SceneV2): string {
  const generatedLayers = buildDirectorDocumentLayers(project, scene, { locale: "en" });
  const editedLayers = scene.directorLayers ?? {};
  const englishSequence = compileDirectorSequence(project, scene, { locale: "en" });
  const labelsByKey = new Map(DIRECTOR_LAYERS.map((layer) => [layer.key, layer]));
  const sections: string[] = [];

  for (const section of FINAL_SOURCE_SECTIONS) {
    let body = "";
    if (section.key === "actionTiming") {
      body = extractPromptSection(englishSequence, "SHOT EXECUTION");
    } else if (section.key === "activeReferences") {
      // References are executable data, not an editable prose layer.
      body = generatedLayers.activeReferences || "";
    } else {
      const layer = labelsByKey.get(section.key as typeof DIRECTOR_LAYER_ORDER[number]);
      const edited = layer ? withoutLayerHeading(editedLayers[section.key] ?? "", section.heading, layer.zh) : "";
      body = edited || generatedLayers[section.key as typeof DIRECTOR_LAYER_ORDER[number]] || "";
    }
    if (body.trim()) sections.push(`${section.heading}:\n${body.trim()}`);
  }
  return sections.join("\n\n");
}

/** 解析 AI 返回的 directorLayers：仅保留 canonical 层 key，且值非空。 */
function normalizeDirectorLayers(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const key of DIRECTOR_LAYER_ORDER) {
    const text = asString(raw[key]).trim();
    if (text) result[key] = text;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function normalizeSceneDraft(project: ProjectV2, scene: SceneV2, data: unknown, seconds: string, locale: Locale = "zh"): {
  scene: SceneV2;
  negativePrompt?: string;
  directorLayers?: Record<string, string>;
  directorLayerIssues?: DirectorLayerIssue[];
} {
  const obj = (data ?? {}) as Record<string, unknown>;
  const assets = project.assets ?? [];
  const characterIds = new Set(assets.filter((asset) => asset.kind === "character").map((asset) => asset.id));
  const propIds = new Set(assets.filter((asset) => asset.kind === "prop").map((asset) => asset.id));
  const orderIds = [...(scene.staging?.characterOrder ?? [])].filter((id) => characterIds.has(id));
  const sceneContext = asString(obj.sceneContext, scene.sceneContext ?? "").trim();
  const candidateDirectorLayers = normalizeDirectorLayers(obj.directorLayers);

  const LENS_CHARACTERS = new Set(["47-standard", "84-wide", "107-ultrawide", "29-short-tele", "18-tele", "8-supertele", "135-immersive"]);
  const PHYSICS_ANCHOR_KINDS = new Set(["walk", "run", "weapon", "liquid", "particle"]);
  const normalizeOptics = (raw: unknown): Optics | undefined => {
    const part = (raw ?? {}) as Record<string, unknown>;
    const result: Optics = {};
    const lensCharacter = asString(part.lensCharacter, undefined);
    if (lensCharacter && LENS_CHARACTERS.has(lensCharacter)) result.lensCharacter = lensCharacter as Optics["lensCharacter"];
    const fov = asNumber(part.fieldOfViewDegrees, NaN);
    if (Number.isFinite(fov)) result.fieldOfViewDegrees = Math.max(8, Math.min(135, Math.round(fov)));
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
  const normalizeFirstFrameLock = (raw: unknown): FirstFrameLock | undefined => {
    const part = (raw ?? {}) as Record<string, unknown>;
    const ids = asStringArray(part.requiredSubjectIds).filter((id) => characterIds.has(id) || propIds.has(id));
    const occupancyStatement = asString(part.occupancyStatement, undefined);
    const referenceImages = (scene.firstFrameLock?.referenceImages ?? []).map((source) => source.trim()).filter(Boolean);
    if (ids.length === 0 && !occupancyStatement && referenceImages.length === 0) return undefined;
    return {
      ...(ids.length > 0 ? { requiredSubjectIds: ids } : {}),
      ...(occupancyStatement ? { occupancyStatement } : {}),
      ...(referenceImages.length > 0 ? { referenceImages } : {}),
    };
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
    for (const rawBeat of rawBeats.slice(0, 12)) {
      const beat = (rawBeat ?? {}) as Record<string, unknown>;
      const actorId = asString(beat.actorId, undefined);
      const targetCharacterId = asString(beat.targetCharacterId, undefined);
      const targetPropId = asString(beat.targetPropId, undefined);
      if (actorId && !participantIds.has(actorId)) continue;
      if (targetCharacterId && !participantIds.has(targetCharacterId)) continue;
      if (targetPropId && !propIds.has(targetPropId)) continue;
      beats.push({
        id: newId(),
        order: beatOrder++,
        duration: asNumber(beat.duration, 4),
        actorId,
        verb: asString(beat.verb, "acts"),
        targetCharacterId,
        targetPropId,
        targetBodyPart: asString(beat.targetBodyPart, undefined),
        actionText: asString(beat.actionText, undefined),
        dialogue: asString(beat.dialogue, undefined),
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
    const recommendedLensId = /extreme\s*close|极近特写|细节|macro|insert/i.test(framing)
      ? "18-tele"
      : /close[- ]?up|portrait|特写|肖像|面部|面孔|中近景/i.test(framing)
        ? "29-short-tele"
        : /wide|full|establishing|全景|远景|广角/i.test(framing)
          ? "84-wide"
          : "47-standard";
    const recommendedLens = lensById(recommendedLensId);
    const selectedLensId = shotOptics?.lensCharacter ?? lensByFov(legacyFov)?.id;
    const selectedLens = selectedLensId ? lensById(selectedLensId) : undefined;
    const needsNarrowLens = /extreme\s*close|close[- ]?up|portrait|特写|肖像|面部|面孔|中近景|细节|macro|insert/i.test(framing);
    const needsBroadLens = /wide|full|establishing|全景|远景|广角/i.test(framing);
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

  const activeCharacterIds = new Set(shots.flatMap((shot) => shot.participants?.map((participant) => participant.characterId) ?? []));
  const actingObjectives = (Array.isArray(obj.actingObjectives) ? obj.actingObjectives : [])
    .map((rawItem) => {
      const item = (rawItem ?? {}) as Record<string, unknown>;
      const characterId = asString(item.characterId);
      if (!activeCharacterIds.has(characterId)) return null;
      const objective = asString(item.objective);
      if (!objective) return null;
      return {
        characterId,
        objective,
        superObjective: asString(item.superObjective, undefined),
        obstacle: asString(item.obstacle, undefined),
        stakes: asString(item.stakes, undefined),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  const firstShotIds = new Set([
    ...(shots[0]?.participants?.map((participant) => participant.characterId) ?? []),
    ...(shots[0]?.beats?.flatMap((beat) => [beat.targetPropId, beat.targetCharacterId].filter((id): id is string => Boolean(id))) ?? []),
  ]);
  const rawFirstFrameLock = normalizeFirstFrameLock(obj.firstFrameLock);
  const requiredSubjectIds = (rawFirstFrameLock?.requiredSubjectIds ?? []).filter((id) => firstShotIds.has(id));
  const firstFrameLock = rawFirstFrameLock && (requiredSubjectIds.length > 0 || rawFirstFrameLock.occupancyStatement || rawFirstFrameLock.referenceImages?.length)
    ? { ...rawFirstFrameLock, ...(requiredSubjectIds.length > 0 ? { requiredSubjectIds } : {}) }
    : undefined;
  const lightingDirection = normalizeLightingDirection(obj.lightingDirection);

  const structuredScene: SceneV2 = {
      ...scene,
      name: asString(obj.sceneName, scene.name),
      ...(sceneContext ? { sceneContext } : {}),
      emotionArc: asString(obj.emotionArc, scene.emotionArc ?? ""),
      ...(actingObjectives.length > 0 ? { actingObjectives } : {}),
      ...(firstFrameLock ? { firstFrameLock } : {}),
      ...(lightingDirection ? { lightingDirection } : {}),
      shots,
  };
  // Validate AI prose against the newly generated shots, not the obsolete
  // pre-compile scene. Missing or rejected AI layers are deterministically
  // rebuilt from the same structured scene so the document is never blank.
  const directorLayerIssues = candidateDirectorLayers
    ? validateDirectorLayers(candidateDirectorLayers, project, structuredScene)
    : [];
  const generatedLayers = buildDirectorDocumentLayers(project, structuredScene, { locale });
  const acceptedAiLayers = candidateDirectorLayers && !directorLayerIssues.some((issue) => issue.severity === "error")
    ? candidateDirectorLayers
    : {};
  const directorLayers = { ...generatedLayers, ...acceptedAiLayers };

  return {
    scene: { ...structuredScene, directorLayers },
    negativePrompt: asString(obj.negativePrompt, undefined),
    directorLayers,
    ...(directorLayerIssues.length > 0 ? { directorLayerIssues } : {}),
  };
}
