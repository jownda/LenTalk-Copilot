import type { ModelPricingDefinition } from "@/features/canvas/pricing/types";

/**
 * WGSPAI（api.wgspai.cn）的价目表。
 *
 * 数据来源：平台自己的公开价目接口 `GET /api/pricing`（New-API 系）。
 * 2026-10-18 按本机 `custom:wgspai` 的 Key 全量抓取，17 个可见模型全部带
 * `price_unit`，与 `GET /v1/task/models?type=image|video` 的 `price` 完全一致
 * （后者是同一份数据的前端视图）。
 *
 * 三个要点：
 *
 * 1. **`price_unit` 是权威单位，不能按平台统一假设。**
 *    `call` = 一次请求固定价（与时长无关，视频族大多如此）；
 *    `second` = 每秒单价（要乘时长，例如 `seedance-2.0-720-new` 0.25 元/秒）；
 *    `ratio`（`quota_type: 0`）是语言模型的 token 倍率，与媒体无关，本表不收。
 *
 * 2. **图片按张计价。** 三家图片模型（`gpt-image-2-2k` / `gpt-image-2.5` /
 *    `nano-banana-2`）都是 0.1 元/张，`n` 大于 1 时按张数乘 —— 与
 *    `POST /v1/images/generations` 的 `n` 语义一致。
 *
 * 3. **Videos 族不进 `/api/pricing`。** `seedance2.5` 走 `POST /v1/videos`
 *    （OpenAI Videos 协议），价目表里查不到，价格只能取自官方对接文档
 *    《api.wgspai.cn · Seedance 2.5 对接文档》第 2 节：**¥3 / 次**、固定 30 秒。
 *    所以这一条同样是 `call`，但把时长锁死在 30 秒，与 `wgspaiProtocol` 的
 *    档位表一致。
 *
 * 用户手填的 `modelPrices`（平台级「官方价格」）优先级更高，会盖过这张表 ——
 * 这张表只是开箱即用的兜底。
 */

/** 平台域名特征；用户自建平台时 id 常写成中文名，所以以域名为主。 */
const WGSPAI_HOST_MARKERS = ["api.wgspai.cn"];

/** 平台 id 别名（去掉 `custom:` 前缀后比较）。 */
const WGSPAI_PROVIDER_ID_ALIASES = ["wgspai", "wgspai视频", "wgspai-视频", "wgspai ai"];

/** 平台 id 或 Base URL 任一命中即视为 WGSPAI 链路。 */
export function isWgspaiProvider(providerId: string, baseUrl = ""): boolean {
  const normalizedId = providerId.trim().toLowerCase().replace(/^custom:/, "");
  if (normalizedId && WGSPAI_PROVIDER_ID_ALIASES.includes(normalizedId)) return true;
  const normalizedUrl = baseUrl.trim().toLowerCase();
  return WGSPAI_HOST_MARKERS.some((marker) => normalizedUrl.includes(marker));
}

export interface WgspaiUnitPrice {
  /** call = 一次请求固定价（与时长无关）；second = 每秒单价（要乘时长）。 */
  unit: "call" | "second";
  /** 人民币元。 */
  amount: number;
}

/**
 * 图片：一张多少钱（`price_unit: "call"` 的图片模型按张算）。
 * 键小写。
 */
const WGSPAI_IMAGE_PRICES: Record<string, number> = {
  "gpt-image-2-2k": 0.1,
  "gpt-image-2.5": 0.1,
  "nano-banana-2": 0.1,
};

/**
 * 视频：一次请求或每秒多少钱。
 * 键小写（平台对 `Minimax-h3` 这类大小写敏感的模型名，比价时统一降级）。
 */
const WGSPAI_VIDEO_PRICES: Record<string, WgspaiUnitPrice> = {
  // ── Seedance 2.0 / 2.5 系 ──
  "seedance-v2-720p": { unit: "call", amount: 5.5 },
  "seedance-v2-720p-fast": { unit: "call", amount: 3.5 },
  "seedance-v2.5-1080p": { unit: "call", amount: 8.5 },
  "hf-seedance-2.5-1080p": { unit: "call", amount: 6 },
  "seedance-2.0-720-new": { unit: "second", amount: 0.25 },
  // Videos 族(不走 /api/pricing), 价格来自对接文档第 2 节: ¥3/次、固定 30 秒。
  "seedance2.5": { unit: "call", amount: 3 },
  // ── 其它 ──
  "grok-imagine-video-6s": { unit: "call", amount: 0.42 },
  "minimax-h3": { unit: "call", amount: 1.5 },
  wan3: { unit: "call", amount: 6 },
};

/** 按秒计费的模型没传时长时，用平台默认的那一档估算（与节点默认一致）。 */
const DEFAULT_VIDEO_SECONDS = 5;

/**
 * 图片报价：单价 × 张数。
 *
 * `count` 缺失或非法时按 1 张算 —— 图片节点默认就是 1 张，只有用户主动选
 * 多张时才需要乘。
 */
export function resolveWgspaiImagePrice(model: string, count?: number): number | undefined {
  const unit = WGSPAI_IMAGE_PRICES[model.trim().toLowerCase()];
  if (unit == null) return undefined;
  const images =
    typeof count === "number" && Number.isFinite(count) && count >= 1 ? Math.round(count) : 1;
  return unit * images;
}

/** 视频报价：按次直接返回，按秒乘时长；表里没有该模型返回 undefined。 */
export function resolveWgspaiVideoPrice(model: string, duration?: number): number | undefined {
  const price = WGSPAI_VIDEO_PRICES[model.trim().toLowerCase()];
  if (!price) return undefined;
  if (price.unit === "call") return price.amount;
  const seconds =
    typeof duration === "number" && Number.isFinite(duration) && duration > 0
      ? duration
      : DEFAULT_VIDEO_SECONDS;
  return price.amount * seconds;
}

/** 挂到模型定义上的图片定价（供 registry 直接使用）。 */
export function createWgspaiImagePricing(model: string): ModelPricingDefinition | undefined {
  if (WGSPAI_IMAGE_PRICES[model.trim().toLowerCase()] == null) return undefined;
  return {
    quote: (context) => {
      const count = Number(context.extraParams?.count);
      const amount = resolveWgspaiImagePrice(model, Number.isFinite(count) ? count : undefined);
      return amount == null ? null : { amount, currency: "CNY" as const };
    },
  };
}

/** 挂到模型定义上的视频定价（供 registry 直接使用）。 */
export function createWgspaiVideoPricing(model: string): ModelPricingDefinition | undefined {
  if (!WGSPAI_VIDEO_PRICES[model.trim().toLowerCase()]) return undefined;
  return {
    quote: (context) => {
      const duration = Number(context.extraParams?.duration);
      const amount = resolveWgspaiVideoPrice(model, Number.isFinite(duration) ? duration : undefined);
      return amount == null ? null : { amount, currency: "CNY" as const };
    },
  };
}

/** 表里登记过的所有模型，供设置页/测试做覆盖核对。 */
export const WGSPAI_PRICED_MODELS = {
  image: Object.keys(WGSPAI_IMAGE_PRICES),
  video: Object.keys(WGSPAI_VIDEO_PRICES),
} as const;
