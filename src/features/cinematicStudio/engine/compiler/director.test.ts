import { describe, expect, it } from "vitest";

import type { ProjectV2, SceneV2 } from "../../shared-types";
import { compileDirectorSequence } from "./director";

function makeScene(overrides: Partial<SceneV2> = {}): SceneV2 {
  return {
    id: "scene-1",
    name: "测试场景",
    logline: "角色在车厢中等待。",
    location: "地铁车厢",
    time: "夜晚",
    weather: "晴",
    duration: "5秒",
    palette: "冷白",
    lighting: "顶部灯光",
    environmentLock: true,
    shootingMode: "long-take",
    shots: [{
      id: "shot-1",
      label: "镜头 1",
      duration: "5秒",
      framing: "中景",
      lens: "35mm",
      movement: "Static",
      action: "角色保持坐姿",
      acting: "克制",
      direction: "left-to-right",
    }],
    ...overrides,
  };
}

function makeProject(scene: SceneV2): ProjectV2 {
  return {
    id: "project-1",
    title: "测试项目",
    description: "",
    preset: "custom",
    scenes: [scene],
    characters: [],
    assets: [],
  };
}

describe("compileDirectorSequence stored layer quality gate", () => {
  it("无 error 时按 canonical 层序输出 storedLayers", () => {
    const storedLayers = {
      sceneContext: "SCENE CONTEXT:\nStored scene text.",
      formatMode: "FORMAT MODE:\nSINGLE CONTINUOUS TAKE.",
      negativeLocks: "NEGATIVE LOCKS:\nNo watermark.",
    };
    const scene = makeScene({ directorLayers: storedLayers });
    const output = compileDirectorSequence(makeProject(scene), scene, { locale: "en" });

    expect(output).toBe([
      storedLayers.sceneContext,
      storedLayers.formatMode,
      storedLayers.negativeLocks,
    ].join("\n\n"));
  });

  it("error 级分层冲突时回退结构化编译，不透传错误 storedLayers", () => {
    const invalidLayers = {
      sceneContext: "SCENE CONTEXT:\nAI generated scene.",
      formatMode: "FORMAT MODE:\nCONTROLLED MULTI-SHOT SEQUENCE.",
      actionTiming: "ACTION TIMING:\n0:00-0:05: continuous action without shot blocks.",
    };
    const scene = makeScene({
      shootingMode: "multi-shot",
      directorLayers: invalidLayers,
    });
    const output = compileDirectorSequence(makeProject(scene), scene, { locale: "en" });

    expect(output).toContain("SCENE CONTEXT");
    expect(output).toContain("FORMAT MODE");
    expect(output).toContain("SHOT 镜头 1");
    expect(output).toContain("FOV 47°");
    expect(output).not.toContain("35mm");
    expect(output).not.toContain("AI generated scene.");
    expect(output).not.toContain("continuous action without shot blocks.");
  });
});
