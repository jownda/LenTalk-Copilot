import { describe, expect, it } from 'vitest';

import { resolveZhiniaoVideoMode } from './ai';

/**
 * 知鸟 AI(TokenGo)扁平入口的 mode 判定。
 *
 * 平台硬约束：只有参考生(reference)允许携带参考音频 / 参考视频，
 * 首帧 / 首尾帧带音频会被网关 400 拒收：
 *   `首帧 / 首尾帧模式不能带参考视频或参考音频 (mode=first-frame; …)`
 */
describe('resolveZhiniaoVideoMode', () => {
  it('参考生 + 1 张参考图 + 1 段参考音频 → reference(不得降级成首帧)', () => {
    // 用户实报回归：角色一致性最常见的用法，曾经被按图片数量判成 first-frame 而必失败。
    expect(resolveZhiniaoVideoMode('reference', 1, true)).toBe('reference');
  });

  it('参考生 + 只有参考音频没有参考图 → reference(不能当成纯文生)', () => {
    expect(resolveZhiniaoVideoMode('reference', 0, true)).toBe('reference');
    expect(resolveZhiniaoVideoMode(undefined, 0, true)).toBe('reference');
  });

  it('首尾帧 + 双图 + 参考音频 → reference(首尾帧不收音频, 发 reference 才不会 400)', () => {
    expect(resolveZhiniaoVideoMode('first-last', 2, true)).toBe('reference');
  });

  it('参考生 + 单图 + 无音频 → reference(不再自动降级成首帧)', () => {
    // 用户实报回归：首帧 / 首尾帧模式下平台**忽略 aspect_ratio、跟随首帧图片比例**,
    // 症状是「选了 9:16，输出却是参考图的 3:4」。单图必须走参考生。
    expect(resolveZhiniaoVideoMode('reference', 1)).toBe('reference');
    expect(resolveZhiniaoVideoMode(undefined, 1)).toBe('reference');
  });

  it('参考生 + 多图 → reference', () => {
    expect(resolveZhiniaoVideoMode('reference', 3)).toBe('reference');
    expect(resolveZhiniaoVideoMode(undefined, 2)).toBe('reference');
  });

  it('首尾帧 + 双图 → first-last(用户显式选择，且两图才有首尾语义)', () => {
    expect(resolveZhiniaoVideoMode('first-last', 2)).toBe('first-last');
  });

  it('首尾帧 + 单图 → reference(单图凑不出首尾帧，且首帧模式控不住比例)', () => {
    expect(resolveZhiniaoVideoMode('first-last', 1)).toBe('reference');
  });

  it('首尾帧 + 双图 + 参考图像之外还有参考音频 → reference', () => {
    expect(resolveZhiniaoVideoMode('first-last', 2, true)).toBe('reference');
  });

  it('完全无参考素材 → text-to-video', () => {
    expect(resolveZhiniaoVideoMode(undefined, 0)).toBe('text-to-video');
    expect(resolveZhiniaoVideoMode('reference', 0)).toBe('text-to-video');
  });
});
