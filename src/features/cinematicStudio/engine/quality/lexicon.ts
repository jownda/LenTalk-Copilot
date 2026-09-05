/**
 * V2 质量词表（常量，纯数据）。
 * 供 validateDirectorLayers 与后续 sanitize 管道共用，禁止在此文件引入副作用。
 * 语言约束：用户可见替换句维护 zh/en 两套；检测用正则覆盖两种语言。
 */
/**
 * 导演文档 canonical 层 key（与 compiler/director.ts 的 DIRECTOR_LAYER_ORDER 保持一致）。
 * 刻意内联而非从 director.ts 导入：director → quality 存在编译期依赖，反向导入会形成循环。
 * 两处顺序由 validateDirectorLayers 双语单测隐式锁定。
 */
export const DIRECTOR_LAYER_KEYS: readonly string[] = [
  "activeReferences", "locationMap", "formatMode",
  "optics", "camera", "physics", "lighting", "audio",
  "style",
  "positiveConstraints", "negativeLocks",
];

// ─────────────────────────────────────────────────────────────
// V2-P1-1 光学术语冲突
// 广角（FOV ≥ 84）与「压缩感」互斥；长焦（FOV ≤ 29）与「拉伸 / 近大远小」互斥。
// ─────────────────────────────────────────────────────────────
export const OPTIC_DEGREE_RE = /(\d{1,3})\s*(?:°|度|degrees?|deg)/gi;
export const OPTIC_FOV_KNOWN = { wideMin: 84, teleMax: 29 } as const;

export const OPTIC_WIDE_WORD_RE = /(?:广角|超广角|沉浸|ultrawide|wide[- ]angle|immersive)/i;
export const OPTIC_TELE_WORD_RE = /(?:长焦|超长焦|中近特写|telephoto|short[- ]tele|\btele\b|long[- ]lens)/i;
export const OPTIC_COMPRESSION_RE = /(?:压缩感|空间压缩|背景压缩|压缩|compression|compressed|flattened|creamy bokeh|soft wash)/i;
export const OPTIC_STRETCH_RE = /(?:拉伸|近大远小|透视拉伸|纵深拉伸|perspective stretch|perspective distortion|stretch(?:ed|ing)?)/i;

export const OPTIC_CONFLICT_SUGGESTION = {
  wideWithCompression: {
    zh: "改为可观测的广角描述：「84° 广角纵深透视，近大远小、前后景深度拉开、边缘轻微呼吸感」；不要写「压缩感」。",
    en: "Rewrite as observable wide-angle outcome: \"84° wide-angle perspective: foreground-to-background depth, near-large far-small, slight edge breathing\"; do not write \"compression\".",
  },
  teleWithStretch: {
    zh: "长焦应写「背景压缩、景深变浅、前后景贴平、前景遮挡占画面下部 30–45%」；不要写「拉伸 / 近大远小」。",
    en: "Telephoto should describe \"background compression, shallow depth of field, flattened planes, foreground occlusion covering lower 30–45% of frame\"; avoid \"stretch / perspective distortion\".",
  },
} as const;

// ─────────────────────────────────────────────────────────────
// V2-P0-2 元数据语句：项目管理信息，任何提示词层禁止出现
// ─────────────────────────────────────────────────────────────
export const META_ZH_RES: RegExp[] = [
  /启用资产/, /未启用/, /未使用(?:的)?(?:资产|角色|道具)/, /仅(?:作|为)项目(?:管理)?/,
  /(?:不在|未进入)本场景/,
];
export const META_EN_RES: RegExp[] = [
  /enabled assets?/i, /not enabled/i, /unused (?:assets?|characters?|props?)/i,
  /project-?only/i, /not (?:in|included in) this scene/i,
];

// ─────────────────────────────────────────────────────────────
// V2-P1-3 诊断摘要：连续性 / QA 结论只在检查面板，不进入提示词
// ─────────────────────────────────────────────────────────────
export const DIAGNOSTIC_ZH_RES: RegExp[] = [
  /连续性：[^。\n]*/, /共\s*\d+\s*个(?:问题|错误|警告)/, /最终导出前请解决/,
];
export const DIAGNOSTIC_EN_RES: RegExp[] = [
  /continuity:[^\n]*/i, /\d+\s*(?:issues?|errors?|warnings?)\s*(?:total|found)/i,
  /resolve error-level/i,
];

// ─────────────────────────────────────────────────────────────
// V2-P0-3 首帧「禁止新道具」检测
// ─────────────────────────────────────────────────────────────
export const FORBID_NEW_PROPS_RE =
  /(?:不得|禁止|不要)(?:再)?(?:加入|出现|添加|入镜)(?:任何)?(?:其他)?(?:新)?(?:角色|道具|人物)|no new (?:props?|characters?)|no additional (?:props?|characters?)|nothing else may (?:appear|enter)/i;

// ─────────────────────────────────────────────────────────────
// V2-P1-2 身份锚关键词：行内出现「资产名 + ≥1 关键词」即视为身份描述
// ─────────────────────────────────────────────────────────────
export const ZH_IDENT_WORDS = [
  "方脸", "宽脸", "脸型", "黑发", "头发", "发型", "浓眉", "眉毛", "胡须", "胡子",
  "皮肤", "肤色", "西装", "衬衫", "夹克", "大衣", "裤", "鞋", "领带", "眼镜",
  "肩膀", "肩", "身形", "体格", "制服",
];

export const EN_IDENT_WORDS = [
  "square face", "broad face", "black hair", "hair", "brows", "brow", "stubble", "beard",
  "mustache", "moustache", "skin", "suit", "shirt", "jacket", "coat", "trousers", "jeans",
  "shoes", "tie", "glasses", "shoulders", "shoulder", "build", "uniform",
];

/** 层 key → 中文名（校验信息展示用） */
export const LAYER_ZH_LABELS: Record<string, string> = {
  activeReferences: "活动引用", locationMap: "场景地图和站位",
  formatMode: "格式模式", optics: "光学", camera: "相机", actionTiming: "动作时序", physics: "物理",
  lighting: "光线", audio: "音频", style: "风格", positiveConstraints: "正向约束", negativeLocks: "全局失败锁",
};
