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
  /** 面向用户的一段英文风格说明；不是最终提示词中的导演姓名标签。 */
  description: string;
  /** 面向用户的一段中文风格说明。 */
  descriptionZh: string;
  /** 对应结构化技术配方（P1.1：大师 = 配方；选中后自动填充 TechnicalProfile） */
  recipeId?: string;
}

export const MASTER_STYLES: MasterStyle[] = [
  {
    id: "wong-kar-wai", name: "Wong Kar-wai", nameZh: "王家卫", era: "1990s-2000s", recipeId: "wong-karwai-urban",
    traits: "手持晃动与慢门拖影, 霓虹与暗部高饱和的冷暖对冲, 烟雾弥漫的潮湿夜景, 碎片化诗意构图, 时间流逝的呼吸感, 角色孤独疏离的氛围",
    descriptionZh: "以潮湿的城市夜色为底，用贴近人物的手持跟拍和轻微慢门拖影制造时间被拉长的感觉。霓虹色与深暗部形成冷暖冲撞，构图允许遮挡、切分和偶然失衡，让人物像被困在自己的记忆里。画面保留真实皮肤、烟雾和街道反光的质感，情绪疏离但不失呼吸感。",
    description: "Build the image from a humid urban night, using intimate handheld tracking and restrained shutter drag to make time feel stretched. Neon color collides with deep shadow in a controlled warm-cool tension; partial occlusion and fractured framing make the character feel trapped inside memory. Keep skin, smoke, and wet reflections physically believable, with an atmosphere that is distant yet still breathing."
  },
  {
    id: "roger-deakins", name: "Roger Deakins", nameZh: "罗杰·迪金斯", era: "1980s-present", recipeId: "deakins-controlled",
    traits: "自然主义布光, 高反差低调影像, 烟幕与尘埃塑造的体积感光线, 细腻柔和的阴影过渡, 纪实质感的色彩还原, 克制而精准的运镜",
    descriptionZh: "以有明确来源的自然光和实用光建立空间，控制曝光让暗部保留层次，同时让高光克制而有方向。构图清楚、运动精准，镜头不抢夺表演注意力；烟尘、墙面和衣料都保持真实材质，整体色彩接近现场所见，形成冷静、可信的纪实电影质感。",
    description: "Use motivated natural and practical light to establish the space, holding detail in the shadows while keeping highlights restrained and directional. Composition stays clear and camera movement stays precise so the image never competes with the performance. Preserve believable smoke, walls, and fabric, with colors close to what the location would truly look like for a calm, grounded cinematic realism."
  },
  {
    id: "wes-anderson", name: "Wes Anderson", nameZh: "韦斯·安德森", era: "1990s-present", recipeId: "wes-anderson-symmetry",
    traits: "严格对称的居中构图, 粉彩与糖果色的明快色调, 横移推轨运镜, 平面化道具陈列, 微缩模型般的场景, 复古而俏皮的氛围",
    descriptionZh: "把空间组织成清晰、几何化的舞台，人物和道具优先放在对称轴与可读的平面关系上。使用明快的粉彩色、均匀柔光和横移推轨，让动作像精确编排的舞台调度；材质可以带有微缩模型般的整洁感，但人物反应仍需具体、克制并服务于复古而俏皮的节奏。",
    description: "Organize the location as a clean geometric stage, placing characters and props on a readable central axis and in deliberate planes. Use bright pastel color, even soft light, and lateral tracking so movement feels precisely choreographed. The environment may have a tidy miniature quality, while the characters remain specific and restrained within a dry, playful rhythm."
  },
  {
    id: "stanley-kubrick", name: "Stanley Kubrick", nameZh: "斯坦利·库布里克", era: "1950s-1990s", recipeId: "kubrick-formal",
    traits: "单点透视的对称构图, 冷峻的色温与大面积留白, 缓慢推进的镜头, 几何化空间布局, 精确布光下的高对比, 理性而疏离的宿命感",
    descriptionZh: "用单点透视和严格的空间几何把人物置于无法逃离的秩序中，保留大面积留白与冷峻色温。镜头以缓慢、几乎不可察觉的推进制造压力，光线精确而高反差，人物动作被压低到可观察的细节，最终形成理性、疏离且带有宿命感的画面。",
    description: "Place the character inside an inescapable order through one-point perspective, strict geometry, cool temperature, and generous negative space. Let an almost imperceptible slow push create pressure while precise high-contrast lighting keeps every plane legible. Reduce movement to observable details so the image feels rational, distant, and quietly fatalistic."
  },
  {
    id: "christopher-nolan", name: "Christopher Nolan", nameZh: "克里斯托弗·诺兰", era: "2000s-present", recipeId: "nolan-imax",
    traits: "IMAX 级宏大视野, 冷蓝与琥珀的对比色, 实拍质感的颗粒与细节, 广角纵深构图, 严谨对称的场面调度, 肃穆压抑的史诗氛围",
    descriptionZh: "以大画幅般的广角纵深建立宏大尺度，让人物与环境的比例直接承担叙事压力。冷蓝与琥珀形成克制的对比色，实拍颗粒、坚实材质和严谨调度共同支撑空间可信度；运动与动作要有重量，整体情绪肃穆、压抑而具有史诗感。",
    description: "Use large-format scale and wide depth to make the relationship between character and environment carry narrative pressure. A restrained blue-and-amber contrast, practical texture, solid materials, and rigorous staging keep the space credible. Movement and action must have weight, creating a solemn, compressed image with epic scale."
  },
  {
    id: "andrei-tarkovsky", name: "Andrei Tarkovsky", nameZh: "安德烈·塔可夫斯基", era: "1960s-1980s", recipeId: "tarkovsky-time",
    traits: "绵长的慢镜头与时间质感, 自然光与潮湿表面的反光, 水雾泥土的触感细节, 梦境般的象征意象, 低饱和度大地色调, 静谧沉思的诗意",
    descriptionZh: "让时间成为画面的主要材料，以绵长而耐心的镜头观察自然光、潮湿表面、水雾和泥土的细微变化。低饱和大地色压低戏剧性，梦境般的意象从真实空间里自然生长；人物不急于解释情绪，而是在停顿、触碰和环境回声中呈现静谧的沉思。",
    description: "Treat time itself as the primary material, observing the small changes in natural light, wet surfaces, mist, and earth through long patient takes. Low-saturation earth tones soften theatrical emphasis, allowing dreamlike images to grow from a real location. Characters do not explain emotion too quickly; reflection emerges through pauses, contact, and the echo of the environment."
  },
  {
    id: "denis-villeneuve", name: "Denis Villeneuve", nameZh: "丹尼斯·维伦纽瓦", era: "2000s-present", recipeId: "villeneuve-monumental",
    traits: "极简宏大的构图, 低饱和的土黄与灰蓝大地色, 广角纵深的荒凉透视, 缓慢沉稳的运镜, 强颗粒的胶片质感, 肃穆而疏离的氛围",
    descriptionZh: "用极简而宏大的构图让人物暴露在荒凉的空间尺度中，广角透视延伸出距离和孤独。土黄、灰蓝与厚重颗粒压低色彩情绪，镜头缓慢、沉稳、少做装饰性移动；光线和环境共同制造肃穆、疏离且带有未知压力的视觉气候。",
    description: "Expose the character to a stark monumental scale through minimal composition and wide, desolate perspective. Ochre, gray-blue tones, and heavy grain restrain the palette while slow, deliberate camera movement avoids decoration. Light and environment combine into a solemn, distant visual climate charged with unknown pressure."
  },
  {
    id: "bong-joon-ho", name: "Bong Joon-ho", nameZh: "奉俊昊", era: "2000s-present", recipeId: "bong-genre",
    traits: "社会写实与黑色幽默的混搭, 手持纪实晃动, 类型片式的精准剪辑节奏, 阴郁的雨景与逼仄空间, 冷暖对比的都市色调, 荒诞与压迫并存",
    descriptionZh: "把社会写实的可触质感和黑色幽默的节奏放在同一个逼仄空间里，手持镜头保留现场的不稳定，但剪辑和调度必须清楚地服务因果。雨景、狭窄室内和都市冷暖色构成压迫背景，人物的荒诞反应越具体，现实压力就越显得锋利。",
    description: "Combine tactile social realism with the timing of dark comedy inside cramped, pressurized spaces. Handheld movement keeps the scene observational, while editing and staging remain precise enough to clarify cause and effect. Rain, narrow interiors, and urban warm-cool color create the pressure; the more specific the absurd reaction, the sharper the reality feels."
  },
  {
    id: "ridley-scott", name: "Ridley Scott", nameZh: "雷德利·斯科特", era: "1970s-present", recipeId: "ridley-scott-industrial",
    traits: "暗调工业质感, 逆光剪影与光束烟尘, 厚重的色彩与金属冷光, 宏大的场景纵深, 高反差硬光, 压迫感十足的史诗氛围",
    descriptionZh: "以暗调工业空间和宏大纵深建立压迫感，让金属、烟尘、硬光和逆光剪影共同形成可触摸的重量。色彩厚重但不过度脏乱，光束必须有真实来源并穿过空气中的颗粒；人物在巨大环境里保持清晰的动作和轮廓，画面因此具有肃杀的史诗规模。",
    description: "Build pressure from dark industrial space and monumental depth, giving metal, smoke, hard light, and backlit silhouettes tangible weight. Keep the palette heavy without becoming muddy; every beam must have a motivated source and interact with airborne particles. Characters remain readable inside the vast environment, creating a severe epic scale."
  },
  {
    id: "hayao-miyazaki", name: "Hayao Miyazaki", nameZh: "宫崎骏", era: "1980s-2010s", recipeId: "miyazaki-watercolor",
    traits: "水彩质感的通透画风, 云海与光影的流动, 细腻的植物与自然细节, 柔和的低饱和暖色调, 治愈而辽阔的天空构图, 温柔梦幻的冒险氛围",
    descriptionZh: "用通透的水彩质感和柔和的低饱和暖色描绘一个可以呼吸的自然世界，云层、风、植物和光影保持连续流动。广阔天空给人物留下冒险的方向感，细节不追求硬锐而追求手工绘制般的层次，整体氛围温柔、梦幻并带有真实的情感重量。",
    description: "Create a breathable natural world through translucent watercolor texture and gentle, low-saturation warmth. Clouds, wind, plants, and light should flow continuously, while the open sky gives the characters a sense of adventure and direction. Favor hand-painted layers over hard sharpness, keeping the dreamlike atmosphere emotionally grounded."
  },
  {
    id: "makoto-shinkai", name: "Makoto Shinkai", nameZh: "新海诚", era: "2000s-present", recipeId: "shinkai-skies",
    traits: "高饱和的光影与逆光光晕, 极致的天空与云层细节, 细腻的雨滴与玻璃反光, 通透的青春色调, 广角风景与人物对比, 清澈而感伤的青春氛围",
    descriptionZh: "把高饱和的天空、云层、雨滴和玻璃反光拍得清澈而有层次，逆光光晕只在有光源依据时出现。广角风景与人物的尺度对比放大青春期的辽阔和孤独，色彩通透、细节精致，但情绪保持克制，最终形成清亮而感伤的青春氛围。",
    description: "Render saturated skies, clouds, rain, and glass reflections with clarity and layered detail, using backlight halos only when motivated by a real source. Contrast wide landscapes with the scale of the characters to enlarge both youthful freedom and loneliness. Keep the color luminous and precise but the emotion restrained, producing a clear, wistful atmosphere."
  },
  {
    id: "david-fincher", name: "David Fincher", nameZh: "大卫·芬奇", era: "1990s-present", recipeId: "fincher-tense",
    traits: "冷调低饱和的数字质感, 精妙克制的运镜与推拉, 暗部细节丰富的低调布光, 干净的几何构图, 平滑的数字摄影纹理, 冷静紧张的心理氛围",
    descriptionZh: "以冷调低饱和的数字质感和干净几何构图压缩情绪空间，暗部保留足够细节，让观众感到每个角落都可能藏着信息。运镜平滑、克制而有目的，低调布光避免无意义的炫技；人物表演保持冷静，紧张感从视线、距离和未说出口的判断中累积。",
    description: "Compress the emotional space with cool, desaturated digital texture and clean geometric composition, retaining enough shadow detail for every corner to feel informative. Camera moves are smooth, restrained, and purposeful; low-key light avoids showmanship. Keep performances controlled so tension accumulates through eyelines, distance, and judgments left unspoken."
  },
  {
    id: "emmanuel-lubezki", name: "Emmanuel Lubezki", nameZh: "伊曼纽尔·卢贝兹基", era: "1990s-present", recipeId: "lubezki-dynamic",
    traits: "广角贴身跟拍, 浮动手持与长镜头能量, 自然呼吸式推进, 柔和自然光与逆光边缘光, 暖肤色通透高光, 流动的场面调度",
    descriptionZh: "让摄影机贴近人物并与人物一起呼吸，用广角跟拍、浮动手持和自然推进保留长镜头的连续能量。柔和自然光与逆光边缘光塑造空间，暖肤色和通透高光保持真实而不塑料；角色、摄影机和环境在流动调度中彼此影响，动作始终有重量和方向。",
    description: "Keep the camera close enough to breathe with the characters, using wide tracking, floating handheld movement, and natural push-ins to preserve the continuous energy of a long take. Soft natural light and motivated rim light shape the space; warm skin and translucent highlights stay real rather than plastic. Characters, camera, and environment influence one another through fluid blocking, with every action carrying weight and direction."
  }
];

export const getStyle = (id?: string): MasterStyle | undefined => MASTER_STYLES.find((style) => style.id === id);

const FALLBACK_STYLE_BRIEF = {
  zh: "以真实电影摄影为基础，保持自然光线、清晰的空间关系、可信的材质和克制而可读的表演。",
  en: "Grounded cinematic realism with natural light, readable spatial relationships, believable material detail, and restrained, camera-readable performance.",
} as const;

/** 风格倾向与「一句风格话」共用的本地化段落。 */
export function styleBriefDescription(style: MasterStyle | undefined, locale: "zh" | "en"): string {
  if (!style) return FALLBACK_STYLE_BRIEF[locale];
  return locale === "zh" ? style.descriptionZh : style.description;
}

/** 读取项目当前语言的风格短句；旧项目单字段只在语种匹配时兼容读取。 */
export function localizedStyleBrief(
  project: { styleBrief?: string; styleBriefZh?: string; styleBriefEn?: string },
  locale: "zh" | "en",
): string {
  const localized = locale === "zh" ? project.styleBriefZh : project.styleBriefEn;
  if (localized?.trim()) return localized.trim();
  const legacy = project.styleBrief?.trim() ?? "";
  if (!legacy) return "";
  const isChinese = /[\u3400-\u9fff]/.test(legacy);
  return (locale === "zh") === isChinese ? legacy : "";
}

/** 生成可注入提示词的风格描述 */
export function styleDescription(style?: MasterStyle): string {
  return style
    ? `${style.name} (${style.nameZh}) style, ${style.era}: ${style.traits}`
    : "grounded cinematic realism";
}
