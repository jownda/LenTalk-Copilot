/**
 * Shot Cards 模板编译器（P2.1，P0.2 双语）
 * 适用：高风险动作逐镜生成（一镜一张卡，只引用当前必需资产与状态）。
 */
import type { ProjectV2, SceneV2 } from "../../shared-types";
import type { PromptLocale } from "../i18n/lexicon";
import {
  renderAssetSection, renderAudioSection, renderCountSection, renderNegativeSection,
  renderSceneSection, renderShotSection, renderTechnicalSection, registryForShot,
  unifiedCameraForScene,
  type ReferenceSyntax,
} from "./sections";

export interface ShotCardsOptions {
  syntax?: ReferenceSyntax;
  locale?: PromptLocale;
  audioEnabled?: boolean;
  negativeEnabled?: boolean;
}

/** 编译 Shot Cards（每镜一张卡，双语 canonical） */
export function compileShotCards(project: ProjectV2, scene: SceneV2, options: ShotCardsOptions = {}): string {
  const syntax = options.syntax ?? "asset-id";
  const locale = options.locale ?? "zh";
  const sections: string[] = [];

  const techSection = renderTechnicalSection(project, locale);
  if (techSection) sections.push(techSection);

  const sceneSection = renderSceneSection(scene, locale);
  if (sceneSection) sections.push(sceneSection);

  const countSection = renderCountSection(project, locale);
  if (countSection) sections.push(countSection);

  // 长镜头模式：全镜统一第一镜相机参数（多镜头保留各镜机位）
  const cameraOverride = unifiedCameraForScene(scene);
  const cards = scene.shots.map((shot, index) => {
    const registry = registryForShot(project, scene, shot);
    const parts: string[] = [locale === "zh"
      ? `════════ 分镜卡 ${String(index + 1).padStart(2, "0")} ════════`
      : `════════ SHOT CARD ${String(index + 1).padStart(2, "0")} ════════`];
    const assetSection = renderAssetSection(registry, syntax, locale);
    if (assetSection) parts.push(assetSection);
    parts.push(renderShotSection(project, scene, shot, locale, syntax, cameraOverride));
    return parts.join("\n\n");
  });
  if (cards.length > 0) sections.push(cards.join("\n\n"));

  const audioSection = renderAudioSection(project, scene, locale, options.audioEnabled !== false);
  if (audioSection) sections.push(audioSection);

  const negativeSection = renderNegativeSection(project, locale, options.negativeEnabled !== false);
  if (negativeSection) sections.push(negativeSection);

  return sections.join("\n\n");
}
