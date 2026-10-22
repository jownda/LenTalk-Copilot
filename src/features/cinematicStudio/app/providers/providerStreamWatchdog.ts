/**
 * 上游流式响应的「看门狗」。
 *
 * 为什么需要: `request_provider_stream` 只在自己发现异常时才发 error 事件。如果
 * 事件丢失, 或者连接一直活着却再也不吐字节, 前端 `startPromise` / `reader.read()`
 * 会永远 pending —— 「提示词工作室 → 生成提示词」就锁死在「生成中…」, 用户既等不到
 * 结果也点不了第二次。看门狗保证每个阶段都有一条明确的时间上限。
 *
 * 两段计时:
 * 1. 等待响应头(start 事件): 健康中转的首字节通常 1~5 秒, 2 分钟仍无响应即是挂死;
 * 2. 收到响应头后连续没有新字节: 流式响应本该持续吐字节, 长时间静默说明渠道断了。
 *
 * 注意: 这里的「空闲」按**原始字节**算, 所以只推理、正文还没开始的模型(只吐
 * reasoning_content)不会被误杀 —— 只要有字节到达就会重置。
 */

/** 等响应头的上限: 2 分钟。 */
export const AI_STREAM_START_TIMEOUT_MS = 120_000;
/** 收到响应头后, 连续无新字节的上限: 2 分钟(与后端 read_timeout 对齐)。 */
export const AI_STREAM_IDLE_TIMEOUT_MS = 120_000;

export interface ProviderStreamWatchdogOptions {
  /** 超时回调。同一个看门狗只会回调一次, 直到下次 arm 重新计时。 */
  onTimeout: (message: string) => void;
  startTimeoutMs?: number;
  idleTimeoutMs?: number;
  /** 便于测试注入, 默认用全局 setTimeout / clearTimeout。 */
  setTimer?: (handler: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface ProviderStreamWatchdog {
  /** 开始等响应头。 */
  armStart: () => void;
  /** 收到一段数据, 把空闲计时重新拨满。 */
  touch: () => void;
  /** 结束(正常完成 / 出错 / 取消), 清掉计时。 */
  stop: () => void;
}

function secondsLabel(ms: number): string {
  return String(Math.max(1, Math.round(ms / 1000)));
}

export function createProviderStreamWatchdog({
  onTimeout,
  startTimeoutMs = AI_STREAM_START_TIMEOUT_MS,
  idleTimeoutMs = AI_STREAM_IDLE_TIMEOUT_MS,
  setTimer = (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimer = (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}: ProviderStreamWatchdogOptions): ProviderStreamWatchdog {
  let handle: unknown;

  const stop = () => {
    if (handle !== undefined) {
      clearTimer(handle);
      handle = undefined;
    }
  };

  const arm = (ms: number, message: string) => {
    stop();
    handle = setTimer(() => {
      handle = undefined;
      onTimeout(message);
    }, ms);
  };

  return {
    armStart: () =>
      arm(
        startTimeoutMs,
        `等待上游响应超时（${secondsLabel(startTimeoutMs)} 秒未收到响应头），已中断，可重试`,
      ),
    touch: () =>
      arm(
        idleTimeoutMs,
        `上游 ${secondsLabel(idleTimeoutMs)} 秒没有返回任何数据，已中断，可重试`,
      ),
    stop,
  };
}
