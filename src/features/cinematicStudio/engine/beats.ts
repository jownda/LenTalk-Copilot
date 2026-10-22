/**
 * Beat 动词库（P0.4）
 * UI 动作下拉使用中文显示，存储英文 canonical id；编译器输出英文。
 * ATTACK_VERBS 供因果检查（目标为空 → TARGET_MISSING）。
 */
export interface BeatVerb {
  id: string;
  zh: string;
}

export const BEAT_VERBS: BeatVerb[] = [
  { id: "lifts", zh: "拿起" },
  { id: "sets down", zh: "放下" },
  { id: "presses", zh: "按下" },
  { id: "grabs", zh: "抓住" },
  { id: "grips", zh: "紧握" },
  { id: "bites", zh: "咬住" },
  { id: "strikes", zh: "砸击" },
  { id: "kicks", zh: "踢" },
  { id: "sweeps", zh: "扫腿" },
  { id: "breaks free", zh: "挣脱" },
  { id: "enters", zh: "冲入" },
  { id: "pauses", zh: "停顿" },
  { id: "recoils", zh: "后退" },
  { id: "watches", zh: "注视" },
  { id: "opens", zh: "打开" },
  { id: "closes", zh: "关闭" },
];

export const BEAT_VERB_IDS = BEAT_VERBS.map((verb) => verb.id);

/** 攻击/定向类动作：必须声明目标（角色或道具），否则严重错误 */
export const ATTACK_VERBS = new Set(["grips", "grabs", "bites", "strikes", "kicks", "sweeps", "punches", "throws"]);

/** 动词中英显示 */
export function beatVerbZh(id: string): string {
  return BEAT_VERBS.find((verb) => verb.id === id)?.zh ?? id;
}
