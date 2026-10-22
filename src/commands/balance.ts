import { invoke, isTauri } from '@tauri-apps/api/core';
import i18n from '@/i18n';

/**
 * 平台余额查询。
 *
 * 各平台接口形态差异很大，判定与解析都在 Rust 侧（`commands/balance.rs`）；
 * 前端只负责把「这个平台该用哪种接口」告诉它，并约定：**查不到就不显示余额徽章**。
 */
export type ProviderBalanceKind = 'runninghub' | 'openai-billing';

export interface ProviderBalance {
  amount: number;
  /** 展示单位：`USD` / `RH`。 */
  unit: string;
  /** 额度明细（总额度 / 已用 / 运行中任务），放在 tooltip 里。 */
  detail?: string;
}

export interface JimengCliCredit {
  totalCredit: number;
  vipLevel?: string;
}

export interface WanCliCredits {
  availableCount: number;
  memberCount?: number;
  topUpCount?: number;
  bonusCount?: number;
}

function requireDesktop() {
  if (!isTauri()) throw new Error(i18n.t('balance.desktopOnly'));
}

export async function queryProviderBalance(
  kind: ProviderBalanceKind,
  baseUrl: string,
  apiKey: string,
): Promise<ProviderBalance> {
  requireDesktop();
  return invoke('query_provider_balance', { kind, baseUrl, apiKey });
}

export async function queryJimengCliCredit(executable: string): Promise<JimengCliCredit> {
  requireDesktop();
  return invoke('jimeng_cli_credit', { executable });
}

export async function queryWanCliCredits(executable: string): Promise<WanCliCredits> {
  requireDesktop();
  return invoke('wan_cli_credits', { executable });
}

/** 把余额格式化成卡片上的短标签。 */
export function formatProviderBalance(balance: ProviderBalance): string {
  const unit = balance.unit.toUpperCase();
  if (unit === 'USD') {
    return `$${balance.amount.toFixed(2)}`;
  }
  // RH 币 / 积分：整数就不显示小数位（RunningHub 返回的是 "150.0" 这种字符串）。
  const rounded = Number.isInteger(balance.amount)
    ? String(balance.amount)
    : balance.amount.toFixed(2);
  return `${rounded} ${balance.unit}`;
}
