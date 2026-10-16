import { describe, expect, it } from "vitest";

import { AGENT_SKILLS, composeAgentSystemPrompt, findAgentSkill } from "./index";
import { tiangonxieyi } from "./tiangonxieyi";

const BASE = "你是 LenTalk Copilot 内置的创作助手。";

describe("findAgentSkill", () => {
  it("按 id 命中已登记的 SKILL", () => {
    expect(findAgentSkill("tiangonxieyi")).toBe(tiangonxieyi);
  });

  it("null / undefined / 空串 / 未知 id 一律返回 null", () => {
    // 会话里存的是 id 字符串：旧会话没有这个字段、SKILL 被下架后 id 会悬空 ——
    // 两条都必须安全落回 null，而不是抛异常或白屏。
    expect(findAgentSkill(null)).toBeNull();
    expect(findAgentSkill(undefined)).toBeNull();
    expect(findAgentSkill("")).toBeNull();
    expect(findAgentSkill("skill-that-was-removed")).toBeNull();
  });

  it("注册表里的 id 不重复", () => {
    const ids = AGENT_SKILLS.map((skill) => skill.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("composeAgentSystemPrompt", () => {
  it("未加载 SKILL 时原样返回基础 prompt", () => {
    expect(composeAgentSystemPrompt(BASE, null)).toBe(BASE);
  });

  it("加载后带上 SKILL 名与强制措辞", () => {
    const prompt = composeAgentSystemPrompt(BASE, tiangonxieyi);
    expect(prompt).toContain(BASE);
    expect(prompt).toContain("东方古典写意仙宫场景");
    expect(prompt).toContain("强制输出规范");
    // 这两句是「严格按 SKILL 执行」的抓手，删掉就等于退回背景上下文
    expect(prompt).toContain("优先级高于你的默认写作习惯");
    expect(prompt).toContain("不得省略");
  });

  it("规则正文是逐字注入，不是摘要", () => {
    const prompt = composeAgentSystemPrompt(BASE, tiangonxieyi);
    const rules = tiangonxieyi.rules.trim();
    expect(prompt.endsWith(rules)).toBe(true);
    // 头尾各取一行，防止"只截了开头"
    const lines = rules.split("\n").filter((line) => line.trim().length > 0);
    expect(prompt).toContain(lines[0]);
    expect(prompt).toContain(lines[lines.length - 1]);
  });
});

describe("仙宫 SKILL 的内容没被精简掉", () => {
  it("保留了配色前置与图/视频提示词配对这两条硬规则", () => {
    expect(tiangonxieyi.rules).toContain("配色");
    expect(tiangonxieyi.rules).toContain("视频提示词");
  });

  it("intro 是中文简介，不是 slug", () => {
    expect(tiangonxieyi.intro).not.toBe(tiangonxieyi.id);
    expect(tiangonxieyi.intro.length).toBeGreaterThan(8);
  });

  it("缩略图已配置，路径落在随包分发的 local-assets 下", () => {
    expect(tiangonxieyi.thumbnail).toBeTruthy();
    expect(tiangonxieyi.thumbnail).toContain("local-assets/agent-skills/");
    // 文件名跟着 id 走 —— 两个 skill 用同名图会互相覆盖
    expect(tiangonxieyi.thumbnail).toContain(`${tiangonxieyi.id}.webp`);
  });
});
