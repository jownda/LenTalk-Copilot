import { describe, expect, it } from 'vitest';

import {
  createDramayaVideoPricing,
  isDramayaVideoBaseUrl,
  resolveDramayaVideoOptions,
} from './dramayaModels';

const CONTEXT = {
  resolution: '720p',
  settings: {
    displayCurrencyMode: 'auto' as const,
    usdToCnyRate: 7.2,
    preferDiscountedPrice: false,
    grsaiCreditTierId: 'tier-10' as const,
  },
};

/** tsconfig 的 lib 是 ES2021, 没有 Array.prototype.at, 用下标取末项。 */
function last<T>(items: T[]): T {
  return items[items.length - 1];
}

describe('isDramayaVideoBaseUrl', () => {
  it('只认正典视频站', () => {
    expect(isDramayaVideoBaseUrl('https://video.dramaya.us/v1')).toBe(true);
    expect(isDramayaVideoBaseUrl('https://video.dramaya.us')).toBe(true);
    // 图片站是另一套协议
    expect(isDramayaVideoBaseUrl('https://img.dramaya.us/v1')).toBe(false);
    expect(isDramayaVideoBaseUrl('https://notvideo.dramaya.us')).toBe(false);
    expect(isDramayaVideoBaseUrl('')).toBe(false);
  });
});

describe('resolveDramayaVideoOptions', () => {
  it('按型号给出时长区间(2.5 系 4~30, 2.0 系 4~15)', () => {
    expect(resolveDramayaVideoOptions('seedance2.5-A').durationOptions[0]).toBe(4);
    expect(last(resolveDramayaVideoOptions('seedance2.5-A').durationOptions)).toBe(30);
    expect(last(resolveDramayaVideoOptions('seedance2.0-A').durationOptions)).toBe(15);
    // F-720p 系列文档写 5~15
    expect(resolveDramayaVideoOptions('seedance2.0-F-720p').durationOptions[0]).toBe(5);
  });

  it('分辨率逐型号收窄: 2.5-A 不给 1080p, 720p 专供型号只有一档', () => {
    expect(resolveDramayaVideoOptions('seedance2.5-A').resolutionValues).toEqual(['480p', '720p']);
    expect(resolveDramayaVideoOptions('seedance2.5-720p-C').resolutionValues).toEqual(['720p']);
    expect(resolveDramayaVideoOptions('seedance2.0-B').resolutionValues).toContain('4k');
  });

  it('未登记型号退回通用档位, 不会退化成 1 秒', () => {
    const options = resolveDramayaVideoOptions('some-unknown-model');
    expect(options.durationOptions[0]).toBe(4);
    expect(options.defaultDuration).toBeGreaterThanOrEqual(4);
    expect(options.defaultDuration).toBeLessThanOrEqual(last(options.durationOptions));
  });

  it('默认时长一定落在可选档位内', () => {
    for (const model of ['seedance2.0-A', 'seedance2.5-A', 'minimax-h3', 'sd11-seedance-2.5']) {
      const options = resolveDramayaVideoOptions(model);
      expect(options.durationOptions).toContain(options.defaultDuration);
      expect(options.resolutionValues).toContain(options.defaultResolution);
    }
  });
});

describe('createDramayaVideoPricing', () => {
  it('按秒计费: 单价 × 秒数', () => {
    const pricing = createDramayaVideoPricing('seedance2.0-A');
    expect(pricing?.quote({ ...CONTEXT, resolution: '720p', extraParams: { duration: 10 } })).toEqual({
      amount: 10,
      currency: 'CNY',
    });
    // 1080p 单价 1.4
    expect(pricing?.quote({ ...CONTEXT, resolution: '1080p', extraParams: { duration: 10 } })).toEqual({
      amount: 14,
      currency: 'CNY',
    });
  });

  it('按条计费: 与秒数无关', () => {
    const pricing = createDramayaVideoPricing('seedance2.0-720p-C');
    expect(pricing?.quote({ ...CONTEXT, resolution: '720p', extraParams: { duration: 5 } })?.amount).toBe(3);
    expect(pricing?.quote({ ...CONTEXT, resolution: '720p', extraParams: { duration: 15 } })?.amount).toBe(3);
  });

  it('没登记的分辨率返回 null(显示未知), 不拿低档冒充', () => {
    const pricing = createDramayaVideoPricing('seedance2.5-A');
    expect(pricing?.quote({ ...CONTEXT, resolution: '4k', extraParams: { duration: 5 } })).toBeNull();
  });

  it('sd11 系列文档无报价 → 不给定价定义', () => {
    expect(createDramayaVideoPricing('sd11-seedance-2.0')).toBeUndefined();
  });
});
