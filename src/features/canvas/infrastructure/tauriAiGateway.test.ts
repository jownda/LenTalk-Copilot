import { describe, expect, it } from "vitest";
import { localizeReferenceTokens } from "./tauriAiGateway";

describe("localizeReferenceTokens", () => {
  it("fal 模型: @图N / 图N 转换为 Image N", () => {
    expect(localizeReferenceTokens("@图1 保持人物一致", "fal/nano-banana-2")).toBe(
      "Image 1 保持人物一致",
    );
    expect(localizeReferenceTokens("分镜1：图2 使用该场景", "fal/nano-banana-pro")).toBe(
      "分镜1：Image 2 使用该场景",
    );
    expect(localizeReferenceTokens("图3", "fal/nano-banana-2")).toBe("Image 3");
  });

  it("ppio gemini 模型: 同样转换为 Image N", () => {
    expect(localizeReferenceTokens("保持 @图1 的风格", "ppio/gemini-3.1-flash")).toBe(
      "保持 Image 1 的风格",
    );
  });

  it("grsai 中文模型: 保留中文图N 标记", () => {
    expect(localizeReferenceTokens("图1 人物", "grsai/hunyuan-draw")).toBe("图1 人物");
  });

  it("正文中的图N 字样不被误转(前接汉字)", () => {
    expect(localizeReferenceTokens("如图1所示, 主体居中", "fal/nano-banana-2")).toBe(
      "如图1所示, 主体居中",
    );
    expect(localizeReferenceTokens("参考图1的风格", "fal/nano-banana-2")).toBe("参考图1的风格");
  });

  it("多张参考图按序映射", () => {
    expect(localizeReferenceTokens("@图1 人物, @图2 背景", "fal/nano-banana-2")).toBe(
      "Image 1 人物, Image 2 背景",
    );
  });

  it("空 prompt 安全返回", () => {
    expect(localizeReferenceTokens("", "fal/nano-banana-2")).toBe("");
  });
});
