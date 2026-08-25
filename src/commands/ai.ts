import { invoke, isTauri } from '@tauri-apps/api/core';
import { CUSTOM_API_PROVIDER_PREFIX, useSettingsStore } from '@/stores/settingsStore';
import type { CustomApiCapabilities } from '@/stores/settingsStore';
import { isWindowsDesktopRuntime } from '@/platform/runtime';

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

function resolveZzdhVideoResolution(value: string | undefined, aspectRatio: string, model: string): string {
  const requested = value?.trim().toLowerCase() ?? '';
  // 模型名锁定档位时按官方大写档位交付(720P / 1080P / 2K), 与模型名交付分辨率一致
  const modelLocked = model.trim().toLowerCase().match(/(?:^|[-_])(480p|540p|720p|1080p|2k)(?:[-_]|$)/)?.[1];
  if (modelLocked) return modelLocked.toUpperCase();
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

/** zzdh 官方支持的画幅枚举(文档无 adaptive, 首尾帧必须显式传画幅) */
const ZZDH_ASPECT_RATIO_VALUES: Array<{ label: string; value: number }> = [
  { label: '16:9', value: 16 / 9 },
  { label: '9:16', value: 9 / 16 },
  { label: '1:1', value: 1 },
  { label: '4:3', value: 4 / 3 },
  { label: '3:4', value: 3 / 4 },
  { label: '21:9', value: 21 / 9 },
];

interface ProviderJsonResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

/**
 * Desktop provider requests must use Rust's native HTTP client. A number of
 * custom video gateways do not enable CORS, so WebView fetch is only retained
 * for the browser-only build.
 */
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

/** 把图片宽高映射到 zzdh 支持的画幅标签(取最接近) */
function resolveZzdhAspectRatioLabel(width: number, height: number): string {
  if (width <= 0 || height <= 0) return '16:9';
  const ratio = width / height;
  let best = ZZDH_ASPECT_RATIO_VALUES[0];
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const candidate of ZZDH_ASPECT_RATIO_VALUES) {
    const diff = Math.abs(candidate.value - ratio);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = candidate;
    }
  }
  return best.label;
}

/**
 * 首尾帧画幅: zzdh 网关对 H3 默认 16:9 且不自动跟随图片,
 * 必须显式传 aspect_ratio(官方枚举)才能得到正确画幅。
 * 从首帧读取宽高映射到支持画幅, 读不到时回退 UI 选择的画幅。
 */
async function resolveZzdhFirstLastAspectRatio(
  firstFrameSource: string | undefined,
  fallbackAspectRatio: string
): Promise<string> {
  const dimensions = await loadImageDimensions(firstFrameSource ?? '');
  if (!dimensions) return fallbackAspectRatio;
  return resolveZzdhAspectRatioLabel(dimensions.width, dimensions.height);
}

async function generateZzdhVideo(
  request: GenerateVideoRequest,
  baseUrl: string,
  apiModel: string,
  headers: Record<string, string>
): Promise<string> {
  const isFirstLast = request.image_mode === 'first-last';
  const isMinimaxH3 = apiModel.trim().toLowerCase().includes('minimax');
  const images = request.reference_images?.slice(0, isFirstLast ? 2 : undefined) ?? [];
  // role 按官方文档判定生成模式: 首尾帧用 first_frame/last_frame;
  // 参考生必须显式标 reference_image(否则 1~2 张图会被误判为首尾帧)
  const referenceImages = images.map((url, index) => ({
    url,
    ...(isFirstLast
      ? { role: index === 0 ? 'first_frame' : 'last_frame' }
      : { role: 'reference_image' }),
  }));
  // 画幅: zzdh 网关默认 16:9, 必须显式传 aspect_ratio(官方枚举);
  // 首尾帧从首帧推导画幅跟随图片, 其它模式用 UI 选择的画幅。
  const aspectRatio = isFirstLast
    ? await resolveZzdhFirstLastAspectRatio(images[0], request.aspect_ratio)
    : request.aspect_ratio;
  // 分辨率: H3 模型名已锁定交付档位, 官方文档要求不传(传则必须与模型名一致, 否则被拒);
  // 其它模型(如 Kling)按原逻辑传精确尺寸/档位。
  const resolution = isMinimaxH3
    ? undefined
    : resolveZzdhVideoResolution(request.video_resolution, request.aspect_ratio, apiModel);
  // H3 时长限制 5~15 秒(官方文档)
  const duration = isMinimaxH3
    ? Math.max(5, Math.min(15, Math.round(request.duration)))
    : Math.max(1, Math.round(request.duration));
  const body = {
    model: apiModel,
    prompt: request.prompt,
    duration,
    aspect_ratio: aspectRatio,
    ...(resolution ? { resolution } : {}),
    ...(referenceImages.length ? { reference_images: referenceImages } : {}),
  };
  const submitUrl = `${baseUrl}/v8/videos/generations`;
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
    throw new Error(`字子动画视频请求失败: 平台返回了非 JSON 响应 (${submitUrl})`);
  }
  if (!response.ok) {
    throw new Error(`字子动画视频请求失败: ${buildHttpErrorSummary(response.status, rawResponse, submitUrl)}`);
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
  if (request.extra_params?.video_transport === 'zzdh-v8-video') {
    return await generateZzdhVideo(request, baseUrl, apiModel, headers);
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

export async function generateJimengCliVideo(
  request: GenerateJimengCliVideoRequest
): Promise<string> {
  if (!isTauri()) {
    throw new Error('即梦 CLI 只能在桌面端使用，请打开 LenTalk 桌面应用后再生成。');
  }

  return await invoke<string>('generate_jimeng_cli_video', { request });
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
  const endpoint = `${baseUrl}/v1/${
    usesResponsesProtocol ? 'responses' : usesChatProtocol ? 'chat/completions' : 'images/generations'
  }`;
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

    const response = await fetch(endpoint, {
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
  const referenceImageField = request.extra_params?.reference_image_field === 'input_image'
    ? 'input_image'
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
    } else {
      body.image = normalizeReferenceImage(referenceImages[0]);
      if (referenceImages.length > 1) {
        body.images = referenceImages.map(normalizeReferenceImage);
      }
    }
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

  assertWindowsModelSupported(request);
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
function extractModelsFromPayload(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') {
    return [];
  }
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return [];
  }
  return data
    .map((item) => {
      if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') {
        return (item as { id: string }).id;
      }
      return '';
    })
    .filter((id) => id.length > 0);
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
): Promise<{ capabilities: CustomApiCapabilities; models: string[]; endpoints: Record<string, unknown> }> {
  if (!shouldUseWebviewProviderRequests()) {
    return await invoke<{ capabilities: CustomApiCapabilities; models: string[]; endpoints: Record<string, unknown> }>(
      'detect_provider_capabilities',
      { baseUrl, apiKey }
    );
  }

  const normalized = normalizeBaseUrl(baseUrl);
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
  const [imagesStatus, responsesStatus, chatStatus, videosStatus] = await Promise.all([
    probe('/v1/images/generations'),
    probe('/v1/responses'),
    probe('/v1/chat/completions'),
    probe('/v1/videos/generations'),
  ]);
  const hasGptImage = models.some((model) => /gpt-image/i.test(model));
  const probeAvailable = (status: number) => status !== 0 && status !== 404;
  const imageProtocol = probeAvailable(chatStatus) && !probeAvailable(imagesStatus)
    ? 'chat'
    : probeAvailable(responsesStatus) && !probeAvailable(imagesStatus)
      ? 'responses'
      : 'images';
  const imageReferenceField = hasGptImage
    ? 'input_image'
    : 'image';
  const capabilities: CustomApiCapabilities = {
    detectedAt: Date.now(),
    detectionSource: 'probe',
    confidence: 'low',
    imageProtocol: imageProtocol as CustomApiCapabilities['imageProtocol'],
    imageReferenceField,
    imageReferenceEncoding: imageReferenceField === 'input_image' ? 'raw_base64' : 'data_url',
    videoSubmitPath: '/v1/videos/generations',
    videoQueryPath: '/v1/videos/generations/{taskId}',
    videoReferenceEncoding: 'data_url',
    taskProtocol: 'generic',
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
): Promise<{ models: string[]; count: number }> {
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
