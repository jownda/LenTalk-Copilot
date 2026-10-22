import { describe, expect, it } from "vitest";

import { promptLexicon } from "../engine/i18n/lexicon";
import {
  CAMERA_MOVEMENT_GROUP_ORDER,
  CAMERA_MOVEMENT_IDS,
  CAMERA_MOVEMENT_PRESETS,
  cameraMovementGroupedOptions,
  cameraMovementHint,
  cameraMovementLabel,
  cameraMovementSelectGroups,
  cameraMovementVocab,
  normalizeCameraMovement,
} from "./cameraMovements";

describe("camera movement presets", () => {
  it("ids are unique and every preset carries zh/en labels plus a scene hint", () => {
    expect(new Set(CAMERA_MOVEMENT_IDS).size).toBe(CAMERA_MOVEMENT_IDS.length);
    for (const preset of CAMERA_MOVEMENT_PRESETS) {
      expect(preset.zh.trim()).not.toBe("");
      expect(preset.en.trim()).not.toBe("");
      expect(preset.sceneZh.trim().length).toBeGreaterThan(8);
      expect(preset.sceneEn.trim().length).toBeGreaterThan(8);
      expect(CAMERA_MOVEMENT_GROUP_ORDER).toContain(preset.group);
    }
  });

  it("covers the movement scenarios the inspector must offer", () => {
    for (const id of [
      "Static", "Pan", "Tilt", "Push-in", "Pull-out", "Trucking", "Tracking", "Dolly", "Crane",
      "Arc", "Orbit", "Zoom", "Handheld", "Steadicam", "Gimbal", "Drone", "Cable cam",
      "Vehicle", "Robot arm", "Snorricam", "POV", "OTS", "Reverse tracking",
      "Whip-pan", "Dolly zoom", "Snap zoom",
    ]) {
      expect(CAMERA_MOVEMENT_IDS).toContain(id);
    }
  });

  it("grouped options flatten back to the preset order", () => {
    for (const locale of ["zh", "en"] as const) {
      const groups = cameraMovementGroupedOptions(locale);
      expect(groups.map((group) => group.label)).toHaveLength(CAMERA_MOVEMENT_GROUP_ORDER.length);
      expect(groups.flatMap((group) => group.values)).toEqual(CAMERA_MOVEMENT_IDS);
    }
  });

  it("keeps legacy free-text movement visible in its own group", () => {
    const known = cameraMovementSelectGroups("Push-in", "zh");
    expect(known.flatMap((group) => group.values)).toEqual(CAMERA_MOVEMENT_IDS);

    const custom = cameraMovementSelectGroups("手持绕轴旋转", "zh");
    expect(custom[0]).toEqual({ label: "当前值", values: ["手持绕轴旋转"] });
    expect(custom.flatMap((group) => group.values)).toContain("Push-in");
  });

  it("labels and hints resolve by locale and fall back to raw text", () => {
    expect(cameraMovementLabel("Dolly zoom", "zh")).toBe("推拉变焦");
    expect(cameraMovementLabel("Dolly zoom", "en")).toBe("Dolly zoom");
    expect(cameraMovementLabel("custom-move", "zh")).toBe("custom-move");
    expect(cameraMovementLabel(undefined, "zh")).toBe("");

    const preset = CAMERA_MOVEMENT_PRESETS.find((item) => item.id === "Whip-pan");
    expect(cameraMovementHint("Whip-pan", "zh")).toBe(`适用场景：${preset?.sceneZh}`);
    expect(cameraMovementHint("Whip-pan", "en")).toBe(`Best for: ${preset?.sceneEn}`);
    expect(cameraMovementHint("custom-move", "zh")).toContain("自定义");
    expect(cameraMovementHint(undefined, "zh")).toBe("");
  });

  it("AI vocabulary lists every preset id", () => {
    const vocab = cameraMovementVocab();
    for (const id of CAMERA_MOVEMENT_IDS) expect(vocab).toContain(id);
  });
});

describe("normalizeCameraMovement", () => {
  it("canonicalises case, spacing, separators and synonyms", () => {
    expect(normalizeCameraMovement("dolly zoom")).toBe("Dolly zoom");
    expect(normalizeCameraMovement("DOLLY-ZOOM")).toBe("Dolly zoom");
    expect(normalizeCameraMovement("dolly_in")).toBe("Push-in");
    expect(normalizeCameraMovement("pull back")).toBe("Pull-out");
    expect(normalizeCameraMovement("over-the-shoulder")).toBe("OTS");
    expect(normalizeCameraMovement("first person")).toBe("POV");
    expect(normalizeCameraMovement("vertigo")).toBe("Dolly zoom");
    expect(normalizeCameraMovement("crane")).toBe("Crane");
  });

  it("passes through Chinese synonyms and unknown free text", () => {
    expect(normalizeCameraMovement("推近")).toBe("Push-in");
    expect(normalizeCameraMovement(" 贴身固定 ")).toBe("Snorricam");
    expect(normalizeCameraMovement("滑板跟拍")).toBe("滑板跟拍");
    expect(normalizeCameraMovement("")).toBeUndefined();
    expect(normalizeCameraMovement(undefined)).toBeUndefined();
  });
});

describe("movement lexicon coverage", () => {
  // 界面给得出、但编译成中文提示词后仍是英文的旧值（刻意保留，见 lexicon 注释）。
  const INTENTIONAL_PASSTHROUGH = new Set(["POV", "OTS", "Steadicam"]);

  it("every new movement preset has a Chinese prompt entry", () => {
    const zhValues = promptLexicon("zh").values;
    for (const preset of CAMERA_MOVEMENT_PRESETS) {
      if (INTENTIONAL_PASSTHROUGH.has(preset.id)) continue;
      expect(zhValues[preset.id], `缺少中文词典条目: ${preset.id}`).toBeDefined();
    }
  });
});
