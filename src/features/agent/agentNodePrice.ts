/**
 * 估算单个节点「跑一次大概多少钱」。
 *
 * 为什么需要它：Agent 替用户**批量**发起生成时，确认卡片上必须先给出这批的总价 ——
 * 否则用户点「确认执行」等于盲签一张账单。一次跑 12 张图尤其致命，
 * 单张看不出来，加起来就不是小数。
 *
 * 原则：**算不出来就说不知道**，不要猜一个数字。模型没登记 pricing 时标「未知」，
 * 由调用方如实告诉用户「其中 N 个无法估价」，而不是把未知当成 0。
 */

import type { CanvasNode } from "@/features/canvas/domain/canvasNodes";
import { getAudioModel, getImageModel, getVideoModel } from "@/features/canvas/models/registry";
import { resolveModelPriceDisplay } from "@/features/canvas/pricing";
import { useSettingsStore } from "@/stores/settingsStore";

export interface NodePriceEstimate {
  /** 现成的价格标签（「¥0.06」「$0.01」…）。 */
  label: string;
  /** 是否真的算出来了。`false` 表示该模型没有价格数据，`label` 为「未知」。 */
  known: boolean;
}

const UNKNOWN: NodePriceEstimate = { label: "未知", known: false };

export function estimateNodePrice(node: CanvasNode, language = "zh"): NodePriceEstimate {
  const data = (node.data ?? {}) as Record<string, unknown>;
  const modelId = typeof data.model === "string" ? data.model.trim() : "";
  if (!modelId) return UNKNOWN;

  const settings = useSettingsStore.getState();
  const pricingSettings = {
    displayCurrencyMode: settings.priceDisplayCurrencyMode,
    usdToCnyRate: settings.usdToCnyRate,
    preferDiscountedPrice: settings.preferDiscountedPrice,
    grsaiCreditTierId: settings.grsaiCreditTierId,
  };
  const resolution = typeof data.resolution === "string" ? data.resolution : "";

  // 视频 / 音频先查：同一个 id 不会跨类重复，先命中的就是对的。
  const videoModel = getVideoModel(modelId);
  if (videoModel) {
    const display = resolveModelPriceDisplay(videoModel, {
      resolution,
      extraParams: { duration: data.duration },
      settings: pricingSettings,
      language,
    });
    return display ? { label: display.label, known: true } : UNKNOWN;
  }

  const audioModel = getAudioModel(modelId);
  if (audioModel) {
    const display = resolveModelPriceDisplay(audioModel, {
      resolution,
      settings: pricingSettings,
      language,
    });
    return display ? { label: display.label, known: true } : UNKNOWN;
  }

  // `getImageModel` 总会回落默认模型，所以放最后 —— 否则任何 id 都会被当成图片模型。
  const imageModel = getImageModel(modelId);
  const display = resolveModelPriceDisplay(imageModel, {
    resolution,
    extraParams: { image_count: data.imageCount },
    settings: pricingSettings,
    language,
  });
  return display ? { label: display.label, known: true } : UNKNOWN;
}

/** 价格标签的**前导货币符号**（`¥` / `$` / `€` …）。只看开头，别把「元/条」这类单位算进来。 */
function currencySymbolOf(label: string): string {
  return label.match(/^[^\d\s.,]+/)?.[0] ?? "";
}

/** 给确认卡片用的一句话总价：同币种才合计，混币种老实说不一致。 */
export function summarizeNodePrices(estimates: NodePriceEstimate[]): string {
  if (estimates.length === 0) return "";
  const known = estimates.filter((item) => item.known);
  const unknownCount = estimates.length - known.length;
  if (known.length === 0) return `${estimates.length} 个节点，价格未知`;

  const amounts = known.map((item) => Number(item.label.replace(/[^\d.]/g, ""))).filter(Number.isFinite);
  const symbol = currencySymbolOf(known[0].label);
  const sameSymbol = known.every((item) => currencySymbolOf(item.label) === symbol);
  const sameUnit = sameSymbol && amounts.length === known.length;

  if (!sameUnit) {
    // 混合币种：直接列出来，别硬算一个不存在的合计。
    return known.length === 1
      ? `1 个可估价：${known[0].label}`
      : `${known.length} 个可估价，币种不一致`;
  }

  const total = amounts.reduce((sum, value) => sum + value, 0);
  const rounded = Number.isInteger(total) ? String(total) : total.toFixed(2);
  const suffix = unknownCount > 0 ? `（另有 ${unknownCount} 个无法估价）` : "";
  return `合计 ${symbol}${rounded}，共 ${estimates.length} 个${suffix}`;
}
