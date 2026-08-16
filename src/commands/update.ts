import { invoke, isTauri } from '@tauri-apps/api/core';

export interface LatestReleaseInfo {
  version: string;
  release_url: string;
  download_url: string | null;
  release_notes: string | null;
}

export async function getLatestReleaseInfo(): Promise<LatestReleaseInfo | null> {
  if (!isTauri()) {
    return null;
  }
  return invoke<LatestReleaseInfo>('get_latest_release_info');
}
