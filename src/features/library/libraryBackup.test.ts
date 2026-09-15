import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createLibraryBackupZip,
  importLibraryBackupZip,
} from './libraryBackup';
import { ASSET_LIBRARY_STORAGE_KEY } from './types';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }
}

const storage = new MemoryStorage();

describe('library backup assets', () => {
  afterEach(() => {
    storage.clear();
    vi.unstubAllGlobals();
  });

  it('includes asset binaries and restores them as self-contained browser URLs', async () => {
    vi.stubGlobal('localStorage', storage);

    const sourcePath = 'data:image/png;base64,iVBORw0KGgo=';
    const previewImageUrl = 'data:image/png;base64,AAECAwQ=';
    const state = {
      libraries: [{ id: 'library-default', name: '我的素材库', createdAt: 0 }],
      categories: [],
      assets: [{
        id: 'asset-1',
        libraryId: 'library-default',
        categoryId: null,
        name: '测试图片',
        mediaType: 'image',
        sourcePath,
        previewImageUrl,
        tags: [],
        createdAt: 1,
      }],
      activeLibraryId: 'library-default',
    };
    storage.setItem(ASSET_LIBRARY_STORAGE_KEY, JSON.stringify(state));

    const backup = await createLibraryBackupZip();
    const zip = await JSZip.loadAsync(await backup.arrayBuffer());
    const filesManifest = JSON.parse(await zip.file('asset-files.json')!.async('string')) as {
      files: Array<{ assetId: string; field: string; path: string }>;
    };

    expect(filesManifest.files).toHaveLength(2);
    expect(filesManifest.files.every((entry) => entry.assetId === 'asset-1')).toBe(true);
    for (const entry of filesManifest.files) {
      expect(zip.file(entry.path)).not.toBeNull();
    }

    storage.clear();
    const result = await importLibraryBackupZip(new File([backup], 'backup.zip', { type: 'application/zip' }));
    const restored = JSON.parse(storage.getItem(ASSET_LIBRARY_STORAGE_KEY) ?? '{}');

    expect(result.assetCount).toBe(1);
    expect(restored.assets[0].sourcePath).toBe(sourcePath);
    expect(restored.assets[0].previewImageUrl).toBe(previewImageUrl);
  });
});
