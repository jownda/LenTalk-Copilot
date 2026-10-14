import type { PromptTemplate } from '@/features/prompts/promptLibraryStore';

/**
 * 「提示词模板」选择卡片的尺寸规则与筛选规则。
 *
 * 和 quickAssetPickerLayout 一样抽成纯函数：尺寸要保证卡片整张落在视口内
 * （否则又会被画布边缘裁掉），筛选规则则决定「用户搜关键词时到底能搜到哪几条」，
 * 这两件事都容易被后续微调悄悄改坏。
 */

/** 卡片目标宽度：一行两个时每列约 166px，够放「名称 + 分类」与两行提示词。 */
export const PROMPT_PICKER_WIDTH = 348;
/** 极窄窗口下的下限。 */
export const PROMPT_PICKER_MIN_WIDTH = 240;
/**
 * 「一行两个」的最窄面板宽度。
 *
 * 低于它（窗口很窄被夹过）时退回一行一个 —— 两列各不到 140px 时，模型名、分类标签、
 * 两行提示词会一起挤成省略号，反而不如一行一个看得清。
 */
export const PROMPT_PICKER_TWO_COLUMN_MIN_WIDTH = 300;
/** 一行两个之间 / 两行之间的间距（与列表容器的 `gap-1.5` = 6px 一致）。 */
export const PROMPT_PICKER_GRID_GAP = 6;
/** 列表滚动区的理想高度。 */
export const PROMPT_PICKER_LIST_HEIGHT = 232;
/** 列表之外的高度（标题行 + 搜索框 + 分类行 + 内边距），只用于估算下翻还是上翻。 */
export const PROMPT_PICKER_CHROME_HEIGHT = 104;
/** 视口四周留白，与 getFloatingPanelPosition 的取值保持一致。 */
export const PROMPT_PICKER_VIEWPORT_MARGIN = 16;
/** 列表滚动区的高度下限 —— 再矮就只剩一行可见了。 */
const MIN_LIST_HEIGHT = 88;

export interface PromptPickerSize {
  /** 卡片宽度（已夹进视口）。 */
  width: number;
  /** 列表滚动区高度（已按视口高度收窄）。 */
  listHeight: number;
  /** 列表是排一行还是两行：宽面板两列，窄面板退回一列。 */
  columns: 1 | 2;
}

/**
 * 一行排几个。宽度够就两列（默认形态），被窄窗口夹到 300px 以下时退回一列
 * —— 每列不足 140px 时名称、分类、两行提示词会一起变成省略号。
 */
export function resolvePromptPickerColumns(width: number): 1 | 2 {
  return width >= PROMPT_PICKER_TWO_COLUMN_MIN_WIDTH ? 2 : 1;
}

/**
 * 卡片尺寸：宽度不超出视口左右各 16px，列表高度不超出视口上下各 16px
 * —— 卡片总高最多占满视口，不会被上下边缘裁掉。
 */
export function resolvePromptPickerSize(
  viewport: { width: number; height: number },
  preferredWidth: number = PROMPT_PICKER_WIDTH,
): PromptPickerSize {
  const width = Math.min(
    preferredWidth,
    Math.max(PROMPT_PICKER_MIN_WIDTH, viewport.width - PROMPT_PICKER_VIEWPORT_MARGIN * 2),
  );
  const listHeight = Math.max(
    MIN_LIST_HEIGHT,
    Math.min(
      PROMPT_PICKER_LIST_HEIGHT,
      viewport.height - PROMPT_PICKER_CHROME_HEIGHT - PROMPT_PICKER_VIEWPORT_MARGIN * 2,
    ),
  );
  return { width, listHeight, columns: resolvePromptPickerColumns(width) };
}

/** 「全部分类」的哨兵值。 */
export const PROMPT_PICKER_ALL_CATEGORY = '__all__';

/**
 * 排序：最新添加的提示词排最上面。
 *
 * 按 `createdAt` 降序。同一毫秒创建的那一批（内置预设是循环里连续 seed 出来的，
 * `createdAt` 基本一致）**保持原有顺序** —— `Array.prototype.sort` 自 ES2019 起
 * 要求稳定排序，种子本身的编排顺序不会被重排打乱。
 *
 * 返回新数组：`libraries.items` 是 store 里的共享引用，就地排序会改到持久化数据。
 */
export function sortPromptTemplatesByRecency(templates: PromptTemplate[]): PromptTemplate[] {
  return [...templates].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

/**
 * 收集分类：按条目在列表中首次出现的顺序去重，不做字母排序 ——
 * 用户自己的「我的提示词」库往往按创建顺序排列，重排反而找不到。
 */
export function collectPromptCategories(templates: PromptTemplate[]): string[] {
  const seen = new Set<string>();
  const categories: string[] = [];

  for (const template of templates) {
    const category = (template.category ?? '').trim();
    if (!category || seen.has(category)) {
      continue;
    }
    seen.add(category);
    categories.push(category);
  }

  return categories;
}

export interface PromptTemplateFilter {
  /** 关键词，匹配名称 / 用途说明 / 正向提示词 / 分类，大小写不敏感。 */
  search?: string;
  /** 分类；留空或 `PROMPT_PICKER_ALL_CATEGORY` 表示不限。 */
  category?: string;
}

/** 按关键词与分类筛选提示词。两者都为空时原样返回。 */
export function filterPromptTemplates(
  templates: PromptTemplate[],
  { search = '', category = '' }: PromptTemplateFilter = {},
): PromptTemplate[] {
  const keyword = search.trim().toLowerCase();
  const target = category && category !== PROMPT_PICKER_ALL_CATEGORY ? category : '';

  if (!keyword && !target) {
    return templates;
  }

  return templates.filter((template) => {
    if (target && (template.category ?? '').trim() !== target) {
      return false;
    }
    if (!keyword) {
      return true;
    }

    return [template.name, template.scene, template.positive, template.category]
      .some((field) => (field ?? '').toLowerCase().includes(keyword));
  });
}
