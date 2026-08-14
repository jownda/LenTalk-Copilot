import { describe, expect, it } from "vitest";
import {
  normalizeBodyType,
  getBodyPreset,
  getGroundedLabelY,
  CHARACTER_BODY_PRESETS,
  DEFAULT_CHARACTER_BODY_TYPE,
} from "./bodyTypes";

describe("normalizeBodyType", () => {
  it("returns valid body types unchanged", () => {
    expect(normalizeBodyType("mannequin")).toBe("mannequin");
    expect(normalizeBodyType("female")).toBe("female");
    expect(normalizeBodyType("broad")).toBe("broad");
    expect(normalizeBodyType("chibi")).toBe("chibi");
  });

  it("falls back to default for invalid values", () => {
    expect(normalizeBodyType("invalid")).toBe(DEFAULT_CHARACTER_BODY_TYPE);
    expect(normalizeBodyType(null)).toBe(DEFAULT_CHARACTER_BODY_TYPE);
    expect(normalizeBodyType(undefined)).toBe(DEFAULT_CHARACTER_BODY_TYPE);
    expect(normalizeBodyType("")).toBe(DEFAULT_CHARACTER_BODY_TYPE);
  });
});

describe("getBodyPreset", () => {
  it("returns correct preset for each body type", () => {
    for (const preset of CHARACTER_BODY_PRESETS) {
      const result = getBodyPreset(preset.bodyType);
      expect(result.bodyType).toBe(preset.bodyType);
      expect(result.label).toBeDefined();
      expect(result.proportions.hipY).toBeGreaterThan(0);
    }
  });

  it("falls back to first preset for invalid input", () => {
    const result = getBodyPreset("nonexistent");
    expect(result.bodyType).toBe(CHARACTER_BODY_PRESETS[0].bodyType);
  });
});

describe("getGroundedLabelY", () => {
  it("returns a positive number for all body types", () => {
    for (const preset of CHARACTER_BODY_PRESETS) {
      const y = getGroundedLabelY(preset.bodyType);
      expect(y).toBeGreaterThan(0);
      expect(Number.isFinite(y)).toBe(true);
    }
  });

  it("taller body types have larger label Y than shorter ones", () => {
    // mannequin is taller than child
    expect(getGroundedLabelY("mannequin")).toBeGreaterThan(getGroundedLabelY("child"));
    // child is taller than chibi
    expect(getGroundedLabelY("child")).toBeGreaterThan(getGroundedLabelY("chibi"));
  });
});
