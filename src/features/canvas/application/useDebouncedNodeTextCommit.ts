import { useCallback, useEffect, useRef, type MutableRefObject } from "react";

import type { CanvasNodeData } from "@/features/canvas/domain/canvasNodes";

type UpdateNodeData = (nodeId: string, data: Partial<CanvasNodeData>) => void;

interface UseDebouncedNodeTextCommitOptions {
  nodeId: string;
  field: "prompt" | "purpose" | "content" | "optimizedPrompt";
  valueRef: MutableRefObject<string>;
  updateNodeData: UpdateNodeData;
  delayMs?: number;
}

/**
 * 当前挂着「已排期、还没到点」的提交的节点。
 *
 * 防抖意味着**画布 store 里的文本会短暂落后于编辑器**（最多 delayMs）。绝大多数时候
 * 无所谓 —— 失焦(onBlur)会立刻补交一次。但有一类操作是「拿当前画布当输入立刻算」的：
 * 生成提示词 / 生成视频 / 生成图片，它们读的是 store，不是编辑器里的 draft。
 *
 * 若用户改完文本节点后直接点「生成并创建视频」，而这一刻元素已经被卸载（点按钮/切选中
 * 会让 textarea 从 DOM 移除，这条路径上原生 blur 不保证送达），补交就只能等防抖计时器，
 * 于是这次生成用的是**上一版文本** —— 现象就是「文本改了，生成出来还是旧的」。
 * 所以这类操作在读取输入前先调 `flushPendingNodeTextCommits()` 把欠账补上。
 */
const pendingCommitFlushers = new Set<() => void>();

/**
 * 立刻补交所有防抖中的节点文本。读取画布内容当作输入之前调用。
 * 单个节点的提交失败不牵连其它节点（提交是同步的 store 写入，正常不会抛）。
 */
export function flushPendingNodeTextCommits(): void {
  for (const flush of [...pendingCommitFlushers]) {
    try {
      flush();
    } catch {
      // 忽略：某个节点提交失败不该让整次生成失败。
    }
  }
}

/**
 * 登记一个「防抖中的提交」补交回调，返回注销函数。
 *
 * 单独抽出来是为了能在纯逻辑测试里覆盖注册 / 注销 / 容错语义 —— hook 本身需要 React
 * 渲染环境才能跑，而本仓库的 vitest 跑在 node 环境（没有 jsdom / testing-library）。
 */
export function registerPendingTextCommitFlush(flush: () => void): () => void {
  pendingCommitFlushers.add(flush);
  return () => {
    pendingCommitFlushers.delete(flush);
  };
}

/**
 * A canvas update snapshots history and triggers persistence. Keep the text
 * local during an active typing burst, then commit it once after a short pause.
 */
export function useDebouncedNodeTextCommit({
  nodeId,
  field,
  valueRef,
  updateNodeData,
  delayMs = 480,
}: UseDebouncedNodeTextCommitOptions) {
  const timeoutRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const hasPendingCommitRef = useRef(false);

  const cancelCommit = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    hasPendingCommitRef.current = false;
  }, []);

  const flushCommit = useCallback(() => {
    if (!hasPendingCommitRef.current) {
      return;
    }
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    hasPendingCommitRef.current = false;
    updateNodeData(nodeId, { [field]: valueRef.current } as Partial<CanvasNodeData>);
  }, [field, nodeId, updateNodeData, valueRef]);

  const scheduleCommit = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
    }
    hasPendingCommitRef.current = true;
    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = null;
      flushCommit();
    }, delayMs);
  }, [delayMs, flushCommit]);

  useEffect(() => {
    const unregister = registerPendingTextCommitFlush(flushCommit);
    return () => {
      unregister();
      // 卸载时补交: 组件已经消失, 这是最后一次落库机会。
      flushCommit();
    };
  }, [flushCommit]);

  return { cancelCommit, flushCommit, scheduleCommit };
}
