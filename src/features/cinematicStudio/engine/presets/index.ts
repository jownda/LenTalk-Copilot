/**
 * 技术预设汇总（P1.1）
 * 12 模块预设 + 9 种风格配方 + 编译渲染（renderTechnicalProfile）。
 */
import type { ProjectV2 } from "../../shared-types";
import { FILM_PRESETS, FORMAT_PRESETS, FRAME_PRESETS, PHYSICS_PRESETS, presetById } from "./technical-modules";
import { recipeById } from "./style-recipes";

export * from "./technical-modules";
export * from "./style-recipes";
export * from "./lens-bank";
export * from "./physics-anchors";

/**
 * 编译 TechnicalProfile → canonical 技术段（TECHNICAL: / 全局技术：）
 * 规则：空值不输出；预设取 compile；自定义数组直接列出；forbidden 编译为 Avoid: ...；
 * 风格配方点选（recipeId）时自动补全 cinematography/lighting/color/composition/forbidden，
 * 但用户显式字段优先。
 * 标签本地化（P0.2），技术术语值保持原文（品牌/型号/专有名词不翻译）。
 */
const TECH_LABELS: Record<"zh" | "en", Record<string, string>> = {
  zh: {
    Cinematography: "摄影语言", Lighting: "光线", Color: "色彩", Acting: "表演", Skin: "皮肤",
    Physics: "物理", Composition: "构图", Sharpness: "锐化", "Camera angles": "机位角度", Avoid: "禁止",
  },
  en: {
    Cinematography: "Cinematography", Lighting: "Lighting", Color: "Color", Acting: "Acting", Skin: "Skin",
    Physics: "Physics", Composition: "Composition", Sharpness: "Sharpness", "Camera angles": "Camera angles", Avoid: "Avoid",
  },
};

export function renderTechnicalProfile(
  project: ProjectV2,
  locale: "zh" | "en" = "zh",
  exclude: ("lighting" | "physics")[] = [],
): string {
  const profile = project.technicalProfile;
  const recipe = recipeById(profile?.recipeId);
  const L = TECH_LABELS[locale];
  const sep = locale === "zh" ? "：" : ": ";
  const join = (list: string[]) => list.join(locale === "zh" ? "、" : ", ");
  const line = (label: string, value: string) => `${L[label]}${sep}${value}.`;
  const lines: string[] = [];

  // 影像格式
  const format = profile?.format ? (presetById(FORMAT_PRESETS, profile.format)?.compile ?? profile.format) : "";
  if (format) lines.push(...[format].flat());
  // 胶片
  const film = profile?.filmStock ? (presetById(FILM_PRESETS, profile.filmStock)?.compile ?? profile.filmStock) : "";
  if (film) lines.push(...[film].flat());
  // 分辨率
  if (profile?.resolution) lines.push(profile.resolution);
  // 帧率/快门
  const frame = profile?.fps || profile?.shutterAngle
    ? (presetById(FRAME_PRESETS, `${profile.fps ?? 24}-${profile.shutterAngle ?? 180}`)?.compile ?? `${profile.fps ?? 24}fps${profile.shutterAngle ? `, ${profile.shutterAngle}° shutter` : ""}`)
    : "";
  if (frame) lines.push(...[frame].flat());
  // 摄影语言（配方自动 + 用户覆写）
  const cinematography = profile?.cinematography?.length ? profile.cinematography : (recipe?.cinematography ?? []);
  if (cinematography.length) lines.push(line("Cinematography", join(cinematography)));
  // 光线（配方自动 + 用户覆写）
  if (!exclude.includes("lighting")) {
    const lighting = profile?.lighting?.length ? profile.lighting : (recipe?.lighting ?? []);
    if (lighting.length) lines.push(line("Lighting", join(lighting)));
  }
  // 色彩
  const color = profile?.color || (recipe?.color.join(", "));
  if (color?.trim()) lines.push(line("Color", color.trim()));
  // 表演
  if (profile?.acting?.length) lines.push(line("Acting", join(profile.acting)));
  // 皮肤
  if (profile?.skin?.length) lines.push(line("Skin", join(profile.skin)));
  // 物理
  if (!exclude.includes("physics") && profile?.physics?.length) lines.push(line("Physics", join(profile.physics)));
  // 构图（配方自动 + 用户覆写）
  const composition = profile?.composition?.length ? profile.composition : (recipe?.composition ?? []);
  if (composition.length) lines.push(line("Composition", join(composition)));
  // 锐化
  if (profile?.sharpness?.length) lines.push(line("Sharpness", join(profile.sharpness)));
  // 机位角度
  if (profile?.cameraAngles?.length) lines.push(line("Camera angles", join(profile.cameraAngles)));
  // 禁止项（配方 forbidden + 预设 forbidden 汇总）
  const forbidden = new Set<string>();
  if (profile?.format) (presetById(FORMAT_PRESETS, profile.format)?.forbidden ?? []).forEach((f) => forbidden.add(f));
  if (profile?.filmStock) (presetById(FILM_PRESETS, profile.filmStock)?.forbidden ?? []).forEach((f) => forbidden.add(f));
  if (recipe) recipe.forbidden.forEach((f) => forbidden.add(f));
  if (forbidden.size > 0) lines.push(line("Avoid", [...forbidden].join(", ")));

  return lines.join("\n");
}

/** 导演模式 LIGHTING 层：技术 Profile 光线词条（配方自动 + 用户覆写）。 */
export function renderLightingLayer(project: ProjectV2, locale: "zh" | "en" = "zh"): string {
  const profile = project.technicalProfile;
  const recipe = recipeById(profile?.recipeId);
  const list = profile?.lighting?.length ? profile.lighting : (recipe?.lighting ?? []);
  return list.join(locale === "zh" ? "、" : ", ");
}

/** 导演模式 PHYSICS 层：技术 Profile 物理词条（用户覆写优先，配方模块兜底）。 */
export function renderPhysicsLayer(project: ProjectV2, locale: "zh" | "en" = "zh"): string {
  const profile = project.technicalProfile;
  const recipe = recipeById(profile?.recipeId);
  let list = profile?.physics?.length ? [...profile.physics] : [];
  if (list.length === 0 && recipe?.modules?.physics) {
    const preset = presetById(PHYSICS_PRESETS, recipe.modules.physics);
    if (preset?.compile) list = Array.isArray(preset.compile) ? [...preset.compile] : [preset.compile];
  }
  return list.join(locale === "zh" ? "、" : ", ");
}
