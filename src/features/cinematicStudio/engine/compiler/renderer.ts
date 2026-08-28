/**
 * 共享渲染器（P0.2 双语）
 * 所有 Compiler 模板共用的句子渲染函数，locale 决定输出语言（默认 zh）。
 * 结构化枚举值走词典；用户自由文本（场景名、logline、资产描述）保持原文。
 * 原则：空值不输出；强约束与风格分离；编号在一个 Prompt 内稳定。
 */
import type { Asset, IdentityRule, PropState, ProjectV2, SceneV2, ShotV2 } from "../../shared-types";
import { assetCanonicalDescription } from "../asset-naming";
import { fillTemplate, localizePromptValue, promptLexicon, type PromptLocale } from "../i18n/lexicon";

/** appearance-only 资产：用途仅「仅外观参考」且非锁定 */
export function isAppearanceOnly(asset: Asset): boolean {
  const useFor = asset.useFor ?? [];
  return useFor.length === 1 && useFor[0] === "appearance";
}

/** 资产是否强锁定 */
export function isStrictLocked(asset: Asset): boolean {
  return asset.lockLevel === "strict";
}

/** 资产用途文本段：use for face, body, wardrobe */
export function renderUseFor(asset: Asset, locale: PromptLocale = "zh"): string {
  const useFor = (asset.useFor ?? []).filter((item) => item !== "appearance");
  if (useFor.length === 0) return "";
  return locale === "zh" ? ` 用途：${useFor.join("、")}。` : ` Use for ${useFor.join(", ")}.`;
}

/** 资产忽略文本段：ignore pose, background */
export function renderIgnore(asset: Asset, locale: PromptLocale = "zh"): string {
  const ignore = (asset.ignore ?? []).filter(Boolean);
  if (ignore.length === 0) return "";
  return locale === "zh" ? ` 忽略：${ignore.join("、")}。` : ` Ignore ${ignore.join(", ")}.`;
}

/** 道具资产默认信息：形状/材质仍来自参考图，文本只补充用途、接触位置和可见状态。 */
export function renderPropDefaults(asset: Asset, locale: PromptLocale = "zh", holderName?: (id: string) => string): string {
  if (asset.kind !== "prop") return "";
  const zh = locale === "zh";
  const usage = (zh ? asset.propUsageZh : asset.propUsage)?.trim();
  const position = (zh ? asset.propPositionZh : asset.propPosition)?.trim();
  const state = (zh ? asset.propDefaultStateZh : asset.propDefaultState)?.trim();
  const holderId = asset.propHolderCharacterId;
  const holder = holderId ? (holderName?.(holderId) || holderId) : "";
  if (!usage && !holder && !position && !state) return "";
  if (zh) {
    const parts: string[] = [];
    if (holder) parts.push(`由${holder}持有`);
    if (position) parts.push(`放在${position}`);
    if (usage) parts.push(`用于${usage}`);
    if (state) parts.push(`保持${state}状态`);
    return parts.join("，");
  }
  const parts: string[] = [];
  if (holder) parts.push(`held by ${holder}`);
  if (position) parts.push(`kept at ${position}`);
  if (usage) parts.push(`used only for ${usage}`);
  if (state) parts.push(`kept ${state}`);
  return parts.join(", ");
}

/** 图片引用语法（P2.1 模型 Profile 决定） */
export type ReferenceSyntax = "asset-id" | "at-mention" | "plain-text";

/** 单条资产 canonical 行（Asset-ID 模板；P2.1 支持三种引用语法，P0.2 双语） */
export function renderAssetLine(asset: Asset, imageIndex: number | undefined, syntax: ReferenceSyntax = "asset-id", locale: PromptLocale = "zh", holderName?: (id: string) => string, audioIndex?: number): string {
  const lex = promptLexicon(locale);
  const desc = assetCanonicalDescription(asset, locale) || asset.name.trim();
  const referenceName = asset.referenceTag?.trim() || asset.name.trim() || asset.id;
  const displayName = asset.name.trim() || desc;
  const n = imageIndex ? String(imageIndex) : "";
  const image = imageIndex ? ` [image${n}]` : "";
  const head = syntax === "at-mention"
    ? `@${referenceName}${image} — ${displayName}${locale === "zh" ? "：" : ": "}${desc}`
    : syntax === "plain-text"
      ? `${image.trim()} — ${displayName}${locale === "zh" ? "：" : ": "}${desc}`
      : `<<<${asset.id}>>>${image} — ${displayName}${locale === "zh" ? "：" : ": "}${desc}`;
  const parts: string[] = [head];
  const useFor = renderUseFor(asset, locale);
  if (useFor) parts.push(useFor.trim());
  const ignore = renderIgnore(asset, locale);
  if (ignore) parts.push(ignore.trim());
  if (isAppearanceOnly(asset)) parts.push(lex.labels.appearanceOnly);
  const markers = (asset.uniqueMarkers ?? []).filter(Boolean);
  if (markers.length > 0) parts.push(`${lex.labels.uniqueMarkers}: ${markers.join(locale === "zh" ? "；" : "; ")}.`);
  const always = (asset.alwaysVisible ?? []).filter(Boolean);
  if (always.length > 0) parts.push(`${lex.labels.alwaysVisible}: ${always.join(locale === "zh" ? "；" : "; ")}.`);
  const propDefaults = renderPropDefaults(asset, locale, holderName);
  if (propDefaults) parts.push(propDefaults);
  if (audioIndex && asset.voiceClip?.trim()) parts.push(locale === "zh" ? `声音参考：@audio${audioIndex}。` : `Voice reference: @audio${audioIndex}.`);
  return parts.join(" ");
}

/** 资产编号注册表：按第一次引用顺序分配 [imageN]，编号在单次 Prompt 内稳定 */
export interface AssetRegistry {
  /** assetId → image index（1 起） */
  indexByAssetId: Map<string, number>;
  /** 按引用顺序排列的资产 */
  orderedAssets: Asset[];
}

/**
 * 仅编译本场景、当前镜头与状态链引用的资产。
 * 引用来源：场景 staging.locationAssetId、镜头参与者、V0.1 兼容 characterId、
 * 开始道具状态、Beats 的动作执行者与目标、镜头布局。
 */
export function buildAssetRegistry(project: ProjectV2, scene: SceneV2, shot: ShotV2): AssetRegistry {
  const assets = project.assets ?? [];
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const visited: string[] = [];
  const visit = (id?: string) => {
    if (!id || visited.includes(id)) return;
    const asset = byId.get(id);
    if (!asset) return;
    visited.push(id);
    // Character-bound props are visible with that active character in this shot.
    if (asset.kind === "character") {
      for (const propId of asset.attachedPropIds ?? []) visit(propId);
    }
  };
  visit(scene.staging?.locationAssetId);
  for (const participant of shot.participants ?? []) visit(participant.characterId);
  visit(shot.characterId);
  // Legacy project data may still identify a visible prop through state fields.
  // Keep that asset in the registry, but do not render the state chain.
  for (const state of [...(shot.propStatesAtStart ?? []), ...(shot.propStatesAtEnd ?? [])]) visit(state.propId);
  for (const beat of shot.beats ?? []) {
    visit(beat.actorId);
    visit(beat.targetCharacterId);
    visit(beat.targetPropId);
    for (const state of [...(beat.stateBefore ?? []), ...(beat.stateAfter ?? [])]) visit(state.propId);
  }
  for (const id of shot.layout?.characterOrder ?? []) visit(id);
  const orderedAssets = visited.map((id) => byId.get(id)!).filter(Boolean);
  return {
    indexByAssetId: new Map(orderedAssets.map((asset, index) => [asset.id, index + 1])),
    orderedAssets,
  };
}

/**
 * 场景级资产注册表（pro-sequence / director 用）。
 * `scope: "scene"`（默认）：整个场景共享编号（多镜头共享引用顺序）；
 * `scope: "shot"`：只收集单个镜头的活动引用（导演模式上下文隔离）。
 */
export function buildSceneAssetRegistry(
  project: ProjectV2,
  scene: SceneV2,
  scope: "shot" | "scene" = "scene",
  shot?: ShotV2,
): AssetRegistry {
  if (scope === "shot") {
    if (!shot) throw new Error("buildSceneAssetRegistry: scope 'shot' requires a shot");
    return buildAssetRegistry(project, scene, shot);
  }
  const assets = project.assets ?? [];
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const visited: string[] = [];
  const visit = (id?: string) => {
    if (!id || visited.includes(id)) return;
    const asset = byId.get(id);
    if (!asset) return;
    visited.push(id);
    if (asset.kind === "character") {
      for (const propId of asset.attachedPropIds ?? []) visit(propId);
    }
  };
  visit(scene.staging?.locationAssetId);
  for (const shot of scene.shots) {
    for (const participant of shot.participants ?? []) visit(participant.characterId);
    visit(shot.characterId);
    for (const state of [...(shot.propStatesAtStart ?? []), ...(shot.propStatesAtEnd ?? [])]) visit(state.propId);
    for (const beat of shot.beats ?? []) {
      visit(beat.actorId);
      visit(beat.targetCharacterId);
      visit(beat.targetPropId);
      for (const state of [...(beat.stateBefore ?? []), ...(beat.stateAfter ?? [])]) visit(state.propId);
    }
    for (const id of shot.layout?.characterOrder ?? []) visit(id);
  }
  const orderedAssets = visited.map((id) => byId.get(id)!).filter(Boolean);
  return {
    indexByAssetId: new Map(orderedAssets.map((asset, index) => [asset.id, index + 1])),
    orderedAssets,
  };
}

/** 强锁定资产（身份强锁，不允许用户手工删除该段） */
export function strictLockedAssets(registry: AssetRegistry): Asset[] {
  return registry.orderedAssets.filter(isStrictLocked);
}

/** STRICT IDENTITY LOCK 段（P0.2 双语） */
export function renderStrictIdentityLock(registry: AssetRegistry, rules: IdentityRule[] = [], locale: PromptLocale = "zh"): string {
  const lex = promptLexicon(locale);
  const strictAssets = strictLockedAssets(registry);
  if (strictAssets.length === 0 && rules.length === 0) return "";
  const lines: string[] = [];
  for (const asset of strictAssets) {
    const rule = rules.find((item) => item.characterId === asset.id);
    const markers = (rule?.uniqueMarkers ?? asset.uniqueMarkers ?? []).filter(Boolean);
    const always = (rule?.alwaysVisible ?? asset.alwaysVisible ?? []).filter(Boolean);
    const forbidden = (rule?.forbiddenConfusions ?? asset.forbiddenConfusions ?? []).filter(Boolean);
    const bits: string[] = [];
    if (markers.length) bits.push(`${lex.labels.uniqueMarkers}: ${markers.join(locale === "zh" ? "；" : "; ")}`);
    if (always.length) bits.push(`${lex.labels.alwaysVisible}: ${always.join(locale === "zh" ? "；" : "; ")}`);
    if (forbidden.length) bits.push(`${lex.labels.neverConfuse}: ${forbidden.join(locale === "zh" ? "；" : "; ")}`);
    lines.push(`- ${asset.name.toUpperCase()}: ${lex.headings.strict}${bits.length ? ` — ${bits.join("; ")}.` : "."}`);
  }
  for (const rule of rules) {
    const asset = registry.orderedAssets.find((item) => item.id === rule.characterId);
    if (asset) continue;
    const markers = (rule.uniqueMarkers ?? []).filter(Boolean);
    const always = (rule.alwaysVisible ?? []).filter(Boolean);
    if (markers.length === 0 && always.length === 0) continue;
    const bits: string[] = [];
    if (markers.length) bits.push(`${lex.labels.uniqueMarkers}: ${markers.join(locale === "zh" ? "；" : "; ")}`);
    if (always.length) bits.push(`${lex.labels.alwaysVisible}: ${always.join(locale === "zh" ? "；" : "; ")}`);
    lines.push(`- ${rule.characterId}: ${lex.headings.strict} — ${bits.join("; ")}.`);
  }
  return `${lex.headings.strict}:\n${lines.join("\n")}`;
}

const NUMBERS_ZH = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
const NUMBERS_EN = ["ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE", "TEN"];

/** 角色数量锁（P0.2 双语） */
export function renderCharacterCountLock(project: ProjectV2, locale: PromptLocale = "zh"): string {
  const n = project.characterCountLock;
  if (!n || n <= 0) return "";
  if (locale === "zh") {
    return fillTemplate(promptLexicon("zh").templates.countLine, { n: NUMBERS_ZH[n - 1] ?? String(n) });
  }
  return fillTemplate(promptLexicon("en").templates.countLine, { n: NUMBERS_EN[n - 1] ?? String(n) });
}

/** 状态行渲染：boombox held by JAXX, on shoulder, playing（P0.2 双语；P2.1 引用语法由解析器决定） */
export function renderPropState(state: PropState, assetNameById: (id: string) => string, locale: PromptLocale = "zh"): string {
  const name = assetNameById(state.propId) || state.propId;
  const lex = promptLexicon(locale);
  const bits = [name];
  const holder = state.holderCharacterId ? assetNameById(state.holderCharacterId) || state.holderCharacterId : "";
  if (holder) bits.push(locale === "zh" ? fillTemplate(lex.labels.heldBy, { name: holder }) : `held by ${holder}`);
  if (state.position) bits.push(state.position);
  if (state.state && state.state !== "held") bits.push(localizePromptValue(state.state, locale));
  return bits.join(locale === "zh" ? "，" : ", ");
}

/**
 * 跨镜头/镜头内状态链
 * 从 propStatesAtStart → beats stateAfter（按 order）→ propStatesAtEnd 聚合，
 * 每个资产一行：propName: s1 → s2 → s3。只输出实际变化，连续重复状态合并。
 */
export function renderStateChain(project: ProjectV2, shot: ShotV2, locale: PromptLocale = "zh", syntax: ReferenceSyntax = "asset-id"): string[] {
  const name = assetRefName(project, syntax);
  const nameOfHolder = (id?: string) => (id ? assetRefName(project, syntax)(id) : undefined);
  const lex = promptLexicon(locale);
  const stateText = (s: PropState) => {
    const bits: string[] = [];
    if (s.holderCharacterId) bits.push(locale === "zh" ? fillTemplate(lex.labels.heldBy, { name: nameOfHolder(s.holderCharacterId) ?? "" }) : `held by ${nameOfHolder(s.holderCharacterId)}`);
    if (s.position) bits.push(s.position);
    if (s.state && s.state !== "held") bits.push(localizePromptValue(s.state, locale));
    return bits.join(locale === "zh" ? "，" : ", ") || localizePromptValue(s.state ?? "", locale);
  };
  const sequence: { propId: string; state: string }[] = [];
  const firstSeen = new Set<string>();
  const push = (propId: string, state: string) => {
    const last = sequence[sequence.length - 1];
    if (last && last.propId === propId && last.state === state) return;
    if (firstSeen.has(propId)) { sequence.push({ propId, state }); return; }
    firstSeen.add(propId);
    sequence.push({ propId, state });
  };
  for (const s of shot.propStatesAtStart ?? []) push(s.propId, stateText(s));
  for (const beat of [...(shot.beats ?? [])].sort((a, b) => a.order - b.order)) {
    for (const s of beat.stateBefore ?? []) push(s.propId, stateText(s));
    for (const s of beat.stateAfter ?? []) push(s.propId, stateText(s));
  }
  for (const s of shot.propStatesAtEnd ?? []) push(s.propId, stateText(s));
  const chains = new Map<string, string[]>();
  for (const item of sequence) {
    if (!chains.has(item.propId)) chains.set(item.propId, []);
    const list = chains.get(item.propId)!;
    if (list[list.length - 1] !== item.state) list.push(item.state);
  }
  const lines: string[] = [];
  for (const [propId, states] of chains) {
    if (states.length < 2) continue;
    lines.push(fillTemplate(lex.templates.stateChain, { name: name(propId), chain: states.join(" → ") }));
  }
  return lines;
}

/** Beat 时间线明细：{order}: {begin}-{end}s（P0.2 双语） */
export function renderBeatTimeline(shot: ShotV2, locale: PromptLocale = "zh"): string {
  let start = 0;
  const beatTimes = (shot.beats ?? [])
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((beat) => {
      const begin = start;
      start += beat.duration ?? 0;
      return locale === "zh"
        ? `${beat.order}: ${begin.toFixed(1)}–${start.toFixed(1)} 秒`
        : `${beat.order}: ${begin.toFixed(1)}-${start.toFixed(1)}s`;
    });
  return beatTimes.join(locale === "zh" ? " | " : " | ");
}

/**
 * 镜头时间文本：
 * 1. beats 总时长与显式 time 一致 → 输出 beat 明细
 * 2. 有显式 time → "start.0-end.0s"
 * 3. 兼容旧 "0-8秒" 字符串
 */
export function shotTimeText(shot: ShotV2): string {
  const beatTotal = (shot.beats ?? []).reduce((sum, beat) => sum + (beat.duration ?? 0), 0);
  const time = shot.time;
  if (time) {
    const span = time.endSeconds - time.startSeconds;
    if (beatTotal > 0 && Math.abs(span - beatTotal) < 0.5) return renderBeatTimeline(shot, "en").replace(/\s秒/g, "s");
    return `${time.startSeconds.toFixed(1)}-${time.endSeconds.toFixed(1)}s`;
  }
  const m = shot.duration?.match(/(\d+)\s*-\s*(\d+)/);
  if (m) return `${m[1]}.0-${m[2]}.0s`;
  return shot.duration || "";
}

/** 镜头行渲染（P0.2 双语）：SHOT 01 (0.0-6.0s) / 镜头 01（0.0–6.0 秒） */
export function renderShotTime(shot: ShotV2, locale: PromptLocale = "zh"): string {
  const lex = promptLexicon(locale);
  const raw = shotTimeText(shot);
  const time = locale === "zh" ? raw.replace(/(\d+\.\d)-(\d+\.\d)s/g, "$1–$2 秒").replace(/(\d+)-(\d+\.\d+)s/g, "$1–$2 秒") : raw;
  return fillTemplate(lex.templates.shotLine, { label: shot.label, time });
}

/** 总片长（秒）：最后一镜 end，否则 beats 累加 */
export function totalSceneDuration(scene: SceneV2): number {
  const shots = scene.shots;
  if (shots.length === 0) return 0;
  const last = shots[shots.length - 1];
  if (last.time) return last.time.endSeconds;
  const m = last.duration?.match(/(\d+)\s*-\s*(\d+)/);
  if (m) return Number(m[2]);
  return shots.reduce((sum, shot) => sum + (shot.beats ?? []).reduce((s, beat) => s + (beat.duration ?? 0), 0), 0);
}

/** 从 Project 取资产名 */
export function assetNameById(project: ProjectV2): (id: string) => string {
  const byId = new Map((project.assets ?? []).map((asset) => [asset.id, asset.referenceTag?.trim() || asset.name]));
  return (id: string) => byId.get(id) ?? id;
}

/** 资产名引用（P2.1 语法）：at-mention → @名字，其余保持原名 */
export function assetRefName(project: ProjectV2, syntax: ReferenceSyntax = "asset-id"): (id: string) => string {
  const name = assetNameById(project);
  return (id: string) => {
    const base = name(id);
    return syntax === "at-mention" ? `@${base}` : base;
  };
}

// ─────────────────────────────────────────────────────────────
// P0.2 · 多角色空间站位渲染
// ─────────────────────────────────────────────────────────────

/** 有效左到右顺序：镜头覆写优先，其次场景站位（useSceneStaging !== false 时继承） */
export function resolveCharacterOrder(scene: SceneV2, shot: ShotV2): string[] {
  const participants = (shot.participants ?? []).map((participant) => participant.characterId);
  const participantSet = new Set(participants);
  const restrictToParticipants = (order: string[]) => {
    if (participants.length === 0) return order;
    const ordered = order.filter((id) => participantSet.has(id));
    return [...ordered, ...participants.filter((id) => !ordered.includes(id))];
  };
  if (shot.layout?.characterOrder && shot.layout.characterOrder.length > 0) {
    return restrictToParticipants(shot.layout.characterOrder);
  }
  if (shot.layout?.useSceneStaging === false) return participants;
  const staged = restrictToParticipants(scene.staging?.characterOrder ?? []);
  return staged.length > 0 ? staged : participants;
}

/** 镜头内各角色持有的道具（仅起始状态，P2.2：结束状态不回灌站位文本） */
export function heldPropsByCharacter(shot: ShotV2): Map<string, { propId: string; state?: string; position?: string }[]> {
  void shot;
  return new Map();
}

/** Participants 行：按有效站位顺序输出角色名（P0.2 双语；P2.1 语法） */
export function renderParticipantsLine(project: ProjectV2, shot: ShotV2, order: string[], locale: PromptLocale = "zh", syntax: ReferenceSyntax = "asset-id"): string {
  const ids = order.length > 0 ? order : (shot.participants ?? []).map((p) => p.characterId);
  if (ids.length === 0) return "";
  const name = assetRefName(project, syntax);
  const label = promptLexicon(locale).labels.participants;
  return locale === "zh" ? `${label}：${ids.map(name).join("、")}。` : `${label}: ${ids.map(name).join(", ")}.`;
}

/** Spatial layout 行：左到右 + 道具持有 + 入画方向（P0.2 双语；P2.1 语法；P2.2 只渲染起始状态） */
export function renderSpatialLayoutLine(project: ProjectV2, shot: ShotV2, order: string[], locale: PromptLocale = "zh", syntax: ReferenceSyntax = "asset-id"): string {
  if (order.length < 2) return "";
  const lex = promptLexicon(locale);
  const name = assetRefName(project, syntax);
  const held = heldPropsByCharacter(shot);
  const bits = order.map((id) => {
    const extra: string[] = [];
    const props = held.get(id);
    if (props?.length) {
      const propBits = props.map((p) => {
        const pieces = [name(p.propId)];
        if (p.position) pieces.push(p.position);
        if (p.state && p.state !== "on-ground") pieces.push(localizePromptValue(p.state, locale));
        return pieces.join(locale === "zh" ? "，" : " ");
      });
      extra.push(`${lex.labels.with} ${propBits.join(locale === "zh" ? "、" : ", ")}`);
    }
    const participant = (shot.participants ?? []).find((p) => p.characterId === id);
    if (participant?.entrance === "enters-left") extra.push(lex.labels.entersFromLeft);
    if (participant?.entrance === "enters-right") extra.push(lex.labels.entersFromRight);
    return [name(id), ...extra].join(" ");
  });
  return locale === "zh"
    ? `${lex.labels.spatialLayout}：${bits.join("、")}。`
    : `${lex.labels.spatialLayout}: ${bits.join(", ")}.`;
}

/** 站位细节行：前中后景 / 朝向 / 视线（P0.2 双语；P2.1 语法） */
export function renderStagingDetails(project: ProjectV2, shot: ShotV2, locale: PromptLocale = "zh", syntax: ReferenceSyntax = "asset-id"): string {
  const lex = promptLexicon(locale);
  const details: string[] = [];
  const name = assetRefName(project, syntax);
  for (const participant of shot.participants ?? []) {
    const bits: string[] = [];
    if (participant.position) bits.push(participant.position);
    if (participant.facing) bits.push(`${lex.labels.facing} ${participant.facing}`);
    if (participant.torsoFacing) bits.push(`${lex.labels.torsoFacing} ${participant.torsoFacing}`);
    if (participant.eyeline) bits.push(`${lex.labels.eyeline} ${participant.eyeline}`);
    if (participant.anchorDistance) bits.push(`${lex.labels.anchorDistance} ${participant.anchorDistance}`);
    if (bits.length) details.push(`${name(participant.characterId)} ${bits.join(locale === "zh" ? "，" : ", ")}`);
  }
  if (details.length === 0) return "";
  return locale === "zh" ? `${lex.labels.stagingDetails}：${details.join("；")}。` : `${lex.labels.stagingDetails}: ${details.join("; ")}.`;
}

/** 空间锚点句子（镜头覆写优先于场景；自由文本保持原文） */
export function resolveAnchor(scene: SceneV2, shot: ShotV2): string {
  return shot.layout?.anchorDescription?.trim() || scene.staging?.anchorDescription?.trim() || "";
}

/** 故意越轴注释（P0.2 双语） */
export function renderAxisBreakNote(shot: ShotV2, locale: PromptLocale = "zh"): string {
  if (!shot.layout?.intentionalAxisBreak) return "";
  const lex = promptLexicon(locale);
  const note = shot.layout.axisNote?.trim();
  if (locale === "zh") {
    return note ? `${lex.labels.axisBreak}：${note}。` : "故意越轴：屏幕方向有意反向。";
  }
  return note ? `${lex.labels.axisBreak}: ${note}.` : "Intentional axis break: screen direction reverses on purpose.";
}
