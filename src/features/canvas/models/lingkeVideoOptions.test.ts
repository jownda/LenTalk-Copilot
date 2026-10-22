import { describe, expect, it } from 'vitest';
import {
  API666888_DEFAULT_ASPECTS,
  API666888_FALLBACK_DURATIONS,
  API666888_VIDEO_OPTION_TABLE,
  resolveApi666888VideoOptions,
} from './lingkeVideoOptions';

describe('灵柯 AI 全量视频档位表', () => {
  it('74 个视频模型一个不少', () => {
    expect(Object.keys(API666888_VIDEO_OPTION_TABLE)).toHaveLength(74);
  });

  it('每个模型解析后时长与画幅都不为空, 控件不会空掉', () => {
    for (const model of Object.keys(API666888_VIDEO_OPTION_TABLE)) {
      const resolved = resolveApi666888VideoOptions(model);
      // 超分 / 数字人 / 动作控制 / MV 这几类平台本身不给 duration(由素材决定),
      // 表里留空, 由 resolve 兜底 —— 但绝不能是空数组, 否则节点上没有可选项。
      expect(resolved.durationOptions.length, `${model} 时长档为空`).toBeGreaterThan(0);
      expect(resolved.aspectRatios.length, `${model} 画幅为空`).toBeGreaterThan(0);
    }
  });

  it('名字自带固定秒数的模型按名字定档(omni_flash-10s 只有 10 秒)', () => {
    expect(resolveApi666888VideoOptions('omni_flash-10s').durationOptions).toEqual([10]);
    expect(resolveApi666888VideoOptions('omni_flash-10s-fl').durationOptions).toEqual([10]);
  });

  it('档位全是正整数, 不含 auto / NaN', () => {
    for (const [model, entry] of Object.entries(API666888_VIDEO_OPTION_TABLE)) {
      for (const value of entry.durationOptions) {
        expect(Number.isInteger(value) && value > 0, `${model} 时长档 ${value} 非法`).toBe(true);
      }
      expect(entry.durationOptions, `${model} 时长档未排序`).toEqual(
        [...entry.durationOptions].sort((a, b) => a - b),
      );
    }
  });

  it('defaultDuration 落在该模型自己的档位里, 且不超过 30 秒', () => {
    for (const [model, entry] of Object.entries(API666888_VIDEO_OPTION_TABLE)) {
      expect(entry.defaultDuration, `${model} 默认时长超 30`).toBeLessThanOrEqual(30);
      if (entry.durationOptions.length > 0) {
        expect(entry.durationOptions, `${model} 默认时长不在档位内`).toContain(entry.defaultDuration);
      }
    }
  });

  it('画幅里不出现 adaptive(软件没有「自适应」选项)', () => {
    for (const [model, entry] of Object.entries(API666888_VIDEO_OPTION_TABLE)) {
      expect(entry.aspectRatios, `${model} 残留 adaptive`).not.toContain('adaptive');
    }
  });

  it('抽查各家族的真实档位', () => {
    // 可灵: 5 / 10 / 15, 不是通用的 4~15
    expect(resolveApi666888VideoOptions('kling-v3-video').durationOptions).toEqual([5, 10, 15]);
    // GK: 只有 6 / 10 两档
    expect(resolveApi666888VideoOptions('gk-video-3').durationOptions).toEqual([6, 10]);
    // Vidu Q4: 3~16
    const vidu = resolveApi666888VideoOptions('viduq4-preview').durationOptions;
    expect(vidu[0]).toBe(3);
    expect(vidu[vidu.length - 1]).toBe(16);
    // Omni Flash: 4 / 6 / 8 / 10
    expect(resolveApi666888VideoOptions('omni-flash').durationOptions).toEqual([4, 6, 8, 10]);
    // Seedance 2.5: 4~30 逐秒
    const sd = resolveApi666888VideoOptions('seedance-2.5-anmiao');
    expect(sd.durationOptions[0]).toBe(4);
    expect(sd.durationOptions[sd.durationOptions.length - 1]).toBe(30);
    expect(sd.defaultDuration).toBe(30);
  });

  it('满血版走方舟, 需要 version 类专属参数的要被标出来', () => {
    const guanfang = resolveApi666888VideoOptions('seedance-2.0-guanfang');
    expect(guanfang.needsParams).toContain('version');
    // 能直接跑的模型不该有这个标记
    expect(resolveApi666888VideoOptions('seedance-2.5-anmiao').needsParams).toEqual([]);
  });

  it('表外模型走兜底, 不让控件空掉', () => {
    const unknown = resolveApi666888VideoOptions('brand-new-model-2027');
    expect(unknown.aspectRatios).toEqual(API666888_DEFAULT_ASPECTS);
    expect(unknown.durationOptions).toEqual(API666888_FALLBACK_DURATIONS);
    expect(unknown.defaultDuration).toBe(30);
  });
});
