import { describe, expect, it } from 'vitest';

import { ALL_PROMPT_LIBRARIES_ID, matchesPromptSearch, resolveRevealFilters } from './promptReveal';

const template = {
  name: '真人角色三视图',
  scene: '',
  positive: '一张三格角色设定图',
  negative: 'no plastic skin',
  category: 'character',
};

describe('matchesPromptSearch', () => {
  it('空关键词一律命中', () => {
    expect(matchesPromptSearch(template, '   ')).toBe(true);
  });

  it('四个字段任一命中即可,且大小写不敏感', () => {
    expect(matchesPromptSearch(template, '三格')).toBe(true);
    expect(matchesPromptSearch(template, 'PLASTIC')).toBe(true);
    expect(matchesPromptSearch(template, '不存在的词')).toBe(false);
  });
});

describe('resolveRevealFilters', () => {
  it('已经可见时返回 null(不动用户当前的选择)', () => {
    expect(
      resolveRevealFilters({ libraryId: 'lib-a', category: 'character', search: '三格' }, template, 'lib-a')
    ).toBeNull();
    // 「全部」模式 + 分类不过滤 + 无搜索词 → 一定能看到
    expect(
      resolveRevealFilters(
        { libraryId: ALL_PROMPT_LIBRARIES_ID, category: 'all', search: '' },
        template,
        'lib-a'
      )
    ).toBeNull();
  });

  it('停在别的词库(含只读内置库)时切到目标词库', () => {
    expect(
      resolveRevealFilters({ libraryId: 'lib-builtin', category: 'all', search: '' }, template, 'lib-a')
    ).toEqual({ libraryId: 'lib-a' });
    expect(resolveRevealFilters({ libraryId: null, category: 'all', search: '' }, template, 'lib-a')).toEqual({
      libraryId: 'lib-a',
    });
  });

  it('分类过滤挡不住目标条目时切回「全部」分类', () => {
    expect(
      resolveRevealFilters({ libraryId: 'lib-a', category: 'lighting', search: '' }, template, 'lib-a')
    ).toEqual({ category: 'all' });
  });

  it('搜索词命中不了新条目时清空搜索', () => {
    expect(
      resolveRevealFilters({ libraryId: 'lib-a', category: 'all', search: '别的词' }, template, 'lib-a')
    ).toEqual({ search: '' });
    // 命中则不打扰
    expect(
      resolveRevealFilters({ libraryId: 'lib-a', category: 'all', search: '角色' }, template, 'lib-a')
    ).toBeNull();
  });

  it('多个条件同时挡着时一起改', () => {
    expect(
      resolveRevealFilters(
        { libraryId: 'lib-builtin', category: 'lighting', search: '别的词' },
        template,
        'lib-a'
      )
    ).toEqual({ libraryId: 'lib-a', category: 'all', search: '' });
  });
});
