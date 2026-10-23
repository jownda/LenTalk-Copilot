import { afterEach, describe, expect, it } from 'vitest';

import { CANVAS_NODE_TYPES } from './canvasNodes';
import { getNodeDefinition } from './nodeRegistry';
import { useSettingsStore, type CustomApiProvider } from '@/stores/settingsStore';

/**
 * 回归：「提示词工作室 → 生成提示词」新建的视频节点必须沿用用户上次选的模型 / 画幅 / 分辨率。
 *
 * 线上反馈：知鸟 `seedance-2-5-promo` 手动选 480p，工作室发出的新节点却回到 720p。
 * 这条链路上有三段都可能吃掉设置：
 *   1. `VideoGenNode` 选分辨率时写没写 `lastVideoResolution`；
 *   2. `resolveVideoNodeParams` 只接受「落在该模型档位内」的记忆值；
 *   3. 工作室建节点时有没有把参数写死。
 */
const ZHINIAO: CustomApiProvider = {
  id: 'zhiniao',
  name: '知鸟AI',
  baseUrl: 'https://cuai.token6688.com',
  apiKey: '',
  models: [],
  videoModels: ['seedance-2-5-promo'],
  audioModels: [],
  chatModels: [],
  modelPrices: {},
  createdAt: Date.now(),
  requestMode: 'async',
  protocol: 'images',
  referenceImageField: 'images',
  referenceImageEncoding: 'auto',
  imageTransport: 'auto',
};

describe('新建 AI 视频节点沿用上次的分辨率', () => {
  const snapshot = useSettingsStore.getState();
  afterEach(() => {
    useSettingsStore.setState({
      customApis: snapshot.customApis,
      lastVideoModelId: snapshot.lastVideoModelId,
      lastVideoResolution: snapshot.lastVideoResolution,
      lastVideoAspectRatio: snapshot.lastVideoAspectRatio,
    });
  });

  it('知鸟 seedance-2-5-promo：上次选 480p 时新节点就是 480p', () => {
    useSettingsStore.setState({
      customApis: [...snapshot.customApis, ZHINIAO],
      lastVideoModelId: 'custom:zhiniao/seedance-2-5-promo',
      lastVideoResolution: '480p',
    });

    const data = getNodeDefinition(CANVAS_NODE_TYPES.videoGen).createDefaultData();
    expect(data.model).toBe('custom:zhiniao/seedance-2-5-promo');
    expect(data.resolution).toBe('480p');
  });

  it('记忆值不在该模型档位里时回落到默认档(不会塞一个平台不认的值)', () => {
    useSettingsStore.setState({
      customApis: [...snapshot.customApis, ZHINIAO],
      lastVideoModelId: 'custom:zhiniao/seedance-2-5-promo',
      lastVideoResolution: '4k',
    });

    const data = getNodeDefinition(CANVAS_NODE_TYPES.videoGen).createDefaultData();
    // 模型档位里没有 4k → 用该模型的默认分辨率, 而不是把非法值传下去
    expect(data.resolution).not.toBe('4k');
    expect(['480p', '720p', '1080p']).toContain(data.resolution);
  });
});
