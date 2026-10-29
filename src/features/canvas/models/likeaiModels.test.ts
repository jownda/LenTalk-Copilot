import { describe, expect, it } from 'vitest';

import {
  isLikeaiBaseUrl,
  LIKEAI_VIDEO_OPTION_TABLE,
  likeaiModelSupportsPortrait,
  resolveLikeaiVideoOptions,
} from './likeaiModels';

const last = (values: number[]): number => values[values.length - 1] as number;

describe('likeai520 视频档位表（按渠道实测能力）', () => {
  it('按 Base URL 识别 likeai520', () => {
    expect(isLikeaiBaseUrl('https://api.likeai520.cc')).toBe(true);
    expect(isLikeaiBaseUrl('https://www.likeai520.cc')).toBe(true);
    expect(isLikeaiBaseUrl('https://aiopenapi.kuaizi.cn')).toBe(false);
    expect(isLikeaiBaseUrl(undefined)).toBe(false);
  });

  it('2.5 已放开全画幅（2026-10-28 平台更新），mini 仍只有 16:9', () => {
    // 用户 10-28 反馈「平台说更新了 2.5 的 9:16」→ 实测确实放开，而且不只 9:16。
    const seedance25 = resolveLikeaiVideoOptions('doubao-seedance-2.5');
    expect(seedance25.aspectRatios).toEqual(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive']);
    expect(likeaiModelSupportsPortrait('doubao-seedance-2.5')).toBe(true);
    // mini 没变：9:16 / 1:1 / 21:9 / adaptive 在平台侧仍报 supported ratio is required。
    expect(resolveLikeaiVideoOptions('doubao-seedance-2.0-mini').aspectRatios).toEqual(['16:9']);
    expect(likeaiModelSupportsPortrait('doubao-seedance-2.0-mini')).toBe(false);
  });

  it('2.0 / 2.0-fast 支持竖屏，2.0 还开放 4K', () => {
    expect(resolveLikeaiVideoOptions('doubao-seedance-2.0').aspectRatios).toContain('9:16');
    expect(resolveLikeaiVideoOptions('doubao-seedance-2.0-fast').aspectRatios).toContain('9:16');
    expect(likeaiModelSupportsPortrait('doubao-seedance-2.0')).toBe(true);
    expect(resolveLikeaiVideoOptions('doubao-seedance-2.0').resolutionValues).toContain('4k');
    // fast 实测 4k 被拒
    expect(resolveLikeaiVideoOptions('doubao-seedance-2.0-fast').resolutionValues).not.toContain('4k');
    expect(resolveLikeaiVideoOptions('doubao-seedance-2.5').resolutionValues).not.toContain('4k');
  });

  it('时长：2.5 开放到 30 秒，其余型号仍是 15 秒（31 秒起被拒）', () => {
    const seedance25 = resolveLikeaiVideoOptions('doubao-seedance-2.5');
    expect(seedance25.durationOptions[0]).toBe(4);
    expect(last(seedance25.durationOptions)).toBe(30);
    for (const model of ['doubao-seedance-2.0', 'doubao-seedance-2.0-fast', 'doubao-seedance-2.0-mini']) {
      const options = resolveLikeaiVideoOptions(model);
      expect(options.durationOptions[0], `${model} 起始秒数`).toBe(4);
      expect(last(options.durationOptions), `${model} 时长上限`).toBe(15);
    }
  });

  it('默认值一定落在可选档位里（否则下拉会显示不存在的选项）', () => {
    for (const model of Object.keys(LIKEAI_VIDEO_OPTION_TABLE)) {
      const options = resolveLikeaiVideoOptions(model);
      expect(options.aspectRatios, `${model} 默认画幅不在档位内`).toContain(options.defaultAspectRatio);
      expect(options.resolutionValues, `${model} 默认分辨率不在档位内`).toContain(options.defaultResolution);
      expect(options.durationOptions, `${model} 默认时长不在档位内`).toContain(options.defaultDuration);
    }
  });

  it('表外型号按最保守的交集兜底，不放开画幅', () => {
    const options = resolveLikeaiVideoOptions('some-future-model');
    expect(options.aspectRatios).toEqual(['16:9']);
    expect(options.resolutionValues).toEqual(['480p', '720p']);
    expect(last(options.durationOptions)).toBe(15);
  });
});
