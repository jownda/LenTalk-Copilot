/**
 * Dramaya(video.dramaya.us)视频模型的档位与价格。
 *
 * 事实来源 = 官方开发者文档 `https://playground.dramaya.us/developers`
 * (DEVELOPER REFERENCE / 2026-09-21.1 快照)。文档口径:
 * - `1 credit = 1 元人民币`, 不做汇率换算;
 * - 计费分两类: **按秒**(seedance2.0-A / 2.5-A / F 系列 / minimax-h3)与
 *   **按条**(B / C / E 的 720p 系列, 不管几秒都一个价);
 * - 分辨率不同单价也不同, 所以报价必须读 `resolution` —— 只按秒数算会低估 1080p/4K。
 *
 * ⚠️ 文档明说「已保存高分辨率报价 ≠ 该分辨率已开放」, 且不同 Key 的分组可见模型不同。
 * 档位表就按文档快照写, 不做猜测; 没报价的型号(sd11-*)不登记价格, 让节点显示「未知」
 * 而不是假装 0 元。
 */
import type { ModelPricingDefinition } from '@/features/canvas/pricing/types';

export interface DramayaVideoOptions {
  /** 可选时长(秒), 上下限即滑杆范围 */
  durationOptions: number[];
  /** 可选分辨率; 空数组表示该型号只认固定档位, UI 不显示选择器 */
  resolutionValues: string[];
  /** 可选画幅 */
  aspectRatios: string[];
  defaultDuration: number;
  defaultResolution: string;
}

const STANDARD_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4'];
/** SD1.1 四个型号额外认 21:9 与 adaptive(文档明确: 不要发 Auto)。 */
const SD11_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'];

function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => from + index);
}

interface DramayaModelSpec {
  duration: [number, number];
  resolutions: string[];
  ratios?: string[];
  defaultDuration?: number;
}

/** 型号 → 档位。文档 5.3 / 5.4 两张表逐行对应。 */
const DRAMAYA_MODEL_SPECS: Record<string, DramayaModelSpec> = {
  'seedance2.0-a': { duration: [4, 15], resolutions: ['480p', '720p', '1080p'], defaultDuration: 7 },
  'seedance2.5-a': { duration: [4, 30], resolutions: ['480p', '720p'], defaultDuration: 5 },
  'seedance2.0-b': { duration: [4, 15], resolutions: ['480p', '720p', '1080p', '4k'], defaultDuration: 7 },
  'seedance2.0-fast-b': { duration: [4, 15], resolutions: ['480p', '720p'], defaultDuration: 7 },
  'seedance2.5-720p-b': { duration: [4, 30], resolutions: ['720p'], defaultDuration: 5 },
  'seedance2.0-720p-c': { duration: [4, 15], resolutions: ['720p'], defaultDuration: 10 },
  'seedance2.5-720p-c': { duration: [4, 30], resolutions: ['720p'], defaultDuration: 10 },
  'seedance2.0-720p-e': { duration: [4, 15], resolutions: ['720p'], defaultDuration: 7 },
  'seedance2.0-f': { duration: [4, 15], resolutions: ['720p'], defaultDuration: 7 },
  'seedance2.5-f': { duration: [4, 30], resolutions: ['720p'], defaultDuration: 5 },
  'seedance2.0-f-720p': { duration: [5, 15], resolutions: ['720p'], defaultDuration: 7 },
  'seedance2.0-fast-f-720p': { duration: [5, 15], resolutions: ['720p'], defaultDuration: 7 },
  'minimax-h3': { duration: [4, 15], resolutions: ['480p', '720p', '1080p'], defaultDuration: 5 },
  'sd11-seedance-2.0': { duration: [4, 15], resolutions: ['480p', '720p', '1080p'], ratios: SD11_RATIOS, defaultDuration: 7 },
  'sd11-seedance-2.0-fast': { duration: [4, 15], resolutions: ['480p', '720p'], ratios: SD11_RATIOS, defaultDuration: 7 },
  'sd11-seedance-2.0-mini': { duration: [4, 15], resolutions: ['480p', '720p'], ratios: SD11_RATIOS, defaultDuration: 7 },
  'sd11-seedance-2.5': { duration: [4, 30], resolutions: ['480p', '720p'], ratios: SD11_RATIOS, defaultDuration: 5 },
};

/** 预设模型清单(文档 5.3 / 5.4 里已发布的型号, 顺序按渠道 A→F 排)。 */
export const DRAMAYA_VIDEO_MODELS: string[] = [
  'seedance2.0-A',
  'seedance2.5-A',
  'seedance2.0-B',
  'seedance2.0-fast-B',
  'seedance2.5-720p-B',
  'seedance2.0-720p-C',
  'seedance2.5-720p-C',
  'seedance2.0-720p-E',
  'seedance2.0-F',
  'seedance2.5-F',
  'seedance2.0-F-720p',
  'seedance2.0-fast-F-720p',
  'minimax-h3',
  'sd11-seedance-2.0',
  'sd11-seedance-2.0-fast',
  'sd11-seedance-2.0-mini',
  'sd11-seedance-2.5',
];

export function isDramayaVideoBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const host = new URL(baseUrl.trim()).hostname.toLowerCase();
    // 只认视频站。图片站 img.dramaya.us 是另一套协议。
    return host === 'video.dramaya.us';
  } catch {
    return false;
  }
}

/** 未登记的型号给通用档位(4~15 秒 / 三档分辨率), 不要静默退化成 1 秒。 */
export function resolveDramayaVideoOptions(model: string): DramayaVideoOptions {
  const normalized = model.trim().toLowerCase();
  const spec = DRAMAYA_MODEL_SPECS[normalized];
  if (!spec) {
    return {
      durationOptions: range(4, 15),
      resolutionValues: ['480p', '720p', '1080p'],
      aspectRatios: STANDARD_RATIOS,
      defaultDuration: 5,
      defaultResolution: '720p',
    };
  }
  const resolutions = spec.resolutions;
  return {
    durationOptions: range(spec.duration[0], spec.duration[1]),
    resolutionValues: resolutions,
    aspectRatios: spec.ratios ?? STANDARD_RATIOS,
    defaultDuration: spec.defaultDuration ?? spec.duration[0],
    defaultResolution: resolutions.includes('720p') ? '720p' : resolutions[0],
  };
}

type DramayaPrice =
  | { type: 'per-second'; amountByResolution: Record<string, number> }
  | { type: 'per-run'; amountByResolution: Record<string, number> };

/**
 * 价格表(单位: 元 = credits), 逐分辨率登记。
 *
 * 只登记文档给出的数字。`sd11-*` 四款文档没有报价 → 不登记, 让 UI 显示「未知」;
 * 把未知当 0 会让用户以为免费。
 */
const DRAMAYA_VIDEO_PRICES: Record<string, DramayaPrice> = {
  // 渠道 A: 按秒
  'seedance2.0-a': {
    type: 'per-second',
    amountByResolution: { '480p': 0.85, '720p': 1, '1080p': 1.4 },
  },
  'seedance2.5-a': {
    type: 'per-second',
    amountByResolution: { '480p': 0.9, '720p': 1.15 },
  },
  // 渠道 B/C/E: 按条(与秒数无关)
  'seedance2.0-b': {
    type: 'per-run',
    amountByResolution: { '480p': 4.9, '720p': 6.5, '1080p': 11, '4k': 45 },
  },
  'seedance2.0-fast-b': { type: 'per-run', amountByResolution: { '480p': 4.8, '720p': 6 } },
  'seedance2.5-720p-b': { type: 'per-run', amountByResolution: { '720p': 8 } },
  'seedance2.0-720p-c': { type: 'per-run', amountByResolution: { '720p': 3 } },
  'seedance2.5-720p-c': { type: 'per-run', amountByResolution: { '720p': 4 } },
  'seedance2.0-720p-e': { type: 'per-run', amountByResolution: { '720p': 9 } },
  // 渠道 F: 按秒
  'seedance2.0-f': { type: 'per-second', amountByResolution: { '720p': 0.99 } },
  'seedance2.5-f': { type: 'per-second', amountByResolution: { '720p': 1.51 } },
  // 第三方: 按秒
  'minimax-h3': {
    type: 'per-second',
    amountByResolution: { '480p': 0.16, '720p': 0.2, '1080p': 0.4 },
  },
};

function pickAmount(price: DramayaPrice, resolution: string): number | null {
  const normalized = resolution.trim().toLowerCase();
  const table = price.amountByResolution;
  if (table[normalized] != null) return table[normalized];
  // 平台把 4K 写成 `4K`, 我们档位写 `4k`; 统一小写后再查一次。
  const lower = normalized.replace(/\s+/g, '').toLowerCase();
  if (table[lower] != null) return table[lower];
  // 没登记的档位: 用该型号登记过的最低档兜底不行 —— 那是静默低估。
  // 返回 null 让调用方整条报价作废(显示「未知」)。
  return null;
}

export function createDramayaVideoPricing(model: string): ModelPricingDefinition | undefined {
  const price = DRAMAYA_VIDEO_PRICES[model.trim().toLowerCase()];
  if (!price) return undefined;

  return {
    quote: ({ resolution, extraParams }) => {
      const amount = pickAmount(price, resolution ?? '');
      if (amount == null) return null;
      if (price.type === 'per-run') {
        return { amount, currency: 'CNY' };
      }
      const duration = Math.max(1, Number(extraParams?.duration) || 5);
      return { amount: amount * duration, currency: 'CNY' };
    },
  };
}
