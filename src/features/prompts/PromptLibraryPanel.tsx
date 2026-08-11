import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  Check,
  CheckSquare,
  FilePlus2,
  Library,
  ListChecks,
  Pencil,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { UiButton, UiIconButton } from '@/components/ui/primitives';
import { PROMPT_DRAG_DATA_TYPE, promptDragPayload } from '@/features/library/importAssets';
import { PromptCategoryManageDialog } from './PromptCategoryManageDialog';
import {
  usePromptLibraryStore,
  type PromptLibrary,
  type PromptTemplate,
} from './promptLibraryStore';

export interface PromptLibraryPanelProps {
  open: boolean;
  onClose: () => void;
  onApply: (template: PromptTemplate, mode: 'positive' | 'full') => void;
  /** 嵌入模式:不作为独立全屏面板渲染,而是填充父容器(素材库内嵌提示词 tab 用) */
  embedded?: boolean;
}

interface PromptDraft {
  name: string;
  scene: string;
  positive: string;
  negative: string;
  category: string;
}

const EMPTY_DRAFT: PromptDraft = {
  name: '',
  scene: '',
  positive: '',
  negative: '',
  category: 'custom',
};

/** 「全部」词库的特殊 id:聚合所有词库的提示词 */
const ALL_LIBRARIES_ID = '__all__';

/** 英文分类 → 中文显示(内置词库分类映射;未知分类原样返回) */
const CATEGORY_LABELS: Record<string, string> = {
  lighting: '光影',
  view: '视角',
  character: '角色',
  product: '产品',
  storyboard: '分镜',
  custom: '自定义',
};

function resolveCategoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

export function PromptLibraryPanel({ open, onClose, onApply, embedded = false }: PromptLibraryPanelProps) {
  const { t } = useTranslation();
  const libraries = usePromptLibraryStore((state) => state.libraries);
  const promptCategories = usePromptLibraryStore((state) => state.categories);
  const addLibrary = usePromptLibraryStore((state) => state.addLibrary);
  const renameLibrary = usePromptLibraryStore((state) => state.renameLibrary);
  const deleteLibrary = usePromptLibraryStore((state) => state.deleteLibrary);
  const addTemplate = usePromptLibraryStore((state) => state.addTemplate);
  const updateTemplate = usePromptLibraryStore((state) => state.updateTemplate);
  const deleteTemplate = usePromptLibraryStore((state) => state.deleteTemplate);
  const addCategory = usePromptLibraryStore((state) => state.addCategory);
  const renameCategory = usePromptLibraryStore((state) => state.renameCategory);
  const deleteCategory = usePromptLibraryStore((state) => state.deleteCategory);

  const [activeLibraryId, setActiveLibraryId] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState('all');
  const [search, setSearch] = useState('');
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isManageMode, setIsManageMode] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PromptDraft>(EMPTY_DRAFT);
  const [pendingDeletePromptId, setPendingDeletePromptId] = useState<string | null>(null);
  const [pendingBatchDelete, setPendingBatchDelete] = useState(false);
  const [pendingDeleteLibraryId, setPendingDeleteLibraryId] = useState<string | null>(null);
  const [showCategoryManage, setShowCategoryManage] = useState(false);
  /** 嵌入模式下创建提示词的目标词库 id(可能是切换中的词库) */
  const [createTargetLibraryId, setCreateTargetLibraryId] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const hasInitializedRef = useRef(false);

  const activeLibrary = useMemo(
    () => libraries.find((lib) => lib.id === activeLibraryId) ?? libraries[0] ?? null,
    [libraries, activeLibraryId]
  );
  const isReadonly = Boolean(activeLibrary?.readonly);
  /** 是否处于「全部」模式(聚合所有词库) */
  const isAllMode = activeLibraryId === ALL_LIBRARIES_ID;

  // 打开(或嵌入挂载)时初始化激活库与分类
  useEffect(() => {
    if (!open && !embedded) {
      return;
    }
    // 仅在组件挂载时初始化一次:默认选中「全部」(聚合所有词库)
    if (!hasInitializedRef.current) {
      hasInitializedRef.current = true;
      if (libraries.length > 0 && !activeLibraryId) {
        setActiveLibraryId(ALL_LIBRARIES_ID);
      } else if (libraries.length === 0) {
        setActiveLibraryId(null);
      }
      setSelectedIds(new Set());
      setIsManageMode(false);
      setIsCreating(false);
      setEditingId(null);
    }
  }, [open, embedded, libraries, activeLibraryId]);

  const categories = useMemo(() => {
    const items = isAllMode
      ? libraries.flatMap((lib) => lib.items)
      : (activeLibrary?.items ?? []);
    return ['all', ...new Set(items.map((item) => item.category).filter(Boolean))];
  }, [activeLibrary, isAllMode, libraries]);

  /** 跨所有词库的已有分类(用于新建/编辑表单的分类下拉) */
  const allCategoryOptions = useMemo(() => {
    return [...new Set(
      libraries.flatMap((lib) => lib.items)
        .map((item) => item.category)
        .filter((category) => Boolean(category) && category !== 'all' && category !== 'custom')
    )];
  }, [libraries]);

  /** 分组列表:自定义分组定义 + 条目中出现的分类,含条数 */
  const promptGroups = useMemo(() => {
    const counts = new Map<string, number>();
    libraries.forEach((lib) => {
      lib.items.forEach((item) => {
        if (item.category && item.category !== 'all') {
          counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
        }
      });
    });
    const names = new Set<string>([...(promptCategories ?? []), ...counts.keys()]);
    return Array.from(names)
      .filter((name) => Boolean(name) && name !== 'all')
      .sort((left, right) => left.localeCompare(right))
      .map((name) => ({ name, count: counts.get(name) ?? 0 }));
  }, [promptCategories, libraries]);

  const visibleTemplates = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const items = isAllMode
      ? libraries.flatMap((lib) => lib.items)
      : (activeLibrary?.items ?? []);
    return items
      .filter((template) => activeCategory === 'all' || template.category === activeCategory)
      .filter((template) => {
        if (!query) {
          return true;
        }
        return [template.name, template.scene, template.positive, template.negative]
          .some((value) => value.toLocaleLowerCase().includes(query));
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [activeLibrary, activeCategory, isAllMode, libraries, search]);

  // 选中态清理
  useEffect(() => {
    if (selectedTemplateId && !visibleTemplates.some((item) => item.id === selectedTemplateId)) {
      setSelectedTemplateId(visibleTemplates[0]?.id ?? null);
    }
  }, [visibleTemplates, selectedTemplateId]);

  const selectedTemplate = useMemo(
    () => (selectedTemplateId
      ? (isAllMode
          ? libraries.flatMap((lib) => lib.items).find((item) => item.id === selectedTemplateId)
          : activeLibrary?.items.find((item) => item.id === selectedTemplateId)) ?? null
      : null),
    [activeLibrary, isAllMode, libraries, selectedTemplateId]
  );

  const startCreate = useCallback(() => {
    // 新增目标:当前非只读库优先,否则第一个可编辑(非只读)库;
    // 「全部」模式不能落到只读内置库
    const targetId =
      activeLibrary && !activeLibrary.readonly
        ? activeLibrary.id
        : (libraries.find((lib) => !lib.readonly)?.id ?? null);
    if (!targetId) {
      return;
    }
    setEditingId(null);
    setIsCreating(true);
    setCreateTargetLibraryId(targetId);
    setDraft({ ...EMPTY_DRAFT, category: activeCategory === 'all' ? 'custom' : activeCategory });
  }, [activeCategory, activeLibrary, libraries]);

  const startEdit = useCallback((template: PromptTemplate) => {
    setIsCreating(false);
    setEditingId(template.id);
    setDraft({
      name: template.name,
      scene: template.scene,
      positive: template.positive,
      negative: template.negative,
      category: template.category,
    });
  }, []);

  const saveDraft = useCallback(() => {
    const targetLibraryId = createTargetLibraryId ?? activeLibrary?.id ?? null;
    if (!targetLibraryId) {
      return;
    }
    const name = draft.name.trim();
    const positive = draft.positive.trim();
    if (!name || !positive) {
      return;
    }
    if (isCreating) {
      addTemplate(targetLibraryId, {
        name,
        scene: draft.scene.trim(),
        positive,
        negative: draft.negative.trim(),
        category: draft.category.trim() || 'custom',
      });
      setIsCreating(false);
      setCreateTargetLibraryId(null);
    } else if (editingId) {
      updateTemplate(activeLibrary.id, editingId, {
        name,
        scene: draft.scene.trim(),
        positive,
        negative: draft.negative.trim(),
        category: draft.category.trim() || 'custom',
      });
      setEditingId(null);
      setCreateTargetLibraryId(null);
    }
    setDraft(EMPTY_DRAFT);
  }, [activeLibrary, addTemplate, createTargetLibraryId, draft, editingId, isCreating, updateTemplate]);

  const handleApply = useCallback((template: PromptTemplate, mode: 'positive' | 'full') => {
    onApply(template, mode);
    onClose();
  }, [onApply, onClose]);

  const handleDeletePrompt = useCallback((id: string) => {
    if (!activeLibrary) {
      return;
    }
    // 「全部」模式下 activeLibrary 会 fallback 到第一个库(通常是只读内置库),
    // 必须按卡片 id 找到它真实所属的词库,否则 filter 删不到目标条目。
    const ownerLibrary = libraries.find((lib) => lib.items.some((item) => item.id === id));
    if (!ownerLibrary) {
      return;
    }
    // 只读词库(内置预设)禁止删除条目
    if (ownerLibrary.readonly) {
      return;
    }
    if (pendingDeletePromptId !== id) {
      setPendingDeletePromptId(id);
      return;
    }
    deleteTemplate(ownerLibrary.id, id);
    setPendingDeletePromptId(null);
    if (selectedTemplateId === id) {
      setSelectedTemplateId(null);
    }
    setSelectedIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }, [activeLibrary, deleteTemplate, libraries, pendingDeletePromptId, selectedTemplateId]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleDeleteSelected = useCallback(() => {
    if (!activeLibrary || selectedIds.size === 0) {
      return;
    }
    if (!pendingBatchDelete) {
      setPendingBatchDelete(true);
      return;
    }
    // 与单条删除一致:按卡片真实所属词库删除,跳过只读词库条目
    selectedIds.forEach((id) => {
      const ownerLibrary = libraries.find((lib) => lib.items.some((item) => item.id === id));
      if (ownerLibrary && !ownerLibrary.readonly) {
        deleteTemplate(ownerLibrary.id, id);
      }
    });
    setSelectedIds(new Set());
    setPendingBatchDelete(false);
  }, [activeLibrary, deleteTemplate, libraries, pendingBatchDelete, selectedIds]);

  const handleAddLibrary = useCallback(() => {
    const name = window.prompt(t('promptLibrary.libName', '提示词库名称'), t('promptLibrary.newLib', '新提示词库'));
    if (!name?.trim()) {
      return;
    }
    const library = addLibrary(name.trim());
    if (library) {
      setActiveLibraryId(library.id);
    }
  }, [addLibrary, t]);

  const handleRenameLibrary = useCallback(() => {
    if (!activeLibrary) {
      return;
    }
    const name = window.prompt(t('promptLibrary.libName', '提示词库名称'), activeLibrary.name);
    if (name?.trim()) {
      renameLibrary(activeLibrary.id, name.trim());
    }
  }, [activeLibrary, renameLibrary, t]);

  const handleDeleteLibrary = useCallback(() => {
    if (!activeLibrary) {
      return;
    }
    if (pendingDeleteLibraryId !== activeLibrary.id) {
      setPendingDeleteLibraryId(activeLibrary.id);
      return;
    }
    deleteLibrary(activeLibrary.id);
    setPendingDeleteLibraryId(null);
    setActiveLibraryId(null);
    setSelectedTemplateId(null);
    setSelectedIds(new Set());
  }, [activeLibrary, deleteLibrary, pendingDeleteLibraryId]);

  if (!open && !embedded) {
    return null;
  }

  const inputClass =
    'w-full rounded-md border border-border-dark bg-bg-dark/70 px-2.5 py-2 text-xs text-text-dark outline-none transition-colors placeholder:text-text-muted/60 focus:border-accent';

  // 嵌入模式:卡片形式(词库下拉 + 分类 chips + 卡片网格),适配素材库侧栏宽度
  if (embedded) {
    return (
      <>
      <div className="flex h-full w-full flex-col bg-surface-dark">
        {/* 顶部:词库切换 + 新增 + 搜索 */}
        <div className="flex items-center gap-2 border-b border-border-dark px-3 py-2">
          <select
            value={isAllMode ? ALL_LIBRARIES_ID : (activeLibrary?.id ?? '')}
            onChange={(event) => {
              setActiveLibraryId(event.target.value || null);
              setActiveCategory('all');
              setSelectedTemplateId(null);
              setSearch('');
            }}
            className="h-8 min-w-0 flex-1 rounded-md border border-border-dark bg-bg-dark/70 px-2 text-xs text-text-dark outline-none focus:border-accent"
            aria-label={t('promptLibrary.title', '提示词库')}
          >
            {libraries.length === 0 && <option value="">{t('promptLibrary.noLib', '还没有提示词库')}</option>}
            <option value={ALL_LIBRARIES_ID}>{t('promptLibrary.all', '全部')}</option>
            {libraries.map((lib) => (
              <option key={lib.id} value={lib.id}>
                {lib.name}{lib.readonly ? ' · ' + t('promptLibrary.builtin', '内置') : ''}
              </option>
            ))}
          </select>
          <div className="relative shrink-0">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-text-muted/70" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('promptLibrary.search', '搜索')}
              className="h-8 w-24 rounded-md border border-border-dark bg-bg-dark/70 pl-6 pr-2 text-xs text-text-dark outline-none placeholder:text-text-muted/60 focus:border-accent"
            />
          </div>
          <button
            type="button"
            className="flex h-8 shrink-0 items-center gap-1 rounded-md bg-accent px-2 text-[11px] font-medium text-white transition-colors hover:bg-accent/85"
            onClick={() => {
              // 新增目标:当前非只读库,或第一个可编辑库;「全部」模式不落到只读内置库
              let targetId =
                activeLibrary && !activeLibrary.readonly
                  ? activeLibrary.id
                  : (libraries.find((lib) => !lib.readonly)?.id ?? null);
              if (!targetId) {
                // 没有可编辑词库:弹窗新建一个
                const name = window.prompt(
                  t('promptLibrary.libName', '提示词库名称'),
                  t('promptLibrary.newLib', '新提示词库')
                );
                if (!name?.trim()) {
                  return;
                }
                const library = addLibrary(name.trim());
                if (!library) {
                  return;
                }
                targetId = library.id;
              }
              setEditingId(null);
              setIsCreating(true);
              setCreateTargetLibraryId(targetId);
              setDraft({ ...EMPTY_DRAFT, category: 'custom' });
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            {t('promptLibrary.add', '新增')}
          </button>
        </div>

        {/* 分类 chips */}
        <div className="flex flex-wrap items-center gap-1 border-b border-border-dark px-3 py-1.5">
          {categories.map((category) => (
            <button
              key={category}
              type="button"
              onClick={() => setActiveCategory(category)}
              className={`h-6 rounded-full border px-2 text-[11px] transition-colors ${
                activeCategory === category
                  ? 'border-accent/50 bg-accent/15 text-text-dark'
                  : 'border-border-dark text-text-muted hover:bg-bg-dark'
              }`}
            >
              {category === 'all' ? t('promptLibrary.all', '全部') : resolveCategoryLabel(category)}
            </button>
          ))}
          <button
            type="button"
            className="ml-auto flex h-6 shrink-0 items-center gap-1 rounded-md border border-border-dark px-2 text-[10px] text-text-muted transition-colors hover:border-accent/40 hover:text-text-dark"
            onClick={() => setShowCategoryManage(true)}
            title={t('promptLibrary.manageGroups', '管理分组')}
          >
            <Settings2 className="h-3 w-3" />
            {t('promptLibrary.manageGroups', '管理分组')}
          </button>
        </div>

        {/* 卡片网格 */}
        <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto p-2">
          {(isCreating || editingId) && activeLibrary ? (
            <div className="space-y-3 rounded-lg border border-border-dark bg-bg-dark p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-text-dark">
                  {isCreating ? t('promptLibrary.newPrompt', '新增提示词') : t('promptLibrary.editPrompt', '编辑提示词')}
                </span>
                <button
                  type="button"
                  className="rounded p-1 text-text-muted hover:bg-bg-dark hover:text-text-dark"
                  onClick={() => {
                    setIsCreating(false);
                    setEditingId(null);
                    setCreateTargetLibraryId(null);
                    setDraft(EMPTY_DRAFT);
                  }}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <label className="block">
                <span className="mb-1 block text-[10px] text-text-muted">{t('promptLibrary.name', '名称')}</span>
                <input
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  placeholder={t('promptLibrary.namePlaceholder', '提示词名称')}
                  className={inputClass}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[10px] text-text-muted">{t('promptLibrary.scene', '用途说明')}</span>
                <textarea
                  value={draft.scene}
                  onChange={(event) => setDraft({ ...draft, scene: event.target.value })}
                  rows={2}
                  className={`${inputClass} resize-none`}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[10px] text-text-muted">{t('promptLibrary.positive', '正向提示词')}</span>
                <textarea
                  value={draft.positive}
                  onChange={(event) => setDraft({ ...draft, positive: event.target.value })}
                  rows={5}
                  className={`${inputClass} resize-none font-mono leading-5`}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[10px] text-text-muted">{t('promptLibrary.negative', '负向提示词')}</span>
                <textarea
                  value={draft.negative}
                  onChange={(event) => setDraft({ ...draft, negative: event.target.value })}
                  rows={3}
                  className={`${inputClass} resize-none font-mono leading-5`}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[10px] text-text-muted">{t('promptLibrary.category', '分类')}</span>
                <select
                  value={draft.category}
                  onChange={(event) => setDraft({ ...draft, category: event.target.value })}
                  className={inputClass}
                >
                  <option value="custom">{t('promptLibrary.custom', '自定义')}</option>
                  {allCategoryOptions.map((category) => (
                    <option key={category} value={category}>
                      {resolveCategoryLabel(category)}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className="rounded-md border border-border-dark px-3 py-1.5 text-xs text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark"
                  onClick={() => {
                    setIsCreating(false);
                    setEditingId(null);
                    setCreateTargetLibraryId(null);
                    setDraft(EMPTY_DRAFT);
                  }}
                >
                  {t('common.cancel', '取消')}
                </button>
                <button
                  type="button"
                  className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent/85 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!draft.name.trim() || !draft.positive.trim()}
                  onClick={saveDraft}
                >
                  {t('common.save', '保存')}
                </button>
              </div>
            </div>
          ) : !activeLibrary ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center text-text-muted">
              <BookOpen className="h-8 w-8 opacity-40" />
              <p className="text-xs">{t('promptLibrary.noLibHint', '请先创建提示词库')}</p>
              <button
                type="button"
                className="text-xs text-accent hover:underline"
                onClick={() => {
                  const name = window.prompt(t('promptLibrary.libName', '提示词库名称'), t('promptLibrary.newLib', '新提示词库'));
                  if (name?.trim()) {
                    const lib = addLibrary(name.trim());
                    if (lib) setActiveLibraryId(lib.id);
                  }
                }}
              >
                {t('promptLibrary.addLib', '新建提示词库')}
              </button>
            </div>
          ) : visibleTemplates.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center text-text-muted">
              <BookOpen className="h-8 w-8 opacity-40" />
              <p className="text-xs">
                {search || activeCategory !== 'all'
                  ? t('promptLibrary.searchEmpty', '没有匹配的提示词')
                  : t('promptLibrary.empty', '还没有提示词')}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {visibleTemplates.map((template) => {
                // 查找卡片真实所属词库(「全部」模式下 activeLibrary 不可信)
                const ownerLibrary = libraries.find((lib) => lib.items.some((item) => item.id === template.id));
                const isReadonlyCard = Boolean(ownerLibrary?.readonly);
                return (
                <div
                  key={template.id}
                  className={`group flex cursor-grab flex-col rounded-lg border p-2 transition-colors active:cursor-grabbing ${
                    selectedTemplateId === template.id
                      ? 'border-accent/50 bg-accent/10'
                      : 'border-border-dark bg-bg-dark hover:border-[rgba(255,255,255,0.25)]'
                  }`}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData(PROMPT_DRAG_DATA_TYPE, promptDragPayload(template.id));
                    event.dataTransfer.effectAllowed = 'copy';
                  }}
                  onClick={() => setSelectedTemplateId(template.id)}
                  onDoubleClick={() => {
                    startEdit(template);
                    setCreateTargetLibraryId(
                      libraries.find((lib) => lib.items.some((item) => item.id === template.id))?.id
                      ?? activeLibrary?.id ?? null
                    );
                  }}
                >
                  <div className="flex items-start justify-between gap-1">
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-text-dark" title={template.name}>
                      {template.name}
                    </span>
                    <span className="shrink-0 rounded bg-bg-dark/80 px-1 py-0.5 text-[9px] text-text-muted">
                      {resolveCategoryLabel(template.category)}
                    </span>
                  </div>
                  {template.scene && (
                    <p className="mt-0.5 line-clamp-1 text-[10px] text-text-muted" title={template.scene}>
                      {template.scene}
                    </p>
                  )}
                  <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-[10px] leading-3.5 text-text-muted/80" title={template.positive}>
                    {template.positive}
                  </p>
                  <div className="mt-1.5 flex items-center gap-1">
                    {isReadonlyCard ? (
                      <span className="flex h-6 flex-1 items-center justify-center rounded border border-border-dark/60 bg-bg-dark/40 text-[10px] text-text-muted/50">
                        {t('promptLibrary.builtin', '内置')}
                      </span>
                    ) : (
                      <>
                    {/* 可编辑卡片:编辑 + 删除 */}
                    <button
                      type="button"
                      className="flex h-6 flex-1 items-center justify-center gap-0.5 rounded border border-border-dark bg-bg-dark/60 text-[10px] text-text-muted transition-colors hover:border-accent/50 hover:text-text-dark"
                      onClick={(event) => {
                        event.stopPropagation();
                        startEdit(template);
                        setCreateTargetLibraryId(
                          libraries.find((lib) => lib.items.some((item) => item.id === template.id))?.id
                          ?? activeLibrary?.id ?? null
                        );
                      }}
                    >
                      <Pencil className="h-3 w-3" />
                      {t('common.edit', '编辑')}
                    </button>
                    <button
                      type="button"
                      className={`flex h-6 flex-1 items-center justify-center gap-0.5 rounded text-[10px] transition-colors ${
                        pendingDeletePromptId === template.id
                          ? 'bg-red-500/20 text-red-300'
                          : 'border border-border-dark bg-bg-dark/60 text-text-muted hover:border-red-500/50 hover:text-red-400'
                      }`}
                      onClick={(event) => {
                        event.stopPropagation();
                        handleDeletePrompt(template.id);
                      }}
                    >
                      <Trash2 className="h-3 w-3" />
                      {pendingDeletePromptId === template.id
                        ? t('common.confirmDelete', '确认删除')
                        : t('common.delete', '删除')}
                    </button>
                      </>
                    )}
                  </div>
                </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      <PromptCategoryManageDialog
        open={showCategoryManage}
        onClose={() => setShowCategoryManage(false)}
        groups={promptGroups}
        onAdd={addCategory}
        onRename={renameCategory}
        onDelete={deleteCategory}
      />
      </>
    );
  }

  return (
    <>
    <div className={embedded ? 'flex h-full w-full bg-surface-dark' : 'fixed inset-0 z-[97] flex bg-surface-dark'}>
      {/* 左侧:词库树 */}
      <aside className="flex w-[240px] shrink-0 flex-col border-r border-border-dark">
        <div className="flex items-center justify-between border-b border-border-dark px-4 py-3">
          <div className="flex items-center gap-2">
            <Library className="h-4 w-4 text-accent" />
            <h2 className="text-sm font-medium text-text-dark">{t('promptLibrary.title', '提示词库')}</h2>
          </div>
          <div className="flex items-center gap-1">
            <UiIconButton title={t('promptLibrary.addLib', '新建提示词库')} onClick={handleAddLibrary}>
              <Plus className="h-4 w-4" />
            </UiIconButton>
            <UiIconButton title={t('common.close', '关闭')} onClick={onClose}>
              <X className="h-4 w-4" />
            </UiIconButton>
          </div>
        </div>
        <div className="ui-scrollbar flex-1 overflow-y-auto p-2">
          {libraries.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center text-text-muted">
              <BookOpen className="h-8 w-8 opacity-40" />
              <p className="text-xs">{t('promptLibrary.noLib', '还没有提示词库')}</p>
              <button
                type="button"
                className="mt-1 text-xs text-accent hover:underline"
                onClick={handleAddLibrary}
              >
                {t('promptLibrary.createFirstLib', '创建第一个词库')}
              </button>
            </div>
          ) : (
            <div className="space-y-1">
              {libraries.map((lib: PromptLibrary) => (
                <div
                  key={lib.id}
                  className={`rounded-lg ${activeLibrary?.id === lib.id ? 'bg-accent/15' : 'hover:bg-bg-dark'}`}
                >
                  <button
                    type="button"
                    className="flex w-full items-center justify-between px-3 py-2 text-left"
                    onClick={() => {
                      setActiveLibraryId(lib.id);
                      setActiveCategory('all');
                      setSelectedTemplateId(null);
                      setSearch('');
                    }}
                  >
                    <span className={`min-w-0 flex-1 truncate text-xs font-medium ${activeLibrary?.id === lib.id ? 'text-text-dark' : 'text-text-muted'}`}>
                      {lib.name}
                    </span>
                    <span className="ml-2 shrink-0 text-[10px] text-text-muted/60">
                      {lib.items.length}
                    </span>
                  </button>
                  {activeLibrary?.id === lib.id && !lib.readonly && (
                    <div className="flex items-center gap-1 px-3 pb-2">
                      <button
                        type="button"
                        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-text-muted hover:bg-bg-dark hover:text-text-dark"
                        onClick={handleRenameLibrary}
                      >
                        <Pencil className="h-3 w-3" />
                        {t('common.rename', '重命名')}
                      </button>
                      <button
                        type="button"
                        className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] hover:bg-bg-dark ${
                          pendingDeleteLibraryId === lib.id
                            ? 'text-red-400'
                            : 'text-text-muted hover:text-red-400'
                        }`}
                        onClick={handleDeleteLibrary}
                      >
                        <Trash2 className="h-3 w-3" />
                        {pendingDeleteLibraryId === lib.id
                          ? t('common.confirmDelete', '确认删除')
                          : t('common.delete', '删除')}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>

      {/* 中间:列表 + 搜索 + 批量管理 */}
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-border-dark px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-medium text-text-dark">
              {activeLibrary?.name ?? t('promptLibrary.title', '提示词库')}
            </h2>
            <p className="text-[11px] text-text-muted">
              {t('promptLibrary.count', '共 {{count}} 条提示词', { count: visibleTemplates.length })}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted/70" />
              <input
                ref={searchInputRef}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('promptLibrary.search', '搜索名称、说明或正文…')}
                className="w-48 rounded-md border border-border-dark bg-bg-dark/70 py-1.5 pl-8 pr-2.5 text-xs text-text-dark outline-none transition-colors placeholder:text-text-muted/60 focus:border-accent"
              />
            </div>
            <UiButton variant="primary" size="sm" onClick={startCreate} disabled={!activeLibrary}>
              <FilePlus2 className="h-4 w-4" />
              {t('promptLibrary.add', '新增')}
            </UiButton>
            <UiButton
                variant={isManageMode ? 'primary' : 'muted'}
                size="sm"
                onClick={() => {
                  setIsManageMode((current) => !current);
                  setSelectedIds(new Set());
                }}
                disabled={!activeLibrary}
              >
                <ListChecks className="h-4 w-4" />
                {isManageMode ? t('promptLibrary.doneManage', '完成管理') : t('promptLibrary.batchManage', '批量管理')}
              </UiButton>
          </div>
        </div>

        {/* 分类 chips */}
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border-dark px-4 py-2">
          {categories.map((category) => (
            <button
              key={category}
              type="button"
              onClick={() => setActiveCategory(category)}
              className={`h-6 rounded-full border px-2.5 text-[11px] transition-colors ${
                activeCategory === category
                  ? 'border-accent/50 bg-accent/15 text-text-dark'
                  : 'border-border-dark text-text-muted hover:bg-bg-dark'
              }`}
            >
              {category === 'all'
                ? t('promptLibrary.all', '全部')
                : resolveCategoryLabel(category)}
            </button>
          ))}
          <button
            type="button"
            className="ml-auto flex h-6 shrink-0 items-center gap-1 rounded-md border border-border-dark px-2 text-[10px] text-text-muted transition-colors hover:border-accent/40 hover:text-text-dark"
            onClick={() => setShowCategoryManage(true)}
            title={t('promptLibrary.manageGroups', '管理分组')}
          >
            <Settings2 className="h-3 w-3" />
            {t('promptLibrary.manageGroups', '管理分组')}
          </button>
        </div>

        {/* 批量管理工具条 */}
        {isManageMode && (
          <div className="flex items-center gap-3 border-b border-border-dark bg-bg-dark/40 px-4 py-2">
            <span className="text-[11px] text-text-muted">
              {t('promptLibrary.selectedCount', '已选择 {{count}} 条', { count: selectedIds.size })}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark"
                onClick={() => setSelectedIds(new Set(visibleTemplates.map((item) => item.id)))}
              >
                <CheckSquare className="h-3.5 w-3.5" />
                {t('promptLibrary.selectAll', '全选')}
              </button>
              <button
                type="button"
                className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark"
                onClick={() => setSelectedIds(new Set())}
                disabled={selectedIds.size === 0}
              >
                <Square className="h-3.5 w-3.5" />
                {t('promptLibrary.clear', '清空')}
              </button>
              <button
                type="button"
                className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors ${
                  pendingBatchDelete
                    ? 'bg-red-500/20 text-red-300'
                    : 'text-text-muted hover:bg-red-500/10 hover:text-red-400'
                }`}
                onClick={handleDeleteSelected}
                disabled={selectedIds.size === 0}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {pendingBatchDelete
                  ? t('promptLibrary.confirmDeleteSelected', '确认删除所选')
                  : t('promptLibrary.deleteSelected', '删除所选')}
              </button>
            </div>
          </div>
        )}

        {/* 列表 */}
        <div className="ui-scrollbar flex-1 overflow-y-auto p-3">
          {!activeLibrary ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-text-muted">
              <BookOpen className="h-8 w-8 opacity-40" />
              <p className="text-xs">{t('promptLibrary.noLibHint', '请先创建提示词库')}</p>
            </div>
          ) : visibleTemplates.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-text-muted">
              <BookOpen className="h-8 w-8 opacity-40" />
              <p className="text-xs">
                {search || activeCategory !== 'all'
                  ? t('promptLibrary.searchEmpty', '没有匹配的提示词')
                  : t('promptLibrary.empty', '还没有提示词,点击「新增」添加')}
              </p>
            </div>
          ) : (
            <div className="space-y-1.5">
              {visibleTemplates.map((template) => (
                <article
                  key={template.id}
                  className={`group cursor-grab rounded-lg border p-3 transition-colors active:cursor-grabbing ${
                    selectedTemplateId === template.id
                      ? 'border-accent/50 bg-accent/10'
                      : 'border-border-dark bg-bg-dark hover:border-[rgba(255,255,255,0.25)]'
                  }`}
                  draggable
                  onDragStart={(event) => {
                    // 拖拽提示词到画布,创建 AI 图片节点
                    event.dataTransfer.setData(PROMPT_DRAG_DATA_TYPE, promptDragPayload(template.id));
                    event.dataTransfer.effectAllowed = 'copy';
                  }}
                  onClick={() => {
                    setSelectedTemplateId(template.id);
                    if (isManageMode) {
                      toggleSelect(template.id);
                    }
                  }}
                  onDoubleClick={() => {
                    startEdit(template);
                    setCreateTargetLibraryId(
                      libraries.find((lib) => lib.items.some((item) => item.id === template.id))?.id
                      ?? activeLibrary?.id ?? null
                    );
                  }}
                >
                  <div className="flex items-start gap-2">
                    {isManageMode && (
                      <input
                        type="checkbox"
                        checked={selectedIds.has(template.id)}
                        onChange={() => toggleSelect(template.id)}
                        onClick={(event) => event.stopPropagation()}
                        className="mt-0.5 h-3.5 w-3.5 accent-[var(--accent)]"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-xs font-medium text-text-dark">
                          {template.name}
                        </span>
                        <span className="shrink-0 rounded bg-bg-dark/80 px-1.5 py-0.5 text-[10px] text-text-muted">
                          {resolveCategoryLabel(template.category)}
                        </span>
                      </div>
                      {template.scene && (
                        <p className="mt-0.5 truncate text-[11px] text-text-muted">{template.scene}</p>
                      )}
                      <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-[11px] leading-4 text-text-muted/80">
                        {template.positive}
                      </p>
                    </div>
                    {!isManageMode && (
                      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                        <button
                          type="button"
                          className="rounded p-1 text-text-muted hover:bg-bg-dark hover:text-text-dark"
                          title={t('common.edit', '编辑')}
                          onClick={(event) => {
                            event.stopPropagation();
                            startEdit(template);
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          className={`rounded p-1 hover:bg-bg-dark ${
                            pendingDeletePromptId === template.id
                              ? 'text-red-400'
                              : 'text-text-muted hover:text-red-400'
                          }`}
                          title={pendingDeletePromptId === template.id
                            ? t('common.confirmDelete', '确认删除')
                            : t('common.delete', '删除')}
                          onClick={(event) => {
                            event.stopPropagation();
                            handleDeletePrompt(template.id);
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* 右侧:详情 / 编辑表单 */}
      <aside className="flex w-[320px] shrink-0 flex-col border-l border-border-dark">
        {isCreating || editingId ? (
          <>
            <div className="flex items-center justify-between border-b border-border-dark px-4 py-3">
              <div className="flex items-center gap-2">
                <FilePlus2 className="h-4 w-4 text-accent" />
                <h2 className="text-sm font-medium text-text-dark">
                  {isCreating
                    ? t('promptLibrary.newPrompt', '新增提示词')
                    : t('promptLibrary.editPrompt', '编辑提示词')}
                </h2>
              </div>
              <div className="flex items-center gap-2">
                <UiButton variant="primary" size="sm" onClick={saveDraft}>
                  <Check className="h-4 w-4" />
                  {t('common.save', '保存')}
                </UiButton>
                <UiIconButton
                  title={t('common.cancel', '取消')}
                  onClick={() => {
                    setIsCreating(false);
                    setEditingId(null);
                    setDraft(EMPTY_DRAFT);
                  }}
                >
                  <X className="h-4 w-4" />
                </UiIconButton>
              </div>
            </div>
            <div className="ui-scrollbar flex-1 space-y-3 overflow-y-auto p-4">
              <label className="block">
                <span className="mb-1 block text-[11px] text-text-muted">{t('promptLibrary.name', '名称')}</span>
                <input
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  placeholder={t('promptLibrary.namePlaceholder', '提示词名称')}
                  className={inputClass}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] text-text-muted">{t('promptLibrary.scene', '用途说明')}</span>
                <textarea
                  value={draft.scene}
                  onChange={(event) => setDraft({ ...draft, scene: event.target.value })}
                  placeholder={t('promptLibrary.scenePlaceholder', '这个提示词用在什么场景')}
                  rows={2}
                  className={`${inputClass} resize-none`}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] text-text-muted">{t('promptLibrary.positive', '正向提示词')}</span>
                <textarea
                  value={draft.positive}
                  onChange={(event) => setDraft({ ...draft, positive: event.target.value })}
                  placeholder={t('promptLibrary.positivePlaceholder', '正向提示词内容')}
                  rows={8}
                  className={`${inputClass} resize-none font-mono leading-5`}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] text-text-muted">{t('promptLibrary.negative', '负向提示词')}</span>
                <textarea
                  value={draft.negative}
                  onChange={(event) => setDraft({ ...draft, negative: event.target.value })}
                  placeholder={t('promptLibrary.negativePlaceholder', '负向提示词内容(可选)')}
                  rows={4}
                  className={`${inputClass} resize-none font-mono leading-5`}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] text-text-muted">{t('promptLibrary.category', '分类')}</span>
                <select
                  value={draft.category}
                  onChange={(event) => setDraft({ ...draft, category: event.target.value })}
                  className={inputClass}
                >
                  <option value="custom">{t('promptLibrary.custom', '自定义')}</option>
                  {allCategoryOptions.map((category) => (
                    <option key={category} value={category}>
                      {resolveCategoryLabel(category)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between border-b border-border-dark px-4 py-3">
              <div className="flex items-center gap-2">
                <BookOpen className="h-4 w-4 text-accent" />
                <h2 className="text-sm font-medium text-text-dark">{t('promptLibrary.preview', '提示词预览')}</h2>
              </div>
              {selectedTemplate && (
                <UiIconButton
                  title={t('common.edit', '编辑')}
                  onClick={() => startEdit(selectedTemplate)}
                >
                  <Pencil className="h-4 w-4" />
                </UiIconButton>
              )}
            </div>
            <div className="ui-scrollbar flex-1 overflow-y-auto p-4">
              {!selectedTemplate ? (
                <div className="flex flex-col items-center gap-2 py-16 text-center text-text-muted">
                  <BookOpen className="h-8 w-8 opacity-40" />
                  <p className="text-xs">{t('promptLibrary.noPreview', '选择一条提示词查看全文')}</p>
                </div>
              ) : (
                <div className="space-y-4">
                  <div>
                    <h3 className="text-sm font-medium text-text-dark">{selectedTemplate.name}</h3>
                    {selectedTemplate.scene && (
                      <p className="mt-1 text-[11px] leading-5 text-text-muted">{selectedTemplate.scene}</p>
                    )}
                    <span className="mt-1.5 inline-block rounded bg-bg-dark/80 px-1.5 py-0.5 text-[10px] text-text-muted">
                      {resolveCategoryLabel(selectedTemplate.category)}
                    </span>
                    {isReadonly && (
                      <span className="mt-1.5 ml-1 inline-block rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">
                        {t('promptLibrary.builtin', '内置案例')}
                      </span>
                    )}
                  </div>
                  <section>
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-[11px] font-medium text-text-dark">{t('promptLibrary.positive', '正向提示词')}</span>
                      <span className="text-[10px] text-text-muted/60">
                        {selectedTemplate.positive.length} {t('promptLibrary.chars', '字符')}
                      </span>
                    </div>
                    <div className="rounded-lg border border-border-dark bg-bg-dark p-3">
                      <p className="whitespace-pre-wrap text-[11px] leading-5 text-text-dark/90">
                        {selectedTemplate.positive || t('promptLibrary.notFilled', '未填写')}
                      </p>
                    </div>
                  </section>
                  <section>
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-[11px] font-medium text-text-dark">{t('promptLibrary.negative', '负向提示词')}</span>
                      <span className="text-[10px] text-text-muted/60">
                        {selectedTemplate.negative.length} {t('promptLibrary.chars', '字符')}
                      </span>
                    </div>
                    <div className="rounded-lg border border-[rgba(255,120,120,0.25)] bg-[rgba(255,80,80,0.06)] p-3">
                      <p className="whitespace-pre-wrap text-[11px] leading-5 text-text-dark/90">
                        {selectedTemplate.negative || t('promptLibrary.notFilled', '未填写')}
                      </p>
                    </div>
                  </section>
                  <div className="flex gap-2">
                    <UiButton
                      variant="muted"
                      size="sm"
                      className="flex-1"
                      onClick={() => handleApply(selectedTemplate, 'positive')}
                    >
                      <Plus className="h-4 w-4" />
                      {t('promptLibrary.applyPositive', '正向')}
                    </UiButton>
                    <UiButton
                      variant="primary"
                      size="sm"
                      className="flex-1"
                      disabled={!selectedTemplate.negative}
                      title={selectedTemplate.negative
                        ? undefined
                        : t('promptLibrary.applyFullDisabled', '该提示词没有负向提示词')}
                      onClick={() => handleApply(selectedTemplate, 'full')}
                    >
                      <Sparkles className="h-4 w-4" />
                      {t('promptLibrary.applyFull', '完整应用')}
                    </UiButton>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </aside>
    </div>
      <PromptCategoryManageDialog
        open={showCategoryManage}
        onClose={() => setShowCategoryManage(false)}
        groups={promptGroups}
        onAdd={addCategory}
        onRename={renameCategory}
        onDelete={deleteCategory}
      />
    </>
  );
}

export default memo(PromptLibraryPanel);
