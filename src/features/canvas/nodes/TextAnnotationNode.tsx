import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type UIEvent as ReactUIEvent,
} from 'react';
import { Handle, Position, type NodeProps, useUpdateNodeInternals } from '@xyflow/react';
import { FileText } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { useTranslation } from 'react-i18next';
import { openUrl } from '@tauri-apps/plugin-opener';

import { CANVAS_NODE_TYPES, type TextAnnotationNodeData } from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { useDebouncedNodeTextCommit } from '@/features/canvas/application/useDebouncedNodeTextCommit';
import { clampTextViewScrollTop } from '@/features/canvas/application/textViewScroll';
import { useCanvasStore } from '@/stores/canvasStore';

type TextAnnotationNodeProps = NodeProps & {
  id: string;
  data: TextAnnotationNodeData;
  selected?: boolean;
};

const DEFAULT_WIDTH = 300;
const DEFAULT_HEIGHT = 180;
const MIN_WIDTH = 180;
const MIN_HEIGHT = 100;
const MAX_WIDTH = 900;
const MAX_HEIGHT = 900;

export const TextAnnotationNode = memo(({
  id,
  data,
  selected,
  width,
  height,
}: TextAnnotationNodeProps) => {
  const { t } = useTranslation();
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const updateNodeInternals = useUpdateNodeInternals();
  const [isEditing, setIsEditing] = useState(false);
  const content = typeof data.content === 'string' ? data.content : '';
  const [contentDraft, setContentDraft] = useState(content);
  const contentDraftRef = useRef(contentDraft);
  const { flushCommit: flushContentCommit, scheduleCommit: scheduleContentCommit } =
    useDebouncedNodeTextCommit({
      nodeId: id,
      field: 'content',
      valueRef: contentDraftRef,
      updateNodeData,
    });
  const resolvedTitle = resolveNodeDisplayName(CANVAS_NODE_TYPES.textAnnotation, data);
  const resolvedWidth = Math.max(MIN_WIDTH, Math.round(width ?? DEFAULT_WIDTH));
  const resolvedHeight = Math.max(MIN_HEIGHT, Math.round(height ?? DEFAULT_HEIGHT));
  // 按码点计数：emoji / 代理对算 1 个字, 而不是 UTF-16 的 2。
  const characterCount = Array.from(contentDraft).length;
  const handleMarkdownLinkClick = useCallback((href?: string) => {
    if (!href) {
      return;
    }
    void openUrl(href);
  }, []);

  // ---- 编辑态 / 预览态的视图位置搬运 ----
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  /**
   * 编辑态 textarea 的滚动位置; `null` = 本次会话还没编辑过。
   *
   * 编辑态(textarea)与预览态(markdown 容器)是**两个独立的滚动容器**, 切换时新挂载的
   * 那个从 scrollTop = 0 开始 —— 用户往下翻着改完、一退出编辑就跳回第一行。
   * 所以退出时把它搬给预览容器, 再进来时搬回 textarea。
   *
   * 刻意用 `null` 而不是 0 表示「没记录」: 首次进编辑态要让浏览器按原生行为把光标放在
   * 文末并滚到底(这是老行为, 不能因为「还原 0」而改成停在第一行)。
   */
  const editorScrollTopRef = useRef<number | null>(null);
  /** 退出编辑时记下的光标位置; 再进编辑态回到原处, 而不是被丢到文末。 */
  const pendingEditorCaretRef = useRef<number | null>(null);
  const handleEditorScroll = useCallback((event: ReactUIEvent<HTMLTextAreaElement>) => {
    editorScrollTopRef.current = event.currentTarget.scrollTop;
  }, []);

  /**
   * 切换 编辑态 ⇄ 预览态 时, 把视图位置搬到新挂载的那个容器上。
   *
   * 必须放在 **layout 阶段**: 用 useEffect 的话会先绘制出一帧「第一行」再跳过去,
   * 那正是用户看到的「重置」。预览是 markdown 渲染, 内容高度与 textarea 未必一致,
   * 所以偏移量要按目标容器自己的可滚范围钳一次。
   */
  useLayoutEffect(() => {
    if (isEditing) {
      const textarea = textareaRef.current;
      if (!textarea || editorScrollTopRef.current === null) {
        // 首次进编辑态: 交给浏览器原生行为(光标在文末、视图在文末), 不干预。
        return;
      }
      const caret = pendingEditorCaretRef.current;
      if (caret !== null) {
        // 顺序不能反: setSelectionRange 会把光标位置滚进视野, 后写 scrollTop 才压得住。
        const position = Math.max(0, Math.min(caret, textarea.value.length));
        textarea.setSelectionRange(position, position);
        pendingEditorCaretRef.current = null;
      }
      textarea.scrollTop = clampTextViewScrollTop(
        editorScrollTopRef.current,
        textarea.scrollHeight - textarea.clientHeight,
      );
      return;
    }
    const preview = previewRef.current;
    if (!preview) return;
    preview.scrollTop = clampTextViewScrollTop(
      editorScrollTopRef.current ?? 0,
      preview.scrollHeight - preview.clientHeight,
    );
  }, [isEditing]);

  useEffect(() => {
    if (content !== contentDraftRef.current) {
      contentDraftRef.current = content;
      setContentDraft(content);
    }
  }, [content]);

  // 文本节点的 Handle 位置依赖节点尺寸。尺寸来自 React Flow 的测量/缩放结果,
  // 变化后必须主动刷新内部 bounds, 否则新连线会沿用旧的左右锚点缓存。
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, resolvedHeight, resolvedWidth, updateNodeInternals]);

  // 单击(未拖动)进入编辑; 链接/表单控件/标题按钮上的单击不进入编辑
  const handleNodeClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('a, button, input, textarea, select')) {
      return;
    }
    setSelectedNode(id);
    setIsEditing(true);
  }, [id, setSelectedNode]);

  // 选中状态变化(点击其他节点/画布空白/多选)时退出编辑
  useEffect(() => {
    if (selectedNodeId !== id) {
      // 退出前把「滚到哪 + 光标在哪」钉死: onScroll 只是兜底, 还可能有程序化滚动
      // (输入回写)。该 effect 跑在「已取消选中、textarea 仍在 DOM 里」的那一帧,
      // 读得到真实值 —— 再晚一帧元素就被卸载了。
      const textarea = textareaRef.current;
      if (textarea) {
        editorScrollTopRef.current = textarea.scrollTop;
        pendingEditorCaretRef.current = textarea.selectionStart;
      }
      setIsEditing(false);
    }
  }, [id, selectedNodeId]);

  return (
    <div
      className={`
        group relative h-full w-full overflow-visible rounded-[var(--node-radius)] border bg-surface-dark/85 p-1.5 transition-colors duration-150
        ${selected
          ? 'border-accent shadow-[0_0_0_1px_rgba(59,130,246,0.32)]'
          : 'border-[rgba(15,23,42,0.22)] hover:border-[rgba(15,23,42,0.34)] dark:border-[rgba(255,255,255,0.22)] dark:hover:border-[rgba(255,255,255,0.34)]'}
      `}
      style={{ width: resolvedWidth, height: resolvedHeight }}
      onClick={handleNodeClick}
    >
      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<FileText className="h-4 w-4" />}
        titleText={resolvedTitle}
        editable
        onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
      />

      <NodeResizeHandle
        minWidth={MIN_WIDTH}
        minHeight={MIN_HEIGHT}
        maxWidth={MAX_WIDTH}
        maxHeight={MAX_HEIGHT}
      />
      <Handle
        id="target"
        type="target"
        position={Position.Left}
        className="!h-2 !w-2 !border-surface-dark !bg-accent"
      />
      <Handle
        id="source"
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-surface-dark !bg-accent"
      />

      {isEditing ? (
        // 相对定位容器只为承载右下角的字数角标；输入框本身仍然铺满节点。
        <div className="relative h-full w-full">
          <textarea
            ref={textareaRef}
            autoFocus
            value={contentDraft}
            onChange={(event) => {
              const nextValue = event.target.value;
              contentDraftRef.current = nextValue;
              setContentDraft(nextValue);
              scheduleContentCommit();
            }}
            onScroll={handleEditorScroll}
            onBlur={flushContentCommit}
            placeholder={t('node.textAnnotation.placeholder')}
            className="nodrag nowheel h-full w-full resize-none border-none bg-transparent px-1 pb-4 pt-0.5 text-sm leading-6 text-text-dark outline-none placeholder:text-text-muted/70"
          />
          {/* 角标留给输入框底部内边距(16px)承载, 正文不会压到它下面。 */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute bottom-1 right-1 select-none text-[10px] leading-none text-text-muted/70"
          >
            {t('node.textAnnotation.characters', { count: characterCount })}
          </span>
        </div>
      ) : (
        <div
          ref={previewRef}
          className="nowheel h-full w-full cursor-grab select-none overflow-auto px-1 py-0.5 text-sm leading-6 text-text-dark active:cursor-grabbing"
        >
          {content.trim().length > 0 ? (
            <div className="markdown-body break-words [&_a]:text-accent [&_blockquote]:border-l-2 [&_blockquote]:border-white/20 [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-white/10 [&_code]:px-1 [&_code]:py-0.5 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-[15px] [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-semibold [&_hr]:border-white/10 [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-0 [&_p+_p]:mt-4 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-black/30 [&_pre]:p-2 [&_table]:w-full [&_table]:border-collapse [&_table]:text-xs [&_td]:border [&_td]:border-white/10 [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-white/10 [&_th]:px-2 [&_th]:py-1 [&_ul]:list-disc [&_ul]:pl-5">
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkBreaks]}
                components={{
                  a: ({ href, children, ...props }) => (
                    <a
                      {...props}
                      href={href}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(event) => {
                        event.preventDefault();
                        handleMarkdownLinkClick(href);
                      }}
                    >
                      {children}
                    </a>
                  ),
                }}
              >
                {content}
              </ReactMarkdown>
            </div>
          ) : (
            <div className="pt-1 text-text-muted">{t('node.textAnnotation.empty')}</div>
          )}
        </div>
      )}
    </div>
  );
});

TextAnnotationNode.displayName = 'TextAnnotationNode';
