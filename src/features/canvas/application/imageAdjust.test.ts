import { describe, expect, it } from "vitest";
import {
  DEFAULT_IMAGE_ADJUSTMENTS,
  applyAdjustmentsToImageData,
} from "./imageAdjust";

function makeImageData(r: number, g: number, b: number): ImageData {
  const data = new Uint8ClampedArray([r, g, b, 255, r, g, b, 255]);
  return { data, width: 2, height: 1, colorSpace: "srgb" } as unknown as ImageData;
}

describe("applyAdjustmentsToImageData", () => {
  it("默认参数不改变像素", () => {
    const imageData = makeImageData(100, 150, 200);
    applyAdjustmentsToImageData(imageData, DEFAULT_IMAGE_ADJUSTMENTS);
    expect(imageData.data[0]).toBe(100);
    expect(imageData.data[1]).toBe(150);
    expect(imageData.data[2]).toBe(200);
  });

  it("亮度提升后像素变亮", () => {
    const imageData = makeImageData(100, 100, 100);
    applyAdjustmentsToImageData(imageData, { ...DEFAULT_IMAGE_ADJUSTMENTS, brightness: 100 });
    expect(imageData.data[0]).toBeGreaterThan(100);
  });

  it("亮度降低后像素变暗", () => {
    const imageData = makeImageData(100, 100, 100);
    applyAdjustmentsToImageData(imageData, { ...DEFAULT_IMAGE_ADJUSTMENTS, brightness: -100 });
    expect(imageData.data[0]).toBeLessThan(100);
  });

  it("饱和度拉到最低变灰度", () => {
    const imageData = makeImageData(200, 100, 50);
    applyAdjustmentsToImageData(imageData, { ...DEFAULT_IMAGE_ADJUSTMENTS, saturation: -100 });
    // 饱和度为 0 时 RGB 应趋于灰度(三者接近)
    const [r, g, b] = [imageData.data[0], imageData.data[1], imageData.data[2]];
    expect(Math.abs(r - g)).toBeLessThan(3);
    expect(Math.abs(g - b)).toBeLessThan(3);
  });

  it("色温偏暖: 红增蓝减", () => {
    const imageData = makeImageData(128, 128, 128);
    applyAdjustmentsToImageData(imageData, { ...DEFAULT_IMAGE_ADJUSTMENTS, temperature: 100 });
    expect(imageData.data[0]).toBeGreaterThan(imageData.data[2]);
  });

  it("像素值被 clamp 到 0~255", () => {
    const imageData = makeImageData(250, 250, 250);
    applyAdjustmentsToImageData(imageData, { ...DEFAULT_IMAGE_ADJUSTMENTS, brightness: 100 });
    expect(imageData.data[0]).toBeLessThanOrEqual(255);
  });
});
