import { invoke, isTauri } from '@tauri-apps/api/core';

export const DEFAULT_TEMPLATE_SHARE_ROOT = '\\\\192.168.3.254\\藏倍宁-专用盘\\AI-片头\\AI形象候选\\模板备份不要删';
export const TEMPLATE_SHARE_SETTING_KEY = 'templates.share-root';

/**
 * 同步/导入的超时兜底。
 *
 * Rust 命令一旦 panic（例如旧版 `safe_name` 的 `String::truncate` 切在多字节字符中间），
 * Tauri 不会回包 → `invoke` 的 Promise 永不 settle → 界面永久停在「同步中」且按钮一直禁用。
 * 加一层超时，保证失败最终能被看见、按钮能恢复。正常同步只需数秒（实测共享盘 ~53 MB/s），
 * 5 分钟足够覆盖上百 MB 的首次全量同步。
 */
export const TEMPLATE_SYNC_TIMEOUT_MS = 5 * 60 * 1000;

export class TemplateSyncTimeoutError extends Error {
  readonly code = 'TEMPLATE_SYNC_TIMEOUT';

  constructor() {
    super(`模板同步超时：${TEMPLATE_SYNC_TIMEOUT_MS / 60000} 分钟内没有收到响应，已中止等待`);
    this.name = 'TemplateSyncTimeoutError';
  }
}

function withSyncTimeout<T>(task: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TemplateSyncTimeoutError()), TEMPLATE_SYNC_TIMEOUT_MS);
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export async function loadTemplateShareRoot(): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>('load_app_setting', { key: TEMPLATE_SHARE_SETTING_KEY });
}

export async function saveTemplateShareRoot(root: string): Promise<void> {
  if (!isTauri()) return;
  await invoke('save_app_setting', { key: TEMPLATE_SHARE_SETTING_KEY, value: root });
}

export async function syncTemplatesToShare(sharedRoot: string): Promise<{ templateCount: number; copiedFileCount: number }> {
  if (!isTauri()) throw new Error('共享盘同步仅支持桌面端');
  return withSyncTimeout(invoke<{ templateCount: number; copiedFileCount: number }>('template_sync_to_share', { sharedRoot }));
}

export async function syncTemplatesFromShare(sharedRoot: string): Promise<{ importedCount: number }> {
  if (!isTauri()) throw new Error('共享盘读取仅支持桌面端');
  return withSyncTimeout(invoke<{ importedCount: number }>('template_sync_from_share', { sharedRoot }));
}
