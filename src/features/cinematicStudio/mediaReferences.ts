import { buildSceneAssetRegistry } from "./engine";
import type { ProjectV2, SceneV2 } from "./shared-types";

export interface CinematicMediaReferences {
  referenceImages: string[];
  referenceAudio: string[];
}

/** One primary image per active asset matches the compiler's [imageN] order. */
export function collectCinematicMediaReferences(project: ProjectV2, scene: SceneV2): CinematicMediaReferences {
  const assets = buildSceneAssetRegistry(project, scene).orderedAssets;
  const firstFrameImages = (scene.firstFrameLock?.referenceImages ?? []).map((source) => source.trim()).filter(Boolean);
  return {
    referenceImages: [
      ...assets.map((asset) => asset.referencePaths?.[0]?.trim() ?? "").filter(Boolean),
      ...firstFrameImages,
    ],
    referenceAudio: assets.map((asset) => asset.voiceClip?.trim() ?? "").filter(Boolean),
  };
}
