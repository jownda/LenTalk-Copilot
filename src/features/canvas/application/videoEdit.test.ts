import { describe, expect, it } from "vitest";

import { FPS_23_976, FPS_24, FPS_30, TICKS_PER_SECOND, ticksFromSeconds } from "./mediaTime";
import {
  applySourceMeta,
  buildTimelineTicks,
  buildVideoEditRequest,
  createVideoEditState,
  deleteSegment,
  findSegmentAt,
  isTicksRemoved,
  minSegmentTicks,
  moveSegmentEdge,
  nextKeptTick,
  ratioToTicks,
  removedRanges,
  resolveAudioModeAfterTrackPick,
  resolveOutputDuration,
  splitSegmentsAt,
  ticksToRatio,
  totalKeptTicks,
  validateVideoEditState,
  type ClipSegment,
  type VideoEditState,
} from "./videoEdit";

function stateWith(overrides: Partial<VideoEditState> = {}): VideoEditState {
  const base = applySourceMeta(createVideoEditState(), {
    durationTicks: ticksFromSeconds(10),
    frameRate: FPS_30,
  });
  return { ...base, ...overrides };
}

/** 只比较区间（换算成秒），忽略随机 id（id 只为渲染服务）。 */
function ranges(segments: readonly ClipSegment[]): Array<[number, number]> {
  // 100 tick = 1/1200 秒；先除到「百分之一秒」再除 100，避免浮点尾巴。
  const toSeconds = (ticks: number) => Math.round(ticks / 1_200) / 100;
  return segments.map((segment) => [toSeconds(segment.startTicks), toSeconds(segment.endTicks)]);
}

describe("初始化", () => {
  it("读到时长后铺满整段", () => {
    const state = stateWith();
    expect(state.durationTicks).toBe(ticksFromSeconds(10));
    expect(ranges(state.segments)).toEqual([[0, 10]]);
    expect(state.selectedId).toBe(state.segments[0].id);
  });

  it("时长未知时仍给出可交互的占位段", () => {
    const state = createVideoEditState();
    expect(state.segments).toHaveLength(1);
    expect(state.segments[0].endTicks).toBeGreaterThan(0);
  });

  it("重新读元数据不重置已有剪辑，只做收敛", () => {
    const trimmed = stateWith({ segments: [{ id: "a", startTicks: ticksFromSeconds(2), endTicks: ticksFromSeconds(8) }] });
    const next = applySourceMeta(trimmed, { durationTicks: ticksFromSeconds(5), frameRate: FPS_30 });
    // 8s 的终点被收到 5s，起点保留 —— 用户剪过的痕迹不能被抹掉。
    expect(ranges(next.segments)).toEqual([[2, 5]]);
  });
});

describe("最短片段", () => {
  it("按帧向上取整，保证边界落在帧上", () => {
    // 30fps：每帧 4000 tick，0.1s = 12000 tick = 正好 3 帧。
    expect(minSegmentTicks(FPS_30)).toBe(12_000);
    // 24fps：每帧 5000 tick，12000 不是整数帧 → 抬到 3 帧 = 15000。
    expect(minSegmentTicks(FPS_24)).toBe(15_000);
  });

  it("没有帧率时退回 0.1 秒", () => {
    expect(minSegmentTicks(null)).toBe(TICKS_PER_SECOND * 0.1);
  });
});

describe("切一刀", () => {
  it("在段内切点把一段拆成两段", () => {
    const segments = splitSegmentsAt(stateWith().segments, ticksFromSeconds(4), FPS_30);
    expect(ranges(segments)).toEqual([
      [0, 4],
      [4, 10],
    ]);
  });

  it("切点吸附到帧", () => {
    // 4.01s = 481200 tick，30fps 下吸附到 480000（第 120 帧）。
    const segments = splitSegmentsAt(stateWith().segments, ticksFromSeconds(4.01), FPS_30);
    expect(ranges(segments)).toEqual([
      [0, 4],
      [4, 10],
    ]);
  });

  it("切在已剪掉的空隙里不产生新段", () => {
    const gapped: ClipSegment[] = [
      { id: "a", startTicks: 0, endTicks: ticksFromSeconds(2) },
      { id: "b", startTicks: ticksFromSeconds(6), endTicks: ticksFromSeconds(10) },
    ];
    const segments = splitSegmentsAt(gapped, ticksFromSeconds(4), FPS_30);
    expect(ranges(segments)).toEqual([
      [0, 2],
      [6, 10],
    ]);
  });

  it("切点离边界不足一个最短片段时拒绝切", () => {
    // 距起点 0.05s，会切出一段比 0.1s 还短的碎渣。
    const segments = splitSegmentsAt(stateWith().segments, ticksFromSeconds(0.05), FPS_30);
    expect(segments).toHaveLength(1);
  });
});

describe("删除段", () => {
  it("删中间段后留下空隙", () => {
    const split = splitSegmentsAt(stateWith().segments, ticksFromSeconds(4), FPS_30);
    const middle = split[1];
    const after = deleteSegment(split, middle.id);
    expect(ranges(after)).toEqual([[0, 4]]);
  });

  it("最后一段不允许删光", () => {
    const state = stateWith();
    const after = deleteSegment(state.segments, state.segments[0].id);
    expect(after).toHaveLength(1);
  });
});

describe("拖边界", () => {
  const twoSegments = (): ClipSegment[] => [
    { id: "a", startTicks: 0, endTicks: ticksFromSeconds(4) },
    { id: "b", startTicks: ticksFromSeconds(4), endTicks: ticksFromSeconds(10) },
  ];

  it("起点不能越过上一段的终点", () => {
    const next = moveSegmentEdge(twoSegments(), "b", "start", ticksFromSeconds(1), FPS_30, ticksFromSeconds(10));
    expect(ranges(next)).toEqual([
      [0, 4],
      [4, 10],
    ]);
  });

  it("终点不能越过下一段的起点", () => {
    const next = moveSegmentEdge(twoSegments(), "a", "end", ticksFromSeconds(9), FPS_30, ticksFromSeconds(10));
    expect(ranges(next)).toEqual([
      [0, 4],
      [4, 10],
    ]);
  });

  it("向内拖保留最短长度", () => {
    const next = moveSegmentEdge(twoSegments(), "a", "end", 0, FPS_30, ticksFromSeconds(10));
    expect(next[0].endTicks - next[0].startTicks).toBe(minSegmentTicks(FPS_30));
  });
});

describe("保留区判定", () => {
  const gapped: ClipSegment[] = [
    { id: "a", startTicks: 0, endTicks: ticksFromSeconds(2) },
    { id: "b", startTicks: ticksFromSeconds(6), endTicks: ticksFromSeconds(10) },
  ];

  it("找得到所在段", () => {
    expect(findSegmentAt(gapped, ticksFromSeconds(1))?.id).toBe("a");
    expect(findSegmentAt(gapped, ticksFromSeconds(7))?.id).toBe("b");
    expect(findSegmentAt(gapped, ticksFromSeconds(4))).toBeNull();
  });

  it("空隙判为已剪掉", () => {
    expect(isTicksRemoved(gapped, ticksFromSeconds(4))).toBe(true);
    expect(isTicksRemoved(gapped, ticksFromSeconds(1))).toBe(false);
  });

  it("播放时能拿到下一个保留点", () => {
    expect(nextKeptTick(gapped, ticksFromSeconds(1), ticksFromSeconds(10))).toBe(ticksFromSeconds(6));
    // 后面没有保留段了 → 走到片尾。
    expect(nextKeptTick(gapped, ticksFromSeconds(7), ticksFromSeconds(10))).toBe(ticksFromSeconds(10));
  });

  it("成片时长等于各段之和", () => {
    expect(totalKeptTicks(gapped)).toBe(ticksFromSeconds(6));
  });
});

describe("比例换算", () => {
  it("tick 与比例可来回换算", () => {
    expect(ticksToRatio(ticksFromSeconds(5), ticksFromSeconds(10))).toBeCloseTo(0.5, 6);
    expect(ratioToTicks(0.25, ticksFromSeconds(8))).toBe(ticksFromSeconds(2));
  });

  it("比例被夹在 0~1", () => {
    expect(ticksToRatio(-1, ticksFromSeconds(10))).toBe(0);
    expect(ticksToRatio(ticksFromSeconds(99), ticksFromSeconds(10))).toBe(1);
  });
});

describe("刻度", () => {
  it("等分并覆盖首尾，标签精确到帧", () => {
    const ticks = buildTimelineTicks(ticksFromSeconds(10), FPS_30, 5);
    expect(ticks).toHaveLength(6);
    expect(ticks[0]).toEqual({ ratio: 0, label: "0:00.00" });
    expect(ticks[1]).toEqual({ ratio: 0.2, label: "0:02.00" });
    expect(ticks[5]).toEqual({ ratio: 1, label: "0:10.00" });
  });

  it("没有帧率时退回小数秒", () => {
    expect(buildTimelineTicks(ticksFromSeconds(10), null, 5)[1].label).toBe("0:02.0");
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

  it("一段都不剩时拒绝提交", () => {
    expect(validateVideoEditState(stateWith({ segments: [] }), "/a.mp4")).toBe("noClip");
  });
});

describe("请求体拼装", () => {
  it("把多段转成秒、按顺序提交", () => {
    const state = stateWith({
      segments: [
        { id: "a", startTicks: 0, endTicks: ticksFromSeconds(2) },
        { id: "b", startTicks: ticksFromSeconds(6), endTicks: ticksFromSeconds(10) },
      ],
    });
    const request = buildVideoEditRequest(state, "/a.mp4");
    expect(request.segments).toEqual([
      { start: 0, end: 2 },
      { start: 6, end: 10 },
    ]);
    expect(request.audioMode).toBe("keep");
    expect(request.trimStart).toBeUndefined();
  });

  it("tick 换算成的秒保留 6 位，不丢帧", () => {
    // 1/30 秒 = 4000 tick = 0.033333…s
    const state = stateWith({
      segments: [{ id: "a", startTicks: 0, endTicks: 4_000 }],
    });
    expect(buildVideoEditRequest(state, "/a.mp4").segments?.[0].end).toBe(0.033333);
  });

  it("不用外置音轨时不带 trackPath", () => {
    const request = buildVideoEditRequest(stateWith({ audioMode: "replace" }), "/a.mp4");
    expect(request.trackPath).toBeUndefined();
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

  it("成片时长等于各段之和", () => {
    const state = stateWith({
      segments: [
        { id: "a", startTicks: ticksFromSeconds(2), endTicks: ticksFromSeconds(4) },
        { id: "b", startTicks: ticksFromSeconds(5), endTicks: ticksFromSeconds(8.5) },
      ],
    });
    expect(resolveOutputDuration(state)).toBe(5.5);
  });
});

describe("23.976 素材", () => {
  it("切点落在 5005 tick 的整数倍上", () => {
    const segments = splitSegmentsAt(
      [{ id: "a", startTicks: 0, endTicks: ticksFromSeconds(10) }],
      ticksFromSeconds(4.0),
      FPS_23_976,
    );
    expect(segments[0].endTicks % 5_005).toBe(0);
  });
});

describe('被剪掉的区间（波形遮罩用）', () => {
  /** 造段并换算成秒，方便断言。 */
  const seg = (start: number, end: number, id = `${start}-${end}`): ClipSegment => ({
    id,
    startTicks: ticksFromSeconds(start),
    endTicks: ticksFromSeconds(end),
  });
  const asSeconds = (gaps: Array<{ startTicks: number; endTicks: number }>) =>
    gaps.map((gap) => [gap.startTicks / TICKS_PER_SECOND, gap.endTicks / TICKS_PER_SECOND]);

  it('只剪中间一段时，两侧各有一段空的', () => {
    // 0-2 保留、2-4 剪掉、4-10 保留
    const gaps = removedRanges([seg(0, 2, 'a'), seg(4, 10, 'b')], ticksFromSeconds(10));
    expect(asSeconds(gaps)).toEqual([[2, 4]]);
  });

  it('开头和片尾都被剪掉时两段都算', () => {
    const gaps = removedRanges([seg(2, 6, 'a')], ticksFromSeconds(10));
    expect(asSeconds(gaps)).toEqual([
      [0, 2],
      [6, 10],
    ]);
  });

  it('整段保留时没有任何空隙', () => {
    expect(removedRanges([seg(0, 10)], ticksFromSeconds(10))).toEqual([]);
  });

  it('乱序传入也按时间排好', () => {
    const gaps = removedRanges([seg(6, 8, 'b'), seg(0, 2, 'a')], ticksFromSeconds(10));
    expect(asSeconds(gaps)).toEqual([
      [2, 6],
      [8, 10],
    ]);
  });

  it('重叠的段不会算出负宽空隙', () => {
    // a 与 b 重叠：游标要按「已覆盖到的最远处」推进，否则会凭空多出一段。
    const gaps = removedRanges([seg(0, 5, 'a'), seg(3, 7, 'b')], ticksFromSeconds(10));
    expect(asSeconds(gaps)).toEqual([[7, 10]]);
  });

  it('时长为 0（还没探测到）时不返回空隙', () => {
    expect(removedRanges([seg(0, 10)], 0)).toEqual([]);
  });

  it('段超出片长时按片长收口，不产生越界空隙', () => {
    const gaps = removedRanges([seg(0, 3, 'a'), seg(8, 20, 'b')], ticksFromSeconds(10));
    expect(asSeconds(gaps)).toEqual([[3, 8]]);
  });
});
