import type { ProjectV2, SceneStaging } from "../shared-types";

/**
 * The compact canvas node and the advanced workbench deliberately edit the
 * same project fields. Keeping the mapping here avoids two subtly different
 * definitions of "story", "style", or "scene staging".
 */
export interface CinematicStudioQuickSync {
  /** The scene currently represented by the compact node. */
  sceneId?: string;
  styleBrief: string;
  storySynopsis: string;
  /**
   * 场景站位（地点 / 角色候选 / 左右排序 / 轴 / 间距 / 空间锚点）。
   *
   * 省略表示「节点还没有站位数据」，此时**不要**覆盖高级编辑里的站位 —— 否则
   * 一个新节点（或还没点过站位选择器的节点）打开高级编辑时会把用户已经设好的
   * 地点与角色候选整块清空。有数据时整对象覆盖，两边始终是同一份站位。
   */
  staging?: SceneStaging;
}

/**
 * 画布上游接入的文本，仅供高级编辑做灰色只读回显。
 *
 * 刻意与 CinematicStudioQuickSync 分开：这部分**不会写进工程文件**，
 * 所以断开上游连线（或删掉上游节点）后，高级编辑里的灰字会立刻消失。
 * 节点自己手输的内容仍走 quickSync 的白字通道，两者互不影响。
 */
export interface CinematicStudioUpstreamText {
  styleBrief: string[];
  storySynopsis: string[];
}

export function quickSyncScene(project: ProjectV2, sceneId?: string) {
  return project.scenes.find((scene) => scene.id === sceneId) ?? project.scenes[0];
}

export function applyQuickStudioSync(project: ProjectV2, sync: CinematicStudioQuickSync): ProjectV2 {
  const scene = quickSyncScene(project, sync.sceneId);
  if (!scene) return project;
  const styleBrief = sync.styleBrief;
  const staging = sync.staging;
  return {
    ...project,
    // The compact canvas UI has one shared style field, so it intentionally
    // keeps the advanced editor's canonical and localized variants identical.
    styleBrief,
    styleBriefZh: styleBrief,
    styleBriefEn: styleBrief,
    scenes: project.scenes.map((item) => item.id === scene.id
      ? {
          ...item,
          logline: sync.storySynopsis,
          // 节点没有站位数据时保持工程原样，避免用空对象清掉高级编辑里的站位。
          ...(staging ? { staging: { ...staging } } : {}),
        }
      : item),
  };
}

export function quickSyncFromProject(project: ProjectV2, sceneId?: string): CinematicStudioQuickSync {
  const scene = quickSyncScene(project, sceneId);
  return {
    sceneId: scene?.id,
    styleBrief: project.styleBrief ?? project.styleBriefZh ?? project.styleBriefEn ?? "",
    storySynopsis: scene?.logline ?? "",
    staging: { ...(scene?.staging ?? {}) },
  };
}

/** 上游文本去重后拼成一块，作为合并文本的前缀。 */
function upstreamBlockOf(upstream: readonly string[]): string {
  return [...new Set(upstream.map((text) => text.trim()).filter(Boolean))].join("\n\n");
}

/**
 * 画布上游接入的文本 + 节点里手输的文本 → 一份合并文本（上游在前，本地在后）。
 *
 * 这份合并文本只服务极简节点的本地生成（两条口子都能进内容，生成时都要用）。
 * 高级编辑里的白字保持节点手输的原文、上游走灰色只读回显，因此不在这里合并；
 * 合并仍需幂等，因为节点本地字段有可能残留旧版本写进去的上游块。
 */
export function mergeUpstreamText(upstream: readonly string[], local: string): string {
  const upstreamBlock = upstreamBlockOf(upstream);
  const localText = local.trim();
  if (!upstreamBlock) return localText;
  if (!localText) return upstreamBlock;
  if (localText === upstreamBlock || localText.startsWith(`${upstreamBlock}\n`)) return localText;
  return `${upstreamBlock}\n\n${localText}`;
}

/** mergeUpstreamText 的逆运算：剥掉回写值里的上游块，取回节点自己手输的那部分。 */
export function stripUpstreamText(merged: string, upstream: readonly string[]): string {
  const upstreamBlock = upstreamBlockOf(upstream);
  const mergedText = merged.trim();
  if (!upstreamBlock) return mergedText;
  if (mergedText === upstreamBlock) return "";
  if (mergedText.startsWith(`${upstreamBlock}\n`)) return mergedText.slice(upstreamBlock.length).trim();
  return mergedText;
}
