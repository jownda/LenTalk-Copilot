import { describe, expect, it } from 'vitest';
import { collectActiveGenerationNodeIds } from './videoGenActiveTasks';

describe('collectActiveGenerationNodeIds', () => {
  it('读取新形态的任务列表', () => {
    expect(collectActiveGenerationNodeIds({ activeGenerationNodeIds: ['a', 'b'] })).toEqual(['a', 'b']);
  });

  it('空数组就是没有任务', () => {
    expect(collectActiveGenerationNodeIds({ activeGenerationNodeIds: [] })).toEqual([]);
  });

  it('剔除非字符串与空串', () => {
    expect(collectActiveGenerationNodeIds({ activeGenerationNodeIds: ['a', '', 3, null, undefined, {}, 'b'] })).toEqual([
      'a',
      'b',
    ]);
  });

  it('兼容旧工程的单个 activeGenerationNodeId', () => {
    expect(collectActiveGenerationNodeIds({ activeGenerationNodeId: 'legacy' })).toEqual(['legacy']);
  });

  it('旧字段为空值时视为没有任务', () => {
    expect(collectActiveGenerationNodeIds({ activeGenerationNodeId: null })).toEqual([]);
    expect(collectActiveGenerationNodeIds({ activeGenerationNodeId: '' })).toEqual([]);
  });

  it('两者都没有时为无任务', () => {
    expect(collectActiveGenerationNodeIds({})).toEqual([]);
    expect(collectActiveGenerationNodeIds(null)).toEqual([]);
    expect(collectActiveGenerationNodeIds(undefined)).toEqual([]);
  });

  it('新字段出现后以它为准，忽略旧字段残留', () => {
    expect(collectActiveGenerationNodeIds({ activeGenerationNodeIds: [], activeGenerationNodeId: 'stale' })).toEqual([]);
  });
});
