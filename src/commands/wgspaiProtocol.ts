/**
 * WGSPAI(api.wgspai.cn)视频链路的模型规则表与提示词引用方言本地化。
 *
 * **必须与后端 `src-tauri/src/ai/providers/video_protocols/wgspai.rs` 保持一致**
 * —— 同一个平台有两条活路径: 节点走 `submitGenerateVideoJob` → 后端任务执行器;
 * Canvas / 动作控制 / 模板重跑走 `canvasAiGateway.generateVideo` → `commands/ai.ts`。
 * 两边规则不同会出现「同样素材换个入口就报错」的怪象, 所以规则集中在这一个模块里
 * (后端那份是 Rust, 无法共享代码, 只能靠同构的测试守住)。
 *
 * 依据的四份文档:
 *   - API文档.md                              (总览: 两族接口 / 图床 / 错误体)
 *   - api.wgspai.cn-seedance2.5-对接文档.md    (seedance2.5)
 *   - minimax-h3-api.md                        (Minimax-h3)
 *   - seedance-v2-720p-9-3-3对接文档.md        (seedance-v2-720p)
 */

/** 接口族。决定提交/查询端点, 以及参数是平铺还是包 `params`。 */
export type WgspaiApiFamily = 'videos' | 'task';

/**
 * 时长规则。
 * - `platform-default`: 平台自己定(seedance2.5 固定 30 秒按次计费), 不传；
 * - `in-model-name`:   时长编在模型名里(`…-8s-…`), 不传；
 * - `range`:           传 `seconds`, 并吸附到文档给定的闭区间；
 * - `passthrough`:     文档未写时长规则, 原样透传用户选择。
 */
export type WgspaiDurationRule =
  | { kind: 'platform-default' }
  | { kind: 'in-model-name' }
  | { kind: 'range'; min: number; max: number }
  | { kind: 'passthrough' };

/** 参考素材的提交通道。 */
export type WgspaiReferenceChannel =
  /** 族 1: 顶层平铺 `images` / `audio_urls` / `video_urls`。 */
  | 'top-level'
  /** 族 2: `params.images` / `params.audios` / `params.videos`(含 `-video` 的 content 分支)。 */
  | 'params';

/** 提示词里的引用标记方言。 */
export type WgspaiReferenceDialect =
  /** 文档没定义引用标记的模型: 一个字符都不动。 */
  | 'keep'
  /** `@图片N`(seedance2.5 文档 §4 / §9.3)。 */
  | 'at-picture'
  /** `[imageN]` / `[audio_N]` / `[video_N]`(seedance-v2-720p 文档 §3.3)。 */
  | 'bracketed';

export interface WgspaiModelSpec {
  family: WgspaiApiFamily;
  maxReferenceImages: number;
  maxReferenceAudio: number;
  maxReferenceVideos: number;
  duration: WgspaiDurationRule;
  supportsReferenceAudio: boolean;
  supportsReferenceVideo: boolean;
  channel: WgspaiReferenceChannel;
  dialect: WgspaiReferenceDialect;
  /** 画幅白名单。`undefined` = 文档未限定, 用户选什么发什么。 */
  allowedRatios?: readonly string[];
  /** 白名单外 / 画幅缺失时的兜底。 */
  fallbackRatio: string;
  /** 输入视频用**单数** `video_url` 而不是数组(flashvsr-restore)。 */
  singleVideoUrl: boolean;
  /**
   * 平台固定时长(秒)。只有 `duration.kind === 'platform-default'` 且文档写明了
   * 具体秒数时才有值(seedance2.5 = 30)—— UI 靠它把时长下拉收成一个选项。
   */
  fixedDurationSeconds?: number;
}

/** 族 1(Videos)。三份模型专档都推荐它作为正典路径。 */
export const WGSPAI_VIDEOS_SUBMIT_PATH = '/v1/videos';
/** 族 2(Task)。总览文档「异步：任务」一节。 */
export const WGSPAI_TASK_SUBMIT_PATH = '/v1/task/create';
export const WGSPAI_TASK_QUERY_PATH = '/v1/task/{taskId}';
/** 图床补全路径(API 与图床不同 host, 见 wgspai.rs 的 `image_bed_upload_url`)。 */
export const WGSPAI_IMAGE_BED_PATH = '/image-bed/api/upload';

/**
 * 未识别模型的参考图上限。文档没写上限时**宁可宽松**: 在这里悄悄丢素材, 用户只会
 * 看到"传了但没生效", 无从排查; 交给平台报出它自己的约束反而可诊断。
 */
export const WGSPAI_DEFAULT_MAX_REFERENCE_IMAGES = 30;

/** 文档明确写了"仅支持这两种比例"的画幅白名单。 */
const SEEDANCE_V2_RATIOS = ['9:16', '16:9'] as const;
/** seedance2.5 文档 §5.1: `9:16` / `16:9` / `1:1`。 */
const SEEDANCE_25_RATIOS = ['9:16', '16:9', '1:1'] as const;

/**
 * 总览文档「异步 · 视频类任务」一节列出的族 2 模型名片段。
 *
 * 只在**文档明确写在那一节**里才分流 —— 未识别模型继续走 `/v1/videos`, 这是三份
 * 模型专档一致推荐的路径, 拿它当默认比猜一个更安全。
 */
const TASK_FAMILY_MARKERS = [
  'sd-2',
  'longxia-',
  'sora2-pro',
  'veo31',
  'veo-3.1',
  'ltx2.3',
  'voice-clone',
  'flashvsr-restore',
  'seedance-v2-1080p',
] as const;

function isTaskFamily(normalizedModel: string): boolean {
  return TASK_FAMILY_MARKERS.some((marker) => normalizedModel.includes(marker));
}

const PERMISSIVE_SPEC: WgspaiModelSpec = {
  family: 'videos',
  maxReferenceImages: WGSPAI_DEFAULT_MAX_REFERENCE_IMAGES,
  maxReferenceAudio: 3,
  maxReferenceVideos: 3,
  duration: { kind: 'passthrough' },
  supportsReferenceAudio: true,
  supportsReferenceVideo: true,
  channel: 'top-level',
  dialect: 'keep',
  fallbackRatio: '16:9',
  singleVideoUrl: false,
};

export function resolveWgspaiModelSpec(apiModel: string): WgspaiModelSpec {
  const model = apiModel.trim().toLowerCase();

  // ---- seedance2.5: 30 秒定长按次计费, 参考图 ≤30, 认 `@图片N` ----
  // 音频 / 参考视频「即使传了也不保证生效」(文档 §4) → 仍然透传, 由平台决定。
  if (model.includes('seedance2.5') || model.includes('seedance-2.5')) {
    return {
      family: 'videos',
      maxReferenceImages: 30,
      maxReferenceAudio: 3,
      maxReferenceVideos: 3,
      duration: { kind: 'platform-default' },
      supportsReferenceAudio: true,
      supportsReferenceVideo: true,
      channel: 'top-level',
      dialect: 'at-picture',
      allowedRatios: SEEDANCE_25_RATIOS,
      fallbackRatio: '9:16',
      singleVideoUrl: false,
      fixedDurationSeconds: 30,
    };
  }

  // ---- seedance v2 系列: 9 图 / 3 音频 / 3 视频(简称 9-3-3) ----
  if (model.includes('seedance-v2')) {
    // 只有 720p 有专档(明确走 /v1/videos、4~15 秒); 1080p 只在总览文档的
    // 「异步 · 视频类任务」一节里出现, 属于族 2 且「按次计费, 无需传时长」。
    // 用带连字符的完整名匹配 —— `seedance-v2.5-1080p` 这种没有文档依据的写法
    // 不该被顺手改到另一族去。
    const isTask1080 = model.includes('seedance-v2-1080p');
    return {
      family: isTask1080 ? 'task' : 'videos',
      maxReferenceImages: 9,
      maxReferenceAudio: 3,
      maxReferenceVideos: 3,
      duration: isTask1080 ? { kind: 'platform-default' } : { kind: 'range', min: 4, max: 15 },
      supportsReferenceAudio: true,
      supportsReferenceVideo: model.includes('-video'),
      channel: isTask1080 ? 'params' : 'top-level',
      dialect: 'bracketed',
      allowedRatios: SEEDANCE_V2_RATIOS,
      fallbackRatio: '9:16',
      singleVideoUrl: false,
    };
  }

  // ---- minimax-h3: 图 ≤9, 文档明确「参考音视频: 不支持」----
  // 不透传音视频, 免得平台因为多出来的字段直接 400。时长 4~15 秒(默认 15)。
  if (model.includes('minimax-h3')) {
    return {
      family: 'videos',
      maxReferenceImages: 9,
      maxReferenceAudio: 0,
      maxReferenceVideos: 0,
      duration: { kind: 'range', min: 4, max: 15 },
      supportsReferenceAudio: false,
      supportsReferenceVideo: false,
      channel: 'top-level',
      dialect: 'keep',
      // 文档只说「建议 16:9 或 9:16」, 是建议不是白名单 → 不强制吸附。
      fallbackRatio: '16:9',
      singleVideoUrl: false,
    };
  }

  // ---- 族 2(Task): 总览文档「异步 · 视频类任务」一节的模型 ----
  if (isTaskFamily(model)) {
    const isSd2 = model.includes('sd-2');
    const isFlashvsr = model.includes('flashvsr');
    let duration: WgspaiDurationRule;
    if (isSd2) {
      // sd-2 文档: 「请使用 5～15 之间的整数秒」。
      duration = { kind: 'range', min: 5, max: 15 };
    } else if (model.includes('sora2-pro') || model.includes('veo31') || model.includes('veo-3.1')) {
      // 方向与时长已编进模型名(`…-8s-…` / `…-12s-…`)。
      duration = { kind: 'in-model-name' };
    } else {
      // ltx2.3 / voice-clone / flashvsr-restore 等: 文档未写时长规则。
      duration = { kind: 'passthrough' };
    }
    return {
      family: 'task',
      maxReferenceImages: WGSPAI_DEFAULT_MAX_REFERENCE_IMAGES,
      maxReferenceAudio: 0,
      maxReferenceVideos: isSd2 || isFlashvsr ? 3 : 0,
      duration,
      supportsReferenceAudio: false,
      supportsReferenceVideo: isSd2 || isFlashvsr,
      channel: 'params',
      dialect: 'keep',
      fallbackRatio: '16:9',
      singleVideoUrl: isFlashvsr,
    };
  }

  return { ...PERMISSIVE_SPEC };
}

/** 时长最终值。`undefined` = 本次请求不带时长字段。 */
export function resolveWgspaiDuration(rule: WgspaiDurationRule, requested: number): number | undefined {
  const seconds = Number.isFinite(requested) ? Math.round(requested) : 0;
  switch (rule.kind) {
    case 'platform-default':
    case 'in-model-name':
      return undefined;
    case 'range':
      return Math.min(Math.max(seconds, rule.min), rule.max);
    case 'passthrough':
      return Math.max(1, seconds);
  }
}

/** 画幅比例 → 像素尺寸。未覆盖的比例只发比例串, 不猜尺寸。 */
export function wgspaiPixelSize(aspectRatio: string): string | undefined {
  const table: Record<string, string> = {
    '16:9': '1280x720',
    '9:16': '720x1280',
    '1:1': '1024x1024',
    '4:3': '1024x768',
    '3:4': '768x1024',
    '21:9': '1280x548',
  };
  return table[aspectRatio.trim()];
}

/** 白名单外的比例就近吸附: 只看横/竖归属, 不猜具体数值。 */
function snapRatio(requested: string, allowed: readonly string[], fallback: string): string {
  // `'adaptive'.split(':')` 只有一段 —— `heightText` 在运行时是 undefined
  // (TS 在未开 noUncheckedIndexedAccess 时不会提示), 必须显式判空。
  const [widthText, heightText] = requested.split(':');
  if (heightText === undefined) return fallback;
  const width = Number(widthText.trim());
  const height = Number(heightText.trim());
  if (!Number.isFinite(width) || !Number.isFinite(height) || width === 0 || height === 0) {
    return fallback;
  }
  const wantLandscape = width > height;
  return allowed.find((candidate) => {
    const [candidateWidth, candidateHeight] = candidate.split(':');
    if (candidateHeight === undefined) return false;
    const candidateWidthValue = Number(candidateWidth.trim());
    const candidateHeightValue = Number(candidateHeight.trim());
    if (!Number.isFinite(candidateWidthValue) || !Number.isFinite(candidateHeightValue)) return false;
    return candidateWidthValue > candidateHeightValue === wantLandscape;
  }) ?? fallback;
}

/**
 * 画幅最终值。白名单模型即使在用户没选画幅时也要落到文档默认值 ——
 * 让平台用它自己的默认(seedance-v2-720p = `9:16`)会与用户看到的界面对不上。
 */
export function resolveWgspaiAspectRatio(
  spec: WgspaiModelSpec,
  aspectRatio: string | undefined,
): string | undefined {
  const requested = aspectRatio?.trim() ?? '';
  if (!spec.allowedRatios) {
    return requested.length > 0 ? requested : undefined;
  }
  if (requested.length === 0) return spec.fallbackRatio;
  if (spec.allowedRatios.includes(requested)) return requested;
  return snapRatio(requested, spec.allowedRatios, spec.fallbackRatio);
}

// ---------------------------------------------------------------------------
// 提示词引用标记方言本地化
// ---------------------------------------------------------------------------

type TokenKind = 'image' | 'audio' | 'video';

interface ReferenceToken {
  kind: TokenKind;
  number: number;
  /** token 的长度(含前缀)。 */
  length: number;
}

const TOKEN_PREFIXES: readonly { prefix: string; kind: TokenKind; bracketed: boolean }[] = [
  // `@图片` 必须排在 `@图` 前面: 前者是后者的前缀延长, 顺序反了会把 `片` 当数字段。
  { prefix: '@图片', kind: 'image', bracketed: false },
  { prefix: '@图', kind: 'image', bracketed: false },
  { prefix: '@音频', kind: 'audio', bracketed: false },
  { prefix: '@audio', kind: 'audio', bracketed: false },
  { prefix: '@video', kind: 'video', bracketed: false },
  { prefix: '[image', kind: 'image', bracketed: true },
  { prefix: '[audio', kind: 'audio', bracketed: true },
  { prefix: '[video', kind: 'video', bracketed: true },
];

/**
 * 从 `index` 开始识别一个引用标记。
 *
 * 接受的前缀形态: `@图` / `@图片` / `@音频` / `@audio` / `@video`(画布词法 + 文档
 * 里手写的 `@图片1`), 以及方括号形态 `[image…]` / `[audio…]` / `[video…]`,
 * 方括号内允许 `_` 分隔(`[audio_1]` 是文档 §3.3 的写法)。
 *
 * **刻意不认裸 `图1`**: 「参考图1」「如图1所示」这类普通正文会被误伤, 而画布自己
 * 产出的 token 一定带 `@` 或 `[]`(见 `referenceTokenEditing.ts` 的词法)。
 */
function parseReferenceToken(text: string, index: number): ReferenceToken | undefined {
  const tail = text.slice(index);
  for (const { prefix, kind, bracketed } of TOKEN_PREFIXES) {
    if (!tail.startsWith(prefix)) continue;
    let rest = tail.slice(prefix.length);
    if (bracketed && rest.startsWith('_')) rest = rest.slice(1);
    const digits = /^\d+/.exec(rest);
    if (!digits) continue;
    const number = Number(digits[0]);
    if (!Number.isFinite(number)) continue;
    let length = (tail.length - rest.length) + digits[0].length;
    if (bracketed) {
      if (rest.charAt(digits[0].length) !== ']') continue;
      length += 1;
    }
    return { kind, number, length };
  }
  return undefined;
}

function renderToken(dialect: WgspaiReferenceDialect, kind: TokenKind, number: number): string | undefined {
  if (dialect === 'keep') return undefined;
  if (dialect === 'at-picture') {
    // seedance2.5 文档只有图片标记; 音频/视频没有定义 → 原样保留, 不臆造。
    return kind === 'image' ? `@图片${number}` : undefined;
  }
  if (kind === 'image') return `[image${number}]`;
  if (kind === 'audio') return `[audio_${number}]`;
  return `[video_${number}]`;
}

export interface WgspaiReferenceCounts {
  images: number;
  audios: number;
  videos: number;
}

/**
 * 把画布的规范引用标记翻成目标模型认的方言。
 *
 * 只换写法, 不重编号 —— N 与素材数组下标一一对应(1 起), 重编号会把对应关系改错。
 * 索引超出本次实际提交的数量(素材被上限截断、或模型不支持该通道)时保持原样。
 */
export function localizeWgspaiReferenceTokens(
  prompt: string,
  dialect: WgspaiReferenceDialect,
  counts: WgspaiReferenceCounts,
): string {
  if (dialect === 'keep' || prompt.length === 0) return prompt;

  let out = '';
  let cursor = 0;
  while (cursor < prompt.length) {
    const token = parseReferenceToken(prompt, cursor);
    if (!token) {
      const char = prompt.charAt(cursor);
      out += char;
      cursor += char.length;
      continue;
    }
    const limit =
      token.kind === 'image' ? counts.images : token.kind === 'audio' ? counts.audios : counts.videos;
    const raw = prompt.slice(cursor, cursor + token.length);
    const rendered =
      token.number >= 1 && token.number <= limit ? renderToken(dialect, token.kind, token.number) : undefined;
    out += rendered ?? raw;
    cursor += token.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 请求体
// ---------------------------------------------------------------------------

export interface WgspaiResolvedReferences {
  images: string[];
  audios: string[];
  videos: string[];
}

export interface WgspaiRequestBodyInput {
  apiModel: string;
  prompt: string;
  duration: number;
  aspectRatio?: string;
  videoResolution?: string;
  imageMode?: string;
  references: WgspaiResolvedReferences;
  /**
   * 是否附带炳火继承的 `generate_audio` / `n`。
   * 族 1 保留(不改变既有行为); 族 2 是本次新支持的, 没有"既有行为"需要保,
   * 按文档最小集提交更安全。
   */
  includeLegacyCompatFields?: boolean;
}

/**
 * 构造提交请求体。**纯函数** —— 提交路径与单测共用同一份构造逻辑, 避免测试里
 * 再抄一遍字段名(抄出来的那份永远是对的, 线上那份永远错)。
 */
export function buildWgspaiRequestBody(input: WgspaiRequestBodyInput): Record<string, unknown> {
  const spec = resolveWgspaiModelSpec(input.apiModel);
  const isFirstLast = input.imageMode === 'first-last';
  const prompt = localizeWgspaiReferenceTokens(input.prompt, spec.dialect, {
    images: input.references.images.length,
    audios: input.references.audios.length,
    videos: input.references.videos.length,
  });
  const seconds = resolveWgspaiDuration(spec.duration, input.duration);
  const aspectRatio = resolveWgspaiAspectRatio(spec, input.aspectRatio);
  const pixelSize = aspectRatio ? wgspaiPixelSize(aspectRatio) : undefined;
  const resolution = input.videoResolution?.trim();

  if (spec.family === 'videos') {
    const body: Record<string, unknown> = { model: input.apiModel, prompt };
    // 非文档字段, 从炳火协议继承; 保留以不改变既有行为(见 wgspai.rs 文件头说明)。
    if (input.includeLegacyCompatFields !== false) {
      body.generate_audio = true;
      body.n = 1;
    }
    if (seconds !== undefined) body.seconds = String(seconds);
    if (aspectRatio) {
      // `ratio` 与 `size` 同传: seedance2.5 / Minimax-h3 认 ratio,
      // seedance-v2-720p 的正式字段是 size, 只发 ratio 会被它忽略。
      body.ratio = aspectRatio;
      if (pixelSize) body.size = pixelSize;
    }
    if (input.references.images.length > 0) {
      body.images = input.references.images;
      // 首尾帧模式: 文档口径是 `images` + `image_usage: first_frame`
      // (第 1 张作首帧), 不是炳火那套 start_frame / end_frame。
      if (isFirstLast) body.image_usage = 'first_frame';
    }
    if (input.references.audios.length > 0) body.audio_urls = input.references.audios;
    if (input.references.videos.length > 0) body.video_urls = input.references.videos;
    if (resolution) body.resolution = resolution;
    return body;
  }

  // 族 2: 除 model / prompt 外的参数一律进 `params`(总览文档「创建任务」节)。
  const params: Record<string, unknown> = {};
  if (seconds !== undefined) params.seconds = String(seconds);
  if (aspectRatio) {
    params.ratio = aspectRatio;
    if (pixelSize) params.size = pixelSize;
  }
  // seedance-v2 的 `-video` 模型按文档走类型化 `params.content`
  // (能同时带图 / 视频 / 音频); 其余用平铺的 `images` / `videos` / `audios`。
  if (input.references.videos.length > 0 && spec.dialect === 'bracketed') {
    params.content = [
      ...input.references.images.map((url) => ({
        type: 'image_url',
        image_url: { url },
        role: 'reference_image',
      })),
      ...input.references.videos.map((url) => ({
        type: 'video_url',
        video_url: { url },
        role: 'reference_video',
      })),
      ...input.references.audios.map((url) => ({
        type: 'audio_url',
        audio_url: { url },
        role: 'reference_audio',
      })),
    ];
  } else {
    if (input.references.images.length > 0) params.images = input.references.images;
    if (input.references.audios.length > 0) params.audios = input.references.audios;
    const [first] = input.references.videos;
    if (first) {
      // flashvsr-restore 的输入视频字段是单数 `video_url`(总览文档「工作流类 /
      // 标准 API 模型」一节), 不是数组。
      if (spec.singleVideoUrl) params.video_url = first;
      else params.videos = input.references.videos;
    }
  }
  if (resolution) params.resolution = resolution;
  return { model: input.apiModel, prompt, params };
}

/** 提交端点(族别决定)。 */
export function wgspaiSubmitPath(spec: WgspaiModelSpec): string {
  return spec.family === 'task' ? WGSPAI_TASK_SUBMIT_PATH : WGSPAI_VIDEOS_SUBMIT_PATH;
}

/** 查询端点模板(族别决定)。 */
export function wgspaiQueryPath(spec: WgspaiModelSpec): string {
  return spec.family === 'task' ? WGSPAI_TASK_QUERY_PATH : `${WGSPAI_VIDEOS_SUBMIT_PATH}/{taskId}`;
}

/**
 * UI 时长档位。与 `resolveWgspaiDuration` 同源 —— 下拉里能选到的值, 提交时一定
 * 原样生效(不会被静默吸附到别的秒数), 否则用户选了 12 秒却拿到 30 秒的成片。
 *
 *   - 区间模型(seedance-v2-720p / Minimax-h3 / sd-2) → 展开成整数枚举;
 *   - 固定时长模型(seedance2.5 = 30 秒)             → 只给一个选项;
 *   - 时长编在模型名里(`…-8s-…` / `…-12s-…`)      → 从模型名里解出那一个值;
 *   - 文档未写规则(ltx2.3 / voice-clone 等)        → 交给调用方的 fallback。
 */
export function resolveWgspaiDurationOptions(apiModel: string, fallback: number[]): number[] {
  const spec = resolveWgspaiModelSpec(apiModel);
  switch (spec.duration.kind) {
    case 'range': {
      // 先解构: 在 `Array.from` 的箭头函数里重新读 `spec.duration` 会丢掉类型收窄。
      const { min, max } = spec.duration;
      return Array.from({ length: max - min + 1 }, (_, index) => min + index);
    }
    case 'platform-default':
      return spec.fixedDurationSeconds === undefined ? fallback : [spec.fixedDurationSeconds];
    case 'in-model-name': {
      // `LongXia-O-sora2-pro-8s-9x16` → 8; `…-veo31-8s-…-1080p` 不能把 1080 当秒数,
      // 所以数字后面必须紧跟 `s` 且再往后是 `-` 或结束。
      const match = /(\d+)s(?:-|$)/.exec(apiModel.trim().toLowerCase());
      const seconds = match ? Number(match[1]) : Number.NaN;
      return Number.isFinite(seconds) && seconds > 0 ? [seconds] : fallback;
    }
    case 'passthrough':
      return fallback;
  }
}

/**
 * UI 画幅档位。白名单模型只放白名单值(seedance-v2 文档 §3.4: 仅 `9:16` / `16:9`,
 * 不要传 `1:1`)—— 下拉里给不出来的值, 用户就不会选到。
 */
export function resolveWgspaiAspectRatioOptions(apiModel: string, fallback: readonly string[]): string[] {
  const spec = resolveWgspaiModelSpec(apiModel);
  return spec.allowedRatios ? [...spec.allowedRatios] : [...fallback];
}

// ---------------------------------------------------------------------------
// 业务错误包
// ---------------------------------------------------------------------------

/**
 * 总览文档「错误响应」一节的错误体:
 * `{"code": -1, "message": "错误描述", "data": {"code": "error_code", "message": "详细错误信息"}}`
 *
 * 族 2(Task)用它回错误 —— 通用状态判定只认 `status` 字段, 认不出顶层 `code`, 于是
 * 一旦平台用 **HTTP 200** 返回业务错误, 任务会被一直当成"还在跑", 直到轮询窗口耗尽
 * 才报超时。这条与后端 `wgspai.rs::business_error` 同规则。
 */
const RUNNING_STATUSES = new Set([
  'IN_PROGRESS',
  'PROCESSING',
  'PROCESS',
  'RUNNING',
  'QUEUED',
  'QUEUE',
  'PENDING',
  'SUBMITTED',
  'SUBMIT',
  'GENERATING',
  'GENERATE',
  'IN_QUEUE',
  'WAITING',
  'CREATED',
  'INIT',
  'INITIALIZING',
  'STARTED',
  'NOT_START',
  'NOT_STARTED',
  'ACTIVE',
  'DOING',
]);

/** 从错误体里挖出**人能读的那句话**, 内层被再次序列化的 JSON 继续往下钻。 */
function readBusinessErrorReason(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return readBusinessErrorReason(JSON.parse(trimmed), depth + 1) ?? trimmed;
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }
  if (typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  // 键序 = 优先级, 与后端 `extract_error_reason` 一致。
  for (const key of [
    'error',
    'fail_reason',
    'failure_reason',
    'failReason',
    'failureReason',
    'message',
    'msg',
    'error_message',
    'errorMessage',
    'reason',
    'detail',
  ]) {
    if (!(key in record)) continue;
    const found = readBusinessErrorReason(record[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}

/**
 * 平台是否回了业务错误。`status` 由调用方的状态读取器给出(已大写) ——
 * 平台**明确说"还在跑"时一律不采信** code, 否则一次误判就把已计费的长任务判死,
 * 而平台还在跑, 成片永久收不回(与 `classify` 的铁律同源)。
 */
export function describeWgspaiBusinessError(payload: unknown, status: string): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const code = (payload as Record<string, unknown>).code;
  const isErrorCode =
    typeof code === 'number'
      ? code !== 0
      : typeof code === 'string'
        ? !['', '0', '200', 'success', 'ok'].includes(code.trim().toLowerCase())
        : false;
  if (!isErrorCode) return undefined;
  const normalized = status.trim().toUpperCase().replace(/[\s-]/g, '_');
  if (RUNNING_STATUSES.has(normalized)) return undefined;
  return readBusinessErrorReason(payload) ?? `平台返回业务错误 code=${String(code)}`;
}

