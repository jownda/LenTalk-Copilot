/**
 * 提示词工作室工程标识。
 *
 * 画布上的每个「提示词工作室」节点都持有一份**独立工程**（新建节点即全新空模板，
 * 互不串数据），因此工程需要一个稳定的 id 作为存储键。
 *
 * 本文件刻意不引入任何依赖，方便画布节点注册表（nodeRegistry）等底层模块引用。
 */

/** 旧的、全局唯一的工程 id（历史数据仍存在这个 id 下，必须保持兼容）。 */
export const DEFAULT_CINEMATIC_PROJECT_ID = "cinematic-project";

/** localStorage：默认工程沿用旧键，节点工程使用前缀键。 */
const LOCAL_PROJECT_KEY = "cineprompt-project";
/** SQLite app_settings：节点工程使用该前缀的键值（默认工程仍走 cinematic_projects 表）。 */
const DB_PROJECT_KEY_PREFIX = "cinematic-project";

/** 生成一个节点级工程 id。 */
export function createCinematicProjectId(): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `studio-${Date.now().toString(36)}-${random}`;
}

export function isDefaultCinematicProjectId(projectId?: string | null): boolean {
  return !projectId || projectId === DEFAULT_CINEMATIC_PROJECT_ID;
}

/** localStorage 存储键（默认工程保持旧键，避免老项目丢失）。 */
export function cinematicProjectStorageKey(projectId?: string | null): string {
  return isDefaultCinematicProjectId(projectId) ? LOCAL_PROJECT_KEY : `${LOCAL_PROJECT_KEY}:${projectId}`;
}

/** SQLite app_settings 键。 */
export function cinematicProjectSettingKey(projectId: string): string {
  return `${DB_PROJECT_KEY_PREFIX}:${projectId}`;
}
