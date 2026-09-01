import { describe, expect, it } from "vitest";

import { fovToLegacyFocalLength, legacyFocalLengthToFov, lensByFov, LENS_BANK } from "./lens-bank";

describe("FOV compatibility helpers", () => {
  it("exposes the ten canonical FOV presets, including 12° long tele", () => {
    expect(LENS_BANK.map((preset) => preset.fov)).toEqual([180, 135, 107, 84, 63, 47, 29, 18, 12, 8]);
    expect(lensByFov(12)?.id).toBe("12-long-tele");
  });

  it("maps legacy mm values to the nearest observable lens language", () => {
    expect(legacyFocalLengthToFov("24mm")).toBe(84);
    expect(legacyFocalLengthToFov("50mm")).toBe(47);
    expect(legacyFocalLengthToFov("85mm")).toBe(18);
    expect(legacyFocalLengthToFov("200mm")).toBe(12);
    expect(lensByFov(84)?.id).toBe("84-wide");
  });

  it("keeps old Shot.lens values available only as compatibility output", () => {
    expect(fovToLegacyFocalLength(107)).toBe("24mm");
    expect(fovToLegacyFocalLength(47)).toBe("50mm");
    expect(fovToLegacyFocalLength(12)).toBe("200mm");
    expect(fovToLegacyFocalLength()).toBe("50mm");
  });
});
