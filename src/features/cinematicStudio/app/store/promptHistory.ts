/**
 * Prompt 版本历史存储（P2.2）
 * localStorage 过渡实现（P3 迁 SQLite）。上限 50 条，最旧优先淘汰。
 */
import type { PromptVersion } from "../../shared-types";

const KEY = "cineprompt-prompt-history";
const MAX = 50;

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
