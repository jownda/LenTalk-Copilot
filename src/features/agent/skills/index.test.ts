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

describe("不良人武侠 SKILL 的内容没被精简掉", () => {
  const skill = findAgentSkill("seedance-buliangren-wuxia");

  it("已登记，名字/简介/缩略图都齐", () => {
    expect(skill).not.toBeNull();
    expect(skill?.name).toBe("不良人武侠导演");
    expect(skill?.intro).toContain("不良人");
    expect(skill?.thumbnail).toContain(`local-assets/agent-skills/${skill?.id}.webp`);
  });

  it("模式选择与两层输出结构都在（精简掉这些等于换了 skill）", () => {
    expect(skill?.rules).toContain("模式选择");
    // v2 起格式从「格式A/B/C 逐镜」改成「全局设定层 + 段落层」，示例必须跟着换
    expect(skill?.rules).toContain("提示词格式（两层结构");
    expect(skill?.rules).toContain("【视频基础】");
    expect(skill?.rules).toContain("【段落剧情】");
  });

  it("规则是全文，不是截断 —— 尾部触发词也必须在", () => {
    // skill 曾经因为模板字符串被截断过一半，尾行断言就是防这个。
    // v2 删掉了全部 cm/°/cm/s 参数表，全文从 40K 降到 20K 左右，阈值随之下调。
    expect(skill?.rules.length ?? 0).toBeGreaterThan(15000);
    expect(skill?.rules).toContain("用户提供包含兵器交锋、眼神对峙、武侠动作的剧本");
  });

  it("模式选择走文字提问，不再要求调用不存在的弹窗工具", () => {
    // Agent 只有 canvas.* 工具，写「必须使用 AskUserQuestion」会让模型去调一个不存在的工具，
    // 要么报错要么空转。四个模式必须以纯文本列表的形式问出来。
    expect(skill?.rules).toContain("没有弹窗选择工具");
    expect(skill?.rules).toContain("请回复序号选择拍摄模式");
    ["武打戏", "对峙戏", "混合模式", "自动判断"].forEach((mode) => {
      expect(skill?.rules).toContain(mode);
    });
    // 提问后必须停下，否则用户还没选就被写完了
    expect(skill?.rules).toContain("提问后必须停下");
  });
});

describe("SKILL 的提问式流程不被强制产出覆盖", () => {
  it("system prompt 明确要求先提问再等回复", () => {
    const skill = findAgentSkill("seedance-buliangren-wuxia");
    const prompt = composeAgentSystemPrompt(BASE, skill);
    expect(prompt).toContain("停下等待回复");
  });
});

describe("不良人 SKILL 的输出硬性约束", () => {
  const rules = findAgentSkill("seedance-buliangren-wuxia")?.rules ?? "";

  it("总时长写在提示词第一行", () => {
    expect(rules).toContain("### 输出硬性约束");
    expect(rules).toContain("总时长：15秒｜无BGM｜无字幕｜无画外音");
    // 示例的第一行就是总时长 —— 模型照抄示例的概率远高于照抄规则
    expect(rules).toContain("总时长：15秒｜无BGM");
  });

  it("每个完整示例的第一行都是总时长，不是【视频基础】也不是镜头", () => {
    const blocks = [...rules.matchAll(/```([\s\S]*?)```/g)].map((match) => match[1]);
    const fullPrompts = blocks.filter(
      // 模板块只有骨架，没有结尾那句；用尾句把「完整示例」和「骨架」区分开
      (block) => block.includes("【视频基础】") && block.includes("画面稳定，角色一致，无穿帮变形。"),
    );
    expect(fullPrompts.length).toBeGreaterThanOrEqual(3);
    for (const block of fullPrompts) {
      expect(block.trimStart().startsWith("总时长：")).toBe(true);
      // 两层结构：全局块齐全 + 每一幕七个字段齐全
      ["【光影质感】", "【世界背景】", "【角色】", "【场景与环境】", "【段落剧情】"].forEach((field) => {
        expect(block).toContain(field);
      });
      ["站位：", "镜头：", "台词：无", "情绪：", "特效：", "声音："].forEach((field) => {
        expect(block).toContain(field);
      });
    }
  });

  it("成品示例里没有 cm / ° / 每秒参数（参数表已整张删除）", () => {
    // ❌ 反例块里必须保留错误写法，所以按「代码块前面紧邻的文字」判断它是不是反例
    const blocks = [...rules.matchAll(/```([\s\S]*?)```/g)].map((match) => ({
      body: match[1],
      isBadExample: rules.slice(Math.max(0, (match.index ?? 0) - 40), match.index ?? 0).includes("❌"),
    }));
    for (const { body, isBadExample } of blocks) {
      if (isBadExample) continue;
      expect(body).not.toMatch(/\d+\s*cm/);
      expect(body).not.toMatch(/\d+\s*°/);
      expect(body).not.toMatch(/速度\s*\d/);
    }
  });

  it("所有示例块都不再出现热血值/色调/画幅/风格", () => {
    // 规则文本里可以写「禁止色调」，但示例块里一个字都不能留：
    // 示例是模型的直接模仿对象，示例带什么它就会写什么
    const blocks = [...rules.matchAll(/```([\s\S]*?)```/g)].map((match) => match[1]);
    expect(blocks.length).toBeGreaterThan(5);
    for (const block of blocks) {
      expect(block).not.toMatch(/。?热血值：\d/);
      expect(block).not.toContain("色调");
      expect(block).not.toContain("9:16 | ");
      expect(block).not.toContain("3D质感");
      expect(block).not.toContain("画质引擎");
      // 打击感等级/技法统计原来写在示例块的尾部，会被当成提示词的一部分照抄
      expect(block).not.toContain("打击感等级");
      expect(block).not.toContain("技法统计");
    }
  });

  it("强度档降级成内部推演，不再要求写进成品", () => {
    expect(rules).toContain("仅供推演，禁止写进成品");
    // 旧措辞「每个提示词结尾标注热血等级」正是让它出现在成品里的原因
    expect(rules).not.toContain("每个提示词结尾标注");
  });
});
