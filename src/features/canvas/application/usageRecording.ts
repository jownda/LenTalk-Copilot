// ---------------------------------------------------------------------------
// 生成结果记账: 每次 AI 生成(图片/视频)进入终态(成功/失败)时写一条用量记录。
// 记录 id 用 结果节点id + 时间戳 区分重试; 费用按模型定价估算(统一 CNY)。
// ---------------------------------------------------------------------------
import {
  appendUsageRecord,
  estimateUsageCost,
  type UsageLogRecord,
} from '@/commands/usageLog';
import { getImageModel, getVideoModel } from '@/features/canvas/models';
import { useProjectStore } from '@/stores/projectStore';
import { CURRENT_RUNTIME_SESSION_ID } from './generationErrorReport';

export interface RecordGenerationOutcomeParams {
  /** 结果节点 id(用于在日志中定位) */
  nodeId: string;
  kind: 'image' | 'video';
  providerId: string;
  /** 完整模型 id, 如 custom:wgspai/gpt-image-2-2k */
  modelId: string;
  size?: string;
  duration?: number;
  referenceCount?: number;
  status: 'succeeded' | 'failed';
  errorMessage?: string;
  durationMs?: number;
}

/** 生成进入终态时调用(成功/失败各一次, 由调用方保证每个任务只记一次)。 */
export function recordGenerationOutcome(params: RecordGenerationOutcomeParams): void {
  const model = params.kind === 'video'
    ? getVideoModel(params.modelId)
    : getImageModel(params.modelId);
  const cost = estimateUsageCost(model, {
    kind: params.kind,
    size: params.size ?? '1K',
    duration: params.duration ?? 0,
  });

  const createdAt = Date.now();
  const record: UsageLogRecord = {
    // 同节点重试会产生不同时间戳, 独立记账; 同一事件不会重复写入
    id: `gen-${params.nodeId}-${createdAt}`,
    createdAt,
    providerId: params.providerId,
    providerName: '',
    modelId: params.modelId,
    modelName: params.modelId.split('/').slice(1).join('/') || params.modelId,
    kind: params.kind,
    size: params.size ?? '',
    duration: params.duration ?? 0,
    referenceCount: params.referenceCount ?? 0,
    estimatedCost: params.status === 'succeeded' ? cost : 0,
    currency: 'CNY',
    status: params.status,
    errorMessage: params.errorMessage ?? '',
    durationMs: params.durationMs ?? 0,
    projectId: useProjectStore.getState().currentProjectId ?? '',
    sessionId: CURRENT_RUNTIME_SESSION_ID,
  };
  void appendUsageRecord(record);
}
