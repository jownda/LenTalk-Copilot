import { describe, expect, it } from 'vitest';

import type { CustomApiProvider } from '@/stores/settingsStore';

import { collectPajubenModelOptions, customProviderKey, groupPajubenModelOptions } from './pajubenModels';

function customApi(overrides: Partial<CustomApiProvider> & { id: string; name: string }): CustomApiProvider {
  return {
    baseUrl: 'https://example.com/v1',
    apiKey: '',
    models: [],
    videoModels: [],
    audioModels: [],
    chatModels: [],
    createdAt: 0,
    requestMode: 'sync',
    protocol: 'chat',
    referenceImageField: 'image',
    referenceImageEncoding: 'auto',
    imageTransport: 'auto',
    ...overrides,
  };
}

describe('collectPajubenModelOptions', () => {
  it('把自定义平台的 chat 模型摊平成「渠道 + 模型」选项', () => {
    const options = collectPajubenModelOptions(
      [
        customApi({
          id: 'my-relay',
          name: '我的中转',
          apiKey: 'sk-local',
          chatModels: ['gemini-2.5-pro', 'gpt-5.4'],
        }),
      ],
      {}
    );

    expect(options).toHaveLength(2);
    expect(options.map((option) => option.model)).toEqual(['gemini-2.5-pro', 'gpt-5.4']);
    expect(options[0]).toMatchObject({
      key: 'custom:my-relay/gemini-2.5-pro',
      providerName: '我的中转',
      baseUrl: 'https://example.com/v1',
      apiKey: 'sk-local',
      source: 'custom',
    });
  });

  it('平台对象没带 key 时回退到 apiKeys 里的 custom: 索引', () => {
    const options = collectPajubenModelOptions(
      [customApi({ id: 'relay-2', name: '中转二', apiKey: '', chatModels: ['glm-5.1'] })],
      { [customProviderKey('relay-2')]: 'sk-from-store' }
    );

    expect(options[0].apiKey).toBe('sk-from-store');
  });

  it('推荐平台只在真的配了密钥时才出现', () => {
    const withoutKey = collectPajubenModelOptions([], {});
    expect(withoutKey).toHaveLength(0);

    const withKey = collectPajubenModelOptions([], { zhiniao: 'sk-zhiniao' });
    expect(withKey.length).toBeGreaterThan(0);
    expect(withKey.every((option) => option.source === 'recommended')).toBe(true);
    expect(withKey.every((option) => option.apiKey === 'sk-zhiniao')).toBe(true);
    expect(withKey.every((option) => option.providerName === '知鸟AI')).toBe(true);
  });

  it('忽略只有空白字符的密钥与空模型名', () => {
    const options = collectPajubenModelOptions(
      [customApi({ id: 'blank', name: '空渠道', apiKey: 'sk-x', chatModels: ['', '  '] })],
      { zhiniao: '   ' }
    );
    expect(options).toHaveLength(0);
  });

  it('同一渠道名下重复记录里的同名模型只留一条（优先有密钥的那条）', () => {
    // 历史上重复连接同一个平台会留下 知鸟ai / 知鸟ai-23oa 两条记录。
    const options = collectPajubenModelOptions(
      [
        customApi({ id: 'zhiniao', name: '知鸟AI', apiKey: '', chatModels: ['gemini-3.8-flash'] }),
        customApi({ id: 'zhiniao-23oa', name: '知鸟AI', apiKey: 'sk-live', chatModels: ['gemini-3.8-flash', 'gpt-5.6-luna'] }),
      ],
      {}
    );

    expect(options.map((option) => option.model)).toEqual(['gemini-3.8-flash', 'gpt-5.6-luna']);
    expect(options[0].key).toBe('custom:zhiniao-23oa/gemini-3.8-flash');
    expect(options[0].apiKey).toBe('sk-live');
  });

  it('不同平台的同名模型各自保留（选择的是渠道 + 模型组合）', () => {
    const options = collectPajubenModelOptions(
      [
        customApi({ id: 'a', name: '渠道A', apiKey: 'sk-a', chatModels: ['gpt-5.4'] }),
        customApi({ id: 'b', name: '渠道B', apiKey: 'sk-b', chatModels: ['gpt-5.4'] }),
      ],
      {}
    );

    expect(options).toHaveLength(2);
    expect(new Set(options.map((option) => option.key)).size).toBe(2);
    expect(options.map((option) => option.baseUrl)).toEqual(['https://example.com/v1', 'https://example.com/v1']);
  });

  it('结果按平台名分组排序，便于在下拉里定位', () => {
    const options = collectPajubenModelOptions(
      [
        customApi({ id: 'z', name: 'Z渠道', apiKey: 'sk-z', chatModels: ['m2'] }),
        customApi({ id: 'a', name: 'A渠道', apiKey: 'sk-a', chatModels: ['m1'] }),
      ],
      {}
    );

    expect(options.map((option) => option.providerName)).toEqual(['A渠道', 'Z渠道']);
  });
});

describe('groupPajubenModelOptions', () => {
  it('按供应商分组，组内按模型名排序，组间按渠道名排序', () => {
    const options = collectPajubenModelOptions(
      [
        customApi({ id: 'z', name: 'Z渠道', apiKey: 'sk-z', chatModels: ['m2', 'm1'] }),
        customApi({ id: 'a', name: 'A渠道', apiKey: 'sk-a', chatModels: ['b', 'a'] }),
      ],
      {}
    );

    const groups = groupPajubenModelOptions(options);
    expect(groups.map((group) => group.providerName)).toEqual(['A渠道', 'Z渠道']);
    expect(groups[0].options.map((option) => option.model)).toEqual(['a', 'b']);
    expect(groups[1].options.map((option) => option.model)).toEqual(['m1', 'm2']);
  });

  it('同名模型分属两个渠道时不会并到一组', () => {
    const options = collectPajubenModelOptions(
      [
        customApi({ id: 'a', name: '渠道A', apiKey: 'sk-a', chatModels: ['gpt-5.4'] }),
        customApi({ id: 'b', name: '渠道B', apiKey: 'sk-b', chatModels: ['gpt-5.4'] }),
      ],
      {}
    );

    const groups = groupPajubenModelOptions(options);
    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.options.length === 1)).toBe(true);
  });

  it('空清单返回空数组', () => {
    expect(groupPajubenModelOptions([])).toEqual([]);
  });
});
