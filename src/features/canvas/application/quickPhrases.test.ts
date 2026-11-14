import { describe, expect, it } from 'vitest';

import {
  MAX_QUICK_PHRASES,
  appendQuickPhrase,
  loadQuickPhrases,
  sanitizeQuickPhrases,
} from './quickPhrases';

describe('sanitizeQuickPhrases', () => {
  it('去空白、去重、非字符串一律丢掉', () => {
    expect(sanitizeQuickPhrases(['  更简洁  ', '更简洁', '', '   ', 42, null, '改夜景'])).toEqual([
      '更简洁',
      '改夜景',
    ]);
  });

  it('数量超限时截断，不会无限涨', () => {
    const many = Array.from({ length: MAX_QUICK_PHRASES + 5 }, (_, index) => `句式 ${index}`);
    expect(sanitizeQuickPhrases(many)).toHaveLength(MAX_QUICK_PHRASES);
  });

  it('非数组输入返回空数组（手改 localStorage 也不崩）', () => {
    expect(sanitizeQuickPhrases('not-an-array')).toEqual([]);
    expect(sanitizeQuickPhrases(null)).toEqual([]);
  });
});

describe('appendQuickPhrase', () => {
  it('输入框为空时直接放入，不留前导空行', () => {
    expect(appendQuickPhrase('', '更简洁')).toBe('更简洁');
    expect(appendQuickPhrase('   \n ', '更简洁')).toBe('更简洁');
  });

  it('已有内容时换行追加，并清掉末尾空白', () => {
    expect(appendQuickPhrase('把这段改成夜景   \n', '语气更自然')).toBe(
      '把这段改成夜景\n语气更自然',
    );
  });

  it('空白句式不改变输入', () => {
    expect(appendQuickPhrase('原文', '   ')).toBe('原文');
  });
});

describe('loadQuickPhrases', () => {
  it('非浏览器环境回落预置句式', () => {
    const phrases = loadQuickPhrases();
    expect(phrases.length).toBeGreaterThan(0);
    expect(phrases.every((item) => item.trim().length > 0)).toBe(true);
  });
});
