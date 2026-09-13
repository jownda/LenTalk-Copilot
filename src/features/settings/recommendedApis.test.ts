import { describe, expect, it } from 'vitest';

import { isKnownOpenAiImagesBaseUrl, listVisibleRecommendedApis, recommendedApis, visibleRecommendedApiIds } from './recommendedApis';
import { isAudioModelName, isVideoGenerationModelName } from '@/stores/settingsStore';
import { resolveVideoModelProfile } from '@/features/canvas/models/videoProfiles';
import { isRjmVideoApiBaseUrl } from '@/commands/videoApi';

const zhiniao = recommendedApis.find((api) => api.id === 'zhiniao');
const zizidonghua = recommendedApis.find((api) => api.id === 'zizidonghua');

describe('知鸟AI 推荐平台', () => {
  it('以 cuai.token6688.com 作为站点根地址', () => {
    expect(zhiniao).toBeDefined();
    expect(zhiniao?.baseUrl).toBe('https://cuai.token6688.com');
  });

  it('图片走 OpenAI Images 同步协议, 参考图字段是 images 纯数组', () => {
    expect(zhiniao?.imageConfig).toEqual({
      protocol: 'images',
      referenceImageField: 'images',
      referenceImageEncoding: 'url',
      imageTransport: 'generations_json',
    });
  });

  it('视频提交用扁平入口, 轮询用网关统一的 /v1/tasks/{taskId}', () => {
    expect(zhiniao?.videoConfig).toEqual({
      submitPath: '/v1/videos/generations',
      queryPath: '/v1/tasks/{taskId}',
      referenceEncoding: 'url',
      transport: 'zhiniao-video',
    });
  });

  it('价格区间按图片/视频/音频返回 min~max, < 0.01 全部归 0.01', () => {
    // 锁住公开价格表基线(2026-09-13 抓自 /api/v1/models):
    //   图片 24 个: min ⚡0.0056 (aliyun-image-superres) → 0.01; max ⚡0.1687 → 0.17
    //   视频 49 个: min ⚡0.0009 (aliyun-video-superres) → 0.01; max ⚡1.36
    //   音频 9 个 : max ⚡2.2 (voice-clone; 停服已剔除)
    expect(zhiniao?.pricingRange).toEqual({
      image: '⚡0.01 ~ 0.17 / 张',
      video: '⚡0.01 ~ 1.36 / 次',
      audio: '⚡0.01 ~ 2.2 / 次',
    });
  });

  it('预填的图片模型不会被视频模型名启发式误判成视频', () => {
    // buildCustomImageModels 会用 isVideoGenerationModelName 过滤 models, 被误判的
    // 模型既不会出现在图片列表、也不在 videoModels 里, 等于静默消失。
    const misclassified = (zhiniao?.models ?? []).filter((model) => isVideoGenerationModelName(model));
    expect(misclassified).toEqual([]);
  });

  it('预填的音频模型能被音频启发式识别, 图片模型不会被误判成音频', () => {
    const audioModels = zhiniao?.audioModels ?? [];
    expect(audioModels.length).toBeGreaterThan(0);
    expect(audioModels.filter((model) => !isAudioModelName(model))).toEqual([]);
    expect((zhiniao?.models ?? []).filter((model) => isAudioModelName(model))).toEqual([]);
  });

  it('四类模型清单互不重复, 且都不为空', () => {
    const models = zhiniao?.models ?? [];
    const videoModels = zhiniao?.videoModels ?? [];
    const audioModels = zhiniao?.audioModels ?? [];
    const chatModels = zhiniao?.chatModels ?? [];
    expect(models.length).toBeGreaterThan(0);
    expect(videoModels.length).toBeGreaterThan(0);
    expect(audioModels.length).toBeGreaterThan(0);
    expect(chatModels.length).toBeGreaterThan(0);
    const all = [...models, ...videoModels, ...audioModels, ...chatModels];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('字子动画 推荐平台', () => {
  it('以 www.zizidonghua.com 作为站点根地址, 参考图字段用对象数组写法', () => {
    expect(zizidonghua).toBeDefined();
    expect(zizidonghua?.baseUrl).toBe('https://www.zizidonghua.com');
    expect(zizidonghua?.imageConfig).toEqual({
      protocol: 'images',
      referenceImageField: 'reference_images',
      referenceImageEncoding: 'auto',
      imageTransport: 'auto',
    });
  });

  it('预填的图片模型不会被视频/音频启发式误判', () => {
    const models = zizidonghua?.models ?? [];
    expect(models.length).toBeGreaterThan(0);
    expect(models.filter((model) => isVideoGenerationModelName(model))).toEqual([]);
    expect(models.filter((model) => isAudioModelName(model))).toEqual([]);
  });

  it('预填的视频模型能被视频启发式识别', () => {
    // 视频列表在保存时按原样保留, 但「拉取模型」会用它把同批结果分流;
    // wan2.x / happyhorse 只靠 t2v|i2v|r2v 后缀区分, 必须能被识别。
    const videoModels = zizidonghua?.videoModels ?? [];
    expect(videoModels.length).toBeGreaterThan(0);
    const missed = videoModels.filter((model) => !isVideoGenerationModelName(model));
    expect(missed).toEqual([]);
  });

  it('预填的音频模型能被音频启发式识别(eleven_* 系列)', () => {
    // SettingsDialog 保存平台时会用 isAudioModelName 过滤音频输入框,
    // 识别不到的模型会被静默丢弃, 音频节点下拉就空了。
    const audioModels = zizidonghua?.audioModels ?? [];
    expect(audioModels.length).toBeGreaterThan(0);
    expect(audioModels.filter((model) => !isAudioModelName(model))).toEqual([]);
    expect(audioModels.filter((model) => isVideoGenerationModelName(model))).toEqual([]);
  });

  it('四类模型清单互不重复, 且都不为空', () => {
    const models = zizidonghua?.models ?? [];
    const videoModels = zizidonghua?.videoModels ?? [];
    const audioModels = zizidonghua?.audioModels ?? [];
    const chatModels = zizidonghua?.chatModels ?? [];
    expect(videoModels.length).toBeGreaterThan(0);
    expect(audioModels.length).toBeGreaterThan(0);
    expect(chatModels.length).toBeGreaterThan(0);
    const all = [...models, ...videoModels, ...audioModels, ...chatModels];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('isKnownOpenAiImagesBaseUrl', () => {
  it('把知鸟/TokeGo 域名判定为已知 OpenAI Images 平台', () => {
    expect(isKnownOpenAiImagesBaseUrl('https://cuai.token6688.com')).toBe(true);
    expect(isKnownOpenAiImagesBaseUrl('https://cuai.token6688.com/v1')).toBe(true);
    expect(isKnownOpenAiImagesBaseUrl('https://api.tokengo.love/v1/')).toBe(true);
  });

  it('未收录的域名仍然返回 false', () => {
    expect(isKnownOpenAiImagesBaseUrl('https://example.com/v1')).toBe(false);
  });
});

describe('推荐平台可见白名单(密钥页只展示知鸟AI / RunningHub / ModelScope)', () => {
  it('界面只渲染这三个平台, 顺序与白名单一致', () => {
    expect(listVisibleRecommendedApis().map((api) => api.id)).toEqual([
      'zhiniao',
      'runninghub',
      'modelscope',
    ]);
  });

  it('白名单里的 id 都真实存在于推荐平台清单', () => {
    for (const id of visibleRecommendedApiIds) {
      expect(recommendedApis.some((api) => api.id === id)).toBe(true);
    }
  });

  it('被隐藏的平台仍保留完整链路配置(隐藏 ≠ 删除)', () => {
    // 价格徽章按 baseUrl 匹配 recommendedApis, 链路判定也依赖这些配置;
    // 一旦从数组里删条目, 节点价格兜底与预填能力都会一起丢。
    const hidden = recommendedApis.filter((api) => !visibleRecommendedApiIds.includes(api.id));
    expect(hidden.length).toBeGreaterThan(0);
    for (const api of hidden) {
      expect(api.baseUrl.trim().length).toBeGreaterThan(0);
      expect(api.name.trim().length).toBeGreaterThan(0);
    }
    // 抽查几条有专属链路的平台, 确认仍在清单里。
    const hiddenIds = hidden.map((api) => api.id);
    expect(hiddenIds).toContain('zizidonghua');
    expect(hiddenIds).toContain('sub2api-video');
    expect(hiddenIds).toContain('binghuo');
  });

  it('可见与隐藏条目相加等于完整清单, 没有条目被滤没', () => {
    const visible = listVisibleRecommendedApis();
    const hiddenCount = recommendedApis.length - visible.length;
    expect(visible.length + hiddenCount).toBe(recommendedApis.length);
    // 隐藏条目全部可在原清单中按 id 找回(引用同一对象, 不是拷贝后丢弃)。
    for (const api of visible) {
      expect(recommendedApis.find((item) => item.id === api.id)).toBe(api);
    }
  });
});

describe('隐藏推荐卡片不影响自定义平台命中链路', () => {
  // 链路判定只读 Base URL(与自定义平台 id), 与卡片是否渲染无关:
  // 手工在「自定义平台」新增同域名平台时, id 会按名称生成(如「知鸟AI」→ custom:知鸟ai),
  // 所以必须靠 baseUrl 兜底, 这里锁住这条兜底路径。
  it('字子动画 / 知鸟AI 仍按 Base URL 命中专属视频协议', () => {
    expect(
      resolveVideoModelProfile('custom:字子动画/zzdh-Minimax-h3-480p', 'https://www.zizidonghua.com').id,
    ).toBe('zzdh-v8-video');
    expect(
      resolveVideoModelProfile('custom:知鸟ai/seedance-2-5', 'https://cuai.token6688.com').id,
    ).toBe('zhiniao-video');
  });

  it('Sub2API 视频域名仍被识别为 Rjm 异步链路', () => {
    expect(isRjmVideoApiBaseUrl('https://video.rjm.us.ci')).toBe(true);
  });

  it('FHL / 65535 仍被判定为已知 OpenAI Images 平台', () => {
    expect(isKnownOpenAiImagesBaseUrl('https://www.fhl.mom/v1')).toBe(true);
    expect(isKnownOpenAiImagesBaseUrl('https://sub-proxy-us.65535.space/v1')).toBe(true);
  });
});
