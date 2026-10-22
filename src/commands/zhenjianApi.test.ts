import { describe, expect, it } from 'vitest';

import {
  buildZhenjianImageBody,
  buildZhenjianVideoBody,
  createZhenjianIdempotencyKey,
  extractZhenjianModels,
  isZhenjianProvider,
  resolveZhenjianResultUrl,
} from './zhenjianApi';

describe('zhenjianApi', () => {
  it('识别官方域名和手动命名的平台', () => {
    expect(isZhenjianProvider('zhenjian', 'https://example.com')).toBe(true);
    expect(isZhenjianProvider('my-relay', 'https://www.zhenjian.work/v1')).toBe(true);
    expect(isZhenjianProvider('other', 'https://example.com')).toBe(false);
  });

  it('构造帧间图片/视频任务字段', () => {
    expect(buildZhenjianImageBody({
      model: 'flux-image',
      prompt: 'sunset',
      size: '2K',
      aspect_ratio: '16:9',
    }, ['asset_1'])).toEqual({
      model: 'flux-image',
      prompt: 'sunset',
      resolution: '2K',
      ratio: '16:9',
      assets: ['asset_1'],
    });
    expect(buildZhenjianVideoBody({
      model: 'video-model',
      prompt: 'camera move',
      duration: 5,
      aspect_ratio: '9:16',
      video_resolution: '720p',
    }, ['asset_1'])).toMatchObject({
      model: 'video-model',
      resolution: '720p',
      seconds: 5,
      ratio: '9:16',
      assets: ['asset_1'],
    });
  });

  it('将任务结果相对路径解析到站点根地址', () => {
    expect(resolveZhenjianResultUrl(
      'https://www.zhenjian.work/v1',
      '/v1/tasks/task-1/video?download=1',
      'task-1',
      'video',
    )).toBe('https://www.zhenjian.work/v1/tasks/task-1/video?download=1');
    expect(resolveZhenjianResultUrl(
      'https://www.zhenjian.work',
      '',
      'task-1',
      'image',
    )).toBe('https://www.zhenjian.work/v1/tasks/task-1/image/0?download=1');
  });

  it('生成符合平台约束的幂等键', () => {
    const key = createZhenjianIdempotencyKey('帧间模型');
    expect(key.length).toBeGreaterThanOrEqual(16);
    expect(key.length).toBeLessThanOrEqual(100);
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('读取 models 返回的 rates 并转换为人民币元', () => {
    expect(extractZhenjianModels({
      data: [
        { id: 'image-model', rates: 24 },
        { id: 'video-model', rates: { price: 150 } },
      ],
    })).toEqual({
      models: ['image-model', 'video-model'],
      prices: { 'image-model': 0.24, 'video-model': 1.5 },
    });
  });

  it('兼容以模型名为 key 的价格表结构', () => {
    expect(extractZhenjianModels({
      models: {
        'image-model': { rates: { per_call: '24 分' } },
      },
    })).toEqual({
      models: ['image-model'],
      prices: { 'image-model': 0.24 },
    });
  });
});
