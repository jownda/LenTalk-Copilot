import { describe, expect, it } from 'vitest';

import {
  describeReferenceSource,
  detectBase64Asset,
  extensionFromMimeType,
  localPathFromReferenceSource,
  parseDataUrlAsset,
  resolveReferenceAssetSource,
} from './referenceAssetSource';

/**
 * 补齐到 4 字符对齐(用 'A' 而不是 '=', 免得 padding 落在字符串中间让 atob 报错),
 * 凑够长度让裸 base64 通过长度校验。
 */
function padBase64(prefix: string): string {
  const remainder = prefix.length % 4;
  const aligned = remainder === 0 ? prefix : prefix + 'A'.repeat(4 - remainder);
  return aligned + 'A'.repeat(64);
}

const PNG_BASE64 = padBase64('iVBORw0KGgo');
const JPEG_BASE64 = padBase64('/9j/4AAQSkZJRgABAQAAAQABAAD');
const MP3_ID3_BASE64 = padBase64('SUQz');

describe('extensionFromMimeType', () => {
  it('uses the real file extension instead of the mime subtype', () => {
    expect(extensionFromMimeType('audio/mpeg')).toBe('mp3');
    expect(extensionFromMimeType('audio/mp4')).toBe('m4a');
    expect(extensionFromMimeType('image/jpeg')).toBe('jpg');
    expect(extensionFromMimeType('image/png')).toBe('png');
  });

  it('normalizes case and strips parameters', () => {
    expect(extensionFromMimeType('IMAGE/PNG; charset=utf-8')).toBe('png');
  });

  it('falls back to a sanitized subtype then bin', () => {
    expect(extensionFromMimeType('audio/x-custom')).toBe('xcustom');
    expect(extensionFromMimeType('weird')).toBe('bin');
  });
});

describe('parseDataUrlAsset', () => {
  it('parses a base64 data url and derives the extension from the mime', () => {
    expect(parseDataUrlAsset('data:image/png;base64,iVBORw0KGgo=')).toEqual({
      mimeType: 'image/png',
      extension: 'png',
      base64: 'iVBORw0KGgo=',
    });
    expect(parseDataUrlAsset('data:audio/mpeg;base64,SUQz')?.extension).toBe('mp3');
  });

  it('accepts parameters between mime and base64', () => {
    expect(parseDataUrlAsset('data:image/jpeg;charset=utf-8;base64,/9j/4A==')?.mimeType).toBe('image/jpeg');
  });

  it('rejects non data-url and non-base64 payloads', () => {
    expect(parseDataUrlAsset('/Users/job/a.png')).toBeNull();
    expect(parseDataUrlAsset('data:image/png,%89PNG')).toBeNull();
  });
});

describe('detectBase64Asset', () => {
  it('recognizes raw base64 by file signature', () => {
    expect(detectBase64Asset(PNG_BASE64)?.mimeType).toBe('image/png');
    expect(detectBase64Asset(JPEG_BASE64)?.mimeType).toBe('image/jpeg');
    expect(detectBase64Asset(MP3_ID3_BASE64)?.mimeType).toBe('audio/mpeg');
  });

  it('never mistakes a path or plain text for an asset', () => {
    expect(detectBase64Asset('/Users/job/Desktop/reference.png')).toBeNull();
    expect(detectBase64Asset('C:\\Users\\job\\reference.mp3')).toBeNull();
    expect(detectBase64Asset('hello world, this is not base64 at all!')).toBeNull();
    expect(detectBase64Asset('AAAA')).toBeNull();
  });
});

describe('localPathFromReferenceSource', () => {
  it('returns absolute local paths unchanged', () => {
    expect(localPathFromReferenceSource('/Users/job/a.png')).toBe('/Users/job/a.png');
    expect(localPathFromReferenceSource('C:\\Users\\job\\a.png')).toBe('C:\\Users\\job\\a.png');
    expect(localPathFromReferenceSource('\\\\server\\share\\a.png')).toBe('\\\\server\\share\\a.png');
  });

  it('decodes file:// urls on both platforms', () => {
    expect(localPathFromReferenceSource('file:///Users/job/a.png')).toBe('/Users/job/a.png');
    expect(localPathFromReferenceSource('file:///C:/Users/job/a.png')).toBe('C:/Users/job/a.png');
  });

  it('decodes Tauri asset protocol urls from convertFileSrc', () => {
    expect(localPathFromReferenceSource('asset://localhost/%2FUsers%2Fjob%2Fa.png')).toBe('/Users/job/a.png');
    expect(localPathFromReferenceSource('http://asset.localhost/C%3A%2Fa.png')).toBe('C:/a.png');
  });

  it('ignores public urls, other schemes and relative strings', () => {
    expect(localPathFromReferenceSource('https://example.com/a.png')).toBeNull();
    expect(localPathFromReferenceSource('blob:http://localhost/abc')).toBeNull();
    expect(localPathFromReferenceSource('tauri://localhost/a.png')).toBeNull();
    expect(localPathFromReferenceSource('assets/a.png')).toBeNull();
    expect(localPathFromReferenceSource('   ')).toBeNull();
  });
});

describe('describeReferenceSource', () => {
  it('explains why a source could not be read', () => {
    expect(describeReferenceSource('')).toBe('素材地址为空');
    expect(describeReferenceSource('blob:http://localhost/abc')).toContain('blob:');
    expect(describeReferenceSource('/Users/job/missing.mp3')).toContain('本地文件读取失败');
  });
});

describe('resolveReferenceAssetSource', () => {
  it('passes public urls through untouched', async () => {
    await expect(resolveReferenceAssetSource('https://cdn.example.com/a.png', '炳火 API')).resolves.toEqual({
      kind: 'url',
      url: 'https://cdn.example.com/a.png',
    });
  });

  it('does not mistake Tauri asset.localhost preview urls for public assets', async () => {
    await expect(resolveReferenceAssetSource('http://asset.localhost/C%3A%2Fa.png', '炳火 API')).rejects.toThrow(
      /炳火 API 参考素材必须是公网 URL 或可读取的本地素材/,
    );
  });

  it('accepts data urls and raw base64 without touching the filesystem', async () => {
    const fromDataUrl = await resolveReferenceAssetSource('data:image/png;base64,iVBORw0KGgo=', '炳火 API');
    expect(fromDataUrl).toMatchObject({ kind: 'file', mimeType: 'image/png', extension: 'png' });

    const fromRawBase64 = await resolveReferenceAssetSource(PNG_BASE64, '炳火 API');
    expect(fromRawBase64).toMatchObject({ kind: 'file', mimeType: 'image/png' });
  });

  it('throws a diagnostic error instead of silently degrading', async () => {
    await expect(resolveReferenceAssetSource('', '炳火 API')).rejects.toThrow(/参考素材地址为空/);
    await expect(resolveReferenceAssetSource('/Users/job/missing.mp3', '炳火 API')).rejects.toThrow(
      /炳火 API 参考素材必须是公网 URL 或可读取的本地素材\(本地文件读取失败/,
    );
  });
});
