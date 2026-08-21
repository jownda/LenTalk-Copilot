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
});
