import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Folder, FolderPlus, Pencil, Plus, Trash2 } from 'lucide-react';

import { useAssetLibraryStore } from './assetStore';
import type { AssetCategory } from './types';
import { UiButton, UiIconButton, UiModal } from '@/components/ui/primitives';

export interface CategoryManagerDialogProps {
  open: boolean;
  onClose: () => void;
  libraryId: string | null;
}

export const CategoryManagerDialog = memo(({ open, onClose, libraryId }: CategoryManagerDialogProps) => {
  const { t } = useTranslation();
  const categories = useAssetLibraryStore((state) => state.categories);
  const addCategory = useAssetLibraryStore((state) => state.addCategory);
  const renameCategory = useAssetLibraryStore((state) => state.renameCategory);
  const deleteCategory = useAssetLibraryStore((state) => state.deleteCategory);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const libraryCategories = useMemo(
    () => categories.filter((category) => category.libraryId === libraryId),
    [categories, libraryId]
  );

  const topLevelCategories = useMemo(
    () => libraryCategories.filter((category) => !category.parentId),
    [libraryCategories]
  );

  const childrenOf = (parentId: string) =>
    libraryCategories.filter((category) => category.parentId === parentId);

  const countAssets = (category: AssetCategory): number => {
    const { assets } = useAssetLibraryStore.getState();
    return assets.filter((asset) => asset.libraryId === libraryId && asset.categoryId === category.id).length;
  };

  const toggleExpand = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleNewTopLevel = () => {
    if (!libraryId) return;
    const name = window.prompt(t('assetLibrary.categoryPrompt', '输入新分组名称:'), '');
    if (name?.trim()) {
      addCategory(libraryId, name.trim());
    }
  };

  const handleNewChild = (parent: AssetCategory) => {
    if (!libraryId) return;
    const name = window.prompt(t('assetLibrary.subCategoryPrompt', '输入子分组名称:'), '');
    if (name?.trim()) {
      addCategory(libraryId, name.trim(), parent.id);
      setExpanded((current) => new Set(current).add(parent.id));
    }
  };

  const handleRename = (category: AssetCategory) => {
    const name = window.prompt(t('assetLibrary.categoryPrompt', '输入新分组名称:'), category.name);
    if (name?.trim()) {
      renameCategory(category.id, name.trim());
    }
  };

  const handleDelete = (category: AssetCategory) => {
    if (pendingDeleteId !== category.id) {
      setPendingDeleteId(category.id);
      return;
    }
    deleteCategory(category.id);
    setPendingDeleteId(null);
  };

  const renderRow = (category: AssetCategory, depth: number) => {
    const hasChildren = childrenOf(category.id).length > 0;
    const isExpanded = expanded.has(category.id);
    const count = countAssets(category);

    return (
      <div key={category.id}>
        <div
          className="group flex h-9 items-center gap-1 rounded-md px-2 transition-colors hover:bg-bg-dark"
          style={{ paddingLeft: 8 + depth * 16 }}
        >
          <button
            type="button"
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-muted/60 hover:bg-bg-dark hover:text-text-dark"
            onClick={() => toggleExpand(category.id)}
            disabled={!hasChildren}
          >
            {hasChildren ? (
              isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />
            ) : (
              <span className="w-3.5" />
            )}
          </button>
          <Folder className="h-4 w-4 shrink-0 text-accent/80" />
          <span className="min-w-0 flex-1 truncate text-xs text-text-dark">{category.name}</span>
          <span className="shrink-0 text-[10px] text-text-muted/60">{count}</span>
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <UiIconButton
              className="h-6 w-6"
              title={t('assetLibrary.addSubCategory', '新建子分组')}
              onClick={() => handleNewChild(category)}
            >
              <Plus className="h-3 w-3" />
            </UiIconButton>
            <UiIconButton
              className="h-6 w-6"
              title={t('common.rename', '重命名')}
              onClick={() => handleRename(category)}
            >
              <Pencil className="h-3 w-3" />
            </UiIconButton>
            <UiIconButton
              className={`h-6 w-6 ${pendingDeleteId === category.id ? '!border-red-500/50 !bg-red-500/15 !text-red-300' : ''}`}
              title={pendingDeleteId === category.id ? t('common.confirmDelete', '确认删除') : t('common.delete', '删除')}
              onClick={() => handleDelete(category)}
            >
              <Trash2 className="h-3 w-3" />
            </UiIconButton>
          </div>
        </div>
        {isExpanded &&
          childrenOf(category.id).map((child) => renderRow(child, depth + 1))}
      </div>
    );
  };

  return (
    <UiModal
      isOpen={open}
      title={t('assetLibrary.manageCategories', '管理分组')}
      onClose={onClose}
      widthClassName="w-[min(480px,calc(100vw-40px))]"
      footer={
        <div className="flex gap-2">
          <UiButton variant="ghost" size="sm" onClick={onClose}>
            {t('common.close', '关闭')}
          </UiButton>
        </div>
      }
    >
      <div className="flex items-center justify-between border-b border-border-dark pb-3">
        <p className="text-xs text-text-muted">
          {t('assetLibrary.manageCategoriesHint', '新建分组、子分组，或重命名 / 删除现有分组')}
        </p>
        <UiButton variant="primary" size="sm" onClick={handleNewTopLevel} disabled={!libraryId}>
          <FolderPlus className="h-4 w-4" />
          {t('assetLibrary.newCategory', '新建分组')}
        </UiButton>
      </div>
      <div className="ui-scrollbar mt-3 max-h-[50vh] space-y-0.5 overflow-y-auto">
        {topLevelCategories.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center text-text-muted">
            <Folder className="h-8 w-8 opacity-40" />
            <p className="text-xs">{t('assetLibrary.noCategories', '还没有分组，点击「新建分组」创建')}</p>
          </div>
        ) : (
          topLevelCategories.map((category) => renderRow(category, 0))
        )}
      </div>
    </UiModal>
  );
});

CategoryManagerDialog.displayName = 'CategoryManagerDialog';
