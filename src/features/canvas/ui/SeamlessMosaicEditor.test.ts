import { describe, expect, it } from "vitest";

import type { MosaicLayerItem } from "../domain/canvasNodes";
import { layoutMosaicLayers } from "./SeamlessMosaicEditor";

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
