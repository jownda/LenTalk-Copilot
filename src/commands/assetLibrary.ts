import { invoke } from "@tauri-apps/api/core";

import type { AssetLibraryState } from "@/features/library/types";

/**
 * Tauri IPC 会把 Uint8Array 序列化为普通数字数组。大文件若一次性传输，会同时占用
 * File/ArrayBuffer/JS 数组/Rust Vec 多份内存，并阻塞 WebView 的主线程。超过此阈值后
 * 改为分块写入，每块完成后将控制权还给事件循环。
 */
const LARGE_ASSET_CHUNK_THRESHOLD_BYTES = 4 * 1024 * 1024;
const ASSET_IPC_CHUNK_BYTES = 2 * 1024 * 1024;

export async function loadAssetLibraryState(): Promise<AssetLibraryState> {
  return await invoke<AssetLibraryState>("load_asset_library_state");
}

export async function saveAssetLibraryState(state: AssetLibraryState): Promise<AssetLibraryState> {
  return await invoke<AssetLibraryState>("save_asset_library_state", { state });
}

export async function persistLibraryAssetBinary(bytes: Uint8Array, extension: string): Promise<string> {
  return await invoke<string>("persist_library_asset_binary", {
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
  return await invoke<string | null>("persist_library_asset_binary_chunk", {
    bytes: Array.from(bytes),
    fileId,
    extension,
    chunkIndex,
    isLast,
  });
}

/**
 * 将 Blob 写入素材库。优先由调用方提供的本地路径直接复制；此函数负责没有原生路径时的
 * 分块 IPC 兜底，避免上传大视频时一次性把全部字节转换为 JS 数组。
 */
export async function persistLibraryAssetBlob(blob: Blob, extension: string): Promise<string> {
  if (blob.size <= LARGE_ASSET_CHUNK_THRESHOLD_BYTES) {
    return await persistLibraryAssetBinary(new Uint8Array(await blob.arrayBuffer()), extension);
  }

  const fileId =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const chunkCount = Math.ceil(blob.size / ASSET_IPC_CHUNK_BYTES);
  let persistedPath: string | null = null;

  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const start = chunkIndex * ASSET_IPC_CHUNK_BYTES;
    const end = Math.min(blob.size, start + ASSET_IPC_CHUNK_BYTES);
    const bytes = new Uint8Array(await blob.slice(start, end).arrayBuffer());
    const result = await persistLibraryAssetBinaryChunk(
      bytes,
      fileId,
      extension,
      chunkIndex,
      chunkIndex === chunkCount - 1,
    );
    if (result) {
      persistedPath = result;
    }
  }

  if (!persistedPath) {
    throw new Error("素材文件分块写入未返回目标路径");
  }
  return persistedPath;
}

/** 选择器/拖拽得到原生路径时直接让 Rust 拷贝；否则走受控内存的 Blob 分块写入。 */
export async function persistLibraryAssetFromFile(file: File, extension: string): Promise<string> {
  const nativePath = (file as File & { path?: unknown }).path;
  if (typeof nativePath === "string" && nativePath.trim()) {
    return await persistLibraryAssetFile(nativePath, extension);
  }
  return await persistLibraryAssetBlob(file, extension);
}

/** 直接复制本地媒体文件，避免视频内容经 Tauri IPC 传输。 */
export async function persistLibraryAssetFile(sourcePath: string, extension: string): Promise<string> {
  return await invoke<string>("persist_library_asset_file", {
    sourcePath,
    extension,
  });
}

/** 用系统 QuickLook 为视频生成首帧缩略图, 返回缩略图路径(失败返回 null) */
export async function extractVideoThumbnail(videoPath: string): Promise<string | null> {
  try {
    const result = await invoke<string | null>("extract_video_thumbnail", {
      videoPath,
    });
    return result ?? null;
  } catch (error) {
    console.warn("[assetLibrary] extract video thumbnail failed", error);
    return null;
  }
}
