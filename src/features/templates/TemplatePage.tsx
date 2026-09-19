import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, CloudUpload, Copy, Ellipsis, LayoutTemplate, Search, Trash2, Video } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiIconButton, UiInput, UiModal, UiSelect } from '@/components/ui/primitives';
import { isTauri } from '@tauri-apps/api/core';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { browserTemplateRepository } from './storage/templateRepository';
import { templateCoverSource, templateIsBroken, type Template } from './types';
import { DEFAULT_TEMPLATE_SHARE_ROOT, TemplateSyncTimeoutError, loadTemplateShareRoot, saveTemplateShareRoot, syncTemplatesFromShare, syncTemplatesToShare } from '@/commands/templateSync';

type TemplateSort = 'updatedAt' | 'name';

function formatTemplateDate(value: string): string {
  return new Date(value).toLocaleString();
}

interface TemplateCardProps {
  template: Template;
  broken: boolean;
  menuOpen: boolean;
  onMenuToggle: () => void;
  onCopy: () => void;
  onDelete: () => void;
}

function TemplateCard({ template, broken, menuOpen, onMenuToggle, onCopy, onDelete }: TemplateCardProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const menuRef = useRef<HTMLDivElement>(null);
  const [aspectRatio, setAspectRatio] = useState('16 / 9');
  const referenceCount = template.pipeline.referenceImages.length
    + template.pipeline.referenceAudio.length
    + template.pipeline.referenceVideo.length;

  useEffect(() => {
    if (!menuOpen) return;
    const closeMenu = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onMenuToggle();
    };
    document.addEventListener('mousedown', closeMenu);
    return () => document.removeEventListener('mousedown', closeMenu);
  }, [menuOpen, onMenuToggle]);

  return (
    <article
      className="group flex min-w-0 cursor-pointer overflow-hidden rounded-lg border border-border-dark bg-surface-dark transition-colors hover:border-accent/50"
      role="link"
      tabIndex={0}
      onClick={() => navigate(`/templates/${template.id}`)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          navigate(`/templates/${template.id}`);
        }
      }}
    >
      <div className="relative block w-[42%] shrink-0 self-start bg-black" style={{ aspectRatio }}>
        <video
          muted
          preload="metadata"
          src={resolveImageDisplayUrl(templateCoverSource(template))}
          className="h-full w-full object-contain transition-opacity group-hover:opacity-80"
          onLoadedMetadata={(event) => {
            const { videoWidth, videoHeight } = event.currentTarget;
            if (videoWidth > 0 && videoHeight > 0) setAspectRatio(`${videoWidth} / ${videoHeight}`);
          }}
        />
      </div>
      <div className="relative min-w-0 flex-1 p-3">
        <div ref={menuRef} className="absolute right-2 top-2">
          <UiIconButton
            type="button"
            className="h-7 w-7 border-0 bg-black/10 hover:bg-black/15 dark:bg-white/5 dark:hover:bg-white/10"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onMenuToggle();
            }}
            title={t('templatePage.moreActions')}
            aria-label={t('templatePage.moreActions')}
            aria-expanded={menuOpen}
          >
            <Ellipsis className="h-4 w-4" />
          </UiIconButton>
          {menuOpen && (
            <div className="absolute right-0 top-9 z-20 min-w-[132px] overflow-hidden rounded-md border border-[color:var(--ui-border-soft)] bg-[var(--ui-surface-panel)] p-1 shadow-[var(--ui-shadow-panel)]" onClick={(event) => event.stopPropagation()}>
              <button type="button" className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-text-dark hover:bg-black/10 dark:hover:bg-white/10" onClick={(event) => { event.stopPropagation(); onCopy(); }}>
                <Copy className="h-3.5 w-3.5" />{t('templatePage.copy')}
              </button>
              <button type="button" className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-red-400 hover:bg-red-500/10" onClick={(event) => { event.stopPropagation(); onDelete(); }}>
                <Trash2 className="h-3.5 w-3.5" />{t('templatePage.delete')}
              </button>
            </div>
          )}
        </div>
        <div className="space-y-2 pr-7">
          <div className="flex min-w-0 items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 className="truncate font-semibold text-text-dark">{template.name}</h2>
              <p className="mt-1 truncate text-xs text-text-muted">{template.pipeline.modelId} · {template.pipeline.duration}s · {template.pipeline.aspectRatio}</p>
            </div>
            {broken && <span className="shrink-0 text-xs text-amber-400">{t('templatePage.broken')}</span>}
          </div>
          {template.description && <p className="line-clamp-2 text-xs leading-relaxed text-text-muted">{template.description}</p>}
          <p className="line-clamp-3 text-xs leading-relaxed text-text-muted">{template.pipeline.prompt}</p>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 border-t border-border-dark pt-2 text-[11px] text-text-muted">
          <span>{t('templatePage.references')}: {referenceCount}</span>
          <span>{t('templatePage.history')}: {template.artifacts.history.length}</span>
          <span>{t('templatePage.updated')}: {formatTemplateDate(template.updatedAt)}</span>
        </div>
      </div>
    </article>
  );
}

export function TemplatePage() {
  const { t } = useTranslation();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<TemplateSort>('updatedAt');
  const [notice, setNotice] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [shareRoot, setShareRoot] = useState(DEFAULT_TEMPLATE_SHARE_ROOT);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const refresh = async () => setTemplates(await browserTemplateRepository.list());
  useEffect(() => {
    void refresh();
    if (isTauri()) {
      void loadTemplateShareRoot().then((saved) => {
        if (saved?.trim()) setShareRoot(saved.trim());
      });
    }
  }, []);

  const visibleTemplates = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return templates
      .filter((template) => !normalizedQuery || `${template.name} ${template.description ?? ''} ${(template.tags ?? []).join(' ')}`.toLocaleLowerCase().includes(normalizedQuery))
      .sort((left, right) => sort === 'name'
        ? left.name.localeCompare(right.name, 'zh-Hans-CN')
        : right.updatedAt.localeCompare(left.updatedAt));
  }, [query, sort, templates]);

  const handleDelete = async (template: Template) => {
    if (!window.confirm(t('templatePage.confirmDelete', { name: template.name }))) return;
    await browserTemplateRepository.delete(template.id);
    await refresh();
  };

  const handleCopy = async (template: Template) => {
    const now = new Date().toISOString();
    const copy: Template = {
      ...template,
      id: crypto.randomUUID(),
      name: `${template.name} ${t('templatePage.copySuffix')}`,
      createdAt: now,
      updatedAt: now,
    };
    await browserTemplateRepository.save(copy);
    await refresh();
    setNotice(t('templatePage.copySuccess'));
  };

  /** 同步类报错的统一文案：超时单独提示（多数是 Rust 侧命令异常，不是共享盘的问题）。 */
  const describeSyncError = (error: unknown) => {
    if (error instanceof TemplateSyncTimeoutError) return t('templatePage.syncTimeout');
    return error instanceof Error ? error.message : t('templatePage.syncFailed');
  };

  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    setNotice(null);
    try {
      const root = shareRoot.trim();
      if (!root) throw new Error(t('templatePage.sharePathRequired'));
      await saveTemplateShareRoot(root);
      const result = await syncTemplatesToShare(root);
      setShareDialogOpen(false);
      setNotice(t('templatePage.syncSuccess', { templates: result.templateCount, files: result.copiedFileCount }));
    } catch (error) {
      setNotice(describeSyncError(error));
    } finally {
      setSyncing(false);
    }
  };

  const handleChooseShareRoot = async () => {
    if (!isTauri()) {
      setShareDialogOpen(true);
      return;
    }
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ directory: true, multiple: false, title: t('templatePage.chooseSharePath') });
      if (typeof selected === 'string' && selected.trim()) {
        const nextRoot = selected.trim();
        setShareRoot(nextRoot);
        await saveTemplateShareRoot(nextRoot);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t('templatePage.chooseShareFailed'));
    }
  };

  const handleImportFromShare = async () => {
    if (!isTauri() || syncing) return;
    setSyncing(true);
    try {
      const result = await syncTemplatesFromShare(shareRoot.trim());
      await refresh();
      setNotice(t('templatePage.importSuccess', { count: result.importedCount }));
    } catch (error) {
      setNotice(describeSyncError(error));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="ui-scrollbar h-full min-h-0 overflow-auto p-4 sm:p-6 lg:p-8">
      <div className="mx-auto min-h-full w-full max-w-[1920px]">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Link to="/" aria-label={t('titleBar.back')}>
              <UiIconButton title={t('titleBar.back')} aria-label={t('titleBar.back')}><ArrowLeft className="h-4 w-4" /></UiIconButton>
            </Link>
            <h1 className="text-2xl font-bold text-text-dark">{t('templatePage.title')}</h1>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 md:w-auto">
            <UiButton type="button" variant="muted" size="sm" className="gap-2" onClick={() => setShareDialogOpen(true)}><CloudUpload className="h-4 w-4" />{t('templatePage.syncShare')}</UiButton>
            <div className="relative min-w-[220px] flex-1 md:w-[280px] md:flex-none">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
              <UiInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('templatePage.search')} aria-label={t('templatePage.search')} className="pl-9" />
            </div>
            <UiSelect value={sort} onChange={(event) => setSort(event.target.value as TemplateSort)} aria-label={t('templatePage.sort')} className="w-[128px]">
              <option value="updatedAt">{t('templatePage.sortUpdated')}</option>
              <option value="name">{t('templatePage.sortName')}</option>
            </UiSelect>
          </div>
        </div>
        {notice && <p role="status" className="mb-4 text-sm text-emerald-400">{notice}</p>}

        {visibleTemplates.length === 0 ? (
          <div className="flex min-h-[50vh] flex-col items-center justify-center text-center text-text-muted">
            <LayoutTemplate className="mb-4 h-14 w-14 opacity-50" />
            <p className="text-lg text-text-dark">{t('templatePage.empty')}</p>
            <p className="mt-2 max-w-md text-sm">{t('templatePage.emptyHint')}</p>
            <Link to="/" className="mt-6"><UiButton type="button" variant="primary" className="gap-2"><Video className="h-4 w-4" />{t('templatePage.goToGenerate')}</UiButton></Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {visibleTemplates.map((template) => (
              <TemplateCard
                key={template.id}
                template={template}
                broken={templateIsBroken(template)}
                menuOpen={openMenuId === template.id}
                onMenuToggle={() => setOpenMenuId((current) => current === template.id ? null : template.id)}
                onCopy={() => { setOpenMenuId(null); void handleCopy(template); }}
                onDelete={() => { setOpenMenuId(null); void handleDelete(template); }}
              />
            ))}
          </div>
        )}
      </div>
      <UiModal
        isOpen={shareDialogOpen}
        title={t('templatePage.syncShare')}
        onClose={() => setShareDialogOpen(false)}
        widthClassName="w-[560px]"
        footer={<>
          <UiButton type="button" variant="ghost" size="sm" onClick={() => void handleChooseShareRoot()}>{t('templatePage.chooseSharePath')}</UiButton>
          {isTauri() && <UiButton type="button" variant="ghost" size="sm" onClick={() => void handleImportFromShare()} disabled={syncing}>{t('templatePage.importFromShare')}</UiButton>}
          <UiButton type="button" variant="primary" size="sm" onClick={() => void handleSync()} disabled={syncing}>{syncing ? t('templatePage.syncing') : t('templatePage.syncNow')}</UiButton>
        </>}
      >
        <div className="space-y-3">
          <label className="block text-xs text-text-muted">{t('templatePage.sharePath')}<UiInput value={shareRoot} onChange={(event) => setShareRoot(event.target.value)} className="mt-1.5" placeholder={DEFAULT_TEMPLATE_SHARE_ROOT} /></label>
          <p className="text-xs leading-relaxed text-text-muted">{t('templatePage.syncHint')}</p>
        </div>
      </UiModal>
    </div>
  );
}

