// ---------------------------------------------------------------------------
// 推荐平台(参考 Infinite Canvas 的 API 设置推荐列表,精简为图像相关字段)
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
}

export const recommendedApis: RecommendedApi[] = [
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
    id: 'wgspai',
    name: 'WGSPAI',
    baseUrl: 'https://api.wgspai.cn',
    registerUrl: 'https://api.wgspai.cn/pricing',
    pricingUrl: 'https://api.wgspai.cn/pricing',
    summary: 'OpenAI 兼容平台，图像与视频模型价格有竞争力',
    advantages: [
      'GPT Image 2K ¥0.10/次',
      'Seedance V2 720p Fast ¥0.17/秒起',
      'Minimax H3 ¥1.50/次',
      '视频生成价格优势',
    ],
    models: ['gpt-image-2-2k'],
    videoModels: ['seedance-v2-720p-fast', 'seedance-v2-720p', 'grok-imagine-video-6s', 'Minimax-h3'],
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
    id: 'tudou',
    name: '土豆API',
    baseUrl: 'https://api.ai-tudou.net',
    registerUrl: 'https://api.ai-tudou.net/register?aff=GmBu',
    summary: '支持 LLM、图像和视频模型的一站式中转',
    advantages: ['Grok 图像专属', '异步视频模型预设', '预填全系图像模型'],
    models: [
      'gpt-image-2-1k',
      'gpt-image-2-2k',
      'gpt-image-2-4k',
      'gemini-3.1-flash-image-preview',
      'gemini-3-pro-image-preview',
      'grok-imagine-image',
      'grok-imagine-image-pro',
      'grok-imagine-image-edit',
    ],
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
    baseUrl: 'https://www.fhl.mom',
    registerUrl: 'https://www.fhl.mom/register?aff=86L574B4T2N9',
    summary: '稳定便宜接入 codex / Claude / GPT Image 2 出图',
    advantages: ['OpenAI Images 生图直连', '预填 gpt-image-2 全系', '价格实惠'],
    models: ['gpt-image-2', 'gpt-image-2-2k', 'gpt-image-2-4k', 'nano-banana'],
  },
  {
    id: 'vip-gpt',
    name: 'VIP-GPT',
    baseUrl: 'https://www.vip-gpt.net',
    registerUrl: 'https://www.vip-gpt.net/vip-gpt/register?aff=YGMS7BDKNY5Y',
    summary: 'OpenAI 兼容接入,保存 Key 后一键拉取模型',
    advantages: ['预填官方请求地址', '拉取模型自动导入', 'GPT / Claude 全系'],
    models: [],
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
