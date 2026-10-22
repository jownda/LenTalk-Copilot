/**
 * 候选卡片的展示顺序 —— **最新创建的排在最上面**。
 *
 * 三个候选框（场景站位 / 场景角色候选 / 道具）与工作台侧的候选共用这一条规则。
 *
 * ⚠️ **不能按 `createdAt` 排**：候选里的图片全是「电影资产镜像条目」，
 * `cinematicMirrorSync.ts` 里它们的 `createdAt` 写死是 `0` —— 按时间戳降序排出来
 * 全部相等，表面上就是「改了什么都没发生」。
 *
 * 依据是**数据源的数组顺序**，因为它就是创建顺序：
 * - 素材库：`assetStore.upsertAssets` 是 `[...retained, ...assets]`（追加到末尾）
 * - 工程资产：`projectReducer` 是 `[...(state.assets ?? []), created]`（同样是追加）
 *
 * 倒过来即最新在前。
 *
 * **返回新数组**：`items` 是 `useMemo` 出来的共享引用，`reverse()` 会原地改掉它，
 * 连带污染上游数组。
 */
export function sortQuickAssetItemsNewestFirst<T>(items: T[]): T[] {
  return items.slice().reverse();
}
