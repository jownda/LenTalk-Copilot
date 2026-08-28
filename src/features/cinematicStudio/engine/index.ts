import type { Character, Project, Scene } from "../shared-types";
import { getCamera, getLens } from "./gear";
import { getStyle, styleDescription } from "./styles";
import { withNegativePrefix, DEFAULT_NEGATIVE } from "./constants";

export * from "./gear";
export * from "./styles";
export * from "./states";
export * from "./beats";
export * from "./presets";
export * from "./shot-templates";
export * from "./constants";
export * from "./i18n/lexicon";
export * from "./i18n/recipe-terms";
export * from "./i18n/preset-localize";
export * from "./ai/assistant";
export * from "./compiler";
export * from "./continuity";
export * from "./quality";
export * from "./asset-naming";
export interface ContinuityIssue { status: "ok" | "warning"; label: string; detail: string; }

/** V0.1 遗留编译器（单角色拼接；P2.1 起请用 compilePrompt 新入口，此函数仅保留兼容旧测试） */
export function compilePromptLegacy(project: Project, scene: Scene, character?: Character): string {
  const style = getStyle(project.styleId);
  // 参考图直接以 @<图片> 跟在角色名后; 音频以「角色名声音音色为@<音频>」描述; 道具以「角色名的道具: 用法@<道具图>」描述
  const props = character?.prop?.filter((item) => item.text.trim() || item.image) ?? [];
  const propText = props.length && character
    ? ` ${character.name}的道具: ${props.map((item) => `${item.text.trim()}${item.image ? `@${item.image}` : ""}`).join("; ")}.`
    : "";
  const faceText = character?.face?.trim() ? ` face: ${character.face.trim()}` : "";
  const wardrobeText = character?.wardrobe?.trim() ? `; wardrobe: ${character.wardrobe.trim()}` : "";
  const identity = character
    ? `${character.name}${character.reference ? `@${character.reference}` : ""}${faceText}${wardrobeText}.${character.audio ? ` ${character.name}的声音音色为@${character.audio}.` : ""}${propText}`
    : "未绑定角色(请在角色卡片添加角色后重新生成)。";
  const cuts = scene.shots.map((shot, index) => {
    const camera = getCamera(shot.camera);
    const lens = getLens(shot.lensModel);
    const cameraText = camera ? ` Camera: ${camera.brand} ${camera.model} — ${camera.effect}.` : "";
    const lensText = lens ? ` Lens: ${lens.brand} ${lens.model} ${lens.focal} — ${lens.effect}.` : "";
    return `CUT ${index + 1} (${shot.duration})\n${shot.framing}, ${shot.lens}, ${shot.movement.toLowerCase()} movement.${cameraText}${lensText} ${shot.action} Acting: ${shot.acting}. Screen direction: ${shot.direction}.`;
  }).join("\n\n");
  const negative = withNegativePrefix(project.negativePrompt?.trim() || DEFAULT_NEGATIVE);
  const notes = scene.description?.trim() ? ` ${scene.description.trim()}` : "";
  // 场景锁定字段未填(即"无")不进入提示词; 段落顺序与项目卡片自上而下一致
  const sceneParts = [scene.name, scene.duration, scene.location, scene.time, scene.weather].filter((part) => part.trim()).join(", ");
  return `SCENE:\n${sceneParts}. ${scene.logline}${notes}\n\nSTYLE:\n${styleDescription(style)}; 24 fps, natural texture.\n\nCINEMATOGRAPHY:\n${scene.palette}; practical ${scene.lighting.toLowerCase()}, controlled contrast, motivated shadows.\n\nCHARACTER LOCK:\n${identity}\n\n${cuts}\n\nNEGATIVE CONSTRAINTS:\n${negative}`;
}

export function checkContinuity(scene: Scene, characters: Character[]): ContinuityIssue[] {
  const issues: ContinuityIssue[] = [
    { status: scene.environmentLock ? "ok" : "warning", label: "Environment", detail: scene.environmentLock ? "Location, weather, palette, and lighting are locked." : "Environment lock has not been enabled." },
    { status: scene.weather ? "ok" : "warning", label: "Weather", detail: scene.weather ? `${scene.weather} is defined for every cut.` : "Weather is missing." }
  ];
  for (const shot of scene.shots) {
    if (!shot.characterId) issues.push({ status: "warning", label: shot.label, detail: "No Character Lock is attached." });
    else if (!characters.find((character) => character.id === shot.characterId)?.identityLock) issues.push({ status: "warning", label: shot.label, detail: "Attached character has no active identity lock." });
  }
  const directions = new Set(scene.shots.map((shot) => shot.direction));
  issues.push({ status: directions.size === 1 ? "ok" : "warning", label: "Movement direction", detail: directions.size === 1 ? "Screen direction stays consistent across cuts." : "Cuts use opposing screen directions. Confirm this is intentional." });
  return issues;
}
