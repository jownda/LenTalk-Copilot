/**
 * 电影大师风格库
 * 每个风格包含「详细组成」: 构图 / 色彩 / 光线 / 运镜 / 质感 / 氛围。
 * 编译提示词时作为 STYLE 段注入, 让生成器还原该大师的标志性视觉语言。
 * id 为稳定标识, 持久化在 Project.styleId。
 */

export interface MasterStyle {
  id: string;
  name: string;
  nameZh: string;
  era: string;
  /** 详细风格组成(中文), UI 展示辅助 */
  traits: string;
  /** 对应结构化技术配方（P1.1：大师 = 配方；选中后自动填充 TechnicalProfile） */
  recipeId?: string;
}

export const MASTER_STYLES: MasterStyle[] = [
  {
    id: "wong-kar-wai", name: "Wong Kar-wai", nameZh: "王家卫", era: "1990s-2000s", recipeId: "wong-karwai-urban",
    traits: "手持晃动与慢门拖影, 霓虹与暗部高饱和的冷暖对冲, 烟雾弥漫的潮湿夜景, 碎片化诗意构图, 时间流逝的呼吸感, 角色孤独疏离的氛围"
  },
  {
    id: "roger-deakins", name: "Roger Deakins", nameZh: "罗杰·迪金斯", era: "1980s-present", recipeId: "deakins-controlled",
    traits: "自然主义布光, 高反差低调影像, 烟幕与尘埃塑造的体积感光线, 细腻柔和的阴影过渡, 纪实质感的色彩还原, 克制而精准的运镜"
  },
  {
    id: "wes-anderson", name: "Wes Anderson", nameZh: "韦斯·安德森", era: "1990s-present", recipeId: "wes-anderson-symmetry",
    traits: "严格对称的居中构图, 粉彩与糖果色的明快色调, 横移推轨运镜, 平面化道具陈列, 微缩模型般的场景, 复古而俏皮的氛围"
  },
  {
    id: "stanley-kubrick", name: "Stanley Kubrick", nameZh: "斯坦利·库布里克", era: "1950s-1990s", recipeId: "kubrick-formal",
    traits: "单点透视的对称构图, 冷峻的色温与大面积留白, 缓慢推进的镜头, 几何化空间布局, 精确布光下的高对比, 理性而疏离的宿命感"
  },
  {
    id: "christopher-nolan", name: "Christopher Nolan", nameZh: "克里斯托弗·诺兰", era: "2000s-present", recipeId: "nolan-imax",
    traits: "IMAX 级宏大视野, 冷蓝与琥珀的对比色, 实拍质感的颗粒与细节, 广角纵深构图, 严谨对称的场面调度, 肃穆压抑的史诗氛围"
  },
  {
    id: "andrei-tarkovsky", name: "Andrei Tarkovsky", nameZh: "安德烈·塔可夫斯基", era: "1960s-1980s", recipeId: "tarkovsky-time",
    traits: "绵长的慢镜头与时间质感, 自然光与潮湿表面的反光, 水雾泥土的触感细节, 梦境般的象征意象, 低饱和度大地色调, 静谧沉思的诗意"
  },
  {
    id: "denis-villeneuve", name: "Denis Villeneuve", nameZh: "丹尼斯·维伦纽瓦", era: "2000s-present", recipeId: "villeneuve-monumental",
    traits: "极简宏大的构图, 低饱和的土黄与灰蓝大地色, 广角纵深的荒凉透视, 缓慢沉稳的运镜, 强颗粒的胶片质感, 肃穆而疏离的氛围"
  },
  {
    id: "bong-joon-ho", name: "Bong Joon-ho", nameZh: "奉俊昊", era: "2000s-present", recipeId: "bong-genre",
    traits: "社会写实与黑色幽默的混搭, 手持纪实晃动, 类型片式的精准剪辑节奏, 阴郁的雨景与逼仄空间, 冷暖对比的都市色调, 荒诞与压迫并存"
  },
  {
    id: "ridley-scott", name: "Ridley Scott", nameZh: "雷德利·斯科特", era: "1970s-present", recipeId: "ridley-scott-industrial",
    traits: "暗调工业质感, 逆光剪影与光束烟尘, 厚重的色彩与金属冷光, 宏大的场景纵深, 高反差硬光, 压迫感十足的史诗氛围"
  },
  {
    id: "hayao-miyazaki", name: "Hayao Miyazaki", nameZh: "宫崎骏", era: "1980s-2010s", recipeId: "miyazaki-watercolor",
    traits: "水彩质感的通透画风, 云海与光影的流动, 细腻的植物与自然细节, 柔和的低饱和暖色调, 治愈而辽阔的天空构图, 温柔梦幻的冒险氛围"
  },
  {
    id: "makoto-shinkai", name: "Makoto Shinkai", nameZh: "新海诚", era: "2000s-present", recipeId: "shinkai-skies",
    traits: "高饱和的光影与逆光光晕, 极致的天空与云层细节, 细腻的雨滴与玻璃反光, 通透的青春色调, 广角风景与人物对比, 清澈而感伤的青春氛围"
  },
  {
    id: "david-fincher", name: "David Fincher", nameZh: "大卫·芬奇", era: "1990s-present", recipeId: "fincher-tense",
    traits: "冷调低饱和的数字质感, 精妙克制的运镜与推拉, 暗部细节丰富的低调布光, 干净的几何构图, 平滑的数字摄影纹理, 冷静紧张的心理氛围"
  },
  {
    id: "emmanuel-lubezki", name: "Emmanuel Lubezki", nameZh: "伊曼纽尔·卢贝兹基", era: "1990s-present", recipeId: "lubezki-dynamic",
    traits: "广角贴身跟拍, 浮动手持与长镜头能量, 自然呼吸式推进, 柔和自然光与逆光边缘光, 暖肤色通透高光, 流动的场面调度"
  }
];

export const getStyle = (id?: string): MasterStyle | undefined => MASTER_STYLES.find((style) => style.id === id);

/** 生成可注入提示词的风格描述 */
export function styleDescription(style?: MasterStyle): string {
  return style
    ? `${style.name} (${style.nameZh}) style, ${style.era}: ${style.traits}`
    : "grounded cinematic realism";
}
