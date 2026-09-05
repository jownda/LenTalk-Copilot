import { buildSceneAssetRegistry, sceneVoiceCharacterIds } from "./engine";
import type { ProjectV2, SceneV2 } from "./shared-types";

export interface CinematicMediaReferences {
  referenceImages: string[];
  referenceAudio: string[];
}

/** One primary image per active asset matches the compiler's [imageN] order. */
export function collectCinematicMediaReferences(project: ProjectV2, scene: SceneV2): CinematicMediaReferences {
  const assets = buildSceneAssetRegistry(project, scene).orderedAssets;
  const stagingReferenceImage = scene.staging?.stagingReferenceImage?.trim();
  const firstFrameImages = (scene.firstFrameLock?.referenceImages ?? []).map((source) => source.trim()).filter(Boolean);
  return {
    referenceImages: [
      ...assets.map((asset) => asset.referencePaths?.[0]?.trim() ?? "").filter(Boolean),
      ...(stagingReferenceImage ? [stagingReferenceImage] : []),
      ...firstFrameImages,
    ],
    // 声音顺序必须与导演 AUDIO 段的 @audioN 对齐：按注册表顺序取实际发声且有 voiceClip 的角色。
    referenceAudio: sceneVoiceCharacterIds(project, scene)
      .map((id) => assets.find((asset) => asset.id === id)?.voiceClip?.trim() ?? "")
      .filter(Boolean),
  };
}
