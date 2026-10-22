/**
 * Asset-ID Tagged 模板编译器（P2.1 三模板之一，P0.2 双语）
 * 适用：支持图片 UUID/槽位语法的模型。
 * 结构：技术 → 场景 → 数量锁 → 资产（<<<uuid>>> [imageN]）→ 强锁 → 镜头行 → 音频 → 负面段。
 */
import type { ProjectV2, SceneV2, ShotV2 } from "../../shared-types";
import type { PromptLocale } from "../i18n/lexicon";
import {
  renderAssetSection, renderAudioSection, renderCountSection, renderNegativeSection,
  renderSceneSection, renderShotSection, renderStrictSection, renderTechnicalSection,
  registryForShot, type ReferenceSyntax,
} from "./sections";

export interface CompileOptions {
  /** 图片引用语法（P2.1 模型 Profile 决定；默认 asset-id） */
  syntax?: ReferenceSyntax;
  /** 输出语言（P0.2，默认 zh 产品默认） */
  locale?: PromptLocale;
  /** 音频段开关（supportsAudio=false 时关闭） */
  audioEnabled?: boolean;
  /** 负面段开关（supportsNegativePrompt=false 时关闭） */
  negativeEnabled?: boolean;
  /** 保留用户手动覆写文本 */
  keepManualOverride?: boolean;
}

/** 编译 Asset-ID Tagged 提示词（单镜头，双语 canonical） */
export function compileAssetIdPrompt(project: ProjectV2, scene: SceneV2, shot: ShotV2, options: CompileOptions = {}): string {
  const syntax = options.syntax ?? "asset-id";
  const locale = options.locale ?? "zh";
  const registry = registryForShot(project, scene, shot);
  const sections: string[] = [];

  const sceneSection = renderSceneSection(scene, locale);
  if (sceneSection) sections.push(sceneSection);

  const countSection = renderCountSection(project, locale);
  if (countSection) sections.push(countSection);

  const assetSection = renderAssetSection(registry, syntax, locale);
  if (assetSection) sections.push(assetSection);

  const strictSection = renderStrictSection(registry, project, locale);
  if (strictSection) sections.push(strictSection);

  const techSection = renderTechnicalSection(project, locale);
  if (techSection) sections.push(techSection);

  sections.push(renderShotSection(project, scene, shot, locale, syntax));

  const audioSection = renderAudioSection(project, scene, locale, options.audioEnabled !== false);
  if (audioSection) sections.push(audioSection);

  const negativeSection = renderNegativeSection(project, locale, options.negativeEnabled !== false);
  if (negativeSection) sections.push(negativeSection);

  return sections.join("\n\n");
}
