/**
 * 预设 compile 字符串本地化（显示兜底）
 * 中文界面下，已存的 preset.compile 整字符串查表翻译为 compileZh。
 */
import type { PromptLocale } from "./lexicon";
import { FORMAT_PRESETS, FILM_PRESETS, FRAME_PRESETS, CINEMATOGRAPHY_PRESETS, LIGHTING_PRESETS, COLOR_PRESETS, ACTING_PRESETS, SKIN_PRESETS, PHYSICS_PRESETS, COMPOSITION_PRESETS, SHARPNESS_PRESETS } from "../presets/technical-modules";

type Preset = { id: string; compile: string | string[]; compileZh?: string | string[] };

const ALL_PRESETS: Preset[] = [
  ...(FORMAT_PRESETS as Preset[]),
  ...(FILM_PRESETS as Preset[]),
  ...(FRAME_PRESETS as Preset[]),
  ...(CINEMATOGRAPHY_PRESETS as Preset[]),
  ...(LIGHTING_PRESETS as Preset[]),
  ...(COLOR_PRESETS as Preset[]),
  ...(ACTING_PRESETS as Preset[]),
  ...(SKIN_PRESETS as Preset[]),
  ...(PHYSICS_PRESETS as Preset[]),
  ...(COMPOSITION_PRESETS as Preset[]),
  ...(SHARPNESS_PRESETS as Preset[]),
];

const COMPILE_INDEX = new Map<string, Preset>();
for (const p of ALL_PRESETS) {
  if (!p?.compile) continue;
  const raw = Array.isArray(p.compile) ? p.compile : [p.compile];
  const zh = p.compileZh ? (Array.isArray(p.compileZh) ? p.compileZh : [p.compileZh]) : raw;
  for (let i = 0; i < raw.length; i++) COMPILE_INDEX.set(raw[i], { ...p, compile: zh[i] ?? raw[i] } as Preset);
}

/** 整串查表：preset.compile → locale 对应文本；未命中原样 */
export function localizePresetCompile(value: string, locale: PromptLocale): string {
  if (locale === "en" || !value) return value;
  const p = COMPILE_INDEX.get(value);
  if (!p) return value;
  return typeof p.compile === "string" ? p.compile : value;
}
