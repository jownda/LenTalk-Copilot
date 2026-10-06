import { describe, expect, it } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode } from '../domain/canvasNodes';
import { collectCanvasMediaEntries } from './canvasMediaIndex';

function makeNode(
  type: string,
  data: Record<string, unknown>,
  id = `${type}-1`,
): CanvasNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data,
  } as unknown as CanvasNode;
}

describe('collectCanvasMediaEntries', () => {
  it('图片节点用 previewImageUrl 当缩略图, imageUrl 当预览原图', () => {
    const entries = collectCanvasMediaEntries([
      makeNode(CANVAS_NODE_TYPES.imageEdit, {
        imageUrl: 'full.png',
        previewImageUrl: 'thumb.png',
        displayName: '主图',
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'image',
      thumbnailUrl: 'thumb.png',
      previewUrl: 'full.png',
      previewList: ['full.png'],
      displayName: '主图',
    });
  });

  it('没有图像产物的图片节点不产出条目', () => {
    const entries = collectCanvasMediaEntries([
      makeNode(CANVAS_NODE_TYPES.imageEdit, { imageUrl: null }),
    ]);

    expect(entries).toHaveLength(0);
  });

  it('分镜拆分节点把每一帧收进预览列表', () => {
    const entries = collectCanvasMediaEntries([
      makeNode(CANVAS_NODE_TYPES.storyboardSplit, {
        frames: [
          { id: 'f1', imageUrl: 'a.png', previewImageUrl: 'a-thumb.png', note: '', order: 0 },
          { id: 'f2', imageUrl: 'b.png', note: '', order: 1 },
          { id: 'f3', imageUrl: null, note: '', order: 2 },
        ],
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0].previewList).toEqual(['a.png', 'b.png']);
    expect(entries[0].thumbnailUrl).toBe('a-thumb.png');
  });

  it('媒体节点只收视频, 纯音频忽略', () => {
    const entries = collectCanvasMediaEntries([
      makeNode(CANVAS_NODE_TYPES.audio, { mediaType: 'audio', sourcePath: '/tmp/a.mp3' }, 'audio-1'),
      makeNode(
        CANVAS_NODE_TYPES.audio,
        { mediaType: 'video', sourcePath: '/tmp/v.mp4', previewImageUrl: '/tmp/v.jpg' },
        'video-1',
      ),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      nodeId: 'video-1',
      kind: 'video',
      previewUrl: '/tmp/v.mp4',
      thumbnailUrl: '/tmp/v.jpg',
    });
  });

  it('视频节点没有封面时缩略图为空(交给 UI 显示占位图标)', () => {
    const entries = collectCanvasMediaEntries([
      makeNode(CANVAS_NODE_TYPES.audio, { mediaType: 'video', sourcePath: '/tmp/v.mp4' }),
    ]);

    expect(entries[0].thumbnailUrl).toBeNull();
  });

  it('保持画布中的节点顺序, 并把无媒体节点排在列表之外', () => {
    const entries = collectCanvasMediaEntries([
      makeNode(CANVAS_NODE_TYPES.upload, { imageUrl: 'first.png' }, 'first'),
      makeNode(CANVAS_NODE_TYPES.textAnnotation, { content: '纯文本' }, 'text'),
      makeNode(CANVAS_NODE_TYPES.exportImage, { imageUrl: 'second.png' }, 'second'),
    ]);

    expect(entries.map((entry) => entry.nodeId)).toEqual(['first', 'second']);
  });
});
