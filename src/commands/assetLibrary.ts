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

/** 分块持久化备份素材，避免大视频通过一次 IPC 调用传输。 */
export async function persistLibraryAssetBinaryChunk(
  bytes: Uint8Array,
  fileId: string,
  extension: string,
  chunkIndex: number,
  isLast: boolean,
): Promise<string | null> {
  return await invoke<string | null>('persist_library_asset_binary_chunk', {
    bytes: Array.from(bytes),
    fileId,
    extension,
    chunkIndex,
    isLast,
  });
}

/** 直接复制本地媒体文件，避免视频内容经 Tauri IPC 传输。 */
export async function persistLibraryAssetFile(
  sourcePath: string,
  extension: string
): Promise<string> {
  return await invoke<string>('persist_library_asset_file', {
    sourcePath,
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
