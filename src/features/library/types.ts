export type AssetMediaType = 'image' | 'video' | 'audio';

export interface AssetLibrary {
  id: string;
  name: string;
  createdAt: number;
}

export interface AssetCategory {
  id: string;
  libraryId: string;
  name: string;
  /** 父分组 id,无则为顶级分组 */
  parentId?: string | null;
  createdAt: number;
}

export interface LibraryAsset {
  id: string;
  libraryId: string;
  categoryId: string | null;
  name: string;
  mediaType: AssetMediaType;
  sourcePath: string;
  previewImageUrl?: string | null;
  aspectRatio?: string | null;
  sourceFileName?: string | null;
  tags: string[];
  createdAt: number;
}

export interface AssetLibraryState {
  libraries: AssetLibrary[];
  categories: AssetCategory[];
  assets: LibraryAsset[];
  activeLibraryId: string;
}

export const ASSET_LIBRARY_STORAGE_KEY = 'storyboard-asset-library-v2';
export const ASSET_LIBRARY_MIME_PREFIX = 'application/x-storyboard-asset';
