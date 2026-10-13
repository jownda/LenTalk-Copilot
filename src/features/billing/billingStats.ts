// ---------------------------------------------------------------------------
// 账单 / 创作历程 的统计计算(纯函数, 便于单测)
// 输入是 usage_log 的按天聚合桶(`query_usage_daily`), 不依赖任何 UI 或 Tauri 运行时。
//
// 设计依据(本机真实数据形态):
// - 记录里有 kind(image/video/audio)、status、estimated_cost、model 维度, 没有 token 概念;
// - 费用只有「已配置定价」的模型才有值(图片/音频当前多为 0), 因此费用只做次要展示。
// ---------------------------------------------------------------------------
import type { UsageDailyBucket } from '@/commands/usageLog';

export type KindFilter = 'all' | 'image' | 'video' | 'audio';
export type RangeFilter = 'today' | '7d' | '30d' | '90d' | '365d' | 'all';
export type MediaKind = 'image' | 'video' | 'audio';

export const DAY_MS = 86_400_000;

export const RANGE_OPTIONS: { value: RangeFilter; label: string }[] = [
  { value: 'all', label: '全部时间' },
  { value: 'today', label: '今天' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
  { value: '90d', label: '近 90 天' },
  { value: '365d', label: '近 1 年' },
];

export const KIND_OPTIONS: { value: KindFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'audio', label: '音频' },
];

export const KIND_LABELS: Record<MediaKind, string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
};

export const MEDIA_KINDS: MediaKind[] = ['image', 'video', 'audio'];

/** 三种类型的固定配色(与主题无关, 明暗底都能看清): 图片=主题蓝, 视频=紫, 音频=青绿。 */
export const KIND_COLORS: Record<MediaKind, string> = {
  image: 'rgb(59 130 246)',
  video: 'rgb(167 139 250)',
  audio: 'rgb(52 211 153)',
};

/** 本地时区的 `YYYY-MM-DD`(不用 toISOString, 那个是 UTC 会差一天)。 */
export function toDayKey(value: Date | number): string {
  const date = typeof value === 'number' ? new Date(value) : value;
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** `YYYY-MM-DD` → 本地 0 点的 Date。 */
export function fromDayKey(key: string): Date {
  const [year, month, day] = key.split('-').map((part) => Number(part));
  return new Date(year, (month ?? 1) - 1, day ?? 1);
}

function startOfToday(now: number): Date {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date;
}

function shiftDays(base: Date, days: number): Date {
  const date = new Date(base);
  date.setDate(date.getDate() + days);
  return date;
}

/** 周一为一周之首, 返回 0(周一)..6(周日)。 */
function weekdayIndex(date: Date): number {
  return (date.getDay() + 6) % 7;
}

export function kindCount(bucket: UsageDailyBucket, kind: KindFilter): number {
  switch (kind) {
    case 'image':
      return bucket.image;
    case 'video':
      return bucket.video;
    case 'audio':
      return bucket.audio;
    default:
      return bucket.total;
  }
}

export function kindCost(bucket: UsageDailyBucket, kind: KindFilter): number {
  switch (kind) {
    case 'image':
      return bucket.imageCost;
    case 'video':
      return bucket.videoCost;
    case 'audio':
      return bucket.audioCost;
    default:
      return bucket.cost;
  }
}

/** 时间范围下界(ISO 日期串); `all` 返回 null 表示不设下界。 */
export function rangeStartKey(
  range: RangeFilter,
  buckets: readonly UsageDailyBucket[],
  now: number
): string | null {
  const today = startOfToday(now);
  switch (range) {
    case 'today':
      return toDayKey(today);
    case '7d':
      return toDayKey(shiftDays(today, -6));
    case '30d':
      return toDayKey(shiftDays(today, -29));
    case '90d':
      return toDayKey(shiftDays(today, -89));
    case '365d':
      return toDayKey(shiftDays(today, -364));
    default:
      if (buckets.length === 0) {
        return null;
      }
      return buckets[0].day;
  }
}

export interface BillingSummary {
  /** 选中类型 + 选中时间范围内的生成次数。 */
  total: number;
  succeeded: number;
  failed: number;
  /** 各类型次数(只按时间范围过滤, 不受类型筛选影响, 供「创作构成」使用)。 */
  byKind: Record<MediaKind, number>;
  cost: number;
  byKindCost: Record<MediaKind, number>;
  /** 时间范围内有记录的天数。 */
  activeDaysInRange: number;
  /** 全历史(按类型过滤)的活跃天数、连续天数。 */
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  /** 全历史最后 / 第一次有活动的日期。 */
  lastActiveDay: string | null;
  firstActiveDay: string | null;
  successRate: number;
}

/**
 * 汇总统计。
 * - 次数 / 费用: 受「类型 + 时间范围」共同过滤;
 * - 连续创作 / 最长连续 / 活跃天数: 只受类型过滤(全局语义, 选「今天」不该让连续天数变 1);
 * - 成功 / 失败: 后端按天只聚合了总量, 仅在类型=全部时可用, 否则为 0(由调用方决定是否展示)。
 */
export function summarize(
  buckets: readonly UsageDailyBucket[],
  kind: KindFilter,
  range: RangeFilter,
  now: number
): BillingSummary {
  const todayKey = toDayKey(startOfToday(now));
  const startKey = rangeStartKey(range, buckets, now);

  const byKind: Record<MediaKind, number> = { image: 0, video: 0, audio: 0 };
  const byKindCost: Record<MediaKind, number> = { image: 0, video: 0, audio: 0 };
  let total = 0;
  let succeeded = 0;
  let failed = 0;
  let cost = 0;
  let activeDaysInRange = 0;

  for (const bucket of buckets) {
    if (bucket.day > todayKey) {
      continue;
    }
    if (startKey !== null && bucket.day < startKey) {
      continue;
    }
    byKind.image += bucket.image;
    byKind.video += bucket.video;
    byKind.audio += bucket.audio;
    byKindCost.image += bucket.imageCost;
    byKindCost.video += bucket.videoCost;
    byKindCost.audio += bucket.audioCost;

    const count = kindCount(bucket, kind);
    total += count;
    cost += kindCost(bucket, kind);
    if (kind === 'all') {
      succeeded += bucket.succeeded;
      failed += bucket.failed;
    }
    if (count > 0) {
      activeDaysInRange += 1;
    }
  }

  // 连续天数用全历史(仅按类型过滤), 且要求日期升序去重。
  const activeDates: Date[] = [];
  for (const bucket of buckets) {
    if (kindCount(bucket, kind) > 0) {
      activeDates.push(fromDayKey(bucket.day));
    }
  }
  activeDates.sort((a, b) => a.getTime() - b.getTime());

  let longestStreak = 0;
  let run = 0;
  let previous: Date | null = null;
  for (const date of activeDates) {
    if (previous && Math.round((date.getTime() - previous.getTime()) / DAY_MS) === 1) {
      run += 1;
    } else {
      run = 1;
    }
    longestStreak = Math.max(longestStreak, run);
    previous = date;
  }

  const activeSet = new Set(activeDates.map((date) => toDayKey(date)));
  let cursor = startOfToday(now);
  // 今天还没创作不算断: 从昨天往回数。
  if (!activeSet.has(toDayKey(cursor))) {
    cursor = shiftDays(cursor, -1);
  }
  let currentStreak = 0;
  while (activeSet.has(toDayKey(cursor))) {
    currentStreak += 1;
    cursor = shiftDays(cursor, -1);
  }

  const lastActiveDay = activeDates.length > 0 ? toDayKey(activeDates[activeDates.length - 1]) : null;
  const firstActiveDay = activeDates.length > 0 ? toDayKey(activeDates[0]) : null;

  return {
    total,
    succeeded,
    failed,
    byKind,
    cost,
    byKindCost,
    activeDaysInRange,
    activeDays: activeSet.size,
    currentStreak,
    longestStreak,
    lastActiveDay,
    firstActiveDay,
    successRate: total > 0 ? succeeded / total : 0,
  };
}

export interface HeatCell {
  day: string;
  count: number;
  succeeded: number;
  failed: number;
  cost: number;
  /** 超过今天的补位格子(为对齐整周), 渲染为隐形。 */
  future: boolean;
}

export interface HeatmapModel {
  /** 每列一周(周一起), 共 7 行。 */
  weeks: HeatCell[][];
  monthLabels: { index: number; label: string }[];
  /** 用于配色分级的四分位阈值。 */
  thresholds: number[];
  maxCount: number;
}

/** 0(无) ~ 4(最多) 的强度等级。 */
export function heatLevel(count: number, thresholds: readonly number[]): number {
  if (count <= 0) {
    return 0;
  }
  let level = 1;
  for (const threshold of thresholds) {
    if (count > threshold) {
      level += 1;
    }
  }
  return Math.min(4, level);
}

/** 取非零值的四分位作为分级阈值, 避免少数超长尾把大部分日子压成同一档。 */
function quantileThresholds(counts: readonly number[]): number[] {
  const nonZero = counts.filter((count) => count > 0).sort((a, b) => a - b);
  if (nonZero.length === 0) {
    return [0, 0, 0];
  }
  const pick = (ratio: number) => nonZero[Math.min(nonZero.length - 1, Math.floor(nonZero.length * ratio))];
  return [pick(0.25), pick(0.5), pick(0.75)];
}

/** 构建热力图: 列=周, 行=周一..周日, 只统计选中的类型。 */
export function buildHeatmap(
  buckets: readonly UsageDailyBucket[],
  kind: KindFilter,
  range: RangeFilter,
  now: number
): HeatmapModel {
  const byDay = new Map(buckets.map((bucket) => [bucket.day, bucket]));
  const today = startOfToday(now);

  // 「全部时间」至少铺满一整年(53 周), 与 GitHub 贡献图一致, 数据少时也不会缩成一条窄带。
  const defaultWeeks = 53;
  let start: Date;
  if (range === 'all') {
    const earliest = buckets.length > 0 ? fromDayKey(buckets[0].day) : today;
    const floor = shiftDays(today, -(defaultWeeks * 7 - 1));
    start = earliest.getTime() < floor.getTime() ? earliest : floor;
  } else {
    const windowDays = range === 'today' ? 1 : Number(range.replace('d', ''));
    start = shiftDays(today, -(windowDays - 1));
  }

  const alignedStart = shiftDays(start, -weekdayIndex(start));
  const alignedEnd = shiftDays(today, 6 - weekdayIndex(today));

  const weeks: HeatCell[][] = [];
  let week: HeatCell[] = [];
  const dayCounts: number[] = [];
  const todayKey = toDayKey(today);

  for (
    let cursor = alignedStart;
    cursor.getTime() <= alignedEnd.getTime();
    cursor = shiftDays(cursor, 1)
  ) {
    const key = toDayKey(cursor);
    const bucket = byDay.get(key);
    const count = bucket ? kindCount(bucket, kind) : 0;
    const cell: HeatCell = {
      day: key,
      count,
      succeeded: bucket ? bucket.succeeded : 0,
      failed: bucket ? bucket.failed : 0,
      cost: bucket ? kindCost(bucket, kind) : 0,
      future: key > todayKey,
    };
    dayCounts.push(cell.future ? 0 : count);
    week.push(cell);
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  }
  if (week.length > 0) {
    weeks.push(week);
  }

  const monthLabels: { index: number; label: string }[] = [];
  let lastLabelIndex = -99;
  let lastMonth = -1;
  weeks.forEach((currentWeek, index) => {
    const month = Number(currentWeek[0].day.slice(5, 7));
    if (month !== lastMonth) {
      // 相邻标签太近就跳过, 避免月份文字叠在一起。
      if (index === 0 || index - lastLabelIndex >= 3) {
        monthLabels.push({ index, label: `${month}月` });
        lastLabelIndex = index;
      }
      lastMonth = month;
    }
  });

  return {
    weeks,
    monthLabels,
    thresholds: quantileThresholds(dayCounts),
    maxCount: dayCounts.reduce((max, count) => Math.max(max, count), 0),
  };
}

export interface CompositionSegment {
  kind: MediaKind;
  label: string;
  count: number;
  /** 0~1。 */
  ratio: number;
  color: string;
}

/** 各类型在总生成量中的占比(忽略 0 值类型)。 */
export function buildComposition(byKind: Record<MediaKind, number>): CompositionSegment[] {
  const total = MEDIA_KINDS.reduce((sum, kind) => sum + byKind[kind], 0);
  if (total <= 0) {
    return [];
  }
  return MEDIA_KINDS.filter((kind) => byKind[kind] > 0)
    .map((kind) => ({
      kind,
      label: KIND_LABELS[kind],
      count: byKind[kind],
      ratio: byKind[kind] / total,
      color: KIND_COLORS[kind],
    }))
    .sort((a, b) => b.count - a.count);
}

/** 一句话总结创作构成, 给底部卡片做「人话」标题。 */
export function describeComposition(segments: readonly CompositionSegment[]): string {
  if (segments.length === 0) {
    return '还没有生成记录。';
  }
  if (segments.length === 1) {
    return `目前只用了${segments[0].label}生成，共 ${segments[0].count} 次。`;
  }
  const [first, second] = segments;
  const percent = Math.round(first.ratio * 100);
  return `${first.label}是你的主力，占全部生成的 ${percent}%，${second.label}紧随其后。`;
}

/** 千分位。 */
export function formatCount(value: number): string {
  return value.toLocaleString('zh-CN');
}

/** 费用展示: 0 显示 ¥0, 小于一分显示 <¥0.01。 */
export function formatCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '¥0';
  }
  if (value < 0.01) {
    return '<¥0.01';
  }
  return `¥${value.toFixed(2)}`;
}

/** `2026-10-08` → `10-08`。 */
export function shortDay(key: string | null): string {
  return key ? key.slice(5) : '—';
}
