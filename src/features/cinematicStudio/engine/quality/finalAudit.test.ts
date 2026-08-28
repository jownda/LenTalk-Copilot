import { describe, expect, it } from "vitest";

import type { SceneV2 } from "../../shared-types";
import { auditFinalPrompt, auditFinalPromptWithProject, createFinalPromptDocument, normalizeSceneShotTimeline } from "./finalAudit";

function makeScene(overrides: Partial<SceneV2> = {}): SceneV2 {
  return {
    id: "scene-1", name: "测试", logline: "", location: "车厢", time: "夜晚", weather: "雨", duration: "15秒",
    palette: "", lighting: "", environmentLock: true, shootingMode: "multi-shot",
    shots: [
      { id: "shot-1", label: "镜头 1", duration: "5秒", framing: "中景", lens: "35mm", movement: "Static", action: "说话", acting: "克制", direction: "left-to-right", time: { startSeconds: 0, endSeconds: 5 } },
      { id: "shot-2", label: "镜头 2", duration: "6秒", framing: "特写", lens: "50mm", movement: "Static", action: "反应", acting: "克制", direction: "left-to-right", time: { startSeconds: 0, endSeconds: 6 } },
    ],
    ...overrides,
  };
}

describe("final prompt audit", () => {
  it("将重置的镜头时间归一为连续总时间轴", () => {
    const timeline = normalizeSceneShotTimeline(makeScene());
    expect(timeline.get("shot-1")).toEqual({ startSeconds: 0, endSeconds: 5 });
    expect(timeline.get("shot-2")).toEqual({ startSeconds: 5, endSeconds: 11 });
    expect(auditFinalPrompt(makeScene()).issues.map((issue) => issue.code)).toContain("FINAL.TIMELINE_NORMALIZED");
    expect(auditFinalPrompt(makeScene()).adjustments.find((item) => item.code === "FINAL.TIMELINE_NORMALIZED")?.detail).toContain("->");
  });

  it("合并长镜头旧分段，并仅阻断真实的超时冲突", () => {
    const scene = makeScene({ shootingMode: "long-take", duration: "8秒" });
    const issues = auditFinalPrompt(scene).issues;
    expect(issues.find((issue) => issue.code === "FINAL.MODE_SHOT_CONFLICT")?.severity).toBe("warning");
    expect(issues.map((issue) => issue.code)).toContain("FINAL.DURATION_EXCEEDED");
  });

  it("记录多镜头缺失切点时采用的默认硬切", () => {
    const scene = makeScene({ shots: [
      { ...makeScene().shots[0], id: "shot-1", time: { startSeconds: 0, endSeconds: 5 }, cutStyle: "hard-cut" },
      { ...makeScene().shots[1], id: "shot-2", time: { startSeconds: 5, endSeconds: 11 }, cutStyle: undefined },
    ] });
    expect(auditFinalPrompt(scene).issues.map((issue) => issue.code)).toContain("FINAL.CUT_STYLE_DEFAULTED");
  });

  it("阻断窗外绝对黑与可见霓虹并存的事实冲突", () => {
    const scene = makeScene({
      logline: "车窗外是绝对的黑，没有任何建筑轮廓。",
      lighting: "窗外霓虹透过车窗照亮人物侧脸。",
    });
    expect(auditFinalPrompt(scene).issues.map((issue) => issue.code)).toContain("FINAL.WINDOW_LIGHT_FACT_CONFLICT");
  });

  it("要求窗外光源说明进入画面的路径", () => {
    const scene = makeScene({ lighting: "窗外霓虹照亮人物侧脸。" });
    expect(auditFinalPrompt(scene).issues.map((issue) => issue.code)).toContain("FINAL.EXTERIOR_LIGHT_PATH_MISSING");

    const explained = makeScene({ lighting: "窗外霓虹透过车窗照亮人物侧脸。" });
    expect(auditFinalPrompt(explained).issues.map((issue) => issue.code)).not.toContain("FINAL.EXTERIOR_LIGHT_PATH_MISSING");
  });

  it("规范与 FOV 相反的可见光学结果，并提示抽象表演", () => {
    const scene = makeScene({ shots: [{
      ...makeScene().shots[0],
      optics: { fieldOfViewDegrees: 84, lensOutcome: ["84° 广角带来压缩感"] },
      acting: "恐惧",
    }] });
    const audit = auditFinalPrompt(scene);
    expect(audit.issues.map((issue) => issue.code)).toContain("FINAL.OPTICS_TERMS_NORMALIZED");
    expect(audit.issues.map((issue) => issue.code)).toContain("FINAL.ABSTRACT_PERFORMANCE");
    expect(audit.adjustments[0]?.detailZh).toContain("规范");
  });

  it("对白角色没有声音锁时标明可定位的声音警告", () => {
    const scene = makeScene({ shots: [{
      ...makeScene().shots[0],
      beats: [{ id: "beat-1", order: 1, verb: "speak", actorId: "actor-1", dialogue: "我听见了" }],
    }] });
    const audit = auditFinalPromptWithProject(scene, [{ id: "actor-1", kind: "character" }]);
    const issue = audit.issues.find((item) => item.code === "FINAL.SPEAKER_VOICE_LOCK_MISSING");
    expect(issue?.shotId).toBe("shot-1");
    expect(issue?.field).toBe("voice");
  });

  it("缺少首帧锁或动作时给出可执行的审计操作", () => {
    const scene = makeScene({ shots: [{
      ...makeScene().shots[0], action: "", beats: [],
    }] });
    const issues = auditFinalPrompt(scene).issues;
    expect(issues.find((issue) => issue.code === "FINAL.FIRST_FRAME_MISSING")?.action).toBe("review-staging");
    expect(issues.find((issue) => issue.code === "FINAL.ACTION_BEATS_MISSING")?.action).toBe("review-action");
  });

  it("缺少场景上下文时给出第一段警告", () => {
    const issues = auditFinalPrompt(makeScene()).issues;
    const issue = issues.find((item) => item.code === "FINAL.SCENE_CONTEXT_MISSING");
    expect(issue?.severity).toBe("warning");
    expect(issue?.field).toBe("staging");
  });

  it("场景上下文包含前情/AI 说明时阻断导出并提示重写", () => {
    const scene = makeScene({ sceneContext: "前情提要：上集林sir追查列车；本集阿俊看向窗外。" });
    const issue = auditFinalPrompt(scene).issues.find((item) => item.code === "FINAL.SCENE_CONTEXT_META_LEAK");
    expect(issue?.severity).toBe("error");
  });

  it("场景上下文超过 3 个句子时给出压缩警告", () => {
    const scene = makeScene({ sceneContext: "阿俊擦开雾气。他看见窗外只有黑暗。琪琪抱紧公文包。黛莲压住托特包。列车还在行驶。" });
    const issue = auditFinalPrompt(scene).issues.find((item) => item.code === "FINAL.SCENE_CONTEXT_TOO_LONG");
    expect(issue?.severity).toBe("warning");
  });

  it("合规的场景上下文不触发任何场景上下文问题", () => {
    const scene = makeScene({ sceneContext: "阿俊坐在车厢中央，擦开雾气看向窗外，共 15 秒。" });
    const codes = auditFinalPrompt(scene).issues.map((issue) => issue.code);
    expect(codes).not.toContain("FINAL.SCENE_CONTEXT_MISSING");
    expect(codes).not.toContain("FINAL.SCENE_CONTEXT_META_LEAK");
    expect(codes).not.toContain("FINAL.SCENE_CONTEXT_TOO_LONG");
  });

  it("中间模型只保留最终导出需要的结构化镜头字段", () => {
    const scene = makeScene({ shots: [{
      ...makeScene().shots[0], performanceLevel: 5, note: "检查器备注", participants: [{ characterId: "actor-1", role: "primary" }],
      beats: [{ id: "beat-1", order: 1, verb: "speak", actorId: "actor-1", targetPropId: "prop-1", dialogue: "我听见了" }],
    }] });
    const document = createFinalPromptDocument(scene);
    expect(document.shots[0]).toMatchObject({ participantIds: ["actor-1"], speakerIds: ["actor-1"], propIds: ["prop-1"], hasVisibleAction: true });
    expect(document.shots[0]).not.toHaveProperty("performanceLevel");
    expect(document.shots[0]).not.toHaveProperty("note");
  });
});
