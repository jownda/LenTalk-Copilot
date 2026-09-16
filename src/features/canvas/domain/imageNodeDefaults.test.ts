import { describe, expect, it } from 'vitest';

import {
  resolveImageModelResolutionOptions,
  type ImageModelDefinition,
} from '@/features/canvas/models';

import {
  DEFAULT_IMAGE_NODE_ASPECT_RATIO,
  DEFAULT_IMAGE_NODE_SIZE,
  resolveImageNodeModelId,
  resolveImageNodeParams,
} from './imageNodeDefaults';

function buildModel(overrides: Partial<ImageModelDefinition> = {}): ImageModelDefinition {
  return {
    id: 'custom:myapi/flux-pro',
    mediaType: 'image',
    displayName: 'MyAPI · flux-pro',
    providerId: 'custom:myapi',
    description: '',
    eta: '1min',
    defaultAspectRatio: '1:1',
    defaultResolution: '2K',
    aspectRatios: [
      { value: '1:1', label: '1:1' },
      { value: '16:9', label: '16:9' },
    ],
    resolutions: [
      { value: '1K', label: '1K' },
      { value: '2K', label: '2K' },
      { value: '4K', label: '4K' },
    ],
    resolveRequest: () => ({ requestModel: 'flux-pro', modeLabel: '生成模式' }),
    ...overrides,
  };
}

describe('resolveImageNodeParams', () => {
  it('沿用记忆值(模型支持时)', () => {
    expect(
      resolveImageNodeParams(buildModel(), { size: '4K', aspectRatio: '16:9' })
    ).toEqual({ size: '4K', aspectRatio: '16:9' });
  });

  it('记忆的分辨率不被当前模型支持时回退到模型档位内的兜底值', () => {
    const model = buildModel({ resolutions: [{ value: '1K', label: '1K' }] });
    // 2K 不在该模型档位内, 必须回退到模型首档, 否则会把越界的 2K 写进节点
    expect(resolveImageNodeParams(model, { size: '4K', aspectRatio: null })).toEqual({
      size: '1K',
      aspectRatio: DEFAULT_IMAGE_NODE_ASPECT_RATIO,
    });
  });

  it('记忆的宽高比不被当前模型支持时回退 auto', () => {
    const model = buildModel({ aspectRatios: [{ value: '1:1', label: '1:1' }] });
    expect(resolveImageNodeParams(model, { size: '2K', aspectRatio: '21:9' })).toEqual({
      size: '2K',
      aspectRatio: 'auto',
    });
  });

  it('记忆的宽高比为 auto 时始终沿用(不受模型画幅列表限制)', () => {
    const model = buildModel({ aspectRatios: [{ value: '1:1', label: '1:1' }] });
    expect(resolveImageNodeParams(model, { size: null, aspectRatio: 'auto' }).aspectRatio).toBe(
      'auto'
    );
  });

  it('无记忆时用历史默认值(2K / auto)', () => {
    expect(resolveImageNodeParams(buildModel(), { size: null, aspectRatio: null })).toEqual({
      size: DEFAULT_IMAGE_NODE_SIZE,
      aspectRatio: DEFAULT_IMAGE_NODE_ASPECT_RATIO,
    });
  });

  it('空串记忆值视同未设置', () => {
    expect(resolveImageNodeParams(buildModel(), { size: '', aspectRatio: '' })).toEqual({
      size: DEFAULT_IMAGE_NODE_SIZE,
      aspectRatio: DEFAULT_IMAGE_NODE_ASPECT_RATIO,
    });
  });

  it('模型声明的动态分辨率优先于静态列表', () => {
    const model = buildModel({
      resolutions: [{ value: '1K', label: '1K' }],
      resolveResolutions: () => [{ value: '8K', label: '8K' }],
    });
    expect(resolveImageNodeParams(model, { size: '8K', aspectRatio: null }).size).toBe('8K');
    // 静态列表里的 1K 此时已不合法, 兜底同样落在动态档位内
    expect(resolveImageNodeParams(model, { size: '1K', aspectRatio: null }).size).toBe('8K');
  });

  it('只出 1K 的模型(名称带 -1k)新建节点时不会带上越界的 2K', () => {
    const model = buildModel({
      resolutions: resolveImageModelResolutionOptions('qwen-image-3.0-pro-1k'),
    });
    expect(model.resolutions.map((option) => option.value)).toEqual(['1K']);
    expect(resolveImageNodeParams(model, { size: null, aspectRatio: null }).size).toBe('1K');
    // 用户上次用的 4K 也不该被沿用
    expect(resolveImageNodeParams(model, { size: '4K', aspectRatio: null }).size).toBe('1K');
  });

  it('模型缺失时全部回退内置兜底值', () => {
    expect(
      resolveImageNodeParams(undefined, { size: '4K', aspectRatio: '16:9' })
    ).toEqual({
      size: DEFAULT_IMAGE_NODE_SIZE,
      aspectRatio: DEFAULT_IMAGE_NODE_ASPECT_RATIO,
    });
  });
});

describe('resolveImageNodeModelId', () => {
  const available = (ids: string[]) => (modelId: string) => ids.includes(modelId);

  it('记忆的模型仍可用时沿用', () => {
    expect(
      resolveImageNodeModelId('custom:myapi/flux-pro', available(['custom:myapi/flux-pro']), 'builtin:default')
    ).toBe('custom:myapi/flux-pro');
  });

  it('记忆的模型已被删除时回退默认模型', () => {
    expect(resolveImageNodeModelId('removed-model', available(['builtin:default']), 'builtin:default')).toBe(
      'builtin:default'
    );
  });

  it('记忆的模型存在但平台未配置密钥时回退默认模型', () => {
    // 调用方把「未配置密钥」表达为不可用
    const notConfigured = () => false;
    expect(resolveImageNodeModelId('custom:myapi/flux-pro', notConfigured, 'builtin:default')).toBe(
      'builtin:default'
    );
  });

  it('无记忆值时用默认模型', () => {
    expect(resolveImageNodeModelId(null, available(['builtin:default']), 'builtin:default')).toBe(
      'builtin:default'
    );
  });
});
