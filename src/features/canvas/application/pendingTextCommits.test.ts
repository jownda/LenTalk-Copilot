import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  flushPendingNodeTextCommits,
  registerPendingTextCommitFlush,
} from './useDebouncedNodeTextCommit';

/**
 * 文本节点的编辑是防抖提交的, 画布 store 会短暂落后于编辑器。
 * 「生成提示词 / 生成视频」这类拿画布当输入立刻算的操作要在读输入前补交欠账,
 * 否则会出现「文本改了, 生成出来还是旧内容」。
 */
describe('待提交文本的全局补交', () => {
  const unregisterList: Array<() => void> = [];

  const register = (flush: () => void) => {
    const unregister = registerPendingTextCommitFlush(flush);
    unregisterList.push(unregister);
    return unregister;
  };

  afterEach(() => {
    unregisterList.splice(0).forEach((unregister) => unregister());
  });

  it('补交会调用所有已登记的提交', () => {
    const first = vi.fn();
    const second = vi.fn();
    register(first);
    register(second);

    flushPendingNodeTextCommits();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('注销之后不再被补交', () => {
    const flush = vi.fn();
    const unregister = register(flush);

    unregister();
    flushPendingNodeTextCommits();

    expect(flush).not.toHaveBeenCalled();
  });

  it('同一个提交重复登记只算一次', () => {
    const flush = vi.fn();
    registerPendingTextCommitFlush(flush);
    registerPendingTextCommitFlush(flush);

    flushPendingNodeTextCommits();

    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('单个提交抛错不影响其它节点补交', () => {
    const healthy = vi.fn();
    register(() => {
      throw new Error('boom');
    });
    register(healthy);

    expect(() => flushPendingNodeTextCommits()).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it('提交过程中注销自己不会打乱本轮遍历', () => {
    const order: string[] = [];
    const unregisterSecond = register(() => {
      order.push('first');
      unregisterSecond();
    });
    register(() => order.push('second'));

    flushPendingNodeTextCommits();

    expect(order).toEqual(['first', 'second']);
    // 已经注销: 下一轮不再触发。
    order.length = 0;
    flushPendingNodeTextCommits();
    expect(order).toEqual(['second']);
  });

  it('没有登记任何提交时调用是安全的', () => {
    expect(() => flushPendingNodeTextCommits()).not.toThrow();
  });
});
