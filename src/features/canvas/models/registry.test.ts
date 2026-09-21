import { describe, expect, it } from 'vitest';

import {
  JIMENG_CLI_IMAGE_UPSCALE_MODEL_ID,
  JIMENG_CLI_PROVIDER_ID,
  getImageModel,
  isApiKeylessProvider,
  listAudioModels,
  matchesAudioCreativePanel,
  listImageModels,
  listImageUpscaleModels,
  listVideoModels,
} from './registry';
import { JIMENG_CLI_IMAGE_UPSCALE_MODEL } from '@/commands/ai';
import { resolveModelPriceDisplay } from '@/features/canvas/pricing';
import { isVideoGenerationModelName, useSettingsStore, type CustomApiProvider } from '@/stores/settingsStore';
import { recommendedApis, type RecommendedApi } from '@/features/settings/recommendedApis';
import type { AudioCreativePanel } from './types';

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
  it('uses synced official prices for custom image/video models', () => {
    const previousCustomApis = useSettingsStore.getState().customApis;
    const frame = {
      id: 'zhenjian',
      name: '帧间 API',
      baseUrl: 'https://www.zhenjian.work',
      apiKey: '',
      models: ['image-model'],
      videoModels: ['video-model'],
      audioModels: [],
      chatModels: [],
      modelPrices: { 'image-model': 0.24, 'video-model': 1.5 },
      createdAt: Date.now(),
      requestMode: 'sync' as const,
      protocol: 'images' as const,
      referenceImageField: 'image' as const,
      referenceImageEncoding: 'auto' as const,
      imageTransport: 'generations_json' as const,
    } satisfies CustomApiProvider;

    useSettingsStore.setState({ customApis: [frame] });
    try {
      const image = listImageModels().find((model) => model.id.endsWith('/image-model'));
      const video = listVideoModels().find((model) => model.id.endsWith('/video-model'));
      expect(resolveModelPriceDisplay(image!, {
        resolution: '1K',
        language: 'zh-CN',
      })?.label).toContain('0.24');
      expect(resolveModelPriceDisplay(video!, {
        resolution: '720p',
        extraParams: { duration: 5 },
        language: 'zh-CN',
      })?.label).toContain('1.50');
    } finally {
      useSettingsStore.setState({ customApis: previousCustomApis });
    }
  });

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

describe('字字动画对口型模型', () => {
  it('旧版平台配置即使没保存这两个模型，也会在动作控制节点候选中补出', () => {
    const previousCustomApis = useSettingsStore.getState().customApis;
    const zzdh: CustomApiProvider = {
      id: '字字动画',
      name: '字字动画',
      baseUrl: 'https://www.zizidonghua.com',
      apiKey: '',
      models: [],
      videoModels: ['zzdh-Minimax-h3-720p'],
      audioModels: [],
      chatModels: [],
      createdAt: Date.now(),
      requestMode: 'async',
      protocol: 'images',
      referenceImageField: 'reference_images',
      referenceImageEncoding: 'url',
      imageTransport: 'generations_json',
    };

    useSettingsStore.setState({ customApis: [zzdh] });
    try {
      const ids = listVideoModels().map((model) => model.id);
      expect(ids).toContain('custom:字字动画/zzdh-minimax-h3-限时优惠-对口型-480p');
      expect(ids).toContain('custom:字字动画/zzdh-minimax-h3-限时优惠-对口型-768p');
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

/**
 * 音频节点四个创作面板的归属(音色克隆 / 音色设计 / 2.8 配音 / 音乐创作)。
 *
 * 这一层埋过三次坑, 每次都是「模型名认错 -> 模型整个消失或语义错」:
 *  1. 一度所有模型都能进任何面板(切供应商看不出变化);
 *  2. 修完又变成「名字里没有 clone 的克隆模型列不出来」;
 *  3. 2026-09-20 反向修正 —— 为了救 (2) 把 `speech[-_]?\d` 塞进了克隆标记, 结果把
 *     **消费端** `speech-2.8` 也拖进了克隆页。它的 param_schema 里没有任何参考样音
 *     字段, 用户传完样音平台静默忽略, 表现是「克隆了但声音没变」。
 *
 * 现在的分工(见 docs/api_docs/ZhiniaoAI_MiniMax_Voice_Chain.md):
 *   voice-clone  → 音色克隆页(上传样音建音色)
 *   voice-design → 音色设计页(文字描述建音色)
 *   speech-2.8   → 2.8 配音页(用 voice_id 合成)
 */
describe('listAudioModels: 创作面板归属', () => {
  const AUDIO_PANELS: AudioCreativePanel[] = ['voice-clone', 'voice-design', 'speech', 'music'];

  const toCustomApi = (api: RecommendedApi, audioModels: string[]): CustomApiProvider => ({
    id: api.id,
    name: api.name,
    baseUrl: api.baseUrl,
    apiKey: '',
    models: api.models ?? [],
    videoModels: api.videoModels ?? [],
    audioModels,
    chatModels: api.chatModels ?? [],
    createdAt: Date.now(),
    requestMode: 'sync',
    protocol: 'images',
    referenceImageField: 'image',
    referenceImageEncoding: 'auto',
    imageTransport: 'auto',
  });

  const withCustomApis = <T>(apis: CustomApiProvider[], run: () => T): T => {
    const previous = useSettingsStore.getState().customApis;
    useSettingsStore.setState({ customApis: apis });
    try {
      return run();
    } finally {
      useSettingsStore.setState({ customApis: previous });
    }
  };

  /** 某个模型会出现在哪些面板上(顺序同 AUDIO_PANELS)。 */
  const panelsOf = (apiId: string, model: string): AudioCreativePanel[] => {
    const definition = listAudioModels().find(
      (item) => item.id === `custom:${apiId}/${model}`,
    );
    if (!definition) throw new Error(`音频模型未注册: ${apiId}/${model}`);
    return AUDIO_PANELS.filter((panel) => matchesAudioCreativePanel(definition, panel));
  };

  const zhiniao = recommendedApis.find((api) => api.id === 'zhiniao');

  it('知鸟AI: MiniMax 三件套各归各页, Suno music 只进「音乐创作」', () => {
    expect(zhiniao).toBeTruthy();
    const models = zhiniao?.audioModels ?? [];
    withCustomApis([toCustomApi(zhiniao as RecommendedApi, models)], () => {
      const apiId = (zhiniao as RecommendedApi).id;

      // 建音色的两个入口各自独立: 克隆吃样音, 设计吃文字描述。
      expect(panelsOf(apiId, 'voice-clone')).toEqual(['voice-clone']);
      expect(panelsOf(apiId, 'voice-design')).toEqual(['voice-design']);
      // speech-2.8 是消费端(只吃 voice_id), 绝不能出现在克隆页 ——
      // 它没有参考样音字段, 混进去就是「传了样音但声音没变」。
      expect(panelsOf(apiId, 'speech-2.8')).toEqual(['speech']);
      // 音乐模型必须离开「2.8 配音」, 否则语音页会混进 Suno。
      expect(panelsOf(apiId, 'music')).toEqual(['music']);
      expect(panelsOf(apiId, 'gemini-2.5-pro-tts')).toEqual(['speech']);
      expect(panelsOf(apiId, 'tts-1')).toEqual(['speech']);
    });
  });

  it('字子动画: 音乐模型只进「音乐创作」, 音效模型不会从所有面板消失', () => {
    const zzdh = recommendedApis.find((api) => api.id === 'zizidonghua');
    expect(zzdh).toBeTruthy();
    const models = zzdh?.audioModels ?? [];
    withCustomApis([toCustomApi(zzdh as RecommendedApi, models)], () => {
      const apiId = (zzdh as RecommendedApi).id;

      expect(panelsOf(apiId, 'eleven_music_v2')).toEqual(['music']);
      // eleven 系既能克隆也能直接合成(有内置音色), 两个页面都该有它。
      expect(panelsOf(apiId, 'eleven_multilingual_v2')).toEqual(['voice-clone', 'speech']);
      // 节点没有「音效」页: 音效模型必须仍然落在某个面板里。
      expect(panelsOf(apiId, 'eleven_text_to_sound_v2')).toEqual(['voice-clone']);
    });
  });

  it('推荐平台预置的音频模型都能落在至少一个面板(不会凭空消失)', () => {
    const presets = recommendedApis.filter((api) => (api.audioModels ?? []).length > 0);
    expect(presets.length).toBeGreaterThan(0);

    withCustomApis(
      presets.map((api) => toCustomApi(api, api.audioModels ?? [])),
      () => {
        for (const api of presets) {
          for (const model of api.audioModels ?? []) {
            expect(panelsOf(api.id, model).length, `${api.id}/${model}`).toBeGreaterThan(0);
          }
        }
      },
    );
  });
});

describe('即梦 CLI 图片模型', () => {
  const jimengModels = () =>
    listImageModels().filter((model) => model.providerId === JIMENG_CLI_PROVIDER_ID);

  it('在图片列表里注册 9 个版本, 且属于无密钥平台', () => {
    expect(jimengModels().map((model) => model.id)).toEqual([
      'jimeng-cli/image-5.0Pro',
      'jimeng-cli/image-5.0',
      'jimeng-cli/image-4.7',
      'jimeng-cli/image-4.6',
      'jimeng-cli/image-4.5',
      'jimeng-cli/image-4.1',
      'jimeng-cli/image-4.0',
      'jimeng-cli/image-3.1',
      'jimeng-cli/image-3.0',
    ]);
    // 没有 API Key 可填 —— 图片模型选择器要靠它绕过"填过密钥"的过滤。
    expect(isApiKeylessProvider(JIMENG_CLI_PROVIDER_ID)).toBe(true);
    expect(isApiKeylessProvider('openai')).toBe(false);
  });

  it('档位与 CLI 校验一致: 3.x 只有 1K/2K, 4.x~5.0 是 2K/4K, 5.0Pro 多一档 1.5K', () => {
    const tiersOf = (version: string) =>
      jimengModels().find((model) => model.id === `jimeng-cli/image-${version}`)!
        .resolutions.map((option) => option.value);

    expect(tiersOf('3.0')).toEqual(['1K', '2K']);
    expect(tiersOf('3.1')).toEqual(['1K', '2K']);
    expect(tiersOf('4.0')).toEqual(['2K', '4K']);
    expect(tiersOf('4.5')).toEqual(['2K', '4K']);
    expect(tiersOf('4.7')).toEqual(['2K', '4K']);
    expect(tiersOf('5.0')).toEqual(['2K', '4K']);
    expect(tiersOf('5.0Pro')).toEqual(['1.5K', '2K', '4K']);
  });

  it('画幅用 CLI 的 8 档枚举, 不含自定义平台的 5:4 / 4:5', () => {
    const model = jimengModels()[0]!;
    expect(model.aspectRatios.map((option) => option.value)).toEqual([
      '21:9',
      '16:9',
      '3:2',
      '4:3',
      '1:1',
      '3:4',
      '2:3',
      '9:16',
    ]);
    expect(model.defaultAspectRatio).toBe('1:1');
    // 默认档位取该版本的首档, 保证默认值一定被 CLI 接受。
    expect(model.defaultResolution).toBe('1.5K');
    expect(jimengModels().find((item) => item.id === 'jimeng-cli/image-3.0')?.defaultResolution)
      .toBe('1K');
  });

  it('有参考图时走编辑模式, 无参考图走生成模式', () => {
    const model = jimengModels().find((item) => item.id === 'jimeng-cli/image-5.0')!;
    expect(model.resolveRequest({ referenceImageCount: 0 })).toEqual({
      requestModel: 'jimeng-cli/image-5.0',
      modeLabel: '生成模式',
    });
    expect(model.resolveRequest({ referenceImageCount: 2 })).toEqual({
      requestModel: 'jimeng-cli/image-5.0',
      modeLabel: '编辑模式',
    });
  });

  it('getImageModel 能反查即梦模型, 不会兜底成内置模型', () => {
    // 回归防护: 即梦模型不参与 imageModelMap 构建, 漏了专门分支时重开工程会解析错。
    const resolved = getImageModel('jimeng-cli/image-5.0Pro');
    expect(resolved.id).toBe('jimeng-cli/image-5.0Pro');
    expect(resolved.providerId).toBe(JIMENG_CLI_PROVIDER_ID);
    expect(resolved.displayName).toContain('即梦 CLI');
    expect(resolved.resolutions.map((option) => option.value)).toEqual(['1.5K', '2K', '4K']);
  });
});

describe('图片超清', () => {
  it('超清模型 id 与 commands/ai.ts 的常量保持一致', () => {
    // 两处字符串必须相等, 否则「图片高清」提交的 job 会落回普通图片链路。
    expect(JIMENG_CLI_IMAGE_UPSCALE_MODEL_ID).toBe(JIMENG_CLI_IMAGE_UPSCALE_MODEL);
  });

  it('超清模型不进图片下拉, 但 getImageModel 能解析出定义(记账要用)', () => {
    expect(listImageModels().some((model) => model.id === JIMENG_CLI_IMAGE_UPSCALE_MODEL_ID))
      .toBe(false);

    const resolved = getImageModel(JIMENG_CLI_IMAGE_UPSCALE_MODEL_ID);
    expect(resolved.id).toBe(JIMENG_CLI_IMAGE_UPSCALE_MODEL_ID);
    expect(resolved.providerId).toBe(JIMENG_CLI_PROVIDER_ID);
    expect(resolved.resolutions.map((option) => option.value)).toEqual(['2K', '4K', '8K']);
    // 本机 CLI 不按次计费, 没有定价才不会在用量里算出假费用。
    expect(resolved.pricing).toBeUndefined();
  });

  it('候选列表目前只有内置的即梦超清, 中转站模型暂不并入', () => {
    const previousCustomApis = useSettingsStore.getState().customApis;
    const relay: CustomApiProvider = {
      id: 'relay-hub',
      name: '中转站',
      baseUrl: 'https://relay.example.com/v1',
      apiKey: '',
      models: ['real-esrgan-upscale'],
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

    useSettingsStore.setState({ customApis: [relay] });
    try {
      const models = listImageUpscaleModels();
      // 用户要求先不放中转站模型: 放开时这里会失败, 提醒同步改测试与文案。
      expect(models.map((model) => model.id)).toEqual([JIMENG_CLI_IMAGE_UPSCALE_MODEL_ID]);
      expect(models.some((model) => model.id.startsWith('custom:'))).toBe(false);
    } finally {
      useSettingsStore.setState({ customApis: previousCustomApis });
    }
  });
});
