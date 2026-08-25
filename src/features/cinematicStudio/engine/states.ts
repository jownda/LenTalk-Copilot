/**
 * 状态标签库（P0.3）
 * 道具/角色/地点的状态轨道使用统一标签，允许 UI 选择 + 自定义扩展。
 * 编译输出 canonical 英文标签（id），UI 显示中英双语。
 */
export interface StateLabel {
  id: string;
  zh: string;
}

export const STATE_LABELS: StateLabel[] = [
  { id: "intact", zh: "完好" },
  { id: "shattered", zh: "破碎" },
  { id: "on-ground", zh: "在地上" },
  { id: "held", zh: "被持有" },
  { id: "playing", zh: "播放中" },
  { id: "closed", zh: "关闭" },
  { id: "open", zh: "打开" },
  { id: "blown-open", zh: "被炸开" },
  { id: "smoking", zh: "冒烟" },
  { id: "restrained", zh: "被束缚" },
  { id: "freed", zh: "获释" },
  { id: "stable", zh: "稳定" },
  { id: "falling-start", zh: "开始倒下" },
  { id: "collapsed", zh: "完全倒下" },
  { id: "gripped", zh: "被抓住" },
];

export const STATE_LABEL_IDS = STATE_LABELS.map((label) => label.id);

/** 终态：一旦到达不可回退（后续镜头要求旧状态 → 严重错误） */
export const TERMINAL_STATES = new Set(["shattered", "blown-open", "freed", "collapsed"]);

/** 触发类动作：执行前必须由角色持有目标道具 */
export const TRIGGER_VERBS = new Set(["presses", "pulls", "detonates", "activates", "throws", "strikes"]);

/** 状态标签中英显示 */
export function stateLabelZh(id: string): string {
  return STATE_LABELS.find((label) => label.id === id)?.zh ?? id;
}
