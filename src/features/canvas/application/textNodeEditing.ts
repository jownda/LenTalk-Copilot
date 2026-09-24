export function resolveTextMatchIndexes(text: string, query: string, caseSensitive: boolean): number[] {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];
  const source = caseSensitive ? text : text.toLocaleLowerCase();
  const target = caseSensitive ? normalizedQuery : normalizedQuery.toLocaleLowerCase();
  const indexes: number[] = [];
  let fromIndex = 0;
  while (fromIndex <= source.length - target.length) {
    const index = source.indexOf(target, fromIndex);
    if (index < 0) break;
    indexes.push(index);
    fromIndex = index + Math.max(target.length, 1);
  }
  return indexes;
}

export function replaceTextAt(text: string, query: string, replacement: string, index: number): string {
  const normalizedQuery = query.trim();
  if (!normalizedQuery || index < 0 || index + normalizedQuery.length > text.length) return text;
  return `${text.slice(0, index)}${replacement}${text.slice(index + normalizedQuery.length)}`;
}

export function replaceAllText(text: string, query: string, replacement: string, caseSensitive: boolean): string {
  const matches = resolveTextMatchIndexes(text, query, caseSensitive);
  if (matches.length === 0) return text;
  const normalizedQuery = query.trim();
  let result = '';
  let cursor = 0;
  matches.forEach((index) => {
    result += text.slice(cursor, index);
    result += replacement;
    cursor = index + normalizedQuery.length;
  });
  return result + text.slice(cursor);
}
