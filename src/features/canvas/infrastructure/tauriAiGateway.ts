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
} from '@/features/canvas/application/imageData';
import { useSettingsStore } from '@/stores/settingsStore';
import { isWindowsDesktopRuntime } from '@/platform/runtime';

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

function normalizeProviderBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
}

function usesWgspaiVideoStudio(baseUrl: string): boolean {
  try {
    return new URL(normalizeProviderBaseUrl(baseUrl)).hostname.toLowerCase() === 'api.wgspai.cn';
  } catch {
    return false;
  }
}

export const tauriAiGateway: AiGateway = {
  setApiKey,
  generateImage: async (payload: GenerateImagePayload) => {
    const injected = injectCustomApiRequestMode(payload);
    // 图片直传: 上游图片 URL 数组直接透传(不做 dataURL/persist/上传)
    const normalizedReferenceImages = injected.referenceImages
      ?.map((imageUrl) => imageUrl.trim())
      .filter(Boolean);
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
    // 图片直传: 上游图片 URL 数组直接透传
    const normalizedReferenceImages = injected.referenceImages
      ?.map((imageUrl) => imageUrl.trim())
      .filter(Boolean);
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
    const providerBaseUrl = typeof injected.extraParams?.provider_base_url === 'string'
      ? injected.extraParams.provider_base_url
      : '';
    const useWgspaiStudio = usesWgspaiVideoStudio(providerBaseUrl);
    // 图片直传: 上游图片 URL 数组直接透传(不做 dataURL/上传)
    const referenceImages = payload.referenceImages
      ?.map((imageUrl) => imageUrl.trim())
      .filter(Boolean);
    const videoExtraParams = {
      ...(injected.extraParams ?? {}),
      ...(useWgspaiStudio ? { video_transport: 'wgspai-studio' } : {}),
    };
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
      extra_params: videoExtraParams,
    });
  },
};
