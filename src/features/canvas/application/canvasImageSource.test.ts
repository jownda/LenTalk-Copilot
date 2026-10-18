import { describe, expect, it } from 'vitest';

import { pickCanvasImageSource } from '@/features/canvas/application/canvasImageSource';
import { shouldUseOriginalImageByZoom } from '@/features/canvas/application/imageData';

/** 从真实阈值推出来，别在测试里写死数字 —— 阈值改了这里要跟着走。 */
const FAR_ZOOM = 1.5;
const NEAR_ZOOM = 1;
const LOCAL = 'D:\\media\\images\\abc.jpg';

describe('pickCanvasImageSource', () => {
  it('测试前提：1.5 属于「看原图」档、1 属于「看小图」档', () => {
    expect(shouldUseOriginalImageByZoom(FAR_ZOOM)).toBe(true);
    expect(shouldUseOriginalImageByZoom(NEAR_ZOOM)).toBe(false);
  });

  it('放大到阈值以上时用原图（用户主动要看细节）', () => {
    const pick = pickCanvasImageSource({ zoom: FAR_ZOOM, imageUrl: LOCAL, previewImageUrl: 'D:\\p.jpg' });
    expect(pick.kind).toBe('original');
    expect(pick.url).toBe(LOCAL);
    expect(pick.thumbnailSource).toBeNull();
  });

  it('有 preview 时优先用 preview（已经落盘，比现生成缩略图更省）', () => {
    const pick = pickCanvasImageSource({ zoom: NEAR_ZOOM, imageUrl: LOCAL, previewImageUrl: 'D:\\p.jpg' });
    expect(pick.kind).toBe('preview');
    expect(pick.url).toBe('D:\\p.jpg');
    expect(pick.thumbnailSource).toBeNull();
  });

  it('无 preview 的本地原图走缩略图，且刻意不给 url（调用方要先显示骨架）', () => {
    const pick = pickCanvasImageSource({ zoom: NEAR_ZOOM, imageUrl: LOCAL });
    expect(pick.kind).toBe('thumbnail');
    expect(pick.thumbnailSource).toBe(LOCAL);
    expect(pick.url).toBeNull();
  });

  it('远端 / data / blob 源没法缩略，只能直接用', () => {
    for (const remote of ['https://a.com/x.jpg', 'data:image/png;base64,AA', 'blob:http://x/y']) {
      const pick = pickCanvasImageSource({ zoom: NEAR_ZOOM, imageUrl: remote });
      expect(pick.kind).toBe('original');
      expect(pick.url).toBe(remote);
      expect(pick.thumbnailSource).toBeNull();
    }
  });

  it('关掉缩略图时一律给最清晰的可用源', () => {
    const pick = pickCanvasImageSource({
      zoom: NEAR_ZOOM,
      imageUrl: LOCAL,
      previewImageUrl: 'D:\\p.jpg',
      allowThumbnail: false,
    });
    expect(pick.kind).toBe('original');
    expect(pick.url).toBe(LOCAL);
  });

  it('没有任何源时返回 none', () => {
    expect(pickCanvasImageSource({ zoom: NEAR_ZOOM }).kind).toBe('none');
    expect(pickCanvasImageSource({ zoom: NEAR_ZOOM, imageUrl: '   ' }).kind).toBe('none');
  });

  it('只有 preview、没有原图时也能正确回落', () => {
    const pick = pickCanvasImageSource({ zoom: FAR_ZOOM, previewImageUrl: 'D:\\p.jpg' });
    expect(pick.kind).toBe('original');
    expect(pick.url).toBe('D:\\p.jpg');
  });

  /**
   * `useOriginal` 是给「不想为了这一个判断去订阅整个视口」的调用方用的旁路：
   * 节点订阅 `transform[2] >= 阈值` 这个**布尔**后，平移画布就不会重渲染。
   * 它必须与按 zoom 判断**完全等价**，否则省下来的重渲染会变成「该看原图时还在用小图」。
   */
  it('useOriginal 旁路与按 zoom 判断等价', () => {
    const byZoomFar = pickCanvasImageSource({ zoom: FAR_ZOOM, imageUrl: LOCAL, previewImageUrl: 'D:\\p.jpg' });
    const byFlagFar = pickCanvasImageSource({
      zoom: NEAR_ZOOM, // 故意给「小图档」的 zoom，证明结论只由 useOriginal 决定
      useOriginal: true,
      imageUrl: LOCAL,
      previewImageUrl: 'D:\\p.jpg',
    });
    expect(byFlagFar).toEqual(byZoomFar);

    const byZoomNear = pickCanvasImageSource({ zoom: NEAR_ZOOM, imageUrl: LOCAL, previewImageUrl: 'D:\\p.jpg' });
    const byFlagNear = pickCanvasImageSource({
      zoom: FAR_ZOOM,
      useOriginal: false,
      imageUrl: LOCAL,
      previewImageUrl: 'D:\\p.jpg',
    });
    expect(byFlagNear).toEqual(byZoomNear);
  });

  it('useOriginal 为 false 时仍然走缩略图（不会退化成直接给原图）', () => {
    const pick = pickCanvasImageSource({ zoom: FAR_ZOOM, useOriginal: false, imageUrl: LOCAL });
    expect(pick.kind).toBe('thumbnail');
    expect(pick.url).toBeNull();
    expect(pick.thumbnailSource).toBe(LOCAL);
  });
});
