import { describe, expect, it } from 'vitest';

import { listAudioModels, listImageModels, listVideoModels } from './registry';
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
      audioModels: [],
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
      audioModels: [],
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
      videoModels: ['gz-sd720p', 'tj-sp2.5', 'minimax-h3-pro-768p', 'minimax-h3-pro-2k'],
      audioModels: [],
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
      const minimax768 = models.find((model) => model.id.endsWith('/minimax-h3-pro-768p'));
      const minimax2k = models.find((model) => model.id.endsWith('/minimax-h3-pro-2k'));

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
      expect(minimax768?.aspectRatios.map((option) => option.value)).toEqual(['16:9', '9:16']);
      expect(minimax768?.resolutions?.map((option) => option.value)).toEqual(['768P']);
      expect(minimax2k?.resolutions?.map((option) => option.value)).toEqual(['2K']);
      expect(minimax2k?.durationOptions).toEqual(Array.from({ length: 12 }, (_, index) => index + 4));
      expect(resolveModelPriceDisplay(minimax768!, {
        resolution: '768P',
        extraParams: { duration: 10 },
        language: 'zh-CN',
      })?.label).toContain('0.50');
      expect(resolveModelPriceDisplay(minimax2k!, {
        resolution: '2K',
        extraParams: { duration: 10 },
        language: 'zh-CN',
      })?.label).toContain('0.25');
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
      audioModels: [],
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

describe('listAudioModels(字子动画)', () => {
  it('按模型名把音频分成 语音合成 / 音效 / 音乐 三类, 且不混进图片或视频列表', () => {
    const previousCustomApis = useSettingsStore.getState().customApis;
    const zzdh: CustomApiProvider = {
      id: '字子动画',
      name: '字子动画',
      baseUrl: 'https://www.zizidonghua.com',
      apiKey: '',
      models: ['qwen-image-3.0'],
      videoModels: ['zzdh-Minimax-h3-720p'],
      audioModels: [
        'eleven_multilingual_v2',
        'eleven_text_to_sound_v2',
        'eleven_music_v1',
        'indextts2-v1',
      ],
      chatModels: [],
      createdAt: Date.now(),
      requestMode: 'sync',
      protocol: 'images',
      referenceImageField: 'reference_images',
      referenceImageEncoding: 'auto',
      imageTransport: 'auto',
    };

    useSettingsStore.setState({ customApis: [zzdh] });
    try {
      const audioModels = listAudioModels();
      const byModel = (name: string) =>
        audioModels.find((model) => model.id === `custom:字子动画/${name}`);

      expect(byModel('eleven_multilingual_v2')?.audioKind).toBe('speech');
      expect(byModel('indextts2-v1')?.audioKind).toBe('speech');
      expect(byModel('eleven_text_to_sound_v2')?.audioKind).toBe('sound-effects');
      expect(byModel('eleven_music_v1')?.audioKind).toBe('music');

      // 语音合成才有音色/格式; 音乐才有长度选项。
      expect(byModel('eleven_multilingual_v2')?.defaultFormat).toBe('mp3');
      expect(byModel('eleven_music_v1')?.defaultMusicLengthMs).toBe(30000);
      expect(byModel('eleven_multilingual_v2')?.defaultMusicLengthMs).toBeUndefined();

      // 平台对音频按用量比例计费, 没有可按次展示的固定价 —— 宁可不显示, 也不显示错价。
      expect(byModel('eleven_multilingual_v2')?.pricing).toBeUndefined();

      // 音频模型不能同时出现在图片/视频下拉里。
      expect(listImageModels().some((model) => model.id.includes('eleven_'))).toBe(false);
      expect(listVideoModels().some((model) => model.id.includes('eleven_'))).toBe(false);
    } finally {
      useSettingsStore.setState({ customApis: previousCustomApis });
    }
  });
});
