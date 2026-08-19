import { openGlobalErrorDialog } from '@/features/app/errorDialogEvents';

export interface ResolvedErrorContent {
  message: string;
  details?: string;
}

interface ErrorWithDetails extends Error {
  details?: string;
}

function stringifyUnknown(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 余额不足错误的常见特征(大小写不敏感): OpenAI 兼容平台标准码 + 各平台变体 + 中文 */
const BALANCE_INSUFFICIENT_PATTERNS = [
  /insufficient[ _-]?balance/i,
  /insufficient[ _-]?account[ _-]?balance/i,
  /insufficient[ _-]?credits?/i,
  /not[ _-]?enough[ _-]?balance/i,
  /balance[ _-]?is[ _-]?insufficient/i,
  /余额不足/,
  /积分不足/,
  /余额不够/,
];

/** 判断错误文本是否为"余额/积分不足"类错误 */
export function isBalanceInsufficientError(text: string): boolean {
  if (!text) {
    return false;
  }
  return BALANCE_INSUFFICIENT_PATTERNS.some((pattern) => pattern.test(text));
}

/** 余额不足时的用户可读提示(避免用户误以为是系统故障) */
export const BALANCE_INSUFFICIENT_MESSAGE =
  '余额不足：当前所选平台的账户余额/积分不足以完成本次生成。\n' +
  '请到对应平台（模型选择里显示的供应商）官网充值或购买积分后重试；刚充值过可稍等 1~2 分钟再试。';

/** 若命中余额不足, 把原始错误降级为 details, message 换成明确的充值提示 */
function resolveBalanceInsufficient(
  message: string,
  details: string | undefined
): { message: string; details?: string } {
  const combined = `${message} ${details ?? ''}`;
  if (!isBalanceInsufficientError(combined)) {
    return { message, details };
  }
  const rawDetails = message && message !== BALANCE_INSUFFICIENT_MESSAGE
    ? (details ? `${message}\n${details}` : message)
    : details;
  return { message: BALANCE_INSUFFICIENT_MESSAGE, details: rawDetails?.trim() || undefined };
}

export function resolveErrorContent(error: unknown, fallbackMessage: string): ResolvedErrorContent {
  let resolved: ResolvedErrorContent;
  if (error instanceof Error) {
    const errorWithDetails = error as ErrorWithDetails;
    const details = stringifyUnknown(errorWithDetails.details);
    resolved = {
      message: error.message?.trim() || fallbackMessage,
      details: details?.trim() || undefined,
    };
  } else if (typeof error === 'string') {
    const content = error.trim();
    resolved = {
      message: content || fallbackMessage,
      details: content || undefined,
    };
  } else if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const candidate =
      (typeof record.message === 'string' && record.message) ||
      (typeof record.error === 'string' && record.error) ||
      (typeof record.details === 'string' && record.details) ||
      (typeof record.msg === 'string' && record.msg) ||
      '';
    const details = stringifyUnknown(record);
    resolved = {
      message: candidate.trim() || fallbackMessage,
      details: details?.trim() || undefined,
    };
  } else {
    resolved = { message: fallbackMessage };
  }

  return resolveBalanceInsufficient(resolved.message, resolved.details);
}

export async function showErrorDialog(
  text: string,
  title: string,
  details?: string,
  copyText?: string
): Promise<void> {
  const content = text.trim();
  if (!content) {
    return;
  }

  const resolved = resolveBalanceInsufficient(content, details?.trim() || undefined);
  openGlobalErrorDialog({
    title,
    message: resolved.message,
    details: resolved.details,
    copyText: copyText?.trim() || undefined,
  });
}
