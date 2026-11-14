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

/**
 * 写实近身搏斗的规则来自第三方 Skill 包（`docs/skills/realistic-close-combat/`）。
 * 用户要求「选中这个格式 = 按 skill 完整版写」，所以这组断言守的是**完整**：
 * 一旦有人把它改成摘要版，模型就会开始现编招式和模板。
 */
describe("写实近身搏斗的规则（完整版 SKILL 内联）", () => {
  const format = findQuickPromptFormat("realistic-close-combat");

  it("按 id 命中，没有悄悄回落成默认格式", () => {
    expect(format.id).toBe("realistic-close-combat");
    expect(format.name).toBe("写实近身搏斗");
  });

  it("system 里是 SKILL 原文的硬规则，不是改写摘要", () => {
    const system = format.buildSystem({ outputLanguage: "clear, cinematic Chinese", locale: "zh" });
    expect(system).toContain("禁止笼统词代替画面");
    expect(system).toContain("打斗逐 0.5s 规划并交付");
    expect(system).toContain("必须读取并使用本地库");
  });

  it("17 份 references 与模板 / 示例全部内联成附录（运行时没有文件系统可读）", () => {
    const system = format.buildSystem({ outputLanguage: "clear, cinematic Chinese", locale: "zh" });
    for (const doc of [
      "references/action-move-library.md",
      "references/camera-move-library.md",
      "references/chinese-action-writing.md",
      "references/combo-library.md",
      "references/style-profiles.md",
      "references/contact-physics.md",
      "templates/prompt-template.md",
      "examples/example-05-half-second-library.md",
    ]) {
      expect(system).toContain(`附录：${doc}`);
    }
  });

  it("正文里的文件路径被改写成附录引用，模型不会去找不存在的文件", () => {
    const system = format.buildSystem({ outputLanguage: "clear, cinematic Chinese", locale: "zh" });
    expect(system).not.toContain("`templates/prompt-template.md`");
    expect(system).toContain("《附录 templates/prompt-template.md》");
  });

  it("体量守住完整版下限（摘要版会小一个数量级）", () => {
    const system = format.buildSystem({ outputLanguage: "clear, cinematic Chinese", locale: "zh" });
    expect(system.length).toBeGreaterThan(80000);
  });

  it("追加约束压过 skill 的旧口径：只出成品、FORMAT MODE 不写画幅", () => {
    const system = format.buildSystem({ outputLanguage: "clear, cinematic Chinese", locale: "zh" });
    expect(system).toContain("本链路的追加约束");
    expect(system).toContain("只输出成品提示词本身");
    expect(system).toContain("不写画幅比例");
    expect(system).toContain("clear, cinematic Chinese");
  });

  it("userTail 给的是战斗 12 段骨架 + 逐格要求", () => {
    expect(format.userTail).toContain("ACTION TIMING");
    expect(format.userTail).toContain("IMPACT DELIVERY");
    expect(format.userTail).toContain("CHARACTER / WEAPON ANCHORS");
    expect(format.userTail).toContain("0.5s time cell");
  });

  it("生成链路真的用这套规则与段落清单", () => {
    const request = buildQuickPromptRequest(MINIMAL_INPUT, "zh", "realistic-close-combat");
    expect(request.system).toBe(
      format.buildSystem({ outputLanguage: "clear, cinematic Chinese", locale: "zh" }),
    );
    expect(request.user.startsWith(format.userLead)).toBe(true);
    expect(request.user.endsWith(format.userTail)).toBe(true);
  });
});

/**
 * 超能能量搏斗 = 写实近身搏斗的超能变体。
 * 三份公开 skill 的合成（fight-scene-director / seedance-2-5-fight-director / higgsfield 08-anime-action），
 * 源文件在 `docs/skills/superpower-energy-combat/`。这组断言守两件事：
 * ① 仍是完整版（不是摘要）；② 超能核心（力有来源 / 先接触后特效 / 破坏累积）真的进了 system。
 */
describe("超能能量搏斗的规则（完整版 SKILL 内联）", () => {
  const format = findQuickPromptFormat("superpower-energy-combat");

  it("按 id 命中，没有悄悄回落成默认格式", () => {
    expect(format.id).toBe("superpower-energy-combat");
    expect(format.name).toBe("超能能量搏斗");
  });

  it("三条超能底线在 system 里原样存在", () => {
    const system = format.buildSystem({ outputLanguage: "clear, cinematic Chinese", locale: "zh" });
    expect(system).toContain("力必须有来源");
    expect(system).toContain("先接触，后特效");
    expect(system).toContain("破坏只增不减");
  });

  it("新增的超能 reference 与示例全部内联成附录", () => {
    const system = format.buildSystem({ outputLanguage: "clear, cinematic Chinese", locale: "zh" });
    for (const doc of [
      "references/superpower-force-chain.md",
      "references/impact-budget.md",
      "references/destruction-and-environment.md",
      "references/energy-blast.md",
      "references/energy-move-library.md",
      "references/ability-system.md",
      "examples/example-06-superpower-energy-15s.md",
    ]) {
      expect(system).toContain(`附录：${doc}`);
    }
  });

  it("能量原词库真的全量进来了（末条 EN-88 必须在）", () => {
    const system = format.buildSystem({ outputLanguage: "clear, cinematic Chinese", locale: "zh" });
    expect(system).toContain("EN-01");
    expect(system).toContain("EN-79");
    expect(system).toContain("EN-88");
  });

  it("打击感与破坏的口径进了 system，不是被摘要掉", () => {
    const system = format.buildSystem({ outputLanguage: "clear, cinematic Chinese", locale: "zh" });
    expect(system).toContain("接触帧可读");
    expect(system).toContain("反作用");
    expect(system).toContain("地形改变");
    expect(system).toContain("对波");
  });

  it("体量守住完整版下限（比写实版更大，摘要版会小一个数量级）", () => {
    const system = format.buildSystem({ outputLanguage: "clear, cinematic Chinese", locale: "zh" });
    expect(system.length).toBeGreaterThan(100000);
  });

  it("userTail 给的是 14 段骨架 + 能量六阶段 + 破坏账本要求", () => {
    expect(format.requiredHeadings).toHaveLength(14);
    for (const heading of format.requiredHeadings ?? []) {
      expect(format.userTail).toContain(heading);
    }
    expect(format.userTail).toContain("ENERGY AND EFFECT SYSTEM");
    expect(format.userTail).toContain("DESTRUCTION AND ENVIRONMENT");
    expect(format.userTail).toContain("six stages");
    expect(format.userTail).toContain("0.5s time cell");
  });

  it("追加约束把三条底线再压一遍（冲突时以本节为准）", () => {
    const system = format.buildSystem({ outputLanguage: "clear, cinematic Chinese", locale: "zh" });
    expect(system).toContain("本链路的追加约束");
    expect(system).toContain("三条超能底线不可妥协");
    expect(system).toContain("对轰必须写满五拍");
    expect(system).toContain("只输出成品提示词本身");
  });

  it("生成链路真的用这套规则与段落清单", () => {
    const request = buildQuickPromptRequest(MINIMAL_INPUT, "zh", "superpower-energy-combat");
    expect(request.system).toBe(
      format.buildSystem({ outputLanguage: "clear, cinematic Chinese", locale: "zh" }),
    );
    expect(request.user.startsWith(format.userLead)).toBe(true);
    expect(request.user.endsWith(format.userTail)).toBe(true);
  });
});

/**
 * 武侠 / 仙侠打斗 = 写实近身搏斗的东方武学变体，一个格式装两条线。
 * 三份公开材料的合成（traditional-wuxia / wuxia-blade-film / wushu-action-v7）
 * + 自建仙侠体系，源文件在 `docs/skills/wuxia-combat/`。这组断言守三件事：
 * ① 仍是完整版（不是摘要）；② 武侠特有的东西（定档、轻功锚点、兵器语法、留白）真的进了 system；
 * ③ 仙侠特有的东西（法术六段、法阵三要素、符箓法宝账本、剑芒、打断、代价）也真的进了 system，
 *    而且两条线各有自己的判断依据，不会互相顶掉。
 */
describe("武侠 / 仙侠打斗的规则（完整版 SKILL 内联）", () => {
  const format = findQuickPromptFormat("wuxia-combat");
  const system = format.buildSystem({ outputLanguage: "clear, cinematic Chinese", locale: "zh" });

  it("按 id 命中，没有悄悄回落成默认格式", () => {
    expect(format.id).toBe("wuxia-combat");
    expect(format.name).toBe("武侠 / 仙侠");
  });

  it("三条底线在 system 里原样存在（分线版表述）", () => {
    expect(system).toContain("档不越级");
    expect(system).toContain("力有来源");
    expect(system).toContain("先接触，后反应");
  });

  it("默认档位是写实武侠，且明确写了无光效", () => {
    expect(system).toContain("写实武侠");
    expect(system).toContain("无光效");
    // 不许因为有「内力」章节，就让默认档也跟着发光。
    expect(system).toContain("用户没点名「内力");
  });

  it("新增的武侠 reference 与示例全部内联成附录", () => {
    for (const doc of [
      "references/wuxia-style-tiers.md",
      "references/innerforce-and-qi.md",
      "references/innerforce-move-library.md",
      "references/qinggong-and-airborne.md",
      "references/wuxia-weapon-grammar.md",
      "references/wuxia-aesthetic.md",
      "examples/example-06-wuxia-blade-15s.md",
    ]) {
      expect(system).toContain(`附录：${doc}`);
    }
  });

  it("仙侠专属的 7 份 reference 与示例全部内联成附录", () => {
    for (const doc of [
      "references/xianxia-lane.md",
      "references/spell-and-ritual.md",
      "references/talisman-and-artifact.md",
      "references/spirit-light-and-blade-glow.md",
      "references/formation-and-array.md",
      "references/xianxia-move-library.md",
      "references/xianxia-aesthetic.md",
      "references/blood-and-gore.md",
      "examples/example-07-xianxia-array-15s.md",
    ]) {
      expect(system).toContain(`附录：${doc}`);
    }
  });

  it("超能专属的四份文件一个都没混进来", () => {
    for (const doc of [
      "references/energy-blast.md",
      "references/energy-move-library.md",
      "references/ability-system.md",
      "references/superpower-force-chain.md",
    ]) {
      expect(system).not.toContain(`附录：${doc}`);
    }
  });

  it("内力原词库真的全量进来了（QI-01 ~ QI-60 首尾必须在）", () => {
    expect(system).toContain("QI-01");
    expect(system).toContain("QI-30");
    expect(system).toContain("QI-60");
  });

  it("法术原词库真的全量进来了（FA-01 ~ FA-86 首尾必须在）", () => {
    expect(system).toContain("FA-01");
    expect(system).toContain("FA-50");
    expect(system).toContain("FA-86");
  });

  it("轻功、兵器、留白、先到后动这些武侠专属规则都在", () => {
    expect(system).toContain("起跳面");          // 轻功五锚点
    expect(system).toContain("落地必须卸力");
    expect(system).toContain("剑走线");          // 兵器四类
    expect(system).toContain("兵器账本");
    expect(system).toContain("留白");            // 美学
    expect(system).toContain("先到后动");        // 港式节奏
    expect(system).toContain("一秒生死");        // 长短之争
  });

  it("仙侠专属规则都在：六段、法阵三要素、道具账本、剑芒、打断、代价", () => {
    expect(system).toContain("起诀");            // 法术六段
    expect(system).toContain("引灵");
    expect(system).toContain("凝形");
    expect(system).toContain("阵眼");            // 法阵三要素
    expect(system).toContain("阵旗");
    expect(system).toContain("符箓");            // 道具
    expect(system).toContain("法宝");
    expect(system).toContain("剑芒");            // 光
    expect(system).toContain("灵光");
    expect(system).toContain("打断");            // 仙侠独有失败方式
    expect(system).toContain("真元");            // 预算
    expect(system).toContain("借来的力要还");    // 代价
  });

  it("v1.5 新增能力都在：逐拍公式、能量实体化、血肉分级、声线绑定", () => {
    expect(system).toContain("仙侠特效逐拍公式");
    expect(system).toContain("镜头机位 + 人物 + 锚点 + 技能 + 粒子 + 光效 + 撞击位置 + 物理反馈");
    expect(system).toContain("能量实体化");
    expect(system).toContain("回收或转移");       // 能量生命周期闭合
    expect(system).toContain("切断帧");           // 断肢三段
    expect(system).toContain("不新增第二个声源"); // 声线双锚
    expect(system).toContain("藏医2");            // 重名 @ 去重
  });

  it("分线规则写进去了：先分线再定档，两条线不许串", () => {
    expect(system).toContain("分线");
    expect(system).toContain("武侠线与仙侠线");
    expect(system).toContain("力的来源在不在身体里");
  });

  it("不许擅自添加门派、道统与招式名（这条必须显式写进去）", () => {
    expect(system).toContain("不擅自添加门派");
    expect(system).toContain("道统");
    expect(system).toContain("不自己编");
  });

  it("体量守住完整版下限（指标版会小一个数量级）", () => {
    expect(system.length).toBeGreaterThan(160000);
  });

  it("userTail 给的是 14 段骨架 + 分线定档声明 + 四阶段交锋", () => {
    expect(format.requiredHeadings).toHaveLength(14);
    for (const heading of format.requiredHeadings ?? []) {
      expect(format.userTail).toContain(heading);
    }
    expect(format.userTail).toContain("QI AND TECHNIQUE SYSTEM");
    expect(format.userTail).toContain("realistic wuxia");
    expect(format.userTail).toContain("xianxia lane");
    expect(format.userTail).toContain("interrupted");
    expect(format.userTail).toContain("rise → carry → turn → close");
    expect(format.userTail).toContain("0.5s time cell");
  });

  it("追加约束把两条线的底线再压一遍（冲突时以本节为准）", () => {
    expect(system).toContain("本链路的追加约束");
    expect(system).toContain("武侠线三条底线不可妥协");
    expect(system).toContain("仙侠线三条额外底线");
    expect(system).toContain("先有术后有光");
    expect(system).toContain("轻功落地必须卸力");
    expect(system).toContain("只输出成品提示词本身");
  });

  it("生成链路真的用这套规则与段落清单", () => {
    const request = buildQuickPromptRequest(MINIMAL_INPUT, "zh", "wuxia-combat");
    expect(request.system).toBe(
      format.buildSystem({ outputLanguage: "clear, cinematic Chinese", locale: "zh" }),
    );
    expect(request.user.startsWith(format.userLead)).toBe(true);
    expect(request.user.endsWith(format.userTail)).toBe(true);
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
