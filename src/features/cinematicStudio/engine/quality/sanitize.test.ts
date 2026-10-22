import { describe, expect, it } from "vitest";

import { sanitizeDirectorText } from "./sanitize";

describe("sanitizeDirectorText", () => {
  it("删除项目管理和连续性诊断元数据，保留真实画面指令", () => {
    const input = [
      "场景上下文：",
      "林警官坐在车厢中央。",
      "启用资产：@林警官、@无尽地铁车厢。",
      "未启用琪琪与黛莲。",
      "连续性：共 5 个问题（0 个错误，4 个警告）。",
      "最终导出前请解决错误级问题。",
      "镜头保持低角度，角色呼吸自然。",
      "连续性检查仍然是制作流程的一部分。",
    ].join("\n");

    const output = sanitizeDirectorText(input);
    expect(output).toContain("林警官坐在车厢中央。");
    expect(output).toContain("镜头保持低角度，角色呼吸自然。");
    expect(output).toContain("连续性检查仍然是制作流程的一部分。");
    expect(output).not.toContain("启用资产");
    expect(output).not.toContain("未启用");
    expect(output).not.toContain("共 5 个问题");
    expect(output).not.toContain("最终导出前");
  });

  it("删除末尾和相邻的空分段，并规范换行", () => {
    expect(sanitizeDirectorText("SCENE CONTEXT:\n内容。\n\nOPTICS:\n\nCAMERA:\n低机位。\n\n\n"))
      .toBe("SCENE CONTEXT:\n内容。\n\nCAMERA:\n低机位。");
  });

  it("空输入保持为空", () => {
    expect(sanitizeDirectorText(" \n\n")).toBe("");
  });
});
