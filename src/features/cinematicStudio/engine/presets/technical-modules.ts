/**
 * 全局技术 Profile 预设库（P1.1）
 * 12 个模块的 UI 预设 → 英文 canonical 编译内容。每项可含 forbidden（禁止项）与 note（提示）。
 */
export interface ModulePreset {
  id: string;
  zh: string;
  /** 编译输出（英文 canonical，可为多行） */
  compile: string | string[];
  /** 编译输出中文（界面为中文时使用；与 compile 长度一致或为单串对应） */
  compileZh?: string | string[];
  /** 禁止项：编译为 Avoid: ... */
  forbidden?: string[];
  /** 附注提示（info，如 500T 低照度建议） */
  note?: string;
}

/** 影像格式 */
export const FORMAT_PRESETS: ModulePreset[] = [
  { id: "photoreal", zh: "写实", compile: "Photorealistic, live-action texture", compileZh: "写实质感，实拍纹理" },
  { id: "documentary", zh: "纪实", compile: "Documentary realism, observational footage", compileZh: "纪实风格，观察视角素材" },
  { id: "stylized-animation", zh: "风格化动画", compile: "Stylized animation, painterly textures", compileZh: "风格化动画，绘画质感" },
];

/** 胶片/色彩科学 */
export const FILM_PRESETS: ModulePreset[] = [
  { id: "kodak-500t", zh: "Kodak Vision3 500T", compile: "Kodak Vision3 500T negative, tungsten-balanced, fine grain, rich shadows, warm highlights", compileZh: "Kodak Vision3 500T 负片，钨丝灯色温，细颗粒，丰富阴影，暖高光", note: "Tungsten / low-light biased; strong daylight will shift color." },
  { id: "kodak-250d", zh: "Kodak Vision3 250D", compile: "Kodak Vision3 250D negative, daylight-balanced, natural grain, clean midtones, soft highlights", compileZh: "Kodak Vision3 250D 负片，日光色温，自然颗粒，干净中间调，柔和高光" },
  { id: "arri-logc", zh: "ARRI LogC", compile: "ARRI LogC recording, wide latitude, neutral color, flexible grade", compileZh: "ARRI LogC 录制，宽动态范围，中性色彩，灵活调色" },
  { id: "sony-venice2", zh: "Sony VENICE 2", compile: "Sony VENICE 2 sensor, high dynamic range, clinical detail, natural contrast", compileZh: "Sony VENICE 2 传感器，高动态范围，临床级细节，自然对比" },
];

/** 帧率/快门 */
export const FRAME_PRESETS: ModulePreset[] = [
  { id: "24-180", zh: "24fps + 180° 快门", compile: "24fps with 180° shutter, natural motion blur", compileZh: "24fps + 180° 快门，自然运动模糊" },
  { id: "24-90", zh: "24fps + 90° 快门", compile: "24fps with 90° shutter, sharper motion, staccato movement", compileZh: "24fps + 90° 快门，更锐利运动，断奏感动作" },
  { id: "30", zh: "30fps", compile: "30fps, smooth video-like motion", compileZh: "30fps，平滑视频感运动" },
];

/** 摄影语言 */
export const CINEMATOGRAPHY_PRESETS: ModulePreset[] = [
  { id: "dynamic-handheld", zh: "动态手持", compile: "Dynamic handheld, natural breathing camera", compileZh: "动态手持，自然呼吸式运镜" },
  { id: "measured-naturalism", zh: "克制动感", compile: "Measured naturalism, restrained camera, purposeful moves", compileZh: "克制动感，克制相机，目的性运镜" },
  { id: "graphic-symmetry", zh: "图形对称", compile: "Graphic symmetry, geometric framing", compileZh: "图形对称，几何构图" },
  { id: "slow-observational", zh: "缓慢观察", compile: "Slow observational, patient long takes", compileZh: "缓慢观察，耐心长镜头" },
  { id: "tense-precision", zh: "紧张精确", compile: "Tense precision, smooth slow pushes, exact framing", compileZh: "紧张精确，平滑慢推，精确构图" },
];

/** 光线 */
export const LIGHTING_PRESETS: ModulePreset[] = [
  { id: "cloudy-diffuse", zh: "阴天漫射", compile: "Overcast diffuse light, soft even shadows, gentle falloff", compileZh: "阴天漫射光，柔和均匀阴影，渐进衰减", forbidden: ["hard sun shadows", "direct harsh sunlight"] },
  { id: "cloudy-backlight", zh: "阴天逆光", compile: "Overcast backlight, rim light on edges, soft facial fill", compileZh: "阴天逆光，边缘轮廓光，柔和面部补光" },
  { id: "neon-wet", zh: "霓虹湿街", compile: "Neon and wet reflections, colored practicals, dark ambience", compileZh: "霓虹与湿润反光，彩色实用光源，黑暗氛围", forbidden: ["clean flat studio light"] },
  { id: "cool-fluorescent", zh: "冷荧光室内", compile: "Cool fluorescent interior, green-white cast, minimal fill", compileZh: "冷荧光室内，绿白偏色，极简补光" },
  { id: "golden-hour", zh: "黄昏金光", compile: "Golden hour sidelight, long warm shadows, low color temperature", compileZh: "黄昏侧光，长暖影，低色温" },
];

/** 色彩 */
export const COLOR_PRESETS: ModulePreset[] = [
  { id: "60-30-10", zh: "60:30:10 蓝灰/琥珀/红", compile: "60:30:10 color split — blue-grey environment, amber midtones, red accents", compileZh: "60:30:10 色彩分割 — 蓝灰环境，琥珀中间调，红色点缀" },
  { id: "desat-cool-green", zh: "低饱和冷绿", compile: "Low-saturation cool green grade, muted skin, desaturated highlights", compileZh: "低饱和冷绿调色，柔和肤色，去饱和高光" },
  { id: "warm-cool", zh: "暖肤色/冷背景", compile: "Warm skin tones against cool backgrounds, protective color separation", compileZh: "暖肤色对比冷背景，保护性色彩分离" },
];

/** 表演 */
export const ACTING_PRESETS: ModulePreset[] = [
  { id: "micro-expression", zh: "微表情", compile: "Hollywood micro-expressions, subtle eye darts, restrained reactions", compileZh: "好莱坞微表情，微妙眼神，克制反应" },
  { id: "restrained-grief", zh: "克制悲痛", compile: "Restrained grief, slow breaths, delayed reactions, heavy body", compileZh: "克制悲痛，缓慢呼吸，延迟反应，沉重身体" },
  { id: "urgent-action", zh: "紧迫行动", compile: "Urgent action, fast weight shifts, decisive movement, sharp breathing", compileZh: "紧迫行动，快速重心转移，果断动作，锐利呼吸" },
];

/** 皮肤 */
export const SKIN_PRESETS: ModulePreset[] = [
  { id: "pore-level", zh: "毛孔级细节", compile: "Pore-level skin detail, visible pores and fine hairs, no smoothing", compileZh: "毛孔级皮肤细节，可见毛孔与细绒毛，无磨皮", forbidden: ["airbrushed skin", "plastic skin"] },
  { id: "natural-beauty", zh: "自然美肤", compile: "Natural beauty skin, soft texture, minimal retouch", compileZh: "自然美肤，柔和质感，最少修图" },
];

/** 物理 */
export const PHYSICS_PRESETS: ModulePreset[] = [
  { id: "realistic-athletic", zh: "真实运动物理", compile: "Realistic athletic movement, correct weight and inertia, contact shadows", compileZh: "真实运动物理，正确的重量与惯性，接触阴影", forbidden: ["no-gravity movement", "floating"] },
  { id: "rain-wet", zh: "雨湿布料", compile: "Rain and wet cloth dynamics, heavy fabric drag, droplet trails", compileZh: "雨水与湿布动态，厚重布料拖拽，水滴轨迹" },
  { id: "impact-debris", zh: "冲击与碎屑", compile: "Impact and debris physics, mass and momentum, secondary fragments", compileZh: "冲击与碎屑物理，质量与动量，二次碎片" },
];

/** 构图 */
export const COMPOSITION_PRESETS: ModulePreset[] = [
  { id: "rule-of-thirds", zh: "三分法", compile: "Rule of thirds, subject on intersections, balanced negative space", compileZh: "三分法，主体位于交点，平衡留白" },
  { id: "golden-ratio", zh: "黄金比例", compile: "Golden ratio framing, natural leading lines, harmonic placement", compileZh: "黄金比例构图，自然引导线，和谐布局" },
  { id: "one-point", zh: "单点对称", compile: "One-point symmetry, centered subject, geometric order", compileZh: "单点对称，居中主体，几何秩序" },
  { id: "crowded-depth", zh: "拥挤纵深", compile: "Crowded depth, layered foreground-mid-background, environmental scale", compileZh: "拥挤纵深，层叠前中背景，环境尺度" },
];

/** 锐化 */
export const SHARPNESS_PRESETS: ModulePreset[] = [
  { id: "natural-detail", zh: "自然细节", compile: "Natural detail, gentle sharpness, no overprocessing", compileZh: "自然细节，柔和锐度，无过度处理", forbidden: ["HDR halos", "plastic skin"] },
  { id: "no-oversharp", zh: "无过锐化", compile: "No oversharpening, avoid HDR halos and plastic skin", compileZh: "无过锐化，避免 HDR 光晕与塑料皮肤", forbidden: ["HDR halos", "plastic skin", "oversharpened edges"] },
  { id: "fine-grain", zh: "细颗粒", compile: "Fine film grain, subtle texture, organic noise", compileZh: "细胶片颗粒，细腻质感，有机噪点" },
];

/** 按 id 查找 */
export function presetById(list: ModulePreset[], id?: string): ModulePreset | undefined {
  return list.find((preset) => preset.id === id);
}