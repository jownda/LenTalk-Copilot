import { CURRENT_RUNTIME_SESSION_ID } from "./generationErrorReport";

/**
 * 「生成并创建视频」的进行中标记能存活多久。
 * 同一个运行时里提示词 Agent 正常跑不了这么久, 超出即按残留标记处理,
 * 免得按钮被永久锁在「生成中…」。
 */
export const QUICK_GENERATION_STALE_MS = 15 * 60 * 1000;

/**
 * 判断「生成并创建视频」的进行中标记是否仍属于**本次**运行时。
 *
 * 为什么必须能重算: 画布开了 `onlyRenderVisibleElements`, 节点移出视口就会被卸载,
 * 组件里的 `useState` 会丢 —— 用户把节点拖出画布再拖回来, 按钮就谎报空闲,
 * 而提示词 Agent 其实还在跑。所以判定只依赖两个落库字段。
 *
 * 为什么要会话 id: 上一次运行留下的标记说明那次调用早已随进程结束,
 * 光看时间戳会让「重启后 15 分钟内」都误显示成生成中。
 */
export function isQuickGenerationRunActive(
  startedAt: unknown,
  sessionId: unknown,
  now: number = Date.now(),
  currentSessionId: string = CURRENT_RUNTIME_SESSION_ID,
): boolean {
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt) || startedAt <= 0) {
    return false;
  }
  if (typeof sessionId !== "string" || !sessionId || sessionId !== currentSessionId) {
    return false;
  }
  return now - startedAt < QUICK_GENERATION_STALE_MS;
}
