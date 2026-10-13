import { describe, expect, it } from 'vitest';

import {
  clampTextViewScrollTop,
  replaceAllText,
  replaceTextAt,
  resolveTextMatchIndexes,
} from './textNodeEditing';

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

describe('编辑态滚动位置折射到预览容器', () => {
  it('正常范围内原样搬到预览容器(退出编辑不跳回第一行)', () => {
    expect(clampTextViewScrollTop(240, 900)).toBe(240);
  });

  it('没滚动过(0)就是 0', () => {
    expect(clampTextViewScrollTop(0, 900)).toBe(0);
  });

  it('负数 / NaN / Infinity 一律归 0', () => {
    // 首次挂载、空内容时算出来的可滚范围可能是负的; 组件卸载后读到的可能是 NaN。
    expect(clampTextViewScrollTop(-12, 900)).toBe(0);
    expect(clampTextViewScrollTop(Number.NaN, 900)).toBe(0);
    expect(clampTextViewScrollTop(Number.POSITIVE_INFINITY, 900)).toBe(0);
  });

  it('超出预览自身可滚范围时钳到最大值', () => {
    // 预览是 markdown 渲染, 段落间距 / 标题字号都会改变内容高度, 位置未必对得上。
    expect(clampTextViewScrollTop(800, 300)).toBe(300);
  });

  it('预览内容比容器还短(无可滚范围)时归 0', () => {
    expect(clampTextViewScrollTop(240, 0)).toBe(0);
    expect(clampTextViewScrollTop(240, -50)).toBe(0);
  });
});
