import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createHoverIntent,
  formatMediaByteSize,
  formatMediaDimensions,
  HOVER_INTENT_DELAY_MS,
} from './MediaDimensions';

describe('formatMediaByteSize', () => {
  it('renders bytes without decimals', () => {
    expect(formatMediaByteSize(1)).toBe('1 B');
    expect(formatMediaByteSize(512)).toBe('512 B');
  });

  it('switches to KB at 1024 bytes with no decimals', () => {
    expect(formatMediaByteSize(1024)).toBe('1 KB');
    expect(formatMediaByteSize(1500)).toBe('1 KB');
  });

  it('switches to MB at 1 MiB and keeps one decimal', () => {
    expect(formatMediaByteSize(1024 * 1024)).toBe('1 MB');
    expect(formatMediaByteSize(1_258_291)).toBe('1.2 MB');
  });

  it('switches to GB at 1 GiB', () => {
    expect(formatMediaByteSize(1024 * 1024 * 1024)).toBe('1 GB');
    expect(formatMediaByteSize(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB');
  });

  it('returns null for missing or invalid sizes so the label can degrade', () => {
    expect(formatMediaByteSize(null)).toBeNull();
    expect(formatMediaByteSize(undefined)).toBeNull();
    expect(formatMediaByteSize(0)).toBeNull();
    expect(formatMediaByteSize(-5)).toBeNull();
    expect(formatMediaByteSize(Number.NaN)).toBeNull();
    expect(formatMediaByteSize(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('formatMediaDimensions', () => {
  it('renders pixel dimensions', () => {
    expect(formatMediaDimensions({ width: 1920, height: 1080 })).toBe('1920 × 1080px');
  });

  it('returns null when dimensions are unavailable', () => {
    expect(formatMediaDimensions(null)).toBeNull();
  });
});

describe('createHoverIntent', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(delayMs: number = HOVER_INTENT_DELAY_MS) {
    vi.useFakeTimers();
    const changes: boolean[] = [];
    const controller = createHoverIntent({
      delayMs,
      onVisibilityChange: (visible) => changes.push(visible),
    });
    return { controller, changes };
  }

  it('defaults the hover delay to 1.5s', () => {
    expect(HOVER_INTENT_DELAY_MS).toBe(1500);
  });

  it('stays hidden until the pointer has rested for the full delay', () => {
    const { controller, changes } = setup();

    controller.enter();
    vi.advanceTimersByTime(1499);
    expect(controller.visible).toBe(false);
    expect(changes).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(controller.visible).toBe(true);
    expect(changes).toEqual([true]);
  });

  it('never reveals when the pointer leaves before the delay elapses', () => {
    const { controller, changes } = setup();

    controller.enter();
    vi.advanceTimersByTime(1400);
    controller.leave();
    vi.advanceTimersByTime(5000);

    expect(controller.visible).toBe(false);
    expect(changes).toEqual([]);
  });

  it('restarts the delay when the pointer re-enters', () => {
    const { controller } = setup();

    controller.enter();
    vi.advanceTimersByTime(1000);
    controller.leave();
    controller.enter();
    vi.advanceTimersByTime(1000);
    expect(controller.visible).toBe(false);

    vi.advanceTimersByTime(500);
    expect(controller.visible).toBe(true);
  });

  it('hides immediately once the pointer leaves a revealed label', () => {
    const { controller, changes } = setup();

    controller.enter();
    vi.advanceTimersByTime(1500);
    controller.leave();

    expect(controller.visible).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it('does not re-notify while the pointer keeps moving inside the node', () => {
    const { controller, changes } = setup();

    controller.enter();
    vi.advanceTimersByTime(1500);
    controller.enter();
    controller.enter();
    vi.advanceTimersByTime(5000);

    expect(changes).toEqual([true]);
  });

  it('cancels a pending reveal when disposed', () => {
    const { controller } = setup();

    controller.enter();
    controller.dispose();
    vi.advanceTimersByTime(5000);

    expect(controller.visible).toBe(false);
  });
});
