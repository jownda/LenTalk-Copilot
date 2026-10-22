/**
 * 视频节点的「在跑任务」记账。
 *
 * 允许连点之后，一个源视频节点可以同时有多个下游任务在跑，所以要按列表记账；
 * 但单任务时代（提交后锁到下游终态）存的是单个 `activeGenerationNodeId`，
 * 旧工程重启后仍需能把「生成中」状态恢复出来，因此读取时要兼容两种形态。
 *
 * 优先级：只要出现过新字段（数组），就以它为准——新代码每次写入都会把旧字段置空，
 * 所以「数组存在」意味着这份数据已经是新形态，此时旧字段即便有残留也不可信。
 */
export interface ActiveGenerationTrackingData {
  activeGenerationNodeIds?: unknown;
  activeGenerationNodeId?: unknown;
}

/**
 * 入参放宽成 unknown: 调用点从 store 里取到的是 `CanvasNodeData` 联合类型，
 * 多数成员并没有这两个字段，写成结构化参数会被 TS 的弱类型检查挡下来。
 */
export function collectActiveGenerationNodeIds(data: unknown): string[] {
  if (!data || typeof data !== 'object') return [];
  const record = data as ActiveGenerationTrackingData;
  const list = record.activeGenerationNodeIds;
  if (Array.isArray(list)) {
    return list.filter((value): value is string => typeof value === 'string' && value.length > 0);
  }
  const legacy = record.activeGenerationNodeId;
  return typeof legacy === 'string' && legacy.length > 0 ? [legacy] : [];
}
