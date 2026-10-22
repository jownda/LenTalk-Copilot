import { describe, expect, it } from 'vitest';

import { isLocalVideoPath } from './pajubenLocalPath';

describe('isLocalVideoPath', () => {
  it('接受 Windows 绝对路径（正/反斜杠）', () => {
    expect(isLocalVideoPath('C:\\Users\\Administrator\\Videos\\a.mp4')).toBe(true);
    expect(isLocalVideoPath('D:/AI/对标/第1集.mp4')).toBe(true);
  });

  it('接受 UNC 与 POSIX 绝对路径', () => {
    expect(isLocalVideoPath('\\\\NAS\\剧集\\第1集.mp4')).toBe(true);
    expect(isLocalVideoPath('/Users/job/Movies/a.mp4')).toBe(true);
  });

  it('拒绝远端地址', () => {
    // 实测：炳火那类平台直接回 OSS 链接，扒之前必须先落盘
    expect(isLocalVideoPath('https://binghuo-media-lrs.oss-cn-shenzhen.aliyuncs.com/a.mp4')).toBe(false);
    expect(isLocalVideoPath('http://127.0.0.1:9/a.mp4')).toBe(false);
  });

  it('拒绝空值与相对路径', () => {
    expect(isLocalVideoPath('')).toBe(false);
    expect(isLocalVideoPath('   ')).toBe(false);
    expect(isLocalVideoPath('videos/a.mp4')).toBe(false);
    // 单字母盘符以外的「X:」不算：必须紧跟分隔符
    expect(isLocalVideoPath('C:a.mp4')).toBe(false);
  });
});
