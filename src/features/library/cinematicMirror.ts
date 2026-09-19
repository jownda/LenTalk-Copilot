/**
 * 电影工作室镜像资产：画布素材库里的 `cinematic-*` 条目 ↔ 电影资产（角色 / 地点 / 道具）。
 *
 * 提示词工作室会把工程里的资产镜像进画布素材库，节点上的「场景站位 / 场景角色候选」
 * 就从这个镜像里取候选。镜像字段（cinematicAssetId / cinematicKind）必须能安全往返：
 * 旧数据落库时曾被静默丢弃（Rust 结构体未声明这些字段），因此这里对特征做兜底推导，
 * 保证「镜像条目 → 电影资产 id / 类别」在所有数据形态下都得出同一结果。
 */
import type { LibraryAsset } from './types';

export type CinematicAssetKind = 'character' | 'location' | 'prop' | 'audio-reference';

/** 镜像条目 id 形如 `cinematic-<电影资产 id>-<参考图序号>`。 */
const MIRROR_ID_PATTERN = /^cinematic-(.+)-\d+$/;

/** 兜底：镜像时写入的内置分类 id。 */
const KIND_BY_CATEGORY_ID: Record<string, CinematicAssetKind> = {
  'category-characters': 'character',
  'category-scenes': 'location',
  'category-props': 'prop',
  'category-audio': 'audio-reference',
};

/** 兜底：镜像时写入的标记标签。 */
const KIND_BY_TAG: Record<string, CinematicAssetKind> = {
  角色: 'character',
  场景: 'location',
  道具: 'prop',
  音频: 'audio-reference',
};

/** 是否为电影工作室镜像进素材库的条目（而非用户自己导入的素材）。 */
export function isCinematicMirrorAsset(asset: Pick<LibraryAsset, 'id' | 'cinematicAssetId'>): boolean {
  return Boolean(asset.cinematicAssetId?.trim()) || MIRROR_ID_PATTERN.test(asset.id.trim());
}

/**
 * 从镜像条目 id 反推电影资产 id。
 * 旧数据落库时 `cinematicAssetId` 可能缺失，但条目 id 的形态一直稳定。
 */
export function cinematicAssetIdFromMirrorId(id: string): string {
  const mirrored = MIRROR_ID_PATTERN.exec(id.trim());
  return mirrored ? mirrored[1] : id.trim();
}

/**
 * 同一个电影资产可能有多张参考图（镜像成多条素材库条目），
 * 它们必须映射到同一个 id —— 否则候选会被去重逻辑重复列出，
 * 且已选中的 id 会随数据形态变化而失效。
 */
export function cinematicAssetKey(asset: LibraryAsset): string {
  const explicit = asset.cinematicAssetId?.trim();
  if (explicit) return explicit;
  return cinematicAssetIdFromMirrorId(asset.id);
}

export function cinematicAssetKind(asset: LibraryAsset): CinematicAssetKind | null {
  if (asset.cinematicKind) return asset.cinematicKind;
  // 只有镜像条目才参与推导：用户自己导入的素材可能被随手放进「场景 / 角色」分类，
  // 不能凭分类把它们当成电影资产。
  if (!isCinematicMirrorAsset(asset)) return null;
  // 优先用镜像自己写入的标记标签，分类可能被用户移动过。
  const tag = asset.tags.find((item) => KIND_BY_TAG[item]);
  if (tag) return KIND_BY_TAG[tag];
  return asset.categoryId ? KIND_BY_CATEGORY_ID[asset.categoryId] ?? null : null;
}

export function cinematicAssetDescription(asset: LibraryAsset): string {
  return asset.cinematicDescriptionZh?.trim()
    || asset.cinematicDescription?.trim()
    || asset.tags.filter(Boolean).join('、');
}

/** 某个类别下可用的图片资产，同一电影资产只保留首张。 */
export function cinematicImageAssets(assets: LibraryAsset[], kind: CinematicAssetKind): LibraryAsset[] {
  const seen = new Set<string>();
  return assets.filter((asset) => {
    if (asset.mediaType !== 'image' || !asset.sourcePath.trim()) return false;
    if (cinematicAssetKind(asset) !== kind) return false;
    const key = cinematicAssetKey(asset);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 用户可手工引用的素材库音频（角色声音音色等），新导入的排在前面。
 * 排除电影资产镜像条目：那些由工程自动同步，手工引用会绕成环。
 */
export function pickableAudioAssets(assets: LibraryAsset[]): LibraryAsset[] {
  return assets
    .filter((asset) => asset.mediaType === 'audio' && Boolean(asset.sourcePath.trim()) && !isCinematicMirrorAsset(asset))
    .sort((left, right) => right.createdAt - left.createdAt);
}
