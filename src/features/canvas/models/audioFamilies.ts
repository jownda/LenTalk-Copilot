/**
 * 音频模型的「家族」分类 —— 决定 AI 音频节点右上角选什么、页面主体渲染哪套 UI。
 *
 * 为什么单独一层: 之前节点顶部是「按创作模式」分页(声音克隆/文字转语音/音乐创作),
 * 所有平台共用一套字段。问题是各家的能力根本对不上 —— MiniMax 有音色资产这一层
 * (克隆/设计 → voice_id → 合成), OpenAI 只有「音色 + 风格指令」, Suno 是音乐不是配音。
 * 硬塞进同一套 UI, 结果就是给 OpenAI 显示「克隆样音」、给 Suno 显示「情绪强度」。
 *
 * 现在改成**按家族分页**: 右上角选家族, 主体按家族渲染专属布局。
 *
 * 现有模型清单(2026-09-20 核对各推荐平台预设):
 *   知鸟AI   speech-2.8 / voice-design / voice-clone | tts-1 / tts-1-hd / gpt-4o-mini-tts
 *            | gemini-3.1-flash-tts / gemini-2.5-pro-tts | music
 *   字子动画  indextts2-v1 | eleven_* | music-2.6 / music-2.6-free / music-cover
 *
 * 家族与节点布局的映射见 `resolveAudioFamilyLayout`。
 */

export type AudioModelFamily =
  "minimax" | "indextts" | "openai" | "gemini" | "doubao" | "elevenlabs" | "suno" | "other";

/** 节点主体按家族渲染的布局类型。 */
export type AudioFamilyLayout =
  /** MiniMax 海螺: 音色克隆 / 音色设计 / 语音合成 三卡片联动。 */
  | "mmx-studio"
  /** indexTTS2: 语言 / 情感来源 / 8 维情感向量 / 发音控制。 */
  | "index-tts"
  /** 通用 TTS: 音色 + 风格指令 + 输出格式(OpenAI / Gemini / 豆包 / ElevenLabs)。 */
  | "standard-tts"
  /** 音乐创作: 风格 + 歌词 + 时长。 */
  | "music";

/**
 * 家族判定规则 —— **顺序敏感**, 从最专门到最宽泛。
 *
 * 两个必须注意的顺序:
 *   1. `minimax` 必须最先: `speech-2.8` / `voice-clone` 都是通用词, 放到后面会被抢走。
 *   2. `gemini` 必须早于 `openai`: `gemini-3.1-flash-tts` 结尾也是 `tts`, 而 openai 的
 *      规则会匹配任意 `-tts` 结尾的模型名 —— 顺序反了 Gemini 的模型会被判成 ChatGPT。
 */
const AUDIO_FAMILY_RULES: Array<{ family: AudioModelFamily; pattern: RegExp }> = [
  {
    family: "minimax",
    pattern: /voice[-_ ]?clone|voice[-_ ]?design|speech[-_ ]?\d|hailuo|海螺|(?:minimax|mmx).*(?:speech|tts|voice)/,
  },
  { family: "indextts", pattern: /index[-_ ]?tts/ },
  { family: "elevenlabs", pattern: /eleven/ },
  { family: "gemini", pattern: /gemini|(?:^|[-_])gm[-_]/ },
  { family: "doubao", pattern: /doubao|volc|豆包|seed[-_ ]?tts/ },
  { family: "suno", pattern: /(?:^|[-_./])(?:suno|music)(?:[-_./]|\d|$)/ },
  {
    family: "openai",
    pattern: /(?:^|[-_./])(?:tts|gpt-4o-mini-tts|gpt-4o-tts)(?:[-_./]|\d|$)|(?:gpt|chatgpt|openai)/,
  },
];

/** 按模型名判定家族; 认不出返回 `other`。 */
export function resolveAudioModelFamily(model: string | undefined): AudioModelFamily {
  const normalized = (model ?? "").trim().toLowerCase();
  if (!normalized) return "other";
  for (const rule of AUDIO_FAMILY_RULES) {
    if (rule.pattern.test(normalized)) return rule.family;
  }
  return "other";
}

/** 家族在右上角选择器 / 界面上的名字。 */
export const AUDIO_FAMILY_LABELS: Record<AudioModelFamily, string> = {
  minimax: "MINIMAX 海螺",
  indextts: "indexTTS",
  openai: "ChatGPT 语音",
  gemini: "Gemini 语音",
  doubao: "豆包语音",
  elevenlabs: "ElevenLabs",
  suno: "Suno 音乐",
  other: "其它语音",
};

/**
 * 家族名对应的 i18n key。
 *
 * `AUDIO_FAMILY_LABELS` 是模型层(无 React/无 i18n)的中文兜底, UI 必须优先用这里的 key,
 * 否则英文界面里会混出中文。品牌名(MINIMAX / indexTTS / ElevenLabs)两种语言一致, 但
 * 「ChatGPT 语音」「其它语音」这类含通用词的必须翻译。
 */
export const AUDIO_FAMILY_LABEL_KEYS: Record<AudioModelFamily, string> = {
  minimax: "node.audioGen.families.minimax",
  indextts: "node.audioGen.families.indextts",
  openai: "node.audioGen.families.openai",
  gemini: "node.audioGen.families.gemini",
  doubao: "node.audioGen.families.doubao",
  elevenlabs: "node.audioGen.families.elevenlabs",
  suno: "node.audioGen.families.suno",
  other: "node.audioGen.families.other",
};

/** 家族选择器里的展示顺序 —— 与用户列出的顺序一致。 */
export const AUDIO_FAMILY_ORDER: AudioModelFamily[] = [
  "minimax",
  "indextts",
  "openai",
  "gemini",
  "doubao",
  "elevenlabs",
  "suno",
  "other",
];

const AUDIO_FAMILY_LAYOUTS: Partial<Record<AudioModelFamily, AudioFamilyLayout>> = {
  minimax: "mmx-studio",
  indextts: "index-tts",
  suno: "music",
};

/** 家族 → 节点布局。OpenAI / Gemini / 豆包 / ElevenLabs 共用通用 TTS 布局(字段本就同构)。 */
export function resolveAudioFamilyLayout(family: AudioModelFamily): AudioFamilyLayout {
  return AUDIO_FAMILY_LAYOUTS[family] ?? "standard-tts";
}

/**
 * MINIMAX 三卡片的角色 —— 家族内部的固定分工, 与用户选到哪个成员模型无关。
 *
 * 这三个不是「同族的三个可替换模型」, 而是**流水线上的三个工位**: 克隆/设计产出
 * voice_id, 合成消费 voice_id。所以选中 MINIMAX 家族时三张卡同时在场, 而不是三选一。
 */
export function isMmxFamilyMember(family: AudioModelFamily): boolean {
  return family === "minimax";
}
