import {
  generateImage,
  generateJimengCliVideo,
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
import { JIMENG_CLI_PROVIDER_ID, resolveVideoModelProfile } from '@/features/canvas/models';
import { toVideoGenerationRequest } from '@/features/canvas/application/videoGeneration';

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
  // WGSPAI 的视频模型使用其 OpenAI Video API，不走聊天或网站工作台接口。
  // 仅按平台 id 注入，不影响其它 custom:* 平台的通用视频链路。
  if (providerId === 'wgspai') {
    const apiModel = payload.model.split('/').slice(1).join('/').trim().toLowerCase();
    extraParams.video_transport = apiModel === 'minimax-h3'
      ? 'wgspai-minimax-h3'
      : 'wgspai-openai-video';
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

function normalizeWgspaiVideoModelName(model: string): string {
  const trimmed = model.trim();
  return trimmed.toLowerCase() === 'minimax-h3' ? 'MiniMax-H3' : trimmed;
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

/** 视频参考图默认使用 OpenAI Video API 可接受的 URL / Data URL。 */
async function normalizeVideoReferenceImages(
  imageUrls: string[] | undefined,
  extraParams: Record<string, unknown> | undefined,
  modelId: string
): Promise<string[] | undefined> {
  if (!imageUrls?.length) return undefined;
  const useWgspaiUpload = extraParams?.video_transport === 'wgspai-openai-video'
    || extraParams?.video_transport === 'wgspai-minimax-h3';
  const providerBaseUrl = typeof extraParams?.provider_base_url === 'string'
    ? extraParams.provider_base_url.trim().replace(/\/+$/, '').replace(/\/v1$/i, '')
    : '';
  const providerId = modelId.split('/')[0] ?? '';
  const apiModel = normalizeWgspaiVideoModelName(modelId.split('/').slice(1).join('/') || modelId);
  const apiKey = useSettingsStore.getState().apiKeys[providerId] ?? '';

  return await Promise.all(imageUrls.map(async (imageUrl) => {
    const source = imageUrl.trim();
    if (!source) return source;
    if (/^https?:\/\//i.test(source)) return source;
    const dataUrl = await imageUrlToDataUrl(source);
    if (!useWgspaiUpload) return dataUrl;
    if (!providerBaseUrl || !apiKey || !apiModel) {
      throw new Error('WGSPAI 参考图片上传需要配置 Base URL、API Key 和模型名称');
    }
    return await uploadWgspaiVideoReferenceImage(dataUrl, providerBaseUrl, apiKey, apiModel);
  }));
}

/** WGSPAI 的上游视频模型会下载图片 URL，不接受 data: URL。 */
async function uploadWgspaiVideoReferenceImage(
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
  formData.append('model', model);
  formData.append('model_name', model);

  // WGSPAI 的不同文件上传通道对模型字段的读取位置不一致：有的读 multipart
  // `model`，有的只读 query 的 `model_name`。两种命名同时传递，不改变视频链路。
  const encodedModel = encodeURIComponent(model);
  const uploadUrl = `${baseUrl}/v1/files?model=${encodedModel}&model_name=${encodedModel}`;
  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });
  const rawResponse = await response.text();
  let payload: unknown = null;
  try {
    payload = JSON.parse(rawResponse);
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const record = payload as Record<string, unknown> | null;
    const errorMessage = record && typeof record.error === 'object'
      ? String((record.error as Record<string, unknown>).message ?? '')
      : '';
    throw new Error(
      `WGSPAI 参考图片上传失败: HTTP ${response.status}${errorMessage ? `: ${errorMessage}` : ''} (model: ${model})`
    );
  }

  const assetUrl = extractUploadedAssetUrl(payload, baseUrl);
  if (!assetUrl) {
    throw new Error('WGSPAI 参考图片上传成功但未返回可访问地址');
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
  for (const key of ['url', 'asset_url', 'assetUrl', 'uri', 'file_url', 'fileUrl', 'download_url']) {
    const value = record[key];
    if (typeof value === 'string' && /^https?:\/\//i.test(value.trim())) return value.trim();
  }
  for (const key of ['id', 'file_id', 'fileId', 'asset_id', 'assetId']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return `${baseUrl}/v1/files/${encodeURIComponent(value.trim())}/content`;
    }
  }
  for (const key of ['data', 'file', 'asset', 'result', 'file_info', 'response']) {
    const assetUrl = extractUploadedAssetUrl(record[key], baseUrl);
    if (assetUrl) return assetUrl;
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
    if (payload.model.startsWith(`${JIMENG_CLI_PROVIDER_ID}/`)) {
      const referenceImages = await normalizeReferenceUrls(payload.referenceImages);
      const referenceAudio = payload.referenceAudio
        ?.map((audioUrl) => audioUrl.trim())
        .filter(Boolean);
      const modelVersion = payload.model.slice(`${JIMENG_CLI_PROVIDER_ID}/`.length);

      return await generateJimengCliVideo({
        client_job_id: payload.clientJobId,
        executable: useSettingsStore.getState().jimengCli.executable,
        prompt: payload.prompt,
        model_version: modelVersion,
        duration: payload.duration,
        aspect_ratio: payload.aspectRatio,
        video_resolution: payload.videoResolution,
        image_mode: payload.imageMode,
        reference_images: referenceImages,
        reference_audio: referenceAudio,
      });
    }

    const injected = injectCustomApiRequestMode(payload as unknown as GenerateImagePayload);
    const profile = resolveVideoModelProfile(payload.model);
    if (profile.status === 'pending-adaptation') {
      throw new Error(profile.unavailableReason ?? '该视频模型尚未完成独立适配');
    }
    const unifiedRequest = toVideoGenerationRequest(payload);
    const imageResources = payload.imageMode === 'first-last'
      ? [unifiedRequest.firstFrame, unifiedRequest.lastFrame].filter(
        (resource): resource is NonNullable<typeof resource> => Boolean(resource)
      )
      : unifiedRequest.referenceImages;
    // 视频参考图:WGSPAI 上传本地资源获取可下载 URL，其它平台保留 Data URL。
    const referenceImages = await normalizeVideoReferenceImages(
      imageResources.map((resource) => resource.source),
      injected.extraParams,
      unifiedRequest.modelId
    );
    // 音频直传: 直接把上游音频 URL 数组透传给后端(不做 /v1/files 上传),
    // 由后端按 audio_url / audio_urls 字段提交给平台。
    const referenceAudio = unifiedRequest.referenceAudio
      .map((resource) => resource.source)
      .map((audioUrl) => audioUrl.trim())
      .filter(Boolean);
    return await generateVideo({
      prompt: unifiedRequest.prompt,
      model: unifiedRequest.modelId,
      duration: unifiedRequest.duration,
      aspect_ratio: unifiedRequest.aspectRatio,
      video_resolution: unifiedRequest.videoResolution,
      image_mode: payload.imageMode,
      reference_images: referenceImages,
      reference_audio: referenceAudio,
      extra_params: injected.extraParams,
    });
  },
};
