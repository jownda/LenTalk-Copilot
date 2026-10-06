import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { CloudDownload, CloudUpload, Eye, MoveDiagonal, LayoutTemplate, Loader2, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { UiButton, UiGhostIconButton } from '@/components/ui/primitives';
import { OverlayLayerProvider } from '@/components/ui/overlayLayer';
import { UI_TEMPLATE_DETAIL_OVERLAY_LAYER_Z } from '@/components/ui/motion';
import {
  resolveTemplateShareRoot,
  syncTemplatesFromShare,
  TemplateSyncTimeoutError,
  uploadTemplateToShare,
} from '@/commands/templateSync';
import { TEMPLATE_DRAG_DATA_TYPE, templateDragPayload } from '@/features/templates/templateDrag';
import { useTemplateLibrary } from '@/features/templates/useTemplateLibrary';
import { TemplateDetailDialog } from '@/features/templates/TemplateDetailPage';
import { TemplateDeleteConfirmDialog } from '@/features/templates/TemplateDeleteConfirm';
import { browserTemplateRepository } from '@/features/templates/storage/templateRepository';
import { templateCoverSource, templateIsBroken, type Template } from '@/features/templates/types';

/** 侧边栏宽度：必须容下 3 列卡片（minmax(0,1fr) × 3 + gap + 左右 padding）。 */
const TEMPLATE_PANEL_WIDTH = 440;

/** 右键菜单尺寸估算，仅用于把菜单夹在视口内（三项）。 */
const MENU_WIDTH = 176;
const MENU_HEIGHT = 124;

interface TemplateSidebarProps {
  open: boolean;
  onClose: () => void;
}

interface TemplateCardProps {
  template: Template;
  /** 双击卡片查看详情。 */
  onOpenDetail: () => void;
  /** 右键卡片打开菜单（只回传视口坐标，坐标夹取与 preventDefault 由调用方处理）。 */
  onOpenMenu: (point: { clientX: number; clientY: number }) => void;
  /** 悬停出现的小垃圾桶：直接走轻量确认卡片，不经过详情弹窗。 */
  onDelete: () => void;
}

function TemplateCard({ template, onOpenDetail, onOpenMenu, onDelete }: TemplateCardProps) {
  const { t } = useTranslation();
  const [aspectRatio, setAspectRatio] = useState('16 / 9');
  const broken = templateIsBroken(template);
  const cover = templateCoverSource(template);

  return (
    <div
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(TEMPLATE_DRAG_DATA_TYPE, templateDragPayload(template.id));
        event.dataTransfer.effectAllowed = 'copy';
      }}
      // 双击看详情，单击保持无操作：卡片本身是拖拽源，单击再给动作容易误触。
      onDoubleClick={onOpenDetail}
      onContextMenu={(event) => {
        event.preventDefault();
        onOpenMenu({ clientX: event.clientX, clientY: event.clientY });
      }}
      title={template.description?.trim() || template.name}
      data-template-card={template.id}
      className="group flex min-w-0 cursor-grab flex-col overflow-hidden rounded-lg border border-border-dark bg-bg-dark transition-colors hover:border-accent/60 active:cursor-grabbing"
    >
      <div className="relative w-full bg-black" style={{ aspectRatio }}>
        {cover ? (
          <video
            muted
            preload="metadata"
            src={resolveImageDisplayUrl(cover)}
            className="h-full w-full object-contain"
            onLoadedMetadata={(event) => {
              const { videoWidth, videoHeight } = event.currentTarget;
              if (videoWidth > 0 && videoHeight > 0) setAspectRatio(`${videoWidth} / ${videoHeight}`);
            }}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <LayoutTemplate className="h-5 w-5 text-text-muted" />
          </div>
        )}
        {broken ? (          <span className="absolute left-1 top-1 rounded bg-red-500/85 px-1 py-0.5 text-[10px] leading-none text-white">
            {t('templatePage.broken', '损坏')}
          </span>
        ) : null}
        <span className="pointer-events-none absolute bottom-1 right-1 rounded bg-black/60 p-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <MoveDiagonal className="h-3 w-3 text-white" />
        </span>
        {/* 删除入口直接落在卡片上：只想删一个模板时，不必先双击打开铺满提示词的详情弹窗。
            卡片本身是拖拽源，所以按下时同时 preventDefault（不启动拖拽）与 stopPropagation
            （不触发卡片自身的右键/双击）。 */}
        <button
          type="button"
          draggable={false}
          title={t('templateSidebar.deleteTemplate', '删除模板')}
          aria-label={t('templateSidebar.deleteTemplate', '删除模板')}
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
          onMouseDown={(event) => {
            event.stopPropagation();
            event.preventDefault();
          }}
          onDoubleClick={(event) => event.stopPropagation()}
          className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded bg-black/60 text-white opacity-0 transition-opacity hover:bg-red-500 focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
      <div className="min-w-0 px-1.5 py-1">
        <p className="truncate text-[11px] font-medium text-text-dark" title={template.name}>
          {template.name}
        </p>
        <p className="truncate text-[10px] text-text-muted" title={template.pipeline.modelId}>
          {template.pipeline.modelId || t('templatePage.title', '模板')}
        </p>
      </div>
    </div>
  );
}

interface TemplateContextMenuState {
  templateId: string;
  x: number;
  y: number;
}

/**
 * 画布内模板侧边栏：与「素材库」同款右侧抽屉，一行 3 个卡片，卡片可拖入画布。
 *
 * 用 portal 挂到 body：侧边栏是 `fixed` 定位，若留在画布 DOM 内会受祖先
 * `transform`（React Flow 的缩放容器）影响而错位。
 */
export function TemplateSidebar({ open, onClose }: TemplateSidebarProps) {
  const { t } = useTranslation();
  const { templates, loading, refresh } = useTemplateLibrary(open);
  const [detailTemplateId, setDetailTemplateId] = useState<string | null>(null);
  const [menu, setMenu] = useState<TemplateContextMenuState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Template | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState<'sync' | 'upload' | null>(null);
  const [notice, setNotice] = useState<{ kind: 'info' | 'ok' | 'error'; text: string } | null>(null);

  // 菜单打开期间：Esc 关闭，滚动也关闭（菜单是 fixed 定位，不跟着列表滚）。
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('wheel', close, { passive: true, capture: true });
    window.addEventListener('scroll', close, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('wheel', close, { capture: true });
      window.removeEventListener('scroll', close, { capture: true });
    };
  }, [menu]);

  if (!open) return null;

  /** 同步类报错：超时单独提示（多数是 Rust 命令异常，不是共享盘的问题）。 */
  const describeShareError = (error: unknown) => {
    if (error instanceof TemplateSyncTimeoutError) return t('templatePage.syncTimeout');
    return error instanceof Error ? error.message : t('templatePage.syncFailed');
  };

  /** 右上角「同步模板」：读取共享盘模板并导入本地没有的那些，再刷新列表。 */
  const handleSyncFromShare = async () => {
    if (busy) return;
    setBusy('sync');
    setNotice(null);
    try {
      const root = await resolveTemplateShareRoot();
      const result = await syncTemplatesFromShare(root);
      await refresh();
      setNotice({
        kind: 'ok',
        text: result.importedCount > 0
          ? t('templatePage.importSuccess', { count: result.importedCount })
          : t('templateSidebar.syncNoNew', '共享盘没有新模板'),
      });
    } catch (error) {
      setNotice({ kind: 'error', text: describeShareError(error) });
    } finally {
      setBusy(null);
    }
  };

  /** 右键菜单「上传到共享盘」：单个模板显式上传，共享盘已有同 ID 则原地更新。 */
  const handleUpload = async (templateId: string) => {
    setMenu(null);
    if (busy) return;
    setBusy('upload');
    setNotice({ kind: 'info', text: t('templateSidebar.uploading', '上传中…') });
    try {
      const root = await resolveTemplateShareRoot();
      const result = await uploadTemplateToShare(templateId, root);
      setNotice({
        kind: 'ok',
        text: result.created
          ? t('templateSidebar.uploaded', '已上传到共享盘')
          : t('templateSidebar.uploadedUpdated', '已更新共享盘上的模板'),
      });
    } catch (error) {
      setNotice({ kind: 'error', text: describeShareError(error) });
    } finally {
      setBusy(null);
    }
  };

  /** 右键菜单「删除模板」：先弹一张轻量确认卡片，确认后才真删。
   *  不打开详情弹窗 —— 只是想删掉一个模板，不需要把整份提示词铺出来。 */
  const handleDeleteTemplate = async () => {
    const target = deleteTarget;
    if (!target || deleting) return;
    setDeleting(true);
    try {
      await browserTemplateRepository.delete(target.id);
      // 详情弹窗正开着同一个模板时一并关掉，避免它指向已删除的数据。
      if (detailTemplateId === target.id) setDetailTemplateId(null);
      setDeleteTarget(null);
      await refresh();
      setNotice({ kind: 'ok', text: t('templateSidebar.deleted', '已删除模板') });
    } catch (error) {
      setNotice({
        kind: 'error',
        text: error instanceof Error ? error.message : t('common.error', '操作失败'),
      });
    } finally {
      setDeleting(false);
    }
  };

  return createPortal(
    <>
      <aside
        className="fixed right-0 top-10 z-[140] flex h-[calc(100%-2.5rem)] flex-col border-l border-border-dark bg-surface-dark shadow-2xl"
        style={{ width: TEMPLATE_PANEL_WIDTH }}
        data-template-sidebar
      >
        <header className="flex items-center justify-between gap-2 border-b border-border-dark px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <LayoutTemplate className="h-4 w-4 shrink-0 text-text-muted" />
            <h2 className="truncate text-sm font-medium text-text-dark">{t('templatePage.title', '模板')}</h2>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <UiButton
              type="button"
              variant="muted"
              size="sm"
              className="gap-1.5"
              onClick={() => void handleSyncFromShare()}
              disabled={busy !== null}
              title={t('templateSidebar.syncTemplates', '同步模板')}
            >
              {busy === 'sync'
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <CloudDownload className="h-3.5 w-3.5" />}
              {busy === 'sync'
                ? t('templatePage.syncing', '同步中…')
                : t('templateSidebar.syncTemplates', '同步模板')}
            </UiButton>
            <UiGhostIconButton onClick={onClose} title={t('common.close', '关闭')}>
              <X className="h-4 w-4" />
            </UiGhostIconButton>
          </div>
        </header>

        <p className="border-b border-border-dark px-4 py-2 text-[11px] text-text-muted">
          {t('templateSidebar.dragHint', '按住卡片拖入画布放置整套节点；双击卡片查看模板详情')}
        </p>

        {notice && (
          <p
            role="status"
            className={`border-b border-border-dark px-4 py-1.5 text-[11px] ${
              notice.kind === 'error' ? 'text-red-400' : notice.kind === 'info' ? 'text-text-muted' : 'text-emerald-400'
            }`}
          >
            {notice.text}
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {loading && templates.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-10 text-xs text-text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('templatePage.loading', '加载中…')}
            </div>
          ) : templates.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <LayoutTemplate className="h-8 w-8 text-text-muted" />
              <p className="text-xs text-text-muted">{t('templatePage.empty', '还没有模板')}</p>
              <p className="text-[11px] text-text-muted">{t('templatePage.emptyHint', '在项目里把一套流程存为模板后，会出现在这里')}</p>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {templates.map((template) => (
                <TemplateCard
                  key={template.id}
                  template={template}
                  onOpenDetail={() => setDetailTemplateId(template.id)}
                  onDelete={() => setDeleteTarget(template)}
                  onOpenMenu={({ clientX, clientY }) => setMenu({
                    templateId: template.id,
                    x: Math.max(8, Math.min(clientX, window.innerWidth - MENU_WIDTH - 8)),
                    y: Math.max(8, Math.min(clientY, window.innerHeight - MENU_HEIGHT - 8)),
                  })}
                />
              ))}
            </div>
          )}
        </div>
      </aside>

      {/* 右键菜单与遮罩都放在抽屉同级（根堆叠上下文），层级才能压过 z-[140] 的抽屉。
          遮罩负责"点别处关掉菜单"，所以第一下点击只关菜单、不穿透到卡片。 */}
      {menu && (
        <>
          <div
            className="fixed inset-0"
            style={{ zIndex: UI_TEMPLATE_DETAIL_OVERLAY_LAYER_Z }}
            onMouseDown={() => setMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu(null);
            }}
          />
          <div
            role="menu"
            data-template-menu={menu.templateId}
            className="fixed min-w-[168px] overflow-hidden rounded-md border border-[color:var(--ui-border-soft)] bg-[var(--ui-surface-panel)] p-1 shadow-[var(--ui-shadow-panel)]"
            style={{ left: menu.x, top: menu.y, zIndex: UI_TEMPLATE_DETAIL_OVERLAY_LAYER_Z + 1 }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-text-dark hover:bg-black/10 dark:hover:bg-white/10"
              onClick={() => void handleUpload(menu.templateId)}
            >
              <CloudUpload className="h-3.5 w-3.5" />{t('templateSidebar.uploadToShare', '上传到共享盘')}
            </button>
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-text-dark hover:bg-black/10 dark:hover:bg-white/10"
              onClick={() => {
                setDetailTemplateId(menu.templateId);
                setMenu(null);
              }}
            >
              <Eye className="h-3.5 w-3.5" />{t('templateSidebar.viewDetail', '查看详情')}
            </button>
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-red-400 hover:bg-red-500/10"
              onClick={() => {
                setDeleteTarget(templates.find((item) => item.id === menu.templateId) ?? null);
                setMenu(null);
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />{t('templateSidebar.deleteTemplate', '删除模板')}
            </button>
          </div>
        </>
      )}

      {/* 详情弹窗挂在抽屉同级（都 portal 到 body）。关闭时刷新一次卡片列表：
          弹窗里可能改名、编辑或删除了模板。 */}
      <TemplateDetailDialog
        templateId={detailTemplateId}
        onClose={() => {
          setDetailTemplateId(null);
          void refresh();
        }}
      />

      {/* 删除确认卡片：抽屉本身是 z-[140]，必须用 OverlayLayerProvider 把它抬到抽屉之上，
          否则遮罩压不住抽屉、按钮点不到。 */}
      <OverlayLayerProvider value={UI_TEMPLATE_DETAIL_OVERLAY_LAYER_Z}>
        <TemplateDeleteConfirmDialog
          open={deleteTarget !== null}
          templateName={deleteTarget?.name ?? ''}
          busy={deleting}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void handleDeleteTemplate()}
        />
      </OverlayLayerProvider>
    </>,
    document.body,
  );
}
