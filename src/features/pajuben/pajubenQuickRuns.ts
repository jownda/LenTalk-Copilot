// ---------------------------------------------------------------------------
// 「扒视频」后台运行登记表
//
// 卡片以前把运行状态放在组件里：关窗就卸载、监听器跟着卸，扒完的剧本没人在场接，
// 节点也落不下来 —— 所以关窗只能被禁掉。现在把「这一单」整体搬到模块级 store：
//   - 卡片关掉不影响子进程，事件监听常驻（只装一次）；
//   - 重新点「扒视频」时从登记表恢复进度；
//   - 扒完由这里统一落节点，不依赖卡片是否还开着。
//
// 一张卡对一个视频节点，因此按 nodeId 建表；同一时刻可以有多个节点在跑，
// 事件靠 runId 反查归属。
// ---------------------------------------------------------------------------
import { create } from 'zustand';

import i18n from '@/i18n';
import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { onPajubenFinish, onPajubenLog, onPajubenProgress, readPajubenScript } from '@/commands/pajuben';

/** 剧本正文节点的初始版面：文本节点默认 300×180，读整集剧本太挤。 */
export const SCRIPT_NODE_WIDTH = 460;
export const SCRIPT_NODE_HEIGHT = 420;

export type QuickRunStatus = 'preparing' | 'running' | 'succeeded' | 'failed';

export interface PajubenQuickRun {
  nodeId: string;
  /** 引擎回包后的任务号；`null` 表示还在起手阶段。 */
  runId: string | null;
  status: QuickRunStatus;
  percent: number;
  statusText: string;
  startedAt: number;
  /** 失败原因或提示语；成功时为 null。 */
  notice: string | null;
  videoPath: string;
  episode: number;
}

interface QuickRunStore {
  runs: Record<string, PajubenQuickRun>;
  start: (input: { nodeId: string; videoPath: string; episode: number; statusText: string }) => void;
  setStage: (nodeId: string, statusText: string) => void;
  bindRunId: (nodeId: string, runId: string) => void;
  patchProgress: (nodeId: string, patch: { percent?: number; statusText?: string }) => void;
  fail: (nodeId: string, notice: string) => void;
  /** 用户点「停止」：清掉这条登记，卡片回到可重新开始的状态。 */
  clear: (nodeId: string) => void;
}

export const usePajubenQuickRuns = create<QuickRunStore>((set, get) => ({
  runs: {},
  start: ({ nodeId, videoPath, episode, statusText }) => {
    ensureWatchers();
    set((state) => ({
      runs: {
        ...state.runs,
        [nodeId]: {
          nodeId,
          runId: null,
          status: 'preparing',
          percent: 0,
          statusText,
          startedAt: Date.now(),
          notice: null,
          videoPath,
          episode,
        },
      },
    }));
  },
  setStage: (nodeId, statusText) => {
    const run = get().runs[nodeId];
    if (!run) return;
    set((state) => ({ runs: { ...state.runs, [nodeId]: { ...run, statusText } } }));
  },
  bindRunId: (nodeId, runId) => {
    const run = get().runs[nodeId];
    if (!run) return;
    set((state) => ({
      runs: { ...state.runs, [nodeId]: { ...run, runId, status: 'running' } },
    }));
  },
  patchProgress: (nodeId, patch) => {
    const run = get().runs[nodeId];
    if (!run) return;
    set((state) => ({
      runs: {
        ...state.runs,
        [nodeId]: {
          ...run,
          ...(patch.percent != null ? { percent: Math.max(0, Math.min(100, patch.percent)) } : {}),
          ...(patch.statusText ? { statusText: patch.statusText } : {}),
        },
      },
    }));
  },
  fail: (nodeId, notice) => {
    const run = get().runs[nodeId];
    if (!run) return;
    set((state) => ({ runs: { ...state.runs, [nodeId]: { ...run, status: 'failed', notice } } }));
  },
  clear: (nodeId) => {
    set((state) => {
      const next = { ...state.runs };
      delete next[nodeId];
      return { runs: next };
    });
  },
}));

/** 该节点正在跑（含起手阶段）。 */
export function isQuickRunActive(run: PajubenQuickRun | undefined): boolean {
  return run?.status === 'preparing' || run?.status === 'running';
}

function nodeIdForRun(runId: string): string | null {
  const runs = usePajubenQuickRuns.getState().runs;
  const hit = Object.values(runs).find((run) => run.runId === runId);
  return hit?.nodeId ?? null;
}

/**
 * 起手阶段的 runId 归谁：只在「还没有 runId」的记录里找。
 *
 * 引擎在解释器/密钥/路径这类问题上会**先 finish 再回包**，这时事件里没有 runId，
 * 只能认领当前唯一一条起手中的记录；多条同时在起手的情况实际不会发生（起手是
 * 用户点击触发的，且卡片一次只发起一单）。
 */
function claimPendingRunId(): string | null {
  const runs = usePajubenQuickRuns.getState().runs;
  const pending = Object.values(runs)
    .filter((run) => run.runId === null && isQuickRunActive(run))
    .sort((a, b) => b.startedAt - a.startedAt);
  return pending[0]?.nodeId ?? null;
}

/** 扒完 → 落剧本节点。卡片关掉也必须执行，所以放在这里而不是组件里。 */
async function finishRun(nodeId: string, success: boolean, message: string): Promise<void> {
  const store = usePajubenQuickRuns.getState();
  const run = store.runs[nodeId];
  if (!run) return;
  if (!success) {
    store.fail(nodeId, message);
    return;
  }
  try {
    const script = await readPajubenScript({ target: run.videoPath, episode: run.episode });
    if (isAudioInputRejected(script)) {
      store.fail(
        nodeId,
        i18n.t(
          'pajuben.quickAudioUnsupported',
          '所选模型或渠道没有接收到视频音频，无法生成完整台词剧本。请改用支持音频输入/视频理解的模型后重试。',
        ),
      );
      return;
    }
    const canvas = useCanvasStore.getState();
    const scriptNodeId = canvas.addNode(
      CANVAS_NODE_TYPES.textAnnotation,
      canvas.findNodePosition(nodeId, SCRIPT_NODE_WIDTH, SCRIPT_NODE_HEIGHT),
      {
        displayName: i18n.t('pajuben.quickNodeName', '第 {{n}} 集 剧本', { n: run.episode }),
        content: script,
      },
      { width: SCRIPT_NODE_WIDTH, height: SCRIPT_NODE_HEIGHT },
    );
    // 挂回来源视频：画布上多扒几条时，一眼看得出这份稿子从哪条片子来。
    canvas.addEdge(nodeId, scriptNodeId);
    usePajubenQuickRuns.setState((state) => {
      const current = state.runs[nodeId];
      if (!current) return state;
      return {
        runs: { ...state.runs, [nodeId]: { ...current, status: 'succeeded', percent: 100, statusText: '', notice: null } },
      };
    });
  } catch (error) {
    store.fail(nodeId, error instanceof Error ? error.message : String(error));
  }
}

/**
 * 某些 OpenAI 兼容中转会静默丢弃 `input_audio`，模型返回一段「请上传音频」的说明文字，
 * 进程却正常退出 —— 这不是可用剧本，不能当成功结果落到画布。
 */
function isAudioInputRejected(script: string): boolean {
  const normalized = script.replace(/\s+/g, '');
  return [/未收到.*音频/, /没有.*音频/, /未提供.*音频/, /请补充.*音频/, /无法.*(?:台词|听写|转写)/].some(
    (pattern) => pattern.test(normalized),
  );
}

let watchersInstalled = false;

/** 常驻事件监听：只装一次，与卡片是否挂载无关。 */
function ensureWatchers(): void {
  if (watchersInstalled) return;
  watchersInstalled = true;

  void onPajubenLog((payload) => {
    const nodeId = nodeIdForRun(payload.runId);
    if (nodeId) usePajubenQuickRuns.getState().patchProgress(nodeId, { statusText: payload.line });
  });

  void onPajubenProgress((payload) => {
    const nodeId = nodeIdForRun(payload.runId);
    if (!nodeId) return;
    if (payload.kind === 'overall') {
      const total = payload.total ?? 0;
      if (total > 0) {
        usePajubenQuickRuns
          .getState()
          .patchProgress(nodeId, { percent: Math.round(((payload.done ?? 0) / total) * 100) });
      }
      return;
    }
    usePajubenQuickRuns.getState().patchProgress(nodeId, {
      ...(payload.kind === 'episode' && typeof payload.percent === 'number'
        ? { percent: payload.percent }
        : {}),
      ...(payload.text ? { statusText: payload.text } : {}),
    });
  });

  void onPajubenFinish((payload) => {
    const nodeId = nodeIdForRun(payload.runId) ?? claimPendingRunId();
    if (!nodeId) return;
    void finishRun(nodeId, payload.success, payload.message);
  });
}
