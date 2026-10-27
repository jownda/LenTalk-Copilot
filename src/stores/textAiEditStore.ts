import { create } from "zustand";
import i18n from "@/i18n";
import { useCanvasStore } from "@/stores/canvasStore";
import { runTextAiEdit, type AiEditResult } from "@/features/canvas/application/textAiEdit";

/**
 * 文本节点「AI 修改」的后台任务。
 *
 * 存在这里而不是弹窗的 useState 里，是为了让任务**脱离弹窗生命周期**：
 * 关掉窗口请求照样跑，重新点「AI 修改」能接着看进度，直到用户点「应用修改」才结束。
 *
 * 一个节点同时只保留一个任务（再点一次会覆盖上一个），key 用 nodeId。
 */

export type TextAiEditStatus = "running" | "done" | "error";

export interface TextAiEditTask {
  nodeId: string;
  status: TextAiEditStatus;
  instruction: string;
  /** 生成时用的模型（展示用，便于回来时知道是哪次） */
  modelLabel: string;
  result: AiEditResult | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

interface TextAiEditStore {
  task: TextAiEditTask | null;
  start: (params: {
    nodeId: string;
    text: string;
    instruction: string;
    preserveMarkdown: boolean;
    baseUrl: string;
    apiKey: string;
    model: string;
    modelLabel: string;
  }) => Promise<void>;
  /** 把结果写进节点内容，并清掉任务（这就是「应用修改」） */
  apply: (nodeId: string) => boolean;
  /** 放弃这次任务（不写节点内容） */
  clear: (nodeId?: string) => void;
}

export const useTextAiEditStore = create<TextAiEditStore>((set, get) => ({
  task: null,

  start: async (params) => {
    const startedAt = Date.now();
    set({
      task: {
        nodeId: params.nodeId,
        status: "running",
        instruction: params.instruction,
        modelLabel: params.modelLabel,
        result: null,
        error: null,
        startedAt,
        finishedAt: null,
      },
    });
    try {
      const result = await runTextAiEdit({
        baseUrl: params.baseUrl,
        apiKey: params.apiKey,
        model: params.model,
        text: params.text,
        instruction: params.instruction,
        preserveMarkdown: params.preserveMarkdown,
        emptyResultMessage: i18n.t("textNodeEdit.aiEmptyResult"),
      });
      // 期间用户可能又发起了别的任务（或换了节点）：只认当前这条。
      const current = get().task;
      if (!current || current.startedAt !== startedAt || current.nodeId !== params.nodeId) {
        return;
      }
      set({
        task: { ...current, status: "done", result, finishedAt: Date.now() },
      });
    } catch (caught) {
      const current = get().task;
      if (!current || current.startedAt !== startedAt || current.nodeId !== params.nodeId) {
        return;
      }
      set({
        task: {
          ...current,
          status: "error",
          error: caught instanceof Error ? caught.message : String(caught),
          finishedAt: Date.now(),
        },
      });
    }
  },

  apply: (nodeId) => {
    const task = get().task;
    if (!task || task.nodeId !== nodeId || !task.result) {
      return false;
    }
    useCanvasStore.getState().updateNodeData(nodeId, { content: task.result.text });
    set({ task: null });
    return true;
  },

  clear: (nodeId) => {
    const task = get().task;
    if (!task) return;
    if (nodeId && task.nodeId !== nodeId) return;
    set({ task: null });
  },
}));
