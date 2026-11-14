/**
 * 本地生成 `ACTIVE REFERENCES`（活动引用）段。
 *
 * 为什么不让模型写：模型不保证照抄 `@角色 [imageN]`。实测同一套规则下，有的段落带序号、
 * 有的只剩 `@角色`，甚至同一个资产被它改成近似的名字（`藏九公膏药贴` → `藏九公膏贴`），
 * 导致「按名字补序号」也补不上 —— 用户看到的就是「引用突然全掉了」。
 *
 * 所以这一段改成**由代码按资产表写**：
 * - 序号来自节点的参考图数组（权威，不由模型决定）；
 * - 名字优先沿用模型已经写在段落里的那个（正文用的是同一个名字，才不会对不上）；
 * - 模型漏写的资产**补在段末**，一个都不少；
 * - 模型多写的（不是参考图资产的实体，如画外人物）原样保留，但不给它编号。
 */

export interface LocalReferenceAsset {
  /** 资产名（不含 `@`）。 */
  name: string;
  /** 参考图序号（1 起）。 */
  imageIndex: number;
  /** 资产自带的说明；模型没写这一条时用它兜底。 */
  description?: string;
}

/** 段落标题（大小写不敏感）：中英文都认。 */
const REFERENCES_HEADING = /^[ \t]*(ACTIVE REFERENCES|活动引用)[ \t]*[:：]?[ \t]*$/i;

/** 下一个段落标题 —— 用来界定本段的范围。 */
const NEXT_HEADING =
  /^[ \t]*(SCENE CONTEXT|LOCATION MAP|FIRST FRAME(?: AND SPATIAL BLOCKING)?|FORMAT MODE|OPTICS|CAMERA|ACTION TIMING|PHYSICS|LIGHTING|AUDIO|STYLE|POSITIVE CONSTRAINTS|NEGATIVE CONSTRAINTS|SHOT EXECUTION|SCENE MAP AND STAGING|场景|场景地图|首帧(?:与空间走位|与站位)?|格式模式|光学|相机|摄像机|动作节奏|物理|光线|音频|风格|正向约束|负向约束|镜头执行)[ \t]*[:：]?[ \t]*$/i;

function isHeading(line: string): boolean {
  return NEXT_HEADING.test(line);
}

/** 从一行引用里取出 `@名字` 和名字后面的正文（已去掉序号标记）。 */
function parseReferenceLine(line: string): { name: string; body: string } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('@')) return null;
  const match = /^@([^\s[\]：:，,；;、]+)/.exec(trimmed);
  if (!match) return null;
  const name = match[1];
  let body = trimmed.slice(match[0].length);
  // 去掉模型可能已经写的序号标记（`[image3]` / `@图3`），统一由这里重建。
  body = body.replace(/^\s*(?:\[image\d+\]|@图\d+)/, '');
  body = body.replace(/^\s*[：:]\s*/, '');
  return { name, body: body.trim() };
}

/** 该行是不是某条资产（名字完全一致，或互相包含这种「模型改了半个名字」的情况）。 */
function matchesAsset(lineName: string, assetName: string): boolean {
  if (lineName === assetName) return true;
  const a = lineName.replace(/\s+/g, '');
  const b = assetName.replace(/\s+/g, '');
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  // 模型偶尔把后缀写掉（`藏九公膏药贴` → `藏九公膏贴`），比较去重后的字符集合。
  const setA = new Set([...a]);
  const setB = new Set([...b]);
  const shared = [...setA].filter((ch) => setB.has(ch)).length;
  return shared / Math.max(setA.size, setB.size) >= 0.8;
}

function renderReferenceLine(name: string, imageIndex: number, body: string): string {
  const suffix = body ? `：${body}` : '：严格匹配参考图的外观、比例与材质。';
  return `@${name} [image${imageIndex}]${suffix}`;
}

/**
 * 用资产表重建提示词里的活动引用段。
 *
 * 没有这一段时：插在 `LOCATION MAP` 等已知段落之前；一个已知段落都没有就接在
 * `SCENE CONTEXT` 之后（实在找不到位置就追加到末尾）。
 */
export function applyLocalReferenceSection(
  prompt: string,
  assets: readonly LocalReferenceAsset[],
): string {
  const usable = assets
    .map((asset) => ({
      name: asset.name.trim(),
      imageIndex: Math.floor(asset.imageIndex),
      description: (asset.description ?? '').trim(),
    }))
    .filter(
      (asset) => asset.name.length > 0 && Number.isFinite(asset.imageIndex) && asset.imageIndex >= 1,
    )
    .sort((left, right) => left.imageIndex - right.imageIndex);
  if (usable.length === 0) return prompt;

  const lines = prompt.replace(/\r\n?/g, '\n').split('\n');
  const headingIndex = lines.findIndex((line) => REFERENCES_HEADING.test(line));

  // 段落范围：标题下一行 → 第一个空行后的下一个标题（或文末）。
  let start = headingIndex >= 0 ? headingIndex + 1 : -1;
  let end = -1;
  if (headingIndex >= 0) {
    end = lines.length;
    for (let index = start; index < lines.length; index += 1) {
      if (isHeading(lines[index])) {
        end = index;
        break;
      }
    }
  }

  const existing = headingIndex >= 0 ? lines.slice(start, end) : [];
  const usedLine = new Set<number>();
  const rendered: string[] = [];
  const leftover: string[] = [];

  for (const asset of usable) {
    let matchIndex = -1;
    for (let index = 0; index < existing.length; index += 1) {
      if (usedLine.has(index)) continue;
      const parsed = parseReferenceLine(existing[index]);
      if (!parsed) continue;
      if (matchesAsset(parsed.name, asset.name)) {
        matchIndex = index;
        break;
      }
    }
    if (matchIndex >= 0) {
      usedLine.add(matchIndex);
      const parsed = parseReferenceLine(existing[matchIndex])!;
      // 沿用模型写在段落里的名字：正文引用的是同一个名字，才不会出现两个人。
      rendered.push(renderReferenceLine(parsed.name, asset.imageIndex, parsed.body || asset.description));
      continue;
    }
    rendered.push(renderReferenceLine(asset.name, asset.imageIndex, asset.description));
  }

  for (let index = 0; index < existing.length; index += 1) {
    const line = existing[index];
    if (usedLine.has(index) || !line.trim()) continue;
    // 不是参考图资产的实体（画外人物、纯文本设定）：保留，但不给编号。
    leftover.push(
      line
        .replace(/(\[image\d+\]|@图\d+)\s*/g, '')
        .replace(/\s+([：:])/g, '$1')
        .trimEnd(),
    );
  }

  const section = [...rendered, ...leftover];
  if (headingIndex >= 0) {
    const tail = lines.slice(end);
    // 段落之间保留一个空行：原格式是「标题 + 内容 + 空行 + 下一个标题」。
    const separator = tail.length > 0 && tail[0].trim() ? [''] : [];
    return [...lines.slice(0, headingIndex + 1), ...section, ...separator, ...tail].join('\n');
  }

  // 没有这一段：插到第一个已知段落之前（通常是 LOCATION MAP），否则接在文末。
  // 跳过第 0 行：第一行本身就是 `SCENE CONTEXT`，插在它前面会毁掉整段结构。
  const nextHeadingIndex = lines.findIndex((line, index) => index > 0 && isHeading(line));
  const heading = 'ACTIVE REFERENCES';
  if (nextHeadingIndex >= 0) {
    return [
      ...lines.slice(0, nextHeadingIndex),
      heading,
      ...section,
      '',
      ...lines.slice(nextHeadingIndex),
    ].join('\n');
  }
  return [...lines, '', heading, ...section].join('\n');
}
