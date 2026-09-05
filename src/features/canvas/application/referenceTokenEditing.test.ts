import { describe, expect, it } from "vitest";

import { findReferenceTokens, remapImageReferenceTokens } from "./referenceTokenEditing";

describe("cinematic prompt reference tokens", () => {
  it("recognizes Seedance @audioN references alongside existing editor tokens", () => {
    expect(findReferenceTokens("@loc [image1]；声音 @audio1；旧声音 [audio1]；@图2", 2, 1)).toEqual([
      { start: 5, end: 13, token: "[image1]", value: 1, kind: "image" },
      { start: 17, end: 24, token: "@audio1", value: 1, kind: "audio" },
      { start: 29, end: 37, token: "[audio1]", value: 1, kind: "audio" },
      { start: 38, end: 41, token: "@图2", value: 2, kind: "image" },
    ]);
  });

  it("remaps surviving image references after a middle upstream image disconnects", () => {
    const prompt = "保留 @图1，断开的 @图2，继续使用 [image3]。";

    expect(remapImageReferenceTokens(
      prompt,
      ["image-a", "image-b", "image-c"],
      ["image-a", "image-c"],
    )).toBe("保留 @图1，断开的 ，继续使用 [image2]。");
  });
});
