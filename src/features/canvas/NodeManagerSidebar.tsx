import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Film, Image as ImageIcon, LocateFixed, PanelLeftClose, PanelLeftOpen, Play } from 'lucide-react';

import type { CanvasMediaEntry } from '@/features/canvas/application/canvasMediaIndex';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { nodeCatalog } from '@/features/canvas/application/nodeCatalog';
import type { CanvasNodeType } from '@/features/canvas/domain/canvasNodes';

interface NodeManagerSidebarProps {
  open: boolean;
  entries: CanvasMediaEntry[];
  onToggle: () => void;
  /** 点击缩略图: 打开放大预览。 */
  onPreview: (entry: CanvasMediaEntry) => void;
  /** 点击条目: 把视口移到该节点。 */
  onLocate: (nodeId: string) => void;
}

/**
 * 节点管理工具栏: 收纳画布内所有图片 / 视频节点。
 *
 * 缩略图点一下放大预览, 条目点一下把画布视口定位过去。
 * 它取代了原来的「新建节点」调色板 —— 新建走双击画布空白处的节点菜单。
 */
export function NodeManagerSidebar({
  open,
  entries,
  onToggle,
  onPreview,
  onLocate,
}: NodeManagerSidebarProps) {
  const { t } = useTranslation();

  const resolveTypeLabel = useCallback(
    (nodeType: string) => {
      const definition = nodeCatalog.getDefinition(nodeType as CanvasNodeType);
      if (!definition) {
        return nodeType;
      }
      return t(definition.menuLabelKey) || nodeType;
    },
    [t],
  );

  return (
    <aside
      className={`absolute left-3 top-3 z-30 flex max-h-[calc(100%-24px)] w-60 flex-col overflow-hidden rounded-lg border border-border-dark bg-surface-dark shadow-xl transition-transform duration-150 ${
        open ? 'translate-x-0' : '-translate-x-[calc(100%+16px)]'
      }`}
      aria-label={t('canvas.nodeManager.title', '节点管理')}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border-dark px-2.5">
        <span className="text-xs font-medium text-text-dark">
          {t('canvas.nodeManager.title', '节点管理')}
        </span>
        <span className="rounded bg-bg-dark px-1.5 py-0.5 text-[10px] leading-3 text-text-muted">
          {entries.length}
        </span>
        <button
          type="button"
          className="ml-auto flex h-7 w-7 items-center justify-center rounded text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark"
          title={t('canvas.nodeManager.hide', '隐藏节点管理')}
          aria-label={t('canvas.nodeManager.hide', '隐藏节点管理')}
          onClick={onToggle}
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
      </div>

      <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto p-1.5">
        {entries.length === 0 ? (
          <p className="px-2 py-6 text-center text-[11px] leading-4 text-text-muted">
            {t('canvas.nodeManager.empty', '画布中还没有图片 / 视频节点')}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {entries.map((entry) => {
              const typeLabel = resolveTypeLabel(entry.nodeType);
              const displayName = entry.displayName || typeLabel;
              return (
                <li
                  key={entry.nodeId}
                  className="flex items-center gap-2 rounded-md p-1 transition-colors hover:bg-bg-dark"
                >
                  <button
                    type="button"
                    onClick={() => onPreview(entry)}
                    className="relative h-12 w-12 shrink-0 overflow-hidden rounded border border-border-dark bg-black/30"
                    title={t('canvas.nodeManager.preview', '放大预览')}
                    aria-label={t('canvas.nodeManager.preview', '放大预览')}
                  >
                    {entry.thumbnailUrl ? (
                      <img
                        // 索引里存的是落盘后的绝对路径, 直接当 src 会被 WebView 当作相对地址
                        // 解析成 404(表现为破图), 必须过一遍 asset 协议转换。
                        src={resolveImageDisplayUrl(entry.thumbnailUrl)}
                        alt=""
                        className="h-full w-full object-cover"
                        draggable={false}
                      />
                    ) : (
                      <span className="flex h-full w-full items-center justify-center text-text-muted">
                        {entry.kind === 'video' ? (
                          <Film className="h-4 w-4" />
                        ) : (
                          <ImageIcon className="h-4 w-4" />
                        )}
                      </span>
                    )}
                    {entry.kind === 'video' ? (
                      <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/35">
                        <Play className="h-4 w-4 text-white" />
                      </span>
                    ) : null}
                  </button>

                  <button
                    type="button"
                    onClick={() => onLocate(entry.nodeId)}
                    className="flex min-w-0 flex-1 items-center gap-1 text-left"
                    title={t('canvas.nodeManager.locate', '定位到节点')}
                    aria-label={t('canvas.nodeManager.locate', '定位到节点')}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="w-full truncate text-xs text-text-dark">{displayName}</span>
                      <span className="text-[10px] leading-3 text-text-muted">{typeLabel}</span>
                    </span>
                    <LocateFixed className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}

export function NodeManagerToggle({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="absolute left-3 top-3 z-30 flex h-9 w-9 items-center justify-center rounded-lg border border-border-dark bg-surface-dark text-text-muted shadow-lg transition-colors hover:bg-bg-dark hover:text-text-dark"
      title={t('canvas.nodeManager.show', '显示节点管理')}
      aria-label={t('canvas.nodeManager.show', '显示节点管理')}
      onClick={onClick}
    >
      <PanelLeftOpen className="h-4 w-4" />
    </button>
  );
}
