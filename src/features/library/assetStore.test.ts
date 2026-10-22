import { beforeEach, describe, expect, it } from 'vitest';

import { useAssetLibraryStore } from './assetStore';
import type { LibraryAsset } from './types';

function seedAsset(overrides: Partial<LibraryAsset> = {}): LibraryAsset {
  return {
    id: 'asset-1',
    libraryId: 'library-default',
    categoryId: null,
    name: '画布图片 10:08:32',
    mediaType: 'image',
    sourcePath: 'data:image/png;base64,AAAA',
    previewImageUrl: null,
    aspectRatio: '1:1',
    sourceFileName: 'canvas-image-1759123456789.png',
    tags: [],
    createdAt: 0,
    ...overrides,
  };
}

function currentAsset(): LibraryAsset {
  const asset = useAssetLibraryStore.getState().assets.find((item) => item.id === 'asset-1');
  if (!asset) throw new Error('asset missing');
  return asset;
}

describe('素材库重命名', () => {
  beforeEach(() => {
    useAssetLibraryStore.setState({
      libraries: [{ id: 'library-default', name: '我的素材库', createdAt: 0 }],
      categories: [],
      assets: [seedAsset()],
      activeLibraryId: 'library-default',
      isHydrated: true,
    });
  });

  it('素材名与「原始文件名」同步改名', async () => {
    await useAssetLibraryStore.getState().renameAsset('asset-1', '商品头图');

    const asset = currentAsset();
    expect(asset.name).toBe('商品头图');
    expect(asset.sourceFileName).toBe('商品头图.png');
  });

  it('连着扩展名一起改也不会落成双扩展名', async () => {
    await useAssetLibraryStore.getState().renameAsset('asset-1', '商品头图.png');

    const asset = currentAsset();
    expect(asset.name).toBe('商品头图');
    expect(asset.sourceFileName).toBe('商品头图.png');
  });

  it('空名字不生效', async () => {
    await useAssetLibraryStore.getState().renameAsset('asset-1', '   ');
    expect(currentAsset().name).toBe('画布图片 10:08:32');
  });

  it('视频素材按原扩展名同步', async () => {
    useAssetLibraryStore.setState({
      assets: [
        seedAsset({
          mediaType: 'video',
          sourcePath: 'data:video/mp4;base64,AAAA',
          sourceFileName: 'canvas-video-1759123456789.mp4',
        }),
      ],
    });

    await useAssetLibraryStore.getState().renameAsset('asset-1', '开场镜头');

    const asset = currentAsset();
    expect(asset.name).toBe('开场镜头');
    expect(asset.sourceFileName).toBe('开场镜头.mp4');
  });
});
