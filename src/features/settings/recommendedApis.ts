// ---------------------------------------------------------------------------
// 推荐平台(参考 Infinite Canvas 的 API 设置推荐列表,集中维护预填的多媒体协议)
// 点「添加」→ 预填名称 / Base URL / 模型,保存后即可使用
// ---------------------------------------------------------------------------

export interface RecommendedApi {
  id: string;
  name: string;
  baseUrl: string;
  registerUrl: string;
  pricingUrl?: string;
  summary: string;
  advantages: string[];
  models: string[];
  videoModels?: string[];
  chatModels?: string[];
  /** 图片协议的明确配置；未声明的平台继续使用通用默认值。 */
  imageConfig?: RecommendedImageConfig;
  /** 视频协议的明确配置；用于异步提交、轮询和参考素材适配。 */
  videoConfig?: RecommendedVideoConfig;
}

export interface RecommendedImageConfig {
  protocol: 'images' | 'responses' | 'chat';
  referenceImageField: 'image' | 'input_image';
  referenceImageEncoding: 'auto' | 'data_url' | 'raw_base64' | 'url';
  imageTransport: 'auto' | 'generations_json' | 'edits_multipart' | 'apimart_json';
}

export interface RecommendedVideoConfig {
  submitPath: string;
  queryPath: string;
  referenceEncoding: 'data_url' | 'raw_base64' | 'url';
  transport: 'sub2api-video' | 'binghuo-video';
}

/** 已确认的 OpenAI Images 平台不通过 OPTIONS 猜测协议。 */
export function isKnownOpenAiImagesBaseUrl(value: string): boolean {
  const normalized = value.trim().replace(/\/+$/, '').replace(/\/v1$/i, '').replace(/\/+$/, '').toLowerCase();
  return normalized === 'https://www.fhl.mom'
    || normalized === 'https://fhl.mom'
    || normalized === 'https://sub-proxy-us.65535.space';
}

export const recommendedApis: RecommendedApi[] = [
  {
    id: 'binghuo',
    name: '炳火 API',
    baseUrl: 'https://api.7tai.cc/v1',
    registerUrl: 'https://api.7tai.cc/console/log',
    summary: '统一提供图片、异步视频、LLM 与音频接口的 OpenAI 兼容平台',
    advantages: [
      '图片使用 /v1/images/generations，兼容文生图与参考图生图',
      '视频使用 /v1/video/generations 异步提交与轮询',
      '支持 Seedance、即梦、Wan、MiniMax 等视频模型',
      '支持 Chat Completions 流式输出与长上下文模型',
    ],
    models: [
      'gemini-3-pro-image-preview',
      'gemini-3.1-flash-image-preview',
      'image2k4k',
      'image4k',
      'image2-high',
      'gpt-image-2',
      'by-image1k',
      'by-image2k4k',
      'cf-image4k',
    ],
    videoModels: [
      'bh2.0-fast-480p',
      'bh2.0-fast-720p',
      'bh2.0-480p',
      'bh2.0-720p',
      'bh2.0-1080p',
      'bh2.04K',
      'bh2.0-mini-480p',
      'bh2.0-mini-720p',
      'SD2.0-720P-fast',
      'SD2.0-1080P',
      'sdvip4k',
      'sdvip720p',
      'sdvip1080p',
      'gz-sd480p',
      'gz-sd720p',
      'gz-sd1080p',
      'gz-sd4k',
      'SD2.5-480p',
      'SD2.5-720p',
      'SD2.5-1080p',
      'wan3.0-480p',
      'wan3.0-720p',
      'wan3.0-1080p',
      'tj-wan3-720p',
      'sd2.5-backup',
      'sd2.5-480p-ch1',
      'sd2.5-720p-ch2',
      'gz-sd2.5-480p',
      'gz-sd2.5-720p',
      'gz-sd2.5-1080p',
      'rd2.5-480p',
      'rd2.5-720p',
      'rd2.0-480p',
      'rd2.0-480pfast',
      'rd2.0-720p',
      'rd2.0-1080p',
      'wanneng1.1',
      'doubaofast',
      'minimax-h3-pro-768p',
      'sd2-fast福利',
      'seedance-2.0-480p',
      'SD2.0-720P',
      'sp2.5-720p',
      'sp2.5-720p-15s',
      'sp2.5-720p-30s',
      'tj-sp2.5',
      'sd2.5-720p-ch1',
      'minimax-h3-pro-2k',
      'sd2-福利',
      'B-quannengship2.0',
      'quanneng2.0',
      'sdquan-2-miao',
      'hailuo-h3-2k',
      'quanneng2.0-9tu',
      'video2.0',
      'sd2-vip720p',
      'sd2-vip720p-fast',
      'keling-3',
      'xb-sora2',
      'me-kuaile1.0',
      'sora-2-z',
      'veo-omni-flash',
      'grok-imagine-video-1.5-preview',
      'grok-imagine-video',
    ],
    chatModels: [
      'o3',
      'o4-mini',
      'claude-opus-4-8',
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'deepseek-chat',
      'deepseek-reasoner',
      'minimax-m2',
    ],
    imageConfig: {
      protocol: 'images',
      referenceImageField: 'image',
      referenceImageEncoding: 'url',
      imageTransport: 'generations_json',
    },
    videoConfig: {
      submitPath: '/v1/video/generations',
      queryPath: '/v1/video/generations/{taskId}',
      referenceEncoding: 'url',
      transport: 'binghuo-video',
    },
  },
  {
    id: 'zizidonghua',
    name: '字子动画',
    baseUrl: 'https://www.zizidonghua.com',
    registerUrl: 'https://www.zizidonghua.com/login',
    pricingUrl: 'https://www.zizidonghua.com/pricing',
    summary: '统一视频生成 API，支持文生、首尾帧和参考生视频',
    advantages: [
      '统一使用 /v8/videos/generations 异步接口',
      '支持 Kling、Minimax H3、Seedance 等视频模型',
      '顶层 resolution/aspect_ratio 画幅参数',
      '参考图支持 URL 或 base64，并可标记首尾帧',
    ],
    models: [],
    videoModels: [
      'Kling-1.6',
      'Kling-2.0',
      'Kling-2.1',
      'Kling-2.5',
      'Kling-2.6',
      'Kling-3.0',
      'Kling-3.0-Omni',
      'Kling-O1',
      'zzdh-Minimax-h3-480p',
      'zzdh-Minimax-h3-720p',
      'zzdh-Minimax-h3-1080p',
      'zzdh-Minimax-h3-2k',
      'kling-3.0-omni-720p-noref-mute',
      'kling-3.0-omni-720p-noref-audio',
      'kling-3.0-omni-720p-ref-mute',
      'kling-3.0-omni-720p-ref-audio',
    ],
  },
  {
    id: 'comfly',
    name: 'COMFly',
    baseUrl: 'https://ai.comfly.org',
    registerUrl: 'https://ai.comfly.org/register',
    pricingUrl: 'https://ai.comfly.org/pricing',
    summary: 'OpenAI 兼容中转平台，50+ 模型覆盖图像/视频/LLM',
    advantages: [
      '50+ 领先模型，图像/视频/LLM 全覆盖',
      '100% OpenAI 兼容，接入即用',
      '7×24 稳定在线',
      '按量付费，价格透明',
    ],
    models: ['gpt-image-2-2k', 'nano-banana'],
    videoModels: ['seedance-v2-720p-fast', 'seedance-v2-720p', 'grok-imagine-video-6s', 'Minimax-h3'],
  },
  {
    id: 'exellome',
    name: 'EXELLOME',
    baseUrl: 'https://new.exellome.online',
    registerUrl: 'https://new.exellome.online/register?aff=r2dZ',
    summary: '稳定输出 GPT-Image2 和 Nano Banana 的 2K/4K',
    advantages: ['异步协议长任务稳定', '2K/4K 高清', '预填全系图像模型'],
    models: [
      'gpt-image2-2k',
      'gpt-image2-4k',
      'Nano-Banana-2-2k',
      'Nano-Banana-2-4k',
      'Nano-Banana-Pro-2k',
      'Nano-Banana-Pro-4k',
    ],
  },
  {
    id: 'fhl',
    name: 'FHL',
    baseUrl: 'https://www.fhl.mom/v1',
    registerUrl: 'https://www.fhl.mom/register?aff=86L574B4T2N9',
    summary: '稳定便宜接入 codex / Claude / GPT Image 2 出图',
    advantages: [
      'OpenAI Images 生图直连',
      '预填 gpt-image-2 全系',
      '1K/2K ¥0.04/张',
      '4K ¥0.06/张',
    ],
    models: ['gpt-image-2', 'gpt-image-2-2k', 'gpt-image-2-4k', 'nano-banana'],
    imageConfig: {
      protocol: 'images',
      referenceImageField: 'image',
      referenceImageEncoding: 'data_url',
      imageTransport: 'generations_json',
    },
  },
  {
    id: '65535',
    name: '65535',
    baseUrl: 'https://sub-proxy-us.65535.space/v1',
    registerUrl: 'https://sub-proxy-us.65535.space',
    summary: 'OpenAI Images 兼容生图平台，支持 GPT Image 2 图片模型',
    advantages: [
      'GPT Image 2 使用 /v1/images/generations JSON',
      '返回 data[0].b64_json',
      '预填 gpt-image-2、eco、auto',
      'Gemini 图片编辑使用 /v1/images/edits multipart',
    ],
    models: ['gpt-image-2', 'gpt-image-2-eco', 'gpt-image-2-auto'],
    imageConfig: {
      protocol: 'images',
      referenceImageField: 'image',
      referenceImageEncoding: 'data_url',
      imageTransport: 'auto',
    },
  },
  {
    id: 'sub2api-video',
    name: 'Sub2API 视频',
    baseUrl: 'https://video.rjm.us.ci',
    registerUrl: 'https://video.rjm.us.ci',
    summary: '异步视频任务平台，支持 Seedance 2.0 / 2.5 图片生视频',
    advantages: [
      '提交 /v1/videos 后自动轮询任务状态',
      '本地参考图自动上传为 image_id',
      '使用 ratio 画幅字段与幂等请求键',
      'Seedance 2.0 固定 15 秒，2.5 固定 30 秒，均为 720p',
    ],
    models: [],
    videoModels: ['seedance2.5', 'seedance2.0'],
    videoConfig: {
      submitPath: '/v1/videos',
      queryPath: '/v1/videos/{taskId}',
      referenceEncoding: 'data_url',
      transport: 'sub2api-video',
    },
  },
  {
    id: 'runninghub',
    name: 'RunningHub',
    baseUrl: 'https://www.runninghub.ai',
    registerUrl:
      'https://www.runninghub.ai/enterprise-api/consumerApi?inviteCode=rh-v1331',
    summary: '覆盖图像、视频和 LLM 的 RunningHub OpenAPI',
    advantages: ['图像 / 视频 / LLM 全覆盖', 'Seedance 视频模型', 'OpenAPI 工作流'],
    models: ['nano-banana'],
  },
  {
    id: 'modelscope',
    name: 'ModelScope',
    baseUrl: 'https://api-inference.modelscope.cn/v1',
    registerUrl: 'https://www.modelscope.cn/my/access/token',
    summary: 'ModelScope 提供免费额度和模型广场接入，适合基础图像与 LLM 测试',
    advantages: ['免费额度可用', '需要绑定阿里云账号', '适合基础图像与 LLM 测试'],
    models: [
      'Tongyi-MAI/Z-Image-Turbo',
      'Qwen/Qwen-Image-2512',
      'Qwen/Qwen-Image-Edit-2511',
      'black-forest-labs/FLUX.2-klein-9B',
    ],
  },
];
