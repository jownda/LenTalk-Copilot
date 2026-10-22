import { describe, expect, it } from "vitest";

import {
  MMX_DEFAULT_LANGUAGE,
  MMX_SYSTEM_VOICES,
  MMX_VOICE_LANGUAGES,
  findMmxSystemVoice,
  isMmxSystemVoiceId,
  mmxVoiceGroupOf,
  mmxVoicesForLanguage,
  resolveMmxVoicePreview,
  shouldCaptureMmxVoicePreview,
} from "./mmxVoiceLibrary";

/**
 * 官方音色数据不变量。
 *
 * 这份表是**抓取产物**（`mmxVoiceLibrary.json`，327 条），人眼不可能逐条审。所以这里盯的是
 * 「结构上必须成立、一旦破坏说明抓取或清洗出错了」的那些条件：
 *
 * - id 唯一 —— 它是 `speech-2.8` 的 `voice` 值, 重复会让选择器选到另一条;
 * - 每条都有 id/名字/语言 —— 少了就没法展示也没法调用;
 * - 有试听的必须给 URL, 没试听的只能是 legacy —— 否则 UI 会出现一个点不动的试听键;
 * - 分组只可能是 女/男/童 —— 出现第四种说明标签清洗漏了新维度。
 *
 * ⚠️ 表里**只有**官方文档「系统音色列表」收录的 327 条 —— 实跑证明音色库独有的 320 条平台
 * 不认（`Voice not found`），已在生成数据时裁掉，永远不要把它们加回来（除非官方改了取值域）。
 */
describe("官方音色数据不变量", () => {
  it("规模符合预期(官方文档收录: 327 条)", () => {
    expect(MMX_SYSTEM_VOICES).toHaveLength(327);
  });

  it("id 唯一 —— 它是主键, 也是发给平台的 voice 值", () => {
    const ids = MMX_SYSTEM_VOICES.map((voice) => voice.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("每条都有 id / 名字 / 语言", () => {
    const broken = MMX_SYSTEM_VOICES.filter((voice) => !voice.id || !voice.name || !voice.lang);
    expect(broken).toEqual([]);
  });

  it("gender 只有 male / female", () => {
    const genders = new Set(MMX_SYSTEM_VOICES.map((voice) => voice.gender));
    expect([...genders].sort()).toEqual(["female", "male"]);
  });

  it("试听 URL: 有就是 https, 没有的必须是 legacy(官网确实没有样本)", () => {
    for (const voice of MMX_SYSTEM_VOICES) {
      if (voice.sample) {
        expect(voice.sample.startsWith("https://"), `${voice.id} 的试听不是 https`).toBe(true);
      } else {
        expect(voice.legacy, `${voice.id} 没有试听却不是 legacy`).toBe(true);
      }
    }
  });

  it("legacy 音色没有描述也没有试听(它们是 v1 老音色, 官方音色库里查不到)", () => {
    for (const voice of MMX_SYSTEM_VOICES.filter((item) => item.legacy)) {
      expect(voice.sample).toBe("");
      expect(voice.desc).toBe("");
    }
  });

  it("非 legacy 的都有官方描述 —— 这正是「音色带描述」的来源", () => {
    const missing = MMX_SYSTEM_VOICES.filter((voice) => !voice.legacy && !voice.desc);
    expect(missing.map((voice) => voice.id)).toEqual([]);
  });

  it("实跑验证过的音色必须在表里(2026-09-20, Chinese (Mandarin)_Gentleman 200/OK)", () => {
    expect(isMmxSystemVoiceId("Chinese (Mandarin)_Gentleman")).toBe(true);
  });
});

describe("mmxVoiceGroupOf", () => {
  it("童声按年龄切, 不按性别切 —— 儿童里男女都有, 都归「童声」", () => {
    const children = MMX_SYSTEM_VOICES.filter((voice) => voice.age === "儿童");
    expect(children.length).toBeGreaterThan(0);
    expect(children.every((voice) => mmxVoiceGroupOf(voice) === "child")).toBe(true);
    // 儿童里确实两种性别都有, 否则这条规则就没意义
    expect(new Set(children.map((voice) => voice.gender)).size).toBe(2);
  });

  it("非儿童按性别分", () => {
    for (const voice of MMX_SYSTEM_VOICES.filter((item) => item.age !== "儿童")) {
      expect(mmxVoiceGroupOf(voice)).toBe(voice.gender);
    }
  });
});

describe("语言维度", () => {
  it("默认语言在列表里, 且是中文普通话", () => {
    expect(MMX_DEFAULT_LANGUAGE).toBe("中文-普通话");
    expect(MMX_VOICE_LANGUAGES).toContain(MMX_DEFAULT_LANGUAGE);
  });

  it("语言列表不重复, 且覆盖表里出现过的每一种语言", () => {
    const fromData = new Set(MMX_SYSTEM_VOICES.map((voice) => voice.lang));
    expect(new Set(MMX_VOICE_LANGUAGES).size).toBe(MMX_VOICE_LANGUAGES.length);
    expect([...fromData].every((lang) => MMX_VOICE_LANGUAGES.includes(lang))).toBe(true);
  });

  it("常用语言排在前面(中文、粤语、英语、日韩…)", () => {
    expect(MMX_VOICE_LANGUAGES.slice(0, 3)).toEqual(["中文-普通话", "中文-粤语", "英语"]);
  });

  it("按语言过滤后只留该语言, 且过滤结果加起来等于总数", () => {
    let sum = 0;
    for (const lang of MMX_VOICE_LANGUAGES) {
      const subset = mmxVoicesForLanguage(lang);
      expect(subset.every((voice) => voice.lang === lang)).toBe(true);
      expect(subset.length).toBeGreaterThan(0);
      sum += subset.length;
    }
    expect(sum).toBe(MMX_SYSTEM_VOICES.length);
  });

  it("传空语言等于不过滤", () => {
    expect(mmxVoicesForLanguage("")).toHaveLength(MMX_SYSTEM_VOICES.length);
  });
});

/**
 * 「被裁掉的平台不认」—— 这不是洁癖, 是**实跑踩出来的**。
 *
 * 2026-09-20 用音色库独有的 `Chinese_casual_instructor_nv1` 调 `speech-2.8`,
 * 平台直接返回 `Voice not found`。官方音色库那 603 条是海螺**音频产品**的音色表
 * (里面还混着 `moss_audio_<uuid>` 这类用户向音色), 不等于 API 支持的 `voice` 取值;
 * 只有官方文档「系统音色列表」收录的 327 条才是平台认的 —— 所以数据文件里只有它们。
 * 下面这几条把「库独有的不进表」锁住, 免得以后有人把 603 条整包搬回来。
 */
describe("音色库独有的 320 条不在表内(实跑: Voice not found)", () => {
  it("踩坑的那条 Chinese_casual_instructor_nv1 彻底查不到 —— 它发不出去", () => {
    expect(isMmxSystemVoiceId("Chinese_casual_instructor_nv1")).toBe(false);
    expect(findMmxSystemVoice("Chinese_casual_instructor_nv1")).toBeUndefined();
    expect(mmxVoicesForLanguage("中文-普通话").some((v) => v.id === "Chinese_casual_instructor_nv1")).toBe(false);
  });

  it("moss_audio 用户向音色也不该出现在表里", () => {
    expect(MMX_SYSTEM_VOICES.some((voice) => voice.id.startsWith("moss_audio"))).toBe(false);
  });

  it("中文普通话: 58 条(已确认子集)", () => {
    expect(mmxVoicesForLanguage("中文-普通话")).toHaveLength(58);
  });
});

describe("id 查询", () => {
  it("能查到, 且查到的就是那一条", () => {
    const voice = MMX_SYSTEM_VOICES[0];
    expect(findMmxSystemVoice(voice.id)).toBe(voice);
    expect(isMmxSystemVoiceId(voice.id)).toBe(true);
  });

  it("GT 系的假音色查不到 —— 早期版本往 voice 里写过 alloy, 它必须被判为无效", () => {
    expect(isMmxSystemVoiceId("alloy")).toBe(false);
    expect(findMmxSystemVoice("alloy")).toBeUndefined();
  });

  it("空串查不到", () => {
    expect(isMmxSystemVoiceId("")).toBe(false);
  });
});

/**
 * 「生成一次, 自动变成试听」—— legacy 那 44 条没有官方样本, 但合成结果本来就落了盘,
 * 白拿的试听没理由不要。这两个纯函数把「要不要收」「播哪个」锁住。
 */
describe("本地试听收录(legacy 音色合成后自动有试听)", () => {
  it("有官方样本的音色不值得收编 —— 官方的更好, 也不该被本地缓存顶掉", () => {
    const withSample = MMX_SYSTEM_VOICES.find((voice) => voice.sample);
    expect(withSample).toBeDefined();
    expect(shouldCaptureMmxVoicePreview(withSample)).toBe(false);
  });

  it("legacy 音色(无样本)值得收编; 查不到的音色不收", () => {
    const legacy = MMX_SYSTEM_VOICES.find((voice) => voice.legacy);
    expect(legacy).toBeDefined();
    expect(shouldCaptureMmxVoicePreview(legacy)).toBe(true);
    expect(shouldCaptureMmxVoicePreview(undefined)).toBe(false);
  });

  it("试听源优先级: 官方样本 > 本地缓存 > 空(不渲染试听键)", () => {
    const official = MMX_SYSTEM_VOICES.find((voice) => voice.sample)!;
    const legacy = MMX_SYSTEM_VOICES.find((voice) => voice.legacy)!;
    expect(resolveMmxVoicePreview(official, { [official.id]: "/tmp/override.mp3" })).toBe(official.sample);
    expect(resolveMmxVoicePreview(legacy, { [legacy.id]: "/assets/voice-x.mp3" })).toBe("/assets/voice-x.mp3");
    expect(resolveMmxVoicePreview(legacy, {})).toBe("");
  });
});
