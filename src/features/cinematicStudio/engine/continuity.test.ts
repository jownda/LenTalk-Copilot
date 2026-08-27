import { describe, expect, it } from "vitest";

import type { ProjectV2, SceneV2 } from "../shared-types";
import { checkSpatial, checkTechnical } from "./continuity";

const makeScene = (shot: SceneV2["shots"][number]): SceneV2 => ({
  id: "scene-1", name: "Test", logline: "", location: "", time: "", weather: "Night", duration: "5s",
  palette: "", lighting: "", environmentLock: true, shots: [shot],
});

const project: ProjectV2 = {
  id: "project-1", title: "Test", description: "", preset: "custom", scenes: [], characters: [], assets: [],
};

describe("FOV continuity gate", () => {
  it("treats a recognized legacy mm value as a compatibility FOV", () => {
    const scene = makeScene({ id: "shot-1", label: "1", duration: "5s", framing: "Medium", lens: "50mm", lensModel: "cooke-s7i", movement: "Static", action: "wait", acting: "still", direction: "left-to-right" });
    expect(checkTechnical(project, scene).some((issue) => issue.code === "OPTICS.DUAL_TRACK_CONFLICT")).toBe(false);
  });

  it("blocks a brand-only lens declaration without an observable FOV", () => {
    const scene = makeScene({ id: "shot-1", label: "1", duration: "5s", framing: "Medium", lens: "custom", lensModel: "cooke-s7i", movement: "Static", action: "wait", acting: "still", direction: "left-to-right" });
    const issue = checkTechnical(project, scene).find((item) => item.code === "OPTICS.DUAL_TRACK_CONFLICT");
    expect(issue?.severity).toBe("error");
  });
});

describe("spatial direction gate", () => {
  it("blocks a camera move that contradicts an explicitly placed target", () => {
    const scene = makeScene({
      id: "shot-1", label: "1", duration: "5s", framing: "Medium", lens: "50mm", movement: "Tracking", action: "镜头向右移到黛莲。", acting: "still", direction: "left-to-right",
      participants: [{ characterId: "dailian", role: "primary", position: "screen-left" }],
    });
    const withAsset = { ...project, assets: [{
      id: "dailian", kind: "character" as const, name: "黛莲", description: "", referencePaths: [], lockLevel: "none" as const, tags: [],
    }] };

    const issue = checkSpatial(withAsset, scene).find((item) => item.code === "SPATIAL.TARGET_DIRECTION_CONFLICT");
    expect(issue?.severity).toBe("error");
    expect(issue?.detailZh).toContain("镜头动作");
  });

  it("does not infer a direction conflict when the target has no known screen side", () => {
    const scene = makeScene({
      id: "shot-1", label: "1", duration: "5s", framing: "Medium", lens: "50mm", movement: "Tracking", action: "镜头向右移到黛莲。", acting: "still", direction: "left-to-right",
      participants: [{ characterId: "dailian", role: "primary", position: "center" }],
    });
    const withAsset = { ...project, assets: [{
      id: "dailian", kind: "character" as const, name: "黛莲", description: "", referencePaths: [], lockLevel: "none" as const, tags: [],
    }] };

    expect(checkSpatial(withAsset, scene).some((item) => item.code === "SPATIAL.TARGET_DIRECTION_CONFLICT")).toBe(false);
  });
});
