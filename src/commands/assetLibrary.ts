import { invoke } from '@tauri-apps/api/core';

import type { AssetLibraryState } from '@/features/library/types';

export async function loadAssetLibraryState(): Promise<AssetLibraryState> {
  return await invoke<AssetLibraryState>('load_asset_library_state');
}

export async function saveAssetLibraryState(state: AssetLibraryState): Promise<AssetLibraryState> {
  return await invoke<AssetLibraryState>('save_asset_library_state', { state });
}

export async function persistLibraryAssetBinary(
  bytes: Uint8Array,
  extension: string
): Promise<string> {
  return await invoke<string>('persist_library_asset_binary', {
    bytes: Array.from(bytes),
    extension,
  });
}

/** 用系统 QuickLook 为视频生成首帧缩略图, 返回缩略图路径(失败返回 null) */
export async function extractVideoThumbnail(videoPath: string): Promise<string | null> {
  try {
    const result = await invoke<string | null>('extract_video_thumbnail', {
      videoPath,
    });
    return result ?? null;
  } catch (error) {
    console.warn('[assetLibrary] extract video thumbnail failed', error);
    return null;
  }
}
