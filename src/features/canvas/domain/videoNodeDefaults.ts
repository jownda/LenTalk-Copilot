import type { VideoModelDefinition } from '@/features/canvas/models';

/**
 * 新建 AI 视频节点时, 「上次使用」配置无效情况下的兜底值。
 * 与历史默认保持一致(此前节点固定以 16:9 / 720p 创建)。
 */
export const DEFAULT_VIDEO_NODE_ASPECT_RATIO = '16:9';
export const DEFAULT_VIDEO_NODE_RESOLUTION = '720p';

/**
 * 把任意秒数落到模型支持的档位上。
 *
 * 平台的时长枚举分两种：连续档（4,5,6…15）和离散档（4,5,6,8,10,12,15,20,25,30）。
 * 离散档的中间值平台会直接拒，所以取最近合法档，不做简单夹取。
 */
export function snapVideoDurationOption(options: number[], seconds: number): number {
  if (options.length === 0) return seconds;
  const minimum = options[0];
  const maximum = options[options.length - 1];
  const clamped = Math.max(minimum, Math.min(maximum, Math.round(seconds)));
  const contiguous = options.every((value, index) => index === 0 || value === options[index - 1] + 1);
  if (contiguous) return clamped;
  return options.reduce((best, value) => (Math.abs(value - clamped) < Math.abs(best - clamped) ? value : best));
}

/**
 * 新建节点 / 切换模型时的视频时长。
 *
 * - **长镜头模型（声明 defaultDuration = 30）**：直接按 30 秒起始。可灵 v4 这类模型
 *   的能力就是长镜头，沿用上次的 5s 等于把它藏起来；这是「新模型先按 30 秒默认」那条
 *   策略在 UI 上的落点。
 * - 其它模型：沿用「上次使用」的时长，但要落在该模型的合法档位里 —— 离散档位（如
 *   4/5/6/8/10/12/15/20/25/30）拖到 17 秒会被平台直接拒，所以吸附到最近合法档。
 * - 记忆值缺失或非法时，退到模型默认值 / 首个合法档。
 */
export function resolveVideoNodeDuration(
  model: VideoModelDefinition | undefined,
  remembered: number | null | undefined,
): number | undefined {
  if (!model) return undefined;
  const options = model.durationOptions ?? [];
  const policyDefault = model.defaultDuration;
  if (policyDefault !== undefined && policyDefault >= 30 && (options.length === 0 || options.includes(policyDefault))) {
    return policyDefault;
  }
  if (options.length === 0) return undefined;
  const raw = Number(remembered);
  const value = Number.isFinite(raw) && raw > 0 ? raw : (policyDefault ?? options[0]);
  return snapVideoDurationOption(options, value);
}

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
  remembered: RememberedVideoNodeParams,
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
  fallbackModelId: string,
): string {
  if (rememberedModelId && isModelAvailable(rememberedModelId)) {
    return rememberedModelId;
  }
  return fallbackModelId;
}
