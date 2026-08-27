import { describe, expect, it } from "vitest";

import type { Asset, SceneV2, ShotV2 } from "../../shared-types";
import { buildAssetReferenceTag, buildSceneAssetRegistry, renderAssetLine, resolveCharacterOrder } from "../../engine";

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

  it("renders prop defaults with a resolved holder reference", () => {
    const prop: Asset = {
      id: "lighter", kind: "prop", name: "打火机", description: "", descriptionZh: "银色金属打火机",
      referencePaths: [], lockLevel: "none", tags: [], propUsageZh: "仅用于点烟", propHolderCharacterId: "hero",
      propPositionZh: "右手握持", propDefaultStateZh: "未点燃",
    };
    const output = renderAssetLine(prop, 2, "at-mention", "zh", (id) => id === "hero" ? "@hero" : id);
    expect(output).toContain("道具默认：使用：仅用于点烟；持有者：@hero；位置：右手握持；状态：未点燃");
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

describe("shot participant isolation", () => {
  it("镜头已有 participants 时，只用场景站位为其排序，不泄漏未出镜角色", () => {
    const scene = {
      id: "scene", name: "测试", logline: "", location: "车厢", time: "夜", weather: "雨", duration: "8秒",
      palette: "", lighting: "", environmentLock: true,
      staging: { characterOrder: ["dalian", "ajun", "qiqi"] },
      shots: [],
    } as SceneV2;
    const shot = {
      id: "shot", label: "特写", duration: "3秒", framing: "特写", lens: "50mm", movement: "Static", action: "倾听", acting: "克制", direction: "left-to-right",
      participants: [{ characterId: "ajun", role: "primary", position: "center" }],
    } as ShotV2;

    expect(resolveCharacterOrder(scene, shot)).toEqual(["ajun"]);
  });
});

describe("attached character props", () => {
  it("includes character-linked props whenever the character is referenced", () => {
    const hero = { ...asset, id: "hero", attachedPropIds: ["lighter"] };
    const lighter: Asset = {
      id: "lighter", kind: "prop", name: "打火机", description: "", descriptionZh: "银色打火机",
      referencePaths: [], lockLevel: "none", tags: [],
    };
    const scene = {
      id: "scene", name: "测试", logline: "", location: "车厢", time: "夜", weather: "雨", duration: "8秒",
      palette: "", lighting: "", environmentLock: true,
      shots: [{ id: "shot", label: "近景", duration: "3秒", framing: "近景", lens: "50mm", movement: "Static", action: "点烟", acting: "克制", direction: "left-to-right", characterId: "hero" }],
    } as SceneV2;
    const registry = buildSceneAssetRegistry({ assets: [hero, lighter] } as any, scene);
    expect(registry.orderedAssets.map((item) => item.id)).toEqual(["hero", "lighter"]);
  });
});
