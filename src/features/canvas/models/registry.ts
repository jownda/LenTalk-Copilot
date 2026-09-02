import type {
  ImageModelDefinition,
  ImageModelRuntimeContext,
  ModelProviderDefinition,
  ResolutionOption,
  VideoModelDefinition,
} from './types';
import {
  buildCustomModelId,
  buildCustomProviderId,
  isVideoGenerationModelName,
  useSettingsStore,
} from '@/stores/settingsStore';
import { isWindowsDesktopRuntime } from '@/platform/runtime';
import { createPointsOnlyPricing } from '@/features/canvas/pricing';
import { resolveVideoModelProfile } from './videoProfiles';
import { isRjmVideoApiBaseUrl } from '@/commands/videoApi';

const providerModules = import.meta.glob<{ provider: ModelProviderDefinition }>(
  './providers/*.ts',
  { eager: true }
);
const modelModules = import.meta.glob<{ imageModel: ImageModelDefinition }>(
  './image/**/*.ts',
  { eager: true }
);

const providers: ModelProviderDefinition[] = Object.values(providerModules)
  .map((module) => module.provider)
  .filter((provider): provider is ModelProviderDefinition => Boolean(provider))
  .sort((a, b) => a.id.localeCompare(b.id));

const imageModels: ImageModelDefinition[] = Object.values(modelModules)
  .map((module) => module.imageModel)
  .filter((model): model is ImageModelDefinition => Boolean(model))
  .sort((a, b) => a.id.localeCompare(b.id));

const providerMap = new Map<string, ModelProviderDefinition>(
  providers.map((provider) => [provider.id, provider])
);
const imageModelMap = new Map<string, ImageModelDefinition>(
  imageModels.map((model) => [model.id, model])
);

export const DEFAULT_IMAGE_MODEL_ID = 'builtin:default';
export const JIMENG_CLI_PROVIDER_ID = 'jimeng-cli';
const JIMENG_CLI_PROVIDER: ModelProviderDefinition = {
  id: JIMENG_CLI_PROVIDER_ID,
  name: '即梦 CLI',
  label: '即梦 CLI',
};
const JIMENG_CLI_VIDEO_POINTS_PER_SECOND: Record<string, number> = {
  'seedance2.0_vip': 14,
  'seedance2.5': 26,
  'seedance2.0mini': 6,
  'seedance2.0fast_vip': 6,
  'seedance2.0fast': 2,
  'seedance2.0': 3,
};
const WINDOWS_UNCONFIGURED_IMAGE_MODEL_ID = 'custom:unconfigured/configure-api';
const WINDOWS_UNCONFIGURED_IMAGE_MODEL: ImageModelDefinition = {
  id: WINDOWS_UNCONFIGURED_IMAGE_MODEL_ID,
  mediaType: 'image',
  displayName: '请先配置自定义 API',
  providerId: 'custom:unconfigured',
  description: 'Windows 桌面端仅支持自定义 OpenAI 兼容 API',
  eta: '1min',
  expectedDurationMs: 60000,
  defaultAspectRatio: '1:1',
  defaultResolution: '1K',
  aspectRatios: [{ value: '1:1', label: '1:1' }],
  resolutions: [{ value: '1K', label: '1K' }],
  resolveRequest: () => ({
    requestModel: WINDOWS_UNCONFIGURED_IMAGE_MODEL_ID,
    modeLabel: '需要配置',
  }),
};

const imageModelAliasMap = new Map<string, string>([]);

export function listImageModels(): ImageModelDefinition[] {
  if (isWindowsDesktopRuntime()) {
    const customModels = buildCustomImageModels();
    return customModels.length > 0 ? customModels : [WINDOWS_UNCONFIGURED_IMAGE_MODEL];
  }
  return [...imageModels, ...buildCustomImageModels()];
}

export function listModelProviders(): ModelProviderDefinition[] {
  if (isWindowsDesktopRuntime()) {
    return buildCustomProviders();
  }
  return [...providers, ...buildCustomProviders()];
}

export function getImageModel(modelId: string): ImageModelDefinition {
  const resolvedModelId = imageModelAliasMap.get(modelId) ?? modelId;
  const custom = buildCustomImageModels().find((model) => model.id === resolvedModelId);
  if (custom) {
    return custom;
  }

  if (isWindowsDesktopRuntime()) {
    return buildCustomImageModels()[0] ?? WINDOWS_UNCONFIGURED_IMAGE_MODEL;
  }

  // 旧节点可能引用已移除平台的模型(如 grsai/kie/ppio/fal): 找不到时兜底到
  // 第一个可用模型(自定义平台优先), 绝不允许返回 undefined 导致界面崩溃。
  return imageModelMap.get(resolvedModelId)
    ?? imageModelMap.get(DEFAULT_IMAGE_MODEL_ID)
    ?? listImageModels()[0]
    ?? WINDOWS_UNCONFIGURED_IMAGE_MODEL;
}

export function getDefaultImageModelId(): string {
  return listImageModels()[0]?.id ?? DEFAULT_IMAGE_MODEL_ID;
}

export function listVideoModels(): VideoModelDefinition[] {
  const customVideoModels: VideoModelDefinition[] = useSettingsStore.getState().customApis.flatMap((api) =>
    Array.from(new Set([
      ...api.videoModels,
      ...api.models.filter(isVideoGenerationModelName),
    ])).map((model) => {
      const modelId = buildCustomModelId(api.id, model);
      const profile = resolveVideoModelProfile(modelId, api.baseUrl);
      const normalizedModel = model.trim().toLowerCase();
      const isZzdh = api.id.trim().toLowerCase() === 'zizidonghua'
        || api.baseUrl.trim().toLowerCase().includes('zizidonghua.com');
      const isSub2Api = api.id.trim().toLowerCase() === 'sub2api-video'
        || isRjmVideoApiBaseUrl(api.baseUrl);
      const isBinghuo = api.id.trim().toLowerCase() === 'binghuo'
        || api.baseUrl.trim().toLowerCase().includes('api.7tai.cc');
      const binghuoOptions = isBinghuo ? resolveBinghuoVideoOptions(model) : undefined;
      const sub2ApiDuration = normalizedModel === 'seedance2.5'
        ? 30
        : normalizedModel === 'seedance2.0'
          ? 15
          : undefined;
      const isSub2ApiSeedance = isSub2Api && sub2ApiDuration !== undefined;
      const modelResolution = model.trim().match(/(?:^|[-_])(480p|720p|1080p|2k)(?:[-_]|$)/i)?.[1]?.toLowerCase();
      const resolutionValues = isSub2ApiSeedance
        ? normalizedModel === 'seedance2.5'
          ? ['480p', '720p']
          : ['480p', '720p', '1080p', '4k']
        : isZzdh
          ? (modelResolution ? [modelResolution] : ['720p', '1080p'])
          : binghuoOptions?.resolutionValues;
      const aspectRatios = isSub2ApiSeedance
        ? ['16:9', '9:16']
        : (binghuoOptions?.aspectRatios ?? CUSTOM_ASPECT_RATIOS);
      const durationOptions = sub2ApiDuration !== undefined
        ? [sub2ApiDuration]
        : (binghuoOptions?.durationOptions ?? Array.from({ length: 30 }, (_, index) => index + 1));
      const displayModelName = normalizedModel === 'seedance2.5'
        ? 'Seedance 2.5'
        : normalizedModel === 'seedance2.0'
          ? 'Seedance 2.0'
          : model;
      return {
        id: modelId,
        mediaType: 'video' as const,
        displayName: `${api.name} · ${displayModelName}`,
        providerId: buildCustomProviderId(api.id),
        description: `${api.name} · ${displayModelName}`,
        expectedDurationMs: 180000,
        aspectRatios: aspectRatios.map((value) => ({ value, label: value })),
        defaultAspectRatio: '16:9',
        durationOptions,
        defaultDuration: sub2ApiDuration ?? binghuoOptions?.durationOptions[0] ?? 5,
        ...(resolutionValues ? {
          resolutions: resolutionValues.map((value) => ({
            value,
            label: value.toUpperCase(),
          })),
          defaultResolution: resolutionValues.includes('720p') ? '720p' : resolutionValues[0],
        } : {}),
          pricing: resolveCustomVideoPricing(api.name, model, isBinghuo),
        profileId: profile.id,
        profileStatus: profile.status,
        profileLabel: profile.protocolLabel,
        profileUnavailableReason: profile.unavailableReason,
      };
    })
  );

  return [...customVideoModels, ...buildJimengCliVideoModels()];
}

export function getVideoModel(modelId: string): VideoModelDefinition | undefined {
  return listVideoModels().find((model) => model.id === modelId);
}

export function getDefaultVideoModelId(): string {
  return listVideoModels()[0]?.id ?? '';
}

function buildJimengCliVideoModels(): VideoModelDefinition[] {
  const models = [
    { version: 'seedance2.0fast', label: 'Seedance 2.0 Fast', maxDuration: 15, resolutions: ['720p'] },
    { version: 'seedance2.0', label: 'Seedance 2.0', maxDuration: 15, resolutions: ['720p'] },
    { version: 'seedance2.0fast_vip', label: 'Seedance 2.0 Fast VIP', maxDuration: 15, resolutions: ['720p'] },
    { version: 'seedance2.0_vip', label: 'Seedance 2.0 VIP', maxDuration: 15, resolutions: ['720p', '1080p', '4k'] },
    { version: 'seedance2.0mini', label: 'Seedance 2.0 Mini', maxDuration: 15, resolutions: ['720p'] },
    { version: 'seedance2.5', label: 'Seedance 2.5', maxDuration: 30, resolutions: ['480p', '720p', '1080p'] },
  ] as const;

  return models.map(({ version, label, maxDuration, resolutions }) => ({
    id: `${JIMENG_CLI_PROVIDER_ID}/${version}`,
    mediaType: 'video' as const,
    displayName: `即梦 CLI · ${label}`,
    providerId: JIMENG_CLI_PROVIDER_ID,
    description: `即梦 CLI · ${label}`,
    expectedDurationMs: 300000,
    aspectRatios: CUSTOM_ASPECT_RATIOS.map((value) => ({ value, label: value })),
    defaultAspectRatio: '16:9',
    durationOptions: Array.from({ length: maxDuration - 3 }, (_, index) => index + 4),
    defaultDuration: 5,
    resolutions: resolutions.map((value) => ({ value, label: value.toUpperCase() })),
    defaultResolution: resolutions[0],
    pricing: createPointsOnlyPricing(({ extraParams }) =>
      (JIMENG_CLI_VIDEO_POINTS_PER_SECOND[version] ?? 0) * Math.max(1, Number(extraParams?.duration) || 5)
    ),
  }));
}

export function resolveImageModelResolutions(
  model: ImageModelDefinition,
  context: ImageModelRuntimeContext = {}
): ResolutionOption[] {
  const resolvedOptions = model.resolveResolutions?.(context);
  return resolvedOptions && resolvedOptions.length > 0 ? resolvedOptions : model.resolutions;
}

export function resolveImageModelResolution(
  model: ImageModelDefinition,
  requestedResolution: string | undefined,
  context: ImageModelRuntimeContext = {}
): ResolutionOption {
  const resolutionOptions = resolveImageModelResolutions(model, context);

  return (
    (requestedResolution
      ? resolutionOptions.find((item) => item.value === requestedResolution)
      : undefined) ??
    resolutionOptions.find((item) => item.value === model.defaultResolution) ??
    resolutionOptions[0] ??
    model.resolutions[0]
  );
}

export function getModelProvider(providerId: string): ModelProviderDefinition {
  if (providerId === JIMENG_CLI_PROVIDER_ID) {
    return JIMENG_CLI_PROVIDER;
  }
  const builtin = providerMap.get(providerId);
  if (builtin) {
    return builtin;
  }
  const custom = buildCustomProviders().find((provider) => provider.id === providerId);
  return (
    custom ?? {
      id: 'unknown',
      name: 'Unknown Provider',
      label: 'Unknown',
    }
  );
}

// ---------------------------------------------------------------------------
// 自定义平台(OpenAI 兼容):从设置里的 customApis 动态生成 provider 与模型
// ---------------------------------------------------------------------------

const CUSTOM_ASPECT_RATIOS = [
  '1:1',
  '16:9',
  '9:16',
  '21:9',
  '5:4',
  '4:5',
  '3:2',
  '2:3',
  '4:3',
  '3:4',
] as const;

const CUSTOM_RESOLUTIONS: ResolutionOption[] = [
  { value: '1K', label: '1K' },
  { value: '2K', label: '2K' },
  { value: '4K', label: '4K' },
];

function resolveBinghuoVideoOptions(model: string): {
  aspectRatios: string[];
  durationOptions: number[];
  resolutionValues: string[];
} {
  const normalized = model.trim().toLowerCase();
  const aspectRatios = normalized === 'minimax-h3-pro-768p'
    ? ['16:9', '9:16']
    : ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'];
  let durationOptions = Array.from({ length: 12 }, (_, index) => index + 4);
  if (normalized === 'sd2.0-720p' || normalized === 'sd2.0-720p-fast') {
    durationOptions = [5, 10, 15];
  } else if (normalized === 'tj-sp2.5' || normalized === 'sd2.5-720p-ch1') {
    durationOptions = [30];
  } else if (normalized === 'sp2.5-720p-30s') {
    durationOptions = Array.from({ length: 15 }, (_, index) => index + 16);
  } else if (normalized === 'sp2.5-720p') {
    durationOptions = Array.from({ length: 27 }, (_, index) => index + 4);
  } else if (normalized === 'sp2.5-720p-15s') {
    durationOptions = Array.from({ length: 12 }, (_, index) => index + 4);
  } else if (normalized === 'sd2-vip720p' || normalized === 'quanneng2.0' || normalized === 'sdquan-2-miao' || normalized === 'quanneng2.0-9tu') {
    durationOptions = [15];
  } else if (normalized === 'wan3.0-480p' || normalized === 'wan3.0-720p' || normalized === 'wan3.0-1080p') {
    durationOptions = [...Array.from({ length: 11 }, (_, index) => index + 5), 20, 25, 30];
  } else if (['sd2.5-480p', 'sd2.5-1080p', 'sd2.5-backup', 'sd2.5-720p-ch2'].includes(normalized)) {
    durationOptions = Array.from({ length: 26 }, (_, index) => index + 4);
  } else if (normalized.includes('sd2.5') || normalized.includes('rd2.5') || normalized.includes('gz-sd2.5')) {
    durationOptions = Array.from({ length: 27 }, (_, index) => index + 4);
  } else if (normalized === 'minimax-h3-pro-2k' || normalized === 'hailuo-h3-2k') {
    durationOptions = normalized === 'hailuo-h3-2k' ? [6, 10] : Array.from({ length: 12 }, (_, index) => index + 4);
  } else if (normalized === 'grok-imagine-video' || normalized === 'grok-imagine-video-1.5-preview') {
    durationOptions = Array.from({ length: 15 }, (_, index) => index + 1);
  }
  const resolution = normalized.includes('4k')
    ? '4K'
    : normalized.includes('1080p')
      ? '1080P'
      : normalized.includes('768p')
        ? '768P'
        : normalized.includes('480p')
          ? '480P'
          : '720P';
  return { aspectRatios, durationOptions, resolutionValues: [resolution] };
}

const ZZDH_VIDEO_PRICE_PER_SECOND: Record<string, number> = {
  'zzdh-minimax-h3-480p': 0.06,
  'zzdh-minimax-h3-720p': 0.09,
  'zzdh-minimax-h3-1080p': 0.12,
  'zzdh-minimax-h3-2k': 0.16,
  'kling-v3-omni': 0.8,
  'kling-3.0-omni-720p-noref-mute': 0.51,
  'kling-3.0-omni-720p-noref-audio': 0.68,
  'kling-3.0-omni-720p-ref-mute': 0.77,
  'kling-3.0-omni-720p-ref-audio': 0.94,
  'kling-3.0-omni-1080p-noref-mute': 0.68,
  'kling-3.0-omni-1080p-noref-audio': 0.85,
  'kling-3.0-omni-1080p-ref-mute': 1.19,
  'kling-3.0-omni-1080p-ref-audio': 1.02,
  'doubao-seedance-2-480p': 0.49,
  'doubao-seedance-2-720p': 1.09,
  'doubao-seedance-2-1080p': 2.7,
  'doubao-seedance-2-4k': 5.56,
  'doubao-seedance-2-0-fast-480p': 0.4,
  'doubao-seedance-2-0-fast-720p': 0.88,
  'doubao-seedance-2-0-mini-480p': 0.25,
  'doubao-seedance-2-0-mini-720p': 0.55,
  'doubao-seedance-2-5-480p': 0.84,
  'doubao-seedance-2-5-720p': 1.81,
  'doubao-seedance-2-video-480p': 0.3,
  'doubao-seedance-2-video-720p': 0.67,
  'doubao-seedance-2-video-1080p': 1.66,
  'doubao-seedance-2-video-4k': 3.42,
  'doubao-seedance-2-0-fast-video-480p': 0.24,
  'doubao-seedance-2-0-fast-video-720p': 0.52,
  'doubao-seedance-2-0-mini-video-480p': 0.15,
  'doubao-seedance-2-0-mini-video-720p': 0.33,
  'doubao-seedance-2-5-video-480p': 0.51,
  'doubao-seedance-2-5-video-720p': 1.09,
  'doubao-seedance-2-video-优惠版-720p': 0.6,
  'doubao-seedance-2-video-优惠版-1080p': 1.2,
};

type BinghuoVideoPrice =
  | { type: 'per-second'; amount: number }
  | { type: 'per-run'; amount: number; durationThreshold?: number; thresholdAmount?: number };

const BINGHUO_VIDEO_PRICES: Record<string, BinghuoVideoPrice> = {
  'gz-sd480p': { type: 'per-second', amount: 0.28 },
  'gz-sd720p': { type: 'per-second', amount: 0.5 },
  'gz-sd1080p': { type: 'per-second', amount: 1.15 },
  'gz-sd4k': { type: 'per-second', amount: 2.2 },
  'gz-sd2.5-480p': { type: 'per-second', amount: 0.46 },
  'gz-sd2.5-720p': { type: 'per-second', amount: 0.92 },
  'gz-sd2.5-1080p': { type: 'per-second', amount: 2.2 },
  'sd2.5-720p-ch2': { type: 'per-second', amount: 0.55 },
  'rd2.5-480p': { type: 'per-second', amount: 0.425 },
  'rd2.5-720p': { type: 'per-second', amount: 0.58 },
  'rd2.0-480p': { type: 'per-second', amount: 0.485 },
  'rd2.0-720p': { type: 'per-second', amount: 0.58 },
  'rd2.0-1080p': { type: 'per-second', amount: 1.39 },
  'sdvip720p': { type: 'per-second', amount: 0.39 },
  'sdvip1080p': { type: 'per-second', amount: 0.68 },
  'sdvip4k': { type: 'per-second', amount: 3.85 },
  'sd2.5-480p': { type: 'per-second', amount: 0.4 },
  'sd2.5-720p': { type: 'per-second', amount: 0.85 },
  'wan3.0-480p': { type: 'per-second', amount: 0.25 },
  'wan3.0-720p': { type: 'per-second', amount: 0.4 },
  'wan3.0-1080p': { type: 'per-second', amount: 0.7 },
  'tj-wan3.0-1080p': { type: 'per-second', amount: 0.36 },
  'tj-wan3.0-720p': { type: 'per-second', amount: 0.29 },
  'tj-wan3-720p': { type: 'per-second', amount: 0.29 },
  'minimax-h3-pro-768p': { type: 'per-second', amount: 0.05 },
  'minimax-h3-pro-2k': { type: 'per-run', amount: 2.5 },
  'sp2.5-720p': { type: 'per-run', amount: 4.9, durationThreshold: 15, thresholdAmount: 6.1 },
  'sd2.5-720p-ch1': { type: 'per-run', amount: 2.68 },
  'tj-sp2.5': { type: 'per-run', amount: 3.85 },
  'sd2-vip720p': { type: 'per-run', amount: 3.55 },
  'quanneng2.0': { type: 'per-run', amount: 5.8 },
  'sdquan-2-miao': { type: 'per-run', amount: 6.5 },
  'sd2-福利': { type: 'per-run', amount: 3.25 },
  'sd2-fast福利': { type: 'per-run', amount: 2.85 },
  'sd2.0-720p': { type: 'per-run', amount: 1.5 },
};

function resolveCustomVideoPricing(apiName: string, model: string, isBinghuo: boolean) {
  const normalizedApiName = apiName.trim().toLowerCase();
  const normalized = model.trim().toLowerCase();
  if (isBinghuo) {
    const price = BINGHUO_VIDEO_PRICES[normalized];
    if (price) {
      return {
        quote: ({ extraParams }: { extraParams?: Record<string, unknown> }) => {
          const duration = Math.max(1, Number(extraParams?.duration) || 5);
          const amount = price.type === 'per-second'
            ? price.amount * duration
            : price.durationThreshold != null && duration > price.durationThreshold
              ? price.thresholdAmount ?? price.amount
              : price.amount;
          return { amount, currency: 'CNY' as const };
        },
      };
    }
  }
  if (normalizedApiName === '字子动画' || normalizedApiName === '字字动画' || normalizedApiName === 'zizidonghua') {
    const perSecond = ZZDH_VIDEO_PRICE_PER_SECOND[normalized];
    if (perSecond != null) {
      return {
        quote: ({ extraParams }: { extraParams?: Record<string, unknown> }) => ({
          amount: perSecond * Math.max(1, Number(extraParams?.duration) || 5),
          currency: 'CNY' as const,
        }),
      };
    }
    return undefined;
  }
  return undefined;
}

function buildCustomProviders(): ModelProviderDefinition[] {
  return useSettingsStore.getState().customApis.map((api) => ({
    id: buildCustomProviderId(api.id),
    name: api.name,
    label: api.name,
  }));
}

function buildCustomImageModels(): ImageModelDefinition[] {
  return useSettingsStore
    .getState()
    .customApis.flatMap((api) =>
      api.models
        .filter((model) => {
          const normalizedModel = model.trim().toLowerCase();
          return !isVideoGenerationModelName(model) && !api.videoModels.some(
            (videoModel) => videoModel.trim().toLowerCase() === normalizedModel
          );
        })
        .map((model) => {
        const modelId = buildCustomModelId(api.id, model);
        return {
          id: modelId,
          mediaType: 'image',
          displayName: `${api.name} · ${model}`,
          providerId: buildCustomProviderId(api.id),
          description: `${api.name} · ${model}`,
          eta: '1min',
          expectedDurationMs: 60000,
          defaultAspectRatio: '1:1',
          defaultResolution: '1K',
          aspectRatios: CUSTOM_ASPECT_RATIOS.map((value) => ({ value, label: value })),
          resolutions: CUSTOM_RESOLUTIONS,
          resolveRequest: ({ referenceImageCount }) => ({
            requestModel: modelId,
            modeLabel: referenceImageCount > 0 ? '编辑模式' : '生成模式',
          }),
        };
      })
    );
}
