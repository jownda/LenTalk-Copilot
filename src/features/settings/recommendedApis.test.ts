import { describe, expect, it } from 'vitest';

import { isKnownOpenAiImagesBaseUrl, findRecommendedApiByBaseUrl, listVisibleRecommendedApis, normalizeRecommendedBaseUrl, recommendedApis, visibleRecommendedApiIds } from './recommendedApis';
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

describe('推荐平台可见白名单(密钥页展示内置推荐平台)', () => {
  it('界面只渲染白名单平台, 顺序与白名单一致', () => {
    expect(listVisibleRecommendedApis().map((api) => api.id)).toEqual([
      'zhiniao',
      'runninghub',
      'runninghub-cn',
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
    // 帧间 API 按用户要求从界面隐藏, 但它带着 zhenjian-task-api 专属链路 ——
    // 条目必须留在清单里, 否则手工用同一 Base URL 建的平台会命中不到链路。
    expect(hiddenIds).toContain('zhenjian');
  });

  it('帧间 API 不再出现在可见卡片里', () => {
    expect(visibleRecommendedApiIds).not.toContain('zhenjian');
    expect(listVisibleRecommendedApis().some((api) => api.id === 'zhenjian')).toBe(false);
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

describe('RunningHub 国际版 / 国内版', () => {
  // 两个站点是独立的站点与账号体系, 拆成两条预设; 链路判定全部按 Base URL,
  // 因此新增的一条不需要额外的专有 profile。
  const international = recommendedApis.find((api) => api.id === 'runninghub');
  const domestic = recommendedApis.find((api) => api.id === 'runninghub-cn');

  it('两条预设分别指向国际站与国内站, 域名不同', () => {
    expect(international?.baseUrl).toBe('https://www.runninghub.ai');
    expect(domestic?.baseUrl).toBe('https://www.runninghub.cn');
  });

  it('注册链接各自带邀请码, 且互不相同', () => {
    expect(international?.registerUrl).toContain('inviteCode=gg6f774v');
    expect(domestic?.registerUrl).toContain('inviteCode=0cthsuca');
    expect(international?.registerUrl).not.toBe(domestic?.registerUrl);
  });

  it('两条都在可见白名单里(不在白名单的卡片根本不渲染)', () => {
    expect(visibleRecommendedApiIds).toContain('runninghub');
    expect(visibleRecommendedApiIds).toContain('runninghub-cn');
  });

  it('名称可区分, 密钥页不会出现两个同名平台', () => {
    expect(international?.name).toContain('国际');
    expect(domestic?.name).toContain('国内');
    expect(international?.name).not.toBe(domestic?.name);
  });

  it('预填模型不会被视频/音频启发式抢走(否则保存平台时被静默丢弃)', () => {
    for (const preset of [international, domestic]) {
      const models = preset?.models ?? [];
      expect(models.length).toBeGreaterThan(0);
      expect(models.filter((model) => isVideoGenerationModelName(model))).toEqual([]);
      expect(models.filter((model) => isAudioModelName(model))).toEqual([]);
    }
  });
});

describe('推荐平台 Base URL 匹配(卡片「已连接」徽章的判定依据)', () => {
  it('带不带 /v1 后缀视为同一个平台', () => {
    expect(normalizeRecommendedBaseUrl('https://api-inference.modelscope.cn/v1')).toBe(
      normalizeRecommendedBaseUrl('https://api-inference.modelscope.cn'),
    );
  });

  it('大小写与结尾斜杠不影响匹配', () => {
    expect(findRecommendedApiByBaseUrl('HTTPS://WWW.RunningHub.cn/')?.id).toBe('runninghub-cn');
    expect(findRecommendedApiByBaseUrl('https://www.runninghub.ai/')?.id).toBe('runninghub');
  });

  it('每个可见推荐平台的 baseUrl 都能反查回它自己', () => {
    for (const api of listVisibleRecommendedApis()) {
      expect(findRecommendedApiByBaseUrl(api.baseUrl)?.id).toBe(api.id);
    }
  });

  it('自己手填的第三方平台不会被误判成推荐平台', () => {
    expect(findRecommendedApiByBaseUrl('https://relay.example.com/v1')).toBeUndefined();
    expect(findRecommendedApiByBaseUrl('   ')).toBeUndefined();
  });

  it('两个 RunningHub 站点互不串台', () => {
    expect(findRecommendedApiByBaseUrl('https://www.runninghub.ai')?.id).not.toBe('runninghub-cn');
    expect(findRecommendedApiByBaseUrl('https://www.runninghub.cn')?.id).not.toBe('runninghub');
  });
});

describe('可见推荐平台直接连接后的模型归属', () => {
  it('预填的图片模型不会被视频/音频启发式抢走(否则连上后列表里看不到)', () => {
    for (const api of listVisibleRecommendedApis()) {
      const models = api.models ?? [];
      expect(
        models.filter((model) => isVideoGenerationModelName(model)),
        `${api.id} 的图片模型被当成视频模型`,
      ).toEqual([]);
      expect(
        models.filter((model) => isAudioModelName(model)),
        `${api.id} 的图片模型被当成音频模型`,
      ).toEqual([]);
    }
  });
});

describe('推荐平台的余额查询声明', () => {
  it('只给确实有额度接口的平台声明 balanceKind', () => {
    const kinds = Object.fromEntries(
      listVisibleRecommendedApis().map((api) => [api.id, api.balanceKind ?? null]),
    );
    expect(kinds).toEqual({
      // TokenGo 是 One-API 系网关: /v1/dashboard/billing/subscription 存在(未授权时 401 而非 404)。
      zhiniao: 'openai-billing',
      runninghub: 'runninghub',
      'runninghub-cn': 'runninghub',
      // ModelScope 实测该端点返回 404 —— 声明了只会白发请求且永远查不到余额。
      modelscope: null,
    });
  });
});
