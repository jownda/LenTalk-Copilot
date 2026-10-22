import { describe, expect, it } from 'vitest';

import { resolveRecommendedApiPriceBadge } from './nodePriceBadge';

describe('resolveRecommendedApiPriceBadge', () => {
  const customApis = [
    { id: 'binghuo', baseUrl: 'https://api.7tai.cc/v1' },
    { id: 'zhiniao', baseUrl: 'https://cuai.token6688.com' },
  ];

  it('returns null when providerId is missing', () => {
    expect(resolveRecommendedApiPriceBadge(undefined, customApis, 'video')).toBeNull();
  });

  it('returns null when providerId is not a custom: provider', () => {
    expect(resolveRecommendedApiPriceBadge('grsai', customApis, 'video')).toBeNull();
    expect(resolveRecommendedApiPriceBadge('JIMENG_CLI', customApis, 'video')).toBeNull();
  });

  it('returns null when custom api is not found', () => {
    expect(resolveRecommendedApiPriceBadge('custom:unknown', customApis, 'video')).toBeNull();
  });

  it('returns null when recommended api has no pricingRange for the requested kind', () => {
    expect(resolveRecommendedApiPriceBadge('custom:binghuo', customApis, 'image')).toBeNull();
  });

  it('returns the video range for zhiniao', () => {
    expect(resolveRecommendedApiPriceBadge('custom:zhiniao', customApis, 'video')).toEqual({
      label: '⚡0.01 ~ 1.36 / 次',
      nativeLabel: '⚡0.01 ~ 1.36 / 次',
    });
  });

  it('returns the image range for zhiniao', () => {
    expect(resolveRecommendedApiPriceBadge('custom:zhiniao', customApis, 'image')).toEqual({
      label: '⚡0.01 ~ 0.17 / 张',
      nativeLabel: '⚡0.01 ~ 0.17 / 张',
    });
  });

  it('returns the audio range for zhiniao', () => {
    expect(resolveRecommendedApiPriceBadge('custom:zhiniao', customApis, 'audio')).toEqual({
      label: '⚡0.01 ~ 2.2 / 次',
      nativeLabel: '⚡0.01 ~ 2.2 / 次',
    });
  });
});
