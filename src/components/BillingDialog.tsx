import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Clapperboard,
  Film,
  Flame,
  Image as ImageIcon,
  Layers,
  Receipt,
  RefreshCw,
  Sparkles,
  Table,
  Trophy,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  queryUsageBreakdown,
  queryUsageDaily,
  queryUsageRecords,
  queryUsageSummary,
  type UsageDailyBucket,
  type UsageLogRecord,
  type UsageLogSummary,
  type UsageModelBreakdown,
} from '@/commands/usageLog';
import {
  KIND_COLORS,
  KIND_LABELS,
  KIND_OPTIONS,
  RANGE_OPTIONS,
  buildComposition,
  buildHeatmap,
  describeComposition,
  formatCost,
  formatCount,
  heatLevel,
  shortDay,
  summarize,
  type KindFilter,
  type MediaKind,
  type RangeFilter,
} from '@/features/billing/billingStats';

interface BillingDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

/** 热力图 0~4 档的透明度(基于主题 accent 色, 深浅主题都能看)。 */
const HEAT_ALPHA = [0.16, 0.34, 0.52, 0.72, 0.95];

function heatCellBackground(count: number, level: number): string {
  if (count <= 0) {
    return 'rgb(var(--border-rgb) / 0.55)';
  }
  return `rgb(var(--accent-rgb) / ${HEAT_ALPHA[level]})`;
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const time = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
  return sameDay ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

function formatDuration(ms: number): string {
  if (ms <= 0) {
    return '—';
  }
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 模型排行里标出该模型主要产出的类型。 */
function dominantKind(item: UsageModelBreakdown): MediaKind | null {
  const entries: [MediaKind, number][] = [
    ['image', item.image],
    ['video', item.video],
    ['audio', item.audio],
  ];
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][1] > 0 ? entries[0][0] : null;
}

export function BillingDialog({ isOpen, onClose }: BillingDialogProps) {
  const { t } = useTranslation();
  const [records, setRecords] = useState<UsageLogRecord[]>([]);
  const [daily, setDaily] = useState<UsageDailyBucket[]>([]);
  const [breakdown, setBreakdown] = useState<UsageModelBreakdown[]>([]);
  const [summary, setSummary] = useState<UsageLogSummary | null>(null);
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [rangeFilter, setRangeFilter] = useState<RangeFilter>('all');
  const [detailOpen, setDetailOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  // 统计口径基准时间: 只在刷新时推进, 避免渲染过程中 now 漂移导致 useMemo 反复失效。
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    setLoading(true);
    const [nextRecords, nextDaily, nextBreakdown, nextSummary] = await Promise.all([
      queryUsageRecords({ limit: 1000 }),
      queryUsageDaily(),
      queryUsageBreakdown(10),
      queryUsageSummary(),
    ]);
    setRecords(nextRecords);
    setDaily(nextDaily);
    setBreakdown(nextBreakdown);
    setSummary(nextSummary);
    setNow(Date.now());
    setLoading(false);
  }, []);

  useEffect(() => {
    if (isOpen) {
      void refresh();
    }
  }, [isOpen, refresh]);

  // 头部徽标用「全部时间 + 全部类型」的口径, 不随筛选跳动。
  const globalSummary = useMemo(() => summarize(daily, 'all', 'all', now), [daily, now]);
  const scopedSummary = useMemo(
    () => summarize(daily, kindFilter, rangeFilter, now),
    [daily, kindFilter, rangeFilter, now]
  );
  const heatmap = useMemo(
    () => buildHeatmap(daily, kindFilter, rangeFilter, now),
    [daily, kindFilter, rangeFilter, now]
  );
  const composition = useMemo(() => buildComposition(scopedSummary.byKind), [scopedSummary.byKind]);
  const rangeLabel =
    RANGE_OPTIONS.find((option) => option.value === rangeFilter)?.label ?? '全部时间';

  const filteredRecords = useMemo(() => {
    const nowMs = Date.now();
    const dayMs = 86_400_000;
    const cutoff =
      rangeFilter === 'today'
        ? (() => {
            const start = new Date(nowMs);
            start.setHours(0, 0, 0, 0);
            return start.getTime();
          })()
        : rangeFilter === 'all'
          ? 0
          : nowMs - (Number(rangeFilter.replace('d', '')) - 1) * dayMs;
    return records.filter((record) => {
      if (kindFilter !== 'all' && record.kind !== kindFilter) {
        return false;
      }
      if (cutoff > 0 && record.createdAt < cutoff) {
        return false;
      }
      return true;
    });
  }, [kindFilter, rangeFilter, records]);

  const lastUpdated = useMemo(() => {
    if (records.length === 0) {
      return '—';
    }
    const latest = records.reduce((max, record) => Math.max(max, record.createdAt), 0);
    return `${new Date(latest).getMonth() + 1}-${new Date(latest).getDate()} ${formatTime(latest)}`;
  }, [records]);

  const statCards = useMemo(() => {
    const { byKind, total, succeeded, failed, currentStreak, longestStreak, activeDays } =
      scopedSummary;
    const totalGeneration = byKind.image + byKind.video + byKind.audio;
    const percentOf = (value: number) =>
      totalGeneration > 0 ? `${Math.round((value / totalGeneration) * 100)}%` : '—';
    return [
      {
        label: '图片生成',
        icon: ImageIcon,
        value: formatCount(byKind.image),
        unit: '张',
        hint: `占全部 ${percentOf(byKind.image)}`,
      },
      {
        label: '视频生成',
        icon: Film,
        value: formatCount(byKind.video),
        unit: '本',
        hint: `占全部 ${percentOf(byKind.video)}`,
      },
      {
        label: '累计生成',
        icon: Layers,
        value: formatCount(total),
        unit: '次',
        hint: kindFilter === 'all' ? `成功 ${formatCount(succeeded)} · 失败 ${formatCount(failed)}` : `${KIND_LABELS[kindFilter]}口径`,
      },
      {
        label: '连续创作',
        icon: Flame,
        value: formatCount(currentStreak),
        unit: '天',
        hint: `最近一次 ${shortDay(globalSummary.lastActiveDay)}`,
      },
      {
        label: '最长连续',
        icon: Trophy,
        value: formatCount(longestStreak),
        unit: '天',
        hint: `共 ${formatCount(activeDays)} 个活跃日`,
      },
    ];
  }, [kindFilter, globalSummary.lastActiveDay, scopedSummary]);

  const maxModelTotal = useMemo(
    () => breakdown.reduce((max, item) => Math.max(max, item.total), 0),
    [breakdown]
  );

  if (!isOpen) {
    return null;
  }

  const hasData = daily.length > 0;

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 sm:p-6">
      <div className="absolute inset-0 bg-black/55 backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative z-10 flex max-h-full w-full max-w-[1080px] flex-col overflow-hidden rounded-2xl border border-border-dark bg-surface-dark shadow-2xl">
        {/* 顶栏 */}
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border-dark px-4">
          <div className="flex items-center gap-2">
            <Receipt className="h-4 w-4 text-accent" />
            <span className="text-sm font-semibold text-text-dark">账单 / 创作历程</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void refresh()}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark"
              title="刷新"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark"
              title={t('common.close')}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-7 sm:px-8">
          {/* 创作者头部 */}
          <div className="flex flex-col items-center text-center">
            <div className="relative flex h-[72px] w-[72px] items-center justify-center rounded-full bg-accent/15 ring-1 ring-accent/25">
              <Clapperboard className="h-8 w-8 text-accent" />
              <span className="absolute -bottom-0.5 -right-0.5 flex h-6 w-6 items-center justify-center rounded-full border border-border-dark bg-surface-dark">
                <Sparkles className="h-3.5 w-3.5 text-accent" />
              </span>
            </div>
            <div className="mt-3 text-lg font-semibold text-text-dark">创作者</div>
            <div className="mt-1 text-xs text-text-muted">把灵感，变成看得见的作品。</div>
            <div className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-[11px] text-accent">
              <Sparkles className="h-3 w-3" />
              已记录 {formatCount(globalSummary.total)} 次生成 · 图片 · 视频 · 音频
            </div>
          </div>

          {!hasData ? (
            <div className="mt-12 flex flex-col items-center justify-center gap-2 py-10 text-center">
              <Receipt className="h-9 w-9 text-text-muted/40" />
              <div className="text-xs text-text-muted">
                暂无记录。生成图片、视频或音频后，这里会汇总你的创作历程与费用估算。
              </div>
            </div>
          ) : (
            <>
              {/* 区块标题 + 时间范围 */}
              <div className="mt-9 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-text-dark">我的创作历程</h3>
                <select
                  value={rangeFilter}
                  onChange={(event) => setRangeFilter(event.target.value as RangeFilter)}
                  className="h-8 cursor-pointer rounded-lg border border-border-dark bg-bg-dark/60 px-2 text-xs text-text-dark outline-none transition-colors hover:border-accent/40"
                >
                  {RANGE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* 统计卡片条 */}
              <div className="mt-3 grid grid-cols-2 divide-border-dark overflow-hidden rounded-xl border border-border-dark bg-bg-dark/40 sm:grid-cols-3 lg:grid-cols-5 lg:divide-x">
                {statCards.map((card) => (
                  <div key={card.label} className="px-4 py-3.5">
                    <div className="flex items-center gap-1.5 text-[11px] text-text-muted">
                      <card.icon className="h-3.5 w-3.5" />
                      {card.label}
                    </div>
                    <div className="mt-2 flex items-baseline gap-1">
                      <span className="text-[26px] font-semibold leading-none tabular-nums text-text-dark">
                        {card.value}
                      </span>
                      <span className="text-[11px] text-text-muted">{card.unit}</span>
                    </div>
                    <div className="mt-1.5 truncate text-[10.5px] text-text-muted/80">{card.hint}</div>
                  </div>
                ))}
              </div>

              {/* 热力图 */}
              <div className="mt-4 rounded-xl border border-border-dark bg-bg-dark/40 p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-text-dark">创作记录</div>
                    <div className="mt-1 text-[11px] leading-relaxed text-text-muted">
                      {scopedSummary.activeDaysInRange > 0
                        ? `${rangeLabel}内 ${scopedSummary.activeDaysInRange} 个活跃日，共完成 ${formatCount(scopedSummary.total)} 次生成。每个格子代表一天，颜色越深生成越多。`
                        : `${rangeLabel}内还没有生成记录。`}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-border-dark bg-surface-dark/60 p-0.5">
                    {KIND_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => setKindFilter(option.value)}
                        className={`rounded-md px-2.5 py-1 text-[11px] transition-colors ${
                          kindFilter === option.value
                            ? 'bg-accent/20 text-accent'
                            : 'text-text-muted hover:text-text-dark'
                        }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="mt-5 flex gap-2">
                  <div className="flex shrink-0 flex-col gap-[3px] pt-[14px]">
                    {['一', '', '三', '', '五', '', '日'].map((label, index) => (
                      <div
                        key={index}
                        className="h-[11px] w-4 text-[9px] leading-[11px] text-text-muted/70"
                      >
                        {label}
                      </div>
                    ))}
                  </div>
                  <div className="min-w-0 flex-1 overflow-x-auto">
                    {/* 固定总宽, 让月份标签与格子共用同一坐标系(格子 11px + 3px 间距) */}
                    <div style={{ width: Math.max(heatmap.weeks.length * 14 - 3, 0) }}>
                      <div className="relative h-[14px]">
                        {heatmap.monthLabels.map((label) => (
                          <span
                            key={label.index}
                            className="absolute top-0 whitespace-nowrap text-[9px] text-text-muted/70"
                            style={{ left: label.index * 14 }}
                          >
                            {label.label}
                          </span>
                        ))}
                      </div>
                      <div
                        className="grid"
                        style={{
                          gridAutoFlow: 'column',
                          gridTemplateRows: 'repeat(7, 11px)',
                          gridAutoColumns: '11px',
                          gap: '3px',
                        }}
                      >
                        {heatmap.weeks.flatMap((week, weekIndex) =>
                          week.map((cell, dayIndex) => {
                            const level = heatLevel(cell.count, heatmap.thresholds);
                            return (
                              <div
                                key={`${weekIndex}-${dayIndex}`}
                                title={
                                  cell.future
                                    ? undefined
                                    : `${cell.day} · ${
                                        cell.count > 0 ? `${cell.count} 次` : '无生成'
                                      }${cell.cost > 0 ? ` · ${formatCost(cell.cost)}` : ''}`
                                }
                                className="rounded-[2px] transition-transform hover:scale-[1.25]"
                                style={{
                                  backgroundColor: cell.future
                                    ? 'transparent'
                                    : heatCellBackground(cell.count, level),
                                }}
                              />
                            );
                          })
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-[10.5px] text-text-muted">
                  <div className="flex items-center gap-1.5">
                    <span>少</span>
                    {[0, 1, 2, 3, 4].map((level) => (
                      <span
                        key={level}
                        className="h-[10px] w-[10px] rounded-[2px]"
                        style={{
                          backgroundColor:
                            level === 0
                              ? heatCellBackground(0, 0)
                              : `rgb(var(--accent-rgb) / ${HEAT_ALPHA[level]})`,
                        }}
                      />
                    ))}
                    <span>多</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span>共 {formatCount(scopedSummary.total)} 次</span>
                    {kindFilter === 'all' ? (
                      <>
                        <span className="flex items-center gap-1">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                          成功 {formatCount(scopedSummary.succeeded)}
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
                          失败 {formatCount(scopedSummary.failed)}
                        </span>
                      </>
                    ) : null}
                    <span>单日最多 {formatCount(heatmap.maxCount)} 次</span>
                  </div>
                </div>
              </div>

              {/* 创作构成 + 费用估算 */}
              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <div className="rounded-xl border border-border-dark bg-bg-dark/40 p-5">
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="text-sm font-semibold text-text-dark">创作构成</div>
                    <div className="text-[10.5px] text-text-muted">占全部生成的比例</div>
                  </div>
                  <div className="mt-2 text-[11px] leading-relaxed text-text-muted">
                    {describeComposition(composition)}
                  </div>
                  <div className="mt-5 flex h-2.5 overflow-hidden rounded-full bg-border-dark/60">
                    {composition.map((segment) => (
                      <div
                        key={segment.kind}
                        style={{ width: `${segment.ratio * 100}%`, backgroundColor: segment.color }}
                      />
                    ))}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
                    {composition.map((segment) => (
                      <div
                        key={segment.kind}
                        className="flex items-center gap-1.5 text-[11px] text-text-muted"
                      >
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ backgroundColor: segment.color }}
                        />
                        {segment.label} {formatCount(segment.count)}
                        <span className="text-text-muted/60">
                          ({Math.round(segment.ratio * 100)}%)
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-xl border border-border-dark bg-bg-dark/40 p-5">
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="text-sm font-semibold text-text-dark">费用估算</div>
                    <div className="text-[10.5px] text-text-muted">按模型定价本地估算</div>
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-4">
                    <div>
                      <div className="flex items-center gap-1.5 text-[11px] text-text-muted">
                        <Film className="h-3.5 w-3.5" />
                        视频费用
                      </div>
                      <div className="mt-1.5 text-xl font-semibold tabular-nums text-text-dark">
                        {formatCost(scopedSummary.byKindCost.video)}
                      </div>
                    </div>
                    <div>
                      <div className="flex items-center gap-1.5 text-[11px] text-text-muted">
                        <ImageIcon className="h-3.5 w-3.5" />
                        图片费用
                      </div>
                      <div className="mt-1.5 text-xl font-semibold tabular-nums text-text-dark">
                        {formatCost(scopedSummary.byKindCost.image)}
                      </div>
                    </div>
                  </div>
                  <div className="mt-4 border-t border-border-dark pt-3 text-[10.5px] leading-relaxed text-text-muted/80">
                    累计 {formatCost(scopedSummary.cost)}
                    {summary ? ` · 本月 ${formatCost(summary.monthCost)}` : ''} · 最近更新 {lastUpdated}
                    <br />
                    费用只统计已配置定价的模型（图片与音频多数未配置，暂记 ¥0）；实际扣费以平台账单为准。
                  </div>
                </div>
              </div>

              {/* 常用模型 */}
              {breakdown.length > 0 ? (
                <div className="mt-4 rounded-xl border border-border-dark bg-bg-dark/40 p-5">
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="text-sm font-semibold text-text-dark">常用模型</div>
                    <div className="text-[10.5px] text-text-muted">
                      全部时间 · 共 {formatCount(
                        breakdown.reduce((sum, item) => sum + item.total, 0)
                      )} 次
                    </div>
                  </div>
                  <div className="mt-4 space-y-2.5">
                    {breakdown.slice(0, 5).map((item, index) => {
                      const kind = dominantKind(item);
                      const percent = maxModelTotal > 0 ? item.total / maxModelTotal : 0;
                      return (
                        <div key={`${item.modelId}-${index}`} className="flex items-center gap-3">
                          <span className="w-3 shrink-0 text-[11px] tabular-nums text-text-muted">
                            {index + 1}
                          </span>
                          <span
                            className="w-44 shrink-0 truncate text-xs text-text-dark sm:w-56"
                            title={`${item.modelName || item.modelId}${item.providerName ? ` · ${item.providerName}` : ''}`}
                          >
                            {item.modelName || item.modelId}
                          </span>
                          {kind ? (
                            <span className="hidden shrink-0 items-center gap-1 text-[10px] text-text-muted sm:flex">
                              <span
                                className="h-1.5 w-1.5 rounded-full"
                                style={{ backgroundColor: KIND_COLORS[kind] }}
                              />
                              {KIND_LABELS[kind]}
                            </span>
                          ) : null}
                          <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-border-dark/50">
                            <div
                              className="h-full rounded-full bg-accent"
                              style={{ width: `${Math.max(3, percent * 100)}%` }}
                            />
                          </div>
                          <span className="w-20 shrink-0 text-right text-[11px] tabular-nums text-text-muted">
                            {formatCount(item.total)} 次
                          </span>
                          <span className="hidden w-14 shrink-0 text-right text-[10.5px] tabular-nums text-text-muted/70 sm:block">
                            {item.failed > 0 ? `失败 ${item.failed}` : '无失败'}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {/* 用量明细 */}
              <div className="mt-4 rounded-xl border border-border-dark bg-bg-dark/40">
                <button
                  type="button"
                  onClick={() => setDetailOpen((open) => !open)}
                  className="flex w-full items-center justify-between px-5 py-3.5"
                >
                  <span className="flex items-center gap-2 text-sm font-semibold text-text-dark">
                    <Table className="h-4 w-4 text-text-muted" />
                    用量明细
                  </span>
                  <span className="flex items-center gap-2 text-[11px] text-text-muted">
                    {formatCount(filteredRecords.length)} 条
                    {detailOpen ? (
                      <ChevronDown className="h-4 w-4" />
                    ) : (
                      <ChevronRight className="h-4 w-4" />
                    )}
                  </span>
                </button>
                {detailOpen ? (
                  <div className="border-t border-border-dark px-5 py-4">
                    {filteredRecords.length === 0 ? (
                      <div className="py-6 text-center text-[11px] text-text-muted">
                        当前筛选条件下没有记录。
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full border-collapse text-xs">
                          <thead>
                            <tr className="border-b border-border-dark text-left text-[11px] text-text-muted">
                              <th className="pb-2 pr-2 font-normal">时间</th>
                              <th className="pb-2 pr-2 font-normal">模型</th>
                              <th className="pb-2 pr-2 font-normal">类型</th>
                              <th className="pb-2 pr-2 font-normal">规格</th>
                              <th className="pb-2 pr-2 font-normal">参考图</th>
                              <th className="pb-2 pr-2 text-right font-normal">费用</th>
                              <th className="pb-2 pr-2 text-right font-normal">耗时</th>
                              <th className="pb-2 font-normal">状态</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredRecords.slice(0, 200).map((record) => (
                              <tr
                                key={record.id}
                                className="border-b border-border-dark/50 align-middle last:border-0"
                              >
                                <td className="whitespace-nowrap py-2 pr-2 text-text-muted">
                                  {formatTime(record.createdAt)}
                                </td>
                                <td
                                  className="max-w-[140px] truncate py-2 pr-2 text-text-dark"
                                  title={`${record.providerId} / ${record.modelId}`}
                                >
                                  {record.modelName || record.modelId}
                                </td>
                                <td className="py-2 pr-2 text-text-muted">
                                  {KIND_LABELS[record.kind]}
                                </td>
                                <td className="py-2 pr-2 text-text-muted">
                                  {record.size}
                                  {record.duration > 0 ? ` · ${record.duration}s` : ''}
                                </td>
                                <td className="py-2 pr-2 text-text-muted">
                                  {record.referenceCount > 0 ? `${record.referenceCount}` : '—'}
                                </td>
                                <td className="py-2 pr-2 text-right text-text-dark">
                                  {formatCost(record.estimatedCost)}
                                </td>
                                <td className="py-2 pr-2 text-right text-text-muted">
                                  {formatDuration(record.durationMs)}
                                </td>
                                <td className="py-2 text-right">
                                  {record.status === 'succeeded' ? (
                                    <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-400">
                                      成功
                                    </span>
                                  ) : (
                                    <span
                                      className="inline-flex items-center rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] text-red-400"
                                      title={record.errorMessage || undefined}
                                    >
                                      失败
                                    </span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {filteredRecords.length > 200 ? (
                          <div className="pt-3 text-center text-[10.5px] text-text-muted/70">
                            仅显示最近 200 条，共 {formatCount(filteredRecords.length)} 条
                          </div>
                        ) : null}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
