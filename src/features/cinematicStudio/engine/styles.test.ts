import { describe, expect, it } from "vitest";

import { MASTER_STYLES, getStyle, localizedStyleBrief, styleBriefDescription } from "./styles";

describe("localized style briefs", () => {
  it("provides a substantial description for every master style", () => {
    for (const style of MASTER_STYLES) {
      expect(style.descriptionZh.length).toBeGreaterThan(40);
      expect(style.description.length).toBeGreaterThan(120);
      expect(styleBriefDescription(style, "zh")).toBe(style.descriptionZh);
      expect(styleBriefDescription(style, "en")).toBe(style.description);
      expect(style.descriptionZh).not.toMatch(/[A-Za-z]{3,}/);
      expect(style.description).not.toMatch(/[\u3400-\u9fff]/);
    }
  });

  it("keeps the legacy style brief in the matching language only", () => {
    expect(localizedStyleBrief({ styleBrief: "潮湿夜色中的克制跟拍" }, "zh")).toBe("潮湿夜色中的克制跟拍");
    expect(localizedStyleBrief({ styleBrief: "Restrained tracking in a humid night" }, "en")).toBe("Restrained tracking in a humid night");
    expect(localizedStyleBrief({ styleBrief: "潮湿夜色中的克制跟拍" }, "en")).toBe("");
  });

  it("prefers the language-specific field over the compatibility field", () => {
    expect(localizedStyleBrief({ styleBrief: "旧文本", styleBriefZh: "中文风格段落" }, "zh")).toBe("中文风格段落");
    expect(localizedStyleBrief({ styleBrief: "Legacy text", styleBriefEn: "English style paragraph" }, "en")).toBe("English style paragraph");
    expect(getStyle("emmanuel-lubezki")?.descriptionZh).toContain("摄影机贴近人物");
  });
});
