import type { Locale } from "../i18n";

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

function renderAsset(asset: QuickPromptAsset, kind: AssetBlockKind): string {
  const mediaType = asset.mediaType ?? "image";
  const reference = asset.referenceIndex
    ? mediaType === "audio"
      ? ` [audio${asset.referenceIndex}]`
      : ` [image${asset.referenceIndex}]`
    : mediaType === "video"
      ? " [video input]"
      : "";
  const description = asset.description?.trim() ? ` — ${asset.description.trim()}` : "";
  return `@${asset.name}${reference} (${kind} ${mediaType})${description}`;
}

/** 场景站位：只输出有内容的行，避免空标题干扰模型。 */
function renderStaging(staging: QuickPromptStaging): string[] {
  const lines: string[] = [];
  if (staging.locationName) {
    const description = staging.locationDescription?.trim();
    lines.push(`LOCATION (场景站位地点): @${staging.locationName}${description ? ` — ${description}` : ""}`);
  }
  if (staging.anchorDescription?.trim()) lines.push(`SPATIAL ANCHOR (空间锚点): ${staging.anchorDescription.trim()}`);
  if (staging.characterOrderNames?.length) {
    lines.push(`CHARACTER ORDER (左到右站位): ${staging.characterOrderNames.map((name) => `@${name}`).join(", ")}`);
  }
  const spatial: string[] = [];
  if (staging.spacing?.trim()) spatial.push(`spacing: ${staging.spacing.trim()}`);
  if (staging.axisDirection) spatial.push(`axis: ${staging.axisDirection}`);
  if (spatial.length) lines.push(`SPACING / AXIS: ${spatial.join("; ")}`);
  if (staging.priorContext?.trim()) lines.push(`PRIOR CONTEXT (前情): ${staging.priorContext.trim()}`);
  return lines;
}

function renderCharacterProfiles(profiles: QuickPromptCharacterProfile[], propByName: Map<string, string>): string[] {
  const lines: string[] = [];
  for (const profile of profiles) {
    const acting = profile.actingMaster?.trim();
    const voice = profile.voiceLock?.trim();
    const props = (profile.propIds ?? [])
      .map((id) => propByName.get(id))
      .filter((name): name is string => Boolean(name));
    if (!acting && !voice && props.length === 0) continue;
    lines.push(`@${profile.name}`);
    if (acting) lines.push(`  ACTING MASTER (表演母版): ${acting}`);
    if (voice) lines.push(`  VOICE LOCK (声音锁，仅当该角色开口时逐字使用): ${voice}`);
    if (props.length) lines.push(`  ATTACHED PROPS (随身道具): ${props.map((name) => `@${name}`).join(", ")}`);
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
export function buildQuickPromptRequest(input: QuickPromptInput, locale: Locale): { system: string; user: string } {
  const outputLanguage = locale === "zh" ? "clear, cinematic Chinese" : "clear cinematic English";
  const props = input.props ?? [];
  const references = [
    ...input.sceneAssets.map((asset) => renderAsset(asset, "scene")),
    ...input.characterAssets.map((asset) => renderAsset(asset, "character")),
    ...props.map((asset) => renderAsset(asset, "prop")),
  ];
  const propByName = new Map(props.map((prop) => [prop.id, prop.name]));
  const stagingLines = input.staging ? renderStaging(input.staging) : [];
  const profileLines = renderCharacterProfiles(input.characterProfiles ?? [], propByName);

  const userBlocks: string[] = [
    "Create one final Seedance/Higgsfield video prompt from this minimal brief.",
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
  if (props.length > 0) {
    userBlocks.push(
      "",
      "PROP ASSETS (道具；只在该道具被故事梗概用到时才写进提示词):",
      props.map((prop) => renderAsset(prop, "prop")).join("\n"),
    );
  }

  userBlocks.push(
    "",
    "Use only the applicable final-prompt sections in this order: SCENE CONTEXT, ACTIVE REFERENCES, LOCATION MAP, FIRST FRAME AND SPATIAL BLOCKING, FORMAT MODE, OPTICS, CAMERA, ACTION TIMING, PHYSICS, LIGHTING, AUDIO, POSITIVE CONSTRAINTS. Do not output a standalone NEGATIVE CONSTRAINTS section unless a local failure lock is necessary.",
  );

  return {
    system: [
      "You are CINEDANCE V4, an elite AI film prompt director for Seedance 2.0 and Higgsfield Seedance, combined with the ACTING SYSTEM performance director.",
      "Turn the supplied style, story synopsis, scene assets, and character assets into one production-ready video-generation prompt. Return the final prompt only: no analysis, preface, markdown fence, QA report, or explanation.",
      `Write in ${outputLanguage}. Use direct, concrete, camera-readable and measurable language instead of abstract, poetic, or decorative prose. Keep @asset tags and [imageN]/[audioN] tokens unchanged.`,
      "Silently follow CINEDANCE's D1-D4 method: deconstruct only this current shot or sequence; diagnose reference, first-frame, spatial, optics, physics, lighting, dialogue and continuity risks; develop locks in their required priority; then deliver only the corrected final prompt. Never expose this method or its QA.",
      "Treat the final prompt as a sealed current-shot document. Remove scene numbers, script headers, prior-scene summaries, stale tags, unused people, unused props, and phrases such as previous, continues, same as before, or as above. Never invent unselected characters, assets, plot events, dialogue, or reference tags.",
      "Put spatial facts before aesthetic prose. State first-frame occupancy, screen-left/right placement, body orientation, gaze direction, landmark proximity, distance and required hand/prop states whenever the brief makes them relevant. Required subjects must be visible in the first frame; use a short positive lock and a local no-failure lock only when it prevents a specific risk.",
      "Select optics and camera only from story needs. State the camera side, framing, lens outcome, movement, trigger, stop point and response to action when relevant. Keep multi-shot continuity stable and include a cut only when the story supplies a reason. Preserve physical cause and effect, contact, weight, momentum, materials, weather and light direction; never allow floaty motion, arbitrary coverage or flat front light.",
      "Build ACTION TIMING as physically achievable chronological time blocks when a duration or sequence is supplied. Each block describes one visible event with subject position, action, camera response, critical prop state, physics and audio where relevant. Dialogue contains only supplied quoted lines: no ad-libs, narration, subtitles, captions or unrequested offscreen voices.",
      "SCENE STAGING, CHARACTER PROFILES, and PROP ASSETS are planning context, never output text. Reference them strictly by the story synopsis: bring in a roster character only when the synopsis events actually involve them; keep a character out when the synopsis never places them on screen; use a prop only when the synopsis implies it is visible, carried, or used; apply the spatial anchor, left-to-right order, spacing, and axis to the blocking you write. Reference tags and [imageN]/[audioN] tokens come only from ACTIVE REFERENCES.",
      "An ACTING MASTER is an AI-only identity and behavioural baseline for one character: use it to understand who the character is, then write that character's performance for this story moment. Never paste, quote, paraphrase line by line, or expose it as a section, and never output a CHARACTER ACTING heading.",
      "A VOICE LOCK is a per-character vocal formula. Paste it verbatim into AUDIO only for a character who actually speaks a line in the synopsis; omit it for a character who stays silent, and never invent a voice lock for a character who has none.",
      "For every active character, follow ACTING SYSTEM: write behavior under immediate pressure, never emotion labels. Give a playable objective directed at a partner, a concrete obstacle or stake, changing action-verb tactics, and two to four visible beats when scene duration supports them. Show thought before words, listening/reaction before a reply, assessment pauses, purposeful physical business, motivated changes in distance and status through the body. Preserve subtext through behavior, not explanation.",
      "Make performance observable: use gaze targets, natural micro-saccades, state-appropriate blinks and live catchlights; eyes lead the thought. Tie posture, center of gravity, breath, tempo, physical habits and speech rhythm to the scene pressure. Use stable playable states rather than vague transition chains. Ensemble reactions must travel in staggered waves, never synchronized; do not put wardrobe, camera, color or generic emotion labels inside performance instructions.",
      "Keep every @asset tag and every [imageN] or [audioN] token exactly as received. A [video input] is an upstream video reference: use it as scene context without inventing a new asset token. Reference descriptions belong in ACTIVE REFERENCES; do not contradict or rename them. Before returning, silently verify active references, first frame, spatial logic, gaze, camera side, optics, lighting, physics, timing, dialogue hygiene, continuity, prompt density and acting specificity; fix every failure before output.",
    ].join(" "),
    user: userBlocks.join("\n"),
  };
}
