import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PAJUBEN_QUALITY_TIER,
  PAJUBEN_QUALITY_PRESETS,
  PAJUBEN_QUALITY_TIERS,
  isPajubenQualityTier,
  resolvePajubenQualityPreset,
} from './pajubenQuality';

describe('pajubenQuality 画质档位', () => {
  it('三档齐备，且 fps / 清晰度 / 帧数上限逐档递增', () => {
    const [fast, standard, fine] = PAJUBEN_QUALITY_TIERS.map((t) => PAJUBEN_QUALITY_PRESETS[t]);
    expect(fast.fps).toBeLessThan(standard.fps);
    expect(standard.fps).toBeLessThan(fine.fps);
    expect(fast.maxFrames).toBeLessThan(standard.maxFrames);
    expect(standard.maxFrames).toBeLessThan(fine.maxFrames);
    expect([fast.resolution, standard.resolution, fine.resolution]).toEqual(['low', 'medium', 'high']);
  });

  it('快速档与旧默认一致(fps 1 / low / 120)，保证最省 token', () => {
    expect(PAJUBEN_QUALITY_PRESETS.fast).toEqual({
      tier: 'fast',
      fps: 1,
      resolution: 'low',
      maxFrames: 120,
    });
  });

  it('默认档为「标准」，且它不是最省档', () => {
    expect(DEFAULT_PAJUBEN_QUALITY_TIER).toBe('standard');
    expect(resolvePajubenQualityPreset(undefined).tier).toBe('standard');
  });

  it('非法/缺失档位回落到默认档，不返回 undefined', () => {
    for (const bad of [null, undefined, '', 'turbo', 42, {}]) {
      expect(resolvePajubenQualityPreset(bad)).toBe(PAJUBEN_QUALITY_PRESETS.standard);
    }
  });

  it('合法档位原样解析，且 isPajubenQualityTier 只放行三档', () => {
    expect(resolvePajubenQualityPreset('fine')).toBe(PAJUBEN_QUALITY_PRESETS.fine);
    for (const tier of PAJUBEN_QUALITY_TIERS) {
      expect(isPajubenQualityTier(tier)).toBe(true);
    }
    expect(isPajubenQualityTier('high')).toBe(false);
    expect(isPajubenQualityTier(0)).toBe(false);
  });
});
