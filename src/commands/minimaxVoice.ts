/**
 * 知鸟AI · MiniMax 海螺语音链路 —— 三个能力的协议定义。
 *
 * 事实来源(2026-09-20 实测, 全部免鉴权可复核), 完整记录见
 * `docs/api_docs/ZhiniaoAI_MiniMax_Voice_Chain.md`:
 *   - GET {root}/v1/logical-models      全量模型元数据 + param_schema(权威字段表)
 *   - GET {root}/api/v1/models          分页目录(含价格 / billing_type)
 *   - GET {root}/zh-CN/docs             文档站(SPA, 正文在 self.__next_f.push 载荷里)
 *
 * 核心事实(照抄目录, 不要凭猜):
 *   1. 平台**只有一个音频端点** `/v1/audio/speech`, model 决定能力 —— 即官方原话
 *      「把 base_url 换成本平台、model 填 voice-clone, 其余请求体保持 GT 原样即可」。
 *      `/v1/audio/music`、`/v1/audio/sound-effects`、`/v1/voice-clone` 一律 404, 别照抄别家文档。
 *   2. `voice-clone` / `voice-design` 是**创建音色资产**(按次一次性计费);
 *      `speech-2.8` 是**消费音色做合成**(按字符计费)。联结点是 `voice_id`。
 *   3. **`voice_id` 由调用方自带**(两个创建接口的都是必填), 且 `voice-clone` 同一 ID
 *      重复克隆**幂等、不二次收费** —— 所以 id 必须在发请求之前就落库, 重试才能免费。
 *   4. 🚨 **`speech-2.8` 没有任何参考样音字段**, 只吃 `voice`(voice_id)。
 *      历史上本项目每次合成都带 `reference_audio`, 平台静默忽略 —— 表现是「克隆了但声音没变」。
 *   5. 请求体字段**放顶层扁平**(与现有 buildAudioBody 一致), 不包 params/metadata。
 *      这一条与「响应体形状」「文本字段名」同属**未经实跑确认项**, 见文档第 8 节。
 */

// ---------------------------------------------------------------------------
// 模型 / 端点
// ---------------------------------------------------------------------------

export const MMX_VOICE_CLONE_MODEL = "voice-clone";
export const MMX_VOICE_DESIGN_MODEL = "voice-design";
export const MMX_SPEECH_MODEL = "speech-2.8";

/** 三个能力共用同一个端点。 */
export const MMX_AUDIO_SPEECH_PATH = "/v1/audio/speech";

/** 自研语音家族标识 —— 平台按家族隔离音色, 跨家族用不了(`familyMismatchHint`)。 */
export const MMX_SPEECH_FAMILY = "speech-2.8";

export type MmxVoiceOperation = "voice-clone" | "voice-design" | "speech";

/**
 * 按模型名判定走哪个能力。
 *
 * 顺序要紧: `voice-clone` / `voice-design` 名字里都含 `voice`, 必须先判这两个,
 * 否则会落进 speech 分支被当普通语音合成用(历史上 `voice-design` 就是这么被送成
 * `input=文本` 的, 语义完全错)。
 */
export function resolveMmxVoiceOperation(model: string | undefined): MmxVoiceOperation | null {
  const normalized = (model ?? "").trim().toLowerCase();
  if (!normalized) return null;
  if (/voice[-_ ]?clone|voiceclone|音色克隆/.test(normalized)) return "voice-clone";
  if (/voice[-_ ]?design|voicedesign|音色设计/.test(normalized)) return "voice-design";
  if (/speech[-_ ]?\d|hailuo|海螺/.test(normalized)) return "speech";
  return null;
}

export function isMmxVoiceCloneModel(model: string | undefined): boolean {
  return resolveMmxVoiceOperation(model) === "voice-clone";
}

export function isMmxVoiceDesignModel(model: string | undefined): boolean {
  return resolveMmxVoiceOperation(model) === "voice-design";
}

export function isMmxSpeechModel(model: string | undefined): boolean {
  return resolveMmxVoiceOperation(model) === "speech";
}

/** 三个能力都属于 MiniMax 语音链路(用于在传输层统一分流)。 */
export function isMmxVoiceModel(model: string | undefined): boolean {
  return resolveMmxVoiceOperation(model) !== null;
}

// ---------------------------------------------------------------------------
// 计费(照抄 /api/v1/models 的 output_price / billing_type)
// ---------------------------------------------------------------------------

/** `voice-clone`: 按次 ⚡2.20, 一次性音色费。 */
export const MMX_VOICE_CLONE_UNIT_PRICE = 2.2;
/** `voice-design`: 按次 ⚡2.1944, 一次性音色费。 */
export const MMX_VOICE_DESIGN_UNIT_PRICE = 2.1944;
/** `speech-2.8`: 按字符, 45 µ$/字符。 */
export const MMX_SPEECH_UNIT_PRICE_PER_CHAR = 0.000045;

/** 创建音色的单价(数字), 供 UI 自己套 i18n 模板。 */
export function resolveMmxCreatePrice(operation: "voice-clone" | "voice-design"): number {
  return operation === "voice-clone" ? MMX_VOICE_CLONE_UNIT_PRICE : MMX_VOICE_DESIGN_UNIT_PRICE;
}

/**
 * 创建音色是一次性花钱的动作, UI 必须在按钮上把价钱说清楚。
 *
 * 中文兜底用; UI 走 `node.audioGen.mmx.pricePerCall` 模板, 英文界面才不会混出「次」。
 */
export function describeMmxCreatePrice(operation: "voice-clone" | "voice-design"): string {
  return `⚡${resolveMmxCreatePrice(operation)} / 次`;
}

// ---------------------------------------------------------------------------
// 参数枚举(照抄 param_schema 的 enum / options, 不要自己编档位)
// ---------------------------------------------------------------------------

export const MMX_SPEECH_VERSIONS = ["2.8", "2.6"] as const;
export const MMX_DEFAULT_SPEECH_VERSION = "2.8";

export const MMX_SPEECH_TIERS = ["hd", "turbo"] as const;
export type MmxSpeechTier = (typeof MMX_SPEECH_TIERS)[number];
export const MMX_DEFAULT_SPEECH_TIER: MmxSpeechTier = "hd";

export const MMX_SPEECH_SPEEDS = ["0.5", "0.75", "1", "1.25", "1.5", "2"] as const;
export const MMX_DEFAULT_SPEECH_SPEED = "1";

export const MMX_SPEECH_PITCHES = ["-6", "-3", "0", "3", "6"] as const;
export const MMX_DEFAULT_SPEECH_PITCH = "0";

export const MMX_SPEECH_EMOTIONS = ["auto", "happy", "sad", "angry", "fearful", "surprised", "calm"] as const;
export const MMX_DEFAULT_SPEECH_EMOTION = "auto";
export type MmxSpeechEmotion = (typeof MMX_SPEECH_EMOTIONS)[number];

export const MMX_SPEECH_SOUND_EFFECTS = [
  "none",
  "spacious_echo",
  "auditorium_echo",
  "lofi_telephone",
  "robotic",
] as const;
export const MMX_DEFAULT_SPEECH_SOUND_EFFECT = "none";

/** `max_prompt_chars: 9999`。 */
export const MMX_SPEECH_MAX_TEXT_CHARS = 9999;

function coerceEnum<T extends readonly string[]>(value: unknown, allowed: T, fallback: T[number]): T[number] {
  const normalized = typeof value === "string" ? value.trim() : "";
  return (allowed as readonly string[]).includes(normalized) ? (normalized as T[number]) : fallback;
}

export function normalizeMmxSpeechVersion(value: unknown): string {
  return coerceEnum(value, MMX_SPEECH_VERSIONS, MMX_DEFAULT_SPEECH_VERSION);
}
export function normalizeMmxSpeechTier(value: unknown): MmxSpeechTier {
  return coerceEnum(value, MMX_SPEECH_TIERS, MMX_DEFAULT_SPEECH_TIER);
}
export function normalizeMmxSpeechSpeed(value: unknown): string {
  return coerceEnum(value, MMX_SPEECH_SPEEDS, MMX_DEFAULT_SPEECH_SPEED);
}
export function normalizeMmxSpeechPitch(value: unknown): string {
  return coerceEnum(value, MMX_SPEECH_PITCHES, MMX_DEFAULT_SPEECH_PITCH);
}
export function normalizeMmxSpeechEmotion(value: unknown): MmxSpeechEmotion {
  return coerceEnum(value, MMX_SPEECH_EMOTIONS, MMX_DEFAULT_SPEECH_EMOTION);
}
export function normalizeMmxSpeechSoundEffect(value: unknown): string {
  return coerceEnum(value, MMX_SPEECH_SOUND_EFFECTS, MMX_DEFAULT_SPEECH_SOUND_EFFECT);
}

// ---------------------------------------------------------------------------
// voice_id
// ---------------------------------------------------------------------------

/**
 * `voice-clone` 要求「字母开头, 8-256 字符, 字母/数字/-/_」;
 * `voice-design` 要求「字母开头, ≥8 字符, 字母+数字」。
 * 取交集(字母+数字)才能让同一个 id 在两条链路都合法。
 */
export const MMX_VOICE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9]{7,255}$/;

export function isValidMmxVoiceId(value: string | undefined): boolean {
  return MMX_VOICE_ID_PATTERN.test((value ?? "").trim());
}

const VOICE_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * 生成一个合法的新音色 ID: `lt` + base36 时间戳 + 4 位随机, 总长 13。
 *
 * **必须在发请求之前生成并落库**: `voice-clone` 按 voice_id 幂等, 失败重试沿用同一个
 * id 才不会被二次收费。等响应回来再定 id 就失去了这层保护。
 */
export function generateMmxVoiceId(now: number = Date.now(), random: () => number = Math.random): string {
  const stamp = Math.floor(now).toString(36);
  let suffix = "";
  for (let index = 0; index < 4; index += 1) {
    suffix += VOICE_ID_ALPHABET[Math.floor(random() * VOICE_ID_ALPHABET.length)] ?? "x";
  }
  const candidate = `lt${stamp}${suffix}`;
  return isValidMmxVoiceId(candidate) ? candidate : `ltvoice${Date.now().toString(36)}`;
}

// ---------------------------------------------------------------------------
// 样音约束(照抄 voiceLibraryLimits)
// ---------------------------------------------------------------------------

export const MMX_SAMPLE_MIN_SECONDS = 10;
export const MMX_SAMPLE_MAX_SECONDS = 300;
export const MMX_SAMPLE_MAX_BYTES = 20 * 1024 * 1024;
export const MMX_SAMPLE_EXTENSIONS = ["mp3", "m4a", "wav"] as const;

/**
 * 样音前置校验 —— 文档原文:
 * 「音频须为 MP3/M4A/WAV, 时长 10–300 秒(含边界), 文件严格小于 20 MiB」。
 *
 * 客户端必须自己拦: 这条链路一次 ⚡2.2, 拿一个参数错误换 2.2 太亏。
 * 返回 null 表示通过, 否则返回给用户看的中文原因。
 */
export function validateMmxSample(input: {
  /** 样音时长(秒); 读不到音频元数据时传 undefined, 只跳过时长校验。 */
  durationSeconds?: number;
  /** 文件字节数; 未知时传 undefined。 */
  bytes?: number;
  /** 文件扩展名或路径。 */
  fileName?: string;
}): string | null {
  const { durationSeconds, bytes, fileName } = input;
  const extension = (fileName ?? "")
    .trim()
    .toLowerCase()
    .match(/\.([a-z0-9]+)$/)?.[1];
  if (extension && !(MMX_SAMPLE_EXTENSIONS as readonly string[]).includes(extension)) {
    return `样音格式需为 ${MMX_SAMPLE_EXTENSIONS.join(" / ")}，当前是 .${extension}`;
  }
  if (typeof bytes === "number" && bytes > MMX_SAMPLE_MAX_BYTES) {
    return `样音文件需小于 20 MB，当前 ${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  if (typeof durationSeconds === "number" && Number.isFinite(durationSeconds)) {
    if (durationSeconds < MMX_SAMPLE_MIN_SECONDS || durationSeconds > MMX_SAMPLE_MAX_SECONDS) {
      return `样音时长需为 ${MMX_SAMPLE_MIN_SECONDS}-${MMX_SAMPLE_MAX_SECONDS} 秒，当前 ${Math.round(durationSeconds)} 秒`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 请求体(字段名照抄 param_schema)
// ---------------------------------------------------------------------------

export interface MmxVoiceCloneParams {
  /** 调用方自定义的新音色 ID。 */
  voiceId: string;
  /** 待复刻的人声样本: 「我方存储 URL 或 data:」。本地样音需先转成 data URL。 */
  sampleUrl: string;
  /**
   * 平台**不产出试听**(原文: 「当前克隆动作不产出试听; 保留仅为兼容旧调用, 不发厂商」)。
   * 传了也会被丢弃, 因此默认不写进请求体。
   */
  previewText?: string;
}

export interface MmxVoiceDesignParams {
  voiceId: string;
  /** 音色描述词, 如「低沉富有磁性的悬疑播音员」。 */
  prompt: string;
  /** 试听文本 —— 返回的音频即此文本用新音色念出。 */
  previewText: string;
}

export interface MmxSpeechParams {
  text: string;
  /** MMX 音色: 预设 id(如 `female-tianmei`)或用户克隆音色 ID。 */
  voice: string;
  version?: string;
  tier?: string;
  speed?: string;
  pitch?: string;
  emotion?: string;
  soundEffects?: string;
  /** 输出格式, 走 `response_format`(见 ttsBinaryResponseNote)。 */
  format?: string;
}

/** 请求体信封: 顶层扁平(与 OpenAI 兼容口径一致, 见文件头第 5 条)。 */
export function buildMmxVoiceCloneBody(params: MmxVoiceCloneParams): Record<string, unknown> {
  return {
    model: MMX_VOICE_CLONE_MODEL,
    voice_id: params.voiceId.trim(),
    sample_url: params.sampleUrl,
    // preview_text 平台明确「不发厂商」, 主动省略而不是发一个死字段。
  };
}

export function buildMmxVoiceDesignBody(params: MmxVoiceDesignParams): Record<string, unknown> {
  return {
    model: MMX_VOICE_DESIGN_MODEL,
    voice_id: params.voiceId.trim(),
    prompt: params.prompt.trim(),
    preview_text: params.previewText.trim(),
  };
}

export function buildMmxSpeechBody(params: MmxSpeechParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: MMX_SPEECH_MODEL,
    input: params.text,
    // speech-2.8 只吃 voice_id, 没有参考样音字段。
    voice: params.voice.trim(),
  };
  const version = normalizeMmxSpeechVersion(params.version);
  const tier = normalizeMmxSpeechTier(params.tier);
  const speed = normalizeMmxSpeechSpeed(params.speed);
  const pitch = normalizeMmxSpeechPitch(params.pitch);
  const emotion = normalizeMmxSpeechEmotion(params.emotion);
  const soundEffects = normalizeMmxSpeechSoundEffect(params.soundEffects);
  if (version !== MMX_DEFAULT_SPEECH_VERSION) body.version = version;
  if (tier !== MMX_DEFAULT_SPEECH_TIER) body.tier = tier;
  if (speed !== MMX_DEFAULT_SPEECH_SPEED) body.speed = speed;
  if (pitch !== MMX_DEFAULT_SPEECH_PITCH) body.pitch = pitch;
  if (emotion !== MMX_DEFAULT_SPEECH_EMOTION) body.emotion = emotion;
  if (soundEffects !== MMX_DEFAULT_SPEECH_SOUND_EFFECT) body.sound_effects = soundEffects;
  if (params.format?.trim()) body.response_format = params.format.trim().toLowerCase();
  return body;
}

// ---------------------------------------------------------------------------
// 响应解析
// ---------------------------------------------------------------------------

/**
 * 在任意嵌套的 JSON 里深度优先找出第一个满足 `predicate` 的字符串。
 *
 * 用返回值(而不是闭包里的标志位)承载结果 —— 闭包赋值会让 TS 的控制流分析
 * 在调用点把变量判定成恒定 null, 编译期就报错。
 */
function findStringInJson(payload: unknown, predicate: (key: string, text: string) => boolean): string | null {
  const stack: Array<{ key: string; value: unknown }> = [{ key: "", value: payload }];
  while (stack.length) {
    const current = stack.pop()!;
    if (current.value === null || typeof current.value !== "object") {
      if (typeof current.value === "string" && predicate(current.key, current.value)) {
        return current.value;
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      current.value.forEach((item) => stack.push({ key: current.key, value: item }));
      continue;
    }
    for (const [key, nested] of Object.entries(current.value as Record<string, unknown>)) {
      stack.push({ key, value: nested });
    }
  }
  return null;
}

/**
 * 从创建音色的响应里取 `voice_id`。
 *
 * 平台响应形状未经实跑确认(见文档第 8 节), 所以做**递归兼容提取**:
 * 顶层 `voice_id` / 嵌套 `data.voice_id` / `data.voice.id` 都能命中。
 * 取不到时返回 null, 由调用方回退到自己生成的那个 id(幂等, 不会二次收费)。
 */
export function extractMmxVoiceId(payload: unknown): string | null {
  return (
    findStringInJson(payload, (key, text) => {
      const normalizedKey = key.toLowerCase().replace(/[^a-z]/g, "");
      return normalizedKey === "voiceid" && text.trim().length > 0;
    })?.trim() ?? null
  );
}

/** 音频响应若是 JSON, 从中取出可播放地址(URL 或 data URL)。 */
export function extractMmxAudioSource(payload: unknown): string | null {
  const dataAudio = findStringInJson(payload, (_key, text) => /^data:audio\/[a-z0-9.+-]+;base64,/i.test(text.trim()));
  if (dataAudio) return dataAudio.trim();
  const remote = findStringInJson(payload, (key, text) => {
    if (!/^https?:\/\//i.test(text.trim())) return false;
    return /(url|audio|result|output|file|path|src|link)/.test(key.toLowerCase());
  });
  return remote?.trim() ?? null;
}

/** 平台错误体的 message(形如 `{"error":{"code":..,"message":..}}`)。 */
export function extractMmxErrorMessage(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const payload = JSON.parse(trimmed) as { error?: unknown; message?: unknown };
    const error = payload?.error;
    if (error && typeof error === "object") {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message.trim();
    }
    if (typeof payload?.message === "string" && payload.message.trim()) return payload.message.trim();
  } catch {
    return null;
  }
  return null;
}
