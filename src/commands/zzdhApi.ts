/**
 * 字子动画(zizidonghua.com)专有链路 —— 所有事实来自官方文档, 2026-09-12 核对。
 *
 * 文档入口:
 *   - /api-docs/video-generation   视频生成(文生/首尾帧/参考生 + Kling/Omni 专章)
 *   - /api-docs/image-generation   图片生成(OpenAI 兼容)
 *   - /api-docs/services           服务类(TTS / 音效 / 音乐 / 嵌入 / 重排)
 *   - /api-docs/model/{model}      单模型字段表(以模型页为准)
 *   原始数据: GET /api/api-docs/sections | /api/api-docs/section/{slug} | /api/api-docs/model/{model}
 *
 * 关键约束(照抄文档, 不要凭猜):
 *   1. `/v8` 与 `/v1` 字段互相兼容: `reference_images` / `reference_audios` /
 *      `reference_videos` 与 `/v1` 的 `metadata.content`、`images`、`seconds` 都能用;
 *      老字段 `image` / `input_reference` / `size` 也会自动对齐。
 *   2. `resolution`、`aspect_ratio`、`reference_images` 必须放在请求顶层,
 *      不要放进 `settings` / `metadata` 信封。
 *   3. `resolution` 优先于 `aspect_ratio` —— 两者冲突时以 resolution 为准,
 *      所以「推导出画幅」之后必须用同一个画幅去算 resolution。
 *   4. 画幅枚举只有 `16:9` / `9:16` / `1:1`(文档「宽高比与实际尺寸」+ 常见问题)。
 *      方形请求 720x720 会被上游归一化成 960x960, 不能假设像素等于请求值。
 *   5. H3 分辨率由**模型名**锁定, 请求体里的 `resolution` 不改档(故 H3 不传)。
 *   6. H3 不支持 `negative_prompt`; Kling 系列没有 `mode` 字段。
 *   7. `mode` 不传时"有参考图/视频/音频一律走参考生", 选首尾帧必须显式传 `fl2v`。
 *   8. 参考图 URL 要公网可直连, 且路径显式以 `.jpeg` / `.jpg` / `.png` / `.webp` 结尾;
 *      无扩展名的签名 URL 可能被上游拒绝。H3 单模型文档只接受 `{ url, role }`，本地
 *      图片必须先上传到可公开访问的图床或 CDN，不能伪装成 `url` 或依赖 `base64` 兼容。
 *   9. 名称含 `-video` 的模型是**视频参考**调用, 必须传 `reference_videos`。
 *  10. 提交被拒绝的请求不扣费; 失败任务会退款。
 */

/** 平台域名特征(中英文平台 id 都可能出现, 用户自建时 id 常是「字子动画」)。 */
const ZZDH_HOST_MARKER = 'zizidonghua.com';
const ZZDH_PROVIDER_ID_ALIASES = ['zizidonghua', '字子动画', '字字动画'];

export function isZzdhProviderId(providerId: string): boolean {
  const normalized = providerId.trim().toLowerCase().replace(/^custom:/, '');
  return ZZDH_PROVIDER_ID_ALIASES.some((alias) => alias === normalized);
}

export function isZzdhBaseUrl(baseUrl?: string): boolean {
  return (baseUrl ?? '').trim().toLowerCase().includes(ZZDH_HOST_MARKER);
}

/** 平台 id 或 Base URL 任一命中即视为字子动画链路。 */
export function isZzdhProvider(providerId: string, baseUrl?: string): boolean {
  return isZzdhProviderId(providerId) || isZzdhBaseUrl(baseUrl);
}

// ---------------------------------------------------------------------------
// 端点(文档「调用入口」原文)
// ---------------------------------------------------------------------------

/** 视频: 统一异步入口(推荐), 提交 + 轮询 + 内容直取。 */
export const ZZDH_VIDEO_SUBMIT_PATH = '/v8/videos/generations';
export const ZZDH_VIDEO_QUERY_PATH = '/v8/videos/generations/{taskId}';
export const ZZDH_VIDEO_CONTENT_PATH = '/v1/videos/{taskId}/content';

/** 图片: OpenAI 兼容文生图/图生图。 */
export const ZZDH_IMAGE_SUBMIT_PATH = '/v1/images/generations';

/** 音频: OpenAI 兼容语音合成 / 音效 / 音乐。 */
export const ZZDH_AUDIO_SPEECH_PATH = '/v1/audio/speech';
export const ZZDH_AUDIO_SOUND_EFFECTS_PATH = '/v1/audio/sound-effects';
export const ZZDH_AUDIO_MUSIC_PATH = '/v1/audio/music';

/** `/v8` 形态的等价入口(文档「调用入口」列出, `/v1` 不通时可回退)。 */
export const ZZDH_IMAGE_SUBMIT_PATH_V8 = '/v8/images/generations';
export const ZZDH_AUDIO_SPEECH_PATH_V8 = '/v8/audio/speech';

export type ZzdhAudioKind = 'speech' | 'sound-effects' | 'music';

const ZZDH_AUDIO_KIND_PATTERNS: Array<{ kind: ZzdhAudioKind; pattern: RegExp }> = [
  // 音乐生成: eleven_music_v1 / eleven_music_v2 / suno / mureka / music...
  { kind: 'music', pattern: /(?:^|[-_./])(?:music|suno|mureka|ace[-_]?step)(?:[-_./]|\d|$)/ },
  // 音效: eleven_text_to_sound_v2 / text-to-sound / sound-effect / sfx
  { kind: 'sound-effects', pattern: /(?:^|[-_./])(?:text[-_]?to[-_]?sound|sound[-_]?effects?|sfx)(?:[-_./]|\d|$)/ },
  // 其余语音合成: eleven_* / tts / speech / voice / indextts...
  { kind: 'speech', pattern: /(?:^|[-_./])(?:tts|speech|voice|audio|eleven|indextts|vocoder|cosyvoice)(?:[-_./]|\d|$)/ },
];

/**
 * 按模型名判定它属于哪条音频端点(文档按系列分三个入口)。
 *
 * 规则本身与平台无关(只看名字里的 music / sfx / tts 等词), 因此音频节点把模型分到
 * 「声音克隆 / 文字转语音 / 音乐创作」三个面板时也用这一套 —— 名字带 Zzdh 是历史原因,
 * 不要误以为只服务字子动画(知鸟的 `music`、FHL 的 `suno-v3` 同样靠它归位)。
 */
export function resolveZzdhAudioKind(model: string): ZzdhAudioKind | null {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return null;
  for (const entry of ZZDH_AUDIO_KIND_PATTERNS) {
    if (entry.pattern.test(normalized)) return entry.kind;
  }
  return null;
}

export function resolveZzdhAudioPath(kind: ZzdhAudioKind): string {
  if (kind === 'sound-effects') return ZZDH_AUDIO_SOUND_EFFECTS_PATH;
  if (kind === 'music') return ZZDH_AUDIO_MUSIC_PATH;
  return ZZDH_AUDIO_SPEECH_PATH;
}

/** 文档示例里的默认音色与格式(字段都是可选项, 不传时平台有默认)。 */
export const ZZDH_BASE_DEFAULT_VOICE = 'alloy';
export const ZZDH_DEFAULT_AUDIO_FORMAT = 'mp3';

// ---------------------------------------------------------------------------
// 画幅
// ---------------------------------------------------------------------------

/** 官方文档枚举, 只有这三个。 */
export const ZZDH_ASPECT_RATIOS = ['16:9', '9:16', '1:1'] as const;
export type ZzdhAspectRatio = (typeof ZZDH_ASPECT_RATIOS)[number];

const ZZDH_ASPECT_RATIO_VALUES: Record<ZzdhAspectRatio, number> = {
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '1:1': 1,
};

/** 把任意画幅字符串收敛到官方枚举(不合法时回退, 默认 16:9)。 */
export function resolveZzdhAspectRatio(value: string | undefined, fallback: ZzdhAspectRatio = '16:9'): ZzdhAspectRatio {
  const normalized = (value ?? '').trim();
  const hit = ZZDH_ASPECT_RATIOS.find((candidate) => candidate === normalized);
  return hit ?? fallback;
}

/** 按图片实际宽高取最接近的官方画幅(首帧生视频时跟随首帧比例)。 */
export function resolveZzdhAspectRatioFromSize(width: number, height: number): ZzdhAspectRatio {
  if (!(width > 0) || !(height > 0)) return '16:9';
  const ratio = width / height;
  let best: ZzdhAspectRatio = '16:9';
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const candidate of ZZDH_ASPECT_RATIOS) {
    const diff = Math.abs(ZZDH_ASPECT_RATIO_VALUES[candidate] - ratio);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = candidate;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 视频档位 / 时长
// ---------------------------------------------------------------------------

export type ZzdhResolutionTier = '480p' | '540p' | '720p' | '768p' | '1080p' | '2k' | '4k';

/** 字字动画限时优惠对口型模型名。旧版已保存的平台配置也要能显示它们。 */
export const ZZDH_LIP_SYNC_MODEL_NAMES = [
  'zzdh-minimax-h3-限时优惠-对口型-480p',
  'zzdh-minimax-h3-限时优惠-对口型-768p',
] as const;

/** 档位写在模型名里(如 zzdh-Minimax-h3-480p、doubao-seedance-2-video-4k)。 */
export function resolveZzdhResolutionTier(model: string): ZzdhResolutionTier | null {
  const hit = model.trim().toLowerCase().match(/(?:^|[-_])(480p|540p|720p|768p|1080p|2k|4k)(?:[-_]|$)/);
  return (hit?.[1] as ZzdhResolutionTier | undefined) ?? null;
}

/**
 * H3 时长上限按档位区分(官方模型页): 480P 档 5~10 秒, 其余档位 5~15 秒。
 * 非 H3(如 seedance/wan/Kling)文档未给范围, 返回 null 表示不额外收窄。
 */
export function resolveZzdhVideoDurationRange(model: string): { min: number; max: number } | null {
  const family = resolveZzdhVideoFamily(model);
  if (family !== 'minimax-h3') return null;
  const tier = resolveZzdhResolutionTier(model);
  return {
    min: 5,
    max: tier === '480p' ? 10 : 15,
  };
}

/** 非 H3 视频模型的兜底时长(文档「可用范围受具体模型限制」, 未给具体值)。 */
export const ZZDH_VIDEO_DURATION_OPTIONS = Array.from({ length: 30 }, (_, index) => index + 1);

export type ZzdhVideoFamily = 'minimax-h3' | 'kling' | 'seedance' | 'wan' | 'happyhorse' | 'other';

/** 产品线判定 —— role 语义、mode 支持、时长范围都按产品线分。 */
export function resolveZzdhVideoFamily(model: string): ZzdhVideoFamily {
  const normalized = model.trim().toLowerCase();
  if (normalized.includes('minimax') || normalized.includes('h3')) return 'minimax-h3';
  if (normalized.includes('kling')) return 'kling';
  if (normalized.includes('seedance') || normalized.includes('doubao')) return 'seedance';
  if (normalized.includes('wan')) return 'wan';
  if (normalized.includes('happyhorse')) return 'happyhorse';
  return 'other';
}

/** 名称含 `-video`(或在 `-video-` 段)的模型是视频参考调用, 必须传 reference_videos。 */
export function isZzdhVideoReferenceModel(model: string): boolean {
  return /(?:^|[-_])video(?:[-_]|$)/.test(model.trim().toLowerCase());
}

/** 字子动画专用对口型模型，不能出现在普通视频节点里。 */
export function isZzdhLipSyncModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized.includes('对口型')
    || normalized.includes('lip-sync')
    || normalized.includes('lipsync');
}

export type ZzdhReferenceRole = 'first_frame' | 'last_frame' | 'reference_image';

/**
 * 参考图 role 语义(文档):
 *   - H3「图文参考」支持 文生 / 图生 / 首尾帧 / 参考生, role 三值齐全;
 *   - Kling 只支持 首帧参考(+ 第二张可作尾帧), **没有参考生** —— 给它发
 *     `reference_image` 属于超出文档的字段, 所以统一映射成首帧/尾帧。
 */
export function resolveZzdhReferenceRole(
  family: ZzdhVideoFamily,
  imageMode: 'reference' | 'first-last' | undefined,
  index: number,
): ZzdhReferenceRole {
  // H3 的参考生模式: 全部标 reference_image(标成 first_frame 会被当成首帧生视频)。
  if (family === 'minimax-h3' && imageMode !== 'first-last') return 'reference_image';
  return index === 0 ? 'first_frame' : 'last_frame';
}

/**
 * H3 的 `mode` 取值(文档 `t2v` / `fl2v` / `ref2v`)。
 *
 * 不传 mode 时"有参考图/视频/音频一律走参考生", 所以选了首尾帧也必须显式传 fl2v,
 * 否则会被静默当成参考生执行 —— 仅靠 role 不足以纠正。
 *
 * 例外: 4K 档模型页只写「文生 / 图生 / 首尾帧」(无参考生), 因此有图时按
 * 首帧生视频(fl2v)提交, 不发 ref2v。
 */
export function resolveZzdhGenerationMode(
  imageMode: string | undefined,
  imageCount: number,
  model?: string,
): 't2v' | 'fl2v' | 'ref2v' {
  if (imageMode === 'first-last') return 'fl2v';
  if (imageCount <= 0) return 't2v';
  const supportsReferenceGeneration = !model || resolveZzdhResolutionTier(model) !== '4k';
  return supportsReferenceGeneration ? 'ref2v' : 'fl2v';
}

/** H3 不支持 `negative_prompt`(文档原文), 其它系列未声明。 */
export function supportsZzdhNegativePrompt(model: string): boolean {
  return resolveZzdhVideoFamily(model) !== 'minimax-h3';
}
