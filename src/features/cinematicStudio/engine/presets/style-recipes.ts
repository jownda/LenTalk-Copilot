/**
 * 大师风格配方（P1.1）
 * 「大师不是一个名字」：点选风格 → 自动填充摄影/光线/色彩/构图/禁止默认建议值，
 * 用户可覆写任意已锁定之外的字段。
 */
export interface StyleRecipe {
  id: string;
  name: string;
  nameEn: string;
  /** 摄影/机位 */
  cinematography: string[];
  /** 光线 */
  lighting: string[];
  /** 色彩/质感 */
  color: string[];
  /** 色彩/质感（中文，界面为中文时配方描述显示） */
  colorZh?: string[];
  /** 构图/节奏 */
  composition: string[];
  /** 禁止默认（编译为 Avoid: ...） */
  forbidden: string[];
  /** 推荐模块预设（选中风格后自动填入的下拉模块；preset id） */
  modules?: {
    format?: string;
    filmStock?: string;
    acting?: string;
    skin?: string;
    physics?: string;
    sharpness?: string;
  };
}

export const STYLE_RECIPES: StyleRecipe[] = [
  {
    id: "lubezki-dynamic", name: "Lubezki 动态自然主义", nameEn: "Lubezki Dynamic Naturalism",
    cinematography: ["wide intimate tracking", "floating handheld", "long-take energy", "natural breathing push-ins"],
    lighting: ["soft natural light", "backlit rim light", "gentle facial fill"],
    color: ["warm skin tones", "translucent highlights", "natural contrast"],
    colorZh: ["暖肤色", "半透明高光", "自然对比"],
    composition: ["characters always in motion", "environmental depth", "fluid blocking"],
    forbidden: ["overly stable shots", "stiff blocking", "fragmented hard cuts"],
    modules: { format: "photoreal", acting: "micro-expression", skin: "natural-beauty", physics: "realistic-athletic", sharpness: "natural-detail" },
  },
  {
    id: "deakins-controlled", name: "Deakins 克制写实", nameEn: "Deakins Controlled Realism",
    cinematography: ["stable and precise", "restrained handheld", "focal length serves narrative"],
    lighting: ["motivated light sources", "shadow detail", "soft shadow transitions"],
    color: ["low-saturation true color", "clean midtones", "delicate highlights"],
    colorZh: ["低饱和真实色", "干净中间调", "细腻高光"],
    composition: ["clear subject", "negative space", "scene geometry"],
    forbidden: ["color pollution", "unmotivated light", "gratuitous flares"],
    modules: { format: "photoreal", filmStock: "kodak-250d", acting: "micro-expression", skin: "natural-beauty", physics: "realistic-athletic", sharpness: "natural-detail" },
  },
  {
    id: "lubezki-deakins-action", name: "Lubezki × Deakins 动作自然主义", nameEn: "Lubezki × Deakins Action Naturalism",
    cinematography: ["dynamic handheld with clear storytelling", "24/35/50mm alternating"],
    lighting: ["overcast diffuse", "backlit rim", "soft facial fill"],
    color: ["warm skin tones", "low-saturation environment", "natural grain"],
    colorZh: ["暖肤色", "低饱和环境", "自然颗粒"],
    composition: ["strong depth", "readable action", "golden ratio"],
    forbidden: ["oversharpening", "video-game cutscene look", "floating movement"],
    modules: { format: "photoreal", acting: "urgent-action", skin: "natural-beauty", physics: "realistic-athletic", sharpness: "natural-detail" },
  },
  {
    id: "fincher-tense", name: "Fincher 紧张精确", nameEn: "Fincher Tense Precision",
    cinematography: ["smooth stable moves", "slow push-ins", "precise framing"],
    lighting: ["low-key directional light", "shadow texture retained"],
    color: ["cool green desaturated", "digital detail"],
    colorZh: ["冷绿低饱和", "数字细节"],
    composition: ["geometric order", "oppressive negative space"],
    forbidden: ["shaky handheld", "too warm", "casual framing"],
    modules: { format: "photoreal", acting: "micro-expression", skin: "natural-beauty", physics: "realistic-athletic", sharpness: "no-oversharp" },
  },
  {
    id: "wong-karwai-urban", name: "王家卫 都市记忆", nameEn: "Wong Kar-wai Urban Memory",
    cinematography: ["intimate handheld", "slow shutter streaks", "partial voyeuristic framing"],
    lighting: ["neon", "wet reflections", "colored shadows in darkness"],
    color: ["high-saturation warm-cool clash", "grain", "color casts"],
    colorZh: ["高饱和冷暖冲突", "颗粒", "色偏"],
    composition: ["fragmented occlusion", "isolated characters"],
    forbidden: ["clean commercial light", "flat daylight"],
    modules: { format: "photoreal", filmStock: "kodak-500t", acting: "micro-expression", skin: "natural-beauty", physics: "rain-wet", sharpness: "fine-grain" },
  },
  {
    id: "kubrick-formal", name: "库布里克 形式张力", nameEn: "Kubrick Formal Tension",
    cinematography: ["stable symmetry", "slow pushes", "wide-angle perspective"],
    lighting: ["precise lighting", "controlled high contrast"],
    color: ["cool neutral", "crisp edges"],
    colorZh: ["冷中性色", "锐利边缘"],
    composition: ["one-point perspective", "centered subjects", "geometric order"],
    forbidden: ["random handheld", "cluttered staging"],
    modules: { format: "photoreal", acting: "micro-expression", skin: "natural-beauty", physics: "realistic-athletic", sharpness: "natural-detail" },
  },
  {
    id: "nolan-imax", name: "诺兰 实拍 IMAX 能量", nameEn: "Nolan Practical IMAX Energy",
    cinematography: ["large-format wide", "practical movement", "practical-impact energy"],
    lighting: ["high-contrast daylight / practical light"],
    color: ["cool blue with amber", "real grain", "deep perspective"],
    colorZh: ["冷蓝与琥珀", "真实颗粒", "深邃透视"],
    composition: ["monumental space", "clear action direction"],
    forbidden: ["plastic CGI", "weightless explosions"],
    modules: { format: "photoreal", filmStock: "kodak-250d", acting: "urgent-action", skin: "natural-beauty", physics: "impact-debris", sharpness: "natural-detail" },
  },
  {
    id: "villeneuve-monumental", name: "维伦纽瓦 纪念碑极简", nameEn: "Villeneuve Monumental Minimalism",
    cinematography: ["stable wide shots", "slow movement", "restrained close-ups"],
    lighting: ["soft haze", "backlight", "low-light spaces"],
    color: ["grey-blue / ochre low saturation", "heavy atmosphere"],
    colorZh: ["灰蓝/赭石低饱和", "厚重氛围"],
    composition: ["minimal subjects", "vast negative space"],
    forbidden: ["fast whip pans", "vivid candy colors"],
    modules: { format: "photoreal", filmStock: "arri-logc", acting: "restrained-grief", skin: "natural-beauty", physics: "realistic-athletic", sharpness: "natural-detail" },
  },
  {
    id: "bong-genre", name: "奉俊昊 类型写实", nameEn: "Bong Genre Realism",
    cinematography: ["handheld documentary switching with precise genre cutting"],
    lighting: ["rain", "cool interior light", "natural practicals"],
    color: ["wet urban warm-cool contrast"],
    colorZh: ["湿冷城市冷暖对比"],
    composition: ["clear ensemble relationships", "cramped spaces"],
    forbidden: ["romantic filters", "uncaused action"],
    modules: { format: "photoreal", filmStock: "kodak-250d", acting: "micro-expression", skin: "natural-beauty", physics: "rain-wet", sharpness: "natural-detail" },
  },
  {
    id: "wes-anderson-symmetry", name: "韦斯·安德森 对称糖果", nameEn: "Wes Anderson Symmetry",
    cinematography: ["strict centered symmetry", "lateral tracking moves", "flat dollhouse staging"],
    lighting: ["even bright daylight", "soft pastel fill", "no harsh shadows"],
    color: ["pastel candy palette", "vivid saturated midtones"],
    colorZh: ["粉彩糖果色", "鲜活饱和中间调"],
    composition: ["perfect one-point symmetry", "flat object arrangements", "dollhouse scale"],
    forbidden: ["handheld instability", "gritty texture", "dark desaturated grade"],
    modules: { format: "photoreal", acting: "micro-expression", skin: "natural-beauty", physics: "realistic-athletic", sharpness: "no-oversharp" },
  },
  {
    id: "tarkovsky-time", name: "塔可夫斯基 时间质感", nameEn: "Tarkovsky Time",
    cinematography: ["long slow takes", "slow contemplative moves", "time-laden pauses"],
    lighting: ["natural light", "wet surface reflections", "low-contrast diffusion"],
    color: ["low-saturation earth tones", "mud and mist textures"],
    colorZh: ["低饱和大地色", "泥土与雾气质感"],
    composition: ["dreamlike symbolic imagery", "elemental foregrounds", "vast contemplative space"],
    forbidden: ["fast cutting", "high-key commercial light", "glossy digital look"],
    modules: { format: "photoreal", filmStock: "kodak-500t", acting: "restrained-grief", skin: "natural-beauty", physics: "realistic-athletic", sharpness: "fine-grain" },
  },
  {
    id: "ridley-scott-industrial", name: "雷德利·斯科特 工业暗调", nameEn: "Ridley Scott Industrial",
    cinematography: ["epic wide staging", "slow majestic moves", "deep perspective"],
    lighting: ["high-contrast hard light", "backlit silhouettes", "god rays through smoke"],
    color: ["heavy color saturation", "metallic cold highlights", "deep shadows"],
    colorZh: ["重饱和色", "金属冷高光", "深阴影"],
    composition: ["monumental depth", "imposing environment scale"],
    forbidden: ["flat even lighting", "small intimate framing", "pastel palette"],
    modules: { format: "photoreal", filmStock: "kodak-500t", acting: "urgent-action", skin: "pore-level", physics: "impact-debris", sharpness: "natural-detail" },
  },
  {
    id: "miyazaki-watercolor", name: "宫崎骏 水彩冒险", nameEn: "Miyazaki Watercolor",
    cinematography: ["gentle tracking through landscapes", "sweeping aerial moves"],
    lighting: ["soft luminous daylight", "flowing cloud light"],
    color: ["translucent watercolor palette", "warm low-saturation tones"],
    colorZh: ["半透明水彩", "温暖低饱和"],
    composition: ["expansive sky compositions", "detailed natural foregrounds", "healing open space"],
    forbidden: ["harsh contrast", "neon colors", "gritty textures"],
    modules: { format: "stylized-animation", acting: "micro-expression", skin: "natural-beauty", physics: "realistic-athletic", sharpness: "no-oversharp" },
  },
  {
    id: "shinkai-skies", name: "新海诚 天空青春", nameEn: "Shinkai Skies",
    cinematography: ["wide landscape vs character contrast", "slow push-ins on details"],
    lighting: ["high-saturation backlight", "lens flare halos", "god rays"],
    color: ["ultra-vivid sky tones", "translucent highlights", "tear-clear clarity"],
    colorZh: ["超鲜活天空色", "半透明高光", "泪透清澈"],
    composition: ["extreme sky detail", "glass and rain reflections", "wide-angle grandeur"],
    forbidden: ["muted desaturation", "flat overcast gray", "soft commercial glow"],
    modules: { format: "stylized-animation", acting: "micro-expression", skin: "natural-beauty", physics: "realistic-athletic", sharpness: "no-oversharp" },
  },
];

export function recipeById(id?: string): StyleRecipe | undefined {
  return STYLE_RECIPES.find((recipe) => recipe.id === id);
}
