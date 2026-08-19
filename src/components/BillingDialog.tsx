import { useCallback, useEffect, useMemo, useState } from 'react';
import { Receipt, RefreshCw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  queryUsageRecords,
  queryUsageSummary,
  type UsageLogRecord,
  type UsageLogSummary,
} from '@/commands/usageLog';

interface BillingDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

type KindFilter = 'all' | 'image' | 'video';
type TimeFilter = 'all' | 'today' | '7d' | '30d';

const KIND_LABELS: Record<KindFilter, string> = {
  all: '全部',
  image: '图片',
  video: '视频',
};

const TIME_LABELS: Record<TimeFilter, string> = {
  all: '全部',
  today: '今天',
  '7d': '近 7 天',
  '30d': '近 30 天',
};

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
  }
  return `${date.getMonth() + 1}/${date.getDate()} ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
}

function formatCost(value: number): string {
  if (value <= 0) {
    return '—';
  }
  if (value < 0.01) {
    return '¥<0.01';
  }
  return `¥${value.toFixed(2)}`;
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

export function BillingDialog({ isOpen, onClose }: BillingDialogProps) {
  const { t } = useTranslation();
  const [records, setRecords] = useState<UsageLogRecord[]>([]);
  const [summary, setSummary] = useState<UsageLogSummary | null>(null);
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('all');
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    const [nextRecords, nextSummary] = await Promise.all([
      queryUsageRecords({ limit: 500 }),
      queryUsageSummary(),
    ]);
    setRecords(nextRecords);
    setSummary(nextSummary);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (isOpen) {
      void refresh();
    }
  }, [isOpen, refresh]);

  const filteredRecords = useMemo(() => {
    const now = Date.now();
    const dayMs = 86_400_000;
    const cutoff = timeFilter === 'today'
      ? (() => {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        return start.getTime();
      })()
      : timeFilter === '7d'
        ? now - 7 * dayMs
        : timeFilter === '30d'
          ? now - 30 * dayMs
          : 0;
    return records.filter((record) => {
      if (kindFilter !== 'all' && record.kind !== kindFilter) {
        return false;
      }
      if (cutoff > 0 && record.createdAt < cutoff) {
        return false;
      }
      return true;
    });
  }, [kindFilter, records, timeFilter]);

  const filteredCost = useMemo(
    () => filteredRecords.reduce((sum, record) => sum + (record.estimatedCost ?? 0), 0),
    [filteredRecords]
  );
  const succeededCount = useMemo(
    () => filteredRecords.filter((record) => record.status === 'succeeded').length,
    [filteredRecords]
  );
  const successRate = filteredRecords.length > 0
    ? Math.round((succeededCount / filteredRecords.length) * 100)
    : 0;

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[120]">
      <div
        className="absolute inset-0 bg-black/45 backdrop-blur-[1px]"
        onClick={onClose}
      />
      <div className="absolute inset-y-0 right-0 flex w-[600px] max-w-[92vw] flex-col border-l border-[rgba(255,255,255,0.14)] bg-surface-dark shadow-2xl">
        {/* 头部 */}
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-[rgba(255,255,255,0.12)] px-4">
          <div className="flex items-center gap-2">
            <Receipt className="h-4 w-4 text-accent" />
            <span className="text-sm font-semibold text-text-dark">账单 / 用量记录</span>
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

        {/* 汇总卡片 */}
        <div className="grid shrink-0 grid-cols-4 gap-2 px-4 pt-4">
          <div className="rounded-xl border border-[rgba(255,255,255,0.1)] bg-bg-dark/60 px-3 py-2.5">
            <div className="text-[11px] text-text-muted">总花费</div>
            <div className="mt-0.5 text-base font-semibold text-text-dark">{formatCost(filteredCost)}</div>
          </div>
          <div className="rounded-xl border border-[rgba(255,255,255,0.1)] bg-bg-dark/60 px-3 py-2.5">
            <div className="text-[11px] text-text-muted">本月花费</div>
            <div className="mt-0.5 text-base font-semibold text-text-dark">{formatCost(summary?.monthCost ?? 0)}</div>
          </div>
          <div className="rounded-xl border border-[rgba(255,255,255,0.1)] bg-bg-dark/60 px-3 py-2.5">
            <div className="text-[11px] text-text-muted">生成次数</div>
            <div className="mt-0.5 text-base font-semibold text-text-dark">
              {filteredRecords.length}
              <span className="ml-1 text-[11px] font-normal text-text-muted">
                (成功 {succeededCount})
              </span>
            </div>
          </div>
          <div className="rounded-xl border border-[rgba(255,255,255,0.1)] bg-bg-dark/60 px-3 py-2.5">
            <div className="text-[11px] text-text-muted">成功率</div>
            <div className="mt-0.5 text-base font-semibold text-text-dark">
              {filteredRecords.length > 0 ? `${successRate}%` : '—'}
            </div>
          </div>
        </div>

        {/* 筛选 */}
        <div className="flex shrink-0 items-center gap-2 px-4 pt-3">
          <div className="flex items-center gap-1 rounded-lg border border-[rgba(255,255,255,0.12)] bg-bg-dark/60 p-0.5">
            {(Object.keys(KIND_LABELS) as KindFilter[]).map((kind) => (
              <button
                key={kind}
                type="button"
                onClick={() => setKindFilter(kind)}
                className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                  kindFilter === kind
                    ? 'bg-accent/20 text-accent'
                    : 'text-text-muted hover:text-text-dark'
                }`}
              >
                {KIND_LABELS[kind]}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-[rgba(255,255,255,0.12)] bg-bg-dark/60 p-0.5">
            {(Object.keys(TIME_LABELS) as TimeFilter[]).map((range) => (
              <button
                key={range}
                type="button"
                onClick={() => setTimeFilter(range)}
                className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                  timeFilter === range
                    ? 'bg-accent/20 text-accent'
                    : 'text-text-muted hover:text-text-dark'
                }`}
              >
                {TIME_LABELS[range]}
              </button>
            ))}
          </div>
        </div>

        {/* 明细表格 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-3">
          {filteredRecords.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <Receipt className="h-8 w-8 text-text-muted/40" />
              <div className="text-xs text-text-muted">
                暂无记录。生成图片或视频后，这里会显示每次生成的费用估算。
              </div>
              <div className="text-[11px] text-text-muted/60">
                费用为本地估算值，实际扣费以平台账单为准
              </div>
            </div>
          ) : (
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="border-b border-[rgba(255,255,255,0.1)] text-left text-[11px] text-text-muted">
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
                {filteredRecords.map((record) => (
                  <tr
                    key={record.id}
                    className="border-b border-[rgba(255,255,255,0.06)] align-middle last:border-0"
                  >
                    <td className="whitespace-nowrap py-2 pr-2 text-text-muted">
                      {formatTime(record.createdAt)}
                    </td>
                    <td className="max-w-[140px] truncate py-2 pr-2 text-text-dark" title={`${record.providerId} / ${record.modelId}`}>
                      {record.modelName || record.modelId}
                    </td>
                    <td className="py-2 pr-2 text-text-muted">{record.kind === 'video' ? '视频' : '图片'}</td>
                    <td className="py-2 pr-2 text-text-muted">
                      {record.size}
                      {record.duration > 0 ? ` · ${record.duration}s` : ''}
                    </td>
                    <td className="py-2 pr-2 text-text-muted">{record.referenceCount > 0 ? `${record.referenceCount}` : '—'}</td>
                    <td className="py-2 pr-2 text-right text-text-dark">{formatCost(record.estimatedCost)}</td>
                    <td className="py-2 pr-2 text-right text-text-muted">{formatDuration(record.durationMs)}</td>
                    <td className="py-2 text-right">
                      {record.status === 'succeeded' ? (
                        <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-300">
                          成功
                        </span>
                      ) : (
                        <span
                          className="inline-flex items-center rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] text-red-300"
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
          )}
        </div>
      </div>
    </div>
  );
}
