import { describe, expect, it } from 'vitest';

import { appendPromptText, composePromptText } from './promptApply';

const template = {
  positive: '  a knight in the rain  ',
  negative: '  blurry, extra fingers  ',
};

describe('composePromptText', () => {
  it('appends the negative prompt with a "Negative prompt:" prefix in full mode', () => {
    expect(composePromptText(template, 'full')).toBe(
      'a knight in the rain\n\nNegative prompt:\nblurry, extra fingers',
    );
  });

  it('returns only the positive prompt in positive mode', () => {
    expect(composePromptText(template, 'positive')).toBe('a knight in the rain');
  });

  it('falls back to the positive prompt when there is no negative prompt', () => {
    expect(composePromptText({ positive: 'a castle', negative: '   ' }, 'full')).toBe('a castle');
    expect(composePromptText({ positive: 'a castle' }, 'full')).toBe('a castle');
  });

  it('defaults to full mode', () => {
    expect(composePromptText(template)).toContain('Negative prompt:');
  });

  it('trims both sides and tolerates empty input', () => {
    expect(composePromptText({ positive: '   ', negative: '' }, 'full')).toBe('');
    expect(composePromptText({ positive: '', negative: 'only negative' }, 'full')).toBe(
      'Negative prompt:\nonly negative',
    );
  });

  it('never doubles the blank line between positive and negative', () => {
    const once = composePromptText({ positive: 'p', negative: 'n' }, 'full');
    expect(once).toBe('p\n\nNegative prompt:\nn');
  });
});

describe('appendPromptText', () => {
  it('joins with a blank line so two paragraphs stay separate', () => {
    expect(appendPromptText('existing text', 'new text')).toBe('existing text\n\nnew text');
  });

  it('puts the addition alone when the box is empty', () => {
    expect(appendPromptText('', 'new text')).toBe('new text');
    expect(appendPromptText('   \n  ', 'new text')).toBe('new text');
  });

  it('keeps the existing text when the addition is blank', () => {
    expect(appendPromptText('existing text', '   ')).toBe('existing text');
  });

  it('trims both sides so repeated applies do not accumulate blank lines', () => {
    expect(appendPromptText('  existing  ', '  added  ')).toBe('existing\n\nadded');
    expect(appendPromptText(appendPromptText('a', 'b'), 'c')).toBe('a\n\nb\n\nc');
  });

  it('is a no-op when both sides are empty', () => {
    expect(appendPromptText('', '')).toBe('');
  });
});

describe('composePromptText + appendPromptText together', () => {
  it('produces the same text the canvas drop path writes into a fresh node', () => {
    // 拖拽提示词到画布 = 空输入框 + 完整模式；点按钮填入 = 同一个结果。
    expect(appendPromptText('', composePromptText(template, 'full'))).toBe(
      composePromptText(template, 'full'),
    );
  });

  it('appends a full template to an existing prompt exactly once', () => {
    expect(appendPromptText('@图1 特写', composePromptText(template, 'full'))).toBe(
      '@图1 特写\n\na knight in the rain\n\nNegative prompt:\nblurry, extra fingers',
    );
  });
});
