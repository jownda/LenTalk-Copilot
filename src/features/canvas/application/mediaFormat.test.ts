import { describe, expect, it } from "vitest";

import {
  formatByteSize,
  formatDurationMs,
  formatDurationSeconds,
  formatResolution,
  formatTimestamp,
  resolveMediaFormatLabel,
} from "./mediaFormat";

describe("formatResolution", () => {
  it("合法尺寸按像素展示", () => {
    expect(formatResolution(1920, 1080)).toBe("1920 × 1080 px");
    expect(formatResolution(1023.7, 768.2)).toBe("1024 × 768 px");
  });

  it("缺失或非法维度返回 null", () => {
    expect(formatResolution(0, 100)).toBeNull();
    expect(formatResolution(100, null)).toBeNull();
    expect(formatResolution(Number.NaN, 100)).toBeNull();
  });
});

describe("formatDurationSeconds", () => {
  it("分:秒 与 时:分:秒 两种形态", () => {
    expect(formatDurationSeconds(5)).toBe("0:05");
    expect(formatDurationSeconds(95)).toBe("1:35");
    expect(formatDurationSeconds(3661)).toBe("1:01:01");
  });

  it("NaN / Infinity / 非正数(流式媒体常见)返回 null", () => {
    expect(formatDurationSeconds(Number.NaN)).toBeNull();
    expect(formatDurationSeconds(Number.POSITIVE_INFINITY)).toBeNull();
    expect(formatDurationSeconds(0)).toBeNull();
    expect(formatDurationSeconds(null)).toBeNull();
  });
});

describe("formatDurationMs", () => {
  it("小于一分钟用秒,否则用分秒", () => {
    expect(formatDurationMs(45_000)).toBe("45 秒");
    expect(formatDurationMs(150_000)).toBe("2 分 30 秒");
    expect(formatDurationMs(120_000)).toBe("2 分");
  });
});

describe("formatByteSize", () => {
  it("沿用悬停标注的同一套舍入规则", () => {
    expect(formatByteSize(1)).toBe("1 B");
    expect(formatByteSize(1024)).toBe("1 KB");
    expect(formatByteSize(1_258_291)).toBe("1.2 MB");
    expect(formatByteSize(0)).toBeNull();
  });
});

describe("formatTimestamp", () => {
  it("非法时间戳返回 null,合法时间戳带日期与时间", () => {
    expect(formatTimestamp(null)).toBeNull();
    expect(formatTimestamp(Number.NaN)).toBeNull();
    expect(formatTimestamp(1_700_000_000_000)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

describe("resolveMediaFormatLabel", () => {
  it("普通扩展名转大写,JPEG 归一成 JPG", () => {
    expect(resolveMediaFormatLabel("/media/a.png")).toBe("PNG");
    expect(resolveMediaFormatLabel("https://cdn.x.com/a.jpeg?token=1")).toBe("JPG");
    expect(resolveMediaFormatLabel("/media/clip.MP4")).toBe("MP4");
  });

  it("data URL 取 MIME 子类型", () => {
    expect(resolveMediaFormatLabel("data:image/png;base64,AAAA")).toBe("PNG");
    expect(resolveMediaFormatLabel("data:audio/mpeg;base64,AAAA")).toBe("MP3");
  });

  it("无扩展名或扩展名不像后缀时返回 null", () => {
    expect(resolveMediaFormatLabel("blob:http://127.0.0.1/abc")).toBeNull();
    expect(resolveMediaFormatLabel("https://api.example.com/v1/final")).toBeNull();
    expect(resolveMediaFormatLabel("")).toBeNull();
  });
});
