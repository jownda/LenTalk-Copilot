export type DeleteDirection = 'backward' | 'forward';

export interface TextRange {
  start: number;
  end: number;
}

export interface ReferenceTokenMatch extends TextRange {
  token: string;
  value: number;
  kind: 'image' | 'audio';
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
  maxAudioCount?: number
): ReferenceTokenMatch[] {
  const tokens: ReferenceTokenMatch[] = [];

  for (let index = 0; index < text.length; index += 1) {
    const tokenShape = text.startsWith('@图', index)
      ? { kind: 'image' as const, prefixLength: 2, closesWithBracket: false }
      : text.startsWith('@音频', index)
        ? { kind: 'audio' as const, prefixLength: 3, closesWithBracket: false }
        : text.startsWith('@audio', index)
          ? { kind: 'audio' as const, prefixLength: 6, closesWithBracket: false }
        : text.startsWith('[image', index)
          ? { kind: 'image' as const, prefixLength: 6, closesWithBracket: true }
          : text.startsWith('[audio', index)
            ? { kind: 'audio' as const, prefixLength: 6, closesWithBracket: true }
            : null;
    if (!tokenShape) {
      continue;
    }

    const digitsStart = index + tokenShape.prefixLength;
    if (!isAsciiDigit(text[digitsStart] ?? '')) {
      continue;
    }

    const maxReferenceNumber = resolveMaxReferenceNumber(
      tokenShape.kind === 'image' ? maxImageCount : maxAudioCount
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

function findTokenRanges(
  text: string,
  maxImageCount?: number,
  maxAudioCount?: number
): TokenRange[] {
  const ranges: TokenRange[] = [];
  const referenceTokens = findReferenceTokens(text, maxImageCount, maxAudioCount);
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
  maxAudioCount?: number
): TextRange | null {
  const safeStart = clamp(selectionStart, 0, text.length);
  const safeEnd = clamp(selectionEnd, 0, text.length);
  const selectionMin = Math.min(safeStart, safeEnd);
  const selectionMax = Math.max(safeStart, safeEnd);
  const tokenRanges = findTokenRanges(text, maxImageCount, maxAudioCount);

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
 * 移除提示词中超出当前图片或音频数量的引用标记(上游断连后调用)。
 * 从后往前删除, 连同 token 前紧邻的空格一并移除, 避免残留多余空格。
 */
export function removeOutOfRangeReferenceTokens(
  text: string,
  maxImageCount: number,
  maxAudioCount?: number
): string {
  const tokens = findReferenceTokens(text);
  const maxAudioReferenceNumber = resolveMaxReferenceNumber(maxAudioCount);
  const outOfRange = tokens.filter((token) => token.value > (
    token.kind === 'image' ? maxImageCount : maxAudioReferenceNumber
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
