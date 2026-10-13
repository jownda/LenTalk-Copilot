/**
 * 视频生成任务的「可取消窗口」记账 —— 只能在**请求还没送到平台**的那一段取消。
 *
 * 语义(与节点上的文案一致):
 *  - 点「生成」后, 下游结果节点立刻出现并进入生成中。此时请求还在本地: 素材要规整
 *    (本地图压成 data URL)、知鸟那类平台要先把素材上传换公网 URL、后端还要把请求体
 *    POST 出去。这一段中止**不会在平台留下任务、不会计费**, 所以允许「取消生成」。
 *  - 平台一旦受理(拿到 task_id、开始出片), 再取消只会把已经计费的结果丢掉, 因此按钮
 *    必须消失 —— 这是产品要求, 也是不产生"白扣费+成片丢失"的唯一安全边界。
 *
 * 窗口由两段拼成, 对外只暴露一个判据:
 *  1. 本进程内的提交流水线(prepare → 上传 → invoke)在跑 → 窗口开着;
 *  2. invoke 已返回 job id、但后端 `get_generate_video_job` 仍报 `cancelable: true`
 *     (请求还在飞) → 窗口继续开着。后端报 false / 报终态时由画布轮询关窗。
 *
 * 记账按**下游结果节点 id** 索引 —— 取消按钮长在那个节点上, 而"这次提交属于哪个节点"
 * 只有提交方(VideoGenNode)知道。
 *
 * 刻意**不**写进节点 data: 窗口是进程内的瞬时状态, 落库会让应用重启后把上一个进程
 * 早已送出的请求当成"还能取消", 反而误导用户。重启后窗口天然为空, 与后端一致
 * (后端的取消表也是内存态)。
 */

interface CancellationWindow {
  /** 用户是否已经点过「取消生成」。 */
  canceled: boolean;
}

const windows = new Map<string, CancellationWindow>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** 提交被用户取消时抛出的哨兵错误 —— 调用方据此走"已取消"而不是"失败"分支。 */
export class VideoGenerationCanceledError extends Error {
  constructor() {
    super("已取消生成");
    this.name = "VideoGenerationCanceledError";
  }
}

export function isVideoGenerationCanceledError(error: unknown): error is VideoGenerationCanceledError {
  return error instanceof VideoGenerationCanceledError;
}

/** 打开窗口: 下游节点已挂上画布、请求还没交出去。 */
export function openVideoCancellationWindow(nodeId: string): void {
  windows.set(nodeId, { canceled: false });
  emit();
}

/** 关窗: 平台已受理、提交失败、或提交被取消, 三种情况都不该再显示取消入口。 */
export function closeVideoCancellationWindow(nodeId: string): void {
  if (windows.delete(nodeId)) emit();
}

export function isVideoCancellationWindowOpen(nodeId: string): boolean {
  return windows.has(nodeId);
}

export function isVideoCancellationRequested(nodeId: string): boolean {
  return windows.get(nodeId)?.canceled === true;
}

/**
 * 用户点击「取消生成」。
 *
 * 返回 `false` 表示窗口已关闭(平台已经受理) —— 调用方不能假装取消成功。
 */
export function requestVideoCancellation(nodeId: string): boolean {
  const window = windows.get(nodeId);
  if (!window || window.canceled) return false;
  window.canceled = true;
  emit();
  return true;
}

/** 供 `useSyncExternalStore` 订阅。 */
export function subscribeVideoCancellation(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 提交流水线里的检查点: 窗口内用户已点取消就中止本次提交。
 *
 * 传空 nodeId(非画布节点发起的提交)时是 no-op。
 */
export function throwIfVideoSubmissionCanceled(nodeId: string | undefined | null): void {
  if (!nodeId) return;
  if (isVideoCancellationRequested(nodeId)) throw new VideoGenerationCanceledError();
}
