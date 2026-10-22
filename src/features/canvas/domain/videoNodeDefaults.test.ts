import { describe, expect, it } from 'vitest';

import type { VideoModelDefinition } from '@/features/canvas/models';

import {
  DEFAULT_VIDEO_NODE_ASPECT_RATIO,
  DEFAULT_VIDEO_NODE_RESOLUTION,
  resolveVideoNodeDuration,
  resolveVideoNodeModelId,
  resolveVideoNodeParams,
  snapVideoDurationOption,
} from './videoNodeDefaults';

function buildModel(overrides: Partial<VideoModelDefinition> = {}): VideoModelDefinition {
  return {
    id: 'seedance2.5',
    mediaType: 'video',
    displayName: 'Seedance 2.5',
    providerId: 'jimeng-cli',
    description: '',
    aspectRatios: [
      { value: '16:9', label: '16:9' },
      { value: '9:16', label: '9:16' },
    ],
    defaultAspectRatio: '16:9',
    durationOptions: [5, 10, 15],
    defaultDuration: 5,
    resolutions: [
      { value: '480p', label: '480p' },
      { value: '720p', label: '720p' },
    ],
    defaultResolution: '720p',
    ...overrides,
  };
}

describe('resolveVideoNodeParams', () => {
  it('沿用记忆值(模型支持时)', () => {
    expect(resolveVideoNodeParams(buildModel(), { aspectRatio: '9:16', resolution: '480p' })).toEqual({
      aspectRatio: '9:16',
      resolution: '480p',
    });
  });

  it('记忆的宽高比不被当前模型支持时回退模型默认值', () => {
    const model = buildModel({
      aspectRatios: [{ value: '16:9', label: '16:9' }],
      defaultAspectRatio: '16:9',
    });
    expect(resolveVideoNodeParams(model, { aspectRatio: '9:16', resolution: null })).toEqual({
      aspectRatio: '16:9',
      resolution: '720p',
    });
  });

  it('记忆的分辨率不被当前模型支持时回退模型默认值', () => {
    const model = buildModel({ resolutions: [{ value: '720p', label: '720p' }] });
    expect(resolveVideoNodeParams(model, { aspectRatio: '9:16', resolution: '4K' })).toEqual({
      aspectRatio: '9:16',
      resolution: '720p',
    });
  });

  it('无记忆分辨率时用模型首个可选值(模型未声明 defaultResolution)', () => {
    const model = buildModel({
      resolutions: [
        { value: '540p', label: '540p' },
        { value: '1080p', label: '1080p' },
      ],
      defaultResolution: undefined,
    });
    expect(resolveVideoNodeParams(model, { aspectRatio: null, resolution: null })).toEqual({
      aspectRatio: '16:9',
      resolution: '540p',
    });
  });

  it('模型无 resolutions 声明时回退内置兜底值', () => {
    const model = buildModel({ resolutions: undefined, defaultResolution: undefined });
    expect(resolveVideoNodeParams(model, { aspectRatio: null, resolution: null })).toEqual({
      aspectRatio: '16:9',
      resolution: '720p',
    });
  });

  it('模型缺失时全部回退内置兜底值', () => {
    expect(resolveVideoNodeParams(undefined, { aspectRatio: '9:16', resolution: '1080p' })).toEqual({
      aspectRatio: DEFAULT_VIDEO_NODE_ASPECT_RATIO,
      resolution: DEFAULT_VIDEO_NODE_RESOLUTION,
    });
  });

  it('空串记忆值视同未设置', () => {
    expect(resolveVideoNodeParams(buildModel(), { aspectRatio: '', resolution: '' })).toEqual({
      aspectRatio: '16:9',
      resolution: '720p',
    });
  });
});

describe('snapVideoDurationOption', () => {
  it('连续档位直接夹取', () => {
    expect(snapVideoDurationOption([4, 5, 6, 7, 8], 99)).toBe(8);
    expect(snapVideoDurationOption([4, 5, 6, 7, 8], 1)).toBe(4);
    expect(snapVideoDurationOption([4, 5, 6, 7, 8], 6.4)).toBe(6);
  });

  it('离散档位取最近合法档（5/10/15/30 这类稀疏枚举）', () => {
    const options = [5, 10, 15, 30];
    expect(snapVideoDurationOption(options, 17)).toBe(15);
    expect(snapVideoDurationOption(options, 23)).toBe(30);
    expect(snapVideoDurationOption(options, 8)).toBe(10);
  });

  it('无档位声明时原样返回', () => {
    expect(snapVideoDurationOption([], 12)).toBe(12);
  });
});

describe('resolveVideoNodeDuration', () => {
  it('模型声明 defaultDuration 时优先用它（可灵 v4 默认 30s）', () => {
    const klingV4 = buildModel({ id: 'kling-v4', durationOptions: [5, 10, 15, 30], defaultDuration: 30 });
    expect(resolveVideoNodeDuration(klingV4, 5)).toBe(30);
    expect(resolveVideoNodeDuration(klingV4, null)).toBe(30);
  });

  it('没声明 defaultDuration 时沿用记忆值，但要吸附到合法档', () => {
    const seedance = buildModel({ durationOptions: [4, 5, 6, 8, 10, 12, 15, 20, 25, 30], defaultDuration: 5 });
    expect(resolveVideoNodeDuration(seedance, 17)).toBe(15);
    expect(resolveVideoNodeDuration(seedance, 10)).toBe(10);
  });

  it('记忆值缺失时用模型首个档位', () => {
    const model = buildModel({ durationOptions: [4, 6, 8], defaultDuration: undefined });
    expect(resolveVideoNodeDuration(model, undefined)).toBe(4);
  });

  it('模型缺失时不改时长', () => {
    expect(resolveVideoNodeDuration(undefined, 12)).toBeUndefined();
  });
});

describe('resolveVideoNodeModelId', () => {
  const available = (ids: string[]) => (modelId: string) => ids.includes(modelId);

  it('记忆的模型仍存在时沿用', () => {
    expect(resolveVideoNodeModelId('seedance2.5', available(['seedance2.5']), 'veo3.1')).toBe('seedance2.5');
  });

  it('记忆的模型已被删除时回退默认模型', () => {
    expect(resolveVideoNodeModelId('removed-model', available(['veo3.1']), 'veo3.1')).toBe('veo3.1');
  });

  it('无记忆值时用默认模型', () => {
    expect(resolveVideoNodeModelId(null, available(['veo3.1']), 'veo3.1')).toBe('veo3.1');
  });
});
