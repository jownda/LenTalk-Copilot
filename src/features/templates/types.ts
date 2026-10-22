import type { CanvasEdge, CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';

export type TemplateStatus = 'ready' | 'broken';
export type AssetKind = 'image' | 'audio' | 'video';

export interface AssetRef {
  refId: string;
  assetId?: string;
  kind: AssetKind;
  role?: string;
  sourcePath: string;
  fileName: string;
  contentHash?: string;
  required: boolean;
}

export interface GenerateRun {
  id: string;
  createdAt: string;
  status: 'running' | 'success' | 'failed';
  videoRef?: AssetRef;
  params?: Record<string, unknown>;
}

export interface TemplatePipeline {
  prompt: string;
  negativePrompt: string;
  referenceImages: AssetRef[];
  referenceAudio: AssetRef[];
  referenceVideo: AssetRef[];
  imageMode?: 'reference' | 'first-last';
  providerId: string;
  modelId: string;
  duration: number;
  aspectRatio: string;
  resolution?: string;
  extraParams?: Record<string, unknown>;
}

export interface TemplatePromptStudioSnapshot {
  studioProjectId: string;
  snapshot: unknown;
}

export interface TemplateGraphSnapshot {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  outputNodeId: string;
  videoNodeId: string;
}

export interface Template {
  id: string;
  schemaVersion: number;
  name: string;
  description?: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
  status: TemplateStatus;
  pipeline: TemplatePipeline;
  graph?: TemplateGraphSnapshot;
  promptStudio?: TemplatePromptStudioSnapshot;
  assets: AssetRef[];
  artifacts: {
    coverVideo: AssetRef;
    history: GenerateRun[];
  };
}

function fallbackNode(id: string, type: CanvasNode['type'], position: { x: number; y: number }, data: Record<string, unknown>): CanvasNode {
  return { id, type, position, data } as CanvasNode;
}

/** Fill in a graph for templates saved before graph snapshots were introduced. */
export function ensureTemplateGraph(template: Template): Template {
  if (template.graph) return template;

  const textId = `${template.id}-text`;
  const studioId = `${template.id}-studio`;
  const videoId = `${template.id}-video`;
  const outputId = `${template.id}-output`;
  const imageNodes = template.pipeline.referenceImages.map((asset, index) => ({
    node: fallbackNode(`${template.id}-image-${index}`, CANVAS_NODE_TYPES.upload, { x: 360, y: index * 150 }, {
      displayName: asset.fileName,
      imageUrl: asset.sourcePath,
      previewImageUrl: asset.sourcePath,
      aspectRatio: '1:1',
      sourceFileName: asset.fileName,
    }),
    id: `${template.id}-image-${index}`,
  }));
  const audioNodes = template.pipeline.referenceAudio.map((asset, index) => ({
    node: fallbackNode(`${template.id}-audio-${index}`, CANVAS_NODE_TYPES.audio, { x: 360, y: (template.pipeline.referenceImages.length + index) * 150 }, {
      displayName: asset.fileName,
      sourcePath: asset.sourcePath,
      mediaType: 'audio',
    }),
    id: `${template.id}-audio-${index}`,
  }));
  const nodes: CanvasNode[] = [
    fallbackNode(textId, CANVAS_NODE_TYPES.textAnnotation, { x: 0, y: 120 }, { displayName: '文本', content: template.description?.trim() || template.pipeline.prompt }),
    fallbackNode(studioId, CANVAS_NODE_TYPES.cinematicStudio, { x: 360, y: 120 }, {
      displayName: '提示词工作室',
      lastPromptPreview: template.pipeline.prompt,
      studioReferenceImages: template.pipeline.referenceImages.map((asset) => asset.sourcePath),
      studioReferenceAudio: template.pipeline.referenceAudio.map((asset) => asset.sourcePath),
    }),
    ...imageNodes.map((item) => item.node),
    ...audioNodes.map((item) => item.node),
    fallbackNode(videoId, CANVAS_NODE_TYPES.videoGen, { x: 760, y: 120 }, {
      displayName: 'AI 视频',
      prompt: template.pipeline.prompt,
      model: template.pipeline.modelId,
      duration: template.pipeline.duration,
      aspectRatio: template.pipeline.aspectRatio,
      resolution: template.pipeline.resolution,
      imageMode: template.pipeline.imageMode ?? 'reference',
      binghuoReferenceVideos: template.pipeline.referenceVideo.map((asset) => asset.sourcePath),
    }),
    fallbackNode(outputId, CANVAS_NODE_TYPES.audio, { x: 1240, y: 120 }, {
      displayName: template.name,
      sourcePath: template.artifacts.coverVideo.sourcePath,
      mediaType: 'video',
      aspectRatio: template.pipeline.aspectRatio,
      generationProviderId: template.pipeline.providerId,
      generationModel: template.pipeline.modelId,
    }),
  ];
  const edge = (source: string, target: string): CanvasEdge => ({ id: `${source}-${target}`, source, target });
  const edges: CanvasEdge[] = [edge(textId, studioId), edge(studioId, videoId), ...imageNodes.map((item) => edge(item.id, videoId)), ...audioNodes.map((item) => edge(item.id, videoId)), edge(videoId, outputId)];
  return { ...template, graph: { nodes, edges, outputNodeId: outputId, videoNodeId: videoId } };
}

export const TEMPLATE_SCHEMA_VERSION = 1;

export function templateCoverSource(template: Template): string {
  return template.artifacts.coverVideo.sourcePath;
}

export function templateIsBroken(template: Template): boolean {
  return template.status === 'broken'
    || !template.pipeline.prompt.trim()
    || !template.pipeline.modelId.trim()
    || !template.artifacts.coverVideo.sourcePath.trim();
}
