/**
 * 模型 Profile（P2.1）
 * 不是营销下拉框：决定图片引用语法、是否拆镜、提示词最大长度、
 * 音频/负面字段是否输出与最终导出策略。
 */
import type { ModelProfile, ProjectV2, SceneV2, ShotV2 } from "../../shared-types";
import type { PromptLocale } from "../i18n/lexicon";
import { compileAssetIdPrompt, type CompileOptions } from "./asset-id";
import { compileDirectorSequence } from "./director";
import { compileProSequence, type ProSequenceOptions } from "./pro";
import { compileShotCards, type ShotCardsOptions } from "./shot-cards";

export const MODEL_PROFILES: ModelProfile[] = [
  {
    id: "generic-asset-id", name: "通用 · Asset-ID 引用",
    imageReferenceSyntax: "asset-id", maxReferences: 8, preferredTemplate: "asset-id-tagged",
    supportsNegativePrompt: true, supportsAudio: true, supportsMultiShot: true,
  },
  {
    id: "sora", name: "OpenAI Sora",
    imageReferenceSyntax: "at-mention", maxReferences: 5, preferredTemplate: "pro-sequence",
    supportsNegativePrompt: false, supportsAudio: false, supportsMultiShot: true,
  },
  {
    id: "veo3", name: "Google Veo 3",
    imageReferenceSyntax: "asset-id", maxReferences: 6, preferredTemplate: "shot-cards",
    supportsNegativePrompt: true, supportsAudio: true, supportsMultiShot: false,
  },
  {
    id: "kling", name: "可灵 Kling",
    imageReferenceSyntax: "plain-text", maxReferences: 4, preferredTemplate: "shot-cards",
    supportsNegativePrompt: true, supportsAudio: true, supportsMultiShot: false,
  },
  {
    id: "seedance", name: "字节 Seedance（@资产引用）",
    imageReferenceSyntax: "at-mention", maxReferences: 5, preferredTemplate: "shot-cards",
    supportsNegativePrompt: true, supportsAudio: true, supportsMultiShot: false,
  },
];

export function modelProfileById(id?: string): ModelProfile | undefined {
  return MODEL_PROFILES.find((profile) => profile.id === id);
}

export type TemplateId = "pro-sequence" | "shot-cards" | "asset-id-tagged";

export interface CompileRequest {
  template: TemplateId;
  /** 目标模型 Profile：决定语法与字段开关；缺失时用模板默认 */
  profile?: ModelProfile;
  /** 输出语言（P0.2，默认 zh 产品默认） */
  locale?: PromptLocale;
  /** 导演级分段模式（P0.5）：pro-sequence 时按 CINEDANCE 顺序重组（默认关，保留老顺序） */
  director?: boolean;
}

/** 编译结果：输出文本 + 策略提示（拆镜建议等） */
export interface CompileResult {
  text: string;
  /** 模型策略提示：如 不支持多镜 → 已自动拆为 shot-cards */
  strategyNotes: string[];
}

/**
 * 统一编译入口（P2.1）
 * template + profile 共同决定输出；profile 缺省时使用模板默认行为。
 */
export function compilePrompt(project: ProjectV2, scene: SceneV2, shot: ShotV2, request: CompileRequest): CompileResult {
  const profile = request.profile;
  const notes: string[] = [];
  // P0.2：locale 缺省默认 zh（产品默认语言）
  const locale = request.locale ?? "zh";

  // 模型 Profile 决策：引用语法 + 字段开关（默认 @ 资产引用，符合 Seedance 等平台习惯）
  const syntax = profile?.imageReferenceSyntax ?? "at-mention";
  const audioEnabled = profile ? profile.supportsAudio : true;
  const negativeEnabled = profile ? profile.supportsNegativePrompt : true;

  // Final delivery has one canonical format. Target-model profiles still control
  // reference syntax and audio capability, but must not downgrade final output to
  // a legacy shot-card/technical-brief template that exposes AI reference inputs.
  if (request.director === true) {
    return {
      text: compileDirectorSequence(project, scene, { syntax, locale, audioEnabled }),
      strategyNotes: notes,
    };
  }

  // 多镜头不支持：pro-sequence 自动降级 shot-cards
  let template = request.template;
  if (template === "pro-sequence" && profile && !profile.supportsMultiShot && scene.shots.length > 1) {
    template = "shot-cards";
    notes.push(locale === "zh"
      ? "该模型不支持多镜头提示词，已自动切换为分镜卡（一镜一卡）。"
      : "This model does not support multi-shot prompts; switched to shot cards (one card per shot).");
  }
  // 引用数超限：提示逐镜（shot-cards 天然拆分）
  const registryCount = (project.assets ?? []).length;
  if (profile && registryCount > profile.maxReferences && template !== "shot-cards") {
    notes.push(locale === "zh"
      ? `资产引用（${registryCount}）超过模型上限（${profile.maxReferences}），建议使用分镜卡逐镜生成。`
      : `Asset references (${registryCount}) exceed the model limit (${profile.maxReferences}); shot cards are recommended.`);
  }

  let text = "";
  if (template === "pro-sequence") {
    text = compileProSequence(project, scene, { syntax, locale, audioEnabled, negativeEnabled, director: request.director } as ProSequenceOptions);
  } else if (template === "shot-cards") {
    text = compileShotCards(project, scene, { syntax, locale, audioEnabled, negativeEnabled } as ShotCardsOptions);
  } else {
    text = compileAssetIdPrompt(project, scene, shot, { syntax, locale, audioEnabled, negativeEnabled } as CompileOptions);
  }
  return { text, strategyNotes: notes };
}
