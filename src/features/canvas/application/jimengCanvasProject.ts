import { createJimengCanvasProject, listJimengCanvasProjects } from '@/commands/jimengCanvasCli';
import { useJimengCanvasCliStore } from '@/stores/jimengCanvasCliStore';
import { useProjectStore } from '@/stores/projectStore';

/**
 * 按 LenTalk 工程分配即梦画布。
 *
 * ## 为什么需要这个
 *
 * 后端的兜底逻辑(`ensure_canvas_project`)只在账号里找一张名叫 `LenTalk` 的画布，找不到才
 * 新建 —— 于是**所有工程、所有节点都堆在同一张画布上**。用户打开官网看到的就是一张越来越
 * 乱的画布，而且本机历史上已经出现两张同名的 `LenTalk`（早先并发创建留下的）。
 *
 * 这里改成「一个 LenTalk 工程 → 一张即梦画布」：
 *   - 画布名带工程 id 前 8 位，重名工程也不会撞车；
 *   - projectId 记在本地 store 里，稳定复用，不再每次去 `canvas ls` 里按名字猜；
 *   - `canvas ls` 每次都要起一次 CLI(联网自检十几秒)，只在**第一次**给某个工程分配时才调。
 */

/** 画布名前缀 —— 与探针画布(`LenTalk-价格探针`)区分，也方便在官网一眼认出是 LenTalk 建的。 */
export const CANVAS_NAME_PREFIX = 'LenTalk';

/** 画布名总长上限。CLI 没写明限制，取一个保守值（含前缀与后缀）。 */
const CANVAS_NAME_MAX_LENGTH = 48;

/**
 * 由工程名生成画布名：`LenTalk-<工程名>-<工程 id 前 8 位>`。
 *
 * 带 id 后缀是为了区分同名工程（「未命名项目」会有一堆），也方便排查
 * 「这条生成到底进了哪张画布」。
 */
export function canvasNameForProject(projectName: string, projectId: string): string {
  const suffix = projectId.trim().slice(0, 8);
  // 画布名会原样进命令行参数，控制字符和路径分隔符先清掉。
  // （用 `\p{Cc}` 而不是 `\x00-\x1f`：后者会被 eslint 的 no-control-regex 拦下。）
  const cleaned = projectName
    .replace(/[\p{Cc}<>:"/\\|?*]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const head = cleaned || 'Untitled';
  const budget = Math.max(8, CANVAS_NAME_MAX_LENGTH - CANVAS_NAME_PREFIX.length - suffix.length - 2);
  const trimmedHead = head.length > budget ? head.slice(0, budget) : head;
  return suffix ? `${CANVAS_NAME_PREFIX}-${trimmedHead}-${suffix}` : `${CANVAS_NAME_PREFIX}-${trimmedHead}`;
}

/**
 * 在画布列表里找这个工程已经建好的那张。
 *
 * 顺序很关键：
 *   1. **先按完整名字精确匹配**（`LenTalk-<工程名>-<id8>`）—— 这是当前版本的命名，
 *      命中就用它，不管别的画布更新得多新。
 *   2. 再退到老版本的命名（`LenTalk-<工程名>`，没有 id 后缀），免得升级后又给同一个
 *      工程新建一张。
 *
 * 🔴 **绝不匹配裸 `LenTalk`**：那是老版本「所有工程共用一张」的画布，一旦让它命中，
 * 所有工程又会重新绑到同一张上，等于这次改动白做。没有工程名的旧画布只能靠用户在设置里
 * 手动「为当前工程新建画布」重新分配。
 *
 * 同优先级有多个候选时取**最近更新**的那张 —— 它才是实际一直在用的。
 */
export function pickCanvasForProject<T extends { name: string; projectId: string; updatedAt?: number | null }>(
  projects: T[],
  projectName: string,
  projectId: string,
): T | null {
  const exact = pickNewest(projects.filter((item) => item.name === canvasNameForProject(projectName, projectId)));
  if (exact) return exact;
  const legacyNames = legacyCanvasNames(projectName);
  return pickNewest(projects.filter((item) => legacyNames.includes(item.name)));
}

function pickNewest<T extends { updatedAt?: number | null }>(items: T[]): T | null {
  if (items.length === 0) return null;
  return items.reduce((best, item) => ((item.updatedAt ?? 0) > (best.updatedAt ?? 0) ? item : best));
}

/**
 * 旧版命名（没有 id 后缀）——只用于兼容，不再新建这种名字。
 *
 * 刻意**不包含**裸 `LenTalk`，原因见 `pickCanvasForProject` 的注释。
 */
function legacyCanvasNames(projectName: string): string[] {
  const cleaned = projectName.replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];
  return [`${CANVAS_NAME_PREFIX}-${cleaned}`, `${CANVAS_NAME_PREFIX} ${cleaned}`];
}

/** 同一个工程的分配请求并发时只跑一次（否则会建出两张画布）。 */
const inflight = new Map<string, Promise<string | undefined>>();

export interface EnsureCanvasOptions {
  /** 忽略已有绑定，强制新建一张并把绑定改到新画布（旧的云端画布保留）。 */
  forceNew?: boolean;
}

/**
 * 拿到「当前 LenTalk 工程」对应的即梦画布 projectId。
 *
 * 返回 `undefined` 表示**没有可用的工程上下文或分配失败** —— 这时调用方应当不传
 * `projectId`，让后端退回旧的「共享 LenTalk 画布」行为。生成链路不能因为画布分配失败
 * 就整条中断：图/视频是用户等着的产物，画布只是归档位置。
 */
export async function ensureJimengCanvasProject(
  executable: string,
  options: EnsureCanvasOptions = {},
): Promise<string | undefined> {
  const projectState = useProjectStore.getState();
  const projectId = projectState.currentProjectId ?? '';
  if (!projectId) return undefined;
  const projectName = projectState.currentProject?.name ?? '';
  const store = useJimengCanvasCliStore.getState();
  const bound = store.bindings[projectId];
  if (bound && !options.forceNew) return bound.projectId;

  const key = `${executable}|${projectId}|${options.forceNew ? 'new' : 'existing'}`;
  const running = inflight.get(key);
  if (running) return running;

  const task = (async () => {
    try {
      if (!options.forceNew) {
        const projects = await listJimengCanvasProjects(executable);
        const hit = pickCanvasForProject(projects, projectName, projectId);
        if (hit) {
          useJimengCanvasCliStore.getState().setBinding(projectId, {
            projectId: hit.projectId,
            name: hit.name,
            boundAt: Date.now(),
          });
          return hit.projectId;
        }
      }
      const created = await createJimengCanvasProject(
        executable,
        canvasNameForProject(projectName, projectId),
      );
      useJimengCanvasCliStore.getState().setBinding(projectId, {
        projectId: created.projectId,
        name: created.name || canvasNameForProject(projectName, projectId),
        boundAt: Date.now(),
      });
      return created.projectId;
    } catch (error) {
      // 分配失败不阻断生成：退回后端的共享画布兜底，只留一条 warn 便于排查。
      console.warn('[jimeng-canvas] 画布分配失败，本次使用共享兜底画布', {
        projectId,
        projectName,
        error,
      });
      return undefined;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, task);
  return task;
}

/** 测试用：清空并发去重表。 */
export function resetCanvasProjectInflightForTests() {
  inflight.clear();
}
