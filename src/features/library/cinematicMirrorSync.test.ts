import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Asset, AssetKind } from '../cinematicStudio/shared-types';
import { useAssetLibraryStore } from './assetStore';
import { cinematicImageAssets } from './cinematicMirror';
import {
  buildCinematicMirrorAssets,
  resolveStaleMirrorIds,
  syncCinematicMirrorAssets,
} from './cinematicMirrorSync';
import type { AssetCategory, LibraryAsset } from './types';

// 项目 vitest 固定跑 node 环境（未装 jsdom），而 assetStore 每次变更都会持久化，
// 缺 localStorage 会打出一条 persist failed 噪音。这里补最小实现；
// 断言只看内存态，不依赖它。
const memoryStorage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => memoryStorage.get(key) ?? null,
  setItem: (key: string, value: string) => { memoryStorage.set(key, value); },
  removeItem: (key: string) => { memoryStorage.delete(key); },
  clear: () => { memoryStorage.clear(); },
  key: (index: number) => [...memoryStorage.keys()][index] ?? null,
  get length() { return memoryStorage.size; },
});

const LIBRARY_ID = 'library-default';

const CATEGORIES: AssetCategory[] = [
  { id: 'category-characters', libraryId: LIBRARY_ID, name: '角色', createdAt: 0 },
  { id: 'category-scenes', libraryId: LIBRARY_ID, name: '场景', createdAt: 0 },
  { id: 'category-props', libraryId: LIBRARY_ID, name: '道具', createdAt: 0 },
];

const CONTEXT = { libraryId: LIBRARY_ID, categories: CATEGORIES };

function cinematicAsset(overrides: Partial<Asset> & { id: string; kind: AssetKind }): Asset {
  return {
    name: 'Rebecca',
    description: '',
    referencePaths: [],
    lockLevel: 'none',
    tags: [],
    ...overrides,
  } as Asset;
}

function staleMirror(id: string): LibraryAsset {
  return {
    libraryId: LIBRARY_ID,
    categoryId: 'category-characters',
    name: '旧镜像',
    mediaType: 'image',
    sourcePath: '/stale.png',
    tags: ['电影资产', '角色'],
    createdAt: 0,
    id,
  } as LibraryAsset;
}

beforeEach(() => {
  useAssetLibraryStore.setState({
    isHydrated: false,
    libraries: [],
    categories: [],
    assets: [],
    activeLibraryId: '',
  });
});

describe('buildCinematicMirrorAssets', () => {
  it('skips assets that have no reference image yet', () => {
    // 「资产库里新建了资产，但节点 + 里没有」最常见的原因就是这条：
    // 新建出来的资产 referencePaths 为空，而节点候选只认有图的条目。
    const mirrored = buildCinematicMirrorAssets(
      [cinematicAsset({ id: 'c1', kind: 'character' })],
      CONTEXT,
    );
    expect(mirrored).toEqual([]);
  });

  it('expands each reference image into one entry sharing the cinematic asset id', () => {
    const mirrored = buildCinematicMirrorAssets(
      [cinematicAsset({ id: 'c1', kind: 'character', referencePaths: ['/a.png', '/b.png'] })],
      CONTEXT,
    );
    expect(mirrored.map((asset) => asset.id)).toEqual(['cinematic-c1-0', 'cinematic-c1-1']);
    // 同一个电影资产的多张参考图必须共用 cinematicAssetId，否则候选去重会重复列出。
    expect(new Set(mirrored.map((asset) => asset.cinematicAssetId))).toEqual(new Set(['c1']));
    expect(mirrored.every((asset) => asset.cinematicKind === 'character')).toBe(true);
    expect(mirrored.every((asset) => asset.categoryId === 'category-characters')).toBe(true);
    expect(mirrored.every((asset) => asset.mediaType === 'image')).toBe(true);
  });

  it('appends the character voice clip as an audio entry', () => {
    const mirrored = buildCinematicMirrorAssets(
      [cinematicAsset({
        id: 'c1',
        kind: 'character',
        referencePaths: ['/a.png'],
        voiceClip: 'data:audio/mpeg;base64,AAAA',
      })],
      CONTEXT,
    );
    expect(mirrored).toHaveLength(2);
    expect(mirrored[0].mediaType).toBe('image');
    expect(mirrored[1].mediaType).toBe('audio');
    expect(mirrored[1].previewImageUrl).toBeNull();
  });

  it('maps location onto the 场景 category', () => {
    const mirrored = buildCinematicMirrorAssets(
      [cinematicAsset({ id: 'l1', kind: 'location', referencePaths: ['/room.png'] })],
      CONTEXT,
    );
    expect(mirrored[0].cinematicKind).toBe('location');
    expect(mirrored[0].categoryId).toBe('category-scenes');
  });

  it('falls back to the 道具 category when the kind has no built-in one', () => {
    const mirrored = buildCinematicMirrorAssets(
      [cinematicAsset({ id: 's1', kind: 'style-reference', referencePaths: ['/style.png'] })],
      CONTEXT,
    );
    expect(mirrored[0].categoryId).toBe('category-props');
    // 风格参考不是角色 / 地点 / 道具之一，不应被当成电影资产类别。
    expect(mirrored[0].cinematicKind).toBeUndefined();
  });

  it('produces entries the node candidate filter accepts', () => {
    // 端到端：这条断言正是本次修复要保证的效果 ——
    // 资产带上参考图后，节点上的「+」候选就能取到它。
    const mirrored = buildCinematicMirrorAssets(
      [cinematicAsset({ id: 'c1', kind: 'character', name: 'Rebecca', referencePaths: ['/a.png'] })],
      CONTEXT,
    );
    expect(cinematicImageAssets(mirrored, 'character').map((asset) => asset.name)).toEqual(['Rebecca']);
  });
});

describe('resolveStaleMirrorIds', () => {
  it('only drops mirror-prefixed ids that are no longer generated', () => {
    expect(
      resolveStaleMirrorIds(
        ['cinematic-gone-0', 'cinematic-keep-0'],
        ['cinematic-keep-0'],
      ),
    ).toEqual(['cinematic-gone-0']);
  });

  it('never touches user-imported assets', () => {
    expect(resolveStaleMirrorIds(['asset-user-1', 'upstream-scene-0'], [])).toEqual([]);
  });
});

describe('syncCinematicMirrorAssets', () => {
  it('never clears mirrors before the shared library is hydrated', () => {
    // hydrate 之前 store 里的 assets 是空的，不能据此认定「镜像已过期」而清空。
    useAssetLibraryStore.setState({
      isHydrated: false,
      libraries: [{ id: LIBRARY_ID, name: '默认素材库', createdAt: 0 }],
      categories: CATEGORIES,
      assets: [staleMirror('cinematic-old-0')],
      activeLibraryId: LIBRARY_ID,
    });
    syncCinematicMirrorAssets([cinematicAsset({ id: 'c1', kind: 'character', referencePaths: ['/a.png'] })]);
    expect(useAssetLibraryStore.getState().assets.map((asset) => asset.id)).toEqual(['cinematic-old-0']);
  });

  it('leaves the library untouched when the cinematic asset list is empty', () => {
    useAssetLibraryStore.setState({
      isHydrated: true,
      libraries: [{ id: LIBRARY_ID, name: '默认素材库', createdAt: 0 }],
      categories: CATEGORIES,
      assets: [staleMirror('cinematic-old-0')],
      activeLibraryId: LIBRARY_ID,
    });
    syncCinematicMirrorAssets([]);
    expect(useAssetLibraryStore.getState().assets.map((asset) => asset.id)).toEqual(['cinematic-old-0']);
  });

  it('writes mirror entries and drops the ones that went away', () => {
    useAssetLibraryStore.setState({
      isHydrated: true,
      libraries: [{ id: LIBRARY_ID, name: '默认素材库', createdAt: 0 }],
      categories: CATEGORIES,
      assets: [staleMirror('cinematic-old-0')],
      activeLibraryId: LIBRARY_ID,
    });
    syncCinematicMirrorAssets([
      cinematicAsset({ id: 'c1', kind: 'character', referencePaths: ['/a.png'] }),
    ]);
    const state = useAssetLibraryStore.getState();
    expect(state.assets.map((asset) => asset.id)).toEqual(['cinematic-c1-0']);
    expect(cinematicImageAssets(state.assets, 'character')).toHaveLength(1);
  });

  it('picks the asset up on the next sync once a reference image is added', () => {
    // 用户的实际路径：资产库里新建资产（此时 referencePaths 为空）→ 点节点 + 看不到
    // → 进高级编辑重选一遍。补图之后不需要重开工作室、也不需要重进高级编辑：
    // 下一次同步（资产变更即触发）就应把镜像写进去，节点候选随之出现。
    useAssetLibraryStore.setState({
      isHydrated: true,
      libraries: [{ id: LIBRARY_ID, name: '默认素材库', createdAt: 0 }],
      categories: CATEGORIES,
      assets: [],
      activeLibraryId: LIBRARY_ID,
    });

    const draft = cinematicAsset({ id: 'p1', kind: 'prop', name: '旧怀表' });
    syncCinematicMirrorAssets([draft]);
    expect(useAssetLibraryStore.getState().assets).toEqual([]);

    // UPDATE_ASSET 之后的形态：同一资产带上参考图（reducer 会返回新的 project 引用，
    // 于是依赖 project.assets 的同步 effect 重新执行）。
    syncCinematicMirrorAssets([{ ...draft, referencePaths: ['/watch.png'] }]);
    const after = useAssetLibraryStore.getState().assets;
    expect(after.map((asset) => asset.id)).toEqual(['cinematic-p1-0']);
    expect(cinematicImageAssets(after, 'prop').map((asset) => asset.name)).toEqual(['旧怀表']);
  });

  it('keeps one candidate when more reference images are added', () => {
    // 在资产库里继续补图会让镜像条目变多，但候选必须仍只列一条 ——
    // 否则用户每加一张图，节点 + 里就会多出一个同名项。
    useAssetLibraryStore.setState({
      isHydrated: true,
      libraries: [{ id: LIBRARY_ID, name: '默认素材库', createdAt: 0 }],
      categories: CATEGORIES,
      assets: [],
      activeLibraryId: LIBRARY_ID,
    });

    syncCinematicMirrorAssets([cinematicAsset({ id: 'c1', kind: 'character', referencePaths: ['/a.png'] })]);
    syncCinematicMirrorAssets([
      cinematicAsset({ id: 'c1', kind: 'character', referencePaths: ['/a.png', '/b.png'] }),
    ]);

    const state = useAssetLibraryStore.getState();
    expect(state.assets.map((asset) => asset.id)).toEqual(['cinematic-c1-0', 'cinematic-c1-1']);
    expect(cinematicImageAssets(state.assets, 'character')).toHaveLength(1);
  });

  it('is idempotent across repeated runs', () => {
    useAssetLibraryStore.setState({
      isHydrated: true,
      libraries: [{ id: LIBRARY_ID, name: '默认素材库', createdAt: 0 }],
      categories: CATEGORIES,
      assets: [],
      activeLibraryId: LIBRARY_ID,
    });
    const assets = [cinematicAsset({ id: 'c1', kind: 'character', referencePaths: ['/a.png', '/b.png'] })];
    syncCinematicMirrorAssets(assets);
    syncCinematicMirrorAssets(assets);
    expect(useAssetLibraryStore.getState().assets.map((asset) => asset.id))
      .toEqual(['cinematic-c1-0', 'cinematic-c1-1']);
  });
});
