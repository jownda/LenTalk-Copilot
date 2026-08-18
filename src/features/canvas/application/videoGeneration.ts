import type {
  GenerateVideoPayload,
  VideoGenerationRequest,
  VideoReferenceResource,
  VideoReferenceSourceKind,
} from './ports';

function getReferenceSourceKind(source: string): VideoReferenceSourceKind {
  if (/^https?:\/\//i.test(source)) return 'public-url';
  if (/^data:/i.test(source)) return 'data-url';
  if (/^(?:[a-z]+:)?\/\/|^file:/i.test(source)) return 'platform-file';
  return 'local-file';
}

function toResources(sources: string[] | undefined): VideoReferenceResource[] {
  return (sources ?? [])
    .map((source) => source.trim())
    .filter(Boolean)
    .map((source) => ({ source, sourceKind: getReferenceSourceKind(source) }));
}

export function toVideoGenerationRequest(payload: GenerateVideoPayload): VideoGenerationRequest {
  const referenceImages = toResources(payload.referenceImages);
  const isFirstLast = payload.imageMode === 'first-last';

  return {
    clientJobId: payload.clientJobId,
    modelId: payload.model,
    prompt: payload.prompt,
    duration: payload.duration,
    aspectRatio: payload.aspectRatio,
    videoResolution: payload.videoResolution,
    referenceImages: isFirstLast ? [] : referenceImages,
    referenceAudio: toResources(payload.referenceAudio),
    firstFrame: isFirstLast ? referenceImages[0] : undefined,
    lastFrame: isFirstLast ? referenceImages[1] : undefined,
  };
}
