import { describe, expect, it } from 'vitest';

import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { collectUnpersistedMedia, summarizeUnpersistedMedia } from './unpersistedMedia';

function node(id: string, type: string, data: Record<string, unknown>): CanvasNode {
  return { id, type, position: { x: 0, y: 0 }, data } as unknown as CanvasNode;
}

/** 够长的内联 base64：`isLocalizableMediaSource` 的门槛是 4096 字符。 */
const BIG_DATA_URL = `data:image/png;base64,${'A'.repeat(4200)}`;

describe('collectUnpersistedMedia', () => {
  it('认出仍指向网络链接的媒体字段', () => {
    const hits = collectUnpersistedMedia([
      node('v1', 'videoGenNode', { sourcePath: 'https://cdn.example.com/a.mp4' }),
      node('i1', 'imageNode', { imageUrl: 'https://cdn.example.com/b.png' }),
    ]);

    expect(hits.map((hit) => [hit.nodeId, hit.key, hit.kind])).toEqual([
      ['v1', 'sourcePath', 'remote'],
      ['i1', 'imageUrl', 'remote'],
    ]);
  });

  it('本地路径、asset 协议、小内联图都不算', () => {
    const hits = collectUnpersistedMedia([
      node('a', 'imageNode', { imageUrl: 'C:\\Users\\me\\Downloads\\LenTalk\\images\\x.png' }),
      node('b', 'videoGenNode', { sourcePath: 'asset://localhost/x.mp4' }),
      node('c', 'imageNode', { imageUrl: 'data:image/png;base64,AAAA' }),
    ]);

    expect(hits).toEqual([]);
  });

  it('够大的内联 base64 算「未落盘」，但标成 inline', () => {
    const hits = collectUnpersistedMedia([node('a', 'imageNode', { imageUrl: BIG_DATA_URL })]);
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe('inline');
  });

  it('只认媒体字段名：提示词里的链接不能算', () => {
    const hits = collectUnpersistedMedia([
      node('t', 'textAnnotation', {
        prompt: '参考 https://example.com/ref.png 的光线，保持构图',
        note: 'https://example.com/a.mp4',
      }),
    ]);

    expect(hits).toEqual([]);
  });

  it('数组字段按元素展开，并带下标', () => {
    const hits = collectUnpersistedMedia([
      node('v', 'videoGenNode', {
        referenceImages: ['C:\\local\\a.png', 'https://cdn.example.com/c.png'],
      }),
    ]);

    expect(hits).toHaveLength(1);
    expect(hits[0].key).toBe('referenceImages[1]');
  });

  it('节点标题优先用 label，没有就退回节点类型', () => {
    const hits = collectUnpersistedMedia([
      node('a', 'videoGenNode', { label: '巷战镜头', sourcePath: 'https://cdn.example.com/a.mp4' }),
      node('b', 'imageNode', { imageUrl: 'https://cdn.example.com/b.png' }),
    ]);

    expect(hits[0].nodeLabel).toBe('巷战镜头');
    expect(hits[1].nodeLabel).toBe('imageNode');
  });
});

describe('summarizeUnpersistedMedia', () => {
  it('同一条链接挂在多个节点上只算一次，节点数照实计', () => {
    const shared = 'https://cdn.example.com/shared.png';
    const summary = summarizeUnpersistedMedia(
      collectUnpersistedMedia([
        node('a', 'imageNode', { imageUrl: shared }),
        node('b', 'imageEditNode', { imageUrl: shared }),
        node('c', 'videoGenNode', { sourcePath: 'https://cdn.example.com/v.mp4' }),
      ]),
    );

    expect(summary).toEqual({ total: 2, remote: 2, inline: 0, nodes: 3, remoteNodes: 3 });
  });

  it('空输入返回全零', () => {
    expect(summarizeUnpersistedMedia([])).toEqual({
      total: 0,
      remote: 0,
      inline: 0,
      nodes: 0,
      remoteNodes: 0,
    });
  });

  it('只有内嵌数据的节点不计入 remoteNodes', () => {
    const summary = summarizeUnpersistedMedia(
      collectUnpersistedMedia([
        node('a', 'imageNode', { imageUrl: BIG_DATA_URL }),
        node('b', 'imageNode', { imageUrl: 'https://cdn.example.com/b.png' }),
      ]),
    );

    expect(summary.remote).toBe(1);
    expect(summary.inline).toBe(1);
    expect(summary.nodes).toBe(2);
    expect(summary.remoteNodes).toBe(1);
  });
});
