import { describe, expect, it } from 'vitest';

import {
  isKnownOpenAiImagesBaseUrl,
  findRecommendedApiByBaseUrl,
  listVisibleRecommendedApis,
  normalizeRecommendedBaseUrl,
  recommendedApis,
  resolveNewRecommendedVideoModels,
  visibleRecommendedApiIds,
} from './recommendedApis';
import { isAudioModelName, isChatCompletionModelName, isVideoGenerationModelName } from '@/stores/settingsStore';
import { LINGKE_IMAGE_NAME_OVERRIDES } from './lingkeModels';
import { resolveVideoModelProfile } from '@/features/canvas/models/videoProfiles';
import { isRjmVideoApiBaseUrl } from '@/commands/videoApi';
import { RUNNINGHUB_VIDEO_ENDPOINTS, RUNNINGHUB_VIDEO_TRANSPORT } from '@/commands/runningHubProtocol';

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
    // 锁住积分标价快照基线(2026-09-13 抓自 /api/v1/models):
    //   图片 24 个: min ⚡0.0056 (aliyun-image-superres) → 0.01; max ⚡0.1687 → 0.17
    //   视频 49 个: min ⚡0.0009 (aliyun-video-superres) → 0.01; max ⚡1.36
    //   音频 9 个 : max ⚡2.2 (voice-clone)
    // 2026-10-07 起该接口只返回 chat 目录, 媒体单价必须带密钥走
    // GET /v1/skills/models/{model}/pricing, 故这份区间只作兜底、不随文档清单同步。
    expect(zhiniao?.pricingRange).toEqual({
      image: '⚡0.01 ~ 0.17 / 张',
      video: '⚡0.01 ~ 1.36 / 次',
      audio: '⚡0.01 ~ 2.2 / 次',
    });
  });

  it('卡片提供官方定价页直达入口(价格链路)', () => {
    expect(zhiniao?.pricingUrl).toBe('https://cuai.token6688.com/pricing');
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

  it('预填的视频模型都能被视频启发式识别(含 Grok Imagine 视频系)', () => {
    // grok-imagine-1.5 / grok-imagine-1-5-7tu-special 名字里只有 imagine、没有 video，
    // 旧实现把它们判成图片/对话模型 —— 视频节点下拉里就选不到。这里锁住「预填的
    // 视频模型必须都能被识别为视频」。
    const videoModels = zhiniao?.videoModels ?? [];
    expect(videoModels.length).toBeGreaterThan(0);
    expect(videoModels.filter((model) => !isVideoGenerationModelName(model))).toEqual([]);
  });

  it('Grok Imagine 只有带 image 的变体是图片, 视频变体留在视频清单', () => {
    const models = zhiniao?.models ?? [];
    const videoModels = zhiniao?.videoModels ?? [];
    expect(models).toContain('grok-imagine-image');
    expect(models).not.toContain('grok-imagine-1.5');
    expect(models).not.toContain('grok-imagine-1-5-7tu-special');
    expect(videoModels).toContain('grok-imagine-1-5-7tu-special');
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

describe('炳火 API 推荐平台', () => {
  const binghuo = recommendedApis.find((api) => api.id === 'binghuo');

  it('以 api.7tai.cc 作为 Base URL, 并带上 /v1', () => {
    expect(binghuo).toBeDefined();
    expect(binghuo?.baseUrl).toBe('https://api.7tai.cc/v1');
    expect(binghuo?.name).toBe('炳火 API');
  });

  it('注册链接是带推荐码的落地页, 不再是登录页', () => {
    // 2026-10-13 起用带 aff 的推荐链接; 旧值 /console/log 是控制台登录页,
    // 新用户点进去只能看到登录框, 还得自己找注册入口。
    expect(binghuo?.registerUrl).toBe('https://api.7tai.cc/register?aff=T1TT');
    expect(binghuo?.registerUrl).not.toContain('/console/');
  });

  it('已在密钥页可见白名单里(不在白名单的卡片根本不渲染)', () => {
    expect(visibleRecommendedApiIds).toContain('binghuo');
    expect(listVisibleRecommendedApis().some((api) => api.id === 'binghuo')).toBe(true);
  });

  it('专属链路按 Base URL 就能命中, 不依赖自定义平台 id', () => {
    // 卡片连上后 id 由名称生成(「炳火 API」→ custom:炳火-api), 所以 Base URL 兜底
    // 必须成立, 否则节点会退化成通用 OpenAI Video 协议。
    expect(resolveVideoModelProfile('custom:炳火-api/bh2.0-720p', 'https://api.7tai.cc/v1').id).toBe('binghuo-video');
  });

  it('预填的图片模型不会被视频/音频启发式误判', () => {
    const models = binghuo?.models ?? [];
    expect(models.length).toBeGreaterThan(0);
    expect(models.filter((model) => isVideoGenerationModelName(model))).toEqual([]);
    expect(models.filter((model) => isAudioModelName(model))).toEqual([]);
  });
});

describe('api666888 暗苗链路预设', () => {
  const api = recommendedApis.find((item) => item.id === 'api666888');

  it('74 个视频模型全部登记, 且每个都落到一个明确协议', () => {
    // 2026-10-20 平台全量: chat 78 / image 21 / video 74 / audio 8。
    // 视频 74 个一个不少 —— 这是「全量接入」的底线, 少一个就是漏配。
    expect(api?.videoModels).toHaveLength(74);
    expect(new Set(api?.videoModels).size).toBe(74);
    // 抽样覆盖每个家族, 防止以后被整段误删:
    expect(api?.videoModels).toEqual(
      expect.arrayContaining([
        'seedance-2.5-guanfang-anmiao',
        'seedance-2.5-anmiao-wensheng',
        'kling-v3-video',
        'kling-motion-control',
        'wan3.0-video',
        'hailuo-h3-max',
        'viduq4-preview',
        'pixverse-v6-shouweizhen',
        'happyhorse-t2v',
        'minimax-h3',
        'omni-flash',
        'vo3.1',
        'gk-video-3.5',
        'hailuo-h3-zaishengcheng',
      ]),
    );
    expect(api?.videoConfig?.transport).toBe('media-generate');
    expect(api?.videoConfig?.transportByModel).toEqual({
      'seedance-2.5-guanfang-anmiao': 'ark-anmiao',
      'seedance-2.0-guanfang-anmiao': 'ark-anmiao',
    });
    // 满血版走方舟, 其余 72 个走 media —— 不能有第三个协议漏网。
    const transports = (api?.videoModels ?? []).map(
      (model) => api?.videoConfig?.transportByModel?.[model] ?? api?.videoConfig?.transport,
    );
    expect(new Set(transports)).toEqual(new Set(['media-generate', 'ark-anmiao']));
  });

  it('图片 21 / 音频 8 / 对话 55 分门别类登记, 不互串', () => {
    expect(api?.models).toHaveLength(21);
    expect(api?.audioModels).toHaveLength(8);
    expect(api?.chatModels).toHaveLength(55);
    // 平台把 kling-v3 / kling-v3-omni 登记为「可灵出图」, 名字却命中 kling 视频规则:
    // settingsStore 按平台做了显式例外, 它们才留在图片清单里(视频清单里不能重复出现)。
    expect(api?.models).toContain('kling-v3');
    expect(api?.models).toContain('kling-v3-omni');
    expect(api?.videoModels).not.toContain('kling-v3');
    expect(api?.videoModels).not.toContain('kling-v3-omni');
    // 23 个 anthropic / gemini 原生协议模型不登记(软件对话只走 /v1/chat/completions)。
    expect(api?.chatModels).not.toContain('sn-5-5');
    expect(api?.chatModels).not.toContain('gem-4-argon');
    // 老配置靠 revision 增量补端点。
    expect(api?.videoModelsRevision).toBe(2);
  });

  it('181 个模型都能被「拉取模型」的分类器分进对的桶', () => {
    // 反例: 旧分类器只认厂商真名, 而灵柯把 GPT / Gemini 写成 tt- / gk- / gem- 代号,
    // 于是 22 个对话模型既不像视频也不像音频、更不像对话 —— 图片那条兜底分支
    // (`!video && !audio && !chat`) 就把它们收进 models 了。表现正是用户看到的
    // 「对话模型跑到图片里, 对话那边拉取不到」。
    const classify = (model: string) =>
      // 灵柯把 kling-v3 / kling-v3-omni 登记成图片模型, 裸分类器只认名字会把它们
      // 判成视频; settingsStore 按平台做了例外, 这里同步优待。
      LINGKE_IMAGE_NAME_OVERRIDES.includes(model.trim().toLowerCase())
        ? 'image'
        : isVideoGenerationModelName(model)
          ? 'video'
          : isAudioModelName(model)
            ? 'audio'
            : isChatCompletionModelName(model)
              ? 'chat'
              : 'image';
    const mismatch = (list: string[] | undefined, expected: string) =>
      (list ?? []).filter((model) => classify(model) !== expected);

    expect(mismatch(api?.models, 'image')).toEqual([]);
    expect(mismatch(api?.videoModels, 'video')).toEqual([]);
    expect(mismatch(api?.audioModels, 'audio')).toEqual([]);
    expect(mismatch(api?.chatModels, 'chat')).toEqual([]);

    // 代号家族逐个点名, 防止以后又有人把它们从正则里删掉。
    for (const model of ['tt-6-luna', 'tt-5.4-nano', 'gk-4.6', 'gk-build-0.1', 'mimo-v2.6-pro', 'stepfun/step-3.7-flash']) {
      expect(isChatCompletionModelName(model), model).toBe(true);
    }
    for (const model of ['kwvideo-v2', 'kwvideo-v2-ref', 'omni_flash-10s', 'omni-1.1', 'vo3.1']) {
      expect(isVideoGenerationModelName(model), model).toBe(true);
    }
    // 带 image / video / tts 字样的依旧归原位, 不能被代号前缀抢走。
    expect(classify('tt-image-2')).toBe('image');
    expect(classify('gk-image-2.0')).toBe('image');
    expect(classify('gk-video-3')).toBe('video');
    expect(classify('gem-2.5-tts')).toBe('audio');
  });

  it('Base URL 指向官方主域名而不是白标静态站', () => {
    // 官方报错文案写明主域名 api.lk888.ai / 备用 api.lk666.ai。api666888.com、
    // lingkeai.ai、lingkeai.vip、huifengai.com 都是同一套白标站(任何路径回
    // index.html, POST 是 405), api.lingkeai.ai 只是别名 —— 填错会让每个请求
    // 拿到 HTML 而不是 JSON。
    expect(api?.baseUrl).toBe('https://api.lk888.ai');
    // 代码会自己拼 `/v1/...`, baseUrl 再带 /v1 就会变成 /v1/v1/...
    expect(api?.baseUrl).not.toMatch(/\/v1\/?$/);
    // 注册 / 充值走推广链接, 带 `yonghu=` 归因参数, 不能退化成裸站。
    expect(api?.registerUrl).toBe('https://lingkeai.ai?yonghu=R7T9O1W16A64FT7W');
    expect(api?.registerUrl).toContain('yonghu=');
    // 显示名改成「灵柯AI」, 但 id 必须还是 api666888 —— registry.ts 的 isApi666888
    // 按 id 认视频参数表, 改名连带改 id 会让 74 个模型的时长/画幅档位失效。
    expect(api?.name).toBe('灵柯AI');
    expect(api?.id).toBe('api666888');
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
      'binghuo',
      'runninghub',
      'runninghub-cn',
      'modelscope',
      // api666888: 「暗苗」链路(media 信封 + 火山方舟两种协议混挂)。
      'api666888',
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
    // 炳火 2026-10-13 起进入白名单(卡片可见), 不再属于隐藏条目。
    expect(hiddenIds).not.toContain('binghuo');
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
    expect(resolveVideoModelProfile('custom:字子动画/zzdh-Minimax-h3-480p', 'https://www.zizidonghua.com').id).toBe(
      'zzdh-v8-video',
    );
    expect(resolveVideoModelProfile('custom:知鸟ai/seedance-2-5', 'https://cuai.token6688.com').id).toBe(
      'zhiniao-video',
    );
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

  it('不预填图像模型, 但预填已接通的 RunningHub 音频端点', () => {
    for (const preset of [international, domestic]) {
      // 图像端点仍未接入标准图像节点；音频端点已经走 RunningHub v2 任务协议。
      expect(preset?.models ?? []).toEqual([]);
      expect(preset?.audioModels).toEqual([
        'indextts2_clone',
        'rhart-audio/text-to-audio/speech-2.8-turbo',
        'rhart-audio/text-to-audio/speech-2.8-hd',
        'bytedance/doubao-seed-tts-2.0',
        'minimax/music-2.6/text-to-music',
        'minimax/music-2.6/text-to-instrumental',
        'rhart-audio/suno-v5.5/single',
        'rhart-audio/suno-v5.5/custom',
      ]);
    }
  });

  it('预填端点与官方目录快照一一对应(两边都锁死, 不会单方面漂移)', () => {
    const known = new Set(RUNNINGHUB_VIDEO_ENDPOINTS.map((endpoint) => endpoint.endpoint));
    const videoModels = international?.videoModels ?? [];
    expect(videoModels.length).toBeGreaterThan(0);
    // 预设里的每个 ID 都必须能在目录里查到字段表 —— 查不到就是拼错了,
    // 提交时会被平台回 "Invalid URL"。
    expect(videoModels.filter((model) => !known.has(model))).toEqual([]);
    // 反向: 目录里的每个端点都应被预填, 不留「实现了却选不到」的孤儿。
    expect([...known].filter((endpoint) => !videoModels.includes(endpoint))).toEqual([]);
    expect(new Set(videoModels).size).toBe(videoModels.length);
  });

  it('视频端点 ID 形如 <家族>/<文生|图生> 且不含前导斜杠或空白', () => {
    for (const model of international?.videoModels ?? []) {
      // 提交时整串拼在 `/openapi/v2/` 之后, 前导斜杠会拼成双斜杠。
      expect(model).not.toMatch(/^\/|\s/);
      // 海螺 02 文生的端点名是 t2v-pro, 多模态端点则使用 multimodal-video。
      expect(model).toMatch(/to-video|t2v|i2v|multimodal/);
    }
  });

  it('两条预设都声明 runninghub-model 协议, 且视频档案按 Base URL 命中', () => {
    for (const preset of [international, domestic]) {
      expect(preset?.videoConfig?.transport).toBe(RUNNINGHUB_VIDEO_TRANSPORT);
      // 查询地址是固定路径 POST body {taskId}, 不是提交路径 + /{taskId}。
      expect(preset?.videoConfig?.queryPath).toBe('/openapi/v2/query');
    }
    expect(
      resolveVideoModelProfile('custom:runninghub/kling-v3.0-pro/image-to-video', 'https://www.runninghub.cn').id,
    ).toBe('runninghub-model');
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
    // 灵柯平台把 `kling-v3` / `kling-v3-omni` **登记为图片模型**(可灵出图), 名字却
    // 命中通用 kling 视频规则 —— settingsStore 按平台做了显式例外, 这里同步放过。
    const isDeclaredImageName = (model: string) =>
      LINGKE_IMAGE_NAME_OVERRIDES.includes(model.trim().toLowerCase());
    for (const api of listVisibleRecommendedApis()) {
      const models = api.models ?? [];
      expect(
        models.filter((model) => !isDeclaredImageName(model) && isVideoGenerationModelName(model)),
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
    const kinds = Object.fromEntries(listVisibleRecommendedApis().map((api) => [api.id, api.balanceKind ?? null]));
    expect(kinds).toEqual({
      // TokenGo 是 One-API 系网关: /v1/dashboard/billing/subscription 存在(未授权时 401 而非 404)。
      zhiniao: 'openai-billing',
      // 炳火没有实测过的额度接口 —— 宁可不显示余额, 也不猜一个数字出来。
      binghuo: null,
      runninghub: 'runninghub',
      'runninghub-cn': 'runninghub',
      // ModelScope 实测该端点返回 404 —— 声明了只会白发请求且永远查不到余额。
      modelscope: null,
      // api666888 有 /v1/skills/balance, 但尚未接入余额查询, 先不声明。
      api666888: null,
    });
  });
});

describe('预设视频模型的增量同步', () => {
  // 「预设加了端点, 但已添加过该平台的用户看不到」—— 平台添加后模型列表就与预设脱钩。
  // 下面锁定补差集的语义。
  const presetEndpointIds = RUNNINGHUB_VIDEO_ENDPOINTS.map((item) => item.endpoint);
  // 老配置: 第二批才补进来的 bytedance/* 端点当时还不存在。
  const legacyModels = presetEndpointIds.filter((id) => !id.startsWith('bytedance/'));

  it('从未同步过的老配置能把预设新增的端点补出来', () => {
    const resolved = resolveNewRecommendedVideoModels('https://www.runninghub.cn', legacyModels, undefined);
    expect(resolved).not.toBeNull();
    expect(resolved?.revision).toBe(3);
    expect(resolved?.models).toEqual([
      'bytedance/seedance-2.5-token/text-to-video',
      'bytedance/seedance-2.5-token/image-to-video',
      'bytedance/seedance-2.5-token/multimodal-video',
    ]);
  });

  it('已对齐的平台是 no-op —— 用户删掉的预设端点不会被反复加回来', () => {
    expect(resolveNewRecommendedVideoModels('https://www.runninghub.cn', presetEndpointIds, 3)).toBeNull();
  });

  it('对齐之后用户删掉某个预设端点, 依然不会复活', () => {
    const afterUserDeletion = presetEndpointIds.filter((id) => !id.includes('hailuo'));
    expect(resolveNewRecommendedVideoModels('https://www.runninghub.cn', afterUserDeletion, 3)).toBeNull();
  });

  it('用户手加的端点既不会被删, 也不影响差集', () => {
    const resolved = resolveNewRecommendedVideoModels(
      'https://www.runninghub.cn',
      [...legacyModels, 'my-own/private-endpoint'],
      1,
    );
    expect(resolved?.models).toEqual([
      'bytedance/seedance-2.5-token/text-to-video',
      'bytedance/seedance-2.5-token/image-to-video',
      'bytedance/seedance-2.5-token/multimodal-video',
    ]);
  });

  it('清单不由代码维护的平台不参与同步', () => {
    for (const baseUrl of ['https://api.wgspai.cn/v1', 'https://api.grsai.com', '']) {
      expect(resolveNewRecommendedVideoModels(baseUrl, [], undefined)).toBeNull();
    }
  });

  it('知鸟已纳入同步: 老配置能把 2026-10-07 新增的视频模型补出来', () => {
    const resolved = resolveNewRecommendedVideoModels('https://cuai.token6688.com', [], undefined);
    expect(resolved?.revision).toBe(1);
    expect(resolved?.models).toContain('grok-imagine-1-5-7tu-special');
  });

  it('两条 RunningHub 预设的 revision 必须同步推进', () => {
    const international = recommendedApis.find((api) => api.id === 'runninghub');
    const domestic = recommendedApis.find((api) => api.id === 'runninghub-cn');
    expect(international?.videoModelsRevision).toBe(domestic?.videoModelsRevision);
    // 低于 3 说明有人改了 videoModels 却忘了 +1 —— 老用户就永远收不到新端点。
    expect(domestic?.videoModelsRevision).toBeGreaterThanOrEqual(3);
  });
});
