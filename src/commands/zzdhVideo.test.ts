import { describe, expect, it } from 'vitest';

import { resolveZzdhGenerationMode, resolveZzdhReferenceImages } from './ai';

/**
 * 字子动画 H3 的 mode 是官方文档明确要求的字段:
 * 不传 mode 时"有参考图/视频/音频一律走参考生", 选首尾帧会被静默降级成参考生。
 */
describe('resolveZzdhGenerationMode', () => {
  it('首尾帧 → fl2v(不传 mode 会被误判成参考生)', () => {
    expect(resolveZzdhGenerationMode('first-last', 2)).toBe('fl2v');
  });

  it('首尾帧只给了一张首帧 → 仍是 fl2v(首帧生视频)', () => {
    expect(resolveZzdhGenerationMode('first-last', 1)).toBe('fl2v');
  });

  it('参考生(有参考图) → ref2v', () => {
    expect(resolveZzdhGenerationMode('reference', 3)).toBe('ref2v');
    expect(resolveZzdhGenerationMode(undefined, 1)).toBe('ref2v');
  });

  it('无参考素材 → t2v(纯文生)', () => {
    expect(resolveZzdhGenerationMode('reference', 0)).toBe('t2v');
    expect(resolveZzdhGenerationMode(undefined, 0)).toBe('t2v');
  });
});

describe('resolveZzdhReferenceImages', () => {
  it('保留真正的公网图片 URL 与 H3 参考生 role', async () => {
    await expect(resolveZzdhReferenceImages(
      ['https://cdn.example.com/character.png'],
      'minimax-h3',
      'reference',
    )).resolves.toEqual([
      { url: 'https://cdn.example.com/character.png', role: 'reference_image' },
    ]);
  });

  it('H3 在提交前拒绝本地 data URL，避免平台返回不可操作的公网 URL 错误', async () => {
    await expect(resolveZzdhReferenceImages(
      ['data:image/png;base64,iVBORw0KGgo='],
      'minimax-h3',
      'reference',
    )).rejects.toThrow(/MiniMax H3 参考图仅支持公网 HTTP\(S\) URL/);
  });

  it('其它模型仍可使用通用 base64 参考图兼容格式', async () => {
    await expect(resolveZzdhReferenceImages(
      ['data:image/png;base64,iVBORw0KGgo='],
      'seedance',
      'reference',
    )).resolves.toEqual([
      { base64: 'iVBORw0KGgo=', role: 'first_frame' },
    ]);
  });
});
