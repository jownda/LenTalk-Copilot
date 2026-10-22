import { describe, expect, it } from "vitest";

import { resolveAudioVoiceCatalog, resolveVoiceStyle } from "./audioVoices";

/**
 * 音色表是「平台事实」的镜像 —— 写错一个字, 用户看到的就是一个不存在的音色。
 * 这几条断言锁住的是: **不同模型的音色数量真的不一样**。
 *
 * 之前所有模型共用写死的 6 音色(alloy/echo/fable/onyx/nova/shimmer), 那是 tts-1 的清单;
 * GM 系列明明有 30 种预置音色, 却被显示成 6 种。
 */
describe("resolveAudioVoiceCatalog", () => {
  it("GM-3.1 Flash / GM-2.5 Pro 走 30 音色表(带风格说明, 仅 wav, 支持风格指令)", () => {
    for (const model of ["gemini-3.1-flash-tts", "gemini-2.5-pro-tts", "GM-3.1 Flash TTS"]) {
      const catalog = resolveAudioVoiceCatalog(model);
      expect(catalog.voices, model).toHaveLength(30);
      expect(catalog.defaultVoice, model).toBe("Zephyr");
      expect(catalog.formatOptions, model).toEqual(["wav"]);
      expect(catalog.defaultFormat, model).toBe("wav");
      expect(catalog.supportsInstructions, model).toBe(true);
      // 首尾各抽查一个, 确认顺序与平台一致(顺序会体现在下拉里)。
      expect(catalog.voices[0].id, model).toBe("Zephyr");
      expect(catalog.voices[0].style, model).toBe("明亮 / Bright");
      expect(catalog.voices[29].id, model).toBe("Sulafat");
      expect(catalog.voices[29].style, model).toBe("温暖 / Warm");
    }
  });

  it("GT TTS / GT TTS HD 是 6 音色、6 种输出格式、无风格指令、有语速", () => {
    for (const model of ["tts-1", "tts-1-hd"]) {
      const catalog = resolveAudioVoiceCatalog(model);
      expect(
        catalog.voices.map((voice) => voice.id),
        model,
      ).toEqual(["alloy", "echo", "fable", "onyx", "nova", "shimmer"]);
      expect(catalog.defaultVoice, model).toBe("alloy");
      expect(catalog.formatOptions, model).toEqual(["mp3", "opus", "aac", "flac", "wav", "pcm"]);
      expect(catalog.defaultFormat, model).toBe("mp3");
      expect(catalog.supportsInstructions, model).toBe(false);
      expect(catalog.speed, model).toMatchObject({ min: 0.25, max: 4, default: "1.0" });
    }
  });

  it("GT-4o Mini TTS 是 6 音色但**支持**自然语言风格指令", () => {
    const catalog = resolveAudioVoiceCatalog("gpt-4o-mini-tts");
    expect(catalog.voices).toHaveLength(6);
    expect(catalog.supportsInstructions).toBe(true);
    // 格式与 GT TTS 一致(6 种), 不是 GM 的仅 wav。
    expect(catalog.formatOptions).toContain("mp3");
  });

  it("ElevenLabs 使用官方预置音色, UI 显示名称但保留官方 voice_id", () => {
    const catalog = resolveAudioVoiceCatalog("eleven_multilingual_v2");
    expect(catalog.voices).toHaveLength(10);
    expect(catalog.defaultVoice).toBe("21m00Tcm4TlvDq8ikWAM");
    expect(catalog.voices[0]).toMatchObject({
      id: "21m00Tcm4TlvDq8ikWAM",
      name: "Rachel",
    });
    expect(catalog.voices.map((voice) => voice.name)).toContain("Adam");
    expect(catalog.formatOptions).toEqual(["mp3", "pcm"]);
  });

  it("认不出的模型(其它平台)退回 6 音色兜底, 不会把列表清空", () => {
    const catalog = resolveAudioVoiceCatalog("some-unknown-tts-v9");
    expect(catalog.voices).toHaveLength(6);
    expect(catalog.defaultVoice).toBe("alloy");
  });

  it("音色 id 大小写保持平台原样(GM 系列是 Zephyr 不是 zephyr)", () => {
    const catalog = resolveAudioVoiceCatalog("gemini-3.1-flash-tts");
    expect(catalog.voices.some((voice) => voice.id === "Zephyr")).toBe(true);
    expect(catalog.voices.some((voice) => voice.id === "zephyr")).toBe(false);
  });
});

describe("resolveVoiceStyle", () => {
  it("取出风格说明; 未知音色返回 undefined", () => {
    const catalog = resolveAudioVoiceCatalog("gemini-3.1-flash-tts");
    expect(resolveVoiceStyle(catalog, "Puck")).toBe("活泼 / Upbeat");
    expect(resolveVoiceStyle(catalog, "nope")).toBeUndefined();
    expect(resolveVoiceStyle(undefined, "Puck")).toBeUndefined();
  });
});
