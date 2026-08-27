import { describe, expect, it } from "vitest";

import { mergeMediaReferenceSources } from "./mediaReferenceSources";

describe("mergeMediaReferenceSources", () => {
  it("keeps direct cinematic attachments before matching graph inputs and removes duplicates", () => {
    expect(mergeMediaReferenceSources(
      [" location.png ", "character.png"],
      ["character.png", "prop.png", ""],
      [undefined, 42] as unknown[],
    )).toEqual(["location.png", "character.png", "prop.png"]);
  });
});
