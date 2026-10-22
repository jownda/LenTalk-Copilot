import { describe, expect, it } from 'vitest';

import {
  createZhiniaoImagePricing,
  createZhiniaoVideoPricing,
  isZhiniaoProvider,
  resolveZhiniaoImagePrice,
  resolveZhiniaoVideoPrice,
} from './zhiniaoPricing';

const PRICE_CONTEXT = {
  settings: {
    displayCurrencyMode: 'auto' as const,
    usdToCnyRate: 7.2,
    preferDiscountedPrice: false,
    grsaiCreditTierId: 'tier-10' as const,
  },
};

describe('isZhiniaoProvider', () => {
  it('认平台 id（含 custom: 前缀与中文名）', () => {
    expect(isZhiniaoProvider('custom:知鸟ai')).toBe(true);
    expect(isZhiniaoProvider('zhiniao')).toBe(true);
    expect(isZhiniaoProvider('custom:zhiniaoai')).toBe(true);
  });

  it('认平台域名（用户改名后仍能命中）', () => {
    expect(isZhiniaoProvider('随便起的名字', 'https://cuai.token6688.com')).toBe(true);
    expect(isZhiniaoProvider('', 'https://CUAi.Token6688.com/v1')).toBe(true);
  });

  it('不误伤其它平台', () => {
    expect(isZhiniaoProvider('custom:字子动画', 'https://www.zizidonghua.com')).toBe(false);
    expect(isZhiniaoProvider('custom:炳火api', 'https://api.7tai.cc/v1')).toBe(false);
    expect(isZhiniaoProvider('', '')).toBe(false);
  });
});

describe('resolveZhiniaoImagePrice', () => {
  it('无档位维度的模型直接返回固定价', () => {
    expect(resolveZhiniaoImagePrice('gpt-image-2', '1K')).toBeCloseTo(0.033, 4);
    expect(resolveZhiniaoImagePrice('gpt-image-2', '4K')).toBeCloseTo(0.033, 4);
  });

  it('有档位维度的模型按分辨率取价，且大小写不敏感', () => {
    expect(resolveZhiniaoImagePrice('gemini-3.1-flash-image', '1K')).toBeCloseTo(0.1189, 4);
    expect(resolveZhiniaoImagePrice('gemini-3.1-flash-image', '4k')).toBeCloseTo(0.2379, 4);
    expect(resolveZhiniaoImagePrice('gemini-nano-banana-2.1-image', '2K')).toBeCloseTo(0.1097, 4);
  });

  it('档位缺失时退回 default，而不是返回空', () => {
    expect(resolveZhiniaoImagePrice('no-such-image-model', '1K')).toBeUndefined();
    expect(resolveZhiniaoImagePrice('gpt-image-2-c', '1K')).toBeCloseTo(0.0529, 4);
  });

  it('Midjourney 按组计价：count 是组数', () => {
    expect(resolveZhiniaoImagePrice('mj_imagine', '1K')).toBeCloseTo(0.0866, 4);
    expect(resolveZhiniaoImagePrice('mj_imagine', '1K', { count: 2 })).toBeCloseTo(0.1732, 4);
    expect(resolveZhiniaoImagePrice('mj_imagine', '1K', { count: 4 })).toBeCloseTo(0.3464, 4);
  });

  it('count 异常值按 1 组、并夹到 50 组上限', () => {
    expect(resolveZhiniaoImagePrice('mj_imagine', '1K', { count: 0 })).toBeCloseTo(0.0866, 4);
    expect(resolveZhiniaoImagePrice('mj_imagine', '1K', { count: Number.NaN })).toBeCloseTo(0.0866, 4);
    expect(resolveZhiniaoImagePrice('mj_imagine', '1K', { count: 999 })).toBeCloseTo(0.0866 * 50, 4);
  });

  it('表里没有的模型返回 undefined（节点不显示价格，而不是显示 0）', () => {
    expect(resolveZhiniaoImagePrice('no-such-model', '1K')).toBeUndefined();
  });
});

describe('resolveZhiniaoVideoPrice', () => {
  it('按秒的模型乘时长', () => {
    expect(resolveZhiniaoVideoPrice('seedance-2-5', '720P', 5)).toBeCloseTo(5.6625, 3);
    expect(resolveZhiniaoVideoPrice('seedance-2-5', '720P', 10)).toBeCloseTo(11.325, 3);
    expect(resolveZhiniaoVideoPrice('seedance-2-5', '1080P', 5)).toBeCloseTo(13.351, 2);
  });

  it('按次的模型与时长无关', () => {
    expect(resolveZhiniaoVideoPrice('veo-3.1', '720P', 5)).toBeCloseTo(0.8736, 4);
    expect(resolveZhiniaoVideoPrice('veo-3.1', '720P', 15)).toBeCloseTo(0.8736, 4);
    expect(resolveZhiniaoVideoPrice('omni-flash-1-1', '1080P', 10)).toBeCloseTo(0.8299, 4);
  });

  it('同一模型不同档位的计价单位可以不一样（wan-3-0）', () => {
    expect(resolveZhiniaoVideoPrice('wan-3-0', '480P', 10)).toBeCloseTo(2.283, 3);
    expect(resolveZhiniaoVideoPrice('wan-3-0', '1080P', 10)).toBeCloseTo(4.368, 3);
  });

  it('时长缺省按 5 秒估', () => {
    expect(resolveZhiniaoVideoPrice('seedance-2-5', '720P', undefined)).toBeCloseTo(5.6625, 3);
    expect(resolveZhiniaoVideoPrice('seedance-2-5', '720P', 0)).toBeCloseTo(5.6625, 3);
  });

  it('档位对不上时优先落 720P，再退回表里第一档', () => {
    // 表里只有 768p / 2k，客户端默认给 720P —— 落 720P 兜底（不存在）后取第一档
    expect(resolveZhiniaoVideoPrice('minimax-h3', '720P', 5)).toBeGreaterThan(0);
    expect(resolveZhiniaoVideoPrice('kling-avatar', '720P', 10)).toBeCloseTo(4.95, 3);
  });
});

describe('pricing 定义（挂到模型上时）', () => {
  it('图片：quote 带上分辨率与组数', () => {
    const pricing = createZhiniaoImagePricing('mj_imagine');
    expect(pricing).toBeDefined();
    const quote = pricing!.quote({
      resolution: '1K',
      extraParams: { count: 2 },
      ...PRICE_CONTEXT,
    });
    expect(quote).toEqual({ amount: expect.closeTo(0.1732, 4), currency: 'CNY' });
  });

  it('视频：quote 从 extraParams.duration 取时长', () => {
    const pricing = createZhiniaoVideoPricing('seedance-2-5');
    expect(pricing).toBeDefined();
    const quote = pricing!.quote({
      resolution: '720P',
      extraParams: { duration: 10 },
      ...PRICE_CONTEXT,
    });
    expect(quote?.amount).toBeCloseTo(11.325, 3);
    expect(quote?.currency).toBe('CNY');
  });

  it('不在表里的模型不生成 pricing', () => {
    expect(createZhiniaoImagePricing('no-such-model')).toBeUndefined();
    expect(createZhiniaoVideoPricing('no-such-model')).toBeUndefined();
  });
});
