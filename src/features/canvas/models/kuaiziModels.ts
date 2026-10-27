// ---------------------------------------------------------------------------
// 筷子AI(aiopenapi.kuaizi.cn)视频档位表 —— 逐模型登记, 不做通用兜底表。
//
// 数据源:《视频生成 兼容接口文档》v1.6「分档参数矩阵」原文
//
//   model                            resolution                duration  参考图  参考视频  参考音频
//   doubao-seedance-2-0-260128      480p/720p/1080p/4k        4~15       ≤9      ≤3      ≤3
//   doubao-seedance-2-0-fast-260128 480p/720p/1080p           4~15       ≤9      ≤3      ≤3
//   doubao-seedance-2-0-mini-260615 480p/720p/1080p           4~15       ≤9      ≤3      ≤3
//   doubao-seedance-2-5-260628      480p/720p/1080p           4~30       ≤30     ≤10     ≤10
//
// 为什么必须逐模型登记:
//   - `4k` **只有 pro**(`doubao-seedance-2-0-260128`)支持, 2.5 明确不支持;
//   - 2.5 的时长上限是 **30 秒**, 其余三个是 **15 秒**。用一份通用档位表会出现
//     「下拉里选了 30 秒、平台按 15 秒校验直接报错」或反过来「只能选到 15 秒」——
//     这正是接入后用户在节点里看不到 30 秒 / 4K 的原因。
//
// 画幅: 文档枚举为 16:9 / 4:3 / 1:1 / 3:4 / 9:16 / 21:9 / adaptive。
// 这里刻意**不收 adaptive** —— 软件画幅下拉没有「自适应」这一档, 且除 2.5 的首帧 /
// 首尾帧 / 视频编辑 / 视频延长四类任务外, 传具体比例都合法。2.5 的那条硬约束由
// 协议层(ark.rs)在提交时自动改成 adaptive, 不靠用户选。
// ---------------------------------------------------------------------------

/** 筷子 4 个官方模型的画幅枚举(取自文档 ratio 字段说明, 去掉 adaptive)。 */
export const KZ_ASPECT_RATIOS = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'] as const;

export interface KuaiziVideoOptionEntry {
  /** 下拉展示名 —— 平台原文是 `doubao-seedance-2-0-260128` 这种内部 Model ID。 */
  label: string;
  /** 官方 duration 区间(闭区间, 文档给的是「4~15」「4~30」这种范围而非枚举)。 */
  durationRange: readonly [number, number];
  resolutionValues: string[];
  aspectRatios: string[];
  /** 参考图上限(content 里 image_url 的条数)。 */
  maxImages: number;
  /** 参考音频上限。 */
  maxAudios: number;
  /**
   * 2.5 专属约束: 首帧 / 首尾帧、视频编辑、视频延长三类任务 `ratio` **必须** adaptive。
   * 其余模型没这条限制。
   */
  firstLastRequiresAdaptiveRatio: boolean;
}

const KZ_2_0_RESOLUTIONS = ['480p', '720p', '1080p'];
const KZ_2_0_DURATION: readonly [number, number] = [4, 15];
const KZ_2_5_DURATION: readonly [number, number] = [4, 30];

export const KZ_VIDEO_OPTION_TABLE: Record<string, KuaiziVideoOptionEntry> = {
  'doubao-seedance-2-0-260128': {
    label: 'Seedance 2.0 Pro（4K）',
    durationRange: KZ_2_0_DURATION,
    // 4k 仅此一个模型支持
    resolutionValues: [...KZ_2_0_RESOLUTIONS, '4k'],
    aspectRatios: [...KZ_ASPECT_RATIOS],
    maxImages: 9,
    maxAudios: 3,
    firstLastRequiresAdaptiveRatio: false,
  },
  'doubao-seedance-2-0-fast-260128': {
    label: 'Seedance 2.0 Fast',
    durationRange: KZ_2_0_DURATION,
    resolutionValues: [...KZ_2_0_RESOLUTIONS],
    aspectRatios: [...KZ_ASPECT_RATIOS],
    maxImages: 9,
    maxAudios: 3,
    firstLastRequiresAdaptiveRatio: false,
  },
  'doubao-seedance-2-0-mini-260615': {
    label: 'Seedance 2.0 Mini',
    durationRange: KZ_2_0_DURATION,
    resolutionValues: [...KZ_2_0_RESOLUTIONS],
    aspectRatios: [...KZ_ASPECT_RATIOS],
    maxImages: 9,
    maxAudios: 3,
    firstLastRequiresAdaptiveRatio: false,
  },
  'doubao-seedance-2-5-260628': {
    label: 'Seedance 2.5（30 秒）',
    durationRange: KZ_2_5_DURATION,
    resolutionValues: [...KZ_2_0_RESOLUTIONS],
    aspectRatios: [...KZ_ASPECT_RATIOS],
    maxImages: 30,
    maxAudios: 10,
    firstLastRequiresAdaptiveRatio: true,
  },
};

/**
 * 表外模型(平台新上型号、或用户手工填了别的 Model ID)的兜底:
 * 取 2.0 与 2.5 的**交集** —— 4~15 秒、480p/720p/1080p。宁可少给档位,
 * 也不要把 2.5 才有的 30 秒 / pro 才有的 4k 发到什么都不知道的型号上。
 */
const KZ_FALLBACK: KuaiziVideoOptionEntry = {
  label: '',
  durationRange: KZ_2_0_DURATION,
  resolutionValues: [...KZ_2_0_RESOLUTIONS],
  aspectRatios: [...KZ_ASPECT_RATIOS],
  maxImages: 9,
  maxAudios: 3,
  firstLastRequiresAdaptiveRatio: false,
};

/** 文档默认值: `resolution` 默认 720p、`duration` 默认 5 秒。 */
export const KZ_DEFAULT_RESOLUTION = '720p';
export const KZ_DEFAULT_DURATION = 5;

/** 按 Base URL 认筷子 —— 平台 id 可能被改成任意值, 域名是稳定的。 */
export function isKuaiziBaseUrl(baseUrl?: string): boolean {
  return (baseUrl ?? '').trim().toLowerCase().includes('kuaizi.cn');
}

export function resolveKuaiziVideoEntry(model: string): KuaiziVideoOptionEntry {
  const normalized = model.trim().toLowerCase();
  return KZ_VIDEO_OPTION_TABLE[normalized] ?? KZ_FALLBACK;
}

function rangeToOptions(range: readonly [number, number]): number[] {
  const [min, max] = range;
  return Array.from({ length: Math.max(0, max - min + 1) }, (_, index) => min + index);
}

/**
 * 交给 registry 的档位包。
 *
 * `defaultDuration` 取文档默认的 5 秒(落在所有模型的 4~15 / 4~30 区间内);
 * `defaultResolution` 取 720p。两者都保证「默认值一定在可选档位里」。
 */
export function resolveKuaiziVideoOptions(model: string): {
  label: string;
  durationOptions: number[];
  defaultDuration: number;
  resolutionValues: string[];
  defaultResolution: string;
  aspectRatios: string[];
  maxImages: number;
  maxAudios: number;
  firstLastRequiresAdaptiveRatio: boolean;
} {
  const entry = resolveKuaiziVideoEntry(model);
  return {
    label: entry.label,
    durationOptions: rangeToOptions(entry.durationRange),
    defaultDuration: KZ_DEFAULT_DURATION,
    resolutionValues: [...entry.resolutionValues],
    defaultResolution: entry.resolutionValues.includes(KZ_DEFAULT_RESOLUTION)
      ? KZ_DEFAULT_RESOLUTION
      : (entry.resolutionValues[0] ?? KZ_DEFAULT_RESOLUTION),
    aspectRatios: [...entry.aspectRatios],
    maxImages: entry.maxImages,
    maxAudios: entry.maxAudios,
    firstLastRequiresAdaptiveRatio: entry.firstLastRequiresAdaptiveRatio,
  };
}

/**
 * 提交侧要用的数量上限(协议层裁参考素材条数)。
 *
 * 🔴 与 `src-tauri/src/ai/providers/video_protocols/ark.rs` 的 `kuaizi_limits` 是
 *    **两份实现** —— 前端裁了是为了不发无效素材, 后端裁了是为了不因为多传一条
 *    让整单 400。改上限时两处必须一起改。
 */
export function resolveKuaiziVideoLimits(model: string): { maxImages: number; maxAudios: number } {
  const entry = resolveKuaiziVideoEntry(model);
  return { maxImages: entry.maxImages, maxAudios: entry.maxAudios };
}
