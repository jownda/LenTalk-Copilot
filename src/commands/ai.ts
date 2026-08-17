import { invoke, isTauri } from '@tauri-apps/api/core';
import { buildCustomProviderId, CUSTOM_API_PROVIDER_PREFIX, useSettingsStore } from '@/stores/settingsStore';
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
  image_mode?: 'reference' | 'first-last';
  reference_images?: string[];
  reference_audio?: string[];
  extra_params?: Record<string, unknown>;
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
  if (!isTauri() || isWindowsDesktopRuntime()) {
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

/** 浏览器降级任务存储:jobId → 状态(与 Rust 异步任务语义一致) */
const browserGenerationJobs = new Map<string, GenerationJobStatus>();

function getVideoResultUrl(payload: unknown): string | null {
  const urls: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      if (/^(https?:|data:)/.test(value)) urls.push(value);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const record = value as Record<string, unknown>;
    ['videos', 'outputs', 'output', 'data', 'detail', 'result', 'results', 'content', 'video_url', 'videoUrl', 'url', 'output_url', 'download_url'].forEach((key) => visit(record[key]));
  };
  visit(payload);
  return urls[0] ?? null;
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
  return normalized.replace(/\/v1$/i, '');
}

function getVideoTaskStatus(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as Record<string, unknown>;
  for (const key of ['status', 'task_status', 'state']) {
    if (typeof record[key] === 'string') return record[key].toUpperCase();
  }
  for (const key of ['data', 'detail', 'result']) {
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

function resolveWgspaiVideoStudioSize(aspectRatio: string): string {
  const sizeByRatio: Record<string, string> = {
    '16:9': '1280x720',
    '9:16': '720x1280',
    '4:3': '1024x768',
    '3:4': '768x1024',
    '1:1': '1024x1024',
  };
  return sizeByRatio[aspectRatio] ?? '1280x720';
}

function getWgspaiStudioError(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as Record<string, unknown>;
  for (const key of ['message', 'error', 'msg']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value && typeof value === 'object') {
      const nestedMessage = (value as Record<string, unknown>).message;
      if (typeof nestedMessage === 'string' && nestedMessage.trim()) return nestedMessage.trim();
    }
  }
  return '';
}

function ensureWgspaiStudioSuccess(payload: unknown): void {
  if (!payload || typeof payload !== 'object') {
    throw new Error('WGSPAI 视频工作台返回了无效响应');
  }
  const code = (payload as Record<string, unknown>).code;
  if (typeof code === 'number' && code !== 0) {
    throw new Error(`WGSPAI 视频工作台请求失败: ${getWgspaiStudioError(payload) || `code ${code}`}`);
  }
}

async function postWgspaiVideoStudioRequest(
  baseUrl: string,
  apiKey: string,
  action: 'create' | 'query',
  body: Record<string, unknown>,
  headers: Record<string, string>
): Promise<unknown> {
  if (isTauri()) {
    return await invoke('post_wgspai_video_studio_request', {
      baseUrl,
      apiKey,
      action,
      body,
    });
  }

  const url = `${baseUrl}/api/video-studio/${action}`;
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const rawResponse = await response.text();
  if (!response.ok) {
    throw new Error(buildHttpErrorSummary(response.status, rawResponse, url));
  }
  try {
    return JSON.parse(rawResponse);
  } catch {
    throw new Error(`平台返回了非 JSON 响应 (${url})`);
  }
}

async function generateWgspaiStudioVideo(
  request: GenerateVideoRequest,
  baseUrl: string,
  apiKey: string,
  apiModel: string,
  headers: Record<string, string>
): Promise<string> {
  const videoImages = request.image_mode === 'first-last'
    ? request.reference_images?.slice(0, 2)
    : request.reference_images;
  const body = {
    model: apiModel,
    prompt: request.prompt,
    size: resolveWgspaiVideoStudioSize(request.aspect_ratio),
    duration: Math.max(1, Math.round(request.duration)),
    ...(videoImages?.length ? {
      images: videoImages,
      ...(videoImages.length === 1 ? { image: videoImages[0], input_reference: videoImages[0] } : {}),
      ...(request.image_mode === 'first-last' ? { generation_type: 'frame' } : {}),
    } : {}),
    ...(request.reference_audio?.length
      ? {
        audios: request.reference_audio,
        audio_url: request.reference_audio[0],
      }
      : {}),
  };
  const payload = await postWgspaiVideoStudioRequest(baseUrl, apiKey, 'create', body, headers);
  try {
    ensureWgspaiStudioSuccess(payload);
  } catch (error) {
    // 附加 token 摘要, 便于定位 401 是 token 未保存还是填错
    const maskedToken = apiKey.length > 4
      ? `${apiKey.slice(0, 4)}***${apiKey.slice(-2)}`
      : apiKey
        ? '(short)'
        : '(empty)';
    throw new Error(`${error instanceof Error ? error.message : String(error)} [access token: ${maskedToken}]`);
  }

  const immediateResult = getVideoResultUrl(payload);
  if (immediateResult) return immediateResult;
  const taskId = getVideoTaskId(payload);
  if (!taskId) {
    throw new Error(`WGSPAI 视频工作台响应中未找到任务 ID 或视频地址: ${describeVideoResponse(payload)}`);
  }

  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const queryPayload = await postWgspaiVideoStudioRequest(
      baseUrl,
      apiKey,
      'query',
      { task_id: taskId },
      headers
    );
    ensureWgspaiStudioSuccess(queryPayload);
    const videoUrl = getVideoResultUrl(queryPayload);
    if (videoUrl) return videoUrl;
    const status = getVideoTaskStatus(queryPayload);
    if (['FAILED', 'FAILURE', 'ERROR', 'CANCELED', 'CANCELLED', 'REJECTED'].includes(status)) {
      throw new Error(`视频生成失败: ${status}`);
    }
  }
}

export async function generateVideo(request: GenerateVideoRequest): Promise<string> {
  if (!isCustomModel(request.model)) {
    throw new Error('视频生成仅支持自定义平台(custom:*)模型');
  }
  const providerId = request.model.split('/')[0] ?? '';
  const apiModel = request.model.split('/').slice(1).join('/');
  const configuredBaseUrl = typeof request.extra_params?.provider_base_url === 'string'
    ? request.extra_params.provider_base_url
    : '';
  const baseUrl = normalizeVideoProviderBaseUrl(configuredBaseUrl);
  // WGSPAI 视频工作台用独立的 access token(优先), 其他平台用 API Key。
  const settingsState = useSettingsStore.getState();
  const customApi = settingsState.customApis.find(
    (item) => buildCustomProviderId(item.id) === providerId
  );
  const wgspaiAccessToken = customApi?.videoAccessToken?.trim() ?? '';
  const apiKey = wgspaiAccessToken || (settingsState.apiKeys[providerId] ?? '');
  if (!baseUrl || !apiKey || !apiModel) {
    throw new Error('请在设置中配置视频模型对应的 Base URL、API Key 和模型名称');
  }
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  if (request.extra_params?.video_transport === 'wgspai-studio') {
    return await generateWgspaiStudioVideo(request, baseUrl, apiKey, apiModel, headers);
  }
  const videoImages = request.image_mode === 'first-last'
    ? request.reference_images?.slice(0, 2)
    : request.reference_images;
  const body = {
    model: apiModel,
    prompt: request.prompt,
    duration: Math.max(1, Math.round(request.duration)),
    seconds: String(Math.max(1, Math.round(request.duration))),
    size: request.aspect_ratio,
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
  // New API uses the singular `/v1/video/generations` route. Other OpenAI-compatible
  // relays use `/v1/videos` or the older plural generations endpoints.
  const submitUrls = [
    `${baseUrl}/v1/video/generations`,
    `${baseUrl}/v1/videos`,
    `${baseUrl}/v1/videos/generations`,
    `${baseUrl}/v2/videos/generations`,
  ];
  let payload: unknown = null;
  let submitUrl = '';
  const attemptErrors: string[] = [];
  for (const url of submitUrls) {
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const contentType = response.headers.get('content-type') ?? '';
    const rawResponse = await response.text();
    try {
      payload = JSON.parse(rawResponse);
    } catch {
      payload = null;
    }
    if (!response.ok) {
      attemptErrors.push(buildHttpErrorSummary(response.status, rawResponse, url));
      continue;
    }
    if (getVideoResultUrl(payload) || getVideoTaskId(payload)) {
      submitUrl = url;
      break;
    }
    if (payload) {
      attemptErrors.push(`平台未返回任务信息: ${describeVideoResponse(payload)} (${url})`);
    } else {
      attemptErrors.push(`平台返回了非 JSON 响应${contentType ? ` (${contentType})` : ''} (${url})`);
    }
  }
  if (!submitUrl) {
    // 优先展示 HTTP 状态码错误(如 401 鉴权失败 / 404 端点不存在 / 429 限流), 比非 JSON 响应更有诊断价值。
    // 部分中转平台对不存在的路径返回 200 + HTML(SPA 页面), 会掩盖真实的鉴权/路径错误。
    const httpError = attemptErrors.find((entry) => /^HTTP \d{3}/.test(entry));
    throw new Error(`视频生成请求失败: ${httpError ?? attemptErrors[attemptErrors.length - 1] ?? '平台未返回有效响应'}`);
  }
  const immediateResult = getVideoResultUrl(payload);
  if (immediateResult) return immediateResult;
  const taskId = getVideoTaskId(payload);
  if (!taskId) throw new Error('视频平台响应中未找到任务 ID 或视频地址');
  const taskUrls = [
    `${baseUrl}/v1/video/generations/${encodeURIComponent(taskId)}`,
    `${baseUrl}/v1/videos/${encodeURIComponent(taskId)}`,
    `${baseUrl}/v1/videos/generations/${encodeURIComponent(taskId)}`,
    `${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`,
    submitUrl === `${baseUrl}/v2/videos/generations`
      ? `${baseUrl}/v2/videos/generations/${encodeURIComponent(taskId)}`
      : '',
  ].filter(Boolean);
  // 视频生成耗时受排队、模型和时长影响，持续轮询直到平台给出终态。
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    for (const url of taskUrls) {
      const response = await fetch(url, { headers });
      if (!response.ok) continue;
      try { payload = await response.json(); } catch { continue; }
      const videoUrl = getVideoResultUrl(payload);
      if (videoUrl) return videoUrl;
      const status = getVideoTaskStatus(payload);
      if (['FAILED', 'FAILURE', 'ERROR', 'CANCELED', 'CANCELLED', 'REJECTED'].includes(status)) {
        throw new Error(`视频生成失败: ${status}`);
      }
      break;
    }
  }
}

function isCustomModel(model: string): boolean {
  return model.startsWith(CUSTOM_API_PROVIDER_PREFIX);
}

function shouldUseWebviewGeneration(request: GenerateRequest): boolean {
  return !isTauri() || (isWindowsDesktopRuntime() && isCustomModel(request.model));
}

function shouldUseWebviewProviderRequests(): boolean {
  return !isTauri() || isWindowsDesktopRuntime();
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
  const baseUrl =
    typeof rawBaseUrl === 'string' ? rawBaseUrl.trim().replace(/\/+$/, '') : '';
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
  const endpoint = `${baseUrl}/v1/${usesResponsesProtocol ? 'responses' : 'images/generations'}`;
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
              ...referenceImages.map((image) => ({ type: 'input_image', image_url: image })),
            ],
          }],
          tools: [{
            type: 'image_generation',
            action: referenceImages.length > 0 ? 'edit' : 'generate',
            size: mapGptImageSize(request.aspect_ratio),
          }],
          tool_choice: { type: 'image_generation' },
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
  const body: Record<string, unknown> = {
    model: apiModel,
    prompt: request.prompt,
    size: isGptImage ? mapGptImageSize(request.aspect_ratio) : '1024x1024',
    n: 1,
  };
  if (isGptImage) {
    body.output_format = 'png';
    if (apiModel.toLowerCase().includes('gpt-image-2')) {
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
      const normalized = referenceImages.map((image) =>
        image.startsWith('data:') ? (image.split(',', 2)[1] ?? image) : image
      );
      body.input_image = normalized.length === 1 ? normalized[0] : normalized;
    } else {
      body.image = referenceImages[0];
      if (referenceImages.length > 1) {
        body.images = referenceImages;
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
