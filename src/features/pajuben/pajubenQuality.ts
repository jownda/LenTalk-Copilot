// ---------------------------------------------------------------------------
// 「扒视频」画质档位：把引擎的三个抽帧参数(fps / resolution / maxFrames)打包成
// 快速 / 标准 / 精细三档，画布上的「扒视频」与工作台共用同一套取值。
//
// 为什么要分档：单次模型请求的帧数上限是固定的(引擎里 PER_REQUEST_FRAME_CAP=120，
// 每段 ≤120 帧)，总帧数只能靠 fps 与分段数堆出来。所以档位之间的真实差异是
// 「每秒抽几帧 + 画面多清晰」，而不是简单地把帧数上限调大。
//   - 快速   fps=1 / 低清    → 与旧默认一致，最省 token；
//   - 标准   fps=2 / 中清    → 帧数与清晰度各翻一档，日常推荐；
//   - 精细   fps=3 / 高清    → 密集抽帧 + 全清晰度，字幕/微表情最清楚，耗时与费用最高。
// resolution 的取值必须与引擎 RES_LONGEDGE(low 512 / medium 768 / high 1024) 对齐。
// ---------------------------------------------------------------------------

export type PajubenQualityTier = 'fast' | 'standard' | 'fine';

export type PajubenResolution = 'low' | 'medium' | 'high';

export interface PajubenQualityPreset {
  tier: PajubenQualityTier;
  /** 每秒抽帧数；引擎会按分段时长与单请求上限再收敛。 */
  fps: number;
  /** 画面清晰度，决定抽帧缩放的长边像素。 */
  resolution: PajubenResolution;
  /** 单集帧数上限；超过单请求上限(120)的部分只影响分段数，不增加单次负担。 */
  maxFrames: number;
}

/** UI 展示顺序：由省到精。 */
export const PAJUBEN_QUALITY_TIERS: PajubenQualityTier[] = ['fast', 'standard', 'fine'];

export const PAJUBEN_QUALITY_PRESETS: Record<PajubenQualityTier, PajubenQualityPreset> = {
  fast: { tier: 'fast', fps: 1, resolution: 'low', maxFrames: 120 },
  standard: { tier: 'standard', fps: 2, resolution: 'medium', maxFrames: 240 },
  fine: { tier: 'fine', fps: 3, resolution: 'high', maxFrames: 400 },
};

/** 首次使用(或历史配置没有该字段)时的默认档位。 */
export const DEFAULT_PAJUBEN_QUALITY_TIER: PajubenQualityTier = 'standard';

export function isPajubenQualityTier(value: unknown): value is PajubenQualityTier {
  return typeof value === 'string' && value in PAJUBEN_QUALITY_PRESETS;
}

/** 取值可能是持久化里来的脏字符串 —— 非法/缺失一律回落到默认档，避免生成参数变成 undefined。 */
export function resolvePajubenQualityPreset(value: unknown): PajubenQualityPreset {
  return isPajubenQualityTier(value)
    ? PAJUBEN_QUALITY_PRESETS[value]
    : PAJUBEN_QUALITY_PRESETS[DEFAULT_PAJUBEN_QUALITY_TIER];
}
