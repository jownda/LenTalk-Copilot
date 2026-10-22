import { describe, expect, it } from 'vitest';

import {
  RUNNINGHUB_VIDEO_ENDPOINTS,
  RUNNINGHUB_VIDEO_TRANSPORT,
  buildRunningHubRequestBody,
  isRunningHubBaseUrl,
  isRunningHubVideoEndpoint,
  resolveRunningHubAspectRatioOptions,
  resolveRunningHubDurationOptions,
  resolveRunningHubResolutionOptions,
  resolveRunningHubVideoEndpoint,
  resolveRunningHubVideoDisplayName,
  runningHubVideoExtraParams,
  collapseRunningHubVideoModels,
  isRunningHubDedicatedVideoEndpoint,
  resolveRunningHubVideoEndpointForInput,
  resolveRunningHubVideoFamily,
  snapRunningHubDuration,
  snapRunningHubRatio,
  snapRunningHubResolution,
} from './runningHubProtocol';

describe('平台识别', () => {
  it('认 .cn 与 .ai 两个站点, 带不带协议都行', () => {
    expect(isRunningHubBaseUrl('https://www.runninghub.cn')).toBe(true);
    expect(isRunningHubBaseUrl('https://www.runninghub.ai')).toBe(true);
    expect(isRunningHubBaseUrl('RUNNINGHUB.CN')).toBe(true);
    expect(isRunningHubBaseUrl('  https://www.runninghub.cn/  ')).toBe(true);
  });

  it('不误伤别的平台', () => {
    expect(isRunningHubBaseUrl('https://api.7tai.cc')).toBe(false);
    expect(isRunningHubBaseUrl('https://www.runninghub.cn.evil.com')).toBe(false);
    expect(isRunningHubBaseUrl('')).toBe(false);
    expect(isRunningHubBaseUrl(undefined)).toBe(false);
  });

  it('transport 名与后端常量一致', () => {
    expect(RUNNINGHUB_VIDEO_TRANSPORT).toBe('runninghub-model');
  });
});

describe('端点解析', () => {
  it('端点 ID 含两层斜杠也能整串命中', () => {
    expect(resolveRunningHubVideoEndpoint('rhart-video/sparkvideo-2.0/image-to-video')?.task).toBe(
      'image-to-video',
    );
    expect(resolveRunningHubVideoEndpoint('minimax/hailuo-02/t2v-pro')?.task).toBe('text-to-video');
    expect(resolveRunningHubVideoEndpoint('alibaba/wan-2.7/image-to-video')?.task).toBe(
      'image-to-video',
    );
  });

  it('大小写与空白容错', () => {
    expect(resolveRunningHubVideoEndpoint('  KLING-V3.0-PRO/text-to-video ')?.endpoint).toBe(
      'kling-v3.0-pro/text-to-video',
    );
  });

  it('展示名去掉文生/图生等端点动作后缀', () => {
    expect(resolveRunningHubVideoDisplayName('kling-v3.0-pro/text-to-video')).toBe('可灵3.0 pro');
    expect(resolveRunningHubVideoDisplayName('bytedance/seedance-2.5-token/multimodal-video')).toBe(
      'Seedance 2.5 Token 计费',
    );
  });

  it('未知端点返回 undefined, 不按前缀宽松命中', () => {
    expect(resolveRunningHubVideoEndpoint('kling-v3.0-pro')).toBeUndefined();
    expect(resolveRunningHubVideoEndpoint('nano-banana')).toBeUndefined();
    expect(isRunningHubVideoEndpoint('nano-banana')).toBe(false);
  });

  it('同一模型家族按输入类型选择文生/图生/多模态端点', () => {
    expect(resolveRunningHubVideoFamily('bytedance/seedance-2.5-token/text-to-video')).toBe(
      'bytedance/seedance-2.5-token',
    );
    expect(resolveRunningHubVideoEndpointForInput('bytedance/seedance-2.5-token/text-to-video', 'text')).toBe(
      'bytedance/seedance-2.5-token/text-to-video',
    );
    expect(resolveRunningHubVideoEndpointForInput('bytedance/seedance-2.5-token/text-to-video', 'image')).toBe(
      'bytedance/seedance-2.5-token/image-to-video',
    );
    expect(resolveRunningHubVideoEndpointForInput('bytedance/seedance-2.5-token/text-to-video', 'multimodal')).toBe(
      'bytedance/seedance-2.5-token/multimodal-video',
    );
    expect(resolveRunningHubVideoEndpointForInput('minimax/hailuo-h3/text-to-video', 'text')).toBe(
      'minimax/hailuo-h3/text-to-video',
    );
    expect(resolveRunningHubVideoEndpointForInput('minimax/hailuo-h3/text-to-video', 'image')).toBe(
      'minimax/hailuo-h3/image-to-video',
    );
    expect(resolveRunningHubVideoEndpointForInput('minimax/hailuo-h3/text-to-video', 'first-last')).toBe(
      'minimax/hailuo-h3/image-to-video',
    );
    expect(resolveRunningHubVideoEndpointForInput('minimax/hailuo-h3/text-to-video', 'multimodal')).toBe(
      'minimax/hailuo-h3/multimodal-to-video',
    );
  });

  it('首尾帧只选择声明首尾字段的图生端点', () => {
    expect(resolveRunningHubVideoEndpointForInput('rhart-video/sparkvideo-2.0-mini/text-to-video', 'first-last')).toBe(
      'rhart-video/sparkvideo-2.0-mini/image-to-video',
    );
  });

  it('普通视频模型合并同家族端点, 专用端点不进入普通模型列表', () => {
    expect(
      collapseRunningHubVideoModels([
        'bytedance/seedance-2.5-token/text-to-video',
        'bytedance/seedance-2.5-token/image-to-video',
        'bytedance/seedance-2.5-token/multimodal-video',
        'kling-v2-ai-avatar-pro/image-audio-to-video',
      ]),
    ).toEqual(['bytedance/seedance-2.5-token/text-to-video']);
    expect(isRunningHubDedicatedVideoEndpoint('kling-v2-ai-avatar-pro/image-audio-to-video')).toBe(true);
  });

  it('目录里没有官方不存在的模型(nano-banana 曾误挂在这条链路上)', () => {
    for (const spec of RUNNINGHUB_VIDEO_ENDPOINTS) {
      expect(spec.endpoint.toLowerCase()).not.toContain('nano-banana');
    }
  });

  it('目录内端点唯一, 且都带 family 段与合法 task', () => {
    const ids = RUNNINGHUB_VIDEO_ENDPOINTS.map((item) => item.endpoint);
    expect(new Set(ids).size).toBe(ids.length);
    for (const spec of RUNNINGHUB_VIDEO_ENDPOINTS) {
      // 端点 ID 至少有一层斜杠分成 family / 后缀; 后缀**不总是** task 名
      // (海螺 02 文生的 ID 是 `minimax/hailuo-02/t2v-pro`), 所以只断言 task 字段本身。
      expect(spec.endpoint).toContain('/');
      expect(['text-to-video', 'image-to-video', 'reference-to-video', 'multimodal-video', 'audio-to-video']).toContain(
        spec.task,
      );
      expect(spec.label.length).toBeGreaterThan(0);
    }
  });

  it('Seedance 2.5 走 `ratio` 而非 `aspectRatio`, 首帧字段名也对得上', () => {
    // Seedance 2.5 是 2026-06 之后按官网文档补进来的, 参数名容易抄错。
    const v25 = resolveRunningHubVideoEndpoint('bytedance/seedance-2.5-token/text-to-video')!;
    expect(v25).toBeDefined();
    expect(v25.fields.ratio).toBe('ratio');
    expect(v25.durations).toContain(30);
    expect(v25.resolutions).toContain('native1080p');

    const seedanceI2v = resolveRunningHubVideoEndpoint('bytedance/seedance-2.5-token/image-to-video')!;
    expect(seedanceI2v.fields.image).toBe('firstFrameUrl');
    expect(seedanceI2v.fields.lastImage).toBe('lastFrameUrl');
  });

  it('官方枚举里的智能时长 `-1` 不暴露给 UI(否则渲染成「-1 秒」)', () => {
    for (const id of [
      'bytedance/seedance-2.5-token/text-to-video',
      'bytedance/seedance-2.5-token/image-to-video',
    ]) {
      const spec = resolveRunningHubVideoEndpoint(id)!;
      expect(spec.durations.every((value) => value > 0)).toBe(true);
    }
  });
});

describe('时长吸附', () => {
  it('精确命中时原样返回', () => {
    const spec = resolveRunningHubVideoEndpoint('kling-v2.6-pro/text-to-video')!;
    expect(snapRunningHubDuration(spec, 5)).toBe(5);
    expect(snapRunningHubDuration(spec, 10)).toBe(10);
  });

  it('枚举外的值吸附到最近档(可灵 2.6 只有 5/10, 选 12 秒会变成 10)', () => {
    const spec = resolveRunningHubVideoEndpoint('kling-v2.6-pro/text-to-video')!;
    expect(snapRunningHubDuration(spec, 12)).toBe(10);
    expect(snapRunningHubDuration(spec, 4)).toBe(5);
    expect(snapRunningHubDuration(spec, 8)).toBe(10);
  });

  it('连续枚举按数值就近(可灵 3.0 是 3~15)', () => {
    const spec = resolveRunningHubVideoEndpoint('kling-v3.0-pro/text-to-video')!;
    expect(snapRunningHubDuration(spec, 7)).toBe(7);
    expect(snapRunningHubDuration(spec, 99)).toBe(15);
    expect(snapRunningHubDuration(spec, 1)).toBe(3);
  });

  it('固定档位的端点不会给出枚举外的值(Veo 3.1 Pro 只有 8 秒)', () => {
    const spec = resolveRunningHubVideoEndpoint('rhart-video-v3.1-pro/text-to-video')!;
    expect(snapRunningHubDuration(spec, 4)).toBe(8);
    expect(snapRunningHubDuration(spec, 30)).toBe(8);
  });

  it('INT 型无枚举(可灵 o3)按自由整数收敛到 1~30', () => {
    const spec = resolveRunningHubVideoEndpoint('kling-video-o3-pro/text-to-video')!;
    expect(spec.durations).toHaveLength(0);
    expect(snapRunningHubDuration(spec, 7)).toBe(7);
    expect(snapRunningHubDuration(spec, 0)).toBe(5);
    expect(snapRunningHubDuration(spec, 999)).toBe(30);
    expect(snapRunningHubDuration(spec, Number.NaN)).toBe(5);
  });

  it('durationType 决定发字符串还是数字(可灵 o3 是 INT)', () => {
    const spec = resolveRunningHubVideoEndpoint('kling-video-o3-pro/image-to-video')!;
    expect(spec.durationType).toBe('number');
    const body = buildRunningHubRequestBody(spec, {
      prompt: 'p',
      images: ['https://x/a.png'],
      duration: 6,
    });
    expect(body.duration).toBe(6);
  });

  it('LIST 型 duration 发字符串(平台口径)', () => {
    const spec = resolveRunningHubVideoEndpoint('kling-v2.6-pro/image-to-video')!;
    const body = buildRunningHubRequestBody(spec, {
      prompt: 'p',
      images: ['https://x/a.png'],
      duration: 5,
    });
    expect(body.duration).toBe('5');
  });
});

describe('比例吸附', () => {
  it('精确命中优先', () => {
    const spec = resolveRunningHubVideoEndpoint('kling-v3.0-pro/text-to-video')!;
    expect(snapRunningHubRatio(spec, '9:16')).toBe('9:16');
    expect(snapRunningHubRatio(spec, '16:9')).toBe('16:9');
  });

  it('枚举外按 宽/高 数值就近(4:3 在 1:1/16:9/9:16 里更接近 1:1)', () => {
    const spec = resolveRunningHubVideoEndpoint('kling-v3.0-pro/text-to-video')!;
    expect(snapRunningHubRatio(spec, '4:3')).toBe('1:1');
    expect(snapRunningHubRatio(spec, '21:9')).toBe('16:9');
  });

  it('adaptive 这类非数字标签按数值吸附', () => {
    const spec = resolveRunningHubVideoEndpoint('seedance-v1.5-pro/image-to-video')!;
    expect(snapRunningHubRatio(spec, '4:3')).toBe('4:3');
  });

  it('无比例参数的端点返回 undefined, 不会凭空发一个键', () => {
    const spec = resolveRunningHubVideoEndpoint('minimax/hailuo-2.3-fast/image-to-video')!;
    expect(snapRunningHubRatio(spec, '16:9')).toBeUndefined();
  });

  it('size 型端点把比例折成官方像素串', () => {
    const spec = resolveRunningHubVideoEndpoint('rhart-video-s-official/text-to-video')!;
    expect(snapRunningHubRatio(spec, '9:16')).toBe('720x1280');
    expect(snapRunningHubRatio(spec, '16:9')).toBe('1280x720');
    // 横屏请求在只有竖/横两档时不会串档
    expect(snapRunningHubRatio(spec, '4:3')).toBe('1280x720');
  });

  it('size 型多档端点按数值就近(pro 版有 6 档)', () => {
    const spec = resolveRunningHubVideoEndpoint('rhart-video-s-official/text-to-video-pro')!;
    expect(snapRunningHubRatio(spec, '16:9')).toBe('1280x720');
    expect(snapRunningHubRatio(spec, '9:16')).toBe('720x1280');
  });
});

describe('分辨率吸附', () => {
  it('大小写不敏感精确命中(万相是 720P / 1080P)', () => {
    const spec = resolveRunningHubVideoEndpoint('alibaba/wan-2.7/text-to-video')!;
    expect(snapRunningHubResolution(spec, '1080p')).toBe('1080P');
    expect(snapRunningHubResolution(spec, '720P')).toBe('720P');
  });

  it('枚举外回落官方默认档', () => {
    const spec = resolveRunningHubVideoEndpoint('vidu/text-to-video-q3-pro')!;
    expect(snapRunningHubResolution(spec, '8k')).toBe('360p');
  });

  it('无分辨率参数的端点返回 undefined', () => {
    const spec = resolveRunningHubVideoEndpoint('kling-v2.6-pro/image-to-video')!;
    expect(snapRunningHubResolution(spec, '720p')).toBeUndefined();
  });
});

describe('请求体构造 — 只许发 schema 内的键', () => {
  it('文生视频: 带 prompt/duration/ratio, 不带任何图片键', () => {
    const spec = resolveRunningHubVideoEndpoint('kling-v3.0-pro/text-to-video')!;
    const body = buildRunningHubRequestBody(spec, {
      prompt: '一只猫',
      images: [],
      duration: 5,
      aspectRatio: '16:9',
      resolution: '1080p',
    });
    expect(body).toMatchObject({ prompt: '一只猫', duration: '5', aspectRatio: '16:9' });
    expect(body).not.toHaveProperty('imageUrl');
    expect(body).not.toHaveProperty('firstImageUrl');
    // 这个端点没有 resolution 参数
    expect(body).not.toHaveProperty('resolution');
  });

  it('图生视频: imageUrl 家族', () => {
    const spec = resolveRunningHubVideoEndpoint('kling-v2.6-pro/image-to-video')!;
    const body = buildRunningHubRequestBody(spec, {
      prompt: 'p',
      images: ['https://x/a.png'],
      duration: 5,
    });
    expect(body.imageUrl).toBe('https://x/a.png');
    expect(body).not.toHaveProperty('firstImageUrl');
  });

  it('图生视频: firstImageUrl 家族, 只有一张图时不发 lastImageUrl', () => {
    const spec = resolveRunningHubVideoEndpoint('kling-v3.0-pro/image-to-video')!;
    const single = buildRunningHubRequestBody(spec, {
      prompt: 'p',
      images: ['https://x/a.png'],
      duration: 5,
    });
    expect(single.firstImageUrl).toBe('https://x/a.png');
    expect(single).not.toHaveProperty('lastImageUrl');

    const pair = buildRunningHubRequestBody(spec, {
      prompt: 'p',
      images: ['https://x/a.png', 'https://x/b.png'],
      duration: 5,
    });
    expect(pair.firstImageUrl).toBe('https://x/a.png');
    expect(pair.lastImageUrl).toBe('https://x/b.png');
  });

  it('图生视频: firstFrameUrl 家族(Seedance 2.0)', () => {
    const spec = resolveRunningHubVideoEndpoint('rhart-video/sparkvideo-2.0/image-to-video')!;
    const body = buildRunningHubRequestBody(spec, {
      prompt: 'p',
      images: ['https://x/a.png', 'https://x/b.png'],
      duration: 8,
      aspectRatio: '16:9',
      resolution: '1080p',
    });
    expect(body.firstFrameUrl).toBe('https://x/a.png');
    expect(body.lastFrameUrl).toBe('https://x/b.png');
    expect(body.ratio).toBe('16:9');
    expect(body.resolution).toBe('1080p');
    expect(body).not.toHaveProperty('imageUrl');
  });

  it('多模态端点按 schema 发送图片/视频/音频数组并限制数量', () => {
    const spec = resolveRunningHubVideoEndpoint('bytedance/seedance-2.5-token/multimodal-video')!;
    const body = buildRunningHubRequestBody(spec, {
      prompt: 'p',
      images: ['https://x/1.png', 'https://x/2.png', 'https://x/3.png'],
      videos: ['https://x/a.mp4', 'https://x/b.mp4'],
      audios: ['https://x/a.mp3'],
      duration: 8,
      aspectRatio: '16:9',
      resolution: '720p',
    });
    expect(body.imageUrls).toEqual(['https://x/1.png', 'https://x/2.png', 'https://x/3.png']);
    expect(body.videoUrls).toEqual(['https://x/a.mp4', 'https://x/b.mp4']);
    expect(body.audioUrls).toEqual(['https://x/a.mp3']);
    expect(body).not.toHaveProperty('firstFrameUrl');
    expect(body.ratio).toBe('16:9');
  });

  it('数字人口播端点使用单图 + 单音频字段', () => {
    const spec = resolveRunningHubVideoEndpoint('kling-v2-ai-avatar-pro/image-audio-to-video')!;
    const body = buildRunningHubRequestBody(spec, {
      prompt: 'p',
      images: ['https://x/person.png'],
      audios: ['https://x/voice.mp3', 'https://x/extra.mp3'],
      duration: 5,
    });
    expect(body.imageUrl).toBe('https://x/person.png');
    expect(body.audioUrl).toBe('https://x/voice.mp3');
    expect(body).not.toHaveProperty('audioUrls');
  });

  it('官方必填的固定参数带默认值(可灵 3.0 的 sound 是 BOOLEAN true)', () => {
    const spec = resolveRunningHubVideoEndpoint('kling-v3.0-std/text-to-video')!;
    const body = buildRunningHubRequestBody(spec, { prompt: 'p', images: [], duration: 5 });
    expect(body.sound).toBe(true);
    expect(body.shotType).toBe('customize');
    // 这个端点(文生)的 cfgScale 官方默认是 0.5。
    expect(body.cfgScale).toBe(0.5);
  });

  it('同一家族不同端点的默认值不同, 不能按前缀一把抄(可灵 3.0-std 图生 cfgScale 是 0.8)', () => {
    const text = resolveRunningHubVideoEndpoint('kling-v3.0-std/text-to-video')!;
    const image = resolveRunningHubVideoEndpoint('kling-v3.0-std/image-to-video')!;
    expect(text.defaults?.cfgScale).toBe(0.5);
    expect(image.defaults?.cfgScale).toBe(0.8);
  });

  it('可灵 2.6 的 sound 是 LIST 字符串, 不能发成布尔', () => {
    const spec = resolveRunningHubVideoEndpoint('kling-v2.6-pro/text-to-video')!;
    const body = buildRunningHubRequestBody(spec, { prompt: 'p', images: [], duration: 5 });
    expect(body.sound).toBe('true');
  });

  it('negativePrompt 只在端点确实有这个参数时才发', () => {
    const withNp = resolveRunningHubVideoEndpoint('kling-v3.0-pro/text-to-video')!;
    expect(
      buildRunningHubRequestBody(withNp, {
        prompt: 'p',
        images: [],
        duration: 5,
        negativePrompt: '模糊',
      }).negativePrompt,
    ).toBe('模糊');

    const withoutNp = resolveRunningHubVideoEndpoint('vidu/text-to-video-q3-pro')!;
    expect(
      buildRunningHubRequestBody(withoutNp, {
        prompt: 'p',
        images: [],
        duration: 5,
        negativePrompt: '模糊',
      }),
    ).not.toHaveProperty('negativePrompt');
  });

  it('无 duration 参数的端点(海螺 02 文生)不会凭空带上 duration', () => {
    const spec = resolveRunningHubVideoEndpoint('minimax/hailuo-02/t2v-pro')!;
    const body = buildRunningHubRequestBody(spec, {
      prompt: 'p',
      images: [],
      duration: 10,
      aspectRatio: '16:9',
    });
    expect(body).not.toHaveProperty('duration');
    expect(body).not.toHaveProperty('aspectRatio');
    expect(body.enablePromptExpansion).toBe(true);
  });

  it('空 prompt 仍然占位(该字段官方必填, 交给平台自己兜底)', () => {
    const spec = resolveRunningHubVideoEndpoint('kling-v2.6-pro/image-to-video')!;
    const body = buildRunningHubRequestBody(spec, {
      prompt: '',
      images: ['https://x/a.png'],
      duration: 5,
    });
    expect(body).toHaveProperty('prompt');
  });
});

describe('extra_params 字段映射', () => {
  it('把端点与字段映射传给后端', () => {
    const extra = runningHubVideoExtraParams('kling-v3.0-pro/image-to-video');
    expect(extra).toMatchObject({
      endpoint: 'kling-v3.0-pro/image-to-video',
      durationType: 'string',
      fields: {
        prompt: 'prompt',
        image: 'firstImageUrl',
        lastImage: 'lastImageUrl',
        duration: 'duration',
      },
      durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    });
  });

  it('多模态字段映射包含数组键和上限', () => {
    expect(runningHubVideoExtraParams('alibaba/wan-3.0/reference-to-video')).toMatchObject({
      fields: { imageList: 'imageUrls', videoList: 'videoUrls', audioList: 'audioUrls' },
      maxImages: 10,
      maxVideos: 5,
      maxAudios: 5,
    });
  });

  it('必须带上官方必填的固定参数, 漏了会被平台判 PARAMS_INVALID', () => {
    const extra = runningHubVideoExtraParams('kling-v3.0-pro/text-to-video')! as {
      defaults: Record<string, unknown>;
    };
    expect(extra.defaults).toMatchObject({ sound: true, shotType: 'customize' });

    const hailuo = runningHubVideoExtraParams('minimax/hailuo-02/t2v-pro')! as {
      defaults: Record<string, unknown>;
    };
    expect(hailuo.defaults.enablePromptExpansion).toBe(true);
  });

  it('size 型端点带上官方像素枚举, 供后端把比例折成像素串', () => {
    const extra = runningHubVideoExtraParams('rhart-video-s-official/text-to-video-pro')! as {
      sizeOptions: string[];
    };
    expect(extra.sizeOptions).toContain('720x1280');
    expect(extra.sizeOptions).toContain('1920x1080');
  });

  it('非 size 型端点不给 sizeOptions', () => {
    const extra = runningHubVideoExtraParams('kling-v2.6-pro/text-to-video')! as {
      sizeOptions: string[];
    };
    expect(extra.sizeOptions).toEqual([]);
  });

  it('未知端点不给映射(让后端走保守默认, 而不是发一个错的字段名)', () => {
    expect(runningHubVideoExtraParams('nano-banana')).toBeUndefined();
  });

  it('目录里每个端点都能生成映射(避免漏配导致后端回落)', () => {
    for (const spec of RUNNINGHUB_VIDEO_ENDPOINTS) {
      const extra = runningHubVideoExtraParams(spec.endpoint);
      expect(extra, spec.endpoint).toBeDefined();
      expect((extra as { endpoint: string }).endpoint).toBe(spec.endpoint);
    }
  });
});

describe('UI 档位取值', () => {
  it('有官方枚举时用它', () => {
    expect(resolveRunningHubDurationOptions('kling-v2.6-pro/text-to-video', [5])).toEqual([5, 10]);
    expect(resolveRunningHubAspectRatioOptions('vidu/text-to-video-q3-pro', [])).toEqual([
      '4:3',
      '3:4',
      '16:9',
      '9:16',
      '1:1',
    ]);
    expect(resolveRunningHubResolutionOptions('alibaba/wan-2.7/image-to-video', [])).toEqual([
      '720P',
      '1080P',
    ]);
  });

  it('duration 无枚举时回落到调用方默认档(自由整数仍需给 UI 一组可选值)', () => {
    expect(resolveRunningHubDurationOptions('kling-video-o3-pro/text-to-video', [5, 8])).toEqual([
      5, 8,
    ]);
  });

  it('ratio / resolution 无该参数时返回空数组(语义是「隐藏这个控件」, 不是回落)', () => {
    // 与 duration 刻意不同: 自由整数的时长仍需要 UI 给档位, 但「端点根本没有比例参数」
    // 时有意义的行为是把控件藏掉 —— 回落到通用比例列表反而会让用户以为选了有效。
    expect(resolveRunningHubAspectRatioOptions('minimax/hailuo-02/t2v-pro', ['16:9'])).toEqual([]);
    expect(resolveRunningHubResolutionOptions('kling-v2.6-pro/image-to-video', ['720p'])).toEqual(
      [],
    );
  });

  it('端点确实有该参数时返回官方枚举, 不透传调用方默认', () => {
    expect(resolveRunningHubAspectRatioOptions('kling-v3.0-pro/text-to-video', ['21:9'])).toEqual([
      '1:1',
      '16:9',
      '9:16',
    ]);
  });

  it('未知端点也回落到默认档', () => {
    expect(resolveRunningHubDurationOptions('unknown-model', [4, 8])).toEqual([4, 8]);
  });
});
