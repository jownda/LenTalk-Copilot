import { memo, useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CloudOff, Loader2, X } from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";

import { useCanvasStore } from "@/stores/canvasStore";
import { useProjectStore } from "@/stores/projectStore";
import { createMediaLocalizer } from "@/features/mediaMaintenance/localizeMedia";
import {
  collectUnpersistedMedia,
  summarizeUnpersistedMedia,
  type UnpersistedMediaSummary,
} from "@/features/mediaMaintenance/unpersistedMedia";

/**
 * 画布上「素材还没落盘」的兜底修复。
 *
 * 生成侧的落盘失败是静默的（`persistVideoLocally` 只 warn 一句就退回远端 URL），
 * 用户看不出这条素材其实还在平台临时链接上。旧实现是弹一条黄条让用户点「存到本地」——
 * 但这是**纯机械的重复劳动**，同一个工程每次打开都要再问一遍。
 *
 * 现在改成：**打开工程后自动在后台做，成功不打扰，只有失败才冒出来**。
 * 「同一批素材只自动试一次」由 `autoAttemptRef` 记住签名保证，失败后不会无限重试；
 * 用户重试仍失败就停在提示条上，直到手动关掉或换工程。
 *
 * 性能取舍（重要）：**不订阅 `nodes`**。画布拖拽时 `nodes` 每帧换引用，用 selector
 * 订阅会让这个组件每帧重渲。改成订阅 store 的**变更事件** + 800ms 防抖扫描，
 * 拖动过程中反复重置定时器，停手后才真正遍历一次。
 */
const SCAN_DEBOUNCE_MS = 800;
/** 自动修复前的静默期：等工程把节点图铺完，避免和加载过程抢着写工程。 */
const AUTO_LOCALIZE_DELAY_MS = 2000;

/** 深拷贝：整条链路（setCanvasData / 历史栈）按「新对象」判断是否变化。 */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * 这条失败是不是「源文件本机已经没有了」。
 *
 * 那种情况**再存一次也不会有结果** —— 文件不在了，属于已裂的素材，只能重新上传/生成。
 * 自动保存把它当失败报出来，用户看到的是「全部失败：Failed to read local image source:
 * 系统找不到指定的文件。(os error 2)；放宽预算重试后仍失败…」这种内部话术，
 * 既看不懂也没有可做的动作。所以这类失败**不参与提示**。
 */
export function isMissingLocalSourceFailure(reason: string): boolean {
  if (!reason) return false;
  return (
    reason.includes("本地文件已经不存在") ||
    /Failed to read (local|file:\/\/) (image|media) source/i.test(reason) ||
    /os error 2\b/i.test(reason) ||
    reason.includes("系统找不到指定的文件")
  );
}

/** 把内部话术压成一句人话（取第一段，去掉重试之类的实现细节）。 */
export function plainReason(reason: string): string {
  const head = reason.split(/[；;]/)[0]?.trim() ?? "";
  if (!head) return "";
  if (/Failed to read|os error|放宽预算/i.test(head)) return "源文件已不可用";
  return head;
}

export const UnpersistedMediaNotice = memo(function UnpersistedMediaNotice({
  leftOffsetPx = 64,
}: {
  /**
   * 距画布左缘的距离（px）。
   *
   * 不能写死：节点管理器面板是 `left-3 top-3 w-64`（12 + 256），**展开时几乎占满整列**，
   * 固定 `left-16` 会被它压住 —— 用户报过「提示条被节点管理器挡住」。由 `Canvas.tsx`
   * 按展开状态传值（展开 280 / 收起 64）。
   */
  leftOffsetPx?: number;
}) {
  const [summary, setSummary] = useState<UnpersistedMediaSummary | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 只有失败时才非空：它是「要不要冒出来打扰用户」的唯一依据。 */
  const [errorText, setErrorText] = useState<string | null>(null);
  const dismissedProjectRef = useRef<string | null>(null);
  /** 自动修复的签名（工程 + 待处理规模）；同一签名只自动跑一次。 */
  const autoAttemptRef = useRef<string>("");

  const scanNow = useCallback(() => {
    const next = summarizeUnpersistedMedia(collectUnpersistedMedia(useCanvasStore.getState().nodes));
    setSummary((previous) =>
      previous &&
      previous.total === next.total &&
      previous.remote === next.remote &&
      previous.inline === next.inline &&
      previous.nodes === next.nodes
        ? previous
        : next,
    );
  }, []);

  useEffect(() => {
    scanNow();
    let timer: number | undefined;
    const unsubscribe = useCanvasStore.subscribe(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(scanNow, SCAN_DEBOUNCE_MS);
    });
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [scanNow]);

  // 换工程就重新开始：上一个工程的「忽略」和失败记录都不该顺延。
  useEffect(() => {
    const unsubscribe = useProjectStore.subscribe((state) => {
      const projectId = state.currentProjectId ?? null;
      // 工程 id 短暂变空（保存/重新加载的中间态）不算换工程，否则刚点「忽略」提示就弹回来。
      if (!projectId || projectId === dismissedProjectRef.current) return;
      dismissedProjectRef.current = null;
      autoAttemptRef.current = "";
      setDismissed(false);
      setErrorText(null);
    });
    return unsubscribe;
  }, []);

  /** 真正执行本地化。成功时完全安静；失败一定说出来。 */
  const runLocalize = useCallback(async () => {
    if (!isTauri()) {
      setErrorText("浏览器预览下无法保存到本地，请在桌面端操作");
      return;
    }
    setBusy(true);
    try {
      type LocalizeStats = { localized: number; failed: { reason?: string }[] };
      let stats: LocalizeStats | null = null;
      let wroteBack = false;

      // 下载可能持续几十秒，期间用户完全可能继续改画布。直接写回会覆盖他的编辑，
      // 所以每轮都记下画布引用，写完前再核一次；变了就重来一轮（已落盘的部分是幂等的）。
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const canvas = useCanvasStore.getState();
        const sourceNodes = canvas.nodes;
        const nodes = cloneJson(canvas.nodes);
        const edges = cloneJson(canvas.edges);
        const history = canvas.history ? cloneJson(canvas.history) : canvas.history;

        const localizer = createMediaLocalizer();
        await localizer.localize(nodes);
        await localizer.localize(edges);
        await localizer.localize(history);
        stats = localizer.stats;

        if (useCanvasStore.getState().nodes !== sourceNodes) continue;
        if (stats.localized > 0) {
          useCanvasStore.getState().setCanvasData(nodes, edges, history);
          const projectState = useProjectStore.getState();
          projectState.saveCurrentProject(
            nodes,
            edges,
            projectState.currentProject?.viewport,
            history,
          );
        }
        wroteBack = true;
        break;
      }

      // 两轮都被并发编辑打断：这一轮放弃，等下一次扫描（签名变了会重新尝试）。
      if (!stats || !wroteBack) return;

      // 只有「还能补救」的失败才值得打扰用户：源文件已经没了的那些，再存也不会有结果。
      const recoverable = stats.failed.filter(
        (item) => !isMissingLocalSourceFailure(item.reason ?? ""),
      );
      if (recoverable.length > 0) {
        const reason = plainReason(recoverable[0]?.reason ?? "");
        setErrorText(
          stats.localized > 0
            ? `已保存 ${stats.localized} 条，还有 ${recoverable.length} 条没存下来${reason ? `（${reason}）` : ""}`
            : `${recoverable.length} 条素材没能保存到本地${reason ? `：${reason}` : "，链接可能已经失效"}`,
        );
      } else {
        // 成功、或只剩「源文件已丢失」这类无解的情况 —— 保持安静。
        setErrorText(null);
      }
      scanNow();
    } catch (error) {
      setErrorText(`本地化失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [scanNow]);

  // 自动修复：等工程铺完 → 静默存一遍。同一批素材只试一次，避免失败后反复重试。
  useEffect(() => {
    if (!summary || summary.remote === 0) return;
    if (busy || dismissed || !isTauri()) return;
    const projectId = useProjectStore.getState().currentProjectId ?? "unknown";
    const signature = `${projectId}:${summary.remote}:${summary.remoteNodes}`;
    if (autoAttemptRef.current === signature) return;
    autoAttemptRef.current = signature;

    const timer = window.setTimeout(() => {
      void runLocalize();
    }, AUTO_LOCALIZE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [busy, dismissed, runLocalize, summary]);

  const handleDismiss = useCallback(() => {
    dismissedProjectRef.current = useProjectStore.getState().currentProjectId ?? null;
    setDismissed(true);
  }, []);

  // 没有失败就不占画布：成功是默认结果，不需要再告诉用户一遍。
  if (dismissed || !errorText) return null;

  return (
    <div
      className="absolute bottom-4 z-20 w-[320px] rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-100 shadow-lg backdrop-blur-sm"
      style={{
        left: leftOffsetPx,
        // 窗口很窄时别溢出到画布外（面板展开后可用宽度只剩 100% - 280px）。
        maxWidth: `calc(100% - ${leftOffsetPx + 16}px)`,
      }}
      role="status"
    >
      <div className="flex items-start gap-2">
        <CloudOff className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-medium leading-4">素材自动保存到本地失败</div>
          <div className="mt-1 flex items-start gap-1 text-[11px] leading-4 text-amber-200/90">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            <span className="min-w-0 break-words">{errorText}</span>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void runLocalize()}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded border border-amber-400/60 bg-amber-500/20 px-2 py-1 text-[11px] text-amber-100 transition-colors hover:bg-amber-500/30 disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              {busy ? "正在重试…" : "重试"}
            </button>
            <button
              type="button"
              onClick={handleDismiss}
              className="text-[11px] text-amber-200/70 transition-colors hover:text-amber-100"
            >
              忽略
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          className="text-amber-200/60 transition-colors hover:text-amber-100"
          aria-label="关闭提示"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
});

UnpersistedMediaNotice.displayName = "UnpersistedMediaNotice";
