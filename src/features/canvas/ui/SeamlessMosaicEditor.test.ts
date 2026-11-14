import { describe, expect, it } from "vitest";

import type { MosaicLayerItem } from "../domain/canvasNodes";
import { cropCanvasTo, layoutMosaicLayers } from "./SeamlessMosaicEditor";

function createLayer(id: string, aspectRatio: string): MosaicLayerItem {
  return {
    id,
    imageUrl: `${id}.png`,
    aspectRatio,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    crop: null,
    visible: true,
    order: 0,
  };
}

describe("layoutMosaicLayers", () => {
  it("keeps every image aspect ratio when applying a grid template", () => {
    const layers = layoutMosaicLayers(
      [createLayer("landscape", "4:3"), createLayer("portrait", "9:16")],
      "grid",
      1920,
      1080,
      2,
      1,
      8,
    );

    expect(layers[0].width / layers[0].height).toBeCloseTo(4 / 3);
    expect(layers[1].width / layers[1].height).toBeCloseTo(9 / 16);
  });

  it("keeps every image aspect ratio when applying a strip template", () => {
    const [layer] = layoutMosaicLayers([createLayer("portrait", "3:4")], "h-strip", 1920, 1080, 3, 2, 8);

    expect(layer.width / layer.height).toBeCloseTo(3 / 4);
  });
});

describe("cropCanvasTo", () => {
  const layer: MosaicLayerItem = {
    ...createLayer("a", "4:3"),
    x: 200,
    y: 120,
    width: 800,
    height: 600,
  };

  it("裁剪 = 改画布尺寸 + 所有图层整体平移", () => {
    const result = cropCanvasTo([layer], { x: 100, y: 50, width: 500, height: 400 });
    expect({ width: result.width, height: result.height }).toEqual({ width: 500, height: 400 });
    expect(result.layers[0]).toMatchObject({ x: 100, y: 70, width: 800, height: 600 });
  });

  it("图层尺寸与裁剪信息一个都不动（不变形、不真的删像素）", () => {
    const result = cropCanvasTo([layer], { x: 300, y: 300, width: 200, height: 200 });
    expect(result.layers[0].width).toBe(800);
    expect(result.layers[0].height).toBe(600);
    expect(result.layers[0].crop).toBeNull();
    // 原坐标在画布左上角之外 → 负值，画面只是被画布裁掉，数据仍在
    expect(result.layers[0].x).toBe(-100);
    expect(result.layers[0].y).toBe(-180);
  });

  it("多图层同步平移", () => {
    const second = { ...createLayer("b", "1:1"), x: 400, y: 400, width: 200, height: 200 };
    const result = cropCanvasTo([layer, second], { x: 50, y: 20, width: 300, height: 300 });
    expect(result.layers.map((item) => [item.x, item.y])).toEqual([
      [150, 100],
      [350, 380],
    ]);
  });
});
