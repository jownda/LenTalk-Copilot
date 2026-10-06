import type { PromptOptimizerTaskType } from "./canvasNodes";

export type LiraTaskType = Exclude<PromptOptimizerTaskType, "auto">;
export type LiraLang = "zh" | "en";

export interface LiraRoute {
  taskType: LiraTaskType;
  model: string;
  summary: string;
}

export interface LiraOptimizeInput {
  purpose: string;
  taskType: PromptOptimizerTaskType;
  targetModel?: string;
  referencePalette?: string;
  /** 输出语言：zh=中文(默认), en=English。 */
  lang?: LiraLang;
}

export interface LiraOptimizeResult {
  prompt: string;
  route: LiraRoute;
  notes: string[];
}

interface LiraText {
  zh: string;
  en: string;
}

type PaletteHue = LiraText;

/* ================================================================== *
 * 1. 模型路由 —— LIRA skill「Model routing」
 *    人物 / 场景走 Soul 系；道具走 NBP / GPT Image 2；成片编辑永远先走 NBP；
 *    纹理修复只走 Seedream 4.5；机位反转走 GPT Image 2。
 *    画幅与分辨率是平台参数，只出现在 notes 里，绝不写进提示词正文。
 * ================================================================== */

const TASK_LABEL: Record<LiraTaskType, LiraText> = {
  character: { zh: "人物", en: "character" },
  location: { zh: "地点/环境", en: "location / environment" },
  prop: { zh: "道具", en: "prop" },
  edit: { zh: "编辑", en: "edit" },
  texture: { zh: "纹理修复", en: "texture repair" },
  viewChange: { zh: "机位反转", en: "view change" },
};

const TASK_MODEL: Record<LiraTaskType, LiraText> = {
  character: {
    zh: "Higgsfield Soul 2.0（备选：Cinema Studio AI Cast）",
    en: "Higgsfield Soul 2.0 (alt: Cinema Studio AI Cast)",
  },
  location: { zh: "Higgsfield Soul Cinema", en: "Higgsfield Soul Cinema" },
  prop: { zh: "Nano Banana Pro / GPT Image 2", en: "Nano Banana Pro / GPT Image 2" },
  edit: { zh: "Nano Banana Pro（编辑永远优先）", en: "Nano Banana Pro (always first)" },
  texture: { zh: "Seedream 4.5（仅纹理通道）", en: "Seedream 4.5 (texture pass only)" },
  viewChange: { zh: "GPT Image 2", en: "GPT Image 2" },
};

/* ================================================================== *
 * 2. 技术块 —— LIRA skill「Formulas & Building Blocks → Tech blocks」
 *    Soul Cinema 自带胶片质感与天然颗粒，技术块保持精简，不堆叠 grain / film 词。
 * ================================================================== */

const TECH: Record<LiraLang, { clean: string; cinema: string; texture: string }> = {
  en: {
    clean:
      "Shot on ARRI Alexa Mini LF with ARRI Signature Prime lens, clean modern digital cinematic capture, crisp natural detail, minimal fine grain, soft cinematic falloff, modern cinematic film still quality, hyperrealistic photographic detail, natural living skin tones, medium contrast, subtle cool tone in the shadows, true-to-life modern colour",
    cinema:
      "Photorealistic ARRI Alexa LF anamorphic Cooke S4 lens at T2.0, organic 35mm film grain, soft cinematic falloff, cinematic film still",
    texture: "Cinematic still, true-to-life material detail, natural film grain, soft falloff",
  },
  zh: {
    clean:
      "使用 ARRI Alexa Mini LF 与 ARRI Signature Prime 镜头拍摄，干净的现代数字电影质感，清晰自然细节，极轻微颗粒，柔和电影感衰减，现代电影剧照品质，超写实摄影细节，自然的活体肤色，中等对比，阴影带轻微冷调，真实到位的现代色彩",
    cinema: "写实 ARRI Alexa LF 变形宽银幕 Cooke S4 镜头 T2.0，有机 35mm 胶片颗粒，柔和电影感衰减，电影剧照质感",
    texture: "电影剧照，真实材质细节，自然胶片颗粒，柔和衰减",
  },
};

/* ================================================================== *
 * 3. 调色板 —— 文档强制 60/30/10，且只能从用户指令 / 场景上下文 / 参考图推导，
 *    绝不凭空发明。所以这里只在草稿真的出现颜色词或场景线索时才输出调色板行，
 *    否则留占位符交给用户填。
 * ================================================================== */

const COLOR_LEXICON: Array<{ pattern: RegExp; hue: PaletteHue }> = [
  { pattern: /暖黄|暖色调|金黄|琥珀|amber|golden|warm yellow/i, hue: { zh: "暖赭黄", en: "warm ochre" } },
  { pattern: /暖橙|橘黄|橘色|赭石|赤陶|terracotta|burnt orange|orange/i, hue: { zh: "暖橙", en: "terracotta orange" } },
  { pattern: /青灰|灰蓝|钢蓝|slate|steel blue|blue\s?grey|blue\s?gray/i, hue: { zh: "青灰", en: "slate grey" } },
  { pattern: /锈红|暗红|砖红|猩红|rust|crimson|brick red/i, hue: { zh: "锈红", en: "rust-red" } },
  { pattern: /墨绿|深绿|森林绿|翡翠|forest green|deep green|emerald/i, hue: { zh: "墨绿", en: "deep forest green" } },
  { pattern: /米白|象牙白|灰白|乳白|ivory|off-?white|bone white/i, hue: { zh: "米白", en: "ivory" } },
  { pattern: /深褐|棕褐|褐色|sepia|umber|brown/i, hue: { zh: "深褐", en: "deep umber" } },
  { pattern: /靛蓝|深蓝|幽蓝|午夜蓝|indigo|deep blue|midnight blue/i, hue: { zh: "靛蓝", en: "deep indigo" } },
  { pattern: /炭黑|墨黑|近黑|charcoal|near-?black/i, hue: { zh: "炭黑", en: "deep charcoal" } },
  { pattern: /冷青|冰蓝|青蓝|湖蓝|teal|cyan|ice blue/i, hue: { zh: "冷青", en: "cool teal" } },
];

/** 场景线索 → 调色板。顺序即优先级，更具体的场景必须排在更泛的前面（雨夜 先于 雨）。 */
const SCENE_PALETTE: Array<{ pattern: RegExp; hues: PaletteHue[] }> = [
  {
    pattern: /雨夜|rain(?:y)?\s*night|rain-?soaked/i,
    hues: [
      { zh: "冷青灰", en: "cool teal-grey" },
      { zh: "炭黑", en: "deep charcoal" },
      { zh: "暖钠黄", en: "warm sodium amber" },
    ],
  },
  {
    pattern: /黄昏|日落|夕阳|dusk|sunset|golden hour/i,
    hues: [
      { zh: "暖赭黄", en: "warm ochre" },
      { zh: "深褐", en: "deep umber" },
      { zh: "锈红", en: "rust-red" },
    ],
  },
  {
    pattern: /清晨|晨雾|拂晓|黎明|dawn|mist|fog/i,
    hues: [
      { zh: "淡冷灰", en: "pale cool grey" },
      { zh: "米白", en: "ivory" },
      { zh: "冷青", en: "cool teal" },
    ],
  },
  {
    pattern: /夜晚|深夜|午夜|night|midnight/i,
    hues: [
      { zh: "靛蓝", en: "deep indigo" },
      { zh: "炭黑", en: "deep charcoal" },
      { zh: "暖钠黄", en: "warm sodium amber" },
    ],
  },
  {
    pattern: /沙漠|荒漠|戈壁|desert|dune/i,
    hues: [
      { zh: "暖赭黄", en: "warm ochre" },
      { zh: "米白", en: "ivory" },
      { zh: "锈红", en: "rust-red" },
    ],
  },
  {
    pattern: /森林|树林|丛林|forest|woods|jungle/i,
    hues: [
      { zh: "墨绿", en: "deep forest green" },
      { zh: "深褐", en: "deep umber" },
      { zh: "冷青", en: "cool teal" },
    ],
  },
  {
    pattern: /雪|冰霜|frost|snow|winter/i,
    hues: [
      { zh: "冷白", en: "cool white" },
      { zh: "青灰", en: "slate grey" },
      { zh: "靛蓝", en: "deep indigo" },
    ],
  },
  {
    pattern: /雨|rain|wet street/i,
    hues: [
      { zh: "青灰", en: "slate grey" },
      { zh: "冷青", en: "cool teal" },
      { zh: "暖橙", en: "terracotta orange" },
    ],
  },
];

function buildPaletteLine(hues: PaletteHue[], lang: LiraLang): string {
  if (hues.length === 0) return "";
  const [first, second, third] = hues;
  const tailZh = "，深黑压暗，克制的自然主义分级，柔和低对比，强烈电影明暗对比";
  const tailEn =
    "deep crushed blacks, restrained naturalistic grading, soft low contrast, strong cinematic chiaroscuro";
  if (lang === "zh") {
    if (third) {
      return `精炼低饱和调色板：60% ${first.zh}、30% ${second.zh}、10% ${third.zh}${tailZh}`;
    }
    if (second) return `精炼低饱和调色板：${first.zh} 主导，${second.zh} 作为唯一对比色${tailZh}`;
    return `精炼低饱和调色板：${first.zh} 主导${tailZh}`;
  }
  if (third) return `Refined desaturated palette: 60% ${first.en}, 30% ${second.en}, 10% ${third.en}, ${tailEn}`;
  if (second) {
    return `Refined desaturated palette: ${first.en} dominating, ${second.en} as the only counter-tone, ${tailEn}`;
  }
  return `Refined desaturated palette: ${first.en} dominating, ${tailEn}`;
}

const PALETTE_SLOT: LiraText = {
  zh: "【待补充：调色板，按 60% / 30% / 10% 写，例如 60% 暖赭黄、30% 炭黑、10% 锈红】",
  en: "[add a palette: 60% X, 30% Y, 10% Z — e.g. 60% warm ochre, 30% deep charcoal, 10% rust-red]",
};

/* ================================================================== *
 * 4. 正向优先 —— 这些模型都没有负面提示词参数，NOT 堆叠反而会把要排除的概念
 *    注入画面。命中常见「不要…」表述时，就地替换成正向描述。
 * ================================================================== */

const NEGATIVE_REWRITES: Array<{ pattern: RegExp; positive: LiraText }> = [
  {
    pattern:
      /(?:不要|没有|无|别加|不含|不放)\s*(?:任何)?\s*(?:人物|人|行人|路人|人影)|no\s+people|without\s+people|no\s+persons?/gi,
    positive: { zh: "空旷无人的空间，光秃的墙面，空气静止", en: "empty deserted space, bare walls, still air" },
  },
  {
    pattern: /(?:不要|没有|无)\s*(?:文字|字幕|水印|标题|英文)|no\s+text|without\s+text|no\s+lettering/gi,
    positive: { zh: "表面素净空白，不带任何字样", en: "clean blank surfaces, plain and unmarked" },
  },
  {
    pattern: /(?:不要|没有|无)\s*(?:logo|LOGO|Logo|标识|品牌|商标)|no\s+logo|no\s+branding|unbranded/gi,
    positive: { zh: "素净无品牌的哑光表面", en: "plain unbranded blank matte surface" },
  },
  {
    pattern: /(?:不要|不是|没有)\s*(?:卡通|动漫|漫画|插画|二次元)|no\s+cartoon|not\s+anime|no\s+illustration/gi,
    positive: { zh: "写实电影剧照，真实摄影细节", en: "photorealistic film still, real photographic detail" },
  },
];

/* ================================================================== *
 * 5. 草稿清洗 —— 画幅、分辨率、量化参数一律剔除（平台参数，不进正文）
 * ================================================================== */

const PLATFORM_PARAM_SOURCE =
  "--ar\\s*\\S+|--\\w+|\\b\\d{1,2}\\s*:\\s*\\d{1,2}\\b|\\b\\d{3,4}\\s*[x×]\\s*\\d{3,4}\\b|\\b(?:4k|8k|2k|1k|1080p|720p|uhd|hd)\\b";

function stripPlatformParameters(text: string): { text: string; removed: string[] } {
  const removed: string[] = [];
  const next = text.replace(new RegExp(PLATFORM_PARAM_SOURCE, "gi"), (match) => {
    removed.push(match.replace(/\s+/g, " ").trim());
    return " ";
  });
  return { text: next.replace(/\s+/g, " ").trim(), removed };
}

function applyPositiveRewrites(text: string, lang: LiraLang): { text: string; applied: LiraText[] } {
  let next = text;
  const applied: LiraText[] = [];
  for (const rule of NEGATIVE_REWRITES) {
    rule.pattern.lastIndex = 0;
    if (!rule.pattern.test(next)) continue;
    rule.pattern.lastIndex = 0;
    // 就地换成正向描述：模型没有负面提示词参数，NOT 堆叠反而会把要排除的概念注入画面。
    next = next.replace(rule.pattern, () => `${rule.positive[lang]} `);
    applied.push(rule.positive);
  }
  return { text: next, applied };
}

function cleanDraft(text: string, lang: LiraLang): string {
  const cleaned = text
    .replace(/["“”]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    // 正向改写会把命中的「不要…」整段替换成正向描述，容易留下悬空或重复的分隔符，统一收敛。
    .replace(/\s*([，、；：])\s*/g, "$1")
    .replace(/([，、；：])(?=[，、；：])/g, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/^[,，、;；:：\s]+/, "")
    .replace(/[,，、;；:：\s]+$/, "");
  if (!cleaned) return "";
  if (/[.!?。！？]$/.test(cleaned)) return cleaned;
  return `${cleaned}${lang === "zh" ? "。" : "."}`;
}

/** 去掉句末终止符——把草稿嵌进句子中间时需要，否则会出现「…台灯。，其余…」这种断句。 */
function stripTerminator(text: string): string {
  return text.replace(/[.!?。！？]+$/, "");
}

function terminate(text: string, lang: LiraLang): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (/[.!?。！？]$/.test(trimmed)) return trimmed;
  return `${trimmed}${lang === "zh" ? "。" : "."}`;
}

function detectHues(text: string): PaletteHue[] {
  const hues: PaletteHue[] = [];
  for (const entry of COLOR_LEXICON) {
    if (!entry.pattern.test(text)) continue;
    if (hues.some((hue) => hue.en === entry.hue.en)) continue;
    hues.push(entry.hue);
  }
  return hues;
}

function detectSceneHues(text: string): PaletteHue[] {
  for (const entry of SCENE_PALETTE) {
    if (entry.pattern.test(text)) return entry.hues;
  }
  return [];
}

/* ================================================================== *
 * 6. 任务推断
 * ================================================================== */

const TEXTURE_WORDS =
  /纹理|发糊|糊成一片|塑料感|皮肤毛孔|布料织纹|ai\s*味|texture|skin\s*pores|fabric\s*weave|ai\s*slop|sloppy/i;
const VIEW_WORDS =
  /反打|反向|机位反转|另一个角度|换个机位|换机位|背面视角|转到.{0,6}(?:后面|背后)|reverse\s*angle|new\s*camera|opposite\s*side|other\s*side|behind\s+the\s+camera|view\s*change/i;
const EDIT_WORDS =
  /编辑|修图|改图|换掉|换成|替换|去掉|移除|删除|加上|改成|把.{0,12}(?:换成|改为)|replace|remove|swap|\bedit\b/i;
const CHARACTER_WORDS =
  /人物|角色|设定图|肖像|人像|模特|穿搭|女性|男性|女子|男子|少女|少年|老人|儿童|全身|半身|特写人|character|portrait|casting|ugc|fashion|model|person|woman|man|girl|boy|face|body/i;
const LOCATION_WORDS =
  /地点|环境|空镜|场景|室内|室外|房间|街道|街|巷|建筑|山|海|森林|天空|站台|走廊|大厅|废墟|location|environment|establishing|interior|exterior|room|street|building|landscape|cityscape/i;
const PROP_WORDS =
  /道具|产品|物品|物件|武器|商品|包装|静物|器皿|工具|手表|怀表|首饰|prop|product|object|item|device|packaging|still\s*life|gadget|appliance/i;

function inferTaskType(purpose: string): LiraTaskType {
  if (TEXTURE_WORDS.test(purpose)) return "texture";
  if (VIEW_WORDS.test(purpose)) return "viewChange";
  if (EDIT_WORDS.test(purpose)) return "edit";
  if (CHARACTER_WORDS.test(purpose)) return "character";
  if (LOCATION_WORDS.test(purpose)) return "location";
  if (PROP_WORDS.test(purpose)) return "prop";
  return "location";
}

/* ================================================================== *
 * 7. 六类预制模版 —— LIRA skill「Prompt-Type Templates」
 *    人物设定图豁免三分法，其余一律追加 rule of thirds（standing rule）。
 * ================================================================== */

const RULE_OF_THIRDS: LiraText = { zh: "三分法构图。", en: "Rule of thirds." };

const CAMERA_WORDS =
  /镜头|机位|视角|俯拍|仰拍|平视|广角|特写|中景|全景|远景|航拍|camera\s*angle|wide\s*shot|close-?up|high\s*angle|low\s*angle|medium\s*shot|aerial/i;

const DEFAULT_CAMERA_ANCHOR: LiraText = {
  zh: "高角度四分之三广角镜头，机位高于空间，沿约 45 度斜向下俯视",
  en: "High angle three-quarter wide shot, camera high above the space looking diagonally down at a 45 degree angle",
};

function isCharacterDraftVague(subject: string): boolean {
  const stripped = subject
    .replace(
      /人物角色设定图|角色设定图|人物设定图|人物设定|角色设定|人物图|三格|三视图|人像|肖像|全身|半身|character\s*sheet|portrait|casting|model|person|character/gi,
      " ",
    )
    .replace(/[\s.,!?。！？，,:：;；'"“”\-【】[\]]+/g, "")
    .trim();
  return stripped.length === 0;
}

function joinParts(parts: string[], separator = " "): string {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(separator);
}

/** 中文句子之间不留空格，英文之间留一个空格。 */
function joinSentences(parts: string[], lang: LiraLang): string {
  return joinParts(parts, lang === "zh" ? "" : " ");
}

function buildCharacterPrompt(subject: string, paletteLine: string, lang: LiraLang): string {
  const vague = isCharacterDraftVague(subject);
  const personZh = vague ? "【待补充：性别、年龄、发型发色、五官、服装、表情】" : subject;
  const personEn = vague ? "[add gender, age, hair, facial features, wardrobe, expression]" : subject;

  if (lang === "zh") {
    return [
      "一张电影角色设定图：同一真实人物的三张棚拍照片并排置于纯中性中灰背景上，左侧正面全身照、中间背面全身照、右侧大幅特写头像，三格为同一人，跨面板完全一致。柔和的方向性电影棚光从单侧打来，自然的阴影衰减，干净中性的电影质感。",
      `人物：${personZh}`,
      "所有面板服装保持一致【待补充：服装】。双手空置，不持任何道具。",
      "两张全身照均从颈部以下取景，脸部只出现在右侧特写中；特写为四分之三侧面的头肩像，同时呈现正面与侧面。",
      joinSentences([terminate(paletteLine || PALETTE_SLOT.zh, lang), terminate(TECH.zh.clean, lang)], lang),
    ].join("\n\n");
  }
  return [
    "Three studio photographs of the same real person arranged side by side on a flat neutral mid-grey studio backdrop, a film character sheet: a full-body front photo on the left, a full-body back photo in the middle, a close-up portrait photo on the right, the same real person in all three, consistent across panels. Soft directional cinematic studio lighting from one side, gentle natural shadow falloff, clean neutral cinematic look.",
    `The person: ${personEn}`,
    "Wardrobe consistent in all panels [add wardrobe]. Hands empty, no props.",
    "Both full-body panels are framed from the neck down, so the face appears only in the close-up; the close-up is a head-and-shoulders three-quarter view showing the front and the side at once.",
    joinSentences([terminate(paletteLine || PALETTE_SLOT.en, lang), terminate(TECH.en.clean, lang)], lang),
  ].join("\n\n");
}

function buildLocationPrompt(subject: string, paletteLine: string, lang: LiraLang): string {
  const needsAnchor = !CAMERA_WORDS.test(subject);
  if (lang === "zh") {
    const first = joinSentences([needsAnchor ? `${DEFAULT_CAMERA_ANCHOR.zh}。` : "", subject], lang);
    return [
      first,
      "【待补充：关键建筑与自然元素的具体材质与形体】。【待补充：光源方向与色温】，次要元素向纵深退去。",
      joinSentences(
        [
          terminate(paletteLine || PALETTE_SLOT.zh, lang),
          terminate(TECH.zh.cinema, lang),
          "【待补充：情绪或摄影师参考】。",
          RULE_OF_THIRDS.zh,
        ],
        lang,
      ),
    ].join("\n\n");
  }
  const first = joinSentences([needsAnchor ? `${DEFAULT_CAMERA_ANCHOR.en}.` : "", subject], lang);
  return [
    first,
    "[add the key architectural and natural elements, their concrete materials and forms]. [add the light source, its direction and colour temperature]; secondary elements recede into depth.",
    joinSentences(
      [
        terminate(paletteLine || PALETTE_SLOT.en, lang),
        terminate(TECH.en.cinema, lang),
        "[add mood / cinematographer reference].",
        RULE_OF_THIRDS.en,
      ],
      lang,
    ),
  ].join("\n\n");
}

function buildPropPrompt(subject: string, paletteLine: string, lang: LiraLang): string {
  const bare = stripTerminator(subject);
  if (lang === "zh") {
    return [
      `${bare} 置于中性灰水泥平面上的写实四分之三俯视产品照，柔和方向光，主体独立。${RULE_OF_THIRDS.zh}`,
      "【待补充：材质、表面与磨损状态】。素净无品牌的哑光表面。",
      joinSentences([paletteLine ? terminate(paletteLine, lang) : "", terminate(TECH.zh.clean, lang)], lang),
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  return [
    `Photorealistic three-quarter overhead product shot of ${bare} on a neutral grey concrete surface, soft directional lighting, isolated subject. ${RULE_OF_THIRDS.en}`,
    "[add concrete materials, surfaces and wear state]. Plain unbranded blank matte surface.",
    joinSentences([paletteLine ? terminate(paletteLine, lang) : "", terminate(TECH.en.clean, lang)], lang),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildEditPrompt(subject: string, lang: LiraLang): string {
  const bare = stripTerminator(subject);
  if (lang === "zh") {
    return [
      `编辑图片：${bare}。`,
      "",
      `修改：${bare}。`,
      "",
      "完全保留：",
      "- 人物的面部、身份、表情与皮肤",
      "- 服装、道具及其确切位置",
      "- 机位角度、取景、透视与焦距",
      "- 墙面、地面、背景及主体身后的每一个元素",
      "- 所有既有阴影与高光",
      "- 色彩分级、调色板、对比度、颗粒与光线衰减",
      "",
      `仅修改：${bare}，其余 100% 保持一致。`,
    ].join("\n");
  }
  return [
    `Edit the image: ${bare}.`,
    "",
    `CHANGE: ${bare}.`,
    "",
    "PRESERVE EXACTLY:",
    "- the person's face, identity, expression and skin",
    "- wardrobe, props and their exact positions",
    "- camera angle, framing, perspective and focal length",
    "- walls, floor, background and every element behind the subject",
    "- every existing shadow and highlight",
    "- colour grade, palette, contrast, grain and light falloff",
    "",
    `ONLY CHANGE: ${bare}. 100% identical otherwise.`,
  ].join("\n");
}

function buildTexturePrompt(subject: string, lang: LiraLang): string {
  const bare = stripTerminator(subject);
  if (lang === "zh") {
    return [
      "修复成片上的粗糙 AI 纹理。",
      "",
      `修改：${bare}。`,
      "",
      "完全保留：构图、身份、光线、色彩分级与颗粒质感——只有列出的表面恢复真实细节。不做点编辑。",
    ].join("\n");
  }
  return [
    "Revive sloppy AI textures on the finished frame.",
    "",
    `CHANGE: ${bare}.`,
    "",
    "PRESERVE EXACTLY: composition, identity, lighting, colour grade and grain character — only the listed surfaces gain true-to-life detail. No point edits.",
  ].join("\n");
}

function buildViewChangePrompt(subject: string, lang: LiraLang): string {
  const bare = stripTerminator(subject);
  if (lang === "zh") {
    return [
      `同一地点的全新机位：${bare}。`,
      "",
      "新布局逐件写清：主视角里【物体 A】在右侧，这个反转机位里它必须落在左侧；原先在机位背后的【物体 B】现在出现在前方；【每个主要物体的新位置都要逐件锚定】。",
      "",
      "完全保留：空间的材质、调色板、分级与光线方向——只有机位改变。",
      "",
      RULE_OF_THIRDS.zh,
    ].join("\n");
  }
  return [
    `A new camera position of the same location: ${bare}.`,
    "",
    "NEW ARRANGEMENT, spelled out object by object: [object A] was on the right in the main view — in this reverse view it is on the LEFT; [object B] that was behind the camera is now visible ahead; [anchor every major object's new position explicitly].",
    "",
    "PRESERVE EXACTLY: the materials of the space, palette, grade and light direction — only the camera position changes.",
    "",
    RULE_OF_THIRDS.en,
  ].join("\n");
}

function buildPrompt(taskType: LiraTaskType, subject: string, paletteLine: string, lang: LiraLang): string {
  switch (taskType) {
    case "character":
      return buildCharacterPrompt(subject, paletteLine, lang);
    case "location":
      return buildLocationPrompt(subject, paletteLine, lang);
    case "prop":
      return buildPropPrompt(subject, paletteLine, lang);
    case "edit":
      return buildEditPrompt(subject, lang);
    case "texture":
      return buildTexturePrompt(subject, lang);
    case "viewChange":
      return buildViewChangePrompt(subject, lang);
    default:
      return subject;
  }
}

/* ================================================================== *
 * 8. 入口
 * ================================================================== */

export function optimizeLiraPrompt(input: LiraOptimizeInput): LiraOptimizeResult {
  const lang: LiraLang = input.lang ?? "zh";
  const zh = lang === "zh";
  const purpose = input.purpose.trim();

  if (!purpose) {
    return {
      prompt: "",
      route: {
        taskType: "location",
        model: TASK_MODEL.location[lang],
        summary: zh ? "请先输入意图草稿" : "Enter a draft intent first",
      },
      notes: [],
    };
  }

  // 先剔平台参数、再做正向改写，最后才推断任务类型：否则「不要人物」里的「人物」
  // 会把空镜误判成人物设定图，「不要卡通」会把写实人物误判成别的类型。
  const stripped = stripPlatformParameters(purpose);
  const rewritten = applyPositiveRewrites(stripped.text, lang);
  const subject = cleanDraft(rewritten.text, lang);

  const inferred: LiraTaskType = input.taskType === "auto" ? inferTaskType(rewritten.text) : input.taskType;
  const manualModel = typeof input.targetModel === "string" ? input.targetModel.trim() : "";
  const model = manualModel || TASK_MODEL[inferred][lang];

  const explicitPalette = typeof input.referencePalette === "string" ? input.referencePalette.trim() : "";
  let paletteHues: PaletteHue[] = [];
  let paletteSource: "input" | "colour" | "scene" | "none" = "none";
  if (explicitPalette) {
    paletteHues = [{ zh: explicitPalette, en: explicitPalette }];
    paletteSource = "input";
  } else {
    const fromDraft = detectHues(purpose);
    if (fromDraft.length > 0) {
      paletteHues = fromDraft.slice(0, 3);
      paletteSource = "colour";
    } else {
      const fromScene = detectSceneHues(purpose);
      if (fromScene.length > 0) {
        paletteHues = fromScene;
        paletteSource = "scene";
      }
    }
  }
  const paletteLine = buildPaletteLine(paletteHues, lang);

  const prompt = buildPrompt(inferred, subject, paletteLine, lang);

  /* ---------------- 应用提示（文档的 pre-send checklist 落到 notes） ---------------- */

  const notes: string[] = [];
  notes.push(
    zh
      ? `任务判定：${TASK_LABEL[inferred].zh}（${input.taskType === "auto" ? "自动" : "手动指定"}）`
      : `Task routing: ${TASK_LABEL[inferred].en} (${input.taskType === "auto" ? "auto-detected" : "manual"})`,
  );
  notes.push(
    manualModel
      ? zh
        ? `目标模型已手动指定：${model}`
        : `Target model set manually: ${model}`
      : zh
        ? `建议模型：${model}`
        : `Suggested model: ${model}`,
  );

  if (stripped.removed.length > 0) {
    const list = Array.from(new Set(stripped.removed)).join(zh ? "、" : ", ");
    notes.push(
      zh
        ? `已从草稿剔除平台参数：${list}（画幅与分辨率属于平台参数，在 UI 里设置，不写进提示词）`
        : `Platform parameters stripped: ${list} (aspect and resolution belong in the UI, never in prompt text)`,
    );
  }
  if (rewritten.applied.length > 0) {
    const list = rewritten.applied.map((item) => (zh ? item.zh : item.en)).join(zh ? "；" : "; ");
    notes.push(
      zh
        ? `已按「正向优先」改写成正向描述（这些模型都没有负面提示词参数）：${list}`
        : `Rewritten positive-first (no model here has a negative prompt): ${list}`,
    );
  }
  if (paletteSource === "colour") {
    notes.push(zh ? "调色板取自草稿里出现的颜色词。" : "Palette derived from colour words in the draft.");
  } else if (paletteSource === "scene") {
    notes.push(
      zh
        ? "调色板按草稿的场景线索推导，请对着实际画面校正。"
        : "Palette derived from the scene context — correct it against the actual look.",
    );
  } else if (paletteSource === "none" && inferred !== "edit" && inferred !== "texture" && inferred !== "viewChange") {
    notes.push(
      zh
        ? "草稿里没有颜色或场景线索，调色板留了占位——文档要求调色板只能由你的指令或参考图推导，不能凭空发明。"
        : "No colour or scene cue, so the palette is left as a placeholder — it must come from your brief or references, never invented.",
    );
  }

  if (inferred === "character") {
    notes.push(
      zh
        ? "跨镜头一致性由 Soul ID（平台参数）承载，散文里的「同一真实人物」只做强化；Soul 2.0 没有 21:9，宽银幕人物帧请走 Soul Cinema + Soul ID；角色设定图豁免三分法。"
        : "Cross-shot consistency is carried by Soul ID (a platform parameter); the prose anchor only reinforces it. Soul 2.0 has no 21:9 — widescreen character plates go to Soul Cinema with a Soul ID. Sheets are exempt from the rule of thirds.",
    );
    if (isCharacterDraftVague(subject)) {
      notes.push(
        zh
          ? "人物描述不足：请补性别、年龄、发型发色、五官、服装、表情。"
          : "Thin character description: add gender, age, hair, facial features, wardrobe and expression.",
      );
    }
  }
  if (inferred === "location") {
    notes.push(
      zh
        ? "机位锚点是空镜最常见的失败点：用「高角度四分之三广角，机位高于空间 45 度斜向下」这种大白话，别写 CCTV / 鱼眼等抽象术语；光学与景深语言留给人物，不要用在场景上。"
        : 'The camera anchor is the usual failure point on locations: plain wording ("high angle three-quarter wide, camera high above the space at 45 degrees") beats CCTV/fisheye jargon. Optics and DOF language belongs to characters, not locations.',
    );
  }
  if (inferred === "edit") {
    notes.push(
      zh
        ? "编辑永远先走 NBP，且是对原片的后期处理：一次只改一处，其余全部列进「完全保留」。要重建画面就不是编辑，请回 Soul 系重新生成。"
        : "Every edit starts on NBP as post-processing of the original: one change per pass, everything else under PRESERVE EXACTLY. Rebuilding a frame is not an edit — regenerate it in a Soul model.",
    );
  }
  if (inferred === "texture") {
    notes.push(
      zh
        ? "Seedream 4.5 只做纹理通道，永远不要给它点编辑。"
        : "Seedream 4.5 is a texture pass only — never hand it a point edit.",
    );
  }
  if (inferred === "viewChange") {
    notes.push(
      zh
        ? "机位反转默认走 GPT Image 2；若改用 NBP，必须逐件写清每个物体在新机位下的位置，否则几何会被打乱。"
        : "View changes default to GPT Image 2; on NBP you must spell out each object's new position or the geometry scrambles.",
    );
  }
  if (inferred === "prop") {
    notes.push(
      zh
        ? "道具是这个工作流里唯一不走 Soul 系的生成任务：走 NBP / GPT Image 2；无品牌要求就正向写「素净无品牌哑光表面」。"
        : 'Props are the one generation task that does not go to a Soul model: NBP / GPT Image 2. For no logos, state "plain unbranded blank matte surface" positively.',
    );
  }

  const length = Array.from(prompt).length;
  if (length > 2000) {
    notes.push(
      zh
        ? `提示词 ${length} 字符，超过文档建议的 1500–2000 上限：每多一个从句都会稀释注意力，建议精简。`
        : `The prompt is ${length} characters, over the 1500–2000 target — extra clauses dilute attention, so trim it.`,
    );
  }

  const draftLength = purpose.replace(/\s+/g, "").length;
  if (draftLength < (zh ? 24 : 80)) {
    notes.push(
      zh
        ? "草稿信息较少，建议补光线、材质、构图或调色方向。"
        : "The draft is thin — add light, materials, composition or palette direction.",
    );
  }

  return {
    prompt,
    route: { taskType: inferred, model, summary: `${TASK_LABEL[inferred][lang]} → ${model}` },
    notes,
  };
}
