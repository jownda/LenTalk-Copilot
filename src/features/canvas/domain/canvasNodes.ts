import type { Edge, Node, XYPosition } from "@xyflow/react";

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

export const IMAGE_SIZES = ["0.5K", "1K", "2K", "4K"] as const;
export const IMAGE_ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "21:9"] as const;

export type ImageSize = (typeof IMAGE_SIZES)[number];

export interface NodeDisplayData {
  displayName?: string;
  [key: string]: unknown;
}

export interface NodeImageData extends NodeDisplayData {
  imageUrl: string | null;
  previewImageUrl?: string | null;
  aspectRatio: string;
  isSizeManuallyAdjusted?: boolean;
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
}

export type PersistedGenerationRequest = ImageGenerationRequestData | VideoGenerationRequestData;

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

export type PromptOptimizerTaskType =
  | "auto"
  | "character"
  | "location"
  | "prop"
  | "edit"
  | "texture"
  | "viewChange";

export interface PromptOptimizerNodeData extends NodeDisplayData {
  purpose: string;
  taskType?: PromptOptimizerTaskType;
  targetModel?: string;
  referencePalette?: string;
  optimizedPrompt?: string;
  routeSummary?: string;
  notes?: string[];
  /** 最近一次优化的执行模式：local=本地规则, ai=AI 增强, ai-fallback=AI 失败已回退。 */
  enhanceMode?: 'local' | 'ai' | 'ai-fallback';
  /** Chat 模型选择(来自设置中 providers 的 chatModels)。 */
  chatProviderId?: string;
  chatModel?: string;
  /** 输出语言：zh=中文, en=English。 */
  outputLang?: 'zh' | 'en';
  [key: string]: unknown;
}

export interface ImageEditNodeData extends NodeImageData {
  prompt: string;
  /** 负向提示词(对齐 Infinite Canvas 的 negative prompt) */
  negativePrompt?: string;
  model: string;
  size: ImageSize;
  requestAspectRatio?: string;
  extraParams?: Record<string, unknown>;
  isGenerating?: boolean;
  generationStartedAt?: number | null;
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

/** Cinematic Prompt Studio 节点:双击进入独立提示词工作台 */
export interface CinematicStudioNodeData extends NodeDisplayData {
  /** 最近一次保存的工程标题(仅用于节点预览) */
  lastProjectTitle?: string | null;
  /** 最近一次编译的提示词摘要(仅用于节点预览) */
  lastPromptPreview?: string | null;
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

/** 媒体节点(音频/视频共用, 素材库拖入或插入画布) */
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
  generationRequest?: VideoGenerationRequestData;
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
  | StoryboardSplitNodeData
  | StoryboardGenNodeData
  | PanoramaNodeData
  | DirectorDeskNodeData
  | CinematicStudioNodeData
  | AudioNodeData
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

export function isAudioNode(
  node: CanvasNode | null | undefined,
): node is Node<AudioNodeData, typeof CANVAS_NODE_TYPES.audio> {
  return node?.type === CANVAS_NODE_TYPES.audio;
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
