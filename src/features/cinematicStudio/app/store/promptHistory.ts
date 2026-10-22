/**
 * Prompt 版本历史存储（P2.2）
 * localStorage 过渡实现（P3 迁 SQLite）。上限 50 条，最旧优先淘汰。
 */
import type { PromptVersion } from "../../shared-types";
import { loadAppSetting, saveAppSetting } from "@/commands/appDatabase";
import { isTauri } from "@tauri-apps/api/core";

const KEY = "cineprompt-prompt-history";
const MAX = 50;
const DATABASE_KEY = "cinematic-prompt-history";

export function loadHistory(): PromptVersion[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as PromptVersion[]) : [];
  } catch {
    return [];
  }
}

function persist(list: PromptVersion[]): PromptVersion[] {
  const trimmed = list.slice(0, MAX);
  if (isTauri()) return trimmed;
  try {
    localStorage.setItem(KEY, JSON.stringify(trimmed));
  } catch {
    // 快照过大时淘汰最旧版本直至可写入
    let current = trimmed;
    while (current.length > 0) {
      try {
        localStorage.setItem(KEY, JSON.stringify(current));
        break;
      } catch {
        current = current.slice(0, current.length - 1);
      }
    }
  }
  return trimmed;
}

export function addVersion(version: Omit<PromptVersion, "id" | "createdAt">): PromptVersion[] {
  const list = loadHistory();
  const record: PromptVersion = {
    ...version,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  return persist([record, ...list]);
}

export function deleteVersion(id: string): PromptVersion[] {
  return persist(loadHistory().filter((version) => version.id !== id));
}

export function clearHistory(): PromptVersion[] {
  return persist([]);
}

export async function loadHistoryFromDatabase(): Promise<PromptVersion[] | null> {
  try {
    const raw = await loadAppSetting(DATABASE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PromptVersion[]).slice(0, MAX) : null;
  } catch {
    return null;
  }
}

export async function persistHistoryToDatabase(list: PromptVersion[]): Promise<boolean> {
  try {
    await saveAppSetting(DATABASE_KEY, JSON.stringify(list.slice(0, MAX)));
    return true;
  } catch {
    return false;
  }
}
