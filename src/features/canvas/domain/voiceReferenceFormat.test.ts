import { describe, expect, it } from 'vitest';
import {
  applyVoiceReferenceFormat,
  canonicalAudioToken,
  normalizeVoiceReferenceBindings,
  renderVoiceReferenceSentence,
} from './voiceReferenceFormat';

describe('规范化句子', () => {
  it('中文用「使用 @音频N 作为 @角色 的唯一人声参考。」', () => {
    expect(renderVoiceReferenceSentence({ audioIndex: 1, characterName: '藏医' })).toBe(
      '使用 @音频1 作为 @藏医 的唯一人声参考。',
    );
  });

  it('英文句式同义，引用标记仍是画布规范的 @音频N', () => {
    expect(renderVoiceReferenceSentence({ audioIndex: 2, characterName: 'Detective' }, 'en')).toBe(
      'Use @音频2 as the only voice reference for @Detective.',
    );
  });

  it('@音频N 与视频节点「引用」按钮插入的标记一致', () => {
    expect(canonicalAudioToken(3)).toBe('@音频3');
  });
});

describe('绑定去重与清洗', () => {
  it('按音频序号去重并升序，非法项直接丢掉', () => {
    expect(
      normalizeVoiceReferenceBindings([
        { audioIndex: 2, characterName: '乙' },
        { audioIndex: 1, characterName: '甲' },
        { audioIndex: 2, characterName: '丙' },
        { audioIndex: 0, characterName: '无效' },
        { audioIndex: 3, characterName: '   ' },
      ]),
    ).toEqual([
      { audioIndex: 1, characterName: '甲' },
      { audioIndex: 2, characterName: '乙' },
    ]);
  });
});

describe('applyVoiceReferenceFormat', () => {
  const bindings = [{ audioIndex: 1, characterName: '藏医' }];

  it('没有绑定时原样返回，一个字符都不改', () => {
    const prompt = 'AUDIO\n雨声。声音参考：@audio1。';
    expect(applyVoiceReferenceFormat(prompt, [])).toBe(prompt);
  });

  it('旧式「声音参考：」子句原地换成规范句，不留分号与句号残渣', () => {
    const prompt = 'ACTIVE REFERENCES\n@藏医 [image1] — 藏族男子。\n\nAUDIO\n环境底噪。；声音参考：@audio1。\n台词：“站住。”';
    const next = applyVoiceReferenceFormat(prompt, bindings);
    expect(next).toContain('使用 @音频1 作为 @藏医 的唯一人声参考。');
    expect(next).not.toContain('声音参考');
    expect(next).not.toContain('。。');
    expect(next).not.toContain('；；');
    // 与音频无关的正文原样保留
    expect(next).toContain('@藏医 [image1] — 藏族男子。');
    expect(next).toContain('台词：“站住。”');
  });

  it('英文旧式子句同样原地替换', () => {
    const next = applyVoiceReferenceFormat(
      '林警官 VOICE: @林警官 [image1]; voice lock: 低沉。; voice reference: @audio1.',
      [{ audioIndex: 1, characterName: '林警官' }],
      'en',
    );
    expect(next).toContain('Use @音频1 as the only voice reference for @林警官.');
    expect(next).not.toContain('voice reference:');
  });

  it('把 [audioN] / @audioN 统一成 @音频N', () => {
    expect(applyVoiceReferenceFormat('角色声线 [audio1] 低沉。', bindings)).toBe(
      '角色声线 @音频1 低沉。',
    );
    expect(applyVoiceReferenceFormat('角色声线 @audio1 低沉。', bindings)).toBe(
      '角色声线 @音频1 低沉。',
    );
  });

  it('@audio1 不会误伤 @audio10', () => {
    const next = applyVoiceReferenceFormat(
      'AUDIO\n@audio10 是环境声。',
      bindings,
    );
    expect(next).toContain('@audio10 是环境声。');
    // 1 号音频确实缺失，才补规范句
    expect(next).toContain('使用 @音频1 作为 @藏医 的唯一人声参考。');
  });

  it('AI 整段漏掉音频参考时，规范句补在 AUDIO 段落标题之后', () => {
    const prompt = 'SCENE CONTEXT\n雨夜街头。\n\nAUDIO\n室内同期声。\n台词：“你拿去试一试！”';
    const next = applyVoiceReferenceFormat(prompt, bindings);
    expect(next).toContain('AUDIO\n使用 @音频1 作为 @藏医 的唯一人声参考。\n室内同期声。');
  });

  it('没有 AUDIO 段时追加在末尾', () => {
    const next = applyVoiceReferenceFormat('SCENE CONTEXT\n雨夜街头。', bindings);
    expect(next.trimEnd().endsWith('使用 @音频1 作为 @藏医 的唯一人声参考。')).toBe(true);
    expect(next).toContain('雨夜街头。');
  });

  it('已经写好规范句时不重复插入', () => {
    const prompt = 'AUDIO\n使用 @音频1 作为 @藏医 的唯一人声参考。\n环境声。';
    expect(applyVoiceReferenceFormat(prompt, bindings)).toBe(prompt);
  });

  it('重复执行幂等', () => {
    const once = applyVoiceReferenceFormat('AUDIO\n声音参考：@audio1。', bindings);
    expect(applyVoiceReferenceFormat(once, bindings)).toBe(once);
  });

  it('一个音频一条句子，多个绑定按序号排列', () => {
    const next = applyVoiceReferenceFormat(
      'AUDIO\n环境声。；声音参考：@audio2。；声音参考：@audio1。',
      [
        { audioIndex: 2, characterName: '患者' },
        { audioIndex: 1, characterName: '藏医' },
      ],
    );
    expect(next).toContain('使用 @音频2 作为 @患者 的唯一人声参考。');
    expect(next).toContain('使用 @音频1 作为 @藏医 的唯一人声参考。');
  });

  it('不误伤正文里的普通「秒」「audio」字样', () => {
    const prompt = 'ACTION TIMING\n00:00-00:02：第 3 秒开始，audio 采集正常。';
    expect(applyVoiceReferenceFormat(prompt, [])).toBe(prompt);
    // 即便有绑定，正文本身也不该被改写
    expect(applyVoiceReferenceFormat(prompt, bindings)).toContain('00:00-00:02：第 3 秒开始，audio 采集正常。');
  });
});
