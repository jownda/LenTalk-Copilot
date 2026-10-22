import { describe, expect, it } from 'vitest';

import {
  isZzdhBaseUrl,
  isZzdhProvider,
  isZzdhProviderId,
  resolveZzdhAudioKind,
  resolveZzdhAudioPath,
  resolveZzdhResolutionTier,
  resolveZzdhVideoDurationRange,
} from './zzdhApi';

/**
 * 音频链路端点分流: 平台把 TTS / 音效 / 音乐拆成三个入口,
 * 只能靠模型名判定, 发错端点会直接 404 或生成出错误内容。
 */
describe('resolveZzdhAudioKind', () => {
  it.each([
    'eleven_multilingual_v2',
    'eleven_multilingual_v1',
    'eleven_flash_v2_5',
    'eleven_turbo_v2',
    'eleven_monolingual_v1',
    'eleven_v3',
    'indextts2-v1',
    'tts-1-hd',
  ])('把 %s 判成语音合成', (model) => {
    expect(resolveZzdhAudioKind(model)).toBe('speech');
  });

  it.each(['eleven_text_to_sound_v2', 'text-to-sound-v2', 'sfx-1'])(
    '把 %s 判成音效',
    (model) => {
      expect(resolveZzdhAudioKind(model)).toBe('sound-effects');
    },
  );

  it.each(['eleven_music_v1', 'eleven_music_v2', 'music-2.6', 'music-cover-free', 'suno-v4'])(
    '把 %s 判成音乐',
    (model) => {
      expect(resolveZzdhAudioKind(model)).toBe('music');
    },
  );

  it('音乐优先于其它匹配(eleven_music_v1 里也含 eleven)', () => {
    expect(resolveZzdhAudioKind('eleven_music_v1')).toBe('music');
  });

  it('无法判定时返回 null, 由调用方退化为 speech', () => {
    expect(resolveZzdhAudioKind('')).toBeNull();
    expect(resolveZzdhAudioKind('some-unknown-model')).toBeNull();
  });
});

describe('resolveZzdhAudioPath', () => {
  it('三类音频各走自己的端点', () => {
    expect(resolveZzdhAudioPath('speech')).toBe('/v1/audio/speech');
    expect(resolveZzdhAudioPath('sound-effects')).toBe('/v1/audio/sound-effects');
    expect(resolveZzdhAudioPath('music')).toBe('/v1/audio/music');
  });
});

describe('isZzdhProvider', () => {
  it('识别平台 id 的中英文写法与 baseUrl', () => {
    expect(isZzdhProviderId('字子动画')).toBe(true);
    expect(isZzdhProviderId('zizidonghua')).toBe(true);
    expect(isZzdhProviderId('custom:字子动画')).toBe(true);
    expect(isZzdhProviderId('comfly')).toBe(false);
    expect(isZzdhBaseUrl('https://www.zizidonghua.com/v1')).toBe(true);
    expect(isZzdhProvider('', 'https://www.zizidonghua.com')).toBe(true);
    expect(isZzdhProvider('comfly', 'https://ai.comfly.org')).toBe(false);
  });
});

describe('H3 视频档位与时长(官方模型页)', () => {
  it('从模型名读出分辨率档位', () => {
    expect(resolveZzdhResolutionTier('zzdh-Minimax-h3-480p')).toBe('480p');
    expect(resolveZzdhResolutionTier('zzdh-Minimax-h3-4k')).toBe('4k');
    expect(resolveZzdhResolutionTier('doubao-seedance-2-video-1080p')).toBe('1080p');
    expect(resolveZzdhResolutionTier('kling-v3-omni')).toBeNull();
  });

  it('480P 档 5~10 秒, 其余 H3 档位 5~15 秒', () => {
    expect(resolveZzdhVideoDurationRange('zzdh-Minimax-h3-480p')).toEqual({ min: 5, max: 10 });
    expect(resolveZzdhVideoDurationRange('zzdh-Minimax-h3-720p')).toEqual({ min: 5, max: 15 });
    expect(resolveZzdhVideoDurationRange('zzdh-Minimax-h3-4k')).toEqual({ min: 5, max: 15 });
  });

  it('非 H3 系列不收窄时长', () => {
    expect(resolveZzdhVideoDurationRange('doubao-seedance-2-720p')).toBeNull();
    expect(resolveZzdhVideoDurationRange('wan3.0-t2v-720p')).toBeNull();
  });
});
