import { memo, useEffect } from 'react';

import { isTextAnnotationNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import { TextNodeEditDialog } from './TextNodeEditDialog';

/**
 * 画布级宿主：文本节点的「AI 修改文本 / 查找替换」弹窗。
 *
 * 以前这个弹窗挂在选中节点的工具栏里，而其他节点（如自动生成的 AI 视频节点）
 * 生成完成时会把选中切到新节点，工具栏随即改渲染新节点，弹窗就被动关闭，
 * 正在输入修改要求时会被打断。提到画布级后只跟随目标文本节点：只要它还在，
 * 别的节点生成、选中切换都不会影响这个弹窗。
 */
export const TextNodeEditDialogHost = memo(() => {
  const dialog = useCanvasStore((state) => state.textEditDialog);
  // 只订阅弹窗目标那一个节点：订阅整表会让这个弹窗跟着画布每帧重渲染
  // （弹窗里是整篇剧本的 textarea，重渲染代价不小）。
  const node = useCanvasStore((state) =>
    state.textEditDialog
      ? (state.nodes.find((item) => item.id === state.textEditDialog!.nodeId) ?? null)
      : null,
  );
  const closeTextEditDialog = useCanvasStore((state) => state.closeTextEditDialog);
  const isOpen = Boolean(node && isTextAnnotationNode(node));

  // 目标节点被删除、被撤销掉，或不再是文本节点时，自动收起弹窗。
  useEffect(() => {
    if (dialog && !isOpen) {
      closeTextEditDialog();
    }
  }, [closeTextEditDialog, dialog, isOpen]);

  if (!dialog || !node || !isOpen) {
    return null;
  }

  return <TextNodeEditDialog mode={dialog.mode} node={node} onClose={closeTextEditDialog} />;
});

TextNodeEditDialogHost.displayName = 'TextNodeEditDialogHost';
