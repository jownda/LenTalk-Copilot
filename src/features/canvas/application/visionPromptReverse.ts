import { chatCompletion, type ChatCompletionContentPart } from '@/commands/ai';
import { useSettingsStore, type CustomApiProvider } from '@/stores/settingsStore';
import {
  reversePromptSystemPrompt,
  reversePromptUserMessage,
  type ReversePromptContext,
} from '@/features/canvas/domain/reversePrompt';
import type { PromptOptimizerTaskType } from '@/features/canvas/domain/canvasNodes';
import { imageUrlToDataUrl } from './imageData';

/**
 * 视觉大模型（chat/completions）相关的公共小工具。
 *
 * 提示词优化节点和节点工具栏的「反推提示词」走的是同一条链路：把图交成 data URL /
 * 公网 URL，按 chat completions 的多模态格式发出去。以前这段逻辑只长在节点里，
 * 工具栏要用就得再抄一遍 —— 这里收口成一份，两边共用。
 */

/** 去掉模型偶尔吐出来的 `<thinking>…</thinking>` / `思考: … 输出:` 前缀。 */
export function stripThinkingBlock(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return trimmed;
  }

  const wrapper = /^(?:<thinking>[\s\S]*?<\/thinking>|\\?\s*(?:thinking|reason)\s*:?[\s\S]*?)\\?\s*(?:response|answer|output|final_answer)\s*:?\s*/i;
  const match = trimmed.match(wrapper);
  if (match) {
    const rest = trimmed.slice((match.index ?? 0) + match[0].length).trim();
    if (rest) {
      return rest;
    }
  }

  const enclosed = trimmed.replace(/^(?:<thinking>[\s\S]*?<\/thinking>|<reason>[\s\S]*?<\/reason>)\s*/i, '').trim();
  if (enclosed && enclosed !== trimmed) {
    return enclosed;
  }

  return trimmed;
}

/** 把本地路径 / asset:// / 公网 URL 统一成视觉模型能吃进去的来源。 */
export async function toVisionImageSource(source: string): Promise<string> {
  const trimmed = source.trim();
  if (trimmed.startsWith('data:')) {
    return trimmed;
  }
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }
  const dataUrl = await imageUrlToDataUrl(trimmed);
  if (dataUrl.startsWith('data:')) {
    return dataUrl;
  }
  const mime = /\.png$/i.test(trimmed)
    ? 'image/png'
    : /\.jpe?g$/i.test(trimmed)
      ? 'image/jpeg'
      : /\.webp$/i.test(trimmed)
        ? 'image/webp'
        : /\.gif$/i.test(trimmed)
          ? 'image/gif'
          : 'image/png';
  return `data:${mime};base64,${dataUrl}`;
}

/**
 * 视觉模型的识别特征词。
 *
 * 反推提示词必须用能读图的 chat 模型，纯文本模型（deepseek-chat 之类）收到 image_url
 * 要么报错要么直接忽略图片。平台里通常同时挂着两类模型，所以这里按名字先挑一遍。
 */
const VISION_MODEL_HINTS = [
  'gpt-4o',
  'gpt-4.1',
  'gpt-5',
  'o4',
  'gemini',
  'claude',
  'qwen-vl',
  'qwen2-vl',
  'qwen2.5-vl',
  'qwen3-vl',
  'vl-max',
  'glm-4v',
  'glm-4.5v',
  'vision',
  'doubao-1.5',
  'doubao-seed',
  'step-1v',
  'internvl',
  'pixtral',
  'llava',
  'yi-vision',
  'grok-2-vision',
  'grok-4',
];

export interface VisionChatModel {
  provider: CustomApiProvider;
  model: string;
}

function looksLikeVisionModel(model: string): boolean {
  const lower = model.toLowerCase();
  return VISION_MODEL_HINTS.some((hint) => lower.includes(hint));
}

/**
 * 挑一个能读图的对话模型：优先名字像视觉模型的，其次退回第一个填了 Key 的对话模型。
 * 没有可用配置时返回 null，由调用方给出可读提示（去设置里配平台）。
 */
export function resolveVisionChatModel(
  customApis: CustomApiProvider[],
): VisionChatModel | null {
  const candidates: VisionChatModel[] = [];
  for (const provider of customApis) {
    if (!provider.apiKey?.trim()) {
      continue;
    }
    for (const model of provider.chatModels ?? []) {
      if (model.trim()) {
        candidates.push({ provider, model });
      }
    }
  }
  if (candidates.length === 0) {
    return null;
  }
  return candidates.find((candidate) => looksLikeVisionModel(candidate.model)) ?? candidates[0];
}

export interface ReversePromptFromImagesOptions {
  imageSources: string[];
  lang: 'zh' | 'en';
  taskType?: PromptOptimizerTaskType;
  purpose?: string;
  /** 不传则按设置里的平台自动挑一个视觉模型。 */
  chatModel?: VisionChatModel | null;
}

export class VisionModelMissingError extends Error {
  constructor() {
    super('no-vision-chat-model');
    this.name = 'VisionModelMissingError';
  }
}

export class VisionImageUnreadableError extends Error {
  constructor() {
    super('image-unreadable');
    this.name = 'VisionImageUnreadableError';
  }
}

/**
 * 用视觉模型从图片反推提示词，返回清理后的提示词文本。
 * 抛 `VisionModelMissingError` / `VisionImageUnreadableError` 时由界面层翻译成中文提示。
 */
export async function reversePromptFromImages({
  imageSources,
  lang,
  taskType = 'auto',
  purpose = '',
  chatModel,
}: ReversePromptFromImagesOptions): Promise<{ prompt: string; model: string }> {
  const resolvedChatModel =
    chatModel ?? resolveVisionChatModel(useSettingsStore.getState().customApis);
  if (!resolvedChatModel) {
    throw new VisionModelMissingError();
  }

  const imageParts: ChatCompletionContentPart[] = [];
  for (const source of imageSources) {
    try {
      const url = await toVisionImageSource(source);
      imageParts.push({ type: 'image_url', image_url: { url } });
    } catch (error) {
      console.warn('[reversePrompt] failed to read reference image', {
        source,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (imageParts.length === 0) {
    throw new VisionImageUnreadableError();
  }

  const context: ReversePromptContext = {
    taskType,
    purpose,
    imageCount: imageParts.length,
    lang,
  };

  const raw = await chatCompletion(
    resolvedChatModel.provider.baseUrl,
    resolvedChatModel.provider.apiKey,
    resolvedChatModel.model,
    [
      { role: 'system', content: reversePromptSystemPrompt(lang) },
      {
        role: 'user',
        content: [
          { type: 'text', text: reversePromptUserMessage(context) },
          ...imageParts,
        ],
      },
    ],
  );

  const prompt = stripThinkingBlock(raw);
  if (!prompt) {
    throw new Error('empty-response');
  }
  return { prompt, model: resolvedChatModel.model };
}
