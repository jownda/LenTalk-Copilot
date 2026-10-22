import { invoke, isTauri } from '@tauri-apps/api/core';
import { useSettingsStore } from '@/stores/settingsStore';
import type { ModelPricingDefinition } from '@/features/canvas/pricing/types';

export interface UsageLogRecord {
  id: string;
  createdAt: number;
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  kind: 'image' | 'video' | 'audio';
  size: string;
  duration: number;
  referenceCount: number;
  estimatedCost: number;
  currency: string;
  status: 'succeeded' | 'failed';
  errorMessage: string;
  durationMs: number;
  projectId: string;
  sessionId: string;
}

export interface UsageLogSummary {
  totalCount: number;
  succeededCount: number;
  failedCount: number;
  totalCost: number;
  monthCount: number;
  monthCost: number;
}

export interface QueryUsageRecordsOptions {
  limit?: number;
  offset?: number;
  kind?: 'image' | 'video' | 'audio';
}

/** 按天聚合的用量(SQL 全表 GROUP BY, 不受记录条数上限影响)。 */
export interface UsageDailyBucket {
  /** 本地时区日期, 形如 `2026-10-08`。 */
  day: string;
  total: number;
  succeeded: number;
  failed: number;
  image: number;
  video: number;
  audio: number;
  cost: number;
  imageCost: number;
  videoCost: number;
  audioCost: number;
}

/** 按模型聚合的用量排行项。 */
export interface UsageModelBreakdown {
  modelId: string;
  modelName: string;
  providerName: string;
  total: number;
  succeeded: number;
  failed: number;
  image: number;
  video: number;
  audio: number;
  cost: number;
}

/**
 * 估算一次生成的费用(统一换算为 CNY)。
 * 无定价定义或无法估算时返回 0。
 */
export function estimateUsageCost(
  model: { pricing?: ModelPricingDefinition } | undefined,
  options: {
    kind: 'image' | 'video' | 'audio';
    size: string;
    duration: number;
    /** 影响价格的模型参数(图片: MJ 的 count 组数; 视频: 时长由 duration 提供)。 */
    extraParams?: Record<string, unknown>;
  }
): number {
  if (!model?.pricing) {
    return 0;
  }
  const settings = useSettingsStore.getState();
  const quote = model.pricing.quote({
    resolution: options.size,
    extraParams: options.kind === 'video'
      ? { duration: options.duration, ...(options.extraParams ?? {}) }
      : options.extraParams,
    settings: {
      displayCurrencyMode: settings.priceDisplayCurrencyMode,
      usdToCnyRate: settings.usdToCnyRate,
      preferDiscountedPrice: settings.preferDiscountedPrice,
      grsaiCreditTierId: settings.grsaiCreditTierId,
    },
  });
  if (!quote) {
    return 0;
  }
  const amount = Math.max(0, Number.isFinite(quote.amount) ? quote.amount : 0);
  if (quote.currency === 'CNY') {
    return amount;
  }
  const rate = Number.isFinite(settings.usdToCnyRate) && settings.usdToCnyRate > 0
    ? settings.usdToCnyRate
    : 7.2;
  return amount * rate;
}

/** 写入一条用量记录(幂等); 非 Tauri 环境静默跳过。 */
export async function appendUsageRecord(record: UsageLogRecord): Promise<void> {
  if (!isTauri()) {
    return;
  }
  try {
    await invoke('append_usage_record', { record });
  } catch (error) {
    // 记账失败不影响生成流程, 只打日志
    console.warn('[UsageLog] append failed', error);
  }
}

/** 查询用量记录(按时间倒序)。 */
export async function queryUsageRecords(
  options: QueryUsageRecordsOptions = {}
): Promise<UsageLogRecord[]> {
  if (!isTauri()) {
    return [];
  }
  try {
    return await invoke<UsageLogRecord[]>('query_usage_records', {
      limit: options.limit ?? 200,
      offset: options.offset ?? 0,
      kind: options.kind ?? null,
    });
  } catch (error) {
    console.warn('[UsageLog] query failed', error);
    return [];
  }
}

/** 按天聚合的用量(升序, 覆盖全部历史)。非 Tauri 环境返回空数组。 */
export async function queryUsageDaily(
  kind?: 'image' | 'video' | 'audio'
): Promise<UsageDailyBucket[]> {
  if (!isTauri()) {
    return [];
  }
  try {
    return await invoke<UsageDailyBucket[]>('query_usage_daily', {
      kind: kind ?? null,
    });
  } catch (error) {
    console.warn('[UsageLog] daily query failed', error);
    return [];
  }
}

/** 按模型聚合的用量排行(次数降序, 覆盖全部历史)。 */
export async function queryUsageBreakdown(limit = 10): Promise<UsageModelBreakdown[]> {
  if (!isTauri()) {
    return [];
  }
  try {
    return await invoke<UsageModelBreakdown[]>('query_usage_breakdown', { limit });
  } catch (error) {
    console.warn('[UsageLog] breakdown query failed', error);
    return [];
  }
}

/** 用量汇总(总次数/成功数/失败数/总费用 + 本月)。 */
export async function queryUsageSummary(): Promise<UsageLogSummary | null> {
  if (!isTauri()) {
    return null;
  }
  try {
    return await invoke<UsageLogSummary>('query_usage_summary');
  } catch (error) {
    console.warn('[UsageLog] summary failed', error);
    return null;
  }
}
