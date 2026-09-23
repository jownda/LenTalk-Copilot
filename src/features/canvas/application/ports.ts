import type { XYPosition } from "@xyflow/react";

import type {
  CanvasEdge,
  CanvasNode,
  CanvasNodeData,
  CanvasNodeType,
  NodeToolType,
  StoryboardFrameItem,
} from "../domain/canvasNodes";
import type { CanvasNodeDefinition } from "../domain/nodeRegistry";

export interface IdGenerator {
  next: () => string;
}

export interface NodeCatalog {
  getDefinition: (type: CanvasNodeType) => CanvasNodeDefinition;
  getMenuDefinitions: () => CanvasNodeDefinition[];
}

export interface NodeFactory {
  createNode: (
    type: CanvasNodeType,
    position: XYPosition,
    data?: Partial<CanvasNodeData>,
    /** 显式初始尺寸；省略则用节点类型注册的 defaultSize。 */
    size?: { width: number; height: number },
  ) => CanvasNode;
}

export interface GraphImageResolver {
  collectInputImages: (nodeId: string, nodes: CanvasNode[], edges: CanvasEdge[]) => string[];
  collectInputAudio: (nodeId: string, nodes: CanvasNode[], edges: CanvasEdge[]) => string[];
  collectInputVideos: (nodeId: string, nodes: CanvasNode[], edges: CanvasEdge[]) => string[];
  collectInputText: (nodeId: string, nodes: CanvasNode[], edges: CanvasEdge[]) => string[];
}

export interface GenerateImagePayload {
  prompt: string;
  /** 负向提示词(透传到上游 extra_params) */
  negativePrompt?: string;
  model: string;
  size: string;
  aspectRatio: string;
  /** 请求的输出图片数量；供应商不支持时由其按自身能力处理。 */
  imageCount?: number;
  referenceImages?: string[];
  extraParams?: Record<string, unknown>;
}

export interface GenerateVideoPayload {
  clientJobId?: string;
  prompt: string;
  model: string;
  duration: number;
  aspectRatio: string;
  videoResolution?: string;
  imageMode?: "reference" | "first-last";
  referenceImages?: string[];
  referenceAudio?: string[];
  extraParams?: Record<string, unknown>;
}

export interface UpscaleVideoPayload {
  /** 超分源：公网 URL 或本地路径 */
  videoSource: string;
  model: string;
  tier?: string;
  bitRate?: number | string;
  extraParams?: Record<string, unknown>;
}
export type GenerateAudioKind = "speech" | "sound-effects" | "music";

/**
 * 知鸟 Suno 的音乐参数。
 *
 * 与 `@/commands/sunoMusic` 的 `SunoMusicBodyInput` 同构（prompt 走外层），
 * 值域与默认值一律由那个模块收窄，这里只做搬运。
 */
export interface SunoMusicPayload {
  /** generate / extend / cover / lyrics / stems / stems_all / mp4 / concat */
  operation?: string;
  version?: string;
  mode?: string;
  /** 风格标签（映射 Suno tags）。 */
  style?: string;
  /** 歌曲标题。 */
  title?: string;
  /** 演唱声线 auto / m / f，仅 song 模式有效。 */
  vocalGender?: string;
  /** 排除风格（映射 negative_tags）。 */
  negativeTags?: string;
  /** stems / stems_all / mp4 / concat 的源 clip。 */
  clipId?: string;
  /** extend 的源 clip。 */
  continueClipId?: string;
  /** extend 的续写起点秒。 */
  continueAt?: string;
  /** cover 的源 clip。 */
  coverClipId?: string;
}

export interface GenerateAudioPayload {
  prompt: string;
  model: string;
  /** 音频类型; 缺省由适配层按模型名推断 */
  audioKind?: GenerateAudioKind;
  /** 音色(语音合成) */
  voice?: string;
  /** 声音克隆参考样音：本地持久化路径或 URL。 */
  referenceAudio?: string;
  /** IndexTTS2/RH 工作流第二段语气参考样音。 */
  indexTtsSecondReferenceAudio?: string;
  /** 情绪控制。 */
  emotion?: string;
  /** 情绪强度，范围 0-100。 */
  emotionIntensity?: number;
  /** 自然语言风格指令(GM 系列 / GT-4o Mini TTS 独有), 与 emotion 是两条通路。 */
  instructions?: string;
  /** 语速(平台声明 0.25-4.0)。 */
  speed?: string;
  /** 输出格式(语音合成), 默认 mp3 */
  format?: string;
  /** 音效时长(秒) */
  durationSeconds?: number;
  /** 音乐时长(毫秒)。字子动画的字段; **知鸟 Suno 没有这个字段**, 曲长由模型决定。 */
  musicLengthMs?: number;
  /** 歌词(音乐生成) */
  lyrics?: string;
  /**
   * 知鸟 Suno(`music` 模型)专有参数。
   *
   * 与上面的 `musicLengthMs` 并存的理由: 那是字子动画的协议
   * (`metadata{lyrics_text, music_length_ms}`), Suno 是**顶层扁平字段** +
   * 8 种 operation 的完全另一套, 由 `@/commands/sunoMusic` 承担。
   * 两套协议靠平台标记分流(见 `generateAudio` 的分发顺序)。
   */
  suno?: SunoMusicPayload;
  /** MiniMax 音色 ID(合成时引用音色库里的音色)。 */
  voiceId?: string;
  /**
   * MiniMax speech-2.8 专有参数。
   *
   * 与上面的 `emotion` 分开: 通用 emotion 的取值域是 `natural/calm/happy/...`,
   * 而平台 speech-2.8 只认 `auto/happy/sad/angry/fearful/surprised/calm`, 混用会发出平台不认的值。
   */
  mmxParams?: {
    version?: string;
    tier?: string;
    speed?: string;
    pitch?: string;
    emotion?: string;
    soundEffects?: string;
  };
  extraParams?: Record<string, unknown>;
}

/**
 * 创建音色资产(voice-clone / voice-design)的载荷。
 *
 * 这两个能力**不产出音频**, 所以不能复用 `generateAudio` 的返回类型 ——
 * 它们返回的是 `voice_id`(可能带一段试听音频)。
 */
export interface GenerateAudioAssetPayload {
  model: string;
  /** 音色描述词(voice-design 必填)。 */
  prompt: string;
  /** 调用方自带的音色 ID。平台按它幂等, 必须先在音色库落库再发请求。 */
  voiceId: string;
  /** 音色克隆的参考样音(voice-clone 必填)。 */
  sampleAudio?: string;
  /** 音色设计的试听文本(voice-design 必填)。 */
  previewText?: string;
  format?: string;
  extraParams?: Record<string, unknown>;
}

export interface GenerateAudioAssetResultPayload {
  voiceId: string;
  previewAudio?: string;
}

/**
 * `operation=lyrics` 的载荷 —— 按主题生成歌词**文本**。
 *
 * 单独一个入口而不是塞进 `generateAudio`: 后者返回的是媒体路径, 而它返回文本。
 * 混在一起会让「生成音频」按钮在写词页上发一个产出完全不同的请求。
 */
export interface GenerateAudioLyricsPayload {
  /** 歌曲主题 / 描述（必填）。 */
  prompt: string;
  model: string;
  extraParams?: Record<string, unknown>;
}

export type VideoReferenceSourceKind = "public-url" | "data-url" | "local-file" | "platform-file";

export interface VideoReferenceResource {
  source: string;
  sourceKind: VideoReferenceSourceKind;
}

/**
 * 视频节点提交给适配层的统一任务。供应商专用字段只能由模型 profile 生成，
 * 节点层不再决定 endpoint、images、size 或首尾帧字段名。
 */
export interface VideoGenerationRequest {
  clientJobId?: string;
  modelId: string;
  prompt: string;
  duration: number;
  aspectRatio: string;
  videoResolution?: string;
  referenceImages: VideoReferenceResource[];
  referenceAudio: VideoReferenceResource[];
  firstFrame?: VideoReferenceResource;
  lastFrame?: VideoReferenceResource;
}

export interface AiGateway {
  setApiKey: (provider: string, apiKey: string) => Promise<void>;
  generateImage: (payload: GenerateImagePayload) => Promise<string>;
  submitGenerateImageJob: (payload: GenerateImagePayload) => Promise<string>;
  getGenerateImageJob: (jobId: string) => Promise<{
    job_id: string;
    status: "queued" | "running" | "succeeded" | "failed" | "not_found";
    result?: string | null;
    error?: string | null;
  }>;
  submitGenerateVideoJob: (payload: GenerateVideoPayload) => Promise<string>;
  getGenerateVideoJob: (jobId: string) => Promise<{
    job_id: string;
    status: string;
    result: string | null;
    error: string | null;
    /** 后端声明: 本次 `error` 只是诊断文本(网络抖动 / 5xx), 任务仍在平台侧生成。 */
    transient?: boolean;
  }>;
  generateVideo: (payload: GenerateVideoPayload) => Promise<string>;
  /** 视频超分：本地视频先上传换 URL，提交后轮询取片。 */
  upscaleVideo: (payload: UpscaleVideoPayload) => Promise<string>;
  generateAudio: (payload: GenerateAudioPayload) => Promise<string>;
  /** 创建音色资产(音色克隆 / 音色设计)。产出 voice_id, 不是音频。 */
  generateAudioAsset: (payload: GenerateAudioAssetPayload) => Promise<GenerateAudioAssetResultPayload>;
  /** 按主题生成歌词文本(知鸟 Suno `operation=lyrics`)。产出文本, 不是音频。 */
  generateAudioLyrics: (payload: GenerateAudioLyricsPayload) => Promise<string>;
}

export interface ImageSplitGateway {
  split: (
    imageSource: string,
    rows: number,
    cols: number,
    lineThickness: number,
    colFractions?: number[],
    rowFractions?: number[],
  ) => Promise<string[]>;
}

export interface ToolProcessorResult {
  outputImageUrl?: string;
  storyboardFrames?: StoryboardFrameItem[];
  rows?: number;
  cols?: number;
  frameAspectRatio?: string;
}

export interface ToolProcessor {
  process: (
    toolType: NodeToolType,
    sourceImageUrl: string,
    options: Record<string, unknown>,
  ) => Promise<ToolProcessorResult>;
}

export interface CanvasEventMap {
  "tool-dialog/open": {
    nodeId: string;
    toolType: NodeToolType;
  };
  "tool-dialog/close": undefined;
  "upload-node/reupload": {
    nodeId: string;
  };
  "media-node/capture-frame": {
    nodeId: string;
  };
  "upload-node/paste-image": {
    nodeId: string;
    file: File;
  };
  "upload-node/convert-media": {
    nodeId: string;
    file: File;
    mediaType: "video" | "audio";
  };
  "group-node/rename": {
    nodeId: string;
  };
}

export interface CanvasEventBus {
  publish: <TType extends keyof CanvasEventMap>(type: TType, payload: CanvasEventMap[TType]) => void;
  subscribe: <TType extends keyof CanvasEventMap>(
    type: TType,
    handler: (payload: CanvasEventMap[TType]) => void,
  ) => () => void;
}
