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

  it('2.5 与 2.0-mini 只开放 16:9（实测都不支持 9:16 / adaptive）', () => {
    expect(resolveLikeaiVideoOptions('doubao-seedance-2.5').aspectRatios).toEqual(['16:9']);
    expect(resolveLikeaiVideoOptions('doubao-seedance-2.0-mini').aspectRatios).toEqual(['16:9']);
    expect(likeaiModelSupportsPortrait('doubao-seedance-2.5')).toBe(false);
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

  it('时长上限实测为 15 秒（16 秒起被拒，与官方 2.5 的 30 秒口径不同）', () => {
    for (const model of Object.keys(LIKEAI_VIDEO_OPTION_TABLE)) {
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
