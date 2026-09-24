import { describe, expect, it } from 'vitest';

import type { VideoModelDefinition } from '@/features/canvas/models';

import {
  extractDurationSeconds,
  resolveVideoDurationHint,
  resolveVideoDurationHintFromTexts,
  snapDurationToModelOptions,
} from './videoDurationHint';

function buildModel(overrides: Partial<VideoModelDefinition> = {}): VideoModelDefinition {
  return {
    id: 'wan3.0-720p',
    mediaType: 'video',
    displayName: 'Wan 3.0 720p',
    providerId: 'wgspai',
    description: '',
    aspectRatios: [{ value: '16:9', label: '16:9' }],
    defaultAspectRatio: '16:9',
    durationOptions: Array.from({ length: 11 }, (_, index) => index + 5),
    defaultDuration: 5,
    resolutions: [{ value: '720p', label: '720p' }],
    defaultResolution: '720p',
    ...overrides,
  };
}

describe('extractDurationSeconds', () => {
  it('识别「N秒的视频」', () => {
    expect(extractDurationSeconds('一个人在雨夜街头抽烟，5秒的视频')).toBe(5);
    expect(extractDurationSeconds('8秒的短片')).toBe(8);
  });

  it('识别带引导词的句式，且优先于后面出现的裸秒数', () => {
    expect(extractDurationSeconds('时长：15秒。镜头一 5 秒，镜头二 6 秒')).toBe(15);
    expect(extractDurationSeconds('视频时长 8 秒')).toBe(8);
  });

  it('识别「时长N秒」的各种写法', () => {
    expect(extractDurationSeconds('时长10秒')).toBe(10);
    expect(extractDurationSeconds('时长：10秒')).toBe(10);
    expect(extractDurationSeconds('时长 10 s')).toBe(10);
    expect(extractDurationSeconds('时长为10秒')).toBe(10);
    // 省略单位、只留冒号的写法
    expect(extractDurationSeconds('时长：10')).toBe(10);
    // 但「时长：10分钟」里的 10 是分钟，不能当秒用
    expect(extractDurationSeconds('时长：10分钟')).toBeNull();
  });

  it('识别「时间：00:00-00:10」时间段，取区间长度', () => {
    expect(extractDurationSeconds('时间：00:00-00:10')).toBe(10);
    expect(extractDurationSeconds('时间：00:00 - 00:10')).toBe(10);
    expect(extractDurationSeconds('时间：00:00~00:10')).toBe(10);
    expect(extractDurationSeconds('时间 00:00 至 00:10')).toBe(10);
    // 起点不是 0 时，时长是区间长度（第 5 秒到第 15 秒 = 10 秒）
    expect(extractDurationSeconds('时间：00:05-00:15')).toBe(10);
    expect(extractDurationSeconds('时间码：0:00–0:15')).toBe(15);
    expect(extractDurationSeconds('时长 00:00 到 00:20')).toBe(20);
    // 起点写全时间码、终点只写秒的简写
    expect(extractDurationSeconds('时间：00:00-10')).toBe(10);
    // 中文输入法下的全角减号 / 数学减号也算区间连接符
    expect(extractDurationSeconds('时间：00:00－00:10')).toBe(10);
    expect(extractDurationSeconds('时间：00:00−00:10')).toBe(10);
    // 单个时间码
    expect(extractDurationSeconds('时间：00:10')).toBe(10);
  });

  it('时间段无效或超范围时不算数', () => {
    // 区间长度为 0
    expect(extractDurationSeconds('时间：00:00-00:00')).toBeNull();
    // 20 分钟远超上限，说明写的不是「这条片子多长」
    expect(extractDurationSeconds('时间：00:00-20:00')).toBeNull();
  });

  it('识别英文句式', () => {
    expect(extractDurationSeconds('duration: 8s, single take')).toBe(8);
    expect(extractDurationSeconds('a 12 seconds clip')).toBe(12);
    expect(extractDurationSeconds('9 segments across the frame')).toBeNull();
  });

  it('裸「N秒」可用，但挡掉序数与小数时间轴', () => {
    expect(extractDurationSeconds('10秒，长镜头')).toBe(10);
    // 高级编辑器的场景行：`场景：雨夜街头，15秒，厦门，夜晚，雨`
    expect(extractDurationSeconds('场景：雨夜街头，15秒，厦门，夜晚，雨')).toBe(15);
    // 旧数据里的整数镜头区间：终点即镜头长度
    expect(extractDurationSeconds('镜头 01（0-15秒）')).toBe(15);
    // 序数：第 3 秒是时间点，不是成片长度
    expect(extractDurationSeconds('第3秒出现一只手')).toBeNull();
    expect(extractDurationSeconds('第12秒切到远景')).toBeNull();
    // beat 时间轴是小数，不是用户写的成片长度
    expect(extractDurationSeconds('镜头 01（0.0–6.0 秒）')).toBeNull();
    expect(extractDurationSeconds('SHOT 01 (0.0-6.0s)')).toBeNull();
  });

  it('没有秒数 / 空串 / null 都返回 null', () => {
    expect(extractDurationSeconds('雨夜街头，一个人抽烟')).toBeNull();
    expect(extractDurationSeconds('')).toBeNull();
    expect(extractDurationSeconds(null)).toBeNull();
    expect(extractDurationSeconds(undefined)).toBeNull();
  });

  it('忽略 0 秒与超出上限的数字', () => {
    expect(extractDurationSeconds('0秒')).toBeNull();
    expect(extractDurationSeconds('9999秒')).toBeNull();
  });
});

describe('snapDurationToModelOptions', () => {
  it('连续档位夹到区间内', () => {
    expect(snapDurationToModelOptions(buildModel(), 8)).toBe(8);
    expect(snapDurationToModelOptions(buildModel(), 2)).toBe(5);
    expect(snapDurationToModelOptions(buildModel(), 999)).toBe(15);
  });

  it('离散档位取最接近的合法值', () => {
    const seedance = buildModel({ durationOptions: [4, 5, 6, 8, 10, 12, 15, 20, 25, 30] });
    expect(snapDurationToModelOptions(seedance, 10)).toBe(10);
    expect(snapDurationToModelOptions(seedance, 7)).toBe(6);
    expect(snapDurationToModelOptions(seedance, 9)).toBe(8);
    expect(snapDurationToModelOptions(seedance, 13)).toBe(12);
  });

  it('固定单一档位的模型返回 null（不改动）', () => {
    expect(snapDurationToModelOptions(buildModel({ durationOptions: [30] }), 8)).toBeNull();
    expect(snapDurationToModelOptions(buildModel({ durationOptions: [8] }), 8)).toBeNull();
  });

  it('模型缺失或没有档位声明时返回 null', () => {
    expect(snapDurationToModelOptions(undefined, 8)).toBeNull();
    expect(snapDurationToModelOptions(buildModel({ durationOptions: [] }), 8)).toBeNull();
  });
});

describe('resolveVideoDurationHint', () => {
  it('文案有明确秒数且模型可变时长 → 落值', () => {
    expect(resolveVideoDurationHint(buildModel(), '5秒的视频')).toBe(5);
  });

  it('文案没有秒数 → null，保持节点默认值', () => {
    expect(resolveVideoDurationHint(buildModel(), '雨夜街头，一个人抽烟')).toBeNull();
  });

  it('模型固定时长 → null，即使文案写了秒数', () => {
    const fixed = buildModel({ durationOptions: [30], defaultDuration: 30 });
    expect(resolveVideoDurationHint(fixed, '8秒的视频')).toBeNull();
  });
});

describe('resolveVideoDurationHintFromTexts', () => {
  it('提示词优先，提示词没写秒数时回落到故事梗概', () => {
    const model = buildModel();
    expect(
      resolveVideoDurationHintFromTexts(model, ['雨夜街头', '5秒的视频'])
    ).toBe(5);
    expect(
      resolveVideoDurationHintFromTexts(model, ['总时长：8 秒', '5秒的视频'])
    ).toBe(8);
  });

  it('都没写秒数时返回 null', () => {
    expect(resolveVideoDurationHintFromTexts(buildModel(), ['雨夜街头', ''])).toBeNull();
  });
});

describe('时间段写法端到端', () => {
  it('落到模型档位上', () => {
    expect(resolveVideoDurationHint(buildModel(), '时间：00:00-00:10')).toBe(10);
    expect(resolveVideoDurationHint(buildModel(), '时长10秒')).toBe(10);
    // 离散档位吸附：等距时取较小档（与既有行为一致，视频宁短不长）
    const seedance = buildModel({ durationOptions: [4, 5, 6, 8, 10, 12, 15, 20, 25, 30] });
    expect(resolveVideoDurationHint(seedance, '时间：00:00-00:09')).toBe(8);
    expect(resolveVideoDurationHint(seedance, '时间：00:00-00:13')).toBe(12);
  });

  it('模型固定时长时仍然不改动', () => {
    const fixed = buildModel({ durationOptions: [8], defaultDuration: 8 });
    expect(resolveVideoDurationHint(fixed, '时间：00:00-00:10')).toBeNull();
    expect(resolveVideoDurationHint(fixed, '时长10秒')).toBeNull();
  });
});

/**
 * 编译器（提示词工作室）输出的最终提示词里**本来就有逐镜时间轴**
 * （`0:00–0:06 — 镜头 1`、`0:00–0:03：角色：动作`）。这些数字只代表某一镜头的
 * 长度，不代表整片时长 —— 一旦被识别，用户没写时长也会被莫名改掉。
 */
describe('与编译器输出的隔离', () => {
  it('逐镜时间轴不会被当成整片时长', () => {
    const compiled = [
      '0:00–0:06 — 镜头 1（相机：固定机位）',
      '0:00–0:03：林sir：推开木门；停顿一秒。',
      '0:06–0:15 — 镜头 2',
    ].join('\n');
    expect(extractDurationSeconds(compiled)).toBeNull();
  });

  it('用户自己逐镜写的时间段：引导词没紧邻时间码就不算数', () => {
    expect(
      extractDurationSeconds('动作时间：镜头1 · 0:00-0:17：林sir回忆；镜头2 · 0:17-0:34：阿俊入画。')
    ).toBeNull();
  });

  it('整片时间段仍然优先于后面出现的裸秒数', () => {
    expect(extractDurationSeconds('时间：00:00-00:10。镜头一 3 秒，镜头二 4 秒')).toBe(10);
  });

  it('「时间：」后面不是时间码时不受影响', () => {
    // 用户字段里常见的写法：引导词后面跟的是镜头编号，不是时间码
    expect(extractDurationSeconds('时间：镜头1 · 0:00-0:17')).toBeNull();
  });
});

/**
 * 判定顺序是「先看明确性，再谈位置」：明确的声明全篇任何位置都认；只有信息不足
 * （裸秒数这类弱信号、或多处时长互相冲突）才收窄到开头区域 —— 那里才是场记位置。
 */
describe('明确性优先，位置只用于仲裁', () => {
  it('带引导词的明确声明写在任何位置都认', () => {
    expect(extractDurationSeconds('时间：00:00-00:10\n雨夜，厦门老街，一个人撑伞走过')).toBe(10);
    expect(extractDurationSeconds('时长10秒。雨夜街头，一个人抽烟')).toBe(10);
    // 写在句子之后、远离开头，仍然认（明确就不用收窄）
    expect(extractDurationSeconds('雨夜街头，男人点烟。\n时间：00:00-00:10')).toBe(10);
  });

  it('裸秒数这类弱信号只在开头区域里认', () => {
    expect(extractDurationSeconds('10秒，长镜头')).toBe(10);
    expect(extractDurationSeconds('场景：雨夜街头，15秒，厦门，夜晚，雨')).toBe(15);
    // 正文里描述镜头节奏的秒数不算
    expect(extractDurationSeconds('雨夜街头，男人点烟。停顿 5 秒后起身离开。')).toBeNull();
    // 「约」是模糊估计，不构成明确声明 → 落到弱信号，位置在中部 → 不算
    expect(extractDurationSeconds('雨夜街头，男人点烟。镜头缓慢推进，时长约3秒后切到特写。')).toBeNull();
  });

  it('多处时长互相冲突时才收窄到开头', () => {
    expect(extractDurationSeconds('时间：00:00-00:06；时间：00:06-00:15')).toBe(6);
    expect(extractDurationSeconds('时间：00:00-00:06。\n镜头2 · 时间：00:06-00:15。')).toBe(6);
  });

  /**
   * 真实格式：剧本表头是**多行**的（集 / 场 / 时间 / 人物 / 调度 各占一行），
   * 「时间：」落在第 3 行。边界若按换行切就会漏掉它。
   */
  it('多行表头里的时间段能识别', () => {
    const script = [
      '# 第1集',
      '1-1场 日 内 卧室',
      '时间：00:00-00:04',
      '人物：女子，老人',
      '场面调度：女子处于画面左侧近景，单手持产品展示；老人躺在右侧床上，右手搭放在碎花被面上。',
      '人物状态：女子：平稳；老人：虚弱卧床（布满皱纹的手搭在被面上，手指微动）',
      '△【00:00】室内床边，女子从画面左下方伸出一只手，握着一盒产品向镜头展示。',
      '△【00:02】老人的手掌手指微微向上抬离被面，女子依然稳稳握着产品。',
    ].join('\n');
    expect(extractDurationSeconds(script)).toBe(4);
  });

  it('多行表头里的「时长N秒」也能识别', () => {
    expect(extractDurationSeconds('雨夜，厦门老街\n时长10秒\n△【00:00】一个人撑伞走过')).toBe(10);
  });
});
