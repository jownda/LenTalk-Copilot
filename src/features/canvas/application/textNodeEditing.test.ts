import { describe, expect, it } from 'vitest';

import { replaceAllText, replaceTextAt, resolveTextMatchIndexes } from './textNodeEditing';

describe('text node editing helpers', () => {
  it('finds matches with optional case sensitivity', () => {
    expect(resolveTextMatchIndexes('Doctor doctor DOCTOR', 'doctor', false)).toEqual([0, 7, 14]);
    expect(resolveTextMatchIndexes('Doctor doctor DOCTOR', 'doctor', true)).toEqual([7]);
  });

  it('replaces all matches without treating special characters as a regex', () => {
    expect(replaceAllText('A+B a+b A+B', 'a+b', 'x', false)).toBe('x x x');
  });

  it('replaces one selected match by its text index', () => {
    const text = '医生检查膝盖，随后检查膝盖';
    const secondMatch = resolveTextMatchIndexes(text, '膝盖', true)[1];
    expect(replaceTextAt(text, '膝盖', '腰椎', secondMatch)).toBe('医生检查膝盖，随后检查腰椎');
  });
});
