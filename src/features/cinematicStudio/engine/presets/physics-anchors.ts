/**
 * P1.7 物理锚点预设库（Physics Anchor bank）
 * 五类动作锚点：行走/奔跑/武器/液体/粒子。每类给可观测锚点短语（中英对称），
 * 供镜头检查器勾选与编译器渲染取值；数字/专有名词按 §1 第 7 条保留英文。
 */
import type { PhysicsAnchorKind } from "../../shared-types";

export interface PhysicsAnchorPreset {
  zh: string;
  en: string;
  pointsZh: string[];
  pointsEn: string[];
}

export const PHYSICS_ANCHORS: Record<PhysicsAnchorKind, PhysicsAnchorPreset> = {
  walk: {
    zh: "行走", en: "walk",
    pointsZh: ["脚跟落地", "重心转移", "髋部摆动", "脚趾蹬地"],
    pointsEn: ["heel contact", "weight transfer", "hip shift", "toe push-off"],
  },
  run: {
    zh: "奔跑", en: "run",
    pointsZh: ["地面接触", "屈膝抬腿", "对侧摆臂"],
    pointsEn: ["ground contact", "knee lift", "opposing arm swing"],
  },
  weapon: {
    zh: "武器", en: "weapon",
    pointsZh: ["重量", "惯性"],
    pointsEn: ["weight", "inertia"],
  },
  liquid: {
    zh: "液体", en: "liquid",
    pointsZh: ["重力", "附着", "滴落", "汇聚"],
    pointsEn: ["gravity", "cling", "drip", "pool"],
  },
  particle: {
    zh: "粒子", en: "particle",
    pointsZh: ["风向", "前中后景分布"],
    pointsEn: ["wind direction", "foreground-midground-background distribution"],
  },
};

/** 按 kind 取预设锚点（未知 kind 返回 undefined 以向后兼容非法数据） */
export function physicsAnchorById(kind: PhysicsAnchorKind): PhysicsAnchorPreset | undefined {
  return PHYSICS_ANCHORS[kind];
}
