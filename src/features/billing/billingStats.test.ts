import { describe, expect, it } from 'vitest';
import type { UsageDailyBucket } from '@/commands/usageLog';
import {
  buildComposition,
  buildHeatmap,
  describeComposition,
  formatCost,
  heatLevel,
  rangeStartKey,
  summarize,
  toDayKey,
} from '@/features/billing/billingStats';

/** 2026-10-08 12:00 (+08:00) —— 固定「现在」, 避免测试随真实时间漂移。 */
const NOW = new Date(2026, 9, 8, 12, 0, 0).getTime();

function bucket(day: string, patch: Partial<UsageDailyBucket> = {}): UsageDailyBucket {
  const image = patch.image ?? 0;
  const video = patch.video ?? 0;
  const audio = patch.audio ?? 0;
  const total = patch.total ?? image + video + audio;
  const imageCost = patch.imageCost ?? 0;
  const videoCost = patch.videoCost ?? 0;
  const audioCost = patch.audioCost ?? 0;
  return {
    day,
    total,
    succeeded: patch.succeeded ?? total,
    failed: patch.failed ?? 0,
    image,
    video,
    audio,
    // 与 Rust 侧一致: cost 是各类型费用之和
    cost: patch.cost ?? imageCost + videoCost + audioCost,
    imageCost,
    videoCost,
    audioCost,
  };
}

describe('toDayKey', () => {
  it('用本地时区而不是 UTC(否则晚上会差一天)', () => {
    expect(toDayKey(new Date(2026, 9, 8, 23, 30))).toBe('2026-10-08');
    expect(toDayKey(new Date(2026, 0, 1, 0, 5))).toBe('2026-01-01');
  });
});

describe('rangeStartKey', () => {
  const buckets = [bucket('2026-08-20', { image: 1 })];

  it('按天回推, 含今天', () => {
    expect(rangeStartKey('today', buckets, NOW)).toBe('2026-10-08');
    expect(rangeStartKey('7d', buckets, NOW)).toBe('2026-10-02');
    expect(rangeStartKey('30d', buckets, NOW)).toBe('2026-09-09');
  });

  it('全部时间取下界为最早一条记录', () => {
    expect(rangeStartKey('all', buckets, NOW)).toBe('2026-08-20');
    expect(rangeStartKey('all', [], NOW)).toBeNull();
  });
});

describe('summarize', () => {
  const buckets = [
    bucket('2026-10-05', { image: 3, video: 1, imageCost: 0, videoCost: 12.5 }),
    bucket('2026-10-06', { image: 2 }),
    bucket('2026-10-07', { image: 5, video: 2, failed: 1, succeeded: 6, videoCost: 20 }),
    bucket('2026-10-08', { audio: 4, failed: 2, succeeded: 2 }),
  ];

  it('次数与费用受类型 + 时间范围过滤', () => {
    const all = summarize(buckets, 'all', 'all', NOW);
    expect(all.total).toBe(17);
    // 未显式给 succeeded 的桶按整桶成功计: 4 + 2 + 6 + 2
    expect(all.succeeded).toBe(14);
    expect(all.failed).toBe(3);
    expect(all.cost).toBeCloseTo(32.5);

    expect(summarize(buckets, 'video', 'all', NOW).total).toBe(3);
    expect(summarize(buckets, 'video', 'all', NOW).cost).toBeCloseTo(32.5);
    expect(summarize(buckets, 'image', '7d', NOW).total).toBe(10);
    expect(summarize(buckets, 'image', 'today', NOW).total).toBe(0);
  });

  it('类型不是「全部」时不谎报成功/失败(后端按天只聚合了总量)', () => {
    expect(summarize(buckets, 'audio', 'all', NOW).succeeded).toBe(0);
    expect(summarize(buckets, 'audio', 'all', NOW).failed).toBe(0);
  });

  it('创作构成统计各类型, 不受类型筛选影响', () => {
    const summary = summarize(buckets, 'image', 'all', NOW);
    expect(summary.byKind).toEqual({ image: 10, video: 3, audio: 4 });
  });

  it('连续天数用全历史, 选「今天」不会把连续天数打回 1', () => {
    expect(summarize(buckets, 'all', 'today', NOW).currentStreak).toBe(4);
    expect(summarize(buckets, 'all', 'all', NOW).currentStreak).toBe(4);
    expect(summarize(buckets, 'all', 'all', NOW).activeDaysInRange).toBe(4);
    expect(summarize(buckets, 'all', 'today', NOW).activeDaysInRange).toBe(1);
  });

  it('今天还没创作时不判定为断签', () => {
    const yesterdayOnly = [bucket('2026-10-07', { image: 1 }), bucket('2026-10-06', { image: 1 })];
    expect(summarize(yesterdayOnly, 'all', 'all', NOW).currentStreak).toBe(2);
  });

  it('最长连续取历史最大连续段', () => {
    const withGap = [
      bucket('2026-09-01', { image: 1 }),
      bucket('2026-09-02', { image: 1 }),
      bucket('2026-09-03', { image: 1 }),
      bucket('2026-09-10', { image: 1 }),
      bucket('2026-10-07', { image: 1 }),
      bucket('2026-10-08', { image: 1 }),
    ];
    const summary = summarize(withGap, 'all', 'all', NOW);
    expect(summary.longestStreak).toBe(3);
    expect(summary.currentStreak).toBe(2);
    expect(summary.firstActiveDay).toBe('2026-09-01');
    expect(summary.lastActiveDay).toBe('2026-10-08');
  });

  it('成功率只按全量类型统计', () => {
    const summary = summarize(buckets, 'all', 'all', NOW);
    expect(summary.successRate).toBeCloseTo(14 / 17);
  });
});

describe('heatLevel', () => {
  it('0 次永远是最浅; 超出阈值逐级上升, 封顶 4', () => {
    expect(heatLevel(0, [1, 3, 7])).toBe(0);
    expect(heatLevel(1, [1, 3, 7])).toBe(1);
    expect(heatLevel(2, [1, 3, 7])).toBe(2);
    expect(heatLevel(5, [1, 3, 7])).toBe(3);
    expect(heatLevel(9, [1, 3, 7])).toBe(4);
  });

  it('全是同一天量级时不会把所有格子顶到最深', () => {
    expect(heatLevel(1, [1, 1, 1])).toBe(1);
  });
});

describe('buildHeatmap', () => {
  const buckets = [
    bucket('2026-08-20', { image: 2 }),
    bucket('2026-10-07', { video: 9 }),
    bucket('2026-10-08', { image: 1 }),
  ];

  it('每列 7 天且列首为周一', () => {
    const model = buildHeatmap(buckets, 'all', 'all', NOW);
    expect(model.weeks.length).toBeGreaterThanOrEqual(26);
    for (const week of model.weeks) {
      expect(week).toHaveLength(7);
    }
    const firstDay = new Date(model.weeks[0][0].day);
    expect((firstDay.getDay() + 6) % 7).toBe(0);
  });

  it('末尾补位到周日并标记 future', () => {
    const model = buildHeatmap(buckets, 'all', 'all', NOW);
    const lastWeek = model.weeks[model.weeks.length - 1];
    expect(lastWeek[6].day).toBe('2026-10-11');
    // 2026-10-08 是周四, 之后的周五/六/日属于补位
    expect(lastWeek[4].future).toBe(true);
    expect(lastWeek[6].future).toBe(true);
    expect(lastWeek[3].future).toBe(false);
    expect(lastWeek[3].count).toBe(1);
  });

  it('类型筛选只影响计数, 不影响网格形状', () => {
    const all = buildHeatmap(buckets, 'all', 'all', NOW);
    const video = buildHeatmap(buckets, 'video', 'all', NOW);
    expect(video.weeks.length).toBe(all.weeks.length);
    const flatVideo = video.weeks.flat().filter((cell) => cell.day === '2026-10-07');
    expect(flatVideo[0].count).toBe(9);
  });

  it('近 7 天只铺 2 列(周一 + 本周), 且不含更早的记录', () => {
    const model = buildHeatmap(buckets, 'all', '7d', NOW);
    const days = model.weeks.flat().filter((cell) => !cell.future).map((cell) => cell.day);
    expect(days).toEqual([
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
    ]);
    // 2026-08-20 的 2 次图片被排除在窗口外
    expect(model.weeks.flat().reduce((sum, cell) => sum + cell.count, 0)).toBe(10);
  });

  it('月份标签按列去重且不粘连', () => {
    const model = buildHeatmap(buckets, 'all', '365d', NOW);
    const indices = model.monthLabels.map((label) => label.index);
    expect(new Set(indices).size).toBe(indices.length);
    for (let i = 1; i < indices.length; i += 1) {
      expect(indices[i] - indices[i - 1]).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('buildComposition / describeComposition', () => {
  it('按真实数据算出占比(视频为主力)', () => {
    const segments = buildComposition({ image: 249, video: 290, audio: 14 });
    expect(segments.map((segment) => segment.kind)).toEqual(['video', 'image', 'audio']);
    expect(segments[0].ratio).toBeCloseTo(290 / 553);
    expect(describeComposition(segments)).toContain('视频是你的主力');
    expect(describeComposition(segments)).toContain('52%');
  });

  it('无记录时返回空并给出兜底文案', () => {
    expect(buildComposition({ image: 0, video: 0, audio: 0 })).toEqual([]);
    expect(describeComposition([])).toContain('还没有生成记录');
  });

  it('只有一种类型时不说「紧随其后」', () => {
    const segments = buildComposition({ image: 5, video: 0, audio: 0 });
    expect(segments).toHaveLength(1);
    expect(describeComposition(segments)).toBe('目前只用了图片生成，共 5 次。');
  });
});

describe('formatCost', () => {
  it('0 与极小值都不显示成 ¥0.00', () => {
    expect(formatCost(0)).toBe('¥0');
    expect(formatCost(0.004)).toBe('<¥0.01');
    expect(formatCost(734.623)).toBe('¥734.62');
  });
});
