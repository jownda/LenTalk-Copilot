import { describe, expect, it } from 'vitest';

import { isMissingLocalSourceFailure, plainReason } from './UnpersistedMediaNotice';

describe('isMissingLocalSourceFailure', () => {
  it('认出「源文件本机已不存在」的几种形态', () => {
    // 真机抓到的完整文案（Rust 侧 + 重试话术）
    expect(
      isMissingLocalSourceFailure(
        'Failed to read local image source: 系统找不到指定的文件。 (os error 2); 放宽预算重试后仍失败: Failed to read local image source: 系统找不到指定的文件。 (os error 2)',
      ),
    ).toBe(true);
    expect(isMissingLocalSourceFailure('素材的本地文件已经不存在了（可能被移动或删除）：D://x.png')).toBe(true);
    expect(isMissingLocalSourceFailure('Failed to read file:// image source: not found')).toBe(true);
  });

  it('网络类失败不算「源文件丢失」', () => {
    expect(isMissingLocalSourceFailure('参考音频下载失败：HTTP 404')).toBe(false);
    expect(isMissingLocalSourceFailure('connection timed out')).toBe(false);
    expect(isMissingLocalSourceFailure('')).toBe(false);
  });
});

describe('plainReason', () => {
  it('取第一段，去掉重试之类的实现细节', () => {
    const raw =
      'Failed to read local image source: 系统找不到指定的文件。 (os error 2); 放宽预算重试后仍失败: x';
    expect(plainReason(raw)).toBe('源文件已不可用');
  });

  it('普通人话原样保留', () => {
    expect(plainReason('参考音频下载失败：HTTP 404。链接已失效')).toBe(
      '参考音频下载失败：HTTP 404。链接已失效',
    );
  });

  it('空原因返回空串', () => {
    expect(plainReason('')).toBe('');
  });
});
