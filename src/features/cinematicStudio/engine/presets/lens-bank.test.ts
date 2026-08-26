import { describe, expect, it } from "vitest";

import { fovToLegacyFocalLength, legacyFocalLengthToFov, lensByFov } from "./lens-bank";

describe("FOV compatibility helpers", () => {
  it("maps legacy mm values to the nearest observable lens language", () => {
    expect(legacyFocalLengthToFov("24mm")).toBe(84);
    expect(legacyFocalLengthToFov("50mm")).toBe(47);
    expect(legacyFocalLengthToFov("85mm")).toBe(18);
    expect(lensByFov(84)?.id).toBe("84-wide");
  });

  it("keeps old Shot.lens values available only as compatibility output", () => {
    expect(fovToLegacyFocalLength(107)).toBe("24mm");
    expect(fovToLegacyFocalLength(47)).toBe("50mm");
    expect(fovToLegacyFocalLength()).toBe("50mm");
  });
});
