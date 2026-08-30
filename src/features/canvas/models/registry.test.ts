import { describe, expect, it } from 'vitest';

import { listVideoModels } from './registry';
import { useSettingsStore, type CustomApiProvider } from '@/stores/settingsStore';

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
      expect(seedance20?.resolutions?.map((option) => option.value)).toEqual(['720p']);
      expect(seedance20?.aspectRatios.map((option) => option.value)).toEqual(['16:9', '9:16']);

      expect(seedance25?.displayName).toContain('Seedance 2.5');
      expect(seedance25?.durationOptions).toEqual([30]);
      expect(seedance25?.defaultDuration).toBe(30);
      expect(seedance25?.resolutions?.map((option) => option.value)).toEqual(['720p']);
      expect(seedance25?.aspectRatios.map((option) => option.value)).toEqual(['16:9', '9:16']);
    } finally {
      useSettingsStore.setState({ customApis: previousCustomApis });
    }
  });
});
