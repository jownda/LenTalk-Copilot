import { describe, expect, it } from 'vitest';

import { applyLocalReferenceSection } from './referenceSection';

describe('applyLocalReferenceSection', () => {
  it('模型漏写序号时按资产表重建，且沿用模型的名字', () => {
    const prompt = [
      'SCENE CONTEXT',
      '白墙旁的水泥地。',
      '',
      'ACTIVE REFERENCES',
      '@藏九公膏贴 ：方形圆角透明膏药贴。',
      '',
      'LOCATION MAP',
      '白墙位于后方。',
    ].join('\n');

    const result = applyLocalReferenceSection(prompt, [
      { name: '藏九公膏药贴', imageIndex: 1, description: '方形圆角' },
    ]);

    // 模型把名字写成了「藏九公膏贴」，段落里保留它的写法，但序号按资产表补上。
    expect(result).toContain('@藏九公膏贴 [image1]：方形圆角透明膏药贴。');
    expect(result).toContain('LOCATION MAP');
  });

  it('模型漏掉的资产补在段末，一个都不少', () => {
    const prompt = [
      'ACTIVE REFERENCES',
      '@藏医 ：青年藏族女性。',
      '',
      'LOCATION MAP',
      '诊床在中央。',
    ].join('\n');

    const result = applyLocalReferenceSection(prompt, [
      { name: '藏医', imageIndex: 2 },
      { name: '患者', imageIndex: 3, description: '中年男性，深色工装。' },
    ]);

    expect(result).toContain('@藏医 [image2]：青年藏族女性。');
    expect(result).toContain('@患者 [image3]：中年男性，深色工装。');
  });

  it('模型已经写了错序号的，按资产表改写', () => {
    const prompt = [
      'ACTIVE REFERENCES',
      '@藏医 [image5]：青年藏族女性。',
      '',
      'AUDIO',
      '无对白。',
    ].join('\n');

    const result = applyLocalReferenceSection(prompt, [{ name: '藏医', imageIndex: 2 }]);
    expect(result).toContain('@藏医 [image2]：青年藏族女性。');
    expect(result).not.toContain('[image5]');
  });

  it('不是参考图资产的实体原样保留，但去掉它的编号', () => {
    const prompt = [
      'ACTIVE REFERENCES',
      '@藏医 ：青年藏族女性。',
      '@王哥（画外）[image9]：只作为听筒里的声音。',
      '',
      'LOCATION MAP',
      '墙。',
    ].join('\n');

    const result = applyLocalReferenceSection(prompt, [{ name: '藏医', imageIndex: 1 }]);
    expect(result).toContain('@王哥（画外）：只作为听筒里的声音。');
    expect(result).not.toContain('[image9]');
  });

  it('整段缺失时插到 LOCATION MAP 之前', () => {
    const prompt = [
      'SCENE CONTEXT',
      '室外。',
      '',
      'LOCATION MAP',
      '墙在后方。',
    ].join('\n');

    const result = applyLocalReferenceSection(prompt, [
      { name: '场景图片-1', imageIndex: 1, description: '白墙与台阶。' },
    ]);

    expect(result.indexOf('ACTIVE REFERENCES')).toBeGreaterThan(result.indexOf('SCENE CONTEXT'));
    expect(result.indexOf('ACTIVE REFERENCES')).toBeLessThan(result.indexOf('LOCATION MAP'));
    expect(result).toContain('@场景图片-1 [image1]：白墙与台阶。');
  });

  it('没有资产时原样返回（不做破坏性写入）', () => {
    const prompt = 'SCENE CONTEXT\n室外。';
    expect(applyLocalReferenceSection(prompt, [])).toBe(prompt);
  });
});
