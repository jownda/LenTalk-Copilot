import { invoke, isTauri } from '@tauri-apps/api/core';

export const DEFAULT_TEMPLATE_SHARE_ROOT = '\\\\192.168.3.254\\藏倍宁-专用盘\\AI-片头\\AI形象候选\\模板备份不要删';
export const TEMPLATE_SHARE_SETTING_KEY = 'templates.share-root';

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
  return invoke<{ templateCount: number; copiedFileCount: number }>('template_sync_to_share', { sharedRoot });
}

export async function syncTemplatesFromShare(sharedRoot: string): Promise<{ importedCount: number }> {
  if (!isTauri()) throw new Error('共享盘读取仅支持桌面端');
  return invoke<{ importedCount: number }>('template_sync_from_share', { sharedRoot });
}
