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

  it("upgrades existing assets with project code, base state and stable reference tag", () => {
    const project = {
      schemaVersion: 2,
      title: "Cully Hill Boys",
      assets: [{ id: "kel", kind: "character", name: "Kel", description: "teenage boy", referencePaths: [], lockLevel: "none", tags: [] }],
      scenes: [],
    } as unknown as ProjectV2;
    const migrated = migrateProject(project);
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.projectCode).toBe("cully-hill-boys");
    expect(migrated.assets![0]).toMatchObject({
      variantGroupId: "kel",
      baseAssetId: "kel",
      stateName: "base",
      version: 1,
      referenceTag: "char_cully-hill-boys_kel_base_v1",
    });
  });
});
