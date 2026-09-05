import { describe, expect, it } from "vitest";

import type { Asset, SceneV2, ShotV2 } from "../../shared-types";
import { buildAssetReferenceTag, buildSceneAssetRegistry, renderAssetLine, resolveCharacterOrder } from "../../engine";
import { renderSpatialLayoutLine } from "./renderer";
import { renderShotSection } from "./sections";

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
    expect(output).toContain("由@hero持有，放在右手握持，用于仅用于点烟，保持未点燃状态");
    expect(output).not.toContain("道具默认");
  });

  it("uses a readable name-and-kind fallback instead of repeating an internal prop id", () => {
    const prop: Asset = {
      id: "prop_internal_123", kind: "prop", name: "红色托特包", referenceTag: "prop_cully_tote_base_v1",
      description: "", descriptionZh: "", referencePaths: [], lockLevel: "none", tags: [],
    };
    const output = renderAssetLine(prop, 1, "at-mention", "zh");
    expect(output).toContain("@prop_cully_tote_base_v1 [image1] — 红色托特包：红色托特包（道具）");
    expect(output).not.toContain("：prop_cully_tote_base_v1");
    expect(output).not.toContain("prop_internal_123");
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

describe("prop changes", () => {
  it("renders one prop-change description and never exports legacy start/end states", () => {
    const prop: Asset = {
      id: "lighter", kind: "prop", name: "打火机", description: "", descriptionZh: "银色打火机",
      referencePaths: [], lockLevel: "none", tags: [],
    };
    const scene: SceneV2 = {
      id: "scene", name: "场景", logline: "", location: "", time: "", weather: "", duration: "5秒", palette: "", lighting: "", environmentLock: true,
      shots: [],
    };
    const shot: ShotV2 = {
      id: "shot", label: "01", duration: "0-5秒", framing: "Medium close-up", lens: "50mm", movement: "Static", action: "", acting: "", direction: "left-to-right",
      propChangeDescription: "角色拿起打火机并点燃，始终握在右手。",
      propStatesAtStart: [{ propId: "lighter", state: "intact" }],
      propStatesAtEnd: [{ propId: "lighter", state: "burning" }],
    };
    const project = { id: "project", title: "测试", description: "", preset: "custom" as const, scenes: [scene], characters: [], assets: [prop] };

    const output = renderShotSection(project, scene, shot, "zh");
    expect(output).toContain("道具变化：角色拿起打火机并点燃，始终握在右手。");
    expect(output).not.toContain("起始状态");
    expect(output).not.toContain("结束状态");
    expect(output).not.toContain("intact");
    expect(output).not.toContain("burning");
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
  it("includes a character-linked prop when that character is active in a shot", () => {
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

describe("held props in spatial layout", () => {
  it("renders the holder relationship from propStatesAtStart into the spatial layout line", () => {
    const hero: Asset = {
      id: "hero", kind: "character", name: "HERO", description: "A man in a navy suit.",
      descriptionZh: "穿海军蓝西装的男人。", referencePaths: [], lockLevel: "strict", tags: [],
    };
    const partner: Asset = {
      id: "partner", kind: "character", name: "PARTNER", description: "A woman.",
      descriptionZh: "一位女性。", referencePaths: [], lockLevel: "strict", tags: [],
    };
    const lighter: Asset = {
      id: "lighter", kind: "prop", name: "打火机", description: "", descriptionZh: "银色金属打火机",
      referencePaths: [], lockLevel: "none", tags: [],
    };
    const scene: SceneV2 = {
      id: "scene", name: "场景", logline: "", location: "", time: "", weather: "", duration: "5秒",
      palette: "", lighting: "", environmentLock: true, shots: [],
    };
    const shot: ShotV2 = {
      id: "shot", label: "01", duration: "0-5秒", framing: "中景", lens: "50mm", movement: "Static",
      action: "", acting: "", direction: "left-to-right",
      participants: [
        { characterId: "hero", role: "primary", position: "left" },
        { characterId: "partner", role: "supporting", position: "right" },
      ],
      propStatesAtStart: [{ propId: "lighter", state: "held", holderCharacterId: "hero", position: "右手" }],
    };
    const project = {
      id: "project", title: "测试", description: "", preset: "custom" as const,
      scenes: [scene], characters: [], assets: [hero, partner, lighter],
    };

    const output = renderSpatialLayoutLine(project, shot, ["hero", "partner"], "zh");
    expect(output).toContain("HERO 携带");
    expect(output).toContain("打火机");
    expect(output).toContain("右手");
    expect(output).not.toContain("PARTNER 携带");
  });
});
