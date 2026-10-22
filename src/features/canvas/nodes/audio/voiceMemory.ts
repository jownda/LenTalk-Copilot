/**
 * 「各模型最后选过的音色」记忆表 —— 纯函数, 便于单测。
 *
 * 为什么需要它: 音色是**按模型**隔离的。GM 的 `Zephyr` 在 GT 系列里不存在; MiniMax 的
 * 音色压根不是预置清单(是克隆/设计产出的资产)。所以切模型时**必须**重算音色。
 *
 * 但重算不等于重置。旧实现是「切到哪家就写那家的默认音色」, 后果是:
 *   用户在 MiniMax 里挑好的音色, 切去 ChatGPT 再切回来就没了(被 `alloy` 顶掉);
 *   MiniMax 更是被塞进一个平台根本不认的默认音色。
 *
 * 现在改成两步: **切走时按模型记一份 → 切回时优先还原**。只有从没在这个模型上选过音色,
 * 才退回该模型的默认值; 连默认值都没有(MiniMax 就没有)时返回空串 —— 即「不选音色」,
 * 这正是期望的初始状态。
 */

/** 能参与记忆的模型 —— 只需要 id 与可选默认音色。 */
export interface VoiceMemoryTarget {
  id: string;
  defaultVoice?: string;
}

/** 记忆表: 模型 id → 音色。 */
export type VoiceMemory = Record<string, string>;

/**
 * 记下「这个模型当前用的是哪个音色」。
 *
 * 空音色**不覆盖**旧记忆 —— 用户把音色清空(#不使用音色)只是这一次不用, 不该顺手把他
 * 之前挑好的那个也抹掉; 否则下次切回来会发现「怎么又变回默认了」。
 */
export function rememberVoice(
  memory: VoiceMemory | undefined,
  modelId: string | undefined,
  voice: string,
): VoiceMemory {
  const next: VoiceMemory = { ...(memory ?? {}) };
  const trimmed = voice.trim();
  if (modelId && trimmed) next[modelId] = trimmed;
  return next;
}

/**
 * 切到该模型时应该用哪个音色。
 *
 * 优先级: 记忆值 → 模型默认值 → 空串。
 * 「空串」这一档是给 MiniMax 准备的: 它没有默认音色, 而把上一个家族的默认音色带过来
 * 只会发出一个平台不认的音色。
 */
export function resolveVoiceForModel(
  memory: VoiceMemory | undefined,
  model: VoiceMemoryTarget | undefined,
): string {
  if (!model) return "";
  const remembered = memory?.[model.id];
  if (remembered) return remembered;
  return model.defaultVoice ?? "";
}
