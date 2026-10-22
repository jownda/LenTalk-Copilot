import { describe, expect, it } from 'vitest';

import type { LibraryAsset } from './types';
import {
  cinematicAssetDescription,
  cinematicAssetIdFromMirrorId,
  cinematicAssetKey,
  cinematicAssetKind,
  cinematicImageAssets,
  isCinematicMirrorAsset,
  pickableAudioAssets,
} from './cinematicMirror';

/** 镜像条目：id 形如 cinematic-<电影资产 id>-<参考图序号>。 */
function mirror(overrides: Partial<LibraryAsset> & { id: string }): LibraryAsset {
  return {
    libraryId: 'library-default',
    categoryId: 'category-characters',
    name: '未命名素材',
    mediaType: 'image',
    sourcePath: '/assets/images/a.jpg',
    previewImageUrl: null,
    aspectRatio: '1:1',
    sourceFileName: null,
    tags: ['电影资产', '角色'],
    createdAt: 0,
    ...overrides,
  } as LibraryAsset;
}

const CHARACTER_ID = '2691e2b7-b5f0-45fd-8ebd-1074de0ad9ec';
const LOCATION_ID = '232685da-5992-436a-b835-3c1ee86a0d40';

describe('isCinematicMirrorAsset', () => {
  it('detects mirrors by explicit field or by the mirrored id', () => {
    expect(isCinematicMirrorAsset({ id: 'cinematic-x-0', cinematicAssetId: CHARACTER_ID })).toBe(true);
    expect(isCinematicMirrorAsset({ id: `cinematic-${CHARACTER_ID}-0` })).toBe(true);
  });

  it('rejects assets the user imported themselves', () => {
    expect(isCinematicMirrorAsset({ id: 'asset-438d583b-f96' })).toBe(false);
    expect(isCinematicMirrorAsset({ id: 'asset-438d583b-f96', cinematicAssetId: '  ' })).toBe(false);
  });
});

describe('cinematicAssetIdFromMirrorId', () => {
  it('reverses the mirrored id back to the cinematic asset id', () => {
    expect(cinematicAssetIdFromMirrorId(`cinematic-${CHARACTER_ID}-3`)).toBe(CHARACTER_ID);
    expect(cinematicAssetIdFromMirrorId(`  cinematic-${CHARACTER_ID}-0  `)).toBe(CHARACTER_ID);
  });

  it('leaves non-mirrored ids and upstream synthetic ids untouched', () => {
    // 上游素材的合成 id 不能反推成电影资产（否则描述兜底会张冠李戴）。
    expect(cinematicAssetIdFromMirrorId('upstream-scene-image-0-/a/b.png')).toBe('upstream-scene-image-0-/a/b.png');
    expect(cinematicAssetIdFromMirrorId('asset-438d583b-f96')).toBe('asset-438d583b-f96');
  });
});

describe('cinematicAssetKey', () => {
  it('prefers the explicit cinematicAssetId', () => {
    const asset = mirror({ id: 'cinematic-other-0', cinematicAssetId: CHARACTER_ID });
    expect(cinematicAssetKey(asset)).toBe(CHARACTER_ID);
  });

  it('derives the cinematic asset id from the mirrored id when the field was dropped', () => {
    // 落库时 cinematicAssetId 曾被 Rust 结构体静默丢弃，这里必须兜底反推，
    // 而且要与显式字段得出同一个 id，否则节点里已选的资产会失配。
    expect(cinematicAssetKey(mirror({ id: `cinematic-${CHARACTER_ID}-0` }))).toBe(CHARACTER_ID);
    expect(cinematicAssetKey(mirror({ id: `cinematic-${CHARACTER_ID}-12` }))).toBe(CHARACTER_ID);
  });

  it('keeps the plain id for assets that are not cinematic mirrors', () => {
    const asset = mirror({ id: 'asset-438d583b-f96', tags: [] });
    expect(cinematicAssetKey(asset)).toBe('asset-438d583b-f96');
  });
});

describe('cinematicAssetKind', () => {
  it('reads the explicit cinematicKind first', () => {
    expect(cinematicAssetKind(mirror({ id: 'cinematic-x-0', cinematicKind: 'prop', categoryId: 'category-scenes', tags: ['电影资产', '角色'] }))).toBe('prop');
  });

  it('falls back to the mirror tag, which is written by the mirror itself', () => {
    expect(cinematicAssetKind(mirror({ id: `cinematic-${CHARACTER_ID}-0`, tags: ['电影资产', '角色'] }))).toBe('character');
    expect(cinematicAssetKind(mirror({ id: `cinematic-${LOCATION_ID}-0`, categoryId: 'category-5a4125e0-7db', tags: ['电影资产', '场景'] }))).toBe('location');
    expect(cinematicAssetKind(mirror({ id: 'cinematic-p-0', categoryId: 'category-characters', tags: ['电影资产', '道具'] }))).toBe('prop');
  });

  it('falls back to the builtin category when the tags were edited', () => {
    expect(cinematicAssetKind(mirror({ id: `cinematic-${CHARACTER_ID}-0`, categoryId: 'category-characters', tags: ['电影资产'] }))).toBe('character');
    expect(cinematicAssetKind(mirror({ id: `cinematic-${LOCATION_ID}-0`, categoryId: 'category-scenes', tags: [] }))).toBe('location');
  });

  it('never classifies assets the user imported themselves, even inside a media category', () => {
    expect(cinematicAssetKind(mirror({ id: 'asset-1', categoryId: 'category-scenes', tags: ['电商'] }))).toBeNull();
    expect(cinematicAssetKind(mirror({ id: 'asset-2', categoryId: 'category-characters', tags: [] }))).toBeNull();
  });
});

describe('cinematicImageAssets', () => {
  const assets = [
    mirror({ id: `cinematic-${CHARACTER_ID}-0`, name: 'Rebecca' }),
    mirror({ id: `cinematic-${CHARACTER_ID}-1`, name: 'Rebecca 2' }),
    mirror({ id: `cinematic-${LOCATION_ID}-0`, name: '公寓楼前', categoryId: 'category-scenes', tags: ['电影资产', '场景'] }),
    mirror({ id: `cinematic-${CHARACTER_ID}-2`, mediaType: 'audio', sourcePath: '/assets/audio/v.m4a', name: 'Rebecca 音色' }),
    mirror({ id: 'asset-plain', name: '画布图片', categoryId: 'category-scenes', tags: [] }),
  ];

  it('lists one entry per cinematic asset and filters by kind', () => {
    expect(cinematicImageAssets(assets, 'character').map((asset) => asset.name)).toEqual(['Rebecca']);
    expect(cinematicImageAssets(assets, 'location').map((asset) => asset.name)).toEqual(['公寓楼前']);
  });

  it('ignores audio mirrors and plain library assets', () => {
    const names = cinematicImageAssets(assets, 'character').map((asset) => asset.name);
    expect(names).not.toContain('Rebecca 音色');
    expect(names).not.toContain('画布图片');
  });

  it('skips entries without a usable source path', () => {
    const broken = [mirror({ id: `cinematic-${CHARACTER_ID}-0`, sourcePath: '   ' })];
    expect(cinematicImageAssets(broken, 'character')).toEqual([]);
  });

  it('keys candidates with the same ids the compact node stored', () => {
    // 节点里已存的是电影资产 id 本身（如 2691e2b7-…）。镜像条目即使被落库丢掉字段，
    // 候选也必须推导出同一个 id，否则「已选中的角色」会显示不出来、还会重复出现在候选里。
    const nodeStored = ['2691e2b7-b5f0-45fd-8ebd-1074de0ad9ec', '0bbc305c-39bd-4744-b0bc-8e9af39c531a'];
    const assets = [
      mirror({ id: `cinematic-${nodeStored[0]}-0`, categoryId: 'category-characters', tags: ['电影资产', '角色'] }),
      mirror({ id: `cinematic-${nodeStored[0]}-1`, categoryId: 'category-characters', tags: ['电影资产', '角色'] }),
      mirror({ id: `cinematic-${nodeStored[1]}-0`, categoryId: 'category-characters', tags: ['电影资产', '角色'] }),
    ];

    const candidates = cinematicImageAssets(assets, 'character');
    expect(candidates.map(cinematicAssetKey)).toEqual(nodeStored);
    const selected = new Set(nodeStored);
    expect(candidates.every((asset) => selected.has(cinematicAssetKey(asset)))).toBe(true);
  });
});

describe('cinematicAssetDescription', () => {
  it('prefers the Chinese description, then English, then tags', () => {
    expect(cinematicAssetDescription(mirror({ id: 'cinematic-x-0', cinematicDescriptionZh: '中文' }))).toBe('中文');
    expect(cinematicAssetDescription(mirror({ id: 'cinematic-x-0', cinematicDescription: 'en' }))).toBe('en');
    expect(cinematicAssetDescription(mirror({ id: 'cinematic-x-0' }))).toBe('电影资产、角色');
  });
});

describe('pickableAudioAssets', () => {
  it('keeps user-imported audio, newest first, and drops mirrors, images and blank paths', () => {
    const assets = [
      mirror({ id: 'asset-old', mediaType: 'audio', sourcePath: '/audio/old.m4a', createdAt: 10 }),
      mirror({ id: 'asset-new', mediaType: 'audio', sourcePath: '/audio/new.m4a', createdAt: 30 }),
      mirror({ id: 'asset-mid', mediaType: 'audio', sourcePath: '/audio/mid.m4a', createdAt: 20 }),
      mirror({ id: `cinematic-${CHARACTER_ID}-1`, mediaType: 'audio', sourcePath: '/audio/mirror.m4a', createdAt: 40 }),
      mirror({ id: 'asset-image', mediaType: 'image', sourcePath: '/images/a.jpg', createdAt: 50 }),
      mirror({ id: 'asset-blank', mediaType: 'audio', sourcePath: '   ', createdAt: 60 }),
    ];

    expect(pickableAudioAssets(assets).map((asset) => asset.id)).toEqual(['asset-new', 'asset-mid', 'asset-old']);
  });
});
