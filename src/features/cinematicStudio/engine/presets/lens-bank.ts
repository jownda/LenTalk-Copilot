/**
 * P1.1 镜头语言库（Lens Character bank）
 * 十档 FOV 的可观测结果画像。数字即视场角度；优先写「画面里能观察到什么」，
 * 而不是焦距/品牌 gear。供 UI 点选、决策树推荐与编译器取值。
 */
import type { LensCharacter } from "../../shared-types";

/** 内容类别（用于「内容-视场对齐」检查 OPTICS.MIXED_CONTENT_CLASS） */
export type LensContentClass = "face-portrait" | "environment-action" | "detail-closeup" | "distant-observation";

export interface LensPreset {
  id: LensCharacter;
  /** 中文名 */
  zh: string;
  /** 英文名 */
  en: string;
  /** 视场角（度），8–180 */
  fov: number;
  /** 推荐拍摄距离（英文，可选） */
  distance?: string;
  /** 可观测结果画像（英文 canonical） */
  outcome: string[];
  /** 可观测结果画像（中文） */
  outcomeZh: string[];
  /** 适用内容类别 */
  contentClasses: LensContentClass[];
  /** 防漂移锁（英文 canonical） */
  antiDrift: string;
  /** 防漂移锁（中文） */
  antiDriftZh: string;
}

export const LENS_BANK: LensPreset[] = [
  {
    id: "180-panoramic", zh: "极限全景 180°", en: "Extreme panoramic 180°", fov: 180,
    distance: "immersive environmental coverage",
    outcome: [
      "near-complete panoramic environment surrounds the subject",
      "extreme edge expansion with strong spatial immersion",
      "subject remains readable only when anchored by clear placement",
    ],
    outcomeZh: [
      "近乎完整的全景环境包裹主体",
      "画面边缘极度扩张，空间沉浸感最强",
      "只有明确锚定站位时主体才保持清晰可读",
    ],
    contentClasses: ["environment-action"],
    antiDrift: "Keep the extreme 180° panoramic field throughout; do not collapse into normal or telephoto perspective.",
    antiDriftZh: "全段保持极限 180° 全景视场；不要收缩成标准或长焦透视。",
  },
  {
    id: "135-immersive", zh: "沉浸广角 135°", en: "Immersive ultrawide 135°", fov: 135,
    distance: "immersive environmental coverage",
    outcome: [
      "immersive wraparound environment, vast spatial field",
      "dramatic curvature at frame edges",
      "subject small within a dominant environment",
    ],
    outcomeZh: [
      "沉浸包裹式环境，广阔空间场",
      "画面边缘明显弯曲",
      "主体在宏大环境中显得渺小",
    ],
    contentClasses: ["environment-action"],
    antiDrift: "No part of this shot becomes telephoto or normal-lens coverage.",
    antiDriftZh: "本镜任何部分都不要变成长焦或标准镜头。",
  },
  {
    id: "107-ultrawide", zh: "广角正射 107°", en: "Ultrawide 107°", fov: 107,
    distance: "0.5 to 0.8 meters from subject",
    outcome: [
      "exaggerated perspective with close foreground dominating",
      "tight proximity without fisheye distortion",
      "strong depth separation, subject pushed into frame",
    ],
    outcomeZh: [
      "夸张透视，近处前景占主导",
      "贴近拍摄但无鱼眼畸变",
      "强烈纵深分离，主体被推入画面",
    ],
    contentClasses: ["environment-action", "detail-closeup"],
    antiDrift: "No part of this shot becomes telephoto or normal-lens coverage.",
    antiDriftZh: "本镜任何部分都不要变成长焦或标准镜头。",
  },
  {
    id: "84-wide", zh: "经典广角 84°", en: "Classic wide 84°", fov: 84,
    distance: "1 to 1.5 meters from subject",
    outcome: [
      "environment clearly established around subject",
      "visible foreground-to-background depth",
      "moderate wide perspective, subject stays centered and legible",
    ],
    outcomeZh: [
      "主体周围环境被清晰建立",
      "前景到背景的纵深可见",
      "中等广角透视，主体居中且清晰可读",
    ],
    contentClasses: ["environment-action"],
    antiDrift: "No part of this shot becomes telephoto or normal-lens coverage.",
    antiDriftZh: "本镜任何部分都不要变成长焦或标准镜头。",
  },
  {
    id: "63-moderate-wide", zh: "中广角 63°", en: "Moderate wide 63°", fov: 63,
    distance: "2 to 3 meters from subject",
    outcome: [
      "slightly expanded perspective with natural subject proportions",
      "environment remains readable without dominating the subject",
      "balanced depth between a standard and wide view",
    ],
    outcomeZh: [
      "轻微扩张的透视，主体比例自然",
      "环境保持可读，但不会压过主体",
      "介于标准与广角之间的平衡纵深",
    ],
    contentClasses: ["environment-action", "face-portrait"],
    antiDrift: "Keep the moderate-wide perspective stable; do not drift into extreme wide or telephoto compression.",
    antiDriftZh: "保持稳定的中广角透视；不要漂移到极端广角或长焦压缩。",
  },
  {
    id: "47-standard", zh: "标准 47°", en: "Standard 47°", fov: 47,
    distance: "2 to 4 meters from subject",
    outcome: [
      "natural eye-level perspective, straight lines stay straight",
      "balanced subject-to-background scale without distortion",
      "foreground and background in stable, readable proportion",
    ],
    outcomeZh: [
      "自然人眼透视，直线保持笔直",
      "主体与背景比例均衡、无畸变",
      "前景与背景关系稳定、可读",
    ],
    contentClasses: ["environment-action"],
    antiDrift: "LENS IS 47° ACROSS ALL SHOTS. NOT NEGOTIABLE.",
    antiDriftZh: "全片统一 47° 镜头。不可协商。",
  },
  {
    id: "29-short-tele", zh: "中近特写 29°", en: "Short tele / portrait 29°", fov: 29,
    distance: "portrait / close-up distance",
    outcome: [
      "flattering facial compression, natural proportions",
      "softly separated background, subject isolated",
      "intimate portrait framing with controlled depth",
    ],
    outcomeZh: [
      "讨喜的面部压缩，自然比例",
      "背景柔和剥离，主体被隔离",
      "亲密肖像构图，景深可控",
    ],
    contentClasses: ["face-portrait", "detail-closeup"],
    antiDrift: "No part of this shot becomes wide-angle coverage.",
    antiDriftZh: "本镜任何部分都不要变成广角。",
  },
  {
    id: "18-tele", zh: "经典长焦 18°", en: "Classic tele 18°", fov: 18,
    distance: "6 to 8 meters from subject",
    outcome: [
      "strong background compression, layers stack flat",
      "subject cleanly isolated from environment",
      "controlled depth, distant background rendered soft",
    ],
    outcomeZh: [
      "背景强烈压缩，层次扁平堆叠",
      "主体从环境中被干净剥离",
      "景深可控，远处背景柔化",
    ],
    contentClasses: ["distant-observation", "face-portrait"],
    antiDrift: "No part of this shot becomes wide-angle or normal-lens coverage.",
    antiDriftZh: "本镜任何部分都不要变成广角或标准镜头。",
  },
  {
    id: "12-long-tele", zh: "超长焦 12°", en: "Long tele 12°", fov: 12,
    distance: "12 to 16 meters from subject; approximately 200mm full-frame equivalent",
    outcome: [
      "very strong background compression with clearly stacked layers",
      "tight two-person or portrait coverage from a distant camera position",
      "shallow depth separates faces while preserving a compressed corridor or street",
    ],
    outcomeZh: [
      "极强背景压缩，空间层次明显堆叠",
      "从较远机位完成紧双人或肖像画面",
      "浅景深分离面部，同时保留被压缩的走廊或街道",
    ],
    contentClasses: ["distant-observation", "face-portrait"],
    antiDrift: "Keep the 12° long-tele perspective and distant camera position throughout; do not widen the field or move into normal-lens coverage.",
    antiDriftZh: "全段保持 12° 超长焦透视和远距离机位；不要扩大视场或变成标准镜头。",
  },
  {
    id: "8-supertele", zh: "超长焦 8°", en: "Super tele 8°", fov: 8,
    distance: "20 to 25 meters from subject",
    outcome: [
      "extreme telescopic flattening, distant observational vantage",
      "foreground occlusion frames the peering view",
      "subject compressed into the environment, layers collapse",
    ],
    outcomeZh: [
      "极强长焦压缩，远处观察视角",
      "前景遮挡框出窥视感",
      "主体被压进环境，层次塌缩",
    ],
    contentClasses: ["distant-observation"],
    antiDrift: "No part of this shot becomes wide-angle or normal-lens coverage.",
    antiDriftZh: "本镜任何部分都不要变成广角或标准镜头。",
  },
];

/** 按 id 查找镜头语言档位 */
export function lensById(id?: LensCharacter): LensPreset | undefined {
  return LENS_BANK.find((preset) => preset.id === id);
}

/** FOV 度数（8–180）→ 最近的一档镜头语言（用于把自由输入规整到标准档） */
export function lensByFov(degrees?: number): LensPreset | undefined {
  if (degrees == null) return undefined;
  return LENS_BANK.reduce<LensPreset | undefined>((best, preset) => {
    if (!best) return preset;
    return Math.abs(preset.fov - degrees) < Math.abs(best.fov - degrees) ? preset : best;
  }, undefined);
}

/** 旧工程的 mm 焦段只用于迁移兼容，不作为新的提示词字段。 */
export function legacyFocalLengthToFov(value?: string): number | undefined {
  const match = value?.match(/(\d+(?:\.\d+)?)\s*mm/i);
  if (!match) return undefined;
  const focal = Number(match[1]);
  if (!Number.isFinite(focal)) return undefined;
  if (focal <= 28) return 84;
  if (focal <= 50) return 47;
  if (focal <= 65) return 29;
  if (focal <= 85) return 18;
  if (focal <= 200) return 12;
  return 8;
}

/** 为仍要求旧 Shot.lens 的兼容结构生成稳定的 mm 值。 */
export function fovToLegacyFocalLength(degrees?: number): string {
  if (degrees == null) return "50mm";
  if (degrees >= 180) return "12mm";
  if (degrees >= 135) return "18mm";
  if (degrees >= 107) return "24mm";
  if (degrees >= 84) return "28mm";
  if (degrees >= 63) return "35mm";
  if (degrees >= 47) return "50mm";
  if (degrees >= 29) return "65mm";
  if (degrees >= 18) return "85mm";
  if (degrees >= 12) return "200mm";
  return "300mm";
}
