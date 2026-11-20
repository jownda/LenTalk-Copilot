import { describe, expect, it } from "vitest";

import type { CustomApiProvider } from "@/stores/settingsStore";

import {
  AudioReverseUnreadableError,
  audioDataUrlToInputPart,
  looksLikeAudioRejected,
  resolveAudioInputFormat,
  resolveAudioReverseChatModel,
} from "./audioPromptReverse";

/** 1 字节音频的合法 data URL（`AQID` = 0x01 0x02 0x03）。 */
const TINY_MP3 = "data:audio/mpeg;base64,AQID";

function provider(overrides: Partial<CustomApiProvider> = {}): CustomApiProvider {
  return {
    id: "zhiniao",
    name: "知鸟AI",
    baseUrl: "https://cuai.token6688.com",
    apiKey: "sk-test",
    chatModels: ["deepseek-v4.1-flash", "gemini-3.8-flash"],
    ...overrides,
  } as CustomApiProvider;
}

describe("resolveAudioInputFormat", () => {
  it("按扩展名判断", () => {
    expect(resolveAudioInputFormat("C:/a/b/song.wav")).toBe("wav");
    expect(resolveAudioInputFormat("song.m4a")).toBe("m4a");
    expect(resolveAudioInputFormat("song.ogg")).toBe("ogg");
    expect(resolveAudioInputFormat("song.flac")).toBe("flac");
    expect(resolveAudioInputFormat("song.mp3")).toBe("mp3");
  });

  it("按 mime 判断优先于扩展名，未知一律 mp3", () => {
    expect(resolveAudioInputFormat("song.unknown", "audio/x-wav")).toBe("wav");
    expect(resolveAudioInputFormat("song.unknown", "audio/mp4")).toBe("m4a");
    expect(resolveAudioInputFormat("song.unknown")).toBe("mp3");
  });
});

describe("audioDataUrlToInputPart", () => {
  it("拆出 base64 与格式", () => {
    const { part, format, bytes } = audioDataUrlToInputPart(TINY_MP3);
    expect(format).toBe("mp3");
    expect(bytes).toBe(3);
    expect(part).toEqual({
      type: "input_audio",
      input_audio: { data: "AQID", format: "mp3" },
    });
  });

  it("wav 的 mime 映射成 wav", () => {
    expect(audioDataUrlToInputPart("data:audio/wav;base64,AQID").format).toBe("wav");
  });

  it("不是 base64 data URL 时报读不出来", () => {
    expect(() => audioDataUrlToInputPart("https://cdn.example.com/a.mp3")).toThrow(
      AudioReverseUnreadableError,
    );
    expect(() => audioDataUrlToInputPart("data:audio/mpeg,")).toThrow(AudioReverseUnreadableError);
  });
});

describe("looksLikeAudioRejected", () => {
  it("正常的反推结果不误判", () => {
    const result = "【类型】\n音乐（city pop）\n\n【风格标签】\ncity pop, 80s synth";
    expect(looksLikeAudioRejected(result)).toBe(false);
  });

  it("模型说没收到音频时判定为拒收", () => {
    expect(looksLikeAudioRejected("抱歉，我没有收到音频，请重新上传。")).toBe(true);
    expect(looksLikeAudioRejected("I'm sorry, no audio was provided in this request.")).toBe(true);
    expect(looksLikeAudioRejected("无法访问这段音频，请提供文件。")).toBe(true);
  });

  it("空回复也算没拿到东西", () => {
    expect(looksLikeAudioRejected("   ")).toBe(true);
  });

  it("只看开头 —— 结果正文里出现「听不到」不误判", () => {
    const body = `【台词】\n[00:03] 女声：这里什么都听不到\n\n${"【生成提示词】\nquiet room ambience ".repeat(20)}`;
    expect(looksLikeAudioRejected(body)).toBe(false);
  });
});

describe("resolveAudioReverseChatModel", () => {
  it("只挑名字明牌支持音频的模型（跳过纯文本）", () => {
    const model = resolveAudioReverseChatModel([provider()], {});
    expect(model?.model).toBe("gemini-3.8-flash");
    expect(model?.providerName).toBe("知鸟AI");
  });

  it("没有任何能听音频的模型时返回 null —— 不能拿纯文本模型凑数", () => {
    const model = resolveAudioReverseChatModel(
      [provider({ chatModels: ["deepseek-v4.1-flash", "gpt-6-sol"] })],
      {},
    );
    expect(model).toBeNull();
  });

  it("没填 Key 的渠道不参与挑选", () => {
    const model = resolveAudioReverseChatModel([provider({ apiKey: "" })], {});
    expect(model).toBeNull();
  });

  it("qwen-omni 这类也认", () => {
    const model = resolveAudioReverseChatModel([provider({ chatModels: ["qwen3.8-omni-flash"] })], {});
    expect(model?.model).toBe("qwen3.8-omni-flash");
  });
});
