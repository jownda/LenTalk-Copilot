/** Merge stored and graph-provided media references without changing attachment order. */
export function mergeMediaReferenceSources(...groups: Array<readonly unknown[] | undefined>): string[] {
  const sources: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const value of group ?? []) {
      if (typeof value !== "string") continue;
      const source = value.trim();
      if (!source || seen.has(source)) continue;
      seen.add(source);
      sources.push(source);
    }
  }
  return sources;
}
