import { describe, expect, it } from 'vitest';

import {
  MIDJOURNEY_IMAGES_PER_GROUP,
  isMidjourneyImageModel,
  resolveImageCountImages,
} from './midjourney';
import { getImageModel } from './registry';
import { useSettingsStore, type CustomApiProvider } from '@/stores/settingsStore';

describe('isMidjourneyImageModel', () => {
  it.each([
    'custom:知鸟ai/mj_imagine',
    'mj_imagine',
    'MJ_Imagine',
    'midjourney',
    'custom:some-api/midjourney-v6',
  ])('recognizes %s as Midjourney', (modelId) => {
    expect(isMidjourneyImageModel(modelId)).toBe(true);
  });

  it.each([
    // grok-imagine 名字里也有 imagine，但它是 xAI 的模型、按张出图 —— 跟着 MJ 走会把 4 张当成 1 张
    'custom:知鸟ai/grok-imagine-image',
    'grok-imagine-image-2.0',
    'custom:知鸟ai/gpt-image-2',
    'doubao-seedream-5-0',
    'seedream-imagine',
    '',
    null,
    undefined,
  ])('keeps %s off the Midjourney path', (modelId) => {
    expect(isMidjourneyImageModel(modelId as string | null | undefined)).toBe(false);
  });
});

describe('resolveImageCountImages', () => {
  it('converts count slots into real images for Midjourney', () => {
    // 一档 = 一组 = 4 张：实测 n 被忽略、count 才是组数（见 midjourney.ts 注释）
    expect(MIDJOURNEY_IMAGES_PER_GROUP).toBe(4);
    expect(resolveImageCountImages(1, 4)).toBe(4);
    expect(resolveImageCountImages(2, 4)).toBe(8);
    expect(resolveImageCountImages(4, 4)).toBe(16);
  });

  it('defaults to one image per slot', () => {
    expect(resolveImageCountImages(1)).toBe(1);
    expect(resolveImageCountImages(3)).toBe(3);
    expect(resolveImageCountImages(0, 1)).toBe(1);
    expect(resolveImageCountImages(Number.NaN, 4)).toBe(4);
  });
});

describe('Midjourney 模型定义', () => {
  const midjourneyApi: CustomApiProvider = {
    id: 'zn-mj',
    name: '知鸟AI',
    baseUrl: 'https://cuai.token6688.com',
    apiKey: '',
    models: ['mj_imagine', 'gpt-image-2'],
    videoModels: [],
    audioModels: [],
    chatModels: [],
    modelPrices: {},
    createdAt: Date.now(),
    requestMode: 'sync',
    protocol: 'images',
    referenceImageField: 'images',
    referenceImageEncoding: 'auto',
    imageTransport: 'generations_json',
  };

  function withCustomApis<T>(apis: CustomApiProvider[], run: () => T): T {
    const previous = useSettingsStore.getState().customApis;
    useSettingsStore.setState({ customApis: apis });
    try {
      return run();
    } finally {
      useSettingsStore.setState({ customApis: previous });
    }
  }

  it('marks mj_imagine as 4 images per slot and ships its own params', () => {
    withCustomApis([midjourneyApi], () => {
      const model = getImageModel('custom:zn-mj/mj_imagine');
      expect(model.imagesPerCountUnit).toBe(4);
      expect(model.extraParamsSchema?.map((definition) => definition.key)).toEqual([
        'bot_type',
        'version',
        'stylize',
      ]);
      expect(model.defaultExtraParams?.bot_type).toBe('MID_JOURNEY');
      // count 只能按组翻倍，由 gateway 写进 extra_params，不再走 image_count
      expect(model.extraParamsSchema?.some((definition) => definition.key === 'count')).toBe(false);
    });
  });

  it('leaves other image models on the per-image path', () => {
    withCustomApis([midjourneyApi], () => {
      const model = getImageModel('custom:zn-mj/gpt-image-2');
      expect(model.imagesPerCountUnit).toBeUndefined();
      expect(model.extraParamsSchema).toBeUndefined();
    });
  });
});
