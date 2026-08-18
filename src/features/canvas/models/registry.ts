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
import { createFixedResolutionPricing, createPointsOnlyPricing } from '@/features/canvas/pricing';
import { resolveVideoModelProfile } from './videoProfiles';

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

export const DEFAULT_IMAGE_MODEL_ID = 'kie/nano-banana-2';
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

const imageModelAliasMap = new Map<string, string>([
  ['gemini-3.1-flash', 'ppio/gemini-3.1-flash'],
  ['gemini-3.1-flash-edit', 'ppio/gemini-3.1-flash'],
]);

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

  return imageModelMap.get(resolvedModelId) ?? imageModelMap.get(DEFAULT_IMAGE_MODEL_ID)!;
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
      const isMinimaxH3 = model.trim().toLowerCase() === 'minimax-h3';
      const profile = resolveVideoModelProfile(model);
      return {
        id: buildCustomModelId(api.id, model),
        mediaType: 'video' as const,
        displayName: `${api.name} · ${model}`,
        providerId: buildCustomProviderId(api.id),
        description: `${api.name} · ${model}`,
        expectedDurationMs: 180000,
        aspectRatios: CUSTOM_ASPECT_RATIOS.map((value) => ({ value, label: value })),
        defaultAspectRatio: '16:9',
        durationOptions: isMinimaxH3
          ? Array.from({ length: 12 }, (_, index) => index + 4)
          : Array.from({ length: 30 }, (_, index) => index + 1),
        defaultDuration: 5,
        ...(isMinimaxH3 ? {
          resolutions: [
            { value: '768P', label: '768P' },
            { value: '2K', label: '2K' },
          ],
          defaultResolution: '2K',
        } : {}),
        pricing: resolveCustomVideoPricing(api.name, model),
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

const WGSPAI_GPT_IMAGE_2_2K_PRICING = createFixedResolutionPricing({
  currency: 'CNY',
  standardRates: {
    '1K': 0.1,
    '2K': 0.1,
    '4K': 0.1,
  },
});

function resolveCustomImagePricing(apiName: string, model: string) {
  if (apiName.trim().toLowerCase() === 'wgspai' && model.trim().toLowerCase() === 'gpt-image-2-2k') {
    return WGSPAI_GPT_IMAGE_2_2K_PRICING;
  }
  return undefined;
}

function resolveCustomVideoPricing(apiName: string, model: string) {
  if (apiName.trim().toLowerCase() !== 'wgspai') return undefined;
  const normalized = model.trim().toLowerCase();
  const perSecondRates: Record<string, number> = {
    'seedance-v2-720p-fast': 0.17,
    'seedance-v2-720p': 0.3,
  };
  if (perSecondRates[normalized] != null) {
    return {
      quote: ({ extraParams }: { extraParams?: Record<string, unknown> }) => ({
        amount: perSecondRates[normalized] * Math.max(1, Number(extraParams?.duration) || 5),
        currency: 'CNY' as const,
      }),
    };
  }
  if (normalized === 'grok-imagine-video-6s') {
    return createFixedResolutionPricing({ currency: 'CNY', standardRates: { video: 0.1 } });
  }
  if (normalized === 'minimax-h3') {
    return createFixedResolutionPricing({ currency: 'CNY', standardRates: { video: 1.5 } });
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
          pricing: resolveCustomImagePricing(api.name, model),
          resolveRequest: ({ referenceImageCount }) => ({
            requestModel: modelId,
            modeLabel: referenceImageCount > 0 ? '编辑模式' : '生成模式',
          }),
        };
      })
    );
}
