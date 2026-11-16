import { describe, expect, it } from "vitest";

import {
  createDefaultAdjust,
  isAdjustIdentity,
  adjustSummary,
  hexToRgb,
  rgbToHex,
  type MosaicAdjust,
} from "@/features/canvas/domain/mosaicAdjust";
import { applyAdjustToImageData, histogramOf, sampleCurveLut } from "./mosaicAdjust";

function pixel(r: number, g: number, b: number): Uint8ClampedArray {
  return new Uint8ClampedArray([r, g, b, 255]);
}

function adjustWith(patch: Partial<MosaicAdjust>): MosaicAdjust {
  return { ...createDefaultAdjust(), ...patch };
}

describe("isAdjustIdentity", () => {
  it("默认参数就是恒等", () => {
    expect(isAdjustIdentity(createDefaultAdjust())).toBe(true);
    expect(isAdjustIdentity(undefined)).toBe(true);
  });

  it("任何一项动过就不是恒等", () => {
    expect(isAdjustIdentity(adjustWith({ brightness: 1 }))).toBe(false);
    expect(isAdjustIdentity(adjustWith({ exposure: 0.1 }))).toBe(false);
    expect(
      isAdjustIdentity({
        ...createDefaultAdjust(),
        colorBalance: { ...createDefaultAdjust().colorBalance, midtones: [10, 0, 0] },
      }),
    ).toBe(false);
  });
});

describe("applyAdjustToImageData", () => {
  it("恒等参数不动像素", () => {
    const data = pixel(120, 60, 30);
    applyAdjustToImageData(data, createDefaultAdjust());
    expect([...data]).toEqual([120, 60, 30, 255]);
  });

  it("亮度 +100 变亮，-100 变暗", () => {
    const bright = pixel(100, 100, 100);
    applyAdjustToImageData(bright, adjustWith({ brightness: 100 }));
    expect(bright[0]).toBeGreaterThan(200);

    const dark = pixel(100, 100, 100);
    applyAdjustToImageData(dark, adjustWith({ brightness: -100 }));
    expect(dark[0]).toBeLessThan(20);
  });

  it("对比度 +100 拉开亮暗", () => {
    const light = pixel(180, 180, 180);
    const dark = pixel(60, 60, 60);
    applyAdjustToImageData(light, adjustWith({ contrast: 100 }));
    applyAdjustToImageData(dark, adjustWith({ contrast: 100 }));
    expect(light[0]).toBeGreaterThan(180);
    expect(dark[0]).toBeLessThan(60);
  });

  it("色阶：黑场抬到 128 后，中灰变黑", () => {
    const data = pixel(128, 128, 128);
    const adjust = createDefaultAdjust();
    adjust.levels.master.black = 128;
    applyAdjustToImageData(data, adjust);
    expect(data[0]).toBeLessThan(5);
  });

  it("曲线：把中点抬到 200，中灰应明显变亮", () => {
    const data = pixel(128, 128, 128);
    const adjust = createDefaultAdjust();
    adjust.curves.rgb = [
      { x: 0, y: 0 },
      { x: 128, y: 200 },
      { x: 255, y: 255 },
    ];
    applyAdjustToImageData(data, adjust);
    expect(data[0]).toBeGreaterThan(190);
    expect(data[0]).toBeLessThan(212);
  });

  it("色相旋转 180°：红变青", () => {
    const data = pixel(255, 0, 0);
    applyAdjustToImageData(data, adjustWith({ hue: 180 }));
    expect(data[0]).toBeLessThan(20);
    expect(data[1]).toBeGreaterThan(200);
    expect(data[2]).toBeGreaterThan(200);
  });

  it("饱和度 -100 变灰：三通道相等", () => {
    const data = pixel(200, 40, 40);
    applyAdjustToImageData(data, adjustWith({ saturation: -100 }));
    expect(Math.abs(data[0] - data[1])).toBeLessThan(2);
    expect(Math.abs(data[1] - data[2])).toBeLessThan(2);
  });

  it("色彩平衡加红：红↑、绿蓝↓", () => {
    const data = pixel(128, 128, 128);
    const adjust = createDefaultAdjust();
    adjust.colorBalance.midtones = [60, 0, 0];
    applyAdjustToImageData(data, adjust);
    expect(data[0]).toBeGreaterThan(128);
    expect(data[1]).toBeLessThan(128);
    expect(data[2]).toBeLessThan(128);
  });

  it("自然饱和度对已经很艳的颜色改动更小", () => {
    const vivid = pixel(250, 20, 20);
    const dull = pixel(140, 120, 120);
    const adjust = adjustWith({ vibrance: 100 });
    applyAdjustToImageData(vivid, adjust);
    applyAdjustToImageData(dull, adjust);
    // 两者都被加强，但灰度图（低饱和）的 s 提升比例更大
    expect(dull[1]).toBeLessThan(120);
    expect(vivid[1]).toBeLessThanOrEqual(20);
  });
});

describe("sampleCurveLut", () => {
  it("两点曲线就是恒等", () => {
    const lut = sampleCurveLut([
      { x: 0, y: 0 },
      { x: 255, y: 255 },
    ]);
    expect(Math.round(lut[0])).toBe(0);
    expect(Math.round(lut[128])).toBe(128);
    expect(Math.round(lut[255])).toBe(255);
  });
});

describe("histogramOf", () => {
  it("按通道统计", () => {
    const data = new Uint8ClampedArray([
      255, 0, 0, 255,
      255, 0, 0, 255,
      0, 0, 255, 255,
    ]);
    const histogram = histogramOf(data);
    expect(histogram.r[255]).toBe(2);
    expect(histogram.b[255]).toBe(1);
    expect(histogram.g[0]).toBe(3);
    // 峰值刻意忽略 0 与 255（大片纯黑纯白会把直方图压成一条线）
    expect(histogram.max).toBe(1);

    const midtones = new Uint8ClampedArray([80, 80, 80, 255, 80, 80, 80, 255]);
    expect(histogramOf(midtones).max).toBe(2);
  });
});

describe("adjustSummary", () => {
  it("列出动过的项目", () => {
    expect(adjustSummary(createDefaultAdjust())).toEqual([]);
    const adjust = createDefaultAdjust();
    adjust.brightness = 10;
    adjust.hue = 20;
    expect(adjustSummary(adjust)).toEqual(["亮度/对比度", "色相/饱和度"]);
  });
});

describe("进阶调整", () => {
  it("通道混合器：单色时按红通道系数算灰度", () => {
    const data = pixel(100, 100, 100);
    const adjust = adjustWith({});
    adjust.channelMixer = {
      ...adjust.channelMixer,
      enabled: true,
      monochrome: true,
      red: [50, 50, 50],
    };
    applyAdjustToImageData(data, adjust);
    expect(data[0]).toBe(150);
    expect(data[1]).toBe(150);
    expect(data[2]).toBe(150);
  });

  it("黑白：提高红色权重后，红色比蓝色亮", () => {
    const red = pixel(255, 0, 0);
    const blue = pixel(0, 0, 255);
    const adjust = adjustWith({});
    adjust.blackWhite = { ...adjust.blackWhite, enabled: true };
    applyAdjustToImageData(red, adjust);
    applyAdjustToImageData(blue, adjust);
    expect(red[0]).toBeGreaterThan(blue[0]);
    expect(red[0]).toBe(red[1]);
    expect(red[1]).toBe(red[2]);
  });

  it("六色域：红色域色相 +60° 后红色偏黄（绿通道抬起来）", () => {
    const data = pixel(255, 0, 0);
    const adjust = adjustWith({});
    adjust.hueRanges[0] = { hue: 60, saturation: 0, lightness: 0 };
    applyAdjustToImageData(data, adjust);
    expect(data[1]).toBeGreaterThan(80);
  });

  it("照片滤镜：暖色滤镜压蓝通道", () => {
    const data = pixel(128, 128, 128);
    const adjust = adjustWith({});
    adjust.photoFilter = { ...adjust.photoFilter, enabled: true, color: "#ec8a00", density: 100 };
    applyAdjustToImageData(data, adjust);
    expect(data[2]).toBeLessThan(128);
  });

  it("渐变映射：按亮度替换颜色（默认暗蓝 → 暖白）", () => {
    const dark = pixel(20, 20, 20);
    const bright = pixel(230, 230, 230);
    const adjust = adjustWith({});
    adjust.gradientMap = { ...adjust.gradientMap, enabled: true };
    applyAdjustToImageData(dark, adjust);
    applyAdjustToImageData(bright, adjust);
    // 暗部偏蓝、亮部偏暖
    expect(dark[2]).toBeGreaterThan(dark[0]);
    expect(bright[0]).toBeGreaterThan(bright[2]);
  });

  it("3D LUT：褪色预设会抬起黑场", () => {
    const data = pixel(0, 0, 0);
    const adjust = adjustWith({});
    adjust.colorLookup = { ...adjust.colorLookup, enabled: true, preset: "fade", intensity: 100 };
    applyAdjustToImageData(data, adjust);
    expect(data[0]).toBeGreaterThan(10);
  });

  it("强度 0 的 LUT 与关闭时一致", () => {
    const data = pixel(90, 120, 60);
    const adjust = adjustWith({});
    adjust.colorLookup = { ...adjust.colorLookup, enabled: true, preset: "punch", intensity: 0 };
    expect(isAdjustIdentity(adjust)).toBe(false);
    applyAdjustToImageData(data, adjust);
    expect([...data]).toEqual([90, 120, 60, 255]);
  });
});

describe("颜色工具", () => {
  it("hex 与 rgb 互相转换", () => {
    expect(hexToRgb("#ff8800")).toEqual([255, 136, 0]);
    expect(rgbToHex(255, 136, 0)).toBe("#ff8800");
    expect(hexToRgb("乱写")).toEqual([128, 128, 128]);
  });
});
