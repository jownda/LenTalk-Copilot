import { describe, expect, it } from 'vitest';
import { buildQuickPromptRequest } from './quickPromptAgent';

describe('buildQuickPromptRequest', () => {
  it('keeps the minimal brief unchanged when the node has no staging context', () => {
    const { system, user } = buildQuickPromptRequest({
      style: '胶片颗粒',
      synopsis: '侦探穿过雨夜的站台。',
      sceneAssets: [{ id: 'loc', name: '站台', description: '雨夜月台', mediaType: 'image', referenceIndex: 1 }],
      characterAssets: [{ id: 'hero', name: '侦探', mediaType: 'image', referenceIndex: 2 }],
    }, 'zh');

    expect(user).toContain('@站台 [image1] (scene image) — 雨夜月台');
    expect(user).toContain('@侦探 [image2] (character image)');
    expect(user).not.toContain('SCENE STAGING');
    expect(user).not.toContain('CHARACTER PROFILES');
    expect(user).not.toContain('PROP ASSETS');
    expect(system).toContain('CINEDANCE V4');
  });

  it('renders staging, acting masters, voice locks, and props as planning context', () => {
    const { system, user } = buildQuickPromptRequest({
      style: '胶片颗粒',
      synopsis: '侦探用短刀割断绳子。',
      sceneAssets: [{ id: 'loc', name: '站台', description: '雨夜月台', mediaType: 'image', referenceIndex: 1 }],
      characterAssets: [{ id: 'hero', name: '侦探', description: '风衣礼帽', mediaType: 'image', referenceIndex: 2 }],
      staging: {
        locationName: '站台',
        locationDescription: '雨夜月台',
        anchorDescription: '背靠立柱',
        characterOrderNames: ['侦探'],
        spacing: '两米',
        axisDirection: 'left-to-right',
        priorContext: '他刚下夜班',
      },
      characterProfiles: [{
        id: 'hero',
        name: '侦探',
        actingMaster: '中文表演母版',
        voiceLock: '低沉沙哑',
        propIds: ['knife'],
      }],
      props: [{ id: 'knife', name: '短刀', description: '绣春刀；由侦探持有', mediaType: 'image', referenceIndex: 3 }],
    }, 'zh');

    expect(user).toContain('SCENE STAGING (场景站位，空间契约；不是输出段落):');
    expect(user).toContain('SPATIAL ANCHOR (空间锚点): 背靠立柱');
    expect(user).toContain('CHARACTER ORDER (左到右站位): @侦探');
    expect(user).toContain('PRIOR CONTEXT (前情): 他刚下夜班');
    expect(user).toContain('CHARACTER PROFILES (场景角色候选的表演母版 / 声音锁；AI 参考，禁止原样输出):');
    expect(user).toContain('ACTING MASTER (表演母版): 中文表演母版');
    expect(user).toContain('VOICE LOCK (声音锁，仅当该角色开口时逐字使用): 低沉沙哑');
    expect(user).toContain('ATTACHED PROPS (随身道具): @短刀');
    expect(user).toContain('PROP ASSETS (道具；只在该道具被故事梗概用到时才写进提示词):');
    expect(user).toContain('@短刀 [image3] (prop image) — 绣春刀；由侦探持有');

    // 关键规则：只按故事梗概引用 + 母版不得照抄 + 声音锁只在开口时使用。
    expect(system).toContain('Reference them strictly by the story synopsis');
    expect(system).toContain('Never paste, quote, paraphrase line by line, or expose it as a section');
    expect(system).toContain('only for a character who actually speaks a line in the synopsis');
  });

  it('switches the required output language with the locale', () => {
    const input = {
      style: '胶片颗粒',
      synopsis: '侦探穿过雨夜的站台。',
      sceneAssets: [{ id: 'loc', name: '站台', description: '雨夜月台', mediaType: 'image' as const, referenceIndex: 1 }],
      characterAssets: [],
    };

    // 语言指令本身始终用英文书写，切换的是「成品提示词要用哪种语言」。
    const zhSystem = buildQuickPromptRequest(input, 'zh').system;
    expect(zhSystem).toContain('Write in clear, cinematic Chinese.');
    expect(zhSystem).not.toContain('Write in clear cinematic English.');
    expect(buildQuickPromptRequest(input, 'en').system).toContain('Write in clear cinematic English.');
  });
});
