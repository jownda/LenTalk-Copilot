/**
 * 各 TTS 模型的**真实预置音色表**。
 *
 * 之前所有音频模型共用一份写死的 6 音色(alloy / echo / fable / onyx / nova /
 * shimmer) —— 那其实是 `tts-1` 一家独有的清单, 被错误地当成了「TTS 通用音色」。
 * 实际上各模型的音色数量与名字都不一样:
 *
 * | 模型 | 预置音色 | 输出格式 | 风格指令 |
 * |---|---|---|---|
 * | GM-3.1 Flash TTS / GM-2.5 Pro TTS | **30** 种 + 24 语言 | 仅 wav | ✅ instructions |
 * | GT TTS / GT TTS HD | 6 种 | mp3/opus/aac/flac/wav/pcm | — |
 * | GT-4o Mini TTS | 6 种 | mp3/opus/aac/flac/wav/pcm | ✅ instructions |
 * | ElevenLabs | 官方预置音色 | mp3/pcm | — |
 *
 * 统一成 6 种既不真实, 也会让用户以为 GM 系列只有 6 个音色 —— 那 30 个音色是
 * 「有声小说 / 多角色配音」场景的核心资产, 藏起来等于把卖点砍了。
 *
 * 数据来源: 知鸟 AI `GET /v1/logical-models` 的 `param_schema.voice.options`
 * (2026-09-20 抓取)。平台改音色表时同步这里 —— 这是唯一真相, 不要在 UI 里另写一份。
 */

/** 一个预置音色。`id` 是发给平台的原始值, 大小写敏感(GM 系列是 `Zephyr` 不是 `zephyr`)。 */
export interface AudioVoiceEntry {
  id: string;
  /** UI 展示名称。省略时沿用 id(兼容 Gemini/OpenAI 等模型)。 */
  name?: string;
  /** 平台的风格说明, 原文形如「明亮 / Bright」。英文界面下不显示。 */
  style?: string;
}

/** 语速(speed)取值域 —— 平台接受小数, 不是枚举。 */
export interface AudioVoiceSpeedRange {
  min: number;
  max: number;
  step: number;
  default: string;
}

export interface AudioVoiceCatalog {
  /** 该模型真实可用的预置音色, 顺序即平台给出的顺序。 */
  voices: AudioVoiceEntry[];
  /** 平台默认音色。 */
  defaultVoice: string;
  formatOptions: string[];
  defaultFormat: string;
  /**
   * 是否支持**自然语言风格指令**(instructions)。
   * GM 系列与 GT-4o Mini TTS 独有: 可以写「以温柔耳语朗读」「快速兴奋」这类描述,
   * 这是它们相对普通 TTS 的核心差异, 没有这个输入框那两项能力等于不存在。
   */
  supportsInstructions: boolean;
  /** 有则渲染语速输入框。 */
  speed?: AudioVoiceSpeedRange;
}

/** GM 系列 30 种预置音色(GM-3.1 Flash 与 GM-2.5 Pro 共用同一套)。 */
const GEMINI_VOICES: AudioVoiceEntry[] = [
  { id: "Zephyr", style: "明亮 / Bright" },
  { id: "Puck", style: "活泼 / Upbeat" },
  { id: "Charon", style: "信息量大 / Informative" },
  { id: "Kore", style: "坚定 / Firm" },
  { id: "Fenrir", style: "激动 / Excitable" },
  { id: "Leda", style: "年轻 / Youthful" },
  { id: "Orus", style: "坚定 / Firm" },
  { id: "Aoede", style: "轻盈 / Breezy" },
  { id: "Callirrhoe", style: "随和 / Easy-going" },
  { id: "Autonoe", style: "明亮 / Bright" },
  { id: "Enceladus", style: "呼吸感 / Breathy" },
  { id: "Iapetus", style: "清晰 / Clear" },
  { id: "Umbriel", style: "随和 / Easy-going" },
  { id: "Algieba", style: "流畅 / Smooth" },
  { id: "Despina", style: "流畅 / Smooth" },
  { id: "Erinome", style: "清晰 / Clear" },
  { id: "Algenib", style: "沙哑 / Gravelly" },
  { id: "Rasalgethi", style: "信息量大 / Informative" },
  { id: "Laomedeia", style: "活泼 / Upbeat" },
  { id: "Achernar", style: "柔和 / Soft" },
  { id: "Alnilam", style: "坚定 / Firm" },
  { id: "Schedar", style: "稳重 / Even" },
  { id: "Gacrux", style: "成熟 / Mature" },
  { id: "Pulcherrima", style: "前进 / Forward" },
  { id: "Achird", style: "友好 / Friendly" },
  { id: "Zubenelgenubi", style: "随性 / Casual" },
  { id: "Vindemiatrix", style: "温柔 / Gentle" },
  { id: "Sadachbia", style: "活泼 / Lively" },
  { id: "Sadaltager", style: "博学 / Knowledgeable" },
  { id: "Sulafat", style: "温暖 / Warm" },
];

/** GT(GPT)系列 6 种预置音色。 */
const GT_VOICES: AudioVoiceEntry[] = [
  { id: "alloy", style: "中性平衡" },
  { id: "echo", style: "男声" },
  { id: "fable", style: "英伦男声" },
  { id: "onyx", style: "深沉男声" },
  { id: "nova", style: "女声" },
  { id: "shimmer", style: "女声 — 温柔" },
];

/** ElevenLabs 官方 Premade Voices。id 是官方 API voice_id，不是展示名称。 */
const ELEVENLABS_VOICES: AudioVoiceEntry[] = [
  { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel", style: "女声 / 叙述" },
  { id: "AZnzlk1XvdvUeBnXmlld", name: "Domi", style: "女声 / 坚定" },
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Bella", style: "女声 / 温柔" },
  { id: "ErXwobaYiN019PkySvjV", name: "Antoni", style: "男声 / 沉稳" },
  { id: "MF3mGyEYCl7XYWbV9V6O", name: "Elli", style: "女声 / 年轻" },
  { id: "TxGEqnHWrfWFTfGW9XjX", name: "Josh", style: "男声 / 年轻" },
  { id: "VR6AewLTigWG4xSOukaG", name: "Arnold", style: "男声 / 厚重" },
  { id: "pNInz6obpgDQGcFmaJgB", name: "Adam", style: "男声 / 深沉" },
  { id: "yoZ06aMxZJJ28mfd3POQ", name: "Sam", style: "男声 / 均衡" },
  { id: "ThT5KcBeYPX3keUQqHPh", name: "Dorothy", style: "女声 / 英式" },
];

/** GM 系列支持的输出格式 —— 平台只开放 wav(原生 PCM 无损)。 */
const GEMINI_FORMATS = ["wav"];
/** GT 系列支持的输出格式。 */
const GT_FORMATS = ["mp3", "opus", "aac", "flac", "wav", "pcm"];

const GEMINI_CATALOG: AudioVoiceCatalog = {
  voices: GEMINI_VOICES,
  defaultVoice: "Zephyr",
  formatOptions: GEMINI_FORMATS,
  defaultFormat: "wav",
  // GM 的看家能力: 用自然语言描述语气/情绪/速度。
  supportsInstructions: true,
};

const GT_CATALOG: AudioVoiceCatalog = {
  voices: GT_VOICES,
  defaultVoice: "alloy",
  formatOptions: GT_FORMATS,
  defaultFormat: "mp3",
  supportsInstructions: false,
  speed: { min: 0.25, max: 4, step: 0.05, default: "1.0" },
};

const GT_INSTRUCT_CATALOG: AudioVoiceCatalog = {
  ...GT_CATALOG,
  // gpt-4o-mini-tts 独有的 instructions: 可调情感/口音/语速。
  supportsInstructions: true,
};

/**
 * 模型名 → 音色目录。顺序敏感: GM 系列要排在通用 `tts` 规则前面。
 *
 * 未识别的模型(其它平台的模型)退回 GT 目录 —— 保持与改造前一致的兜底行为,
 * 不会因为认不出而把音色列表清空。
 */
const GEMINI_TTS_MARKER = /gemini.*tts|gm[-_ ]?\d+(?:\.\d+)?.*tts/;
const GT_INSTRUCT_MARKER = /gpt-4o-mini-tts|4o[-_ ]?mini[-_ ]?tts/;
const ELEVENLABS_MARKER = /eleven(?:labs)?/;

export function resolveAudioVoiceCatalog(modelName: string): AudioVoiceCatalog {
  const normalized = modelName.trim().toLowerCase();
  if (ELEVENLABS_MARKER.test(normalized)) {
    return {
      voices: ELEVENLABS_VOICES,
      defaultVoice: ELEVENLABS_VOICES[0]?.id ?? "",
      formatOptions: ["mp3", "pcm"],
      defaultFormat: "mp3",
      supportsInstructions: false,
    };
  }
  if (GEMINI_TTS_MARKER.test(normalized)) return GEMINI_CATALOG;
  if (GT_INSTRUCT_MARKER.test(normalized)) return GT_INSTRUCT_CATALOG;
  return GT_CATALOG;
}

/** 音色 id → 风格说明。UI 里把 `Zephyr` 显示成「Zephyr · 明亮」。 */
export function resolveVoiceStyle(catalog: AudioVoiceCatalog | undefined, voiceId: string): string | undefined {
  return catalog?.voices.find((entry) => entry.id === voiceId)?.style;
}
