import { invoke, isTauri } from '@tauri-apps/api/core';

/** Shared desktop key/value storage backed by the unified lentalk.db. */
export async function loadAppSetting(key: string): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>('load_app_setting', { key });
}

export async function saveAppSetting(key: string, value: string): Promise<void> {
  if (!isTauri()) return;
  await invoke('save_app_setting', { key, value });
}

export async function deleteAppSetting(key: string): Promise<void> {
  if (!isTauri()) return;
  await invoke('delete_app_setting', { key });
}

export async function loadCinematicProject(): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>('load_cinematic_project');
}

export async function saveCinematicProject(value: string): Promise<void> {
  if (!isTauri()) return;
  await invoke('save_cinematic_project', { projectJson: value });
}
