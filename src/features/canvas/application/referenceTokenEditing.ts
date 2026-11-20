export type DeleteDirection = 'backward' | 'forward';

export interface TextRange {
  start: number;
  end: number;
}

export interface ReferenceTokenMatch extends TextRange {
  token: string;
  value: number;
  kind: 'image' | 'audio' | 'video';
}

interface TokenRange extends TextRange {
  blockStart: number;
  blockEnd: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function resolveMaxReferenceNumber(maxImageCount?: number): number {
  if (typeof maxImageCount !== 'number' || !Number.isFinite(maxImageCount)) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(0, Math.floor(maxImageCount));
}

function isAsciiDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

export function findReferenceTokens(
  text: string,
  maxImageCount?: number,
  maxAudioCount?: number,
  maxVideoCount?: number
): ReferenceTokenMatch[] {
  const tokens: ReferenceTokenMatch[] = [];

  for (let index = 0; index < text.length; index += 1) {
    const tokenShape = text.startsWith('@图', index)
      ? { kind: 'image' as const, prefixLength: 2, closesWithBracket: false }
      : text.startsWith('@音频', index)
        ? { kind: 'audio' as const, prefixLength: 3, closesWithBracket: false }
        : text.startsWith('@视频', index)
          ? { kind: 'video' as const, prefixLength: 3, closesWithBracket: false }
          : text.startsWith('@audio', index)
            ? { kind: 'audio' as const, prefixLength: 6, closesWithBracket: false }
            : text.startsWith('@video', index)
              ? { kind: 'video' as const, prefixLength: 6, closesWithBracket: false }
              : text.startsWith('[image', index)
                ? { kind: 'image' as const, prefixLength: 6, closesWithBracket: true }
                : text.startsWith('[audio', index)
                  ? { kind: 'audio' as const, prefixLength: 6, closesWithBracket: true }
                  : text.startsWith('[video', index)
                    ? { kind: 'video' as const, prefixLength: 6, closesWithBracket: true }
                    : null;
    if (!tokenShape) {
      continue;
    }

    const digitsStart = index + tokenShape.prefixLength;
    if (!isAsciiDigit(text[digitsStart] ?? '')) {
      continue;
    }

    const maxReferenceNumber = resolveMaxReferenceNumber(
      tokenShape.kind === 'image'
        ? maxImageCount
        : tokenShape.kind === 'audio'
          ? maxAudioCount
          : maxVideoCount
    );

    let digitsEnd = digitsStart;
    while (isAsciiDigit(text[digitsEnd] ?? '')) {
      digitsEnd += 1;
    }

    const end = tokenShape.closesWithBracket ? digitsEnd + 1 : digitsEnd;
    if (tokenShape.closesWithBracket && text[digitsEnd] !== ']') {
      continue;
    }
    const value = Number(text.slice(digitsStart, digitsEnd));
    if (Number.isFinite(value) && value >= 1 && value <= maxReferenceNumber) {
      tokens.push({
        start: index,
        end,
        token: text.slice(index, end),
        value,
        kind: tokenShape.kind,
      });
      index = end - 1;
    }
  }

  return tokens;
}

/** Remove or re-number audio references after a connected source is removed. */
export function remapAudioReferenceTokens(text: string, oldSources: readonly string[], nextSources: readonly string[]): string {
  return text
    .replace(/@audio(\d+)|@音频(\d+)|\[audio(\d+)\]/g, (token, asciiIndex?: string, chineseIndex?: string, bracketIndex?: string) => {
      const oldIndex = Number(asciiIndex || chineseIndex || bracketIndex);
      const source = oldSources[oldIndex - 1];
      if (!source) return token;
      const nextIndex = nextSources.indexOf(source);
      if (nextIndex < 0) return '';
      const value = nextIndex + 1;
      if (token.startsWith('[')) return `[audio${value}]`;
      if (token.startsWith('@音频')) return `@音频${value}`;
      return `@audio${value}`;
    })
    .replace(/[ \t]{2,}/g, ' ');
}

/** Remove or re-number video references after a connected source is removed. */
export function remapVideoReferenceTokens(text: string, oldSources: readonly string[], nextSources: readonly string[]): string {
  return text
    .replace(/@video(\d+)|@视频(\d+)|\[video(\d+)\]/g, (token, asciiIndex?: string, chineseIndex?: string, bracketIndex?: string) => {
      const oldIndex = Number(asciiIndex || chineseIndex || bracketIndex);
      const source = oldSources[oldIndex - 1];
      if (!source) return token;
      const nextIndex = nextSources.indexOf(source);
      if (nextIndex < 0) return '';
      const value = nextIndex + 1;
      if (token.startsWith('[')) return `[video${value}]`;
      if (token.startsWith('@视频')) return `@视频${value}`;
      return `@video${value}`;
    })
    .replace(/[ \t]{2,}/g, ' ');
}

/**
 * Preserve an image token's source when graph inputs are removed or reordered.
 * A disconnected source loses only its own tokens; surviving sources receive
 * their new contiguous API index instead of inheriting a neighbor's token.
 */
export function remapImageReferenceTokens(text: string, oldSources: readonly string[], nextSources: readonly string[]): string {
  return text
    .replace(/@图(\d+)|\[image(\d+)\]/g, (token, chineseIndex?: string, bracketIndex?: string) => {
      const oldIndex = Number(chineseIndex || bracketIndex);
      const source = oldSources[oldIndex - 1];
      if (!source) return token;
      const nextIndex = nextSources.indexOf(source);
      if (nextIndex < 0) return '';
      const value = nextIndex + 1;
      return token.startsWith('[') ? `[image${value}]` : `@图${value}`;
    })
    .replace(/[ \t]{2,}/g, ' ');
}

/**
 * 参考图数组变化时，该对提示词里的 `[imageN]` 做什么。
 *
 * 🔴 判据是**变化类型**，不是「数量变少就删」。
 *
 * `remapImageReferenceTokens` 的删除语义建立在「找不到 = 这个来源被断开了」这个前提上，
 * 但真实链路里还有第三种情况：来源**被原地改写成了另一个字符串**。
 *
 * - `UnpersistedMediaNotice` 打开工程 2 秒后会自动把 `http(s)://` 参考图下载成本地文件，
 *   并把节点数据里的地址整体换成落盘路径；
 * - 资产库「文件名对齐」走 `applyAssetPathRemap`，一次全局字符串重映射就换掉了
 *   `studioReferenceImages` 里的路径（这条只作用于资产库来源 —— 这就是「从资产库调的
 *   图片更容易掉」的原因）。
 *
 * 这两种改写都是「同一张图换了个地址」，`nextSources.indexOf(oldSource)` 必然 -1，
 * 按删除语义就会把 `[image1]`…整段删掉并**写回节点数据**，等图片到齐也不会恢复。
 * 用户看到的就是「刚开始引用正常，过一会儿（画面动一下回来）全掉了」。
 * 音频没有这条自动重映射，所以同样的改写对它没有影响 —— 与线上反馈完全一致。
 *
 * 所以：
 * - `next` 是 `previous` 的子集且更短 → 真的断连，删掉那几个标记；
 * - `next` 是 `previous` 的**重排**（同长度、同一批来源）→ 只换序号；
 * - 出现 `previous` 里没有的新来源（改写、增删混合）→ **一个标记都不动**。
 *   宁可留一个越界标记，也绝不删用户的内容。
 */
export function syncImageReferenceTokens(
  text: string,
  previousSources: readonly string[],
  nextSources: readonly string[],
): string {
  const sameSet = nextSources.every((source) => previousSources.includes(source));
  if (!sameSet) {
    // 有陌生来源：至少有一次改写，无法区分「改写」与「断开」，保守不动。
    return text;
  }
  if (nextSources.length === previousSources.length) {
    // 同一批来源的纯重排：序号要跟着新的上传顺序走。
    return remapImageReferenceTokens(text, previousSources, nextSources);
  }
  if (nextSources.length < previousSources.length) {
    // 只少了来源、没有新增 —— 这才是真正的上游断连。
    return remapImageReferenceTokens(text, previousSources, nextSources);
  }
  return text;
}

/**
 * 两段提示词是否「只差引用标记」（空白与 `[imageN]` / `@图N` 都不计）。
 *
 * 用在「自愈」上：视频节点的正文与上游工作室的成品逐字相同、只少了标记 ——
 * 说明标记是被某条链路删的，可以安全地整段借回。用户只要改过一个字，
 * 这里就不相等，绝不覆盖他的编辑。
 */
export function samePromptIgnoringReferenceTokens(left: string, right: string): boolean {
  const normalize = (text: string) =>
    text
      .replace(/(\[image\d+\]|@图\d+)/g, '')
      .replace(/\s+/g, '');
  const a = normalize(left);
  return a.length > 0 && a === normalize(right);
}

function findTokenRanges(
  text: string,
  maxImageCount?: number,
  maxAudioCount?: number,
  maxVideoCount?: number
): TokenRange[] {
  const ranges: TokenRange[] = [];
  const referenceTokens = findReferenceTokens(text, maxImageCount, maxAudioCount, maxVideoCount);
  for (const token of referenceTokens) {
    const start = token.start;
    const end = token.end;
    const blockStart = start > 0 && text[start - 1] === ' ' ? start - 1 : start;
    const blockEnd = end < text.length && text[end] === ' ' ? end + 1 : end;

    ranges.push({
      start,
      end,
      blockStart,
      blockEnd,
    });
  }

  return ranges;
}

export function insertReferenceToken(
  text: string,
  cursor: number,
  marker: string
): { nextText: string; nextCursor: number } {
  const safeCursor = clamp(cursor, 0, text.length);
  const before = text.slice(0, safeCursor);
  const after = text.slice(safeCursor);
  const previousChar = before.length > 0 ? before.charAt(before.length - 1) : '';
  const nextChar = after.length > 0 ? after.charAt(0) : '';
  const needsLeadingSpace = before.length > 0 && !/\s/.test(previousChar);
  const needsTrailingSpace = !(after.length > 0 && /\s/.test(nextChar));
  const insertion = `${needsLeadingSpace ? ' ' : ''}${marker}${needsTrailingSpace ? ' ' : ''}`;

  return {
    nextText: `${before}${insertion}${after}`,
    nextCursor: before.length + insertion.length,
  };
}

export function resolveReferenceAwareDeleteRange(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  direction: DeleteDirection,
  maxImageCount?: number,
  maxAudioCount?: number,
  maxVideoCount?: number
): TextRange | null {
  const safeStart = clamp(selectionStart, 0, text.length);
  const safeEnd = clamp(selectionEnd, 0, text.length);
  const selectionMin = Math.min(safeStart, safeEnd);
  const selectionMax = Math.max(safeStart, safeEnd);
  const tokenRanges = findTokenRanges(text, maxImageCount, maxAudioCount, maxVideoCount);

  if (selectionMin !== selectionMax) {
    let expandedStart = selectionMin;
    let expandedEnd = selectionMax;
    let touchedToken = false;

    for (const tokenRange of tokenRanges) {
      if (tokenRange.blockEnd <= expandedStart || tokenRange.blockStart >= expandedEnd) {
        continue;
      }

      touchedToken = true;
      expandedStart = Math.min(expandedStart, tokenRange.blockStart);
      expandedEnd = Math.max(expandedEnd, tokenRange.blockEnd);
    }

    if (!touchedToken) {
      return null;
    }

    return {
      start: expandedStart,
      end: expandedEnd,
    };
  }

  const point = direction === 'backward'
    ? Math.max(0, selectionMin - 1)
    : selectionMin;

  for (const tokenRange of tokenRanges) {
    if (point >= tokenRange.blockStart && point < tokenRange.blockEnd) {
      return {
        start: tokenRange.blockStart,
        end: tokenRange.blockEnd,
      };
    }
  }

  return null;
}

export function removeTextRange(
  text: string,
  range: TextRange
): { nextText: string; nextCursor: number } {
  const safeStart = clamp(Math.min(range.start, range.end), 0, text.length);
  const safeEnd = clamp(Math.max(range.start, range.end), 0, text.length);
  const before = text.slice(0, safeStart);
  const after = text.slice(safeEnd);

  if (before.endsWith(' ') && after.startsWith(' ')) {
    return {
      nextText: `${before}${after.slice(1)}`,
      nextCursor: safeStart,
    };
  }

  return {
    nextText: `${before}${after}`,
    nextCursor: safeStart,
  };
}

/**
 * 是否该清理「越界」引用标记。
 *
 * 判据只有一条：**参考数量确实变少了**（上游断连）。
 *
 * 为什么不能无条件按当前数量清理：提示词工作室把成品写进下游节点的那一刻，节点的参考图
 * 往往还没解析完（资源地址异步解析）或还没接线，此时数量短暂为 0/偏小。按数量清理会把
 * 整段 `[imageN]` 当成越界删掉，并且**写回节点数据** —— 等图片到齐也不会恢复了。
 * 用户看到的现象就是「刚生成时有图片引用，过一会儿全消失了」。
 */
export function shouldPruneReferenceTokens(previousCount: number, nextCount: number): boolean {
  return nextCount < previousCount;
}

/**
 * 移除提示词中超出当前图片或音频数量的引用标记(上游断连后调用)。
 * 从后往前删除, 连同 token 前紧邻的空格一并移除, 避免残留多余空格。
 */
export function removeOutOfRangeReferenceTokens(
  text: string,
  maxImageCount: number,
  maxAudioCount?: number,
  maxVideoCount?: number
): string {
  const tokens = findReferenceTokens(text);
  const maxAudioReferenceNumber = resolveMaxReferenceNumber(maxAudioCount);
  const maxVideoReferenceNumber = resolveMaxReferenceNumber(maxVideoCount);
  const outOfRange = tokens.filter((token) => token.value > (
    token.kind === 'image'
      ? maxImageCount
      : token.kind === 'audio'
        ? maxAudioReferenceNumber
        : maxVideoReferenceNumber
  ));
  if (outOfRange.length === 0) {
    return text;
  }

  let next = text;
  for (let index = outOfRange.length - 1; index >= 0; index -= 1) {
    const token = outOfRange[index];
    let start = token.start;
    while (start > 0 && next[start - 1] === ' ') {
      start -= 1;
    }
    let cleaned = next.slice(0, start) + next.slice(token.end);
    if (start === 0) {
      cleaned = cleaned.trimStart();
    }
    next = cleaned;
  }
  return next;
}
