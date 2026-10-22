import type { Locale } from "../i18n";
import { renderVoiceReferenceSentence } from "@/features/canvas/domain/voiceReferenceFormat";
import { assetToken } from "@/features/cinematicStudio/engine/asset-naming";

import { findQuickPromptFormat } from "./quickPromptFormats";

/** 轻量模式中被明确选中的素材；图片序号与最终提示词的 [imageN] 一一对应。 */
export interface QuickPromptAsset {
  id: string;
  name: string;
  description?: string;
  /** 图片、音频和视频都可来自工作室节点的上游素材输入口。 */
  mediaType?: "image" | "audio" | "video";
  referenceIndex?: number;
}

/**
 * 场景站位里的空间契约。节点上的选择器只存资产 id，
 * 锚点、左右站位、间距这些文字只存在于电影工程里，需要单独带进模型上下文。
 */
export interface QuickPromptStaging {
  locationId?: string;
  locationName?: string;
  /** 地点资产的描述（与活动引用同义，供模型确认「哪个 @标签 是这个场景」）。 */
  locationDescription?: string;
  /** 空间锚点：人物相对固定参照物的位置。 */
  anchorDescription?: string;
  /** 左到右的站位顺序（角色名）。 */
  characterOrderNames?: string[];
  spacing?: string;
  axisDirection?: "left-to-right" | "right-to-left";
  /** 前情（用户手写的上下文补充）。 */
  priorContext?: string;
}

/**
 * 场景角色候选里的角色语义：表演母版与声音锁。
 * 两者都是 AI-only 参考——母版用于理解角色，声音锁仅在该角色真正开口时逐字使用。
 */
export interface QuickPromptCharacterProfile {
  /** 电影资产 id，与 QuickPromptAsset.id 对齐。 */
  id: string;
  name: string;
  /** 表演母版（P2）：身份与行为基线，禁止照抄进提示词。 */
  actingMaster?: string;
  /** 声音锁（P5）：角色开口时的声线公式，逐字粘贴。 */
  voiceLock?: string;
  /** 随身 / 关联道具的资产 id。 */
  propIds?: string[];
}

export interface QuickPromptInput {
  style: string;
  synopsis: string;
  sceneAssets: QuickPromptAsset[];
  characterAssets: QuickPromptAsset[];
  /** 场景站位的空间契约（地点、锚点、左右站位、间距、轴向、前情）。 */
  staging?: QuickPromptStaging;
  /** 场景角色候选的表演母版 / 声音锁 / 随身道具绑定。 */
  characterProfiles?: QuickPromptCharacterProfile[];
  /** 道具资产（含角色随身道具），已经带好 [imageN]。 */
  props?: QuickPromptAsset[];
}

type AssetBlockKind = "scene" | "character" | "prop";

/**
 * `@` 引用名对照表。
 *
 * 轻量链路刻意用**资产名**当引用标识（`@林小雨`），不用高级工作台那种
 * `char_linxiaoyu` —— 名字对视频模型有语义，tag 只是个陌生 token。
 * 但名字直接拿来用有两个必须修的问题：
 *
 * 1. **重名**：两个角色都叫「妈妈」时 `@妈妈` 指代不明，模型会把她们当同一人、
 *    甚至对上同一张参考图。后来者加 `-2` 后缀区分。
 * 2. **空格与标点**：`@林 小雨` 会被拆成两个 token（`@` 引用就断了）。
 *    统一走 `assetToken` 规整（空格转连字符、去标点），与资产引用名同一套字符规则。
 *
 * 🔴 后缀用 `-2` 而不是 ` #2`：`#` 后面跟空格会把引用重新拆开。
 * 🔴 **整篇必须共用一份对照表** —— 各段各生成一次的话，同一个角色在
 *    ACTIVE REFERENCES 里叫 `@林小雨`、在站位里叫 `@林小雨-2`，模型就当成两个人了。
 */
interface QuickAssetRefNames {
  byId: Map<string, string>;
  byOriginalName: Map<string, string>;
}

function buildQuickAssetRefNames(assets: QuickPromptAsset[]): QuickAssetRefNames {
  const byId = new Map<string, string>();
  const byOriginalName = new Map<string, string>();
  const usedCounts = new Map<string, number>();

  for (const asset of assets) {
    // 同一资产会在多个块里重复出现（场景 / 角色 / 道具），只分配一次。
    if (byId.has(asset.id)) continue;

    const original = (asset.name ?? "").trim();
    const base = assetToken(original, "") || assetToken(asset.id, asset.id);
    const count = (usedCounts.get(base) ?? 0) + 1;
    usedCounts.set(base, count);
    const refName = count === 1 ? base : `${base}-${count}`;

    byId.set(asset.id, refName);
    // 站位 / 角色表演母版只有名字没有 id，靠原名反查同一份结果。
    if (original && !byOriginalName.has(original)) byOriginalName.set(original, refName);
  }

  return { byId, byOriginalName };
}

/** 资产（有 id）的引用名。 */
function refNameOfAsset(refs: QuickAssetRefNames, asset: QuickPromptAsset): string {
  return refs.byId.get(asset.id) ?? (assetToken(asset.name ?? "", "") || asset.id);
}

/** 只有名字的地方（站位地点、角色顺序、表演母版）：查不到就按同一套规则规整。 */
function refNameOfText(refs: QuickAssetRefNames, name: string): string {
  const trimmed = (name ?? "").trim();
  const hit = refs.byOriginalName.get(trimmed);
  if (hit) return hit;
  return assetToken(trimmed, "") || trimmed;
}

function renderAsset(
  asset: QuickPromptAsset,
  kind: AssetBlockKind,
  refs: QuickAssetRefNames,
): string {
  const mediaType = asset.mediaType ?? "image";
  const reference = asset.referenceIndex
    ? mediaType === "audio"
      ? ` [audio${asset.referenceIndex}]`
      : ` [image${asset.referenceIndex}]`
    : mediaType === "video"
      ? " [video input]"
      : "";
  const description = asset.description?.trim() ? ` — ${asset.description.trim()}` : "";
  return `@${refNameOfAsset(refs, asset)}${reference} (${kind} ${mediaType})${description}`;
}

/**
 * 角色声线的引用行：直接给出**成品里要出现的那句话**，让模型照抄，而不是给一个
 * `@角色声音 [audio1]` 这样的原始标记 —— 成品提示词统一使用
 * 「使用 @音频N 作为 @角色 的唯一人声参考。」这种可读的绑定句（`@音频N` 也是
 * 画布视频节点「引用」按钮插入的规范标记）。
 *
 * 音频序号缺失（素材没有可上传的源文件）时给不出标记，退化成只有角色名的说明。
 */
function renderCharacterVoiceReference(
  asset: QuickPromptAsset,
  locale: Locale,
  refs: QuickAssetRefNames,
): string {
  const description = asset.description?.trim() ? ` — ${asset.description.trim()}` : "";
  const referenceName = refNameOfAsset(refs, asset);
  const audioIndex = asset.referenceIndex;
  if (!audioIndex) return `@${referenceName} (character audio)${description}`;
  const sentence = renderVoiceReferenceSentence(
    { audioIndex, characterName: referenceName },
    locale === "zh" ? "zh" : "en",
  );
  return `${sentence}${description}`;
}

/** 场景站位：只输出有内容的行，避免空标题干扰模型。 */
function renderStaging(staging: QuickPromptStaging, refs: QuickAssetRefNames): string[] {
  const lines: string[] = [];
  if (staging.locationName) {
    const description = staging.locationDescription?.trim();
    lines.push(
      `LOCATION (场景站位地点): @${refNameOfText(refs, staging.locationName)}${description ? ` — ${description}` : ""}`,
    );
  }
  if (staging.anchorDescription?.trim()) lines.push(`SPATIAL ANCHOR (空间锚点): ${staging.anchorDescription.trim()}`);
  if (staging.characterOrderNames?.length) {
    lines.push(
      `CHARACTER ORDER (左到右站位): ${staging.characterOrderNames.map((name) => `@${refNameOfText(refs, name)}`).join(", ")}`,
    );
  }
  const spatial: string[] = [];
  if (staging.spacing?.trim()) spatial.push(`spacing: ${staging.spacing.trim()}`);
  if (staging.axisDirection) spatial.push(`axis: ${staging.axisDirection}`);
  if (spatial.length) lines.push(`SPACING / AXIS: ${spatial.join("; ")}`);
  if (staging.priorContext?.trim()) lines.push(`PRIOR CONTEXT (前情): ${staging.priorContext.trim()}`);
  return lines;
}

function renderCharacterProfiles(
  profiles: QuickPromptCharacterProfile[],
  propByName: Map<string, string>,
  refs: QuickAssetRefNames,
): string[] {
  const lines: string[] = [];
  for (const profile of profiles) {
    const acting = profile.actingMaster?.trim();
    const voice = profile.voiceLock?.trim();
    const props = (profile.propIds ?? [])
      .map((id) => propByName.get(id))
      .filter((name): name is string => Boolean(name));
    if (!acting && !voice && props.length === 0) continue;
    lines.push(`@${refNameOfText(refs, profile.name)}`);
    if (acting) lines.push(`  ACTING MASTER (表演母版): ${acting}`);
    if (voice) lines.push(`  VOICE LOCK (声音锁，仅当该角色开口时逐字使用): ${voice}`);
    if (props.length) {
      lines.push(
        `  ATTACHED PROPS (随身道具): ${props.map((name) => `@${refNameOfText(refs, name)}`).join(", ")}`,
      );
    }
  }
  return lines;
}

/**
 * 极简节点的独立提示词 Agent。
 *
 * 这里刻意不复用高级模式的工程/分镜编译链路：轻量模式只把用户在节点上
 * 明确填写或选择的风格、故事、场景和角色送入模型，避免隐式读取旧工程内容。
 * 规则内置自 CINEDANCE V4 与 ACTING SYSTEM：轻量模式沿用其最终成片提示词、
 * 镜头控制与表演执行规范，不依赖外部 Skill 文件在运行时存在。
 */
export function buildQuickPromptRequest(
  input: QuickPromptInput,
  locale: Locale,
  formatId?: string | null,
): { system: string; user: string } {
  // 格式决定 system 规则与 user 首行。查不到就回落默认（Seedance）——
  // 老节点没有该字段、或某个格式以后被删掉，都不该让生成中断。
  const format = findQuickPromptFormat(formatId);
  const outputLanguage = locale === "zh" ? "clear, cinematic Chinese" : "clear cinematic English";
  const props = input.props ?? [];
  const allReferenceAssets = [
    ...input.sceneAssets.map((asset) => ({ asset, kind: "scene" as const })),
    ...input.characterAssets.map((asset) => ({ asset, kind: "character" as const })),
    ...props.map((asset) => ({ asset, kind: "prop" as const })),
  ];
  // 引用名对照表：整篇共用一份（重名加后缀、空格标点规整），否则同一个角色
  // 在不同段落里名字不同，模型会当成两个人。
  const refs = buildQuickAssetRefNames(allReferenceAssets.map(({ asset }) => asset));
  // ACTIVE REFERENCES is the visual-reference block. Audio references are voice locks:
  // keeping them separate prevents the video model from treating a voice clip as an image.
  const references = allReferenceAssets
    .filter(({ asset }) => asset.mediaType !== "audio")
    .map(({ asset, kind }) => renderAsset(asset, kind, refs));
  // 角色声线走绑定句（成品里要出现的那句话）；场景 / 道具音频（环境音、音效）保持
  // 原来的标记写法 —— 它们不是任何人的声线，不该被写成「唯一人声参考」。
  const voiceReferences = allReferenceAssets
    .filter(({ asset }) => asset.mediaType === "audio")
    .map(({ asset, kind }) => (kind === "character"
      ? renderCharacterVoiceReference(asset, locale, refs)
      : renderAsset(asset, kind, refs)));
  const visualProps = props.filter((asset) => asset.mediaType !== "audio");
  const propByName = new Map(props.map((prop) => [prop.id, prop.name]));
  const stagingLines = input.staging ? renderStaging(input.staging, refs) : [];
  const profileLines = renderCharacterProfiles(input.characterProfiles ?? [], propByName, refs);

  const userBlocks: string[] = [
    format.userLead,
    "",
    "STYLE:",
    input.style.trim(),
    "",
    "STORY SYNOPSIS:",
    input.synopsis.trim(),
    "",
    "ACTIVE REFERENCES:",
    references.length > 0 ? references.join("\n") : "(No visual reference selected; do not invent one.)",
  ];

  if (voiceReferences.length > 0) {
    userBlocks.push(
      "",
      "VOICE LOCK REFERENCES (声音锁参考；音频引用只能放在 AUDIO 中):",
      voiceReferences.join("\n"),
    );
  }

  if (stagingLines.length > 0) {
    userBlocks.push("", "SCENE STAGING (场景站位，空间契约；不是输出段落):", stagingLines.join("\n"));
  }
  if (profileLines.length > 0) {
    userBlocks.push(
      "",
      "CHARACTER PROFILES (场景角色候选的表演母版 / 声音锁；AI 参考，禁止原样输出):",
      profileLines.join("\n"),
    );
  }
  if (visualProps.length > 0) {
    userBlocks.push(
      "",
      "PROP ASSETS (道具；只在该道具被故事梗概用到时才写进提示词):",
      visualProps.map((prop) => renderAsset(prop, "prop", refs)).join("\n"),
    );
  }

  // 末尾这段只讲「成品输出哪些段落」。Seedance 是一串大写标题、H3 是下划线小写字段，
  // 段落清单必须跟格式走，否则换格式后模型会被这句固定清单拽回 Seedance 结构。
  userBlocks.push("", format.userTail);

  return {
    system: format.buildSystem({ outputLanguage, locale }),
    user: userBlocks.join("\n"),
  };
}
