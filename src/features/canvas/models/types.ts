import type { ModelPricingDefinition } from "@/features/canvas/pricing/types";
import type { AudioModelFamily } from "./audioFamilies";
import type { AudioVoiceCatalog } from "./audioVoices";

export type MediaModelType = "image" | "video" | "audio";

export interface ModelProviderDefinition {
  id: string;
  name: string;
  label: string;
}

export interface AspectRatioOption {
  value: string;
  label: string;
}

export interface ResolutionOption {
  value: string;
  label: string;
}

export interface ImageModelRuntimeContext {
  extraParams?: Record<string, unknown>;
}

export type ExtraParamType = "boolean" | "enum" | "number" | "string";

export interface ExtraParamDefinition {
  key: string;
  label: string;
  labelKey?: string;
  type: ExtraParamType;
  description?: string;
  descriptionKey?: string;
  defaultValue?: boolean | number | string;
  options?: Array<{ value: string; label: string; labelKey?: string }>;
  min?: number;
  max?: number;
  step?: number;
}

export interface ImageModelDefinition {
  id: string;
  mediaType: "image";
  displayName: string;
  providerId: string;
  description: string;
  eta: string;
  expectedDurationMs?: number;
  defaultAspectRatio: string;
  defaultResolution: string;
  aspectRatios: AspectRatioOption[];
  resolutions: ResolutionOption[];
  resolveResolutions?: (context: ImageModelRuntimeContext) => ResolutionOption[];
  /**
   * 节点上「生成张数」的一个档位实际产出多少张。
   *
   * 缺省 1（一档一张，绝大多数模型）。Midjourney 是 4 —— 上游一次任务恒出 4 张，
   * `count` 只能按「组」翻倍，见 `models/midjourney.ts` 的实测记录。
   * 节点里存的 `imageCount` 仍然是档位（1~4），换算只发生在展示与请求两处。
   */
  imagesPerCountUnit?: number;
  /**
   * 「生成张数」最多能选到第几档（缺省 4，即全局上限）。
   *
   * 用于**张数被平台钉死**的模型：MJ 8.2 的 `--count` 声明 required 且 min==max==4，
   * 传 8 会被服务端拒。这种情况下档位只能选 1（一档 = 4 张），多给控件只会让用户
   * 选出一个必然失败的组合。
   */
  maxImageCountUnits?: number;
  /**
   * `--prompt` 的字符上限（由平台目录声明，缺省不限制）。
   *
   * 各模型差得很远（实测 MJ 8.2 只有 1024，seedream 4.x 2000，5.x 5000，
   * GPT Image 系 7000）。超了服务端回 `service.2 / params.prompt`，所以在节点上
   * 先把字数标出来、在提交前拦住。
   */
  maxPromptLength?: number;
  /**
   * 单次最多可带几张参考图（`undefined` = 平台未声明）。
   *
   * 图片模型的上限差别很大（实测 4 / 6 / 10 / 14 / 16 / 20），超量会被服务端拒。
   */
  maxReferenceImages?: number;
  /**
   * 报价是否随「生成张数」变化（按张计费的平台 / 即梦画布 CLI）。
   *
   * 缺省 false：绝大多数平台的 `prices` 是按次的，跟张数无关，把 count 传进定价
   * 上下文反而可能被下游误读。**按张计费**的模型必须置 true，否则节点上选 4 张
   * 只显示 1 张的价，与实际扣分对不上。
   */
  countAffectsPricing?: boolean;
  extraParamsSchema?: ExtraParamDefinition[];
  defaultExtraParams?: Record<string, unknown>;
  pricing?: ModelPricingDefinition;
  resolveRequest: (context: { referenceImageCount: number }) => {
    requestModel: string;
    modeLabel: string;
  };
}

export interface VideoModelDefinition {
  id: string;
  mediaType: "video";
  displayName: string;
  providerId: string;
  description: string;
  expectedDurationMs?: number;
  aspectRatios: AspectRatioOption[];
  defaultAspectRatio: string;
  durationOptions: number[];
  defaultDuration: number;
  /** 仅在供应商公开了视频分辨率约束时显示。 */
  resolutions?: ResolutionOption[];
  defaultResolution?: string;
  /**
   * 单次最多可带几张参考图。`undefined` = 平台未声明上限。
   *
   * 节点据此显示「已选 N / 上限」并在提交时截断 —— 有的模型(如 muse-video 只收 4 张)
   * 超量会直接报错, 而不是静默忽略。
   */
  maxReferenceImages?: number;
  /**
   * 单次最多可带几段参考视频。`undefined` = 平台未声明上限（由协议档案判定）。
   *
   * 平台目录声明的额度优先于 `videoReferenceSupport` 里按协议登记的默认值：
   * 即梦画布 CLI 同一个协议下 `seedance_2.5_flash` 收 5 段、`seedance_pro_fast` 一段都不收，
   * 只看协议会把两者判成一样。
   */
  maxReferenceVideos?: number;
  pricing?: ModelPricingDefinition;
  profileId?: string;
  profileStatus?: "verified" | "pending-adaptation";
  profileLabel?: string;
  profileUnavailableReason?: string;
}

/** 音频生成类型: 语音合成 / 音效 / 音乐(对应平台三个端点)。 */
export type AudioModelKind = "speech" | "sound-effects" | "music";

/** 音频节点顶部的三个创作面板(声音克隆 / 文字转语音 / 音乐创作)。 */
export type AudioCreativePanel = "voice-clone" | "voice-design" | "speech" | "music";

/**
 * 语音创作的操作语义 —— 决定**请求体怎么构造**, 与端点无关。
 *
 * 知鸟 AI 的 MiniMax 语音链路(voice-clone / voice-design / speech-2.8)三项都打同一个
 * `/v1/audio/speech`, 靠 `model` 分流; 所以「端点类型」(audioKind) 说明不了要发什么 body,
 * 必须再带一个 operation。两者分开以后:
 *   - `voice-clone` / `voice-design` → 创建音色资产, 产出 voice_id, 按次一次性计费;
 *   - `speech` → 消费 voice_id 做合成, 按字符计费。
 * 详见 docs/api_docs/ZhiniaoAI_MiniMax_Voice_Chain.md
 */
export type AudioModelOperation = "speech" | "voice-clone" | "voice-design" | "sound-effects" | "music";

export interface AudioModelDefinition {
  id: string;
  mediaType: "audio";
  displayName: string;
  providerId: string;
  description: string;
  expectedDurationMs?: number;
  /** 端点类型(决定提交路径与请求体字段)。 */
  audioKind: AudioModelKind;
  /**
   * 操作语义(决定请求体构造器)。缺省时按 audioKind 兜底。
   * 语音链路里「打同一个端点、发不同 body」的三个能力靠它区分。
   */
  operation?: AudioModelOperation;
  /**
   * 模型家族 —— 节点右上角的选择维度, 也决定主体渲染哪套 UI。
   * 由模型名推出(见 audioFamilies.ts), 不走 id 解析。
   */
  family?: AudioModelFamily;
  /** 音色候选(语音合成); 平台可选项时留空。 */
  voiceOptions?: string[];
  defaultVoice?: string;
  /**
   * 音色目录 —— 每个模型的预置音色数量/名字/风格都不一样(GM 系列 30 种、GT 系列 6 种),
   * 不能再让所有模型共用一份写死的 6 音色。见 audioVoices.ts。
   * `voiceOptions` 是它的扁平投影(兼容既有消费方), 这个字段额外带着风格说明、
   * 真实输出格式与「是否支持自然语言风格指令」。
   */
  voiceCatalog?: AudioVoiceCatalog;
  /** 模型是否声明支持参考样音克隆。未声明的模型仍可手工透传，但会显示兼容性提示。 */
  supportsVoiceClone?: boolean;
  /** 模型是否支持以 emotion / emotion_intensity 控制情绪。 */
  supportsEmotion?: boolean;
  /** 输出格式候选(语音合成)。 */
  formatOptions?: string[];
  defaultFormat?: string;
  /**
   * 音乐时长候选(毫秒) —— **字子动画的字段**。
   *
   * 知鸟的 Suno `music` **没有** `music_length_ms`（曲长由模型决定），
   * 它的模型不该拿到这个字段，见下面的 `musicProtocol`。
   */
  musicLengthOptionsMs?: number[];
  defaultMusicLengthMs?: number;
  /**
   * 音乐链路协议 —— 决定音乐页渲染哪套 UI。
   *
   *   - `suno`    知鸟的 `music`：8 种 operation + version/mode/style/title/vocal_gender/negative_tags，
   *               走统一入口 `/api/v1/model-runtime/invoke` 异步轮询。字段表见 `@/commands/sunoMusic`。
   *   - `generic` 其余平台(字子动画 `music-2.6` 等)：只有歌词 + 时长，同步返回二进制。
   *
   * 判定复用 `isSunoMusicModel`，与链路层的分流**同源**，避免 UI 显示 A 协议、
   * 请求发 B 协议。
   */
  musicProtocol?: "suno" | "mureka" | "generic";
  /** RunningHub/Suno 端点实际支持的操作子集。缺省表示使用完整 Suno 页面。 */
  sunoSupportedOperations?: string[];
  /** 特定端点需填写的服务端音色/演讲人 ID 列表。 */
  endpointVoiceOptions?: string[];
  /** 豆包 TTS 的额外平台参数表单类型。 */
  audioUiProtocol?: "doubao-tts";
  pricing?: ModelPricingDefinition;
}
