import type { Asset, Project, ProjectV2 } from "../shared-types";
import { DEFAULT_NEGATIVE, deriveProjectCode, fovToLegacyFocalLength, legacyFocalLengthToFov, lensByFov, withAssetReferenceTag, withNegativePrefix } from "../engine";
import { loadAppSetting, loadCinematicProject, saveAppSetting, saveCinematicProject } from "@/commands/appDatabase";
import { isTauri } from "@tauri-apps/api/core";
import {
  DEFAULT_CINEMATIC_PROJECT_ID,
  cinematicProjectSettingKey,
  cinematicProjectStorageKey,
  isDefaultCinematicProjectId,
} from "./projectId";

export const SCHEMA_VERSION = 4;

export const seedProject: ProjectV2 = {
  id: "cinematic-project", title: "未命名影片", description: "", preset: "custom", styleId: undefined,
  negativePrompt: DEFAULT_NEGATIVE, schemaVersion: SCHEMA_VERSION,
  characters: [],
  scenes: [{
    id: "scene-01", name: "新场景", logline: "",
    location: "", time: "", weather: "", duration: "15秒", palette: "", lighting: "", environmentLock: false,
    shots: [
      { id: "shot-01", label: "镜头 01", duration: "0-15秒", framing: "Wide", lens: "35mm", camera: "arri-alexa-35", lensModel: "arri-master-prime", movement: "Static", action: "", acting: "", direction: "left-to-right" }
    ]
  }]
};

/**
 * 角色候选与空间左右顺序拆分。旧项目只有 characterOrder 时，
 * 将它作为初始候选角色保留，避免升级后丢失既有场景资产范围。
 */
function migrateSceneCharacterRosters(project: ProjectV2): ProjectV2 {
  return {
    ...project,
    scenes: (project.scenes ?? []).map((scene) => {
      const directorIntentRefinement = scene.directorIntentRefinement?.trim() || scene.storyNotes?.trim() || undefined;
      const staging = scene.staging;
      const withRefinement = {
        ...scene,
        ...(directorIntentRefinement ? {
          directorIntentRefinement,
          directorIntentRefinementSource: scene.directorIntentRefinementSource ?? "ai",
        } : {}),
      };
      if (!staging?.characterOrder?.length || Array.isArray(staging.characterRoster)) return withRefinement;
      return {
        ...withRefinement,
        staging: {
          ...staging,
          characterRoster: [...new Set(staging.characterOrder)],
        },
      };
    }),
  };
}

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
    return migrateSceneCharacterRosters({ ...project, projectCode, assets: project.assets.map((asset) => withAssetReferenceTag(asset, projectCode)) });
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

  return migrateSceneCharacterRosters(migrated);
}

export function loadProject(): ProjectV2 {
  try {
    const stored = JSON.parse(localStorage.getItem("cineprompt-project") || "") as ProjectV2;
    const migrated = migrateProject(stored);
    return {
      ...migrated,
      // Do not inject a director/style preset into an existing project. A
      // missing style means the current scene data must stand on its own.
      styleId: migrated.styleId,
      // 负面提示词统一带「不要」等前缀(旧数据无前缀的自动补, 保证输入框所见即所得)
      negativePrompt: withNegativePrefix(migrated.negativePrompt?.trim() || DEFAULT_NEGATIVE),
    };
  } catch { return migrateProject(seedProject); }
}

export function persistProject(project: ProjectV2) {
  if (isTauri()) return;
  try {
    localStorage.setItem("cineprompt-project", JSON.stringify(project));
  } catch (error) {
    // 配额超限(图片/音频 data URL 过大)时静默降级, 避免写入异常导致界面崩溃
    console.warn("persistProject failed", error);
  }
}

/** Desktop source of truth for the studio's working draft. */
export async function loadProjectFromDatabase(): Promise<ProjectV2 | null> {
  try {
    const raw = await loadCinematicProject();
    if (!raw) return null;
    return migrateProject(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function persistProjectToDatabase(project: ProjectV2): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    await saveCinematicProject(JSON.stringify(project));
    return true;
  } catch {
    return false;
  }
}

/* ── 节点级独立工程 ────────────────────────────────────────────────────────
 * 画布上每个「提示词工作室」节点各自持有一份工程，互不串数据：
 * - 默认工程 id：沿用旧的 cinematic_projects 全局行 / 全局 localStorage 键，老数据不丢。
 * - 节点工程 id：SQLite 走 app_settings 键值表（cinematic-project:<id>），
 *   localStorage 走 cineprompt-project:<id>；没有存档时返回空白模板。
 * 未打开任何节点工作室时，画布侧边栏资产库回退到「最近一次打开的节点工程」。
 */

/** 空白模板（新建节点打开的就是它）。 */
export function createSeedProject(projectId?: string): ProjectV2 {
  const seeded = migrateProject(seedProject);
  return projectId ? { ...seeded, id: projectId } : seeded;
}

function normalizeProject(project: ProjectV2, projectId?: string): ProjectV2 {
  return {
    ...project,
    id: projectId ?? project.id,
    styleId: project.styleId,
    // 负面提示词统一带「不要」等前缀(旧数据无前缀的自动补, 保证输入框所见即所得)
    negativePrompt: withNegativePrefix(project.negativePrompt?.trim() || DEFAULT_NEGATIVE),
  };
}

function readLocalProject(projectId?: string): ProjectV2 | null {
  try {
    const raw = localStorage.getItem(cinematicProjectStorageKey(projectId));
    if (!raw) return null;
    return migrateProject(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** 同步读取（首屏初始状态）；没有存档时给出空白模板。 */
export function loadProjectById(projectId?: string): ProjectV2 {
  const stored = readLocalProject(projectId);
  return normalizeProject(stored ?? migrateProject(seedProject), projectId);
}

export async function loadProjectFromDatabaseById(projectId?: string): Promise<ProjectV2 | null> {
  if (isDefaultCinematicProjectId(projectId)) return loadProjectFromDatabase();
  if (!isTauri()) return null;
  try {
    const raw = await loadAppSetting(cinematicProjectSettingKey(projectId as string));
    if (!raw) return null;
    return normalizeProject(migrateProject(JSON.parse(raw)), projectId);
  } catch {
    return null;
  }
}

export async function persistProjectToDatabaseById(projectId: string | undefined, project: ProjectV2): Promise<boolean> {
  if (isDefaultCinematicProjectId(projectId)) return persistProjectToDatabase(project);
  if (!isTauri()) return false;
  try {
    await saveAppSetting(cinematicProjectSettingKey(projectId as string), JSON.stringify(project));
    return true;
  } catch {
    return false;
  }
}

export function persistProjectById(projectId: string | undefined, project: ProjectV2) {
  if (isTauri()) return;
  try {
    localStorage.setItem(cinematicProjectStorageKey(projectId), JSON.stringify(project));
  } catch (error) {
    // 配额超限(图片/音频 data URL 过大)时静默降级, 避免写入异常导致界面崩溃
    console.warn("persistProject failed", error);
  }
}

/**
 * 复制一份工程到新的 id（画布复制节点时使用），
 * 让副本与原节点各自独立编辑，而不是共享同一份数据。
 * 资产库是全局共享的，不随工程复制（加载时会并入），避免多份大体积 data URL 副本。
 */
export async function duplicateCinematicProject(sourceProjectId: string, nextProjectId: string): Promise<void> {
  if (!sourceProjectId || !nextProjectId) return;
  const stored = await loadProjectFromDatabaseById(sourceProjectId);
  const source = stored ?? readLocalProject(sourceProjectId) ?? migrateProject(seedProject);
  const copy = normalizeProject({ ...source, assets: [] }, nextProjectId);
  const saved = await persistProjectToDatabaseById(nextProjectId, copy);
  if (!saved) persistProjectById(nextProjectId, copy);
}

/* ── 全局共享资产库 ────────────────────────────────────────────────────────
 * 资产库（角色 / 场景 / 道具）是**独立于节点工程**的全局数据源：
 * - 画布上每个工作室节点共读共写同一份资产，新建节点绝不会把资产库清空；
 * - 节点工程只保存场景、镜头、提示词等结构（落库前会剥离 assets）。
 * 载体沿用历史全局工程（老数据原封不动地继续作为资产库），
 * 读写时只替换 assets 字段，不触碰其中的其它内容。
 */

/** 合并资产池与节点遗留资产（按 id 去重，池内优先）。 */
export function mergeAssetPool(pool: Asset[], local: Asset[]): Asset[] {
  const seen = new Set(pool.map((asset) => asset.id));
  const extras = local.filter((asset) => asset && !seen.has(asset.id));
  return extras.length ? [...pool, ...extras] : pool;
}

/** 读取全局共享资产库。 */
export async function loadSharedAssets(): Promise<Asset[]> {
  const stored = await loadProjectFromDatabaseById(undefined);
  const source = stored ?? readLocalProject(undefined) ?? migrateProject(seedProject);
  return source.assets ?? [];
}

/** 写回全局共享资产库（只更新 assets，其余字段保持原样）。 */
export async function persistSharedAssets(assets: Asset[]): Promise<void> {
  const stored = await loadProjectFromDatabaseById(undefined);
  const base = stored ?? readLocalProject(undefined) ?? migrateProject(seedProject);
  const next = normalizeProject({ ...base, assets }, DEFAULT_CINEMATIC_PROJECT_ID);
  const saved = await persistProjectToDatabaseById(undefined, next);
  if (!saved) persistProjectById(undefined, next);
}
