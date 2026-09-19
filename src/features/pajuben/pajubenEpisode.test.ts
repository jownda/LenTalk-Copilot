import { describe, expect, it } from 'vitest';

import { describeEpisodeGuess, guessEpisodeFromVideoName } from './pajubenEpisode';

describe('guessEpisodeFromVideoName', () => {
  it('认显式集号写法', () => {
    expect(guessEpisodeFromVideoName('第16集.mp4')).toBe(16);
    expect(guessEpisodeFromVideoName('第 3 集 大结局.mkv')).toBe(3);
    expect(guessEpisodeFromVideoName('16集.mp4')).toBe(16);
    expect(guessEpisodeFromVideoName('S01E16.mkv')).toBe(16);
    expect(guessEpisodeFromVideoName('s1e7.mp4')).toBe(7);
    expect(guessEpisodeFromVideoName('EP07.mp4')).toBe(7);
    expect(guessEpisodeFromVideoName('E16.mp4')).toBe(16);
    expect(guessEpisodeFromVideoName('剧集-ep12-终.mp4')).toBe(12);
  });

  it('纯数字文件名就是集号', () => {
    expect(guessEpisodeFromVideoName('1.mp4')).toBe(1);
    expect(guessEpisodeFromVideoName('16.mp4')).toBe(16);
    expect(guessEpisodeFromVideoName('[16].mp4')).toBe(16);
    expect(guessEpisodeFromVideoName('（16）.mp4')).toBe(16);
    expect(guessEpisodeFromVideoName('D:/剧集/05.mp4')).toBe(5);
    expect(guessEpisodeFromVideoName('D:\\剧集\\05.mp4')).toBe(5);
  });

  it('含字母的哈希/uuid 名字不再凭空造出集号（回归：曾因 node-16e… 写成第16集）', () => {
    expect(guessEpisodeFromVideoName('node-16e678df-df36-4ed2-9142-3d9c23737f88.mp4')).toBe(1);
    expect(guessEpisodeFromVideoName('C6218.MP4')).toBe(1);
    expect(guessEpisodeFromVideoName('719ac086-c131-4304-a970-92c6a03716af.mp4')).toBe(1);
    expect(guessEpisodeFromVideoName('-爆-下雪.MP4')).toBe(1);
  });

  it('纯中文/日期的名字仍按首段数字识别', () => {
    expect(guessEpisodeFromVideoName('9月19日.mp4')).toBe(9);
    expect(guessEpisodeFromVideoName('9月23日 (1)(2).mp4')).toBe(9);
  });

  it('describeEpisodeGuess 标出是否真的识别到了', () => {
    expect(describeEpisodeGuess('第16集.mp4')).toEqual({ episode: 16, recognized: true });
    expect(describeEpisodeGuess('node-16e678df-df36-4ed2-9142-3d9c23737f88.mp4')).toEqual({
      episode: 1,
      recognized: false,
    });
  });
});
