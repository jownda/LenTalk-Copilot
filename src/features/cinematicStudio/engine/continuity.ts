/**
 * V0.2 连续性规则引擎（P0.5 完整实现，P0.1 先行实现 Identity 组）
 *
 * 返回带 code / severity / entityId 的结构化问题，供 UI 展示与「连续性修复」使用。
 * 严重级别：
 *   error   — 无法逻辑成立；禁止导出「最终版」
 *   warning — 可能造成模型漂移；允许导出，但要求用户确认
 *   info    — 质量建议；可忽略
 *
 * P0.1 范围：Identity 组（角色数量锁、唯一标记、始终可见、强锁定存在性、无重复角色）
 * P0.2 范围：Spatial 组（地点资产、180° 轴线、故意越轴、站位顺序一致性）
 * 其余规则组在 P0.3-P0.5 分批加入。
 */
import type { Asset, ContinuityIssueV2, ProjectV2, SceneV2, ShotRisk } from "../shared-types";
import { resolveCharacterOrder } from "./compiler/renderer";
import { TERMINAL_STATES, TRIGGER_VERBS } from "./states";
import { ATTACK_VERBS } from "./beats";
import { FILM_PRESETS, LENS_BANK, lensById, presetById, type LensContentClass } from "./presets";

/** 画面方向值的中文映射（连续性详情在 zh 界面使用） */
const DIR_ZH: Record<string, string> = {
  "left-to-right": "从左到右",
  "right-to-left": "从右到左",
  LTR: "从左到右",
  RTL: "从右到左",
};
const dirLabel = (d?: string) => (d ? DIR_ZH[d] ?? d : "");

/** 规则组（P0.5 全部启用：Identity/Spatial/Prop/Causality/Technical/Audio；P5.3 增加 Acting；P3 增加 Context） */
export type RuleGroup = "identity" | "spatial" | "prop" | "causality" | "technical" | "audio" | "acting" | "context";

export interface ContinuityCheckOptions {
  groups?: RuleGroup[];
}

/** 资产引用集合：项目中的角色资产 + 身份规则绑定 */
export interface IdentityContext {
  characterAssets: Asset[];
  rulesByCharacter: Map<string, NonNullable<ProjectV2["identityRules"]>[number]>;
  /** 场景中出现的角色 ID（参与者 + V0.1 兼容 characterId） */
  referencedCharacterIds: Set<string>;
  /** 每个出现镜头都需校验 alwaysVisible 的角色 ID */
  visibleLockedCharacterIds: Set<string>;
}

export function buildIdentityContext(project: ProjectV2, scene: SceneV2): IdentityContext {
  const characterAssets = (project.assets ?? []).filter((asset) => asset.kind === "character");
  const rulesByCharacter = new Map((project.identityRules ?? []).map((rule) => [rule.characterId, rule]));
  const referenced = new Set<string>();
  const visibleLocked = new Set<string>();
  for (const shot of scene.shots) {
    for (const participant of shot.participants ?? []) referenced.add(participant.characterId);
    if (shot.characterId) referenced.add(shot.characterId);
  }
  // 强锁定或带 alwaysVisible 的角色出现在任一镜头时，alwaysVisible 需被校验；
  // 未声明 alwaysVisible 的强锁定角色不在此组检查（由 MARKERS_MISSING 覆盖）
  for (const asset of characterAssets) {
    const rule = rulesByCharacter.get(asset.id);
    const hasAlways = (rule?.alwaysVisible ?? asset.alwaysVisible ?? []).length > 0;
    if (hasAlways && referenced.has(asset.id)) visibleLocked.add(asset.id);
  }
  return { characterAssets, rulesByCharacter, referencedCharacterIds: referenced, visibleLockedCharacterIds: visibleLocked };
}

/** 低信息量英文虚词，不参与 alwaysVisible 证据比对 */
const ALWAYS_VISIBLE_STOP = new Set(["at", "all", "times", "the", "on", "in", "with", "and", "both", "his", "her", "their", "left", "right", "over", "hands", "feet", "face"]);

/**
 * Identity 组检查（P0.1）：
 * 1. 角色数量锁 EXACTLY N 与实际出现人数不符 → error
 * 2. 强锁定角色未出现在任何镜头 → warning
 * 3. alwaysVisible 资产的标记在每次出现镜头都被编译 → 由编译器保证；此处校验规则存在性
 * 4. 唯一标记缺失（强锁定角色没有 uniqueMarkers）→ warning
 * 5. 重复角色：同一镜头同一角色出现两次 → error
 */
export function checkIdentity(project: ProjectV2, scene: SceneV2, _options: ContinuityCheckOptions = {}): ContinuityIssueV2[] {
  const issues: ContinuityIssueV2[] = [];
  const ctx = buildIdentityContext(project, scene);

  // 1. 角色数量锁
  const countLock = project.characterCountLock;
  if (countLock && countLock > 0) {
    const actual = ctx.referencedCharacterIds.size;
    if (actual !== countLock) {
      issues.push({
        code: "IDENTITY.COUNT",
        severity: "error",
        entityId: scene.id,
        label: "Character count lock",
        detail: `Project locks EXACTLY ${countLock} characters, but this scene references ${actual}.`,
        detailZh: `项目锁定了恰好 ${countLock} 个角色，但本场景实际出现 ${actual} 个。`,
      });
    }
  }

  // 2. 强锁定角色是否出现在场景
  for (const asset of ctx.characterAssets) {
    if (asset.lockLevel === "strict" && !ctx.referencedCharacterIds.has(asset.id)) {
      issues.push({
        code: "IDENTITY.STRICT_NOT_REFERENCED",
        severity: "warning",
        entityId: asset.id,
        label: "Strict identity not used",
        detail: `Strict-locked character ${asset.name} is not referenced by any shot in this scene.`,
        detailZh: `强锁定角色「${asset.name}」未被本场景任何镜头引用。`,
      });
    }
  }

  // 3. alwaysVisible 完整性：声明了始终可见物件的角色出现在场景时，
  //    校验物件关键词是否有资产描述/独特标记作为证据（编译器保证输出，这里给出质量建议）
  for (const characterId of ctx.visibleLockedCharacterIds) {
    const asset = ctx.characterAssets.find((item) => item.id === characterId);
    if (!asset) continue;
    const rule = ctx.rulesByCharacter.get(characterId);
    const always = (rule?.alwaysVisible ?? asset.alwaysVisible ?? []).filter(Boolean);
    if (always.length === 0) continue;
    const markers = (rule?.uniqueMarkers ?? asset.uniqueMarkers ?? []);
    const evidence = `${asset.description} ${asset.descriptionZh ?? ""} ${markers.join(" ")}`.toLowerCase();
    for (const item of always) {
      const keyTokens = item.toLowerCase().split(/\s+/).filter((w) => w.length > 3 && !ALWAYS_VISIBLE_STOP.has(w));
      const covered = keyTokens.every((token) => evidence.includes(token));
      if (!covered) {
          issues.push({
          code: "IDENTITY.ALWAYS_VISIBLE_UNVERIFIED",
          severity: "info",
          entityId: characterId,
          label: "Always-visible token unverified",
          detail: `Always-visible rule "${item}" for ${asset.name} is not backed by the asset description or unique markers; consider adding it to the description. Compiler will still output it.`,
          detailZh: `「${asset.name}」的始终可见规则「${item}」未在资产描述或独特标记中找到佐证；建议补充到描述中（编译器仍会照常输出该规则）。`,
        });
      }
    }
  }

  // 4. 唯一标记缺失（强锁定角色）
  for (const asset of ctx.characterAssets) {
    if (asset.lockLevel !== "strict") continue;
    const rule = ctx.rulesByCharacter.get(asset.id);
    const markers = (rule?.uniqueMarkers ?? asset.uniqueMarkers ?? []).filter(Boolean);
    if (markers.length === 0) {
      issues.push({
        code: "IDENTITY.MARKERS_MISSING",
        severity: "warning",
        entityId: asset.id,
        label: "Unique markers missing",
        detail: `Strict-locked character ${asset.name} has no unique markers; identity may drift.`,
        detailZh: `强锁定角色「${asset.name}」没有独特标记，身份可能会漂移。`,
      });
    }
  }

  // 5. 重复角色（同一镜头参与者重复）
  for (const shot of scene.shots) {
    const ids = (shot.participants ?? []).map((p) => p.characterId);
    if (shot.characterId) ids.push(shot.characterId);
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) {
        issues.push({
          code: "IDENTITY.DUPLICATE",
          severity: "error",
          entityId: shot.id,
          label: "Duplicate character in shot",
          detail: `Shot ${shot.label} references character ${id} more than once.`,
          detailZh: `镜头「${shot.label}」重复引用了角色 ${id}。`,
        });
        break;
      }
      seen.add(id);
    }
  }

  return issues;
}

/**
 * Spatial 组检查（P0.2）：
 * 1. 场景地点资产必须存在（staging.locationAssetId）→ error
 * 2. 相邻镜头 180° 轴线：方向翻转未标记故意越轴 → warning；已标记 → info
 * 3. 站位顺序一致性：参与角色缺位 / 顺序包含非参与者 → warning
 */
export function checkSpatial(project: ProjectV2, scene: SceneV2, _options: ContinuityCheckOptions = {}): ContinuityIssueV2[] {
  const issues: ContinuityIssueV2[] = [];

  // 1. 地点资产存在性
  const locationId = scene.staging?.locationAssetId;
  if (locationId) {
    const exists = (project.assets ?? []).some((asset) => asset.id === locationId);
    if (!exists) {
      issues.push({
        code: "SPATIAL.LOCATION_MISSING",
        severity: "error",
        entityId: scene.id,
        label: "Location asset missing",
        detail: `Scene staging references location asset ${locationId}, which does not exist in the asset library.`,
        detailZh: `场景站位引用了地点资产 ${locationId}，但资产库中不存在该资产。`,
      });
    }
  }

  // 2. 相邻镜头轴线（逐对检查，允许故意越轴标记）
  const shots = scene.shots;
  for (let i = 1; i < shots.length; i += 1) {
    const prev = shots[i - 1];
    const curr = shots[i];
    if (!prev.direction || !curr.direction || prev.direction === curr.direction) continue;
    if (curr.layout?.intentionalAxisBreak) {
      issues.push({
        code: "SPATIAL.AXIS_BREAK_INTENTIONAL",
        severity: "info",
        entityId: curr.id,
        label: "Intentional axis break",
        detail: `Shot ${prev.label} (${prev.direction}) → ${curr.label} (${curr.direction}) crosses the 180° line; marked as intentional.${curr.layout.axisNote ? ` Note: ${curr.layout.axisNote}` : ""}`,
        detailZh: `镜头「${prev.label}」（${dirLabel(prev.direction)}）→「${curr.label}」（${dirLabel(curr.direction)}）越过 180° 轴线，已标记为故意越轴。${curr.layout.axisNote ? `备注：${curr.layout.axisNote}` : ""}`,
      });
    } else {
      issues.push({
        code: "SPATIAL.AXIS_CONFLICT",
        severity: "warning",
        entityId: curr.id,
        label: "Axis conflict",
        detail: `Shot ${prev.label} (${prev.direction}) → ${curr.label} (${curr.direction}) reverses screen direction and crosses the 180° line. Confirm this is intentional or mark “intentional axis break”.`,
        detailZh: `镜头「${prev.label}」（${dirLabel(prev.direction)}）→「${curr.label}」（${dirLabel(curr.direction)}）反转了屏幕方向并越过 180° 轴线。请确认这是有意为之，或标记为“故意越轴”。`,
        fixLabel: "Mark as intentional",
      });
    }
  }

  // 3. 站位顺序与参与者一致性（逐镜头，含场景继承）
  for (const shot of shots) {
    const participants = shot.participants ?? [];
    if (participants.length === 0) continue;
    const order = resolveCharacterOrder(scene, shot);
    if (order.length === 0) continue;
    const participantIds = new Set(participants.map((p) => p.characterId));
    const inShotNotInOrder = [...participantIds].filter((id) => !order.includes(id));
    const inOrderNotInShot = order.filter((id) => !participantIds.has(id));
    if (inShotNotInOrder.length > 0) {
      issues.push({
        code: "SPATIAL.ORDER_MISSING",
        severity: "warning",
        entityId: shot.id,
        label: "Character missing from layout",
        detail: `Shot ${shot.label}: ${inShotNotInOrder.join(", ")} is a participant but absent from the left-to-right order.`,
        detailZh: `镜头「${shot.label}」：${inShotNotInOrder.join("、")} 是参与者，但未出现在从左到右的站位顺序中。`,
      });
    }
    if (inOrderNotInShot.length > 0) {
      issues.push({
        code: "SPATIAL.ORDER_EXTRA",
        severity: "warning",
        entityId: shot.id,
        label: "Layout lists non-participant",
        detail: `Shot ${shot.label}: layout order includes ${inOrderNotInShot.join(", ")}, which is not a participant of this shot.`,
        detailZh: `镜头「${shot.label}」：站位顺序包含 ${inOrderNotInShot.join("、")}，但该角色并非本镜头的参与者。`,
      });
    }
  }

  // 4. 弱词锚定（P1 验收）：站位文本命中 near/around/nearby/somewhere → 建议替换为可观测距离
  const WEAK_ANCHOR_RE = /\b(near|around|nearby|in the area|somewhere)\b/i;
  const weakFields: { entityId: string; text: string }[] = [];
  if (scene.staging?.anchorDescription?.trim()) weakFields.push({ entityId: scene.id, text: scene.staging.anchorDescription });
  if (scene.staging?.spacing?.trim()) weakFields.push({ entityId: scene.id, text: scene.staging.spacing });
  for (const shot of shots) {
    if (shot.layout?.anchorDescription?.trim()) weakFields.push({ entityId: shot.id, text: shot.layout.anchorDescription });
    for (const participant of shot.participants ?? []) {
      if (participant.position?.trim()) weakFields.push({ entityId: shot.id, text: participant.position });
      if (participant.anchorDistance?.trim()) weakFields.push({ entityId: shot.id, text: participant.anchorDistance });
    }
  }
  for (const field of weakFields) {
    const hit = field.text.match(WEAK_ANCHOR_RE);
    if (hit) {
      issues.push({
        code: "SPATIAL.WEAK_ANCHOR",
        severity: "warning",
        entityId: field.entityId,
        label: "Weak spatial anchor",
        detail: `Spatial text uses a vague positional word ("${hit[1]}"); replace with an observable anchor such as "within 1 meter", "back against the wall", or "hand on the handle".`,
        detailZh: `站位文本使用了模糊位置词（“${hit[1]}”）；请换成可观测的锚点描述，例如“一米以内”“背靠墙壁”或“手搭在把手上”。`,
      });
    }
  }

  // 5. 对白关系缺少朝向/视线（P3）：有对白的镜头，说话参与者必须同时具备朝向与视线，
  //    否则模型无法把「对话关系」落到可观测的身体与眼神上。
  for (const shot of shots) {
    const dialogueActors = new Set(
      (shot.beats ?? [])
        .filter((beat) => beat.dialogue?.trim())
        .map((beat) => beat.actorId)
        .filter((id): id is string => Boolean(id))
    );
    if (dialogueActors.size === 0) continue;
    const missingOrient: string[] = [];
    const missingEyeline: string[] = [];
    for (const participant of shot.participants ?? []) {
      if (!dialogueActors.has(participant.characterId)) continue;
      const orient = participant.facing?.trim() || participant.torsoFacing?.trim();
      const eyeline = participant.eyeline?.trim();
      if (!orient) missingOrient.push(participant.characterId);
      if (!eyeline) missingEyeline.push(participant.characterId);
    }
    const list = [...new Set([...missingOrient, ...missingEyeline])];
    if (list.length === 0) continue;
    const both = missingOrient.length > 0 && missingEyeline.length > 0;
    issues.push({
      code: "SPATIAL.GAZE_ORIENT_MISSING",
      severity: "warning",
      entityId: shot.id,
      label: "Dialogue lacks facing / eyeline",
      detail: `Shot ${shot.label} has dialogue but ${list.join(", ")} ${both ? "lack both facing (朝向) and eyeline (视线)" : missingOrient.length > 0 ? "lack facing/orientation" : "lack eyeline"}; dialogue reads as disembodied without observable body+eye contact.`,
      detailZh: `镜头「${shot.label}」有对白，但说话者 ${list.join("、")} ${both ? "既缺朝向也缺视线" : missingOrient.length > 0 ? "缺身体朝向" : "缺视线"}；没有可观测的身体朝向与眼神，对白会显得“无根”。`,
      fixLabel: "Add facing + eyeline",
    });
  }

  return issues;
}

/**
 * Prop 组检查（P0.3）：
 * 1. 状态引用的资产必须存在（propStatesAtStart/End、beat.stateBefore/After）→ error
 * 2. 跨镜头状态继承：下一镜头开始状态必须由上一镜头结束状态产生（首次登场除外）→ error
 * 3. 终态回退：shattered/blown-open/freed/collapsed 之后不可要求旧状态 → error
 * 4. 触发前持有：presses/pulls/detonates 等动作执行前目标道具必须被角色持有 → error
 */
export function checkProp(project: ProjectV2, scene: SceneV2, _options: ContinuityCheckOptions = {}): ContinuityIssueV2[] {
  const issues: ContinuityIssueV2[] = [];
  const assets = project.assets ?? [];
  const nameOf = (id: string) => assets.find((a) => a.id === id)?.name ?? id;
  const shots = scene.shots;

  // 1. 引用资产存在性
  for (const shot of shots) {
    const refs = [
      ...(shot.propStatesAtStart ?? []),
      ...(shot.propStatesAtEnd ?? []),
      ...((shot.beats ?? []).flatMap((beat) => [...(beat.stateBefore ?? []), ...(beat.stateAfter ?? [])])),
    ];
    for (const state of refs) {
      if (!assets.some((a) => a.id === state.propId)) {
        issues.push({
          code: "PROP.REFERENCE_MISSING",
          severity: "error",
          entityId: shot.id,
          label: "State references missing asset",
          detail: `Shot ${shot.label} references state asset ${state.propId}, which does not exist in the asset library.`,
          detailZh: `镜头「${shot.label}」引用了状态资产 ${state.propId}，但资产库中不存在该资产。`,
        });
      }
    }
  }

  // 2-3. 跨镜头状态链：lastEnd 追踪每一资产的最后已知结束状态
  const lastEnd = new Map<string, { state: string; shotLabel: string }>();
  shots.forEach((shot, index) => {
    // 初始化 lastEnd：第一镜开始状态 / 首次登场
    for (const state of shot.propStatesAtStart ?? []) {
      if (!lastEnd.has(state.propId)) lastEnd.set(state.propId, { state: state.state, shotLabel: shot.label });
    }
    // 继承检查（从第二镜起）：开始状态必须等于上一镜头结束状态，否则严重错误
    if (index > 0) {
      for (const state of shot.propStatesAtStart ?? []) {
        const prev = lastEnd.get(state.propId);
        if (!prev) continue; // 首次登场，允许
        if (prev.state === state.state) continue;
        if (TERMINAL_STATES.has(prev.state)) {
          issues.push({
            code: "PROP.STATE_REGRESSION",
            severity: "error",
            entityId: shot.id,
            label: "Terminal state regressed",
            detail: `${nameOf(state.propId)} ended shot ${prev.shotLabel} as "${prev.state}" (terminal); shot ${shot.label} starts it as "${state.state}". A terminal state cannot revert.`,
            detailZh: `${nameOf(state.propId)} 在镜头「${prev.shotLabel}」结束时是“${prev.state}”（终态）；镜头「${shot.label}」却以“${state.state}”开始。终态不可回退。`,
          });
        } else {
          issues.push({
            code: "PROP.STATE_UNPRODUCED",
            severity: "error",
            entityId: shot.id,
            label: "State not produced by previous shot",
            detail: `Shot ${shot.label} starts ${nameOf(state.propId)} as "${state.state}", but shot ${prev.shotLabel} ended it as "${prev.state}". The previous shot must produce this state first.`,
            detailZh: `镜头「${shot.label}」把 ${nameOf(state.propId)} 设为“${state.state}”开头，但镜头「${prev.shotLabel}」结束时是“${prev.state}”。前一镜头必须先产生该状态。`,
          });
        }
      }
    }
    // 更新 lastEnd：beats stateAfter（按 order）→ propStatesAtEnd
    for (const beat of [...(shot.beats ?? [])].sort((a, b) => a.order - b.order)) {
      for (const state of beat.stateAfter ?? []) lastEnd.set(state.propId, { state: state.state, shotLabel: shot.label });
    }
    for (const state of shot.propStatesAtEnd ?? []) lastEnd.set(state.propId, { state: state.state, shotLabel: shot.label });
  });

  // 4. 触发动作前必须持有目标道具
  for (const shot of shots) {
    for (const beat of shot.beats ?? []) {
      if (!TRIGGER_VERBS.has(beat.verb) || !beat.targetPropId) continue;
      const heldBefore = [
        ...(beat.stateBefore ?? []),
        ...(shot.propStatesAtStart ?? []),
      ].some((state) => state.propId === beat.targetPropId && state.holderCharacterId);
      if (!heldBefore) {
        issues.push({
          code: "PROP.NOT_HELD_BEFORE_TRIGGER",
          severity: "error",
          entityId: beat.id,
          label: "Prop not held before trigger",
          detail: `${nameOf(beat.actorId ?? "?")} ${beat.verb} ${nameOf(beat.targetPropId)} in shot ${shot.label}, but no character is recorded as holding it beforehand.`,
          detailZh: `${nameOf(beat.actorId ?? "?")} 在镜头「${shot.label}」中执行「${beat.verb}」作用于 ${nameOf(beat.targetPropId)}，但此前没有记录任何角色持有该道具。`,
        });
      }
    }
  }

  return issues;
}

/** 因果前置条件：目标状态要求前置状态（跨 beat / 镜头起始） */
const CAUSAL_PRECONDITIONS: Record<string, string[]> = {
  freed: ["restrained", "gripped"],
  shattered: ["intact"],
  "blown-open": ["closed", "open"],
  collapsed: ["falling-start", "stable"],
};

/**
 * Causality 组检查（P0.3）：
 * 1. 状态变化的前置条件：freed 需要 restrained/gripped 等（stateBefore 或镜头起始状态满足）→ 违反时 error(required)/warning
 * 2. 救援因果链：GUARD grips LULU → LULU freed 由状态链保证（同一 beat 或前一 beat 产生前置状态）
 */
export function checkCausality(project: ProjectV2, scene: SceneV2, _options: ContinuityCheckOptions = {}): ContinuityIssueV2[] {
  const issues: ContinuityIssueV2[] = [];
  const assets = project.assets ?? [];
  const nameOf = (id: string) => assets.find((a) => a.id === id)?.name ?? id;

  for (const shot of scene.shots) {
    // 0. 目标约束（P0.4 验收 1/2）：攻击动作必须有目标；目标不得位于 forbiddenTargets
    for (const beat of shot.beats ?? []) {
      if (!ATTACK_VERBS.has(beat.verb)) continue;
      const targetId = beat.targetCharacterId ?? beat.targetPropId;
      if (!targetId) {
        issues.push({
          code: "CAUSALITY.TARGET_MISSING",
          severity: "error",
          entityId: beat.id,
          label: "Attack without target",
          detail: `Beat ${beat.order} in ${shot.label}: "${beat.verb}" is an attack action and must declare a target character or prop.`,
          detailZh: `镜头「${shot.label}」第 ${beat.order} 拍：“${beat.verb}”属于攻击动作，必须声明目标角色或道具。`,
        });
        continue;
      }
      if ((beat.forbiddenTargets ?? []).includes(targetId)) {
        issues.push({
          code: "CAUSALITY.FORBIDDEN_TARGET",
          severity: "error",
          entityId: beat.id,
          label: "Target is forbidden",
          detail: `Beat ${beat.order} in ${shot.label} targets ${nameOf(targetId)}, which is listed in forbiddenTargets.`,
          detailZh: `镜头「${shot.label}」第 ${beat.order} 拍的目标是 ${nameOf(targetId)}，该目标列在禁止目标（forbiddenTargets）中。`,
        });
      }
    }
    // 镜头内已产生状态（含起始）：用于跨 beat 前置满足
    const produced = new Map<string, string[]>();
    for (const state of shot.propStatesAtStart ?? []) {
      produced.set(state.propId, [state.state]);
    }
    for (const beat of [...(shot.beats ?? [])].sort((a, b) => a.order - b.order)) {
      for (const state of beat.stateAfter ?? []) {
        const preconditions = CAUSAL_PRECONDITIONS[state.state];
        if (preconditions) {
          const before = [
            ...(beat.stateBefore ?? []).map((s) => s.state),
            ...(produced.get(state.propId) ?? []),
          ];
          const satisfied = before.some((stateText) => preconditions.includes(stateText));
          if (!satisfied) {
            issues.push({
              code: "CAUSALITY.PRECONDITION_MISSING",
              severity: beat.required ? "error" : "warning",
              entityId: beat.id,
              label: "Causal precondition missing",
              detail: `${nameOf(state.propId)} → "${state.state}" in ${shot.label} requires prior ${preconditions.join(" or ")}, but none is recorded before this beat.`,
              detailZh: `镜头「${shot.label}」中 ${nameOf(state.propId)} 要变为“${state.state}”，需先满足 ${preconditions.join(" 或 ")}，但这一拍之前没有记录任何前置状态。`,
            });
          }
        }
        // 更新已产生状态
        const list = produced.get(state.propId) ?? [];
        list.push(state.state);
        produced.set(state.propId, list);
      }
    }
  }

  return issues;
}

/**
 * Technical 组检查（P0.5）：
 * 1. 场景环境锁定未开启 / 天气缺失（原 V0.1 兼容层移入引擎）
 * 2. 镜头缺相机/镜头型号 → warning
 * 3. 技术 Profile 未配置 → info（可一键应用默认 photoreal）
 * 4. 负面提示词为空 → warning（可一键使用默认）
 */
export function checkTechnical(project: ProjectV2, scene: SceneV2, _options: ContinuityCheckOptions = {}): ContinuityIssueV2[] {
  const issues: ContinuityIssueV2[] = [];
  if (!scene.environmentLock) {
    issues.push({
      code: "SCENE.ENVIRONMENT_UNLOCKED",
      severity: "warning",
      entityId: scene.id,
      label: "Environment lock",
      detail: "Environment lock has not been enabled; the model may drift the location across shots.",
      detailZh: "尚未开启环境锁定，模型可能会在不同镜头之间漂移场景地点。",
      fixLabel: "Enable environment lock",
    });
  }
  if (!scene.weather?.trim()) {
    issues.push({
      code: "SCENE.WEATHER_MISSING",
      severity: "warning",
      entityId: scene.id,
      label: "Weather",
      detail: "Weather is missing for this scene.",
      detailZh: "本场景缺少天气设定。",
    });
  }
  for (const shot of scene.shots) {
    if (!shot.camera && !shot.lensModel) {
      issues.push({
        code: "TECHNICAL.CAMERA_MISSING",
        severity: "warning",
        entityId: shot.id,
        label: "Camera model missing",
        detail: `Shot ${shot.label} has no camera / lens model; technical consistency cannot be locked.`,
        detailZh: `镜头「${shot.label}」未设置相机/镜头型号，无法锁定技术一致性。`,
      });
    }
  }
  const profile = project.technicalProfile;
  const profileConfigured = profile && (profile.format || profile.cinematography?.length || profile.lighting?.length || profile.filmStock);
  if (!profileConfigured) {
    issues.push({
      code: "TECHNICAL.PROFILE_MISSING",
      severity: "info",
      entityId: scene.id,
      label: "Technical profile",
      detail: "No technical profile configured; output relies on the master style only.",
      detailZh: "未配置技术 Profile，编译输出将仅依赖大师风格。",
      fixLabel: "Apply default photoreal profile",
    });
  }
  if (!project.negativePrompt?.trim()) {
    issues.push({
      code: "TECHNICAL.NEGATIVE_EMPTY",
      severity: "warning",
      entityId: scene.id,
      label: "Negative prompt",
      detail: "Negative prompt is empty; drift terms are not constrained.",
      detailZh: "负面提示词为空，漂移项未受约束。",
      fixLabel: "Use default negative prompt",
    });
  }
  // 光线冲突（P1.1 验收 2）：阴天漫射 + 自定义"强硬阳光阴影" → warning
  if (profile?.lighting?.length) {
    const lightingText = profile.lighting.join(" ").toLowerCase();
    const diffuseSelected = /overcast|diffuse/i.test(lightingText);
    const hardSunMentioned = /hard sun|harsh sunlight|direct sun|strong sunlight/i.test(lightingText);
    if (diffuseSelected && hardSunMentioned) {
      issues.push({
        code: "LIGHTING.CONFLICT",
        severity: "warning",
        entityId: scene.id,
        label: "Lighting conflict",
        detail: "Overcast diffuse light is selected but the lighting notes mention hard sun shadows — these contradict each other.",
        detailZh: "已选择阴天漫射光，但光线备注中提到了强烈日光的硬阴影——两者相互矛盾。",
      });
    }
  }
  // 胶片低照度提示（P1.1 验收 3）：Kodak 500T + 纯强日光 → info 仅提示
  const film = presetById(FILM_PRESETS, profile?.filmStock);
  if (film?.id === "kodak-500t" && profile?.lighting?.length) {
    const lightingText = profile.lighting.join(" ").toLowerCase();
    if (/sunny|bright daylight|direct sunlight|high-key/i.test(lightingText)) {
      issues.push({
        code: "FILM.LOWLIGHT_NOTE",
        severity: "info",
        entityId: scene.id,
        label: "Film stock vs daylight",
        detail: `${film.zh} is tungsten/low-light biased; bright daylight will shift color temperature. Consider a daylight-balanced stock or corrective grade.`,
        detailZh: `${film.zh} 偏钨丝灯/低照度特性；强日光会导致色温偏移。建议改用日光平衡胶片或做校色处理。`,
      });
    }
  }
  // P1 光学：长镜头下统一 FOV 被逐镜覆写 → warning
  const opticsShots = scene.shots.filter((shot) => shot.optics);
  if (scene.shootingMode === "long-take" && opticsShots.length > 0) {
    const first = opticsShots[0].optics!;
    const unifiedFov = lensById(first.lensCharacter)?.fov ?? first.fieldOfViewDegrees;
    if (unifiedFov != null) {
      for (const shot of opticsShots.slice(1)) {
        const o = shot.optics!;
        const fov = lensById(o.lensCharacter)?.fov ?? o.fieldOfViewDegrees;
        if (fov != null && fov !== unifiedFov) {
          issues.push({
            code: "OPTICS.FOV_OVERRIDDEN",
            severity: "warning",
            entityId: shot.id,
            label: "FOV overridden in long take",
            detail: `Long-take mode unifies ${unifiedFov}°; shot ${shot.label} overrides to ${fov}°.`,
            detailZh: `长镜头模式统一为 ${unifiedFov}°；镜头「${shot.label}」覆写为 ${fov}°。`,
          });
        }
      }
    }
  }

  // P1 相机：手持质感写了数字抖动/随机晃动/稳定器平滑 → warning
  const HANDHELD_DIGITAL_RE = /\b(digital jitter|random shake|gimbal smoothness|gimbal[- ]smooth|digital shake|shaky[ -]?cam)\b/i;
  for (const shot of scene.shots) {
    const hq = shot.cameraBehavior?.handheldQuality?.trim();
    if (hq && HANDHELD_DIGITAL_RE.test(hq)) {
      const hit = hq.match(HANDHELD_DIGITAL_RE);
      issues.push({
        code: "CAMERA.HANDHELD_DIGITAL",
        severity: "warning",
        entityId: shot.id,
        label: "Digital handheld term",
        detail: `Handheld quality should describe physical operator behavior (operator breath, micro-settling, weight shift), not "${hit?.[1] ?? "digital jitter"}".`,
        detailZh: `手持质感应描述摄影师的身体操作（呼吸、轻微沉降、重心转移），而不是“${hit?.[1] ?? "digital jitter"}”。`,
      });
    }
  }

  // P3 光学：只写了品牌/焦距，没给镜头语言（FOV）→ info，引导用可观测结果表达
  for (const shot of scene.shots) {
    const hasFov = Boolean(shot.optics?.lensCharacter || shot.optics?.fieldOfViewDegrees);
    const brandText = shot.lensModel?.trim() || shot.lens?.trim();
    if (brandText && !hasFov) {
      issues.push({
        code: "OPTICS.BRAND_AS_PRIMARY",
        severity: "info",
        entityId: shot.id,
        label: "Brand / focal length without FOV",
        detail: `Shot ${shot.label} declares gear ("${brandText}") but no lens character / FOV; give an observable lens language (47°/84°/107°/29°/18°/8°/135°) instead.`,
        detailZh: `镜头「${shot.label}」只写了器材（“${brandText}”），没有给出镜头语言/视场角；请改用可观测的镜头语言（47°/84°/107°/29°/18°/8°/135°）。`,
      });
    }
  }

  // P3 光学：同一镜头「镜头语言」与画面内容类别互斥（近距离特写 vs 大环境运动）
  const LENS_CLASSES = new Map(LENS_BANK.map((lens) => [lens.id, lens.contentClasses]));
  const CONTENT_SIGNALS: Record<LensContentClass, RegExp> = {
    "face-portrait": /(extreme\s*)?close[- ]?up|portrait|特写|肖像|面部|面孔/i,
    "detail-closeup": /insert|macro|手部|手指|眼部|细节/i,
    "environment-action": /wide|establishing|全景|远景|广角|环境|运动|行走|奔跑|walk|run|tracking|跟随|跟拍/i,
    "distant-observation": /observ|vantage|窥视|远观|远处|极远/i,
  };
  const narrowOf = (set: Set<LensContentClass>) => set.has("face-portrait") || set.has("detail-closeup");
  const broadOf = (set: Set<LensContentClass>) => set.has("environment-action") || set.has("distant-observation");
  for (const shot of scene.shots) {
    const declared = new Set<LensContentClass>(shot.optics?.lensCharacter ? LENS_CLASSES.get(shot.optics.lensCharacter) ?? [] : []);
    if (declared.size === 0) continue;
    const text = `${shot.framing} ${shot.lens ?? ""} ${shot.movement} ${shot.action} ${(shot.beats ?? []).map((beat) => `${beat.verb} ${beat.actionText ?? ""}`).join(" ")}`;
    const derived = new Set<LensContentClass>();
    for (const cls of Object.keys(CONTENT_SIGNALS) as LensContentClass[]) {
      if (CONTENT_SIGNALS[cls].test(text)) derived.add(cls);
    }
    if (derived.size === 0) continue;
    const mismatch = (narrowOf(declared) && !broadOf(declared) && broadOf(derived) && !narrowOf(derived)) ||
      (broadOf(declared) && !narrowOf(declared) && narrowOf(derived) && !broadOf(derived));
    if (mismatch) {
      issues.push({
        code: "OPTICS.MIXED_CONTENT_CLASS",
        severity: "warning",
        entityId: shot.id,
        label: "Lens conflicts with content class",
        detail: `Shot ${shot.label} locks a ${shot.optics?.lensCharacter ?? ""} lens but the frame content reads as the opposite class; one shot should commit to one content class so the lens outcome stays observable.`,
        detailZh: `镜头「${shot.label}」锁定了 ${shot.optics?.lensCharacter ?? ""} 镜头，但画面内容属于相反类别；单个镜头应专注一种内容类别，镜头语言的结果才可观测。`,
        fixLabel: "Re-pick lens by content class",
      });
    }
  }

  // P3 光线：技术 Profile 配置了光线词条，但场景没有结构化光向 → 模型无法稳定锁光
  if ((profile?.lighting ?? []).some((item) => item.trim()) && !scene.lightingDirection?.direction?.trim()) {
    issues.push({
      code: "LIGHTING.DIRECTION_MISSING",
      severity: "warning",
      entityId: scene.id,
      label: "Lighting direction missing",
      detail: "Technical profile configures lighting but the scene has no structured light direction; the model may guess key/side/back placement per shot.",
      detailZh: "技术 Profile 配置了光线词条，但场景没有结构化光线方向；模型可能每镜乱猜主光/侧光/轮廓光的位置。",
      fixLabel: "Set lighting direction",
    });
  }

  // P3 物理：跑/走类动作缺地面接触锚点 → info，提示勾选物理锚点
  const GAIT_VERB_RE = /(?:walk(?:ing)?|step(?:s|ping)?|stumbl|run(?:ning)?|sprint|dash|pace|stride|走|跑|奔|踱|迈步)/i;
  for (const shot of scene.shots) {
    const hasGait = (shot.beats ?? []).some((beat) => GAIT_VERB_RE.test(`${beat.verb} ${beat.actionText ?? ""}`));
    const anchors = new Set((shot.physicsAnchors ?? []).map((anchor) => anchor.kind));
    if (hasGait && !anchors.has("walk") && !anchors.has("run")) {
      issues.push({
        code: "PHYSICS.GROUND_CONTACT",
        severity: "info",
        entityId: shot.id,
        label: "Gait without ground-contact anchor",
        detail: `Shot ${shot.label} contains walk/run motion but no ground-contact physics anchor; add one so the model keeps weight and inertia on the floor.`,
        detailZh: `镜头「${shot.label}」有走/跑动作，但缺少地面接触物理锚点；请勾选，让模型保持落地重量与惯性。`,
      });
    }
  }

  return issues;
}

/**
 * Audio 组检查（P0.5/P1.3）：
 * 1. 无音频计划 → info（可一键创建默认）
 * 2. 有对白但字幕未开启 → info（可一键开启字幕）
 * 3. SFX 字段误填画内音乐（boombox beat 等）→ warning（可一键移动到画内音乐）
 * 4. 画内音乐来源道具不存在 → warning
 */
export function checkAudio(project: ProjectV2, scene: SceneV2, _options: ContinuityCheckOptions = {}): ContinuityIssueV2[] {
  const issues: ContinuityIssueV2[] = [];
  const audio = project.audioPlan;
  const hasDialogue = scene.shots.some((shot) => (shot.beats ?? []).some((beat) => beat.dialogue?.trim()));
  // P3 音频：有对白的角色缺声音锁 → info（母版/声音锁在 P2/P5 资产侧，可一键补）
  if (hasDialogue) {
    const voiceByCharacter = new Map(
      (project.assets ?? [])
        .filter((asset) => asset.kind === "character")
        .map((asset) => [asset.id, Boolean(asset.actingProfile?.voicePrompt?.trim() || asset.actingProfile?.voicePromptZh?.trim())])
    );
    const speakerIds = new Set<string>();
    for (const shot of scene.shots ?? []) {
      for (const beat of shot.beats ?? []) {
        if (beat.dialogue?.trim() && beat.actorId) speakerIds.add(beat.actorId);
      }
    }
    for (const speakerId of speakerIds) {
      if (!voiceByCharacter.has(speakerId)) continue; // 非角色资产引用的对白不在此组
      if (voiceByCharacter.get(speakerId)) continue;
      issues.push({
        code: "AUDIO.VOICE_PROMPT_OMITTED",
        severity: "info",
        entityId: speakerId,
        label: "Speaking character has no voice lock",
        detail: `Character ${speakerId} speaks in this scene but has no voicePrompt; the audio section cannot paste a per-word voice lock.`,
        detailZh: `角色 ${speakerId} 在本场景有台词，但资产没有声音锁（voicePrompt），音频段无法逐字粘贴声音锁定。`,
        fixLabel: "Add voice lock",
      });
    }
  }
  // P3 对白：有台词的镜头缺「只念台词/他人闭嘴」锁 → info
  const LIPS_RULE_RE = /只念台词|只说台词|他人闭嘴|他人不出声|其他人安静|mouth only|only the line|others? (?:stay|remain|keep) silent|no one else speaks/i;
  for (const shot of scene.shots ?? []) {
    const dialogue = (shot.beats ?? []).filter((beat) => beat.dialogue?.trim());
    if (dialogue.length === 0) continue;
    const notes = `${shot.note ?? ""} ${dialogue.map((beat) => `${beat.note ?? ""} ${beat.reactionBeforeLine ?? ""}`).join(" ")}`;
    if (!LIPS_RULE_RE.test(notes)) {
      issues.push({
        code: "DIALOGUE.LIPS_RULE",
        severity: "info",
        entityId: shot.id,
        label: "Dialogue lacks lips rule",
        detail: `Shot ${shot.label} has dialogue but no "speak only the line / others stay silent" lock; the model may add off-script mouthing.`,
        detailZh: `镜头「${shot.label}」有台词，但缺少“只念台词/他人闭嘴”锁；模型可能会多出剧本外的口型动作。`,
      });
    }
    const timingNotes = `${shot.note ?? ""} ${dialogue.map((beat) => beat.note ?? "").join(" ")}`;
    if (!/静默|沉默|停顿|前 ?1 ?秒|后 ?1 ?秒|即时|立刻|0\.3 ?秒|immediate|instant|silence|pause|within 0\.3|0\.3 second/i.test(timingNotes)) {
      issues.push({
        code: "DIALOGUE.TIMING_UNSPECIFIED",
        severity: "info",
        entityId: shot.id,
        label: "Dialogue timing unspecified",
        detail: `Shot ${shot.label} has lines but no silence / immediate-open rule; default to 1s silence before a slow line and ≤0.3s for an urgent reply.`,
        detailZh: `镜头「${shot.label}」有台词，但缺少静默/即时开口规则；请写明：缓缓开口前静默 1 秒，急迫接话在 0.3 秒内。`,
      });
    }
  }
  if (!audio) {
    issues.push({
      code: "AUDIO.PLAN_MISSING",
      severity: "info",
      entityId: scene.id,
      label: "Audio plan",
      detail: "No audio plan configured; diegetic music, SFX and score are unspecified.",
      detailZh: "未配置音频计划；画内音乐、环境音效和配乐均未指定。",
      fixLabel: "Create default audio plan",
    });
    return issues;
  }
  if (hasDialogue && audio.subtitles === false) {
    issues.push({
      code: "AUDIO.DIALOGUE_UNSUBTITLED",
      severity: "info",
      entityId: scene.id,
      label: "Dialogue subtitles",
      detail: "Beats contain dialogue but subtitles are off.",
      detailZh: "节拍中包含对白，但字幕已关闭。",
      fixLabel: "Enable subtitles",
    });
  }
  // P1.3 冲突规则：SFX 字段含音乐类词 → 属于画内音乐而非 SFX
  const MUSIC_TOKENS = ["boombox", "beat", "radio", "band", "music", "playback", "jingle", "melody"];
  const musicLikeSfx = (audio.sfx ?? []).find((sfx) => MUSIC_TOKENS.some((token) => sfx.toLowerCase().includes(token)));
  if (musicLikeSfx) {
    issues.push({
      code: "AUDIO.CONFLICT",
      severity: "warning",
      entityId: scene.id,
      label: "Music mislabeled as SFX",
      detail: `"${musicLikeSfx}" 属于画内音乐（diegetic music）而非 SFX。建议编译为：Diegetic music + SFX only; no non-diegetic score; no subtitles.`,
      detailZh: `“${musicLikeSfx}”属于画内音乐而非环境音效（SFX），请移到画内音乐列，避免被编译成杂音效果。`,
      fixLabel: "Move to diegetic music",
    });
  }
  // 来源道具存在性
  if (audio.musicSourcePropId && !(project.assets ?? []).some((asset) => asset.id === audio.musicSourcePropId)) {
    issues.push({
      code: "AUDIO.SOURCE_MISSING",
      severity: "warning",
      entityId: scene.id,
      label: "Music source missing",
      detail: `Diegetic music source asset ${audio.musicSourcePropId} does not exist in the asset library.`,
      detailZh: `画内音乐的来源道具 ${audio.musicSourcePropId} 在资产库中不存在。`,
    });
  }
  return issues;
}

/**
 * Acting 组检查（P5.3）：仅当角色有表演母版时触发，校验母版结构质量与声音锁完整性。
 * 全为 warning / info 级：不阻塞导出，只给出可执行修复建议。
 */
export function checkActing(project: ProjectV2, scene: SceneV2, _options: ContinuityCheckOptions = {}): ContinuityIssueV2[] {
  const issues: ContinuityIssueV2[] = [];
  const characters = (project.assets ?? []).filter((asset) => asset.kind === "character");
  const speakers = new Set<string>();
  for (const shot of scene.shots ?? []) {
    for (const beat of shot.beats ?? []) {
      if (beat.dialogue?.trim() && beat.actorId) speakers.add(beat.actorId);
    }
  }

  for (const asset of characters) {
    const prof = asset.actingProfile;
    const masterEn = prof?.masterProfile?.trim() ?? "";
    const masterZh = prof?.masterProfileZh?.trim() ?? "";
    const master = `${masterEn}\n${masterZh}`;
    if (!master.trim()) continue;

    // MASK_NO_CRACK：压力裂缝（However, when X… / 然而，当 X…）缺失 → 冷静面具可能扁平
    if (!/however\s*,?\s*when|但当|但是当|然而[,，]?\s*当|一旦/i.test(master)) {
      issues.push({
        code: "ACTING.MASK_NO_CRACK",
        severity: "warning",
        entityId: asset.id,
        label: "Acting mask without crack",
        detail: `Character ${asset.name} master profile lacks a "However, when X…" mask+crack; the calm mask may read as flat.`,
        detailZh: `角色「${asset.name}」的表演母版缺少“然而，当 X……时”的面具+裂缝结构，冷静面具可能显得扁平。`,
        fixLabel: "Add mask + crack",
      });
    }

    // TIC_NO_TRIGGER：出现习惯/抽动词，却没有任何触发条件
    const hasTic = /习惯|抽动|抽搐|抖动|下意识|habit|tic|twitch|fidget|compulsiv/i.test(master);
    const hasTrigger = /当|每当|每逢|一旦|触发|when(ever)?|once|if|trigger|每逢/i.test(master);
    if (hasTic && !hasTrigger) {
      issues.push({
        code: "ACTING.TIC_NO_TRIGGER",
        severity: "warning",
        entityId: asset.id,
        label: "Habit / tic without trigger",
        detail: `Character ${asset.name} master profile mentions a habit or tic without a trigger condition.`,
        detailZh: `角色「${asset.name}」的表演母版提到了习惯/抽动，但没有给出触发条件。`,
        fixLabel: "Add trigger",
      });
    }

    // WARDROBE_IN_PROFILE：母版混入服装 / 相机 / 色彩（应归到描述或技术段）
    if (/相机|镜头|景别|焦距|焦段|色彩|色调|服装|衬衫|西装|外套|领带|裤|裙|鞋|帽|camera|lens|framing|focal|\bmm\b|costume|outfit|wardrobe|suit|shirt|dress|pants|shoes/i.test(master)) {
      issues.push({
        code: "ACTING.WARDROBE_IN_PROFILE",
        severity: "info",
        entityId: asset.id,
        label: "Wardrobe / camera in profile",
        detail: `Character ${asset.name} master profile mixes wardrobe / camera / color wording; move it to the description or technical section.`,
        detailZh: `角色「${asset.name}」的表演母版混入了服装/相机/色彩的描述，请移到资产描述或技术段落。`,
      });
    }

    // SCALE_BELOW_TARGET：表演目标分（0–5）过低，难以产出可被镜头捕捉的立体表演
    const target = prof?.performanceTarget;
    if (target != null && target <= 2) {
      issues.push({
        code: "ACTING.SCALE_BELOW_TARGET",
        severity: "warning",
        entityId: asset.id,
        label: "Performance target too low",
        detail: `Character ${asset.name} performance target is ${target} (scale 0-5). Target should be ≥4 for a camera-readable performance; raise it or strengthen the master profile.`,
        detailZh: `角色「${asset.name}」的表演目标为 ${target}（0–5 分制）。要产出镜头可读的表演，目标应 ≥4；请调高评分或强化表演母版。`,
        fixLabel: "Raise to ≥4",
      });
    }

    // VOICE_LOCK_MISSING：讲话角色缺声音锁
    if (speakers.has(asset.id)) {
      const hasVoice = Boolean(prof?.voicePrompt?.trim() || prof?.voicePromptZh?.trim());
      if (!hasVoice) {
        issues.push({
          code: "ACTING.VOICE_LOCK_MISSING",
          severity: "warning",
          entityId: asset.id,
          label: "Voice lock missing",
          detail: `Character ${asset.name} has dialogue but no voice lock (voicePrompt).`,
          detailZh: `角色「${asset.name}」有对白，但缺少声音锁（voicePrompt）。`,
          fixLabel: "Add voice lock",
        });
      }
    }
  }

  // ── P2 表演质量组：仅在场景显式填写了 P2 结构化表演字段时触发，
  //    避免只有旧版 acting 自由文本的项目误报 ──────────
  const hasActingInput =
    (scene.actingObjectives ?? []).length > 0 ||
    scene.shots?.some((shot) =>
      Boolean(shot.eyeLife?.trim()) ||
      shot.performanceLevel != null ||
      shot.beats?.some((beat) => beat.tactic?.trim() || beat.subtext?.trim() || beat.beatChange?.trim() || beat.reactionBeforeLine?.trim()));
  if (!hasActingInput) return issues;

  // 场景表演目标解析：画面内主要角色是否有目的/阻碍/代价
  const objectiveByCharacter = new Map((scene.actingObjectives ?? []).map((objective) => [objective.characterId, objective]));
  const scenePrimary = new Set<string>();
  for (const shot of scene.shots ?? []) {
    for (const participant of shot.participants ?? []) {
      if (participant.role === "primary" || participant.role === "target") scenePrimary.add(participant.characterId);
    }
  }
  if (scenePrimary.size > 0) {
    for (const characterId of scenePrimary) {
      const objective = objectiveByCharacter.get(characterId);
      const hasObjective = Boolean(objective?.objective?.trim());
      const hasObstacle = Boolean(objective?.obstacle?.trim());
      const hasStakes = Boolean(objective?.stakes?.trim());
      if (!hasObjective) {
        issues.push({
          code: "ACTING.OBJECTIVE_MISSING",
          severity: "warning",
          entityId: characterId,
          label: "Character objective missing",
          detail: `Primary character ${characterId} has no acting objective; performance has no pressure or direction.`,
          detailZh: `主要角色 ${characterId} 没有表演目的，表演会缺少压力和方向。`,
          fixLabel: "Write a verb objective",
        });
      } else if (!hasObstacle || !hasStakes) {
        issues.push({
          code: "ACTING.OBSTACLE_OR_STAKES_MISSING",
          severity: "info",
          entityId: characterId,
          label: "Obstacle / stakes missing",
          detail: `Character ${characterId} has an objective but ${!hasObstacle ? "no obstacle" : "no stakes"}; tension is flat.`,
          detailZh: `角色 ${characterId} 已有表演目的，但${!hasObstacle ? "缺少阻碍" : "缺少失败代价"}，张力不足。`,
          fixLabel: "Add obstacle and stakes",
        });
      }
    }
  }

  // 节拍质量：策略/节拍变化/反应/潜台词
  for (const shot of scene.shots ?? []) {
    const beats = (shot.beats ?? []).filter((beat) => beat.verb || beat.actionText?.trim());
    const tactics = new Set(beats.map((beat) => beat.tactic?.trim().toLowerCase()).filter(Boolean));
    const changes = beats.filter((beat) => beat.beatChange?.trim() || beat.tactic?.trim()).length;
    const hasDialogue = beats.some((beat) => beat.dialogue?.trim());

    if (tactics.size > 0 && tactics.size < 2) {
      issues.push({
        code: "ACTING.TACTIC_MONO",
        severity: "warning",
        entityId: shot.id,
        label: "Monotactic scene",
        detail: `Shot ${shot.label} uses a single tactic across all beats; acting reads as one color. Give each beat a contrasting tactic verb.`,
        detailZh: `镜头「${shot.label}」的所有节拍都使用同一策略，表演显得单一。请为每个节拍搭配不同的策略动词。`,
        fixLabel: "Vary tactics per beat",
      });
    }
    if (beats.length >= 2 && changes === 0) {
      issues.push({
        code: "ACTING.BEATS_FLAT",
        severity: "warning",
        entityId: shot.id,
        label: "Beats flat",
        detail: `Shot ${shot.label} has ${beats.length} beats but no visible beat change (tactic / posture / tempo / gaze); performance stays static.`,
        detailZh: `镜头「${shot.label}」有 ${beats.length} 个节拍，但没有可见的节拍变化（策略/姿态/节奏/视线），表演会显得静止。`,
        fixLabel: "Add 2-4 visible beat changes",
      });
    }
    if (hasDialogue && beats.every((beat) => !beat.reactionBeforeLine?.trim())) {
      issues.push({
        code: "ACTING.DEAD_PAUSE",
        severity: "info",
        entityId: shot.id,
        label: "Dead pause risk",
        detail: `Shot ${shot.label} has dialogue but no reaction that starts mid-line of the partner; silence may read as an empty wait.`,
        detailZh: `镜头「${shot.label}」有对白，但没有在对方台词结束前就开始的反应，静默可能被读作空洞等待。`,
        fixLabel: "Write reaction before the line ends",
      });
    }
    if (hasDialogue && beats.every((beat) => !beat.subtext?.trim())) {
      issues.push({
        code: "ACTING.SUBTEXT_MISSING",
        severity: "info",
        entityId: shot.id,
        label: "Subtext missing",
        detail: `Shot ${shot.label} has lines but no subtext; dialogue risks being literal. Write what the character actually wants beneath the words.`,
        detailZh: `镜头「${shot.label}」有台词但没有潜台词，对白容易显得直白。请写出角色在话语之下真正想要的东西。`,
        fixLabel: "Add subtext",
      });
    }
  }

  // 眼部生活：镜头有表演描述但无眼部内容
  for (const shot of scene.shots ?? []) {
    const hasPerformance = (shot.acting?.trim() ?? "") !== "" || (shot.beats ?? []).some((beat) => beat.actionText?.trim() || beat.tactic?.trim());
    const hasEyeLife = Boolean(shot.eyeLife?.trim()) || /眼|扫视|眨眼|瞳光|视线先|目光|eye|blink|saccade|gaze|catchlight/i.test(
      `${shot.acting ?? ""} ${(shot.beats ?? []).map((beat) => beat.actionText ?? "").join(" ")} ${(shot.beats ?? []).map((beat) => beat.beatChange ?? "").join(" ")}`
    );
    if (hasPerformance && !hasEyeLife) {
      issues.push({
        code: "ACTING.EYE_LIFE_MISSING",
        severity: "warning",
        entityId: shot.id,
        label: "Eye life missing",
        detail: `Shot ${shot.label} contains performance description but no eye life (saccades / blink quality / catchlights / eyes leading the turn); AI faces risk dead eyes.`,
        detailZh: `镜头「${shot.label}」有表演描述但缺少眼部生活（微扫视/眨眼质感/眼神高光/视线带动转头），AI 生成的面孔有“死眼”风险。`,
        fixLabel: "Add eye life",
      });
    }
  }

  // 状态非过渡：把过程写成状态 → 过渡动词链
  for (const shot of scene.shots ?? []) {
    const actionText = (shot.beats ?? []).map((beat) => beat.actionText?.trim() ?? "").join(" ");
    const chain = /reaches into|pulls out|winds up|prepares to|starts to|begins to|走向|伸手|掏出|准备|开始|酝酿|抬手准备|弯腰去拿/i.exec(actionText)?.[0];
    if (chain) {
      issues.push({
        code: "ACTING.TRANSITION_CHAIN",
        severity: "info",
        entityId: shot.id,
        label: "Transition chain written as process",
        detail: `Shot ${shot.label} describes a transition ("${chain}") instead of a mid-action state; the model films states, not processes.`,
        detailZh: `镜头「${shot.label}」把过渡写成了过程（“${chain}”）；模型拍的是状态而非过程，请改写为动作进行中的状态。`,
        fixLabel: "Rewrite as mid-action state",
      });
    }
  }

  // 群像同步反应：所有参与者给出完全相同动作/时间
  for (const shot of scene.shots ?? []) {
    const participants = shot.participants ?? [];
    const ensembleBeats = (shot.beats ?? []).filter((beat) => participants.some((p) => p.characterId === beat.actorId));
    if (participants.length >= 2 && ensembleBeats.length >= 2) {
      const verbs = ensembleBeats.map((beat) => beat.verb).filter(Boolean);
      const allSame = verbs.length === ensembleBeats.filter((beat) => beat.verb).length && new Set(verbs).size === 1;
      const allSameAction = new Set(ensembleBeats.map((beat) => beat.actionText?.trim() ?? "").filter(Boolean)).size <= 1 && ensembleBeats.some((beat) => beat.actionText?.trim());
      if (allSame || allSameAction) {
        issues.push({
          code: "ACTING.ENSEMBLE_SYNC",
          severity: "warning",
          entityId: shot.id,
          label: "Synchronized ensemble",
          detail: `Shot ${shot.label} gives every ensemble participant the same action/time; real groups react in staggered waves with different intensities.`,
          detailZh: `镜头「${shot.label}」让所有群演在同一时间做出相同动作；真实的群戏反应是错落的、强度各不相同的。`,
          fixLabel: "Stagger reactions in a wave",
        });
      }
    }
  }

  // 表演评分 <4：AI 自评低于目标
  for (const shot of scene.shots ?? []) {
    if (shot.performanceLevel != null && shot.performanceLevel < 4) {
      issues.push({
        code: "ACTING.SCALE_BELOW_TARGET",
        severity: "warning",
        entityId: shot.id,
        label: "Performance below target",
        detail: `Shot ${shot.label} self-assesses at ${shot.performanceLevel}/5; target is ≥4. Rewrite the acting and beat detail before export.`,
        detailZh: `镜头「${shot.label}」自评表演为 ${shot.performanceLevel}/5 分，目标应 ≥4。导出前请重写表演与节拍细节。`,
        fixLabel: "Rewrite to ≥4",
      });
    }
  }

  // 表演模版外情绪词：indication（面具式表情展示）
  const INDICATION_WORDS = /蹙眉|挑眉|瞪大眼睛|挤眉|咧嘴|做苦脸|grimac|arched brow|mugging|depict|pantomime|make a face|exaggerated face/i;
  for (const shot of scene.shots ?? []) {
    const actingText = `${shot.acting ?? ""} ${shot.eyeLife ?? ""} ${(shot.beats ?? []).map((beat) => beat.actionText ?? "").join(" ")}`;
    if (INDICATION_WORDS.test(actingText) && !/目|眼|扫视|眨眼|瞳光|eye|blink|saccade|gaze|catchlight/i.test(actingText)) {
      issues.push({
        code: "ACTING.INDICATION",
        severity: "info",
        entityId: shot.id,
        label: "Face depicts emotion",
        detail: `Shot ${shot.label} uses face-mugging / indication wording without eye life; emotion is being displayed rather than produced by pressure.`,
        detailZh: `镜头「${shot.label}」使用了面具式表情/指示性措辞且没有眼部生活；情绪是被“演出来”的，而不是由压力自然催生的。`,
        fixLabel: "Write objective + give the hands business",
      });
    }
  }

  // 强事件后瞬间恢复：emotional reset
  for (let i = 0; i < (scene.shots ?? []).length - 1; i++) {
    const shot = scene.shots[i];
    const next = scene.shots[i + 1];
    const strongEvent = /崩溃|痛哭|爆炸|枪|倒下|尖叫|震怒|夺门|breakdown|sobbing|explosion|gunshot|collaps|scream|rage|slams/i.test(
      `${shot.acting ?? ""} ${(shot.beats ?? []).map((beat) => beat.actionText ?? "").join(" ")}`
    );
    const instantRecover = next.beats?.some((beat) => /恢复正常|若无其事|微笑|从容|镇定|平静|smil|composed|calm|serene|cheerful/i.test(
      `${beat.actionText ?? ""} ${beat.note ?? ""}`
    ));
    if (strongEvent && instantRecover) {
      issues.push({
        code: "ACTING.EMOTIONAL_RESET",
        severity: "warning",
        entityId: next.id,
        label: "Emotional reset after strong event",
        detail: `Shot ${next.label} instantly recovers after a strong event in ${shot.label}; states carry inertia and the trail must persist into the next beat.`,
        detailZh: `镜头「${next.label}」在镜头「${shot.label}」的强事件后立刻恢复正常；状态有惯性，情绪余波必须延续到下一节拍。`,
        fixLabel: "Carry the state into the next beat",
      });
    }
  }

  return issues;
}

/**
 * Context 组检查（P3）：
 * 1. CONTEXT.STALE_TAG（error）：镜头自由文本里的 @资产引用必须在本镜活动引用集合内，
 *    否则场景级资产段会把本镜不用的 @tag 带进编译产物。
 * 2. CONTEXT.SCENE_NUMBER（error）：场景自由文本 / 导演层不得出现“场景 01 / shot 3”式的编号。
 */
export function checkContext(project: ProjectV2, scene: SceneV2, _options: ContinuityCheckOptions = {}): ContinuityIssueV2[] {
  const issues: ContinuityIssueV2[] = [];
  const assets = project.assets ?? [];

  // 1. 陈旧 @tag：本镜文本提到 @资产，但该资产不在本镜活动集合
  const activeIds = (shot: SceneV2["shots"][number]) => {
    const set = new Set<string>();
    for (const participant of shot.participants ?? []) set.add(participant.characterId);
    for (const beat of shot.beats ?? []) {
      if (beat.actorId) set.add(beat.actorId);
      if (beat.targetCharacterId) set.add(beat.targetCharacterId);
      if (beat.targetPropId) set.add(beat.targetPropId);
    }
    for (const state of shot.propStatesAtStart ?? []) set.add(state.propId);
    for (const state of shot.propStatesAtEnd ?? []) set.add(state.propId);
    if (scene.staging?.locationAssetId) set.add(scene.staging.locationAssetId);
    return set;
  };
  const textFields = (shot: SceneV2["shots"][number]) => [
    shot.action,
    shot.acting,
    shot.note,
    shot.layout?.anchorDescription,
    shot.layout?.axisNote,
    ...(shot.beats ?? []).flatMap((beat) => [beat.actionText, beat.dialogue, beat.note, beat.subtext, beat.beatChange]),
  ].filter((text): text is string => Boolean(text?.trim()));

  for (const shot of scene.shots ?? []) {
    const active = activeIds(shot);
    const texts = textFields(shot);
    const stale: string[] = [];
    for (const asset of assets) {
      if (active.has(asset.id)) continue;
      const name = asset.name.trim().toLowerCase();
      if (!name) continue;
      if (texts.some((text) => text.toLowerCase().includes(`@${name}`))) stale.push(asset.name);
    }
    if (stale.length > 0) {
      issues.push({
        code: "CONTEXT.STALE_TAG",
        severity: "error",
        entityId: shot.id,
        label: "Stale @asset tag",
        detail: `Shot ${shot.label} mentions ${stale.join(", ")} but none of them is active in this shot; the compiled asset section would pull an unused @tag. Remove the mention or move it to a shot where the asset actually appears.`,
        detailZh: `镜头「${shot.label}」提到了 ${stale.join("、")}，但它们都不是本镜的活动引用；编译出的资产段会把没用的 @tag 带进这个镜头。请删除该引用，或把它移到真正出现该资产的镜头。`,
      });
    }
  }

  // 2. 场景编号泄漏：场景自由文本及导演层不得出现编号式标签
  const SCENE_NUMBER_RE = /(?:场景|场地|scene|shot|cut)[\s:：]*[0-9０-９]{1,3}/i;
  const fields: { id: string; text: string; field: string }[] = [
    { id: scene.id, text: scene.name, field: "scene.name" },
    { id: scene.id, text: scene.logline, field: "logline" },
    { id: scene.id, text: scene.staging?.priorContext ?? "", field: "priorContext" },
    { id: scene.id, text: scene.emotionArc ?? "", field: "emotionArc" },
  ];
  for (const [key, value] of Object.entries(scene.directorLayers ?? {})) {
    if (value?.trim()) fields.push({ id: scene.id, text: value, field: `directorLayers.${key}` });
  }
  const hit = fields.find((field) => SCENE_NUMBER_RE.test(field.text));
  if (hit) {
    const matched = SCENE_NUMBER_RE.exec(hit.text)?.[0] ?? "";
    issues.push({
      code: "CONTEXT.SCENE_NUMBER",
      severity: "error",
      entityId: hit.id,
      label: "Scene number leaked",
      detail: `Field "${hit.field}" contains numbering ("${matched}"); compiled prompts must not carry labels like 场景 01 / shot 3.`,
      detailZh: `字段「${hit.field}」含有编号（“${matched}”）；编译产物不允许出现“场景 01 / shot 3”这类标签。`,
    });
  }

  return issues;
}

/** 风险等级 */
export function riskLevelOf(score: number): "low" | "medium" | "high" {
  if (score >= 7) return "high";
  if (score >= 3) return "medium";
  return "low";
}

/**
 * 风险评分（P0.5）：每镜头 0-10 分 + 整体分数
 * error=3 / warning=1.5 / info=0.5，封顶 10。
 */
export function computeRiskScores(project: ProjectV2, scene: SceneV2, options: ContinuityCheckOptions = {}): { perShot: Map<string, ShotRisk>; overall: ShotRisk } {
  const issues = checkContinuityV2(project, scene, options);
  const scoreOf = (list: ContinuityIssueV2[]) => Math.min(10, list.reduce((sum, issue) => sum + (issue.severity === "error" ? 3 : issue.severity === "warning" ? 1.5 : 0.5), 0));
  const perShot = new Map<string, ShotRisk>();
  for (const shot of scene.shots) {
    const shotIssues = issues.filter((issue) => issue.entityId === shot.id || issue.entityId === scene.id);
    const score = scoreOf(shotIssues);
    perShot.set(shot.id, {
      shotId: shot.id,
      score: Math.round(score * 10) / 10,
      level: riskLevelOf(score),
      reasons: shotIssues.map((issue) => issue.code),
      suggestion: shotIssues.filter((issue) => issue.severity === "error").length > 0
        ? "Resolve error-level issues before export."
        : "Acceptable; review warnings before final export.",
    });
  }
  const overallScore = scoreOf(issues);
  const overall: ShotRisk = {
    shotId: scene.id,
    score: Math.round(overallScore * 10) / 10,
    level: riskLevelOf(overallScore),
    reasons: issues.map((issue) => issue.code),
    suggestion: "Overall scene risk",
  };
  return { perShot, overall };
}

/** 规则组派发入口：P0.5 全部 6 组启用，P3 增加 Context */
export function checkContinuityV2(project: ProjectV2, scene: SceneV2, options: ContinuityCheckOptions = {}): ContinuityIssueV2[] {
  const groups = options.groups ?? ["identity", "spatial", "prop", "causality", "technical", "audio", "acting", "context"];
  const issues: ContinuityIssueV2[] = [];
  if (groups.includes("identity")) issues.push(...checkIdentity(project, scene, options));
  if (groups.includes("spatial")) issues.push(...checkSpatial(project, scene, options));
  if (groups.includes("prop")) issues.push(...checkProp(project, scene, options));
  if (groups.includes("causality")) issues.push(...checkCausality(project, scene, options));
  if (groups.includes("technical")) issues.push(...checkTechnical(project, scene, options));
  if (groups.includes("audio")) issues.push(...checkAudio(project, scene, options));
  if (groups.includes("acting")) issues.push(...checkActing(project, scene, options));
  if (groups.includes("context")) issues.push(...checkContext(project, scene, options));
  return issues;
}
