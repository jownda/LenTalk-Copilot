import { describe, expect, it } from "vitest";

import type { ProjectV2 } from "../../shared-types";
import { projectReducer } from "./projectReducer";

const project: ProjectV2 = {
  id: "project-1",
  title: "Cully Hill Boys",
  projectCode: "cb",
  description: "",
  preset: "custom",
  characters: [],
  scenes: [],
  assets: [{
    id: "kel",
    kind: "character",
    name: "Kel",
    description: "teenage boy",
    referencePaths: [],
    lockLevel: "none",
    tags: [],
    variantGroupId: "kel",
    baseAssetId: "kel",
    stateName: "base",
    version: 1,
    referenceTag: "char_cb_kel_base_v1",
  }],
};

describe("projectReducer asset naming", () => {
  it("updates the stable tag when the state or version changes", () => {
    const next = projectReducer(project, { type: "UPDATE_ASSET", id: "kel", patch: { stateName: "wet", version: 2 } });
    expect(next.assets?.[0].referenceTag).toBe("char_cb_kel_wet_v2");
  });

  it("recalculates all asset tags after changing the project code", () => {
    const next = projectReducer(project, { type: "PATCH_PROJECT", patch: { projectCode: "CHB" } });
    expect(next.assets?.[0].referenceTag).toBe("char_chb_kel_base_v1");
  });

  it("creates an independent state card with inherited base description and a new version", () => {
    const next = projectReducer(project, { type: "CREATE_ASSET_VARIANT", sourceId: "kel", id: "kel-wet", stateName: "wet" });
    expect(next.assets?.[1]).toMatchObject({
      id: "kel-wet", variantGroupId: "kel", baseAssetId: "kel", stateName: "wet", version: 2,
      baseDescription: "teenage boy", description: "", stressTestStatus: "untested",
      referenceTag: "char_cb_kel_wet_v2",
    });
  });

  it("links and unlinks a prop from a character", () => {
    const linked = projectReducer(project, { type: "SET_PROP_CHARACTER_LINK", propId: "lighter", characterId: "kel", linked: true });
    expect(linked.assets?.[0].attachedPropIds).toEqual(["lighter"]);
    const unlinked = projectReducer(linked, { type: "SET_PROP_CHARACTER_LINK", propId: "lighter", characterId: "kel", linked: false });
    expect(unlinked.assets?.[0].attachedPropIds).toEqual([]);
  });

  it("cleans a deleted character from the roster and scene-level spatial order", () => {
    const state = {
      ...project,
      scenes: [{
        id: "scene-1", name: "Test", logline: "", location: "", time: "", weather: "", duration: "5秒",
        palette: "", lighting: "", environmentLock: false,
        staging: { characterRoster: ["kel"], characterOrder: ["kel"] },
        shots: [],
      }],
    } as ProjectV2;

    const next = projectReducer(state, { type: "DELETE_ASSET", id: "kel" });

    expect(next.scenes[0].staging?.characterRoster).toEqual([]);
    expect(next.scenes[0].staging?.characterOrder).toEqual([]);
  });

  it("keeps final audit records in newest-first project change history", () => {
    const first = projectReducer(project, { type: "RECORD_FINAL_AUDIT", record: {
      id: "audit-1", createdAt: "2026-08-27T01:00:00.000Z", sceneId: "scene-1", status: "passed", automaticFixes: [], issues: [],
    } });
    const next = projectReducer(first, { type: "RECORD_FINAL_AUDIT", record: {
      id: "audit-2", createdAt: "2026-08-27T02:00:00.000Z", sceneId: "scene-1", status: "blocked", automaticFixes: [], issues: [],
    } });
    expect(next.finalAuditLog?.map((record) => record.id)).toEqual(["audit-2", "audit-1"]);
  });
});
