import {
  generateImage,
  generateVideo,
  getGenerateImageJob,
  setApiKey,
  submitGenerateImageJob,
} from '@/commands/ai';
import {
} from '@tauri-apps/api/core';
import {
  imageUrlToDataUrl,
} from '@/features/canvas/application/imageData';
import { useSettingsStore } from '@/stores/settingsStore';

import type { AiGateway, GenerateImagePayload, GenerateVideoPayload } from '../application/ports';

function mergeNegativePrompt(
  payload: GenerateImagePayload
): Record<string, unknown> | undefined {
  const extras = { ...(payload.extraParams ?? {}) };
  if (payload.negativePrompt && payload.negativePrompt.trim()) {
    // 兼容:同时写入 negative_prompt 与 extra_params.negative_prompt,
    // 让 Tauri 命令和上游 AI 后端都能读到。
    extras.negative_prompt = payload.negativePrompt.trim();
  }
  return Object.keys(extras).length > 0 ? extras : payload.extraParams;
}

function withAspectRatioRequirement(prompt: string, aspectRatio: string): string {
  const match = aspectRatio.trim().match(/^(\d+)\s*:\s*(\d+)$/);
  if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0) {
    return prompt;
  }
  return `${prompt.trim()}\n\n[Required image aspect ratio: ${match[1]}:${match[2]}. Compose for this exact frame without borders or empty padding.]`;
}

/**
 * 自定义平台按设置里的请求模式注入 request_mode:
 * sync → 后端同步等待; async → 后端提交任务后轮询。
 */
function injectCustomApiRequestMode(payload: GenerateImagePayload): GenerateImagePayload {
  if (!payload.model.startsWith('custom:')) {
    return payload;
  }
  const providerId = payload.model.split('/')[0].replace('custom:', '');
  const customApi = useSettingsStore
    .getState()
    .customApis.find((api) => api.id === providerId);
  const requestMode = customApi?.requestMode ?? 'async';
  const protocol = customApi?.protocol ?? 'images';
  const referenceImageField = customApi?.referenceImageField ?? 'image';
  const extraParams: Record<string, unknown> = {
    ...(payload.extraParams ?? {}),
  };
  if (requestMode === 'async') {
    extraParams.request_mode = 'async';
  }
  if (protocol === 'responses') {
    extraParams.protocol = 'responses';
  }
  if (customApi?.baseUrl) {
    extraParams.provider_base_url = customApi.baseUrl;
  }
  extraParams.reference_image_field = referenceImageField;
  return {
    ...payload,
    extraParams,
  };
}

/**
 * 参考图引用标记本地化:
 * 画布提示词里用 `@图N` 引用参考图(提交前被去掉 @ 变为 `图N`),
 * 参考图按数组顺序传给后端(image_urls / urls / image_base64s)。
 * 英文模型(fal / ppio gemini)的引用协议是 `Image N`, 中文 `图N` 会被当作普通文字,
 * 导致模型无法把引用与参考图对应 —— 这里按模型把标记转换成协议语言。
 * 仅当 token 前是行首/空白/标点时视为引用, 避免误伤正文里的"如图1所示"等普通文字。
 */
export function localizeReferenceTokens(prompt: string, model: string): string {
  if (!prompt) return prompt;
  const usesEnglishProtocol = model.startsWith('fal/') || model.startsWith('ppio/');
  if (!usesEnglishProtocol) return prompt;

  return prompt.replace(
    /(^|[\s，。；：、,.;:！？!?（）()【】[\]"'“”‘’])(@?\s*图)(\d+)/g,
    (_match, prefix: string, _marker: string, index: string) => `${prefix}Image ${index}`
  );
}

/** 参考图片直传: http(s) URL 直接透传(平台可下载); 本地路径/dataURL 转 base64 内嵌。 */
async function normalizeReferenceUrls(
  urls: string[] | undefined
): Promise<string[] | undefined> {
  if (!urls?.length) return undefined;
  return await Promise.all(
    urls
      .map((url) => url.trim())
      .filter(Boolean)
      .map(async (url) => (/^https?:\/\//i.test(url) ? url : await imageUrlToDataUrl(url)))
  );
}

/** 视频参考图: http(s) URL 直接透传; 本地路径/dataURL 上传到平台 /v1/files 换公开 URL。 */
async function normalizeVideoReferenceImages(
  imageUrls: string[] | undefined,
  extraParams: Record<string, unknown> | undefined,
  modelId: string
): Promise<string[] | undefined> {
  if (!imageUrls?.length) return undefined;

  const providerBaseUrl = typeof extraParams?.provider_base_url === 'string'
    ? extraParams.provider_base_url.trim().replace(/\/+$/, '').replace(/\/v1$/i, '')
    : '';
  const providerId = modelId.split('/')[0] ?? '';
  const apiModel = modelId.split('/').slice(1).join('/') || modelId;
  const apiKey = useSettingsStore.getState().apiKeys[providerId] ?? '';

  return await Promise.all(imageUrls.map(async (imageUrl) => {
    const source = imageUrl.trim();
    if (!source) return source;
    // 公开 URL 直接透传(平台可下载)
    if (/^https?:\/\//i.test(source)) {
      return source;
    }
    if (!providerBaseUrl || !apiKey || !apiModel) {
      throw new Error('参考图片上传需要先在设置中配置视频模型的 Base URL、API Key 和模型名称');
    }
    return await uploadVideoReferenceImage(
      await imageUrlToDataUrl(source),
      providerBaseUrl,
      apiKey,
      apiModel
    );
  }));
}

/** 上传本地参考图到平台 /v1/files, 返回可公开访问的 URL。 */
async function uploadVideoReferenceImage(
  dataUrl: string,
  baseUrl: string,
  apiKey: string,
  model: string
): Promise<string> {
  const imageResponse = await fetch(dataUrl);
  if (!imageResponse.ok) {
    throw new Error(`无法读取参考图片: HTTP ${imageResponse.status}`);
  }
  const imageBlob = await imageResponse.blob();
  const formData = new FormData();
  formData.append('file', imageBlob, imageFileName(imageBlob));
  formData.append('purpose', 'assistants');
  // WGSPAI 的文件接口要求模型名; 使用不含 custom: 前缀的平台模型名。
  formData.append('model', model);

  const response = await fetch(`${baseUrl}/v1/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });
  const rawResponse = await response.text();
  let uploadPayload: unknown = null;
  try {
    uploadPayload = JSON.parse(rawResponse);
  } catch {
    uploadPayload = null;
  }
  if (!response.ok) {
    const record = uploadPayload as Record<string, unknown> | null;
    const errorMessage = record && typeof record.error === 'object'
      ? String((record.error as Record<string, unknown>).message ?? '')
      : '';
    throw new Error(
      `参考图片上传失败: HTTP ${response.status}${errorMessage ? `: ${errorMessage}` : ''}`
    );
  }

  const assetUrl = extractUploadedAssetUrl(uploadPayload, baseUrl);
  if (!assetUrl) {
    throw new Error('参考图片上传成功但平台未返回可访问地址');
  }
  return assetUrl;
}

function imageFileName(blob: Blob): string {
  const extensionByMime: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
  };
  return `reference.${extensionByMime[blob.type.toLowerCase()] ?? 'png'}`;
}

/** 从上传响应里递归提取可访问 URL(参考 Infinite Canvas 的多 key 提取策略)。 */
function extractUploadedAssetUrl(payload: unknown, baseUrl: string): string {
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const assetUrl = extractUploadedAssetUrl(item, baseUrl);
      if (assetUrl) return assetUrl;
    }
    return '';
  }
  if (!payload || typeof payload !== 'object') return '';

  const record = payload as Record<string, unknown>;
  // 优先找完整的 http(s) URL
  for (const key of ['url', 'asset_url', 'assetUrl', 'uri', 'file_url', 'fileUrl', 'download_url']) {
    const value = record[key];
    if (typeof value === 'string' && /^https?:\/\//i.test(value.trim())) {
      return value.trim();
    }
  }
  // 其次找文件 id, 拼出平台内可访问地址
  for (const key of ['id', 'file_id', 'fileId', 'asset_id', 'assetId']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return `${baseUrl}/v1/files/${encodeURIComponent(value.trim())}/content`;
    }
  }
  // 递归进常见容器字段
  for (const key of ['data', 'file', 'asset', 'result', 'file_info', 'response']) {
    const found = extractUploadedAssetUrl(record[key], baseUrl);
    if (found) return found;
  }
  return '';
}

export const tauriAiGateway: AiGateway = {
  setApiKey,
  generateImage: async (payload: GenerateImagePayload) => {
    const injected = injectCustomApiRequestMode(payload);
    // 图片直传: http URL 透传, 本地路径转 base64(平台需能下载)
    const normalizedReferenceImages = await normalizeReferenceUrls(injected.referenceImages);
    const mergedExtraParams = mergeNegativePrompt(injected);

    return await generateImage({
      prompt: localizeReferenceTokens(
        withAspectRatioRequirement(payload.prompt, payload.aspectRatio),
        payload.model
      ),
      negative_prompt: payload.negativePrompt,
      model: payload.model,
      size: payload.size,
      aspect_ratio: payload.aspectRatio,
      reference_images: normalizedReferenceImages,
      extra_params: mergedExtraParams,
    });
  },
  submitGenerateImageJob: async (payload: GenerateImagePayload) => {
    const injected = injectCustomApiRequestMode(payload);
    // 图片直传: http URL 透传, 本地路径转 base64
    const normalizedReferenceImages = await normalizeReferenceUrls(injected.referenceImages);
    const mergedExtraParams = mergeNegativePrompt(injected);
    return await submitGenerateImageJob({
      prompt: localizeReferenceTokens(
        withAspectRatioRequirement(payload.prompt, payload.aspectRatio),
        payload.model
      ),
      negative_prompt: payload.negativePrompt,
      model: payload.model,
      size: payload.size,
      aspect_ratio: payload.aspectRatio,
      reference_images: normalizedReferenceImages,
      extra_params: mergedExtraParams,
    });
  },
  getGenerateImageJob,
  generateVideo: async (payload: GenerateVideoPayload) => {
    const injected = injectCustomApiRequestMode(payload as unknown as GenerateImagePayload);
    // 视频参考图: http URL 直传; 本地图片上传平台 /v1/files 换公开 URL
    // (WGSPAI 视频接口只接受可下载的 http URL, 不接受本地路径/base64)
    const referenceImages = await normalizeVideoReferenceImages(
      payload.referenceImages,
      injected.extraParams,
      payload.model
    );
    // 音频直传: 直接把上游音频 URL 数组透传给后端(不做 /v1/files 上传),
    // 由后端按 audio_url / audio_urls 字段提交给平台。
    const referenceAudio = payload.referenceAudio
      ?.map((audioUrl) => audioUrl.trim())
      .filter(Boolean);
    return await generateVideo({
      prompt: payload.prompt,
      model: payload.model,
      duration: payload.duration,
      aspect_ratio: payload.aspectRatio,
      image_mode: payload.imageMode,
      reference_images: referenceImages,
      reference_audio: referenceAudio,
      extra_params: injected.extraParams,
    });
  },
};
