import { describe, expect, it } from 'vitest';

import {
  createWgspaiImagePricing,
  createWgspaiVideoPricing,
  isWgspaiProvider,
  resolveWgspaiImagePrice,
  resolveWgspaiVideoPrice,
} from './wgspaiPricing';

const PRICE_CONTEXT = {
  resolution: '1K',
  settings: {
    displayCurrencyMode: 'auto' as const,
    usdToCnyRate: 7.2,
    preferDiscountedPrice: false,
    grsaiCreditTierId: 'tier-10' as const,
  },
};

describe('isWgspaiProvider', () => {
  it('认平台 id（含 custom: 前缀）', () => {
    expect(isWgspaiProvider('custom:wgspai')).toBe(true);
    expect(isWgspaiProvider('wgspai')).toBe(true);
    expect(isWgspaiProvider('WGSPAI')).toBe(true);
  });

  it('认平台域名（用户把名字改成中文也命中）', () => {
    expect(isWgspaiProvider('Wgspai 视频', 'https://api.wgspai.cn')).toBe(true);
    expect(isWgspaiProvider('', 'https://API.WGSPAI.cn/v1')).toBe(true);
  });

  it('不误伤其它平台', () => {
    expect(isWgspaiProvider('custom:知鸟ai', 'https://cuai.token6688.com')).toBe(false);
    expect(isWgspaiProvider('custom:炳火api', 'https://api.7tai.cc/v1')).toBe(false);
    expect(isWgspaiProvider('', '')).toBe(false);
  });
});

describe('resolveWgspaiImagePrice', () => {
  it('三款图片模型都是 0.1 元/张', () => {
    expect(resolveWgspaiImagePrice('gpt-image-2-2k')).toBeCloseTo(0.1, 4);
    expect(resolveWgspaiImagePrice('gpt-image-2.5')).toBeCloseTo(0.1, 4);
    expect(resolveWgspaiImagePrice('nano-banana-2')).toBeCloseTo(0.1, 4);
  });

  it('按张数乘（n=4 就是 4 张的钱）', () => {
    expect(resolveWgspaiImagePrice('gpt-image-2-2k', 4)).toBeCloseTo(0.4, 4);
  });

  it('张数非法时按 1 张算，而不是返回 NaN', () => {
    expect(resolveWgspaiImagePrice('gpt-image-2-2k', 0)).toBeCloseTo(0.1, 4);
    expect(resolveWgspaiImagePrice('gpt-image-2-2k', Number.NaN)).toBeCloseTo(0.1, 4);
  });

  it('表里没有的模型返回 undefined（让节点不显示价格，而不是显示 0）', () => {
    expect(resolveWgspaiImagePrice('gpt-image-2pro-2K-16:9')).toBeUndefined();
  });
});

describe('resolveWgspaiVideoPrice', () => {
  it('按次一口价的模型与时长无关', () => {
    expect(resolveWgspaiVideoPrice('seedance-v2-720p', 5)).toBeCloseTo(5.5, 4);
    expect(resolveWgspaiVideoPrice('seedance-v2-720p', 15)).toBeCloseTo(5.5, 4);
    expect(resolveWgspaiVideoPrice('seedance-v2-720p-fast')).toBeCloseTo(3.5, 4);
  });

  it('Videos 族的 seedance2.5 是固定 3 元/次（不在 /api/pricing 里）', () => {
    expect(resolveWgspaiVideoPrice('seedance2.5', 30)).toBeCloseTo(3, 4);
  });

  it('大小写不敏感：平台写 Minimax-h3，表里是小写', () => {
    expect(resolveWgspaiVideoPrice('Minimax-h3')).toBeCloseTo(1.5, 4);
    expect(resolveWgspaiVideoPrice('minimax-h3')).toBeCloseTo(1.5, 4);
  });

  it('唯一按秒计费的模型要乘时长，缺时长按 5 秒估', () => {
    expect(resolveWgspaiVideoPrice('seedance-2.0-720-new', 10)).toBeCloseTo(2.5, 4);
    expect(resolveWgspaiVideoPrice('seedance-2.0-720-new')).toBeCloseTo(1.25, 4);
  });

  it('未定价的模型返回 undefined', () => {
    expect(resolveWgspaiVideoPrice('sd-2', 10)).toBeUndefined();
  });
});

describe('createWgspaiImagePricing / createWgspaiVideoPricing', () => {
  it('图片报价从 extraParams.count 取张数', () => {
    const pricing = createWgspaiImagePricing('gpt-image-2-2k');
    expect(pricing?.quote({ ...PRICE_CONTEXT, extraParams: {} })).toEqual({
      amount: 0.1,
      currency: 'CNY',
    });
    expect(pricing?.quote({ ...PRICE_CONTEXT, extraParams: { count: 4 } })).toEqual({
      amount: 0.4,
      currency: 'CNY',
    });
  });

  it('视频报价从 extraParams.duration 取时长', () => {
    const perSecond = createWgspaiVideoPricing('seedance-2.0-720-new');
    expect(perSecond?.quote({ ...PRICE_CONTEXT, extraParams: { duration: 15 } })).toEqual({
      amount: 3.75,
      currency: 'CNY',
    });
    const perCall = createWgspaiVideoPricing('grok-imagine-video-6s');
    expect(perCall?.quote({ ...PRICE_CONTEXT, extraParams: { duration: 6 } })).toEqual({
      amount: 0.42,
      currency: 'CNY',
    });
  });

  it('没定价的模型不生成 pricing（registry 会退回其它分支）', () => {
    expect(createWgspaiImagePricing('flux-2')).toBeUndefined();
    expect(createWgspaiVideoPricing('sd-2-vip')).toBeUndefined();
  });
});
