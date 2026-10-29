import { describe, expect, it } from "vitest";

import {
  FPS_23_976,
  FPS_24,
  FPS_25,
  FPS_29_97,
  FPS_30,
  FPS_60,
  TICKS_PER_SECOND,
  floorTicksToFrame,
  formatTimecode,
  frameToTicks,
  isFrameAligned,
  parseProbeFrameRate,
  snapTicksToFrame,
  ticksFromSeconds,
  ticksPerFrame,
  ticksToFrame,
  ticksToSeconds,
} from "./mediaTime";

describe("时基常量", () => {
  it("每秒 12 万 tick", () => {
    expect(TICKS_PER_SECOND).toBe(120_000);
    expect(ticksFromSeconds(1.5)).toBe(180_000);
    expect(ticksToSeconds(180_000)).toBe(1.5);
  });

  it("非法秒数不产生 NaN", () => {
    expect(ticksFromSeconds(Number.NaN)).toBe(0);
    expect(ticksFromSeconds(Number.POSITIVE_INFINITY)).toBe(0);
    expect(ticksToSeconds(Number.NaN)).toBe(0);
  });
});

describe("每帧 tick 数", () => {
  it("所有标准帧率都能整除，含丢帧率", () => {
    expect(ticksPerFrame(FPS_23_976)).toBe(5_005);
    expect(ticksPerFrame(FPS_24)).toBe(5_000);
    expect(ticksPerFrame(FPS_25)).toBe(4_800);
    expect(ticksPerFrame(FPS_29_97)).toBe(4_004);
    expect(ticksPerFrame(FPS_30)).toBe(4_000);
    expect(ticksPerFrame(FPS_60)).toBe(2_000);
  });

  it("除不尽的帧率返回 null 而不是四舍五入", () => {
    expect(ticksPerFrame({ numerator: 7, denominator: 3 })).toBeNull();
    expect(ticksPerFrame({ numerator: 0, denominator: 1 })).toBeNull();
    expect(ticksPerFrame(null)).toBeNull();
  });
});

describe("帧吸附", () => {
  it("吸附到最近的帧边界", () => {
    // 30fps 每帧 4000 tick。
    expect(snapTicksToFrame(4_900, FPS_30)).toBe(4_000);
    expect(snapTicksToFrame(6_100, FPS_30)).toBe(8_000);
    expect(isFrameAligned(8_000, FPS_30)).toBe(true);
    expect(isFrameAligned(8_100, FPS_30)).toBe(false);
  });

  it("floor 用于起点：不会越过原位置", () => {
    expect(floorTicksToFrame(7_900, FPS_30)).toBe(4_000);
    expect(snapTicksToFrame(7_900, FPS_30)).toBe(8_000);
  });

  it("没有帧率时退回毫秒取整，仍然稳定", () => {
    expect(snapTicksToFrame(1_234_567, null) % 1000).toBe(0);
    expect(snapTicksToFrame(Number.NaN, null)).toBe(0);
  });

  it("帧号与 tick 可互转", () => {
    expect(ticksToFrame(152_000, FPS_30)).toBe(38);
    expect(frameToTicks(38, FPS_30)).toBe(152_000);
    expect(ticksToFrame(1, null)).toBeNull();
  });
});

describe("时间码", () => {
  it("有帧率时精确到帧", () => {
    // 30fps：1.26 秒 = 第 37 帧余 0.26s → 0:01.07（37 帧 = 148000，余 4000 起点）
    expect(formatTimecode(0, FPS_30)).toBe("0:00.00");
    expect(formatTimecode(151_200, FPS_30)).toBe("0:01.07");
    expect(formatTimecode(120_000, FPS_30)).toBe("0:01.00");
  });

  it("24fps 与 60fps 的帧号位数不同", () => {
    expect(formatTimecode(2_500, FPS_24)).toBe("0:00.00");
    expect(formatTimecode(122_500, FPS_60)).toBe("0:01.01");
  });

  it("超过一小时带小时位", () => {
    expect(formatTimecode(ticksFromSeconds(3725.5), FPS_30)).toBe("1:02:05.15");
  });

  it("没有帧率时退回一位小数秒", () => {
    expect(formatTimecode(0, null)).toBe("0:00.0");
    expect(formatTimecode(ticksFromSeconds(63.25), null)).toBe("1:03.2");
  });

  it("非法值显示全零", () => {
    expect(formatTimecode(Number.NaN, FPS_30)).toBe("0:00.00");
    expect(formatTimecode(-1000, FPS_30)).toBe("0:00.00");
  });
});

describe("探测帧率吸附", () => {
  it("ffmpeg 报的小数吸附到标准有理数", () => {
    expect(parseProbeFrameRate(23.98, 1)).toEqual(FPS_23_976);
    expect(parseProbeFrameRate(29.97, 1)).toEqual(FPS_29_97);
    expect(parseProbeFrameRate(30, 1)).toEqual(FPS_30);
    expect(parseProbeFrameRate(25, 1)).toEqual(FPS_25);
  });

  it("已经是有理数时原样识别", () => {
    expect(parseProbeFrameRate(24_000, 1_001)).toEqual(FPS_23_976);
  });

  it("缺值 / 非法值返回 null", () => {
    expect(parseProbeFrameRate(null, 1)).toBeNull();
    expect(parseProbeFrameRate(0, 1)).toBeNull();
    expect(parseProbeFrameRate(30, 0)).toBeNull();
  });

  it("认不出来的帧率原样保留", () => {
    const odd = parseProbeFrameRate(15, 1);
    expect(odd).toEqual({ numerator: 15, denominator: 1 });
  });
});
