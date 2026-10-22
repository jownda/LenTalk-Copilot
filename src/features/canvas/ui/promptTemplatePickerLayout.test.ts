import { describe, expect, it } from 'vitest';

import type { PromptTemplate } from '@/features/prompts/promptLibraryStore';
import {
  collectPromptCategories,
  filterPromptTemplates,
  PROMPT_PICKER_ALL_CATEGORY,
  PROMPT_PICKER_CHROME_HEIGHT,
  PROMPT_PICKER_LIST_HEIGHT,
  PROMPT_PICKER_MIN_WIDTH,
  PROMPT_PICKER_TWO_COLUMN_MIN_WIDTH,
  PROMPT_PICKER_VIEWPORT_MARGIN,
  PROMPT_PICKER_WIDTH,
  resolvePromptPickerColumns,
  resolvePromptPickerSize,
  sortPromptTemplatesByRecency,
} from './promptTemplatePickerLayout';

function template(overrides: Partial<PromptTemplate> & { id: string }): PromptTemplate {
  return {
    name: '模板',
    scene: '',
    positive: '',
    negative: '',
    category: 'custom',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('resolvePromptPickerSize', () => {
  it('uses the preferred width and list height on a roomy viewport', () => {
    expect(resolvePromptPickerSize({ width: 1920, height: 1080 })).toEqual({
      width: PROMPT_PICKER_WIDTH,
      listHeight: PROMPT_PICKER_LIST_HEIGHT,
      columns: 2,
    });
  });

  it('lays the list out in two columns once the width allows it', () => {
    // 宽度刚好卡在两列门槛上：仍然是两列。
    expect(resolvePromptPickerColumns(PROMPT_PICKER_TWO_COLUMN_MIN_WIDTH)).toBe(2);
    expect(resolvePromptPickerColumns(PROMPT_PICKER_WIDTH)).toBe(2);
  });

  it('falls back to a single column when a narrow viewport squeezes the card', () => {
    expect(resolvePromptPickerColumns(PROMPT_PICKER_TWO_COLUMN_MIN_WIDTH - 1)).toBe(1);
    // 320 - 32 = 288 < 300 → 一列，两列各 130 多像素会挤成省略号。
    expect(resolvePromptPickerSize({ width: 320, height: 900 }).columns).toBe(1);
    expect(resolvePromptPickerSize({ width: 340, height: 900 }).columns).toBe(2);
  });

  it('shrinks the width on a narrow viewport but never below the floor', () => {
    expect(resolvePromptPickerSize({ width: 320, height: 900 }).width).toBe(
      320 - PROMPT_PICKER_VIEWPORT_MARGIN * 2,
    );
    // 宽 200 时 200-32=168 < 240，仍然给下限而不是继续缩。
    expect(resolvePromptPickerSize({ width: 200, height: 900 }).width).toBe(PROMPT_PICKER_MIN_WIDTH);
  });

  it('shrinks the list height so the whole card fits between the viewport edges', () => {
    // 视口矮到理想列表高度放不下时才收窄：300 - 104 - 32 = 164 < 232。
    const viewport = { width: 1200, height: 300 };
    const { listHeight } = resolvePromptPickerSize(viewport);

    expect(listHeight).toBe(300 - PROMPT_PICKER_CHROME_HEIGHT - PROMPT_PICKER_VIEWPORT_MARGIN * 2);
    expect(listHeight + PROMPT_PICKER_CHROME_HEIGHT + PROMPT_PICKER_VIEWPORT_MARGIN * 2).toBeLessThanOrEqual(
      viewport.height,
    );
  });

  it('never exceeds the ideal list height even when the viewport is very tall', () => {
    expect(resolvePromptPickerSize({ width: 1200, height: 4000 }).listHeight).toBe(
      PROMPT_PICKER_LIST_HEIGHT,
    );
  });

  it('keeps a usable list height on an extremely short viewport', () => {
    const { listHeight } = resolvePromptPickerSize({ width: 1200, height: 100 });
    expect(listHeight).toBeGreaterThan(0);
    expect(listHeight).toBeLessThanOrEqual(PROMPT_PICKER_LIST_HEIGHT);
  });
});

describe('sortPromptTemplatesByRecency', () => {
  it('puts the most recently created template first', () => {
    const sorted = sortPromptTemplatesByRecency([
      template({ id: 'old', createdAt: 100 }),
      template({ id: 'newest', createdAt: 300 }),
      template({ id: 'middle', createdAt: 200 }),
    ]);

    expect(sorted.map((item) => item.id)).toEqual(['newest', 'middle', 'old']);
  });

  it('keeps the original order for templates created in the same millisecond', () => {
    // 内置预设是循环里连续 seed 的，createdAt 基本一致 —— 必须保持种子的编排顺序。
    const seeded = [
      template({ id: 'seed-1', createdAt: 1000 }),
      template({ id: 'seed-2', createdAt: 1000 }),
      template({ id: 'seed-3', createdAt: 1000 }),
    ];

    expect(sortPromptTemplatesByRecency(seeded).map((item) => item.id)).toEqual([
      'seed-1',
      'seed-2',
      'seed-3',
    ]);
  });

  it('does not mutate the input array', () => {
    const input = [template({ id: 'a', createdAt: 1 }), template({ id: 'b', createdAt: 2 })];
    const sorted = sortPromptTemplatesByRecency(input);

    expect(sorted).not.toBe(input);
    expect(input.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('treats a missing createdAt as the oldest', () => {
    const sorted = sortPromptTemplatesByRecency([
      { ...template({ id: 'no-date' }), createdAt: undefined as unknown as number },
      template({ id: 'dated', createdAt: 1 }),
    ]);

    expect(sorted.map((item) => item.id)).toEqual(['dated', 'no-date']);
  });

  it('sorts a user library added later above the built-in seeds', () => {
    const seeded = [template({ id: 'builtin-1', createdAt: 1000 }), template({ id: 'builtin-2', createdAt: 1000 })];
    const mine = [template({ id: 'mine', createdAt: 2000 })];

    expect(sortPromptTemplatesByRecency([...seeded, ...mine])[0].id).toBe('mine');
  });
});

describe('collectPromptCategories', () => {
  it('deduplicates while keeping first-seen order', () => {
    const categories = collectPromptCategories([
      template({ id: '1', category: 'lighting' }),
      template({ id: '2', category: 'view' }),
      template({ id: '3', category: 'lighting' }),
      template({ id: '4', category: 'character' }),
    ]);

    expect(categories).toEqual(['lighting', 'view', 'character']);
  });

  it('ignores blank categories', () => {
    expect(
      collectPromptCategories([
        template({ id: '1', category: '' }),
        template({ id: '2', category: '   ' }),
        template({ id: '3', category: 'view' }),
      ]),
    ).toEqual(['view']);
  });

  it('returns an empty list for no templates', () => {
    expect(collectPromptCategories([])).toEqual([]);
  });
});

describe('filterPromptTemplates', () => {
  const templates = [
    template({ id: '1', name: '多机位九宫格', scene: '角色多角度参考', positive: '9 angles grid', category: 'character' }),
    template({ id: '2', name: '柔光人像', scene: '棚拍柔光', positive: 'soft light portrait', category: 'lighting' }),
    template({ id: '3', name: '低角度仰拍', scene: '英雄感', positive: 'low angle shot', category: 'view' }),
  ];

  it('returns the same array reference when nothing is filtered', () => {
    expect(filterPromptTemplates(templates)).toBe(templates);
    expect(filterPromptTemplates(templates, { search: '   ', category: PROMPT_PICKER_ALL_CATEGORY })).toBe(
      templates,
    );
  });

  it('matches the keyword against name, scene, positive and category', () => {
    expect(filterPromptTemplates(templates, { search: '九宫格' }).map((item) => item.id)).toEqual(['1']);
    expect(filterPromptTemplates(templates, { search: '英雄感' }).map((item) => item.id)).toEqual(['3']);
    expect(filterPromptTemplates(templates, { search: 'portrait' }).map((item) => item.id)).toEqual(['2']);
    expect(filterPromptTemplates(templates, { search: 'lighting' }).map((item) => item.id)).toEqual(['2']);
  });

  it('is case-insensitive and trims the keyword', () => {
    expect(filterPromptTemplates(templates, { search: '  PORTRAIT  ' }).map((item) => item.id)).toEqual(['2']);
  });

  it('filters by category, treating the all-sentinel as no filter', () => {
    expect(filterPromptTemplates(templates, { category: 'view' }).map((item) => item.id)).toEqual(['3']);
    expect(filterPromptTemplates(templates, { category: PROMPT_PICKER_ALL_CATEGORY })).toBe(templates);
    expect(filterPromptTemplates(templates, { category: '' })).toBe(templates);
  });

  it('combines keyword and category, and returns empty when nothing matches', () => {
    expect(
      filterPromptTemplates(templates, { search: 'light', category: 'lighting' }).map((item) => item.id),
    ).toEqual(['2']);
    expect(filterPromptTemplates(templates, { search: 'light', category: 'view' })).toEqual([]);
    expect(filterPromptTemplates(templates, { search: '不存在的词' })).toEqual([]);
  });

  it('tolerates templates with missing optional fields', () => {
    const sparse = [template({ id: 'x', name: '裸条目', scene: '', positive: '', category: '' })];
    expect(filterPromptTemplates(sparse, { search: '裸条目' }).map((item) => item.id)).toEqual(['x']);
  });
});
