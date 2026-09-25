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
  /**
   * `videoModels` 的修订号 —— **每次增删 `videoModels` 都必须 +1**。
   *
   * 平台一旦被添加, 它的模型列表就与预设**脱钩**了(`SettingsDialog` 的
   * `applyRecommendedApi` 优先用 `existing.videoModels`, 刻意不覆盖用户手改过的
   * 列表)。代价是: 之后往预设里新增的端点, **老用户永远看不到**, 只能删掉平台
   * 重新添加 —— 这正是「RunningHub 补了 Seedance 2.5 却仍不显示」的原因。
   *
   * 有了这个号, 启动时会按差集把新增端点**追加**进已添加的平台(见
   * `resolveNewRecommendedVideoModels` 与 `settingsStore.syncRecommendedVideoModels`)。
   *
   * 未声明此字段的平台不参与同步(说明它的清单不由代码维护)。
   */
  videoModelsRevision?: number;
  /** 音频模型（语音合成 / 音色克隆 / 音乐生成），与图片模型分开。 */
  audioModels?: string[];
  /** `audioModels` 的增量同步版本。 */
  audioModelsRevision?: number;
  chatModels?: string[];
  /**
   * 价格区间展示（公开平台表范围，参考即可，非实付价）。
   * - 各分项可选；未填的类别不显示对应 pill。
   * - 字符串已含单位（如 "⚡0.01 ~ 0.17 / 张"），UI 直接渲染。
   * - 区间按 min~max 给出：< 0.01 归 1 档；其它类别用价格表 min~max。
   */
  pricingRange?: {
    image?: string;
    video?: string;
    audio?: string;
  };
  /** 图片协议的明确配置；未声明的平台继续使用通用默认值。 */
  imageConfig?: RecommendedImageConfig;
  /** 视频协议的明确配置；用于异步提交、轮询和参考素材适配。 */
  videoConfig?: RecommendedVideoConfig;
  /**
   * 余额查询方式，决定「已连接」卡片上能不能显示余额：
   * - `openai-billing`：One-API / New-API 系中转站，`/v1/dashboard/billing/subscription`；
   * - `runninghub`：RunningHub 的 `/uc/openapi/accountStatus`（RH 币）。
   *
   * **未声明的平台不显示余额** —— 例如 ModelScope 没有额度接口（实测 404），
   * 宁可不显示，也不要猜一个数字出来。
   */
  balanceKind?: 'runninghub' | 'openai-billing';
}

export interface RecommendedImageConfig {
  protocol: 'images' | 'responses' | 'chat';
  /** 参考图字段名: image / input_image 为单图+多图兼容写法; images 为纯数组写法(知鸟 AI 等); reference_images 为对象数组写法(字子动画等)。 */
  referenceImageField: 'image' | 'input_image' | 'images' | 'reference_images';
  referenceImageEncoding: 'auto' | 'data_url' | 'raw_base64' | 'url';
  imageTransport: 'auto' | 'generations_json' | 'edits_multipart' | 'apimart_json';
}

export interface RecommendedVideoConfig {
  submitPath: string;
  queryPath: string;
  referenceEncoding: 'data_url' | 'raw_base64' | 'url';
  transport:
    | 'sub2api-video'
    | 'binghuo-video'
    | 'wgspai-video'
    | 'zhiniao-video'
    | 'zhenjian-task-api'
    /** RunningHub: 端点本身即模型(`/openapi/v2/{endpoint}`), 参数表随请求注入。 */
    | 'runninghub-model';
}

/** 已确认的 OpenAI Images 平台不通过 OPTIONS 猜测协议。 */
export function isKnownOpenAiImagesBaseUrl(value: string): boolean {
  const normalized = value.trim().replace(/\/+$/, '').replace(/\/v1$/i, '').replace(/\/+$/, '').toLowerCase();
  return normalized === 'https://www.fhl.mom'
    || normalized === 'https://fhl.mom'
    || normalized === 'https://sub-proxy-us.65535.space'
    // 知鸟 AI(TokenGo 网关): /v1/images/generations 为同步 OpenAI Images 协议,
    // 参考图字段是 images 数组, 直接判定为已知 Images 平台可省掉 OPTIONS 探测。
    || normalized === 'https://cuai.token6688.com'
    || normalized === 'https://api.tokengo.love';
}

/**
 * RunningHub 精选视频端点(国际站 / 国内站共用同一份官方目录)。
 *
 * **必须是真实端点 ID** —— RunningHub 里「模型」就是端点, 提交时整串拼在
 * `/openapi/v2/` 之后(`custom:runninghub/kling-v3.0-pro/image-to-video`)。
 * 端点全清单见官方 CLI 的 `catalog/data/capabilities.json`(356 个, 其中视频 198 个),
 * 这里只收主流家族。
 *
 * ⚠️ **目录是静态快照, 会滞后**。CLI 包里那份的 `version` 是 `2026-06-02`, 且
 * `rh model list` 只读本地文件、**没有在线刷新**(源码里不存在目录下载 URL)。
 * 官网 2026-09 的口径是视频 322 / 图像 189 / 音频 47 / 3D 16 个模型, 远多于快照。
 * 因此**目录里查不到某模型 ≠ LenTalk 链路不通** —— 要核最新清单请查官网 API
 * 文档站(runninghub.cn/runninghub-api-doc-cn), Seedance 2.5 就是这样补进来的。
 *
 * **中文名里的「全能视频X」是 RunningHub 的转售代号, 真身在 `name_en` 字段**:
 *   `全能视频S`   → `sora-2`                (OpenAI Sora 2)
 *   `全能视频V3.1` → `google/veo3.1-*`      (Google Veo 3.1)
 *   `全能视频X`   → `xai/grok-imagine`      (xAI Grok Imagine)
 *   `全能视频R`   → `runwayml/gen4-turbo`   (Runway Gen-4 Turbo)
 * 转售用代号是为了规避直接使用厂商商标。LenTalk 的 `label` 一律写**真身名**,
 * 便于与其它平台的同名模型对账、也避免用户看不懂「全能视频S」是什么。
 *
 * 字段名 / 枚举 / 必填默认值由 `@/commands/runningHubProtocol.ts` 随请求注入,
 * 后端 `video_protocols/runninghub.rs` 只按说明装填, 不认识任何具体模型。
 */
const RUNNINGHUB_VIDEO_MODELS: readonly string[] = [
  // Sora 2(转售代号「全能视频S」; 低价渠道版)
  'rhart-video-s/text-to-video',
  'rhart-video-s/image-to-video',
  // Sora 2(官方稳定版)
  'rhart-video-s-official/text-to-video',
  'rhart-video-s-official/image-to-video',
  // Sora 2 Pro(官方稳定版, 画幅走像素串 size)
  'rhart-video-s-official/text-to-video-pro',
  'rhart-video-s-official/image-to-video-pro',
  // Veo 3.1 Pro(转售代号「全能视频V3.1-pro」)
  'rhart-video-v3.1-pro/text-to-video',
  'rhart-video-v3.1-pro/image-to-video',
  // Seedance 2.5(2026-06 后上线, 不在 CLI 目录快照里; 走 Token 计费故端点带 -token)
  'bytedance/seedance-2.5-token/text-to-video',
  'bytedance/seedance-2.5-token/image-to-video',
  'bytedance/seedance-2.5-token/multimodal-video',
  // Seedance 2.0(低价渠道版, 端点路径里带一组 sparkvideo-2.0)
  'rhart-video/sparkvideo-2.0/text-to-video',
  'rhart-video/sparkvideo-2.0/image-to-video',
  'rhart-video/sparkvideo-2.0-mini/text-to-video',
  'rhart-video/sparkvideo-2.0-mini/image-to-video',
  // 可灵 3.0-pro / 3.0-std / 2.6-pro / o3-pro
  'kling-v3.0-pro/text-to-video',
  'kling-v3.0-pro/image-to-video',
  'kling-v3.0-std/text-to-video',
  'kling-v3.0-std/image-to-video',
  'kling-v2.6-pro/text-to-video',
  'kling-v2.6-pro/image-to-video',
  'kling-video-o3-pro/text-to-video',
  'kling-video-o3-pro/image-to-video',
  // Seedance 1.5-pro
  'seedance-v1.5-pro/text-to-video',
  'seedance-v1.5-pro/image-to-video',
  // 海螺 02 / 2.3-fast(注意 02 文生的端点名不带 text-to-video)
  'minimax/hailuo-02/t2v-pro',
  'minimax/hailuo-2.3-fast/image-to-video',
  'minimax/hailuo-h3/text-to-video',
  'minimax/hailuo-h3/image-to-video',
  'minimax/hailuo-h3/multimodal-to-video',
  // Vidu q3-pro
  'vidu/text-to-video-q3-pro',
  'vidu/image-to-video-q3-pro',
  'vidu/reference-to-video-q3',
  'vidu/reference-to-video-q3-drama',
  // 万相 2.7
  'alibaba/wan-2.7/text-to-video',
  'alibaba/wan-2.7/image-to-video',
  'alibaba/wan-3.0/image-to-video',
  'alibaba/wan-3.0-prime/image-to-video',
  'alibaba/wan-3.0/reference-to-video',
  'alibaba/wan-3.0-prime/reference-to-video',
  // 多图参考与数字人口播
  'kling-video-o3-pro/reference-to-video',
  'rhart-video-v3.1-pro-official/reference-to-video',
  'rhart-video-g-official/reference-to-video-v1.5',
  'kling-v2-ai-avatar-pro/image-audio-to-video',
  'kling-v2-ai-avatar-standard/image-audio-to-video',
];

/** RunningHub 标准音频端点, 由 AI 音频节点通过同一套 OpenAPI v2 任务协议提交。 */
const RUNNINGHUB_AUDIO_MODELS: readonly string[] = [
  'indextts2_clone',
  'rhart-audio/text-to-audio/speech-2.8-turbo',
  'rhart-audio/text-to-audio/speech-2.8-hd',
  'bytedance/doubao-seed-tts-2.0',
  'minimax/music-2.6/text-to-music',
  'minimax/music-2.6/text-to-instrumental',
  'rhart-audio/suno-v5.5/single',
  'rhart-audio/suno-v5.5/custom',
];

export const recommendedApis: RecommendedApi[] = [
  {
    id: 'zhiniao',
    name: '知鸟AI',
    baseUrl: 'https://cuai.token6688.com',
    registerUrl: 'https://cuai.token6688.com/signup?ref=C53QQRYBP563YEPD',
    summary: 'TokenGo 网关: 语言/图片/视频/音频统一 OpenAI 兼容入口, 密钥 sk- 开头',
    // TokenGo 是 One-API 系网关, 支持标准额度查询接口(实测未授权时返回 401 而非 404)。
    balanceKind: 'openai-billing',
    advantages: [
      '语言模型统一走 /v1/chat/completions, 换 model 即可切换厂商',
      '视频走 /v1/videos/generations 扁平入参, 轮询 /v1/tasks/{task_id}',
      '图片走 /v1/images/generations, 参考图字段为 images(URL 数组)',
      '本地参考素材自动上传 /v1/files 换取公网 URL 后提交',
      '支持 Seedance 2.5 / Veo / Sora / 可灵 / MiniMax / Wan 等视频模型',
    ],
    models: [
      'gpt-image-2.5-sunburst',
      'gpt-image-2.5-flare',
      'gpt-image-2',
      'gpt-image-2-official',
      'gpt-image-2-c',
      'gpt-image-1.5-all',
      'gemini-3-pro-image',
      'gemini-3.1-flash-image',
      'gemini-3.1-flash-lite-image',
      'doubao-seedream-5-0-pro',
      'doubao-seedream-5-0',
      'doubao-seedream-4-5',
      'qwen-image-3.0',
      'qwen-image-2.0',
      'wan2.7-image',
      'flux-2',
      'flux-kontext',
      'grok-imagine-image-2.0',
      'grok-imagine-image',
      'mj_imagine',
      'aliyun-image-superres',
      'face-repaint',
    ],
    videoModels: [
      'seedance-2-5',
      'seedance-2-5-promo',
      'seedance-2-5-special',
      'seedance-2-0-official',
      'seedance-2-0-promo',
      'seedance-2-0-ecom-special',
      'seedance-2-0-9tu-special',
      'veo-3.1',
      'veo-4-omni',
      'sora-2-official',
      'kling-v3',
      'kling-v3-omni-cankao',
      'kling-v3-motion-control',
      'kling-3.0-turbo',
      'minimax-h3',
      'minimax-hailuo-2-3',
      'wan-3-0',
      'wan-2-6',
      'wan2.7-video',
      'grok-imagine-1.5',
      'grok-imagine-video',
      'omni-flash-1-1',
      'pixverse-v6',
      'viduq3',
      'happyhorse-1-1',
      'doubao-seedance-1-5-pro',
      'aliyun-video-superres',
    ],
    chatModels: [
      'gpt-6-astra',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3-codex',
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-sonnet-5',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
      'gemini-3.1-pro',
      'gemini-3.8-flash',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'kimi-k3',
      'glm-5.3',
      'qwen3.8-max',
      'doubao-seed-2-0-pro',
      'minimax-m3',
      'grok-4.6',
      'grok-4.5',
    ],
    audioModels: [
      'speech-2.8',
      'voice-design',
      'voice-clone',
      'gpt-4o-mini-tts',
      'tts-1-hd',
      'tts-1',
      'gemini-3.1-flash-tts',
      'gemini-2.5-pro-tts',
      'music',
    ],
    imageConfig: {
      protocol: 'images',
      referenceImageField: 'images',
      referenceImageEncoding: 'url',
      imageTransport: 'generations_json',
    },
    videoConfig: {
      submitPath: '/v1/videos/generations',
      queryPath: '/v1/tasks/{taskId}',
      referenceEncoding: 'url',
      transport: 'zhiniao-video',
    },
    // 公开价格表（2026-09-13 拉自 https://cuai.token6688.com/api/v1/models）：
    //   图片 24 个模型: min ⚡0.0056 (aliyun-image-superres) ~ max ⚡0.1687 (gpt-image-2-official)
    //   视频 49 个模型: min ⚡0.0009 (aliyun-video-superres) ~ max ⚡1.36   (kling-3.0-turbo)
    //   音频 9 个模型 : min ⚡0      (tts-1-hd 限时免费)   ~ max ⚡2.2    (voice-clone; 停服已剔除)
    // < 0.01 全部归一为 0.01（min 与 max 都按此规则），是平台积分标价、不是实付价。
    pricingRange: {
      image: '⚡0.01 ~ 0.17 / 张',
      video: '⚡0.01 ~ 1.36 / 次',
      audio: '⚡0.01 ~ 2.2 / 次',
    },
  },
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
    id: 'wgspai',
    name: 'WGSPAI 视频',
    baseUrl: 'https://api.wgspai.cn',
    registerUrl: 'https://api.wgspai.cn',
    summary: '同一个 Base 下提供两族视频接口：Videos 族同步提交、Task 族统一异步任务',
    advantages: [
      'Videos 族 POST /v1/videos 提交、GET /v1/videos/{id} 轮询（Seedance 2.5、Seedance v2 720p、MiniMax H3）',
      'Task 族 POST /v1/task/create 提交、GET /v1/task/{id} 轮询（sd-2 / sora2-pro / veo31 / ltx2.3 等）',
      '参考素材上限按模型区分：Seedance 2.5 图 30 张、Seedance v2 系 9 图 / 3 音频 / 3 视频、MiniMax H3 仅图 9 张',
      '本地素材自动上传官方背景机图床换取公网 URL，无需手动转存',
      '提示词里的 @图N / @音频N 引用会自动翻成该模型认的写法（@图片N 或 [imageN] / [audio_1]）',
    ],
    models: [],
    videoModels: [
      // ── Videos 族（seedance2.5 / seedance-v2-720p / minimax-h3 三份专档）──
      'seedance2.5',
      'seedance-v2-720p',
      'seedance-v2-720p-video',
      'Minimax-h3',
      // ── Task 族（总览文档「异步 · 视频类任务」一节）──
      'seedance-v2-1080p',
      'sd-2',
      'sd-2-vip',
      'LongXia-O-sora2-pro-8s-9x16',
      'LongXia-O-sora2-pro-12s-16x9',
      'LongXia-A-veo31-8s-16x9-1080p',
      'ltx2.3',
      'VEO-3.1',
      'flashvsr-restore',
      'voice-clone',
      // ── 站点实际提供但四份文档未列出的型号，保持可用 ──
      'seedance-v2.5-1080p',
      'hf-seedance-2.5-1080p',
      'grok-imagine-video-6s',
    ],
    videoConfig: {
      submitPath: '/v1/videos',
      queryPath: '/v1/videos/{taskId}',
      referenceEncoding: 'url',
      transport: 'wgspai-video',
    },
  },
  {
    id: 'zizidonghua',
    name: '字子动画',
    baseUrl: 'https://www.zizidonghua.com',
    registerUrl: 'https://www.zizidonghua.com/login',
    pricingUrl: 'https://www.zizidonghua.com/pricing',
    summary: '图片 / 视频 / 音频 / 对话全链路专有接入, 视频走异步任务 + 轮询',
    advantages: [
      '视频统一 POST /v8/videos/generations, 轮询 GET /v8/videos/generations/{taskId}',
      '顶层 resolution / aspect_ratio 画幅参数, 画幅枚举 16:9 / 9:16 / 1:1',
      '参考图用 reference_images 对象数组, 可标记首帧 / 尾帧 / 参考图',
      'Minimax H3 分辨率锁在模型名里(480p/720p/1080p/2k/4k), 其余模型用 resolution',
      '图片走 OpenAI 兼容 /v1/images/generations',
      '音频按模型名分流 speech / sound-effects / music 三个端点, 直接返回音频字节',
      '提交被拒绝的请求不扣费, 失败任务会退款',
    ],
    models: [
      'z-image-turbo',
      'zimage',
      'Omni-Nano',
      'Omni-Nano-pro',
      'Omni-Nano-pro-1K',
      'Omni-Nano-pro-2K',
      'Omni-Nano-pro-vip-1K',
      'Omni-Nano-pro-vip-2K',
      'Omni-Image2',
      'Omni-Image2-pro',
      'qwen-image-2.0',
      'qwen-image-2.0-pro',
      'qwen-image-3.0',
      'qwen-image-3.0-pro-1k',
      'qwen-image-3.0-pro-2k',
      'qwen-image-max',
      'qwen-image-edit-max',
      'doubao-seedream-5-0-260128',
      'gpt-image-2.5-flare',
      'gpt-image-2.5-sunburst',
    ],
    videoModels: [
      'zzdh-Minimax-h3-480p',
      'zzdh-Minimax-h3-720p',
      'zzdh-Minimax-h3-1080p',
      'zzdh-Minimax-h3-2k',
      'zzdh-Minimax-h3-4k',
      'zzdh-minimax-h3-限时优惠-文生-480p',
      'zzdh-minimax-h3-限时优惠-文生-768p',
      'zzdh-minimax-h3-限时优惠-首尾帧-480p',
      'zzdh-minimax-h3-限时优惠-首尾帧-768p',
      'zzdh-minimax-h3-限时优惠-多参考图生-480p',
      'zzdh-minimax-h3-限时优惠-多参考图生-768p',
      'zzdh-minimax-h3-限时优惠-多图多音频-480p',
      'zzdh-minimax-h3-限时优惠-多图多音频-768p',
      'zzdh-minimax-h3-限时优惠-对口型-480p',
      'zzdh-minimax-h3-限时优惠-对口型-768p',
      'doubao-seedance-2-480p',
      'doubao-seedance-2-720p',
      'doubao-seedance-2-1080p',
      'doubao-seedance-2-4k',
      'doubao-seedance-2-video-480p',
      'doubao-seedance-2-video-720p',
      'doubao-seedance-2-video-1080p',
      'doubao-seedance-2-video-4k',
      'doubao-seedance-2-优惠版-720p',
      'doubao-seedance-2-优惠版-1080p',
      'doubao-seedance-2-video-优惠版-720p',
      'doubao-seedance-2-video-优惠版-1080p',
      'doubao-seedance-2-0-fast-480p',
      'doubao-seedance-2-0-fast-720p',
      'doubao-seedance-2-0-fast-video-480p',
      'doubao-seedance-2-0-fast-video-720p',
      'doubao-seedance-2-0-mini-480p',
      'doubao-seedance-2-0-mini-720p',
      'doubao-seedance-2-0-mini-video-480p',
      'doubao-seedance-2-0-mini-video-720p',
      'doubao-seedance-2-5-480p',
      'doubao-seedance-2-5-720p',
      'doubao-seedance-2-5-video-480p',
      'doubao-seedance-2-5-video-720p',
      'wan3.0-t2v-480p',
      'wan3.0-t2v-720p',
      'wan3.0-t2v-1080p',
      'wan3.0-i2v-480p',
      'wan3.0-i2v-720p',
      'wan3.0-i2v-1080p',
      'wan3.0-r2v-480p',
      'wan3.0-r2v-720p',
      'wan3.0-r2v-1080p',
      'wan3.0-prime-t2v-480p',
      'wan3.0-prime-t2v-720p',
      'wan3.0-prime-t2v-1080p',
      'wan3.0-prime-i2v-480p',
      'wan3.0-prime-i2v-720p',
      'wan3.0-prime-i2v-1080p',
      'wan3.0-prime-r2v-480p',
      'wan3.0-prime-r2v-720p',
      'wan3.0-prime-r2v-1080p',
      'wan2.7-t2v',
      'wan2.7-i2v',
      'wan2.7-r2v',
      'wan2.7-videoedit',
      'wan2.6-i2v',
      'wan2.6-i2v-flash',
      'wan2.6-r2v',
      'wan2.2-i2v-plus',
      'wan2.2-kf2v-flash',
      'happyhorse-1.0-t2v-720p',
      'happyhorse-1.0-t2v-1080p',
      'happyhorse-1.0-i2v-720p',
      'happyhorse-1.0-i2v-1080p',
      'happyhorse-1.0-r2v-720p',
      'happyhorse-1.0-r2v-1080p',
      'happyhorse-1.0-video-edit-720p',
      'happyhorse-1.0-video-edit-1080p',
      'kling-v3-omni',
    ],
    audioModels: [
      'eleven_multilingual_v2',
      'eleven_multilingual_v1',
      'eleven_flash_v2',
      'eleven_flash_v2_5',
      'eleven_turbo_v2',
      'eleven_turbo_v2_5',
      'eleven_monolingual_v1',
      'eleven_v3',
      'indextts2-v1',
      'eleven_text_to_sound_v2',
      'eleven_music_v1',
      'eleven_music_v2',
      'music-2.6',
      'music-2.6-free',
      'music-cover',
      'music-cover-free',
    ],
    chatModels: [
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'deepseek-v4-flash-vision-exp',
      'glm-5',
      'glm-5.1',
      'kimi-k3',
      'kimi-k2.5',
      'Moonshot-Kimi-K2-Instruct',
      'kimi-k2.7-code',
      'qwen3.8-max',
      'qwen3.7-max',
      'qwen3.7-plus',
      'qwen3.6-plus',
      'qwen3.5-plus',
      'qwq-plus',
      'qwen-vl-max',
      'qwen-vl-ocr',
      'qwen3-vl-plus',
      'qwen-flash-character',
      'gpt-6-astra',
      '字字语言模型-O',
      'xiaomi/mimo-v2.5-pro',
    ],
    imageConfig: {
      protocol: 'images',
      // 官方模型页的参考图字段是对象数组 [{url, role}], 与视频链路同一套素材写法。
      referenceImageField: 'reference_images',
      // 平台没有文件上传接口, 本地素材只能以 data URL 内联提交。
      referenceImageEncoding: 'auto',
      imageTransport: 'auto',
    },
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
  // RunningHub 分国际站 / 国内站两条独立预设 —— 两者是**不同的站点与账号体系**,
  // Base URL 不同、注册链接不同, 用户按网络情况各取所需。
  //
  // 它跟别家的链路根本不同: RunningHub **没有 OpenAI 兼容的模型列表接口**
  // (`GET /v1/models` 实测带有效 Key 仍是 401 空体), 也**不是「固定端点 + 一堆字段」**
  // —— 每个模型就是一个端点, `POST /openapi/v2/{endpoint}` 里的 `{endpoint}` 本身即
  // 模型 ID, 而且**每个端点的参数 schema 都不一样**: 参考图字段有的是 `imageUrl`,
  // 有的是 `firstImageUrl` + `lastImageUrl`, Seedance 2.0 是 `firstFrameUrl` +
  // `lastFrameUrl`; 画幅字段有的是 `aspectRatio`, 有的是 `ratio`, 万能视频S 官方版
  // 直接收像素串 `size`(`720x1280`)。还有一批必填但不由用户驱动的固定参数
  // (可灵的 `sound` / `shotType`, 海螺的 `enablePromptExpansion`, Vidu 的 `style`)。
  // 平台对 schema 外的字段回 `PARAMS_INVALID` 而**不是忽略**, 所以拿一份通用字段表
  // 硬套必然失败 —— 参数表只能逐端点对齐, 这就是 `runningHubProtocol.ts` 存在的理由。
  //
  // 图像端点仍未接入标准图像节点，暂不填无效图像模型；音频端点已接入标准
  // RunningHub v2 任务协议，IndexTTS2.5 继续走既有 AI App 工作流。
  {
    id: 'runninghub',
    name: 'RunningHub 国际版',
    baseUrl: 'https://www.runninghub.ai',
    registerUrl: 'https://www.runninghub.ai?inviteCode=gg6f774v',
    summary: 'RunningHub 国际站(runninghub.ai): 每个模型即一个 OpenAPI 端点, 覆盖可灵 / Seedance / Vidu / 万相 / 海螺',
    // RH 币余额走 /uc/openapi/accountStatus(.ai 与 .cn 接口一致)。
    balanceKind: 'runninghub',
    advantages: [
      '国际站 runninghub.ai',
      '视频主流端点: Sora 2、Veo 3.1 Pro、Seedance 2.5 / 2.0 Mini / 1.5-pro、可灵 3.0-pro / 3.0-std / 2.6-pro / o3-pro、海螺 02 / H3、Vidu Q3、万相 2.7 / 3.0',
      '模型名用真身: RunningHub 官网的「全能视频S」即 Sora 2,「全能视频V3.1」即 Veo 3.1',
      '文生视频与图生视频各自独立成端点, 参数按官方 schema 逐个对齐, 不混发陌生字段',
      '本地参考图自动上传 (media/upload/binary) 换取公网 URL 后提交',
      '提交即落库, 关掉窗口 / 切页 / 重启后仍能续查, 不会白扣费',
      '新用户注册赠 500 RH 币',
    ],
    models: [],
    audioModels: [...RUNNINGHUB_AUDIO_MODELS],
    audioModelsRevision: 2,
    videoModels: [...RUNNINGHUB_VIDEO_MODELS],
    // 修订号: 3 = 补进 Seedance 2.5 图生/多模态、H3、万相 3.0、Vidu/Kling 多模态端点，
    // 并移除官方文档目录中已下架的 Seedance 2.0 Global 别名。
    videoModelsRevision: 3,
    videoConfig: {
      submitPath: '/openapi/v2/{endpoint}',
      queryPath: '/openapi/v2/query',
      referenceEncoding: 'url',
      transport: 'runninghub-model',
    },
  },
  {
    id: 'runninghub-cn',
    name: 'RunningHub 国内版',
    baseUrl: 'https://www.runninghub.cn',
    registerUrl: 'https://www.runninghub.cn?inviteCode=0cthsuca',
    summary: 'RunningHub 国内站(runninghub.cn): 每个模型即一个 OpenAPI 端点, 覆盖可灵 / Seedance / Vidu / 万相 / 海螺',
    // RH 币余额走 /uc/openapi/accountStatus(.ai 与 .cn 接口一致)。
    balanceKind: 'runninghub',
    advantages: [
      '国内站 runninghub.cn, 直连无需代理',
      '视频主流端点: Sora 2、Veo 3.1 Pro、Seedance 2.5 / 2.0 Mini / 1.5-pro、可灵 3.0-pro / 3.0-std / 2.6-pro / o3-pro、海螺 02 / H3、Vidu Q3、万相 2.7 / 3.0',
      '模型名用真身: RunningHub 官网的「全能视频S」即 Sora 2,「全能视频V3.1」即 Veo 3.1',
      '文生视频与图生视频各自独立成端点, 参数按官方 schema 逐个对齐, 不混发陌生字段',
      '本地参考图自动上传 (media/upload/binary) 换取公网 URL 后提交',
      '提交即落库, 关掉窗口 / 切页 / 重启后仍能续查, 不会白扣费',
      '新用户注册赠 500 RH 币',
    ],
    models: [],
    audioModels: [...RUNNINGHUB_AUDIO_MODELS],
    audioModelsRevision: 2,
    videoModels: [...RUNNINGHUB_VIDEO_MODELS],
    // 修订号: 3 = 补进 Seedance 2.5 图生/多模态、H3、万相 3.0、Vidu/Kling 多模态端点，
    // 并移除官方文档目录中已下架的 Seedance 2.0 Global 别名。
    videoModelsRevision: 3,
    videoConfig: {
      submitPath: '/openapi/v2/{endpoint}',
      queryPath: '/openapi/v2/query',
      referenceEncoding: 'url',
      transport: 'runninghub-model',
    },
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
  {
    id: 'zhenjian',
    name: '帧间 API',
    baseUrl: 'https://www.zhenjian.work',
    registerUrl: 'https://www.zhenjian.work/',
    pricingUrl: 'https://www.zhenjian.work/api-docs',
    summary: '图片 / 视频统一异步任务 API，按官方模型列表动态选择模型',
    advantages: [
      '图片生成与编辑分别走 /v1/images/generations、/v1/images/edits',
      '视频走 /v1/videos，统一轮询 /v1/tasks/{task_id}',
      '参考图片、视频、音频先上传 /v1/assets，再提交 asset id',
      '结果下载自动携带 API Key 并落地到桌面端文件',
    ],
    // 平台模型经常动态变化，不在客户端硬编码模型名称；添加后点击“拉取模型”即可选择。
    models: [],
    videoModels: [],
    imageConfig: {
      protocol: 'images',
      referenceImageField: 'image',
      referenceImageEncoding: 'auto',
      imageTransport: 'generations_json',
    },
    videoConfig: {
      submitPath: '/v1/videos',
      queryPath: '/v1/tasks/{taskId}',
      referenceEncoding: 'data_url',
      transport: 'zhenjian-task-api',
    },
  },
];

/**
 * 「密钥 → 推荐平台」界面允许展示的推荐平台 id。
 *
 * 只影响**是否渲染卡片**，不影响链路：
 * - 未列出的条目仍完整保留在 `recommendedApis` 中，`nodePriceBadge` 的价格区间兜底、
 *   以及 `recommendedApis.find(api => api.baseUrl === custom.baseUrl)` 之类的按
 *   Base URL 匹配继续可用；
 * - 平台链路本身由 Base URL 判定（`registry.ts` 的 isZhiniao / isZzdh / isSub2Api、
 *   `videoProfiles.ts`、`tauriAiGateway.ts`、`commands/ai.ts`），与推荐列表无关，
 *   因此在「自定义平台」里手工新增同名/同 Base URL 的平台依旧会命中对应链路。
 */
export const visibleRecommendedApiIds: readonly string[] = [
  'zhiniao',
  'runninghub',
  'runninghub-cn',
  'modelscope',
];

/** 按白名单过滤出需要在设置界面展示的推荐平台（隐藏 ≠ 删除配置）。 */
export function listVisibleRecommendedApis(
  all: readonly RecommendedApi[] = recommendedApis,
): RecommendedApi[] {
  const allow = new Set(visibleRecommendedApiIds);
  return all.filter((api) => allow.has(api.id));
}

/**
 * 归一化 Base URL 用于「这个推荐平台连上了没」的比较。
 *
 * 各家文档给的 baseUrl 带不带 `/v1` 不一致（ModelScope 带、RunningHub 不带），
 * 用户手填时也常省掉后缀，所以比较前一律：去空白 → 去尾斜杠 → 剥掉 `/v1` → 转小写。
 * 不这么做的话，同一个平台会因为一个后缀被判成"未连接"，卡片永远不够绿。
 */
export function normalizeRecommendedBaseUrl(value: string): string {
  return value
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/v1$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * 按 Base URL 反查它属于哪个推荐平台。
 *
 * 用途：把用户已经配好的自定义平台 / 内置平台映射回推荐卡片，据此渲染
 * 「已连接」徽章与「移除」按钮，不必再让用户去下面的自定义平台列表里对。
 * 匹配不到（自己手填的第三方平台）返回 undefined。
 */
export function findRecommendedApiByBaseUrl(
  baseUrl: string,
  all: readonly RecommendedApi[] = recommendedApis,
): RecommendedApi | undefined {
  const target = normalizeRecommendedBaseUrl(baseUrl);
  if (!target) {
    return undefined;
  }
  return all.find((api) => normalizeRecommendedBaseUrl(api.baseUrl) === target);
}

/**
 * 找出「预设里新增、而平台配置里还没有」的视频端点。
 *
 * 平台添加后模型列表就与预设脱钩了(用户可能手改过), 所以预设的更新**只能增量
 * 追加**, 不能整体覆盖。语义:
 *
 * - **只追加**, 不删除、不重排 —— 用户手加的端点与调整过的顺序全部保留;
 * - `syncedRevision >= 预设当前 revision` 时返回 `null` —— 所以补完之后用户手动
 *   删掉某个预设端点, **不会被反复加回来**;
 * - `syncedRevision` 为 `undefined`(从未同步, 即老用户)时补「预设 − 已有」的差集,
 *   这是一次性动作: 补完即写入 revision, 之后按上面的规则静止;
 * - 预设没有 `videoModelsRevision` / `videoModels` 时返回 `null` —— 清单不由代码
 *   维护的平台不参与同步。
 *
 * 返回值里 `models` 可能为空数组, 此时调用方仍应把 `revision` 落库(表示「已对齐」)。
 */
export function resolveNewRecommendedVideoModels(
  baseUrl: string,
  existingVideoModels: readonly string[],
  syncedRevision: number | undefined,
): { models: string[]; revision: number } | null {
  const preset = findRecommendedApiByBaseUrl(baseUrl);
  const revision = preset?.videoModelsRevision;
  const presetModels = preset?.videoModels;
  if (revision === undefined || !presetModels || presetModels.length === 0) {
    return null;
  }
  if (syncedRevision !== undefined && syncedRevision >= revision) {
    return null;
  }
  const known = new Set(existingVideoModels.map((model) => model.trim().toLowerCase()));
  const models = presetModels.filter((model) => !known.has(model.trim().toLowerCase()));
  return { models, revision };
}
