import { describe, expect, it } from 'vitest';

import {
  isKuaiziBaseUrl,
  KZ_VIDEO_OPTION_TABLE,
  resolveKuaiziVideoLimits,
  resolveKuaiziVideoOptions,
} from './kuaiziModels';

const last = (values: number[]): number => values[values.length - 1] as number;

describe('筷子AI 视频档位表', () => {
  it('按 Base URL 识别筷子AI', () => {
    expect(isKuaiziBaseUrl('https://aiopenapi.kuaizi.cn')).toBe(true);
    expect(isKuaiziBaseUrl('https://AIOPENAPI.KUAIZI.CN/v1')).toBe(true);
    expect(isKuaiziBaseUrl('https://api.wgspai.cn')).toBe(false);
    expect(isKuaiziBaseUrl(undefined)).toBe(false);
  });

  it('2.5 的时长到 30 秒, 2.0 三兄弟只到 15 秒', () => {
    // 文档「分档参数矩阵」: 2.5 为 [4,30], 其余为 [4,15]。
    expect(last(resolveKuaiziVideoOptions('doubao-seedance-2-5-260628').durationOptions)).toBe(30);
    for (const model of [
      'doubao-seedance-2-0-260128',
      'doubao-seedance-2-0-fast-260128',
      'doubao-seedance-2-0-mini-260615',
    ]) {
      expect(last(resolveKuaiziVideoOptions(model).durationOptions)).toBe(15);
    }
    // 区间是闭区间且从 4 开始 —— 平台不接受 1~3 秒。
    expect(resolveKuaiziVideoOptions('doubao-seedance-2-5-260628').durationOptions[0]).toBe(4);
  });

  it('4k 只有 pro 能选, 2.5 明确不支持', () => {
    expect(resolveKuaiziVideoOptions('doubao-seedance-2-0-260128').resolutionValues).toContain('4k');
    expect(resolveKuaiziVideoOptions('doubao-seedance-2-5-260628').resolutionValues).not.toContain('4k');
    expect(resolveKuaiziVideoOptions('doubao-seedance-2-0-fast-260128').resolutionValues).not.toContain('4k');
  });

  it('默认时长与默认分辨率都落在可选档位里', () => {
    for (const model of Object.keys(KZ_VIDEO_OPTION_TABLE)) {
      const options = resolveKuaiziVideoOptions(model);
      expect(options.durationOptions, `${model} 默认时长不在档位内`).toContain(options.defaultDuration);
      expect(options.resolutionValues, `${model} 默认分辨率不在档位内`).toContain(options.defaultResolution);
      // 档位必须升序, 滑杆按下标映射秒数。
      expect(options.durationOptions).toEqual([...options.durationOptions].sort((a, b) => a - b));
      // 画幅不出文档枚举(没有 adaptive)。
      expect(options.aspectRatios).not.toContain('adaptive');
    }
  });

  it('素材条数上限按模型分档', () => {
    expect(resolveKuaiziVideoLimits('doubao-seedance-2-0-260128')).toEqual({ maxImages: 9, maxAudios: 3 });
    expect(resolveKuaiziVideoLimits('doubao-seedance-2-5-260628')).toEqual({ maxImages: 30, maxAudios: 10 });
  });

  it('表外模型按 2.0 / 2.5 的交集兜底, 不放大上限', () => {
    const options = resolveKuaiziVideoOptions('some-future-model');
    expect(last(options.durationOptions)).toBe(15);
    expect(options.resolutionValues).toEqual(['480p', '720p', '1080p']);
    expect(options.label).toBe('');
  });

  it('只有 2.5 带首尾帧 adaptive 约束', () => {
    expect(resolveKuaiziVideoOptions('doubao-seedance-2-5-260628').firstLastRequiresAdaptiveRatio).toBe(true);
    expect(resolveKuaiziVideoOptions('doubao-seedance-2-0-260128').firstLastRequiresAdaptiveRatio).toBe(false);
  });
});
