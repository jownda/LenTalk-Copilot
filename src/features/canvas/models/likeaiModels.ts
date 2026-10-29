// ---------------------------------------------------------------------------
// likeai520(api.likeai520.cc)视频档位表 —— 按**该渠道实测能力**登记。
//
// 为什么不能照抄官方文档: 平台的参数校验是「型号已开放的值」，而开放值由**渠道配置**
// 决定（文档 §6 原话：「显式填写型号已开放的值」）。本文件是实测快照。
//
// 实测结果(2026-10-28 复测, 720p / 4s 基准):
//   型号                      画幅                                                     分辨率               时长
//   doubao-seedance-2.5       全画幅 16:9/9:16/1:1/4:3/3:4/21:9/adaptive                480p/720p/1080p      4~30
//   doubao-seedance-2.0       全画幅（同上）                                            480p/720p/1080p/4k   4~15
//   doubao-seedance-2.0-fast  全画幅（同上）                                            480p/720p            4~15
//   doubao-seedance-2.0-mini  仅 16:9（9:16 / 1:1 / 4:3 / 3:4 / 21:9 / adaptive 全拒）  480p/720p            4~15
//
// 2026-10-27 首测时 2.5 还只开放 16:9 + 4~15 秒；10-28 平台放开成上面的样子，
// 其它三个型号没变。**这张表就是会随平台配置漂移的**，别把它当常量事实。
//
// 🔴 探测法（2026-10-28 修正）
//    旧法「content 传非法 type，看报错落在哪」**已经失效**：内容校验排在画幅之前，
//    任何画幅都会先撞 `unsupported content type`，量出来的画幅能力全是假的。
//    现法: 发**参数完全合法**的请求 —— 本机 Key 额度不足，会被 402
//    (`insufficient balance or key quota`) 挡在扣费口，参数不合法则先返回 400。
//    ⇒ 402 = 参数通过，400 = 参数被拒，全程零成本。
//    ⚠️ 这招只在**额度不足**的 Key 上安全；额度充实时会真的创建任务并扣费。
//    校验顺序(实测): 分辨率 → 时长 → 画幅 → 内容。
// ---------------------------------------------------------------------------

export interface LikeaiVideoOptionEntry {
  /** 下拉展示名（平台原文是 `doubao-seedance-2.0-mini` 这种内部名）。 */
  label: string;
  aspectRatios: string[];
  resolutionValues: string[];
  /** 闭区间秒数，实测边界。 */
  durationRange: readonly [number, number];
}

const RATIOS_FULL = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'];
const RATIOS_16_9_ONLY = ['16:9'];
const RES_2K = ['480p', '720p', '1080p'];
const RES_2K_4K = ['480p', '720p', '1080p', '4k'];
const DURATION_4_15: readonly [number, number] = [4, 15];
/** 2.5 是唯一开放到 30 秒的型号（31 秒被拒，实测边界）。 */
const DURATION_4_30: readonly [number, number] = [4, 30];

export const LIKEAI_VIDEO_OPTION_TABLE: Record<string, LikeaiVideoOptionEntry> = {
  'doubao-seedance-2.5': {
    label: 'Seedance 2.5（全画幅 / 最长 30 秒）',
    aspectRatios: [...RATIOS_FULL],
    resolutionValues: [...RES_2K],
    durationRange: DURATION_4_30,
  },
  'doubao-seedance-2.0': {
    label: 'Seedance 2.0（支持 4K / 全画幅）',
    aspectRatios: [...RATIOS_FULL],
    resolutionValues: [...RES_2K_4K],
    durationRange: DURATION_4_15,
  },
  'doubao-seedance-2.0-fast': {
    label: 'Seedance 2.0 Fast',
    aspectRatios: [...RATIOS_FULL],
    resolutionValues: [...RES_2K],
    durationRange: DURATION_4_15,
  },
  'doubao-seedance-2.0-mini': {
    label: 'Seedance 2.0 Mini（仅 16:9）',
    aspectRatios: [...RATIOS_16_9_ONLY],
    resolutionValues: [...RES_2K],
    durationRange: DURATION_4_15,
  },
};

/**
 * 表外型号的兜底：**取最保守的交集**（16:9 + 480p/720p + 4~15 秒）。
 *
 * 反例就在本文件里 —— mini 只开放 16:9，2.0 才有 4K、2.5 才有 30 秒。给未知型号
 * 放开画幅，用户选完 9:16 会在提交时吃一个 `supported ratio is required`，
 * 白白浪费一次尝试。
 */
const LIKEAI_FALLBACK: LikeaiVideoOptionEntry = {
  label: '',
  aspectRatios: [...RATIOS_16_9_ONLY],
  resolutionValues: ['480p', '720p'],
  durationRange: DURATION_4_15,
};

export const LIKEAI_DEFAULT_RATIO = '16:9';
export const LIKEAI_DEFAULT_RESOLUTION = '720p';
export const LIKEAI_DEFAULT_DURATION = 4;

export function isLikeaiBaseUrl(baseUrl?: string): boolean {
  const normalized = (baseUrl ?? '').trim().toLowerCase();
  return normalized.includes('likeai520.cc');
}

export function resolveLikeaiVideoEntry(model: string): LikeaiVideoOptionEntry {
  return LIKEAI_VIDEO_OPTION_TABLE[model.trim().toLowerCase()] ?? LIKEAI_FALLBACK;
}

/**
 * 交给 registry 的档位包。
 *
 * `defaultAspectRatio` 必须落在 `aspectRatios` 里 —— mini 只有 16:9 时，
 * 若默认值仍是 9:16，下拉会显示一个并不存在的选项。
 */
export function resolveLikeaiVideoOptions(model: string): {
  label: string;
  aspectRatios: string[];
  defaultAspectRatio: string;
  durationOptions: number[];
  defaultDuration: number;
  resolutionValues: string[];
  defaultResolution: string;
} {
  const entry = resolveLikeaiVideoEntry(model);
  const [min, max] = entry.durationRange;
  return {
    label: entry.label,
    aspectRatios: [...entry.aspectRatios],
    defaultAspectRatio: entry.aspectRatios.includes(LIKEAI_DEFAULT_RATIO)
      ? LIKEAI_DEFAULT_RATIO
      : (entry.aspectRatios[0] ?? LIKEAI_DEFAULT_RATIO),
    durationOptions: Array.from({ length: Math.max(0, max - min + 1) }, (_, index) => min + index),
    defaultDuration: LIKEAI_DEFAULT_DURATION,
    resolutionValues: [...entry.resolutionValues],
    defaultResolution: entry.resolutionValues.includes(LIKEAI_DEFAULT_RESOLUTION)
      ? LIKEAI_DEFAULT_RESOLUTION
      : (entry.resolutionValues[0] ?? LIKEAI_DEFAULT_RESOLUTION),
  };
}

/**
 * 该型号是否支持竖屏。
 *
 * ⚠️ 目前**没有调用点**：下拉里不出现 9:16 已经把话说完了，再补一句提示只是占版面。
 * 保留这个判断是因为渠道能力随时会变（2.5 就在 2026-10-28 放开了全画幅），
 * 真要做「为什么选不到竖屏」的解释时直接能用。
 */
export function likeaiModelSupportsPortrait(model: string): boolean {
  return resolveLikeaiVideoEntry(model).aspectRatios.includes('9:16');
}
