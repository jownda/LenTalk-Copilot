import { useEffect } from 'react';
import { ArrowUpRight, FolderOpen, X } from 'lucide-react';

/**
 * 画布内的轻量提示条。
 *
 * 起因：节点管理的「下载」是把文件写进系统下载目录，**成功时界面上什么都不发生**，
 * 用户看到的就是「点了没反应」，于是连点四五次，下载目录里堆出一串同名副本。
 * 所以成功也必须说话，而且要说清「存到哪了」，并给一个直接打开目录的入口。
 *
 * 故意不用全局弹窗：连续下载多个素材时，模态框会打断操作。
 */
export interface CanvasToastProps {
  message: string;
  /** 次要信息，例如完整路径。过长时自动单行省略。 */
  detail?: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss: () => void;
  /** 自动消失时间（毫秒）；传 0 表示不自动消失。 */
  duration?: number;
}

export function CanvasToast({
  message,
  detail,
  actionLabel,
  onAction,
  onDismiss,
  duration = 4200,
}: CanvasToastProps) {
  useEffect(() => {
    if (!duration) return;
    const timer = window.setTimeout(onDismiss, duration);
    return () => window.clearTimeout(timer);
    // message 变化视为「换了一条提示」，重新计时。
  }, [duration, message, onDismiss]);

  return (
    <div
      role="status"
      className="pointer-events-none absolute bottom-4 left-1/2 z-40 w-[min(420px,calc(100%-32px))] -translate-x-1/2"
    >
      <div className="pointer-events-auto flex items-start gap-2 rounded-lg border border-border-dark bg-surface-dark px-3 py-2 shadow-2xl">
        <FolderOpen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-300" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12px] font-medium text-text-dark" title={message}>
            {message}
          </p>
          {detail && (
            <p className="truncate text-[10px] text-text-muted" title={detail}>
              {detail}
            </p>
          )}
        </div>
        {actionLabel && onAction && (
          <button
            type="button"
            onClick={onAction}
            className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-accent transition-colors hover:bg-bg-dark"
          >
            {actionLabel}
            <ArrowUpRight className="h-3 w-3" />
          </button>
        )}
        <button
          type="button"
          aria-label="关闭提示"
          onClick={onDismiss}
          className="shrink-0 rounded p-0.5 text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
