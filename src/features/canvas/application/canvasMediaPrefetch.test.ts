import { describe, expect, it } from 'vitest';

import {
  PREFETCH_VISIBLE_MARGIN,
  collectNodePrefetchSources,
  collectPrefetchCandidates,
  nodeBounds,
} from '@/features/canvas/application/canvasMediaPrefetch';

const LOCAL = 'D:\\media\\images\\abc.jpg';
const PREVIEW = 'D:\\media\\previews\\abc.jpg';

describe('collectNodePrefetchSources', () => {
  it('只收「需要 384 缩略图」的源：无 preview 的本地原图', () => {
    expect(collectNodePrefetchSources({ data: { imageUrl: LOCAL } })).toEqual([LOCAL]);
  });

  it('有 preview 的不收（preview 已经落盘，不需要再生成缩略图）', () => {
    expect(collectNodePrefetchSources({ data: { imageUrl: LOCAL, previewImageUrl: PREVIEW } })).toEqual([]);
  });

  it('远端源不收（没法缩略）', () => {
    expect(collectNodePrefetchSources({ data: { imageUrl: 'https://a.com/x.jpg' } })).toEqual([]);
  });

  it('首尾帧与分镜帧同样收集', () => {
    const sources = collectNodePrefetchSources({
      data: {
        firstFrameImageUrl: 'D:\\f\\first.jpg',
        lastFramePreviewImageUrl: 'D:\\f\\last-preview.jpg',
        frames: [{ imageUrl: 'D:\\f\\1.jpg' }, { imageUrl: 'D:\\f\\2.jpg', previewImageUrl: 'D:\\f\\2p.jpg' }],
      },
    });
    expect(sources).toContain('D:\\f\\first.jpg');
    expect(sources).toContain('D:\\f\\1.jpg');
    // 有 preview 的三项都不该进来（preview 已经落盘，用不着再生成缩略图）
    expect(sources).not.toContain('D:\\f\\last-preview.jpg');
    expect(sources).not.toContain('D:\\f\\2.jpg');
    expect(sources).not.toContain('D:\\f\\2p.jpg');
  });

  it('空节点安全', () => {
    expect(collectNodePrefetchSources(null)).toEqual([]);
    expect(collectNodePrefetchSources({})).toEqual([]);
    expect(collectNodePrefetchSources({ data: null })).toEqual([]);
  });
});

describe('nodeBounds', () => {
  it('measured 优先于 width / height（React Flow 的 dimensions 只写 measured）', () => {
    const bounds = nodeBounds({ position: { x: 10, y: 20 }, width: 100, height: 50, measured: { width: 300, height: 200 } });
    expect(bounds).toEqual({ left: 10, top: 20, right: 310, bottom: 220 });
  });

  it('缺尺寸时用兜底值，不抛错', () => {
    const bounds = nodeBounds({ position: { x: 5, y: 6 } });
    expect(bounds.left).toBe(5);
    expect(bounds.right).toBeGreaterThan(5);
    expect(bounds.bottom).toBeGreaterThan(6);
  });
});

describe('collectPrefetchCandidates', () => {
  const viewport = { x: 0, y: 0, zoom: 1 };
  const containerWidth = 1000;
  const containerHeight = 800;

  it('视口内的标 visible，视口外的标 not visible', () => {
    const candidates = collectPrefetchCandidates(
      [
        { position: { x: 0, y: 0 }, measured: { width: 260, height: 220 }, data: { imageUrl: LOCAL } },
        { position: { x: 9000, y: 9000 }, measured: { width: 260, height: 220 }, data: { imageUrl: 'D:\\b.jpg' } },
      ],
      viewport,
      containerWidth,
      containerHeight,
    );
    expect(candidates).toEqual([
      { source: LOCAL, visible: true },
      { source: 'D:\\b.jpg', visible: false },
    ]);
  });

  it('外扩范围内算可见（拖一点就能看到的东西先备好）', () => {
    const candidates = collectPrefetchCandidates(
      [{ position: { x: containerWidth + PREFETCH_VISIBLE_MARGIN - 50, y: 0 }, data: { imageUrl: LOCAL } }],
      viewport,
      containerWidth,
      containerHeight,
    );
    expect(candidates[0].visible).toBe(true);
  });

  it('容器尺寸还没测到时一律按不可见处理（最坏只是走后台队列分批）', () => {
    const candidates = collectPrefetchCandidates(
      [{ position: { x: 0, y: 0 }, data: { imageUrl: LOCAL } }],
      viewport,
      0,
      0,
    );
    expect(candidates[0].visible).toBe(false);
  });

  it('同一个源在多个节点里出现只保留一次', () => {
    const candidates = collectPrefetchCandidates(
      [
        { position: { x: 0, y: 0 }, data: { imageUrl: LOCAL } },
        { position: { x: 400, y: 0 }, data: { imageUrl: LOCAL } },
      ],
      viewport,
      containerWidth,
      containerHeight,
    );
    expect(candidates).toHaveLength(1);
  });
});
