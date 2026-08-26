/**
 * AI 辅助层（P3）— 桌面端实现
 * 配置了 API Key 时使用远程 OpenAI 兼容 Chat Completions（OpenAI / DeepSeek / Kimi / 通义 / 智谱 / 自定义），
 * 未配置或请求失败时自动回退本地模板建议。
 */
import { DIRECTOR_LAYER_ORDER, LocalSuggestionProvider, SHOT_TEMPLATES, localizedStyleBrief } from "../../engine";
import type { AIAssistant, AssetSuggestion, BeatSuggestion, FixSuggestion, SceneSuggestion } from "../../engine";
import { buildSceneAssetRegistry } from "../../engine/compiler/renderer";
import { fovToLegacyFocalLength, legacyFocalLengthToFov, lensByFov } from "../../engine/presets";
import { validateDirectorLayers, type DirectorLayerIssue } from "../../engine/quality";
import type {
  ActionBeat, Asset, AssetActingProfile, AssetKind, CameraBehavior, CameraMovement, ContinuityIssueV2, CutStyle,
  FirstFrameLock, LightingDirection, LockLevel, Optics, PhysicsAnchor, ProjectV2, PropState, SceneV2, ShotParticipant, ShotV2,
} from "../../shared-types";
import { isRemoteConfigured, loadAISettings, normalizeBaseUrl, openAICompatibleBaseUrl, type AISettings } from "./aiSettings";
import type { Locale } from "../i18n";

const localProvider = new LocalSuggestionProvider();

interface AIModelProxyPayload {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * 本地预览（Vite / Tauri dev）下把请求转发给 dev server 的 /__ai_proxy，
 * 由本地中间件代替浏览器请求外部 API，绕过浏览器 CORS 限制；
 * 非浏览器环境（Tauri 打包版原生上下文）仍然使用原生 fetch。
 */
async function remoteFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  if (isTauri) {
    try {
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
    } catch {
      // 宿主未提供该命令时继续走下方浏览器代理/直连降级。
    }
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
  const timer = setTimeout(() => controller.abort(), 300_000);
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


async function chatCompletionsJSON(settings: AISettings, system: string, user: string, imageUrls: string[] = []): Promise<unknown> {
  const endpoint = `${openAICompatibleBaseUrl(settings.baseUrl)}/chat/completions`;
  const messages = [
    { role: "system", content: system },
    {
      role: "user",
      content: imageUrls.length > 0
        ? [
            { type: "text", text: user },
            ...imageUrls.map((url) => ({ type: "image_url", image_url: { url } })),
          ]
        : user,
    },
  ];
  const buildBody = (withJsonMode: boolean) => ({
    model: settings.model.trim(),
    temperature: settings.temperature ?? 0.4,
    messages,
    ...(withJsonMode ? { response_format: { type: "json_object" as const } } : {}),
  });
  const request = (withJsonMode: boolean) => remoteFetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey.trim()}`,
    },
    body: JSON.stringify(buildBody(withJsonMode)),
  });
  let response = await request(true);
  // 部分 OpenAI 兼容服务/中转站不支持 response_format：
  // 有的直接返回 400，有的会把内层 400 包装成 502（Bad Gateway）。
  // 400 且正文提及 response_format 时，或 502 时，去掉 JSON 模式重试一次。
  if (response.status === 400 || response.status === 502) {
    const raw = await response.clone().text();
    if (response.status === 502 || /response_format|json_object/i.test(raw)) {
      response = await request(false);
    }
  }
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}${raw ? `：${raw.slice(0, 260)}` : ""}`);
  }
  const data = await response.json() as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("响应中没有文本内容");
  return extractJSON(content);
}

async function chatJSON(settings: AISettings, system: string, user: string): Promise<unknown> {
  return chatCompletionsJSON(settings, system, user);
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
    } catch {
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

export type AIModelErrorKind = "base" | "network" | "timeout" | "http" | "empty" | "other";

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
  if (/^HTTP \d+/.test(message)) kind = "http";
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
  if (images.length === 0) {
    throw new Error("请先上传至少一张参考图，AI 需要看图才能填写详细。");
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
        `- actingProfile.${masterField}: the character's acting master template in ${language} (performance wording for face/body/wardrobe, 3-6 clauses).`,
        `- actingProfile.${voiceField}: the character's voice-lock formula in ${language} (paste it verbatim when the character speaks).`,
        "- actingProfile.performanceTarget: integer 0-5. After writing the master profile, self-score it (0 mannequin / 1 reciting / 2 diligent / 3 craftsman / 4 alive / 5 magnet). If your self-score is below 4, rewrite the master profile until it reaches 4, then set performanceTarget to that final score (default 4).",
      ]
    : [];

  const data = await chatCompletionsJSON(settings, JSON_SYSTEM, [
    "You are filling in a production asset card for a cinematic AI video prompt studio.",
    `Answer ONLY in ${language}.`,
    "Analyze the attached reference image(s) carefully. Every field must be grounded in what you can see (or, for style refs, derive consistently) — no invented details.",
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
    ...characterRules,
    ...(isCharacter
      ? ["For a character, absorb the user's personality, motivation, speaking habits, and voice notes into actingProfile.masterProfile and actingProfile.voicePrompt; do not output the notes field itself."]
      : ["For this asset, use the user notes only to disambiguate the image and improve the canonical description; do not output the notes field itself."]),
    "",
    `Asset kind: ${asset.kind}`,
    "Current values already filled by the user (keep them unless the image clearly contradicts them): " + JSON.stringify(existing),
    "",
    "Do NOT add prose or keys outside the schema.",
  ].join("\n"), images);

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
  propStatesAtStart?: unknown;
  propStatesAtEnd?: unknown;
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
 * 生成完整的剧情分镜（镜头列表 + 各镜头检查器内容 + 导演文档），音频计划只作为用户输入读取，不回写。
 * @throws 未配置远程模型 / 请求失败
 */
export async function fillSceneDraft(project: ProjectV2, scene: SceneV2, t?: { seconds?: string; locale?: Locale }): Promise<{
  scene: SceneV2;
  negativePrompt?: string;
  directorLayers?: Record<string, string>;
  directorLayerIssues?: DirectorLayerIssue[];
}> {
  const settings = loadAISettings();
  if (!isRemoteConfigured(settings)) {
    throw new Error("AI 未配置，请先在右上角「设置 → API 设置」中填写服务商、模型与 API Key。");
  }

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
    "Read the scene card content below and plan a complete, professional storyboard for this scene: shot list, every shot's camera/performance/participants/beats/prop states, and the audio plan. Treat the style direction as one coherent visual system; do not scatter it into contradictory style labels.",
    "",
    "SCENE CARD CONTENT:",
    `Logline (故事梗概): ${scene.logline?.trim() || "(empty)"}`,
    `Prior context (前情续接): ${scene.staging?.priorContext?.trim() || "(empty)"}`,
    `Spatial anchor (空间锚点): ${scene.staging?.anchorDescription?.trim() || "(empty)"}`,
    `Character order (左到右站位, left-to-right): ${orderIds.length > 0 ? assetSummary(orderIds) : "(none/empty)"}`,
    `Performance objectives (表演目标, per character): ${JSON.stringify(scene.actingObjectives ?? [])}`,
    `Axis direction: ${scene.staging?.axisDirection ?? "left-to-right"}; Spacing: ${scene.staging?.spacing?.trim() || "(default)"}`,
    `Scene emotion arc: ${scene.emotionArc?.trim() || "(not set)"}; Scene name: ${scene.name}`,
    `Style direction: ${styleBrief || "(not set)"}`,
    `User audio plan (read-only; do not return or overwrite the audio plan card): ${JSON.stringify(project.audioPlan ?? { score: "none", subtitles: false })}`,
    "",
    `LOCATION ASSET: ${locationAsset ? `${locationAsset.name}(${locationAsset.id}) — ${locationAsset.description?.trim() || locationAsset.descriptionZh?.trim() || ""}` : "(none)"}`,
    `CHARACTER ASSETS (scene references only): ${assetSummary(characterIds) || "(none)"}`,
    `PROP ASSETS (scene references only): ${assetSummary(propIds) || "(none)"}`,
    `Existing beats may reference: ${allowedBeats.join(", ") || "(none)"}`,
    `Technical profile: ${JSON.stringify(project.technicalProfile ?? {})}`,
    "",
    "STORYBOARD RULES:",
    "Plan 1-8 shots covering the whole scene: establish, medium, close-up/detail, reaction, and any beat-driven shots. Use more shots for longer/more complex scenes and fewer for simple ones. Vary framing, FOV, camera and movement meaningfully. Keep shots in chronological order; each shot's duration 3-12s.",
    `Timeline: all shots are sequential; shot 1 starts at 0; shot N starts where shot N-1 ends; pass startSeconds/endSeconds. Duration label uses "${seconds}" suffix.`,
    "Every shot needs action, acting, framing, optics.fieldOfViewDegrees, movement, direction, and participants (only existing character IDs). Assign camera / lensModel from the available IDs when the scene benefits from a specific look, otherwise omit.",
    "Performance (P2): per shot, set performanceLevel (0-5, 4 default whenever the acting master profile is strong) and eyeLife (micro glances / blink quality / eye glint / eyes leading the turn). Fill the beats' P2 fields: tactic (press / charm / provoke...), subtext (true intent opposite to the line), beatChange (visible shift: pause / posture / tempo / eye-line cut), reactionBeforeLine (reaction starting before the other speaker finishes).",
    "Photography (P1): prefer observable lens character over focal-length-only strings. Per shot set optics.lensCharacter from the 7 presets (47-standard / 84-wide / 107-ultrawide / 29-short-tele / 18-tele / 8-supertele / 135-immersive) with optics.fieldOfViewDegrees 8-135 matching the preset, and add lensOutcome + antiDriftLock when the look must stay locked. Set cameraBehavior as physical operator behavior (height / distance / angle / side / subjectSize / screenPlacement / focusBehavior / depthOfField / handheldQuality). Add physicsAnchors for walk / run / weapon / liquid / particle. Per participant set torsoFacing when the body turns away from the eyeline, and anchorDistance when a landmark anchors the scene. At scene level return firstFrameLock.requiredSubjectIds (only existing asset ids that MUST be on screen in frame one) and lightingDirection (primarySource / direction / exposurePriority / allowHighlights / forbid).",
    "State, not transition: write mid-action states (jaw clenched, strides lengthening), never transition chains (starts to... / begins to...). Groups react in staggered waves with different intensities, never in unison.",
    "Dialogue: write only scripted lines for this scene; when a character speaks, everyone else stays quiet. For an intentional silence, hold 1 second of quiet before and after the line; for an immediate interruption, start the line within 0.3 seconds.",
    "Beats: each shot gets 1-4 ordered beats (start order at 1). Each beat has verb + actorId + targetCharacterId/targetPropId (only existing IDs) when applicable, actionText in the scene language, optional dialogue (include dialogue text in the same language as the scene), optional stateBefore/stateAfter (propId must be an existing prop), optional required flag, and optional cutRule.",
    "propStatesAtStart / propStatesAtEnd: use only existing prop IDs; the state chain must be consistent across shots.",
    "Negative prompt: produce one comma-separated string of concrete negative constraints for this scene in the language of the scene (Chinese if the scene is Chinese), covering character/wardrobe drift, extra limbs, physics, floating props, water/dust on lens where relevant, and scene-specific artifacts to avoid.",
    "Audio: use the user audio plan above as the source of truth. Rephrase or clarify it only inside the AUDIO director layer when needed; do not invent a replacement plan, do not return a top-level audioPlan key, and do not change the user's audio settings.",
    "DIRECTOR LAYERS: also produce \"directorLayers\", an object that lays out this scene as a director-level document in this exact order. Each key maps to one full text block whose FIRST line is its own section header (Chinese header when the scene is Chinese, English uppercase otherwise).",
    `Layer keys in order: ${DIRECTOR_LAYER_ORDER.join(", ")}.`,
    "Use only these canonical section headers; never invent, translate, rename, or omit a header. Choose the Chinese header for a Chinese scene and the English uppercase header for an English scene:",
    "sceneContext=场景上下文 / SCENE CONTEXT; activeReferences=活动引用 / ACTIVE REFERENCES; locationMap=位置图 / LOCATION MAP; firstFrame=首帧与站位 / FIRST FRAME AND SPATIAL BLOCKING; formatMode=格式模式 / FORMAT MODE; optics=光学 / OPTICS; camera=相机 / CAMERA; actionTiming=动作时间 / ACTION TIMING; physics=物理 / PHYSICS; lighting=光线 / LIGHTING; audio=音频 / AUDIO; positiveConstraints=正向约束 / POSITIVE CONSTRAINTS; negativeLocks=负面局部锁 / NEGATIVE LOCKS.",
    "sceneContext: one or two sentences for this scene only (no scene number, no prior-context summary).",
    "activeReferences: list ONLY the @tag assets provided in the scene-reference asset lists; never mention assets absent from those lists.",
    "locationMap: camera position/orientation, foreground-midground-background, landmarks, movement paths, light direction.",
    "firstFrame: first-frame occupancy lock + spatial blocking (who/where at frame one).",
    "formatMode: SINGLE CONTINUOUS TAKE or CONTROLLED MULTI-SHOT SEQUENCE (long-take vs multi-shot).",
    "optics: diagonal field-of-view + observable lens outcome + anti-drift lock.",
    "camera: physical operator behavior (height, distance, angle, side, screen placement, focus, depth of field, handheld quality).",
    "actionTiming: wall-clock time blocks (0:00-0:03 …) each carrying position/action/camera/prop/physics/audio.",
    "physics: physics anchors + walk/run/weapon/liquid/particle locks per shot.",
    "lighting: structured light-direction lock (key light, direction, exposure priority, highlights, forbids).",
    "audio: audio + dialogue rules + per-character voice lock.",
    "positiveConstraints: positive hard constraints (character count lock, strict identity, user hard constraints).",
    "negativeLocks: only global failure modes (identity drift, floating motion, text/watermark); local locks go inline in their own section instead.",
    "Never output project-management metadata such as enabled assets, disabled assets, unused assets, or project-only assets. Never mention an asset by name unless it is in the scene-reference asset lists.",
    "",
    "Return ONLY a JSON object matching this schema:",
    "The top-level object MUST also include \"negativePrompt\": string (see Negative prompt rule) and \"directorLayers\": object (see DIRECTOR LAYERS rule).",
    `{ "sceneName": string, "emotionArc": string, "actingObjectives": [ { "characterId": string, "objective": string, "superObjective": string | null, "obstacle": string | null, "stakes": string | null } ], "firstFrameLock": { "requiredSubjectIds": string[], "occupancyStatement": string | null }, "lightingDirection": { "primarySource": string | null, "direction": string | null, "exposurePriority": string | null, "allowHighlights": string[], "forbid": string[] }, "negativePrompt": string, "directorLayers": { "sceneContext": string, "activeReferences": string, "locationMap": string, "firstFrame": string, "formatMode": string, "optics": string, "camera": string, "actionTiming": string, "physics": string, "lighting": string, "audio": string, "positiveConstraints": string, "negativeLocks": string }, "audioPlan": { "diegeticMusic": string[], "musicSourcePropId": string | null, "sfx": string[], "score": "none" | "original-score", "subtitles": boolean }, "shots": [ { "time": { "startSeconds": number, "endSeconds": number }, "label": string, "framing": string, "lens": string, "lensModel": string | null, "camera": string | null, "optics": { "lensCharacter": "47-standard" | "84-wide" | "107-ultrawide" | "29-short-tele" | "18-tele" | "8-supertele" | "135-immersive" | null, "fieldOfViewDegrees": number | null, "lensOutcome": string[] | null, "antiDriftLock": string | null }, "cameraBehavior": { "height": string | null, "distance": string | null, "angle": string | null, "side": string | null, "subjectSize": string | null, "screenPlacement": string | null, "focusBehavior": string | null, "depthOfField": string | null, "handheldQuality": string | null }, "physicsAnchors": [ { "kind": "walk" | "run" | "weapon" | "liquid" | "particle", "detail": string | null } ], "movement": string, "action": string, "acting": string, "performanceLevel": number, "eyeLife": string, "direction": "left-to-right" | "right-to-left", "cutStyle": "hard-cut" | "overlap" | "match-cut", "participants": [ { "characterId": string, "role": "primary" | "supporting" | "target" | "background", "position": string | null, "entrance": "already-in-frame" | "enters-left" | "enters-right" | null, "facing": string | null, "eyeline": string | null, "torsoFacing": string | null, "anchorDistance": string | null } ], "beats": [ { "order": number, "duration": number, "verb": string, "actorId": string | null, "targetCharacterId": string | null, "targetPropId": string | null, "targetBodyPart": string | null, "actionText": string | null, "dialogue": string | null, "tactic": string | null, "subtext": string | null, "beatChange": string | null, "reactionBeforeLine": string | null, "required": boolean, "forbiddenTargets": string[], "stateBefore": [ { "propId": string, "state": string, "holderCharacterId": string | null, "position": string | null } ], "stateAfter": [ { "propId": string, "state": string, "holderCharacterId": string | null, "position": string | null } ], "cutRule": string | null, "note": string | null } ], "propStatesAtStart": [ { "propId": string, "state": string, "holderCharacterId": string | null, "position": string | null } ], "propStatesAtEnd": [ { "propId": string, "state": string, "holderCharacterId": string | null, "position": string | null } ], "note": string | null } ] }`,
    ...vocabLines,
    "Do NOT invent character/prop IDs. Do NOT add prose or keys outside the schema (the only exceptions are the top-level negativePrompt and directorLayers fields).",
  ].join("\n")
    .replace(', "audioPlan": { "diegeticMusic": string[], "musicSourcePropId": string | null, "sfx": string[], "score": "none" | "original-score", "subtitles": boolean }, "shots"', ', "shots"')
    .replace(/, "lens": string,/, ''));

  return normalizeSceneDraft(project, scene, data, seconds);
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

export function normalizeSceneDraft(project: ProjectV2, scene: SceneV2, data: unknown, seconds: string): {
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
  const candidateDirectorLayers = normalizeDirectorLayers(obj.directorLayers);
  // V2.4：AI 写回前复用同一质量门；error 级分层整体丢弃，交给结构化镜头数据兜底。
  // 显式覆盖为 undefined，避免展开旧 scene 时把上一版坏文本带回工程。
  const directorLayerIssues = candidateDirectorLayers
    ? validateDirectorLayers(candidateDirectorLayers, project, scene)
    : [];
  const directorLayers = candidateDirectorLayers && !directorLayerIssues.some((issue) => issue.severity === "error")
    ? candidateDirectorLayers
    : candidateDirectorLayers
      ? undefined
      : scene.directorLayers;

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
    if (ids.length === 0 && !occupancyStatement) return undefined;
    return { ...(ids.length > 0 ? { requiredSubjectIds: ids } : {}), ...(occupancyStatement ? { occupancyStatement } : {}) };
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
  const generated: GeneratedShotResult[] = rawShots.slice(0, 12).map((raw) => ((raw ?? {}) as GeneratedShotResult));
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
      if (!characterIds.has(characterId)) continue;
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
      });
    }

    const stateList = (value: unknown): PropState[] => {
      if (!Array.isArray(value)) return [];
      const list: PropState[] = [];
      for (const rawItem of value.slice(0, 12)) {
        const item = (rawItem ?? {}) as Record<string, unknown>;
        const propId = asString(item.propId);
        if (!propIds.has(propId)) continue;
        list.push({
          propId,
          state: asString(item.state, "intact"),
          holderCharacterId: asString(item.holderCharacterId, undefined),
          position: asString(item.position, undefined),
        });
      }
      return list;
    };

    const beats: ActionBeat[] = [];
    const rawBeats = Array.isArray(raw.beats) ? raw.beats : [];
    let beatOrder = 1;
    for (const rawBeat of rawBeats.slice(0, 12)) {
      const beat = (rawBeat ?? {}) as Record<string, unknown>;
      const actorId = asString(beat.actorId, undefined);
      const targetCharacterId = asString(beat.targetCharacterId, undefined);
      const targetPropId = asString(beat.targetPropId, undefined);
      if (actorId && !characterIds.has(actorId)) continue;
      if (targetCharacterId && !characterIds.has(targetCharacterId)) continue;
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
        forbiddenTargets: asStringArray(beat.forbiddenTargets).filter((id) => characterIds.has(id) || propIds.has(id)),
        stateBefore: stateList(beat.stateBefore),
        stateAfter: stateList(beat.stateAfter),
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
    const normalizedOptics = shotOptics ?? { fieldOfViewDegrees: legacyFov, lensCharacter: lensByFov(legacyFov)?.id };
    const lens = legacyLens || fovToLegacyFocalLength(legacyFov);
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
      propStatesAtStart: stateList(raw.propStatesAtStart),
      propStatesAtEnd: stateList(raw.propStatesAtEnd),
      note: asString(raw.note, undefined),
      layout: {
        useSceneStaging: true,
        ...(orderIds.length > 0 ? { characterOrder: orderIds } : {}),
        axisDirection: scene.staging?.axisDirection ?? "left-to-right",
        ...(scene.staging?.anchorDescription?.trim() ? { anchorDescription: scene.staging.anchorDescription.trim() } : {}),
      },
    } as ShotV2);
  }

  const actingObjectives = (Array.isArray(obj.actingObjectives) ? obj.actingObjectives : [])
    .map((rawItem) => {
      const item = (rawItem ?? {}) as Record<string, unknown>;
      const characterId = asString(item.characterId);
      if (!characterIds.has(characterId)) return null;
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

  const firstFrameLock = normalizeFirstFrameLock(obj.firstFrameLock);
  const lightingDirection = normalizeLightingDirection(obj.lightingDirection);

  return {
    scene: {
      ...scene,
      name: asString(obj.sceneName, scene.name),
      emotionArc: asString(obj.emotionArc, scene.emotionArc ?? ""),
      ...(actingObjectives.length > 0 ? { actingObjectives } : {}),
      ...(firstFrameLock ? { firstFrameLock } : {}),
      ...(lightingDirection ? { lightingDirection } : {}),
      shots,
      directorLayers,
    },
    negativePrompt: asString(obj.negativePrompt, undefined),
    directorLayers,
    ...(directorLayerIssues.length > 0 ? { directorLayerIssues } : {}),
  };
}
