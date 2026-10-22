import type { ModelPricingDefinition } from "@/features/canvas/pricing/types";

/**
 * 知鸟 AI（cuai.token6688.com）的价目表。
 *
 * 数据来源：平台自己的估价接口 `POST /v1/pricing-estimate/batch`
 * （2026-10-18 全量同步，图片 25 个 + 视频 37 个在售模型，0 个失败）。
 * 每个数字都是「这一档参数下实付多少元」，已经含了所属代理的加价，
 * 是**本账号**的真实扣费价 —— 换账号或代理档位变了，这张表就要重同步。
 *
 * 三个必须知道的点：
 *
 * 1. **计价单位不统一，而且同一模型的不同档位也可能不同。**
 *    大多数视频是「按秒」（`unit: "second"`，要乘时长），但
 *    `seedance-2-0-special` / `veo-3.1` / `omni-flash-1-1` 等是「按次」
 *    （`unit: "run"`，与时长无关）；`wan-3-0` 更怪：480p 按秒、720p/1080p 按次。
 *    所以表里每档都带自己的 unit，不能按模型统一假设。
 *
 * 2. **图片是按次固定价，只有分辨率影响价格。**
 *    分辨率档位键统一小写（`1k` / `2k` / `4k`，个别模型是 `0.5k`）；
 *    没有档位维度的模型直接给 `default`。查不到就退回 `default`，
 *    再查不到退回表里第一个值 —— 宁可给个近似价，也别让节点右上角空着。
 *
 * 3. **Midjourney 的 `count` 是组数。** 一组恒 4 张，`count: 2` 实测就扣两倍钱
 *    （¥0.0866 → ¥0.1732），所以 MJ 的报价要乘组数，见
 *    `models/midjourney.ts` 与 `resolveZhiniaoImagePrice`。
 *
 * 用户手填的 `modelPrices`（平台级「官方价格」）优先级更高，会盖过这张表 ——
 * 这张表只是开箱即用的兜底。
 */

/** 平台域名特征；用户自建平台时 id 常写成「知鸟ai」这类中文名，所以以域名为主。 */
const ZHINIAO_HOST_MARKERS = ["token6688.com"];

/** 平台 id 别名（去掉 `custom:` 前缀后比较）。 */
const ZHINIAO_PROVIDER_ID_ALIASES = ["zhiniao", "zhiniaoai", "知鸟", "知鸟ai"];

/** 平台 id 或 Base URL 任一命中即视为知鸟链路。 */
export function isZhiniaoProvider(providerId: string, baseUrl = ""): boolean {
  const normalizedId = providerId.trim().toLowerCase().replace(/^custom:/, "");
  if (normalizedId && ZHINIAO_PROVIDER_ID_ALIASES.includes(normalizedId)) return true;
  const normalizedUrl = baseUrl.trim().toLowerCase();
  return ZHINIAO_HOST_MARKERS.some((marker) => normalizedUrl.includes(marker));
}

export interface ZhiniaoUnitPrice {
  /** run = 一次请求固定价（与时长无关）；second = 每秒单价（要乘时长）。 */
  unit: "run" | "second";
  /** 人民币元。 */
  amount: number;
}

/**
 * 图片：一次请求的实付价（元），按分辨率档位查。
 * 键小写；`default` 是兜底档。
 */
const ZHINIAO_IMAGE_PRICES: Record<string, Record<string, number>> = {
  "aliyun-image-superres": { default: 0.0529 },
  "doubao-seedream-4-5": { "2k": 0.1322, "4k": 0.2664, "1k": 0.2664 },
  "doubao-seedream-5-0": { default: 0.0529 },
  "doubao-seedream-5-0-pro": { default: 0.0793 },
  "face-repaint": { default: 0.6608 },
  "flux-2": { default: 0.0297 },
  "flux-3": { "1k": 0.3375, "2k": 0.7031, "4k": 4.2678 },
  "flux-kontext": { default: 0.0363 },
  "gemini-3-pro-image": { default: 0.1189 },
  "gemini-3.1-flash-image": { "0.5k": 0.3469, "1k": 0.1189, "2k": 0.1784, "4k": 0.2379 },
  "gemini-3.1-flash-lite-image": { default: 0.1285 },
  "gemini-nano-banana-2.1-image": { "1k": 0.0661, "2k": 0.1097, "4k": 0.2143 },
  "gpt-image-1.5-all": { "1024x1024": 0.1292, "1536x1024": 0.0793, "1024x1536": 0.0793, default: 0.1292 },
  "gpt-image-2": { default: 0.033 },
  "gpt-image-2-c": { "1024x1024": 0.0529, "1792x1024": 0.0793, "1024x1792": 0.0793, default: 0.0529 },
  "gpt-image-2-official": { "1k": 0.1559, "2k": 0.3965, "4k": 0.3965 },
  "gpt-image-2.5-flare": { default: 0.0265 },
  "gpt-image-2.5-sunburst": { default: 0.0265 },
  "grok-imagine-image": { default: 0.0119 },
  "grok-imagine-image-2.0": { default: 0.0357 },
  "kling-image-o3": { "1k": 0.0793, "2k": 0.0925, "4k": 0.1586 },
  "mj_imagine": { default: 0.0866 },
  "qwen-image-2.0": { default: 0.2313 },
  "qwen-image-3.0": { default: 0.1943 },
  "wan2.7-image": { "1k": 0.2498, "2k": 0.3747 },
};

/**
 * 视频：每档分辨率的单价（按秒或按次，见 `ZhiniaoUnitPrice.unit`）。
 * 键小写（`480p` / `720p` / `1080p` / `4k` / `768p` ...），`default` 是兜底档。
 */
const ZHINIAO_VIDEO_PRICES: Record<string, Record<string, ZhiniaoUnitPrice>> = {
  "aliyun-video-superres": { "default": { unit: "second", amount: 0.0097 } },
  "grok-imagine-1-5-7tu-special": { "480p": { unit: "second", amount: 0.0582 }, "720p": { unit: "second", amount: 0.1019 } },
  "grok-imagine-1.5": { "1080p": { unit: "second", amount: 0.131 }, "480p": { unit: "second", amount: 0.0582 }, "720p": { unit: "second", amount: 0.1456 } },
  "grok-imagine-1.5-special": { "720p": { unit: "run", amount: 0.3494 } },
  "grok-imagine-video": { "480p": { unit: "second", amount: 0.0364 }, "720p": { unit: "second", amount: 0.051 } },
  "grok-imagine-video-special": { "720p": { unit: "second", amount: 0.1165 } },
  "happyhorse-1-1": { "1080p": { unit: "second", amount: 1.1356 }, "720p": { unit: "second", amount: 0.8515 } },
  "kling-3.0-turbo": { "720p": { unit: "second", amount: 0.6115 } },
  "kling-avatar": { "default": { unit: "second", amount: 0.495 } },
  "kling-lip-sync": { "default": { unit: "second", amount: 0.9257 } },
  "kling-v3": { "1080p": { unit: "second", amount: 0.8154 }, "720p": { unit: "second", amount: 0.6115 } },
  "kling-v3-motion-control": { "1080p": { unit: "second", amount: 0.8154 }, "720p": { unit: "second", amount: 0.5096 } },
  "kling-v3-omni-cankao": { "default": { unit: "second", amount: 0.6115 } },
  "minimax-h3": { "2k": { unit: "second", amount: 0.2908 }, "768p": { unit: "second", amount: 0.2037 } },
  "minimax-hailuo-2-3": { "1080p": { unit: "second", amount: 0.3363 }, "768p": { unit: "second", amount: 0.3363 } },
  "omni-flash-1-1": { "1080p": { unit: "run", amount: 0.8299 }, "720p": { unit: "run", amount: 0.7426 } },
  "pixverse-c1": { "1080p": { unit: "second", amount: 0.5677 }, "720p": { unit: "second", amount: 0.2986 } },
  "pixverse-v6": { "1080p": { unit: "second", amount: 0.5381 }, "720p": { unit: "second", amount: 0.2691 } },
  "seedance-2-0-9tu-special": { "480p": { unit: "run", amount: 1.456 }, "720p": { unit: "run", amount: 1.456 } },
  "seedance-2-0-ecom-special": { "default": { unit: "run", amount: 4.0768 } },
  "seedance-2-0-manju-special": { "720p": { unit: "run", amount: 1.456 } },
  "seedance-2-0-official": { "1080p": { unit: "second", amount: 0.2204 }, "480p": { unit: "second", amount: 0.1025 }, "4k": { unit: "second", amount: 0.2204 }, "720p": { unit: "second", amount: 0.2204 } },
  "seedance-2-0-promo": { "1080p": { unit: "second", amount: 0.3494 }, "2k": { unit: "second", amount: 5.824 }, "480p": { unit: "second", amount: 0.1747 }, "4k": { unit: "second", amount: 5.824 }, "720p": { unit: "second", amount: 0.3494 } },
  "seedance-2-0-special": { "480p": { unit: "run", amount: 1.8928 }, "720p": { unit: "run", amount: 1.456 } },
  "seedance-2-5": { "1080p": { unit: "second", amount: 2.6702 }, "480p": { unit: "second", amount: 0.653 }, "720p": { unit: "second", amount: 1.1325 } },
  "seedance-2-5-manju-special": { "720p": { unit: "run", amount: 8.008 } },
  "seedance-2-5-promo": { "1080p": { unit: "second", amount: 3.5123 }, "480p": { unit: "second", amount: 0.8064 }, "720p": { unit: "second", amount: 1.344 } },
  "seedance-2-5-special": { "1080p": { unit: "run", amount: 8.008 }, "720p": { unit: "run", amount: 8.008 } },
  "sora-2-official": { "default": { unit: "second", amount: 0.6843 } },
  "veo-3-1-manju-special": { "720p": { unit: "run", amount: 0.4368 } },
  "veo-3.1": { "1080p": { unit: "run", amount: 2.7518 }, "720p": { unit: "run", amount: 0.8736 } },
  "veo-4-omni": { "1080p": { unit: "second", amount: 0.1456 }, "720p": { unit: "second", amount: 0.0874 } },
  "veo-4-omni-v2v": { "default": { unit: "run", amount: 0.8882 } },
  "viduq3": { "1080p": { unit: "second", amount: 0.364 }, "540p": { unit: "second", amount: 0.1325 }, "720p": { unit: "second", amount: 0.1936 } },
  "wan-3-0": { "1080p": { unit: "run", amount: 4.368 }, "480p": { unit: "second", amount: 0.2283 }, "720p": { unit: "run", amount: 2.184 } },
  "wan-3-0-special": { "1080p": { unit: "run", amount: 7.1344 }, "720p": { unit: "run", amount: 7.1344 } },
  "wan2.7-video": { "1080p": { unit: "second", amount: 1.1166 }, "720p": { unit: "second", amount: 0.6767 } },
};

/** 档位归一化：节点上可能是 `1K` / `720P`，表里是 `1k` / `720p`。 */
function normalizeResolutionKey(resolution: string | undefined): string {
  return (resolution ?? "").trim().toLowerCase();
}

/**
 * 在「档位 → 值」的表里取值：精确档位 → default → 表里第一个。
 *
 * 最后那层兜底是刻意的：自定义视频模型的档位是从模型名推出来的（阅读不到就默认
 * 720P），跟平台真实档位（768p / 540p / 2k）常常对不上；这时给个近似价，
 * 比右上角什么都不显示更有用。
 */
function pickByResolution<T>(
  table: Record<string, T> | undefined,
  resolution: string | undefined,
): T | undefined {
  if (!table) return undefined;
  const key = normalizeResolutionKey(resolution);
  if (key && table[key] !== undefined) return table[key];
  if (table.default !== undefined) return table.default;
  // 客户端视频档位读不到时默认 720P, 所以缺失档位这里优先拿 720P 的价。
  if (table["720p"] !== undefined) return table["720p"];
  const values = Object.values(table);
  return values.length > 0 ? values[0] : undefined;
}

/** MJ 一档 = 一组 4 张，`count` 是组数；其它模型 count 无意义。 */
function resolveGroupCount(extraParams: Record<string, unknown> | undefined): number {
  const raw = Number(extraParams?.count);
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.min(50, Math.round(raw));
}

/** 图片报价：按次固定价，MJ 再乘组数。表里没有该模型返回 undefined。 */
export function resolveZhiniaoImagePrice(
  model: string,
  resolution: string | undefined,
  extraParams?: Record<string, unknown>,
): number | undefined {
  const amount = pickByResolution(
    ZHINIAO_IMAGE_PRICES[model.trim().toLowerCase()],
    resolution,
  );
  if (amount == null) return undefined;
  return amount * resolveGroupCount(extraParams);
}

/** 视频报价：按秒乘时长，按次直接返回；时长缺省按 5 秒估。 */
export function resolveZhiniaoVideoPrice(
  model: string,
  resolution: string | undefined,
  duration: number | undefined,
): number | undefined {
  const price = pickByResolution(
    ZHINIAO_VIDEO_PRICES[model.trim().toLowerCase()],
    resolution,
  );
  if (!price) return undefined;
  if (price.unit === "run") return price.amount;
  const seconds = Number.isFinite(duration) && (duration ?? 0) > 0 ? Number(duration) : 5;
  return price.amount * seconds;
}

/** 挂到模型定义上的图片定价（供 registry 直接使用）。 */
export function createZhiniaoImagePricing(model: string): ModelPricingDefinition | undefined {
  if (!ZHINIAO_IMAGE_PRICES[model.trim().toLowerCase()]) return undefined;
  return {
    quote: (context) => {
      const amount = resolveZhiniaoImagePrice(model, context.resolution, context.extraParams);
      return amount == null ? null : { amount, currency: "CNY" as const };
    },
  };
}

/** 挂到模型定义上的视频定价（供 registry 直接使用）。 */
export function createZhiniaoVideoPricing(model: string): ModelPricingDefinition | undefined {
  if (!ZHINIAO_VIDEO_PRICES[model.trim().toLowerCase()]) return undefined;
  return {
    quote: (context) => {
      const duration = Number(context.extraParams?.duration);
      const amount = resolveZhiniaoVideoPrice(model, context.resolution, duration);
      return amount == null ? null : { amount, currency: "CNY" as const };
    },
  };
}
