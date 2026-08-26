import type { Asset, Project, ProjectV2 } from "../shared-types";
import { DEFAULT_NEGATIVE, deriveProjectCode, fovToLegacyFocalLength, legacyFocalLengthToFov, lensByFov, withAssetReferenceTag, withNegativePrefix, bakeryRescueProject, museumRedDoorsProject } from "../engine";

export const SCHEMA_VERSION = 3;

export const rainPreview = "./assets/rain-night-reference.jpg";

export const seedProject: ProjectV2 = {
  id: "rain-night", title: "雨夜", description: "一个男人穿过暴雨中的城市，把所有情绪压在心底。", preset: "Hollywood Naturalism", styleId: "wong-kar-wai",
  negativePrompt: DEFAULT_NEGATIVE, schemaVersion: SCHEMA_VERSION,
  characters: [],
  scenes: [{
    id: "scene-01", name: "雨夜", logline: "一个男人独自穿过被暴雨冲刷的市中心街道。他压抑悲伤，却没有流泪。",
    location: "密集的城市街道", time: "夜晚", weather: "暴雨", duration: "15秒", palette: "蓝灰 60 / 钠灯琥珀 30 / 红色 10", lighting: "街灯与湿润霓虹", environmentLock: true,
    shots: [
      { id: "shot-01", label: "镜头 01", duration: "0-8秒", framing: "3/4 medium, behind subject", lens: "35mm", camera: "sony-venice-2", lensModel: "cooke-s7i", movement: "Tracking", action: "关杰穿过雨幕，大衣被雨水打湿后显得沉重。", acting: "克制的悲伤；视线下垂，呼吸浅促，下颌紧绷。", direction: "left-to-right" },
      { id: "shot-02", label: "镜头 02", duration: "8-15秒", framing: "Extreme close-up, profile", lens: "85mm", camera: "arri-alexa-35", lensModel: "arri-master-prime", movement: "Handheld", action: "他在闪烁的雨棚下驻足，随后继续前行。", acting: "反应延迟；没有落泪，一次呼吸微微顿住。", direction: "left-to-right" }
    ]
  }]
};

/**
 * V0.1 → V0.2 项目迁移：
 * - 为每个 Character 登记 character Asset（reference→referencePaths，face/wardrobe→descriptionZh）
 * - 角色道具登记为 prop Asset
 * - identityLock 角色登记 identityRules（严格锁）
 * - Shot.characterId 转为第一个 participant；action 转为第一个 Beat（保留原文）
 * 幂等：schemaVersion 已是 SCHEMA_VERSION 且 assets 存在则跳过。
 */
export function migrateProject(raw: unknown): ProjectV2 {
  const project = (raw ?? {}) as ProjectV2;
  if (project.schemaVersion === SCHEMA_VERSION && Array.isArray(project.assets)) {
    for (const scene of project.scenes ?? []) {
      for (const shot of scene.shots ?? []) {
        if (shot.optics || !shot.lens) continue;
        const fov = legacyFocalLengthToFov(shot.lens);
        if (fov == null) continue;
        shot.optics = { fieldOfViewDegrees: fov, lensCharacter: lensByFov(fov)?.id };
        shot.lens = fovToLegacyFocalLength(fov);
      }
    }
    const projectCode = project.projectCode?.trim() || deriveProjectCode(project.title || project.id);
    return { ...project, projectCode, assets: project.assets.map((asset) => withAssetReferenceTag(asset, projectCode)) };
  }

  const projectCode = project.projectCode?.trim() || deriveProjectCode(project.title || project.id);
  const migrated: ProjectV2 = { ...project, schemaVersion: SCHEMA_VERSION, projectCode };
  const legacy = project as Project;
  const charAssetIds = new Map<string, string>();

  if (!Array.isArray(migrated.assets)) migrated.assets = [];
  if (!Array.isArray(migrated.identityRules)) migrated.identityRules = [];

  for (const character of legacy.characters ?? []) {
    const assetId = `asset-${character.id}`;
    charAssetIds.set(character.id, assetId);
    const faceDesc = [character.face, character.wardrobe].filter((part) => part.trim()).join("；");
    const characterAsset: Asset = {
      id: assetId,
      kind: "character",
      name: character.name.trim().toUpperCase() || `CHARACTER ${character.id}`,
      // canonical 描述：旧数据无法自动翻译为英文，先用名称占位，UI 提供翻译入口
      description: character.name.trim() || `Character ${character.id}`,
      descriptionZh: faceDesc || undefined,
      referencePaths: character.reference ? [character.reference] : [],
      useFor: ["face", "body", "wardrobe"],
      lockLevel: character.identityLock ? "strict" : "soft",
      tags: ["migrated"],
      uniqueMarkers: [],
    };
    migrated.assets.push(characterAsset);
    if (character.identityLock) {
      migrated.identityRules.push({ characterId: assetId, uniqueMarkers: [] });
    }
    // 角色道具 → prop 资产
    for (const prop of character.prop ?? []) {
      const propAssetId = `asset-${character.id}-prop-${prop.id}`;
      migrated.assets.push({
        id: propAssetId,
        kind: "prop",
        name: prop.text.trim() || "prop",
        description: prop.text.trim() || "Prop",
        descriptionZh: prop.text.trim() || undefined,
        referencePaths: prop.image ? [prop.image] : [],
        lockLevel: "none",
        tags: ["migrated"],
      });
    }
  }

  // Shot 迁移：characterId → participants[0]；action → beats[0]
  for (const scene of migrated.scenes ?? []) {
    for (const shot of scene.shots ?? []) {
      const assetId = shot.characterId ? charAssetIds.get(shot.characterId) : undefined;
      if (assetId && !Array.isArray(shot.participants)) {
        shot.participants = [{ characterId: assetId, role: "primary", entrance: "already-in-frame" }];
      }
      if (shot.action?.trim() && !Array.isArray(shot.beats)) {
        shot.beats = [{ id: `${shot.id}-beat-1`, order: 1, actorId: assetId, verb: "performs", actionText: shot.action.trim() }];
      }
      if (!shot.optics && shot.lens) {
        const fov = legacyFocalLengthToFov(shot.lens);
        if (fov != null) {
          shot.optics = { fieldOfViewDegrees: fov, lensCharacter: lensByFov(fov)?.id };
          shot.lens = fovToLegacyFocalLength(fov);
        }
      }
    }
  }

  migrated.assets = migrated.assets.map((asset) => withAssetReferenceTag(asset, projectCode));

  return migrated;
}

export function loadProject(): ProjectV2 {
  try {
    const stored = JSON.parse(localStorage.getItem("cineprompt-project") || "") as ProjectV2;
    // Refresh only the bundled demonstration project when upgrading to the Chinese default.
    const base = stored.id === seedProject.id && stored.title === "Rain Night" ? seedProject : stored;
    const migrated = migrateProject(base);
    return {
      ...migrated,
      styleId: migrated.styleId ?? "wong-kar-wai",
      // 负面提示词统一带「不要」等前缀(旧数据无前缀的自动补, 保证输入框所见即所得)
      negativePrompt: withNegativePrefix(migrated.negativePrompt?.trim() || DEFAULT_NEGATIVE),
    };
  } catch { return migrateProject(seedProject); }
}

export function persistProject(project: ProjectV2) {
  try {
    localStorage.setItem("cineprompt-project", JSON.stringify(project));
  } catch (error) {
    // 配额超限(图片/音频 data URL 过大)时静默降级, 避免写入异常导致界面崩溃
    console.warn("persistProject failed", error);
  }
}

export { museumRedDoorsProject, bakeryRescueProject };
