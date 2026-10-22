import { recommendedApis } from '@/features/settings/recommendedApis';

export type NodePriceKind = 'image' | 'video' | 'audio';

export interface NodePriceBadgeInfo {
  /** 节点右上角显示的简短文本（如「⚡0.01 ~ 0.17 / 张」）。 */
  label: string;
  /** hover 时显示的完整文本；与 label 一致即可。 */
  nativeLabel: string;
}

/**
 * 当当前选中的模型是「推荐平台 custom:<id>」，且该推荐平台登记了
 * `pricingRange.{image,video,audio}` 价格区间时，返回该区间字符串。
 * 否则返回 null（调用方继续走更精确的 `resolveModelPriceDisplay`）。
 *
 * 设计目的：grsai / fhl 等老链路模型在 registry 里自带精确 `pricing`，
 * `resolveModelPriceDisplay` 能算出精确价；但像「知鸟 AI」这类只填了
 * 平台级 `pricingRange` 的推荐平台，节点右上角过去永远空白——
 * 这里把同一份价格数据消费到节点上。
 */
export function resolveRecommendedApiPriceBadge(
  providerId: string | undefined,
  customApis: ReadonlyArray<{ id: string; baseUrl: string }> | undefined,
  kind: NodePriceKind,
): NodePriceBadgeInfo | null {
  if (!providerId) return null;
  const match = /^custom:(.+)$/.exec(providerId);
  if (!match) return null;
  const custom = customApis?.find((api) => api.id === match[1]);
  if (!custom) return null;
  const recommended = recommendedApis.find((api) => api.baseUrl === custom.baseUrl);
  const range = recommended?.pricingRange?.[kind];
  if (!range) return null;
  return { label: range, nativeLabel: range };
}