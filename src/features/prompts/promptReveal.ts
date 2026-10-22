import type { PromptTemplate } from './promptLibraryStore';

/** 「全部」词库的哨兵 id:选中它时聚合所有词库的条目 */
export const ALL_PROMPT_LIBRARIES_ID = '__all__';

/** 列表当前的过滤条件(与 `PromptLibraryPanel` 的 visibleTemplates 一致) */
export interface PromptFilterState {
  libraryId: string | null;
  category: string;
  search: string;
}

type SearchablePrompt = Pick<PromptTemplate, 'name' | 'scene' | 'positive' | 'negative'>;

/** 关键词匹配:与列表过滤同一条规则(名称 / 用途说明 / 正向 / 负向) */
export function matchesPromptSearch(template: SearchablePrompt, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) {
    return true;
  }
  return [template.name, template.scene, template.positive, template.negative]
    .some((value) => value.toLocaleLowerCase().includes(needle));
}

/**
 * 刚保存的条目如果落在「当前视图看不到」的词库 / 分类 / 搜索词里, 列表不会有任何变化,
 * 用户会以为保存失败并反复点保存。
 *
 * 返回需要改成的过滤条件;已经可见时返回 `null`(调用方不要动用户当前的选择)。
 */
export function resolveRevealFilters(
  state: PromptFilterState,
  template: SearchablePrompt & Pick<PromptTemplate, 'category'>,
  targetLibraryId: string
): Partial<PromptFilterState> | null {
  const patch: Partial<PromptFilterState> = {};
  // 「全部」模式聚合所有词库,词库维度天然可见
  if (state.libraryId !== ALL_PROMPT_LIBRARIES_ID && state.libraryId !== targetLibraryId) {
    patch.libraryId = targetLibraryId;
  }
  if (state.category !== 'all' && state.category !== template.category) {
    patch.category = 'all';
  }
  if (!matchesPromptSearch(template, state.search)) {
    patch.search = '';
  }
  return Object.keys(patch).length > 0 ? patch : null;
}
