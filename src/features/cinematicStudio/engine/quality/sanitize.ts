import {
  DIAGNOSTIC_EN_RES, DIAGNOSTIC_ZH_RES, META_EN_RES, META_ZH_RES,
} from "./lexicon";

const EMPTY_SECTION_RE = /^(?:SCENE CONTEXT|ACTIVE REFERENCES|LOCATION MAP|FIRST FRAME(?: AND SPATIAL BLOCKING)?|FORMAT MODE|OPTICS|CAMERA|ACTION TIMING|PHYSICS|LIGHTING|AUDIO|POSITIVE CONSTRAINTS|NEGATIVE LOCKS(?: \(GLOBAL ONLY\))?|场景上下文|活动引用|位置图|首帧(?:与站位)?|格式模式|光学|相机|动作时间|动作时序|物理|光线|音频|正向约束|负面局部锁)\s*[:：]?\s*$/i;

function isProjectMetadata(line: string): boolean {
  return META_ZH_RES.some((pattern) => pattern.test(line)) || META_EN_RES.some((pattern) => pattern.test(line));
}

function isDiagnosticMetadata(line: string): boolean {
  return DIAGNOSTIC_ZH_RES.some((pattern) => pattern.test(line)) || DIAGNOSTIC_EN_RES.some((pattern) => pattern.test(line));
}

/**
 * V2.5：最终提示词正文的统一净化出口。
 * 只删除项目管理/诊断元数据与空分段，不改写用户的画面指令和资产引用。
 */
export function sanitizeDirectorText(text: string): string {
  if (!text?.trim()) return "";

  const kept = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => !isProjectMetadata(line) && !isDiagnosticMetadata(line));

  const withoutEmptySections: string[] = [];
  for (let index = 0; index < kept.length; index += 1) {
    const line = kept[index].trim();
    if (EMPTY_SECTION_RE.test(line)) {
      let next = index + 1;
      while (next < kept.length && !kept[next].trim()) next += 1;
      if (next >= kept.length || EMPTY_SECTION_RE.test(kept[next].trim())) continue;
    }
    withoutEmptySections.push(kept[index]);
  }

  return withoutEmptySections.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
