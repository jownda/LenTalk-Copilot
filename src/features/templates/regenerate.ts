import { canvasAiGateway } from '@/features/canvas/application/canvasServices';
import { browserTemplateRepository } from './storage/templateRepository';
import type { AssetRef, GenerateRun, Template } from './types';
import type { VideoGenNodeData, VideoGenerationRequestData } from '@/features/canvas/domain/canvasNodes';

export interface RegenerateTemplateOptions {
  onTemplateUpdate?: (template: Template) => void;
}

function sourceList(assets: AssetRef[]): string[] {
  return assets.map((asset) => asset.sourcePath.trim()).filter(Boolean);
}

function withExtraParams(template: Template): Record<string, unknown> {
  return { ...(template.pipeline.extraParams ?? {}) };
}

function resolveTemplateImageMode(template: Template): 'reference' | 'first-last' {
  if (template.pipeline.imageMode === 'first-last') return 'first-last';
  const videoNode = template.graph?.nodes.find((node) => node.id === template.graph?.videoNodeId);
  const mode = (videoNode?.data as VideoGenNodeData | undefined)?.imageMode;
  return mode === 'first-last' ? 'first-last' : 'reference';
}

export async function regenerateTemplate(template: Template, options: RegenerateTemplateOptions = {}): Promise<{ template: Template; run: GenerateRun }> {
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const runningRun: GenerateRun = { id: runId, createdAt: startedAt, status: 'running', params: { ...withExtraParams(template) } };
  const runningTemplate: Template = {
    ...template,
    updatedAt: startedAt,
    artifacts: { ...template.artifacts, history: [...template.artifacts.history, runningRun] },
  };
  const imageMode = resolveTemplateImageMode(template);
  await browserTemplateRepository.save(runningTemplate);
  options.onTemplateUpdate?.(runningTemplate);

  try {
    const videoUrl = await canvasAiGateway.generateVideo({
      clientJobId: runId,
      prompt: template.pipeline.prompt,
      model: template.pipeline.modelId,
      duration: template.pipeline.duration,
      aspectRatio: template.pipeline.aspectRatio,
      videoResolution: template.pipeline.resolution,
      imageMode,
      referenceImages: imageMode === 'first-last'
        ? sourceList(template.pipeline.referenceImages).slice(0, 2)
        : sourceList(template.pipeline.referenceImages),
      referenceAudio: sourceList(template.pipeline.referenceAudio),
      extraParams: withExtraParams(template),
    });
    const videoRef: AssetRef = {
      refId: crypto.randomUUID(), kind: 'video', role: 'generatedVideo', sourcePath: videoUrl,
      fileName: `${template.name}-${runId}.mp4`, required: false,
    };
    const run: GenerateRun = { ...runningRun, status: 'success', videoRef };
    const nextGenerationRequest: VideoGenerationRequestData = {
      kind: 'video',
      clientJobId: runId,
      prompt: template.pipeline.prompt,
      model: template.pipeline.modelId,
      duration: template.pipeline.duration,
      aspectRatio: template.pipeline.aspectRatio,
      videoResolution: template.pipeline.resolution,
      imageMode,
      referenceImages: sourceList(template.pipeline.referenceImages),
      referenceAudio: sourceList(template.pipeline.referenceAudio),
      extraParams: withExtraParams(template),
    };
    const nextGraph = template.graph ? {
      ...template.graph,
      nodes: template.graph.nodes.map((node) => node.id === template.graph?.outputNodeId
        ? { ...node, data: { ...node.data, sourcePath: videoUrl, mediaType: 'video', generationRequest: nextGenerationRequest, isGenerating: false, generationError: null } }
        : node),
    } : undefined;
    const completed: Template = {
      ...runningTemplate,
      updatedAt: new Date().toISOString(),
      pipeline: { ...runningTemplate.pipeline, imageMode },
      ...(nextGraph ? { graph: nextGraph } : {}),
      assets: [...runningTemplate.assets, videoRef],
      artifacts: { ...runningTemplate.artifacts, coverVideo: videoRef, history: runningTemplate.artifacts.history.map((item) => item.id === runId ? run : item) },
    };
    await browserTemplateRepository.save(completed);
    options.onTemplateUpdate?.(completed);
    return { template: completed, run };
  } catch (error) {
    const run: GenerateRun = { ...runningRun, status: 'failed', params: { ...runningRun.params, error: error instanceof Error ? error.message : String(error) } };
    const failed: Template = {
      ...runningTemplate,
      updatedAt: new Date().toISOString(),
      artifacts: { ...runningTemplate.artifacts, history: runningTemplate.artifacts.history.map((item) => item.id === runId ? run : item) },
    };
    await browserTemplateRepository.save(failed);
    options.onTemplateUpdate?.(failed);
    throw error;
  }
}


