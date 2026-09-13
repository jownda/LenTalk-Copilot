import { describe, expect, it } from 'vitest';

import {
  isAudioModelName,
  isChatCompletionModelName,
  isVideoGenerationModelName,
} from './settingsStore';

describe('isAudioModelName', () => {
  it('识别 TTS / 语音克隆 / 音乐生成模型', () => {
    for (const model of [
      'tts-1',
      'tts-1-hd',
      'gpt-4o-mini-tts',
      'speech-2.8',
      'voice-clone',
      'voice-design',
      'music',
      'suno-v4',
      'elevenlabs-tts',
      'qwen-audio',
      'gpt-4o-audio-preview',
      // 与知鸟 AI 音频清单一致
      'gemini-3.1-flash-tts',
      'gemini-2.5-pro-tts',
    ]) {
      expect(isAudioModelName(model), model).toBe(true);
    }
  });

  it('不把图片模型判成音频', () => {
    for (const model of [
      'gpt-image-2',
      'gpt-image-2.5-sunburst',
      'nano-banana',
      'gemini-3.1-flash-image',
      'doubao-seedream-4-5',
      'flux-2',
      'wan2.7-image',
      'qwen-image-3.0',
    ]) {
      expect(isAudioModelName(model), model).toBe(false);
    }
  });

  it('视频模型优先归类为视频, 不被名称里的 audio 抢走', () => {
    const model = 'kling-3.0-omni-720p-ref-audio';
    expect(isVideoGenerationModelName(model)).toBe(true);
    expect(isAudioModelName(model)).toBe(false);
  });

  it('空值与普通文本返回 false', () => {
    expect(isAudioModelName('')).toBe(false);
    expect(isAudioModelName('   ')).toBe(false);
    expect(isAudioModelName('gpt-5.5')).toBe(false);
  });
});

describe('isChatCompletionModelName 与音频模型互斥', () => {
  it('带 tts/audio 的模型不会被当成 Chat LLM', () => {
    expect(isChatCompletionModelName('gemini-3.1-flash-tts')).toBe(false);
    expect(isChatCompletionModelName('qwen-audio')).toBe(false);
    expect(isChatCompletionModelName('gpt-4o-mini-tts')).toBe(false);
  });

  it('普通语言模型仍然判定为 Chat', () => {
    expect(isChatCompletionModelName('gemini-3.1-pro')).toBe(true);
    expect(isChatCompletionModelName('deepseek-v4-pro')).toBe(true);
  });
});
