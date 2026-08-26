import { describe, expect, it } from "vitest";

import type { Asset, ProjectV2, SceneV2 } from "../../shared-types";
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

    expect(output).toContain(storedLayers.sceneContext);
    expect(output).toContain(storedLayers.formatMode);
    expect(output).toContain(storedLayers.negativeLocks);
    expect(output).toContain("STRUCTURED SHOT INSPECTOR:");
    expect(output).toContain("SHOT 镜头 1");
    expect(output.indexOf(storedLayers.formatMode)).toBeLessThan(output.indexOf("STRUCTURED SHOT INSPECTOR:"));
    expect(output.indexOf("STRUCTURED SHOT INSPECTOR:")).toBeLessThan(output.indexOf(storedLayers.negativeLocks));
  });

  it("无 error 时把检查器的活动引用、节拍、表演与声音锁追加到最终提示词", () => {
    const actor: Asset = {
      id: "actor-1",
      kind: "character",
      name: "林警官",
      description: "middle-aged man",
      descriptionZh: "中年男性",
      referencePaths: [],
      lockLevel: "none",
      tags: [],
      actingProfile: { voicePromptZh: "低沉克制，压力下呼吸加重。" },
    };
    const scene = makeScene({
      directorLayers: {
        sceneContext: "SCENE CONTEXT:\nAI scene prose.",
        formatMode: "FORMAT MODE:\nSINGLE CONTINUOUS TAKE.",
        actionTiming: "ACTION TIMING:\nAI timing reference.",
      },
      shots: [{
        ...makeScene().shots[0],
        participants: [{ characterId: actor.id, role: "primary", position: "center" }],
        optics: { fieldOfViewDegrees: 84 },
        beats: [{
          id: "beat-1",
          order: 1,
          duration: 2,
          verb: "speak",
          actorId: actor.id,
          actionText: "抬眼并压低声音",
          dialogue: "我听见了。",
          required: true,
        }],
        acting: "先压住怒意，再让恐惧从眼神里露出来。",
        eyeLife: "眼睛先于头部转向声源，眨眼变慢。",
        performanceLevel: 4,
      }],
    });
    const project = makeProject(scene);
    project.assets = [actor];
    const output = compileDirectorSequence(project, scene, { locale: "zh", syntax: "at-mention" });

    expect(output).toContain("镜头结构化检查器：");
    expect(output).toContain("镜头活动引用：");
    expect(output).toContain("@林警官");
    expect(output).toContain("视场角 84°");
    expect(output).toContain("抬眼并压低声音");
    expect(output).toContain("表演评分：4");
    expect(output).toContain("对白：\"我听见了。\"");
    expect(output).toContain("声音锁（林警官）：低沉克制，压力下呼吸加重。");
    expect(output.indexOf("AI timing reference.")).toBeLessThan(output.indexOf("抬眼并压低声音"));
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
