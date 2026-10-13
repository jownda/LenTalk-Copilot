import { describe, expect, it } from "vitest";

import {
  QUICK_ASSET_LIST_HEIGHT,
  QUICK_ASSET_PANEL_CHROME_HEIGHT,
  QUICK_ASSET_PANEL_MIN_WIDTH,
  QUICK_ASSET_PANEL_WIDTH,
  QUICK_ASSET_RENDER_BATCH,
  QUICK_ASSET_VIEWPORT_MARGIN,
  nextQuickAssetRenderCount,
  resolveQuickAssetPanelSize,
} from "./quickAssetPickerLayout";

describe("resolveQuickAssetPanelSize", () => {
  it("keeps the target width and list height on a roomy desktop viewport", () => {
    const size = resolveQuickAssetPanelSize({ width: 1600, height: 900 });

    expect(size.width).toBe(QUICK_ASSET_PANEL_WIDTH);
    expect(size.listHeight).toBe(QUICK_ASSET_LIST_HEIGHT);
  });

  it("narrows the card so it still fits a small window", () => {
    const size = resolveQuickAssetPanelSize({ width: 320, height: 900 });

    // 卡片 + 左右各 16px 留白必须落在视口内。
    expect(size.width).toBe(320 - QUICK_ASSET_VIEWPORT_MARGIN * 2);
    expect(size.width + QUICK_ASSET_VIEWPORT_MARGIN * 2).toBeLessThanOrEqual(320);
  });

  it("never shrinks the card below the usable minimum", () => {
    expect(resolveQuickAssetPanelSize({ width: 120, height: 900 }).width).toBe(QUICK_ASSET_PANEL_MIN_WIDTH);
  });

  it("shrinks the list on a short viewport so the whole card fits", () => {
    const viewportHeight = 300;
    const size = resolveQuickAssetPanelSize({ width: 1600, height: viewportHeight });

    expect(size.listHeight).toBeLessThan(QUICK_ASSET_LIST_HEIGHT);
    // 列表 + 标题行 + 上下留白不超过视口高度。
    expect(size.listHeight + QUICK_ASSET_PANEL_CHROME_HEIGHT + QUICK_ASSET_VIEWPORT_MARGIN * 2).toBeLessThanOrEqual(
      viewportHeight,
    );
  });

  it("keeps a floor on the list height for absurdly short viewports", () => {
    expect(resolveQuickAssetPanelSize({ width: 1600, height: 120 }).listHeight).toBeGreaterThan(0);
  });

  it("honours a wider preferred width but still clamps it into the viewport", () => {
    // 工作台面板比画布节点宽，卡片可以要更宽的理想值……
    expect(resolveQuickAssetPanelSize({ width: 1600, height: 900 }, 440).width).toBe(440);
    // ……但窄窗口下仍然不许溢出。
    expect(resolveQuickAssetPanelSize({ width: 320, height: 900 }, 440).width).toBe(
      320 - QUICK_ASSET_VIEWPORT_MARGIN * 2,
    );
  });
});

describe("nextQuickAssetRenderCount", () => {
  it("adds one batch at a time", () => {
    expect(nextQuickAssetRenderCount(QUICK_ASSET_RENDER_BATCH, 500)).toBe(QUICK_ASSET_RENDER_BATCH * 2);
  });

  it("stops at the total so a large library does not over-render", () => {
    expect(nextQuickAssetRenderCount(940, 950)).toBe(950);
    expect(nextQuickAssetRenderCount(950, 950)).toBe(950);
  });

  it("handles an empty library", () => {
    expect(nextQuickAssetRenderCount(0, 0)).toBe(0);
  });

  it("recovers from a nonsensical current value", () => {
    expect(nextQuickAssetRenderCount(Number.NaN, 10)).toBe(10);
    expect(nextQuickAssetRenderCount(-5, 10)).toBe(10);
  });
});
