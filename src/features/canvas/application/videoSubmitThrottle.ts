/**
 * 视频提交的「防误点」节流。
 *
 * 判据必须放在**模块级**而不是组件内：
 * 画布开了 `onlyRenderVisibleElements`，节点滚出视口就会卸载，组件内 ref 随之清零。
 * 用户滚回来时按钮已经"冷却结束"，手一抖就是第二单 —— 而视频一单几十秒到几分钟，
 * 这单往往还在跑，于是两个视频、两份钱。
 *
 * 同时**不能**把「有任务在跑」当成提交锁：用户明确要求「点一次生成一次，
 * 过几秒可以再点一次生成新的」。所以这里只管时间窗，不管任务数。
 */

/** 防误点的窗口：双击（<500ms）与手滑重复点击（<1.5s）都会被挡住，正常"过几秒再点"不受影响。 */
export const VIDEO_SUBMIT_COOLDOWN_MS = 2000;

/** nodeId → 上次真正提交的时刻（毫秒）。 */
const lastSubmitAtByNode = new Map<string, number>();

/** 真正发起提交时调用。校验失败不要调 —— 那种情况用户改完就能立刻重试。 */
export function markVideoSubmit(nodeId: string, now: number = Date.now()): void {
  lastSubmitAtByNode.set(nodeId, now);
}

/** 距离可以再次提交还剩多少毫秒；`0` = 现在就能点。 */
export function remainingVideoSubmitCooldown(nodeId: string, now: number = Date.now()): number {
  const last = lastSubmitAtByNode.get(nodeId);
  if (!last) {
    return 0;
  }
  return Math.max(0, VIDEO_SUBMIT_COOLDOWN_MS - (now - last));
}

/** 是否还在防误点窗口内（在这个窗口里的点击一律丢弃）。 */
export function isVideoSubmitThrottled(nodeId: string, now: number = Date.now()): boolean {
  return remainingVideoSubmitCooldown(nodeId, now) > 0;
}

/** 单测用：清空所有节点的节流记录。 */
export function resetVideoSubmitThrottle(): void {
  lastSubmitAtByNode.clear();
}
