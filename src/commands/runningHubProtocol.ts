/**
 * RunningHub 标准模型 API 协议(runninghub.cn / runninghub.ai)。
 *
 * ## 为什么需要这个模块
 *
 * RunningHub **没有 OpenAI 兼容的模型列表接口**(`GET /v1/models` 实测带有效 Key
 * 仍返回 401 空 body; `POST /openapi/v2/models` 回 `code:1001 Invalid URL`),
 * 所以设置页的「拉取模型」对它永远不可能成功 —— 那条 401 是「路径不存在」,
 * 不是「Key 不对」。**它的模型目录只存在于官方 CLI 内置的 capabilities.json 里**
 * (356 个端点, 其中 video 198 个), 因此这里内置一份**精选主流**的快照。
 *
 * ## 协议形状(已实测)
 *
 * - 提交: `POST {base}/openapi/v2/{endpoint}`, body 就是**该端点自己的参数字典**
 *   (如 `{prompt, imageUrl, duration, aspectRatio}`), `Authorization: Bearer <key>`;
 *   响应是统一任务信封 `{taskId, status, errorCode, errorMessage, results, clientId}`。
 * - 轮询: `POST {base}/openapi/v2/query` body `{"taskId": "..."}` → 同一个信封,
 *   `status: SUCCESS` 时 `results[].url` 是成片地址。
 * - 素材: `POST {base}/openapi/v2/media/upload/binary`(字段 `file`)换公网 URL。
 *   **视频端点的参考图必须走上传**, 平台要求公网可访问地址。
 * - 鉴权: Bearer(`rh check` 实测通过: 「API Key 可用, 但余额为 0」)。
 *
 * ## 与后端的耦合
 *
 * 后端 `src-tauri/src/ai/providers/video_protocols/runninghub.rs` 只做「按字段映射
 * 装填 + 提交 + 轮询」, **不认识具体模型**。端点 ID 与字段映射通过
 * `extra_params.runninghub_video` 传过去(`runningHubVideoExtraParams`), 因此本文件
 * 是模型知识的**唯一权威** —— 新增模型只改这里。
 */

/** 与后端 `runninghub.rs` 的 `TRANSPORT` 常量必须一致。 */
export const RUNNINGHUB_VIDEO_TRANSPORT = 'runninghub-model';

/** 端点根前缀(与 Base URL 拼接)。 */
export const RUNNINGHUB_API_PREFIX = '/openapi/v2';
/** 查询通道: POST `{taskId}`。 */
export const RUNNINGHUB_QUERY_PATH = '/openapi/v2/query';
/** 素材上传通道: multipart 字段名 `file`。 */
export const RUNNINGHUB_UPLOAD_PATH = '/openapi/v2/media/upload/binary';

/** 平台名, 用于错误文案前缀。 */
export const RUNNINGHUB_LABEL = 'RunningHub';

/**
 * RunningHub 端点 ID 的形状: `<family>/<task>`, family 里可能再带一层斜杠
 * (如 `rhart-video/sparkvideo-2.0/text-to-video`、`minimax/hailuo-02/t2v-pro`)。
 * 因此**不能**按斜杠数量解析, 只能整串比对 / 前缀匹配。
 */
export function isRunningHubBaseUrl(baseUrl?: string): boolean {
  const normalized = (baseUrl ?? '').trim().toLowerCase();
  if (!normalized) return false;
  // 必须比对**主机名**而不是子串: `runninghub.cn.evil.com` 这种伪装域名会命中
  // 朴素的 `includes('runninghub.cn')`, 把请求连同 Bearer Key 一起送到别人服务器。
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(normalized)
    ? normalized
    : `https://${normalized}`;
  let host: string;
  try {
    host = new URL(withScheme).hostname;
  } catch {
    return false;
  }
  return (
    host === 'runninghub.cn'
    || host.endsWith('.runninghub.cn')
    || host === 'runninghub.ai'
    || host.endsWith('.runninghub.ai')
  );
}

// ---------------------------------------------------------------------------
// 端点目录
// ---------------------------------------------------------------------------

export type RunningHubVideoTask =
  | 'text-to-video'
  | 'image-to-video'
  | 'reference-to-video'
  | 'multimodal-video'
  | 'audio-to-video';

/**
 * 用户可驱动字段的**平台侧键名**。缺省表示该端点在官方 schema 里没有这个参数,
 * 构建请求体时会整键省略 —— 发一个 schema 之外的字段, 平台会回 `PARAMS_INVALID`。
 */
export interface RunningHubVideoFields {
  prompt?: string;
  /** 首帧 / 唯一参考图。 */
  image?: string;
  /** 尾帧(仅 image-to-video 且官方支持时存在)。 */
  lastImage?: string;
  /** 多图参考数组，例如 `imageUrls` / `referenceImages`。 */
  imageList?: string;
  /** 单个参考视频，例如 Kling O3 的 `videoUrl`。 */
  video?: string;
  /** 多视频参考数组，例如 `videoUrls`。 */
  videoList?: string;
  /** 单个参考音频，例如数字人口播的 `audioUrl`。 */
  audio?: string;
  /** 多音频参考数组，例如 `audioUrls`。 */
  audioList?: string;
  negativePrompt?: string;
  duration?: string;
  /** `aspectRatio` / `ratio` 直接收比例串; `size` 收 `720x1280` 这种像素串。 */
  ratio?: string;
  ratioKind?: 'ratio' | 'size';
  resolution?: string;
}

export interface RunningHubVideoEndpoint {
  /** 官方端点 ID, 也是模型下拉里的值。 */
  endpoint: string;
  /** 下拉展示名(取自官方 `name_cn`)。 */
  label: string;
  task: RunningHubVideoTask;
  fields: RunningHubVideoFields;
  /** 官方 `duration` 允许的秒数; **空数组 = 自由整数**(INT 型参数, 无枚举)。 */
  durations: number[];
  /** LIST 型 duration 收字符串(平台口径), INT 型收数字。 */
  durationType: 'string' | 'number';
  /** 比例下拉选项(UI 口径)。 */
  ratios: string[];
  /** 独立分辨率字段的选项; 空数组 = 该端点没有这个字段。 */
  resolutions: string[];
  /** 数组字段的官方上限。未声明时按视频节点的保守上限处理。 */
  maxImages?: number;
  maxVideos?: number;
  maxAudios?: number;
  /**
   * 官方 schema 里**必填但不由用户驱动**的参数默认值, 照抄官方 `default`。
   * 类型也要照抄(`sound` 在可灵 2.6 上是 LIST 字符串 `"true"`, 在 3.0 上是
   * BOOLEAN `true`)—— 发错类型平台会拒。
   */
  defaults?: Record<string, unknown>;
}

export type RunningHubVideoInputMode = 'text' | 'image' | 'first-last' | 'multimodal';

/**
 * RunningHub 的专用处理端点不属于普通视频生成节点。
 * 它们必须由动作控制 / 对口型 / 数字人口播等专用节点消费。
 */
export function isRunningHubDedicatedVideoEndpoint(endpointId: string): boolean {
  const normalized = endpointId.trim().toLowerCase();
  const spec = RUNNINGHUB_VIDEO_ENDPOINTS.find((item) => item.endpoint.toLowerCase() === normalized);
  return spec?.task === 'audio-to-video'
    || normalized.includes('motion-control')
    || normalized.includes('lip-sync')
    || normalized.includes('avatar')
    || normalized.includes('video-edit');
}

/** 同一模型家族的稳定 key, 用于合并文生 / 图生 / 多模态端点。 */
export function resolveRunningHubVideoFamily(endpointId: string): string {
  const normalized = endpointId.trim().toLowerCase();
  return normalized.replace(
    /^(.*)\/(?:text-to-video|image-to-video|multimodal-video|multimodal-to-video|reference-to-video|image-audio-to-video|start-end-to-video|(?:t2v|i2v))(-[^/]+)?$/,
    (_match, prefix: string, variant = '') => `${prefix}${variant}`,
  );
}

export function runningHubEndpointSupportsInput(
  spec: RunningHubVideoEndpoint,
  mode: RunningHubVideoInputMode,
): boolean {
  if (isRunningHubDedicatedVideoEndpoint(spec.endpoint)) return false;
  switch (mode) {
    case 'text':
      return spec.task === 'text-to-video';
    case 'first-last':
      return spec.task === 'image-to-video' && Boolean(spec.fields.image && spec.fields.lastImage);
    case 'image':
      return (spec.task === 'image-to-video' || spec.task === 'reference-to-video')
        && Boolean(spec.fields.image || spec.fields.imageList);
    case 'multimodal':
      return spec.task === 'multimodal-video'
        || (spec.task === 'reference-to-video'
          && Boolean(spec.fields.video || spec.fields.videoList || spec.fields.audio || spec.fields.audioList))
        || Boolean(spec.fields.video || spec.fields.videoList || spec.fields.audio || spec.fields.audioList);
  }
}

/**
 * 按实际输入选择同一模型家族下的 RunningHub 端点。
 * 普通视频节点只保存一个 canonical model，提交前再按输入切换协议端点：
 * 文字 → 文生，单/多图片 → 图生，视频或音频 → 多模态，首尾帧 → 首尾帧图生。
 */
export function resolveRunningHubVideoEndpointForInput(
  endpointId: string,
  mode: RunningHubVideoInputMode,
): string | undefined {
  const family = resolveRunningHubVideoFamily(endpointId);
  const candidates = RUNNINGHUB_VIDEO_ENDPOINTS.filter(
    (item) => resolveRunningHubVideoFamily(item.endpoint) === family,
  );
  return candidates.find((item) => runningHubEndpointSupportsInput(item, mode))?.endpoint;
}

/**
 * 把设置里的多个端点压成模型家族列表。优先保留文生端点作为 canonical id，
 * 没有文生时再选图生 / 多模态端点；提交时由上面的 resolver 自动切换。
 */
export function collapseRunningHubVideoModels(models: readonly string[]): string[] {
  const groups = new Map<string, string[]>();
  for (const model of models) {
    const spec = RUNNINGHUB_VIDEO_ENDPOINTS.find((item) => item.endpoint.toLowerCase() === model.trim().toLowerCase());
    if (!spec || isRunningHubDedicatedVideoEndpoint(spec.endpoint)) continue;
    const family = resolveRunningHubVideoFamily(spec.endpoint);
    const group = groups.get(family) ?? [];
    group.push(spec.endpoint);
    groups.set(family, group);
  }
  return [...groups.values()].map((group) => {
    const preferred = group.find((endpoint) => runningHubEndpointSupportsInput(
      RUNNINGHUB_VIDEO_ENDPOINTS.find((item) => item.endpoint === endpoint)!,
      'text',
    ));
    return preferred ?? group.find((endpoint) => endpoint.includes('image-to-video')) ?? group[0]!;
  });
}

/** 与官方 capabilities.json 对齐的精选快照(按官方 popularity 排序取头部)。 */
export const RUNNINGHUB_VIDEO_ENDPOINTS: readonly RunningHubVideoEndpoint[] = [
  // --- Sora 2 (官方转售代号「全能视频S」, name_en = sora-2) ---
  {
    endpoint: 'rhart-video-s/text-to-video',
    label: 'Sora 2 · 文生视频（低价渠道）',
    task: 'text-to-video',
    fields: { prompt: 'prompt', duration: 'duration', ratio: 'aspectRatio', ratioKind: 'ratio' },
    durations: [10, 15],
    durationType: 'string',
    ratios: ['9:16', '16:9'],
    resolutions: [],
    defaults: { storyboard: false },
  },
  {
    endpoint: 'rhart-video-s/image-to-video',
    label: 'Sora 2 · 图生视频（低价渠道）',
    task: 'image-to-video',
    fields: {
      prompt: 'prompt',
      image: 'imageUrl',
      duration: 'duration',
      ratio: 'aspectRatio',
      ratioKind: 'ratio',
    },
    durations: [10, 15],
    durationType: 'string',
    ratios: ['9:16', '16:9'],
    resolutions: [],
    defaults: { storyboard: false },
  },
  {
    endpoint: 'rhart-video-s-official/text-to-video',
    label: 'Sora 2 · 文生视频（官方稳定版）',
    task: 'text-to-video',
    fields: { prompt: 'prompt', duration: 'duration', ratio: 'size', ratioKind: 'size' },
    durations: [4, 8, 12],
    durationType: 'string',
    ratios: ['9:16', '16:9'],
    resolutions: [],
  },
  {
    endpoint: 'rhart-video-s-official/image-to-video',
    label: 'Sora 2 · 图生视频（官方稳定版）',
    task: 'image-to-video',
    fields: { prompt: 'prompt', image: 'imageUrl', duration: 'duration' },
    durations: [4, 8, 12],
    durationType: 'string',
    ratios: [],
    resolutions: [],
  },
  {
    endpoint: 'rhart-video-s-official/text-to-video-pro',
    label: 'Sora 2 Pro · 文生视频（官方稳定版）',
    task: 'text-to-video',
    fields: { prompt: 'prompt', duration: 'duration', ratio: 'size', ratioKind: 'size' },
    durations: [4, 8, 12, 16, 20],
    durationType: 'string',
    // 官方 size 枚举: 720x1280 / 1280x720 / 1024x1792 / 1792x1024 / 1080x1920 / 1920x1080
    // 折算成比例后是 9:16 / 16:9 / 4:7 / 7:4 —— 前两档就是常规竖横屏, 这里只暴露这两档,
    // 其余按比例就近吸附(见 snapSize)。
    ratios: ['9:16', '16:9'],
    resolutions: [],
  },
  {
    endpoint: 'rhart-video-s-official/image-to-video-pro',
    label: 'Sora 2 Pro · 图生视频（官方稳定版）',
    task: 'image-to-video',
    fields: {
      prompt: 'prompt',
      image: 'imageUrl',
      duration: 'duration',
      resolution: 'resolution',
    },
    durations: [4, 8, 12, 16, 20],
    durationType: 'string',
    ratios: [],
    resolutions: ['720p', '1080p'],
  },
  // --- Veo 3.1 (官方转售代号「全能视频V3.1」, name_en = google/veo3.1-*) ---
  {
    endpoint: 'rhart-video-v3.1-pro/text-to-video',
    label: 'Veo 3.1 Pro · 文生视频',
    task: 'text-to-video',
    fields: {
      prompt: 'prompt',
      duration: 'duration',
      ratio: 'aspectRatio',
      ratioKind: 'ratio',
      resolution: 'resolution',
    },
    durations: [8],
    durationType: 'string',
    ratios: ['16:9', '9:16'],
    resolutions: ['720p', '1080p', '4k'],
  },
  {
    endpoint: 'rhart-video-v3.1-pro/image-to-video',
    label: 'Veo 3.1 Pro · 图生视频',
    task: 'image-to-video',
    fields: {
      prompt: 'prompt',
      image: 'imageUrl',
      duration: 'duration',
      ratio: 'aspectRatio',
      ratioKind: 'ratio',
    },
    durations: [8],
    durationType: 'string',
    ratios: ['16:9', '9:16'],
    resolutions: [],
  },
  // --- Seedance 2.5 ---
  // 2026-06 之后上线, **不在 CLI 的 capabilities.json 快照里**(那份 version=2026-06-02,
  // 且 CLI 无在线刷新能力), 所以这一条是按官网 API 文档手写补进来的。
  // 计费方式从「按次 / 按秒」改成**按 Token**, 因此端点带 `-token` 后缀。
  // 文档: runninghub.cn/runninghub-api-doc-cn/api-498749507
  // 多模态版(seedance-2.5-token/multimodal-video)收 imageUrls/videoUrls/audioUrls
  // **数组**字段, 现有装填说明只支持单图与首尾帧, 故暂未收录。
  {
    endpoint: 'bytedance/seedance-2.5-token/text-to-video',
    label: 'Seedance 2.5 · 文生视频（Token 计费）',
    task: 'text-to-video',
    fields: {
      prompt: 'prompt',
      duration: 'duration',
      ratio: 'ratio',
      ratioKind: 'ratio',
      resolution: 'resolution',
    },
    // 官方口径「-1 为智能时长; 4-30 秒可选」。`-1` 不暴露给 UI(会被渲染成「-1 秒」),
    // 只列实数档位。
    durations: [
      4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
      28, 29, 30,
    ],
    durationType: 'string',
    ratios: ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9'],
    resolutions: ['480p', '720p', 'native1080p', '1080p', '2k', '4k'],
    // 官方把 generateAudio / watermark / webSearch / returnLastFrame / bitrateMode 全标为
    // **可选**(各有默认), 因此只带两个会改变用户预期的开关, 其余不发 —— 少发一个键就少
    // 一份被平台按 PARAMS_INVALID 拒单的面积。
    defaults: { generateAudio: true, returnLastFrame: false },
  },
  // --- Seedance 2.0 (低价渠道版) ---
  {
    endpoint: 'rhart-video/sparkvideo-2.0/text-to-video',
    label: 'Seedance 2.0 · 文生视频（低价渠道）',
    task: 'text-to-video',
    fields: {
      prompt: 'prompt',
      duration: 'duration',
      ratio: 'ratio',
      ratioKind: 'ratio',
      resolution: 'resolution',
    },
    durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    durationType: 'string',
    ratios: ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9'],
    resolutions: ['480p', '720p', 'native1080p', '1080p', '2k', '4k'],
    // generateAudio / webSearch / returnLastFrame 官方都是可选, 只带音频开关注册表默认值。
    defaults: { generateAudio: true, returnLastFrame: false },
  },
  {
    endpoint: 'rhart-video/sparkvideo-2.0/image-to-video',
    label: 'Seedance 2.0 · 图生视频（低价渠道）',
    task: 'image-to-video',
    fields: {
      prompt: 'prompt',
      image: 'firstFrameUrl',
      lastImage: 'lastFrameUrl',
      duration: 'duration',
      ratio: 'ratio',
      ratioKind: 'ratio',
      resolution: 'resolution',
    },
    durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    durationType: 'string',
    ratios: ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9'],
    resolutions: ['480p', '720p', 'native1080p', '1080p', '2k', '4k'],
    defaults: { generateAudio: true, returnLastFrame: false },
  },
  // --- 可灵 3.0 ---
  {
    endpoint: 'kling-v3.0-pro/text-to-video',
    label: '可灵文生视频3.0-pro',
    task: 'text-to-video',
    fields: {
      prompt: 'prompt',
      negativePrompt: 'negativePrompt',
      duration: 'duration',
      ratio: 'aspectRatio',
      ratioKind: 'ratio',
    },
    durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    durationType: 'string',
    ratios: ['1:1', '16:9', '9:16'],
    resolutions: [],
    defaults: { sound: true, multiShot: false, shotType: 'customize', cfgScale: 0.5 },
  },
  {
    endpoint: 'kling-v3.0-pro/image-to-video',
    label: '可灵图生视频3.0-pro',
    task: 'image-to-video',
    fields: {
      prompt: 'prompt',
      negativePrompt: 'negativePrompt',
      image: 'firstImageUrl',
      lastImage: 'lastImageUrl',
      duration: 'duration',
    },
    durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    durationType: 'string',
    ratios: [],
    resolutions: [],
    defaults: { sound: true, multiShot: false, shotType: 'customize', cfgScale: 0.5 },
  },
  {
    endpoint: 'kling-v3.0-std/text-to-video',
    label: '可灵文生视频3.0-std',
    task: 'text-to-video',
    fields: {
      prompt: 'prompt',
      negativePrompt: 'negativePrompt',
      duration: 'duration',
      ratio: 'aspectRatio',
      ratioKind: 'ratio',
    },
    durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    durationType: 'string',
    ratios: ['1:1', '16:9', '9:16'],
    resolutions: [],
    defaults: { sound: true, multiShot: false, shotType: 'customize', cfgScale: 0.5 },
  },
  {
    endpoint: 'kling-v3.0-std/image-to-video',
    label: '可灵图生视频3.0-std',
    task: 'image-to-video',
    fields: {
      prompt: 'prompt',
      negativePrompt: 'negativePrompt',
      image: 'firstImageUrl',
      lastImage: 'lastImageUrl',
      duration: 'duration',
    },
    durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    durationType: 'string',
    ratios: [],
    resolutions: [],
    // 注意官方这个端点的 cfgScale 默认是 0.8(不是 0.5), 别照抄。
    defaults: { sound: true, multiShot: false, shotType: 'customize', cfgScale: 0.8 },
  },
  // --- 可灵 2.6 ---
  {
    endpoint: 'kling-v2.6-pro/text-to-video',
    label: '可灵文生视频2.6-pro',
    task: 'text-to-video',
    fields: {
      prompt: 'prompt',
      negativePrompt: 'negativePrompt',
      duration: 'duration',
      ratio: 'aspectRatio',
      ratioKind: 'ratio',
    },
    durations: [5, 10],
    durationType: 'string',
    ratios: ['1:1', '16:9', '9:16'],
    resolutions: [],
    // 这个端点的 sound 是 LIST 字符串, 不是 BOOLEAN。
    defaults: { sound: 'true' },
  },
  {
    endpoint: 'kling-v2.6-pro/image-to-video',
    label: '可灵图生视频2.6-pro',
    task: 'image-to-video',
    fields: {
      prompt: 'prompt',
      negativePrompt: 'negativePrompt',
      image: 'imageUrl',
      duration: 'duration',
    },
    durations: [5, 10],
    durationType: 'string',
    ratios: [],
    resolutions: [],
    defaults: { sound: 'true' },
  },
  // --- 可灵 o3 ---
  {
    endpoint: 'kling-video-o3-pro/text-to-video',
    label: '可灵文生视频o3-pro',
    task: 'text-to-video',
    fields: { prompt: 'prompt', duration: 'duration', ratio: 'aspectRatio', ratioKind: 'ratio' },
    // duration 官方是 INT 且无枚举 —— 自由整数(按 1~30 收敛), 不做档位吸附。
    durations: [],
    durationType: 'number',
    ratios: ['1:1', '16:9', '9:16'],
    resolutions: [],
    defaults: { sound: true, multiShot: false, shotType: 'customize' },
  },
  {
    endpoint: 'kling-video-o3-pro/image-to-video',
    label: '可灵图生视频o3-pro',
    task: 'image-to-video',
    fields: {
      prompt: 'prompt',
      image: 'firstImageUrl',
      lastImage: 'lastImageUrl',
      duration: 'duration',
    },
    durations: [],
    durationType: 'number',
    ratios: [],
    resolutions: [],
    defaults: { sound: true, multiShot: false, shotType: 'customize' },
  },
  // --- Seedance 1.5 ---
  {
    endpoint: 'seedance-v1.5-pro/text-to-video',
    label: 'Seedance 1.5 Pro · 文生视频',
    task: 'text-to-video',
    fields: {
      prompt: 'prompt',
      duration: 'duration',
      ratio: 'aspectRatio',
      ratioKind: 'ratio',
      resolution: 'resolution',
    },
    durations: [4, 5, 6, 7, 8, 9, 10, 11, 12],
    durationType: 'string',
    ratios: ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9'],
    resolutions: ['480p', '720p', '1080p'],
    defaults: { generateAudio: 'true', cameraFixed: 'false' },
  },
  {
    endpoint: 'seedance-v1.5-pro/image-to-video',
    label: 'Seedance 1.5 Pro · 图生视频',
    task: 'image-to-video',
    fields: {
      prompt: 'prompt',
      image: 'firstImageUrl',
      lastImage: 'lastImageUrl',
      duration: 'duration',
      ratio: 'aspectRatio',
      ratioKind: 'ratio',
      resolution: 'resolution',
    },
    durations: [4, 5, 6, 7, 8, 9, 10, 11, 12],
    durationType: 'string',
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'],
    resolutions: ['480p', '720p', '1080p'],
    defaults: { generateAudio: 'true', cameraFixed: 'false' },
  },
  // --- 海螺 ---
  {
    endpoint: 'minimax/hailuo-02/t2v-pro',
    label: '海螺-02-文生视频-pro',
    task: 'text-to-video',
    fields: { prompt: 'prompt' },
    // 官方这个端点**没有 duration 参数** —— 不能凭空发一个。
    durations: [],
    durationType: 'string',
    ratios: [],
    resolutions: [],
    defaults: { enablePromptExpansion: true },
  },
  {
    endpoint: 'minimax/hailuo-2.3-fast/image-to-video',
    label: '海螺-2.3-fast-图生视频',
    task: 'image-to-video',
    fields: { prompt: 'prompt', image: 'imageUrl', duration: 'duration' },
    durations: [6, 10],
    durationType: 'string',
    ratios: [],
    resolutions: [],
    defaults: { enablePromptExpansion: true },
  },
  // --- Vidu ---
  {
    endpoint: 'vidu/text-to-video-q3-pro',
    label: 'Vidu-文生视频-q3-pro',
    task: 'text-to-video',
    fields: {
      prompt: 'prompt',
      duration: 'duration',
      ratio: 'aspectRatio',
      ratioKind: 'ratio',
      resolution: 'resolution',
    },
    durations: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    durationType: 'string',
    ratios: ['4:3', '3:4', '16:9', '9:16', '1:1'],
    resolutions: ['360p', '540p', '720p', '1080p'],
    defaults: { style: 'general', audio: true },
  },
  {
    endpoint: 'vidu/image-to-video-q3-pro',
    label: 'Vidu-图生视频-q3-pro',
    task: 'image-to-video',
    fields: { prompt: 'prompt', image: 'imageUrl', duration: 'duration', resolution: 'resolution' },
    durations: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    durationType: 'string',
    ratios: [],
    resolutions: ['360p', '540p', '720p', '1080p', '2k'],
    defaults: { audio: true },
  },
  // --- 万相 2.7 ---
  {
    endpoint: 'alibaba/wan-2.7/text-to-video',
    label: '万相2.7-文生视频',
    task: 'text-to-video',
    fields: {
      prompt: 'prompt',
      negativePrompt: 'negativePrompt',
      duration: 'duration',
      ratio: 'aspectRatio',
      ratioKind: 'ratio',
      resolution: 'resolution',
    },
    durations: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    durationType: 'string',
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    // 官方这个端点的大小写是 720P / 1080P(全大写), 与其它端点的 720p 不同。
    resolutions: ['720P', '1080P'],
    defaults: { promptExtend: true },
  },
  {
    endpoint: 'alibaba/wan-2.7/image-to-video',
    label: '万相2.7-图生视频',
    task: 'image-to-video',
    fields: {
      prompt: 'prompt',
      image: 'firstImageUrl',
      lastImage: 'lastImageUrl',
      negativePrompt: 'negativePrompt',
      duration: 'duration',
      resolution: 'resolution',
    },
    durations: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    durationType: 'string',
    ratios: [],
    resolutions: ['720P', '1080P'],
    defaults: { promptExtend: true },
  },
  // --- Seedance 2.5 / MiniMax H3 多模态新增端点 ---
  {
    endpoint: 'bytedance/seedance-2.5-token/image-to-video',
    label: 'Seedance 2.5 · 图生视频（Token 计费）',
    task: 'image-to-video',
    fields: {
      prompt: 'prompt', image: 'firstFrameUrl', lastImage: 'lastFrameUrl', duration: 'duration',
      ratio: 'ratio', ratioKind: 'ratio', resolution: 'resolution',
    },
    durations: Array.from({ length: 27 }, (_, index) => index + 4),
    durationType: 'string',
    ratios: ['adaptive'],
    resolutions: ['480p', '720p', 'native1080p', '1080p', '2k', '4k'],
    defaults: { generateAudio: true, returnLastFrame: false },
  },
  {
    endpoint: 'bytedance/seedance-2.5-token/multimodal-video',
    label: 'Seedance 2.5 · 多模态视频（Token 计费）',
    task: 'multimodal-video',
    fields: {
      prompt: 'prompt', imageList: 'imageUrls', videoList: 'videoUrls', audioList: 'audioUrls',
      duration: 'duration', ratio: 'ratio', ratioKind: 'ratio', resolution: 'resolution',
    },
    durations: Array.from({ length: 27 }, (_, index) => index + 4),
    durationType: 'string',
    ratios: ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9'],
    resolutions: ['480p', '720p', 'native1080p', '1080p', '2k', '4k'],
    maxImages: 30,
    maxVideos: 10,
    maxAudios: 10,
    defaults: { generateAudio: true, returnLastFrame: false },
  },
  {
    endpoint: 'rhart-video/sparkvideo-2.0-mini/text-to-video',
    label: 'Seedance 2.0 Mini · 文生视频',
    task: 'text-to-video',
    fields: { prompt: 'prompt', duration: 'duration', ratio: 'ratio', ratioKind: 'ratio', resolution: 'resolution' },
    durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    durationType: 'string',
    ratios: ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9'],
    resolutions: ['480p', '720p', '1080p', '2k', '4k'],
    defaults: { generateAudio: true, returnLastFrame: false },
  },
  {
    endpoint: 'rhart-video/sparkvideo-2.0-mini/image-to-video',
    label: 'Seedance 2.0 Mini · 图生视频',
    task: 'image-to-video',
    fields: { prompt: 'prompt', image: 'firstFrameUrl', lastImage: 'lastFrameUrl', duration: 'duration', ratio: 'ratio', ratioKind: 'ratio', resolution: 'resolution' },
    durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    durationType: 'string',
    ratios: ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9'],
    resolutions: ['480p', '720p', '1080p', '2k', '4k'],
    defaults: { generateAudio: true, returnLastFrame: false },
  },
  {
    endpoint: 'minimax/hailuo-h3/text-to-video',
    label: 'MiniMax H3 · 文生视频',
    task: 'text-to-video',
    fields: { prompt: 'prompt', duration: 'duration', ratio: 'ratio', ratioKind: 'ratio', resolution: 'resolution' },
    durations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    durationType: 'string',
    ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
    resolutions: ['2K', '768P'],
    defaults: { aigc_watermark: false },
  },
  {
    endpoint: 'minimax/hailuo-h3/image-to-video',
    label: 'MiniMax H3 · 首尾帧生视频',
    task: 'image-to-video',
    fields: { prompt: 'prompt', image: 'firstFrameUrl', lastImage: 'lastFrameUrl', duration: 'duration', resolution: 'resolution' },
    durations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    durationType: 'string',
    ratios: [],
    resolutions: ['2K', '768P'],
    defaults: { aigc_watermark: false },
  },
  {
    endpoint: 'minimax/hailuo-h3/multimodal-to-video',
    label: 'MiniMax H3 · 多模态参考生视频',
    task: 'multimodal-video',
    fields: { prompt: 'prompt', imageList: 'imageUrls', videoList: 'videoUrls', audioList: 'audioUrls', duration: 'duration', ratio: 'ratio', ratioKind: 'ratio', resolution: 'resolution' },
    durations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    durationType: 'string',
    ratios: ['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
    resolutions: ['2K', '768P'],
    maxImages: 9,
    maxVideos: 1,
    maxAudios: 1,
    defaults: { aigc_watermark: false },
  },
  // --- 万相 3.0 多模态 ---
  {
    endpoint: 'alibaba/wan-3.0/image-to-video',
    label: '万相 3.0 · 图生视频',
    task: 'image-to-video',
    fields: { prompt: 'prompt', image: 'firstFrameUrl', lastImage: 'lastFrameUrl', duration: 'duration', ratio: 'aspectRatio', ratioKind: 'ratio', resolution: 'resolution' },
    durations: Array.from({ length: 29 }, (_, index) => index + 2),
    durationType: 'string',
    ratios: ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16'],
    resolutions: ['480P', '720P', '1080P'],
    defaults: { audio: true },
  },
  {
    endpoint: 'alibaba/wan-3.0-prime/image-to-video',
    label: '万相 3.0 Prime · 图生视频',
    task: 'image-to-video',
    fields: { prompt: 'prompt', image: 'firstFrameUrl', lastImage: 'lastFrameUrl', duration: 'duration', ratio: 'aspectRatio', ratioKind: 'ratio', resolution: 'resolution' },
    durations: Array.from({ length: 29 }, (_, index) => index + 2),
    durationType: 'string',
    ratios: ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16'],
    resolutions: ['480P', '720P', '1080P'],
    defaults: { audio: true },
  },
  {
    endpoint: 'alibaba/wan-3.0/reference-to-video',
    label: '万相 3.0 · 多模态参考生视频',
    task: 'multimodal-video',
    fields: { prompt: 'prompt', imageList: 'imageUrls', videoList: 'videoUrls', audioList: 'audioUrls', negativePrompt: 'negativePrompt', duration: 'duration', ratio: 'aspectRatio', ratioKind: 'ratio', resolution: 'resolution' },
    durations: Array.from({ length: 29 }, (_, index) => index + 2),
    durationType: 'string',
    ratios: ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16'],
    resolutions: ['480P', '720P', '1080P'],
    maxImages: 10,
    maxVideos: 5,
    maxAudios: 5,
    defaults: { audio: true, promptExtend: true },
  },
  {
    endpoint: 'alibaba/wan-3.0-prime/reference-to-video',
    label: '万相 3.0 Prime · 多模态参考生视频',
    task: 'multimodal-video',
    fields: { prompt: 'prompt', imageList: 'imageUrls', videoList: 'videoUrls', audioList: 'audioUrls', duration: 'duration', ratio: 'aspectRatio', ratioKind: 'ratio', resolution: 'resolution' },
    durations: Array.from({ length: 29 }, (_, index) => index + 2),
    durationType: 'string',
    ratios: ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16'],
    resolutions: ['480P', '720P', '1080P'],
    maxImages: 10,
    maxVideos: 5,
    maxAudios: 5,
    defaults: { audio: true },
  },
  // --- Vidu / 可灵 / 全能视频参考生 ---
  {
    endpoint: 'vidu/reference-to-video-q3',
    label: 'Vidu Q3 · 参考生视频',
    task: 'reference-to-video',
    fields: { prompt: 'prompt', imageList: 'imageUrls', duration: 'duration', ratio: 'aspectRatio', ratioKind: 'ratio', resolution: 'resolution' },
    durations: Array.from({ length: 14 }, (_, index) => index + 3),
    durationType: 'number',
    ratios: ['16:9', '9:16', '4:3', '3:4', '1:1', 'auto'],
    resolutions: ['540p', '720p', '1080p'],
    maxImages: 7,
    defaults: { audio: 'true' },
  },
  {
    endpoint: 'vidu/reference-to-video-q3-drama',
    label: 'Vidu Q3 Drama · 参考生视频',
    task: 'reference-to-video',
    fields: { prompt: 'prompt', imageList: 'imageUrls', duration: 'duration', ratio: 'aspectRatio', ratioKind: 'ratio', resolution: 'resolution' },
    durations: Array.from({ length: 14 }, (_, index) => index + 2),
    durationType: 'number',
    ratios: ['16:9', '9:16', '4:3', '3:4', '1:1', 'auto'],
    resolutions: ['1080p'],
    maxImages: 7,
    defaults: { audio: 'true' },
  },
  {
    endpoint: 'kling-video-o3-pro/reference-to-video',
    label: '可灵 O3 Pro · 参考生视频',
    task: 'reference-to-video',
    fields: { prompt: 'prompt', imageList: 'imageUrls', video: 'videoUrl', duration: 'duration', ratio: 'aspectRatio', ratioKind: 'ratio' },
    durations: Array.from({ length: 13 }, (_, index) => index + 3),
    durationType: 'number',
    ratios: ['16:9', '9:16', '1:1'],
    resolutions: [],
    maxImages: 7,
    defaults: { keepOriginalSound: true, sound: false, multiShot: false, shotType: 'customize' },
  },
  {
    endpoint: 'rhart-video-v3.1-pro-official/reference-to-video',
    label: 'Veo 3.1 Pro · 多图参考生视频',
    task: 'reference-to-video',
    fields: { prompt: 'prompt', imageList: 'imageUrls', negativePrompt: 'negativePrompt', resolution: 'resolution' },
    durations: [8],
    durationType: 'string',
    ratios: [],
    resolutions: ['720p', '1080p', '4k'],
    maxImages: 3,
    defaults: { generateAudio: false },
  },
  {
    endpoint: 'rhart-video-g-official/reference-to-video-v1.5',
    label: 'Grok Imagine v1.5 · 多图参考生视频',
    task: 'reference-to-video',
    fields: { prompt: 'prompt', imageList: 'referenceImages', duration: 'duration', ratio: 'aspectRatio', ratioKind: 'ratio', resolution: 'resolution' },
    durations: Array.from({ length: 15 }, (_, index) => index + 1),
    durationType: 'number',
    ratios: ['16:9', '1:1', '9:16', '3:2', '2:3'],
    resolutions: ['480p', '720p'],
    maxImages: 7,
  },
  {
    endpoint: 'kling-v2-ai-avatar-pro/image-audio-to-video',
    label: 'Kling V2 Pro · 数字人口播',
    task: 'audio-to-video',
    fields: { prompt: 'prompt', image: 'imageUrl', audio: 'audioUrl' },
    durations: [],
    durationType: 'string',
    ratios: [],
    resolutions: [],
  },
  {
    endpoint: 'kling-v2-ai-avatar-standard/image-audio-to-video',
    label: 'Kling V2 Standard · 数字人口播',
    task: 'audio-to-video',
    fields: { prompt: 'prompt', image: 'imageUrl', audio: 'audioUrl' },
    durations: [],
    durationType: 'string',
    ratios: [],
    resolutions: [],
  },
];

/** 端点 ID → 规格。整串比对: 端点 ID 里可能含两层斜杠, 不能按前缀宽松匹配。 */
export function resolveRunningHubVideoEndpoint(
  endpointId: string,
): RunningHubVideoEndpoint | undefined {
  const wanted = endpointId.trim().toLowerCase();
  return RUNNINGHUB_VIDEO_ENDPOINTS.find((item) => item.endpoint.toLowerCase() === wanted);
}

/** 展示给用户的模型家族名，不把文生/图生/多模态等端点动作暴露在模型名里。 */
export function resolveRunningHubVideoDisplayName(endpointId: string): string {
  const spec = resolveRunningHubVideoEndpoint(endpointId);
  const label = spec?.label?.trim() || endpointId.trim();
  return label
    .replace(/(?:文生视频|图生视频|多模态参考生视频|多模态视频|首尾帧生视频|参考生视频)/g, '')
    .replace(/[（）()]/g, '')
    .replace(/[·\s_-]+/g, ' ')
    .trim();
}

/** 该端点是不是视频端点(用于校验用户手填的模型名)。 */
export function isRunningHubVideoEndpoint(endpointId: string): boolean {
  return resolveRunningHubVideoEndpoint(endpointId) !== undefined;
}

// ---------------------------------------------------------------------------
// 档位吸附
// ---------------------------------------------------------------------------

/**
 * 时长吸附到官方允许的枚举。
 *
 * 官方 `duration` 有两型:
 * - LIST: 有明确枚举, **必须**吸附到最近档, 否则平台回 `PARAMS_INVALID`;
 * - INT 且无枚举(可灵 o3): 自由整数, 只做四舍五入与 1~30 收敛。
 *
 * `preferDefault` 为真且请求值不在枚举里时, 优先取官方默认档(列表首个常是默认) ——
 * 用户没显式选时长时不该被吸附到语义奇怪的值。
 */
export function snapRunningHubDuration(
  endpoint: RunningHubVideoEndpoint,
  seconds: number,
): number {
  const requested = Number.isFinite(seconds) ? Math.round(seconds) : 0;
  if (endpoint.durations.length === 0) {
    return Math.min(30, Math.max(1, requested || 5));
  }
  if (endpoint.durations.includes(requested)) {
    return requested;
  }
  let best = endpoint.durations[0]!;
  let bestDistance = Math.abs(best - requested);
  for (const candidate of endpoint.durations) {
    const distance = Math.abs(candidate - requested);
    // 距离相同时取较小档: 少生成 1 秒比多生成 1 秒更不容易触发计费争议。
    if (distance < bestDistance || (distance === bestDistance && candidate < best)) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * 比例 → 像素串(`size` 型端点): 按 宽/高 数值就近吸附, 同距取先出现的档。
 *
 * 入参既可能是**比例标签**(`16:9`, 来自画布的 aspect_ratio)也可能是**像素串**
 * (`1280x720`, 来自官方 size 枚举), 所以分隔符要同时接受 `x` / `*` / `×` / `:`。
 * 早先只认 `x` 号, 导致比例标签解析失败后一律回落首个选项 —— 横屏请求会被静默
 * 变成竖屏, 而且因为请求本身是合法的, 平台不会报错。
 */
function snapSize(requested: string, options: readonly string[]): string {
  const parse = (value: string): number | undefined => {
    const match = /^(\d+(?:\.\d+)?)\s*[x*×:]\s*(\d+(?:\.\d+)?)$/i.exec(value.trim());
    if (!match) return undefined;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || height === 0) return undefined;
    return width / height;
  };
  const want = parse(requested);
  if (want === undefined) return options[0]!;
  let best = options[0]!;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of options) {
    const ratio = parse(candidate);
    if (ratio === undefined) continue;
    const distance = Math.abs(ratio - want);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** 比例吸附: 精确命中优先, 否则按 宽/高 就近(支持 `adaptive` 这类非数字标签按等义处理)。 */
export function snapRunningHubRatio(
  endpoint: RunningHubVideoEndpoint,
  aspectRatio: string,
): string | undefined {
  const options = endpoint.ratios;
  if (options.length === 0) return undefined;
  const wanted = aspectRatio.trim();
  if (!wanted) return undefined;

  const exact = options.find((item) => item.toLowerCase() === wanted.toLowerCase());
  if (exact) {
    // `size` 型端点要把比例标签折成像素串。
    if (endpoint.fields.ratioKind === 'size') {
      return snapSize(wanted, SIZE_OPTIONS[endpoint.endpoint] ?? options);
    }
    return exact;
  }

  if (endpoint.fields.ratioKind === 'size') {
    const sizes = SIZE_OPTIONS[endpoint.endpoint];
    return sizes ? snapSize(wanted, sizes) : undefined;
  }

  const numeric = (value: string): number | undefined => {
    const match = /^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/.exec(value.trim());
    if (!match) return undefined;
    const width = Number(match[1]);
    const height = Number(match[2]);
    return height === 0 ? undefined : width / height;
  };
  const want = numeric(wanted);
  if (want === undefined) return undefined;
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of options) {
    const ratio = numeric(candidate);
    if (ratio === undefined) continue;
    const distance = Math.abs(ratio - want);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** `size` 型端点的官方像素枚举(不在通用 ratios 里, 因为 UI 只展示比例标签)。 */
const SIZE_OPTIONS: Record<string, readonly string[]> = {
  'rhart-video-s-official/text-to-video': ['720x1280', '1280x720'],
  'rhart-video-s-official/text-to-video-pro': [
    '720x1280',
    '1280x720',
    '1024x1792',
    '1792x1024',
    '1080x1920',
    '1920x1080',
  ],
};

/** 分辨率吸附: 大小写不敏感精确命中优先(万相是 `720P`), 否则回落官方默认档。 */
export function snapRunningHubResolution(
  endpoint: RunningHubVideoEndpoint,
  resolution: string,
): string | undefined {
  const options = endpoint.resolutions;
  if (options.length === 0) return undefined;
  const wanted = resolution.trim().toLowerCase();
  const exact = options.find((item) => item.toLowerCase() === wanted);
  return exact ?? options[0];
}

/** UI: 端点允许的时长档位(空 = 自由整数, 交给调用方给默认列表)。 */
export function resolveRunningHubDurationOptions(
  endpointId: string,
  fallback: readonly number[],
): number[] {
  const spec = resolveRunningHubVideoEndpoint(endpointId);
  if (!spec) return [...fallback];
  return spec.durations.length > 0 ? [...spec.durations] : [...fallback];
}

/** UI: 端点允许的比例档位(空 = 该端点无比例参数, 调用方应隐藏该控件)。 */
export function resolveRunningHubAspectRatioOptions(
  endpointId: string,
  fallback: readonly string[],
): string[] {
  const spec = resolveRunningHubVideoEndpoint(endpointId);
  if (!spec) return [...fallback];
  return [...spec.ratios];
}

/** UI: 端点允许的分辨率档位(空 = 该端点无分辨率参数)。 */
export function resolveRunningHubResolutionOptions(
  endpointId: string,
  fallback: readonly string[],
): string[] {
  const spec = resolveRunningHubVideoEndpoint(endpointId);
  if (!spec) return [...fallback];
  return [...spec.resolutions];
}

// ---------------------------------------------------------------------------
// 请求体构造
// ---------------------------------------------------------------------------

export interface RunningHubBuildInput {
  prompt: string;
  /** 已换成公网 URL 的参考图(首帧在前)。 */
  images: string[];
  /** 已换成公网 URL 的参考视频。 */
  videos?: string[];
  /** 已换成公网 URL 的参考音频。 */
  audios?: string[];
  duration: number;
  aspectRatio?: string;
  resolution?: string;
  negativePrompt?: string;
}

/**
 * 按官方 schema 装填请求体。
 *
 * 铁律: **端点 schema 里没有的键一律不发**。RunningHub 对陌生字段回
 * `PARAMS_INVALID`, 而不是忽略 —— 多发一个键就等于整个任务提交失败。
 */
export function buildRunningHubRequestBody(
  endpoint: RunningHubVideoEndpoint,
  input: RunningHubBuildInput,
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...(endpoint.defaults ?? {}) };
  const { fields } = endpoint;

  if (fields.prompt) {
    body[fields.prompt] = input.prompt;
  }
  const negative = input.negativePrompt?.trim();
  if (fields.negativePrompt && negative) {
    body[fields.negativePrompt] = negative;
  }
  const first = input.images[0]?.trim();
  if (fields.image && first) {
    body[fields.image] = first;
  }
  const last = input.images[1]?.trim();
  if (fields.lastImage && last) {
    body[fields.lastImage] = last;
  }
  const images = input.images.map((item) => item.trim()).filter(Boolean);
  if (fields.imageList && images.length > 0) {
    body[fields.imageList] = images.slice(0, endpoint.maxImages ?? 30);
  }
  const videos = (input.videos ?? []).map((item) => item.trim()).filter(Boolean);
  if (fields.video && videos[0]) {
    body[fields.video] = videos[0];
  }
  if (fields.videoList && videos.length > 0) {
    body[fields.videoList] = videos.slice(0, endpoint.maxVideos ?? 10);
  }
  const audios = (input.audios ?? []).map((item) => item.trim()).filter(Boolean);
  if (fields.audio && audios[0]) {
    body[fields.audio] = audios[0];
  }
  if (fields.audioList && audios.length > 0) {
    body[fields.audioList] = audios.slice(0, endpoint.maxAudios ?? 10);
  }
  if (fields.duration) {
    const snapped = snapRunningHubDuration(endpoint, input.duration);
    body[fields.duration] = endpoint.durationType === 'number' ? snapped : String(snapped);
  }
  if (fields.ratio && input.aspectRatio?.trim()) {
    const ratio = snapRunningHubRatio(endpoint, input.aspectRatio);
    if (ratio) body[fields.ratio] = ratio;
  }
  if (fields.resolution && input.resolution?.trim()) {
    const resolution = snapRunningHubResolution(endpoint, input.resolution);
    if (resolution) body[fields.resolution] = resolution;
  }
  return body;
}

/**
 * 提交时随 `extra_params.runninghub_video` 传给后端的**完整装填说明**。
 *
 * 后端 `runninghub.rs` 不认识任何具体模型 —— 它只按这份说明装填、提交、轮询。
 * 因此这里必须把三样东西都给全:
 * 1. `fields`   —— 各字段的平台键名(可灵是 `firstImageUrl`, Seedance 2.0 是
 *    `firstFrameUrl`, Sora 2(官网名「全能视频S」) 是 `imageUrl`);
 * 2. `defaults` —— 官方 schema 里**必填但不由用户驱动**的参数默认值。漏掉它们
 *    会被平台判 `PARAMS_INVALID`(如可灵的 `sound` / `shotType`);
 * 3. 选项列表   —— `durations` / `ratios` / `sizeOptions` / `resolutions`,
 *    后端据此把用户选的秒数与画幅吸附到官方枚举。`sizeOptions` 只在
 *    `ratioKind === 'size'` 时才有(该端点的画幅字段收 `720x1280` 这种像素串)。
 *
 * 缺了这份说明后端会回落到保守默认映射, 可灵 / Seedance 这类首帧字段名不同的
 * 端点就会漏传参考图 —— 任务能提交成功, 但生成的视频跟参考图无关。
 */
export function runningHubVideoExtraParams(endpointId: string): Record<string, unknown> | undefined {
  const spec = resolveRunningHubVideoEndpoint(endpointId);
  if (!spec) return undefined;
  return {
    endpoint: spec.endpoint,
    fields: {
      prompt: spec.fields.prompt,
      image: spec.fields.image,
      lastImage: spec.fields.lastImage,
      imageList: spec.fields.imageList,
      video: spec.fields.video,
      videoList: spec.fields.videoList,
      audio: spec.fields.audio,
      audioList: spec.fields.audioList,
      negativePrompt: spec.fields.negativePrompt,
      duration: spec.fields.duration,
      ratio: spec.fields.ratio,
      ratioKind: spec.fields.ratioKind,
      resolution: spec.fields.resolution,
    },
    durationType: spec.durationType,
    durations: spec.durations,
    ratios: spec.ratios,
    sizeOptions: spec.fields.ratioKind === 'size' ? [...(SIZE_OPTIONS[spec.endpoint] ?? [])] : [],
    resolutions: spec.resolutions,
    maxImages: spec.maxImages,
    maxVideos: spec.maxVideos,
    maxAudios: spec.maxAudios,
    defaults: spec.defaults ?? {},
  };
}
