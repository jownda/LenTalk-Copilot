import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Plus, Tag, Trash2, X } from 'lucide-react';
import { UiButton, UiModal } from '@/components/ui';

export interface PromptCategoryGroup {
  name: string;
  count: number;
}

interface PromptCategoryManageDialogProps {
  open: boolean;
  onClose: () => void;
  groups: PromptCategoryGroup[];
  onAdd: (name: string) => void;
  onRename: (oldName: string, newName: string) => void;
  onDelete: (name: string) => void;
}

/** 提示词分组(分类)管理弹窗:新增 / 重命名 / 删除分组 */
export function PromptCategoryManageDialog({
  open,
  onClose,
  groups,
  onAdd,
  onRename,
  onDelete,
}: PromptCategoryManageDialogProps) {
  const { t } = useTranslation();
  const [newGroupName, setNewGroupName] = useState('');
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [pendingDeleteName, setPendingDeleteName] = useState<string | null>(null);

  const existingNames = useMemo(() => new Set(groups.map((group) => group.name)), [groups]);

  const handleAdd = () => {
    const name = newGroupName.trim();
    if (!name || existingNames.has(name)) {
      return;
    }
    onAdd(name);
    setNewGroupName('');
  };

  const handleStartRename = (name: string) => {
    setEditingName(name);
    setEditDraft(name);
    setPendingDeleteName(null);
  };

  const handleCommitRename = () => {
    if (!editingName) {
      return;
    }
    const next = editDraft.trim();
    if (!next || next === editingName || existingNames.has(next)) {
      return;
    }
    onRename(editingName, next);
    setEditingName(null);
    setEditDraft('');
  };

  return (
    <UiModal
      isOpen={open}
      onClose={onClose}
      title={t('promptLibrary.manageGroups', '管理分组')}
      footer={(
        <UiButton variant="primary" onClick={onClose}>
          {t('common.close', '关闭')}
        </UiButton>
      )}
    >
      <div className="space-y-3">
        {/* 新增分组 */}
        <div className="flex items-center gap-2">
          <input
            value={newGroupName}
            onChange={(event) => setNewGroupName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                handleAdd();
              }
            }}
            placeholder={t('promptLibrary.groupNamePlaceholder', '分组名称')}
            className="h-9 min-w-0 flex-1 rounded-md border border-border-dark bg-bg-dark/70 px-2.5 text-xs text-text-dark outline-none placeholder:text-text-muted/60 focus:border-accent"
          />
          <UiButton
            variant="primary"
            size="sm"
            onClick={handleAdd}
            disabled={!newGroupName.trim() || existingNames.has(newGroupName.trim())}
          >
            <Plus className="h-3.5 w-3.5" />
            {t('promptLibrary.addGroup', '新增分组')}
          </UiButton>
        </div>

        {/* 分组列表 */}
        <div className="ui-scrollbar max-h-[320px] space-y-1 overflow-y-auto">
          {groups.length === 0 ? (
            <p className="py-6 text-center text-xs text-text-muted/60">
              {t('promptLibrary.groupEmpty', '暂无分组,点击上方新增分组')}
            </p>
          ) : (
            groups.map((group) => {
              const isEditing = editingName === group.name;
              const isConfirmingDelete = pendingDeleteName === group.name;
              return (
                <div
                  key={group.name}
                  className="flex items-center gap-2 rounded-md border border-border-dark bg-bg-dark px-2.5 py-2"
                >
                  <Tag className="h-3.5 w-3.5 shrink-0 text-text-muted/60" />
                  {isEditing ? (
                    <>
                      <input
                        value={editDraft}
                        onChange={(event) => setEditDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            handleCommitRename();
                          }
                          if (event.key === 'Escape') {
                            setEditingName(null);
                          }
                        }}
                        autoFocus
                        className="h-8 min-w-0 flex-1 rounded border border-border-dark bg-surface-dark px-2 text-xs text-text-dark outline-none focus:border-accent"
                      />
                      <button
                        type="button"
                        className="shrink-0 rounded px-1.5 py-1 text-[11px] text-accent hover:bg-bg-dark"
                        onClick={handleCommitRename}
                        disabled={!editDraft.trim() || editDraft.trim() === group.name}
                      >
                        {t('common.save', '保存')}
                      </button>
                      <button
                        type="button"
                        className="shrink-0 rounded p-1 text-text-muted hover:bg-bg-dark"
                        onClick={() => setEditingName(null)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 truncate text-xs text-text-dark">
                        {group.name}
                      </span>
                      <span className="shrink-0 text-[10px] text-text-muted/60">
                        {t('promptLibrary.groupCount', '{{count}} 条', { count: group.count })}
                      </span>
                      <button
                        type="button"
                        className="shrink-0 rounded p-1 text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark"
                        onClick={() => handleStartRename(group.name)}
                        title={t('promptLibrary.renameGroup', '重命名')}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        className={`shrink-0 rounded p-1 transition-colors ${
                          isConfirmingDelete
                            ? 'bg-red-500/20 text-red-300'
                            : 'text-text-muted hover:bg-bg-dark hover:text-red-400'
                        }`}
                        onClick={() => {
                          if (isConfirmingDelete) {
                            onDelete(group.name);
                            setPendingDeleteName(null);
                          } else {
                            setPendingDeleteName(group.name);
                            setEditingName(null);
                          }
                        }}
                        title={t('promptLibrary.deleteGroup', '删除分组')}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </>
                  )}
                  {isConfirmingDelete && (
                    <p className="w-full text-[10px] leading-4 text-red-300">
                      {t('promptLibrary.deleteGroupConfirm', '删除分组将同时删除该分组下的 {{count}} 条提示词,确认删除?', {
                        count: group.count,
                      })}
                      <button
                        type="button"
                        className="ml-1 text-accent hover:underline"
                        onClick={() => setPendingDeleteName(null)}
                      >
                        {t('common.cancel', '取消')}
                      </button>
                    </p>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </UiModal>
  );
}
