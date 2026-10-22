import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Folder, FolderCog, Pencil, Plus, Trash2, X } from 'lucide-react';

import { useAssetLibraryStore } from './assetStore';
import type { AssetCategory } from './types';
import { UiButton, UiGhostIconButton, UiModal } from '@/components/ui/primitives';

export interface CategoryManagerDialogProps {
  open: boolean;
  onClose: () => void;
  libraryId: string | null;
}

export const CategoryManagerDialog = memo(({ open, onClose, libraryId }: CategoryManagerDialogProps) => {
  const { t } = useTranslation();
  const categories = useAssetLibraryStore((state) => state.categories);
  const assets = useAssetLibraryStore((state) => state.assets);
  const addCategory = useAssetLibraryStore((state) => state.addCategory);
  const renameCategory = useAssetLibraryStore((state) => state.renameCategory);
  const deleteCategory = useAssetLibraryStore((state) => state.deleteCategory);
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const libraryCategories = useMemo(
    () => categories.filter((category) => category.libraryId === libraryId && !category.parentId),
    [categories, libraryId]
  );

  const categoryCount = (categoryId: string) =>
    assets.filter((asset) => asset.libraryId === libraryId && asset.categoryId === categoryId).length;

  const addGroup = () => {
    if (!libraryId || !newName.trim()) return;
    if (addCategory(libraryId, newName)) setNewName('');
  };

  const startRename = (category: AssetCategory) => {
    setEditingId(category.id);
    setEditName(category.name);
    setPendingDeleteId(null);
  };

  const saveRename = () => {
    if (!editingId || !editName.trim()) return;
    renameCategory(editingId, editName);
    setEditingId(null);
    setEditName('');
  };

  return (
    <UiModal
      isOpen={open}
      title={t('assetLibrary.manageCategories', '管理分组')}
      onClose={onClose}
      widthClassName="w-[min(460px,calc(100vw-40px))]"
      footer={<UiButton variant="ghost" size="sm" onClick={onClose}>{t('common.close', '关闭')}</UiButton>}
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <input
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && addGroup()}
            placeholder={t('assetLibrary.categoryNamePlaceholder', '分组名称')}
            className="h-9 min-w-0 flex-1 rounded-md border border-border-dark bg-bg-dark px-2.5 text-xs text-text-dark outline-none placeholder:text-text-muted/60 focus:border-accent"
          />
          <UiButton variant="primary" size="sm" onClick={addGroup} disabled={!newName.trim() || !libraryId}>
            <Plus className="h-3.5 w-3.5" />
            {t('assetLibrary.newCategory', '新建分组')}
          </UiButton>
        </div>
        <p className="text-[11px] leading-4 text-text-muted">
          {t('assetLibrary.builtinCategoryHint', '角色、场景、道具为内置分组，不能重命名或删除。')}
        </p>
        <div className="ui-scrollbar max-h-[320px] space-y-1 overflow-y-auto">
          {libraryCategories.map((category) => {
            const editing = editingId === category.id;
            const confirmingDelete = pendingDeleteId === category.id;
            return (
              <div key={category.id} className="rounded-md border border-border-dark bg-bg-dark px-2.5 py-2">
                <div className="flex items-center gap-2">
                  {category.builtin ? <FolderCog className="h-3.5 w-3.5 shrink-0 text-accent/80" /> : <Folder className="h-3.5 w-3.5 shrink-0 text-text-muted/70" />}
                  {editing ? (
                    <input
                      autoFocus
                      value={editName}
                      onChange={(event) => setEditName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') saveRename();
                        if (event.key === 'Escape') setEditingId(null);
                      }}
                      className="h-7 min-w-0 flex-1 rounded border border-border-dark bg-surface-dark px-2 text-xs text-text-dark outline-none focus:border-accent"
                    />
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-xs text-text-dark">{category.name}</span>
                  )}
                  <span className="shrink-0 text-[10px] text-text-muted/60">{t('assetLibrary.count', '{{count}} 个素材', { count: categoryCount(category.id) })}</span>
                  {editing ? (
                    <>
                      <button type="button" className="shrink-0 px-1 text-[11px] text-accent" onClick={saveRename}>{t('common.save', '保存')}</button>
                      <UiGhostIconButton className="h-6 w-6" title={t('common.cancel', '取消')} onClick={() => setEditingId(null)}><X className="h-3.5 w-3.5" /></UiGhostIconButton>
                    </>
                  ) : !category.builtin && (
                    <>
                      <UiGhostIconButton className="h-6 w-6" title={t('common.rename', '重命名')} onClick={() => startRename(category)}><Pencil className="h-3.5 w-3.5" /></UiGhostIconButton>
                      <UiGhostIconButton
                        className={`h-6 w-6 ${confirmingDelete ? '!text-red-300' : ''}`}
                        title={confirmingDelete ? t('common.confirm', '确认') : t('common.delete', '删除')}
                        onClick={() => {
                          if (confirmingDelete) {
                            deleteCategory(category.id);
                            setPendingDeleteId(null);
                          } else {
                            setPendingDeleteId(category.id);
                          }
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </UiGhostIconButton>
                    </>
                  )}
                </div>
                {confirmingDelete && (
                  <p className="mt-1.5 text-[10px] leading-4 text-red-300">
                    {t('assetLibrary.deleteCategoryConfirm', '删除分组，素材将保留为未分组。')}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </UiModal>
  );
});

CategoryManagerDialog.displayName = 'CategoryManagerDialog';
