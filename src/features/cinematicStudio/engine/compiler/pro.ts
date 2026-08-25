/**
 * Pro Sequence 模板编译器（P2.1，P0.2 双语）
 * 适用：长视频、多镜叙事、人工审查。
 * 结构：技术 → 场景 → 数量锁 → 资产（全场景）→ 强锁 → 全部镜头 → 连续性摘要 → 音频 → 负面段。
 */
import type { ProjectV2, SceneV2 } from "../../shared-types";
import { checkContinuityV2 } from "../continuity";
import type { PromptLocale } from "../i18n/lexicon";
import { promptLexicon } from "../i18n/lexicon";
import {
  renderAssetSection, renderAudioSection, renderCountSection, renderNegativeSection,
  renderSceneSection, renderShotSection, renderStrictSection, renderTechnicalSection,
  unifiedCameraForScene,
  type ReferenceSyntax,
} from "./sections";
import { buildSceneAssetRegistry } from "./renderer";
import { compileDirectorSequence } from "./director";

export interface ProSequenceOptions {
  syntax?: ReferenceSyntax;
  locale?: PromptLocale;
  audioEnabled?: boolean;
  negativeEnabled?: boolean;
  /** 连续性摘要开关（pro-sequence 人工审查用途） */
  includeContinuity?: boolean;
  /**
   * 导演级分段模式（CINEDANCE V4）。
   * 默认 false = 保留现有「技术→场景→数量锁→资产→强锁→镜头→音频→负面」顺序；
   * true = 按 SCENE CONTEXT → … → POSITIVE CONSTRAINTS 重组（P0.1 起实现）。
   */
  director?: boolean;
}

/** 编译 Pro Sequence（全场景多镜头，双语 canonical） */
export function compileProSequence(project: ProjectV2, scene: SceneV2, options: ProSequenceOptions = {}): string {
  const syntax = options.syntax ?? "asset-id";
  const locale = options.locale ?? "zh";
  if (options.director === true) {
    return compileDirectorSequence(project, scene, {
      syntax,
      locale,
      audioEnabled: options.audioEnabled,
    });
  }
  const registry = buildSceneAssetRegistry(project, scene);
  const sections: string[] = [];

  const techSection = renderTechnicalSection(project, locale);
  if (techSection) sections.push(techSection);

  const sceneSection = renderSceneSection(scene, locale);
  if (sceneSection) sections.push(sceneSection);

  const countSection = renderCountSection(project, locale);
  if (countSection) sections.push(countSection);

  const assetSection = renderAssetSection(registry, syntax, locale);
  if (assetSection) sections.push(assetSection);

  const strictSection = renderStrictSection(registry, project, locale);
  if (strictSection) sections.push(strictSection);

  // 长镜头模式：全镜统一第一镜相机参数（多镜头保留各镜机位）
  const cameraOverride = unifiedCameraForScene(scene);
  sections.push(scene.shots.map((shot) => renderShotSection(project, scene, shot, locale, syntax, cameraOverride)).join("\n\n"));

  // 诊断元数据默认不进提示词正文（留在左侧连续性面板与版本历史），
  // 需要显式 includeContinuity=true 才拼入。
  if (options.includeContinuity === true) {
    const issues = checkContinuityV2(project, scene);
    const errorCount = issues.filter((i) => i.severity === "error").length;
    const warningCount = issues.filter((i) => i.severity === "warning").length;
    const heading = promptLexicon(locale).headings.continuity;
    sections.push(locale === "zh"
      ? `${heading}：共 ${issues.length} 个问题（${errorCount} 个错误，${warningCount} 个警告）。最终导出前请解决错误级问题。`
      : `${heading}: ${issues.length} issues total (${errorCount} errors, ${warningCount} warnings). Resolve error-level issues before final export.`);
  }

  const audioSection = renderAudioSection(project, scene, locale, options.audioEnabled !== false);
  if (audioSection) sections.push(audioSection);

  const negativeSection = renderNegativeSection(project, locale, options.negativeEnabled !== false);
  if (negativeSection) sections.push(negativeSection);

  return sections.join("\n\n");
}
