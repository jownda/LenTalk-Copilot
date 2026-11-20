import { invoke, isTauri } from "@tauri-apps/api/core";

import { chatCompletion, type ChatCompletionContentPart, type ChatCompletionMessage } from "@/commands/ai";
import {
  audioReverseSystemPrompt,
  audioReverseUserMessage,
  type AudioReverseLang,
} from "@/features/canvas/domain/audioReversePrompt";
import {
  collectPajubenModelOptions,
  isPajubenAudioInputModel,
  type PajubenModelOption,
} from "@/features/pajuben/pajubenModels";
import { useSettingsStore, type CustomApiProvider } from "@/stores/settingsStore";
import { resolveImageDisplayUrl } from "./imageData";
import { stripThinkingBlock } from "./visionPromptReverse";

/**
 * 音频反推提示词 —— 把画布上的一段音频交给能「听」的对话模型，反推出风格、歌词、台词。
 *
 * 与图片反推是同一种交付：结果是可编辑的文本节点。差别在于链路：
 *   图片走 `image_url`（部分平台还接受公网直链），音频只能走 OpenAI 的 `input_audio`
 *   （base64 内联），所以必须先把文件读成字节 —— 本地路径 / `asset://` / 远端 URL
 *   都统一由 `loadAudioSourceAsDataUrl` 处理，和画布其它媒体读取走同一套机制。
 *
 * 哪些模型能用：不是所有 chat 模型都收 `input_audio`，而且部分中转会**静默丢弃**它
 * （返回一段「请上传音频」的正常回复）。所以模型按名字先筛一遍（复用扒剧本那份
 * `isPajubenAudioInputModel`），再对返回文本做一次「是不是在说没收到音频」的判定。
 */

export type AudioInputFormat = "wav" | "mp3" | "m4a" | "ogg" | "flac";

/** base64 内联请求体的体积上限 —— 超过这个量级中转基本都会 413，早点拦下来给明确提示。 */
export const MAX_AUDIO_INLINE_BYTES = 15 * 1024 * 1024;

export class AudioReverseModelMissingError extends Error {
  constructor() {
    super("no-audio-chat-model");
    this.name = "AudioReverseModelMissingError";
  }
}

export class AudioReverseUnreadableError extends Error {
  constructor() {
    super("audio-unreadable");
    this.name = "AudioReverseUnreadableError";
  }
}

export class AudioReverseTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super("audio-too-large");
    this.name = "AudioReverseTooLargeError";
  }
}

/** 模型其实没收到音频时说的话（中英各一套；扒剧本引擎里也有同一份判定）。 */
const AUDIO_REJECTED_PATTERNS = [
  /未收到.*音频/,
  /没有.*音频/,
  /未提供.*音频/,
  /请(?:补充|上传|提供).*音频/,
  /无法(?:访问|读取|解析|处理).*(?:音频|声音)/,
  /(?:没有|无法|没能)听到(?:任何)?(?:音频|声音|内容)/,
  /no audio (?:was )?(?:provided|attached|received)/i,
  /(?:unable|cannot|can't) (?:to )?(?:access|read|process) (?:the )?audio/i,
  /please (?:provide|upload|attach) (?:the )?audio/i,
  /I (?:don't|do not) (?:have|see|receive) (?:any )?audio/i,
];

/** 小节标题 —— 出现任何一个就说明模型按格式读了音频，不该按「没收」处理。 */
const AUDIO_REVERSE_HEADING_RE = /【(?:类型|风格标签|情绪与速度|乐器与编曲|人声|歌词|台词|音效与环境|生成提示词)】/;

/**
 * 判定模型是不是在说「没收到音频」。
 *
 * 只在前 400 字里找：真反推出来的结果开头是【类型】，而拒收回复通常整段都是解释。
 * 放宽到全文会把「音频里有句台词叫『我什么也没听到』」这种误判掉；反过来，只要
 * 模型吐出了任一小节标题，就直接放行 —— 那是真读过音频才会有的结构。
 */
export function looksLikeAudioRejected(text: string): boolean {
  if (!text.trim()) return true;
  if (AUDIO_REVERSE_HEADING_RE.test(text)) return false;
  const head = text.slice(0, 400);
  return AUDIO_REJECTED_PATTERNS.some((pattern) => pattern.test(head));
}

export function resolveAudioInputFormat(source: string, mimeType = ""): AudioInputFormat {
  const normalized = `${mimeType} ${source}`.toLowerCase();
  if (normalized.includes("wav")) return "wav";
  if (normalized.includes("m4a") || normalized.includes("mp4") || normalized.includes("aac")) return "m4a";
  if (normalized.includes("ogg") || normalized.includes("oga") || normalized.includes("opus")) return "ogg";
  if (normalized.includes("flac")) return "flac";
  return "mp3";
}

/**
 * 把任意音频来源读成 data URL。
 *
 * 走 Rust 的 `load_media_data_url`：它同时处理本地路径、`asset://` 与远端 http(s)，
 * 而且不受 webview 的 CORS 约束 —— 远端音频在画布里常因跨域读不出字节。
 * 非 Tauri（浏览器预览）退回 fetch + FileReader。
 */
export async function loadAudioSourceAsDataUrl(source: string): Promise<string> {
  const trimmed = source.trim();
  if (!trimmed) {
    throw new AudioReverseUnreadableError();
  }
  if (trimmed.startsWith("data:")) {
    return trimmed;
  }
  if (isTauri()) {
    let dataUrl = "";
    try {
      dataUrl = await invoke<string>("load_media_data_url", { source: trimmed });
    } catch (error) {
      console.warn("[audioReverse] load_media_data_url failed", {
        source: trimmed,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (dataUrl.startsWith("data:")) return dataUrl;
    throw new AudioReverseUnreadableError();
  }
  try {
    const response = await fetch(resolveImageDisplayUrl(trimmed));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(new Error("音频读取失败"));
      reader.readAsDataURL(blob);
    });
  } catch (error) {
    console.warn("[audioReverse] fetch fallback failed", {
      source: trimmed,
      message: error instanceof Error ? error.message : String(error),
    });
    throw new AudioReverseUnreadableError();
  }
}

export interface AudioInputPart {
  part: ChatCompletionContentPart;
  format: AudioInputFormat;
  /** 原始字节数（base64 解码后），用于体积提示。 */
  bytes: number;
}

export function audioDataUrlToInputPart(dataUrl: string): AudioInputPart {
  const match = dataUrl.match(/^data:([^;,]*)(;base64)?,(.*)$/s);
  if (!match || !match[2]) {
    throw new AudioReverseUnreadableError();
  }
  const mimeType = match[1] || "audio/mpeg";
  const base64 = match[3] ?? "";
  if (!base64) {
    throw new AudioReverseUnreadableError();
  }
  // base64 → 原始字节数（去掉 padding 再乘 3/4）。
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const bytes = Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
  if (bytes > MAX_AUDIO_INLINE_BYTES) {
    throw new AudioReverseTooLargeError(bytes);
  }
  const format = resolveAudioInputFormat("", mimeType);
  return {
    part: { type: "input_audio", input_audio: { data: base64, format } },
    format,
    bytes,
  };
}

/**
 * 挑一个能听音频的对话模型。
 *
 * 优先用户自己的自定义平台（多数人的 key 在那边），其次内置推荐平台；
 * 同类里优先名字明牌支持音频的（gemini / *-omni / *-audio），都不匹配再退回第一项 ——
 * 反正后面还有 `looksLikeAudioRejected` 兜底，选错模型不会悄悄产出一份假结果。
 */
export function resolveAudioReverseChatModel(
  customApis: CustomApiProvider[],
  apiKeys: Record<string, string>,
): PajubenModelOption | null {
  const options = collectPajubenModelOptions(customApis, apiKeys);
  if (options.length === 0) return null;
  // 采到的条目里包含没填 Key 的渠道（`collectPajubenModelOptions` 只在推荐平台那边过滤），
  // 挑中它们只会在发送时 401，不如在这里就跳过。
  const audioCapable = options.filter(
    (option) => option.apiKey.trim() && isPajubenAudioInputModel(option.model),
  );
  if (audioCapable.length > 0) {
    return audioCapable.find((option) => option.source === "custom") ?? audioCapable[0];
  }
  return null;
}

export interface ReversePromptFromAudioOptions {
  audioSource: string;
  /** 展示名（节点标题 / 文件名），只作为上下文交给模型。 */
  label?: string;
  durationSec?: number;
  lang: AudioReverseLang;
  /** 不传则按设置里的平台自动挑一个能听音频的模型。 */
  chatModel?: PajubenModelOption | null;
}

export interface ReversePromptFromAudioResult {
  text: string;
  model: string;
  providerName: string;
  format: AudioInputFormat;
  bytes: number;
}

/**
 * 用音频理解模型反推提示词，返回模型原始（已去掉思考块）的分节文本。
 *
 * 抛错时由界面层翻译成人话：`AudioReverseModelMissingError`（没配模型）、
 * `AudioReverseUnreadableError`（读不出字节 / 模型没收到音频）、
 * `AudioReverseTooLargeError`（超过内联上限）。
 */
export async function reversePromptFromAudio({
  audioSource,
  label = "",
  durationSec = 0,
  lang,
  chatModel,
}: ReversePromptFromAudioOptions): Promise<ReversePromptFromAudioResult> {
  const model =
    chatModel ??
    resolveAudioReverseChatModel(
      useSettingsStore.getState().customApis,
      useSettingsStore.getState().apiKeys,
    );
  if (!model) {
    throw new AudioReverseModelMissingError();
  }

  const dataUrl = await loadAudioSourceAsDataUrl(audioSource);
  const { part, format, bytes } = audioDataUrlToInputPart(dataUrl);

  const messages: ChatCompletionMessage[] = [
    { role: "system", content: audioReverseSystemPrompt(lang) },
    {
      role: "user",
      content: [
        { type: "text", text: audioReverseUserMessage({ label, durationSec, lang }) },
        part,
      ],
    },
  ];

  const raw = await chatCompletion(model.baseUrl, model.apiKey, model.model, messages);
  const text = stripThinkingBlock(raw);

  if (looksLikeAudioRejected(text)) {
    // 中转丢 `input_audio` 时模型会正常回一段「请提供音频」——这不是结果，必须报错，
    // 否则用户会把这段解释当成反推内容粘进提示词。
    throw new AudioReverseUnreadableError();
  }
  if (!text.trim()) {
    throw new Error("empty-response");
  }

  return { text, model: model.model, providerName: model.providerName, format, bytes };
}
