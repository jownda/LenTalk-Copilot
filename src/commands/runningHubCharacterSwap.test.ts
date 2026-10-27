/**
 * RunningHub AI 应用「更换视频人物MinimaxH3」的提交参数装配。
 *
 * 这些断言的作用是**防漂移**：画幅档位在 UI(`domain/canvasNodes.ts`) 与协议模块
 * (`commands/runningHubProtocol.ts`) 各有一份 —— 前者为了不让 domain 层依赖 commands
 * 层而独立定义。两份一旦不同步, 用户在下拉里选到的比例会被静默吸附到别的档位,
 * 而且请求本身合法、平台不会报错, 只有出片画幅不对。
 */

import { describe, expect, it } from 'vitest';

import { CHARACTER_SWAP_ASPECT_RATIOS } from '@/features/canvas/domain/canvasNodes';
import {
  CHARACTER_SWAP_PROMPT_MARKERS,
  CHARACTER_SWAP_PROMPT_TEMPLATE,
  resolveCharacterSwapPrompt,
} from '@/features/canvas/domain/characterSwapPrompt';
import {
  RUNNINGHUB_CHARACTER_SWAP_ASPECT_OPTIONS,
  RUNNINGHUB_CHARACTER_SWAP_ASPECT_RATIOS,
  RUNNINGHUB_CHARACTER_SWAP_APP_ID,
  RUNNINGHUB_CHARACTER_SWAP_NODES,
  buildRunningHubCharacterSwapNodeInfoList,
  normalizeRunningHubCharacterSwapAspect,
  normalizeRunningHubCharacterSwapDuration,
  normalizeRunningHubCharacterSwapMegapixels,
  normalizeRunningHubCharacterSwapSteps,
} from './runningHubProtocol';

describe('RunningHub 角色替换应用', () => {
  it('应用编号与官方详情页一致', () => {
    expect(RUNNINGHUB_CHARACTER_SWAP_APP_ID).toBe('2112763525239234562');
  });

  it('UI 画幅档位与协议模块完全一致（集合一致，每档都有平台取值）', () => {
    // 顺序不做断言: UI 把横屏放前面（画布常用），协议模块按官方 schema 顺序排列,
    // 两者顺序不同是刻意的 —— 真正会出事的是「集合不同」或「某档没有 COMBO 取值」。
    expect(new Set(CHARACTER_SWAP_ASPECT_RATIOS)).toEqual(
      new Set(Object.keys(RUNNINGHUB_CHARACTER_SWAP_ASPECT_OPTIONS)),
    );
    expect(CHARACTER_SWAP_ASPECT_RATIOS).toHaveLength(RUNNINGHUB_CHARACTER_SWAP_ASPECT_RATIOS.length);
    for (const ratio of CHARACTER_SWAP_ASPECT_RATIOS) {
      expect(RUNNINGHUB_CHARACTER_SWAP_ASPECT_OPTIONS[ratio]).toBeTruthy();
    }
  });

  it('画幅标签折成平台 COMBO 整串，像素串按宽高比就近吸附', () => {
    expect(normalizeRunningHubCharacterSwapAspect('16:9')).toBe('16:9');
    expect(normalizeRunningHubCharacterSwapAspect('1280x720')).toBe('16:9');
    expect(normalizeRunningHubCharacterSwapAspect('720x1280')).toBe('9:16');
    // 21:9 与 16:9 的宽高比很接近, 近似值必须落到 21:9 而不是横屏通用档。
    expect(normalizeRunningHubCharacterSwapAspect('2560x1080')).toBe('21:9');
    expect(normalizeRunningHubCharacterSwapAspect('')).toBeUndefined();
    expect(normalizeRunningHubCharacterSwapAspect('garbage')).toBeUndefined();
  });

  it('像素按 0.1 取整并夹在 0.1~16', () => {
    expect(normalizeRunningHubCharacterSwapMegapixels(0.83)).toBe(0.8);
    expect(normalizeRunningHubCharacterSwapMegapixels(20)).toBe(16);
    expect(normalizeRunningHubCharacterSwapMegapixels(0.01)).toBe(0.1);
    expect(normalizeRunningHubCharacterSwapMegapixels(0)).toBeUndefined();
    expect(normalizeRunningHubCharacterSwapMegapixels('abc')).toBeUndefined();
  });

  it('步数取整并夹在 1~10000', () => {
    expect(normalizeRunningHubCharacterSwapSteps(8.4)).toBe(8);
    expect(normalizeRunningHubCharacterSwapSteps(99999)).toBe(10000);
    expect(normalizeRunningHubCharacterSwapSteps(-3)).toBeUndefined();
  });

  it('图片与视频永远提交，提示词留空时不覆盖应用内置模板', () => {
    const base = buildRunningHubCharacterSwapNodeInfoList({
      imageUrl: 'https://cdn/a.png',
      videoUrl: 'https://cdn/a.mp4',
    });
    expect(base).toEqual([
      { nodeId: RUNNINGHUB_CHARACTER_SWAP_NODES.image, fieldName: 'image', fieldValue: 'https://cdn/a.png' },
      { nodeId: RUNNINGHUB_CHARACTER_SWAP_NODES.video, fieldName: 'video', fieldValue: 'https://cdn/a.mp4' },
    ]);
    // 全空白等价于「没填」——不能发空串过去把作者的模板冲掉。
    const blank = buildRunningHubCharacterSwapNodeInfoList({
      imageUrl: 'https://cdn/a.png',
      videoUrl: 'https://cdn/a.mp4',
      prompt: '   ',
    });
    expect(blank.some((item) => item.nodeId === RUNNINGHUB_CHARACTER_SWAP_NODES.prompt)).toBe(false);
  });

  it('三个出片参数都挂到正确的节点与字段上', () => {
    const list = buildRunningHubCharacterSwapNodeInfoList({
      imageUrl: 'https://cdn/a.png',
      videoUrl: 'https://cdn/a.mp4',
      prompt: '把人物换成参考图里的女孩',
      duration: 5,
      aspectRatio: '9:16',
      megapixels: 1,
      steps: 8,
    });
    const byField = (fieldName: string) => list.find((item) => item.fieldName === fieldName);
    expect(byField('text')).toEqual({
      nodeId: RUNNINGHUB_CHARACTER_SWAP_NODES.prompt,
      fieldName: 'text',
      fieldValue: '把人物换成参考图里的女孩',
    });
    // 时长走的是通用 Float 节点，字段名是 `value` —— 只能靠节点号区分用途。
    expect(byField('value')).toEqual({
      nodeId: RUNNINGHUB_CHARACTER_SWAP_NODES.duration,
      fieldName: 'value',
      fieldValue: '5',
    });
    expect(byField('aspect_ratio')).toEqual({
      nodeId: RUNNINGHUB_CHARACTER_SWAP_NODES.resolution,
      fieldName: 'aspect_ratio',
      fieldValue: '9:16 (Portrait Widescreen)',
    });
    expect(byField('megapixels')).toEqual({
      nodeId: RUNNINGHUB_CHARACTER_SWAP_NODES.resolution,
      fieldName: 'megapixels',
      fieldValue: '1',
    });
    expect(byField('steps')).toEqual({
      nodeId: RUNNINGHUB_CHARACTER_SWAP_NODES.scheduler,
      fieldName: 'steps',
      fieldValue: '8',
    });
  });

  it('时长夹在 1~60 秒并按 0.1 秒取整', () => {
    expect(normalizeRunningHubCharacterSwapDuration(5)).toBe(5);
    expect(normalizeRunningHubCharacterSwapDuration(0.5)).toBe(1);
    expect(normalizeRunningHubCharacterSwapDuration(120)).toBe(60);
    expect(normalizeRunningHubCharacterSwapDuration(7.26)).toBe(7.3);
    expect(normalizeRunningHubCharacterSwapDuration(0)).toBeUndefined();
    expect(normalizeRunningHubCharacterSwapDuration(undefined)).toBeUndefined();
  });

  it('没给时长时不提交 value 节点，让应用默认值生效', () => {
    const list = buildRunningHubCharacterSwapNodeInfoList({
      imageUrl: 'https://cdn/a.png',
      videoUrl: 'https://cdn/a.mp4',
    });
    expect(list.some((item) => item.nodeId === RUNNINGHUB_CHARACTER_SWAP_NODES.duration)).toBe(false);
  });
});

describe('角色替换通用提示词模板', () => {
  it('保留应用认得的素材引用名', () => {
    for (const marker of CHARACTER_SWAP_PROMPT_MARKERS) {
      expect(CHARACTER_SWAP_PROMPT_TEMPLATE).toContain(marker);
    }
  });

  it('已经抽掉原版里那位角色的具体外观描述', () => {
    // 原版是围绕「乌黑长发及腰 + 象牙白缎面吊带长裙 + 白色细带低跟凉鞋」写的 ——
    // 这些词留在模板里，换任何别的角色都会被强行改衣服改发型。
    for (const concreteLook of ['乌黑长发', '缎面', '吊带', '凉鞋', '银色金属圆环', '及踝']) {
      expect(CHARACTER_SWAP_PROMPT_TEMPLATE).not.toContain(concreteLook);
    }
  });

  it('四段结构齐全：换谁 / 保什么 / 一致什么 / 不许改什么', () => {
    const prompt = CHARACTER_SWAP_PROMPT_TEMPLATE;
    expect(prompt).toContain('以 <Image 1> 作为替换角色的唯一身份与外观依据');
    expect(prompt).toContain('运镜');
    expect(prompt).toContain('保持角色形象的一致性');
    expect(prompt).toContain('不得新增或删除');
  });

  it('留空（含纯空白）一律走通用模板，而不是应用内置的那份角色描述', () => {
    // 「留空 → 不提交提示词节点 → 应用用自带模板」是早期行为：那个内置模板围着一位
    // 具体角色写死，留空等于把别人的发型衣服套到用户角色身上。
    expect(resolveCharacterSwapPrompt('')).toBe(CHARACTER_SWAP_PROMPT_TEMPLATE);
    expect(resolveCharacterSwapPrompt('   \n  ')).toBe(CHARACTER_SWAP_PROMPT_TEMPLATE);
    expect(resolveCharacterSwapPrompt(null)).toBe(CHARACTER_SWAP_PROMPT_TEMPLATE);
    expect(resolveCharacterSwapPrompt(undefined)).toBe(CHARACTER_SWAP_PROMPT_TEMPLATE);
  });

  it('用户自己写的提示词原样保留，只去首尾空白', () => {
    expect(resolveCharacterSwapPrompt('  把人物换成参考图里的女孩  ')).toBe('把人物换成参考图里的女孩');
    // 写了内容就不该被模板拼接或改写。
    expect(resolveCharacterSwapPrompt('自定义提示')).not.toContain('保持角色形象的一致性');
  });
});
