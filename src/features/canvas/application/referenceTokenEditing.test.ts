import { describe, expect, it } from "vitest";

import {
  findReferenceTokens,
  remapImageReferenceTokens,
  samePromptIgnoringReferenceTokens,
  shouldPruneReferenceTokens,
  syncImageReferenceTokens,
} from "./referenceTokenEditing";

describe("cinematic prompt reference tokens", () => {
  it("recognizes Seedance @audioN references alongside existing editor tokens", () => {
    expect(findReferenceTokens("@loc [image1]；声音 @audio1；旧声音 [audio1]；@图2", 2, 1)).toEqual([
      { start: 5, end: 13, token: "[image1]", value: 1, kind: "image" },
      { start: 17, end: 24, token: "@audio1", value: 1, kind: "audio" },
      { start: 29, end: 37, token: "[audio1]", value: 1, kind: "audio" },
      { start: 38, end: 41, token: "@图2", value: 2, kind: "image" },
    ]);
  });

  it("remaps surviving image references after a middle upstream image disconnects", () => {
    const prompt = "保留 @图1，断开的 @图2，继续使用 [image3]。";

    expect(remapImageReferenceTokens(
      prompt,
      ["image-a", "image-b", "image-c"],
      ["image-a", "image-c"],
    )).toBe("保留 @图1，断开的 ，继续使用 [image2]。");
  });
});

describe("shouldPruneReferenceTokens", () => {
  it("参考图变少（上游断连）时才清理越界标记", () => {
    expect(shouldPruneReferenceTokens(6, 4)).toBe(true);
    expect(shouldPruneReferenceTokens(1, 0)).toBe(true);
  });

  it("图片后接、提示词先到时不清理（否则 [imageN] 会被整段删掉）", () => {
    // 真机时序：提示词工作室先把成品写进节点，参考图还在异步解析，数量短暂为 0。
    expect(shouldPruneReferenceTokens(0, 6)).toBe(false);
    // 数量不变（含重排）也不该清理，重编号交给 remap。
    expect(shouldPruneReferenceTokens(6, 6)).toBe(false);
  });
});

describe("syncImageReferenceTokens：改写与断连必须分开处理", () => {
  const prompt = "场景 @图1，角色 [image2]，道具 @图3。";

  it("来源被原地改写（本地化 / 资产库路径重映射）时，标记一个都不能少", () => {
    // 真机链路：打开工程 2 秒后 UnpersistedMediaNotice 自动把 http 参考图下载成本地
    // 文件，并把节点数据里的地址整体换成落盘路径 —— 数组长度与顺序都不变，只有字符串变了。
    expect(
      syncImageReferenceTokens(
        prompt,
        ["https://cdn.example.com/a.png", "https://cdn.example.com/b.png", "https://cdn.example.com/c.png"],
        ["/Users/me/LenTalk/media/1.png", "/Users/me/LenTalk/media/2.png", "/Users/me/LenTalk/media/3.png"],
      ),
    ).toBe(prompt);
  });

  it("只有一部分被改写时也保持不动（写回就会丢内容）", () => {
    // 3 张里成功 2 张：改写与保留混在一起，无法区分，保守不动。
    expect(
      syncImageReferenceTokens(prompt, ["http://a", "http://b", "http://c"], ["local-a", "local-b", "http://c"]),
    ).toBe(prompt);
  });

  it("真正的上游断连：只删它自己的标记，后面的图接过连续序号", () => {
    expect(syncImageReferenceTokens(prompt, ["a", "b", "c"], ["a", "c"])).toBe(
      "场景 @图1，角色 ，道具 @图2。",
    );
  });

  it("同一批来源的重排：序号跟着新的上传顺序换，内容不删", () => {
    expect(syncImageReferenceTokens(prompt, ["a", "b", "c"], ["c", "b", "a"])).toBe(
      "场景 @图3，角色 [image2]，道具 @图1。",
    );
  });

  it("新增来源（不改写）时不动已有标记", () => {
    expect(syncImageReferenceTokens(prompt, ["a", "b", "c"], ["a", "b", "c", "d"])).toBe(prompt);
  });

  it("改写 + 断连同时发生时不猜，宁可留一个越界标记", () => {
    // 少了一条、又多了一个陌生来源 —— 无法判断哪个是「被改写的那张」。
    expect(syncImageReferenceTokens(prompt, ["http://a", "http://b", "http://c"], ["local-a", "local-c"])).toBe(
      prompt,
    );
  });

  it("没有历史来源时不动", () => {
    expect(syncImageReferenceTokens(prompt, [], ["a"])).toBe(prompt);
  });
});

describe("samePromptIgnoringReferenceTokens：自愈借回的唯一前提", () => {
  it("只差标记时判定为同一版（可以整段借回）", () => {
    expect(
      samePromptIgnoringReferenceTokens(
        "SCENE CONTEXT 药铺室内 @图1 ，后墙排列木药柜 [image2]。",
        "SCENE CONTEXT 药铺室内 ，后墙排列木药柜。",
      ),
    ).toBe(true);
  });

  it("用户改过一个字就不借回（绝不覆盖他的编辑）", () => {
    expect(
      samePromptIgnoringReferenceTokens(
        "SCENE CONTEXT 药铺室内 @图1 ，后墙排列木药柜。",
        "SCENE CONTEXT 药铺室内 ，后墙摆着木药柜。",
      ),
    ).toBe(false);
  });

  it("空文本不算同一版", () => {
    expect(samePromptIgnoringReferenceTokens("@图1", "  ")).toBe(false);
    expect(samePromptIgnoringReferenceTokens("", "")).toBe(false);
  });
});
