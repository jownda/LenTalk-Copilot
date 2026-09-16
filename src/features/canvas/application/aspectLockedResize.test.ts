import { describe, expect, it } from 'vitest';

import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import {
  AUDIO_ONLY_RESIZE_BOUNDS,
  IMAGE_MEDIA_RESIZE_BOUNDS,
  UPLOAD_MEDIA_RESIZE_BOUNDS,
  VIDEO_MEDIA_RESIZE_BOUNDS,
  parseAspectRatioText,
  resolveAspectLockedResize,
  resolveMediaNodeAspectLock,
  resolveMediaNodeResizeBounds,
} from './aspectLockedResize';

const WIDE_BOUNDS = { minWidth: 96, minHeight: 96, maxWidth: 1600, maxHeight: 1600 };
const RATIO_4_3 = 4 / 3;
const RATIO_16_9 = 16 / 9;
const RATIO_9_16 = 9 / 16;

describe('parseAspectRatioText', () => {
  it('parses common ratio texts', () => {
    expect(parseAspectRatioText('1:1')).toBe(1);
    expect(parseAspectRatioText('16:9')).toBeCloseTo(RATIO_16_9, 6);
    expect(parseAspectRatioText(' 9 : 16 ')).toBeCloseTo(RATIO_9_16, 6);
    expect(parseAspectRatioText('2.35:1')).toBeCloseTo(2.35, 6);
  });

  it('rejects values that do not describe a usable ratio', () => {
    expect(parseAspectRatioText(undefined)).toBeNull();
    expect(parseAspectRatioText(null)).toBeNull();
    expect(parseAspectRatioText(16 / 9)).toBeNull();
    expect(parseAspectRatioText('')).toBeNull();
    expect(parseAspectRatioText('auto')).toBeNull();
    expect(parseAspectRatioText('16/9')).toBeNull();
    expect(parseAspectRatioText('0:9')).toBeNull();
    expect(parseAspectRatioText('16:0')).toBeNull();
  });
});

describe('resolveMediaNodeAspectLock', () => {
  it('locks image like nodes to their aspect ratio', () => {
    expect(resolveMediaNodeAspectLock(CANVAS_NODE_TYPES.imageEdit, { aspectRatio: '4:3' })).toEqual({
      ratio: RATIO_4_3,
      bounds: IMAGE_MEDIA_RESIZE_BOUNDS,
    });
    expect(resolveMediaNodeAspectLock(CANVAS_NODE_TYPES.exportImage, { aspectRatio: '1:1' }))
      .toEqual({ ratio: 1, bounds: IMAGE_MEDIA_RESIZE_BOUNDS });
    expect(resolveMediaNodeAspectLock(CANVAS_NODE_TYPES.upload, { aspectRatio: '16:9' }))
      .toEqual({ ratio: RATIO_16_9, bounds: UPLOAD_MEDIA_RESIZE_BOUNDS });
  });

  it('locks video result nodes but leaves audio only nodes free', () => {
    expect(
      resolveMediaNodeAspectLock(CANVAS_NODE_TYPES.audio, {
        mediaType: 'video',
        aspectRatio: '9:16',
      })
    ).toEqual({ ratio: RATIO_9_16, bounds: VIDEO_MEDIA_RESIZE_BOUNDS });

    expect(
      resolveMediaNodeAspectLock(CANVAS_NODE_TYPES.audio, {
        mediaType: 'audio',
        aspectRatio: '9:16',
      })
    ).toBeNull();
  });

  it('skips nodes without a usable ratio or outside the media set', () => {
    expect(resolveMediaNodeAspectLock(CANVAS_NODE_TYPES.imageEdit, {})).toBeNull();
    expect(resolveMediaNodeAspectLock(CANVAS_NODE_TYPES.imageEdit, { aspectRatio: 'auto' })).toBeNull();
    expect(resolveMediaNodeAspectLock(CANVAS_NODE_TYPES.group, { aspectRatio: '1:1' })).toBeNull();
    expect(resolveMediaNodeAspectLock(CANVAS_NODE_TYPES.storyboardSplit, { aspectRatio: '1:1' })).toBeNull();
  });
});

describe('resolveMediaNodeResizeBounds', () => {
  it('follows the lock when the node is locked', () => {
    expect(resolveMediaNodeResizeBounds(CANVAS_NODE_TYPES.upload, { aspectRatio: '1:1' }))
      .toEqual(UPLOAD_MEDIA_RESIZE_BOUNDS);
  });

  it('falls back to audio-only bounds for audio nodes without a ratio', () => {
    expect(resolveMediaNodeResizeBounds(CANVAS_NODE_TYPES.audio, { mediaType: 'audio' }))
      .toEqual(AUDIO_ONLY_RESIZE_BOUNDS);
  });
});

describe('resolveAspectLockedResize', () => {
  it('keeps the ratio when the pointer stretches horizontally', () => {
    expect(
      resolveAspectLockedResize({
        previous: { width: 400, height: 300 },
        next: { width: 600, height: 300 },
        ratio: RATIO_4_3,
        bounds: WIDE_BOUNDS,
      })
    ).toEqual({ width: 600, height: 450 });
  });

  it('keeps the ratio when the pointer stretches vertically', () => {
    expect(
      resolveAspectLockedResize({
        previous: { width: 400, height: 300 },
        next: { width: 400, height: 450 },
        ratio: RATIO_4_3,
        bounds: WIDE_BOUNDS,
      })
    ).toEqual({ width: 600, height: 450 });
  });

  it('shrinks along whichever edge the pointer moved most', () => {
    expect(
      resolveAspectLockedResize({
        previous: { width: 400, height: 300 },
        next: { width: 200, height: 300 },
        ratio: RATIO_4_3,
        bounds: WIDE_BOUNDS,
      })
    ).toEqual({ width: 200, height: 150 });
  });

  it('keeps a proportional frame untouched', () => {
    expect(
      resolveAspectLockedResize({
        previous: { width: 640, height: 360 },
        next: { width: 800, height: 450 },
        ratio: RATIO_16_9,
        bounds: WIDE_BOUNDS,
      })
    ).toEqual({ width: 800, height: 450 });
  });

  it('never drops below the minimum edges', () => {
    expect(
      resolveAspectLockedResize({
        previous: { width: 400, height: 300 },
        next: { width: 96, height: 96 },
        ratio: RATIO_4_3,
        bounds: WIDE_BOUNDS,
      })
    ).toEqual({ width: 128, height: 96 });
  });

  it('never grows past the maximum edges', () => {
    expect(
      resolveAspectLockedResize({
        previous: { width: 400, height: 300 },
        next: { width: 1600, height: 1600 },
        ratio: RATIO_4_3,
        bounds: WIDE_BOUNDS,
      })
    ).toEqual({ width: 1600, height: 1200 });
  });

  it('keeps portrait video inside its own bounds', () => {
    expect(
      resolveAspectLockedResize({
        previous: { width: 180, height: 320 },
        next: { width: 180, height: 100 },
        ratio: RATIO_9_16,
        bounds: VIDEO_MEDIA_RESIZE_BOUNDS,
      })
    ).toEqual({ width: 180, height: 320 });

    expect(
      resolveAspectLockedResize({
        previous: { width: 180, height: 320 },
        next: { width: 180, height: 400 },
        ratio: RATIO_9_16,
        bounds: VIDEO_MEDIA_RESIZE_BOUNDS,
      })
    ).toEqual({ width: 225, height: 400 });
  });

  it('returns the candidate untouched when the ratio is unusable', () => {
    expect(
      resolveAspectLockedResize({
        previous: { width: 400, height: 300 },
        next: { width: 517, height: 401 },
        ratio: Number.NaN,
        bounds: WIDE_BOUNDS,
      })
    ).toEqual({ width: 517, height: 401 });
  });

  it('falls back to the horizontal edge when the previous size is unknown', () => {
    expect(
      resolveAspectLockedResize({
        previous: { width: 0, height: Number.NaN },
        next: { width: 320, height: 999 },
        ratio: RATIO_4_3,
        bounds: WIDE_BOUNDS,
      })
    ).toEqual({ width: 320, height: 240 });
  });
});

describe('resolveAspectLockedResize 拖拽平滑性', () => {
  const DRAG_BOUNDS = { minWidth: 96, minHeight: 96, maxWidth: 4000, maxHeight: 4000 };
  const START_SIZE = { width: 800, height: 450 };

  /**
   * 模拟一次拖拽: 指针沿固定方向匀速移动, 每帧产生一个自由候选尺寸, 返回相邻帧之间
   * 输出尺寸的最大跳变量。`keepStartSize` 为 true 时基准恒定(修复后 store 的行为);
   * false 时拿上一帧输出当基准(修复前的行为, 基准会随输出一起漂移)。
   */
  function simulateDrag(keepStartSize: boolean): number {
    let previous = START_SIZE;
    let last = resolveAspectLockedResize({
      previous,
      next: START_SIZE,
      ratio: RATIO_16_9,
      bounds: DRAG_BOUNDS,
    });
    let maxStep = 0;

    for (let frame = 1; frame <= 80; frame += 1) {
      const dx = frame * 3;
      const dy = dx * 0.4;
      const out = resolveAspectLockedResize({
        previous,
        next: { width: START_SIZE.width + dx, height: START_SIZE.height + dy },
        ratio: RATIO_16_9,
        bounds: DRAG_BOUNDS,
      });
      maxStep = Math.max(
        maxStep,
        Math.abs(out.width - last.width),
        Math.abs(out.height - last.height)
      );
      last = out;
      previous = keepStartSize ? START_SIZE : out;
    }

    return maxStep;
  }

  it('基准固定为手势起始尺寸时, 逐帧输出保持平缓, 不出现跳变', () => {
    expect(simulateDrag(true)).toBeLessThanOrEqual(4);
  });

  it('拿上一帧输出当基准会因主导轴翻转产生跳变(修复前的成因)', () => {
    expect(simulateDrag(false)).toBeGreaterThan(4);
  });
});
