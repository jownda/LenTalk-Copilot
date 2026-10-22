import { describe, expect, it } from 'vitest';

import { applyAssetPathRemap, remapAssetPathsInValue } from './assetPathRemap';

describe('remapAssetPathsInValue', () => {
  it('改写节点里所有指向旧文件的字段', () => {
    const nodes = [
      {
        id: 'n1',
        data: {
          imageUrl: '/lib/old.png',
          previewImageUrl: '/lib/old.png',
          sourcePath: '/lib/old.png',
          displayName: '商品头图',
        },
      },
    ];
    const hits = remapAssetPathsInValue(nodes, new Map([['/lib/old.png', '/lib/新名字.png']]));

    expect(hits).toBe(3);
    expect(nodes[0].data.imageUrl).toBe('/lib/新名字.png');
    expect(nodes[0].data.previewImageUrl).toBe('/lib/新名字.png');
    expect(nodes[0].data.sourcePath).toBe('/lib/新名字.png');
    // 名字字段不该被顺手改掉
    expect(nodes[0].data.displayName).toBe('商品头图');
  });

  it('数组、撤销栈 imagePool、深层对象都能覆盖', () => {
    const payload = {
      referenceImages: ['/lib/a.png', '/lib/other.png'],
      history: { imagePool: { __img_ref__0: '/lib/a.png' }, past: [{ data: { imageUrl: '/lib/a.png' } }] },
    };
    const hits = remapAssetPathsInValue(payload, new Map([['/lib/a.png', '/lib/新.png']]));

    expect(hits).toBe(3);
    expect(payload.referenceImages).toEqual(['/lib/新.png', '/lib/other.png']);
    expect(payload.history.imagePool.__img_ref__0).toBe('/lib/新.png');
    expect(payload.history.past[0].data.imageUrl).toBe('/lib/新.png');
  });

  it('长路径优先,避免把另一条路径改坏', () => {
    const payload = { a: '/lib/图.png', b: '/lib/图.png.bak' };
    remapAssetPathsInValue(
      payload,
      new Map([
        ['/lib/图.png', '/lib/新.png'],
        ['/lib/图.png.bak', '/lib/新.bak.png'],
      ]),
    );
    expect(payload.a).toBe('/lib/新.png');
    expect(payload.b).toBe('/lib/新.bak.png');
  });

  it('其它字段原样保留', () => {
    const payload = { prompt: '把 /lib/old.png 里的产品抠出来', value: 1, nested: { list: [{ ok: true }] } };
    const before = JSON.parse(JSON.stringify(payload));
    expect(remapAssetPathsInValue(payload, new Map())).toBe(0);
    expect(payload).toEqual(before);
  });
});

describe('applyAssetPathRemap', () => {
  it('非桌面环境(没有本地文件系统)时是空操作', async () => {
    const report = await applyAssetPathRemap(new Map([['/lib/old.png', '/lib/new.png']]));
    expect(report).toEqual({
      replacements: 0,
      canvasChanged: false,
      projectsChanged: 0,
      templatesChanged: 0,
      cinematicAssetsChanged: false,
    });
  });
});
