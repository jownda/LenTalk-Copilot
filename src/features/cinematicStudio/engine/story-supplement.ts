/**
 * 导演意图深化统一入口。
 * 「必须发生 / 禁止发生 / 对白 / 情绪走向 / 表演目标」五个旧字段已合并为一个
 * `directorIntentRefinement` 是 AI 对既有导演简报输入的可编辑深化结果。
 * 旧项目没有该字段时，兼容读取 `storyNotes` 与旧分散字段。
 */
import type { SceneV02 } from "../shared-types";

/** 从用户故事梗概中提取必须跨镜头继承的第一人称摄影机约束。 */
export interface FirstPersonPovLock {
  operatorName?: string;
  hideOperator: boolean;
}

export function extractFirstPersonPovLock(text?: string): FirstPersonPovLock | undefined {
  const source = text?.trim() ?? "";
  if (!/(?:第一人称|第一视角|主观(?:镜头|视角)|first[- ]person(?:\s+pov)?|\bpov\b)/i.test(source)) return undefined;
  const operatorName = source.match(/(?:全程|始终|一直|全片)?\s*([A-Za-z][A-Za-z0-9_-]{0,31}|[\u4e00-\u9fff]{2,8})\s*(?:的)?\s*(?:第一人称|第一视角|主观(?:镜头|视角)|first[- ]person)/i)?.[1];
  return {
    ...(operatorName ? { operatorName } : {}),
    hideOperator: /(?:不出镜|不入镜|不可见|never\s+(?:appears|visible)|off[- ]camera)/i.test(source),
  };
}

export function renderFirstPersonPovLock(lock: FirstPersonPovLock, locale: "zh" | "en" = "zh"): string {
  const zh = locale === "zh";
  const operator = lock.operatorName
    ? (zh ? `摄影机即${lock.operatorName}的眼睛` : `the camera is ${lock.operatorName}'s eyes`)
    : (zh ? "摄影机即观看者的眼睛" : "the camera is the viewer's eyes");
  const hidden = lock.hideOperator
    ? (zh ? `${lock.operatorName ?? "视角持有者"}绝不出镜，包括身体、脸、影子与倒影` : `${lock.operatorName ?? "the viewpoint holder"} never appears, including body, face, shadow, or reflection`)
    : "";
  return zh
    ? `全程第一人称 POV 锁：${operator}；禁止第三人称、旁观或反打机位${hidden ? `；${hidden}` : ""}。`
    : `FULL-TIME FIRST-PERSON POV LOCK: ${operator}; no third-person, observer, or reverse-angle camera${hidden ? `; ${hidden}` : ""}.`;
}

type SupplementScene = Pick<
  SceneV02,
  "storyNotes" | "mustHappen" | "forbid" | "dialogue" | "emotionArc" | "actingObjectives"
>;

export function directorIntentRefinementText(
  scene: SupplementScene & { directorIntentRefinement?: string },
  assets: { id: string; name: string }[] = [],
): string {
  const refinement = scene.directorIntentRefinement?.trim() || scene.storyNotes?.trim();
  if (refinement) return refinement;
  const lines: string[] = [];
  if ((scene.mustHappen ?? []).length > 0) lines.push(`必须发生：${scene.mustHappen!.join("；")}`);
  if ((scene.forbid ?? []).length > 0) lines.push(`禁止发生：${scene.forbid!.join("；")}`);
  if (scene.dialogue?.trim()) lines.push(`对白：${scene.dialogue.trim()}`);
  if (scene.emotionArc?.trim()) lines.push(`情绪走向：${scene.emotionArc.trim()}`);
  for (const item of scene.actingObjectives ?? []) {
    const name = assets.find((asset) => asset.id === item.characterId)?.name ?? item.characterId;
    const bits = [
      item.objective?.trim(),
      item.obstacle?.trim() ? `阻碍：${item.obstacle.trim()}` : "",
      item.stakes?.trim() ? `失败代价：${item.stakes.trim()}` : "",
    ].filter(Boolean);
    if (bits.length > 0) lines.push(`表演目标（${name}）：${bits.join("；")}`);
  }
  return lines.join("\n");
}

/** @deprecated 旧调用兼容：新代码请使用 directorIntentRefinementText。 */
export const storySupplementText = directorIntentRefinementText;
