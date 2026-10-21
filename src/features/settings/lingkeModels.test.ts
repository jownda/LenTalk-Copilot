import { describe, expect, it } from "vitest";

import {
  LINGKE_IMAGE_CAPABILITIES,
  LINGKE_IMAGE_NAME_OVERRIDES,
  LINGKE_MEDIA_IMAGE_MODELS,
  isLingkeBaseUrl,
  isLingkeMediaImageModel,
  resolveLingkeImageCapability,
} from "./lingkeModels";

describe("灵柯图片模型能力表", () => {
  it("21 个媒体图片模型一个不少, 且每个都有能力条目", () => {
    // 名单来自 GET /houduan/gongkai/apidoc/moxing-liebiao?domain=lingkeai.vip
    // 的 data.image 数组(2026-10-20, 21 条, api_xieyi 全为 media)。
    expect(LINGKE_MEDIA_IMAGE_MODELS).toHaveLength(21);
    for (const model of LINGKE_MEDIA_IMAGE_MODELS) {
      expect(LINGKE_IMAGE_CAPABILITIES[model], `${model} 缺能力条目`).toBeDefined();
    }
    expect(Object.keys(LINGKE_IMAGE_CAPABILITIES).sort()).toEqual(
      [...LINGKE_MEDIA_IMAGE_MODELS].sort(),
    );
  });

  it("名字像视频的那两个在例外表里", () => {
    expect(LINGKE_IMAGE_NAME_OVERRIDES).toEqual(["kling-v3", "kling-v3-omni"]);
  });

  it("按名字查能力时大小写不敏感", () => {
    expect(resolveLingkeImageCapability("Banana-2.1")?.resolutions).toEqual(["1K", "2K", "4K"]);
    expect(resolveLingkeImageCapability("不存在的模型")).toBeUndefined();
    expect(isLingkeMediaImageModel(" TT-IMAGE-2.5 ")).toBe(true);
    expect(isLingkeMediaImageModel("gpt-image-2")).toBe(false);
  });

  it("主域名 / 白标站 / 备用域名都算灵柯, 别家域名不算", () => {
    for (const baseUrl of [
      "https://api.lk888.ai",
      "https://api.lk888.ai/v1",
      "https://api.lk666.ai",
      "https://api.lingkeai.ai",
      "https://lingkeai.vip",
      "https://api666888.com",
    ]) {
      expect(isLingkeBaseUrl(baseUrl), baseUrl).toBe(true);
    }
    for (const baseUrl of ["https://api.openai.com", "https://api.wgspai.cn", "", undefined]) {
      expect(isLingkeBaseUrl(baseUrl), String(baseUrl)).toBe(false);
    }
  });
});
