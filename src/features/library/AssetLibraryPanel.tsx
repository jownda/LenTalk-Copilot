import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  AudioLines,
  ChevronRight,
  Download,
  Folder,
  FolderCog,
  ImagePlus,
  Library,
  MoreVertical,
  Music2,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Upload,
  Video,
  X,
} from 'lucide-react';

import { useAssetLibraryStore } from './assetStore';
import { ASSET_DRAG_DATA_TYPE, assetDragPayload, importFilesToAssets } from './importAssets';
import type { AssetMediaType, LibraryAsset } from './types';
import { CategoryManagerDialog } from './CategoryManagerDialog';
import {
  buildBackupFileName,
  createLibraryBackupZip,
  downloadBlob,
  importLibraryBackupZip,
} from './libraryBackup';
import { PromptLibraryPanel } from '@/features/prompts/PromptLibraryPanel';
import { RenameDialog } from '@/features/project/RenameDialog';
import type { PromptTemplate } from '@/features/prompts/promptLibraryStore';
import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { nodeCatalog } from '@/features/canvas/application/nodeCatalog';
import { UiButton, UiIconButton } from '@/components/ui/primitives';

export interface AssetLibraryPanelProps {
  open: boolean;
  onClose: () => void;
  fullscreen?: boolean;
  /** 画布入口传入,提示词「应用」回调(素材库内嵌提示词 tab 时用) */
  onApplyPrompt?: (template: PromptTemplate, mode: 'positive' | 'full') => void;
}

const PANEL_WIDTH = 360;
type MediaFilter = 'all' | AssetMediaType;

function resolveViewportCenterPosition(): { x: number; y: number } {
  const { currentViewport, canvasViewportSize } = useCanvasStore.getState();
  const zoom = Math.max(0.01, currentViewport.zoom || 1);
  return {
    x: Math.round((canvasViewportSize.width / 2 - currentViewport.x) / zoom - 110),
    y: Math.round((canvasViewportSize.height / 2 - currentViewport.y) / zoom - 90),
  };
}

function mediaIcon(mediaType: AssetMediaType) {
  if (mediaType === 'video') return <Video className="h-5 w-5" />;
  if (mediaType === 'audio') return <Music2 className="h-5 w-5" />;
  return <ImagePlus className="h-5 w-5" />;
}

function MediaPreview({ asset }: { asset: LibraryAsset }) {
  if (asset.mediaType === 'image') {
    return (
      <img
        src={resolveImageDisplayUrl(asset.previewImageUrl || asset.sourcePath)}
        alt={asset.name}
        className="h-full w-full object-cover"
        draggable={false}
      />
    );
  }
  if (asset.mediaType === 'video') {
    if (asset.previewImageUrl) {
      return (
        <img
          src={resolveImageDisplayUrl(asset.previewImageUrl)}
          alt={asset.name}
          className="h-full w-full object-cover"
          draggable={false}
        />
      );
    }
    // 无缩略图时用 video 元素渲染首帧(静音自动播放, WKWebView 下 preload 不显示首帧必须 autoplay)
    return (
      <video
        src={resolveImageDisplayUrl(asset.sourcePath)}
        muted
        autoPlay
        playsInline
        preload="auto"
        draggable={false}
        className="h-full w-full object-cover"
      />
    );
  }
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-gradient-to-br from-amber-500/25 to-rose-500/15 text-amber-100">
      <AudioLines className="h-8 w-8" />
      <span className="text-[10px] font-medium">AUDIO</span>
    </div>
  );
}

export const AssetLibraryPanel = memo(({ open, onClose, fullscreen = false, onApplyPrompt }: AssetLibraryPanelProps) => {
  const { t } = useTranslation();
  const hydrate = useAssetLibraryStore((state) => state.hydrate);
  const isHydrated = useAssetLibraryStore((state) => state.isHydrated);
  const libraries = useAssetLibraryStore((state) => state.libraries);
  const categories = useAssetLibraryStore((state) => state.categories);
  const assets = useAssetLibraryStore((state) => state.assets);
  const activeLibraryId = useAssetLibraryStore((state) => state.activeLibraryId);
  const setActiveLibrary = useAssetLibraryStore((state) => state.setActiveLibrary);
  const createLibrary = useAssetLibraryStore((state) => state.createLibrary);
  const renameLibrary = useAssetLibraryStore((state) => state.renameLibrary);
  const deleteLibrary = useAssetLibraryStore((state) => state.deleteLibrary);
  const addAssets = useAssetLibraryStore((state) => state.addAssets);
  const deleteAssets = useAssetLibraryStore((state) => state.deleteAssets);
  const renameAsset = useAssetLibraryStore((state) => state.renameAsset);
  const classifyAssets = useAssetLibraryStore((state) => state.classifyAssets);
  const moveAssetsToCategory = useAssetLibraryStore((state) => state.moveAssetsToCategory);
  const addNode = useCanvasStore((state) => state.addNode);

  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedAssetIds, setSelectedAssetIds] = useState<Set<string>>(new Set());
  const [isImporting, setIsImporting] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [backupNotice, setBackupNotice] = useState<string | null>(null);
  const backupInputRef = useRef<HTMLInputElement>(null);
  const [activeSection, setActiveSection] = useState<'assets' | 'prompts'>('assets');
  const [showCategoryManager, setShowCategoryManager] = useState(false);
  /** 缩略图卡片尺寸(px, 由滑杆调节) */
  const [thumbSize, setThumbSize] = useState(132);
  /** 卡片右上角「...」菜单: 打开的素材 id + 菜单锚点位置 */
  const [assetMenu, setAssetMenu] = useState<{ assetId: string; x: number; y: number } | null>(null);
  /** 「移动到分组」子菜单展开(悬停右侧呼出分组列表) */
  const [moveMenuOpen, setMoveMenuOpen] = useState(false);
  /** 自绘重命名对话框(Tauri 下 window.prompt 不可用, 素材/素材库/新建库共用) */
  const [renameDialog, setRenameDialog] = useState<{
    mode: 'asset' | 'library' | 'newLibrary';
    targetId: string | null;
    title: string;
    defaultValue: string;
  } | null>(null);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!open) return;
    setSelectedAssetIds(new Set());
    setSearchQuery('');
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    setActiveCategoryId(null);
    setSelectedAssetIds(new Set());
  }, [activeLibraryId]);

  // 卡片「...」菜单: Esc 关闭
  useEffect(() => {
    if (!assetMenu) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setAssetMenu(null);
        setMoveMenuOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [assetMenu]);

  const currentLibrary = libraries.find((library) => library.id === activeLibraryId) ?? libraries[0];
  const libraryCategories = useMemo(
    () => categories.filter((category) => category.libraryId === activeLibraryId),
    [activeLibraryId, categories]
  );
  const libraryAssets = useMemo(
    () => assets.filter((asset) => asset.libraryId === activeLibraryId),
    [activeLibraryId, assets]
  );
  const visibleAssets = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    return libraryAssets
      .filter((asset) => !activeCategoryId || asset.categoryId === activeCategoryId)
      .filter((asset) => mediaFilter === 'all' || asset.mediaType === mediaFilter)
      .filter((asset) => {
        if (!query) return true;
        return [asset.name, asset.sourceFileName ?? '', ...asset.tags]
          .some((value) => value.toLocaleLowerCase().includes(query));
      })
      .sort((left, right) => right.createdAt - left.createdAt);
  }, [activeCategoryId, libraryAssets, mediaFilter, searchQuery]);

  const handleImportFiles = useCallback(async (files: File[]) => {
    if (!currentLibrary || files.length === 0) return;
    setIsImporting(true);
    try {
      const imported = await importFilesToAssets(files, currentLibrary.id, activeCategoryId);
      if (imported.length > 0) addAssets(imported);
    } finally {
      setIsImporting(false);
    }
  }, [activeCategoryId, addAssets, currentLibrary]);

  /** 导出素材库 + 提示词库为 zip 备份 */
  const handleExportBackup = useCallback(async () => {
    if (backupBusy) return;
    setBackupBusy(true);
    setBackupError(null);
    setBackupNotice(null);
    try {
      const blob = await createLibraryBackupZip();
      downloadBlob(blob, buildBackupFileName());
      setBackupNotice(t('assetLibrary.backupDone', '备份已导出'));
      window.setTimeout(() => setBackupNotice(null), 3000);
    } catch (error) {
      console.error('[assetLibrary] backup failed', error);
      setBackupError(t('assetLibrary.backupFailed', '备份失败,请重试'));
    } finally {
      setBackupBusy(false);
    }
  }, [backupBusy, t]);

  /** 从 zip 导入备份(校验后覆盖素材库与提示词库,完成后刷新页面) */
  const handleImportBackup = useCallback(async (file: File) => {
    if (backupBusy) return;
    setBackupBusy(true);
    setBackupError(null);
    setBackupNotice(null);
    try {
      const summary = await importLibraryBackupZip(file);
      setBackupNotice(
        t('assetLibrary.importDone', '导入成功(素材 {{assets}} 个 / 提示词库 {{libs}} 个),即将刷新…', {
          assets: summary.assetCount,
          libs: summary.promptCount,
        })
      );
      // 数据已写入 localStorage,刷新页面让各 store 重新 hydrate
      window.setTimeout(() => window.location.reload(), 1200);
    } catch (error) {
      console.error('[assetLibrary] import backup failed', error);
      setBackupError(
        error instanceof Error
          ? error.message
          : t('assetLibrary.importFailed', '导入失败,请选择有效的备份文件')
      );
    } finally {
      setBackupBusy(false);
    }
  }, [backupBusy, t]);

  const insertAsset = useCallback((asset: LibraryAsset) => {
    if (asset.mediaType === 'image') {
      const definition = nodeCatalog.getDefinition(CANVAS_NODE_TYPES.upload);
      addNode(CANVAS_NODE_TYPES.upload, resolveViewportCenterPosition(), {
        ...definition.createDefaultData(),
        imageUrl: asset.sourcePath,
        previewImageUrl: asset.previewImageUrl ?? asset.sourcePath,
        aspectRatio: asset.aspectRatio ?? '1:1',
        sourceFileName: asset.sourceFileName ?? null,
        displayName: asset.name,
      });
      return;
    }
    if (asset.mediaType === 'audio' || asset.mediaType === 'video') {
      const definition = nodeCatalog.getDefinition(CANVAS_NODE_TYPES.audio);
      addNode(CANVAS_NODE_TYPES.audio, resolveViewportCenterPosition(), {
        ...definition.createDefaultData(),
        sourcePath: asset.sourcePath,
        previewImageUrl: asset.previewImageUrl ?? null,
        mediaType: asset.mediaType,
        displayName: asset.name,
      });
      return;
    }
  }, [addNode]);

  const toggleAssetSelection = useCallback((assetId: string) => {
    setSelectedAssetIds((current) => {
      const next = new Set(current);
      if (next.has(assetId)) next.delete(assetId);
      else next.add(assetId);
      return next;
    });
  }, []);

  const requestNewLibrary = useCallback(() => {
    setRenameDialog({
      mode: 'newLibrary',
      targetId: null,
      title: t('assetLibrary.libraryName', '素材库名称'),
      defaultValue: t('assetLibrary.newLibrary', '新素材库'),
    });
  }, [t]);

  const requestRenameAsset = useCallback((asset: LibraryAsset) => {
    setRenameDialog({
      mode: 'asset',
      targetId: asset.id,
      title: t('assetLibrary.renameAsset', '重命名素材'),
      defaultValue: asset.name,
    });
  }, [t]);

  const handleRenameConfirm = useCallback((name: string) => {
    if (!renameDialog) {
      return;
    }
    if (renameDialog.mode === 'asset' && renameDialog.targetId) {
      renameAsset(renameDialog.targetId, name);
    } else if (renameDialog.mode === 'library' && renameDialog.targetId) {
      renameLibrary(renameDialog.targetId, name);
    } else if (renameDialog.mode === 'newLibrary') {
      createLibrary(name);
    }
    setRenameDialog(null);
  }, [createLibrary, renameAsset, renameDialog, renameLibrary]);

  if (!open) return null;

  const closeAssetMenu = () => {
    setAssetMenu(null);
    setMoveMenuOpen(false);
  };

  const assetMenuAsset = assetMenu ? assets.find((asset) => asset.id === assetMenu.assetId) : null;

  /** 子菜单展开方向: 菜单靠近屏幕右缘时向左展开, 否则向右 */
  const moveSubmenuRight = !assetMenu || assetMenu.x + 340 <= window.innerWidth;

  /** 卡片右上角「...」下拉菜单(portal 到 body): 重命名 / 移动到分组(右侧呼出分组列表) / 删除 */
  const assetMenuNode = assetMenu && assetMenuAsset && (
    <>
      <div className="fixed inset-0 z-[120]" onClick={closeAssetMenu} />
      {createPortal(
        <div
          className="fixed z-[121] w-44 overflow-visible rounded-lg border border-[rgba(255,255,255,0.16)] bg-surface-dark py-1 shadow-2xl"
          style={{ left: assetMenu.x, top: assetMenu.y }}
        >
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-text-dark transition-colors hover:bg-bg-dark"
            onClick={() => {
              requestRenameAsset(assetMenuAsset);
              closeAssetMenu();
            }}
          >
            <Pencil className="h-3.5 w-3.5 text-text-muted" />
            {t('assetLibrary.renameAsset', '重命名')}
          </button>
          <div
            className="relative"
            onMouseEnter={() => setMoveMenuOpen(true)}
          >
            <button
              type="button"
              className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs transition-colors ${moveMenuOpen ? 'bg-bg-dark text-text-dark' : 'text-text-dark hover:bg-bg-dark'}`}
              onClick={(event) => {
                event.stopPropagation();
                setMoveMenuOpen((value) => !value);
              }}
            >
              <span className="flex items-center gap-2">
                <Folder className="h-3.5 w-3.5 text-text-muted" />
                {t('assetLibrary.moveTo', '移动到分组')}
              </span>
              <ChevronRight className={`h-3.5 w-3.5 text-text-muted transition-transform ${moveMenuOpen ? 'rotate-90' : ''}`} />
            </button>
            {moveMenuOpen && (
              <div className={`ui-scrollbar absolute top-0 z-[122] max-h-60 w-40 overflow-y-auto rounded-lg border border-[rgba(255,255,255,0.16)] bg-surface-dark py-1 shadow-2xl ${moveSubmenuRight ? 'left-full ml-1' : 'right-full mr-1'}`}>
                {libraryCategories.length === 0 && (
                  <div className="px-3 py-1.5 text-xs text-text-muted">
                    {t('assetLibrary.noCategories', '暂无分组')}
                  </div>
                )}
                {libraryCategories.map((category) => (
                  <button
                    key={category.id}
                    type="button"
                    className="block w-full truncate px-3 py-1.5 text-left text-xs text-text-dark transition-colors hover:bg-bg-dark"
                    onClick={() => {
                      moveAssetsToCategory([assetMenuAsset.id], category.id);
                      closeAssetMenu();
                    }}
                  >
                    {category.name}
                  </button>
                ))}
                <button
                  type="button"
                  className="block w-full border-t border-border-dark px-3 py-1.5 text-left text-xs text-text-muted transition-colors hover:bg-bg-dark"
                  onClick={() => {
                    moveAssetsToCategory([assetMenuAsset.id], null);
                    closeAssetMenu();
                  }}
                >
                  {t('assetLibrary.uncategorized', '未分组')}
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-red-400 transition-colors hover:bg-bg-dark"
            onClick={() => {
              deleteAssets([assetMenuAsset.id]);
              closeAssetMenu();
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('common.delete', '删除')}
          </button>
        </div>,
        document.body
      )}
    </>
  );

  /** 重命名/新建素材库共用对话框(Tauri 下 window.prompt 不可用) */
  const renameDialogNode = (
    <RenameDialog
      isOpen={Boolean(renameDialog)}
      title={renameDialog?.title ?? ''}
      defaultValue={renameDialog?.defaultValue ?? ''}
      onClose={() => setRenameDialog(null)}
      onConfirm={handleRenameConfirm}
    />
  );

  const assetGrid = (
    <div
      className={`relative flex-1 overflow-y-auto p-3 ${isDragOver ? 'bg-accent/5' : ''}`}
      onDragEnter={(event) => {
        event.preventDefault();
        dragCounterRef.current += 1;
        setIsDragOver(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        event.preventDefault();
        dragCounterRef.current -= 1;
        if (dragCounterRef.current <= 0) {
          dragCounterRef.current = 0;
          setIsDragOver(false);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragCounterRef.current = 0;
        setIsDragOver(false);
        void handleImportFiles(Array.from(event.dataTransfer.files ?? []));
      }}
    >
      {!isHydrated ? (
        <EmptyState label={t('assetLibrary.loading', '加载中…')} />
      ) : visibleAssets.length === 0 ? (
        <EmptyState label={searchQuery ? t('assetLibrary.searchEmpty', '没有匹配的素材') : t('assetLibrary.empty', '还没有素材\n导入图片、视频或音频开始建立素材库')} />
      ) : (
        <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(auto-fill, ${thumbSize}px)` }}>
          {visibleAssets.map((asset) => {
            const selected = selectedAssetIds.has(asset.id);
            return (
              <article
                key={asset.id}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData(ASSET_DRAG_DATA_TYPE, assetDragPayload(asset.id));
                  event.dataTransfer.effectAllowed = 'copy';
                }}
                className={`group relative overflow-hidden rounded-md border bg-bg-dark ${selected ? 'border-accent ring-2 ring-accent/35' : 'border-border-dark hover:border-accent/60'}`}
              >
                <button
                  type="button"
                  className="block w-full text-left"
                  onClick={() => asset.mediaType === 'image' || asset.mediaType === 'audio' || asset.mediaType === 'video' ? insertAsset(asset) : toggleAssetSelection(asset.id)}
                  title={asset.mediaType === 'image' ? t('assetLibrary.insertHint', '点击插入画布') : asset.name}
                >
                  <div className="aspect-square overflow-hidden"><MediaPreview asset={asset} /></div>
                  <div className="flex min-w-0 items-center gap-1 px-2 py-1.5">
                    <span className="shrink-0 text-text-muted">{mediaIcon(asset.mediaType)}</span>
                    <span className="min-w-0 flex-1 truncate text-[11px] text-text-dark">{asset.name}</span>
                  </div>
                </button>
                <button
                  type="button"
                  className="absolute right-1.5 top-1.5 z-10 flex h-7 w-7 items-center justify-center rounded-full border border-white/25 bg-black/50 text-white opacity-80 backdrop-blur-sm transition-all hover:border-accent/70 hover:bg-accent/85 hover:opacity-100"
                  title={t('assetLibrary.more', '更多操作')}
                  onClick={(event) => {
                    event.stopPropagation();
                    setMoveMenuOpen(false);
                    const rect = event.currentTarget.getBoundingClientRect();
                    setAssetMenu({
                      assetId: asset.id,
                      x: Math.min(rect.left, window.innerWidth - 180),
                      y: rect.bottom + 4,
                    });
                  }}
                >
                  <MoreVertical className="h-4 w-4" strokeWidth={2.6} />
                </button>
              </article>
            );
          })}
        </div>
      )}
      {isDragOver && (
        <div className="pointer-events-none fixed inset-0 z-[99] flex items-center justify-center bg-black/25">
          <div className="rounded-md border-2 border-dashed border-accent bg-surface-dark px-10 py-8 text-center shadow-2xl">
            <ImagePlus className="mx-auto h-9 w-9 text-accent" />
            <p className="mt-3 text-sm text-text-dark">{t('assetLibrary.dropHint', '松开鼠标导入图片、视频或音频')}</p>
          </div>
        </div>
      )}
    </div>
  );

  /** 右上角:备份 / 导入(图标按钮) */
  const backupControls = (
    <>
      <UiIconButton
        title={t('assetLibrary.backupHint', '导出素材库和提示词库为 zip 备份文件')}
        onClick={() => void handleExportBackup()}
        disabled={backupBusy}
      >
        <Download className="h-4 w-4" />
      </UiIconButton>
      <UiIconButton
        title={t('assetLibrary.importBackupHint', '从 zip 备份文件恢复素材库和提示词库')}
        onClick={() => backupInputRef.current?.click()}
        disabled={backupBusy}
      >
        <Upload className="h-4 w-4" />
      </UiIconButton>
    </>
  );

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2">
      <UiButton variant="primary" size="sm" onClick={() => fileInputRef.current?.click()} disabled={isImporting}>
        <ImagePlus className="h-4 w-4" />
        {isImporting ? t('assetLibrary.importing', '导入中…') : t('assetLibrary.import', '导入素材')}
      </UiButton>
      <UiButton variant="muted" size="sm" onClick={() => setShowCategoryManager(true)}>
        <FolderCog className="h-4 w-4" />
        {t('assetLibrary.manageCategories', '管理分组')}
      </UiButton>
      <div className="min-w-[126px] flex-1" />
      {selectedAssetIds.size > 0 && (
        <>
          <UiIconButton title={t('assetLibrary.smartClassify', '智能分类')} onClick={() => {
            const changed = classifyAssets([...selectedAssetIds]);
            if (changed === 0) window.alert(t('assetLibrary.classifyNoMatch', '没有找到匹配的分类。请先建立角色、场景或道具分组，并使用有意义的素材名称或标签。'));
          }}>
            <Sparkles className="h-4 w-4 text-amber-300" />
          </UiIconButton>
          <select
            className="h-8 max-w-[132px] rounded-md border border-border-dark bg-bg-dark px-2 text-xs text-text-dark"
            defaultValue=""
            aria-label={t('assetLibrary.moveTo', '移动到分组')}
            onChange={(event) => {
              const value = event.target.value;
              if (!value) return;
              moveAssetsToCategory([...selectedAssetIds], value === '__none__' ? null : value);
              event.target.value = '';
            }}
          >
            <option value="" disabled>{t('assetLibrary.moveTo', '移动到分组')}</option>
            {libraryCategories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
            <option value="__none__">{t('assetLibrary.uncategorized', '未分组')}</option>
          </select>
          <UiIconButton title={t('assetLibrary.deleteSelected', '删除已选')} onClick={() => {
            if (window.confirm(t('assetLibrary.deleteSelectedConfirm', '确定删除选中的 {{count}} 个素材吗?', { count: selectedAssetIds.size }))) {
              deleteAssets([...selectedAssetIds]);
              setSelectedAssetIds(new Set());
            }
          }}>
            <Trash2 className="h-4 w-4 text-red-400" />
          </UiIconButton>
        </>
      )}
    </div>
  );

  const filterBar = (
    <div className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" />
        <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder={t('assetLibrary.search', '搜索素材或标签…')} className="h-8 w-full rounded-md border border-border-dark bg-bg-dark pl-8 pr-2 text-xs text-text-dark outline-none focus:border-accent" />
      </div>
      <div className="flex gap-1">
        {(['all', 'image', 'video', 'audio'] as MediaFilter[]).map((type) => (
          <button key={type} type="button" onClick={() => setMediaFilter(type)} className={`h-7 rounded-md border px-2 text-[11px] ${mediaFilter === type ? 'border-accent/60 bg-accent/15 text-text-dark' : 'border-border-dark text-text-muted hover:bg-bg-dark'}`}>
            {type === 'all' ? t('assetLibrary.all', '全部') : type === 'image' ? t('assetLibrary.images', '图片') : type === 'video' ? t('assetLibrary.videos', '视频') : t('assetLibrary.audio', '音频')}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 pt-0.5">
        <ImagePlus className="h-3.5 w-3.5 shrink-0 text-text-muted/60" />
        <input
          type="range"
          min={84}
          max={220}
          step={2}
          value={thumbSize}
          onChange={(event) => setThumbSize(Number(event.target.value))}
          aria-label={t('assetLibrary.thumbSize', '缩略图大小')}
          className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-border-dark accent-accent"
        />
        <span className="w-8 shrink-0 text-right text-[10px] text-text-muted">{thumbSize}</span>
      </div>
    </div>
  );

  const categoryList = (
    <div className="space-y-1">
      <button type="button" onClick={() => setActiveCategoryId(null)} className={`flex h-8 w-full items-center justify-between rounded-md px-2 text-left text-xs ${activeCategoryId === null ? 'bg-accent/15 text-text-dark' : 'text-text-muted hover:bg-bg-dark'}`}>
        <span>{t('assetLibrary.all', '全部')}</span><span>{libraryAssets.length}</span>
      </button>
      {libraryCategories
        .filter((category) => !category.parentId)
        .map((category) => (
          <div key={category.id}>
            <button
              type="button"
              onClick={() => setActiveCategoryId(category.id)}
              className={`flex h-8 w-full items-center justify-between rounded-md px-2 text-left text-xs ${activeCategoryId === category.id ? 'bg-accent/15 text-text-dark' : 'text-text-muted hover:bg-bg-dark'}`}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <Folder className="h-3.5 w-3.5 shrink-0 text-text-muted/60" />
                <span className="truncate">{category.name}</span>
              </span>
              <span>{libraryAssets.filter((asset) => asset.categoryId === category.id).length}</span>
            </button>
            {libraryCategories
              .filter((child) => child.parentId === category.id)
              .map((child) => (
                <button
                  key={child.id}
                  type="button"
                  onClick={() => setActiveCategoryId(child.id)}
                  className={`flex h-8 w-full items-center justify-between rounded-md pl-6 pr-2 text-left text-xs ${activeCategoryId === child.id ? 'bg-accent/15 text-text-dark' : 'text-text-muted hover:bg-bg-dark'}`}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Folder className="h-3 w-3 shrink-0 text-text-muted/40" />
                    <span className="truncate">{child.name}</span>
                  </span>
                  <span>{libraryAssets.filter((asset) => asset.categoryId === child.id).length}</span>
                </button>
              ))}
          </div>
        ))}
    </div>
  );

  const libraryControls = currentLibrary && (
    <div className="flex items-center gap-1">
      <select value={currentLibrary.id} onChange={(event) => setActiveLibrary(event.target.value)} className="h-8 min-w-0 flex-1 rounded-md border border-border-dark bg-bg-dark px-2 text-xs text-text-dark">
        {libraries.map((library) => <option key={library.id} value={library.id}>{library.name}</option>)}
      </select>
      <UiIconButton title={t('assetLibrary.newLibrary', '新建素材库')} onClick={requestNewLibrary}><Plus className="h-4 w-4" /></UiIconButton>
      <UiIconButton title={t('assetLibrary.renameLibrary', '重命名素材库')} onClick={() => {
        setRenameDialog({
          mode: 'library',
          targetId: currentLibrary.id,
          title: t('assetLibrary.renameLibrary', '重命名素材库'),
          defaultValue: currentLibrary.name,
        });
      }}><Pencil className="h-3.5 w-3.5" /></UiIconButton>
      {libraries.length > 1 && <UiIconButton title={t('assetLibrary.deleteLibrary', '删除素材库')} onClick={() => {
        if (window.confirm(t('assetLibrary.deleteLibraryConfirm', '删除素材库及其全部素材？'))) deleteLibrary(currentLibrary.id);
      }}><Trash2 className="h-3.5 w-3.5 text-red-400" /></UiIconButton>}
    </div>
  );

  const categoryControls = null;

  const fileInput = <input ref={fileInputRef} type="file" accept="image/*,video/*,audio/*" multiple className="hidden" onChange={(event) => { void handleImportFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />;
  const backupFileInput = (
    <input
      ref={backupInputRef}
      type="file"
      accept=".zip,application/zip"
      className="hidden"
      onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (file) void handleImportBackup(file);
      }}
    />
  );
  const backupStatusNotice = (backupNotice || backupError) && (
    <div className={`fixed bottom-6 left-1/2 z-[99] -translate-x-1/2 rounded-lg border px-4 py-2 text-xs shadow-lg ${
      backupError
        ? 'border-red-500/40 bg-red-500/15 text-red-200'
        : 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200'
    }`}>
      {backupError ?? backupNotice}
    </div>
  );

  if (fullscreen) {
    return (
      <div className="fixed inset-0 z-[98] flex flex-col bg-surface-dark" data-asset-library>
        <header className="flex items-center justify-between border-b border-border-dark px-5 py-3">
          <div className="flex items-center gap-2"><Library className="h-5 w-5 text-accent" /><h2 className="text-sm font-medium text-text-dark">{t('assetLibrary.title', '素材库')}</h2><span className="text-xs text-text-muted">{visibleAssets.length}</span></div>
          {/* 图片素材 / 提示词库 tab */}
          <div className="flex items-center gap-1 rounded-lg border border-border-dark bg-bg-dark/50 p-0.5">
            <button
              type="button"
              className={`rounded-md px-3 py-1 text-xs transition-colors ${activeSection === 'assets' ? 'bg-accent/20 text-text-dark' : 'text-text-muted hover:text-text-dark'}`}
              onClick={() => setActiveSection('assets')}
            >
              {t('assetLibrary.assetsTab', '图片素材')}
            </button>
            <button
              type="button"
              className={`rounded-md px-3 py-1 text-xs transition-colors ${activeSection === 'prompts' ? 'bg-accent/20 text-text-dark' : 'text-text-muted hover:text-text-dark'}`}
              onClick={() => setActiveSection('prompts')}
            >
              {t('assetLibrary.promptsTab', '提示词库')}
            </button>
          </div>
          <div className="flex items-center gap-1">
            {backupControls}
            <UiIconButton onClick={onClose} title={t('common.close', '关闭')}><X className="h-4 w-4" /></UiIconButton>
          </div>
        </header>
        {activeSection === 'prompts' ? (
          <div className="min-h-0 flex-1">
            <PromptLibraryPanel
              open={false}
              embedded
              onClose={onClose}
              onApply={(template, mode) => {
                if (onApplyPrompt) {
                  onApplyPrompt(template, mode);
                  onClose();
                }
              }}
            />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            <aside className="flex w-64 shrink-0 flex-col gap-3 border-r border-border-dark p-3">
              {libraryControls}
              <div className="border-t border-border-dark pt-3">{toolbar}</div>
              <div className="min-h-0 flex-1 overflow-y-auto">{categoryList}</div>
              {categoryControls}
            </aside>
            <section className="flex min-w-0 flex-1 flex-col"><div className="border-b border-border-dark p-3">{filterBar}</div>{assetGrid}</section>
          </div>
        )}
        {activeSection === 'assets' && fileInput}
        {activeSection === 'assets' && backupFileInput}
        {backupStatusNotice}
        {assetMenuNode}
        {renameDialogNode}
        <CategoryManagerDialog
          open={showCategoryManager && activeSection === 'assets'}
          onClose={() => setShowCategoryManager(false)}
          libraryId={currentLibrary?.id ?? null}
        />
      </div>
    );
  }

  return (
    <>
      <aside className="fixed right-0 top-0 z-[96] flex h-full flex-col border-l border-border-dark bg-surface-dark shadow-2xl" style={{ width: PANEL_WIDTH }} data-asset-library>
        <header className="flex items-center justify-between border-b border-border-dark px-4 py-3">
          <div className="flex items-center gap-2">
            <Library className="h-4 w-4 text-accent" />
            <h2 className="text-sm font-medium text-text-dark">{t('assetLibrary.title', '素材库')}</h2>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-0.5 rounded-md border border-border-dark bg-bg-dark/50 p-0.5">
              <button
                type="button"
                className={`rounded px-2 py-0.5 text-[11px] transition-colors ${activeSection === 'assets' ? 'bg-accent/20 text-text-dark' : 'text-text-muted hover:text-text-dark'}`}
                onClick={() => setActiveSection('assets')}
              >
                {t('assetLibrary.assetsTab', '图片素材')}
              </button>
              <button
                type="button"
                className={`rounded px-2 py-0.5 text-[11px] transition-colors ${activeSection === 'prompts' ? 'bg-accent/20 text-text-dark' : 'text-text-muted hover:text-text-dark'}`}
                onClick={() => setActiveSection('prompts')}
              >
                {t('assetLibrary.promptsTab', '提示词库')}
              </button>
            </div>
            {backupControls}
            <UiIconButton onClick={onClose} title={t('common.close', '关闭')}><X className="h-4 w-4" /></UiIconButton>
          </div>
        </header>
        {activeSection === 'prompts' ? (
          <div className="min-h-0 flex-1">
            <PromptLibraryPanel
              open={false}
              embedded
              onClose={onClose}
              onApply={(template, mode) => {
                if (onApplyPrompt) {
                  onApplyPrompt(template, mode);
                  onClose();
                }
              }}
            />
          </div>
        ) : (
          <>
            <div className="space-y-2 border-b border-border-dark p-3">{libraryControls}{toolbar}{filterBar}</div>
            <div className="max-h-40 overflow-y-auto border-b border-border-dark p-2">{categoryList}</div>
            {categoryControls && <div className="border-b border-border-dark p-2">{categoryControls}</div>}
            {assetGrid}
            {fileInput}
            {backupFileInput}
            {backupStatusNotice}
            {assetMenuNode}
            {renameDialogNode}
          </>
        )}
      </aside>
      <CategoryManagerDialog
        open={showCategoryManager && activeSection === 'assets'}
        onClose={() => setShowCategoryManager(false)}
        libraryId={currentLibrary?.id ?? null}
      />
    </>
  );
});

AssetLibraryPanel.displayName = 'AssetLibraryPanel';

function EmptyState({ label }: { label: string }) {
  return <div className="flex h-full min-h-56 flex-col items-center justify-center gap-2 text-center"><Library className="h-9 w-9 text-text-muted/40" /><p className="whitespace-pre-line text-xs leading-5 text-text-muted">{label}</p></div>;
}
