import { describe, expect, it } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode, type CanvasNodeType } from '@/features/canvas/domain/canvasNodes';
import {
  buildBatchConnections,
  countBatchConnections,
  resolveBatchAnchorCandidates,
} from './batchNodeConnection';

function node(id: string, type: CanvasNodeType, selected = false): CanvasNode {
  return { id, type, position: { x: 0, y: 0 }, data: {}, selected } as unknown as CanvasNode;
}

const UPLOAD = CANVAS_NODE_TYPES.upload; // 图片/视频素材：只有 source 端口
const AUDIO = CANVAS_NODE_TYPES.audio;
const IMAGE_EDIT = CANVAS_NODE_TYPES.imageEdit; // AI 图片
const VIDEO_GEN = CANVAS_NODE_TYPES.videoGen; // AI 视频
const GROUP = CANVAS_NODE_TYPES.group;

describe('buildBatchConnections', () => {
  it('connects every selected upstream node when the dragged node is inside the selection', () => {
    const nodes = [
      node('img1', UPLOAD, true),
      node('img2', UPLOAD, true),
      node('aud1', AUDIO, true),
      node('vg1', VIDEO_GEN),
    ];

    const result = buildBatchConnections({
      anchorNodeId: 'img1',
      peerNodeId: 'vg1',
      anchorHandleType: 'source',
      nodes,
    });

    expect(result.map((item) => `${item.source}->${item.target}`)).toEqual([
      'img1->vg1',
      'img2->vg1',
      'aud1->vg1',
    ]);
    expect(result.every((item) => item.sourceHandle === 'source' && item.targetHandle === 'target')).toBe(
      true,
    );
  });

  it('stays a single connection when the dragged node is outside the selection', () => {
    // 从框选范围外的节点拖线，不应该顺手把旁边选中的一堆也连上。
    const nodes = [node('img1', UPLOAD), node('img2', UPLOAD, true), node('vg1', VIDEO_GEN)];

    const result = buildBatchConnections({
      anchorNodeId: 'img1',
      peerNodeId: 'vg1',
      anchorHandleType: 'source',
      nodes,
    });

    expect(result).toEqual([
      { source: 'img1', target: 'vg1', sourceHandle: 'source', targetHandle: 'target' },
    ]);
  });

  it('stays a single connection when only the dragged node itself is selected', () => {
    const nodes = [node('img1', UPLOAD, true), node('vg1', VIDEO_GEN)];

    expect(
      buildBatchConnections({
        anchorNodeId: 'img1',
        peerNodeId: 'vg1',
        anchorHandleType: 'source',
        nodes,
      }),
    ).toHaveLength(1);
  });

  it('fans out to every selected target when dragging in reverse', () => {
    // 反向拖入：一个源接到多个选中的下游节点。
    const nodes = [
      node('img1', UPLOAD),
      node('vg1', VIDEO_GEN, true),
      node('vg2', VIDEO_GEN, true),
      node('vg3', IMAGE_EDIT, true),
    ];

    const result = buildBatchConnections({
      anchorNodeId: 'vg1',
      peerNodeId: 'img1',
      anchorHandleType: 'target',
      nodes,
    });

    expect(result.map((item) => `${item.source}->${item.target}`)).toEqual([
      'img1->vg1',
      'img1->vg2',
      'img1->vg3',
    ]);
  });

  it('leaves group nodes out of the batch even when they are selected', () => {
    // 组体积大，框选时几乎必然被圈进来；它是容器不是素材，不该被顺手连上。
    const nodes = [
      node('g1', GROUP, true),
      node('img1', UPLOAD, true),
      node('img2', UPLOAD, true),
      node('vg1', VIDEO_GEN),
    ];

    const result = buildBatchConnections({
      anchorNodeId: 'img1',
      peerNodeId: 'vg1',
      anchorHandleType: 'source',
      nodes,
    });

    expect(result.map((item) => item.source)).toEqual(['img1', 'img2']);
  });

  it('keeps a group anchor as a single connection', () => {
    // 从组自己拉线时照旧只连一条（组另有「从组派生下游」的语义）。
    const nodes = [node('g1', GROUP, true), node('img1', UPLOAD, true), node('vg1', VIDEO_GEN)];

    const result = buildBatchConnections({
      anchorNodeId: 'g1',
      peerNodeId: 'vg1',
      anchorHandleType: 'source',
      nodes,
    });

    expect(result).toEqual([
      { source: 'g1', target: 'vg1', sourceHandle: 'source', targetHandle: 'target' },
    ]);
  });

  it('never connects a node to itself when the peer is also selected', () => {
    const nodes = [node('img1', UPLOAD, true), node('img2', UPLOAD, true), node('vg1', VIDEO_GEN, true)];

    const result = buildBatchConnections({
      anchorNodeId: 'img1',
      peerNodeId: 'vg1',
      anchorHandleType: 'source',
      nodes,
    });

    expect(result.every((item) => item.source !== item.target)).toBe(true);
    expect(result.map((item) => item.source).sort()).toEqual(['img1', 'img2']);
  });

  it('drops everything when the peer end cannot accept a connection', () => {
    // 素材节点（upload）没有 target 端口：正向拖线到它上面不会产生任何连接。
    const nodes = [node('img1', UPLOAD), node('vg1', VIDEO_GEN, true), node('vg2', VIDEO_GEN, true)];

    expect(
      buildBatchConnections({
        anchorNodeId: 'vg1',
        peerNodeId: 'img1',
        anchorHandleType: 'source',
        nodes,
      }),
    ).toEqual([]);
  });

  it('returns nothing for a self-connection or a missing node', () => {
    const nodes = [node('img1', UPLOAD, true), node('vg1', VIDEO_GEN, true)];

    expect(
      buildBatchConnections({
        anchorNodeId: 'img1',
        peerNodeId: 'img1',
        anchorHandleType: 'source',
        nodes,
      }),
    ).toEqual([]);
    expect(
      buildBatchConnections({
        anchorNodeId: 'img1',
        peerNodeId: 'missing',
        anchorHandleType: 'source',
        nodes,
      }),
    ).toEqual([]);
  });

  it('counts the same connections it builds', () => {
    const nodes = [node('img1', UPLOAD, true), node('img2', UPLOAD, true), node('vg1', VIDEO_GEN)];

    expect(
      countBatchConnections({ anchorNodeId: 'img1', peerNodeId: 'vg1', anchorHandleType: 'source', nodes }),
    ).toBe(2);
  });
});

/**
 * 拖拽过程中的「幽灵线」用的就是这一份候选判定。
 * 这里钉住的核心不变量：**看到几条线，松手就落地几条边**。
 */
describe('resolveBatchAnchorCandidates', () => {
  it('lists every eligible selected node, keeping the canvas order', () => {
    const nodes = [
      node('img1', UPLOAD, true),
      node('img2', UPLOAD, true),
      node('aud1', AUDIO, true),
    ];

    expect(
      resolveBatchAnchorCandidates({ anchorNodeId: 'img1', anchorHandleType: 'source', nodes }).map(
        (item) => item.id,
      ),
    ).toEqual(['img1', 'img2', 'aud1']);
  });

  it('returns only the anchor when the anchor itself is not selected', () => {
    // 从框选范围外拉线：不该凭空多出几条线来。
    const nodes = [node('img1', UPLOAD), node('img2', UPLOAD, true), node('img3', UPLOAD, true)];

    expect(
      resolveBatchAnchorCandidates({ anchorNodeId: 'img1', anchorHandleType: 'source', nodes }).map(
        (item) => item.id,
      ),
    ).toEqual(['img1']);
  });

  it('skips group nodes even when they are selected', () => {
    const nodes = [node('g1', GROUP, true), node('img1', UPLOAD, true), node('img2', UPLOAD, true)];

    expect(
      resolveBatchAnchorCandidates({ anchorNodeId: 'img1', anchorHandleType: 'source', nodes }).map(
        (item) => item.id,
      ),
    ).toEqual(['img1', 'img2']);
  });

  it('keeps a group anchor on its own', () => {
    const nodes = [node('g1', GROUP, true), node('img1', UPLOAD, true)];

    expect(
      resolveBatchAnchorCandidates({ anchorNodeId: 'g1', anchorHandleType: 'source', nodes }).map(
        (item) => item.id,
      ),
    ).toEqual(['g1']);
  });

  it('filters by the handle the user actually dragged', () => {
    // 反向拖（从 target 端口起手）：没有 target 端口的素材节点该出局。
    const nodes = [
      node('img1', UPLOAD, true),
      node('img2', UPLOAD, true),
      node('vg1', VIDEO_GEN, true),
      node('vg2', VIDEO_GEN, true),
    ];

    expect(
      resolveBatchAnchorCandidates({ anchorNodeId: 'vg1', anchorHandleType: 'target', nodes }).map(
        (item) => item.id,
      ),
    ).toEqual(['vg1', 'vg2']);
  });

  it('returns nothing for a missing anchor', () => {
    expect(
      resolveBatchAnchorCandidates({ anchorNodeId: 'nope', anchorHandleType: 'source', nodes: [] }),
    ).toEqual([]);
  });

  it('never shows more ghost lines than the connections it will actually build', () => {
    const nodes = [
      node('g1', GROUP, true),
      node('img1', UPLOAD, true),
      node('img2', UPLOAD, true),
      node('img3', UPLOAD),
      node('aud1', AUDIO, true),
      node('vg1', VIDEO_GEN),
    ];

    const candidates = resolveBatchAnchorCandidates({
      anchorNodeId: 'img1',
      anchorHandleType: 'source',
      nodes,
    });
    const connections = buildBatchConnections({
      anchorNodeId: 'img1',
      peerNodeId: 'vg1',
      anchorHandleType: 'source',
      nodes,
    });

    // 幽灵线数 = 候选数 - 1（锚点自己那条是主线），必须与落地的边数一致。
    expect(candidates.filter((item) => item.id !== 'img1')).toHaveLength(connections.length - 1);
    expect(connections.map((item) => item.source)).toEqual(
      candidates.map((item) => item.id),
    );
  });
});
