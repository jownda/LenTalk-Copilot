import { describe, expect, it } from 'vitest';

import { listImageModels, listVideoModels } from './registry';
import { resolveModelPriceDisplay } from '@/features/canvas/pricing';
import { isVideoGenerationModelName, useSettingsStore, type CustomApiProvider } from '@/stores/settingsStore';

describe('isVideoGenerationModelName', () => {
  it.each([
    'bh2.0-720p',
    'SD2.5-1080p',
    'rd2.5-720p',
    'wan3.0-720p',
    'gz-sd2.5-480p',
    'sdvip4k',
    'quanneng2.0',
    'tj-sp2.5',
    'video2.0',
    'seedance2.5',
  ])('recognizes %s as a video model', (model) => {
    expect(isVideoGenerationModelName(model)).toBe(true);
  });

  it.each([
    'gemini-3-pro-image-preview',
    'gpt-image-2',
    'sdxl',
    'qwen-image',
  ])('keeps %s out of the video list', (model) => {
    expect(isVideoGenerationModelName(model)).toBe(false);
  });
});

describe('listVideoModels', () => {
  it('locks Sub2API Seedance durations, resolution, and aspect ratios', () => {
    const previousCustomApis = useSettingsStore.getState().customApis;
    const sub2Api: CustomApiProvider = {
      id: 'sub2api-video',
      name: 'Sub2API 视频',
      baseUrl: 'https://video.rjm.us.ci',
      apiKey: '',
      models: [],
      videoModels: ['seedance2.0', 'seedance2.5'],
      chatModels: [],
      createdAt: Date.now(),
      requestMode: 'sync',
      protocol: 'images',
      referenceImageField: 'image',
      referenceImageEncoding: 'data_url',
      imageTransport: 'auto',
    };

    useSettingsStore.setState({ customApis: [sub2Api] });
    try {
      const models = listVideoModels();
      const seedance20 = models.find((model) => model.id.endsWith('/seedance2.0'));
      const seedance25 = models.find((model) => model.id.endsWith('/seedance2.5'));

      expect(seedance20?.displayName).toContain('Seedance 2.0');
      expect(seedance20?.durationOptions).toEqual([15]);
      expect(seedance20?.defaultDuration).toBe(15);
      expect(seedance20?.resolutions?.map((option) => option.value)).toEqual(['480p', '720p', '1080p', '4k']);
      expect(seedance20?.aspectRatios.map((option) => option.value)).toEqual(['16:9', '9:16']);

      expect(seedance25?.displayName).toContain('Seedance 2.5');
      expect(seedance25?.durationOptions).toEqual([30]);
      expect(seedance25?.defaultDuration).toBe(30);
      expect(seedance25?.resolutions?.map((option) => option.value)).toEqual(['480p', '720p']);
      expect(seedance25?.aspectRatios.map((option) => option.value)).toEqual(['16:9', '9:16']);
    } finally {
      useSettingsStore.setState({ customApis: previousCustomApis });
    }
  });

  it('applies the RJM profile and restrictions to a manually added platform URL', () => {
    const previousCustomApis = useSettingsStore.getState().customApis;
    const customRjm: CustomApiProvider = {
      id: 'my-rjm',
      name: '我的 RJM 平台',
      baseUrl: 'https://sub2api.rjm.us.ci/v1',
      apiKey: '',
      models: [],
      videoModels: ['seedance2.5'],
      chatModels: [],
      createdAt: Date.now(),
      requestMode: 'sync',
      protocol: 'images',
      referenceImageField: 'image',
      referenceImageEncoding: 'data_url',
      imageTransport: 'auto',
    };

    useSettingsStore.setState({ customApis: [customRjm] });
    try {
      const model = listVideoModels().find((item) => item.id.endsWith('/seedance2.5'));
      expect(model?.profileId).toBe('sub2api-video');
      expect(model?.durationOptions).toEqual([30]);
      expect(model?.resolutions?.map((option) => option.value)).toEqual(['480p', '720p']);
    } finally {
      useSettingsStore.setState({ customApis: previousCustomApis });
    }
  });

  it('uses 炳火 video constraints and the verified async profile', () => {
    const previousCustomApis = useSettingsStore.getState().customApis;
    const binghuo: CustomApiProvider = {
      id: 'binghuo',
      name: '炳火 API',
      baseUrl: 'https://api.7tai.cc/v1',
      apiKey: '',
      models: [],
      videoModels: ['gz-sd720p', 'tj-sp2.5', 'minimax-h3-pro-768p'],
      chatModels: [],
      createdAt: Date.now(),
      requestMode: 'sync',
      protocol: 'images',
      referenceImageField: 'image',
      referenceImageEncoding: 'url',
      imageTransport: 'generations_json',
    };

    useSettingsStore.setState({ customApis: [binghuo] });
    try {
      const models = listVideoModels();
      const standard = models.find((model) => model.id.endsWith('/gz-sd720p'));
      const fixed = models.find((model) => model.id.endsWith('/tj-sp2.5'));
      const minimax = models.find((model) => model.id.endsWith('/minimax-h3-pro-768p'));

      expect(standard?.durationOptions).toEqual(Array.from({ length: 12 }, (_, index) => index + 4));
      expect(standard?.resolutions?.map((option) => option.value)).toEqual(['720P']);
      expect(standard?.aspectRatios.map((option) => option.value)).toContain('21:9');
      expect(standard?.profileId).toBe('binghuo-video');
      expect(standard?.profileStatus).toBe('verified');
      expect(resolveModelPriceDisplay(standard!, {
        resolution: '720P',
        extraParams: { duration: 5 },
        language: 'zh-CN',
      })?.label).toContain('2.50');
      expect(fixed?.durationOptions).toEqual([30]);
      expect(resolveModelPriceDisplay(fixed!, {
        resolution: '720P',
        extraParams: { duration: 30 },
        language: 'zh-CN',
      })?.label).toContain('3.85');
      expect(minimax?.aspectRatios.map((option) => option.value)).toEqual(['16:9', '9:16']);
    } finally {
      useSettingsStore.setState({ customApis: previousCustomApis });
    }
  });

  it('keeps pulled 炳火 video ids out of image models', () => {
    const previousCustomApis = useSettingsStore.getState().customApis;
    const binghuo: CustomApiProvider = {
      id: 'binghuo-migration',
      name: '炳火 API',
      baseUrl: 'https://api.7tai.cc/v1',
      apiKey: '',
      models: ['bh2.0-720p', 'SD2.5-720p', 'gpt-image-2'],
      videoModels: [],
      chatModels: [],
      createdAt: Date.now(),
      requestMode: 'sync',
      protocol: 'images',
      referenceImageField: 'image',
      referenceImageEncoding: 'url',
      imageTransport: 'generations_json',
    };

    useSettingsStore.setState({ customApis: [binghuo] });
    try {
      const videoModels = listVideoModels();
      const imageModels = listImageModels();
      expect(videoModels.some((model) => model.id.endsWith('/bh2.0-720p'))).toBe(true);
      expect(videoModels.some((model) => model.id.endsWith('/SD2.5-720p'))).toBe(true);
      expect(imageModels.some((model) => model.id.endsWith('/bh2.0-720p'))).toBe(false);
      expect(imageModels.some((model) => model.id.endsWith('/SD2.5-720p'))).toBe(false);
      expect(imageModels.some((model) => model.id.endsWith('/gpt-image-2'))).toBe(true);
    } finally {
      useSettingsStore.setState({ customApis: previousCustomApis });
    }
  });
});
