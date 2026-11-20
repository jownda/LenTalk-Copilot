import { describe, expect, it } from 'vitest';
import { resolveVideoReferenceSupport } from './videoReferenceSupport';

describe('resolveVideoReferenceSupport', () => {
  it('炳火固定支持，上限 3', () => {
    expect(resolveVideoReferenceSupport('binghuo-video', 'bh2.0-pro')).toEqual({
      supported: true,
      maxVideos: 3,
    });
  });

  it('通用 OpenAI Video / Sub2API / 本地 CLI 一律不支持', () => {
    for (const profileId of [
      'openai-video',
      'seedance-v2',
      'sub2api-video',
      'dramaya-video',
      'zhiniao-video',
      'zhenjian-task-api',
      'wan-cli',
    ] as const) {
      expect(resolveVideoReferenceSupport(profileId, 'any-model')).toEqual({
        supported: false,
        maxVideos: 0,
      });
    }
  });

  it('即梦画布 CLI 按模型的目录额度判定：seedance_2.5_flash 收 5 段视频', () => {
    // 目录里 `references.types[video].max` 就是额度，不是 `references.max`（那是总数 20）。
    expect(resolveVideoReferenceSupport('jimeng-canvas', 'jimeng-canvas/seedance_2.5_flash', 5)).toEqual({
      supported: true,
      maxVideos: 5,
    });
    // 目录没同步到（额度缺省）时宁可标不支持，也不要谎称「会提交」。
    expect(resolveVideoReferenceSupport('jimeng-canvas', 'jimeng-canvas/seedance_2.5_flash')).toEqual({
      supported: false,
      maxVideos: 0,
    });
    // `seedance_pro_fast` 的目录里没有 m2v，额度是 0。
    expect(resolveVideoReferenceSupport('jimeng-canvas', 'jimeng-canvas/seedance_pro_fast', 0)).toEqual({
      supported: false,
      maxVideos: 0,
    });
  });

  it('即梦 CLI 按型号判定：2.5 收 10 段、2.0 家族 3 段、2.5 Flash 不收', () => {
    // 来源是 `dreamina multimodal2video -h` 原文的额度声明。
    expect(resolveVideoReferenceSupport('jimeng-cli', 'jimeng-cli/seedance2.5')).toEqual({
      supported: true,
      maxVideos: 10,
    });
    expect(resolveVideoReferenceSupport('jimeng-cli', 'jimeng-cli/seedance2.0fast_vip')).toEqual({
      supported: true,
      maxVideos: 3,
    });
    // `seedance2.5_flash` 只在 text2video 的白名单里，multimodal2video 不认它。
    expect(resolveVideoReferenceSupport('jimeng-cli', 'jimeng-cli/seedance2.5_flash')).toEqual({
      supported: false,
      maxVideos: 0,
    });
    expect(resolveVideoReferenceSupport('jimeng-cli', 'jimeng-cli/unknown')).toEqual({
      supported: false,
      maxVideos: 0,
    });
  });

  it('未选中模型（profile 为空）时不支持，避免 UI 误标', () => {
    expect(resolveVideoReferenceSupport(null, 'x')).toEqual({ supported: false, maxVideos: 0 });
    expect(resolveVideoReferenceSupport(undefined, 'x')).toEqual({ supported: false, maxVideos: 0 });
  });

  it('字子只有 -video 型号支持，普通型号不算', () => {
    expect(resolveVideoReferenceSupport('zzdh-v8-video', 'zzdh-seedance-2-video').supported).toBe(true);
    expect(resolveVideoReferenceSupport('zzdh-v8-video', 'zzdh-Minimax-h3-480p').supported).toBe(false);
  });

  it('WGSPAI 按模型档位决定：seedance 系支持，h3 不支持', () => {
    expect(resolveVideoReferenceSupport('wgspai-video', 'seedance2.5')).toEqual({
      supported: true,
      maxVideos: 3,
    });
    expect(resolveVideoReferenceSupport('wgspai-video', 'minimax-h3').supported).toBe(false);
  });

  it('筷子 / likeai / RunningHub 登记为支持', () => {
    for (const profileId of ['kuaizi-video', 'likeai-video', 'runninghub-model'] as const) {
      expect(resolveVideoReferenceSupport(profileId, 'seedance-2.0').supported).toBe(true);
    }
  });
});
