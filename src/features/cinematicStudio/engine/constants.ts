/** 负面提示词常量与工具（独立文件避免编译器循环依赖） */
import { fillTemplate } from "./i18n/lexicon";
import type { PromptLocale } from "./i18n/lexicon";

/** 默认负面词：稳定 ID（P0.3），中文用「不要…」，英文用「no …」 */
export const DEFAULT_NEGATIVE_IDS = [
  "character-drift",
  "wardrobe-changes",
  "extra-limbs",
  "no-gravity-movement",
  "floating-props",
  "text-or-watermarks",
] as const;

/** 负面词类别（P0.3）：决定就近挂靠到哪个宿主段，还是留在精简全局尾段 */
export type NegativeCategory = "character" | "physics" | "lighting" | "camera" | "global";

/** 全局失败模式：身份漂移 / 悬浮运动 / 文字水印，保留精简负面尾段 */
export const GLOBAL_NEGATIVES = [
  "character-drift",
  "no-gravity-movement",
  "text-or-watermarks",
] as const;

/** 可局部内联的失败模式：外观漂移 / 多余肢体 / 漂浮道具，就近挂到 CHARACTER / PHYSICS */
export const LOCALIZABLE_NEGATIVES = [
  "wardrobe-changes",
  "extra-limbs",
  "floating-props",
] as const;

/** 负面词双语词条（英文 ID → 双语文本；英文已内嵌否定词时不重复加 no） */
export const NEGATIVE_TERMS: Record<string, { zh: string; en: string; alreadyNegated?: boolean }> = {
  "character-drift": { zh: "角色形象漂移", en: "character drift" },
  "wardrobe-changes": { zh: "服装变化", en: "wardrobe changes" },
  "extra-limbs": { zh: "多余肢体", en: "extra limbs" },
  "no-gravity-movement": { zh: "无重力运动", en: "no gravity movement", alreadyNegated: true },
  "floating-props": { zh: "漂浮道具", en: "floating props" },
  "text-or-watermarks": { zh: "文字或水印", en: "text or watermarks" },
};

/** 内置 ID → 类别（P0.3） */
const NEGATIVE_ID_CATEGORY: Record<string, NegativeCategory> = {
  "character-drift": "global",
  "wardrobe-changes": "character",
  "extra-limbs": "character",
  "no-gravity-movement": "global",
  "floating-props": "physics",
  "text-or-watermarks": "global",
};

/** 自由文本关键词 → 类别（normalize 后匹配；覆盖历史项目与 AI 生成的口语负面词） */
const NEGATIVE_TEXT_CATEGORY: Record<string, NegativeCategory> = {
  "character drift": "global",
  "wardrobe changes": "character",
  "extra limbs": "character",
  "no gravity movement": "global",
  "floating props": "physics",
  "text or watermarks": "global",
  "flat front light": "lighting",
  "beauty fill": "lighting",
  "overly stable shots": "camera",
  "stiff blocking": "camera",
  "fragmented hard cuts": "camera",
};

const normalizeNegative = (item: string): string => item.trim().toLowerCase().replace(/\s+/g, " ");

/** 自由文本 → 内置 ID（历史项目常用英文负面词） */
export function canonicalNegativeId(item: string): string | undefined {
  const trimmed = item.trim();
  if (NEGATIVE_TERMS[trimmed]) return trimmed;
  const hyphenated = trimmed.toLowerCase().replace(/\s+/g, "-");
  return NEGATIVE_TERMS[hyphenated] ? hyphenated : undefined;
}

/** 负面词归类：内置 ID 优先，其次自由文本关键词，未知词保守归 global（P0.3） */
export function classifyNegative(item: string): NegativeCategory {
  const canonical = canonicalNegativeId(item);
  if (canonical && NEGATIVE_ID_CATEGORY[canonical]) return NEGATIVE_ID_CATEGORY[canonical];
  return NEGATIVE_TEXT_CATEGORY[normalizeNegative(item)] ?? "global";
}

/**
 * 渲染负面约束条目（P0.3，替代 withNegativePrefix）
 * - 内置 ID：中文「不要…」，英文「no …」（已带否定词的不重复加）
 * - 旧自由文本（逗号分隔）：按原文输出，不额外添加跨语言前缀
 */
export function renderNegativeItems(items: string[], locale: PromptLocale): string[] {
  return items
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const term = NEGATIVE_TERMS[item];
      if (term) {
        if (locale === "zh") return `不要${term.zh}`;
        return term.alreadyNegated ? term.en : `no ${term.en}`;
      }
      return item; // 自由文本保持原文
    });
}

/** 兼容旧引用（V0.1 测试）：保留原 withNegativePrefix 行为，但按新规范实现 */
export function withNegativePrefix(text: string, locale: PromptLocale = "zh"): string {
  const ids = text.split(/[,，]/);
  // 全部命中内置 ID → 走新词条
  if (ids.every((item) => NEGATIVE_TERMS[item.trim()])) return renderNegativeItems(ids, locale).join(", ");
  return text
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => /^(不要|禁止|避免|严禁|no\b)/i.test(item) ? item : `不要${item}`)
    .join(", ");
}

/** 默认负面词渲染（P0.3） */
export function renderDefaultNegative(locale: PromptLocale): string {
  return renderNegativeItems([...DEFAULT_NEGATIVE_IDS], locale).join(", ");
}

/** 兼容导出：默认负面词 ID 逗号串（UI 占位；编译时走 renderNegativeItems） */
export const DEFAULT_NEGATIVE = [...DEFAULT_NEGATIVE_IDS].join(", ");

/** 兼容导出：fillTemplate 透传 */
export const _fill = fillTemplate;
