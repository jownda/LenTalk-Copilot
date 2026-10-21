import { isTauri } from '@tauri-apps/api/core';

import {
  getProjectRecord,
  listProjectSummaries,
  upsertProjectRecord,
} from '@/commands/projectState';
import { browserTemplateRepository } from '@/features/templates/storage/templateRepository';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';

/**
 * 素材文件改名后的引用修复。
 *
 * 画布节点不是「引用素材 id」，而是把 `sourcePath` / `imageUrl` **按值拷贝**进节点数据，
 * 工程落库时也是这么存的。所以素材文件一改名，所有引用过它的节点（当前画布、其它工程、
 * 模板）都会指向一个已经不存在的路径 —— 图片/视频直接白屏。
 *
 * 这里做的是一次全局字符串重映射。和 `localizeMedia` 不同，**不设字段白名单**：
 * 旧路径改名后已经失效，任何字段里出现它都只可能是一条坏引用，替换掉是唯一有意义的处理。
 */

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 把 JSON 里所有出现 `oldPath` 的字符串替换成 `newPath`，返回替换条数。 */
export function remapAssetPathsInValue(
  value: unknown,
  pathMap: Map<string, string>,
): number {
  if (pathMap.size === 0) return 0;
  // 长路径优先，避免 A 是 B 的前缀时把 B 改坏。
  const entries = [...pathMap.entries()].sort((left, right) => right[0].length - left[0].length);

  let replacements = 0;

  const replaceString = (source: string): string => {
    let next = source;
    for (const [oldPath, newPath] of entries) {
      if (!oldPath || oldPath === newPath) continue;
      if (!next.includes(oldPath)) continue;
      // 记录命中次数（同一字符串里出现多次也算多次）
      let cursor = 0;
      let hits = 0;
      while (true) {
        const index = next.indexOf(oldPath, cursor);
        if (index === -1) break;
        hits += 1;
        cursor = index + oldPath.length;
      }
      replacements += hits;
      next = next.split(oldPath).join(newPath);
    }
    return next;
  };

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        const item = node[index];
        if (typeof item === 'string') {
          node[index] = replaceString(item);
        } else if (item && typeof item === 'object') {
          walk(item);
        }
      }
      return;
    }
    if (!node || typeof node !== 'object') return;

    const record = node as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const child = record[key];
      if (typeof child === 'string') {
        record[key] = replaceString(child);
      } else if (child && typeof child === 'object') {
        walk(child);
      }
    }
  };

  walk(value);
  return replacements;
}

export interface AssetPathRemapReport {
  /** 被改写的字符串条数。 */
  replacements: number;
  /** 当前画布是否写回过。 */
  canvasChanged: boolean;
  /** 被改写并回写的工程条数。 */
  projectsChanged: number;
  /** 被改写并回写的模板条数。 */
  templatesChanged: number;
  /** 资产库（角色/地点/道具）是否写回过。 */
  cinematicAssetsChanged: boolean;
}

/**
 * 等工程加载结束再动引用。
 *
 * 工程打开是异步的（`isOpeningProject`）：如果在「记录已读、画布还没写入」的窗口里
 * 改路径，画布拿到的就是没被改写的一份旧数据，改完立刻又显示成坏图。
 */
async function waitForProjectLoad(timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();
  while (useProjectStore.getState().isOpeningProject && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

/**
 * 把改名结果同步到当前画布、所有工程记录与模板。
 *
 * 当前打开的工程必须走内存态：它在画布 store 里有一份活数据，只改数据库的话，
 * 下一次自动保存又会把旧路径写回去。
 */
export async function applyAssetPathRemap(
  pathMap: Map<string, string>,
): Promise<AssetPathRemapReport> {
  const report: AssetPathRemapReport = {
    replacements: 0,
    canvasChanged: false,
    projectsChanged: 0,
    templatesChanged: 0,
    cinematicAssetsChanged: false,
  };
  if (!isTauri() || pathMap.size === 0) {
    return report;
  }

  await waitForProjectLoad();

  // ---- 1. 当前画布（内存态，含撤销栈）----
  try {
    const canvas = useCanvasStore.getState();
    const nodes = cloneJson(canvas.nodes);
    const edges = cloneJson(canvas.edges);
    const history = cloneJson(canvas.history);
    const hits =
      remapAssetPathsInValue(nodes, pathMap) +
      remapAssetPathsInValue(edges, pathMap) +
      remapAssetPathsInValue(history, pathMap);
    report.replacements += hits;
    if (hits > 0) {
      useCanvasStore.getState().setCanvasData(nodes, edges, history);
      const projectState = useProjectStore.getState();
      projectState.saveCurrentProject(
        nodes,
        edges,
        projectState.currentProject?.viewport,
        history,
      );
      report.canvasChanged = true;
    }
  } catch (error) {
    console.warn('[assetLibrary] 当前画布引用修复失败', error);
  }

  // ---- 2. 其它工程（数据库）----
  try {
    const currentProjectId = useProjectStore.getState().currentProjectId;
    const summaries = await listProjectSummaries();
    for (const summary of summaries) {
      if (summary.id === currentProjectId) continue;
      try {
        const record = await getProjectRecord(summary.id);
        if (!record) continue;
        const nodes = JSON.parse(record.nodesJson) as unknown;
        const edges = JSON.parse(record.edgesJson) as unknown;
        const history = JSON.parse(record.historyJson) as unknown;
        const hits =
          remapAssetPathsInValue(nodes, pathMap) +
          remapAssetPathsInValue(edges, pathMap) +
          remapAssetPathsInValue(history, pathMap);
        if (hits === 0) continue;
        const nextNodesJson = JSON.stringify(nodes);
        const nextEdgesJson = JSON.stringify(edges);
        const nextHistoryJson = JSON.stringify(history);
        await upsertProjectRecord({
          ...record,
          nodesJson: nextNodesJson,
          edgesJson: nextEdgesJson,
          historyJson: nextHistoryJson,
        });
        report.replacements += hits;
        report.projectsChanged += 1;
      } catch (error) {
        console.warn('[assetLibrary] 工程引用修复失败', summary.id, error);
      }
    }
  } catch (error) {
    console.warn('[assetLibrary] 工程列表读取失败', error);
  }

  // ---- 3. 模板 ----
  try {
    const templates = await browserTemplateRepository.list();
    for (const template of templates) {
      const next = cloneJson(template);
      const hits = remapAssetPathsInValue(next, pathMap);
      if (hits === 0) continue;
      await browserTemplateRepository.save(next);
      report.replacements += hits;
      report.templatesChanged += 1;
    }
  } catch (error) {
    console.warn('[assetLibrary] 模板引用修复失败', error);
  }

  // ---- 4. 资产库（电影工作室的角色 / 地点 / 道具）----
  // 它们的 referencePaths / voiceClip 直接存着素材库文件的绝对路径（镜像条目就是这么来的），
  // 漏掉这一步，改名会把角色参考图、音色全部变成死链。
  try {
    const { loadSharedAssets, persistSharedAssets } = await import(
      '@/features/cinematicStudio/app/model'
    );
    const assets = await loadSharedAssets();
    if (assets.length > 0) {
      const next = cloneJson(assets);
      const hits = remapAssetPathsInValue(next, pathMap);
      if (hits > 0) {
        await persistSharedAssets(next);
        report.replacements += hits;
        report.cinematicAssetsChanged = true;
      }
    }
  } catch (error) {
    console.warn('[assetLibrary] 资产库引用修复失败', error);
  }

  return report;
}
