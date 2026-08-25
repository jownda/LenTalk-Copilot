/**
 * P1.1 镜头语言库（Lens Character bank）
 * 七档 FOV 的可观测结果画像。数字即视场角度；优先写「画面里能观察到什么」，
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
  /** 视场角（度），8–135 */
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
];

/** 按 id 查找镜头语言档位 */
export function lensById(id?: LensCharacter): LensPreset | undefined {
  return LENS_BANK.find((preset) => preset.id === id);
}

/** FOV 度数（8–135）→ 最近的一档镜头语言（用于把自由输入规整到标准档） */
export function lensByFov(degrees?: number): LensPreset | undefined {
  if (degrees == null) return undefined;
  return LENS_BANK.reduce<LensPreset | undefined>((best, preset) => {
    if (!best) return preset;
    return Math.abs(preset.fov - degrees) < Math.abs(best.fov - degrees) ? preset : best;
  }, undefined);
}
