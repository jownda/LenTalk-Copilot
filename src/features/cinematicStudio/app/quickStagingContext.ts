/**
 * 提示词工作室极简节点：把「场景站位 / 场景角色候选」里的语义带进「生成并创建视频」。
 *
 * 节点上的选择器只保存电影资产 id（来自画布素材库的 `cinematic-*` 镜像），
 * 而描述、表演母版、声音锁、随身道具和站位的空间文字都只存在于电影工程的资产记录里。
 * 这里把两者合成一份模型可读的上下文，让极简链路也能像高级工作台那样
 * 「按故事梗概引用」这些资产，而不是只丢一堆图片进去。
 */
import type { Asset, SceneStaging } from '../shared-types';
import type { Locale } from './i18n';
import type {
  QuickPromptAsset,
  QuickPromptCharacterProfile,
  QuickPromptStaging,
} from './providers/quickPromptAgent';

export interface QuickStagingContextInput {
  /** 电影工程的资产库：角色 / 地点 / 道具的唯一真源。 */
  assets: Asset[];
  /** 节点当前的场景站位（与高级编辑双向同步）。 */
  staging?: SceneStaging;
  locale?: Locale;
  /**
   * 已经排好序的图片参考（场景 + 角色）。
   * 道具会续在其后，并复用已经出现过的同一路径，保证 [imageN] 不重复、不错位。
   */
  imageSources?: readonly string[];
  /** 电影资产 id → 素材库镜像里的首张参考图路径。 */
  resolveImageSource?: (assetId: string) => string | undefined;
  /** 电影资产 id → 提示词里的 `@标签`，仅作为旧镜像数据的名称兜底。 */
  resolveAssetName?: (assetId: string) => string | undefined;
}

export interface QuickStagingContext {
  /** 场景站位的空间契约；没有任何内容时为 undefined。 */
  staging?: QuickPromptStaging;
  /** 角色候选的表演母版 / 声音锁 / 随身道具绑定。 */
  characterProfiles: QuickPromptCharacterProfile[];
  /** 道具资产（已带可用的 [imageN]）。 */
  props: QuickPromptAsset[];
  /** 需要追加到参考图列表的新图片（已去重，顺序与 props 的 referenceIndex 一一对应）。 */
  referenceImages: string[];
}

function text(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 中英双字段：中文界面读 *Zh，英文界面读英文字段，缺失时互相兜底。 */
function localized(zhValue: string | undefined, enValue: string | undefined, locale: Locale): string {
  return locale === 'zh'
    ? (text(zhValue) || text(enValue))
    : (text(enValue) || text(zhValue));
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

export function buildQuickStagingContext(input: QuickStagingContextInput): QuickStagingContext {
  const { assets, staging, locale = 'zh', resolveImageSource, resolveAssetName } = input;
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const imageSources = [...(input.imageSources ?? [])];
  const appendedImages: string[] = [];

  /** 工程资产名称是唯一的 canonical 名称；镜像名称只兼容旧数据。 */
  const nameOf = (assetId: string): string => {
    return text(byId.get(assetId)?.name) || resolveAssetName?.(assetId)?.trim() || assetId;
  };

  /** 复用已有图片序号，没有则续一个新序号（与最终参考图数组顺序一致）。 */
  const referenceIndexFor = (assetId: string): number | undefined => {
    const source = text(resolveImageSource?.(assetId));
    if (!source) return undefined;
    const existing = imageSources.indexOf(source);
    if (existing >= 0) return existing + 1;
    imageSources.push(source);
    appendedImages.push(source);
    return imageSources.length;
  };

  /** 道具默认信息：与高级工作台的道具行保持同一套语义（持有者 / 位置 / 用途 / 状态）。 */
  const renderPropDefaults = (asset: Asset): string => {
    if (asset.kind !== 'prop') return '';
    const holderId = asset.propHolderCharacterId?.trim();
    const holder = holderId ? nameOf(holderId) : '';
    const usage = localized(asset.propUsageZh, asset.propUsage, locale);
    const position = localized(asset.propPositionZh, asset.propPosition, locale);
    const state = localized(asset.propDefaultStateZh, asset.propDefaultState, locale);
    const zh = locale === 'zh';
    const parts: string[] = [];
    if (holder) parts.push(zh ? `由${holder}持有` : `held by ${holder}`);
    if (position) parts.push(zh ? `位置：${position}` : `kept at ${position}`);
    if (usage) parts.push(zh ? `用途：${usage}` : `used only for ${usage}`);
    if (state) parts.push(zh ? `状态：${state}` : `kept ${state}`);
    return parts.join(zh ? '，' : ', ');
  };

  const toPropAsset = (asset: Asset): QuickPromptAsset => {
    const description = [
      localized(asset.descriptionZh, asset.description, locale),
      renderPropDefaults(asset),
    ].filter(Boolean).join(locale === 'zh' ? '；' : '; ');
    return {
      id: asset.id,
      name: nameOf(asset.id),
      ...(description ? { description } : {}),
      mediaType: 'image',
      referenceIndex: referenceIndexFor(asset.id),
    };
  };

  const rosterIds = dedupe((staging?.characterRoster ?? []).filter((id) => byId.get(id)?.kind === 'character'));
  const orderIds = dedupe((staging?.characterOrder ?? []).filter((id) => rosterIds.includes(id)));

  const props: QuickPromptAsset[] = [];
  const collectedPropIds = new Set<string>();
  const characterProfiles: QuickPromptCharacterProfile[] = rosterIds.map((id) => {
    const asset = byId.get(id)!;
    const profile = asset.actingProfile;
    const actingMaster = localized(profile?.masterProfileZh, profile?.masterProfile, locale);
    const voiceLock = localized(profile?.voicePromptZh, profile?.voicePrompt, locale);
    // 随身道具：角色登记的道具 + 默认持有者指向该角色的道具。
    const attached = new Set(
      (asset.attachedPropIds ?? []).filter((propId) => byId.get(propId)?.kind === 'prop'),
    );
    for (const candidate of assets) {
      if (candidate.kind === 'prop' && candidate.propHolderCharacterId === id) attached.add(candidate.id);
    }
    const propIds = [...attached];
    for (const propId of propIds) {
      if (collectedPropIds.has(propId)) continue;
      collectedPropIds.add(propId);
      props.push(toPropAsset(byId.get(propId)!));
    }
    return {
      id,
      name: nameOf(id),
      ...(actingMaster ? { actingMaster } : {}),
      ...(voiceLock ? { voiceLock } : {}),
      ...(propIds.length ? { propIds } : {}),
    };
  });

  const locationAsset = staging?.locationAssetId ? byId.get(staging.locationAssetId) : undefined;
  const anchorDescription = text(staging?.anchorDescription);
  const spacing = text(staging?.spacing);
  const priorContext = text(staging?.priorContext);
  const hasStaging = Boolean(locationAsset || anchorDescription || spacing || priorContext || orderIds.length);
  const stagingContext: QuickPromptStaging | undefined = hasStaging
    ? {
      ...(locationAsset ? {
        locationId: locationAsset.id,
        locationName: nameOf(locationAsset.id),
        ...(localized(locationAsset.descriptionZh, locationAsset.description, locale)
          ? { locationDescription: localized(locationAsset.descriptionZh, locationAsset.description, locale) }
          : {}),
      } : {}),
      ...(anchorDescription ? { anchorDescription } : {}),
      ...(orderIds.length ? { characterOrderNames: orderIds.map(nameOf) } : {}),
      ...(spacing ? { spacing } : {}),
      ...(staging?.axisDirection ? { axisDirection: staging.axisDirection } : {}),
      ...(priorContext ? { priorContext } : {}),
    }
    : undefined;

  return {
    ...(stagingContext ? { staging: stagingContext } : {}),
    characterProfiles,
    props,
    referenceImages: appendedImages,
  };
}
