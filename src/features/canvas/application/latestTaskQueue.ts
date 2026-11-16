/**
 * 「只跑最新一帧」的任务队列。
 *
 * 拖滑块时事件每 16ms 就来一次。如果每次都排队算，队列会越拖越长、画面落后手指；
 * 如果像以前那样做防抖（每次事件都重置计时器），拖动期间计时器永远不到点 ——
 * 表现就是「松手才更新」。
 *
 * 这里的规则是：**立刻开工，算完只认最新的那个参数**，中间值直接丢掉。
 * 于是每一帧都基于手指当前位置出图，视觉上就是连续线性的。
 */
export interface LatestTaskQueue<T> {
  push(task: T): void;
  clear(): void;
  /** 测试用：当前是否有任务在跑 */
  isBusy(): boolean;
}

export function createLatestTaskQueue<T>(worker: (task: T) => Promise<void> | void): LatestTaskQueue<T> {
  let pending: T | null = null;
  let hasPending = false;
  let busy = false;

  const pump = () => {
    if (busy || !hasPending) return;
    const task = pending as T;
    pending = null;
    hasPending = false;
    busy = true;
    Promise.resolve()
      .then(() => worker(task))
      .catch(() => {
        /* 失败不该卡住队列，worker 内部自己留痕 */
      })
      .finally(() => {
        busy = false;
        pump();
      });
  };

  return {
    push(task: T) {
      pending = task;
      hasPending = true;
      pump();
    },
    clear() {
      pending = null;
      hasPending = false;
    },
    isBusy() {
      return busy;
    },
  };
}
