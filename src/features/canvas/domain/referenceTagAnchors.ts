/**
 * 给成品提示词里的 `@角色` 补上图片序号的最后一道兜底。
 *
 * 背景：提示词工作室给模型看的输入里已经写成 `@藏医 [image2] (character image)`，
 * 但模型不保证照抄 —— 同一套规则下，实测有些段落写成 `@藏医 [image2]`，有些只写
 * `@藏医`。视频模型的图片与文本是两条独立通道，只给名字时它只能猜「这个名字对应
 * 第几张图」，表现出来就是「引用时有时无」「同一个角色换脸」。
 *
 * 所以成品落节点前做一次**确定性**补齐：正文里出现图纸内的资产名且后面没跟序号时，
 * 补上它的 `[imageN]`。已经有 `[imageN]` / `@图N` 的不重复加，也不改已有编号 ——
 * 编号的权威来源是节点参考图数组的顺序，这里只补缺口。
 */
export interface ImageReferenceAnchor {
  /** 提示词里的标签名（不含 `@`）。 */
  name: string;
  /** 该资产在参考图数组里的序号（1 起）。 */
  imageIndex: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function anchorImageReferenceTags(
  prompt: string,
  anchors: readonly ImageReferenceAnchor[],
): string {
  const usable = anchors
    .map((anchor) => ({ name: anchor.name.trim(), imageIndex: Math.floor(anchor.imageIndex) }))
    .filter(
      (anchor) =>
        anchor.name.length > 0 && Number.isFinite(anchor.imageIndex) && anchor.imageIndex >= 1,
    );
  if (usable.length === 0) return prompt;

  // 长名优先：正则的或分支按顺序试，`@藏九公腰椎药盒` 必须排在 `@藏九公` 前面，
  // 否则后者会先命中、把前者截成 `@藏九公 [image1]腰椎药盒`。
  const ordered = [...usable].sort((left, right) => right.name.length - left.name.length);
  // 同名只认第一次出现的序号（重复锚点多半是同一资产被挂了两次）。
  const indexByName = new Map<string, number>();
  for (const anchor of ordered) {
    if (!indexByName.has(anchor.name)) indexByName.set(anchor.name, anchor.imageIndex);
  }
  const pattern = new RegExp(`@(${ordered.map((anchor) => escapeRegExp(anchor.name)).join('|')})`, 'g');

  let result = '';
  let lastIndex = 0;
  for (const match of prompt.matchAll(pattern)) {
    const at = match.index ?? 0;
    const afterTag = at + match[0].length;
    result += prompt.slice(lastIndex, afterTag);

    const nextChar = prompt[afterTag] ?? '';
    // 后面还连着字母/数字/下划线/连字符 → 这是更长的标签（`@藏医12`、`@藏医-2`），不动。
    const continuesTag = /[A-Za-z0-9_-]/.test(nextChar);
    const tail = prompt.slice(afterTag, afterTag + 24);
    const alreadyAnchored = /^\s*\[image\d+\]/.test(tail) || /^\s*@图\d+/.test(tail);

    const imageIndex = indexByName.get(match[1]);
    if (!continuesTag && !alreadyAnchored && imageIndex) {
      result += ` [image${imageIndex}]`;
    }
    lastIndex = afterTag;
  }
  result += prompt.slice(lastIndex);
  return result;
}
