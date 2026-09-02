/**
 * 引擎级本地化词典（P0.2）
 * 结构化枚举值（景别/运动/状态/转场/音频）由字典解析；
 * 用户自由文本（场景名、logline、资产描述）保持原文，不自动改写。
 */
export type PromptLocale = "zh" | "en";

export interface PromptLexicon {
  headings: Record<"technical" | "scene" | "assets" | "strict" | "shot" | "acting" | "audio" | "negative" | "continuity", string>;
  labels: Record<string, string>;
  values: Record<string, string>;
  templates: Record<string, string>;
}

const ZH: PromptLexicon = {
  headings: {
    technical: "全局技术",
    scene: "场景",
    assets: "资产引用",
    strict: "严格身份锁定",
    shot: "镜头",
    acting: "表演",
    audio: "音频",
    negative: "负面约束",
    continuity: "连续性",
  },
  labels: {
    priorContext: "前情提要",
    cameraFraming: "相机与景别",
    screenDirection: "屏幕方向",
    participants: "角色",
    spatialLayout: "角色站位（从左到右）",
    stagingDetails: "站位细节",
    startingStates: "起始状态",
    endingStates: "结束状态",
    stateTransitions: "状态变化",
    beat: "节拍",
    targetOnly: "目标：{name} 仅此",
    never: "禁止",
    mustOccur: "必须发生",
    dialogue: "对白",
    note: "备注",
    action: "动作",
    acting: "表演",
    actingSection: "表演",
    objective: "目的",
    superObjective: "贯穿目标",
    obstacle: "阻碍",
    stakes: "代价",
    tactic: "策略",
    subtext: "潜台词",
    beatChange: "节拍变化",
    reactionBeforeLine: "反应先于台词结束",
    eyeLife: "眼部生活",
    performanceLevel: "表演评分",
    diegeticMusic: "画内音乐",
    sfx: "音效",
    score: "配乐",
    subtitles: "字幕",
    burnedIn: "烧录字幕",
    none: "无",
    noScore: "无配乐",
    useFor: "用途",
    ignore: "忽略",
    uniqueMarkers: "唯一特征",
    alwaysVisible: "始终可见",
    appearanceOnly: "仅外观参考，不复制姿势、背景或光线。",
    heldBy: "由{name}持有",
    with: "携带",
    entersFromLeft: "从左入画",
    entersFromRight: "从右入画",
    facing: "朝向",
    eyeline: "视线",
    torsoFacing: "身体朝向",
    anchorDistance: "标志物距离",
    axisBreak: "故意越轴",
    countPrefix: "画面中恰好",
    countSuffix: "名角色，禁止重复，禁止额外人物",
    neverConfuse: "勿与以下混淆",
    scoreWord: "配乐",
    subtitlesWord: "字幕",
  },
  values: {
    // 景别
    "Extreme wide / establishing": "大远景 / 建立镜头", "Wide": "全景", "Full shot": "全身镜头", "Medium full / cowboy": "中全景 / 牛仔镜头",
    "Medium": "中景", "Medium close-up": "中近景", "Close-up": "近景 / 特写", "Big close-up": "大特写",
    "Extreme close-up": "极近特写", "Insert / detail": "细节插入", "Two-shot": "双人镜头", "Tight two-shot": "紧凑双人镜头",
    "Over-the-shoulder": "过肩镜头", "3/4 medium, behind subject": "3/4 中景，人物背后", "Extreme close-up, profile": "极近特写，侧面",
    "Medium wide": "中全景", "Low wide": "低角度全景", "Full": "全身", "Insert": "插入特写",
    // 镜头运动
    "Static": "静态", "Handheld": "手持", "Dolly": "移轨", "Crane": "升降", "Pan": "摇镜",
    "Tilt": "俯仰", "Push-in": "推近", "Pull-out": "拉远", "Trucking": "横移", "Tracking": "跟拍",
    // 状态
    "on-ground": "在地上", "playing": "播放中", "blown-open": "被炸开", "closed": "关闭", "open": "打开",
    "pressed": "已按下", "held": "持有中", "armed": "已武装", "gripped": "被抓住", "freed": "已挣脱",
    "shattered": "碎裂", "intact": "完好", "stable": "稳定", "falling-start": "开始倒下", "covered": "盖上",
    "exposed": "露出", "on-shoulder": "在肩上",
    // 转场
    "hard-cut": "硬切", "overlap": "允许重叠", "match-cut": "匹配剪辑",
    // 音频
    "none": "无配乐", "original-score": "原创配乐", "burned-in": "烧录字幕",
  },
  templates: {
    shotLine: "镜头 {label}（{time}）",
    shotTime: "{start}–{end} 秒",
    beatLine: "节拍 {order}：{content}",
    stateChain: "{name}：{chain}",
    assetHead: "<<<{id}>>> [image{n}] — {name}：{desc}",
    assetHeadAtMention: "@{name} [image{n}] — {name}：{desc}",
    assetHeadPlain: "[image{n}] — {name}：{desc}",
    countLine: "画面中恰好 {n} 名角色。禁止重复，禁止额外人物。",
    cameraBit: "{framing}，{lens}，{movement}",
    directionBit: "屏幕方向：{direction}",
  },
};

const EN: PromptLexicon = {
  headings: {
    technical: "TECHNICAL", scene: "SCENE", assets: "ASSET REFERENCES", strict: "STRICT IDENTITY LOCK",
    shot: "SHOT", acting: "ACTING", audio: "AUDIO", negative: "NEGATIVE CONSTRAINTS", continuity: "CONTINUITY",
  },
  labels: {
    priorContext: "Prior context",
    cameraFraming: "Camera & framing",
    screenDirection: "Screen direction",
    participants: "Participants",
    spatialLayout: "Spatial layout, left to right",
    stagingDetails: "Staging details",
    startingStates: "Starting states",
    endingStates: "Ending states",
    stateTransitions: "STATE TRANSITIONS",
    beat: "BEAT",
    targetOnly: "Target: {name} only",
    never: "never",
    mustOccur: "MUST occur",
    dialogue: "Dialogue",
    note: "NOTE",
    action: "Action",
    acting: "Acting",
    actingSection: "ACTING",
    objective: "Objective",
    superObjective: "Super-objective",
    obstacle: "Obstacle",
    stakes: "Stakes",
    tactic: "Tactic",
    subtext: "Subtext",
    beatChange: "Beat change",
    reactionBeforeLine: "Reacts before the other line ends",
    eyeLife: "Eye life",
    performanceLevel: "Performance level",
    diegeticMusic: "Diegetic music",
    sfx: "SFX",
    score: "Score",
    subtitles: "Subtitles",
    burnedIn: "burned-in",
    none: "none",
    noScore: "no score",
    useFor: "Use for",
    ignore: "Ignore",
    uniqueMarkers: "Unique markers",
    alwaysVisible: "Always visible",
    appearanceOnly: "Appearance reference only. Do not copy pose, background, or lighting.",
    heldBy: "held by {name}",
    with: "with",
    entersFromLeft: "enters from left",
    entersFromRight: "enters from right",
    facing: "facing",
    eyeline: "eyeline",
    torsoFacing: "torso facing",
    anchorDistance: "anchor distance",
    axisBreak: "Intentional axis break",
    countPrefix: "EXACTLY",
    countSuffix: "characters in every frame. No duplicates. No extras.",
    neverConfuse: "never confuse with",
    scoreWord: "Score",
    subtitlesWord: "Subtitles",
  },
  values: {
    "Wide": "Wide", "Medium close-up": "Medium close-up", "Close-up": "Close-up", "Extreme close-up": "Extreme close-up",
    "Medium": "Medium", "Medium wide": "Medium wide", "Low wide": "Low wide", "Full": "Full", "Insert": "Insert",
    "Static": "Static", "Handheld": "Handheld", "Dolly": "Dolly", "Crane": "Crane", "Pan": "Pan",
    "Tilt": "Tilt", "Push-in": "Push-in", "Pull-out": "Pull-out", "Trucking": "Trucking", "Tracking": "Tracking",
    "on-ground": "on-ground", "playing": "playing", "blown-open": "blown-open", "closed": "closed", "open": "open",
    "pressed": "pressed", "held": "held", "armed": "armed", "gripped": "gripped", "freed": "freed",
    "shattered": "shattered", "intact": "intact", "stable": "stable", "falling-start": "falling-start", "covered": "covered",
    "exposed": "exposed", "on-shoulder": "on shoulder",
    "hard-cut": "hard cut", "overlap": "overlap", "match-cut": "match cut",
    "none": "none", "original-score": "original score", "burned-in": "burned-in",
  },
  templates: {
    shotLine: "SHOT {label} ({time})",
    shotTime: "{start}-{end}s",
    beatLine: "BEAT {order}: {content}",
    stateChain: "{name}: {chain}",
    assetHead: "<<<{id}>>> [image{n}] — {name}: {desc}",
    assetHeadAtMention: "@{name} [image{n}] — {name}: {desc}",
    assetHeadPlain: "[image{n}] — {name}: {desc}",
    countLine: "EXACTLY {n} characters in every frame. No duplicates. No extras.",
    cameraBit: "{framing}, {lens}, {movement}",
    directionBit: "Screen direction: {direction}",
  },
};

const LEXICONS: Record<PromptLocale, PromptLexicon> = { zh: ZH, en: EN };

export function promptLexicon(locale: PromptLocale): PromptLexicon {
  return LEXICONS[locale] ?? ZH;
}

/** 结构化枚举值 → 当前语言文本；未知值原样返回（自由文本不改写） */
export function localizePromptValue(value: string, locale: PromptLocale): string {
  if (!value) return value;
  const localized = promptLexicon(locale).values[value];
  return localized ?? value;
}

/** 模板填充：{key} → 值 */
export function fillTemplate(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => params[key] ?? "");
}
