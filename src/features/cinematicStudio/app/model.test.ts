import { describe, expect, it } from "vitest";

import type { ProjectV2 } from "../shared-types";
import { migrateProject, seedProject } from "./model";

describe("project optics migration", () => {
  it("uses a neutral project seed instead of the old Rain Night demo", () => {
    expect(seedProject.title).toBe("未命名影片");
    expect(seedProject.description).toBe("");
    expect(seedProject.scenes[0].name).toBe("新场景");
    expect(seedProject.scenes[0].logline).toBe("");
  });

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

  it("preserves legacy scene staging as the initial character roster", () => {
    const project = {
      schemaVersion: 3,
      title: "Test",
      assets: [],
      scenes: [{ id: "scene-1", staging: { characterOrder: ["hero", "support", "hero"] }, shots: [] }],
    } as unknown as ProjectV2;

    const migrated = migrateProject(project);

    expect(migrated.scenes[0].staging?.characterRoster).toEqual(["hero", "support"]);
    expect(migrated.scenes[0].staging?.characterOrder).toEqual(["hero", "support", "hero"]);
  });
});
