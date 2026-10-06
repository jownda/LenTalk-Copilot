import { describe, expect, it } from 'vitest';

import { optimizeLiraPrompt } from './liraRules';

function run(purpose: string, overrides: Partial<Parameters<typeof optimizeLiraPrompt>[0]> = {}) {
  return optimizeLiraPrompt({ purpose, taskType: 'auto', ...overrides });
}

describe('optimizeLiraPrompt — 路由推断', () => {
  it('空草稿不产出提示词', () => {
    const result = run('   ');
    expect(result.prompt).toBe('');
    expect(result.notes).toEqual([]);
  });

  it.each([
    ['一位穿灰色大衣的女性角色，正面半身照', 'character'],
    ['一条雨夜的老街，空镜', 'location'],
    ['一张金属怀表的道具产品图', 'prop'],
    ['把画面里的台灯换成壁灯', 'edit'],
    ['画面纹理发糊，皮肤毛孔丢失', 'texture'],
    ['反打机位，从背后看同一个客厅', 'viewChange'],
  ])('%s → %s', (draft, expected) => {
    expect(run(draft).route.taskType).toBe(expected);
  });

  it('手动指定任务类型时不被自动推断覆盖', () => {
    const result = optimizeLiraPrompt({ purpose: '一条老街', taskType: 'prop', lang: 'en' });
    expect(result.route.taskType).toBe('prop');
  });
});

describe('optimizeLiraPrompt — 人物设定图（Soul 2.0）', () => {
  const result = run('a 30-year-old woman in a grey wool coat', { taskType: 'character', lang: 'en' });

  it('用电影角色设定图措辞，避开插画漂移触发词', () => {
    expect(result.prompt).toContain('film character sheet');
    expect(result.prompt).toContain('Three studio photographs');
    expect(result.prompt).not.toContain('character reference sheet');
    expect(result.prompt).not.toContain('painterly');
  });

  it('角色设定图豁免三分法', () => {
    expect(result.prompt.toLowerCase()).not.toContain('rule of thirds');
  });

  it('提示 Soul ID 承载跨镜头一致性，并点出 Soul 2.0 无 21:9', () => {
    expect(result.notes.join('\n')).toContain('Soul ID');
    expect(result.notes.join('\n')).toContain('21:9');
    expect(result.route.model).toContain('Soul 2.0');
  });

  it('草稿只有「人物角色设定图」时留出信息占位', () => {
    const vague = run('人物角色设定图');
    expect(vague.prompt).toContain('待补充');
    expect(vague.notes.join('\n')).toContain('人物描述不足');
  });
});

describe('optimizeLiraPrompt — 文档 standing rule：三分法', () => {
  it.each(['location', 'prop', 'viewChange'] as const)('%s 追加 rule of thirds', (taskType) => {
    const result = run('一条雨夜的老街', { taskType, lang: 'en' });
    expect(result.prompt).toContain('Rule of thirds');
  });

  it('编辑与纹理通道基于原片，不加三分法', () => {
    expect(run('把台灯换成壁灯', { taskType: 'edit', lang: 'en' }).prompt).not.toContain('Rule of thirds');
    expect(run('皮肤纹理发糊', { taskType: 'texture', lang: 'en' }).prompt).not.toContain('Rule of thirds');
  });
});

describe('optimizeLiraPrompt — 地点模版的机位锚点', () => {
  it('草稿没写机位时补默认锚点', () => {
    const result = run('一条雨夜的老街', { taskType: 'location', lang: 'en' });
    expect(result.prompt).toContain('High angle three-quarter wide shot');
  });

  it('草稿已写机位时不重复叠加锚点', () => {
    const result = run('低角度仰拍一条雨夜的老街', { taskType: 'location', lang: 'en' });
    expect(result.prompt).not.toContain('High angle three-quarter wide shot');
    expect(result.prompt).toContain('低角度仰拍一条雨夜的老街');
  });

  it('Soul Cinema 技术块保持精简，不堆叠 grain 词', () => {
    const result = run('一条老街', { taskType: 'location', lang: 'en' });
    const grains = result.prompt.match(/grain/gi) ?? [];
    expect(grains).toHaveLength(1);
  });
});

describe('optimizeLiraPrompt — 平台参数不进正文', () => {
  const result = run('一条老街 16:9 4K --ar 21:9', { taskType: 'location', lang: 'en' });

  it('从草稿里剔除画幅与分辨率', () => {
    expect(result.prompt).not.toContain('16:9');
    expect(result.prompt).not.toContain('4K');
    expect(result.prompt).not.toContain('--ar');
  });

  it('在应用提示里说明它们属于平台参数', () => {
    const notes = result.notes.join('\n');
    expect(notes).toContain('16:9');
    expect(notes).toContain('4K');
    expect(notes).toContain('Platform parameters');
  });
});

describe('optimizeLiraPrompt — 正向优先（无负面提示词参数）', () => {
  const result = run('一条老街，不要人物', { taskType: 'location', lang: 'en' });

  it('把「不要人物」改写成正向的空景描述', () => {
    expect(result.prompt).toContain('empty deserted space');
    expect(result.prompt).not.toContain('不要人物');
    expect(result.prompt).not.toContain('没有人物');
  });

  it('改写结果记入应用提示', () => {
    expect(result.notes.join('\n')).toContain('positive-first');
  });

  it('中文输出同样改写为正向描述', () => {
    const zh = run('一条老街，没有任何行人', { taskType: 'location' });
    expect(zh.prompt).toContain('空旷无人的空间');
    expect(zh.prompt).not.toContain('行人');
  });

  it('推断任务类型时先做正向改写，避免「不要人物」把空镜判成人物', () => {
    const zh = run('雨夜的老街，霓虹倒影，不要人物');
    expect(zh.route.taskType).toBe('location');
    expect(zh.prompt).toContain('空旷无人的空间');

    const en = run('雨夜的老街，霓虹倒影，不要人物', { lang: 'en' });
    expect(en.route.taskType).toBe('location');
    expect(en.prompt).toContain('empty deserted space');
  });
});

describe('optimizeLiraPrompt — 句子拼接不产生断句', () => {
  it('编辑模版不会出现「。，」这类悬空标点', () => {
    const zh = run('把画面里桌上的台灯换成壁灯', { taskType: 'edit' });
    expect(zh.prompt).not.toContain('。，');
    expect(zh.prompt).not.toContain('。。');
    expect(zh.prompt).not.toContain('，，');
    expect(zh.prompt).toContain('仅修改：把画面里桌上的台灯换成壁灯，其余 100% 保持一致。');
  });

  it('道具模版把草稿嵌进句中时不会吃掉后半句', () => {
    const en = run('a worn brass pocket watch', { taskType: 'prop', lang: 'en' });
    expect(en.prompt).toContain('product shot of a worn brass pocket watch on a neutral grey concrete surface');
  });

  it('调色板行与后面的技术块之间有句读', () => {
    const en = run('雨夜的老街', { taskType: 'location', lang: 'en' });
    expect(en.prompt).toContain('chiaroscuro. Photorealistic');
  });
});

describe('optimizeLiraPrompt — 调色板只从线索推导，不凭空发明', () => {
  it('草稿出现三种颜色时给出 60/30/10', () => {
    const result = run('锈红色的砖墙、靛蓝的夜空、青灰的地面', { taskType: 'location', lang: 'en' });
    expect(result.prompt).toContain('60%');
    expect(result.prompt).toContain('30%');
    expect(result.prompt).toContain('10%');
  });

  it('草稿只有场景线索时按场景推导', () => {
    const result = run('雨夜的老街', { taskType: 'location', lang: 'en' });
    expect(result.prompt).toContain('cool teal-grey');
  });

  it('完全没有线索时留占位符并说明原因', () => {
    const result = run('一条老街', { taskType: 'location', lang: 'en' });
    expect(result.prompt).toContain('[add a palette');
    expect(result.notes.join('\n')).toContain('placeholder');
  });

  it('外部传入调色板时优先使用', () => {
    const result = run('一条老街', { taskType: 'location', lang: 'en', referencePalette: '60% teal, 30% black' });
    expect(result.prompt).toContain('60% teal, 30% black');
  });

  it('编辑与纹理通道不写调色板（原本就要保留原片分级）', () => {
    expect(run('把台灯换成壁灯', { taskType: 'edit', lang: 'en' }).prompt).not.toContain('[add a palette');
    expect(run('皮肤纹理发糊', { taskType: 'texture', lang: 'en' }).prompt).not.toContain('[add a palette');
  });
});

describe('optimizeLiraPrompt — 编辑通道（NBP 永远优先）', () => {
  const result = run('把画面里的台灯换成壁灯', { taskType: 'edit', lang: 'en' });

  it('套用外科手术式模版：最小修改 + 全量保留', () => {
    expect(result.prompt).toContain('CHANGE:');
    expect(result.prompt).toContain('PRESERVE EXACTLY:');
    expect(result.prompt).toContain('ONLY CHANGE:');
    expect(result.prompt).toContain('100% identical otherwise');
  });

  it('保留清单覆盖身份、服装、机位、光线与分级', () => {
    const prompt = result.prompt;
    expect(prompt).toContain('face');
    expect(prompt).toContain('wardrobe');
    expect(prompt).toContain('camera angle');
    expect(prompt).toContain('colour grade');
  });

  it('路由到 NBP 并提示一次只改一处', () => {
    expect(result.route.model).toContain('Nano Banana Pro');
    expect(result.notes.join('\n')).toContain('one change per pass');
  });
});

describe('optimizeLiraPrompt — 纹理通道与机位反转', () => {
  it('纹理修复是 Seedream 的纹理通道，不做点编辑', () => {
    const result = run('皮肤纹理发糊，布料质感塑料感', { taskType: 'texture', lang: 'en' });
    expect(result.prompt).toContain('Revive sloppy AI textures');
    expect(result.prompt).toContain('No point edits');
    expect(result.route.model).toContain('Seedream 4.5');
  });

  it('机位反转必须逐件写清新位置', () => {
    const result = run('走廊的反打机位', { taskType: 'viewChange', lang: 'en' });
    expect(result.prompt).toContain('NEW ARRANGEMENT');
    expect(result.prompt).toContain('on the LEFT');
    expect(result.notes.join('\n')).toContain('GPT Image 2');
  });
});

describe('optimizeLiraPrompt — 输出语言与模型覆盖', () => {
  it('默认输出中文模版', () => {
    const result = run('一位穿灰色大衣的女性角色');
    expect(result.prompt).toContain('电影角色设定图');
    expect(result.prompt).not.toContain('Three studio photographs');
  });

  it('lang=en 输出英文模版', () => {
    const result = run('一位穿灰色大衣的女性角色', { lang: 'en' });
    expect(result.prompt).toContain('film character sheet');
  });

  it('手动指定目标模型时覆盖路由建议', () => {
    const result = optimizeLiraPrompt({
      purpose: '一位穿灰色大衣的女性角色',
      taskType: 'character',
      targetModel: 'Soul Cinema',
      lang: 'zh',
    });
    expect(result.route.model).toBe('Soul Cinema');
    expect(result.notes.join('\n')).toContain('目标模型已手动指定');
  });
});
