import {
  generateImage,
  getGenerateImageJob,
  setApiKey,
  submitGenerateImageJob,
} from '@/commands/ai';
import { imageUrlToDataUrl, persistImageLocally } from '@/features/canvas/application/imageData';

import type { AiGateway, GenerateImagePayload } from '../application/ports';

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
    /(^|[\s，。；：、,.;:！？!?（）()【】\[\]"'“”‘’])(@?\s*图)(\d+)/g,
    (_match, prefix: string, _marker: string, index: string) => `${prefix}Image ${index}`
  );
}

async function normalizeReferenceImages(payload: GenerateImagePayload): Promise<string[] | undefined> {
  const isKieModel = payload.model.startsWith('kie/');
  const isFalModel = payload.model.startsWith('fal/');
  return payload.referenceImages
    ? await Promise.all(
      payload.referenceImages.map(async (imageUrl) =>
        isKieModel || isFalModel
          ? await imageUrlToDataUrl(imageUrl)
          : await persistImageLocally(imageUrl)
      )
    )
    : undefined;
}

export const tauriAiGateway: AiGateway = {
  setApiKey,
  generateImage: async (payload: GenerateImagePayload) => {
    const normalizedReferenceImages = await normalizeReferenceImages(payload);
    const mergedExtraParams = mergeNegativePrompt(payload);

    return await generateImage({
      prompt: localizeReferenceTokens(payload.prompt, payload.model),
      negative_prompt: payload.negativePrompt,
      model: payload.model,
      size: payload.size,
      aspect_ratio: payload.aspectRatio,
      reference_images: normalizedReferenceImages,
      extra_params: mergedExtraParams,
    });
  },
  submitGenerateImageJob: async (payload: GenerateImagePayload) => {
    const normalizedReferenceImages = await normalizeReferenceImages(payload);
    const mergedExtraParams = mergeNegativePrompt(payload);
    return await submitGenerateImageJob({
      prompt: localizeReferenceTokens(payload.prompt, payload.model),
      negative_prompt: payload.negativePrompt,
      model: payload.model,
      size: payload.size,
      aspect_ratio: payload.aspectRatio,
      reference_images: normalizedReferenceImages,
      extra_params: mergedExtraParams,
    });
  },
  getGenerateImageJob,
};
