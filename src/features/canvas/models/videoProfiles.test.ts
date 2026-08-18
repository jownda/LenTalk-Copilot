import { describe, expect, it } from 'vitest';

import { resolveVideoModelProfile } from './videoProfiles';

describe('resolveVideoModelProfile', () => {
  it('marks MiniMax H3 as the verified profile', () => {
    const profile = resolveVideoModelProfile('custom:wgspai/minimax-h3');
    expect(profile.id).toBe('minimax-h3');
    expect(profile.status).toBe('verified');
    expect(profile.referenceImageTarget).toBe('platform-file');
  });

  it('keeps Seedance 2 separate and pending adaptation', () => {
    const profile = resolveVideoModelProfile('custom:wgspai/seedance-v2-1080p');
    expect(profile.id).toBe('seedance-v2');
    expect(profile.status).toBe('pending-adaptation');
    expect(profile.supportsReferenceImages).toBe(false);
  });

  it('uses the standard profile for explicitly compatible custom models', () => {
    expect(resolveVideoModelProfile('custom:provider/model').id).toBe('openai-video');
  });
});
