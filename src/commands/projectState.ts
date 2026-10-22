import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '@tauri-apps/api/core';

export interface ProjectSummaryRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  nodeCount: number;
  /** 项目封面缩略图(前 4 张) */
  thumbnails?: string[];
}

export interface ProjectRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  nodeCount: number;
  thumbnails?: string[];
  nodesJson: string;
  edgesJson: string;
  viewportJson: string;
  historyJson: string;
}

// ---------------------------------------------------------------------------
// 浏览器降级:非 Tauri 环境下用 IndexedDB(优先,容量大不会超限丢图)/
// localStorage(回退)模拟 SQLite 后端,保证 `npm run dev` 纯前端预览时
// 项目管理(新建/打开/重命名/删除)可用。
// ---------------------------------------------------------------------------
import {
  readAllBrowserProjects,
  writeAllBrowserProjects,
} from './browserProjectStorage';

/** 项目图片引用前缀(与 projectStore 的 encodeImageReference 一致) */
const IMAGE_REF_PREFIX = '__img_ref__:';

/** 从 historyJson 中提取 imagePool(兼容 projectStore 的持久化格式) */
function extractImagePoolFromHistoryJson(historyJson: string): string[] {
  try {
    const payload = JSON.parse(historyJson) as { imagePool?: unknown };
    if (Array.isArray(payload.imagePool)) {
      return payload.imagePool.filter((item): item is string => typeof item === 'string');
    }
    return [];
  } catch {
    return [];
  }
}

/** 解码图片引用为真实 URL(引用 + imagePool;非引用原样返回) */
function decodeImageReference(
  imageUrl: string,
  imagePool: string[] | undefined
): string | null {
  if (!imagePool || !imageUrl.startsWith(IMAGE_REF_PREFIX)) {
    return imageUrl;
  }
  const index = Number.parseInt(imageUrl.slice(IMAGE_REF_PREFIX.length), 10);
  if (!Number.isFinite(index) || index < 0) {
    return imageUrl;
  }
  return imagePool[index] ?? null;
}

/** 从 nodesJson 提取前 4 张封面缩略图(解码 __img_ref__:N 引用), 供 Tauri 列表补齐 */
function extractThumbnailsFromNodesJson(
  nodesJson: string,
  imagePool: string[]
): string[] {
  try {
    const nodes = JSON.parse(nodesJson) as Array<{ data?: Record<string, unknown> }>;
    const thumbnails: string[] = [];
    const seen = new Set<string>();
    const push = (url: unknown) => {
      if (thumbnails.length >= 4) {
        return;
      }
      if (typeof url !== 'string' || !url) {
        return;
      }
      const decoded = decodeImageReference(url, imagePool);
      if (!decoded || decoded.startsWith(IMAGE_REF_PREFIX) || seen.has(decoded)) {
        return;
      }
      seen.add(decoded);
      thumbnails.push(decoded);
    };
    for (const node of nodes) {
      const data = node.data ?? {};
      if (data.imageUrl) {
        push(data.imageUrl);
      } else if (data.previewImageUrl) {
        push(data.previewImageUrl);
      }
      if (Array.isArray(data.frames)) {
        for (const frame of data.frames as Array<Record<string, unknown>>) {
          if (frame.imageUrl) {
            push(frame.imageUrl);
          }
        }
      }
      if (thumbnails.length >= 4) {
        break;
      }
    }
    return thumbnails;
  } catch {
    return [];
  }
}

async function browserUpsert(record: ProjectRecord): Promise<void> {
  const entries = await readAllBrowserProjects();
  const existing = entries.find((entry) => entry.id === record.id);
  if (existing) {
    await writeAllBrowserProjects(entries.map((entry) =>
      entry.id === record.id
        ? {
            ...entry,
            name: record.name,
            updatedAt: record.updatedAt,
            nodeCount: record.nodeCount,
            thumbnails: record.thumbnails,
            nodesJson: record.nodesJson,
            edgesJson: record.edgesJson,
            viewportJson: record.viewportJson,
            historyJson: record.historyJson,
          }
        : entry
    ));
  } else {
    await writeAllBrowserProjects([...entries, { ...record }]);
  }
}

export async function listProjectSummaries(): Promise<ProjectSummaryRecord[]> {
  if (!isTauri()) {
    const entries = await readAllBrowserProjects();
    return entries.map((entry) => {
      // thumbnails 持久化的是 __img_ref__:N 轻量引用,这里用该项目的
      // imagePool 解码成真实 URL 供项目管理页显示
      const imagePool = extractImagePoolFromHistoryJson(entry.historyJson);
      const thumbnails = (entry.thumbnails ?? [])
        .map((ref) => decodeImageReference(ref, imagePool))
        .filter((url): url is string => Boolean(url));
      return {
        id: entry.id,
        name: entry.name,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        nodeCount: entry.nodeCount,
        ...(thumbnails.length > 0 ? { thumbnails } : {}),
      };
    });
  }
  const records = await invoke<ProjectSummaryRecord[]>('list_project_summaries');
  // Tauri: SQLite 列表不返回缩略图, 逐项目读取并解码补齐
  return await Promise.all(records.map(async (record) => {
    try {
      const full = await getProjectRecord(record.id);
      if (!full) {
        return record;
      }
      const imagePool = extractImagePoolFromHistoryJson(full.historyJson);
      const thumbnails = extractThumbnailsFromNodesJson(full.nodesJson, imagePool);
      return thumbnails.length > 0 ? { ...record, thumbnails } : record;
    } catch {
      return record;
    }
  }));
}

export async function getProjectRecord(projectId: string): Promise<ProjectRecord | null> {
  if (!isTauri()) {
    const entries = await readAllBrowserProjects();
    const entry = entries.find((item) => item.id === projectId);
    if (!entry) {
      return null;
    }
    return { ...entry };
  }
  return await invoke<ProjectRecord | null>('get_project_record', { projectId });
}

export async function upsertProjectRecord(record: ProjectRecord): Promise<void> {
  if (!isTauri()) {
    await browserUpsert(record);
    return;
  }
  await invoke('upsert_project_record', { record });
}

export async function updateProjectViewportRecord(
  projectId: string,
  viewportJson: string
): Promise<void> {
  if (!isTauri()) {
    const entries = await readAllBrowserProjects();
    await writeAllBrowserProjects(entries.map((entry) =>
      entry.id === projectId ? { ...entry, viewportJson } : entry
    ));
    return;
  }
  await invoke('update_project_viewport_record', { projectId, viewportJson });
}

export async function renameProjectRecord(
  projectId: string,
  name: string,
  updatedAt: number
): Promise<void> {
  if (!isTauri()) {
    const entries = await readAllBrowserProjects();
    await writeAllBrowserProjects(entries.map((entry) =>
      entry.id === projectId ? { ...entry, name, updatedAt } : entry
    ));
    return;
  }
  await invoke('rename_project_record', { projectId, name, updatedAt });
}

export async function deleteProjectRecord(projectId: string): Promise<void> {
  if (!isTauri()) {
    const entries = await readAllBrowserProjects();
    await writeAllBrowserProjects(entries.filter((entry) => entry.id !== projectId));
    return;
  }
  await invoke('delete_project_record', { projectId });
}
