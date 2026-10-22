import { describe, expect, it } from 'vitest';

import { filterExcludedReferences, resolveEffectiveReferences } from './referenceExclusions';

describe('filterExcludedReferences', () => {
  it('drops a source that the user removed on this node', () => {
    expect(filterExcludedReferences(['a', 'b', 'c'], ['b'])).toEqual(['a', 'c']);
  });

  it('returns a copy when nothing is excluded', () => {
    const sources = ['a', 'b'];
    const result = filterExcludedReferences(sources, []);
    expect(result).toEqual(sources);
    expect(result).not.toBe(sources);
  });
});

describe('resolveEffectiveReferences', () => {
  it('removes a reference that keeps arriving from an upstream node', () => {
    // 线上问题: 音频来自上游提示词工作室, 用户在视频节点删掉自己的那份后
    // 上游仍把同一份喂回来 → 生成时照样上传。移除记录必须作用在合并结果上。
    const upstream = ['studio-audio.mp3'];
    expect(resolveEffectiveReferences(['studio-audio.mp3'], upstream, ['studio-audio.mp3']))
      .toEqual([]);
  });

  it('keeps other upstream references intact', () => {
    expect(resolveEffectiveReferences(
      ['own.png'],
      ['studio.png', 'other.png'],
      ['studio.png'],
    )).toEqual(['own.png', 'other.png']);
  });

  it('de-duplicates direct and upstream entries before filtering', () => {
    expect(resolveEffectiveReferences(['same.png'], ['same.png'], [])).toEqual(['same.png']);
  });

  it('ignores blank and non-string entries', () => {
    expect(resolveEffectiveReferences(['', '  ', 'ok.png'], [null, 42, 'ok.png'], [])).toEqual(['ok.png']);
  });
});
