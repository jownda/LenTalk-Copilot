import { invoke, isTauri } from '@tauri-apps/api/core';

import { persistImageBinary } from '@/commands/image';
import {
  extensionFromMimeType,
  resolveReferenceAssetSource,
  type ReferenceAssetPayload,
} from '@/commands/referenceAssetSource';
import { useSettingsStore } from '@/stores/settingsStore';
import type { GenerateRequest, GenerateVideoRequest } from '@/commands/ai';

/** 帧间 API 的固定协议版本。Base URL 在设置里保存为站点根地址。 */
const ZHENJIAN_API_PREFIX = '/v1';
const ZHENJIAN_POLL_INTERVAL_MS = 10_000;

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

export function normalizeZhenjianBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/i, '').replace(/\/+$/, '');
}

/** 同时按平台 id 和域名识别，允许用户手动添加/改名后仍自动走专有链路。 */
export function isZhenjianProvider(providerId: string, baseUrl = ''): boolean {
  const normalizedId = providerId.trim().toLowerCase().replace(/^custom:/, '');
  const normalizedUrl = baseUrl.trim().toLowerCase();
  return normalizedId === 'zhenjian'
    || normalizedId.includes('帧间')
    || normalizedUrl.includes('zhenjian.work');
}

export interface ZhenjianModelsResult {
  models: string[];
  /** 官方 rates 转换为 CNY 元，平台文档的 rates 单位是人民币分。 */
  prices: Record<string, number>;
}

function parseFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const normalized = value.trim().replace(/[,，]/g, '');
    if (Number.isFinite(Number(normalized))) return Number(normalized);
    const embedded = normalized.match(/-?\d+(?:\.\d+)?/);
    if (embedded && Number.isFinite(Number(embedded[0]))) return Number(embedded[0]);
  }
  return null;
}

function extractRateInCny(value: unknown): number | null {
  const direct = parseFiniteNumber(value);
  if (direct != null) return Math.max(0, direct) / 100;
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const rate = extractRateInCny(item);
      if (rate != null) return rate;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  const preferredKeys = [
    'price', 'amount', 'cost', 'cny', 'rmb', 'per_call', 'per_request',
    'per_run', 'output', 'image', 'video', 'total', 'value',
  ];
  for (const key of preferredKeys) {
    const rate = extractRateInCny(record[key]);
    if (rate != null) return rate;
  }
  for (const nested of Object.values(record)) {
    const rate = extractRateInCny(nested);
    if (rate != null) return rate;
  }
  return null;
}

function modelIdFromRecord(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of ['id', 'model', 'model_id', 'modelId', 'model_name', 'modelName', 'slug', 'name']) {
    if (typeof record[key] === 'string' && record[key].trim()) return record[key].trim();
  }
  return null;
}

/** 解析帧间 /v1/models，同时保留官方 rates 供价格表使用。 */
export function extractZhenjianModels(payload: unknown): ZhenjianModelsResult {
  const models = new Set<string>();
  const prices: Record<string, number> = {};
  const visit = (value: unknown, allowModelMap = false): void => {
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, allowModelMap));
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const modelId = modelIdFromRecord(record);
    if (modelId) {
      models.add(modelId);
      const rate = extractRateInCny(record.rates ?? record.rate ?? record.pricing ?? record.price);
      if (rate != null) prices[modelId] = rate;
    }
    for (const key of ['data', 'models', 'items', 'results']) visit(record[key], true);
    if (allowModelMap && !modelId) {
      for (const [key, nested] of Object.entries(record)) {
        if (!nested || typeof nested !== 'object' || Array.isArray(nested)) continue;
        const nestedRecord = nested as Record<string, unknown>;
        if (nestedRecord.rates != null || nestedRecord.rate != null || nestedRecord.pricing != null || nestedRecord.price != null) {
          visit({ ...nestedRecord, id: key });
        }
      }
    }
  };
  visit(payload);
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const root = payload as Record<string, unknown>;
    for (const key of ['rates', 'prices', 'pricing']) {
      const rateTable = root[key];
      if (!rateTable || typeof rateTable !== 'object' || Array.isArray(rateTable)) continue;
      for (const [modelId, value] of Object.entries(rateTable as Record<string, unknown>)) {
        if (!models.has(modelId)) continue;
        const rate = extractRateInCny(value);
        if (rate != null) prices[modelId] = rate;
      }
    }
  }
  return { models: [...models], prices };
}

function zhenjianUrl(baseUrl: string, path: string): string {
  const root = normalizeZhenjianBaseUrl(baseUrl);
  return `${root}${ZHENJIAN_API_PREFIX}${path.startsWith('/') ? path : `/${path}`}`;
}

export function createZhenjianIdempotencyKey(seed = ''): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replace(/-/g, '')
    : `${Date.now()}${Math.random().toString(36).slice(2)}`;
  const suffix = seed.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
  return `${random}${suffix}`.slice(0, 100).padEnd(16, '0');
}

function providerApiKey(model: string): string {
  const providerId = model.split('/')[0] ?? '';
  return (useSettingsStore.getState().apiKeys[providerId] ?? '').trim();
}

function jsonHeaders(apiKey: string, idempotencyKey?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
  };
}

async function requestJson(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<ProviderJsonResponse> {
  if (!isTauri()) {
    const response = await fetch(url, init);
    return { ok: response.ok, status: response.status, text: () => response.text() };
  }

  let body: unknown;
  if (init.body) body = JSON.parse(init.body);
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

async function requestBinary(
  url: string,
  headers: Record<string, string>,
): Promise<ProviderBinaryResponse> {
  if (!isTauri()) {
    const response = await fetch(url, { headers });
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      ok: response.ok,
      status: response.status,
      bytes,
      text: () => response.text(),
    };
  }

  const result = await invoke<{ status: number; body: string; body_base64?: string | null }>(
    'request_provider_json',
    { url, method: 'GET', headers, responseEncoding: 'base64' },
  );
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

async function requestMultipart(
  url: string,
  apiKey: string,
  asset: ReferenceAssetPayload,
  model: string,
  kind: 'image' | 'video' | 'audio',
): Promise<ProviderJsonResponse> {
  if (!isTauri()) {
    const binary = atob(asset.base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const form = new FormData();
    form.append('model', model);
    form.append('kind', kind);
    form.append('file', new Blob([bytes], { type: asset.mimeType }), `reference.${asset.extension}`);
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    return { ok: response.ok, status: response.status, text: () => response.text() };
  }

  const result = await invoke<{ status: number; body: string }>('request_provider_multipart', {
    url,
    headers: { Authorization: `Bearer ${apiKey}` },
    fieldName: 'file',
    filename: `reference.${asset.extension}`,
    contentType: asset.mimeType,
    bodyBase64: asset.base64,
    fields: { model, kind },
  });
  return {
    ok: result.status >= 200 && result.status < 300,
    status: result.status,
    text: async () => result.body,
  };
}

function parseJson(raw: string, label: string): unknown {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`${label}: 平台返回了非 JSON 响应`);
  }
}

function errorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const error = record.error;
    if (typeof error === 'string' && error.trim()) return error.trim();
    if (error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string') {
      return String((error as Record<string, unknown>).message);
    }
    for (const key of ['message', 'detail', 'failure_reason', 'reason']) {
      if (typeof record[key] === 'string' && String(record[key]).trim()) return String(record[key]);
    }
  }
  return fallback;
}

function extractTaskId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const id = extractTaskId(item);
      if (id) return id;
    }
    return null;
  }
  const record = payload as Record<string, unknown>;
  for (const key of ['id', 'asset_id', 'assetId', 'task_id', 'taskId', 'job_id', 'jobId']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  for (const key of ['data', 'task', 'job', 'result']) {
    const id = extractTaskId(record[key]);
    if (id) return id;
  }
  return null;
}

function extractStatus(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  if (Array.isArray(payload)) return payload.map(extractStatus).find(Boolean) ?? '';
  const record = payload as Record<string, unknown>;
  for (const key of ['status', 'state', 'task_status']) {
    if (typeof record[key] === 'string') return record[key].trim().toLowerCase();
  }
  for (const key of ['data', 'task', 'job', 'result']) {
    const status = extractStatus(record[key]);
    if (status) return status;
  }
  return '';
}

function isFailedStatus(status: string): boolean {
  return ['failed', 'failure', 'error', 'canceled', 'cancelled', 'rejected'].includes(status);
}

function isCompletedStatus(status: string): boolean {
  return ['completed', 'complete', 'success', 'succeeded', 'done'].includes(status);
}

function isMediaString(value: string): boolean {
  return /^(?:https?:\/\/|data:|\/)/i.test(value.trim());
}

function extractMediaReference(payload: unknown, kind: 'image' | 'video'): string | null {
  if (typeof payload === 'string') return isMediaString(payload) ? payload.trim() : null;
  if (!payload || typeof payload !== 'object') return null;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const value = extractMediaReference(item, kind);
      if (value) return value;
    }
    return null;
  }
  const record = payload as Record<string, unknown>;
  for (const key of ['b64_json', 'base64', 'data_base64']) {
    if (typeof record[key] === 'string' && record[key]) {
      return record[key].startsWith('data:')
        ? record[key]
        : `data:${kind === 'image' ? 'image/png' : 'video/mp4'};base64,${record[key]}`;
    }
  }
  const preferred = kind === 'image'
    ? ['url', 'image_url', 'download_url', 'downloadUrl', 'images', 'image', 'output']
    : ['url', 'video_url', 'videoUrl', 'download_url', 'downloadUrl', 'video', 'output'];
  for (const key of preferred) {
    const value = record[key];
    if (typeof value === 'string' && isMediaString(value)) return value.trim();
    const nested = extractMediaReference(value, kind);
    if (nested) return nested;
  }
  for (const key of ['data', 'result', 'task', 'outputs', 'files']) {
    const nested = extractMediaReference(record[key], kind);
    if (nested) return nested;
  }
  return null;
}

export function resolveZhenjianResultUrl(
  baseUrl: string,
  result: string,
  taskId: string,
  kind: 'image' | 'video',
): string {
  const value = result.trim();
  if (/^data:/i.test(value) || /^https?:\/\//i.test(value)) return value;
  if (value.startsWith('/')) return `${normalizeZhenjianBaseUrl(baseUrl)}${value}`;
  if (value) return `${normalizeZhenjianBaseUrl(baseUrl)}/${value}`;
  return zhenjianUrl(baseUrl, `/tasks/${encodeURIComponent(taskId)}/${kind === 'image' ? 'image/0' : 'video'}?download=1`);
}

function mimeFromResult(result: string, kind: 'image' | 'video'): string {
  const dataMatch = result.match(/^data:([^;,]+)/i);
  if (dataMatch) return dataMatch[1];
  const lower = result.toLowerCase();
  if (kind === 'video' && lower.includes('.webm')) return 'video/webm';
  if (kind === 'video' && lower.includes('.mov')) return 'video/quicktime';
  if (kind === 'image' && lower.includes('.webp')) return 'image/webp';
  if (kind === 'image' && lower.includes('.jpg')) return 'image/jpeg';
  return kind === 'image' ? 'image/png' : 'video/mp4';
}

async function materializeResult(
  baseUrl: string,
  apiKey: string,
  result: string,
  taskId: string,
  kind: 'image' | 'video',
): Promise<string> {
  if (/^data:/i.test(result)) return result;
  const url = resolveZhenjianResultUrl(baseUrl, result, taskId, kind);
  const response = await requestBinary(url, { Authorization: `Bearer ${apiKey}` });
  if (!response.ok || response.bytes.length === 0) {
    throw new Error(`帧间${kind === 'image' ? '图片' : '视频'}下载失败: HTTP ${response.status} (${url})`);
  }
  const mimeType = mimeFromResult(url, kind);
  if (isTauri()) {
    return await persistImageBinary(response.bytes, extensionFromMimeType(mimeType));
  }
  return URL.createObjectURL(new Blob([response.bytes], { type: mimeType }));
}

async function remoteUrlToAsset(url: string, kind: 'image' | 'video' | 'audio'): Promise<ReferenceAssetPayload> {
  const response = await requestBinary(url, {});
  if (!response.ok || response.bytes.length === 0) {
    throw new Error(`帧间参考素材下载失败: HTTP ${response.status}`);
  }
  const mimeType = kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'audio/mpeg';
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < response.bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...response.bytes.subarray(index, index + chunkSize));
  }
  return { mimeType, extension: extensionFromMimeType(mimeType), base64: btoa(binary) };
}

async function uploadAsset(
  source: string,
  baseUrl: string,
  apiKey: string,
  model: string,
  kind: 'image' | 'video' | 'audio',
  index: number,
): Promise<string> {
  const resolved = await resolveReferenceAssetSource(source, `帧间${kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'} ${index + 1}`);
  const asset = resolved.kind === 'url' ? await remoteUrlToAsset(resolved.url, kind) : resolved;
  const url = zhenjianUrl(baseUrl, '/assets');
  const response = await requestMultipart(url, apiKey, asset, model, kind);
  const raw = await response.text();
  const payload = parseJson(raw, '帧间参考素材上传失败');
  if (!response.ok) throw new Error(`帧间参考素材上传失败: ${errorMessage(payload, `HTTP ${response.status}`)}`);
  const id = extractTaskId(payload);
  if (!id) throw new Error('帧间参考素材上传失败: 响应中未找到 asset id');
  return id;
}

async function pollTask(
  baseUrl: string,
  apiKey: string,
  taskId: string,
  kind: 'image' | 'video',
): Promise<string> {
  const taskUrl = zhenjianUrl(baseUrl, `/tasks/${encodeURIComponent(taskId)}`);
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, ZHENJIAN_POLL_INTERVAL_MS));
    const response = await requestJson(taskUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
    const raw = await response.text();
    const payload = parseJson(raw, `帧间${kind === 'image' ? '图片' : '视频'}任务查询失败`);
    if (!response.ok) throw new Error(`帧间任务查询失败: ${errorMessage(payload, `HTTP ${response.status}`)}`);
    const result = extractMediaReference(payload, kind);
    if (result) return await materializeResult(baseUrl, apiKey, result, taskId, kind);
    const status = extractStatus(payload);
    if (isFailedStatus(status)) {
      throw new Error(`帧间${kind === 'image' ? '图片' : '视频'}生成失败: ${errorMessage(payload, status)}`);
    }
    if (isCompletedStatus(status)) {
      const fallback = resolveZhenjianResultUrl(baseUrl, '', taskId, kind);
      return await materializeResult(baseUrl, apiKey, fallback, taskId, kind);
    }
  }
}

async function submitAndWait(
  baseUrl: string,
  apiKey: string,
  model: string,
  kind: 'image' | 'video',
  path: string,
  body: Record<string, unknown>,
): Promise<string> {
  const submitUrl = zhenjianUrl(baseUrl, path);
  const response = await requestJson(submitUrl, {
    method: 'POST',
    headers: jsonHeaders(apiKey, createZhenjianIdempotencyKey(model)),
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  const payload = parseJson(raw, `帧间${kind === 'image' ? '图片' : '视频'}请求失败`);
  if (!response.ok) throw new Error(`帧间${kind === 'image' ? '图片' : '视频'}请求失败: ${errorMessage(payload, `HTTP ${response.status}`)}`);
  const immediate = extractMediaReference(payload, kind);
  const taskId = extractTaskId(payload);
  if (immediate && taskId) return await materializeResult(baseUrl, apiKey, immediate, taskId, kind);
  if (immediate) return /^data:/i.test(immediate) ? immediate : await materializeResult(baseUrl, apiKey, immediate, taskId ?? 'result', kind);
  if (!taskId) throw new Error(`帧间${kind === 'image' ? '图片' : '视频'}响应中未找到任务 ID: ${JSON.stringify(payload).slice(0, 600)}`);
  return await pollTask(baseUrl, apiKey, taskId, kind);
}

export function buildZhenjianImageBody(
  request: Pick<GenerateRequest, 'prompt' | 'model' | 'size' | 'aspect_ratio'>,
  assets?: string[],
): Record<string, unknown> {
  return {
    model: request.model,
    prompt: request.prompt,
    resolution: request.size,
    ratio: request.aspect_ratio,
    ...(assets?.length ? { assets } : {}),
  };
}

export function buildZhenjianVideoBody(
  request: Pick<GenerateVideoRequest, 'prompt' | 'model' | 'duration' | 'aspect_ratio' | 'video_resolution'>,
  assets?: string[],
): Record<string, unknown> {
  return {
    model: request.model,
    prompt: request.prompt,
    resolution: request.video_resolution || '720p',
    seconds: Math.max(1, Math.round(request.duration)),
    ratio: request.aspect_ratio,
    ...(assets?.length ? { assets } : {}),
  };
}

export async function generateZhenjianImage(request: GenerateRequest): Promise<string> {
  const providerId = request.model.split('/')[0] ?? '';
  const apiModel = request.model.split('/').slice(1).join('/').trim();
  const baseUrl = typeof request.extra_params?.provider_base_url === 'string'
    ? request.extra_params.provider_base_url
    : '';
  const apiKey = providerApiKey(request.model);
  if (!baseUrl || !apiKey || !apiModel || !isZhenjianProvider(providerId, baseUrl)) {
    throw new Error('请在设置中配置帧间 API 的 Base URL、API Key 和模型名称');
  }
  const sources = (request.reference_images ?? []).filter((source) => source.trim());
  const assets = await Promise.all(
    sources.map((source, index) => uploadAsset(source, baseUrl, apiKey, apiModel, 'image', index)),
  );
  const path = assets.length ? '/images/edits' : '/images/generations';
  return await submitAndWait(baseUrl, apiKey, apiModel, 'image', path, buildZhenjianImageBody({ ...request, model: apiModel }, assets));
}

export async function generateZhenjianVideo(request: GenerateVideoRequest): Promise<string> {
  const providerId = request.model.split('/')[0] ?? '';
  const apiModel = request.model.split('/').slice(1).join('/').trim();
  const baseUrl = typeof request.extra_params?.provider_base_url === 'string'
    ? request.extra_params.provider_base_url
    : '';
  const apiKey = providerApiKey(request.model);
  if (!baseUrl || !apiKey || !apiModel || !isZhenjianProvider(providerId, baseUrl)) {
    throw new Error('请在设置中配置帧间 API 的 Base URL、API Key 和模型名称');
  }
  const imageSources = (request.reference_images ?? []).filter((source) => source.trim());
  const imageAssets = await Promise.all(
    imageSources.map((source, index) => uploadAsset(source, baseUrl, apiKey, apiModel, 'image', index)),
  );
  const audioAssets = await Promise.all(
    (request.reference_audio ?? []).filter((source) => source.trim()).map((source, index) =>
      uploadAsset(source, baseUrl, apiKey, apiModel, 'audio', index)),
  );
  return await submitAndWait(
    baseUrl,
    apiKey,
    apiModel,
    'video',
    '/videos',
    buildZhenjianVideoBody({ ...request, model: apiModel }, [...imageAssets, ...audioAssets]),
  );
}
