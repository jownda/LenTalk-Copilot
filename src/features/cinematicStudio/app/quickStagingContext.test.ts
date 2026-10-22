import { describe, expect, it } from 'vitest';
import type { Asset } from '../shared-types';
import { buildQuickStagingContext } from './quickStagingContext';

function asset(partial: Partial<Asset> & { id: string; kind: Asset['kind'] }): Asset {
  return {
    name: partial.id,
    description: '',
    referencePaths: [],
    lockLevel: 'soft',
    tags: [],
    ...partial,
  } as Asset;
}

describe('buildQuickStagingContext', () => {
  it('carries the location description plus the staging spatial contract', () => {
    const assets: Asset[] = [
      asset({ id: 'loc', kind: 'location', name: '地铁站台', description: 'Night subway platform', descriptionZh: '雨夜的废弃站台' }),
      asset({ id: 'hero', kind: 'character', name: '侦探' }),
    ];

    const context = buildQuickStagingContext({
      assets,
      staging: {
        locationAssetId: 'loc',
        characterRoster: ['hero'],
        characterOrder: ['hero'],
        anchorDescription: '背靠立柱，面向闸机',
        spacing: '两人相距两米',
        axisDirection: 'right-to-left',
        priorContext: '他刚下夜班',
      },
      locale: 'zh',
    });

    expect(context.staging).toEqual({
      locationId: 'loc',
      locationName: '地铁站台',
      locationDescription: '雨夜的废弃站台',
      anchorDescription: '背靠立柱，面向闸机',
      characterOrderNames: ['侦探'],
      spacing: '两人相距两米',
      axisDirection: 'right-to-left',
      priorContext: '他刚下夜班',
    });
  });

  it('reads the acting master and voice lock from the character asset with locale fallback', () => {
    const assets: Asset[] = [
      asset({
        id: 'hero',
        kind: 'character',
        name: 'HERO',
        actingProfile: {
          masterProfile: 'EN master profile',
          masterProfileZh: '中文表演母版',
          voicePrompt: 'EN voice lock',
          voicePromptZh: '低沉沙哑，句尾下沉',
        },
      }),
    ];

    const zh = buildQuickStagingContext({ assets, staging: { characterRoster: ['hero'] }, locale: 'zh' });
    expect(zh.characterProfiles).toEqual([
      { id: 'hero', name: 'HERO', actingMaster: '中文表演母版', voiceLock: '低沉沙哑，句尾下沉' },
    ]);

    const en = buildQuickStagingContext({ assets, staging: { characterRoster: ['hero'] }, locale: 'en' });
    expect(en.characterProfiles).toEqual([
      { id: 'hero', name: 'HERO', actingMaster: 'EN master profile', voiceLock: 'EN voice lock' },
    ]);
  });

  it('prefers the project asset name over a stale mirrored library name', () => {
    const assets: Asset[] = [
      asset({ id: 'hero', kind: 'character', name: '工程角色名' }),
      asset({ id: 'loc', kind: 'location', name: '工程场景名' }),
    ];

    const context = buildQuickStagingContext({
      assets,
      staging: {
        locationAssetId: 'loc',
        characterRoster: ['hero'],
        characterOrder: ['hero'],
      },
      resolveAssetName: (id) => (id === 'hero' ? '旧镜像角色名 1' : '旧镜像场景名 1'),
    });

    expect(context.staging?.locationName).toBe('工程场景名');
    expect(context.staging?.characterOrderNames).toEqual(['工程角色名']);
    expect(context.characterProfiles[0]?.name).toBe('工程角色名');
  });

  it('collects attached props and props whose default holder is the roster character', () => {
    const assets: Asset[] = [
      asset({ id: 'hero', kind: 'character', name: 'HERO', attachedPropIds: ['knife'] }),
      asset({ id: 'other', kind: 'character', name: 'OTHER', attachedPropIds: ['knife'] }),
      asset({ id: 'knife', kind: 'prop', name: '短刀', description: 'rusty blade', propPositionZh: '右手握持' }),
      asset({ id: 'lighter', kind: 'prop', name: '打火机', propHolderCharacterId: 'hero', propUsageZh: '点火' }),
      asset({ id: 'unused', kind: 'prop', name: '无关道具' }),
    ];

    const context = buildQuickStagingContext({
      assets,
      staging: { characterRoster: ['hero', 'other'] },
      locale: 'zh',
      imageSources: ['loc.png'],
      resolveImageSource: (id) => (id === 'knife' ? 'knife.png' : id === 'lighter' ? 'lighter.png' : undefined),
    });

    // 两个角色共享的短刀只出现一次。
    expect(context.props.map((prop) => prop.id)).toEqual(['knife', 'lighter']);
    expect(context.characterProfiles[0]).toMatchObject({ id: 'hero', propIds: ['knife', 'lighter'] });
    expect(context.characterProfiles[1]).toMatchObject({ id: 'other', propIds: ['knife'] });
    expect(context.props[0].description).toContain('位置：右手握持');
    expect(context.props[1].description).toContain('由HERO持有');
    expect(context.props[1].description).toContain('用途：点火');
    expect(context.props.some((prop) => prop.id === 'unused')).toBe(false);
  });

  it('numbers prop images after the existing references and reuses a duplicate path', () => {
    const assets: Asset[] = [
      asset({ id: 'hero', kind: 'character', name: 'HERO', attachedPropIds: ['knife', 'lighter'] }),
      asset({ id: 'knife', kind: 'prop', name: '短刀' }),
      asset({ id: 'lighter', kind: 'prop', name: '打火机' }),
    ];

    const context = buildQuickStagingContext({
      assets,
      staging: { characterRoster: ['hero'] },
      // 打火机的图片已经作为角色参考图出现过一次：不能再追加，序号要指回原位置。
      imageSources: ['loc.png', 'hero.png', 'lighter.png'],
      resolveImageSource: (id) => (id === 'knife' ? 'knife.png' : id === 'lighter' ? 'lighter.png' : undefined),
    });

    expect(context.props.map((prop) => [prop.id, prop.referenceIndex])).toEqual([['knife', 4], ['lighter', 3]]);
    expect(context.referenceImages).toEqual(['knife.png']);
  });

  it('stays empty for a node without staging or without a loaded project', () => {
    const context = buildQuickStagingContext({ assets: [], locale: 'zh' });
    expect(context.staging).toBeUndefined();
    expect(context.characterProfiles).toEqual([]);
    expect(context.props).toEqual([]);
    expect(context.referenceImages).toEqual([]);
  });

  it('never treats a non-character roster id as a profile', () => {
    const assets: Asset[] = [
      asset({ id: 'loc', kind: 'location', name: '站台' }),
      asset({ id: 'knife', kind: 'prop', name: '短刀' }),
    ];

    const context = buildQuickStagingContext({
      assets,
      staging: { characterRoster: ['loc', 'knife', 'ghost'], characterOrder: ['loc'] },
      locale: 'zh',
    });

    expect(context.characterProfiles).toEqual([]);
    expect(context.props).toEqual([]);
    expect(context.staging?.characterOrderNames).toBeUndefined();
  });

  it('collects the scene prop roster picked on the node', () => {
    const assets: Asset[] = [
      asset({ id: 'knife', kind: 'prop', name: '短刀', descriptionZh: '锈迹斑斑' }),
      asset({ id: 'car', kind: 'prop', name: '旧车', propPositionZh: '停在路边' }),
    ];

    const context = buildQuickStagingContext({
      assets,
      staging: { propRoster: ['knife', 'car'] },
      locale: 'zh',
      resolveImageSource: (id) => `${id}.png`,
    });

    // 没有角色候选也必须能带出道具：这是「道具」候选框的唯一意义。
    expect(context.props.map((prop) => [prop.id, prop.referenceIndex])).toEqual([['knife', 1], ['car', 2]]);
    expect(context.referenceImages).toEqual(['knife.png', 'car.png']);
    expect(context.props[1].description).toContain('位置：停在路边');
  });

  it('appends the scene prop roster after the attached props without renumbering them', () => {
    const assets: Asset[] = [
      asset({ id: 'hero', kind: 'character', name: 'HERO', attachedPropIds: ['lighter'] }),
      asset({ id: 'lighter', kind: 'prop', name: '打火机' }),
      asset({ id: 'knife', kind: 'prop', name: '短刀' }),
    ];

    const context = buildQuickStagingContext({
      assets,
      // 打火机既是随身道具又被选进 propRoster：只能出现一次，且必须是随身道具的原序号。
      staging: { characterRoster: ['hero'], propRoster: ['lighter', 'knife'] },
      imageSources: ['loc.png', 'hero.png'],
      resolveImageSource: (id) => `${id}.png`,
    });

    expect(context.props.map((prop) => [prop.id, prop.referenceIndex])).toEqual([['lighter', 3], ['knife', 4]]);
    expect(context.referenceImages).toEqual(['lighter.png', 'knife.png']);
    expect(context.characterProfiles[0]).toMatchObject({ id: 'hero', propIds: ['lighter'] });
  });

  it('ignores non-prop and unknown ids in the scene prop roster', () => {
    const assets: Asset[] = [
      asset({ id: 'loc', kind: 'location', name: '站台' }),
      asset({ id: 'knife', kind: 'prop', name: '短刀' }),
    ];

    const context = buildQuickStagingContext({
      assets,
      staging: { propRoster: ['loc', 'missing', 'knife'] },
      locale: 'zh',
    });

    expect(context.props.map((prop) => prop.id)).toEqual(['knife']);
  });
});
