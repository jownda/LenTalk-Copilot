import { describe, expect, it } from "vitest";

import {
  MIN_CLIP_DURATION_SEC,
  buildTimelineTicks,
  buildVideoEditRequest,
  clampTrimRange,
  createFullTrimRange,
  createVideoEditState,
  formatTimecode,
  moveTrimHandle,
  pickNearestTrimHandle,
  ratioToSeconds,
  resolveAudioModeAfterTrackPick,
  resolveOutputDuration,
  resolveTimelineDuration,
  secondsToRatio,
  trimSelectionDuration,
  validateVideoEditState,
  type VideoEditState,
} from "./videoEdit";

function stateWith(overrides: Partial<VideoEditState> = {}): VideoEditState {
  return { ...createVideoEditState(10), ...overrides };
}

describe("裁剪区间", () => {
  it("默认覆盖整段视频", () => {
    expect(createFullTrimRange(12)).toEqual({ start: 0, end: 12 });
  });

  it("把越界区间收回 [0, duration]", () => {
    expect(clampTrimRange({ start: -3, end: 99 }, 8)).toEqual({ start: 0, end: 8 });
  });

  it("区间被压成 0 长度时重新撑到最小时长", () => {
    const range = clampTrimRange({ start: 5, end: 5 }, 8);
    expect(trimSelectionDuration(range)).toBeGreaterThanOrEqual(MIN_CLIP_DURATION_SEC);
    expect(range.end).toBeLessThanOrEqual(8);
  });

  it("时长未知时退回占位时长，仍能得到合法区间", () => {
    expect(resolveTimelineDuration(0)).toBeGreaterThan(0);
    const range = clampTrimRange({ start: 0, end: 0 }, 0);
    expect(range.end).toBeGreaterThan(0);
  });
});

describe("拖动手柄", () => {
  it("起点不会越过终点", () => {
    const range = moveTrimHandle("start", 9.99, { start: 1, end: 5 }, 10);
    expect(range.start).toBeCloseTo(5 - MIN_CLIP_DURATION_SEC, 6);
    expect(range.end).toBe(5);
  });

  it("终点不会越过起点", () => {
    const range = moveTrimHandle("end", 0, { start: 4, end: 8 }, 10);
    expect(range.start).toBe(4);
    expect(range.end).toBeCloseTo(4 + MIN_CLIP_DURATION_SEC, 6);
  });

  it("终点不会超出片长，起点不会为负", () => {
    expect(moveTrimHandle("end", 42, { start: 0, end: 8 }, 10).end).toBe(10);
    expect(moveTrimHandle("start", -5, { start: 1, end: 8 }, 10).start).toBe(0);
  });

  it("非法输入退回原值而不是 NaN", () => {
    const range = moveTrimHandle("end", Number.NaN, { start: 2, end: 6 }, 10);
    expect(Number.isFinite(range.end)).toBe(true);
    expect(range.end).toBe(2 + MIN_CLIP_DURATION_SEC);
  });
});

describe("就近吸附", () => {
  it("离哪个手柄近就抓哪个", () => {
    const range = { start: 1, end: 9 };
    expect(pickNearestTrimHandle(1.2, range)).toBe("start");
    expect(pickNearestTrimHandle(8.6, range)).toBe("end");
    // 正好在中间时取起点，保证结果确定。
    expect(pickNearestTrimHandle(5, range)).toBe("start");
  });
});

describe("比例换算", () => {
  it("秒与比例可来回换算", () => {
    expect(secondsToRatio(5, 10)).toBeCloseTo(0.5, 6);
    expect(ratioToSeconds(0.25, 8)).toBeCloseTo(2, 6);
  });

  it("比例被夹在 0~1", () => {
    expect(secondsToRatio(-1, 10)).toBe(0);
    expect(secondsToRatio(50, 10)).toBe(1);
    expect(ratioToSeconds(3, 10)).toBe(10);
  });
});

describe("时间码", () => {
  it("保留一位小数", () => {
    expect(formatTimecode(0)).toBe("0:00.0");
    expect(formatTimecode(3.04)).toBe("0:03.0");
    expect(formatTimecode(63.25)).toBe("1:03.2");
  });

  it("超过一小时带小时位", () => {
    expect(formatTimecode(3725.5)).toBe("1:02:05.5");
  });

  it("非法值显示 0:00.0", () => {
    expect(formatTimecode(Number.NaN)).toBe("0:00.0");
    expect(formatTimecode(-4)).toBe("0:00.0");
  });

  it("刻度等分整段并覆盖首尾", () => {
    const ticks = buildTimelineTicks(10, 5);
    expect(ticks).toHaveLength(6);
    expect(ticks[0]).toEqual({ ratio: 0, label: "0:00.0" });
    expect(ticks[ticks.length - 1]).toEqual({ ratio: 1, label: "0:10.0" });
  });
});

describe("音轨模式", () => {
  it("选到音轨后自动切到替换", () => {
    expect(resolveAudioModeAfterTrackPick("keep", true)).toBe("replace");
    expect(resolveAudioModeAfterTrackPick("mix", true)).toBe("mix");
  });

  it("清空音轨后回到保留原声", () => {
    expect(resolveAudioModeAfterTrackPick("replace", false)).toBe("keep");
  });
});

describe("可提交性校验", () => {
  it("没有视频来源时拒绝提交", () => {
    expect(validateVideoEditState(stateWith(), null)).toBe("missingSource");
    expect(validateVideoEditState(stateWith(), "  ")).toBe("missingSource");
  });

  it("替换 / 混合模式必须选好音轨", () => {
    expect(validateVideoEditState(stateWith({ audioMode: "replace" }), "/a.mp4")).toBe("missingTrack");
    expect(validateVideoEditState(stateWith({ audioMode: "replace", trackPath: "/m.m4a" }), "/a.mp4")).toBeNull();
    expect(validateVideoEditState(stateWith({ audioMode: "mute" }), "/a.mp4")).toBeNull();
  });

  it("片段过短时拒绝提交", () => {
    const state = stateWith({ trim: { start: 3, end: 3.02 } });
    expect(validateVideoEditState(state, "/a.mp4")).toBe("clipTooShort");
  });
});

describe("请求体拼装", () => {
  it("不用外置音轨时不带 trackPath", () => {
    const request = buildVideoEditRequest(stateWith({ trim: { start: 1.2345, end: 6 } }), "/a.mp4");
    expect(request).toEqual({
      sourcePath: "/a.mp4",
      trimStart: 1.235,
      trimEnd: 6,
      audioMode: "keep",
      audioVolume: 1,
      fadeIn: 0,
      fadeOut: 0,
    });
  });

  it("替换 / 混合时带上音轨与音量", () => {
    const request = buildVideoEditRequest(
      stateWith({ audioMode: "mix", trackPath: "/m.m4a", trackVolume: 0.5, audioVolume: 1.2 }),
      "/a.mp4",
    );
    expect(request.trackPath).toBe("/m.m4a");
    expect(request.trackVolume).toBe(0.5);
    expect(request.audioVolume).toBe(1.2);
  });

  it("模式要求音轨但没选时不误传空路径", () => {
    const request = buildVideoEditRequest(stateWith({ audioMode: "replace" }), "/a.mp4");
    expect(request.trackPath).toBeUndefined();
  });

  it("成片时长等于裁剪区间", () => {
    expect(resolveOutputDuration(stateWith({ trim: { start: 2, end: 7.5 } }))).toBe(5.5);
  });
});
