import { describe, expect, it } from "vitest";

import type { ProjectV2 } from "../shared-types";
import { migrateProject } from "./model";

describe("project optics migration", () => {
  it("adds FOV optics to an existing schema-v2 shot that only has mm", () => {
    const project = {
      schemaVersion: 2,
      assets: [],
      scenes: [{ id: "scene-1", shots: [{ id: "shot-1", lens: "35mm" }] }],
    } as unknown as ProjectV2;
    const migrated = migrateProject(project);
    expect(migrated.scenes[0].shots[0].optics).toEqual({ lensCharacter: "47-standard", fieldOfViewDegrees: 47 });
  });
});
