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

  it('packs the cinematic asset library and restores its reference images and voice clips', async () => {
    vi.stubGlobal('localStorage', storage);

    const reference = 'data:image/png;base64,AAECAwQ=';
    const voiceClip = 'data:audio/mpeg;base64,QUJDRA==';
    storage.setItem(
      'cineprompt-project',
      JSON.stringify({
        id: 'cinematic-project',
        title: '测试影片',
        schemaVersion: 4,
        assets: [{
          id: 'char-1',
          kind: 'character',
          name: 'REIN',
          description: 'A drifter',
          lockLevel: 'strict',
          tags: [],
          referencePaths: [reference],
          voiceClip,
        }],
      }),
    );

    const backup = await createLibraryBackupZip();
    const zip = await JSZip.loadAsync(await backup.arrayBuffer());
    expect(zip.file('cinematic-assets.json')).not.toBeNull();

    const filesManifest = JSON.parse(await zip.file('cinematic-files.json')!.async('string')) as {
      files: Array<{ assetId: string; field: string; index: number; path: string }>;
    };
    expect(filesManifest.files).toHaveLength(2);
    expect(filesManifest.files.every((entry) => entry.assetId === 'char-1')).toBe(true);
    expect(filesManifest.files.map((entry) => entry.field).sort()).toEqual(['referencePaths', 'voiceClip']);
    for (const entry of filesManifest.files) {
      expect(zip.file(entry.path)).not.toBeNull();
    }

    storage.clear();
    const result = await importLibraryBackupZip(new File([backup], 'backup.zip', { type: 'application/zip' }));
    const restoredProject = JSON.parse(storage.getItem('cineprompt-project') ?? '{}');

    expect(result.cinematicAssetCount).toBe(1);
    expect(result.failedAssetFiles).toBe(0);
    expect(restoredProject.assets).toHaveLength(1);
    expect(restoredProject.assets[0].referencePaths[0]).toBe(reference);
    expect(restoredProject.assets[0].voiceClip).toBe(voiceClip);
  });

  it('merges the restored asset library by id so local-only assets survive', async () => {
    vi.stubGlobal('localStorage', storage);

    const backupProject = {
      id: 'cinematic-project',
      title: '测试影片',
      schemaVersion: 4,
      assets: [{ id: 'char-1', kind: 'character', name: 'REIN', description: 'A', lockLevel: 'strict', tags: [] }],
    };
    storage.setItem('cineprompt-project', JSON.stringify(backupProject));
    const backup = await createLibraryBackupZip();

    const localProject = {
      ...backupProject,
      assets: [
        { id: 'char-1', kind: 'character', name: '本机改名', description: 'A', lockLevel: 'strict', tags: [] },
        { id: 'char-2', kind: 'character', name: '本机新增', description: 'B', lockLevel: 'soft', tags: [] },
      ],
    };
    storage.setItem('cineprompt-project', JSON.stringify(localProject));

    await importLibraryBackupZip(new File([backup], 'backup.zip', { type: 'application/zip' }));
    const restored = JSON.parse(storage.getItem('cineprompt-project') ?? '{}');

    expect(restored.assets.map((asset: { id: string }) => asset.id)).toEqual(['char-1', 'char-2']);
    // 同 id 以备份为准(恢复),本机独有的 char-2 必须保留。
    expect(restored.assets[0].name).toBe('REIN');
    expect(restored.assets[1].name).toBe('本机新增');
  });
});
