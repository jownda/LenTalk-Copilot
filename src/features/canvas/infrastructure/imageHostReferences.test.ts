import { describe, expect, it } from 'vitest';

import { isPublicHttpUrl, toSiteRootBaseUrl } from './imageHostReferences';

describe('图床参考素材的前置判定', () => {
  it('公网 http(s) 直链直接透传', () => {
    expect(isPublicHttpUrl('https://cdn.example.com/a.jpg')).toBe(true);
    expect(isPublicHttpUrl('http://cdn.example.com/a.jpg')).toBe(true);
  });

  it('Tauri 本地预览协议不算公网地址(否则上游读不到)', () => {
    // 这两种看着像 URL, 实际只有本机能访问, 必须先还原本地路径再上传。
    expect(isPublicHttpUrl('http://asset.localhost/C%3A%2Ftmp%2Fa.png')).toBe(false);
    expect(isPublicHttpUrl('asset://localhost/%2Ftmp%2Fa.png')).toBe(false);
  });

  it('本地路径 / data URL / 裸串都不是公网地址', () => {
    expect(isPublicHttpUrl('D:/work/a.png')).toBe(false);
    expect(isPublicHttpUrl('/Users/x/a.png')).toBe(false);
    expect(isPublicHttpUrl('data:image/png;base64,AAA')).toBe(false);
    expect(isPublicHttpUrl('file:///tmp/a.png')).toBe(false);
  });

  it('站点根地址去掉尾斜杠与 /v1', () => {
    expect(toSiteRootBaseUrl('https://cuai.token6688.com/v1/')).toBe('https://cuai.token6688.com');
    expect(toSiteRootBaseUrl('https://cuai.token6688.com')).toBe('https://cuai.token6688.com');
  });
});
