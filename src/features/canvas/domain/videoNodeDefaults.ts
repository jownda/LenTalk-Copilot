import type { VideoModelDefinition } from '@/features/canvas/models';

/**
 * 新建 AI 视频节点时, 「上次使用」配置无效情况下的兜底值。
 * 与历史默认保持一致(此前节点固定以 16:9 / 720p 创建)。
 */
export const DEFAULT_VIDEO_NODE_ASPECT_RATIO = '16:9';
export const DEFAULT_VIDEO_NODE_RESOLUTION = '720p';

export interface RememberedVideoNodeParams {
  aspectRatio: string | null;
  resolution: string | null;
}

export interface ResolvedVideoNodeParams {
  aspectRatio: string;
  resolution: string;
}

/**
 * 解析新建 AI 视频节点的初始宽高比 / 分辨率。
 *
 * 记忆值只在当前模型声明的能力范围内生效: 用户上次用的是 9:16 / 1080p,
 * 换成只支持 16:9 的模型后这些值就不合法了。宽高比在 VideoGenNode 里是
 * 直接绑定 `data.aspectRatio` 的下拉框, 不会自愈(分辨率那条链有自愈, 但仍
 * 统一在这里归一, 避免把已知无效值写进节点数据)。
 */
export function resolveVideoNodeParams(
  model: VideoModelDefinition | undefined,
  remembered: RememberedVideoNodeParams
): ResolvedVideoNodeParams {
  const aspectRatioValues = model?.aspectRatios.map((option) => option.value) ?? [];
  const aspectRatio =
    remembered.aspectRatio && aspectRatioValues.includes(remembered.aspectRatio)
      ? remembered.aspectRatio
      : (model?.defaultAspectRatio ?? DEFAULT_VIDEO_NODE_ASPECT_RATIO);

  const resolutionValues = model?.resolutions?.map((option) => option.value) ?? [];
  const resolution =
    remembered.resolution && resolutionValues.includes(remembered.resolution)
      ? remembered.resolution
      : (model?.defaultResolution ?? resolutionValues[0] ?? DEFAULT_VIDEO_NODE_RESOLUTION);

  return { aspectRatio, resolution };
}

/**
 * 解析新建 AI 视频节点的初始模型 id。
 * 记忆的模型可能已被删除(比如用户移除了对应平台), 此时回退默认模型。
 */
export function resolveVideoNodeModelId(
  rememberedModelId: string | null,
  isModelAvailable: (modelId: string) => boolean,
  fallbackModelId: string
): string {
  if (rememberedModelId && isModelAvailable(rememberedModelId)) {
    return rememberedModelId;
  }
  return fallbackModelId;
}
