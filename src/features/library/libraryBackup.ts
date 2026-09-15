// ---------------------------------------------------------------------------
// 素材库 + 提示词库 备份/导入(zip 格式)
// 备份内容:素材库(storyboard-asset-library-v2)+ 提示词库(storyboard-prompt-library-v2)
// 素材文件以二进制写入 zip,不能只保存 sourcePath(桌面端路径在另一台设备上无效)。
// ---------------------------------------------------------------------------
import JSZip from 'jszip';
import { isTauri } from '@tauri-apps/api/core';
import { ASSET_LIBRARY_STORAGE_KEY, type AssetLibraryState } from './types';
import { loadAssetLibraryState, persistLibraryAssetBinary, saveAssetLibraryState } from '@/commands/assetLibrary';
import { extensionFromMimeType } from '@/commands/referenceAssetSource';
import { readFile } from '@tauri-apps/plugin-fs';

export const PROMPT_LIBRARY_STORAGE_KEY = 'storyboard-prompt-library-v2';

const BACKUP_APP = 'storyboard-copilot';
const BACKUP_TYPE = 'library-backup';
const BACKUP_VERSION = 2;
const ASSET_FILE_PREFIX = 'asset-files/';

interface BackupManifest {
  app: typeof BACKUP_APP;
  type: typeof BACKUP_TYPE;
  version: number;
  exportedAt: number;
}

interface BackupAssetFile {
  path: string;
  mimeType: string;
  extension: string;
}

interface BackupAssetEntry extends BackupAssetFile {
  assetId: string;
  field: 'sourcePath' | 'previewImageUrl';
}

interface BackupAssetFilesManifest {
  files: BackupAssetEntry[];
}

function formatTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}`
  );
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function decodeDataUrl(value: string): { bytes: Uint8Array; mimeType: string; extension: string } | null {
  const match = value.match(/^data:([^;,]+)(?:;[^,]*)?;base64,([a-z0-9+/=\s]+)$/i);
  if (!match) return null;
  try {
    const binary = atob(match[2].replace(/\s+/g, ''));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const mimeType = match[1].toLowerCase();
    return { bytes, mimeType, extension: extensionFromMimeType(mimeType) };
  } catch {
    return null;
  }
}

function pathFromFileUrl(value: string): string {
  if (!value.toLowerCase().startsWith('file://')) return value;
  try {
    const parsed = new URL(value);
    return decodeURIComponent(parsed.pathname).replace(/^\/([A-Za-z]:[\\/])/, '$1');
  } catch {
    return value.replace(/^file:\/\//i, '');
  }
}

function extensionFromSource(value: string, fallback: string): string {
  const name = value.split(/[\\/?#]/).pop() ?? '';
  const match = name.match(/\.([a-z0-9]{1,12})$/i);
  return match?.[1]?.toLowerCase() || fallback;
}

async function readBackupAssetSource(source: string, fallbackExtension: string): Promise<BackupAssetFile & { bytes: Uint8Array }> {
  const dataUrl = decodeDataUrl(source);
  if (dataUrl) return { ...dataUrl, path: '' , bytes: dataUrl.bytes };

  if (isTauri()) {
    const path = pathFromFileUrl(source);
    try {
      const bytes = await readFile(path);
      return {
        bytes,
        path,
        mimeType: `application/${extensionFromSource(path, fallbackExtension)}`,
        extension: extensionFromSource(path, fallbackExtension),
      };
    } catch {
      // HTTP(S) sources may still be valid in a desktop asset record.
    }
  }

  const response = await fetch(source);
  if (!response.ok) throw new Error(`无法读取素材文件(${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const mimeType = response.headers.get('content-type')?.split(';')[0] || `application/${fallbackExtension}`;
  return { bytes, path: source, mimeType, extension: extensionFromMimeType(mimeType) || fallbackExtension };
}

function dataUrlFromBytes(bytes: Uint8Array, mimeType: string): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

function backupAssetPath(assetId: string, field: BackupAssetEntry['field'], extension: string): string {
  return `${ASSET_FILE_PREFIX}${assetId}/${field}.${extension}`;
}

/** 读取 zip 中指定路径的文件文本;支持根路径或任意子目录下的同名文件 */
async function readZipTextFile(zip: JSZip, fileName: string): Promise<string | null> {
  const direct = zip.file(fileName);
  if (direct) {
    return await direct.async('string');
  }
  const matches = zip.filter((relativePath) => relativePath.endsWith(`/${fileName}`));
  if (matches.length > 0) {
    return await matches[0].async('string');
  }
  return null;
}

/**
 * 生成素材库备份 zip。
 * 结构:
 *   manifest.json          备份元信息(app/类型/版本/时间)
 *   asset-library.json     素材库元数据
 *   asset-files/...        每个素材的原始文件与预览文件
 *   asset-files.json       二进制文件与资产字段的映射
 *   prompt-library.json    提示词库完整数据
 */
export async function createLibraryBackupZip(): Promise<Blob> {
  const zip = new JSZip();
  const exportedAt = Date.now();

  const manifest: BackupManifest = {
    app: BACKUP_APP,
    type: BACKUP_TYPE,
    version: BACKUP_VERSION,
    exportedAt,
  };
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));

  // 素材库:桌面版存 Rust 后端,浏览器存 localStorage,分别读取真实数据。
  let assetRaw: string | null = null;
  if (isTauri()) {
    const state = await loadAssetLibraryState();
    assetRaw = JSON.stringify(state);
  } else {
    assetRaw = localStorage.getItem(ASSET_LIBRARY_STORAGE_KEY);
  }
  const assetState = safeJsonParse<AssetLibraryState>(
    assetRaw ?? JSON.stringify({ libraries: [], categories: [], assets: [], activeLibraryId: null }),
    { libraries: [], categories: [], assets: [], activeLibraryId: '' },
  );
  const assetFiles: BackupAssetEntry[] = [];
  for (const asset of assetState.assets ?? []) {
    const fields: Array<{ field: BackupAssetEntry['field']; source: string | null | undefined; fallback: string }> = [
      { field: 'sourcePath', source: asset.sourcePath, fallback: asset.mediaType === 'video' ? 'mp4' : asset.mediaType === 'audio' ? 'mp3' : 'png' },
      { field: 'previewImageUrl', source: asset.previewImageUrl, fallback: 'png' },
    ];
    for (const item of fields) {
      if (!item.source?.trim()) continue;
      try {
        const file = await readBackupAssetSource(item.source.trim(), item.fallback);
        const zipPath = backupAssetPath(asset.id, item.field, file.extension);
        zip.file(zipPath, file.bytes);
        assetFiles.push({
          assetId: asset.id,
          field: item.field,
          path: zipPath,
          mimeType: file.mimeType,
          extension: file.extension,
        });
      } catch (error) {
        console.warn('[assetLibrary] skip unreadable backup asset file', asset.id, item.field, error);
      }
    }
  }
  zip.file('asset-library.json', JSON.stringify(assetState, null, 2));
  zip.file('asset-files.json', JSON.stringify({ files: assetFiles }, null, 2));

  const promptRaw = localStorage.getItem(PROMPT_LIBRARY_STORAGE_KEY);
  zip.file('prompt-library.json', promptRaw ?? '[]');

  return await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

/** 默认备份文件名:LenTalk-素材库备份-20260809-2310.zip */
export function buildBackupFileName(date: Date = new Date()): string {
  return `LenTalk-素材库备份-${formatTimestamp(date)}.zip`;
}

/**
 * 从 zip 导入备份(校验 manifest 后覆盖当前素材库与提示词库)。
 * 返回导入的数据摘要;调用方在成功后刷新页面以重新加载 store。
 */
export async function importLibraryBackupZip(
  file: File | Blob
): Promise<{ imported: string[]; assetCount: number; promptCount: number }> {
  // 统一转成 ArrayBuffer，兼容浏览器 File/Blob 与桌面端 WebView 的实现差异。
  const zip = await JSZip.loadAsync(await file.arrayBuffer());

  // 1) 校验 manifest
  const manifestRaw = await readZipTextFile(zip, 'manifest.json');
  let manifest: BackupManifest | null = null;
  if (manifestRaw) {
    const parsed = safeJsonParse<Partial<BackupManifest> | null>(manifestRaw, null);
    if (parsed && parsed.app === BACKUP_APP && parsed.type === BACKUP_TYPE) {
      manifest = parsed as BackupManifest;
    }
  }
  if (!manifest) {
    throw new Error('不是有效的LenTalk素材库备份文件(zip 缺少合法 manifest.json)');
  }

  // 2) 素材库
  const assetRaw = await readZipTextFile(zip, 'asset-library.json');
  let assetCount = 0;
  if (assetRaw) {
    const state = safeJsonParse<AssetLibraryState & { assets?: unknown }>(assetRaw, {} as AssetLibraryState);
    if (!Array.isArray(state.assets)) {
      throw new Error('备份文件中的素材库数据无效');
    }
    assetCount = state.assets.length;
    const filesRaw = await readZipTextFile(zip, 'asset-files.json');
    const filesManifest = safeJsonParse<BackupAssetFilesManifest>(filesRaw ?? '{}', { files: [] });
    const restoredState = {
      ...state,
      assets: [...state.assets] as AssetLibraryState['assets'],
    };
    for (const entry of filesManifest.files ?? []) {
      const asset = restoredState.assets.find((item) => item.id === entry.assetId);
      const file = zip.file(entry.path);
      if (!asset || !file) continue;
      const bytes = await file.async('uint8array');
      let restoredPath: string;
      if (isTauri()) {
        restoredPath = await persistLibraryAssetBinary(bytes, entry.extension);
      } else {
        restoredPath = dataUrlFromBytes(bytes, entry.mimeType);
      }
      if (entry.field === 'sourcePath') {
        asset.sourcePath = restoredPath;
      } else {
        asset.previewImageUrl = restoredPath;
      }
    }
    if (isTauri()) {
      await saveAssetLibraryState(restoredState);
    } else {
      localStorage.setItem(ASSET_LIBRARY_STORAGE_KEY, JSON.stringify(restoredState));
    }
  }

  // 3) 提示词库
  const promptRaw = await readZipTextFile(zip, 'prompt-library.json');
  let promptCount = 0;
  if (promptRaw) {
    const libraries = safeJsonParse<unknown[]>(promptRaw, []);
    if (!Array.isArray(libraries)) {
      throw new Error('备份文件中的提示词库数据无效');
    }
    promptCount = libraries.length;
    localStorage.setItem(PROMPT_LIBRARY_STORAGE_KEY, promptRaw);
  }

  return {
    imported: ['asset-library', 'prompt-library'],
    assetCount,
    promptCount,
  };
}

/** 触发浏览器下载 Blob */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** 判断是否运行在 Tauri 桌面环境 */
export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * 保存 Blob 到文件:
 * - Tauri 环境:弹出系统保存对话框,用户选择路径后写入
 * - 浏览器环境:fallback 为浏览器下载
 * 返回保存路径(浏览器环境返回 null)。
 */
export async function saveBlobWithDialog(blob: Blob, fileName: string): Promise<string | null> {
  if (!isTauriRuntime()) {
    downloadBlob(blob, fileName);
    return null;
  }

  const { save } = await import('@tauri-apps/plugin-dialog');
  const { writeFile } = await import('@tauri-apps/plugin-fs');

  const filePath = await save({
    defaultPath: fileName,
    filters: [{ name: 'ZIP 备份', extensions: ['zip'] }],
  });
  if (!filePath) return null; // 用户取消

  const bytes = new Uint8Array(await blob.arrayBuffer());
  await writeFile(filePath, bytes);
  return filePath;
}
