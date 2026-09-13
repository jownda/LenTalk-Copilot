import { describe, expect, it } from "vitest";

import type { ProjectV2, SceneV2 } from "./shared-types";
import { collectCinematicMediaReferences } from "./mediaReferences";

describe("collectCinematicMediaReferences", () => {
  it("keeps only explicitly active asset images and voice clips in compiler reference order", () => {
    const scene = {
      id: "scene", name: "测试", logline: "", location: "车厢", time: "夜", weather: "雨", duration: "8秒",
      palette: "", lighting: "", environmentLock: true,
      shots: [{ id: "shot", label: "近景", duration: "3秒", framing: "近景", lens: "50mm", movement: "Static", action: "倾听", acting: "克制", direction: "left-to-right", characterId: "hero" }],
    } as SceneV2;
    const project = {
      assets: [
        { id: "hero", kind: "character", name: "林sir", description: "", referencePaths: ["hero-image"], voiceClip: "hero-voice", lockLevel: "none", tags: [], attachedPropIds: ["lighter"] },
        { id: "lighter", kind: "prop", name: "打火机", description: "", referencePaths: ["lighter-image"], lockLevel: "none", tags: [] },
      ],
    } as unknown as ProjectV2;
    expect(collectCinematicMediaReferences(project, scene)).toEqual({
      referenceImages: ["hero-image", "lighter-image"],
      referenceAudio: ["hero-voice"],
    });
  });

  it("在场景站位里登记但还没分到镜头的角色，也进参考清单并追加在镜头资产之后", () => {
    // 资产库面板一直把 characterRoster 里的角色显示为「本场景已使用」，
    // 编译器必须用同一口径，否则角色的参考图 / 声音参考 / 随身道具会整块丢掉。
    const scene = {
      id: "scene", name: "测试", logline: "", location: "车厢", time: "夜", weather: "雨", duration: "8秒",
      palette: "", lighting: "", environmentLock: true,
      staging: { characterRoster: ["standby"] },
      shots: [{ id: "shot", label: "近景", duration: "3秒", framing: "近景", lens: "50mm", movement: "Static", action: "倾听", acting: "克制", direction: "left-to-right", characterId: "hero" }],
    } as SceneV2;
    const project = {
      assets: [
        { id: "hero", kind: "character", name: "林sir", description: "", referencePaths: ["hero-image"], voiceClip: "hero-voice", lockLevel: "none", tags: [], attachedPropIds: ["lighter"] },
        { id: "lighter", kind: "prop", name: "打火机", description: "", referencePaths: ["lighter-image"], lockLevel: "none", tags: [] },
        { id: "standby", kind: "character", name: "备用角色", description: "", referencePaths: ["standby-image"], voiceClip: "standby-voice", lockLevel: "none", tags: [], attachedPropIds: ["knife"] },
        { id: "knife", kind: "prop", name: "匕首", description: "", referencePaths: ["knife-image"], lockLevel: "none", tags: [] },
      ],
    } as unknown as ProjectV2;
    expect(collectCinematicMediaReferences(project, scene)).toEqual({
      // 镜头引用的资产编号保持不变，站位里的角色追加在后面
      referenceImages: ["hero-image", "lighter-image", "standby-image", "knife-image"],
      referenceAudio: ["hero-voice", "standby-voice"],
    });
  });

  it("同一资产既在镜头里又在站位清单里时只出现一次", () => {
    const scene = {
      id: "scene", name: "测试", logline: "", location: "车厢", time: "夜", weather: "雨", duration: "8秒",
      palette: "", lighting: "", environmentLock: true,
      staging: { characterRoster: ["hero"], characterOrder: ["hero"] },
      shots: [{ id: "shot", label: "近景", duration: "3秒", framing: "近景", lens: "50mm", movement: "Static", action: "倾听", acting: "克制", direction: "left-to-right", characterId: "hero" }],
    } as SceneV2;
    const project = {
      assets: [{ id: "hero", kind: "character", name: "林sir", description: "", referencePaths: ["hero-image"], voiceClip: "hero-voice", lockLevel: "none", tags: [] }],
    } as unknown as ProjectV2;
    expect(collectCinematicMediaReferences(project, scene)).toEqual({
      referenceImages: ["hero-image"],
      referenceAudio: ["hero-voice"],
    });
  });

  it("inserts the staging reference after active assets and drops first-frame-only images", () => {
    const scene = {
      id: "scene", name: "测试", logline: "", location: "车厢", time: "夜", weather: "雨", duration: "8秒",
      palette: "", lighting: "", environmentLock: true,
      staging: { stagingReferenceImage: "staging-layout" },
      firstFrameLock: { referenceImages: ["first-frame-a", "first-frame-b"] },
      shots: [{ id: "shot", label: "近景", duration: "3秒", framing: "近景", lens: "50mm", movement: "Static", action: "倾听", acting: "克制", direction: "left-to-right", characterId: "hero" }],
    } as SceneV2;
    const project = {
      assets: [{ id: "hero", kind: "character", name: "林sir", description: "", referencePaths: ["hero-image"], lockLevel: "none", tags: [] }],
    } as unknown as ProjectV2;
    expect(collectCinematicMediaReferences(project, scene).referenceImages).toEqual([
      "hero-image", "staging-layout",
    ]);
  });
});
