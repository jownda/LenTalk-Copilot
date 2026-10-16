/**
 * 节点「生成」处理器注册表。
 *
 * 为什么不把生成逻辑抽成公共函数：各节点的 `handleGenerate` 深绑组件内部状态
 * （提示词草稿、已选模型、上游素材、比例推断、API Key…），搬出来等于把整条生成链路重写一遍，
 * 而那条链路上压着计费、取消、错误上报、结果节点落位等一堆既有约定。
 * 改成「组件把自己的生成函数登记一下」，AI 侧按名调用即可 —— **零改动现有生成**。
 *
 * 代价（必须如实认知）：只有**当前挂载**的节点才能被触发。
 * 画布开了 `onlyRenderVisibleElements`，视口外的节点组件是卸载的，
 * 这时调用方要明确告诉用户「先把节点移到可见范围」，而不是静默失败。
 */

export type NodeGenerationHandler = () => void | Promise<void>;

const handlers = new Map<string, NodeGenerationHandler>();

/** 注册并返回注销函数，可直接作为 `useEffect` 的返回值 */
export function registerNodeGenerationHandler(
  nodeId: string,
  handler: NodeGenerationHandler,
): () => void {
  handlers.set(nodeId, handler);
  return () => {
    // 只在自己仍是当前登记时才删：快速重挂载时，旧 effect 的清理不能把新的抹掉
    if (handlers.get(nodeId) === handler) handlers.delete(nodeId);
  };
}

export function getNodeGenerationHandler(nodeId: string): NodeGenerationHandler | undefined {
  return handlers.get(nodeId);
}

export function isNodeGenerationAvailable(nodeId: string): boolean {
  return handlers.has(nodeId);
}

/** 单测用 */
export function resetNodeGenerationHandlers(): void {
  handlers.clear();
}
