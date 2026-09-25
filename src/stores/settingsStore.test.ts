import { describe, expect, it } from 'vitest';

import {
  isAudioModelName,
  isChatCompletionModelName,
  isVideoGenerationModelName,
  useSettingsStore,
} from './settingsStore';
import { RUNNINGHUB_VIDEO_ENDPOINTS } from '@/commands/runningHubProtocol';

describe('isAudioModelName', () => {
  it('识别 TTS / 语音克隆 / 音乐生成模型', () => {
    for (const model of [
      'tts-1',
      'tts-1-hd',
      'gpt-4o-mini-tts',
      'speech-2.8',
      'voice-clone',
      'voice-design',
      'music',
      'suno-v4',
      'elevenlabs-tts',
      'qwen-audio',
      'gpt-4o-audio-preview',
      // 与知鸟 AI 音频清单一致
      'gemini-3.1-flash-tts',
      'gemini-2.5-pro-tts',
    ]) {
      expect(isAudioModelName(model), model).toBe(true);
    }
  });

  it('不把图片模型判成音频', () => {
    for (const model of [
      'gpt-image-2',
      'gpt-image-2.5-sunburst',
      'nano-banana',
      'gemini-3.1-flash-image',
      'doubao-seedream-4-5',
      'flux-2',
      'wan2.7-image',
      'qwen-image-3.0',
    ]) {
      expect(isAudioModelName(model), model).toBe(false);
    }
  });

  it('视频模型优先归类为视频, 不被名称里的 audio 抢走', () => {
    const model = 'kling-3.0-omni-720p-ref-audio';
    expect(isVideoGenerationModelName(model)).toBe(true);
    expect(isAudioModelName(model)).toBe(false);
  });

  it('空值与普通文本返回 false', () => {
    expect(isAudioModelName('')).toBe(false);
    expect(isAudioModelName('   ')).toBe(false);
    expect(isAudioModelName('gpt-5.5')).toBe(false);
  });
});

describe('isChatCompletionModelName 与音频模型互斥', () => {
  it('带 tts/audio 的模型不会被当成 Chat LLM', () => {
    expect(isChatCompletionModelName('gemini-3.1-flash-tts')).toBe(false);
    expect(isChatCompletionModelName('qwen-audio')).toBe(false);
    expect(isChatCompletionModelName('gpt-4o-mini-tts')).toBe(false);
  });

  it('普通语言模型仍然判定为 Chat', () => {
    expect(isChatCompletionModelName('gemini-3.1-pro')).toBe(true);
    expect(isChatCompletionModelName('deepseek-v4-pro')).toBe(true);
  });
});

describe('图片模型不被视频厂商前缀抢走（拉取模型的分类回归）', () => {
  // 这几条实测来自知鸟 AI 的 /v1/models：kling-image-o3 曾被当成视频，
  // 用户在「图片模型」弹窗里根本选不到它。
  it.each(['kling-image-o3', 'wan2.7-image', 'grok-imagine-image', 'grok-imagine-image-2.0'])(
    '%s 是图片而不是视频',
    (model) => {
      expect(isVideoGenerationModelName(model)).toBe(false);
      expect(isAudioModelName(model)).toBe(false);
      expect(isChatCompletionModelName(model)).toBe(false);
    }
  );

  it('带 video / i2v 硬标记时不会被 image 前缀救回来', () => {
    for (const model of [
      'doubao-seedance-2-video-720p',
      'wan2.7-video',
      'wan2.7-i2v',
      'happyhorse-1.0-video-edit-1080p',
      'kling-v3-motion-control',
      'grok-imagine-video',
    ]) {
      expect(isVideoGenerationModelName(model), model).toBe(true);
    }
  });

  it('名字里没有 video/t2v 的视频型号也要认出来', () => {
    // 旧实现把它们留在图片清单里，图片节点下拉会混进视频模型。
    for (const model of ['happyhorse-1-0', 'happyhorse-1-1', 'omni-flash-1-1', 'viduq3', 'wan-2-6', 'wan-3-0']) {
      expect(isVideoGenerationModelName(model), model).toBe(true);
    }
  });
});

describe('启动时同步推荐预设的视频模型', () => {
  // 用意：平台一旦被添加, 它的模型列表就与预设脱钩了 —— 预设后来新增的端点
  // (如 RunningHub 的 Seedance 2.5)老用户根本看不到。这里验证补差集的完整行为,
  // 特别是 `presetVideoModelsRevision` 必须能穿过 normalizeCustomApis 存活下来
  // (它是唯一一个「丢了就出 bug」的字段: 丢了会让用户删掉的端点反复复活)。
  const presetEndpointIds = RUNNINGHUB_VIDEO_ENDPOINTS.map((item) => item.endpoint);

  function seedRunningHub(videoModels: string[], revision?: number) {
    useSettingsStore.setState({
      customApis: [
        {
          id: 'runninghub-国内版',
          name: 'RunningHub 国内版',
          baseUrl: 'https://www.runninghub.cn',
          apiKey: '',
          models: [],
          videoModels,
          audioModels: [],
          chatModels: [],
          createdAt: 0,
          requestMode: 'sync',
          protocol: 'images',
          referenceImageField: 'image',
          referenceImageEncoding: 'auto',
          imageTransport: 'auto',
          ...(revision === undefined ? {} : { presetVideoModelsRevision: revision }),
        },
      ],
    });
  }

  function currentApi() {
    return useSettingsStore.getState().customApis[0];
  }

  it('老配置(缺 bytedance/* 且无 revision)能补齐新增端点, 顺序追加在末尾', () => {
    const legacy = presetEndpointIds.filter((id) => !id.startsWith('bytedance/'));
    const added = presetEndpointIds.filter((id) => id.startsWith('bytedance/'));
    seedRunningHub(legacy);
    useSettingsStore.getState().syncRecommendedVideoModels();
    // **追加**而不是按预设顺序重排 —— 用户可能已经按自己的习惯调过顺序。
    expect(currentApi().videoModels).toEqual([...legacy, ...added]);
    expect(currentApi().presetVideoModelsRevision).toBe(3);
  });

  it('对齐之后再跑是 no-op —— 用户删掉的预设端点不会复活', () => {
    const trimmed = presetEndpointIds.filter((id) => !id.includes('hailuo'));
    seedRunningHub(trimmed, 3);
    useSettingsStore.getState().syncRecommendedVideoModels();
    expect(currentApi().videoModels).toEqual(trimmed);
    expect(currentApi().presetVideoModelsRevision).toBe(3);
  });

  it('用户手加的端点被保留, 不受差集影响', () => {
    const legacy = presetEndpointIds.filter((id) => !id.startsWith('bytedance/'));
    seedRunningHub([...legacy, 'my-own/private-endpoint']);
    useSettingsStore.getState().syncRecommendedVideoModels();
    const models = currentApi().videoModels;
    expect(models).toContain('my-own/private-endpoint');
    expect(models).toHaveLength(presetEndpointIds.length + 1);
  });

  it('与预设无关的平台原样不动', () => {
    seedRunningHub([]);
    useSettingsStore.setState({
      customApis: [
        {
          ...currentApi(),
          id: 'my-gateway',
          name: '我的中转站',
          baseUrl: 'https://api.example.com/v1',
          videoModels: ['veo3'],
        },
      ],
    });
    useSettingsStore.getState().syncRecommendedVideoModels();
    expect(currentApi().videoModels).toEqual(['veo3']);
    expect(currentApi().presetVideoModelsRevision).toBeUndefined();
  });
});
