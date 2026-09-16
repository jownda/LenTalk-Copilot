import { invoke, isTauri } from '@tauri-apps/api/core';
import { CUSTOM_API_PROVIDER_PREFIX, useSettingsStore } from '@/stores/settingsStore';
import type { CustomApiCapabilities } from '@/stores/settingsStore';
import { isWindowsDesktopRuntime } from '@/platform/runtime';
import { isKnownOpenAiImagesBaseUrl } from '@/features/settings/recommendedApis';
import { persistImageBinary } from '@/commands/image';
import { resolveReferenceAssetSource } from '@/commands/referenceAssetSource';
import {
  createVideoIdempotencyKey,
  getVideoTaskFailureReason,
  resolveRjmVideoApiBaseUrl,
} from '@/commands/videoApi';
import {
  isZzdhBaseUrl,
  resolveZzdhAspectRatio,
  resolveZzdhAspectRatioFromSize,
  resolveZzdhAudioKind,
  resolveZzdhAudioPath,
  resolveZzdhGenerationMode,
  resolveZzdhReferenceRole,
  resolveZzdhResolutionTier,
  resolveZzdhVideoDurationRange,
  resolveZzdhVideoFamily,
  ZZDH_BASE_DEFAULT_VOICE,
  ZZDH_DEFAULT_AUDIO_FORMAT,
  type ZzdhReferenceRole,
} from '@/commands/zzdhApi';
import {
  generateZhenjianImage,
  generateZhenjianVideo,
  extractZhenjianModels,
  isZhenjianProvider,
} from '@/commands/zhenjianApi';

export interface GenerateRequest {
  prompt: string;
  /** 负向提示词(上游 AI 服务支持的模型可生效) */
  negative_prompt?: string;
  model: string;
  size: string;
  aspect_ratio: string;
  reference_images?: string[];
  extra_params?: Record<string, unknown>;
}

export interface GenerateVideoRequest {
  prompt: string;
  model: string;
  duration: number;
  aspect_ratio: string;
  video_resolution?: string;
  image_mode?: 'reference' | 'first-last';
  reference_images?: string[];
  reference_audio?: string[];
  extra_params?: Record<string, unknown>;
}

interface GenerateJimengCliVideoRequest {
  client_job_id?: string;
  executable: string;
  prompt: string;
  model_version: string;
  duration: number;
  aspect_ratio: string;
  video_resolution?: string;
  image_mode?: 'reference' | 'first-last';
  reference_images?: string[];
  reference_audio?: string[];
}

/**
 * 即梦 CLI 图片生成: 参考图为空时走 `text2image`, 非空时走 `image2image`,
 * 由 Rust 侧按参考图数量决定, 前端不需要区分。
 */
interface GenerateJimengCliImageRequest {
  client_job_id?: string;
  executable: string;
  prompt: string;
  model_version: string;
  /** LenTalk 侧是大写档位(1K/2K/4K/1.5K), 下发时归一化为小写。 */
  resolution_type: string;
  aspect_ratio?: string;
  generate_num?: number;
  reference_images?: string[];
}

interface GenerateJimengCliImageUpscaleRequest {
  client_job_id?: string;
  executable: string;
  image: string;
  resolution_type: string;
}

/**
 * 即梦 CLI 图片模型 id 前缀(model 形如 `jimeng-cli/image-5.0`)。
 * 与 `canvas/models/registry.ts` 的 JIMENG_CLI_PROVIDER_ID 保持一致;
 * 这里不直接 import 是为了避免 commands 层反向依赖 features 层。
 */
const JIMENG_CLI_IMAGE_MODEL_PREFIX = 'jimeng-cli/image-';

/**
 * 即梦 CLI 图片超清(image_upscale)的内部模型 id —— 注意它**不以**上面的
 * `image-` 前缀开头, 否则会被误判成普通图片模型。
 *
 * 与 `canvas/models/registry.ts` 的 JIMENG_CLI_IMAGE_UPSCALE_MODEL_ID 必须一致,
 * registry.test.ts 里有断言锁住两者相等。
 */
export const JIMENG_CLI_IMAGE_UPSCALE_MODEL = 'jimeng-cli/upscale';

export type GenerationJobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'not_found';

export interface GenerationJobStatus {
  job_id: string;
  status: GenerationJobState;
  result?: string | null;
  error?: string | null;
}

const BASE64_PREVIEW_HEAD = 96;
const BASE64_PREVIEW_TAIL = 24;

function truncateText(value: string, max = 200): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}...(${value.length} chars)`;
}

function truncateBase64Like(value: string): string {
  if (!value) {
    return value;
  }

  if (value.startsWith('data:')) {
    const [meta, payload = ''] = value.split(',', 2);
    if (payload.length <= BASE64_PREVIEW_HEAD + BASE64_PREVIEW_TAIL) {
      return value;
    }
    return `${meta},${payload.slice(0, BASE64_PREVIEW_HEAD)}...${payload.slice(-BASE64_PREVIEW_TAIL)}(${payload.length} chars)`;
  }

  const base64Like = /^[A-Za-z0-9+/=]+$/.test(value) && value.length > 256;
  if (!base64Like) {
    return truncateText(value, 280);
  }

  return `${value.slice(0, BASE64_PREVIEW_HEAD)}...${value.slice(-BASE64_PREVIEW_TAIL)}(${value.length} chars)`;
}

function sanitizeGenerateRequestForLog(request: GenerateRequest): Record<string, unknown> {
  return {
    prompt: truncateText(request.prompt, 240),
    negative_prompt: truncateText(request.negative_prompt ?? '', 240),
    model: request.model,
    size: request.size,
    aspect_ratio: request.aspect_ratio,
    reference_images_count: request.reference_images?.length ?? 0,
    reference_images_preview: (request.reference_images ?? []).map((item) =>
      truncateBase64Like(item)
    ),
    extra_params: request.extra_params ?? {},
  };
}

interface ErrorWithDetails extends Error {
  details?: string;
}

function normalizeInvokeError(error: unknown): { message: string; details?: string } {
  if (error instanceof Error) {
    const detailsText =
      'details' in error
        ? typeof (error as { details?: unknown }).details === 'string'
          ? (error as { details?: string }).details
          : undefined
        : undefined;
    return { message: error.message || 'Generation failed', details: detailsText };
  }

  if (typeof error === 'string') {
    return { message: error || 'Generation failed', details: error || undefined };
  }

  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const message =
      (typeof record.message === 'string' && record.message) ||
      (typeof record.error === 'string' && record.error) ||
      (typeof record.msg === 'string' && record.msg) ||
      'Generation failed';
    let details: string | undefined;
    try {
      details = truncateText(JSON.stringify(record, null, 2), 2000);
    } catch {
      details = truncateText(String(record), 2000);
    }
    return { message, details };
  }

  return { message: 'Generation failed' };
}

function createErrorWithDetails(message: string, details?: string): ErrorWithDetails {
  const error: ErrorWithDetails = new Error(message);
  if (details) {
    error.details = details;
  }
  return error;
}

/**
 * 网络层错误前置翻译: reqwest 抛的 "error sending request for url" 在 tauri
 * 上即指向 Rust send() 失败(DNS / TCP / TLS)。炳火 api.7tai.cc 在境外服务器,
 * 国内直连出现间歇性丢包是已知情况, 对用户直接展示 URL 没有任何可操作的信息。
 * 命中 transport-level 文案时, 给一句分级提示帮助定位(中文优先, 仅当检测到
 * 经典的 reqwest / 浏览器 fetch transport 关键词才翻译, 避免污染业务错误)。
 */
function translateTransportError(message: string, urlLabel: string): string {
  const lower = message.toLowerCase();
  const isTransport = /(error sending request|fetch failed|failed to fetch|request failed|networkerror|connection (refused|reset|timed out)|tls handshake|ssl handshake|dns|getaddrinfo|name resolution)/i.test(lower);
  if (!isTransport) return message;
  return `网络连接到 ${urlLabel} 失败(${message})。该平台服务器在境外, 国内访问可能出现间歇性丢包,稍候重试或检查代理/防火墙设置。`;
}

export async function setApiKey(provider: string, apiKey: string): Promise<void> {
  console.info('[AI] set_api_key', {
    provider,
    apiKeyMasked: apiKey ? `${apiKey.slice(0, 4)}***${apiKey.slice(-2)}` : '',
    tauri: isTauri(),
  });
  if (!isTauri()) {
    // 浏览器降级:key 已存于 settingsStore,无需传给 Rust
    return;
  }
  return await invoke('set_api_key', { provider, apiKey });
}

function mapGptImageSize(aspectRatio: string): string {
  if (['9:16', '3:4', '2:3', '4:5', '1:2', '1:3'].includes(aspectRatio)) {
    return '1024x1536';
  }
  if (['16:9', '3:2', '4:3', '5:4', '2:1', '3:1', '21:9'].includes(aspectRatio)) {
    return '1536x1024';
  }
  return '1024x1024';
}

function usesNativeImageParameters(apiModel: string): boolean {
  const normalized = apiModel.trim().toLowerCase();
  return normalized.endsWith('-native')
    || normalized.endsWith('-n')
    || normalized.includes('gpt-image-1')
    || normalized.includes('dall-e');
}

function mapRequestedImageSize(
  apiModel: string,
  resolution: string,
  aspectRatio: string
): string {
  const normalizedResolution = resolution.trim();
  if (/^\d+x\d+$/i.test(normalizedResolution)) {
    return normalizedResolution;
  }
  if (normalizedResolution.toUpperCase() === '1K') {
    return mapGptImageSize(aspectRatio);
  }
  const targetLongEdge = normalizedResolution.toUpperCase() === '4K'
    ? 3840
    : normalizedResolution.toUpperCase() === '2K'
      ? 2048
      : 0;
  const match = aspectRatio.trim().match(/^(\d+)\s*:\s*(\d+)$/);
  if (!targetLongEdge || !match) {
    return mapGptImageSize(aspectRatio);
  }
  const ratioWidth = Number(match[1]);
  const ratioHeight = Number(match[2]);
  if (!ratioWidth || !ratioHeight) {
    return mapGptImageSize(aspectRatio);
  }
  const roundTo16 = (value: number) => Math.max(16, Math.round(value / 16) * 16);
  let width: number;
  let height: number;
  if (ratioWidth >= ratioHeight) {
    width = targetLongEdge;
    height = roundTo16(targetLongEdge * ratioHeight / ratioWidth);
  } else {
    width = roundTo16(targetLongEdge * ratioWidth / ratioHeight);
    height = targetLongEdge;
  }
  if (usesNativeImageParameters(apiModel)) {
    const maxNativePixels = 8_294_400;
    const pixels = width * height;
    if (pixels > maxNativePixels) {
      const scale = Math.sqrt(maxNativePixels / pixels);
      width = Math.max(16, Math.floor(width * scale / 16) * 16);
      height = Math.max(16, Math.floor(height * scale / 16) * 16);
    }
  }
  return `${width}x${height}`;
}

/** 浏览器降级任务存储:jobId → 状态(与 Rust 异步任务语义一致) */
const browserGenerationJobs = new Map<string, GenerationJobStatus>();

function getVideoResultUrl(payload: unknown): string | null {
  const urls = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      const url = value.trim();
      if (/^(https?:|data:video\/)/i.test(url)) urls.add(url);
      const embeddedUrl = url.match(/https?:\/\/[^\s\])}",]+/i)?.[0];
      if (embeddedUrl) urls.add(embeddedUrl);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const record = value as Record<string, unknown>;
    [
      'video_url',
      'videoUrl',
      'result_url',
      'resultUrl',
      'url',
      'uri',
      'value',
      'output_url',
      'download_url',
      'downloadUrl',
      'data',
      'videos',
      'video_urls',
      'videoUrls',
      'output_videos',
      'outputs',
      'output',
      'results',
      'files',
      'task',
      'content',
    ].forEach((key) => visit(record[key]));
  };
  visit(payload);
  return urls.values().next().value ?? null;
}

function getVideoTaskId(payload: unknown): string | null {
  if (typeof payload === 'number' && Number.isFinite(payload)) {
    return String(payload);
  }
  if (!payload || typeof payload !== 'object') return null;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const taskId = getVideoTaskId(item);
      if (taskId) return taskId;
    }
    return null;
  }
  const record = payload as Record<string, unknown>;
  for (const key of [
    'id',
    'task_id',
    'taskId',
    'video_id',
    'videoId',
    'job_id',
    'jobId',
    'request_id',
    'requestId',
    'generation_id',
    'generationId',
  ]) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  for (const key of ['data', 'detail', 'result', 'task', 'job', 'video', 'generation', 'response']) {
    const taskId = getVideoTaskId(record[key]);
    if (taskId) return taskId;
  }
  return null;
}

function describeVideoResponse(payload: unknown): string {
  try {
    return truncateText(JSON.stringify(payload), 600);
  } catch {
    return truncateText(String(payload), 600);
  }
}

function normalizeVideoProviderBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  // 设置页的 Base URL 约定为站点根路径。兼容用户粘贴 OpenAI 常见的
  // `.../v1` 地址，避免最终请求被拼成 `/v1/v1/video/generations`。
  return normalized.replace(/\/v(?:1|8)$/i, '');
}

function getVideoTaskStatus(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as Record<string, unknown>;
  for (const key of ['status', 'task_status', 'state']) {
    if (typeof record[key] === 'string') return record[key].toUpperCase();
  }
  for (const key of ['data', 'detail', 'result', 'task']) {
    const status = getVideoTaskStatus(record[key]);
    if (status) return status;
  }
  return '';
}

/** 从平台 HTTP 错误响应中提取可读的错误摘要(解析 JSON body 的 message / error.message)。 */
function buildHttpErrorSummary(status: number, rawResponse: string, url: string): string {
  let platformMessage = '';
  try {
    const parsed = JSON.parse(rawResponse) as Record<string, unknown>;
    const errorNode = parsed?.error;
    if (typeof errorNode === 'object' && errorNode !== null) {
      const errorMessage = (errorNode as Record<string, unknown>).message;
      if (typeof errorMessage === 'string' && errorMessage.trim()) {
        platformMessage = errorMessage.trim();
      }
    }
    if (!platformMessage && typeof parsed?.message === 'string' && parsed.message.trim()) {
      platformMessage = parsed.message.trim();
    }
  } catch {
    platformMessage = '';
  }

  if (status === 429) {
    const hint = platformMessage || '请求过于频繁或平台限流';
    return `HTTP 429 平台限流: ${hint} (${url})`;
  }
  if (status === 401 || status === 403) {
    const hint = platformMessage || (status === 401 ? 'API Key 无效或未配置' : '无权限访问');
    return `HTTP ${status} 鉴权失败: ${hint} (${url})`;
  }
  if (status === 404) {
    return `HTTP 404 端点不存在: ${platformMessage || '接口路径可能已变更'} (${url})`;
  }

  const bodySummary = platformMessage
    ? `: ${platformMessage}`
    : rawResponse
      ? `: ${truncateText(rawResponse, 240)}`
      : '';
  return `HTTP ${status}${bodySummary} (${url})`;
}

/**
 * 非 H3 视频模型的 `resolution`(文档「推荐传精确尺寸」如 `1280x720`)。
 *
 * 两个硬约束:
 *   - 文档明确 `resolution` 优先于 `aspect_ratio`, 两者冲突时以 resolution 为准,
 *     所以这里必须用**最终画幅**推导 —— 否则会出现 resolution=1280x720 与
 *     aspect_ratio=9:16 互相矛盾、平台按横屏执行的静默错误。
 *   - 档位写在模型名里时(`zzdh-Minimax-h3-480p` / `doubao-seedance-2-4k` /
 *     `kling-3.0-omni-720p-*`)文档写明「请求体里的 resolution 不会改档」,
 *     传了无意义还可能冲突 → 一律不传。
 */
function resolveZzdhVideoResolution(
  value: string | undefined,
  aspectRatio: string,
  model: string,
): string | undefined {
  if (resolveZzdhResolutionTier(model)) return undefined;
  const requested = value?.trim().toLowerCase() ?? '';
  if (/^\d+x\d+$/.test(requested)) return requested;
  const dimensions: Record<string, Record<string, string>> = {
    '16:9': { '480p': '854x480', '720p': '1280x720', '1080p': '1920x1080', '2k': '2560x1440' },
    '9:16': { '480p': '480x854', '720p': '720x1280', '1080p': '1080x1920', '2k': '1440x2560' },
    '1:1': { '480p': '480x480', '720p': '720x720', '1080p': '1080x1080', '2k': '2048x2048' },
  };
  return dimensions[aspectRatio.trim()]?.[requested]
    ?? dimensions[aspectRatio.trim()]?.['720p']
    ?? '1280x720';
}

function resolveProviderEndpoint(baseUrl: string, configuredPath: unknown, fallbackPath: string, taskId?: string): string {
  const configured = typeof configuredPath === 'string' && configuredPath.trim()
    ? configuredPath.trim()
    : fallbackPath;
  const resolvedPath = taskId ? configured.replace('{taskId}', encodeURIComponent(taskId)) : configured;
  if (/^https?:\/\//i.test(resolvedPath)) return resolvedPath;
  return `${baseUrl}${resolvedPath.startsWith('/') ? resolvedPath : `/${resolvedPath}`}`;
}

/** 读取图片实际宽高(供首尾帧画幅跟随首帧), 失败返回 null */
function loadImageDimensions(source: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    try {
      const image = new Image();
      image.onload = () => {
        const width = image.naturalWidth;
        const height = image.naturalHeight;
        resolve(width > 0 && height > 0 ? { width, height } : null);
      };
      image.onerror = () => resolve(null);
      image.src = source;
    } catch {
      resolve(null);
    }
  });
}

interface ProviderJsonResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

interface ProviderBinaryResponse {
  ok: boolean;
  status: number;
  bytes: Uint8Array;
  text(): Promise<string>;
}

/** Generic JSON provider requests use Rust's native desktop HTTP client. */
export async function requestProviderJson(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string }
): Promise<ProviderJsonResponse> {
  if (!isTauri()) {
    return await fetch(url, init);
  }

  let body: unknown;
  if (init.body) {
    try {
      body = JSON.parse(init.body);
    } catch {
      throw new Error(`Provider request body is not valid JSON (${url})`);
    }
  }
  const result = await invoke<{ status: number; body: string }>('request_provider_json', {
    url,
    method: init.method ?? 'GET',
    headers: init.headers ?? {},
    body,
  });
  return {
    ok: result.status >= 200 && result.status < 300,
    status: result.status,
    text: async () => result.body,
  };
}

function decodeBase64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** Upload a reference asset through the WebView fetch transport. */
async function requestProviderMultipartViaWebView(
  url: string,
  init: {
    headers?: Record<string, string>;
    fieldName: string;
    filename: string;
    contentType: string;
    bodyBase64: string;
  },
): Promise<ProviderJsonResponse> {
  const bytes = decodeBase64Bytes(init.bodyBase64);
  const form = new FormData();
  form.append(init.fieldName, new Blob([bytes], { type: init.contentType }), init.filename);
  const response = await fetch(url, { method: 'POST', headers: init.headers, body: form });
  return {
    ok: response.ok,
    status: response.status,
    text: () => response.text(),
  };
}

/** Upload a reference asset through the native client or browser fetch. */
export async function requestProviderMultipart(
  url: string,
  init: {
    headers?: Record<string, string>;
    fieldName: string;
    filename: string;
    contentType: string;
    bodyBase64: string;
  }
): Promise<ProviderJsonResponse> {
  if (!isTauri()) {
    return await requestProviderMultipartViaWebView(url, init);
  }

  // Windows' native TLS/DNS path can fail before the provider returns an HTTP
  // response (for example, with "error sending request"). The WebView uses
  // the same network path as the working browser/macOS flow, so try it first
  // on Windows. Only a rejected fetch is eligible for fallback; an HTTP error
  // must be returned as-is so the caller does not submit the upload twice.
  let webViewError: unknown;
  if (isWindowsDesktopRuntime()) {
    try {
      return await requestProviderMultipartViaWebView(url, init);
    } catch (error) {
      webViewError = error;
    }
  }

  try {
    const result = await invoke<{ status: number; body: string }>('request_provider_multipart', {
      url,
      headers: init.headers ?? {},
      fieldName: init.fieldName,
      filename: init.filename,
      contentType: init.contentType,
      bodyBase64: init.bodyBase64,
    });
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      text: async () => result.body,
    };
  } catch (nativeError) {
    if (webViewError) {
      const describe = (error: unknown): string =>
        error instanceof Error ? error.message : String(error);
      throw new Error(
        `Provider multipart request failed via WebView (${describe(webViewError)}); `
        + `native fallback failed (${describe(nativeError)})`,
      );
    }
    throw nativeError;
  }
}

/**
 * 取二进制响应(视频内容 / 音频文件)。
 * `body` 用于 POST 类接口(如 OpenAI 兼容 TTS `/v1/audio/speech`, 请求是 JSON、
 * 返回是音频字节), 不传时退化为 GET 下载。
 */
async function requestProviderBinary(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string }
): Promise<ProviderBinaryResponse> {
  if (!isTauri()) {
    const response = await fetch(url, init);
    return {
      ok: response.ok,
      status: response.status,
      bytes: new Uint8Array(await response.arrayBuffer()),
      text: () => response.text(),
    };
  }

  let parsedBody: unknown;
  if (init.body) {
    try {
      parsedBody = JSON.parse(init.body);
    } catch {
      throw new Error(`Provider request body is not valid JSON (${url})`);
    }
  }
  const result = await invoke<{ status: number; body: string; body_base64?: string | null }>('request_provider_json', {
    url,
    method: init.method ?? 'GET',
    headers: init.headers ?? {},
    body: parsedBody,
    responseEncoding: 'base64',
  });
  const encoded = result.body_base64 ?? '';
  const binary = encoded ? atob(encoded) : '';
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return {
    ok: result.status >= 200 && result.status < 300,
    status: result.status,
    bytes,
    text: async () => new TextDecoder().decode(bytes),
  };
}

async function persistSub2ApiVideo(bytes: Uint8Array): Promise<string> {
  if (isTauri()) {
    return await persistImageBinary(bytes, 'mp4');
  }
  return URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
}

/**
 * 首尾帧/图生画幅: zzdh 网关默认 16:9 且不自动跟随图片,
 * 必须显式传 aspect_ratio(官方枚举只有 16:9 / 9:16 / 1:1)才能得到正确画幅。
 * 从首帧读取宽高映射到官方画幅, 读不到时回退 UI 选择的画幅。
 */
async function resolveZzdhFirstLastAspectRatio(
  firstFrameSource: string | undefined,
  fallbackAspectRatio: string
): Promise<string> {
  const dimensions = await loadImageDimensions(firstFrameSource ?? '');
  if (!dimensions) return resolveZzdhAspectRatio(fallbackAspectRatio);
  return resolveZzdhAspectRatioFromSize(dimensions.width, dimensions.height);
}

/**
 * 提交 H3 视频任务, 失败时可重试一次。
 *
 * 平台网关在转换参考素材时偶发同步返回 HTTP 400 `请求转换失败`。官方文档明确
 * 提交被拒绝的请求不扣费，因此只对这一种错误做一次有界重试。
 */
async function submitZzdhVideoTask(
  submitUrl: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ ok: boolean; status: number; rawResponse: string }> {
  let last = { ok: false, status: 0, rawResponse: '' };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await requestProviderJson(submitUrl, { method: 'POST', headers, body });
    const rawResponse = await response.text();
    last = { ok: response.ok, status: response.status, rawResponse };
    const retriable = !response.ok && attempt === 0 && rawResponse.includes('请求转换失败');
    if (!retriable) break;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return last;
}

/**
 * H3 的 mode 解析已收敛到 `@/commands/zzdhApi`(与画幅/role/时长同源), 这里只做转发,
 * 保持既有调用点与单测的导入路径不变。
 */
export { resolveZzdhGenerationMode };

/** 字子动画参考图：H3 只接受公网地址；其它兼容模型可接收内嵌 base64。 */
export type ZzdhReferenceImage =
  | { url: string; role: ZzdhReferenceRole }
  | { base64: string; role: ZzdhReferenceRole };

interface ReferenceAssetUploadConfig {
  url: string;
  token: string;
}

function resolveReferenceAssetUploadConfig(extraParams: GenerateVideoRequest['extra_params']): ReferenceAssetUploadConfig | null {
  const url = typeof extraParams?.reference_asset_upload_url === 'string'
    ? extraParams.reference_asset_upload_url.trim().replace(/\/+$/, '')
    : '';
  const token = typeof extraParams?.reference_asset_upload_token === 'string'
    ? extraParams.reference_asset_upload_token.trim()
    : '';
  return url && token ? { url, token } : null;
}

async function uploadPublicReferenceAsset(
  asset: Exclude<Awaited<ReturnType<typeof resolveReferenceAssetSource>>, { kind: 'url' }>,
  upload: ReferenceAssetUploadConfig,
  index: number,
): Promise<string> {
  const response = await requestProviderJson(upload.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${upload.token}`,
    },
    body: JSON.stringify({
      filename: `reference-${index + 1}.${asset.extension}`,
      content_type: asset.mimeType,
      data_base64: asset.base64,
    }),
  });
  const rawResponse = await response.text();
  let payload: unknown;
  try {
    payload = rawResponse ? JSON.parse(rawResponse) : {};
  } catch {
    throw new Error(`参考素材上传失败: 上传服务返回了非 JSON 响应 (${upload.url})`);
  }
  if (!response.ok) {
    throw new Error(`参考素材上传失败: ${buildHttpErrorSummary(response.status, rawResponse, upload.url)}`);
  }
  const url = extractBinghuoAssetUrl(payload);
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new Error(`参考素材上传失败: 上传服务未返回公网 HTTP(S) URL (${upload.url})`);
  }
  return url;
}

/**
 * H3 单模型文档限定 `reference_images` 为 `{ url, role }`，且实际网关会将非公网
 * 地址直接拒绝。通用文档中的 `base64` 兼容项不适用于 H3，因此在本地提交前明确阻止，
 * 避免向平台发送必然失败的请求；其它模型仍保留通用 `base64` 兼容行为。
 */
export async function resolveZzdhReferenceImages(
  sources: string[],
  family: ReturnType<typeof resolveZzdhVideoFamily>,
  imageMode: GenerateVideoRequest['image_mode'],
  upload?: ReferenceAssetUploadConfig | null,
): Promise<ZzdhReferenceImage[]> {
  return await Promise.all(sources.map(async (source, index) => {
    const asset = await resolveReferenceAssetSource(source, `字子动画参考图片 ${index + 1}`);
    const role = resolveZzdhReferenceRole(family, imageMode, index);
    if (asset.kind === 'url') return { url: asset.url, role };
    if (family === 'minimax-h3') {
      if (upload) {
        return { url: await uploadPublicReferenceAsset(asset, upload, index), role };
      }
      throw new Error(
        `字子动画 MiniMax H3 参考图仅支持公网 HTTP(S) URL：第 ${index + 1} 张是本地或内嵌素材。请先在字子动画的平台设置中配置“参考素材上传地址”和“上传令牌”，或上传到可公开访问的图床/CDN 后再生成。`,
      );
    }
    return { base64: asset.base64, role };
  }));
}

async function generateZzdhVideo(
  request: GenerateVideoRequest,
  baseUrl: string,
  apiModel: string,
  headers: Record<string, string>
): Promise<string> {
  const isFirstLast = request.image_mode === 'first-last';
  // 产品线决定 role 语义 / mode 支持 / 时长范围(见 zzdhApi 文档注释)。
  const family = resolveZzdhVideoFamily(apiModel);
  const isMinimaxH3 = family === 'minimax-h3';
  const images = request.reference_images?.slice(0, isFirstLast ? 2 : undefined) ?? [];
  // H3 的 `url` 只接受公网 HTTP(S) 地址。本地素材会在此处提前给出可操作提示，避免
  // 被平台错误当成公网 URL 而触发「reference image must be public」。
  const referenceImages = await resolveZzdhReferenceImages(
    images,
    family,
    request.image_mode,
    resolveReferenceAssetUploadConfig(request.extra_params),
  );
  // 模式: H3 官方文档要求显式声明(不传会被静默当成参考生)。
  // H3 专有字段, 其它系列(Kling/seedance/wan)不传。
  const generationMode = resolveZzdhGenerationMode(request.image_mode, images.length, apiModel);
  // 画幅: 官方枚举只有 16:9 / 9:16 / 1:1。网关默认 16:9 且不跟随图片 ——
  // 首尾帧从首帧推导, 其它模式用 UI 选择值(超出枚举的旧值在此收敛)。
  const aspectRatio = isFirstLast
    ? await resolveZzdhFirstLastAspectRatio(images[0], request.aspect_ratio)
    : resolveZzdhAspectRatio(request.aspect_ratio);
  // 分辨率: 必须用**最终画幅**推导(文档: resolution 优先于 aspect_ratio);
  // 模型名锁定档位时不传(文档: 请求体里的 resolution 不会改档)。
  const resolution = resolveZzdhVideoResolution(request.video_resolution, aspectRatio, apiModel);
  // 时长: H3 按档位收窄(480P 5~10s, 其余 5~15s); 其它系列文档未给范围, 沿用原样。
  const durationRange = resolveZzdhVideoDurationRange(apiModel);
  const duration = durationRange
    ? Math.max(durationRange.min, Math.min(durationRange.max, Math.round(request.duration)))
    : Math.max(1, Math.round(request.duration));
  // 参考音频: 文档在模型家族字段表里列出 reference_audios(仅在有音频时发送)。
  const referenceAudios = (request.reference_audio ?? [])
    .map((audioUrl) => audioUrl.trim())
    .filter(Boolean)
    .map((url) => ({ url }));
  const body = {
    model: apiModel,
    prompt: request.prompt,
    duration,
    aspect_ratio: aspectRatio,
    ...(isMinimaxH3 ? { mode: generationMode } : {}),
    ...(resolution ? { resolution } : {}),
    ...(referenceImages.length ? { reference_images: referenceImages } : {}),
    ...(referenceAudios.length ? { reference_audios: referenceAudios } : {}),
  };
  const submitUrl = `${baseUrl}/v8/videos/generations`;
  const { ok: submitOk, status: submitStatus, rawResponse } = await submitZzdhVideoTask(
    submitUrl,
    headers,
    JSON.stringify(body),
  );
  let payload: unknown;
  try {
    payload = rawResponse ? JSON.parse(rawResponse) : {};
  } catch {
    throw new Error(`字子动画视频请求失败: 平台返回了非 JSON 响应 (${submitUrl})`);
  }
  if (!submitOk) {
    throw new Error(`字子动画视频请求失败: ${buildHttpErrorSummary(submitStatus, rawResponse, submitUrl)}`);
  }
  const immediateResult = getVideoResultUrl(payload);
  if (immediateResult) return immediateResult;
  const taskId = getVideoTaskId(payload);
  if (!taskId) {
    throw new Error(`字子动画视频响应中未找到任务 ID 或视频地址: ${describeVideoResponse(payload)}`);
  }

  const taskUrl = `${submitUrl}/${encodeURIComponent(taskId)}`;
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const taskResponse = await requestProviderJson(taskUrl, { headers });
    const taskRawResponse = await taskResponse.text();
    try {
      payload = taskRawResponse ? JSON.parse(taskRawResponse) : {};
    } catch {
      throw new Error(`字子动画视频查询失败: 平台返回了非 JSON 响应 (${taskUrl})`);
    }
    if (!taskResponse.ok) {
      throw new Error(`字子动画视频查询失败: ${buildHttpErrorSummary(taskResponse.status, taskRawResponse, taskUrl)}`);
    }
    const videoUrl = getVideoResultUrl(payload);
    if (videoUrl) return videoUrl;
    const status = getVideoTaskStatus(payload);
    if (['FAILED', 'FAILURE', 'ERROR', 'CANCELED', 'CANCELLED', 'REJECTED'].includes(status)) {
      throw new Error(`字子动画视频生成失败: ${status}`);
    }
  }
}

function extractSub2ApiUploadImageId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const imageId = extractSub2ApiUploadImageId(item);
      if (imageId) return imageId;
    }
    return null;
  }
  const record = payload as Record<string, unknown>;
  const imageId = record.image_id ?? record.imageId;
  if (typeof imageId === 'string' && imageId.trim()) return imageId.trim();
  for (const key of ['data', 'file', 'result']) {
    const nestedId = extractSub2ApiUploadImageId(record[key]);
    if (nestedId) return nestedId;
  }
  return null;
}

function getDataUrlBase64(source: string): string | null {
  const match = source.trim().match(/^data:[^;,]+(?:;[^,]*)?;base64,([a-z0-9+/=]+)$/i);
  return match?.[1] ?? null;
}

function resolveRjmSeedanceResolution(model: string, requested: string | undefined): string {
  const allowed = model.trim().toLowerCase() === 'seedance2.5'
    ? ['480p', '720p']
    : ['480p', '720p', '1080p', '4k'];
  const normalizedRequested = requested?.trim().toLowerCase();
  return normalizedRequested && allowed.includes(normalizedRequested)
    ? normalizedRequested
    : '720p';
}

function extractBinghuoAssetUrl(payload: unknown): string | null {
  if (typeof payload === 'string' && /^https?:\/\//i.test(payload.trim())) return payload.trim();
  if (!payload || typeof payload !== 'object') return null;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const url = extractBinghuoAssetUrl(item);
      if (url) return url;
    }
    return null;
  }
  const record = payload as Record<string, unknown>;
  for (const key of ['url', 'asset_url', 'assetUrl', 'download_url', 'downloadUrl', 'data', 'result', 'asset']) {
    const url = extractBinghuoAssetUrl(record[key]);
    if (url) return url;
  }
  return null;
}

/**
 * 把参考素材上传到平台换取公网 URL(multipart, 字段名固定 file)。
 * 炳火 /v1/assets/uploads 与知鸟 /v1/files 是同构流程, 只有端点与文案不同 ——
 * 合并成同一条链路, 避免两份逻辑各自漂移。
 */
async function uploadPlatformReferenceAsset(
  source: string,
  baseUrl: string,
  headers: Record<string, string>,
  index: number,
  platformLabel: string,
  uploadPath: string,
): Promise<string> {
  const asset = await resolveReferenceAssetSource(source, platformLabel);
  if (asset.kind === 'url') return asset.url;
  const uploadUrl = `${baseUrl}${uploadPath}`;
  // multipart 需自行生成 boundary, 转发 JSON 的 Content-Type 会让上传体失效。
  const uploadHeaders = Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'content-type'),
  );
  const response = await requestProviderMultipart(uploadUrl, {
    headers: uploadHeaders,
    fieldName: 'file',
    filename: `reference-${index + 1}.${asset.extension}`,
    contentType: asset.mimeType,
    bodyBase64: asset.base64,
  });
  const rawResponse = await response.text();
  let payload: unknown;
  try {
    payload = rawResponse ? JSON.parse(rawResponse) : {};
  } catch {
    throw new Error(`${platformLabel} 参考素材上传失败: 平台返回了非 JSON 响应 (${uploadUrl})`);
  }
  if (!response.ok) {
    throw new Error(`${platformLabel} 参考素材上传失败: ${buildHttpErrorSummary(response.status, rawResponse, uploadUrl)}`);
  }
  const url = extractBinghuoAssetUrl(payload);
  if (!url) {
    throw new Error(`${platformLabel} 参考素材上传响应中未找到公网 URL: ${describeVideoResponse(payload)}`);
  }
  return url;
}

async function uploadBinghuoReferenceAsset(
  source: string,
  baseUrl: string,
  headers: Record<string, string>,
  index: number,
): Promise<string> {
  return await uploadPlatformReferenceAsset(
    source,
    baseUrl,
    headers,
    index,
    '炳火 API',
    '/v1/assets/uploads',
  );
}

async function generateBinghuoVideo(
  request: GenerateVideoRequest,
  baseUrl: string,
  apiModel: string,
  headers: Record<string, string>,
): Promise<string> {
  const rawImages = request.reference_images ?? [];
  const isMinimaxH3 = apiModel.trim().toLowerCase().startsWith('minimax-h3-pro-');
  const imageLimit = request.image_mode === 'first-last' ? 2 : (isMinimaxH3 ? 9 : 30);
  // 参考视频: 来自 extra_params.reference_videos(URL 列表), 上传换 OSS 后填 reference_videos。
  // 字段名必须叫 reference_videos(手册 3.3 红字强调: 'videos'/'video_urls' 部分模型被忽略)。
  const rawReferenceVideos = (() => {
    const value = request.extra_params?.reference_videos;
    if (!Array.isArray(value)) return [];
    return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim()).slice(0, 3);
  })();
  // 跳过真人审核: 责任声明(手册 3.8), 仅 bh 系模型生效, 显式 true 时下游跳过审核。
  // 炳火限定为以 'bh2.0-' 开头或等于 'bh2.04K' 的模型 id, 其余模型传了也由平台忽略。
  const skipReview = request.extra_params?.skip_review === true;
  let imageSources: string[];
  let audioSources: string[];
  let referenceVideoSources: string[];
  try {
    imageSources = await Promise.all(
      rawImages.slice(0, imageLimit)
        .map((source, index) => uploadBinghuoReferenceAsset(source, baseUrl, headers, index)),
    );
    audioSources = await Promise.all(
      (request.reference_audio ?? []).slice(0, 3)
        .map((source, index) => uploadBinghuoReferenceAsset(source, baseUrl, headers, imageSources.length + index)),
    );
    referenceVideoSources = await Promise.all(
      rawReferenceVideos
        .map((source, index) => uploadBinghuoReferenceAsset(
          source,
          baseUrl,
          headers,
          imageSources.length + audioSources.length + index,
        )),
    );
  } catch (error) {
    if (error instanceof Error) {
      error.message = translateTransportError(error.message, '炳火 API 上传端点');
    }
    throw error;
  }
  const body: Record<string, unknown> = {
    model: apiModel,
    prompt: request.prompt,
    duration: Math.max(1, Math.round(request.duration)),
    ratio: request.aspect_ratio,
    generate_audio: true,
    n: 1,
  };
  if (request.image_mode === 'first-last' && imageSources.length > 0) {
    body.start_frame = [imageSources[0]];
    if (imageSources[1]) body.end_frame = [imageSources[1]];
  } else if (imageSources.length > 0) {
    body.images = imageSources;
  }
  if (audioSources.length > 0) body.reference_audios = audioSources;
  if (referenceVideoSources.length > 0) body.reference_videos = referenceVideoSources;
  if (skipReview) body.skip_review = true;
  if (request.video_resolution?.trim()) body.resolution = request.video_resolution.trim();

  const submitUrl = `${baseUrl}/v1/video/generations`;
  let submitResponse: ProviderJsonResponse;
  let submitRaw: string;
  try {
    submitResponse = await requestProviderJson(submitUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    submitRaw = await submitResponse.text();
  } catch (error) {
    if (error instanceof Error) {
      error.message = translateTransportError(error.message, '炳火 API 提交端点');
    }
    throw error;
  }
  let payload: unknown;
  try {
    payload = submitRaw ? JSON.parse(submitRaw) : {};
  } catch {
    throw new Error(`炳火 API 视频请求失败: 平台返回了非 JSON 响应 (${submitUrl})`);
  }
  if (!submitResponse.ok) {
    throw new Error(`炳火 API 视频请求失败: ${buildHttpErrorSummary(submitResponse.status, submitRaw, submitUrl)}`);
  }
  const immediateResult = getVideoResultUrl(payload);
  if (immediateResult) return immediateResult;
  const taskId = getVideoTaskId(payload);
  if (!taskId) {
    throw new Error(`炳火 API 视频响应中未找到任务 ID: ${describeVideoResponse(payload)}`);
  }
  const taskUrl = `${baseUrl}/v1/video/generations/${encodeURIComponent(taskId)}`;
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    let taskResponse: ProviderJsonResponse;
    let taskRawResponse: string;
    try {
      taskResponse = await requestProviderJson(taskUrl, { headers });
      taskRawResponse = await taskResponse.text();
    } catch (error) {
      if (error instanceof Error) {
        error.message = translateTransportError(error.message, '炳火 API 轮询端点');
      }
      throw error;
    }
    try {
      payload = taskRawResponse ? JSON.parse(taskRawResponse) : {};
    } catch {
      throw new Error(`炳火 API 视频查询失败: 平台返回了非 JSON 响应 (${taskUrl})`);
    }
    if (!taskResponse.ok) {
      throw new Error(`炳火 API 视频查询失败: ${buildHttpErrorSummary(taskResponse.status, taskRawResponse, taskUrl)}`);
    }
    const videoUrl = getVideoResultUrl(payload);
    if (videoUrl) return videoUrl;
    const status = getVideoTaskStatus(payload);
    if (['FAILED', 'FAILURE', 'ERROR', 'CANCELED', 'CANCELLED', 'REJECTED'].includes(status)) {
      const reason = getVideoTaskFailureReason(payload);
      throw new Error(`炳火 API 视频生成失败: ${reason ?? describeVideoResponse(payload)}`);
    }
  }
}

/**
 * wgspai 平台链路：提交/轮询端点与炳火一致(/v1/video/generations)，
 * 但平台没有 /v1/assets/uploads 独立上传端点，参考素材只能以公网 URL 或
 * data URL 直接内嵌进请求体，不再执行独立文件上传。
 */
async function generateWgspaiVideo(
  request: GenerateVideoRequest,
  baseUrl: string,
  apiModel: string,
  headers: Record<string, string>,
): Promise<string> {
  const rawImages = request.reference_images ?? [];
  const imageSources = rawImages.slice(0, request.image_mode === 'first-last' ? 2 : 30);
  const audioSources = (request.reference_audio ?? []).slice(0, 3);
  // 平台没有独立上传端点, 本地素材只能读成 data URL 内嵌进请求体。
  const normalizeSource = async (source: string, label: string): Promise<string> => {
    const asset = await resolveReferenceAssetSource(source, `wgspai API 参考${label}`);
    return asset.kind === 'url' ? asset.url : `data:${asset.mimeType};base64,${asset.base64}`;
  };
  const normalizedImages = await Promise.all(
    imageSources.map((source, index) => normalizeSource(source, `素材 ${index + 1}`)),
  );
  const normalizedAudios = await Promise.all(
    audioSources.map((source, index) => normalizeSource(source, `音频 ${index + 1}`)),
  );
  const body: Record<string, unknown> = {
    model: apiModel,
    prompt: request.prompt,
    duration: Math.max(1, Math.round(request.duration)),
    ratio: request.aspect_ratio,
    generate_audio: true,
    n: 1,
  };
  if (request.image_mode === 'first-last' && normalizedImages.length > 0) {
    body.start_frame = [normalizedImages[0]];
    if (normalizedImages[1]) body.end_frame = [normalizedImages[1]];
  } else if (normalizedImages.length > 0) {
    body.images = normalizedImages;
  }
  if (normalizedAudios.length > 0) body.reference_audios = normalizedAudios;
  if (request.video_resolution?.trim()) body.resolution = request.video_resolution.trim();

  const submitUrl = `${baseUrl}/v1/video/generations`;
  const response = await requestProviderJson(submitUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const rawResponse = await response.text();
  let payload: unknown;
  try {
    payload = rawResponse ? JSON.parse(rawResponse) : {};
  } catch {
    throw new Error(`wgspai API 视频请求失败: 平台返回了非 JSON 响应 (${submitUrl})`);
  }
  if (!response.ok) {
    throw new Error(`wgspai API 视频请求失败: ${buildHttpErrorSummary(response.status, rawResponse, submitUrl)}`);
  }
  const immediateResult = getVideoResultUrl(payload);
  if (immediateResult) return immediateResult;
  const taskId = getVideoTaskId(payload);
  if (!taskId) {
    throw new Error(`wgspai API 视频响应中未找到任务 ID: ${describeVideoResponse(payload)}`);
  }
  const taskUrl = `${baseUrl}/v1/video/generations/${encodeURIComponent(taskId)}`;
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const taskResponse = await requestProviderJson(taskUrl, { headers });
    const taskRawResponse = await taskResponse.text();
    try {
      payload = taskRawResponse ? JSON.parse(taskRawResponse) : {};
    } catch {
      throw new Error(`wgspai API 视频查询失败: 平台返回了非 JSON 响应 (${taskUrl})`);
    }
    if (!taskResponse.ok) {
      throw new Error(`wgspai API 视频查询失败: ${buildHttpErrorSummary(taskResponse.status, taskRawResponse, taskUrl)}`);
    }
    const videoUrl = getVideoResultUrl(payload);
    if (videoUrl) return videoUrl;
    const status = getVideoTaskStatus(payload);
    if (['FAILED', 'FAILURE', 'ERROR', 'CANCELED', 'CANCELLED', 'REJECTED'].includes(status)) {
      throw new Error(`wgspai API 视频生成失败: ${describeVideoResponse(payload)}`);
    }
  }
}

/**
 * 知鸟 AI(TokenGo 网关)参考素材上传:
 * 平台生成类参考字段(images / videos / audios)只收公网 URL, 不收原始字节。
 * 本地素材先 POST /v1/files(multipart, 字段名 file) 换取公网 URL —— 注意该 URL
 * 24 小时后失效, 因此只在提交前随传随用, 不做长期缓存。
 */
export async function uploadZhiniaoReferenceAsset(
  source: string,
  baseUrl: string,
  headers: Record<string, string>,
  index: number,
): Promise<string> {
  return await uploadPlatformReferenceAsset(source, baseUrl, headers, index, '知鸟 AI', '/v1/files');
}

/** 知鸟 AI 扁平入口的 mode 取值: 无参考=文生视频, 单图=首帧, 双图首尾帧, 多图=参考生视频。 */
function resolveZhiniaoVideoMode(imageMode: string | undefined, imageCount: number): string {
  if (imageCount === 0) return 'text-to-video';
  if (imageMode === 'first-last' && imageCount >= 2) return 'first-last';
  if (imageCount === 1) return 'first-frame';
  return 'reference';
}

/**
 * 知鸟 AI(TokenGo)视频链路:
 * - 提交 POST /v1/videos/generations, 全部参数放**顶层**(扁平形状, 不接受 params 信封)
 * - 轮询 GET /v1/tasks/{task_id}, 终态看 state(success/failed) 或 status(completed/failed)
 * - 成片 URL 在 result_url / output_url / result.videos[].url, getVideoResultUrl 已覆盖
 */
async function generateZhiniaoVideo(
  request: GenerateVideoRequest,
  baseUrl: string,
  apiModel: string,
  headers: Record<string, string>,
): Promise<string> {
  const maxImages = request.image_mode === 'first-last' ? 2 : 30;
  const rawImages = (request.reference_images ?? []).slice(0, maxImages);
  const imageSources = await Promise.all(
    rawImages.map((source, index) => uploadZhiniaoReferenceAsset(source, baseUrl, headers, index)),
  );
  const rawAudios = (request.reference_audio ?? []).slice(0, 10);
  const audioSources = await Promise.all(
    rawAudios.map((source, index) =>
      uploadZhiniaoReferenceAsset(source, baseUrl, headers, imageSources.length + index)),
  );

  const body: Record<string, unknown> = {
    model: apiModel,
    prompt: request.prompt,
    mode: resolveZhiniaoVideoMode(request.image_mode, imageSources.length),
    duration: Math.max(1, Math.round(request.duration)),
    aspect_ratio: request.aspect_ratio,
    count: 1,
  };
  if (imageSources.length > 0) body.images = imageSources;
  if (audioSources.length > 0) body.audios = audioSources;
  // 不传则沿用该模型的服务端默认档位(如 seedance-2-5 默认 480p)。
  if (request.video_resolution?.trim()) body.resolution = request.video_resolution.trim();

  const submitUrl = `${baseUrl}/v1/videos/generations`;
  const response = await requestProviderJson(submitUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const rawResponse = await response.text();
  let payload: unknown;
  try {
    payload = rawResponse ? JSON.parse(rawResponse) : {};
  } catch {
    throw new Error(`知鸟 AI 视频请求失败: 平台返回了非 JSON 响应 (${submitUrl})`);
  }
  if (!response.ok) {
    throw new Error(`知鸟 AI 视频请求失败: ${buildHttpErrorSummary(response.status, rawResponse, submitUrl)}`);
  }
  const immediateResult = getVideoResultUrl(payload);
  if (immediateResult && !getVideoTaskId(payload)) return immediateResult;
  const taskId = getVideoTaskId(payload);
  if (!taskId) {
    throw new Error(`知鸟 AI 视频响应中未找到任务 ID: ${describeVideoResponse(payload)}`);
  }
  // 网关统一的任务查询端点, 与提交路径不同。
  const taskUrl = `${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`;
  while (true) {
    // 官方说明: 视频中位 4~40 分钟、p90 55~75 分钟, 轮询间隔 5s 足够且不浪费配额。
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const taskResponse = await requestProviderJson(taskUrl, { headers });
    const taskRawResponse = await taskResponse.text();
    try {
      payload = taskRawResponse ? JSON.parse(taskRawResponse) : {};
    } catch {
      throw new Error(`知鸟 AI 视频查询失败: 平台返回了非 JSON 响应 (${taskUrl})`);
    }
    if (!taskResponse.ok) {
      throw new Error(`知鸟 AI 视频查询失败: ${buildHttpErrorSummary(taskResponse.status, taskRawResponse, taskUrl)}`);
    }
    const videoUrl = getVideoResultUrl(payload);
    if (videoUrl) return videoUrl;
    const status = getVideoTaskStatus(payload);
    if (['FAILED', 'FAILURE', 'ERROR', 'CANCELED', 'CANCELLED', 'REJECTED'].includes(status)) {
      throw new Error(`知鸟 AI 视频生成失败: ${describeVideoResponse(payload)}`);
    }
  }
}

async function uploadSub2ApiReferenceImage(
  source: string,
  baseUrl: string,
  headers: Record<string, string>
): Promise<string> {
  const imageB64 = getDataUrlBase64(source);
  if (!imageB64) {
    throw new Error('Sub2API 本地参考图必须转换为 Base64 图片数据后上传');
  }
  const uploadUrl = `${baseUrl}/v1/files`;
  const response = await requestProviderJson(uploadUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ image_b64: imageB64 }),
  });
  const rawResponse = await response.text();
  let payload: unknown;
  try {
    payload = rawResponse ? JSON.parse(rawResponse) : {};
  } catch {
    throw new Error(`Sub2API 参考图上传失败: 平台返回了非 JSON 响应 (${uploadUrl})`);
  }
  if (!response.ok) {
    throw new Error(`Sub2API 参考图上传失败: ${buildHttpErrorSummary(response.status, rawResponse, uploadUrl)}`);
  }
  const imageId = extractSub2ApiUploadImageId(payload);
  if (!imageId) {
    throw new Error(`Sub2API 参考图上传响应中未找到 image_id: ${describeVideoResponse(payload)}`);
  }
  return imageId;
}

async function generateSub2ApiVideo(
  request: GenerateVideoRequest,
  baseUrl: string,
  apiModel: string,
  headers: Record<string, string>,
  useRjmProtocol = false,
): Promise<string> {
  if (request.reference_audio?.length) {
    throw new Error('Sub2API 当前推荐的 Seedance 视频链路只支持图片参考，暂不提交音频参考。');
  }
  const videoImages = request.image_mode === 'first-last'
    ? request.reference_images?.slice(0, 2)
    : request.reference_images;
  const imageIds: string[] = [];
  const imageUrls: string[] = [];
  for (const source of videoImages ?? []) {
    if (/^https:\/\//i.test(source.trim())) {
      imageUrls.push(source.trim());
    } else {
      imageIds.push(await uploadSub2ApiReferenceImage(source, baseUrl, headers));
    }
  }

  const submitUrl = useRjmProtocol
    ? `${baseUrl}/v1/videos`
    : resolveProviderEndpoint(baseUrl, request.extra_params?.video_submit_path, '/v1/videos');
  const normalizedApiModel = apiModel.trim().toLowerCase();
  const fixedSeedanceDuration = normalizedApiModel === 'seedance2.5'
    ? 30
    : normalizedApiModel === 'seedance2.0'
      ? 15
      : undefined;
  const isFixedSeedanceModel = fixedSeedanceDuration !== undefined;
  const ratio = request.image_mode === 'first-last' && imageIds.length > 0 && useRjmProtocol
    ? 'auto'
    : isFixedSeedanceModel && (request.aspect_ratio === '16:9' || request.aspect_ratio === '9:16')
    ? request.aspect_ratio
    : isFixedSeedanceModel
      ? '16:9'
      : request.aspect_ratio;
  const idempotencyKey = request.extra_params?.client_job_id;
  const response = await requestProviderJson(submitUrl, {
    method: 'POST',
    headers: {
      ...headers,
      'Idempotency-Key': typeof idempotencyKey === 'string' && idempotencyKey.trim()
        ? idempotencyKey.trim()
        : createVideoIdempotencyKey(),
    },
    body: JSON.stringify({
      model: apiModel,
      prompt: request.prompt,
      duration: fixedSeedanceDuration ?? Math.max(1, Math.round(request.duration)),
      ratio,
      ...(isFixedSeedanceModel
        ? {
          resolution: useRjmProtocol
            ? resolveRjmSeedanceResolution(apiModel, request.video_resolution)
            : '720p',
        }
        : request.video_resolution?.trim()
          ? { resolution: request.video_resolution.trim() }
          : {}),
      camera_movement: 'auto',
      ...(imageIds.length ? { image_ids: imageIds } : {}),
      ...(imageUrls.length ? { images: imageUrls } : {}),
    }),
  });
  const rawResponse = await response.text();
  let payload: unknown;
  try {
    payload = rawResponse ? JSON.parse(rawResponse) : {};
  } catch {
    throw new Error(`Sub2API 视频请求失败: 平台返回了非 JSON 响应 (${submitUrl})`);
  }
  if (!response.ok) {
    throw new Error(`Sub2API 视频请求失败: ${buildHttpErrorSummary(response.status, rawResponse, submitUrl)}`);
  }
  const immediateResult = getVideoResultUrl(payload);
  if (immediateResult) return immediateResult;
  const taskId = getVideoTaskId(payload);
  if (!taskId) {
    throw new Error(`Sub2API 视频响应中未找到任务 ID 或视频地址: ${describeVideoResponse(payload)}`);
  }

  const taskUrl = useRjmProtocol
    ? `${baseUrl}/v1/videos/${encodeURIComponent(taskId)}`
    : resolveProviderEndpoint(baseUrl, request.extra_params?.video_query_path, '/v1/videos/{taskId}', taskId);
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const taskResponse = await requestProviderJson(taskUrl, { headers });
    const taskRawResponse = await taskResponse.text();
    try {
      payload = taskRawResponse ? JSON.parse(taskRawResponse) : {};
    } catch {
      throw new Error(`Sub2API 视频查询失败: 平台返回了非 JSON 响应 (${taskUrl})`);
    }
    if (!taskResponse.ok) {
      throw new Error(`Sub2API 视频查询失败: ${buildHttpErrorSummary(taskResponse.status, taskRawResponse, taskUrl)}`);
    }
    const videoUrl = getVideoResultUrl(payload);
    if (videoUrl) return videoUrl;
    const status = getVideoTaskStatus(payload);
    if (['FAILED', 'FAILURE', 'ERROR', 'CANCELED', 'CANCELLED', 'REJECTED'].includes(status)) {
      const reason = getVideoTaskFailureReason(payload);
      throw new Error(`Sub2API 视频生成失败: ${reason ?? status}`);
    }
    if (['COMPLETED', 'COMPLETE', 'SUCCESS', 'SUCCEEDED', 'DONE'].includes(status)) {
      const contentUrl = `${taskUrl}/content`;
      const contentResponse = await requestProviderBinary(contentUrl, { headers });
      if (!contentResponse.ok) {
        const contentText = await contentResponse.text();
        throw new Error(`Sub2API 视频下载失败: ${buildHttpErrorSummary(contentResponse.status, contentText, contentUrl)}`);
      }
      if (!contentResponse.bytes.length) {
        throw new Error(`Sub2API 视频下载失败: 内容为空 (${contentUrl})`);
      }
      return await persistSub2ApiVideo(contentResponse.bytes);
    }
  }
}

export async function generateVideo(request: GenerateVideoRequest): Promise<string> {
  if (!isCustomModel(request.model)) {
    throw new Error('视频生成仅支持自定义平台(custom:*)模型');
  }
  const providerId = request.model.split('/')[0] ?? '';
  const apiModel = request.model.split('/').slice(1).join('/').trim();
  const configuredBaseUrl = typeof request.extra_params?.provider_base_url === 'string'
    ? request.extra_params.provider_base_url
    : '';
  const baseUrl = normalizeVideoProviderBaseUrl(configuredBaseUrl);
  const apiKey = (useSettingsStore.getState().apiKeys[providerId] ?? '').trim();
  if (!baseUrl || !apiKey || !apiModel) {
    throw new Error('请在设置中配置视频模型对应的 Base URL、API Key 和模型名称');
  }
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  if (request.extra_params?.video_transport === 'zhenjian-task-api' || isZhenjianProvider(providerId, baseUrl)) {
    return await generateZhenjianVideo(request);
  }
  const rjmVideoBaseUrl = resolveRjmVideoApiBaseUrl(baseUrl);
  if (rjmVideoBaseUrl) {
    return await generateSub2ApiVideo(request, rjmVideoBaseUrl, apiModel, headers, true);
  }
  // 字子动画: transport 标记或 Base URL 命中都走专有链路(用户自建平台时 id 常是中文,
  // 只靠 transport 标记在极端情况下会漏, 加域名兜底不改变其它平台的分支顺序)。
  if (request.extra_params?.video_transport === 'zzdh-v8-video' || isZzdhBaseUrl(baseUrl)) {
    return await generateZzdhVideo(request, baseUrl, apiModel, headers);
  }
  if (request.extra_params?.video_transport === 'sub2api-video') {
    return await generateSub2ApiVideo(request, baseUrl, apiModel, headers);
  }
  if (request.extra_params?.video_transport === 'binghuo-video') {
    return await generateBinghuoVideo(request, baseUrl, apiModel, headers);
  }
  if (request.extra_params?.video_transport === 'wgspai-video') {
    return await generateWgspaiVideo(request, baseUrl, apiModel, headers);
  }
  if (request.extra_params?.video_transport === 'zhiniao-video') {
    return await generateZhiniaoVideo(request, baseUrl, apiModel, headers);
  }
  const videoImages = request.image_mode === 'first-last'
    ? request.reference_images?.slice(0, 2)
    : request.reference_images;
  const body = {
    model: apiModel,
    prompt: request.prompt,
    duration: Math.max(1, Math.round(request.duration)),
    aspect_ratio: request.aspect_ratio,
    ...(videoImages?.length ? {
      images: videoImages,
      ...(request.image_mode === 'first-last' ? { generation_type: 'frame' } : {}),
    } : {}),
    ...(request.reference_audio?.length
      ? {
        audio_url: request.reference_audio[0],
        ...(request.reference_audio.length > 1 ? { audio_urls: request.reference_audio } : {}),
      }
      : {}),
  };
  // 自定义平台的 Base URL 统一按站点根路径保存，因此这里固定使用
  // OpenAI 兼容视频入口。不要为同一请求探测多个端点，以免重复扣费。
  const submitUrl = resolveProviderEndpoint(
    baseUrl,
    request.extra_params?.video_submit_path,
    '/v1/videos/generations'
  );
  const response = await requestProviderJson(submitUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const rawResponse = await response.text();
  let payload: unknown = null;
  try {
    payload = rawResponse ? JSON.parse(rawResponse) : {};
  } catch {
    throw new Error(`视频生成请求失败: 平台返回了非 JSON 响应 (${submitUrl})`);
  }
  if (!response.ok) {
    throw new Error(`视频生成请求失败: ${buildHttpErrorSummary(response.status, rawResponse, submitUrl)}`);
  }
  const immediateResult = getVideoResultUrl(payload);
  if (immediateResult) return immediateResult;
  const taskId = getVideoTaskId(payload);
  if (!taskId) {
    throw new Error(`视频平台响应中未找到任务 ID 或视频地址: ${describeVideoResponse(payload)}`);
  }
  const taskUrl = resolveProviderEndpoint(
    baseUrl,
    request.extra_params?.video_query_path,
    `${request.extra_params?.video_submit_path ?? '/v1/videos/generations'}/{taskId}`,
    taskId
  );
  // 视频生成耗时受排队、模型和时长影响，持续轮询直到平台给出终态。
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const taskResponse = await requestProviderJson(taskUrl, { headers });
    const taskRawResponse = await taskResponse.text();
    try {
      payload = taskRawResponse ? JSON.parse(taskRawResponse) : {};
    } catch {
      throw new Error(`视频生成查询失败: 平台返回了非 JSON 响应 (${taskUrl})`);
    }
    if (!taskResponse.ok) {
      throw new Error(`视频生成查询失败: ${buildHttpErrorSummary(taskResponse.status, taskRawResponse, taskUrl)}`);
    }
    const videoUrl = getVideoResultUrl(payload);
    if (videoUrl) return videoUrl;
    const status = getVideoTaskStatus(payload);
    if (['FAILED', 'FAILURE', 'ERROR', 'CANCELED', 'CANCELLED', 'REJECTED'].includes(status)) {
      throw new Error(`视频生成失败: ${status}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 音频生成(语音合成 / 音效 / 音乐)
// ---------------------------------------------------------------------------

export type GenerateAudioKind = 'speech' | 'sound-effects' | 'music';

export interface GenerateAudioRequest {
  /** 文本内容: 语音合成的台词 / 音效描述 / 音乐描述 */
  prompt: string;
  model: string;
  /** 音频类型; 缺省按模型名推断(见 resolveZzdhAudioKind) */
  audio_kind?: GenerateAudioKind;
  /** 音色(语音合成, 可选项) */
  voice?: string;
  /** 输出格式(语音合成, 默认 mp3) */
  format?: string;
  /** 音效时长(秒) */
  duration_seconds?: number;
  /** 音乐时长(毫秒) */
  music_length_ms?: number;
  /** 歌词(音乐生成) */
  lyrics?: string;
  extra_params?: Record<string, unknown>;
}

/** 音频响应若是 JSON(部分中转返回 URL 或 data URL), 从中取出可播放地址。 */
function extractAudioSourceFromJson(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const direct = getVideoResultUrl(payload);
  if (direct) return direct;
  // data:audio/... 不在 getVideoResultUrl 的匹配范围内, 单独扫一遍。
  let dataAudio: string | null = null;
  const visit = (value: unknown): void => {
    if (dataAudio) return;
    if (typeof value === 'string') {
      const hit = value.trim().match(/data:audio\/[a-z0-9.+-]+;base64,[^\s"']+/i)?.[0];
      if (hit) dataAudio = hit;
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    Object.values(value as Record<string, unknown>).forEach(visit);
  };
  visit(payload);
  return dataAudio;
}

/** 音频字节落盘: 桌面端写成文件(节点用 convertFileSrc 播放), Web 端退化为 Blob URL。 */
async function persistAudioBytes(bytes: Uint8Array, format: string): Promise<string> {
  const extension = format.trim().toLowerCase().replace(/[^a-z0-9]/g, '') || ZZDH_DEFAULT_AUDIO_FORMAT;
  if (isTauri()) {
    return await persistImageBinary(bytes, extension);
  }
  const mime = extension === 'mp3' ? 'audio/mpeg' : `audio/${extension}`;
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

/** 按音频类型组装请求体(字段名照抄官方模型页示例)。 */
function buildAudioBody(request: GenerateAudioRequest, apiModel: string, kind: GenerateAudioKind): string {
  const format = request.format?.trim().toLowerCase() || ZZDH_DEFAULT_AUDIO_FORMAT;
  const body: Record<string, unknown> = { model: apiModel, input: request.prompt };
  if (kind === 'speech') {
    body.voice = request.voice?.trim() || ZZDH_BASE_DEFAULT_VOICE;
    body.format = format;
  } else if (kind === 'sound-effects') {
    body.metadata = {
      ...(request.duration_seconds ? { duration_seconds: Math.max(1, Math.round(request.duration_seconds)) } : {}),
      loop: false,
    };
  } else {
    body.metadata = {
      ...(request.lyrics?.trim() ? { lyrics_text: request.lyrics.trim() } : {}),
      ...(request.music_length_ms ? { music_length_ms: Math.max(1000, Math.round(request.music_length_ms)) } : {}),
    };
  }
  return JSON.stringify(body);
}

/**
 * 字子动画音频链路(官方文档「服务类 API」+ 各模型页):
 *   - 语音合成 POST /v1/audio/speech         字段 model / input / voice / format
 *   - 音效     POST /v1/audio/sound-effects  字段 model / input / metadata{duration_seconds, loop}
 *   - 音乐     POST /v1/audio/music          字段 model / input / metadata{lyrics_text, music_length_ms}
 * 三个端点都返回音频文件字节, 落盘后交给画布节点播放。
 */
async function generateZzdhAudio(
  request: GenerateAudioRequest,
  baseUrl: string,
  apiModel: string,
  headers: Record<string, string>,
): Promise<string> {
  const kind = request.audio_kind ?? resolveZzdhAudioKind(apiModel) ?? 'speech';
  const submitUrl = `${baseUrl}${resolveZzdhAudioPath(kind)}`;
  const response = await requestProviderBinary(submitUrl, {
    method: 'POST',
    headers,
    body: buildAudioBody(request, apiModel, kind),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`字子动画音频请求失败: ${buildHttpErrorSummary(response.status, raw, submitUrl)}`);
  }
  const jsonSource = extractAudioSourceFromJson(raw);
  if (jsonSource) return jsonSource;
  if (!response.bytes.length) {
    throw new Error(`字子动画音频响应为空 (${submitUrl})`);
  }
  const format = request.format?.trim().toLowerCase() || ZZDH_DEFAULT_AUDIO_FORMAT;
  return await persistAudioBytes(response.bytes, format);
}

/** 其它平台的兜底链路: OpenAI 兼容 /v1/audio/speech。 */
async function generateOpenAiCompatAudio(
  request: GenerateAudioRequest,
  baseUrl: string,
  apiModel: string,
  headers: Record<string, string>,
): Promise<string> {
  const submitUrl = resolveProviderEndpoint(baseUrl, request.extra_params?.audio_submit_path, '/v1/audio/speech');
  const body = JSON.parse(buildAudioBody(request, apiModel, request.audio_kind ?? 'speech')) as Record<string, unknown>;
  const response = await requestProviderBinary(submitUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`音频生成请求失败: ${buildHttpErrorSummary(response.status, raw, submitUrl)}`);
  }
  const jsonSource = extractAudioSourceFromJson(raw);
  if (jsonSource) return jsonSource;
  if (!response.bytes.length) {
    throw new Error(`音频生成响应为空 (${submitUrl})`);
  }
  return await persistAudioBytes(response.bytes, request.format?.trim() || ZZDH_DEFAULT_AUDIO_FORMAT);
}

/** 音频生成入口: 字子动画走专有端点, 其它平台走 OpenAI 兼容 speech。 */
export async function generateAudio(request: GenerateAudioRequest): Promise<string> {
  if (!isCustomModel(request.model)) {
    throw new Error('音频生成仅支持自定义平台(custom:*)模型');
  }
  const providerId = request.model.split('/')[0] ?? '';
  const apiModel = request.model.split('/').slice(1).join('/').trim();
  const configuredBaseUrl = typeof request.extra_params?.provider_base_url === 'string'
    ? request.extra_params.provider_base_url
    : '';
  const baseUrl = normalizeVideoProviderBaseUrl(configuredBaseUrl);
  const apiKey = (useSettingsStore.getState().apiKeys[providerId] ?? '').trim();
  if (!baseUrl || !apiKey || !apiModel) {
    throw new Error('请在设置中配置音频模型对应的 Base URL、API Key 和模型名称');
  }
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  if (request.extra_params?.audio_transport === 'zzdh-openai-audio' || isZzdhBaseUrl(baseUrl)) {
    return await generateZzdhAudio(request, baseUrl, apiModel, headers);
  }
  return await generateOpenAiCompatAudio(request, baseUrl, apiModel, headers);
}

export async function generateJimengCliVideo(
  request: GenerateJimengCliVideoRequest
): Promise<string> {
  if (!isTauri()) {
    throw new Error('即梦 CLI 只能在桌面端使用，请打开 LenTalk 桌面应用后再生成。');
  }

  return await invoke<string>('generate_jimeng_cli_video', { request });
}

/** 即梦 CLI 图片生成(文生图 / 图生图), 返回落盘后的本地图片路径或远端 URL。 */
export async function generateJimengCliImage(
  request: GenerateJimengCliImageRequest
): Promise<string> {
  if (!isTauri()) {
    throw new Error('即梦 CLI 只能在桌面端使用，请打开 LenTalk 桌面应用后再生成。');
  }

  return await invoke<string>('generate_jimeng_cli_image', { request });
}

/** 即梦 CLI 图片超清(2K/4K/8K), 产出新文件而不覆盖原图。 */
export async function generateJimengCliImageUpscale(
  request: GenerateJimengCliImageUpscaleRequest
): Promise<string> {
  if (!isTauri()) {
    throw new Error('即梦 CLI 只能在桌面端使用，请打开 LenTalk 桌面应用后再生成。');
  }

  return await invoke<string>('generate_jimeng_cli_image_upscale', { request });
}

/**
 * 即梦 CLI 图片生成的 job 封装。
 *
 * CLI 是本地长任务: Rust 侧用 `--poll=0` 提交后自行轮询(最长 30 分钟), 没有可以
 * 查询的远端任务 id。这里沿用字子动画(zhenjian)的既有做法, 把结果写进内存 job map,
 * 让 Canvas 那条统一的 job 轮询链路直接消费 —— 图片节点因此不需要为即梦加任何分支。
 *
 * 已知取舍: job 状态只存在内存里, 应用重启后无法再查询(CLI 任务本身仍会跑完并落盘)。
 */
async function submitJimengCliImageJob(request: GenerateRequest): Promise<string> {
  const jobId = crypto.randomUUID();
  browserGenerationJobs.set(jobId, { job_id: jobId, status: 'running', result: null, error: null });

  const modelVersion = request.model.slice(JIMENG_CLI_IMAGE_MODEL_PREFIX.length).trim();
  const executable = useSettingsStore.getState().jimengCli.executable;

  void (async () => {
    try {
      // 参考图可能是远端 CDN 地址: 交给 Rust 统一取字节转 data URL,
      // 既绕开 webview 的 CORS 限制, 也让 CLI 拿到本地可读的文件。
      const referenceImages = request.reference_images?.length
        ? await Promise.all(
            request.reference_images.map((source) =>
              invoke<string>('load_media_data_url', { source })
            )
          )
        : undefined;

      const result = await generateJimengCliImage({
        executable,
        prompt: request.prompt,
        model_version: modelVersion,
        // LenTalk 的 size 就是档位(1K/1.5K/2K/4K), Rust 侧会归一化成 CLI 要的小写。
        resolution_type: request.size,
        aspect_ratio: request.aspect_ratio,
        reference_images: referenceImages,
      });
      browserGenerationJobs.set(jobId, { job_id: jobId, status: 'succeeded', result, error: null });
    } catch (error) {
      browserGenerationJobs.set(jobId, {
        job_id: jobId,
        status: 'failed',
        result: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  return jobId;
}

/**
 * 即梦 CLI 图片超清(image_upscale)的 job 封装。
 *
 * 与图生图共用同一条内存 job 通道 —— 结果节点依旧由 Canvas 统一轮询消费, 所以
 * 「超清」对画布是透明的: 它只是又一个 `kind: 'image'` 的生成任务。
 *
 * 源图取 `reference_images` 的第一张(由调用方把节点自己那张图塞进去)。CLI 需要
 * 本地可读的文件, 因此这里统一经 Rust 转成 data URL, 顺带绕开 webview 的 CORS。
 */
async function submitJimengCliImageUpscaleJob(request: GenerateRequest): Promise<string> {
  const jobId = crypto.randomUUID();
  const source = request.reference_images?.[0];
  if (!source) {
    // 没有源图就没有超清可言: 直接落一条 failed, 让结果节点显示原因而不是空转。
    browserGenerationJobs.set(jobId, {
      job_id: jobId,
      status: 'failed',
      result: null,
      error: '图片超清需要一张源图：请选中带图的结果节点，或先在本节点生成一张图。',
    });
    return jobId;
  }

  browserGenerationJobs.set(jobId, { job_id: jobId, status: 'running', result: null, error: null });
  const executable = useSettingsStore.getState().jimengCli.executable;

  void (async () => {
    try {
      const image = await invoke<string>('load_media_data_url', { source });
      const result = await generateJimengCliImageUpscale({
        executable,
        image,
        // LenTalk 的 size 就是档位(2K/4K/8K), Rust 侧归一化成 CLI 要的小写。
        resolution_type: request.size,
      });
      browserGenerationJobs.set(jobId, { job_id: jobId, status: 'succeeded', result, error: null });
    } catch (error) {
      browserGenerationJobs.set(jobId, {
        job_id: jobId,
        status: 'failed',
        result: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  return jobId;
}

export interface JimengCliLoginStartResult {
  needAuth: boolean;
  verificationUri: string | null;
  userCode: string | null;
  deviceCode: string | null;
  message: string;
}

export interface JimengCliLoginCheckResult {
  success: boolean;
  message: string;
}

/** 开始即梦 CLI 登录: 返回设备码登录材料(验证地址/用户码/设备码), 由调用方打开浏览器并轮询检查 */
export async function jimengCliLoginStart(executable: string): Promise<JimengCliLoginStartResult> {
  if (!isTauri()) {
    throw new Error('即梦 CLI 只能在桌面端使用，请打开 LenTalk 桌面应用后再操作。');
  }
  return await invoke<JimengCliLoginStartResult>('jimeng_cli_login_start', { executable });
}

/** 查询即梦 CLI 设备码登录是否完成 */
export async function jimengCliLoginCheck(
  executable: string,
  deviceCode: string
): Promise<JimengCliLoginCheckResult> {
  if (!isTauri()) {
    throw new Error('即梦 CLI 只能在桌面端使用，请打开 LenTalk 桌面应用后再操作。');
  }
  return await invoke<JimengCliLoginCheckResult>('jimeng_cli_login_check', { executable, deviceCode });
}

/** Clear the local Dreamina CLI OAuth login state. */
export async function jimengCliLogout(executable: string): Promise<JimengCliLoginCheckResult> {
  if (!isTauri()) {
    throw new Error('Dreamina CLI is desktop-only.');
  }
  return await invoke<JimengCliLoginCheckResult>('jimeng_cli_logout', { executable });
}

function isCustomModel(model: string): boolean {
  return model.startsWith(CUSTOM_API_PROVIDER_PREFIX);
}

function shouldUseWebviewGeneration(_request: GenerateRequest): boolean {
  // Desktop builds use the native Rust HTTP client. Windows must not fall
  // back to WebView fetch because custom providers commonly reject CORS.
  return !isTauri();
}

function shouldUseWebviewProviderRequests(): boolean {
  return !isTauri();
}

function assertWindowsModelSupported(request: GenerateRequest): void {
  if (isWindowsDesktopRuntime() && !isCustomModel(request.model)) {
    throw new Error('Windows 桌面端仅支持通过自定义平台(custom:*)生成图片，请在设置中配置 OpenAI 兼容 API。');
  }
}

function uses65535GeminiEdits(
  providerId: string,
  apiModel: string,
  referenceImageCount: number
): boolean {
  if (providerId !== 'custom:65535' || referenceImageCount === 0) {
    return false;
  }
  const normalizedModel = apiModel.trim().toLowerCase();
  return normalizedModel.includes('gemini') && normalizedModel.includes('image');
}

async function buildBrowserGeminiEditsForm(
  request: GenerateRequest,
  apiModel: string,
  referenceImages: string[]
): Promise<FormData> {
  const form = new FormData();
  form.append('model', apiModel);
  form.append('prompt', request.prompt);
  const normalizedSize = request.size.trim().toUpperCase();
  const size = ['1K', '2K', '4K'].includes(normalizedSize)
    ? normalizedSize
    : mapRequestedImageSize(apiModel, request.size, request.aspect_ratio);
  form.append('size', size);
  form.append('n', '1');
  form.append('aspect_ratio', request.aspect_ratio);

  for (const [index, source] of referenceImages.entries()) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`读取第 ${index + 1} 张参考图失败 (HTTP ${response.status})`);
    }
    const blob = await response.blob();
    const extension = blob.type.split('/')[1]?.split(';')[0] || 'png';
    form.append('image', blob, `reference-${index + 1}.${extension}`);
  }
  return form;
}

/**
 * 浏览器降级生成:直接调 OpenAI 兼容文生图接口 POST {base}/v1/images/generations。
 * 与 Rust openai_compat provider 行为一致:key 从 settingsStore.apiKeys[providerId] 读,
 * base_url 从 extra_params.provider_base_url 读,支持 Images 与 Responses 协议。
 */
async function browserGenerateImage(request: GenerateRequest): Promise<string> {
  const model = request.model;
  const providerId = model.split('/')[0] ?? '';
  if (!providerId.startsWith(CUSTOM_API_PROVIDER_PREFIX)) {
    throw new Error('浏览器模式仅支持自定义平台(custom:*)模型,其他平台请使用桌面版 LenTalk 生成');
  }
  // 发送给平台的 model 需去掉 custom:<id>/ 前缀(与 Rust 端拆分逻辑一致)
  const apiModel = model.split('/').slice(1).join('/') || model;

  const rawBaseUrl = request.extra_params?.provider_base_url;
  const baseUrl = typeof rawBaseUrl === 'string'
    ? rawBaseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/i, '').replace(/\/+$/, '')
    : '';
  if (!baseUrl) {
    throw new Error('缺少 provider_base_url,请检查自定义平台配置');
  }

  const apiKey = useSettingsStore.getState().apiKeys[providerId] ?? '';
  if (!apiKey) {
    throw new Error('未配置 API Key,请在「设置-密钥」中填写该平台的密钥');
  }

  const usesResponsesProtocol =
    typeof request.extra_params?.protocol === 'string' &&
    request.extra_params.protocol.toLowerCase() === 'responses';
  const usesChatProtocol =
    typeof request.extra_params?.protocol === 'string' &&
    request.extra_params.protocol.toLowerCase() === 'chat';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000);
  try {
    // 参考图:全部保留(data URL / http(s) 原样,blob 转 data URL)。
    const referenceImages: string[] = [];
    const referenceSources = request.reference_images ?? [];
    for (const rawSource of referenceSources) {
      const source = rawSource.trim();
      if (source.startsWith('data:') || source.startsWith('http://') || source.startsWith('https://')) {
        referenceImages.push(source);
      } else if (source.startsWith('blob:')) {
        try {
          const blob = await (await fetch(source)).blob();
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result ?? ''));
            reader.onerror = () => reject(new Error('参考图读取失败'));
            reader.readAsDataURL(blob);
          });
          referenceImages.push(dataUrl);
        } catch (error) {
          console.warn('[AI] browser fallback: failed to read blob reference image', { error });
        }
      }
    }

    const useGeminiEdits = uses65535GeminiEdits(providerId, apiModel, referenceImages.length);
    const endpoint = `${baseUrl}/v1/${
      usesResponsesProtocol
        ? 'responses'
        : usesChatProtocol
          ? 'chat/completions'
          : useGeminiEdits
            ? 'images/edits'
            : 'images/generations'
    }`;
    const body: Record<string, unknown> = usesResponsesProtocol
      ? {
          model: apiModel,
          input: [{
            role: 'user',
            content: [
              { type: 'input_text', text: request.prompt },
              ...referenceImages.map((image) => ({
                type: 'input_image',
                image_url: image.startsWith('data:') ? (image.split(',', 2)[1] ?? image) : image,
              })),
            ],
          }],
          tools: [{
            type: 'image_generation',
            action: referenceImages.length > 0 ? 'edit' : 'generate',
            size: mapRequestedImageSize(apiModel, request.size, request.aspect_ratio),
          }],
          tool_choice: { type: 'image_generation' },
        }
      : usesChatProtocol
        ? {
            model: apiModel,
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: request.prompt },
                ...referenceImages.map((image) => ({
                  type: 'image_url',
                  image_url: { url: image },
                })),
              ],
            }],
            n: 1,
            response_format: { type: 'image' },
          }
        : buildBrowserImagesRequestBody(request, apiModel, referenceImages);

    const response = useGeminiEdits
      ? await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
          body: await buildBrowserGeminiEditsForm(request, apiModel, referenceImages),
          signal: controller.signal,
        })
      : await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

    let payload: unknown = null;
    try {
      payload = (await response.json()) as unknown;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const errorMessage =
        payload && typeof payload === 'object'
          ? ((payload as { error?: { message?: unknown } }).error?.message as string | undefined) ??
            ((payload as { message?: unknown }).message as string | undefined)
          : undefined;
      throw new Error(
        `自定义平台请求失败 (HTTP ${response.status}): ${errorMessage ?? response.statusText}`
      );
    }

    if (usesResponsesProtocol) {
      const image = extractBrowserResponsesImage(payload);
      if (image) {
        return image;
      }
      throw new Error('Responses 响应中未找到图片，请确认该平台模型支持图像生成');
    }

    if (usesChatProtocol) {
      const image = extractBrowserChatImage(payload);
      if (image) {
        return image;
      }
      throw new Error('Chat Completions 响应中未找到图片，请确认该平台模型支持图像生成');
    }

    const data =
      payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)
        ? (payload as { data: unknown[] }).data
        : [];
    const first = data[0];
    if (first && typeof first === 'object') {
      const b64 = (first as { b64_json?: unknown }).b64_json;
      if (typeof b64 === 'string' && b64) {
        return `data:image/png;base64,${b64}`;
      }
      const url = (first as { url?: unknown }).url;
      if (typeof url === 'string' && url) {
        return url;
      }
    }
    const errorMessage =
      payload && typeof payload === 'object'
        ? ((payload as { error?: { message?: unknown } }).error?.message as string | undefined)
        : undefined;
    throw new Error(errorMessage ?? '响应中未找到图片数据');
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('生成超时(180s),请检查平台服务状态或网络');
    }
    // 浏览器跨域(CORS)或网络错误:fetch 会抛 TypeError
    if (error instanceof TypeError) {
      throw new Error(
        `浏览器跨域(CORS)或网络错误:${error.message}。若平台未开放跨域访问,请使用桌面版 LenTalk 生成`
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function buildBrowserImagesRequestBody(
  request: GenerateRequest,
  apiModel: string,
  referenceImages: string[]
): Record<string, unknown> {
  const isGptImage = apiModel.toLowerCase().includes('gpt-image');
  const rawReferenceImageField = request.extra_params?.reference_image_field;
  const referenceImageField = rawReferenceImageField === 'input_image'
    ? 'input_image'
    : rawReferenceImageField === 'images'
      ? 'images'
      : rawReferenceImageField === 'reference_images'
        ? 'reference_images'
        : 'image';
  const configuredEncoding = typeof request.extra_params?.reference_image_encoding === 'string'
    ? request.extra_params.reference_image_encoding.toLowerCase()
    : 'auto';
  const referenceImageEncoding = configuredEncoding === 'raw_base64' || configuredEncoding === 'data_url' || configuredEncoding === 'url'
    ? configuredEncoding
    : referenceImageField === 'input_image' ? 'raw_base64' : 'data_url';
  const normalizeReferenceImage = (image: string): string => {
    if (referenceImageEncoding !== 'raw_base64' || !image.startsWith('data:')) return image;
    return image.split(',', 2)[1] ?? image;
  };
  const body: Record<string, unknown> = {
    model: apiModel,
    prompt: request.prompt,
    size: mapRequestedImageSize(apiModel, request.size, request.aspect_ratio),
    n: 1,
  };
  if (isGptImage) {
    body.output_format = 'png';
    if (apiModel.toLowerCase().includes('gpt-image-2') && !usesNativeImageParameters(apiModel)) {
      body.aspect_ratio = request.aspect_ratio;
    }
  } else {
    // 非 GPT 的 OpenAI 兼容模型通常以 aspect_ratio 控制画幅；此前只传了
    // 固定的 1024x1024，导致节点选择的横竖比例被服务端默认值覆盖。
    body.aspect_ratio = request.aspect_ratio;
    body.response_format = 'b64_json';
  }
  if (referenceImages.length > 0) {
    if (referenceImageField === 'input_image') {
      const normalized = referenceImages.map(normalizeReferenceImage);
      body.input_image = normalized.length === 1 ? normalized[0] : normalized;
    } else if (referenceImageField === 'images') {
      // 知鸟 AI 等平台的参考图字段是 images 纯数组(单图也是数组)。
      body.images = referenceImages.map(normalizeReferenceImage);
    } else if (referenceImageField === 'reference_images') {
      // 字子动画等平台: 参考图是对象数组 [{"url": "..."}](官方模型页字段表)。
      body.reference_images = referenceImages
        .map(normalizeReferenceImage)
        .map((url) => ({ url }));
    } else {
      body.image = normalizeReferenceImage(referenceImages[0]);
      if (referenceImages.length > 1) {
        body.images = referenceImages.map(normalizeReferenceImage);
      }
    }
  }
  // 知鸟 AI 等平台把「参考图用途」放在 mode 上: 默认 text-to-image 会忽略参考图,
  // 有参考图时必须显式声明 image-edit(单图编辑) / multi-reference(多图融合)。
  const imageGenerationMode = typeof request.extra_params?.image_generation_mode === 'string'
    ? request.extra_params.image_generation_mode.trim()
    : '';
  if (imageGenerationMode) {
    body.mode = imageGenerationMode;
  }
  return body;
}

function extractBrowserResponsesImage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const output = (payload as { output?: unknown }).output;
  if (!Array.isArray(output)) {
    return null;
  }
  for (const item of output) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const result = (item as { result?: unknown }).result;
    if (typeof result === 'string' && result) {
      return /^(https?:|data:)/.test(result) ? result : `data:image/png;base64,${result}`;
    }
    const imageUrl = (item as { image_url?: unknown }).image_url;
    if (typeof imageUrl === 'string' && imageUrl) {
      return imageUrl;
    }
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      const partImageUrl =
        part && typeof part === 'object' ? (part as { image_url?: unknown }).image_url : undefined;
      if (typeof partImageUrl === 'string' && partImageUrl) {
        return partImageUrl;
      }
    }
  }
  return null;
}

/** 从 Chat Completions 响应(choices[].message.content)提取图片 URL。 */
function extractBrowserChatImage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) {
    return null;
  }
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') {
      continue;
    }
    const message = (choice as { message?: unknown }).message;
    if (!message || typeof message !== 'object') {
      continue;
    }
    const msg = message as { image_url?: unknown; content?: unknown };
    if (typeof msg.image_url === 'string' && msg.image_url) {
      return msg.image_url;
    }
    const content = msg.content;
    if (typeof content === 'string') {
      const url = extractUrlFromText(content);
      if (url) {
        return url;
      }
      continue;
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== 'object') {
          continue;
        }
        const partImageUrl = (part as { image_url?: unknown }).image_url;
        if (typeof partImageUrl === 'string' && partImageUrl) {
          return partImageUrl;
        }
        if (partImageUrl && typeof partImageUrl === 'object') {
          const nestedUrl = (partImageUrl as { url?: unknown }).url;
          if (typeof nestedUrl === 'string' && nestedUrl) {
            return nestedUrl;
          }
        }
        const text = (part as { text?: unknown }).text;
        if (typeof text === 'string') {
          const url = extractUrlFromText(text);
          if (url) {
            return url;
          }
        }
      }
    }
  }
  return null;
}

/** 从聊天文本中提取首个 http(s) URL。 */
function extractUrlFromText(text: string): string | null {
  const start = text.indexOf('https://');
  const startFallback = start < 0 ? text.indexOf('http://') : start;
  if (startFallback < 0) {
    return null;
  }
  const candidate = text.slice(startFallback);
  const endMatch = candidate.search(/[\s)\]}"',]/);
  const url = endMatch < 0 ? candidate : candidate.slice(0, endMatch);
  return url.trim() || null;
}

export async function generateImage(request: GenerateRequest): Promise<string> {
  const startedAt = performance.now();
  console.info('[AI] generate_image request', {
    ...sanitizeGenerateRequestForLog(request),
    tauri: isTauri(),
  });

  assertWindowsModelSupported(request);
  const imageProviderId = request.model.split('/')[0] ?? '';
  const imageBaseUrl = typeof request.extra_params?.provider_base_url === 'string'
    ? request.extra_params.provider_base_url
    : '';
  if (request.extra_params?.image_transport === 'zhenjian-task-api'
    || isZhenjianProvider(imageProviderId, imageBaseUrl)) {
    return await generateZhenjianImage(request);
  }
  if (shouldUseWebviewGeneration(request)) {
    // 浏览器降级:直接请求 OpenAI 兼容文生图接口
    return await browserGenerateImage(request);
  }

  try {
    const rawResult = await invoke<unknown>('generate_image', { request });
    if (typeof rawResult !== 'string') {
      throw createErrorWithDetails(
        'Generation returned non-string payload',
        truncateText(
          (() => {
            try {
              return JSON.stringify(rawResult, null, 2);
            } catch {
              return String(rawResult);
            }
          })(),
          2000
        )
      );
    }
    const result = rawResult.trim();
    if (!result) {
      throw createErrorWithDetails('Generation returned empty image source');
    }
    const elapsedMs = Math.round(performance.now() - startedAt);
    console.info('[AI] generate_image success', {
      elapsedMs,
      resultPreview: truncateText(result, 220),
    });
    return result;
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - startedAt);
    const normalizedError = normalizeInvokeError(error);
    console.error('[AI] generate_image failed', {
      elapsedMs,
      request: sanitizeGenerateRequestForLog(request),
      error,
      normalizedError,
    });
    const commandError: ErrorWithDetails = new Error(normalizedError.message);
    commandError.details = normalizedError.details;
    throw commandError;
  }
}

export async function submitGenerateImageJob(request: GenerateRequest): Promise<string> {
  console.info('[AI] submit_generate_image_job request', {
    ...sanitizeGenerateRequestForLog(request),
    tauri: isTauri(),
  });

  // 即梦 CLI 图片超清: 源图是本节点已有的图, 不写提示词。必须在普通图片分支之前
  // 判断, 因为超清 id 也以 `jimeng-cli/` 开头。
  if (request.model === JIMENG_CLI_IMAGE_UPSCALE_MODEL) {
    return await submitJimengCliImageUpscaleJob(request);
  }

  // 即梦 CLI 图片走本机 CLI: Rust 侧自行提交并轮询, 结果经内存 job map 回传。
  if (request.model.startsWith(JIMENG_CLI_IMAGE_MODEL_PREFIX)) {
    return await submitJimengCliImageJob(request);
  }

  assertWindowsModelSupported(request);
  const imageProviderId = request.model.split('/')[0] ?? '';
  const imageBaseUrl = typeof request.extra_params?.provider_base_url === 'string'
    ? request.extra_params.provider_base_url
    : '';
  if (request.extra_params?.image_transport === 'zhenjian-task-api'
    || isZhenjianProvider(imageProviderId, imageBaseUrl)) {
    const jobId = crypto.randomUUID();
    browserGenerationJobs.set(jobId, {
      job_id: jobId,
      status: 'running',
      result: null,
      error: null,
    });
    void generateZhenjianImage(request).then(
      (result) => browserGenerationJobs.set(jobId, { job_id: jobId, status: 'succeeded', result, error: null }),
      (error) => browserGenerationJobs.set(jobId, {
        job_id: jobId,
        status: 'failed',
        result: null,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return jobId;
  }
  if (shouldUseWebviewGeneration(request)) {
    // 浏览器降级:同步发起生成,结果存内存 job map(与 Rust 异步任务语义一致)
    const jobId = crypto.randomUUID();
    browserGenerationJobs.set(jobId, {
      job_id: jobId,
      status: 'running',
      result: null,
      error: null,
    });
    void browserGenerateImage(request).then(
      (result) => {
        browserGenerationJobs.set(jobId, { job_id: jobId, status: 'succeeded', result, error: null });
      },
      (error) => {
        browserGenerationJobs.set(jobId, {
          job_id: jobId,
          status: 'failed',
          result: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    );
    return jobId;
  }

  const jobId = await invoke<string>('submit_generate_image_job', { request });
  if (typeof jobId !== 'string' || !jobId.trim()) {
    throw new Error('submit_generate_image_job returned invalid job id');
  }
  return jobId.trim();
}

export async function getGenerateImageJob(jobId: string): Promise<GenerationJobStatus> {
  if (!isTauri() || browserGenerationJobs.has(jobId)) {
    // 浏览器降级:从内存 job map 读取
    const record = browserGenerationJobs.get(jobId);
    if (!record) {
      return { job_id: jobId, status: 'not_found', result: null, error: 'job not found' };
    }
    return record;
  }

  const result = await invoke<GenerationJobStatus>('get_generate_image_job', { jobId });
  if (!result || typeof result !== 'object' || typeof result.status !== 'string') {
    throw new Error('get_generate_image_job returned invalid payload');
  }
  return result;
}

export async function listModels(): Promise<string[]> {
  return await invoke('list_models');
}

export interface ProviderConnectionResult {
  ok: boolean;
  protocol?: string;
  models?: string[];
  count?: number;
  status?: number;
  capabilities?: CustomApiCapabilities;
  modelPrices?: Record<string, number>;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

/** 浏览器降级 fetch:带超时与跨域友好错误 */
async function httpFetchWithTimeout(url: string, init: RequestInit, timeoutMs = 10000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('请求超时(10s),请检查网络或平台服务状态');
    }
    // 浏览器跨域(CORS)被拦截或网络错误时 fetch 会抛 TypeError
    throw new Error(
      error instanceof Error ? error.message : String(error)
    );
  } finally {
    clearTimeout(timer);
  }
}

/** 从 OpenAI 兼容 /v1/models 响应中提取模型 id 列表 */
function parseProviderPayload(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function extractModelsFromPayload(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') {
    return [];
  }
  const output = new Set<string>();
  const visit = (value: unknown, allowDirect = false): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, true));
      return;
    }
    const record = value as Record<string, unknown>;
    for (const key of ['id', 'model', 'model_id', 'modelId', 'name']) {
      const candidate = record[key];
      if (typeof candidate === 'string' && candidate.trim() && (allowDirect || key !== 'name')) {
        output.add(candidate.trim());
        break;
      }
    }
    for (const key of ['data', 'models', 'items', 'results']) visit(record[key], true);
  };
  visit(payload);
  return [...output];
}

/** 仅验证自定义平台 Base URL 是否可达(不需要 Key) */
export async function verifyProviderUrl(
  baseUrl: string
): Promise<{ ok: boolean; status: number }> {
  if (shouldUseWebviewProviderRequests()) {
    // 浏览器降级:先尝试普通请求拿真实状态码;被 CORS 拦截时退化为 no-cors 探测可达性
    const url = normalizeBaseUrl(baseUrl);
    try {
      const response = await httpFetchWithTimeout(url, { method: 'GET', cache: 'no-store' });
      return { ok: response.status < 500, status: response.status };
    } catch {
      try {
        await httpFetchWithTimeout(url, { method: 'GET', mode: 'no-cors', cache: 'no-store' });
        // no-cors 响应为 opaque,无法读取状态码,可达即视为成功
        return { ok: true, status: 0 };
      } catch {
        return { ok: false, status: 0 };
      }
    }
  }
  return await invoke<{ ok: boolean; status: number }>('verify_provider_url', { baseUrl });
}

/** 验证自定义平台协议(带 Key 调 /v1/models,检测 OpenAI 兼容) */
export async function testProviderConnection(
  baseUrl: string,
  apiKey: string
): Promise<ProviderConnectionResult> {
  if (isZhenjianProvider('', baseUrl)) {
    const normalized = normalizeBaseUrl(baseUrl);
    const response = await requestProviderJson(`${normalized}/v1/models`, {
      method: 'GET',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`帧间 API /v1/models 返回 HTTP ${response.status}`);
    const parsed = extractZhenjianModels(parseProviderPayload(raw));
    return {
      ok: true,
      protocol: 'zhenjian-task-api',
      models: parsed.models,
      count: parsed.models.length,
      status: response.status,
      modelPrices: parsed.prices,
    };
  }
  if (shouldUseWebviewProviderRequests()) {
    // 浏览器降级:直接请求 /v1/models(受 CORS 限制,失败时给出友好提示)
    const url = `${normalizeBaseUrl(baseUrl)}/v1/models`;
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    let response: Response;
    try {
      response = await httpFetchWithTimeout(url, { method: 'GET', headers });
    } catch (error) {
      const hint = error instanceof Error ? error.message : String(error);
      throw new Error(
        `浏览器跨域(CORS)或网络错误:${hint}。若平台未开放跨域访问,请使用桌面版 LenTalk 验证`
      );
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    let models: string[] = [];
    try {
      const payload = (await response.json()) as unknown;
      models = extractModelsFromPayload(payload);
    } catch {
      models = [];
    }
    return {
      ok: true,
      protocol: 'openai',
      models,
      count: models.length,
      status: response.status,
    };
  }
  return await invoke<ProviderConnectionResult>('test_provider_connection', { baseUrl, apiKey });
}

/** Probe metadata and OPTIONS endpoints only; never submits a billable task. */
export async function detectProviderCapabilities(
  baseUrl: string,
  apiKey: string
): Promise<{
  capabilities: CustomApiCapabilities;
  models: string[];
  endpoints: Record<string, unknown>;
  modelPrices?: Record<string, number>;
}> {
  if (isZhenjianProvider('', baseUrl)) {
    const normalized = normalizeBaseUrl(baseUrl);
    const response = await requestProviderJson(`${normalized}/v1/models`, {
      method: 'GET',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`/v1/models 返回 HTTP ${response.status}`);
    const parsed = extractZhenjianModels(parseProviderPayload(raw));
    return {
      capabilities: {
        detectedAt: Date.now(),
        detectionSource: 'probe',
        confidence: 'high',
        imageProtocol: 'images',
        imageReferenceField: 'images',
        imageReferenceEncoding: 'multipart',
        imageTransport: 'generations_json',
        videoSubmitPath: '/v1/videos',
        videoQueryPath: '/v1/tasks/{taskId}',
        videoReferenceEncoding: 'multipart',
        taskProtocol: 'generic',
        videoTransport: 'zhenjian-task-api',
      },
      models: parsed.models,
      modelPrices: parsed.prices,
      endpoints: {
        models: { path: '/v1/models', status: response.status },
        images: { path: '/v1/images/generations' },
        edits: { path: '/v1/images/edits' },
        videos: { path: '/v1/videos' },
        tasks: { path: '/v1/tasks/{taskId}' },
        assets: { path: '/v1/assets' },
      },
    };
  }
  if (!shouldUseWebviewProviderRequests()) {
    return await invoke<{ capabilities: CustomApiCapabilities; models: string[]; endpoints: Record<string, unknown> }>(
      'detect_provider_capabilities',
      { baseUrl, apiKey }
    );
  }

  const normalized = normalizeBaseUrl(baseUrl);
  const isKnownOpenAiImages = isKnownOpenAiImagesBaseUrl(normalized);
  // 知鸟 AI(TokenGo)的参考图字段是 images 纯数组, 与 image / input_image 都不同,
  // 探测时直接按已知平台判定, 避免把「已知」平台的字段猜错。
  const isZhiniaoHost = /(?:cuai\.token6688\.com|api\.tokengo\.love)/i.test(normalized);
  const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const modelsResponse = await httpFetchWithTimeout(`${normalized}/v1/models`, { method: 'GET', headers });
  if (!modelsResponse.ok) {
    throw new Error(`/v1/models 返回 HTTP ${modelsResponse.status} ${modelsResponse.statusText}`);
  }
  const modelsPayload = (await modelsResponse.json().catch(() => ({}))) as unknown;
  const models = extractModelsFromPayload(modelsPayload);
  const probe = async (path: string) => {
    try {
      const response = await httpFetchWithTimeout(`${normalized}${path}`, { method: 'OPTIONS', headers });
      return response.status;
    } catch {
      return 0;
    }
  };
  const [imagesStatus, responsesStatus, chatStatus, videosStatus] = isKnownOpenAiImages
    ? [0, 0, 0, 0]
    : await Promise.all([
        probe('/v1/images/generations'),
        probe('/v1/responses'),
        probe('/v1/chat/completions'),
        probe('/v1/videos/generations'),
      ]);
  const hasGptImage = models.some((model) => /gpt-image/i.test(model));
  const probeAvailable = (status: number) => status !== 0 && status !== 404;
  const imageProtocol = isKnownOpenAiImages
    ? 'images'
    : probeAvailable(chatStatus) && !probeAvailable(imagesStatus)
      ? 'chat'
      : probeAvailable(responsesStatus) && !probeAvailable(imagesStatus)
        ? 'responses'
        : 'images';
  const imageReferenceField = isZhiniaoHost
    ? 'images'
    : isKnownOpenAiImages
      ? 'image'
      : hasGptImage
        ? 'input_image'
        : 'image';
  const capabilities: CustomApiCapabilities = {
    detectedAt: Date.now(),
    detectionSource: 'probe',
    confidence: isKnownOpenAiImages ? 'high' : 'low',
    imageProtocol: imageProtocol as CustomApiCapabilities['imageProtocol'],
    imageReferenceField,
    imageReferenceEncoding: imageReferenceField === 'input_image'
      ? 'raw_base64'
      : imageReferenceField === 'images' ? 'url' : 'data_url',
    imageTransport: isKnownOpenAiImages ? 'generations_json' : 'unknown',
    videoSubmitPath: '/v1/videos/generations',
    videoQueryPath: isZhiniaoHost ? '/v1/tasks/{taskId}' : '/v1/videos/generations/{taskId}',
    videoReferenceEncoding: isZhiniaoHost ? 'url' : 'data_url',
    taskProtocol: 'generic',
    ...(isZhiniaoHost ? { videoTransport: 'zhiniao-video' as const } : {}),
  };
  return {
    capabilities,
    models,
    endpoints: {
      images: { path: '/v1/images/generations', optionsStatus: imagesStatus },
      responses: { path: '/v1/responses', optionsStatus: responsesStatus },
      chat: { path: '/v1/chat/completions', optionsStatus: chatStatus },
      videos: { path: '/v1/videos/generations', optionsStatus: videosStatus },
    },
  };
}

/** 从自定义平台拉取模型列表(OpenAI 兼容 /v1/models) */
export async function fetchProviderModels(
  baseUrl: string,
  apiKey: string
): Promise<{ models: string[]; count: number; prices?: Record<string, number> }> {
  if (isZhenjianProvider('', baseUrl)) {
    const normalized = normalizeBaseUrl(baseUrl);
    const response = await requestProviderJson(`${normalized}/v1/models`, {
      method: 'GET',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`帧间 API /v1/models 返回 HTTP ${response.status}`);
    const parsed = extractZhenjianModels(parseProviderPayload(raw));
    return { models: parsed.models, count: parsed.models.length, prices: parsed.prices };
  }
  if (shouldUseWebviewProviderRequests()) {
    // 浏览器降级:直接请求 /v1/models(受 CORS 限制,失败时给出友好提示)
    const url = `${normalizeBaseUrl(baseUrl)}/v1/models`;
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    let response: Response;
    try {
      response = await httpFetchWithTimeout(url, { method: 'GET', headers });
    } catch (error) {
      const hint = error instanceof Error ? error.message : String(error);
      throw new Error(
        `浏览器跨域(CORS)或网络错误:${hint}。若平台未开放跨域访问,请使用桌面版 LenTalk 验证`
      );
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const payload = (await response.json()) as unknown;
    const models = extractModelsFromPayload(payload);
    return { models, count: models.length };
  }
  return await invoke<{ models: string[]; count: number }>('fetch_provider_models', {
    baseUrl,
    apiKey,
  });
}

export type ChatCompletionContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatCompletionMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatCompletionContentPart[];
}

/** 调用自定义平台(OpenAI 兼容)的纯文本 Chat Completion，用于提示词增强。 */
export async function chatCompletion(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatCompletionMessage[],
): Promise<string> {
  if (shouldUseWebviewProviderRequests()) {
    const url = `${normalizeBaseUrl(baseUrl)}/v1/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    let response: Response;
    try {
      response = await httpFetchWithTimeout(
        url,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ model, messages, temperature: 0.4 }),
        },
        30000,
      );
    } catch (error) {
      const hint = error instanceof Error ? error.message : String(error);
      throw new Error(`浏览器跨域(CORS)或网络错误:${hint}。请使用桌面版 LenTalk 配置自定义平台。`);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content) {
      throw new Error('chat completion 响应缺少 choices[0].message.content');
    }
    return content;
  }
  return await invoke<string>('chat_completion', { baseUrl, apiKey, model, messages });
}
