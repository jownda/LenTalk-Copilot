import { beforeEach, describe, expect, it } from 'vitest';

import type { RhtvParamSpec } from '@/commands/rhtvCli';
import { getVideoModel, listVideoModels } from '@/features/canvas/models/registry';
import { __setRhtvCatalogForTest } from '@/features/canvas/models/rhtvCatalog';

const H3_MODEL = 'text-video-rhart-video-minimax-h3-rh-enhanced-t2va-app';
const SEEDREAM_MODEL = 'text-image-seedream-v5.5';

function spec(partial: Partial<RhtvParamSpec> & Pick<RhtvParamSpec, 'key' | 'semantic'>): RhtvParamSpec {
  return {
    control: 'select',
    title: partial.key,
    required: false,
    options: [],
    ...partial,
  };
}

/** H3 的真实 schema 形态：比例叫 aspectRatio，只有 480p/768p，时长 4–15 秒。 */
const h3Specs: RhtvParamSpec[] = [
  spec({ key: 'prompt', semantic: 'prompt', control: 'prompt', required: true }),
  spec({
    key: 'aspectRatio',
    semantic: 'aspectRatio',
    control: 'aspect',
    options: [
      { value: '', label: '自适应', isAuto: true },
      { value: '16:9', label: '16:9' },
      { value: '21:9', label: '21:9' },
    ],
  }),
  spec({
    key: 'resolution',
    semantic: 'resolution',
    control: 'select',
    defaultValue: '768p',
    options: [
      { value: '480p', label: '480p' },
      { value: '768p', label: '768p' },
    ],
  }),
  spec({
    key: 'duration',
    semantic: 'duration',
    control: 'slider',
    defaultValue: '5',
    min: 4,
    max: 15,
  }),
];

/** seedream 的真实形态：比例叫 whAspectRatio，分辨率只有 1K/2K。 */
const seedreamSpecs: RhtvParamSpec[] = [
  spec({ key: 'prompt', semantic: 'prompt', control: 'prompt', required: true }),
  spec({
    key: 'whAspectRatio',
    semantic: 'aspectRatio',
    control: 'aspect',
    composite: true,
    defaultValue: '1:1',
    options: [
      { value: '1:1', label: '1:1' },
      { value: '16:9', label: '16:9' },
    ],
  }),
  spec({
    key: 'whResolution',
    semantic: 'resolution',
    control: 'resolution',
    composite: true,
    defaultValue: '1K',
    options: [
      { value: '1K', label: '1K' },
      { value: '2K', label: '2K' },
    ],
  }),
];

describe('RunningHub 画布模型档位', () => {
  beforeEach(() => {
    __setRhtvCatalogForTest({
      status: {
        found: true,
        executable: 'rhtvcli',
        resolvedPath: '/tmp/rhtvcli',
        version: '0.7.1',
        loggedIn: true,
        userId: 'u1',
        canvasId: 'c1',
        message: '',
      },
      image: [{ modelCode: SEEDREAM_MODEL, name: 'Seedream 5.5', available: true }],
      video: [{ modelCode: H3_MODEL, name: 'Minimax-H3-RH-Enhanced', available: true }],
      specs: {
        [H3_MODEL]: { params: h3Specs },
        [SEEDREAM_MODEL]: { params: seedreamSpecs },
      },
      loadedAt: Date.now(),
    });
  });

  it('H3 的分辨率只给 schema 里的档位', () => {
    const model = getVideoModel(`rhtv-canvas/${H3_MODEL}`);
    expect(model).toBeTruthy();
    expect(model!.resolutions?.map((option) => option.value)).toEqual(['480p', '768p']);
    expect(model!.defaultResolution).toBe('768p');
  });

  it('H3 的时长按 slider 的 min/max 展开，而不是写死 1-30', () => {
    const model = getVideoModel(`rhtv-canvas/${H3_MODEL}`);
    expect(model!.durationOptions).toEqual(Array.from({ length: 12 }, (_, index) => index + 4));
    expect(model!.defaultDuration).toBe(5);
  });

  it('比例列表会剔掉"自适应"空值项', () => {
    const model = getVideoModel(`rhtv-canvas/${H3_MODEL}`);
    expect(model!.aspectRatios.map((option) => option.value)).toEqual(['16:9', '21:9']);
  });

  it('模型全部来自目录，不在源码里硬编码', () => {
    const ids = listVideoModels().map((model) => model.id);
    expect(ids).toContain(`rhtv-canvas/${H3_MODEL}`);
  });

  it('schema 还没拉到时不崩，退回保守档位', () => {
    __setRhtvCatalogForTest({ specs: {} });
    const model = getVideoModel(`rhtv-canvas/${H3_MODEL}`);
    expect(model).toBeTruthy();
    expect(model!.aspectRatios.map((option) => option.value)).toContain('16:9');
    expect(model!.durationOptions.length).toBeGreaterThan(0);
  });
});
