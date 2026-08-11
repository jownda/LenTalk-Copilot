import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { isTauri } from '@tauri-apps/api/core';

import { loadAssetLibraryState, saveAssetLibraryState } from '@/commands/assetLibrary';
import {
  ASSET_LIBRARY_STORAGE_KEY,
  type AssetCategory,
  type AssetLibrary,
  type AssetLibraryState,
  type LibraryAsset,
} from './types';

const LEGACY_STORAGE_KEY = 'storyboard-asset-library-v1-v1';

interface AssetLibraryStore extends AssetLibraryState {
  isHydrated: boolean;
  hydrate: () => Promise<void>;
  setActiveLibrary: (libraryId: string) => void;
  createLibrary: (name: string) => string;
  renameLibrary: (libraryId: string, name: string) => void;
  deleteLibrary: (libraryId: string) => void;
  addAssets: (assets: LibraryAsset[]) => void;
  deleteAssets: (assetIds: string[]) => void;
  renameAsset: (assetId: string, name: string) => void;
  setAssetTags: (assetId: string, tags: string[]) => void;
  classifyAssets: (assetIds: string[]) => number;
  addCategory: (libraryId: string, name: string, parentId?: string | null) => string;
  renameCategory: (categoryId: string, name: string) => void;
  deleteCategory: (categoryId: string) => void;
  moveAssetsToCategory: (assetIds: string[], categoryId: string | null) => void;
}

let persistQueue = Promise.resolve();

function createId(prefix: string): string {
  return `${prefix}-${uuid().slice(0, 12)}`;
}

function defaultState(): AssetLibraryState {
  const libraryId = 'library-default';
  return {
    libraries: [{ id: libraryId, name: '我的素材库', createdAt: 0 }],
    categories: [
      { id: 'category-characters', libraryId, name: '角色', createdAt: 0 },
      { id: 'category-scenes', libraryId, name: '场景', createdAt: 0 },
      { id: 'category-props', libraryId, name: '道具', createdAt: 0 },
    ],
    assets: [],
    activeLibraryId: libraryId,
  };
}

function readBrowserState(): AssetLibraryState {
  try {
    const value = localStorage.getItem(ASSET_LIBRARY_STORAGE_KEY);
    return value ? normalizeState(JSON.parse(value) as AssetLibraryState) : defaultState();
  } catch {
    return defaultState();
  }
}

function normalizeState(state: AssetLibraryState): AssetLibraryState {
  if (!Array.isArray(state.libraries) || state.libraries.length === 0) return defaultState();
  const libraries = state.libraries.filter((library) => Boolean(library?.id));
  if (libraries.length === 0) return defaultState();
  const libraryIds = new Set(libraries.map((library) => library.id));
  const categories = (Array.isArray(state.categories) ? state.categories : []).filter(
    (category) => category?.id && libraryIds.has(category.libraryId)
  );
  const categoryIds = new Set(categories.map((category) => category.id));
  const assets = (Array.isArray(state.assets) ? state.assets : [])
    .filter((asset) => asset?.id && asset.sourcePath && libraryIds.has(asset.libraryId))
    .map((asset) => ({
      ...asset,
      categoryId: asset.categoryId && categoryIds.has(asset.categoryId) ? asset.categoryId : null,
      mediaType: ['image', 'video', 'audio'].includes(asset.mediaType) ? asset.mediaType : 'image',
      tags: Array.isArray(asset.tags) ? asset.tags.filter(Boolean) : [],
    })) as LibraryAsset[];
  return {
    libraries,
    categories,
    assets,
    activeLibraryId: libraryIds.has(state.activeLibraryId) ? state.activeLibraryId : libraries[0].id,
  };
}

function legacyMigration(): AssetLibraryState | null {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return null;
    const legacy = JSON.parse(raw) as {
      assets?: Array<{
        id?: string;
        categoryId?: string | null;
        imageUrl?: string;
        previewImageUrl?: string;
        aspectRatio?: string;
        sourceFileName?: string | null;
        name?: string;
        createdAt?: number;
      }>;
      categories?: Array<{ id?: string; name?: string; createdAt?: number }>;
    };
    if (!Array.isArray(legacy.assets) || legacy.assets.length === 0) return null;
    const next = defaultState();
    const libraryId = next.activeLibraryId;
    next.categories = (legacy.categories ?? [])
      .filter((category) => category.id)
      .map((category) => ({
        id: category.id as string,
        libraryId,
        name: category.name?.trim() || '未分类',
        createdAt: category.createdAt ?? Date.now(),
      }));
    next.assets = legacy.assets
      .filter((asset) => asset.id && asset.imageUrl)
      .map((asset) => ({
        id: asset.id as string,
        libraryId,
        categoryId: asset.categoryId ?? null,
        name: asset.name?.trim() || '未命名素材',
        mediaType: 'image' as const,
        sourcePath: asset.imageUrl as string,
        previewImageUrl: asset.previewImageUrl ?? asset.imageUrl ?? null,
        aspectRatio: asset.aspectRatio ?? '1:1',
        sourceFileName: asset.sourceFileName ?? null,
        tags: [],
        createdAt: asset.createdAt ?? Date.now(),
      }));
    return normalizeState(next);
  } catch {
    return null;
  }
}

function persist(state: AssetLibraryState): void {
  const snapshot = normalizeState(state);
  persistQueue = persistQueue
    .catch(() => undefined)
    .then(async () => {
      if (isTauri()) {
        await saveAssetLibraryState(snapshot);
      } else {
        localStorage.setItem(ASSET_LIBRARY_STORAGE_KEY, JSON.stringify(snapshot));
      }
    })
    .catch((error) => console.warn('[assetLibrary] persist failed', error));
}

function updateStore(
  set: (partial: Partial<AssetLibraryStore>) => void,
  next: AssetLibraryState
): void {
  const normalized = normalizeState(next);
  set(normalized);
  persist(normalized);
}

function suggestCategoryId(asset: LibraryAsset, categories: AssetCategory[]): string | null {
  const searchable = [asset.name, asset.sourceFileName ?? '', ...asset.tags].join(' ').toLocaleLowerCase();
  const groups: Array<{ category: RegExp; clues: RegExp }> = [
    { category: /角色|人物|character|portrait/i, clues: /角色|人物|肖像|头像|男|女|儿童|老人|character|portrait|person|actor/i },
    { category: /场景|背景|scene|background/i, clues: /场景|背景|室内|室外|街道|建筑|城市|森林|房间|scene|background|street|city|room|landscape/i },
    { category: /道具|物品|props?/i, clues: /道具|物品|武器|车辆|汽车|服装|家具|食物|prop|weapon|vehicle|car|clothing|furniture/i },
    { category: /视频|video/i, clues: /video|视频|镜头|shot|clip/i },
    { category: /音频|音效|配音|audio/i, clues: /audio|音频|音效|配音|music|voice|sound/i },
  ];
  const matchingGroup = groups.find((group) => group.clues.test(searchable));
  if (!matchingGroup) return null;
  return categories.find((category) => matchingGroup.category.test(category.name))?.id ?? null;
}

export const useAssetLibraryStore = create<AssetLibraryStore>((set, get) => ({
  ...defaultState(),
  isHydrated: false,

  hydrate: async () => {
    if (get().isHydrated) return;
    try {
      let state = isTauri() ? await loadAssetLibraryState() : readBrowserState();
      state = normalizeState(state);
      if (state.assets.length === 0) {
        const migrated = legacyMigration();
        if (migrated) {
          state = migrated;
          persist(state);
        }
      }
      set({ ...state, isHydrated: true });
    } catch (error) {
      console.warn('[assetLibrary] hydrate failed', error);
      set({ ...readBrowserState(), isHydrated: true });
    }
  },

  setActiveLibrary: (libraryId) => {
    const state = get();
    if (!state.libraries.some((library) => library.id === libraryId)) return;
    updateStore(set, { ...state, activeLibraryId: libraryId });
  },

  createLibrary: (name) => {
    const state = get();
    const now = Date.now();
    const library: AssetLibrary = {
      id: createId('library'),
      name: name.trim() || '新素材库',
      createdAt: now,
    };
    const category: AssetCategory = {
      id: createId('category'),
      libraryId: library.id,
      name: '默认分组',
      createdAt: now,
    };
    updateStore(set, {
      ...state,
      libraries: [...state.libraries, library],
      categories: [...state.categories, category],
      activeLibraryId: library.id,
    });
    return library.id;
  },

  renameLibrary: (libraryId, name) => {
    const state = get();
    const value = name.trim();
    if (!value) return;
    updateStore(set, {
      ...state,
      libraries: state.libraries.map((library) =>
        library.id === libraryId ? { ...library, name: value } : library
      ),
    });
  },

  deleteLibrary: (libraryId) => {
    const state = get();
    if (state.libraries.length <= 1) return;
    const libraries = state.libraries.filter((library) => library.id !== libraryId);
    updateStore(set, {
      libraries,
      categories: state.categories.filter((category) => category.libraryId !== libraryId),
      assets: state.assets.filter((asset) => asset.libraryId !== libraryId),
      activeLibraryId: state.activeLibraryId === libraryId ? libraries[0].id : state.activeLibraryId,
    });
  },

  addAssets: (assets) => {
    const state = get();
    updateStore(set, { ...state, assets: [...state.assets, ...assets] });
  },

  deleteAssets: (assetIds) => {
    const ids = new Set(assetIds);
    const state = get();
    updateStore(set, { ...state, assets: state.assets.filter((asset) => !ids.has(asset.id)) });
  },

  renameAsset: (assetId, name) => {
    const value = name.trim();
    if (!value) return;
    const state = get();
    updateStore(set, {
      ...state,
      assets: state.assets.map((asset) => asset.id === assetId ? { ...asset, name: value } : asset),
    });
  },

  setAssetTags: (assetId, tags) => {
    const state = get();
    const normalizedTags = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
    updateStore(set, {
      ...state,
      assets: state.assets.map((asset) => asset.id === assetId ? { ...asset, tags: normalizedTags } : asset),
    });
  },

  classifyAssets: (assetIds) => {
    const ids = new Set(assetIds);
    const state = get();
    let changed = 0;
    const assets = state.assets.map((asset) => {
      if (!ids.has(asset.id)) return asset;
      const targetCategoryId = suggestCategoryId(
        asset,
        state.categories.filter((category) => category.libraryId === asset.libraryId)
      );
      if (!targetCategoryId || targetCategoryId === asset.categoryId) return asset;
      changed += 1;
      return { ...asset, categoryId: targetCategoryId };
    });
    if (changed > 0) updateStore(set, { ...state, assets });
    return changed;
  },

  addCategory: (libraryId, name, parentId) => {
    const state = get();
    const category: AssetCategory = {
      id: createId('category'),
      libraryId,
      name: name.trim() || '新分组',
      parentId: parentId || null,
      createdAt: Date.now(),
    };
    updateStore(set, { ...state, categories: [...state.categories, category] });
    return category.id;
  },

  renameCategory: (categoryId, name) => {
    const value = name.trim();
    if (!value) return;
    const state = get();
    updateStore(set, {
      ...state,
      categories: state.categories.map((category) =>
        category.id === categoryId ? { ...category, name: value } : category
      ),
    });
  },

  deleteCategory: (categoryId) => {
    const state = get();
    // 收集该分组及所有子分组的 id
    const idsToDelete = new Set<string>([categoryId]);
    let changed = true;
    while (changed) {
      changed = false;
      state.categories.forEach((category) => {
        if (category.parentId && idsToDelete.has(category.parentId) && !idsToDelete.has(category.id)) {
          idsToDelete.add(category.id);
          changed = true;
        }
      });
    }
    updateStore(set, {
      ...state,
      categories: state.categories.filter((category) => !idsToDelete.has(category.id)),
      assets: state.assets.map((asset) =>
        asset.categoryId && idsToDelete.has(asset.categoryId) ? { ...asset, categoryId: null } : asset
      ),
    });
  },

  moveAssetsToCategory: (assetIds, categoryId) => {
    const ids = new Set(assetIds);
    const state = get();
    const target = categoryId ? state.categories.find((category) => category.id === categoryId) : null;
    if (categoryId && !target) return;
    updateStore(set, {
      ...state,
      assets: state.assets.map((asset) =>
        ids.has(asset.id) && (!target || asset.libraryId === target.libraryId)
          ? { ...asset, categoryId }
          : asset
      ),
    });
  },
}));

export type { LibraryAsset };
