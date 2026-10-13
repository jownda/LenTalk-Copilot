import { graphImageResolver } from '@/features/canvas/application/canvasServices';
import { flushPendingNodeTextCommits } from '@/features/canvas/application/useDebouncedNodeTextCommit';
import { useCanvasStore } from '@/stores/canvasStore';

/**
 * 读取某节点上游接入的文本 —— **实时版**，供「拿画布当输入立刻算」的动作使用
 * （生成提示词 / 生成视频 / 生成图片 / 生成分镜）。
 *
 * 为什么不能直接用 render 期算好的 `collectInputText(...)` 快照：
 * 文本节点的编辑是**防抖提交**的（`useDebouncedNodeTextCommit`，480ms），画布 store 会
 * 短暂落后于编辑器。失焦通常会补交，但只要有一刻「编辑器的 draft 已经变了、store 还没变」
 * 被读到，这次生成就会用**上一版文本** —— 现象就是用户说的「文本节点改了，生成出来还是
 * 旧内容」，而且只在改完立刻点生成时偶发。
 *
 * 所以这里先 `flushPendingNodeTextCommits()` 把欠账补交掉，再直接从 store 现取
 * nodes/edges 重算，完全不依赖 render 期的快照。
 *
 * @param nodeId  拿谁的输入
 * @param handleId 只要某一个输入口（提示词工作室的「风格」「故事梗概」是两个独立入口）；
 *                 省略表示该节点的全部入边。
 */
export function readLiveInputText(nodeId: string, handleId?: string): string[] {
  flushPendingNodeTextCommits();
  const { nodes, edges } = useCanvasStore.getState();
  const scopedEdges = handleId
    ? edges.filter((edge) => edge.target === nodeId && edge.targetHandle === handleId)
    : edges;
  return graphImageResolver.collectInputText(nodeId, nodes, scopedEdges);
}
