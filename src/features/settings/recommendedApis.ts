// ---------------------------------------------------------------------------
// 推荐平台(参考 Infinite Canvas 的 API 设置推荐列表,精简为图像相关字段)
// 点「添加」→ 预填名称 / Base URL / 模型,保存后即可使用
// ---------------------------------------------------------------------------

export interface RecommendedApi {
  id: string;
  name: string;
  baseUrl: string;
  registerUrl: string;
  summary: string;
  advantages: string[];
  models: string[];
}

export const recommendedApis: RecommendedApi[] = [
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
];
