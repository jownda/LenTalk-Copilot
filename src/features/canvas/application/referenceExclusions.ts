import { mergeMediaReferenceSources } from '@/features/canvas/application/mediaReferenceSources';

/**
 * 剔除用户在本节点手动移除过的引用来源。
 *
 * 引用素材有两个入口: 节点自身的 `studioReference*` 附件, 以及上游连进来的
 * 节点媒体（`graphImageResolver` 会把上游提示词工作室的 `studioReferenceImages` /
 * `studioReferenceAudio` 当成输入喂进来）。只清空节点自身的附件是删不掉的 ——
 * 上游会把同一份素材持续喂回来, 最终仍会随请求上传给模型, 所以需要单独记账。
 */
export function filterExcludedReferences(
  sources: readonly string[],
  excluded: readonly string[],
): string[] {
  if (excluded.length === 0) return [...sources];
  const excludedSet = new Set(excluded);
  return sources.filter((source) => !excludedSet.has(source));
}

/** 合并「节点自身附件」与「上游喂入」的引用, 并应用本节点的移除记录。 */
export function resolveEffectiveReferences(
  direct: readonly unknown[] | undefined,
  upstream: readonly unknown[] | undefined,
  excluded: readonly string[],
): string[] {
  return filterExcludedReferences(mergeMediaReferenceSources(direct, upstream), excluded);
}
