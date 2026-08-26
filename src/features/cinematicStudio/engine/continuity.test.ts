import { describe, expect, it } from "vitest";

import type { ProjectV2, SceneV2 } from "../shared-types";
import { checkTechnical } from "./continuity";

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
