import type { XYPosition } from '@xyflow/react';

import type {
  CanvasEdge,
  CanvasNode,
  CanvasNodeData,
  CanvasNodeType,
  NodeToolType,
  StoryboardFrameItem,
} from '../domain/canvasNodes';
import type { CanvasNodeDefinition } from '../domain/nodeRegistry';

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
    size?: { width: number; height: number }
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
  imageMode?: 'reference' | 'first-last';
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
export type GenerateAudioKind = 'speech' | 'sound-effects' | 'music';

export interface GenerateAudioPayload {
  prompt: string;
  model: string;
  /** 音频类型; 缺省由适配层按模型名推断 */
  audioKind?: GenerateAudioKind;
  /** 音色(语音合成) */
  voice?: string;
  /** 输出格式(语音合成), 默认 mp3 */
  format?: string;
  /** 音效时长(秒) */
  durationSeconds?: number;
  /** 音乐时长(毫秒) */
  musicLengthMs?: number;
  /** 歌词(音乐生成) */
  lyrics?: string;
  extraParams?: Record<string, unknown>;
}

export type VideoReferenceSourceKind = 'public-url' | 'data-url' | 'local-file' | 'platform-file';

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
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'not_found';
    result?: string | null;
    error?: string | null;
  }>;
  generateVideo: (payload: GenerateVideoPayload) => Promise<string>;
  /** 视频超分：本地视频先上传换 URL，提交后轮询取片。 */
  upscaleVideo: (payload: UpscaleVideoPayload) => Promise<string>;
  generateAudio: (payload: GenerateAudioPayload) => Promise<string>;
}

export interface ImageSplitGateway {
  split: (
    imageSource: string,
    rows: number,
    cols: number,
    lineThickness: number,
    colFractions?: number[],
    rowFractions?: number[]
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
    options: Record<string, unknown>
  ) => Promise<ToolProcessorResult>;
}

export interface CanvasEventMap {
  'tool-dialog/open': {
    nodeId: string;
    toolType: NodeToolType;
  };
  'tool-dialog/close': undefined;
  'upload-node/reupload': {
    nodeId: string;
  };
  'media-node/capture-frame': {
    nodeId: string;
  };
  'upload-node/paste-image': {
    nodeId: string;
    file: File;
  };
  'upload-node/convert-media': {
    nodeId: string;
    file: File;
    mediaType: 'video' | 'audio';
  };
  'group-node/rename': {
    nodeId: string;
  };
}

export interface CanvasEventBus {
  publish: <TType extends keyof CanvasEventMap>(
    type: TType,
    payload: CanvasEventMap[TType]
  ) => void;
  subscribe: <TType extends keyof CanvasEventMap>(
    type: TType,
    handler: (payload: CanvasEventMap[TType]) => void
  ) => () => void;
}
