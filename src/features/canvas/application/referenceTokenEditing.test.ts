import { describe, expect, it } from "vitest";

import {
  findReferenceTokens,
  remapImageReferenceTokens,
  shouldPruneReferenceTokens,
} from "./referenceTokenEditing";

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

describe("shouldPruneReferenceTokens", () => {
  it("参考图变少（上游断连）时才清理越界标记", () => {
    expect(shouldPruneReferenceTokens(6, 4)).toBe(true);
    expect(shouldPruneReferenceTokens(1, 0)).toBe(true);
  });

  it("图片后接、提示词先到时不清理（否则 [imageN] 会被整段删掉）", () => {
    // 真机时序：提示词工作室先把成品写进节点，参考图还在异步解析，数量短暂为 0。
    expect(shouldPruneReferenceTokens(0, 6)).toBe(false);
    // 数量不变（含重排）也不该清理，重编号交给 remap。
    expect(shouldPruneReferenceTokens(6, 6)).toBe(false);
  });
});
