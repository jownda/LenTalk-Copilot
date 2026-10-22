import type { PromptTemplate } from './promptLibraryStore';

/**
 * 把提示词模板「应用」到输入框的两种方式：
 * - `positive`：只取正向提示词；
 * - `full`：正向 + 负向合并成一段（负向以 `Negative prompt:` 前缀接在后面）。
 *
 * 这个模式枚举原先散在三处（素材库提示词 tab 的「正向 / 完整」按钮、拖拽提示词到画布、
 * 画布右键「应用到选中节点」），合并规则各写了一遍；现在统一到这里，
 * 任何一条链路改规则都不会和另外几条走散。
 */
export type PromptApplyMode = 'positive' | 'full';

/**
 * 把提示词模板编译成一段可直接写进节点输入框的文本。
 *
 * 「完整」模式下负向提示词用 `Negative prompt:\n` 起新段落 —— 对齐 Infinite Canvas 的
 * 输出格式：多数图像模型把负向当普通文字读，单独一行前缀是最不容易被误读成画面内容的写法。
 * 没有负向内容时两种模式结果相同。
 */
export function composePromptText(
  template: Pick<PromptTemplate, 'positive'> & Partial<Pick<PromptTemplate, 'negative'>>,
  mode: PromptApplyMode = 'full',
): string {
  const positive = (template.positive ?? '').trim();
  const negative = (template.negative ?? '').trim();

  if (mode !== 'full' || !negative) {
    return positive;
  }

  return [positive, `Negative prompt:\n${negative}`].filter(Boolean).join('\n\n');
}

/**
 * 把一段文本追加到输入框已有内容后面。
 *
 * 已有内容用**空行**隔开：图像提示词按段落理解，直接换行容易把两段粘成一句；
 * 输入框为空时直接放进去（不留前导空行）。两边都会 trim，
 * 免得出现「空行 + 空行 + 内容」这种越点越长的累积。
 */
export function appendPromptText(current: string, addition: string): string {
  const base = current.trim();
  const extra = addition.trim();

  if (!base) {
    return extra;
  }
  if (!extra) {
    return base;
  }

  return `${base}\n\n${extra}`;
}
