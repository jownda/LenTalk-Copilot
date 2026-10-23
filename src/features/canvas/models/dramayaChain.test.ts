import { describe, expect, it, afterEach } from 'vitest';

import { listVideoModels } from './registry';
import { useSettingsStore, type CustomApiProvider } from '@/stores/settingsStore';

const DRAMAYA_API: CustomApiProvider = {
  id: 'dramaya',
  name: 'Dramaya',
  baseUrl: 'https://video.dramaya.us',
  apiKey: '',
  models: [],
  videoModels: ['seedance2.0-A', 'seedance2.5-A', 'seedance2.5-720p-C', 'minimax-h3'],
  audioModels: [],
  chatModels: [],
  modelPrices: {},
  createdAt: Date.now(),
  requestMode: 'async',
  // 这几个字段是必填的; 本测只关心视频档位, 用与推荐卡片一致的默认值填。
  protocol: 'images',
  referenceImageField: 'image',
  referenceImageEncoding: 'auto',
  imageTransport: 'auto',
};

function withDramaya(api: CustomApiProvider) {
  const previous = useSettingsStore.getState().customApis;
  useSettingsStore.setState({ customApis: [...previous, api] });
  return () => useSettingsStore.setState({ customApis: previous });
}

/** tsconfig 的 lib 是 ES2021, 没有 Array.prototype.at。 */
function last<T>(items: T[]): T {
  return items[items.length - 1];
}

describe('Dramaya 视频链路在节点里的档位', () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('分辨率下拉必须有选项(否则节点里根本调不了分辨率)', () => {
    restore = withDramaya(DRAMAYA_API);
    const models = listVideoModels();
    const seedance25 = models.find((model) => model.id === 'custom:dramaya/seedance2.5-A');
    expect(seedance25).toBeTruthy();
    expect(seedance25?.resolutions?.map((option) => option.value)).toEqual(['480p', '720p']);
    expect(seedance25?.defaultResolution).toBe('720p');
  });

  it('720p 专供型号也应给出单档分辨率', () => {
    restore = withDramaya(DRAMAYA_API);
    const fixed = listVideoModels().find((model) => model.id === 'custom:dramaya/seedance2.5-720p-C');
    expect(fixed?.resolutions?.map((option) => option.value)).toEqual(['720p']);
  });

  it('时长档位跟着型号走(2.5 到 30 秒, 2.0 到 15 秒)', () => {
    restore = withDramaya(DRAMAYA_API);
    const models = listVideoModels();
    const v25 = models.find((model) => model.id === 'custom:dramaya/seedance2.5-A');
    const v20 = models.find((model) => model.id === 'custom:dramaya/seedance2.0-A');
    expect(v25?.durationOptions ? last(v25.durationOptions) : null).toBe(30);
    expect(v20?.durationOptions ? last(v20.durationOptions) : null).toBe(15);
    expect(v25?.defaultDuration).toBe(5);
  });

  it('平台用 /v1 结尾也能命中(用户常这么填)', () => {
    restore = withDramaya({ ...DRAMAYA_API, baseUrl: 'https://video.dramaya.us/v1' });
    const model = listVideoModels().find((item) => item.id === 'custom:dramaya/seedance2.0-A');
    expect(model?.resolutions?.map((option) => option.value)).toEqual(['480p', '720p', '1080p']);
  });
});
