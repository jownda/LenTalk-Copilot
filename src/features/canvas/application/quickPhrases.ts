/**
 * 文本节点 AI 修改面板的「快捷句式」。
 *
 * 用户经常反复输入同一批修改要求（「更简洁」「加强光线对比」…），每次手打很浪费时间。
 * 这里把这份列表存在 localStorage：
 *
 * - 只服务这一个面板，不进 `app_settings`，没必要跨端同步，也就不牵动 Rust；
 * - 读和写都做收敛（去空、去重、限长、限量），手改过 localStorage 也不会让面板崩掉。
 */

const STORAGE_KEY = 'lentalk-text-quick-phrases-v1';

/** 上限只是防呆，不是产品限制。 */
export const MAX_QUICK_PHRASES = 60;
export const MAX_QUICK_PHRASE_LENGTH = 200;

/**
 * 预置几条通用修改要求，让新用户一打开就有东西可点。
 * 都是「动词 + 对象」的短句，套在任何文案上都成立。
 */
export const DEFAULT_QUICK_PHRASES: string[] = [
  '更简洁一些，删掉冗余的修饰',
  '语气更自然，像真人说话',
  '加强画面感，多写具体细节',
  '补上人物的动作和表情',
  '把这段改成夜景',
  '节奏放慢，动作拆得更细',
];

/** 收敛成一份可安全渲染的字符串数组：去空、去重、限长、限量。 */
export function sanitizeQuickPhrases(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const text = item.trim().slice(0, MAX_QUICK_PHRASE_LENGTH);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= MAX_QUICK_PHRASES) break;
  }
  return result;
}

/** 读取快捷句式。没存过（或存坏了）时回落到预置列表。 */
export function loadQuickPhrases(): string[] {
  try {
    if (typeof window === 'undefined') return [...DEFAULT_QUICK_PHRASES];
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [...DEFAULT_QUICK_PHRASES];
    const parsed = JSON.parse(raw) as unknown;
    const list = sanitizeQuickPhrases(parsed);
    // 空数组是用户的合法选择（他把预置的全删了），不要用默认值强行塞回去。
    return list;
  } catch {
    return [...DEFAULT_QUICK_PHRASES];
  }
}

/** 保存并返回收敛后的结果，调用方直接拿它更新界面状态。 */
export function saveQuickPhrases(list: string[]): string[] {
  const sanitized = sanitizeQuickPhrases(list);
  try {
    if (typeof window === 'undefined') return sanitized;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitized));
  } catch {
    // 隐私模式 / 配额满：界面照常可用，只是这次改动不会留存。
  }
  return sanitized;
}

/**
 * 把一条句式插进已有的修改要求里。
 *
 * 用换行接在末尾而不是空格：这些是彼此的独立要求，粘成一行后模型容易只执行最后一句。
 * 已有内容末尾的空白先裁掉，避免越点空行越多。
 */
export function appendQuickPhrase(current: string, phrase: string): string {
  const trimmedPhrase = phrase.trim();
  if (!trimmedPhrase) return current;
  const head = current.replace(/[\s\u3000]+$/, '');
  if (!head.trim()) return trimmedPhrase;
  return `${head}\n${trimmedPhrase}`;
}
