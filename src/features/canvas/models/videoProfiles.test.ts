import { describe, expect, it } from 'vitest';

import { resolveVideoModelProfile } from './videoProfiles';

describe('resolveVideoModelProfile', () => {
  it('uses the generic profile for custom video models', () => {
    const profile = resolveVideoModelProfile('custom:provider/minimax-h3');
    expect(profile.id).toBe('openai-video');
    expect(profile.status).toBe('verified');
  });

  it('maps Seedance 2 to the generic verified profile (no local block)', () => {
    const profile = resolveVideoModelProfile('custom:provider/seedance-v2-1080p');
    expect(profile.id).toBe('seedance-v2');
    expect(profile.status).toBe('verified');
    expect(profile.unavailableReason).toBeUndefined();
    expect(profile.supportsReferenceImages).toBe(false);
  });

  it('maps 即梦 CLI Seedance models to the local CLI profile (no local block)', () => {
    const profile = resolveVideoModelProfile('jimeng-cli/seedance2.0');
    expect(profile.id).toBe('jimeng-cli');
    expect(profile.status).toBe('verified');
    expect(profile.supportsFirstLast).toBe(true);
    expect(profile.supportsReferenceAudio).toBe(true);
  });

  it('uses the standard profile for explicitly compatible custom models', () => {
    expect(resolveVideoModelProfile('custom:provider/model').id).toBe('openai-video');
  });

  it('routes 字子动画 models through the verified v8 profile', () => {
    const profile = resolveVideoModelProfile('custom:zizidonghua/Kling-3.0');
    expect(profile.id).toBe('zzdh-v8-video');
    expect(profile.submitPath).toBe('/v8/videos/generations');
    expect(profile.supportsFirstLast).toBe(true);
  });

  it('routes Sub2API video models through the files and videos profile', () => {
    const profile = resolveVideoModelProfile('custom:sub2api-video/seedance2.5');
    expect(profile.id).toBe('sub2api-video');
    expect(profile.submitPath).toBe('/v1/videos');
    expect(profile.queryPath).toBe('/v1/videos/{taskId}');
    expect(profile.referenceImageTarget).toBe('platform-file');
    expect(profile.supportsReferenceImages).toBe(true);
  });

  it('recognizes an RJM URL even when the custom platform has a different id', () => {
    expect(resolveVideoModelProfile('custom:my-platform/seedance2.5', 'https://sub2api.rjm.us.ci/v1').id)
      .toBe('sub2api-video');
  });
});
