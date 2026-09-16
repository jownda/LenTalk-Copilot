import { describe, expect, it } from 'vitest';

import {
  FALLBACK_IMAGE_RESOLUTIONS,
  resolveDeclaredImageResolutions,
  resolveImageModelResolutionOptions,
} from './imageModelCapabilities';

describe('resolveDeclaredImageResolutions', () => {
  it('reads a single tier from a suffixed model name', () => {
    expect(resolveDeclaredImageResolutions('qwen-image-3.0-pro-1k')).toEqual([
      { value: '1K', label: '1K' },
    ]);
    expect(resolveDeclaredImageResolutions('flux-2k')).toEqual([{ value: '2K', label: '2K' }]);
    expect(resolveDeclaredImageResolutions('sd-4k')).toEqual([{ value: '4K', label: '4K' }]);
  });

  it('accepts underscore, dot and slash separators', () => {
    expect(resolveDeclaredImageResolutions('sdxl_4k_upscale')).toEqual([
      { value: '4K', label: '4K' },
    ]);
    expect(resolveDeclaredImageResolutions('4k-upscaler')).toEqual([{ value: '4K', label: '4K' }]);
    expect(resolveDeclaredImageResolutions('vendor/flux.2k')).toEqual([
      { value: '2K', label: '2K' },
    ]);
  });

  it('is case insensitive', () => {
    expect(resolveDeclaredImageResolutions('FLUX-2K')).toEqual([{ value: '2K', label: '2K' }]);
  });

  it('returns every declared tier in 1K -> 2K -> 4K order', () => {
    expect(resolveDeclaredImageResolutions('flux-4k-2k')).toEqual([
      { value: '2K', label: '2K' },
      { value: '4K', label: '4K' },
    ]);
  });

  it('returns null when the name declares no tier', () => {
    expect(resolveDeclaredImageResolutions('nano-banana-pro')).toBeNull();
    expect(resolveDeclaredImageResolutions('gpt-image-1.5')).toBeNull();
    expect(resolveDeclaredImageResolutions('')).toBeNull();
    expect(resolveDeclaredImageResolutions('   ')).toBeNull();
  });

  it('does not mistake version digits for tiers', () => {
    // 版本号里的数字后面没有 k, 不能当成档位
    expect(resolveDeclaredImageResolutions('gpt-image-1')).toBeNull();
    expect(resolveDeclaredImageResolutions('seedream-4')).toBeNull();
    expect(resolveDeclaredImageResolutions('qwen-image-3.0')).toBeNull();
    // 数字与 k 之间必须有分隔符, 否则视为型号的一部分
    expect(resolveDeclaredImageResolutions('image1k')).toBeNull();
    expect(resolveDeclaredImageResolutions('flux-2k4k')).toBeNull();
  });
});

describe('resolveImageModelResolutionOptions', () => {
  it('narrows to the declared tier when the name carries one', () => {
    expect(resolveImageModelResolutionOptions('qwen-image-3.0-pro-1k')).toEqual([
      { value: '1K', label: '1K' },
    ]);
  });

  it('falls back to 1K / 2K / 4K when no tier can be read', () => {
    expect(resolveImageModelResolutionOptions('nano-banana-pro')).toEqual(
      FALLBACK_IMAGE_RESOLUTIONS
    );
    expect(FALLBACK_IMAGE_RESOLUTIONS.map((option) => option.value)).toEqual(['1K', '2K', '4K']);
  });
});
