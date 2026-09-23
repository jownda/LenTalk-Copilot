import type { Edge, Node, XYPosition } from "@xyflow/react";
import type { SceneStaging } from "@/features/cinematicStudio/shared-types";

export const CANVAS_NODE_TYPES = {
  upload: "uploadNode",
  imageEdit: "imageNode",
  videoGen: "videoGenNode",
  exportImage: "exportImageNode",
  textAnnotation: "textAnnotationNode",
  group: "groupNode",
  storyboardSplit: "storyboardNode",
  storyboardGen: "storyboardGenNode",
  panorama: "panoramaNode",
  directorDesk: "directorDeskNode",
  cinematicStudio: "cinematicStudioNode",
  audio: "audioNode",
  audioGen: "audioGenNode",
  motionControl: "motionControlNode",
  promptOptimizer: "promptOptimizerNode",
  seamlessMosaic: "seamlessMosaicNode",
} as const;

export type CanvasNodeType = (typeof CANVAS_NODE_TYPES)[keyof typeof CANVAS_NODE_TYPES];

export const DEFAULT_ASPECT_RATIO = "1:1";
export const AUTO_REQUEST_ASPECT_RATIO = "auto";
export const DEFAULT_NODE_WIDTH = 220;
// AI 结果节点默认采用紧凑尺寸，避免连续生成时快速占满画布。
export const EXPORT_RESULT_NODE_DEFAULT_WIDTH = 192;
export const EXPORT_RESULT_NODE_LAYOUT_HEIGHT = 144;
export const EXPORT_RESULT_NODE_MIN_WIDTH = 96;
export const EXPORT_RESULT_NODE_MIN_HEIGHT = 96;
/** AI 图片节点允许一次请求的输出数量。 */
export const IMAGE_GENERATION_COUNT_MIN = 1;
export const IMAGE_GENERATION_COUNT_MAX = 4;

export const IMAGE_SIZES = ["0.5K", "1K", "2K", "4K"] as const;
export const IMAGE_ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "21:9"] as const;

export type ImageSize = (typeof IMAGE_SIZES)[number];

export interface NodeDisplayData {
  displayName?: string;
  /** 用户在 AI 图片/视频节点上手动覆盖的价格显示文本。 */
  customPrice?: string | null;
  [key: string]: unknown;
}

export interface NodeImageData extends NodeDisplayData {
  imageUrl: string | null;
  previewImageUrl?: string | null;
  aspectRatio: string;
  isSizeManuallyAdjusted?: boolean;
  /** AI 生成完成后保留结果, 撤销时不会恢复为生成中或删除结果。 */
  generationResultProtected?: boolean;
  [key: string]: unknown;
}

export interface UploadImageNodeData extends NodeImageData {
  sourceFileName?: string | null;
}

export type ExportImageNodeResultKind =
  "generic" | "storyboardGenOutput" | "storyboardSplitExport" | "storyboardFrameEdit";

/** Persisted input needed to recover a generation after an app restart. */
export interface ImageGenerationRequestData {
  kind: "image";
  prompt: string;
  negativePrompt?: string;
  model: string;
  size: string;
  aspectRatio: string;
  /** 一次请求期望的输出图片数量；旧项目缺省为 1。 */
  imageCount?: number;
  referenceImages?: string[];
  extraParams?: Record<string, unknown>;
}

export interface VideoGenerationRequestData {
  kind: "video";
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

/** 音频生成请求快照(语音合成 / 音效 / 音乐)。 */
export interface AudioGenerationRequestData {
  kind: "audio";
  clientJobId?: string;
  prompt: string;
  model: string;
  audioKind: "speech" | "sound-effects" | "music";
  /** 节点中的创作面板，用于恢复用户当时的工作区。 */
  creativeMode?: "voice-clone" | "speech" | "music";
  voice?: string;
  /** 已保存音色档案 ID（生成时保留快照，便于复盘）。 */
  voiceProfileId?: string;
  /** 声音克隆的参考样音：本地持久化路径或可访问 URL。 */
  referenceAudio?: string;
  /** IndexTTS2.5/RH 工作流第二段情感参考样音。 */
  indexTtsSecondReferenceAudio?: string;
  /** IndexTTS2.5 可合成的语言（ZH / EN / JA / ES / AR）。 */
  indexTtsLanguage?: string;
  /** IndexTTS 工作流：双样音情感参考，或多音字手工标注。 */
  indexTtsMode?: "emotion-reference" | "polyphone";
  /** IndexTTS 多音字工作流的手工读音表，每行一条，如 `银行|YIN2 HANG2|ZH`。 */
  indexTtsPronunciation?: string;
  /** 情绪控制（由支持该字段的模型消费）。 */
  emotion?: string;
  /** 情绪强度，范围 0-100。 */
  emotionIntensity?: number;
  format?: string;
  durationSeconds?: number;
  musicLengthMs?: number;
  lyrics?: string;
  /** 生成时透传给适配层的供应商扩展参数快照。 */
  extraParams?: Record<string, unknown>;
}

export type PersistedGenerationRequest =
  ImageGenerationRequestData | VideoGenerationRequestData | AudioGenerationRequestData;

export interface ExportImageNodeData extends NodeImageData {
  resultKind?: ExportImageNodeResultKind;
  generationRequest?: ImageGenerationRequestData;
}

export interface GroupNodeData extends NodeDisplayData {
  label: string;
  [key: string]: unknown;
}

export interface TextAnnotationNodeData extends NodeDisplayData {
  content: string;
  [key: string]: unknown;
}

export type PromptOptimizerTaskType = "auto" | "character" | "location" | "prop" | "edit" | "texture" | "viewChange";

export interface PromptOptimizerNodeData extends NodeDisplayData {
  purpose: string;
  taskType?: PromptOptimizerTaskType;
  targetModel?: string;
  referencePalette?: string;
  optimizedPrompt?: string;
  routeSummary?: string;
  notes?: string[];
  /** 最近一次优化的执行模式：local=本地规则, ai=AI 增强, ai-fallback=AI 失败已回退。 */
  enhanceMode?: "local" | "ai" | "ai-fallback";
  /** Chat 模型选择(来自设置中 providers 的 chatModels)。 */
  chatProviderId?: string;
  chatModel?: string;
  /** 输出语言：zh=中文, en=English。 */
  outputLang?: "zh" | "en";
  [key: string]: unknown;
}

export interface ImageEditNodeData extends NodeImageData {
  prompt: string;
  /** 负向提示词(对齐 Infinite Canvas 的 negative prompt) */
  negativePrompt?: string;
  model: string;
  size: ImageSize;
  requestAspectRatio?: string;
  /** 一次生成的图片数量；结果会拆成多个结果图片节点。 */
  imageCount?: number;
  extraParams?: Record<string, unknown>;
  isGenerating?: boolean;
  generationStartedAt?: number | null;
  /** 后端异步任务 ID。视频与图片结果节点共用同一状态语义。 */
  generationJobId?: string | null;
  generationDurationMs?: number;
}

export interface VideoGenNodeData extends NodeDisplayData {
  prompt: string;
  model: string;
  duration: number;
  aspectRatio: string;
  resolution?: string;
  imageMode?: "reference" | "first-last";
  firstFrameImageUrl?: string | null;
  firstFramePreviewImageUrl?: string | null;
  lastFrameImageUrl?: string | null;
  lastFramePreviewImageUrl?: string | null;
  /** 工作室“发送到视频节点”时随节点快照保存，避免宿主状态防抖期间丢失附件。 */
  studioReferenceImages?: string[];
  studioReferenceAudio?: string[];
  /**
   * 用户在本节点手动移除的引用素材来源。
   *
   * 引用有两个入口: 节点自身的 studioReference*，以及上游连进来的提示词工作室/
   * 素材节点的媒体。只清空 studioReference* 时，上游那份仍会通过
   * graphImageResolver 流回来并上传给模型，所以被删掉的来源要单独记账。
   */
  excludedReferenceSources?: string[];
  /** 炳火专用: 视频参考 URLs(公开 http/https), 提交时先调 /v1/assets/uploads 换 OSS 再传 reference_videos。最多 3 个。 */
  binghuoReferenceVideos?: string[];
  /** 炳火专用: 跳过真人审核(责任声明, 手册 3.8)。仅 bh 系(bh2.0-*, bh2.04K)生效。 */
  binghuoSkipReview?: boolean;
  /** 当前视频节点发起的下游媒体任务；任务终态前禁止再次提交。 */
  activeGenerationNodeId?: string | null;
}

export interface StoryboardFrameItem {
  id: string;
  imageUrl: string | null;
  previewImageUrl?: string | null;
  aspectRatio?: string;
  note: string;
  order: number;
}

export interface StoryboardExportOptions {
  showFrameIndex: boolean;
  showFrameNote: boolean;
  notePlacement: "overlay" | "bottom";
  imageFit: "cover" | "contain";
  frameIndexPrefix: string;
  cellGap: number;
  outerPadding: number;
  fontSize: number;
  backgroundColor: string;
  textColor: string;
}

export interface StoryboardSplitNodeData {
  displayName?: string;
  aspectRatio: string;
  frameAspectRatio?: string;
  gridRows: number;
  gridCols: number;
  frames: StoryboardFrameItem[];
  exportOptions?: StoryboardExportOptions;
  [key: string]: unknown;
}

export interface StoryboardGenFrameItem {
  id: string;
  description: string;
  referenceIndex: number | null;
}

export type StoryboardRatioControlMode = "overall" | "cell";

export interface StoryboardGenNodeData {
  displayName?: string;
  gridRows: number;
  gridCols: number;
  frames: StoryboardGenFrameItem[];
  ratioControlMode?: StoryboardRatioControlMode;
  model: string;
  size: ImageSize;
  requestAspectRatio: string;
  extraParams?: Record<string, unknown>;
  imageUrl: string | null;
  previewImageUrl?: string | null;
  aspectRatio: string;
  isGenerating?: boolean;
  generationStartedAt?: number | null;
  generationDurationMs?: number;
  [key: string]: unknown;
}

export type PanoramaOutputAspect = "16:9" | "1:1" | "9:16" | "21:9" | "4:3";

export interface PanoramaNodeData extends NodeImageData {
  inputImageUrl: string | null;
  previewInputImageUrl?: string | null;
  yaw: number;
  pitch: number;
  fov: number;
  outputAspect: PanoramaOutputAspect;
  outputImageUrl: string | null;
  outputPreviewImageUrl?: string | null;
  isFraming?: boolean;
  [key: string]: unknown;
}

export interface DirectorDeskNodeData extends NodeDisplayData {
  /** 最近一次截图(原图),用于节点缩略图展示 */
  lastCaptureUrl?: string | null;
  lastCapturePreviewUrl?: string | null;
  lastCaptureAspectRatio?: string;
  [key: string]: unknown;
}

/** Prompt Studio 节点：双击进入独立提示词工作台。 */
export interface CinematicStudioNodeData extends NodeDisplayData {
  /** 本节点独占的工作室工程 id（每个节点一份独立工程，新建即空白模板） */
  studioProjectId?: string | null;
  /** 最近一次保存的工程标题(仅用于节点预览) */
  lastProjectTitle?: string | null;
  /** 最近一次保存的工程简介(仅用于节点预览) */
  lastProjectDescription?: string | null;
  /** 最近一次编译的提示词摘要(仅用于节点预览) */
  lastPromptPreview?: string | null;
  /** 工作室当前提示词对应的附件；下游视频节点通过连线接收。 */
  studioReferenceImages?: string[];
  studioReferenceAudio?: string[];
  /** 极简模式：风格与故事仅属于当前节点，不会写入高级工作室工程。 */
  quickStyle?: string;
  quickSynopsis?: string;
  /** 极简模式专用的 Chat 模型选择；不改动全局/高级工作台设置。 */
  quickChatProvider?: string;
  quickChatModel?: string;
  /** 首次由简化节点编辑或高级编辑回传后启用双向字段同步。 */
  quickSyncInitialized?: boolean;
  /** 高级编辑器中与极简节点双向同步的场景 id。 */
  quickStudioSceneId?: string;
  /**
   * 极简模式与高级编辑器共用的场景站位结构：地点、角色候选/左右顺序、
   * 站位参考图、轴线、间距和空间锚点都以同一套语义保存。
   */
  quickStaging?: SceneStaging;
  /**
   * 旧版极简节点的多选素材字段，仅用于兼容已保存的画布。
   * 新节点一律写入 quickStaging。
   */
  quickSceneAssetIds?: string[];
  quickCharacterAssetIds?: string[];
  /** 极简模式独立链路最后一次生成的完整提示词与图片引用。 */
  quickPrompt?: string | null;
  quickReferenceImages?: string[];
  /**
   * 极简链路生成提示词的输出语言。未设置（undefined）表示「跟随画布语言」，
   * 用户在节点上点过中/英切换后才会固定下来，此后不再随画布语言漂移。
   */
  quickPromptLang?: "zh" | "en";
  /**
   * 「生成并创建视频」的进行中标记(时间戳 + 运行时会话 id)。
   * 画布开了 onlyRenderVisibleElements, 节点移出视口会被卸载、局部 state 丢失,
   * 按钮就会谎报空闲; 靠这两个字段把「生成中…」恢复回来, 并保证上一次运行的
   * 残留标记不会锁住按钮(会话 id 不匹配即视为已结束)。
   */
  quickGenerationStartedAt?: number | null;
  quickGenerationSessionId?: string | null;
  /** 图片提示词优化区：与视频提示词工作流分开保存。 */
  imagePromptDraft?: string;
  imagePromptResult?: string;
  [key: string]: unknown;
}

/** 无缝拼图:画布坐标系内的单个图层(裁剪/位移/缩放后叠加) */
export interface MosaicLayerItem {
  id: string;
  /** 源图(已持久化路径或 URL) */
  imageUrl: string;
  previewImageUrl?: string | null;
  /** 导入时的文件名，仅用于图层面板显示 */
  sourceName?: string;
  aspectRatio?: string;
  /** 画布坐标(x/y 相对画布左上角, 像素) */
  x: number;
  y: number;
  /** 画布上的显示尺寸(像素) */
  width: number;
  height: number;
  /** 源图裁剪矩形(0-1 归一化相对源图, 缺省为整图) */
  crop?: { x: number; y: number; width: number; height: number } | null;
  /** 图层可见性 */
  visible: boolean;
  /** 图层顺序: 越大越靠上(叠加顺序) */
  order: number;
  opacity?: number;
}

export type MosaicTemplateId = "grid" | "h-strip" | "v-strip" | "free";

export interface SeamlessMosaicNodeData extends NodeImageData {
  /** 图层列表(按 order 升序 = 底层到顶层) */
  layers: MosaicLayerItem[];
  template: MosaicTemplateId;
  /** 输出画布尺寸(像素) */
  canvasWidth: number;
  canvasHeight: number;
  gridCols?: number;
  gridRows?: number;
  gap?: number;
  backgroundColor?: string;
  /** 已自动导入的上游图片 URL 集合(去重, 避免重复导入) */
  importedSourceKeys?: string[];
  /** 最后一次导出的合并图(可选, 作为节点缩略图) */
  outputImageUrl?: string | null;
  outputPreviewImageUrl?: string | null;
}

/** 媒体节点(音频/视频共用, 素材库拖入或本地上传转换后插入画布) */
export interface AudioNodeData extends NodeDisplayData {
  /** 媒体源文件路径/URL */
  sourcePath: string | null;
  /** 可选封面图 */
  previewImageUrl?: string | null;
  aspectRatio?: string;
  /** 媒体类型: audio | video */
  mediaType?: "audio" | "video";
  /** 下游生成中状态(AI 视频节点生成时写入) */
  isGenerating?: boolean;
  generationStartedAt?: number | null;
  generationDurationMs?: number;
  /** 生成失败信息(显示在节点上) */
  generationError?: string | null;
  generationErrorDetails?: string | null;
  generationProviderId?: string | null;
  generationModel?: string | null;
  providerBaseUrl?: string | null;
  /** AI 生成完成后保留结果, 撤销时不会恢复为生成中或删除结果。 */
  generationResultProtected?: boolean;
  generationRequest?: PersistedGenerationRequest;
  /**
   * 该结果的 **Suno clip 标识**(知鸟音乐链路)。
   *
   * 后处理操作(续写/翻唱/分离/拼接)要拿上次结果的 clip 当源, 但生成接口只返回媒体路径,
   * 所以由 `@/commands/ai` 的内存表带回、写在这里, 下游音乐节点从连线里选它。
   *
   * 注意与 `AudioGenNodeData.sunoClipId` 区分: 那个是「本节点**消费**的源」,
   * 这个是「本结果**对应**的 clip」。同名会串义, 故分开命名。
   */
  sunoResultClipId?: string;
  [key: string]: unknown;
}

/**
 * AI 音频生成节点(语音合成 / 音效 / 音乐)。
 * 与「媒体节点(audio)」是两件事: 这里只负责提交与参数, 生成结果落到下游媒体节点。
 */
export interface AudioGenNodeData extends NodeDisplayData {
  prompt: string;
  model: string;
  /** 音频类型(决定端点与附加参数), 由所选模型决定。 */
  audioKind?: "speech" | "sound-effects" | "music";
  /**
   * 该节点上一次使用的创作形态。
   *
   * 注意: 自 2026-09-20 起 UI 改为**按模型家族分页**(右上角选家族), `creativeMode`
   * 退化为「生成请求里的快照字段」, 不再驱动界面 —— 驱动界面的是 `audioFamily`。
   * 前两个是「建音色」(按次一次性计费), 后两个是「用音色」(合成)。
   * 分工见 docs/api_docs/ZhiniaoAI_MiniMax_Voice_Chain.md
   */
  creativeMode?: "voice-clone" | "voice-design" | "speech" | "music";
  /** 当前模型家族(minimax / indextts / openai / gemini / doubao / elevenlabs / suno / other), 决定节点主体布局。 */
  audioFamily?: string;
  /** 音色(语音合成) */
  voice?: string;
  /**
   * 各模型「最后一次选中的音色」—— 模型 id → 音色。
   *
   * 切模型/切家族时，各家的音色是互不相通的（GM 的 `Zephyr` 在 GT 里不存在，MiniMax
   * 的音色则只来自音色库）。以前的做法是切到哪家就无脑写那家的默认音色，于是回到
   * 原家族时用户自己选的那个已经没了。改成先按模型存一份再恢复：
   * 切走时记录当前音色，切回时优先还原；没有记忆值才退回该模型的默认值。
   */
  voiceByModel?: Record<string, string>;
  /** 已保存的本地音色档案 ID。 */
  voiceProfileId?: string;
  /** 声音克隆参考样音。 */
  referenceAudio?: string;
  /** IndexTTS2.5/RH 工作流第二段情感参考样音。 */
  indexTtsSecondReferenceAudio?: string;
  /** IndexTTS2.5 可合成的语言（ZH / EN / JA / ES / AR）。 */
  indexTtsLanguage?: string;
  /**
   * 待创建的音色 ID(MiniMax 链路)。克隆与设计各存一份。
   *
   * 平台要求**调用方自带** voice_id, 且按它幂等(同一 ID 重复克隆不二次收费)。
   * 所以它必须在点「克隆/设计」的**那一刻**就生成并写进节点, 这样失败重试沿用同一个
   * ID 不会被重复计费 —— 等响应回来再定就晚了。
   */
  mmxCloneVoiceId?: string;
  mmxDesignVoiceId?: string;
  /** 待创建音色的名字(入库用)。 */
  mmxCloneVoiceName?: string;
  mmxDesignVoiceName?: string;
  /** 音色克隆卡片选中的模型(决定供应商)。 */
  mmxCloneModel?: string;
  /** 音色设计卡片选中的模型(决定供应商)。 */
  mmxDesignModel?: string;
  /** 音色克隆成功后生成的试听音频(点「试听」才会生成)。 */
  mmxClonePreviewAudio?: string;
  /** 音色设计接口直接返回的试听音频。 */
  mmxDesignPreviewAudio?: string;
  /** 音色设计: 音色描述词。 */
  voiceDesignPrompt?: string;
  /** 音色设计: 试听文本(返回的试听音频即此文本念出)。 */
  voiceDesignPreviewText?: string;
  /** speech-2.8 档位: hd(高音质) / turbo(速度优先)。 */
  mmxTier?: string;
  /** speech-2.8 版本: 2.8 / 2.6。 */
  mmxVersion?: string;
  /** speech-2.8 语速。 */
  mmxSpeed?: string;
  /** speech-2.8 语调。 */
  mmxPitch?: string;
  /** speech-2.8 情绪(取值域与通用 emotion 不同, 故独立成字段)。 */
  mmxEmotion?: string;
  /** speech-2.8 音效。 */
  mmxSoundEffect?: string;
  /** 情绪控制。 */
  emotion?: string;
  /** 情绪强度，范围 0-100。 */
  emotionIntensity?: number;
  /**
   * 自然语言风格指令(GM 系列 / GT-4o Mini TTS 独有)。
   *
   * 与 `emotion` 是两条通路: emotion 从固定枚举里挑, instructions 让模型理解任意描述
   * (「以温柔耳语朗读」「快速兴奋」)。GM 系列的官方卖点就是这个 ——
   * 藏了它, 「自然语言语气控制」等于没接。
   */
  instructions?: string;
  /** 语速(GT 系列独有, 平台声明 0.25-4.0)。 */
  speed?: string;
  /** 输出格式(语音合成) */
  format?: string;
  /** 音效时长(秒) */
  durationSeconds?: number;
  /**
   * 音乐时长(毫秒) —— **字子动画专有**。
   * 知鸟的 Suno 没有这个字段(曲长由模型决定), 它的音乐页不渲染这一项。
   */
  musicLengthMs?: number;
  /** 歌词(音乐生成)。Suno 的 `operation=generate` 留空即灵感模式自动作词。 */
  lyrics?: string;
  /**
   * Suno 的音乐操作(知鸟 `music` 模型专有)。
   * generate / extend / cover / lyrics / stems / stems_all / mp4 / concat。
   */
  sunoOperation?: string;
  /** Suno 模型版本: chirp-v6(默认) / chirp-v6-mini / chirp-v5 / chirp-v4-5。 */
  sunoVersion?: string;
  /** Suno 模式: song(含人声) / instrumental(纯器乐)。 */
  sunoMode?: string;
  /** Suno 风格标签(映射 Suno tags, 逗号分隔)。 */
  sunoStyle?: string;
  /** Suno 歌曲标题。 */
  sunoTitle?: string;
  /** Suno 演唱声线 auto / m / f。**这才是真正的声线控制**, 仅 song 模式有效。 */
  sunoVocalGender?: string;
  /** Suno 排除风格(映射 negative_tags, 逗号分隔)。 */
  sunoNegativeTags?: string;
  /**
   * 源 clip —— stems / stems_all / mp4 / concat 必填, extend 用 `sunoContinueClipId`。
   *
   * 两种来源: 上游音频节点的生成结果(`source_id`), 或手填。手填优先。
   */
  sunoClipId?: string;
  /** extend 的源 clip。 */
  sunoContinueClipId?: string;
  /** extend 的续写起点秒(留空从结尾续)。 */
  sunoContinueAt?: string;
  /** cover 的翻唱源 clip。 */
  sunoCoverClipId?: string;
  [key: string]: unknown;
}

export type MotionControlMode = "motion-control" | "lip-sync";
export type MotionControlOrientation = "image" | "video";
export type MotionControlLipSyncInput = "image" | "video";

/**
 * 动作控制 / 对口型节点。
 *
 * 这不是普通视频生成节点的别名：动作控制使用角色图 + 动作参考视频，
 * Kling 对口型使用已有视频 + 音频，字字动画对口型还支持人物图片 + 音频。
 */
export interface MotionControlNodeData extends NodeDisplayData {
  mode: MotionControlMode;
  /** 字字动画对口型可选择人物图片+音频，或待处理视频+音频。 */
  lipSyncInput?: MotionControlLipSyncInput;
  model: string;
  prompt: string;
  resolution: "720p" | "1080p";
  characterOrientation: MotionControlOrientation;
  keepOriginalAudio: boolean;
  imageSource?: string | null;
  imagePreviewUrl?: string | null;
  motionVideoSource?: string | null;
  motionVideoPreviewUrl?: string | null;
  inputVideoSource?: string | null;
  inputVideoPreviewUrl?: string | null;
  audioSource?: string | null;
  audioPreviewUrl?: string | null;
  faceSessionId?: string;
  faceId?: string;
  isGenerating?: boolean;
  generationError?: string | null;
  outputVideoUrl?: string | null;
  [key: string]: unknown;
}

export type CanvasNodeData =
  | UploadImageNodeData
  | ExportImageNodeData
  | TextAnnotationNodeData
  | PromptOptimizerNodeData
  | GroupNodeData
  | ImageEditNodeData
  | VideoGenNodeData
  | AudioGenNodeData
  | StoryboardSplitNodeData
  | StoryboardGenNodeData
  | PanoramaNodeData
  | DirectorDeskNodeData
  | CinematicStudioNodeData
  | AudioNodeData
  | MotionControlNodeData
  | SeamlessMosaicNodeData;

export type CanvasNode = Node<CanvasNodeData, CanvasNodeType>;
export type CanvasEdge = Edge;

export interface NodeCreationDto {
  type: CanvasNodeType;
  position: XYPosition;
  data?: Partial<CanvasNodeData>;
}

export interface StoryboardNodeCreationDto {
  position: XYPosition;
  rows: number;
  cols: number;
  frames: StoryboardFrameItem[];
}

export const NODE_TOOL_TYPES = {
  crop: "crop",
  annotate: "annotate",
  splitStoryboard: "split-storyboard",
  rotate: "rotate",
  adjust: "adjust",
} as const;

export type NodeToolType = (typeof NODE_TOOL_TYPES)[keyof typeof NODE_TOOL_TYPES];

export interface ActiveToolDialog {
  nodeId: string;
  toolType: NodeToolType;
}

export function isUploadNode(
  node: CanvasNode | null | undefined,
): node is Node<UploadImageNodeData, typeof CANVAS_NODE_TYPES.upload> {
  return node?.type === CANVAS_NODE_TYPES.upload;
}

export function isImageEditNode(
  node: CanvasNode | null | undefined,
): node is Node<ImageEditNodeData, typeof CANVAS_NODE_TYPES.imageEdit> {
  return node?.type === CANVAS_NODE_TYPES.imageEdit;
}

export function isExportImageNode(
  node: CanvasNode | null | undefined,
): node is Node<ExportImageNodeData, typeof CANVAS_NODE_TYPES.exportImage> {
  return node?.type === CANVAS_NODE_TYPES.exportImage;
}

export function isGroupNode(
  node: CanvasNode | null | undefined,
): node is Node<GroupNodeData, typeof CANVAS_NODE_TYPES.group> {
  return node?.type === CANVAS_NODE_TYPES.group;
}

export function isTextAnnotationNode(
  node: CanvasNode | null | undefined,
): node is Node<TextAnnotationNodeData, typeof CANVAS_NODE_TYPES.textAnnotation> {
  return node?.type === CANVAS_NODE_TYPES.textAnnotation;
}

export function isPromptOptimizerNode(
  node: CanvasNode | null | undefined,
): node is Node<PromptOptimizerNodeData, typeof CANVAS_NODE_TYPES.promptOptimizer> {
  return node?.type === CANVAS_NODE_TYPES.promptOptimizer;
}

export function isStoryboardSplitNode(
  node: CanvasNode | null | undefined,
): node is Node<StoryboardSplitNodeData, typeof CANVAS_NODE_TYPES.storyboardSplit> {
  return node?.type === CANVAS_NODE_TYPES.storyboardSplit;
}

export function isStoryboardGenNode(
  node: CanvasNode | null | undefined,
): node is Node<StoryboardGenNodeData, typeof CANVAS_NODE_TYPES.storyboardGen> {
  return node?.type === CANVAS_NODE_TYPES.storyboardGen;
}

export function isPanoramaNode(
  node: CanvasNode | null | undefined,
): node is Node<PanoramaNodeData, typeof CANVAS_NODE_TYPES.panorama> {
  return node?.type === CANVAS_NODE_TYPES.panorama;
}

export function isDirectorDeskNode(
  node: CanvasNode | null | undefined,
): node is Node<DirectorDeskNodeData, typeof CANVAS_NODE_TYPES.directorDesk> {
  return node?.type === CANVAS_NODE_TYPES.directorDesk;
}

export function isCinematicStudioNode(
  node: CanvasNode | null | undefined,
): node is Node<CinematicStudioNodeData, typeof CANVAS_NODE_TYPES.cinematicStudio> {
  return node?.type === CANVAS_NODE_TYPES.cinematicStudio;
}

export function isAudioNode(
  node: CanvasNode | null | undefined,
): node is Node<AudioNodeData, typeof CANVAS_NODE_TYPES.audio> {
  return node?.type === CANVAS_NODE_TYPES.audio;
}

export function isAudioGenNode(
  node: CanvasNode | null | undefined,
): node is Node<AudioGenNodeData, typeof CANVAS_NODE_TYPES.audioGen> {
  return node?.type === CANVAS_NODE_TYPES.audioGen;
}

export function isMotionControlNode(
  node: CanvasNode | null | undefined,
): node is Node<MotionControlNodeData, typeof CANVAS_NODE_TYPES.motionControl> {
  return node?.type === CANVAS_NODE_TYPES.motionControl;
}

export function isSeamlessMosaicNode(
  node: CanvasNode | null | undefined,
): node is Node<SeamlessMosaicNodeData, typeof CANVAS_NODE_TYPES.seamlessMosaic> {
  return node?.type === CANVAS_NODE_TYPES.seamlessMosaic;
}

export function nodeHasImage(node: CanvasNode | null | undefined): boolean {
  if (!node) {
    return false;
  }

  if (isUploadNode(node) || isImageEditNode(node) || isExportImageNode(node)) {
    return Boolean(node.data.imageUrl);
  }

  if (isStoryboardSplitNode(node)) {
    return node.data.frames.some((frame) => Boolean(frame.imageUrl));
  }

  if (isStoryboardGenNode(node)) {
    return Boolean(node.data.imageUrl);
  }

  if (isPanoramaNode(node)) {
    return Boolean(node.data.outputImageUrl || node.data.inputImageUrl);
  }

  if (isSeamlessMosaicNode(node)) {
    return Boolean(node.data.outputImageUrl);
  }

  return false;
}
