import { describe, expect, it } from "vitest";

import type { Asset } from "../../shared-types";
import { buildAssetReferenceTag, renderAssetLine } from "../../engine";

const asset: Asset = {
  id: "hero", kind: "character", name: "HERO", description: "A man in a navy suit.",
  descriptionZh: "穿海军蓝西装的男人。", notes: "性格内敛，声音低沉沙哑。", notesZh: "性格内敛，声音低沉沙哑。",
  referencePaths: [], lockLevel: "strict", tags: [],
};

describe("renderAssetLine user notes isolation", () => {
  it("does not export user notes in either locale", () => {
    const zh = renderAssetLine(asset, 1, "at-mention", "zh");
    const en = renderAssetLine(asset, 1, "at-mention", "en");
    expect(zh).toContain("穿海军蓝西装的男人。");
    expect(en).toContain("A man in a navy suit.");
    expect(zh).not.toContain("性格内敛");
    expect(en).not.toContain("性格内敛");
    expect(zh).not.toContain("声音低沉");
    expect(en).not.toContain("声音低沉");
  });
});

describe("asset reference naming", () => {
  it("uses the stable project / state / version tag in @ references", () => {
    const tagged = {
      ...asset,
      stateName: "rain soaked",
      version: 2,
      referenceTag: buildAssetReferenceTag({ ...asset, stateName: "rain soaked", version: 2 }, "CB"),
    };
    const output = renderAssetLine(tagged, 1, "at-mention", "en");
    expect(tagged.referenceTag).toBe("char_cb_hero_rain-soaked_v2");
    expect(output).toContain("@char_cb_hero_rain-soaked_v2");
  });

  it("merges a variant's inherited base description with its change-only description", () => {
    const output = renderAssetLine({ ...asset, baseDescriptionZh: "中年男性，深蓝西装", descriptionZh: "西装被雨水浸透，领口沾有血迹" }, 1, "at-mention", "zh");
    expect(output).toContain("中年男性，深蓝西装；西装被雨水浸透，领口沾有血迹");
  });
});
