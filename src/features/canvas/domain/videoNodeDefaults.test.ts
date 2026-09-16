import { describe, expect, it } from 'vitest';

import type { VideoModelDefinition } from '@/features/canvas/models';

import {
  DEFAULT_VIDEO_NODE_ASPECT_RATIO,
  DEFAULT_VIDEO_NODE_RESOLUTION,
  resolveVideoNodeModelId,
  resolveVideoNodeParams,
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
    expect(
      resolveVideoNodeParams(buildModel(), { aspectRatio: '9:16', resolution: '480p' })
    ).toEqual({ aspectRatio: '9:16', resolution: '480p' });
  });

  it('记忆的宽高比不被当前模型支持时回退模型默认值', () => {
    const model = buildModel({
      aspectRatios: [{ value: '16:9', label: '16:9' }],
      defaultAspectRatio: '16:9',
    });
    expect(
      resolveVideoNodeParams(model, { aspectRatio: '9:16', resolution: null })
    ).toEqual({ aspectRatio: '16:9', resolution: '720p' });
  });

  it('记忆的分辨率不被当前模型支持时回退模型默认值', () => {
    const model = buildModel({ resolutions: [{ value: '720p', label: '720p' }] });
    expect(
      resolveVideoNodeParams(model, { aspectRatio: '9:16', resolution: '4K' })
    ).toEqual({ aspectRatio: '9:16', resolution: '720p' });
  });

  it('无记忆分辨率时用模型首个可选值(模型未声明 defaultResolution)', () => {
    const model = buildModel({
      resolutions: [
        { value: '540p', label: '540p' },
        { value: '1080p', label: '1080p' },
      ],
      defaultResolution: undefined,
    });
    expect(
      resolveVideoNodeParams(model, { aspectRatio: null, resolution: null })
    ).toEqual({ aspectRatio: '16:9', resolution: '540p' });
  });

  it('模型无 resolutions 声明时回退内置兜底值', () => {
    const model = buildModel({ resolutions: undefined, defaultResolution: undefined });
    expect(
      resolveVideoNodeParams(model, { aspectRatio: null, resolution: null })
    ).toEqual({ aspectRatio: '16:9', resolution: '720p' });
  });

  it('模型缺失时全部回退内置兜底值', () => {
    expect(
      resolveVideoNodeParams(undefined, { aspectRatio: '9:16', resolution: '1080p' })
    ).toEqual({
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

describe('resolveVideoNodeModelId', () => {
  const available = (ids: string[]) => (modelId: string) => ids.includes(modelId);

  it('记忆的模型仍存在时沿用', () => {
    expect(resolveVideoNodeModelId('seedance2.5', available(['seedance2.5']), 'veo3.1')).toBe(
      'seedance2.5'
    );
  });

  it('记忆的模型已被删除时回退默认模型', () => {
    expect(resolveVideoNodeModelId('removed-model', available(['veo3.1']), 'veo3.1')).toBe('veo3.1');
  });

  it('无记忆值时用默认模型', () => {
    expect(resolveVideoNodeModelId(null, available(['veo3.1']), 'veo3.1')).toBe('veo3.1');
  });
});
