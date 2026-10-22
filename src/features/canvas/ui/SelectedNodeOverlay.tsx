import { memo } from 'react';

import { useCanvasStore } from '@/stores/canvasStore';
import { NodeActionToolbar } from './NodeActionToolbar';

export const SelectedNodeOverlay = memo(() => {
  /**
   * 只订阅「当前选中的那个节点」，不要订阅整张 nodes 表。
   *
   * 这个组件常驻在 <ReactFlow> 里，而 React Flow 拖拽时每帧都会换掉 nodes 数组；
   * 订阅整表就等于拖任何节点都让工具栏跟着重渲染一遍（工具栏里还有一条
   * buildTemplateFromCanvas 的链路回溯）。只取选中节点时，拖动别的节点
   * 完全不会触发它，拖动自己才重渲染 —— 那也是必要的。
   */
  const selectedNode = useCanvasStore((state) =>
    state.selectedNodeId
      ? (state.nodes.find((node) => node.id === state.selectedNodeId) ?? null)
      : null,
  );

  if (!selectedNode) {
    return null;
  }

  return (
    <>
      <NodeActionToolbar node={selectedNode} />
    </>
  );
});

SelectedNodeOverlay.displayName = 'SelectedNodeOverlay';
