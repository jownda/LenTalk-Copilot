import { describe, expect, it } from "vitest";

import { buildQuickPromptRequest } from "./quickPromptAgent";
import {
  DEFAULT_QUICK_PROMPT_FORMAT,
  QUICK_PROMPT_FORMATS,
  findQuickPromptFormat,
} from "./quickPromptFormats";

const MINIMAL_INPUT = { style: "夜景", synopsis: "两人对峙", sceneAssets: [], characterAssets: [] };

describe("QUICK_PROMPT_FORMATS", () => {
  it("id 不重复（注册表是按 id 查找的，重复会让查到的那个变成随机）", () => {
    const ids = QUICK_PROMPT_FORMATS.map((format) => format.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("默认格式确实在注册表里，且就是 Seedance 2.5", () => {
    const found = QUICK_PROMPT_FORMATS.find((format) => format.id === DEFAULT_QUICK_PROMPT_FORMAT);
    expect(found).toBeDefined();
    expect(found?.name).toBe("Seedance 2.5");
  });

  it("每个格式的名字、说明、user 首行都非空（UI 与提示词都要用）", () => {
    for (const format of QUICK_PROMPT_FORMATS) {
      expect(format.name.trim().length).toBeGreaterThan(0);
      expect(format.description.trim().length).toBeGreaterThan(0);
      expect(format.userLead.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("findQuickPromptFormat", () => {
  it("按 id 命中", () => {
    expect(findQuickPromptFormat("seedance-2.5").id).toBe("seedance-2.5");
  });

  it("未提供 / 空串 / 未知 id 一律回落默认（老节点没这个字段不能算错）", () => {
    expect(findQuickPromptFormat(undefined).id).toBe(DEFAULT_QUICK_PROMPT_FORMAT);
    expect(findQuickPromptFormat(null).id).toBe(DEFAULT_QUICK_PROMPT_FORMAT);
    expect(findQuickPromptFormat("").id).toBe(DEFAULT_QUICK_PROMPT_FORMAT);
    expect(findQuickPromptFormat("某个以后被删掉的格式").id).toBe(DEFAULT_QUICK_PROMPT_FORMAT);
  });
});

describe("Seedance 2.5 的规则", () => {
  const format = findQuickPromptFormat("seedance-2.5");

  it("system 保留 CINEDANCE 定位句与输出规范（搬动规则时最容易丢的就是这些）", () => {
    const system = format.buildSystem({ outputLanguage: "clear, cinematic Chinese", locale: "zh" });
    expect(system).toContain("an elite AI film prompt director for Seedance 2.0 and Higgsfield Seedance");
    expect(system).toContain("Keep @asset tags and [imageN]/[audioN] tokens unchanged.");
    // FORMAT MODE 不许写画幅 / 时长 / 帧率，这条是产品级约束，别在重构里丢掉
    expect(system).toContain("FORMAT MODE must never state an aspect ratio");
    expect(system).toContain("唯一人声参考");
  });

  it("system 跟随输出语言", () => {
    const zh = format.buildSystem({ outputLanguage: "clear, cinematic Chinese", locale: "zh" });
    const en = format.buildSystem({ outputLanguage: "clear cinematic English", locale: "en" });
    expect(zh).toContain("clear, cinematic Chinese");
    expect(en).toContain("clear cinematic English");
  });

  it("user 首行点明产出目标", () => {
    expect(format.userLead).toContain("Seedance");
  });
});

/**
 * 这一组守的是「这一层存在的全部理由」：
 * 换格式必须真的换规则，而不只是换个 UI 标签。
 */
describe("格式 → 规则的联动", () => {
  it("生成链路确实从注册表取规则（system 与注册表产物逐字一致）", () => {
    const request = buildQuickPromptRequest(MINIMAL_INPUT, "zh", "seedance-2.5");
    const fromRegistry = findQuickPromptFormat("seedance-2.5").buildSystem({
      outputLanguage: "clear, cinematic Chinese",
      locale: "zh",
    });
    expect(request.system).toBe(fromRegistry);
    expect(request.user.startsWith(findQuickPromptFormat("seedance-2.5").userLead)).toBe(true);
  });

  it("换一个格式，规则与 user 首行都跟着换", () => {
    const originalLength = QUICK_PROMPT_FORMATS.length;
    QUICK_PROMPT_FORMATS.push({
      id: "test-format",
      name: "测试格式",
      description: "仅用于测试",
      userLead: "TEST USER LEAD",
      userTail: "TEST USER TAIL",
      buildSystem: () => "TEST SYSTEM RULE",
    });
    try {
      const swapped = buildQuickPromptRequest(MINIMAL_INPUT, "zh", "test-format");
      expect(swapped.system).toBe("TEST SYSTEM RULE");
      expect(swapped.user.startsWith("TEST USER LEAD")).toBe(true);
      // 段落清单也必须跟着格式走：写死在生成链路里的话，换格式后模型还是按 Seedance 出
      expect(swapped.user.endsWith("TEST USER TAIL")).toBe(true);

      // 别的格式不受影响 —— 否则就是把注册表写成了共享可变状态
      const seedance = buildQuickPromptRequest(MINIMAL_INPUT, "zh", "seedance-2.5");
      expect(seedance.system).not.toBe("TEST SYSTEM RULE");
      expect(seedance.system).toContain("CINEDANCE V4");
    } finally {
      QUICK_PROMPT_FORMATS.length = originalLength;
    }
  });
});

/**
 * H3 的规则来自 MiniMax 官方 skill（base-en.txt + ref-en.txt）。
 * 这些字段名与标签是模型认的硬语法，翻译或改名等于格式失效，所以逐条钉住。
 */
describe("MiniMax H3 的规则", () => {
  const format = findQuickPromptFormat("minimax-h3");

  it("按 id 命中，没有悄悄回落成默认格式", () => {
    expect(format.id).toBe("minimax-h3");
    expect(format.name).toBe("MiniMax H3");
  });

  it("system 带全 H3 硬语法：三字段 / 六段 / 参考标签 / 对白记号", () => {
    const system = format.buildSystem({ outputLanguage: "clear, cinematic Chinese", locale: "zh" });
    expect(system).toContain("integrated_multimodal_description");
    expect(system).toContain("overall_soundscape");
    expect(system).toContain("non_diegetic_music");
    expect(system).toContain("subject_definitions");
    expect(system).toContain("retention_analysis");
    expect(system).toContain("detailed_description");
    expect(system).toContain("<d>[Language] ...</d>");
    expect(system).toContain("<scenetrans>");
    expect(system).toContain("fully_preserved");
    // 运镜是封闭词表（H3 只认这些说法），不能被自由描述替换掉
    expect(system).toContain("Push In / Pull Out");
    expect(system).toContain("at slow speed");
  });

  it("system 跟随输出语言，但字段名与标签始终是英文原文", () => {
    const zh = format.buildSystem({ outputLanguage: "clear, cinematic Chinese", locale: "zh" });
    const en = format.buildSystem({ outputLanguage: "clear cinematic English", locale: "en" });
    expect(zh).toContain("clear, cinematic Chinese");
    expect(en).toContain("clear cinematic English");
    expect(en).toContain("integrated_multimodal_description");
  });

  it("user 末行给的是 H3 字段，不是 Seedance 的大写标题", () => {
    expect(format.userTail).toContain("integrated_multimodal_description");
    expect(format.userTail).toContain("subject_definitions");
    expect(format.userTail).not.toContain("ACTION TIMING");
  });

  it("生成链路对 H3 用 H3 的规则与段落清单", () => {
    const request = buildQuickPromptRequest(MINIMAL_INPUT, "zh", "minimax-h3");
    expect(request.system).toBe(
      format.buildSystem({ outputLanguage: "clear, cinematic Chinese", locale: "zh" }),
    );
    expect(request.user.startsWith(format.userLead)).toBe(true);
    expect(request.user.endsWith(format.userTail)).toBe(true);
  });

  it("老节点（没有格式字段）行为完全不变：仍是 Seedance 规则与段落清单", () => {
    const request = buildQuickPromptRequest(MINIMAL_INPUT, "zh");
    expect(request.system).toContain("CINEDANCE V4");
    expect(request.user.endsWith(findQuickPromptFormat("seedance-2.5").userTail)).toBe(true);
    expect(request.user).toContain("POSITIVE CONSTRAINTS");
  });
});
