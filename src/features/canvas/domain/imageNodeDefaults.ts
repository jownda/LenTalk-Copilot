import type { ImageModelDefinition } from '@/features/canvas/models';
import { resolveImageModelResolutions } from '@/features/canvas/models';

import { AUTO_REQUEST_ASPECT_RATIO } from './canvasNodes';

/**
 * 新建 AI 图片节点时, 「上次使用」配置无效情况下的兜底值。
 * 与历史默认保持一致(此前节点固定以 2K / auto 宽高比创建)。
 */
export const DEFAULT_IMAGE_NODE_SIZE = '2K';
export const DEFAULT_IMAGE_NODE_ASPECT_RATIO = AUTO_REQUEST_ASPECT_RATIO;

export interface RememberedImageNodeParams {
  size: string | null;
  aspectRatio: string | null;
}

export interface ResolvedImageNodeParams {
  size: string;
  aspectRatio: string;
}

/**
 * 解析新建 AI 图片节点的初始分辨率 / 宽高比。
 *
 * 记忆值只在当前模型声明的能力范围内生效: 用户上次用的是 4K / 21:9,
 * 换成只支持 1K / 1:1 的模型后这些值就不合法了。宽高比在 ImageEditNode 里是
 * 直接绑定 `data.requestAspectRatio` 的选择器, 无效值不会自愈(只会让选中态
 * 回落到第一项), 所以统一在这里归一, 避免把已知无效值写进节点数据。
 *
 * `auto` 由 ModelParamsControls 无条件提供(交给模型决定画幅), 任何模型都合法,
 * 因此不受模型 aspectRatios 限制。
 *
 * 分辨率兜底优先沿用历史默认的 2K, 但必须落在模型档位内 —— 只出 1K 的模型
 * (模型名带 `-1k`) 拿到 2K 会被平台拒。因此 2K 不在档位内时退回该模型的首档。
 * 不用 `model.defaultResolution`: 那会改变「无记忆」时的既有行为(部分模型 1K/2K
 * 都支持但默认值是 1K)。写回节点后仍由 `resolveImageModelResolution` 按模型能力
 * 自愈, 与改动前一致。
 */
export function resolveImageNodeParams(
  model: ImageModelDefinition | undefined,
  remembered: RememberedImageNodeParams
): ResolvedImageNodeParams {
  const sizeValues = model ? resolveImageModelResolutions(model).map((option) => option.value) : [];
  const size =
    remembered.size && sizeValues.includes(remembered.size)
      ? remembered.size
      : sizeValues.includes(DEFAULT_IMAGE_NODE_SIZE)
        ? DEFAULT_IMAGE_NODE_SIZE
        : sizeValues[0] ?? DEFAULT_IMAGE_NODE_SIZE;

  const aspectRatioValues = model?.aspectRatios.map((option) => option.value) ?? [];
  const aspectRatio =
    remembered.aspectRatio
    && (remembered.aspectRatio === AUTO_REQUEST_ASPECT_RATIO
      || aspectRatioValues.includes(remembered.aspectRatio))
      ? remembered.aspectRatio
      : DEFAULT_IMAGE_NODE_ASPECT_RATIO;

  return { size, aspectRatio };
}

/**
 * 解析新建 AI 图片节点的初始模型 id。
 * 记忆的模型可能已被删除(比如用户移除了对应平台), 此时回退默认模型。
 * 是否「可用」由调用方判定(除模型存在外, 图片节点还要求对应平台已配置密钥)。
 */
export function resolveImageNodeModelId(
  rememberedModelId: string | null,
  isModelAvailable: (modelId: string) => boolean,
  fallbackModelId: string
): string {
  if (rememberedModelId && isModelAvailable(rememberedModelId)) {
    return rememberedModelId;
  }
  return fallbackModelId;
}
