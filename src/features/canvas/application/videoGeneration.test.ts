import { describe, expect, it } from 'vitest';

import { toVideoGenerationRequest } from './videoGeneration';

describe('toVideoGenerationRequest', () => {
  it('maps first-last references to dedicated frame fields', () => {
    const request = toVideoGenerationRequest({
      model: 'custom:wgspai/minimax-h3',
      prompt: 'transition',
      duration: 5,
      aspectRatio: '16:9',
      imageMode: 'first-last',
      referenceImages: ['/tmp/start.png', 'data:image/png;base64,abc'],
      referenceAudio: [],
    });

    expect(request.referenceImages).toEqual([]);
    expect(request.firstFrame?.sourceKind).toBe('local-file');
    expect(request.lastFrame?.sourceKind).toBe('data-url');
  });
});
