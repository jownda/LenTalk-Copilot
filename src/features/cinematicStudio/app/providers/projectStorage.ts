/**
 * 工程存储（P1）：Tauri 命令封装，浏览器环境降级。
 * P1.1 成功判定：Rust Result<(), String> 成功映射 JS null → invokeSuccess 显式返回 true。
 * P1.3 多参考图：assets 传 Record<string, string[]>。
 */
import type { ProjectV2 } from "../../shared-types";

const hasTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** 写类命令：成功（含 null 返回）→ true，失败/非 Tauri → false */
async function invokeSuccess(command: string, args: Record<string, unknown>): Promise<boolean> {
  if (!hasTauri()) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke<void>(command, args);
    return true;
  } catch {
    return false;
  }
}

/** 读类命令：有返回体 */
async function invokeSafe<T>(command: string, args: Record<string, unknown>): Promise<T | null> {
  if (!hasTauri()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke(command, args)) as T;
  } catch {
    return null;
  }
}

/** 保存工程到磁盘（Tauri）；返回是否成功（浏览器环境返回 false） */
export async function saveProjectToDisk(dir: string, project: ProjectV2, assets: Record<string, string[]>): Promise<boolean> {
  return invokeSuccess("project_save", { dir, projectJson: JSON.stringify(project), assets });
}

/** 从磁盘读取工程 */
export async function loadProjectFromDisk(dir: string): Promise<ProjectV2 | null> {
  return invokeSafe<ProjectV2>("project_load", { dir });
}

/** 保存 Prompt 版本 md 到 prompts/ 目录 */
export async function savePromptToDisk(dir: string, versionId: string, text: string): Promise<boolean> {
  return invokeSuccess("prompt_save", { dir, versionId, text });
}

/** 读取 prompts/<id>.md */
export async function loadPromptFromDisk(dir: string, versionId: string): Promise<string | null> {
  return invokeSafe<string>("prompt_load", { dir, versionId });
}

/** 记录版本到 SQLite */
export async function recordVersionToSqlite(dir: string, versionId: string, template: string, summaryJson: string): Promise<boolean> {
  return invokeSuccess("version_record", { dir, versionId, template, summaryJson });
}

/** 读取 SQLite 版本记录 */
export async function listVersionsFromSqlite(dir: string): Promise<unknown[] | null> {
  return invokeSafe<unknown[]>("version_list", { dir });
}

/** Keychain：写入（Tauri/macOS；仅系统凭据库，绝不落 localStorage） */
export async function keychainSet(service: string, account: string, value: string): Promise<boolean> {
  return invokeSuccess("keychain_set", { service, account, value });
}

/** Keychain：读取 */
export async function keychainGet(service: string, account: string): Promise<string | null> {
  return invokeSafe<string>("keychain_get", { service, account });
}
