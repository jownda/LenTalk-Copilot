import { graphImageResolver } from '@/features/canvas/application/canvasServices';
import { CANVAS_NODE_TYPES, isAudioNode, type CanvasEdge, type CanvasNode, type VideoGenNodeData, type VideoGenerationRequestData } from '@/features/canvas/domain/canvasNodes';
import { browserTemplateRepository } from './storage/templateRepository';
import { TEMPLATE_SCHEMA_VERSION, type AssetRef, type Template } from './types';

export interface TemplateValidation {
  valid: boolean;
  missing: string[];
}

function assetRef(sourcePath: string, kind: AssetRef['kind'], role: string, required = true): AssetRef {
  const fileName = sourcePath.split(/[\\/]/).pop() || `${kind}-${Date.now()}`;
  return { refId: crypto.randomUUID(), kind, role, sourcePath, fileName, required };
}

function buildGraphSnapshot(outputNode: CanvasNode, videoNode: CanvasNode, nodes: CanvasNode[], edges: CanvasEdge[]) {
  const includedIds = new Set<string>();
  const visit = (nodeId: string) => {
    if (includedIds.has(nodeId)) return;
    includedIds.add(nodeId);
    edges.filter((edge) => edge.target === nodeId).forEach((edge) => visit(edge.source));
  };
  visit(outputNode.id);
  const graphNodes = nodes.filter((node) => includedIds.has(node.id));
  const graphEdges = edges.filter((edge) => includedIds.has(edge.source) && includedIds.has(edge.target));
  return {
    nodes: graphNodes,
    edges: graphEdges,
    outputNodeId: outputNode.id,
    videoNodeId: videoNode.id,
  };
}

export function validateTemplateChain(template: Template): TemplateValidation {
  const missing: string[] = [];
  if (!template.pipeline.prompt.trim()) missing.push('正向提示词');
  if (!template.pipeline.modelId.trim()) missing.push('模型配置');
  if (!template.pipeline.providerId.trim()) missing.push('供应商配置');
  if (!template.artifacts.coverVideo.sourcePath.trim()) missing.push('成品视频');
  return { valid: missing.length === 0, missing };
}

export function buildTemplateFromCanvas(outputNode: CanvasNode, nodes: CanvasNode[], edges: CanvasEdge[]): Template {
  if (!isAudioNode(outputNode) || outputNode.data.mediaType !== 'video' || !outputNode.data.sourcePath) {
    throw new Error('当前节点不是已完成的视频结果');
  }
  const upstreamId = edges.find((edge) => edge.target === outputNode.id)?.source;
  const videoNode = nodes.find((node) => node.id === upstreamId);
  if (!videoNode || videoNode.type !== CANVAS_NODE_TYPES.videoGen) throw new Error('未找到视频生成节点');

  const data = videoNode.data as VideoGenNodeData;
  const submittedRequest = outputNode.data.generationRequest;
  const request = submittedRequest?.kind === 'video' ? submittedRequest as VideoGenerationRequestData : null;
  const images = graphImageResolver.collectInputImages(videoNode.id, nodes, edges);
  const studioAudio = Array.isArray(data.studioReferenceAudio) ? data.studioReferenceAudio : [];
  const audio = [...graphImageResolver.collectInputAudio(videoNode.id, nodes, edges), ...studioAudio];
  const requestExtras = request?.extraParams ?? {};
  const referenceVideos = Array.isArray(requestExtras.reference_videos)
    ? requestExtras.reference_videos.filter((source): source is string => typeof source === 'string' && Boolean(source.trim()))
    : (Array.isArray(data.binghuoReferenceVideos) ? data.binghuoReferenceVideos.filter(Boolean) : []);
  const requestImages = request?.referenceImages?.length ? request.referenceImages : images;
  const referenceImages = requestImages.map((source) => assetRef(source, 'image', 'referenceImage'));
  const referenceAudio = audio.map((source) => assetRef(source, 'audio', 'referenceAudio'));
  const referenceVideo = referenceVideos.map((source) => assetRef(source, 'video', 'referenceVideo'));
  const coverVideo = assetRef(outputNode.data.sourcePath, 'video', 'coverVideo');
  const now = new Date().toISOString();
  const modelId = request?.model.trim() || data.model.trim();
  const providerId = (outputNode.data.generationProviderId ?? '').trim() || modelId.split('/')[0] || '';
  const template: Template = {
    id: crypto.randomUUID(), schemaVersion: TEMPLATE_SCHEMA_VERSION,
    name: outputNode.data.displayName?.trim() || data.prompt.trim().slice(0, 40) || '未命名模板',
    createdAt: now, updatedAt: now, status: 'ready',
    pipeline: {
      prompt: request?.prompt.trim() || data.prompt.trim(), negativePrompt: '', referenceImages, referenceAudio, referenceVideo,
      imageMode: request?.imageMode || data.imageMode || 'reference',
      providerId, modelId, duration: data.duration, aspectRatio: data.aspectRatio,
      ...(request?.videoResolution || data.resolution ? { resolution: request?.videoResolution || data.resolution } : {}),
      extraParams: {
        ...requestExtras,
        ...(data.binghuoSkipReview ? { skip_review: true } : {}),
        ...(referenceVideos.length ? { reference_videos: referenceVideos } : {}),
      },
    },
    graph: buildGraphSnapshot(outputNode, videoNode, nodes, edges),
    assets: [...referenceImages, ...referenceAudio, ...referenceVideo, coverVideo],
    artifacts: { coverVideo, history: [{ id: crypto.randomUUID(), createdAt: now, status: 'success', videoRef: coverVideo }] },
  };
  const validation = validateTemplateChain(template);
  template.status = validation.valid ? 'ready' : 'broken';
  return template;
}

export async function createTemplateFromCanvas(outputNode: CanvasNode, nodes: CanvasNode[], edges: CanvasEdge[], name?: string, description?: string): Promise<Template> {
  const template = buildTemplateFromCanvas(outputNode, nodes, edges);
  template.name = name?.trim() || template.name;
  if (description?.trim()) template.description = description.trim();
  const validation = validateTemplateChain(template);
  if (!validation.valid) throw new Error(`链路不完整：${validation.missing.join('、')}`);
  await browserTemplateRepository.save(template);
  return template;
}
