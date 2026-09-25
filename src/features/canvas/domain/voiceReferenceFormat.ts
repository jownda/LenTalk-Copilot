/**
 * 人物音频引用格式：把「角色 ↔ 音频参考」的绑定统一写成人可读的规范句。
 *
 * 中文规范句：`使用 @音频N 作为 @角色 的唯一人声参考。`
 * 英文规范句：`Use @音频N as the only voice reference for @角色.`
 *
 * 背景：`@音频N` 是画布的规范引用标记 —— 视频节点「引用」按钮插入的就是 `@音频N`
 * （见 VideoGenNode 的 marker 拼装），重编号与越界清理（`remapAudioReferenceTokens` /
 * `removeOutOfRangeReferenceTokens`）也只认 `@音频N` / `@audioN` / `[audioN]` 三种形态。
 * 但在提示词落到节点之前，同一个绑定会被写成好几种样子：AI 生成的段落可能写
 * `[audio1]` 或 `@audio1`，高级编译器写 `声音参考：@audio1。`。写法不统一时，
 * 视频模型分不清这段音频是谁的声线，人工校对也无从下手。
 *
 * 这里只做三件事，全部与音频无关的正文原样保留：
 * 1. 带「声音参考 / voice reference」标签的旧式写法 → **原地**换成规范句；
 * 2. 同一序号的其它 token 形态（`[audioN]` / `@audioN`）→ 统一成 `@音频N`；
 * 3. 全文都找不到该绑定时 → 补一句到 AUDIO 段（没有 AUDIO 段就追加在末尾）。
 *
 * 刻意不做「按序号重排」：`@音频N` 的 N 由节点的音频参考数组顺序决定，重编号是
 * `remapAudioReferenceTokens` 的职责；这里只统一**写法**，不动编号。
 */

export type VoiceReferenceLocale = 'zh' | 'en';

export interface VoiceReferenceBinding {
  /** 音频参考序号（1 起），对应 `@音频N` / `[audioN]` / `@audioN` 里的 N。 */
  audioIndex: number;
  /** 该音频所属角色在提示词里的标签（不含 `@`）。 */
  characterName: string;
}

/** 规范引用标记：与视频节点「引用」按钮插入的写法完全一致。 */
export function canonicalAudioToken(audioIndex: number): string {
  return `@音频${audioIndex}`;
}

/** 规范句：一条音频参考只绑一个角色。 */
export function renderVoiceReferenceSentence(
  binding: VoiceReferenceBinding,
  locale: VoiceReferenceLocale = 'zh',
): string {
  const token = canonicalAudioToken(binding.audioIndex);
  const name = binding.characterName.trim();
  return locale === 'en'
    ? `Use ${token} as the only voice reference for @${name}.`
    : `使用 ${token} 作为 @${name} 的唯一人声参考。`;
}

/**
 * 去重 + 剔除非法项，按音频序号升序。
 * 同一个序号被两个角色绑定是脏数据，保留先出现的那条（调用方按参考数组顺序传入）。
 */
export function normalizeVoiceReferenceBindings(
  bindings: readonly VoiceReferenceBinding[],
): VoiceReferenceBinding[] {
  const seen = new Set<number>();
  const normalized: VoiceReferenceBinding[] = [];
  for (const binding of bindings) {
    const audioIndex = Math.floor(binding.audioIndex);
    if (!Number.isFinite(audioIndex) || audioIndex < 1) continue;
    const characterName = binding.characterName.trim();
    if (!characterName || seen.has(audioIndex)) continue;
    seen.add(audioIndex);
    normalized.push({ audioIndex, characterName });
  }
  return normalized.sort((left, right) => left.audioIndex - right.audioIndex);
}

/**
 * 某序号的**等价 token 形态**（不含规范写法本身）。
 * `(?!\d)` 必须保留：否则 `@audio1` 会吃掉 `@audio10` 的前缀，把 10 号音频改错。
 */
function equivalentTokenPattern(audioIndex: number): RegExp {
  return new RegExp(String.raw`\[audio${audioIndex}\]|@audio${audioIndex}(?!\d)`, 'gi');
}

/**
 * 旧式带标签子句：`；声音参考：@audio1。` / `; voice reference: [audio1].`
 *
 * 前缀分隔符（可选，`；` 常常和子句一起删掉）与结尾句号一并吃掉，原地换成规范句后
 * 不会留下 `；` 或 `。` 残渣。标签之后的量词分工：前半段惰性（避免吞掉同一行里更早的
 * 正文），后半段贪婪（保证吃完整条子句直到句末标点）。
 */
function labeledClausePattern(audioIndex: number, locale: VoiceReferenceLocale): RegExp {
  const token = String.raw`(?:\[audio${audioIndex}\]|@audio${audioIndex}(?!\d)|@音频${audioIndex}(?!\d))`;
  return locale === 'en'
    ? new RegExp(
      String.raw`[;；]?[ \t]*voice[ \t]+reference[ \t]*[:：][^.;；\n]*?${token}[^.;；\n]*\.?`,
      'gi',
    )
    : new RegExp(
      String.raw`[;；]?[ \t]*(?:声音参考|人声参考|音色参考)[ \t]*[:：][^。;；\n]*?${token}[^。;；\n]*。?`,
      'g',
    );
}

/** AUDIO 段的标题行：快速链路的标题固定是大写英文，中文标题一并兼容。 */
const AUDIO_HEADING_PATTERN = /^[ \t]*(?:AUDIO|音频)[ \t]*[:：]?[ \t]*$/im;

/** 段落标题下插入规范句；找不到 AUDIO 段时追加在末尾，保证绑定不会丢。 */
function insertIntoAudioSection(prompt: string, sentences: readonly string[]): string {
  const block = sentences.join('\n');
  const match = AUDIO_HEADING_PATTERN.exec(prompt);
  if (!match) {
    return `${prompt.replace(/[ \t]+$/, '')}\n${block}\n`;
  }
  const insertAt = match.index + match[0].length;
  return `${prompt.slice(0, insertAt)}\n${block}${prompt.slice(insertAt)}`;
}

/**
 * 子句替换后可能留下的空标点对（`；；` / `。；` / `；。` / `。。`）。
 * 只处理同一行内的，不跨越换行，避免动到段落结构。
 */
function tidySeparators(text: string): string {
  return text
    .replace(/；[ \t]*；/g, '；')
    .replace(/。[ \t]*；/g, '。')
    .replace(/；[ \t]*。/g, '。')
    .replace(/。[ \t]*。/g, '。');
}

/**
 * 把提示词里的人物音频引用统一成规范句。
 *
 * 没有绑定（比如只有环境音、或上游接入的音频无法确定归属）时原样返回，
 * 一个字符都不改 —— 不明确就不动。
 */
export function applyVoiceReferenceFormat(
  prompt: string,
  bindings: readonly VoiceReferenceBinding[],
  locale: VoiceReferenceLocale = 'zh',
): string {
  const list = normalizeVoiceReferenceBindings(bindings);
  if (!prompt || list.length === 0) return prompt;

  let next = prompt;

  // 1) 旧式带标签写法原地换成规范句（保留它在提示词里的原位置）。
  for (const binding of list) {
    next = next.replace(
      labeledClausePattern(binding.audioIndex, locale),
      renderVoiceReferenceSentence(binding, locale),
    );
  }

  // 2) 同一序号的其它 token 形态统一成 `@音频N`。规范句里的那个本来就是 `@音频N`，
  //    这一步不会动它，因此重复执行也是幂等的。
  for (const binding of list) {
    next = next.replace(
      equivalentTokenPattern(binding.audioIndex),
      canonicalAudioToken(binding.audioIndex),
    );
  }

  // 3) 全文都找不到的绑定补一句：AI 可能整段漏掉了音频参考。
  const missing = list.filter(
    (binding) => !next.includes(canonicalAudioToken(binding.audioIndex)),
  );
  if (missing.length > 0) {
    next = insertIntoAudioSection(
      next,
      missing.map((binding) => renderVoiceReferenceSentence(binding, locale)),
    );
  }

  return tidySeparators(next);
}
