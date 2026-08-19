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
  kind: 'image' | 'video';
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
  kind?: 'image' | 'video';
}

/**
 * 估算一次生成的费用(统一换算为 CNY)。
 * 无定价定义或无法估算时返回 0。
 */
export function estimateUsageCost(
  model: { pricing?: ModelPricingDefinition } | undefined,
  options: { kind: 'image' | 'video'; size: string; duration: number }
): number {
  if (!model?.pricing) {
    return 0;
  }
  const settings = useSettingsStore.getState();
  const quote = model.pricing.quote({
    resolution: options.size,
    extraParams: options.kind === 'video' ? { duration: options.duration } : undefined,
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
