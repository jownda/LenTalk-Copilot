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
});
