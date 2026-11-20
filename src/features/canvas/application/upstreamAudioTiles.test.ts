import { describe, expect, it } from 'vitest';
import { audioSourceLabel, buildUpstreamAudioTiles } from './upstreamAudioTiles';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import type { CanvasNode } from '@/stores/canvasStore';

function audioNode(id: string, data: Record<string, unknown>): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.audio,
    position: { x: 0, y: 0 },
    data,
  } as unknown as CanvasNode;
}

describe('audioSourceLabel', () => {
  it('取文件名并去掉扩展名', () => {
    expect(audioSourceLabel('D:/media/out/翻唱样本.mp3')).toBe('翻唱样本');
    expect(audioSourceLabel('asset://localhost/C:/x/y/voice.wav')).toBe('voice');
  });

  it('去掉查询串（生成结果常带 ?t= 之类的缓存戳）', () => {
    expect(audioSourceLabel('https://cdn.example.com/a/b/song.m4a?v=3')).toBe('song');
    expect(audioSourceLabel('https://cdn.example.com/a/b/song.m4a#t=12')).toBe('song');
  });
});

describe('buildUpstreamAudioTiles', () => {
  it('用上游节点标题命名，并把 suno clip id 带出来', () => {
    const nodes = [
      audioNode('n1', {
        sourcePath: 'D:/media/a.mp3',
        displayName: '副歌 demo',
        sunoResultClipId: 'clip-123',
      }),
    ];
    expect(buildUpstreamAudioTiles(['D:/media/a.mp3'], nodes)).toEqual([
      { source: 'D:/media/a.mp3', label: '副歌 demo', clipId: 'clip-123' },
    ]);
  });

  it('默认标题(媒体/音频)没有区分度，退回文件名', () => {
    const nodes = [
      audioNode('n1', { sourcePath: 'D:/media/a.mp3', displayName: '媒体' }),
      audioNode('n2', { sourcePath: 'D:/media/b.mp3', displayName: '音频' }),
    ];
    const tiles = buildUpstreamAudioTiles(['D:/media/a.mp3', 'D:/media/b.mp3'], nodes);
    expect(tiles.map((tile) => tile.label)).toEqual(['a', 'b']);
  });

  it('普通音频节点没有 clip id —— Suno 不能直接拿它当翻唱源', () => {
    const nodes = [audioNode('n1', { sourcePath: 'D:/media/a.mp3' })];
    expect(buildUpstreamAudioTiles(['D:/media/a.mp3'], nodes)[0]!.clipId).toBe('');
  });

  it('找不到来源节点时仍给出占位名，不会显示空白格', () => {
    expect(buildUpstreamAudioTiles(['D:/media/未知素材.mp3'], [])[0]).toEqual({
      source: 'D:/media/未知素材.mp3',
      label: '未知素材',
      clipId: '',
    });
  });

  it('保持 collectInputAudio 的顺序（提交时的 音频1/音频2 与这里一致）', () => {
    const nodes = [
      audioNode('n1', { sourcePath: 'D:/a.mp3', displayName: '一' }),
      audioNode('n2', { sourcePath: 'D:/b.mp3', displayName: '二' }),
    ];
    const tiles = buildUpstreamAudioTiles(['D:/b.mp3', 'D:/a.mp3'], nodes);
    expect(tiles.map((tile) => tile.label)).toEqual(['二', '一']);
  });
});
