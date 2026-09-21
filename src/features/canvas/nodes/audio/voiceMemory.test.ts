import { describe, expect, it } from "vitest";

import { rememberVoice, resolveVoiceForModel, type VoiceMemory } from "./voiceMemory";

/**
 * 记忆表的语义回归。
 *
 * 这里最容易犯的错不是「记不住」, 而是**记错/覆盖错**: 把空音色也记进去、或在没有记忆值时
 * 沿用上一个模型的默认音色 —— 后者会让 MiniMax 收到一个平台根本不认的音色, 而平台是先扣费
 * 后校验的, 一次错误参数就是一次白扣。
 */

const GPT = { id: "custom:zhiniao/tts-1", defaultVoice: "alloy" };
const GEMINI = { id: "custom:zhiniao/gemini-3.1-flash-tts", defaultVoice: "Zephyr" };
/** MiniMax 语音合成: **没有**预置音色, 音色来自音色库。 */
const MMX_SPEECH = { id: "custom:zhiniao/speech-2.8" };

describe("rememberVoice", () => {
  it("把当前音色记到当前模型名下", () => {
    expect(rememberVoice(undefined, GPT.id, "nova")).toEqual({ [GPT.id]: "nova" });
  });

  it("保留其它模型的记忆 —— 切来切去不该互相冲掉", () => {
    const memory: VoiceMemory = { [GEMINI.id]: "Puck" };
    expect(rememberVoice(memory, GPT.id, "nova")).toEqual({ [GEMINI.id]: "Puck", [GPT.id]: "nova" });
  });

  it("空音色不写入, 也不抹掉旧记忆", () => {
    const memory: VoiceMemory = { [GPT.id]: "nova" };
    expect(rememberVoice(memory, GPT.id, "")).toEqual({ [GPT.id]: "nova" });
    expect(rememberVoice(memory, GPT.id, "   ")).toEqual({ [GPT.id]: "nova" });
  });

  it("没有模型 id 时什么都不记(避免写进一个空 key)", () => {
    expect(rememberVoice(undefined, undefined, "nova")).toEqual({});
  });

  it("不改动传入的对象(纯函数, 免得和 React 的不可变更新打架)", () => {
    const memory: VoiceMemory = {};
    rememberVoice(memory, GPT.id, "nova");
    expect(memory).toEqual({});
  });

  it("去掉首尾空白, 免得同一个音色因为空格被记成两个", () => {
    expect(rememberVoice(undefined, GPT.id, " nova ")).toEqual({ [GPT.id]: "nova" });
  });
});

describe("resolveVoiceForModel", () => {
  it("有记忆值就还原记忆值, 而不是默认值 —— 这就是「记住最后一次选择」", () => {
    expect(resolveVoiceForModel({ [GPT.id]: "nova" }, GPT)).toBe("nova");
  });

  it("没记忆值才退回该模型的默认音色", () => {
    expect(resolveVoiceForModel({}, GPT)).toBe("alloy");
    expect(resolveVoiceForModel(undefined, GEMINI)).toBe("Zephyr");
  });

  it("MiniMax 这种「没有默认音色」的模型返回空串, 而不是沿用别家的音色", () => {
    expect(resolveVoiceForModel({ [GPT.id]: "alloy" }, MMX_SPEECH)).toBe("");
    expect(resolveVoiceForModel(undefined, MMX_SPEECH)).toBe("");
  });

  it("没有模型时返回空串", () => {
    expect(resolveVoiceForModel({ [GPT.id]: "nova" }, undefined)).toBe("");
  });

  it("GPT → Gemini → GPT 走一圈, 回到 GPT 时仍是用户自己选的那个", () => {
    let memory: VoiceMemory = {};
    // GPT 上用户选了 nova
    const gptVoice = "nova";
    memory = rememberVoice(memory, GPT.id, gptVoice);
    // 切到 Gemini: 没有记忆 → 用默认 Zephyr
    expect(resolveVoiceForModel(memory, GEMINI)).toBe("Zephyr");
    memory = rememberVoice(memory, GEMINI.id, "Zephyr");
    // 切回 GPT: 还原 nova, 而不是 alloy
    expect(resolveVoiceForModel(memory, GPT)).toBe("nova");
  });

  it("GPT → MiniMax 时不会把 alloy 带过去", () => {
    const memory = rememberVoice(undefined, GPT.id, "alloy");
    expect(resolveVoiceForModel(memory, MMX_SPEECH)).toBe("");
  });

  it("MiniMax 上从音色库选了一个, 切走再切回来仍然记得", () => {
    let memory: VoiceMemory = {};
    memory = rememberVoice(memory, MMX_SPEECH.id, "voice-abc123");
    memory = rememberVoice(memory, GPT.id, "alloy");
    expect(resolveVoiceForModel(memory, MMX_SPEECH)).toBe("voice-abc123");
  });
});
