import { describe, expect, it } from 'vitest';

import {
  WGSPAI_DEFAULT_MAX_REFERENCE_IMAGES,
  WGSPAI_TASK_QUERY_PATH,
  WGSPAI_TASK_SUBMIT_PATH,
  WGSPAI_VIDEOS_SUBMIT_PATH,
  buildWgspaiRequestBody,
  describeWgspaiBusinessError,
  localizeWgspaiReferenceTokens,
  resolveWgspaiAspectRatio,
  resolveWgspaiAspectRatioOptions,
  resolveWgspaiDuration,
  resolveWgspaiDurationOptions,
  resolveWgspaiModelSpec,
  wgspaiPixelSize,
  wgspaiQueryPath,
  wgspaiSubmitPath,
  type WgspaiResolvedReferences,
} from './wgspaiProtocol';

const noReferences: WgspaiResolvedReferences = { images: [], audios: [], videos: [] };

function bodyOf(overrides: Partial<Parameters<typeof buildWgspaiRequestBody>[0]> = {}) {
  return buildWgspaiRequestBody({
    apiModel: 'seedance2.5',
    prompt: '',
    duration: 10,
    aspectRatio: '16:9',
    references: noReferences,
    ...overrides,
  });
}

describe('resolveWgspaiModelSpec 接口族分流', () => {
  it('文档写在 /v1/videos 下的模型留在族 1', () => {
    for (const model of ['seedance2.5', 'seedance-v2-720p', 'Minimax-h3', 'seedance-v2-720p-video']) {
      expect(resolveWgspaiModelSpec(model).family).toBe('videos');
    }
  });

  it('总览文档「异步 · 视频类任务」一节的模型走族 2', () => {
    for (const model of [
      'sd-2',
      'sd-2-vip',
      'LongXia-O-sora2-pro-8s-9x16',
      'LongXia-A-veo31-8s-16x9-1080p',
      'ltx2.3',
      'voice-clone',
      'flashvsr-restore',
      'VEO-3.1',
      'seedance-v2-1080p',
    ]) {
      expect(resolveWgspaiModelSpec(model).family).toBe('task');
    }
  });

  it('未识别模型保持族 1 的宽松默认', () => {
    const spec = resolveWgspaiModelSpec('some-other-video-model');
    expect(spec.family).toBe('videos');
    expect(spec.maxReferenceImages).toBe(WGSPAI_DEFAULT_MAX_REFERENCE_IMAGES);
    expect(spec.duration).toEqual({ kind: 'passthrough' });
    expect(spec.supportsReferenceAudio).toBe(true);
    expect(spec.supportsReferenceVideo).toBe(true);
    expect(spec.dialect).toBe('keep');
  });

  it('没有文档依据的 1080p 变体不会被改到另一族', () => {
    const spec = resolveWgspaiModelSpec('seedance-v2.5-1080p');
    expect(spec.family).toBe('videos');
    expect(spec.maxReferenceImages).toBe(9);
    expect(spec.duration).toEqual({ kind: 'range', min: 4, max: 15 });
  });

  it('大小写与前缀不影响识别', () => {
    expect(resolveWgspaiModelSpec('HF-Seedance-2.5-1080p').duration).toEqual({ kind: 'platform-default' });
    expect(resolveWgspaiModelSpec('minimax-h3-pro-720p').maxReferenceImages).toBe(9);
    expect(resolveWgspaiModelSpec('SD-2-VIP').family).toBe('task');
  });

  it('Minimax-h3 按文档拒绝参考音视频、时长收在 4~15 秒', () => {
    const spec = resolveWgspaiModelSpec('Minimax-h3');
    expect(spec.supportsReferenceAudio).toBe(false);
    expect(spec.supportsReferenceVideo).toBe(false);
    expect(spec.duration).toEqual({ kind: 'range', min: 4, max: 15 });
  });

  it('seedance-v2 是 9-3-3，视频参考只看 -video 后缀', () => {
    const base = resolveWgspaiModelSpec('seedance-v2-720p');
    expect(base.maxReferenceImages).toBe(9);
    expect(base.maxReferenceAudio).toBe(3);
    expect(base.maxReferenceVideos).toBe(3);
    expect(base.supportsReferenceVideo).toBe(false);
    expect(resolveWgspaiModelSpec('seedance-v2-720p-video').supportsReferenceVideo).toBe(true);
  });
});

describe('resolveWgspaiDuration', () => {
  it('按文档区间吸附，而不是让平台回 400', () => {
    expect(resolveWgspaiDuration({ kind: 'range', min: 4, max: 15 }, 2)).toBe(4);
    expect(resolveWgspaiDuration({ kind: 'range', min: 4, max: 15 }, 30)).toBe(15);
    expect(resolveWgspaiDuration({ kind: 'range', min: 4, max: 15 }, 10)).toBe(10);
    expect(resolveWgspaiDuration({ kind: 'range', min: 5, max: 15 }, 4)).toBe(5);
  });

  it('平台默认 / 编在模型名里都不带时长字段', () => {
    expect(resolveWgspaiDuration({ kind: 'platform-default' }, 10)).toBeUndefined();
    expect(resolveWgspaiDuration({ kind: 'in-model-name' }, 10)).toBeUndefined();
    expect(resolveWgspaiDuration({ kind: 'passthrough' }, 0)).toBe(1);
  });

  it('固定时长模型在请求体里彻底省略 seconds', () => {
    expect(bodyOf({ apiModel: 'seedance2.5' })).not.toHaveProperty('seconds');
    const task = bodyOf({ apiModel: 'LongXia-O-sora2-pro-8s-9x16', aspectRatio: '9:16' });
    expect(task.params as Record<string, unknown>).not.toHaveProperty('seconds');
  });

  it('Minimax-h3 的 30 秒被收到 15', () => {
    expect(bodyOf({ apiModel: 'Minimax-h3', duration: 30 })).toMatchObject({ seconds: '15' });
  });
});

describe('画幅吸附', () => {
  it('seedance-v2 只在 9:16 / 16:9 之间吸附', () => {
    const spec = resolveWgspaiModelSpec('seedance-v2-720p');
    expect(resolveWgspaiAspectRatio(spec, '16:9')).toBe('16:9');
    expect(resolveWgspaiAspectRatio(spec, '9:16')).toBe('9:16');
    expect(resolveWgspaiAspectRatio(spec, '4:3')).toBe('16:9');
    expect(resolveWgspaiAspectRatio(spec, '3:4')).toBe('9:16');
    expect(resolveWgspaiAspectRatio(spec, '1:1')).toBe('9:16');
    expect(resolveWgspaiAspectRatio(spec, 'adaptive')).toBe('9:16');
    // 用户没选也要落到文档默认，不能交给平台默认（界面会对不上）。
    expect(resolveWgspaiAspectRatio(spec, '   ')).toBe('9:16');
  });

  it('未限定画幅的模型保留用户选择', () => {
    const spec = resolveWgspaiModelSpec('Minimax-h3');
    expect(resolveWgspaiAspectRatio(spec, '21:9')).toBe('21:9');
    expect(resolveWgspaiAspectRatio(spec, '')).toBeUndefined();
  });

  it('像素尺寸表覆盖文档列出的比例', () => {
    expect(wgspaiPixelSize('16:9')).toBe('1280x720');
    expect(wgspaiPixelSize('9:16')).toBe('720x1280');
    expect(wgspaiPixelSize('1:1')).toBe('1024x1024');
    expect(wgspaiPixelSize('adaptive')).toBeUndefined();
  });

  it('seedance2.5 保留 1:1', () => {
    expect(bodyOf({ apiModel: 'seedance2.5', duration: 30, aspectRatio: '1:1' })).toMatchObject({
      ratio: '1:1',
      size: '1024x1024',
    });
  });
});

describe('localizeWgspaiReferenceTokens 引用方言', () => {
  it('seedance2.5 把 @图N 换成 @图片N', () => {
    expect(
      localizeWgspaiReferenceTokens('保持@图1人物外观与@图2场景风格', 'at-picture', {
        images: 2,
        audios: 0,
        videos: 0,
      }),
    ).toBe('保持@图片1人物外观与@图片2场景风格');
  });

  it('已经是目标写法时幂等', () => {
    expect(
      localizeWgspaiReferenceTokens('保持@图片1人物外观', 'at-picture', { images: 1, audios: 0, videos: 0 }),
    ).toBe('保持@图片1人物外观');
  });

  it('seedance2.5 不臆造音频标记', () => {
    expect(
      localizeWgspaiReferenceTokens('使用 @音频1 作为人声参考', 'at-picture', {
        images: 1,
        audios: 1,
        videos: 0,
      }),
    ).toBe('使用 @音频1 作为人声参考');
  });

  it('seedance-v2 换成方括号方言，含文档的 [audio_1] 下划线写法', () => {
    expect(
      localizeWgspaiReferenceTokens('人物跟着 @音频1 的节奏点头, 动作参考 @图2, 外形参考 @图1', 'bracketed', {
        images: 2,
        audios: 1,
        videos: 0,
      }),
    ).toBe('人物跟着 [audio_1] 的节奏点头, 动作参考 [image2], 外形参考 [image1]');

    expect(
      localizeWgspaiReferenceTokens('[audio_1] 与 [video_2]', 'bracketed', { images: 0, audios: 1, videos: 2 }),
    ).toBe('[audio_1] 与 [video_2]');
  });

  it('超出本次实际提交数量的 token 保持原样', () => {
    expect(
      localizeWgspaiReferenceTokens('@图3 与 @图1', 'at-picture', { images: 2, audios: 0, videos: 0 }),
    ).toBe('@图3 与 @图片1');
    expect(
      localizeWgspaiReferenceTokens('@音频1 参考', 'bracketed', { images: 1, audios: 0, videos: 0 }),
    ).toBe('@音频1 参考');
  });

  it('普通正文里的「图1」绝不被改写', () => {
    expect(
      localizeWgspaiReferenceTokens('如图1所示, 参考图2的构图', 'at-picture', {
        images: 3,
        audios: 0,
        videos: 0,
      }),
    ).toBe('如图1所示, 参考图2的构图');
    expect(
      localizeWgspaiReferenceTokens('邮箱 a@图b 与 @图1', 'at-picture', { images: 1, audios: 0, videos: 0 }),
    ).toBe('邮箱 a@图b 与 @图片1');
  });

  it('keep 方言原样返回', () => {
    const prompt = '保持 @图1 与 @音频1 一致';
    expect(localizeWgspaiReferenceTokens(prompt, 'keep', { images: 9, audios: 9, videos: 9 })).toBe(prompt);
  });

  it('构建请求体时会真的把提示词换掉', () => {
    const body = bodyOf({
      apiModel: 'seedance-v2-720p',
      duration: 8,
      prompt: '外形参考 @图1',
      references: { images: ['https://cdn.example.com/a.jpg'], audios: [], videos: [] },
    });
    expect(body.prompt).toBe('外形参考 [image1]');
  });
});

describe('buildWgspaiRequestBody', () => {
  it('族 1 平铺参考字段', () => {
    const body = bodyOf({
      apiModel: 'seedance-v2-720p',
      duration: 8,
      references: {
        images: ['https://cdn.example.com/a.jpg'],
        audios: ['https://cdn.example.com/b.mp3'],
        videos: [],
      },
    });
    expect(body).not.toHaveProperty('params');
    expect(body).toMatchObject({
      model: 'seedance-v2-720p',
      images: ['https://cdn.example.com/a.jpg'],
      audio_urls: ['https://cdn.example.com/b.mp3'],
      seconds: '8',
    });
  });

  it('族 2 参数全部包在 params 里，顶层只有 model / prompt', () => {
    const body = bodyOf({ apiModel: 'sd-2', duration: 10, prompt: '镜头缓慢推进' });
    expect(body.model).toBe('sd-2');
    expect(body.prompt).toBe('镜头缓慢推进');
    expect(body).not.toHaveProperty('seconds');
    expect(body).not.toHaveProperty('generate_audio');
    expect(body.params).toMatchObject({ seconds: '10', size: '1280x720', ratio: '16:9' });
  });

  it('族 2 的 sd-2 把参考视频放进 params.videos', () => {
    const body = bodyOf({
      apiModel: 'sd-2',
      references: {
        images: ['https://cdn.example.com/a.jpg'],
        audios: [],
        videos: ['https://cdn.example.com/m.mp4'],
      },
    });
    expect(body.params).toMatchObject({
      images: ['https://cdn.example.com/a.jpg'],
      videos: ['https://cdn.example.com/m.mp4'],
    });
  });

  it('seedance-v2-1080p-video 走类型化 params.content 且不带时长', () => {
    const body = bodyOf({
      apiModel: 'seedance-v2-1080p-video',
      references: {
        images: ['https://cdn.example.com/a.jpg'],
        audios: ['https://cdn.example.com/b.mp3'],
        videos: ['https://cdn.example.com/m.mp4'],
      },
    });
    const params = body.params as Record<string, unknown>;
    expect(params).not.toHaveProperty('seconds');
    expect(params.content).toEqual([
      { type: 'image_url', image_url: { url: 'https://cdn.example.com/a.jpg' }, role: 'reference_image' },
      { type: 'video_url', video_url: { url: 'https://cdn.example.com/m.mp4' }, role: 'reference_video' },
      { type: 'audio_url', audio_url: { url: 'https://cdn.example.com/b.mp3' }, role: 'reference_audio' },
    ]);
  });

  it('flashvsr-restore 用单数 video_url', () => {
    const body = bodyOf({
      apiModel: 'flashvsr-restore',
      references: { images: [], audios: [], videos: ['https://cdn.example.com/m.mp4'] },
    });
    const params = body.params as Record<string, unknown>;
    expect(params.video_url).toBe('https://cdn.example.com/m.mp4');
    expect(params).not.toHaveProperty('videos');
  });

  it('首尾帧模式给第一张图打 first_frame', () => {
    const body = bodyOf({
      apiModel: 'seedance2.5',
      duration: 30,
      imageMode: 'first-last',
      references: {
        images: ['https://cdn.example.com/a.jpg', 'https://cdn.example.com/b.jpg'],
        audios: [],
        videos: [],
      },
    });
    expect(body.image_usage).toBe('first_frame');
  });

  it('resolution 与族别无关地透传', () => {
    expect(bodyOf({ apiModel: 'Minimax-h3', videoResolution: '2K' })).toMatchObject({ resolution: '2K' });
    expect(bodyOf({ apiModel: 'sd-2', videoResolution: '2K' }).params).toMatchObject({ resolution: '2K' });
  });
});

describe('端点选择', () => {
  it('族别决定提交与查询端点', () => {
    const videos = resolveWgspaiModelSpec('seedance2.5');
    expect(wgspaiSubmitPath(videos)).toBe(WGSPAI_VIDEOS_SUBMIT_PATH);
    expect(wgspaiQueryPath(videos)).toBe(`${WGSPAI_VIDEOS_SUBMIT_PATH}/{taskId}`);

    const task = resolveWgspaiModelSpec('sd-2');
    expect(wgspaiSubmitPath(task)).toBe(WGSPAI_TASK_SUBMIT_PATH);
    expect(wgspaiQueryPath(task)).toBe(WGSPAI_TASK_QUERY_PATH);
  });
});

describe('UI 档位', () => {
  const durationFallback = [5, 10, 15];

  it('固定时长模型只给一个选项', () => {
    expect(resolveWgspaiDurationOptions('seedance2.5', durationFallback)).toEqual([30]);
  });

  it('区间模型展开成文档区间内的整数枚举', () => {
    expect(resolveWgspaiDurationOptions('seedance-v2-720p', durationFallback)).toEqual(
      [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    );
    expect(resolveWgspaiDurationOptions('Minimax-h3', durationFallback)).toEqual(
      [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    );
    expect(resolveWgspaiDurationOptions('sd-2', durationFallback)).toEqual(
      [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    );
  });

  it('时长编在模型名里的模型从名字里解出那一个值', () => {
    expect(resolveWgspaiDurationOptions('LongXia-O-sora2-pro-8s-9x16', durationFallback)).toEqual([8]);
    expect(resolveWgspaiDurationOptions('LongXia-O-sora2-pro-12s-16x9', durationFallback)).toEqual([12]);
    // 1080p 里的 1080 不能被当成秒数。
    expect(resolveWgspaiDurationOptions('LongXia-A-veo31-8s-16x9-1080p', durationFallback)).toEqual([8]);
  });

  it('文档没写时长规则时退回调用方的默认档位', () => {
    expect(resolveWgspaiDurationOptions('ltx2.3', durationFallback)).toEqual(durationFallback);
    expect(resolveWgspaiDurationOptions('some-other-model', durationFallback)).toEqual(durationFallback);
    // 1080p 按次计费、不接受客户端时长 → 也退回默认档位。
    expect(resolveWgspaiDurationOptions('seedance-v2-1080p', durationFallback)).toEqual(durationFallback);
  });

  it('画幅白名单模型只在白名单里给值', () => {
    expect(resolveWgspaiAspectRatioOptions('seedance-v2-720p', ['16:9', '9:16', '1:1', '4:3'])).toEqual([
      '9:16',
      '16:9',
    ]);
    expect(resolveWgspaiAspectRatioOptions('seedance2.5', ['16:9', '9:16', '1:1', '4:3'])).toEqual([
      '9:16',
      '16:9',
      '1:1',
    ]);
    expect(resolveWgspaiAspectRatioOptions('Minimax-h3', ['16:9', '9:16', '1:1', '4:3'])).toEqual([
      '16:9',
      '9:16',
      '1:1',
      '4:3',
    ]);
  });
});

describe('describeWgspaiBusinessError', () => {
  it('认出总览文档的业务错误体', () => {
    expect(
      describeWgspaiBusinessError(
        { code: -1, message: '错误描述', data: { code: 'error_code', message: '详细错误信息' } },
        '',
      ),
    ).toBe('错误描述');
  });

  it('code 为 0 / 200 / success 时不算错误', () => {
    expect(describeWgspaiBusinessError({ code: 0, data: { status: 'pending' } }, 'PENDING')).toBeUndefined();
    expect(describeWgspaiBusinessError({ code: '200' }, '')).toBeUndefined();
    expect(describeWgspaiBusinessError({ code: 'success' }, '')).toBeUndefined();
  });

  it('平台说还在跑时不采信 code，避免把已计费的任务判死', () => {
    expect(
      describeWgspaiBusinessError({ code: -1, message: '上游繁忙', data: { status: 'processing' } }, 'PROCESSING'),
    ).toBeUndefined();
  });

  it('没有 code 字段的普通响应不受影响', () => {
    expect(describeWgspaiBusinessError({ id: 'task_1', status: 'queued' }, 'QUEUED')).toBeUndefined();
    expect(describeWgspaiBusinessError(null, '')).toBeUndefined();
    expect(describeWgspaiBusinessError('oops', '')).toBeUndefined();
  });

  it('拿不到人话时退化成 code 本身', () => {
    expect(describeWgspaiBusinessError({ code: -1 }, '')).toBe('平台返回业务错误 code=-1');
  });
});
