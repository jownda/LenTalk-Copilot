import { describe, expect, it } from 'vitest';

import {
  createVideoIdempotencyKey,
  getVideoTaskFailureReason,
  resolveRjmVideoApiBaseUrl,
} from './videoApi';

describe('RJM video API recognition', () => {
  it.each([
    ['https://video.rjm.us.ci', 'https://video.rjm.us.ci'],
    ['https://video.rjm.us.ci/v1', 'https://video.rjm.us.ci'],
    ['https://sub2api.rjm.us.ci/v1', 'https://video.rjm.us.ci'],
  ])('normalizes %s to the dedicated video host', (input, expected) => {
    expect(resolveRjmVideoApiBaseUrl(input)).toBe(expected);
  });

  it('does not intercept unrelated providers', () => {
    expect(resolveRjmVideoApiBaseUrl('https://api.7tai.cc/v1')).toBeNull();
  });

  it('uses a unique idempotency key for every new request', () => {
    expect(createVideoIdempotencyKey()).not.toBe(createVideoIdempotencyKey());
  });

  it('extracts nested provider failure reasons', () => {
    expect(getVideoTaskFailureReason({ data: { task: { error: { message: 'resolution is required' } } } }))
      .toBe('resolution is required');
  });
});
