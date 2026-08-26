/**
 * V2 导演文档校验器（纯函数 + 可单测）。
 * 输入 directorLayers + project + scene，输出结构化的 error / warning 列表；
 * 不产生副作用、不写回、不读取 AI 设置。供 compileDirectorSequence（V2.2）与
 * normalizeSceneDraft 写回前（V2.4）共用，UI 侧可直接展示 issue.detailZh。
 *
 * 规则对照：
 * - DIRECTOR.MULTI_SHOT_TIMELINE     V2-P0-1：多镜头声明 + 单一连续时间轴
 * - DIRECTOR.UNREFERENCED_ASSET      V2-P0-2：正文提到未被本场景引用的资产
 * - DIRECTOR.META_STATEMENT          V2-P0-2：启用/未启用/未使用等项目管理语句
 * - DIRECTOR.DIAGNOSTIC_META         V2-P1-3：连续性/QA 诊断摘要
 * - DIRECTOR.NO_NEW_PROPS_CONFLICT   V2-P0-3：首帧禁新道具与具体道具并存
 * - DIRECTOR.OPTICS_WIDE_COMPRESSION V2-P1-1：广角 + 压缩感
 * - DIRECTOR.OPTICS_TELE_STRETCH     V2-P1-1：长焦 + 拉伸/近大远小
 * - DIRECTOR.IDENTITY_ANCHOR_DUP     V2-P1-2：身份完整描述在多层重复
 */
import type { ProjectV2, SceneV2 } from "../../shared-types";
import { buildSceneAssetRegistry } from "../compiler/renderer";
import {
  DIAGNOSTIC_EN_RES, DIAGNOSTIC_ZH_RES, DIRECTOR_LAYER_KEYS, EN_IDENT_WORDS, FORBID_NEW_PROPS_RE,
  LAYER_ZH_LABELS, META_EN_RES, META_ZH_RES, OPTIC_COMPRESSION_RE, OPTIC_CONFLICT_SUGGESTION,
  OPTIC_DEGREE_RE, OPTIC_FOV_KNOWN, OPTIC_STRETCH_RE, OPTIC_TELE_WORD_RE, OPTIC_WIDE_WORD_RE,
  ZH_IDENT_WORDS,
} from "./lexicon";

export interface DirectorLayerIssue {
  code: string;
  severity: "error" | "warning";
  layerKey?: string;
  line?: number;
  label: string;
  detail: string;
  detailZh: string;
  suggestion?: string;
  suggestionZh?: string;
}

interface LineRef {
  key: string;
  line: number;
  text: string;
}

/** 逐层逐行展开（空层跳过） */
function linesOf(layers: Record<string, string>): LineRef[] {
  const out: LineRef[] = [];
  for (const key of DIRECTOR_LAYER_KEYS) {
    const text = (layers[key] ?? "").trim();
    if (!text) continue;
    text.split("\n").forEach((raw, index) => out.push({ key, line: index + 1, text: raw.trim() }));
  }
  return out;
}

function hasShotBlocks(...texts: string[]): boolean {
  return /(?:镜头|镜|SHOT|Shot)\s*\d/.test(texts.join("\n"));
}

/** 行内是否出现更长的资产名（用于避免「警官」命中「林警官」这类子串误报） */
function hasLongerAssetPresent(project: ProjectV2, name: string, text: string): boolean {
  return (project.assets ?? []).some((other) => other.name.length > name.length && text.includes(other.name));
}

/** 拉丁词按词边界匹配，中文按包含匹配 */
function containsWord(text: string, word: string): boolean {
  if (/^[\x00-\x7F]+$/.test(word)) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(text);
  }
  return text.includes(word);
}

/** 身份关键词命中数（一个词算一次，拉丁词带边界防 chair 命中 hair） */
function identityMarkerCount(text: string): number {
  let count = 0;
  for (const word of ZH_IDENT_WORDS) if (text.includes(word)) count += 1;
  for (const word of EN_IDENT_WORDS) if (containsWord(text, word)) count += 1;
  return count;
}

/** V2-P0-1：声明多镜头却只有一条连续时间轴（无镜头分块） */
function checkMultiShotBlocks(layers: Record<string, string>, scene: SceneV2): DirectorLayerIssue[] {
  const declaredMulti =
    scene.shootingMode === "multi-shot" ||
    /(?:CONTROLLED MULTI[- ]SHOT|多镜头|多镜序列)/i.test(layers.formatMode ?? "");
  if (!declaredMulti) return [];
  const action = (layers.actionTiming ?? "").trim();
  if (!action) return [];
  const timeline = /:\d{2}|0:00/.test(action) || /\d{1,3}\s*[-–~]\s*\d{1,3}\s*(?:秒|s\b)/i.test(action);
  if (!timeline || hasShotBlocks(action, layers.camera ?? "")) return [];
  return [{
    code: "DIRECTOR.MULTI_SHOT_TIMELINE",
    severity: "error",
    layerKey: "actionTiming",
    label: "Multi-shot declared but timeline is continuous",
    detail: "FORMAT MODE declares a controlled multi-shot sequence, but ACTION TIMING is one continuous timeline without shot blocks.",
    detailZh: "格式模式声明多镜头序列，但动作时序是一条没有镜头分块的连续时间轴；每镜必须带镜头号与起止时间。",
    suggestion: "Chunk ACTION TIMING per shot (SHOT 1 · 0:00–0:05 …) or switch FORMAT MODE to SINGLE CONTINUOUS TAKE.",
    suggestionZh: "把动作时序按镜头分块（镜头1 · 0:00–0:05 …），或把格式模式改为「单镜头连续」后重编译。",
  }];
}

/** V2-P3-7：检查器字段缺失时给出 warning，编译器仍会用结构化字段补齐最终提示词。 */
function checkInspectorCoverage(project: ProjectV2, scene: SceneV2): DirectorLayerIssue[] {
  const assets = new Map((project.assets ?? []).map((asset) => [asset.id, asset]));
  const out: DirectorLayerIssue[] = [];
  for (const shot of scene.shots ?? []) {
    const missing: string[] = [];
    if ((shot.beats ?? []).length === 0) missing.push("beats / 节拍");

    const hasParticipantPosition = (shot.participants ?? []).some((participant) => participant.position?.trim());
    const hasShotLayout = Boolean(
      shot.layout?.anchorDescription?.trim() ||
      (shot.layout?.characterOrder ?? []).length > 0,
    );
    const hasSceneLayout = Boolean(
      scene.staging?.anchorDescription?.trim() ||
      (scene.staging?.characterOrder ?? []).length > 0,
    );
    if (!hasParticipantPosition && !hasShotLayout && !hasSceneLayout) missing.push("staging / 站位");
    if (!shot.acting?.trim()) missing.push("acting / 表演");

    const speakers = new Set(
      (shot.beats ?? [])
        .filter((beat) => beat.dialogue?.trim() && beat.actorId)
        .map((beat) => beat.actorId as string),
    );
    const missingVoices = [...speakers].filter((id) => {
      const profile = assets.get(id)?.actingProfile;
      return !profile?.voicePrompt?.trim() && !profile?.voicePromptZh?.trim();
    });
    if (missingVoices.length > 0) {
      missing.push(`voice lock / 声音锁（${missingVoices.map((id) => assets.get(id)?.name ?? id).join(", ")}）`);
    }

    if (missing.length > 0) {
      out.push({
        code: "DIRECTOR.INSPECTOR_COVERAGE",
        severity: "warning",
        layerKey: "actionTiming",
        label: "Structured shot inspector fields are incomplete",
        detail: `Shot ${shot.label} is missing ${missing.join(", ")}. The compiler will append the available structured fields, but the shot should be completed before export.`,
        detailZh: `镜头「${shot.label}」缺少：${missing.join("、")}。编译器会追加已有结构化字段，但导出前应补全该镜头。`,
        suggestion: "Fill the missing inspector fields; the structured shot appendix remains authoritative over conflicting prose.",
        suggestionZh: "补全检查器字段；若与前文导演描述冲突，以最终提示词中的结构化镜头附录为准。",
      });
    }
  }
  return out;
}

/** V2-P0-2：正文提到未被本场景引用的资产 */
function checkUnreferencedAssets(
  layers: Record<string, string>, project: ProjectV2, scene: SceneV2,
): DirectorLayerIssue[] {
  const registry = buildSceneAssetRegistry(project, scene, "scene");
  const referenced = new Set(registry.orderedAssets.map((asset) => asset.id));
  const candidates = (project.assets ?? []).filter(
    (asset) => !referenced.has(asset.id) && asset.name.trim().length >= 2,
  );
  const out: DirectorLayerIssue[] = [];
  const seen = new Set<string>();
  for (const ref of linesOf(layers)) {
    for (const asset of candidates) {
      const name = asset.name.trim();
      if (seen.has(`${ref.key}:${name}`) || !ref.text.includes(name)) continue;
      if (hasLongerAssetPresent(project, name, ref.text)) continue;
      seen.add(`${ref.key}:${name}`);
      out.push({
        code: "DIRECTOR.UNREFERENCED_ASSET",
        severity: "error",
        layerKey: ref.key,
        line: ref.line,
        label: "Unreferenced asset mentioned in a prompt layer",
        detail: `Line mentions "${name}", which is not referenced by any shot of this scene.`,
        detailZh: `本层提到「${name}」，但该资产未被本场景任何镜头引用；模型可能把它画出来。`,
        suggestion: "Remove the name, or reference the asset in scene staging / shot participants / prop states.",
        suggestionZh: "删除该名字；如需它入镜，请先在场景站位、镜头参与者或道具状态中正式引用。",
      });
    }
  }
  return out;
}

/** V2-P0-2 / V2-P1-3：项目管理语句与诊断摘要禁止进入提示词层 */
function checkMetadataStatements(layers: Record<string, string>): DirectorLayerIssue[] {
  const out: DirectorLayerIssue[] = [];
  for (const ref of linesOf(layers)) {
    const meta = META_ZH_RES.some((re) => re.test(ref.text)) || META_EN_RES.some((re) => re.test(ref.text));
    if (meta) {
      out.push({
        code: "DIRECTOR.META_STATEMENT",
        severity: "error",
        layerKey: ref.key,
        line: ref.line,
        label: "Project metadata leaked into prompt",
        detail: "Enabled/disabled/unused/project-only statements are project management data and must never appear in a prompt layer.",
        detailZh: "「启用 / 未启用 / 未使用 / 仅用于项目」属项目管理信息，禁止出现在提示词层。",
        suggestion: "Remove the sentence; assets are loaded implicitly via ACTIVE REFERENCES only.",
        suggestionZh: "删除该句：资产只通过活动引用层隐式加载。",
      });
    }
    const diagnostic = DIAGNOSTIC_ZH_RES.some((re) => re.test(ref.text)) ||
      DIAGNOSTIC_EN_RES.some((re) => re.test(ref.text));
    if (diagnostic) {
      out.push({
        code: "DIRECTOR.DIAGNOSTIC_META",
        severity: "error",
        layerKey: ref.key,
        line: ref.line,
        label: "Diagnostic summary leaked into prompt",
        detail: "Continuity/QA conclusions are panel-only metadata and must not be exported.",
        detailZh: "连续性 / 质量结论只属于左侧检查面板，不能导出进提示词。",
        suggestion: "Remove the summary from the exported text.",
        suggestionZh: "把这段摘要从导出文本中移除。",
      });
    }
  }
  return out;
}

/** V2-P0-3：首帧「禁止新道具」与位置图/首帧具体道具并存 */
function checkFirstFramePropsConflict(
  layers: Record<string, string>, project: ProjectV2, scene: SceneV2,
): DirectorLayerIssue[] {
  const forbidding = [layers.firstFrame ?? "", layers.negativeLocks ?? ""].filter(Boolean).join("\n");
  if (!FORBID_NEW_PROPS_RE.test(forbidding)) return [];
  const registry = buildSceneAssetRegistry(project, scene, "scene");
  const props = registry.orderedAssets.filter((asset) => asset.kind === "prop" && asset.name.trim().length >= 2);
  const probe = [layers.locationMap ?? "", layers.firstFrame ?? ""].filter(Boolean).join("\n");
  const out: DirectorLayerIssue[] = [];
  const seen = new Set<string>();
  for (const prop of props) {
    const name = prop.name.trim();
    if (seen.has(name) || !probe.includes(name)) continue;
    if (hasLongerAssetPresent(project, name, probe)) continue;
    seen.add(name);
    const layerKey = (layers.locationMap ?? "").includes(name) ? "locationMap" : "firstFrame";
    out.push({
      code: "DIRECTOR.NO_NEW_PROPS_CONFLICT",
      severity: "warning",
      layerKey,
      label: "First-frame prop ban conflicts with concrete props",
      detail: `FIRST FRAME bans new props, but a concrete prop ("${name}") is listed in ${layerKey}.`,
      detailZh: `首帧锁定「不得加入新道具」，但「${LAYER_ZH_LABELS[layerKey] ?? layerKey}」层列出了具体道具「${name}」，指令自相矛盾。`,
      suggestion: "Reword to \"no characters or props not already specified in this scene\".",
      suggestionZh: "改成「不加入本场景未指定的角色或道具」。",
    });
  }
  return out;
}

/** 数字 / 词汇两种方式判断文本的 FOV 倾向 */
function fovFlags(text: string): { wide: boolean; tele: boolean } {
  const flags = { wide: false, tele: false };
  let match: RegExpExecArray | null;
  OPTIC_DEGREE_RE.lastIndex = 0;
  while ((match = OPTIC_DEGREE_RE.exec(text)) !== null) {
    const degrees = Number(match[1]);
    if (degrees >= OPTIC_FOV_KNOWN.wideMin) flags.wide = true;
    if (degrees <= OPTIC_FOV_KNOWN.teleMax) flags.tele = true;
  }
  if (OPTIC_WIDE_WORD_RE.test(text)) flags.wide = true;
  if (OPTIC_TELE_WORD_RE.test(text)) flags.tele = true;
  return flags;
}

/** V2-P1-1：广角 + 压缩感 / 长焦 + 拉伸 */
function checkOpticsConflict(layers: Record<string, string>): DirectorLayerIssue[] {
  const out: DirectorLayerIssue[] = [];
  for (const ref of linesOf(layers)) {
    const { wide, tele } = fovFlags(ref.text);
    if (wide && OPTIC_COMPRESSION_RE.test(ref.text)) {
      out.push({
        code: "DIRECTOR.OPTICS_WIDE_COMPRESSION",
        severity: "error",
        layerKey: ref.key,
        line: ref.line,
        label: "Optics term conflict: wide FOV + compression",
        detail: "Wide FOV (>=84°) cannot be combined with compression wording; the model cannot decide which optical outcome to render.",
        detailZh: "广角（≥84°）与「压缩感 / compression」互斥，模型无法判断到底要哪种光学结果。",
        suggestion: OPTIC_CONFLICT_SUGGESTION.wideWithCompression.en,
        suggestionZh: OPTIC_CONFLICT_SUGGESTION.wideWithCompression.zh,
      });
    }
    if (tele && OPTIC_STRETCH_RE.test(ref.text)) {
      out.push({
        code: "DIRECTOR.OPTICS_TELE_STRETCH",
        severity: "error",
        layerKey: ref.key,
        line: ref.line,
        label: "Optics term conflict: telephoto + stretch",
        detail: "Telephoto (<=29°) compresses space; it cannot be written as stretching / near-large-far-small perspective.",
        detailZh: "长焦（≤29°）是压缩空间，不能与「拉伸 / 近大远小」并写。",
        suggestion: OPTIC_CONFLICT_SUGGESTION.teleWithStretch.en,
        suggestionZh: OPTIC_CONFLICT_SUGGESTION.teleWithStretch.zh,
      });
    }
  }
  return out;
}

/** V2-P1-2：身份完整描述在多层重复 */
function checkIdentityAnchorDuplication(
  layers: Record<string, string>, project: ProjectV2, scene: SceneV2,
): DirectorLayerIssue[] {
  const registry = buildSceneAssetRegistry(project, scene, "scene");
  const ruleIds = new Set((project.identityRules ?? []).map((rule) => rule.characterId));
  const strictCharacters = registry.orderedAssets.filter(
    (asset) => asset.kind === "character" && (asset.lockLevel === "strict" || ruleIds.has(asset.id)),
  );
  const out: DirectorLayerIssue[] = [];
  for (const asset of strictCharacters) {
    const name = asset.name.trim();
    const hits: LineRef[] = [];
    for (const ref of linesOf(layers)) {
      if (!ref.text.includes(name)) continue;
      if (identityMarkerCount(ref.text) < 1) continue;
      hits.push(ref);
    }
    if (hits.length === 0) continue;
    const nonAllowed = hits.filter((hit) => hit.key !== "activeReferences" && hit.key !== "positiveConstraints");
    // 完整描述允许同时出现在「活动引用」与「正向约束」；只有当其他层也出现时才告警。
    if (nonAllowed.length === 0) continue;
    const keys = Array.from(new Set(hits.map((hit) => hit.key)));
    out.push({
      code: "DIRECTOR.IDENTITY_ANCHOR_DUP",
      severity: "warning",
      layerKey: nonAllowed[0]?.key ?? hits[0].key,
      line: nonAllowed[0]?.line ?? hits[0].line,
      label: "Identity anchor duplicated across layers",
      detail: `Full identity description of "${name}" appears in ${keys.length} layer(s): ${keys.join(", ")}. Keep it in ACTIVE REFERENCES / POSITIVE CONSTRAINTS only; use @${name} elsewhere.`,
      detailZh: `「${name}」的身份描述出现在 ${keys.length} 个层（${keys.map((key) => LAYER_ZH_LABELS[key] ?? key).join("、")}）；完整描述只保留在活动引用与正向约束，其余层改用 @${name}。`,
      suggestion: `Replace occurrences outside reference/positive layers with @${name}.`,
      suggestionZh: `把活动引用与正向约束之外的重复描述统一替换为 @${name}。`,
    });
  }
  return out;
}

/** 主入口：返回全部 error/warning（按层序稳定排序） */
export function validateDirectorLayers(
  layers: Record<string, string>, project: ProjectV2, scene: SceneV2,
): DirectorLayerIssue[] {
  return [
    ...checkMultiShotBlocks(layers, scene),
    ...checkInspectorCoverage(project, scene),
    ...checkUnreferencedAssets(layers, project, scene),
    ...checkMetadataStatements(layers),
    ...checkFirstFramePropsConflict(layers, project, scene),
    ...checkOpticsConflict(layers),
    ...checkIdentityAnchorDuplication(layers, project, scene),
  ];
}
