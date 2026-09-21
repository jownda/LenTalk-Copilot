import { describe, expect, it } from 'vitest';

import {
  AUDIO_FAMILY_ORDER,
  resolveAudioFamilyLayout,
  resolveAudioModelFamily,
} from './audioFamilies';

/**
 * 家族判定的回归 —— 这一层错了不会报错, 只会让节点渲染出**别的家族的 UI**:
 * 给 OpenAI 的 tts-1 显示「上传克隆样音」, 或者给 Suno 显示「档位 HD/Turbo」。
 * 所以把现有各平台的全部音频模型名钉在这里。
 */
describe('resolveAudioModelFamily', () => {
  it('知鸟AI: MiniMax 三件套 + OpenAI + Gemini + Suno 各归各家', () => {
    expect(resolveAudioModelFamily('voice-clone')).toBe('minimax');
    expect(resolveAudioModelFamily('voice-design')).toBe('minimax');
    expect(resolveAudioModelFamily('speech-2.8')).toBe('minimax');

    expect(resolveAudioModelFamily('tts-1')).toBe('openai');
    expect(resolveAudioModelFamily('tts-1-hd')).toBe('openai');
    expect(resolveAudioModelFamily('gpt-4o-mini-tts')).toBe('openai');

    // 关键顺序: `gemini-3.1-flash-tts` 结尾也是 tts, 若 gemini 规则排在 openai 之后会被抢走。
    expect(resolveAudioModelFamily('gemini-3.1-flash-tts')).toBe('gemini');
    expect(resolveAudioModelFamily('gemini-2.5-pro-tts')).toBe('gemini');

    expect(resolveAudioModelFamily('music')).toBe('suno');
  });

  it('字子动画: indexTTS / ElevenLabs / Suno 互不串味', () => {
    expect(resolveAudioModelFamily('indextts2-v1')).toBe('indextts');
    expect(resolveAudioModelFamily('eleven_multilingual_v2')).toBe('elevenlabs');
    expect(resolveAudioModelFamily('eleven_multilingual_v1')).toBe('elevenlabs');
    expect(resolveAudioModelFamily('eleven_flash_v2_5')).toBe('elevenlabs');
    expect(resolveAudioModelFamily('eleven_v3')).toBe('elevenlabs');
    // 音效模型也属 ElevenLabs, 不能因为名字里有 sound 就落到 other。
    expect(resolveAudioModelFamily('eleven_text_to_sound_v2')).toBe('elevenlabs');
    // `eleven_music_v1` 同时含 eleven 与 music: ElevenLabs 规则在前, 应判成 ElevenLabs。
    expect(resolveAudioModelFamily('eleven_music_v1')).toBe('elevenlabs');

    expect(resolveAudioModelFamily('music-2.6')).toBe('suno');
    expect(resolveAudioModelFamily('music-2.6-free')).toBe('suno');
    expect(resolveAudioModelFamily('music-cover')).toBe('suno');
  });

  it('豆包语音能吃下常见写法', () => {
    expect(resolveAudioModelFamily('doubao-tts')).toBe('doubao');
    expect(resolveAudioModelFamily('doubao-seed-tts-2.0')).toBe('doubao');
    expect(resolveAudioModelFamily('豆包语音合成')).toBe('doubao');
  });

  it('认不出的模型落到 other, 不会静默归到某个家族', () => {
    expect(resolveAudioModelFamily('some-unknown-audio')).toBe('other');
    expect(resolveAudioModelFamily('')).toBe('other');
    expect(resolveAudioModelFamily(undefined)).toBe('other');
  });
});

describe('resolveAudioFamilyLayout', () => {
  it('MINIMAX 走三卡片工作室, Suno 走音乐布局, 其余走通用 TTS', () => {
    expect(resolveAudioFamilyLayout('minimax')).toBe('mmx-studio');
    expect(resolveAudioFamilyLayout('suno')).toBe('music');
    expect(resolveAudioFamilyLayout('indextts')).toBe('index-tts');
    for (const family of ['openai', 'gemini', 'doubao', 'elevenlabs', 'other'] as const) {
      expect(resolveAudioFamilyLayout(family)).toBe('standard-tts');
    }
  });

  it('每个家族都在选择器顺序里, 且顺序与用户列出的口径一致', () => {
    expect(AUDIO_FAMILY_ORDER[0]).toBe('minimax');
    expect(AUDIO_FAMILY_ORDER).toContain('suno');
    expect(new Set(AUDIO_FAMILY_ORDER).size).toBe(AUDIO_FAMILY_ORDER.length);
  });
});
