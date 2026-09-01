import { describe, expect, it } from "vitest";

import type { ProjectV2, SceneV2 } from "../shared-types";
import { checkActing, checkAudio, checkIdentity, checkSpatial, checkTechnical } from "./continuity";

const makeScene = (shot: SceneV2["shots"][number]): SceneV2 => ({
  id: "scene-1", name: "Test", logline: "", location: "", time: "", weather: "Night", duration: "5s",
  palette: "", lighting: "", environmentLock: true, shots: [shot],
});

const project: ProjectV2 = {
  id: "project-1", title: "Test", description: "", preset: "custom", scenes: [], characters: [], assets: [],
};

describe("FOV continuity gate", () => {
  it("treats a recognized legacy mm value as a compatibility FOV", () => {
    const scene = makeScene({ id: "shot-1", label: "1", duration: "5s", framing: "Medium", lens: "50mm", lensModel: "cooke-s7i", movement: "Static", action: "wait", acting: "still", direction: "left-to-right" });
    expect(checkTechnical(project, scene).some((issue) => issue.code === "OPTICS.DUAL_TRACK_CONFLICT")).toBe(false);
  });

  it("blocks a brand-only lens declaration without an observable FOV", () => {
    const scene = makeScene({ id: "shot-1", label: "1", duration: "5s", framing: "Medium", lens: "custom", lensModel: "cooke-s7i", movement: "Static", action: "wait", acting: "still", direction: "left-to-right" });
    const issue = checkTechnical(project, scene).find((item) => item.code === "OPTICS.DUAL_TRACK_CONFLICT");
    expect(issue?.severity).toBe("error");
  });
});

describe("identity continuity gate", () => {
  it("does not require a strict-locked character to appear in every scene", () => {
    const scene = makeScene({ id: "shot-1", label: "1", duration: "5s", framing: "Medium", lens: "50mm", movement: "Static", action: "wait", acting: "still", direction: "left-to-right" });
    const withStrictCharacter = {
      ...project,
      assets: [{ id: "qiqi", kind: "character" as const, name: "琪琪", description: "", referencePaths: [], lockLevel: "strict" as const, tags: [] }],
    };

    expect(checkIdentity(withStrictCharacter, scene).some((issue) => issue.code === "IDENTITY.STRICT_NOT_REFERENCED")).toBe(false);
  });
});

describe("spatial direction gate", () => {
  it("blocks a camera move that contradicts an explicitly placed target", () => {
    const scene = makeScene({
      id: "shot-1", label: "1", duration: "5s", framing: "Medium", lens: "50mm", movement: "Tracking", action: "镜头向右移到黛莲。", acting: "still", direction: "left-to-right",
      participants: [{ characterId: "dailian", role: "primary", position: "screen-left" }],
    });
    const withAsset = { ...project, assets: [{
      id: "dailian", kind: "character" as const, name: "黛莲", description: "", referencePaths: [], lockLevel: "none" as const, tags: [],
    }] };

    const issue = checkSpatial(withAsset, scene).find((item) => item.code === "SPATIAL.TARGET_DIRECTION_CONFLICT");
    expect(issue?.severity).toBe("error");
    expect(issue?.detailZh).toContain("镜头动作");
  });

  it("does not infer a direction conflict when the target has no known screen side", () => {
    const scene = makeScene({
      id: "shot-1", label: "1", duration: "5s", framing: "Medium", lens: "50mm", movement: "Tracking", action: "镜头向右移到黛莲。", acting: "still", direction: "left-to-right",
      participants: [{ characterId: "dailian", role: "primary", position: "center" }],
    });
    const withAsset = { ...project, assets: [{
      id: "dailian", kind: "character" as const, name: "黛莲", description: "", referencePaths: [], lockLevel: "none" as const, tags: [],
    }] };

    expect(checkSpatial(withAsset, scene).some((item) => item.code === "SPATIAL.TARGET_DIRECTION_CONFLICT")).toBe(false);
  });
});

describe("cross-shot spatial inheritance gate", () => {
  const characters = [
    { id: "a", kind: "character" as const, name: "甲", description: "", referencePaths: [], lockLevel: "none" as const, tags: [] },
    { id: "b", kind: "character" as const, name: "乙", description: "", referencePaths: [], lockLevel: "none" as const, tags: [] },
  ];
  const shot = (id: string, participants: SceneV2["shots"][number]["participants"], extra: Partial<SceneV2["shots"][number]> = {}): SceneV2["shots"][number] => ({
    id, label: id, duration: "5s", framing: "Medium", lens: "50mm", movement: "Static", action: "保持位置", acting: "克制", direction: "left-to-right" as const,
    participants, ...extra,
  });
  const sceneWith = (shots: SceneV2["shots"]): SceneV2 => ({
    id: "scene-1", name: "Test", logline: "", location: "", time: "", weather: "Night", duration: "10s",
    palette: "", lighting: "", environmentLock: true, staging: { characterOrder: ["a", "b"] }, shots,
  });
  const withCharacters = (scene: SceneV2): ProjectV2 => ({ ...project, assets: characters, scenes: [scene] });

  it("detects a character jumping from screen-left to screen-right", () => {
    const scene = sceneWith([
      shot("1", [{ characterId: "a", role: "primary", position: "screen-left" }]),
      shot("2", [{ characterId: "a", role: "primary", position: "screen-right" }]),
    ]);
    expect(checkSpatial(withCharacters(scene), scene).some((issue) => issue.code === "SPATIAL.POSITION_JUMP")).toBe(true);
  });

  it("detects an unmarked re-entry after an explicit exit", () => {
    const scene = sceneWith([
      shot("1", [{ characterId: "a", role: "primary", position: "screen-left" }], { action: "甲走出画面" }),
      shot("2", [{ characterId: "a", role: "primary", position: "screen-left" }]),
    ]);
    expect(checkSpatial(withCharacters(scene), scene).some((issue) => issue.code === "SPATIAL.REENTRY_UNMARKED")).toBe(true);
  });

  it("detects an entrance direction that disagrees with the first position", () => {
    const scene = sceneWith([
      shot("1", []),
      shot("2", [{ characterId: "a", role: "primary", position: "screen-right", entrance: "enters-left" }]),
    ]);
    const issue = checkSpatial(withCharacters(scene), scene).find((item) => item.code === "SPATIAL.ENTRANCE_POSITION_CONFLICT");
    expect(issue?.severity).toBe("error");
  });

  it("detects a reversed shared character order", () => {
    const scene = sceneWith([
      shot("1", [{ characterId: "a", role: "primary" }, { characterId: "b", role: "supporting" }], { layout: { characterOrder: ["a", "b"] } }),
      shot("2", [{ characterId: "a", role: "primary" }, { characterId: "b", role: "supporting" }], { layout: { characterOrder: ["b", "a"] } }),
    ]);
    expect(checkSpatial(withCharacters(scene), scene).some((issue) => issue.code === "SPATIAL.ORDER_JUMP")).toBe(true);
  });
});

describe("audio continuity gate", () => {
  it("does not require subtitles when a scene contains dialogue", () => {
    const scene = makeScene({
      id: "shot-1", label: "1", duration: "5s", framing: "Medium", lens: "50mm", movement: "Static", action: "wait", acting: "still", direction: "left-to-right",
      beats: [{ id: "beat-1", order: 1, actorId: "qiqi", verb: "说", dialogue: "你好。" }],
    });
    const withSubtitlesOff = { ...project, audioPlan: { score: "none" as const, subtitles: false } };

    expect(checkAudio(withSubtitlesOff, scene).some((issue) => issue.code === "AUDIO.DIALOGUE_UNSUBTITLED")).toBe(false);
  });
});

describe("acting master profile gate", () => {
  const actingScene = makeScene({
    id: "shot-1", label: "1", duration: "5s", framing: "Medium", lens: "50mm", movement: "Static", action: "wait", acting: "", direction: "left-to-right",
  });

  const withActingProfile = (masterProfileZh: string): ProjectV2 => ({
    ...project,
    assets: [{
      id: "qiqi", kind: "character", name: "琪琪", description: "", referencePaths: [], lockLevel: "none", tags: [],
      actingProfile: { masterProfileZh },
    }],
  });

  it("accepts a compact trigger type and a fully unpacked gait", () => {
    const master = [
      "身体传记：26岁，身形纤细，肩膀略向前，旧伤让她站立时右侧略收。",
      "可观察行为：紧张时先吞咽，呼吸变浅，指尖短暂收紧。",
      "声线与说话动作：低声、短句，压力下语速加快。",
      "习惯/抽动：闲聊时用拇指摩擦指节，借此伪装自信。",
      "命名步态：“逆风步”，重心压低，步幅短，躯干微向前，手臂贴近身体，头部保持水平。",
      "面具 + 裂缝：平时冷静克制；压力下，下唇短暂颤动，随后恢复平静。",
      "软化目标：妹妹。",
    ].join("\n");
    const codes = checkActing(withActingProfile(master), actingScene).map((issue) => issue.code);

    expect(codes).not.toContain("ACTING.MASK_NO_CRACK");
    expect(codes).not.toContain("ACTING.TIC_NO_TRIGGER");
    expect(codes).not.toContain("ACTING.INNER_STATE_UNGROUNDED");
    expect(codes).not.toContain("ACTING.BODY_BIOGRAPHY_MISSING");
    expect(codes).not.toContain("ACTING.GAIT_UNPACKED");
  });

  it("checks a tic trigger on the same line instead of using a trigger elsewhere", () => {
    const master = [
      "身体传记：成年男性，肩膀紧绷，旧伤让他站姿偏向左侧。",
      "命名步态：“沉船步”，重心偏左，步幅拖长，躯干后仰，手臂低垂，头部微低。",
      "面具 + 裂缝：平时镇定；然而，当失去控制时——呼吸骤停，手指收紧。",
      "习惯/抽动：下意识抖腿，伪装自信。",
    ].join("\n");
    const codes = checkActing(withActingProfile(master), actingScene).map((issue) => issue.code);

    expect(codes).toContain("ACTING.TIC_NO_TRIGGER");
  });

  it("does not require a named, fully unpacked gait", () => {
    const master = [
      "身体传记：成年男性，肩膀紧绷，旧伤让他站姿偏向左侧。",
      "可观察行为：紧张时先吞咽，呼吸变浅。",
      "面具 + 裂缝：平时镇定；然而，当失去控制时——手指收紧。",
    ].join("\n");
    const codes = checkActing(withActingProfile(master), actingScene).map((issue) => issue.code);

    expect(codes).not.toContain("ACTING.GAIT_UNPACKED");
  });

  it("does not require a mask-and-crack clause", () => {
    const master = "身体传记：成年女性，体型结实，姿态挺直，职业训练让她保持纪律感。";
    const codes = checkActing(withActingProfile(master), actingScene).map((issue) => issue.code);

    expect(codes).not.toContain("ACTING.MASK_NO_CRACK");
  });

  it("flags an emotion that has no observable body marker", () => {
    const master = [
      "身体传记：成年女性，体型结实，姿态挺直，职业训练让她保持纪律感。",
      "心理引擎：她很紧张。",
      "命名步态：“阅兵步”，重心稳定，步幅均匀，躯干挺直，手臂贴身，头部不动。",
      "面具 + 裂缝：平时冷静；当受到质疑时——手指收紧。",
    ].join("\n");

    expect(checkActing(withActingProfile(master), actingScene).some((issue) => issue.code === "ACTING.INNER_STATE_UNGROUNDED")).toBe(true);
  });
});
