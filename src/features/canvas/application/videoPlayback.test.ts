import { describe, expect, it } from "vitest";

import { isVideoTrackUndecoded } from "./videoPlayback";

describe("isVideoTrackUndecoded", () => {
  it("正常解码的 H.264 视频不算未解码", () => {
    expect(isVideoTrackUndecoded({ videoWidth: 1920, videoHeight: 1080, duration: 15.069 })).toBe(false);
  });

  it("HEVC/ProRes 被静默丢轨: 时长有、尺寸为 0 → 判为未解码", () => {
    // 实测本机 WebView2 加载 hvc1 素材就是这个组合(且 error 恒为 null)。
    expect(isVideoTrackUndecoded({ videoWidth: 0, videoHeight: 0, duration: 15.069 })).toBe(true);
  });

  it("元数据还没就绪时(时长为 0/NaN)不触发, 避免误转码", () => {
    expect(isVideoTrackUndecoded({ videoWidth: 0, videoHeight: 0, duration: 0 })).toBe(false);
    expect(isVideoTrackUndecoded({ videoWidth: 0, videoHeight: 0, duration: Number.NaN })).toBe(false);
    expect(isVideoTrackUndecoded({ videoWidth: 0, videoHeight: 0, duration: Number.POSITIVE_INFINITY })).toBe(false);
  });

  it("只有宽或只有高为 0 时不误判(仍认为可解码)", () => {
    expect(isVideoTrackUndecoded({ videoWidth: 1920, videoHeight: 0, duration: 10 })).toBe(false);
    expect(isVideoTrackUndecoded({ videoWidth: 0, videoHeight: 1080, duration: 10 })).toBe(false);
  });

  it("纯音频容器(时长有、无视频轨)同样被判为未解码 —— 由调用方复用 H.264 代理兜底", () => {
    // 真正的音频文件在画布上走 AudioNode 的音频分支, 不会挂 <video>; 这里只是锁住语义:
    // 判据只回答「有没有可用画面」, 不区分原因。
    expect(isVideoTrackUndecoded({ videoWidth: 0, videoHeight: 0, duration: 62.5 })).toBe(true);
  });
});
