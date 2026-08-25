import type { PromptOptimizerTaskType } from "./canvasNodes";

export interface LiraRoute {
  taskType: Exclude<PromptOptimizerTaskType, "auto">;
  model: string;
  summary: string;
}

export interface LiraOptimizeInput {
  purpose: string;
  taskType: PromptOptimizerTaskType;
  targetModel?: string;
  referencePalette?: string;
  /** 输出语言：zh=中文, en=English(默认)。 */
  lang?: 'zh' | 'en';
}

export interface LiraOptimizeResult {
  prompt: string;
  route: LiraRoute;
  notes: string[];
}

const TASK_LABEL: Record<LiraRoute["taskType"], string> = {
  character: "人物",
  location: "地点/环境",
  prop: "道具",
  edit: "编辑",
  texture: "纹理修复",
  viewChange: "机位反转",
};

const TASK_MODEL: Record<LiraRoute["taskType"], string> = {
  character: "Soul 2.0",
  location: "Soul Cinema",
  prop: "NBP / GPT Image 2",
  edit: "NBP（优先）",
  texture: "Seedream 4.5",
  viewChange: "GPT Image 2",
};

const TECH_CINEMATIC =
  "Photorealistic ARRI Alexa LF anamorphic Cooke S4 lens at T2.0, organic 35mm Kodak Vision3 250D film grain, soft cinematic falloff, cinematic film still aesthetic";

const TECH_CLEAN =
  "Shot on ARRI Alexa Mini LF with ARRI Signature Prime lens, clean modern digital cinematic capture, crisp natural detail, minimal fine grain, soft cinematic falloff, modern cinematic film still quality";

const TECH_TEXTURE =
  "Cinematic still, true-to-life material detail, natural film grain, soft falloff";

const PALETTE_WRAPPER = (palette: string): string =>
  `Refined desaturated palette: ${palette}, deep crushed blacks, restrained naturalistic grading, soft low contrast, strong cinematic chiaroscuro`;

const EDIT_TASK_WORDS = /edit|change|replace|remove|fix the|swap|换掉|替换|去掉|移除|修改|改成|加上|删除/i;
const TEXTURE_WORDS = /texture|skin pores|fabric weave|ai slop|sloppy|纹理|皮肤质感|布料|发糊|塑料感|皮肤毛孔/i;
const VIEW_WORDS = /reverse angle|new camera|opposite side|other side|behind the camera|反打|反向|机位反转|另一个角度|背面视角|转到.*(后面|背后)/i;
const CHARACTER_WORDS = /character|portrait|casting|ugc|fashion|model|person|woman|man|girl|boy|face|body|人物|角色|肖像|模特|穿搭|人像|男人|女人|女孩|男孩|脸|全身/i;
const LOCATION_WORDS = /location|environment|establishing shot|interior|exterior|room|street|building|landscape|cityscape|地点|环境|空镜|室内|室外|房间|街道|建筑|场景|景|山|海|森林|天空/i;
const PROP_WORDS = /prop|product|object|item|gun|sword|device|packaging|道具|产品|物品|物件|武器|商品/i;

function stripPlatformParameters(text: string): string {
  return text
    .replace(/--ar\s*\S+/gi, " ")
    .replace(/--\w+/g, " ")
    .replace(/\b(16:9|21:9|9:16|4:3|3:4|1:1|2:3|3:2|4:5|5:4)\b/gi, " ")
    .replace(/\b(4k|8k|2k|1k|uhd|hd)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanDraft(text: string): string {
  const cleaned = stripPlatformParameters(text).replace(/["“”]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > 0 && !/[.!?。！？,:：;；]$/.test(cleaned) ? `${cleaned}.` : cleaned;
}

function isCharacterDraftVague(subject: string): boolean {
  const stripped = subject
    .replace(/人物角色设定图|角色设定图|人物设定图|人物设定|角色设定|人物图|人像|肖像|全身|character\s*sheet|portrait|casting|model|person|character/gi, " ")
    .replace(/[\s.,!?。！？，,:：;；'"“”-]+/g, "")
    .trim();
  return stripped.length === 0;
}

function buildPrompt(
  taskType: LiraRoute["taskType"],
  purpose: string,
  palette?: string,
): string {
  const subject = cleanDraft(purpose);
  const tech =
    taskType === "location" ? TECH_CINEMATIC : taskType === "texture" ? TECH_TEXTURE : TECH_CLEAN;
  const paletteLine =
    palette && palette.trim().length > 0 ? PALETTE_WRAPPER(palette.trim()) : "";

  switch (taskType) {
    case "character":
      return [
        "A film character sheet in three panels on a solid neutral grey background: a full-body front photo on the left, a full-body back photo in the middle, and a large close-up portrait on the right, the same real person in all three, consistent across panels. Soft even light with no hard shadows and no blown-out highlights; no studio, no equipment, no walls, no rim light.",
        "Both full-body panels are framed from the neck down; the head and face appear only in the close portrait, drawn in three-quarter view to show the front and the side at once.",
        isCharacterDraftVague(subject)
          ? "The person: [待补充：性别、年龄、发型发色、五官、服装、表情]"
          : `The person: ${subject}`,
        "Wardrobe consistent in all panels. Hands empty, no props.",
        `${paletteLine} ${tech}.`.trim(),
      ]
        .filter(Boolean)
        .join("\n\n");
    case "location":
      return [
        `High angle three-quarter wide shot, camera positioned to anchor the space clearly. ${subject}`,
        "Key architectural and natural elements described concretely, secondary details receding into depth.",
        `${paletteLine} ${tech}.`.trim(),
        "Empty deserted space with still air, stated as a quality of the scene.",
      ]
        .filter(Boolean)
        .join("\n\n");
    case "prop":
      return [
        `Photorealistic three-quarter overhead product shot of ${subject} on a neutral grey concrete surface, soft directional lighting, isolated subject.`,
        "Concrete description of materials and wear state. Plain unbranded blank matte surfaces.",
        `${paletteLine} ${tech}.`.trim(),
      ]
        .filter(Boolean)
        .join("\n\n");
    case "edit":
      return [
        `Edit the image: ${subject}`,
        `CHANGE: ${subject}`,
        "PRESERVE EXACTLY:",
        "- identity, wardrobe, props and their positions, camera angle, wall and floor, every existing shadow",
        "- color grade, palette, contrast, grain, light falloff",
        `ONLY CHANGE: ${subject} 100% identical otherwise.`,
      ].join("\n");
    case "texture":
      return [
        "Revive sloppy AI textures on the finished frame.",
        `CHANGE: ${subject}`,
        "PRESERVE EXACTLY: composition, identity, lighting, color grade.",
      ].join("\n");
    case "viewChange":
      return [
        `A new camera position of the same location: ${subject}`,
        "Spell out the mirrored blocking object by object so the new arrangement is explicit.",
        `${paletteLine} ${tech}.`.trim(),
      ]
        .filter(Boolean)
        .join("\n\n");
    default:
      return subject;
  }
}

const TECH_CINEMATIC_ZH =
  "写实 ARRI Alexa LF 变形宽银幕 Cooke S4 镜头 T2.0，有机 35mm Kodak Vision3 250D 胶片颗粒，柔和电影感衰减，电影剧照质感";

const TECH_CLEAN_ZH =
  "使用 ARRI Alexa Mini LF 与 ARRI Signature Prime 镜头拍摄，干净的现代数字电影质感，清晰自然细节，极轻微颗粒，柔和电影感衰减，现代电影剧照品质";

const TECH_TEXTURE_ZH =
  "电影剧照，真实材质细节，自然胶片颗粒，柔和衰减";

const PALETTE_WRAPPER_ZH = (palette: string): string =>
  `精炼低饱和调色板：${palette}，深黑压暗，克制的自然主义分级，柔和低对比，强烈电影明暗对比`;

function buildPromptZh(
  taskType: LiraRoute["taskType"],
  purpose: string,
  palette?: string,
): string {
  const subject = cleanDraft(purpose);
  const tech =
    taskType === "location"
      ? TECH_CINEMATIC_ZH
      : taskType === "texture"
        ? TECH_TEXTURE_ZH
        : TECH_CLEAN_ZH;
  const paletteLine =
    palette && palette.trim().length > 0 ? PALETTE_WRAPPER_ZH(palette.trim()) : "";

  switch (taskType) {
    case "character":
      return [
        "一张三格角色设定图，纯中性灰背景：左侧正面全身照、中间背面全身照、右侧大幅特写头像，三格为同一真实人物，所有面板保持一致。柔和均匀光线，无硬阴影、无过曝高光；无影棚、无设备、无墙壁、无轮廓光。",
        "两张全身照均从颈部以下取景，头部与脸部仅出现在特写头像中；特写采用四分之三侧面，同时呈现正面与侧面。",
        isCharacterDraftVague(subject)
          ? "人物：[待补充：性别、年龄、发型发色、五官、服装、表情]"
          : `人物：${subject}`,
        "所有面板服装保持一致。双手空置，不持任何道具。",
        `${paletteLine} ${tech}.`.trim(),
      ]
        .filter(Boolean)
        .join("\n\n");
    case "location":
      return [
        `高角度四分之三广角镜头，机位清晰锚定空间。${subject}`,
        "关键的建筑与自然元素具体描述，次要细节向纵深退去。",
        `${paletteLine} ${tech}.`.trim(),
        "空旷无人的空间，空气静止，作为场景质感呈现。",
      ]
        .filter(Boolean)
        .join("\n\n");
    case "prop":
      return [
        `${subject} 置于中性灰水泥面上的写实四分之三俯拍产品照，柔和方向光，主体独立。`,
        "材质与磨损状态具体描述。素净无品牌哑光表面。",
        `${paletteLine} ${tech}.`.trim(),
      ]
        .filter(Boolean)
        .join("\n\n");
    case "edit":
      return [
        `编辑图片：${subject}`,
        `修改：${subject}`,
        "完全保留：",
        "- 身份、服装、道具及其位置、机位角度、墙面与地面、所有既有阴影",
        "- 色彩分级、调色板、对比度、颗粒、光线衰减",
        `仅修改：${subject}，其余 100% 保持一致。`,
      ].join("\n");
    case "texture":
      return [
        "修复成片上的粗糙 AI 纹理。",
        `修改：${subject}`,
        "完全保留：构图、身份、光线、色彩分级。",
      ].join("\n");
    case "viewChange":
      return [
        `同一地点的全新机位：${subject}`,
        "逐件写出镜像后的遮挡关系，使新布局明确。",
        `${paletteLine} ${tech}.`.trim(),
      ]
        .filter(Boolean)
        .join("\n\n");
    default:
      return subject;
  }
}

function inferTaskType(purpose: string): Exclude<PromptOptimizerTaskType, "auto"> {
  if (TEXTURE_WORDS.test(purpose)) return "texture";
  if (VIEW_WORDS.test(purpose)) return "viewChange";
  if (EDIT_TASK_WORDS.test(purpose)) return "edit";
  if (CHARACTER_WORDS.test(purpose)) return "character";
  if (LOCATION_WORDS.test(purpose)) return "location";
  if (PROP_WORDS.test(purpose)) return "prop";
  return "location";
}

export function optimizeLiraPrompt(input: LiraOptimizeInput): LiraOptimizeResult {
  const purpose = input.purpose.trim();
  if (!purpose) {
    return {
      prompt: "",
      route: { taskType: "location", model: TASK_MODEL.location, summary: "请先输入意图草稿" },
      notes: [],
    };
  }

  const inferred: Exclude<PromptOptimizerTaskType, "auto"> =
    input.taskType === "auto" ? inferTaskType(purpose) : input.taskType;
  const model =
    input.targetModel && input.targetModel.trim().length > 0
      ? input.targetModel.trim()
      : TASK_MODEL[inferred];
  const notes: string[] = [];
  const wordCount = purpose.split(/\s+/).filter(Boolean).length;

  notes.push(`任务判定：${TASK_LABEL[inferred]}（${inferred === input.taskType ? "手动指定" : "自动"}）`);
  if (input.targetModel && input.targetModel.trim().length > 0) {
    notes.push(`目标模型已手动指定：${model}`);
  }
  if (wordCount < 20) {
    notes.push("草稿信息较少，建议补充光线、材质、构图或调色板方向。");
  }
  if (inferred === "character" && isCharacterDraftVague(purpose)) {
    notes.push("人物描述不足，请在草稿中补充性别、年龄、发型发色、五官、服装或表情等具体信息。");
  }
  if (inferred === "character") {
    notes.push("角色设定图按项目规范：全身图从颈部以下取景，脸部仅由四分之三特写承载。");
  }

  const prompt =
    input.lang === 'zh'
      ? buildPromptZh(inferred, purpose, input.referencePalette)
      : buildPrompt(inferred, purpose, input.referencePalette);
  return {
    prompt,
    route: { taskType: inferred, model, summary: `${TASK_LABEL[inferred]} → ${model}` },
    notes,
  };
}