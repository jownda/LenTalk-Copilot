import { describe, expect, it } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode } from '../domain/canvasNodes';
import {
  NODE_MANAGER_UNGROUPED_SECTION_ID,
  buildNodeManagerSections,
  collectCanvasMediaEntries,
  type CanvasMediaEntry,
} from './canvasMediaIndex';

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

  it('倒序输出(最新创建的排最前), 并把无媒体节点排在列表之外', () => {
    const entries = collectCanvasMediaEntries([
      makeNode(CANVAS_NODE_TYPES.upload, { imageUrl: 'first.png' }, 'first'),
      makeNode(CANVAS_NODE_TYPES.textAnnotation, { content: '纯文本' }, 'text'),
      makeNode(CANVAS_NODE_TYPES.exportImage, { imageUrl: 'second.png' }, 'second'),
    ]);

    expect(entries.map((entry) => entry.nodeId)).toEqual(['second', 'first']);
  });

  it('把 React Flow 的 parentId 带进索引项(侧栏靠它归组)', () => {
    const grouped = makeNode(CANVAS_NODE_TYPES.upload, { imageUrl: 'a.png' }, 'a');
    grouped.parentId = 'group-1';
    const entries = collectCanvasMediaEntries([grouped, makeNode(CANVAS_NODE_TYPES.upload, { imageUrl: 'b.png' }, 'b')]);

    const byId = new Map(entries.map((entry) => [entry.nodeId, entry]));
    expect(byId.get('a')?.parentId).toBe('group-1');
    expect(byId.get('b')?.parentId).toBeNull();
  });
});

function fakeEntry(nodeId: string, parentId: string | null = null): CanvasMediaEntry {
  return {
    nodeId,
    nodeType: 'audioNode',
    kind: 'video',
    thumbnailUrl: null,
    previewUrl: `/media/${nodeId}.mp4`,
    previewList: [],
    displayName: nodeId,
    parentId,
  };
}

describe('节点管理侧栏的分节', () => {
  it('按 parentId 把条目归到对应分组', () => {
    const sections = buildNodeManagerSections(
      [fakeEntry('a', 'g1'), fakeEntry('b', 'g2'), fakeEntry('c', 'g1')],
      [
        { id: 'g1', label: '备选' },
        { id: 'g2', label: '剪辑画面' },
      ],
      '未分组',
    );
    expect(sections.map((section) => section.id)).toEqual(['g1', 'g2']);
    expect(sections[0]?.entries.map((item) => item.nodeId)).toEqual(['a', 'c']);
    expect(sections[1]?.entries.map((item) => item.nodeId)).toEqual(['b']);
  });

  it('parentId 指向已删除的分组时落回「未分组」，不能整条消失', () => {
    // 画布上删掉分组节点后，组内节点的 parentId 可能还留着旧 id。
    const sections = buildNodeManagerSections([fakeEntry('a', 'gone'), fakeEntry('b')], [], '未分组');
    expect(sections).toHaveLength(1);
    expect(sections[0]?.id).toBe(NODE_MANAGER_UNGROUPED_SECTION_ID);
    expect(sections[0]?.entries.map((item) => item.nodeId)).toEqual(['a', 'b']);
  });

  it('空分组不出现，「未分组」永远排最后', () => {
    const sections = buildNodeManagerSections(
      [fakeEntry('a', 'g2'), fakeEntry('b')],
      [
        { id: 'g1', label: '空的' },
        { id: 'g2', label: '有内容' },
      ],
      '未分组',
    );
    // g1 没有成员 → 不渲染；这样画布上一堆空组不会把真正的产物挤走。
    expect(sections.map((section) => section.id)).toEqual(['g2', NODE_MANAGER_UNGROUPED_SECTION_ID]);
  });

  it('没有任何条目时不产生空节', () => {
    expect(buildNodeManagerSections([], [{ id: 'g1', label: '分组' }], '未分组')).toEqual([]);
  });

  it('全部在组内时不额外追加「未分组」', () => {
    const sections = buildNodeManagerSections([fakeEntry('a', 'g1')], [{ id: 'g1', label: '备选' }], '未分组');
    expect(sections).toHaveLength(1);
    expect(sections[0]?.id).toBe('g1');
  });
});
