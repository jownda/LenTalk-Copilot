/**
 * 电影资产 → 画布素材库的镜像同步（唯一实现）。
 *
 * 提示词工作室节点上的「场景站位 / 场景角色候选」只认素材库里的**镜像条目**
 * （筛选规则见 `cinematicMirror.ts`：必须带 cinematicAssetId / cinematicKind，
 * 且 mediaType === 'image'、sourcePath 非空）。镜像条目唯一的来源就是这里。
 *
 * 这段逻辑原先内联在工作室 App 的一个 effect 里，于是只有「工作室正开着」时才会同步：
 * 用户从画布侧边栏「资产库」tab 维护资产（此时工作室未挂载，面板走自持项目模式）
 * 永远进不了节点候选 —— 表现为「资产库里明明有，节点点 + 却选不到」。
 *
 * 抽出为共享模块后，两条写入路径（工作室 App、侧边栏面板）共用同一份实现；
 * 判断逻辑（展开 / 过期清理）是纯函数，可直接单测。
 */
import type { Asset } from '@/features/cinematicStudio/shared-types';
import { useAssetLibraryStore } from './assetStore';
import type { AssetCategory, LibraryAsset } from './types';

/** 镜像条目 id 前缀：只有本模块会写入，清理过期条目时也只认这个前缀。 */
export const CINEMATIC_MIRROR_ID_PREFIX = 'cinematic-';

/**
 * 镜像条目固定携带的标记标签。
 * `cinematicMirror.cinematicAssetKind()` 在 cinematicKind 缺失时会读它做兜底推导，
 * 因此这个字面量不能随意改。
 */
export const CINEMATIC_MIRROR_TAG = '电影资产';

/** 资产类别 → 素材库内置分类名。 */
const CATEGORY_NAME_BY_KIND: Record<string, string> = {
  character: '角色',
  location: '场景',
  prop: '道具',
  'audio-reference': '音频',
};

export interface CinematicMirrorContext {
  libraryId: string;
  categories: AssetCategory[];
}

/**
 * 纯函数：把电影工程资产展开为素材库镜像条目。
 *
 * 同一个资产的多张参考图会展开成多条条目，但共用同一个 cinematicAssetId
 * —— 候选取用时会按该 id 去重（`cinematicMirror.cinematicAssetKey`）。
 * 角色的声音音色（voiceClip）作为最后一条追加，标记为 audio。
 */
export function buildCinematicMirrorAssets(
  cinematicAssets: Asset[],
  context: CinematicMirrorContext,
): LibraryAsset[] {
  const categoryIdByName = new Map<string, string>();
  for (const category of context.categories) {
    if (category.libraryId === context.libraryId) categoryIdByName.set(category.name, category.id);
  }

  const mirrored: LibraryAsset[] = [];
  for (const asset of cinematicAssets) {
    const isAudioReference = asset.kind === 'audio-reference';
    const sources = [...(asset.referencePaths ?? [])];
    if (asset.kind === 'character' && asset.voiceClip?.trim()) sources.push(asset.voiceClip);

    sources.filter(Boolean).forEach((source, index) => {
      const isVoiceClip = asset.kind === 'character'
        && index === sources.length - 1
        && asset.voiceClip === source;
      const categoryName = CATEGORY_NAME_BY_KIND[asset.kind] ?? '道具';
      mirrored.push({
        id: `${CINEMATIC_MIRROR_ID_PREFIX}${asset.id}-${index}`,
        libraryId: context.libraryId,
        categoryId: categoryIdByName.get(categoryName) ?? null,
        // 多张参考图仍属于同一个电影资产，名称必须与工程资产一致；
        // 序号只体现在条目 id 与图片顺序上，不能污染候选和最终提示词里的 @标签。
        name: asset.name || '未命名资产',
        mediaType: isVoiceClip || isAudioReference ? 'audio' : 'image',
        sourcePath: source,
        previewImageUrl: isVoiceClip || isAudioReference ? null : source,
        aspectRatio: isVoiceClip || isAudioReference ? null : '1:1',
        sourceFileName: null,
        tags: [CINEMATIC_MIRROR_TAG, categoryName],
        createdAt: 0,
        cinematicAssetId: asset.id,
        cinematicKind: asset.kind === 'character' || asset.kind === 'location' || asset.kind === 'prop' || asset.kind === 'audio-reference'
          ? asset.kind
          : undefined,
        cinematicDescription: asset.description,
        cinematicDescriptionZh: asset.descriptionZh,
        cinematicNotes: asset.notesZh || asset.notes,
      });
    });
  }
  return mirrored;
}

/** 纯函数：本次未再生成的旧镜像条目 id（资产已删除或参考图被移除）。 */
export function resolveStaleMirrorIds(
  existingIds: readonly string[],
  mirroredIds: readonly string[],
): string[] {
  const keep = new Set(mirroredIds);
  return existingIds.filter((id) => id.startsWith(CINEMATIC_MIRROR_ID_PREFIX) && !keep.has(id));
}

/**
 * 副作用：读取素材库 store 并完成一次完整同步（幂等，可重复调用）。
 *
 * 两种情况下直接返回，且**绝不清理**已有镜像：
 * - 素材库尚未 hydrate —— 空列表会被误判成「资产已删除」，把镜像条目整批清掉；
 * - 传入的资产列表为空 —— 同上，避免上游数据还没加载完就误删。
 */
export function syncCinematicMirrorAssets(cinematicAssets: Asset[]): void {
  if (cinematicAssets.length === 0) return;
  const state = useAssetLibraryStore.getState();
  if (!state.isHydrated) return;
  const libraryId = state.activeLibraryId || state.libraries[0]?.id;
  if (!libraryId) return;

  const mirrored = buildCinematicMirrorAssets(cinematicAssets, {
    libraryId,
    categories: state.categories,
  });
  const staleIds = resolveStaleMirrorIds(
    state.assets.map((asset) => asset.id),
    mirrored.map((asset) => asset.id),
  );
  if (staleIds.length > 0) state.deleteAssets(staleIds);
  state.upsertAssets(mirrored);
}
