import { describe, expect, it } from "vitest";

import {
  AUDIO_REVERSE_SECTIONS,
  audioReverseSystemPrompt,
  audioReverseUserMessage,
  parseAudioReverseSections,
  pickAudioReverseSection,
} from "./audioReversePrompt";

const SAMPLE = `【类型】
音乐（city pop / 轻快女声）

【风格标签】
city pop, 80s synth, city night, female vocal

【情绪与速度】
明亮、松弛，约 112 BPM

【乐器与编曲】
电钢琴铺底，合成器 arpeggio，指弹贝斯，四四拍

【人声】
女声，日语

【歌词】
夜の窓に　街の灯り
まだ帰らない　帰れない

【台词】
无

【音效与环境】
远处车流，便利店门铃（约 0:42）

【生成提示词】
nagoya night drive city pop, 112 BPM, female Japanese vocal, analog synth arpeggio, warm electric piano
city pop, 80s synth, night drive, female vocal`;

describe("audioReverseSystemPrompt", () => {
  it("中英文都携带全部小节锚点", () => {
    for (const lang of ["zh", "en"] as const) {
      const prompt = audioReverseSystemPrompt(lang);
      for (const section of AUDIO_REVERSE_SECTIONS) {
        expect(prompt).toContain(`【${section}】`);
      }
    }
  });

  it("明确禁止编造歌词与翻译", () => {
    expect(audioReverseSystemPrompt("zh")).toContain("不翻译、不编造");
    expect(audioReverseSystemPrompt("en")).toContain("Never translate, never invent");
  });
});

describe("audioReverseUserMessage", () => {
  it("没有时长与名字时不留下空括号", () => {
    const message = audioReverseUserMessage({ label: "", lang: "zh" });
    expect(message).toContain("请分析这段音频。");
    expect(message).not.toContain("（）");
  });

  it("有时长时给出秒数", () => {
    const message = audioReverseUserMessage({ label: "demo", durationSec: 187, lang: "zh" });
    expect(message).toContain("名称：demo");
    expect(message).toContain("187s");
  });
});

describe("parseAudioReverseSections", () => {
  it("按【】小节切开", () => {
    const sections = parseAudioReverseSections(SAMPLE);
    expect(sections["类型"]).toContain("city pop");
    expect(sections["风格标签"]).toContain("city night");
    expect(sections["歌词"]).toContain("夜の窓に");
    expect(sections["生成提示词"]).toContain("nagoya night drive");
  });

  it("认 [类型] / 类型：/ **类型** 这几种写法", () => {
    const sections = parseAudioReverseSections(
      ["[类型]", "音乐", "", "类型：", "音乐", "", "**风格标签**", "ambient"].join("\n"),
    );
    // 同一小节出现两次时保留先出现的那个
    expect(sections["类型"]).toBe("音乐");
    expect(sections["风格标签"]).toBe("ambient");
  });

  it("标题与内容同在一行时也能接住内容", () => {
    const sections = parseAudioReverseSections("【风格标签】lo-fi, jazz\n【人声】无");
    expect(sections["风格标签"]).toBe("lo-fi, jazz");
  });

  it("认不出的内容归到上一节，不丢词", () => {
    const sections = parseAudioReverseSections("【台词】\n[00:03] A：你好\n补充：声音偏轻");
    expect(sections["台词"]).toContain("补充：声音偏轻");
  });
});

describe("pickAudioReverseSection", () => {
  it("取到对应小节", () => {
    expect(pickAudioReverseSection(SAMPLE, "歌词")).toContain("まだ帰らない");
  });

  it("「无」/ none / 空都当没有", () => {
    expect(pickAudioReverseSection(SAMPLE, "台词")).toBe("");
    expect(pickAudioReverseSection("【台词】\nnone", "台词")).toBe("");
    expect(pickAudioReverseSection("【台词】", "台词")).toBe("");
  });
});
