import { describe, expect, it } from "vitest";

import {
  countTags,
  hasTag,
  joinTagList,
  parseTagList,
  SUNO_NEGATIVE_TAG_GROUPS,
  SUNO_STYLE_TAG_GROUPS,
  toggleTag,
  type SunoTagGroup,
} from "./sunoTagLibrary";

/**
 * 标签库的两类回归：
 *   1. **纯函数语义** —— toggle 必须等价于「手改那个输入框」，否则点选与手填
 *      会写出两种形状的字段（一个标签被重复追加、或移除后顺序被打乱）。
 *   2. **数据不变量** —— chip 高亮是按值判定的，同一个词出现在两个分组里
 *      会让「点 A 组、B 组也亮」。这条只能靠测试守着，人眼扫 400 个词扫不出来。
 */

const ALL_GROUPS: SunoTagGroup[] = [...SUNO_STYLE_TAG_GROUPS, ...SUNO_NEGATIVE_TAG_GROUPS];

describe("parseTagList / joinTagList", () => {
  it("按英文逗号拆分并去掉空白", () => {
    expect(parseTagList("古风, 钢琴, 治愈")).toEqual(["古风", "钢琴", "治愈"]);
  });

  it("容忍中文逗号 / 顿号 / 分号 —— 用户从别处粘过来的一串不该变成一个巨型标签", () => {
    expect(parseTagList("古风，钢琴、治愈；民谣")).toEqual(["古风", "钢琴", "治愈", "民谣"]);
  });

  it("丢空项：尾随逗号、连续逗号、纯空白都不产出空标签", () => {
    expect(parseTagList("古风,,  ,钢琴,")).toEqual(["古风", "钢琴"]);
  });

  it("空值与空白值解析为空数组", () => {
    expect(parseTagList("")).toEqual([]);
    expect(parseTagList("   ")).toEqual([]);
  });

  it("回写统一用「, 」—— 手填与点选产生同一形状", () => {
    expect(joinTagList(["古风", "钢琴"])).toBe("古风, 钢琴");
    expect(joinTagList([])).toBe("");
  });

  it("拆了再拼是幂等的（不会越拼越乱）", () => {
    const once = joinTagList(parseTagList("古风，钢琴、治愈"));
    expect(joinTagList(parseTagList(once))).toBe(once);
    expect(once).toBe("古风, 钢琴, 治愈");
  });
});

describe("toggleTag", () => {
  it("不在值里就追加到末尾", () => {
    expect(toggleTag("古风", "钢琴")).toBe("古风, 钢琴");
  });

  it("从空值开始也成立（首次点选不该带出前导逗号）", () => {
    expect(toggleTag("", "古风")).toBe("古风");
  });

  it("已在值里就移除，且保持其余标签的原顺序", () => {
    expect(toggleTag("古风, 钢琴, 治愈", "钢琴")).toBe("古风, 治愈");
  });

  it("点两次回到原值 —— 这是「再点一下取消」的核心保证", () => {
    const original = "古风, 钢琴";
    expect(toggleTag(toggleTag(original, "治愈"), "治愈")).toBe(original);
  });

  it("高亮的判据与 toggle 的判据同源：hasTag 为真时 toggle 一定走移除", () => {
    const value = "古风, 钢琴";
    expect(hasTag(value, "钢琴")).toBe(true);
    expect(toggleTag(value, "钢琴")).toBe("古风");
    expect(hasTag(value, "二胡")).toBe(false);
    expect(toggleTag(value, "二胡")).toBe("古风, 钢琴, 二胡");
  });

  it("用户手填了中文逗号的串，点选也能正确移除", () => {
    expect(toggleTag("古风，钢琴", "古风")).toBe("钢琴");
  });

  it("countTags 与已选项数一致", () => {
    expect(countTags("")).toBe(0);
    expect(countTags("古风,, 钢琴")).toBe(2);
    expect(toggleTag("古风", "钢琴")).toBe(joinTagList(["古风", "钢琴"]));
  });
});

describe("标签库数据不变量", () => {
  it("分组 key 唯一", () => {
    const keys = ALL_GROUPS.map((group) => group.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("每个分组的 labelKey 都指向 tagGroups 命名空间", () => {
    for (const group of ALL_GROUPS) {
      expect(group.labelKey).toBe(`node.audioGen.suno.tagGroups.${group.key}`);
    }
  });

  it("正向库里没有任何重复标签（含跨组）—— 否则高亮会串组", () => {
    const flat = SUNO_STYLE_TAG_GROUPS.flatMap((group) => [...group.tags]);
    const duplicates = flat.filter((tag, index) => flat.indexOf(tag) !== index);
    expect([...new Set(duplicates)]).toEqual([]);
  });

  it("负向库里没有任何重复标签（含跨组）", () => {
    const flat = SUNO_NEGATIVE_TAG_GROUPS.flatMap((group) => [...group.tags]);
    const duplicates = flat.filter((tag, index) => flat.indexOf(tag) !== index);
    expect([...new Set(duplicates)]).toEqual([]);
  });

  it("标签非空且没有前后空白 —— 空白会让 toggle 匹配不上", () => {
    for (const group of ALL_GROUPS) {
      for (const tag of group.tags) {
        expect(tag.length).toBeGreaterThan(0);
        expect(tag).toBe(tag.trim());
        expect(tag).not.toContain(",");
        expect(tag).not.toContain("，");
      }
    }
  });

  it("每个分组都不为空", () => {
    for (const group of ALL_GROUPS) {
      expect(group.tags.length).toBeGreaterThan(0);
    }
  });

  it("风格库规模够用（防重构时被误删成空壳）", () => {
    const total = SUNO_STYLE_TAG_GROUPS.reduce((sum, group) => sum + group.tags.length, 0);
    expect(total).toBeGreaterThanOrEqual(300);
  });

  it("排除库规模够用", () => {
    const total = SUNO_NEGATIVE_TAG_GROUPS.reduce((sum, group) => sum + group.tags.length, 0);
    expect(total).toBeGreaterThanOrEqual(60);
  });
});
