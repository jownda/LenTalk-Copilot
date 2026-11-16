/**
 * 图像调整（图层级、非破坏性）。
 *
 * 移植自参考项目 `crates/doc/src/adjust.rs` 的调整层模型，覆盖常用与进阶项：
 * 亮度/对比度、曝光、色阶、曲线、色彩平衡、色相饱和度（含六色域）、自然饱和度、
 * 黑白、通道混合器、照片滤镜、渐变映射、3D LUT。
 *
 * 存储上只存参数，像素在渲染时才处理（导出、预览各走一次），所以调整可随时改回。
 */

/** 曲线控制点：x/y 都在 0..255。 */
export interface MosaicCurvePoint {
  x: number;
  y: number;
}

export interface MosaicLevelsChannel {
  /** 输入黑场 0..255 */
  black: number;
  /** 输入白场 0..255 */
  white: number;
  /** 中间调 gamma，0.1..9.99 */
  gamma: number;
}

export interface MosaicLevels {
  master: MosaicLevelsChannel;
  r: MosaicLevelsChannel;
  g: MosaicLevelsChannel;
  b: MosaicLevelsChannel;
}

export interface MosaicCurves {
  rgb: MosaicCurvePoint[];
  r: MosaicCurvePoint[];
  g: MosaicCurvePoint[];
  b: MosaicCurvePoint[];
}

/** 三个色调范围的 CMYK 反向轴：青-红、洋红-绿、黄-蓝，取值 -100..100。 */
export interface MosaicColorBalance {
  shadows: [number, number, number];
  midtones: [number, number, number];
  highlights: [number, number, number];
  preserveLuminosity: boolean;
}

/** 六色域里的单个色域（红/黄/绿/青/蓝/洋红）偏移量。 */
export interface MosaicHueRange {
  /** 色相偏移 -60..60 度 */
  hue: number;
  /** 饱和度 -100..100 */
  saturation: number;
  /** 明度 -100..100 */
  lightness: number;
}

/** 六色域顺序固定：红、黄、绿、青、蓝、洋红。 */
export type MosaicHueRanges = [
  MosaicHueRange,
  MosaicHueRange,
  MosaicHueRange,
  MosaicHueRange,
  MosaicHueRange,
  MosaicHueRange,
];

/** 黑白：六个色域的亮度权重 + 可选单色调。 */
export interface MosaicBlackWhite {
  enabled: boolean;
  /** 红/黄/绿/青/蓝/洋红 的亮度权重，默认 40/60/40/60/20/80 */
  weights: [number, number, number, number, number, number];
  tint: boolean;
  /** 单色调颜色 */
  tintColor: string;
}

/** 通道混合器：输出通道 = Σ 输入通道 × 百分比 / 100。 */
export interface MosaicChannelMixer {
  enabled: boolean;
  red: [number, number, number];
  green: [number, number, number];
  blue: [number, number, number];
  /** 单色：按红通道的系数算出一张灰度 */
  monochrome: boolean;
}

/** 照片滤镜：拿一个颜色乘上去，模拟镜头滤镜。 */
export interface MosaicPhotoFilter {
  enabled: boolean;
  color: string;
  /** 浓度 0..100 */
  density: number;
  preserveLuminosity: boolean;
}

export interface MosaicGradientStop {
  /** 位置 0..1 */
  pos: number;
  color: string;
}

/** 渐变映射：把亮度映射到渐变颜色（会替换掉原来的颜色）。 */
export interface MosaicGradientMap {
  enabled: boolean;
  stops: MosaicGradientStop[];
}

/** 3D LUT：内置预设 + 强度（0..100）。 */
export interface MosaicColorLookup {
  enabled: boolean;
  /** 预设 id：teal-orange / fade / cool / vintage / punch */
  preset: string;
  intensity: number;
}

export interface MosaicAdjust {
  /** 亮度 -100..100 */
  brightness: number;
  /** 对比度 -100..100 */
  contrast: number;
  /** 曝光，单位 EV，-3..3 */
  exposure: number;
  /** 饱和度 -100..100 */
  saturation: number;
  /** 自然饱和度 -100..100 */
  vibrance: number;
  /** 色相旋转 -180..180 */
  hue: number;
  /** 明度 -100..100 */
  lightness: number;
  levels: MosaicLevels;
  curves: MosaicCurves;
  colorBalance: MosaicColorBalance;
  /** 六色域微调 */
  hueRanges: MosaicHueRanges;
  blackWhite: MosaicBlackWhite;
  channelMixer: MosaicChannelMixer;
  photoFilter: MosaicPhotoFilter;
  gradientMap: MosaicGradientMap;
  colorLookup: MosaicColorLookup;
}

export function defaultLevelsChannel(): MosaicLevelsChannel {
  return { black: 0, white: 255, gamma: 1 };
}

export function defaultCurve(): MosaicCurvePoint[] {
  return [
    { x: 0, y: 0 },
    { x: 255, y: 255 },
  ];
}

export function defaultHueRange(): MosaicHueRange {
  return { hue: 0, saturation: 0, lightness: 0 };
}

export function createDefaultAdjust(): MosaicAdjust {
  return {
    brightness: 0,
    contrast: 0,
    exposure: 0,
    saturation: 0,
    vibrance: 0,
    hue: 0,
    lightness: 0,
    levels: {
      master: defaultLevelsChannel(),
      r: defaultLevelsChannel(),
      g: defaultLevelsChannel(),
      b: defaultLevelsChannel(),
    },
    curves: {
      rgb: defaultCurve(),
      r: defaultCurve(),
      g: defaultCurve(),
      b: defaultCurve(),
    },
    colorBalance: {
      shadows: [0, 0, 0],
      midtones: [0, 0, 0],
      highlights: [0, 0, 0],
      preserveLuminosity: true,
    },
    hueRanges: [
      defaultHueRange(),
      defaultHueRange(),
      defaultHueRange(),
      defaultHueRange(),
      defaultHueRange(),
      defaultHueRange(),
    ],
    blackWhite: {
      enabled: false,
      weights: [40, 60, 40, 60, 20, 80],
      tint: false,
      tintColor: "#c9a227",
    },
    channelMixer: {
      enabled: false,
      red: [100, 0, 0],
      green: [0, 100, 0],
      blue: [0, 0, 100],
      monochrome: false,
    },
    photoFilter: {
      enabled: false,
      color: "#ec8a00",
      density: 25,
      preserveLuminosity: true,
    },
    gradientMap: {
      enabled: false,
      stops: [
        { pos: 0, color: "#1b1b2f" },
        { pos: 1, color: "#ffd9a0" },
      ],
    },
    colorLookup: {
      enabled: false,
      preset: "teal-orange",
      intensity: 100,
    },
  };
}

function levelsIsIdentity(channel: MosaicLevelsChannel): boolean {
  return channel.black === 0 && channel.white === 255 && Math.abs(channel.gamma - 1) < 1e-6;
}

function curveIsIdentity(points: readonly MosaicCurvePoint[]): boolean {
  if (points.length !== 2) return false;
  const [first, second] = points;
  return first.x === 0 && first.y === 0 && second.x === 255 && Math.abs(second.y - 255) < 1e-6;
}

function hueRangesTouched(ranges: MosaicHueRanges): boolean {
  return ranges.some((range) => range.hue !== 0 || range.saturation !== 0 || range.lightness !== 0);
}

function channelMixerIsIdentity(mixer: MosaicChannelMixer): boolean {
  if (!mixer.enabled) return true;
  if (mixer.monochrome) return false;
  return (
    mixer.red[0] === 100 &&
    mixer.red[1] === 0 &&
    mixer.red[2] === 0 &&
    mixer.green[0] === 0 &&
    mixer.green[1] === 100 &&
    mixer.green[2] === 0 &&
    mixer.blue[0] === 0 &&
    mixer.blue[1] === 0 &&
    mixer.blue[2] === 100
  );
}

/** 是否等于「什么都不做」——用来跳过像素处理与缓存。 */
export function isAdjustIdentity(adjust: MosaicAdjust | undefined | null): boolean {
  if (!adjust) return true;
  if (adjust.brightness || adjust.contrast || adjust.exposure) return false;
  if (adjust.saturation || adjust.vibrance || adjust.hue || adjust.lightness) return false;
  const { levels, curves, colorBalance } = adjust;
  if (
    !levelsIsIdentity(levels.master) ||
    !levelsIsIdentity(levels.r) ||
    !levelsIsIdentity(levels.g) ||
    !levelsIsIdentity(levels.b)
  ) {
    return false;
  }
  if (
    !curveIsIdentity(curves.rgb) ||
    !curveIsIdentity(curves.r) ||
    !curveIsIdentity(curves.g) ||
    !curveIsIdentity(curves.b)
  ) {
    return false;
  }
  const balanceTouched =
    colorBalance.shadows.some((value) => value !== 0) ||
    colorBalance.midtones.some((value) => value !== 0) ||
    colorBalance.highlights.some((value) => value !== 0);
  if (balanceTouched) return false;
  if (hueRangesTouched(adjust.hueRanges)) return false;
  if (adjust.blackWhite.enabled) return false;
  if (!channelMixerIsIdentity(adjust.channelMixer)) return false;
  if (adjust.photoFilter.enabled) return false;
  if (adjust.gradientMap.enabled) return false;
  if (adjust.colorLookup.enabled) return false;
  return true;
}

/** 只改了哪些项，用于面板上的「已调整」标记。 */
export function adjustSummary(adjust: MosaicAdjust | undefined | null): string[] {
  if (!adjust) return [];
  const tags: string[] = [];
  if (adjust.brightness || adjust.contrast) tags.push("亮度/对比度");
  if (adjust.exposure) tags.push("曝光");
  if (
    adjust.levels.master.black !== 0 ||
    adjust.levels.master.white !== 255 ||
    Math.abs(adjust.levels.master.gamma - 1) > 1e-6 ||
    !levelsIsIdentity(adjust.levels.r) ||
    !levelsIsIdentity(adjust.levels.g) ||
    !levelsIsIdentity(adjust.levels.b)
  ) {
    tags.push("色阶");
  }
  const { curves } = adjust;
  if (curves.rgb.length > 2 || curves.r.length > 2 || curves.g.length > 2 || curves.b.length > 2) {
    tags.push("曲线");
  }
  const cb = adjust.colorBalance;
  if (
    cb.shadows.some((value) => value !== 0) ||
    cb.midtones.some((value) => value !== 0) ||
    cb.highlights.some((value) => value !== 0)
  ) {
    tags.push("色彩平衡");
  }
  if (adjust.hue || adjust.saturation || adjust.lightness) tags.push("色相/饱和度");
  if (hueRangesTouched(adjust.hueRanges)) tags.push("六色域");
  if (adjust.vibrance) tags.push("自然饱和度");
  if (adjust.blackWhite.enabled) tags.push("黑白");
  if (!channelMixerIsIdentity(adjust.channelMixer)) tags.push("通道混合器");
  if (adjust.photoFilter.enabled) tags.push("照片滤镜");
  if (adjust.gradientMap.enabled) tags.push("渐变映射");
  if (adjust.colorLookup.enabled) tags.push("3D LUT");
  return tags;
}

/* ------------------------------ 颜色工具 ------------------------------ */

/** `#rrggbb` → [r,g,b]（0..255）；解析失败按中灰。 */
export function hexToRgb(hex: string): [number, number, number] {
  const value = hex.trim().replace("#", "");
  if (value.length !== 6) return [128, 128, 128];
  const parsed = Number.parseInt(value, 16);
  if (!Number.isFinite(parsed)) return [128, 128, 128];
  return [(parsed >> 16) & 0xff, (parsed >> 8) & 0xff, parsed & 0xff];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** 六色域的名称与中心色相（度）。 */
export const HUE_RANGE_LABELS = ["红", "黄", "绿", "青", "蓝", "洋红"] as const;
export const HUE_RANGE_CENTERS = [0, 60, 120, 180, 240, 300] as const;
