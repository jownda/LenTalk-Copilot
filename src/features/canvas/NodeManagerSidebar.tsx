import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Film,
  Folder,
  Image as ImageIcon,
  LocateFixed,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Play,
  Search,
  Trash2,
} from 'lucide-react';

import type { CanvasMediaEntry } from '@/features/canvas/application/canvasMediaIndex';
import { buildNodeManagerSections } from '@/features/canvas/application/canvasMediaIndex';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { nodeCatalog } from '@/features/canvas/application/nodeCatalog';
import type { CanvasNodeType } from '@/features/canvas/domain/canvasNodes';

/** 画布上的分组节点（React Flow 的 group），侧栏按它分节。 */
export interface NodeManagerGroup {
  id: string;
  label: string;
}

interface NodeManagerSidebarProps {
  open: boolean;
  entries: CanvasMediaEntry[];
  /** 画布上现有的分组；条目按 `parentId` 归到对应的组下面。 */
  groups: NodeManagerGroup[];
  onToggle: () => void;
  /** 点击缩略图: 打开放大预览。 */
  onPreview: (entry: CanvasMediaEntry) => void;
  /** 点击条目: 把视口移到该节点。 */
  onLocate: (nodeId: string) => void;
  onRename: (nodeId: string, displayName: string) => void;
  onDuplicate: (nodeId: string) => void;
  onDownload: (entry: CanvasMediaEntry) => void;
  onDelete: (nodeId: string) => void;
}

type KindFilter = 'all' | 'image' | 'video';

interface MenuAnchor {
  nodeId: string;
  top: number;
  left: number;
}

/**
 * 节点管理侧栏: 收纳画布内所有图片 / 视频节点。
 *
 * 结构对齐成熟做法（分节 + 搜索 + 逐项操作），但**分节用画布本来的分组节点**：
 * 同一个节点只能有一个归属，另造一套「文件夹」会和画布上的分组互相打架。
 *
 * 交互沿用原有约定：缩略图点一下放大预览，条目点一下把画布视口定位过去；
 * 右侧「…」给出重命名 / 复制 / 下载 / 删除。
 *
 * `memo` 是必要的：它挂在画布上，而画布会因为平移缩放每帧重渲染 —— 侧栏没必要跟着跑。
 */
export const NodeManagerSidebar = memo(function NodeManagerSidebar({
  open,
  entries,
  groups,
  onToggle,
  onPreview,
  onLocate,
  onRename,
  onDuplicate,
  onDownload,
  onDelete,
}: NodeManagerSidebarProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [menuAnchor, setMenuAnchor] = useState<MenuAnchor | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

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

  const entryName = useCallback(
    (entry: CanvasMediaEntry) => entry.displayName || resolveTypeLabel(entry.nodeType) || entry.nodeId,
    [resolveTypeLabel],
  );

  // 点菜单外面关闭。菜单本体用 portal 渲染在 body 上，所以这里按 data 属性认。
  useEffect(() => {
    if (!menuAnchor) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-node-manager-menu]')) return;
      setMenuAnchor(null);
    };
    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, [menuAnchor]);

  // 侧栏收起时不留悬空菜单。
  useEffect(() => {
    if (!open) setMenuAnchor(null);
  }, [open]);

  const filteredEntries = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return entries.filter((entry) => {
      if (kindFilter !== 'all' && entry.kind !== kindFilter) return false;
      if (!keyword) return true;
      return entryName(entry).toLowerCase().includes(keyword);
    });
  }, [entries, entryName, kindFilter, query]);

  const sections = useMemo(
    () => buildNodeManagerSections(filteredEntries, groups, t('canvas.nodeManager.ungrouped', '未分组')),
    [filteredEntries, groups, t],
  );

  const commitRename = useCallback(
    (nodeId: string) => {
      // Enter 与 blur 都会走到这里：先判断还停在重命名态，避免同一次输入提交两遍。
      if (renamingId !== nodeId) return;
      const next = renameDraft.trim();
      setRenamingId(null);
      const current = entries.find((entry) => entry.nodeId === nodeId);
      // 空名等于「恢复默认」（节点名回落到类型名），所以只有真的改了才写。
      if (next && next !== (current?.displayName ?? '')) {
        onRename(nodeId, next);
      }
    },
    [entries, onRename, renameDraft, renamingId],
  );

  const handleMenuOpen = useCallback((event: React.MouseEvent<HTMLButtonElement>, nodeId: string) => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const menuWidth = 132;
    setMenuAnchor((previous) => {
      if (previous?.nodeId === nodeId) return null;
      return {
        nodeId,
        // `fixed` 定位 + 右对齐锚点；夹在视口内，避免贴边时被截掉一半。
        left: Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8)),
        top: Math.min(rect.bottom + 4, window.innerHeight - 168),
      };
    });
  }, []);

  const menuEntry = menuAnchor ? entries.find((entry) => entry.nodeId === menuAnchor.nodeId) : undefined;

  return (
    <aside
      className={`absolute left-3 top-3 z-30 flex max-h-[calc(100%-24px)] w-64 flex-col overflow-hidden rounded-lg border border-border-dark bg-surface-dark shadow-xl transition-transform duration-150 ${
        open ? 'translate-x-0' : '-translate-x-[calc(100%+16px)]'
      }`}
      aria-label={t('canvas.nodeManager.title', '节点管理')}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border-dark px-2.5">
        <span className="text-xs font-medium text-text-dark">
          {t('canvas.nodeManager.title', '节点管理')}
        </span>
        <span className="rounded bg-bg-dark px-1.5 py-0.5 text-[10px] leading-3 text-text-muted">
          {filteredEntries.length}
          {filteredEntries.length !== entries.length ? `/${entries.length}` : ''}
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

      <div className="flex shrink-0 flex-col gap-1.5 border-b border-border-dark px-2 py-1.5">
        <label className="relative flex items-center">
          <Search className="pointer-events-none absolute left-1.5 h-3.5 w-3.5 text-text-muted" />
          <input
            className="h-7 w-full rounded border border-border-dark bg-bg-dark pl-6 pr-6 text-[11px] text-text-dark outline-none placeholder:text-text-muted focus:border-accent/60"
            placeholder={t('canvas.nodeManager.search', '搜索名称')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onMouseDown={(event) => event.stopPropagation()}
          />
          {query ? (
            <button
              type="button"
              className="absolute right-1 flex h-5 w-5 items-center justify-center rounded text-text-muted hover:text-text-dark"
              title={t('canvas.nodeManager.clearSearch', '清空搜索')}
              aria-label={t('canvas.nodeManager.clearSearch', '清空搜索')}
              onClick={() => setQuery('')}
            >
              ×
            </button>
          ) : null}
        </label>
        <div className="flex gap-1">
          {(
            [
              ['all', t('canvas.nodeManager.filterAll', '全部')],
              ['image', t('canvas.nodeManager.filterImage', '图片')],
              ['video', t('canvas.nodeManager.filterVideo', '视频')],
            ] as Array<[KindFilter, string]>
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`h-6 flex-1 rounded text-[10px] transition-colors ${
                kindFilter === value
                  ? 'bg-accent/20 text-text-dark'
                  : 'text-text-muted hover:bg-bg-dark hover:text-text-dark'
              }`}
              onClick={() => setKindFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto p-1.5">
        {entries.length === 0 ? (
          <p className="px-2 py-6 text-center text-[11px] leading-4 text-text-muted">
            {t('canvas.nodeManager.empty', '画布中还没有图片 / 视频节点')}
          </p>
        ) : filteredEntries.length === 0 ? (
          <p className="px-2 py-6 text-center text-[11px] leading-4 text-text-muted">
            {t('canvas.nodeManager.emptyFiltered', '没有匹配的节点')}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {sections.map((section) => {
              const isCollapsed = collapsed[section.id] ?? false;
              return (
                <section key={section.id}>
                  <button
                    type="button"
                    className="flex h-6 w-full items-center gap-1 rounded px-1 text-left text-[11px] text-text-muted hover:bg-bg-dark hover:text-text-dark"
                    onClick={() =>
                      setCollapsed((previous) => ({ ...previous, [section.id]: !isCollapsed }))
                    }
                  >
                    {isCollapsed ? (
                      <ChevronRight className="h-3 w-3 shrink-0" />
                    ) : (
                      <ChevronDown className="h-3 w-3 shrink-0" />
                    )}
                    <Folder className="h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{section.label}</span>
                    <span className="shrink-0 text-[10px] opacity-70">{section.entries.length}</span>
                  </button>

                  {isCollapsed ? null : (
                    <ul className="mt-1 flex flex-col gap-1">
                      {section.entries.map((entry) => {
                        const typeLabel = resolveTypeLabel(entry.nodeType);
                        const displayName = entryName(entry);
                        const isRenaming = renamingId === entry.nodeId;
                        return (
                          <li
                            key={entry.nodeId}
                            className="flex items-center gap-1.5 rounded-md p-1 transition-colors hover:bg-bg-dark"
                          >
                            <button
                              type="button"
                              onClick={() => onPreview(entry)}
                              className="relative h-11 w-11 shrink-0 overflow-hidden rounded border border-border-dark bg-black/30"
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
                                  <Play className="h-3.5 w-3.5 text-white" />
                                </span>
                              ) : null}
                            </button>

                            {isRenaming ? (
                              <input
                                className="h-6 min-w-0 flex-1 rounded border border-accent/60 bg-bg-dark px-1 text-xs text-text-dark outline-none"
                                value={renameDraft}
                                autoFocus
                                onChange={(event) => setRenameDraft(event.target.value)}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') commitRename(entry.nodeId);
                                  if (event.key === 'Escape') setRenamingId(null);
                                }}
                                onBlur={() => commitRename(entry.nodeId)}
                                onMouseDown={(event) => event.stopPropagation()}
                              />
                            ) : (
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
                            )}

                            <div className="relative shrink-0" data-node-manager-menu>
                              <button
                                type="button"
                                className={`flex h-6 w-6 items-center justify-center rounded text-text-muted transition-colors hover:bg-surface-dark hover:text-text-dark ${
                                  menuAnchor?.nodeId === entry.nodeId ? 'bg-surface-dark text-text-dark' : ''
                                }`}
                                title={t('canvas.nodeManager.more', '更多操作')}
                                aria-label={t('canvas.nodeManager.more', '更多操作')}
                                onClick={(event) => handleMenuOpen(event, entry.nodeId)}
                              >
                                <MoreHorizontal className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>

      {/*
        菜单必须 portal 到 body：侧栏是 `overflow-hidden` + 内部滚动容器，
        在里面绝对定位会被裁掉一半（贴底那几行的菜单尤其明显）。
      */}
      {menuAnchor && menuEntry
        ? createPortal(
            <div
              data-node-manager-menu
              className="fixed z-[60] w-[132px] rounded-md border border-border-dark bg-surface-dark py-1 shadow-2xl"
              style={{ top: menuAnchor.top, left: menuAnchor.left }}
            >
              <MenuItem
                icon={<Pencil className="h-3.5 w-3.5" />}
                label={t('canvas.nodeManager.rename', '重命名')}
                onClick={() => {
                  setMenuAnchor(null);
                  setRenameDraft(menuEntry.displayName ?? '');
                  setRenamingId(menuEntry.nodeId);
                }}
              />
              <MenuItem
                icon={<Copy className="h-3.5 w-3.5" />}
                label={t('canvas.nodeManager.duplicate', '复制')}
                onClick={() => {
                  setMenuAnchor(null);
                  onDuplicate(menuEntry.nodeId);
                }}
              />
              <MenuItem
                icon={<Download className="h-3.5 w-3.5" />}
                label={t('canvas.nodeManager.download', '下载')}
                onClick={() => {
                  setMenuAnchor(null);
                  onDownload(menuEntry);
                }}
              />
              <div className="my-1 h-px bg-border-dark" />
              <MenuItem
                icon={<Trash2 className="h-3.5 w-3.5" />}
                label={t('canvas.nodeManager.delete', '删除')}
                danger
                onClick={() => {
                  setMenuAnchor(null);
                  onDelete(menuEntry.nodeId);
                }}
              />
            </div>,
            document.body,
          )
        : null}
    </aside>
  );
});

function MenuItem({
  icon,
  label,
  danger,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] transition-colors hover:bg-bg-dark ${
        danger ? 'text-red-300 hover:text-red-200' : 'text-text-dark'
      }`}
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
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
