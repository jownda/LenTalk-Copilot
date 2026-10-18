import { describe, expect, it } from "vitest";

import { buildAssetReferenceTag, withAssetReferenceTag } from "@/features/cinematicStudio/engine/asset-naming";
import type { Asset } from "@/features/cinematicStudio/shared-types";

function makeAsset(patch: Partial<Asset> = {}): Asset {
  return {
    id: "asset-1",
    kind: "character",
    name: "REIN",
    description: "",
    referencePaths: [],
    stateName: "base",
    version: 1,
    ...patch,
  } as Asset;
}

describe("资产引用名格式", () => {
  it("默认状态（base）只保留类型与名字 —— 不带项目码、不带 _base_v1", () => {
    expect(buildAssetReferenceTag(makeAsset())).toBe("char_rein");
  });

  it("状态名为空时同样只保留类型与名字", () => {
    expect(buildAssetReferenceTag(makeAsset({ stateName: "" }))).toBe("char_rein");
    expect(buildAssetReferenceTag(makeAsset({ stateName: "   " }))).toBe("char_rein");
  });

  it("加了状态才带状态与版本", () => {
    expect(buildAssetReferenceTag(makeAsset({ stateName: "wet", version: 2 }))).toBe("char_rein_wet_v2");
  });

  it("变体自动生成的 variant 状态要保留 —— 它是区分同名变体的唯一标识", () => {
    expect(buildAssetReferenceTag(makeAsset({ stateName: "variant", version: 2 }))).toBe(
      "char_rein_variant_v2",
    );
  });

  it("各类资产前缀不变", () => {
    expect(buildAssetReferenceTag(makeAsset({ kind: "location", name: "Bakery" }))).toBe("loc_bakery");
    expect(buildAssetReferenceTag(makeAsset({ kind: "prop", name: "Boombox", stateName: "broken", version: 3 })))
      .toBe("prop_boombox_broken_v3");
  });

  it("withAssetReferenceTag 写回 referenceTag，并补齐基卡字段", () => {
    const tagged = withAssetReferenceTag(makeAsset({ name: "REIN" }));
    expect(tagged.referenceTag).toBe("char_rein");
    expect(tagged.stateName).toBe("base");
    expect(tagged.version).toBe(1);
    expect(tagged.variantGroupId).toBe("asset-1");
    expect(tagged.baseAssetId).toBe("asset-1");
  });

  it("旧存档里的长格式引用名会被重算成新格式", () => {
    // 老项目存的是 `char_<项目码>_<名字>_<状态>_v<版本>`
    const legacy = makeAsset({ name: "REIN", referenceTag: "char_cb_rein_base_v1" });
    expect(withAssetReferenceTag(legacy).referenceTag).toBe("char_rein");

    const legacyVariant = makeAsset({
      name: "REIN",
      stateName: "wet",
      version: 2,
      referenceTag: "char_cb_rein_wet_v2",
    });
    expect(withAssetReferenceTag(legacyVariant).referenceTag).toBe("char_rein_wet_v2");
  });

  it("中文名保留（@ 引用要可读），空格与标点被规整", () => {
    expect(buildAssetReferenceTag(makeAsset({ name: "林小雨" }))).toBe("char_林小雨");
    expect(buildAssetReferenceTag(makeAsset({ name: "Rain Soaked!" }))).toBe("char_rain-soaked");
  });
});
