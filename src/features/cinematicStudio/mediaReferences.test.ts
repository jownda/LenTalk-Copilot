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

  it("inserts the staging reference after active assets and before first-frame-only images", () => {
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
      "hero-image", "staging-layout", "first-frame-a", "first-frame-b",
    ]);
  });
});
