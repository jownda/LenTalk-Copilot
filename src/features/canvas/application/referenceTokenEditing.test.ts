import { describe, expect, it } from "vitest";

import { findReferenceTokens } from "./referenceTokenEditing";

describe("cinematic prompt reference tokens", () => {
  it("recognizes compiler [imageN] and [audioN] tokens alongside editor tokens", () => {
    expect(findReferenceTokens("@loc [image1]；声音 [audio1]；@图2", 2, 1)).toEqual([
      { start: 5, end: 13, token: "[image1]", value: 1, kind: "image" },
      { start: 17, end: 25, token: "[audio1]", value: 1, kind: "audio" },
      { start: 26, end: 29, token: "@图2", value: 2, kind: "image" },
    ]);
  });
});
