import { describe, expect, it } from 'vitest';

import { captureVideoFrame, parseDataUrlPayload } from './videoFrameCapture';

describe('parseDataUrlPayload', () => {
  it('decodes a base64 video payload with its mime type', () => {
    const { mimeType, bytes } = parseDataUrlPayload('data:video/mp4;base64,aGVsbG8=');
    expect(mimeType).toBe('video/mp4');
    expect(Array.from(bytes)).toEqual([104, 101, 108, 108, 111]);
  });

  it('handles extra parameters before the payload', () => {
    const { mimeType, bytes } = parseDataUrlPayload('data:image/png;charset=utf-8;base64,aGk=');
    expect(mimeType).toBe('image/png');
    expect(Array.from(bytes)).toEqual([104, 105]);
  });

  it('falls back to a generic mime type when the header omits one', () => {
    const { mimeType, bytes } = parseDataUrlPayload('data:;base64,aGk=');
    expect(mimeType).toBe('application/octet-stream');
    expect(Array.from(bytes)).toEqual([104, 105]);
  });

  it('percent-decodes non-base64 payloads', () => {
    const { mimeType, bytes } = parseDataUrlPayload('data:text/plain,hello%20world');
    expect(mimeType).toBe('text/plain');
    expect(new TextDecoder().decode(bytes)).toBe('hello world');
  });

  it('rejects malformed data urls', () => {
    expect(() => parseDataUrlPayload('https://cdn.example.com/clip.mp4')).toThrow();
    expect(() => parseDataUrlPayload('data:video/mp4;base64')).toThrow();
  });
});

describe('captureVideoFrame', () => {
  it('rejects an empty source before touching the DOM', async () => {
    await expect(captureVideoFrame({ source: '   ' })).rejects.toThrow('视频来源为空');
  });
});
