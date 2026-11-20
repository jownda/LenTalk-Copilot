/**
 * 图像调整的像素实现。
 *
 * 两段式：
 * 1. **点运算**（曝光 / 亮度对比度 / 色阶 / 曲线）→ 每通道 256 项 LUT，逐像素查表，最快；
 * 2. **颜色运算**（通道混合器 / 色彩平衡 / 黑白 / 色相饱和度与六色域 / 自然饱和度 /
 *    照片滤镜 / 渐变映射 / 3D LUT）→ 必须读三通道的相互关系，只能逐像素算。
 *
 * 只有这一份实现：导出（`renderMosaicToCanvas`）、编辑器预览、节点内预览都走它，
 * 否则「看到的」和「导出的」必然越走越偏。
 */
import type {
  MosaicAdjust,
  MosaicCurvePoint,
  MosaicGradientMap,
  MosaicLevelsChannel,
} from "@/features/canvas/domain/mosaicAdjust";
import { HUE_RANGE_CENTERS, hexToRgb, isAdjustIdentity } from "@/features/canvas/domain/mosaicAdjust";

export interface AdjustHistogram {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  lum: Uint32Array;
  max: number;
}

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);
const clamp255 = (value: number) => (value < 0 ? 0 : value > 255 ? 255 : value);

/* ------------------------------ 点运算：LUT ------------------------------ */

/**
 * 单调三次插值（Fritsch–Carlson）。
 *
 * 用普通样条会在控制点之间过冲：把曲线拉成「S」时中间会冒出一段反转的亮暗，
 * 手感很怪。单调插值保证曲线只跟控制点走，不会自己拐弯。
 */
export function sampleCurveLut(points: readonly MosaicCurvePoint[]): Float32Array {
  const lut = new Float32Array(256);
  const sorted = [...points].sort((a, b) => a.x - b.x);
  if (sorted.length === 0) {
    for (let i = 0; i < 256; i += 1) lut[i] = i;
    return lut;
  }
  if (sorted.length === 1) {
    lut.fill(sorted[0].y);
    return lut;
  }

  const xs = sorted.map((point) => point.x);
  const ys = sorted.map((point) => point.y);
  const n = sorted.length;

  const delta = new Array<number>(n - 1);
  for (let i = 0; i < n - 1; i += 1) {
    delta[i] = (ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]);
  }
  const tangent = new Array<number>(n);
  tangent[0] = delta[0];
  tangent[n - 1] = delta[n - 2];
  for (let i = 1; i < n - 1; i += 1) {
    tangent[i] = delta[i - 1] * delta[i] <= 0 ? 0 : (delta[i - 1] + delta[i]) / 2;
  }
  for (let i = 0; i < n - 1; i += 1) {
    if (delta[i] === 0) {
      tangent[i] = 0;
      tangent[i + 1] = 0;
      continue;
    }
    const a = tangent[i] / delta[i];
    const b = tangent[i + 1] / delta[i];
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      tangent[i] = t * a * delta[i];
      tangent[i + 1] = t * b * delta[i];
    }
  }

  for (let i = 0; i < 256; i += 1) {
    if (i <= xs[0]) {
      lut[i] = ys[0];
      continue;
    }
    if (i >= xs[n - 1]) {
      lut[i] = ys[n - 1];
      continue;
    }
    let segment = 0;
    while (segment < n - 2 && i > xs[segment + 1]) segment += 1;
    const x0 = xs[segment];
    const h = Math.max(1e-6, xs[segment + 1] - x0);
    const t = (i - x0) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    lut[i] =
      (2 * t3 - 3 * t2 + 1) * ys[segment] +
      (t3 - 2 * t2 + t) * h * tangent[segment] +
      (-2 * t3 + 3 * t2) * ys[segment + 1] +
      (t3 - t2) * h * tangent[segment + 1];
  }
  return lut;
}

function applyLevels(value: number, channel: MosaicLevelsChannel): number {
  const black = Math.min(channel.black, channel.white - 1);
  const white = Math.max(channel.white, black + 1);
  const t = clamp01((value - black) / (white - black));
  return (Math.abs(channel.gamma - 1) > 1e-6 ? Math.pow(t, 1 / Math.max(0.01, channel.gamma)) : t) * 255;
}

function buildChannelLut(adjust: MosaicAdjust, channel: 0 | 1 | 2): Uint8ClampedArray {
  const perChannel = [adjust.levels.r, adjust.levels.g, adjust.levels.b][channel];
  const channelCurve = sampleCurveLut([adjust.curves.r, adjust.curves.g, adjust.curves.b][channel]);
  const masterCurve = sampleCurveLut(adjust.curves.rgb);
  const exposureFactor = Math.pow(2, adjust.exposure);
  const brightnessShift = adjust.brightness * 1.27;
  const contrastFactor = Math.max(0, (100 + adjust.contrast) / 100);

  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    if (exposureFactor !== 1) {
      value = Math.pow(Math.pow(value / 255, 2.2) * exposureFactor, 1 / 2.2) * 255;
    }
    value = (value + brightnessShift - 128) * contrastFactor + 128;
    value = applyLevels(value, adjust.levels.master);
    value = applyLevels(value, perChannel);
    value = channelCurve[Math.round(clamp01(value / 255) * 255)];
    value = masterCurve[Math.round(clamp01(value / 255) * 255)];
    lut[i] = value;
  }
  return lut;
}

/* ------------------------------ 颜色工具 ------------------------------ */

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h, s, l];
}

function hueToRgb(p: number, q: number, t: number): number {
  let tt = t;
  if (tt < 0) tt += 1;
  if (tt > 1) tt -= 1;
  if (tt < 1 / 6) return p + (q - p) * 6 * tt;
  if (tt < 1 / 2) return q;
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
  return p;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s <= 0) {
    const value = l * 255;
    return [value, value, value];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hueToRgb(p, q, h + 1 / 3) * 255, hueToRgb(p, q, h) * 255, hueToRgb(p, q, h - 1 / 3) * 255];
}

/** 六色域的三角权重：色相角离得越近权重越大，相邻三个加起来正好是 1。 */
function hueRangeWeights(hueDeg: number): number[] {
  const weights: number[] = new Array(HUE_RANGE_CENTERS.length).fill(0);
  for (let i = 0; i < HUE_RANGE_CENTERS.length; i += 1) {
    let distance = Math.abs(hueDeg - HUE_RANGE_CENTERS[i]);
    if (distance > 180) distance = 360 - distance;
    const weight = Math.max(0, 1 - distance / 120);
    if (weight > 0) weights[i] = weight;
  }
  return weights;
}

function gradientTable(map: MosaicGradientMap): Uint8ClampedArray {
  const table = new Uint8ClampedArray(256 * 3);
  const stops = [...map.stops].sort((a, b) => a.pos - b.pos);
  if (stops.length === 0) {
    for (let i = 0; i < 256; i += 1) {
      table[i * 3] = i;
      table[i * 3 + 1] = i;
      table[i * 3 + 2] = i;
    }
    return table;
  }
  for (let i = 0; i < 256; i += 1) {
    const pos = i / 255;
    let left = stops[0];
    let right = stops[stops.length - 1];
    for (let s = 0; s < stops.length - 1; s += 1) {
      if (pos >= stops[s].pos && pos <= stops[s + 1].pos) {
        left = stops[s];
        right = stops[s + 1];
        break;
      }
    }
    const span = Math.max(1e-6, right.pos - left.pos);
    const t = clamp01((pos - left.pos) / span);
    const [lr, lg, lb] = hexToRgb(left.color);
    const [rr, rg, rb] = hexToRgb(right.color);
    table[i * 3] = lr + (rr - lr) * t;
    table[i * 3 + 1] = lg + (rg - lg) * t;
    table[i * 3 + 2] = lb + (rb - lb) * t;
  }
  return table;
}

/* ------------------------------ 3D LUT ------------------------------ */

const LUT_SIZE = 17;
const lutCache = new Map<string, Float32Array>();

/**
 * 内置「look」定义成函数，再烘焙成 17³ 的查找表。
 *
 * 这样既能像真 LUT 一样做三线性插值，又不用带着一堆二进制资源。
 */
function bakeLook(preset: string): Float32Array {
  const cached = lutCache.get(preset);
  if (cached) return cached;
  const size = LUT_SIZE;
  const table = new Float32Array(size * size * size * 3);
  let index = 0;
  for (let bi = 0; bi < size; bi += 1) {
    for (let gi = 0; gi < size; gi += 1) {
      for (let ri = 0; ri < size; ri += 1) {
        const r = (ri / (size - 1)) * 255;
        const g = (gi / (size - 1)) * 255;
        const b = (bi / (size - 1)) * 255;
        const [nr, ng, nb] = lookColor(preset, r, g, b);
        table[index] = clamp01(nr / 255);
        table[index + 1] = clamp01(ng / 255);
        table[index + 2] = clamp01(nb / 255);
        index += 3;
      }
    }
  }
  lutCache.set(preset, table);
  return table;
}

function lookColor(preset: string, r: number, g: number, b: number): [number, number, number] {
  const l = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  switch (preset) {
    case "teal-orange": {
      // 暗部偏青、亮部偏橙
      const shadow = (1 - l) * 26;
      const highlight = l * 24;
      return [r + shadow * 0.35 + highlight, g + shadow * 0.6 - highlight * 0.12, b + shadow * 0.85 - highlight * 0.3];
    }
    case "fade": {
      // 黑白场抬起、对比降低
      const lift = 18;
      const compress = 0.86;
      return [lift + r * compress, lift + g * compress, lift + b * compress];
    }
    case "cool": {
      return [r - 6 + (1 - l) * 4, g + 2, b + 12 + (1 - l) * 8];
    }
    case "vintage": {
      const warm = 14;
      return [r * 0.9 + warm, g * 0.88 + warm * 0.8, b * 0.82 + warm * 0.5];
    }
    case "punch": {
      const center = 128;
      const contrast = 1.18;
      const [h, s] = rgbToHsl(r, g, b);
      const [pr, pg, pb] = hslToRgb(h, clamp01(s * 1.15), clamp01(0.5 + ((0.299 * r + 0.587 * g + 0.114 * b) / 255 - 0.5)));
      return [(pr - center) * contrast + center, (pg - center) * contrast + center, (pb - center) * contrast + center];
    }
    default:
      return [r, g, b];
  }
}

/* ------------------------------ 预编译 ------------------------------ */

/**
 * 把调整参数「编译」成查表 + 常量，逐像素时只剩查表与四则运算。
 *
 * 之前每个像素每个阶段都返回一个 `[r,g,b]` 数组，388k 像素 × 4 个阶段 =
 * 每帧上百万个临时数组 —— 实测单帧 591ms，拖滑块必然卡成「松手才更新」。
 */
interface CompiledAdjust {
  lutR: Uint8ClampedArray;
  lutG: Uint8ClampedArray;
  lutB: Uint8ClampedArray;
  mixer: { r0: number; r1: number; r2: number; g0: number; g1: number; g2: number; b0: number; b1: number; b2: number; mono: boolean } | null;
  balance: {
    sdr: number; sdg: number; sdb: number;
    mdr: number; mdg: number; mdb: number;
    hdr: number; hdg: number; hdb: number;
    preserve: boolean;
  } | null;
  /** 按明度索引的阴影 / 中间调 / 高光权重 */
  toneShadow: Float32Array | null;
  toneMid: Float32Array | null;
  toneHigh: Float32Array | null;
  bw: { factor: Float32Array; tint: [number, number, number] | null } | null;
  /** 按色相（0..359 度）索引的六色域偏移 */
  rangeShift: Float32Array | null;
  rangeSat: Float32Array | null;
  rangeLight: Float32Array | null;
  hsl: { hue: number; sat: number; vibrance: number; lightness: number } | null;
  filter: { tr: number; tg: number; tb: number; k: number; preserve: boolean } | null;
  gradient: Uint8ClampedArray | null;
  look: { table: Float32Array; intensity: number } | null;
  /**
   * 只有点运算（曝光/亮度对比度/色阶/曲线）时，整条链路都是逐通道查表，
   * 可以走最快的直通路径。
   */
  pureLut: boolean;
}

let compiledKey = "";
let compiledValue: CompiledAdjust | null = null;

function compileAdjust(adjust: MosaicAdjust): CompiledAdjust {
  const key = JSON.stringify(adjust);
  if (compiledValue && compiledKey === key) return compiledValue;

  const mixer = adjust.channelMixer;
  const balance = adjust.colorBalance;
  const blackWhite = adjust.blackWhite;
  const ranges = adjust.hueRanges;
  const filter = adjust.photoFilter;
  const gradient = adjust.gradientMap;
  const lookup = adjust.colorLookup;

  // 色彩平衡：三档 × 三轴 → 每档一条「单位权重下的增量」，逐像素只做加权和
  const balanceActive =
    balance.shadows.some((value) => value !== 0) ||
    balance.midtones.some((value) => value !== 0) ||
    balance.highlights.some((value) => value !== 0);
  let compiledBalance: CompiledAdjust["balance"] = null;
  let toneShadow: Float32Array | null = null;
  let toneMid: Float32Array | null = null;
  let toneHigh: Float32Array | null = null;
  if (balanceActive) {
    const deltas = (values: readonly number[]) => {
      const [cy, mg, yb] = values;
      return [cy - 0.5 * mg - 0.5 * yb, mg - 0.5 * cy - 0.5 * yb, yb - 0.5 * cy - 0.5 * mg];
    };
    const [sdr, sdg, sdb] = deltas(balance.shadows);
    const [mdr, mdg, mdb] = deltas(balance.midtones);
    const [hdr, hdg, hdb] = deltas(balance.highlights);
    compiledBalance = { sdr, sdg, sdb, mdr, mdg, mdb, hdr, hdg, hdb, preserve: balance.preserveLuminosity };
    toneShadow = new Float32Array(256);
    toneMid = new Float32Array(256);
    toneHigh = new Float32Array(256);
    for (let i = 0; i < 256; i += 1) {
      const lightness = i / 255;
      const shadow = Math.pow(clamp01(1 - lightness / 0.5), 2);
      const highlight = Math.pow(clamp01((lightness - 0.5) / 0.5), 2);
      toneShadow[i] = shadow;
      toneHigh[i] = highlight;
      toneMid[i] = Math.max(0, 1 - shadow - highlight);
    }
  }

  // 黑白：色相 → 亮度倍数（0..359 度）
  let compiledBw: CompiledAdjust["bw"] = null;
  if (blackWhite.enabled) {
    const factor = new Float32Array(360);
    for (let deg = 0; deg < 360; deg += 1) {
      const weights = hueRangeWeights(deg);
      let value = 0;
      for (let i = 0; i < weights.length; i += 1) {
        if (weights[i] <= 0) continue;
        value += weights[i] * ((blackWhite.weights[i] ?? 40) / 40);
      }
      factor[deg] = value;
    }
    compiledBw = { factor, tint: blackWhite.tint ? hexToRgb(blackWhite.tintColor) : null };
  }

  // 六色域：色相 → 色相偏移 / 饱和缩放 / 明度偏移
  const rangesActive = !blackWhite.enabled && ranges.some((range) => range.hue || range.saturation || range.lightness);
  let rangeShift: Float32Array | null = null;
  let rangeSat: Float32Array | null = null;
  let rangeLight: Float32Array | null = null;
  if (rangesActive) {
    rangeShift = new Float32Array(360);
    rangeSat = new Float32Array(360);
    rangeLight = new Float32Array(360);
    for (let deg = 0; deg < 360; deg += 1) {
      const weights = hueRangeWeights(deg);
      let shift = 0;
      let sat = 0;
      let light = 0;
      for (let i = 0; i < ranges.length; i += 1) {
        const weight = weights[i];
        if (weight <= 0) continue;
        shift += weight * ranges[i].hue;
        sat += weight * (ranges[i].saturation / 100);
        light += weight * (ranges[i].lightness / 100);
      }
      rangeShift[deg] = shift;
      rangeSat[deg] = sat;
      rangeLight[deg] = light;
    }
  }

  const hueShift = adjust.hue / 360;
  const saturationFactor = adjust.saturation / 100;
  const vibranceAmount = adjust.vibrance / 100;
  const lightnessAmount = adjust.lightness / 100;
  const hslActive =
    Boolean(hueShift || saturationFactor || vibranceAmount || lightnessAmount) || rangesActive;

  const filterActive = filter.enabled && filter.density > 0;
  const filterTint = filterActive ? hexToRgb(filter.color) : [0, 0, 0];

  const pureLut =
    !mixer.enabled &&
    !balanceActive &&
    !blackWhite.enabled &&
    !hslActive &&
    !filterActive &&
    !gradient.enabled &&
    !(lookup.enabled && lookup.intensity > 0);

  compiledKey = key;
  compiledValue = {
    lutR: buildChannelLut(adjust, 0),
    lutG: buildChannelLut(adjust, 1),
    lutB: buildChannelLut(adjust, 2),
    mixer: mixer.enabled
      ? {
          r0: mixer.red[0] / 100, r1: mixer.red[1] / 100, r2: mixer.red[2] / 100,
          g0: mixer.green[0] / 100, g1: mixer.green[1] / 100, g2: mixer.green[2] / 100,
          b0: mixer.blue[0] / 100, b1: mixer.blue[1] / 100, b2: mixer.blue[2] / 100,
          mono: mixer.monochrome,
        }
      : null,
    balance: compiledBalance,
    toneShadow,
    toneMid,
    toneHigh,
    bw: compiledBw,
    rangeShift,
    rangeSat,
    rangeLight,
    hsl: hslActive ? { hue: hueShift, sat: saturationFactor, vibrance: vibranceAmount, lightness: lightnessAmount } : null,
    filter: filterActive
      ? { tr: filterTint[0], tg: filterTint[1], tb: filterTint[2], k: clamp01(filter.density / 100), preserve: filter.preserveLuminosity }
      : null,
    gradient: gradient.enabled ? gradientTable(gradient) : null,
    look: lookup.enabled && lookup.intensity > 0
      ? { table: bakeLook(lookup.preset), intensity: clamp01(lookup.intensity / 100) }
      : null,
    pureLut,
  };
  return compiledValue;
}

/* ------------------------------ 主入口 ------------------------------ */

/** 就地处理一段 RGBA 像素。`adjust` 为空或等于恒等时直接返回。 */
export function applyAdjustToImageData(data: Uint8ClampedArray, adjust: MosaicAdjust | undefined | null): void {
  if (!adjust || isAdjustIdentity(adjust)) return;
  const compiled = compileAdjust(adjust);
  const { lutR, lutG, lutB } = compiled;

  // 最快路径：只有点运算 → 三个通道各自查表，连临时变量都不用夹取。
  if (compiled.pureLut) {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = lutR[data[i]];
      data[i + 1] = lutG[data[i + 1]];
      data[i + 2] = lutB[data[i + 2]];
    }
    return;
  }

  const mixer = compiled.mixer;
  const balance = compiled.balance;
  const toneShadow = compiled.toneShadow;
  const toneMid = compiled.toneMid;
  const toneHigh = compiled.toneHigh;
  const bw = compiled.bw;
  const rangeShift = compiled.rangeShift;
  const rangeSat = compiled.rangeSat;
  const rangeLight = compiled.rangeLight;
  const hsl = compiled.hsl;
  const filter = compiled.filter;
  const gradient = compiled.gradient;
  const look = compiled.look;
  const lookIntensity = look ? look.intensity : 0;
  const lut3 = look ? look.table : null;
  const lutSize = LUT_SIZE;
  const lutStrideZ = lutSize * lutSize * 3;
  const lutStrideY = lutSize * 3;
  const lutScale = (lutSize - 1) / 255;

  for (let i = 0; i < data.length; i += 4) {
    let r = lutR[data[i]];
    let g = lutG[data[i + 1]];
    let b = lutB[data[i + 2]];

    if (mixer) {
      const nr = mixer.r0 * r + mixer.r1 * g + mixer.r2 * b;
      if (mixer.mono) {
        const gray = clamp255(nr);
        r = gray;
        g = gray;
        b = gray;
      } else {
        const ng = mixer.g0 * r + mixer.g1 * g + mixer.g2 * b;
        const nb = mixer.b0 * r + mixer.b1 * g + mixer.b2 * b;
        r = clamp255(nr);
        g = clamp255(ng);
        b = clamp255(nb);
      }
    }

    if (balance) {
      const toneIndex = Math.min(255, Math.max(0, ((Math.max(r, g, b) + Math.min(r, g, b)) / 2) | 0));
      const ws = toneShadow![toneIndex] * 0.5;
      const wm = toneMid![toneIndex] * 0.5;
      const wh = toneHigh![toneIndex] * 0.5;
      const nr = r + ws * balance.sdr + wm * balance.mdr + wh * balance.hdr;
      const ng = g + ws * balance.sdg + wm * balance.mdg + wh * balance.hdg;
      const nb = b + ws * balance.sdb + wm * balance.mdb + wh * balance.hdb;
      if (balance.preserve) {
        const before = (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
        const after = (Math.max(nr, ng, nb) + Math.min(nr, ng, nb)) / 2;
        if (after > 0.001) {
          const scale = before / after;
          r = nr * scale;
          g = ng * scale;
          b = nb * scale;
        } else {
          r = nr;
          g = ng;
          b = nb;
        }
      } else {
        r = nr;
        g = ng;
        b = nb;
      }
    }

    const max = r > g ? (r > b ? r : b) : g > b ? g : b;
    const min = r < g ? (r < b ? r : b) : g < b ? g : b;

    if (bw) {
      // 灰度：按色相权重缩放亮度（默认 40 = ×1.0）
      const deg = max === min ? 0 : hueIndex(r, g, b, max, min);
      const gray = clamp255((0.299 * r + 0.587 * g + 0.114 * b) * bw.factor[deg]);
      if (bw.tint) {
        const k = gray / 255;
        r = clamp255(bw.tint[0] * k);
        g = clamp255(bw.tint[1] * k);
        b = clamp255(bw.tint[2] * k);
      } else {
        r = gray;
        g = gray;
        b = gray;
      }
    } else if (hsl) {
      const rn = r / 255;
      const gn = g / 255;
      const bn = b / 255;
      const mx = max / 255;
      const mn = min / 255;
      let l = (mx + mn) / 2;
      let s = 0;
      let h = 0;
      if (mx !== mn) {
        const d = mx - mn;
        s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
        if (mx === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
        else if (mx === gn) h = ((bn - rn) / d + 2) / 6;
        else h = ((rn - gn) / d + 4) / 6;
      }
      const lightnessAmount = hsl.lightness;
      if (lightnessAmount) l = clamp01(l + lightnessAmount * (lightnessAmount > 0 ? 1 - l : l));
      if (hsl.hue) h = (h + hsl.hue + 1) % 1;
      if (hsl.sat) s = clamp01(s * (1 + hsl.sat));
      if (hsl.vibrance) s = clamp01(s * (1 + hsl.vibrance * (1 - s)));
      if (rangeShift) {
        const deg = (h * 360) | 0;
        const shift = rangeShift[deg];
        const satAdd = rangeSat![deg];
        const lightAdd = rangeLight![deg];
        if (shift || satAdd || lightAdd) {
          if (shift) h = (h + shift / 360 + 1) % 1;
          if (satAdd) s = clamp01(s * (1 + satAdd));
          if (lightAdd) l = clamp01(l + lightAdd * (lightAdd > 0 ? 1 - l : l));
        }
      }
      if (s <= 0) {
        const value = l * 255;
        r = value;
        g = value;
        b = value;
      } else {
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        r = hueToRgb(p, q, h + 1 / 3) * 255;
        g = hueToRgb(p, q, h) * 255;
        b = hueToRgb(p, q, h - 1 / 3) * 255;
      }
    }

    if (filter) {
      const k = filter.k;
      let nr = r * (1 - k + k * (filter.tr / 255));
      let ng = g * (1 - k + k * (filter.tg / 255));
      let nb = b * (1 - k + k * (filter.tb / 255));
      if (filter.preserve) {
        const before = 0.299 * r + 0.587 * g + 0.114 * b;
        const after = 0.299 * nr + 0.587 * ng + 0.114 * nb;
        if (after > 0.001) {
          const scale = before / after;
          nr *= scale;
          ng *= scale;
          nb *= scale;
        }
      }
      r = clamp255(nr);
      g = clamp255(ng);
      b = clamp255(nb);
    }

    if (gradient) {
      const luminance = (0.299 * r + 0.587 * g + 0.114 * b) | 0;
      const index = (luminance > 255 ? 255 : luminance) * 3;
      r = gradient[index];
      g = gradient[index + 1];
      b = gradient[index + 2];
    }

    if (lut3) {
      // 三线性插值；索引直接算，不建闭包、不建数组
      const fx = clamp255(r) * lutScale;
      const fy = clamp255(g) * lutScale;
      const fz = clamp255(b) * lutScale;
      const x0 = fx | 0;
      const y0 = fy | 0;
      const z0 = fz | 0;
      const x1 = x0 + 1 < lutSize ? x0 + 1 : lutSize - 1;
      const y1 = y0 + 1 < lutSize ? y0 + 1 : lutSize - 1;
      const z1 = z0 + 1 < lutSize ? z0 + 1 : lutSize - 1;
      const tx = fx - x0;
      const ty = fy - y0;
      const tz = fz - z0;
      const base0 = z0 * lutStrideZ + y0 * lutStrideY;
      const base1 = z1 * lutStrideZ + y0 * lutStrideY;
      const base2 = z0 * lutStrideZ + y1 * lutStrideY;
      const base3 = z1 * lutStrideZ + y1 * lutStrideY;
      const i000 = base0 + x0 * 3;
      const i100 = base0 + x1 * 3;
      const i010 = base2 + x0 * 3;
      const i110 = base2 + x1 * 3;
      const i001 = base1 + x0 * 3;
      const i101 = base1 + x1 * 3;
      const i011 = base3 + x0 * 3;
      const i111 = base3 + x1 * 3;
      let lr = 0;
      let lg = 0;
      let lb = 0;
      for (let c = 0; c < 3; c += 1) {
        const c000 = lut3[i000 + c];
        const c100 = lut3[i100 + c];
        const c010 = lut3[i010 + c];
        const c110 = lut3[i110 + c];
        const c001 = lut3[i001 + c];
        const c101 = lut3[i101 + c];
        const c011 = lut3[i011 + c];
        const c111 = lut3[i111 + c];
        const c00 = c000 + (c100 - c000) * tx;
        const c10 = c010 + (c110 - c010) * tx;
        const c01 = c001 + (c101 - c001) * tx;
        const c11 = c011 + (c111 - c011) * tx;
        const value = (c00 + (c10 - c00) * ty) * (1 - tz) + (c01 + (c11 - c01) * ty) * tz;
        if (c === 0) lr = value * 255;
        else if (c === 1) lg = value * 255;
        else lb = value * 255;
      }
      if (lookIntensity >= 1) {
        r = lr;
        g = lg;
        b = lb;
      } else {
        r = r + (lr - r) * lookIntensity;
        g = g + (lg - g) * lookIntensity;
        b = b + (lb - b) * lookIntensity;
      }
    }

    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }
}

/** 色相角（0..359），只用于查表。 */
function hueIndex(r: number, g: number, b: number, max: number, min: number): number {
  const d = max - min;
  if (d === 0) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  const deg = (h * 360) | 0;
  return deg < 0 ? 0 : deg > 359 ? 359 : deg;
}

/** 三段直方图（0..255），`max` 是去掉端点后的峰值，画图时用来归一。 */
export function histogramOf(data: Uint8ClampedArray): AdjustHistogram {
  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  const lum = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) {
    r[data[i]] += 1;
    g[data[i + 1]] += 1;
    b[data[i + 2]] += 1;
    lum[Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114)] += 1;
  }
  let max = 1;
  for (let i = 1; i < 255; i += 1) {
    max = Math.max(max, r[i], g[i], b[i]);
  }
  return { r, g, b, lum, max };
}

/* ------------------------------ 画布与缓存 ------------------------------ */

/** 把一张图按调整参数画到离屏画布（用于导出链路）。 */
export function renderAdjustedCanvas(
  image: CanvasImageSource,
  width: number,
  height: number,
  adjust: MosaicAdjust | undefined | null,
  mask?: Uint8ClampedArray | null,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const context = canvas.getContext("2d");
  if (!context) return canvas;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  if (adjust && !isAdjustIdentity(adjust)) {
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    // 有掩码时：只对掩码内（alpha>0）的像素调色，掩码外保持原样。
    // 实现：先把原图备份，调完色后按掩码 alpha 把原像素混合回来。
    const original = mask ? new Uint8ClampedArray(pixels.data) : null;
    applyAdjustToImageData(pixels.data, adjust);
    if (original && mask) {
      for (let i = 0; i < mask.length; i += 1) {
        if (mask[i] === 0) {
          // 掩码外：还原原像素（RGBA 四个字节）。
          const o = i * 4;
          pixels.data[o] = original[o];
          pixels.data[o + 1] = original[o + 1];
          pixels.data[o + 2] = original[o + 2];
          pixels.data[o + 3] = original[o + 3];
        }
      }
    }
    context.putImageData(pixels, 0, 0);
  }
  return canvas;
}

const previewCache = new Map<string, string>();
/**
 * 同一组参数正在算的时候，别的调用者直接等它，不要再算一遍。
 *
 * 编辑器打开时，画布上那个节点仍然挂载着，同一个图层会被「编辑器预览」和
 * 「节点预览」同时请求；去重能让这一帧只算一次。
 */
const previewInflight = new Map<string, Promise<string>>();
const PREVIEW_CACHE_LIMIT = 32;

/**
 * 预览只用小图。
 *
 * 之前按原图尺寸（2048×1536 = 3.1M 像素）逐像素算，一次要上百毫秒，
 * 拖滑块时根本跟不上，只能「松手才更新」。降到 720px 长边后每帧 ~20ms，
 * 就能边拖边变了；导出走的是另一条路（全分辨率），不受影响。
 */
export const PREVIEW_MAX_EDGE = 720;
/**
 * 拖动过程中的「草稿」分辨率。
 *
 * 全开所有调整项时，720px 单帧要 160ms 左右 —— 一帧一帧地等，手感就是卡。
 * 草稿档只算 320px（约 1/5 的像素），先把「变化」实时呈现出来；
 * 停手后再补一张 720px 的清晰图。两档走的是同一份像素实现，画面内容一致，
 * 只有分辨率不同，所以不会出现「草稿和成片不一样」。
 */
export const PREVIEW_DRAFT_MAX_EDGE = 320;
const SOURCE_CACHE_LIMIT = 8;

interface PreviewSource {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

/** 解码 + 缩放一次的源图缓存（拖滑块时不再重复加载、重复缩放）。 */
const previewSourceCache = new Map<string, PreviewSource>();
/** 只解一次、只写一次的复用画布 —— 每帧新建 canvas 会带来额外分配开销。 */
let previewCanvas: HTMLCanvasElement | null = null;

function loadImageElement(url: string, cors: boolean): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    if (cors) image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`图片加载失败：${url.slice(0, 96)}`));
    image.src = url;
  });
}

/**
 * 走 fetch → blob 再取一次。
 *
 * `asset://` 这类本地地址直接用 `<img>` 时，有的内核会把它当跨域，
 * `getImageData` 直接抛 SecurityError；转成 blob URL 就是同源，能正常读像素。
 */
async function loadImageViaBlob(url: string): Promise<HTMLImageElement> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`图片读取失败：${response.status}`);
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    return await loadImageElement(objectUrl, false);
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
  }
}

function previewSize(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const longEdge = Math.max(width, height);
  if (!longEdge || longEdge <= maxEdge) {
    return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
  }
  const scale = maxEdge / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function paintSource(image: HTMLImageElement, maxEdge: number): PreviewSource {
  const size = previewSize(image.naturalWidth, image.naturalHeight, maxEdge);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建预览画布");
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, size.width, size.height);
  // 读一个像素试一下：被跨域污染的画布会在这一步抛 SecurityError，
  // 提前发现才能改走 blob 重试，而不是到了逐像素处理才失败。
  context.getImageData(0, 0, 1, 1);
  return { canvas, width: size.width, height: size.height };
}

async function loadPreviewSource(url: string, maxEdge: number): Promise<PreviewSource> {
  const cacheKey = `${maxEdge}|${url}`;
  const cached = previewSourceCache.get(cacheKey);
  if (cached) return cached;

  let source: PreviewSource;
  try {
    source = paintSource(await loadImageElement(url, /^https?:/i.test(url)), maxEdge);
  } catch (error) {
    console.warn("[Mosaic] 直读原图失败，改用 blob 重试", error);
    source = paintSource(await loadImageViaBlob(url), maxEdge);
  }

  previewSourceCache.set(cacheKey, source);
  if (previewSourceCache.size > SOURCE_CACHE_LIMIT) {
    const oldest = previewSourceCache.keys().next().value;
    if (oldest) previewSourceCache.delete(oldest);
  }
  return source;
}

/** 把调整参数落到复用画布上，同步完成（所以可以安全地共用一块画布）。 */
function paintAdjusted(source: PreviewSource, adjust: MosaicAdjust, maskAlpha?: Uint8ClampedArray | null): HTMLCanvasElement {
  if (!previewCanvas) previewCanvas = document.createElement("canvas");
  const canvas = previewCanvas;
  if (canvas.width !== source.width || canvas.height !== source.height) {
    canvas.width = source.width;
    canvas.height = source.height;
  }
  const context = canvas.getContext("2d");
  if (!context) return canvas;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source.canvas, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  // 有掩码时：备份原像素，调完色后掩码外还原（局部调色）。
  const original = maskAlpha ? new Uint8ClampedArray(pixels.data) : null;
  applyAdjustToImageData(pixels.data, adjust);
  if (original && maskAlpha) {
    for (let i = 0; i < maskAlpha.length; i += 1) {
      if (maskAlpha[i] === 0) {
        const o = i * 4;
        pixels.data[o] = original[o];
        pixels.data[o + 1] = original[o + 1];
        pixels.data[o + 2] = original[o + 2];
        pixels.data[o + 3] = original[o + 3];
      }
    }
  }
  context.putImageData(pixels, 0, 0);
  return canvas;
}

/**
 * 生成「已调整」的预览 data URL（给 `<img>` 用）。
 *
 * 同一组参数走缓存；源图只解码/缩放一次。调用方负责「只跑最新一帧」，
 * 所以这里不做任何节流 —— 有请求就立刻算，早算完界面就早跟上手指。
 */
export function getAdjustedPreviewUrl(
  imageUrl: string,
  adjust: MosaicAdjust | undefined | null,
  maxEdge: number = PREVIEW_MAX_EDGE,
  maskDataUrl?: string | null,
): Promise<string> {
  if (!adjust || isAdjustIdentity(adjust)) return Promise.resolve(imageUrl);
  const key = `${maxEdge}|${imageUrl}|${JSON.stringify(adjust)}|${maskDataUrl ?? ""}`;
  const cached = previewCache.get(key);
  if (cached) return Promise.resolve(cached);
  const inflight = previewInflight.get(key);
  if (inflight) return inflight;

  const task = (async () => {
    const source = await loadPreviewSource(imageUrl, maxEdge);
    // 有局部调色蒙版时，把掩码缩放到预览尺寸（图层框坐标 → 预览源图坐标，近似等比缩放）。
    let maskAlpha: Uint8ClampedArray | null = null;
    if (maskDataUrl) {
      maskAlpha = await loadMaskAlphaForPreview(maskDataUrl, source.width, source.height);
    }
    const url = paintAdjusted(source, adjust, maskAlpha).toDataURL("image/png");
    previewCache.set(key, url);
    if (previewCache.size > PREVIEW_CACHE_LIMIT) {
      const oldest = previewCache.keys().next().value;
      if (oldest) previewCache.delete(oldest);
    }
    return url;
  })().finally(() => {
    previewInflight.delete(key);
  });
  previewInflight.set(key, task);
  return task;
}

/** 从掩码 data URL 读 alpha，缩放到目标尺寸（预览用，近似等比）。 */
async function loadMaskAlphaForPreview(maskDataUrl: string, width: number, height: number): Promise<Uint8ClampedArray | null> {
  try {
    const image = await loadImageElement(maskDataUrl, true);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, width, height);
    const data = ctx.getImageData(0, 0, width, height).data;
    const alpha = new Uint8ClampedArray(width * height);
    for (let i = 0; i < alpha.length; i += 1) {
      alpha[i] = data[i * 4 + 3];
    }
    return alpha;
  } catch {
    return null;
  }
}
