import { describe, expect, it } from 'vitest';

import { anchorImageReferenceTags } from './referenceTagAnchors';

describe('anchorImageReferenceTags', () => {
  it('给裸 @角色 补上 [imageN]', () => {
    const prompt = 'ACTIVE REFERENCES\n@藏医 ：青年藏族女性，翠绿色藏袍。';
    expect(anchorImageReferenceTags(prompt, [{ name: '藏医', imageIndex: 2 }])).toBe(
      'ACTIVE REFERENCES\n@藏医 [image2] ：青年藏族女性，翠绿色藏袍。',
    );
  });

  it('已经有序号的不重复补', () => {
    const bracket = '@藏医 [image2] ：青年藏族女性。';
    expect(anchorImageReferenceTags(bracket, [{ name: '藏医', imageIndex: 2 }])).toBe(bracket);

    const chinese = '@藏医 @图2 ：青年藏族女性。';
    expect(anchorImageReferenceTags(chinese, [{ name: '藏医', imageIndex: 2 }])).toBe(chinese);
  });

  it('同一段落里多处出现都要补', () => {
    const prompt = '@丈夫 站在门口，随后 @丈夫 转身离开。';
    expect(anchorImageReferenceTags(prompt, [{ name: '丈夫', imageIndex: 1 }])).toBe(
      '@丈夫 [image1] 站在门口，随后 @丈夫 [image1] 转身离开。',
    );
  });

  it('长名优先，不把 @藏九公腰椎药盒 截成 @藏九公', () => {
    const prompt = '@藏九公腰椎药盒 与 @藏九公膏药贴 同时可见。';
    const result = anchorImageReferenceTags(prompt, [
      { name: '藏九公', imageIndex: 1 },
      { name: '藏九公腰椎药盒', imageIndex: 2 },
      { name: '藏九公膏药贴', imageIndex: 3 },
    ]);
    expect(result).toBe(
      '@藏九公腰椎药盒 [image2] 与 @藏九公膏药贴 [image3] 同时可见。',
    );
  });

  it('更长的标签不误伤（@藏医12 不等于 @藏医）', () => {
    const prompt = '@藏医12 走进诊室。';
    expect(anchorImageReferenceTags(prompt, [{ name: '藏医', imageIndex: 2 }])).toBe(prompt);
  });

  it('没有可用锚点或序号非法时原样返回', () => {
    const prompt = '@藏医 站在桌旁。';
    expect(anchorImageReferenceTags(prompt, [])).toBe(prompt);
    expect(anchorImageReferenceTags(prompt, [{ name: '藏医', imageIndex: 0 }])).toBe(prompt);
    expect(anchorImageReferenceTags(prompt, [{ name: '   ', imageIndex: 1 }])).toBe(prompt);
  });

  it('句中出现也补（名字后面直接跟动词）', () => {
    expect(anchorImageReferenceTags('首帧看到@藏医面向镜头。', [{ name: '藏医', imageIndex: 4 }])).toBe(
      '首帧看到@藏医 [image4]面向镜头。',
    );
  });
});
