import type {
  AudioModelDefinition,
  AudioModelKind,
  ImageModelDefinition,
  ImageModelRuntimeContext,
  ModelProviderDefinition,
  ResolutionOption,
  VideoModelDefinition,
} from './types';
import {
  buildCustomModelId,
  buildCustomProviderId,
  isAudioModelName,
  isVideoGenerationModelName,
  useSettingsStore,
} from '@/stores/settingsStore';
import { isWindowsDesktopRuntime } from '@/platform/runtime';
import { createPointsOnlyPricing } from '@/features/canvas/pricing';
import { resolveVideoModelProfile } from './videoProfiles';
import { resolveImageModelResolutionOptions } from './imageModelCapabilities';
import { isRjmVideoApiBaseUrl } from '@/commands/videoApi';
import {
  isZzdhProvider,
  resolveZzdhAudioKind,
  resolveZzdhResolutionTier,
  resolveZzdhVideoDurationRange,
  ZZDH_ASPECT_RATIOS,
  ZZDH_VIDEO_DURATION_OPTIONS,
} from '@/commands/zzdhApi';
import { WAN_CLI_PROVIDER_ID, wanCliProvider, wanCliVideoModels } from './wanCli';

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

/**
 * 不使用 API Key 的平台: 本地 CLI(即梦 / 万相)靠可执行文件与各自的登录态工作,
 * 「密钥」页里没有可填的密钥。
 *
 * 图片模型选择器默认按"是否填过密钥"过滤平台, 必须把这类平台排除在过滤之外,
 * 否则它们的模型永远不会出现在列表里(视频侧不过滤, 所以没暴露这个问题)。
 */
const API_KEYLESS_PROVIDER_IDS: ReadonlySet<string> = new Set([
  JIMENG_CLI_PROVIDER_ID,
  WAN_CLI_PROVIDER_ID,
]);

export function isApiKeylessProvider(providerId: string): boolean {
  return API_KEYLESS_PROVIDER_IDS.has(providerId);
}
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
  // 即梦 CLI 在 Windows 上同样有原生制品(见 jimeng_cli.rs 的路径探测), 与视频侧一致放开。
  const jimengCliModels = buildJimengCliImageModels();
  if (isWindowsDesktopRuntime()) {
    const available = [...buildCustomImageModels(), ...jimengCliModels];
    return available.length > 0 ? available : [WINDOWS_UNCONFIGURED_IMAGE_MODEL];
  }
  return [...imageModels, ...jimengCliModels, ...buildCustomImageModels()];
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

  // 即梦 CLI 图片模型只出现在 listImageModels() 里, 不参与 imageModelMap 的构建 ——
  // 少了这一步, 重新打开工程时节点上的即梦模型会被兜底成内置模型(档位/画幅全错)。
  const jimengCli = buildJimengCliImageModels().find((model) => model.id === resolvedModelId);
  if (jimengCli) {
    return jimengCli;
  }

  // 超清任务不是下拉里的可选项, 但必须有定义: 否则记账会按内置模型估价。
  if (isJimengCliImageUpscaleModel(resolvedModelId)) {
    return JIMENG_CLI_IMAGE_UPSCALE_MODEL;
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

// 超分模型只服务“超分”入口，不进入普通视频生成下拉。
function isVideoUpscaleModelName(model: string): boolean {
  return model.trim().toLowerCase() === 'aliyun-video-superres';
}

export function listVideoModels(): VideoModelDefinition[] {
  const customVideoModels: VideoModelDefinition[] = useSettingsStore.getState().customApis.flatMap((api) =>
    Array.from(new Set([
      ...api.videoModels.filter((model) => !isVideoUpscaleModelName(model)),
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
        || api.baseUrl.trim().toLowerCase().includes('api.7tai.cc')
        || api.id.trim().toLowerCase() === 'wgspai'
        || api.baseUrl.trim().toLowerCase().includes('api.wgspai.cn');
      const isZhiniao = api.id.trim().toLowerCase() === 'zhiniao'
        || api.baseUrl.trim().toLowerCase().includes('cuai.token6688.com')
        || api.baseUrl.trim().toLowerCase().includes('api.tokengo.love');
      const binghuoOptions = isBinghuo ? resolveBinghuoVideoOptions(model) : undefined;
      const zhiniaoOptions = isZhiniao ? resolveZhiniaoVideoOptions(model) : undefined;
      const sub2ApiDuration = normalizedModel === 'seedance2.5'
        ? 30
        : normalizedModel === 'seedance2.0'
          ? 15
          : undefined;
      const isSub2ApiSeedance = isSub2Api && sub2ApiDuration !== undefined;
      // 字子动画: 档位写在模型名里(zddh-Minimax-h3-480p / doubao-seedance-2-4k),
      // UI 只提供该档位一个选项; 档位不在模型名里时按文档给 720p/1080p 两档。
      const zzdhTier = isZzdh ? resolveZzdhResolutionTier(model) : null;
      const zzdhDurationRange = isZzdh ? resolveZzdhVideoDurationRange(model) : null;
      const zzdhDurationOptions = isZzdh
        ? (zzdhDurationRange
          ? Array.from(
            { length: zzdhDurationRange.max - zzdhDurationRange.min + 1 },
            (_, index) => zzdhDurationRange.min + index,
          )
          : ZZDH_VIDEO_DURATION_OPTIONS)
        : undefined;
      const resolutionValues = isSub2ApiSeedance
        ? normalizedModel === 'seedance2.5'
          ? ['480p', '720p']
          : ['480p', '720p', '1080p', '4k']
        : isZzdh
          ? (zzdhTier ? [zzdhTier] : ['720p', '1080p'])
          : (zhiniaoOptions?.resolutionValues.length
            ? zhiniaoOptions.resolutionValues
            : binghuoOptions?.resolutionValues);
      // 字子动画画幅枚举只有 16:9 / 9:16 / 1:1(官方文档), 不要放 21:9 等超纲值。
      const aspectRatios = isSub2ApiSeedance
        ? ['16:9', '9:16']
        : isZzdh
          ? [...ZZDH_ASPECT_RATIOS]
          : (zhiniaoOptions?.aspectRatios ?? binghuoOptions?.aspectRatios ?? CUSTOM_ASPECT_RATIOS);
      const durationOptions = sub2ApiDuration !== undefined
        ? [sub2ApiDuration]
        : (zhiniaoOptions?.durationOptions
          ?? binghuoOptions?.durationOptions
          ?? zzdhDurationOptions
          ?? Array.from({ length: 30 }, (_, index) => index + 1));
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
        defaultDuration: sub2ApiDuration
          ?? (zhiniaoOptions
            ? (zhiniaoOptions.durationOptions.includes(5) ? 5 : zhiniaoOptions.durationOptions[0])
            : undefined)
          ?? binghuoOptions?.durationOptions[0]
          ?? 5,
        ...(resolutionValues ? {
          resolutions: resolutionValues.map((value) => ({
            value,
            label: value.toUpperCase(),
          })),
          defaultResolution: resolutionValues.includes('720p') ? '720p' : resolutionValues[0],
        } : {}),
          pricing: resolveCustomVideoPricing(api.name, api.baseUrl, model, isBinghuo),
        profileId: profile.id,
        profileStatus: profile.status,
        profileLabel: profile.protocolLabel,
        profileUnavailableReason: profile.unavailableReason,
      };
    })
  );

  return [...customVideoModels, ...buildJimengCliVideoModels(), ...wanCliVideoModels];
}

export function getVideoModel(modelId: string): VideoModelDefinition | undefined {
  return listVideoModels().find((model) => model.id === modelId);
}

export function getDefaultVideoModelId(): string {
  return listVideoModels()[0]?.id ?? '';
}

/**
 * 音频生成模型(语音合成 / 音效 / 音乐)。
 *
 * 之前 `audioModels` 只是个配置分桶(`buildCustomImageModels` 里把它排除掉),
 * 没有任何运行期消费方 —— 这里把它变成真正的模型定义, 供音频节点下拉使用。
 * 字子动画按模型名判定端点(见 resolveZzdhAudioKind), 其它平台默认走 speech。
 *
 * 定价: 平台对音频按字符用量计费(quota_type=0 / model_ratio), 没有可按次展示的
 * 固定价, 因此不提供 pricing —— 界面上不显示价格, 而不是显示一个错误数字。
 */
function buildCustomAudioModels(): AudioModelDefinition[] {
  return useSettingsStore.getState().customApis.flatMap((api) =>
    Array.from(new Set([
      ...(api.audioModels ?? []),
      ...api.models.filter(isAudioModelName),
    ])).map((model) => {
      const modelId = buildCustomModelId(api.id, model);
      const isZzdh = isZzdhProvider(api.id, api.baseUrl);
      const audioKind: AudioModelKind = isZzdh
        ? (resolveZzdhAudioKind(model) ?? 'speech')
        : 'speech';
      return {
        id: modelId,
        mediaType: 'audio' as const,
        displayName: `${api.name} · ${model}`,
        providerId: buildCustomProviderId(api.id),
        description: `${api.name} · ${model}`,
        expectedDurationMs: audioKind === 'music' ? 180000 : 45000,
        audioKind,
        ...(audioKind === 'speech' ? {
          formatOptions: ['mp3', 'wav', 'pcm', 'opus'],
          defaultFormat: 'mp3',
        } : {}),
        ...(audioKind === 'music' ? {
          musicLengthOptionsMs: [15000, 30000, 60000, 120000],
          defaultMusicLengthMs: 30000,
        } : {}),
      };
    })
  );
}

export function listAudioModels(): AudioModelDefinition[] {
  return buildCustomAudioModels();
}

export function getAudioModel(modelId: string): AudioModelDefinition | undefined {
  return listAudioModels().find((model) => model.id === modelId);
}

export function getDefaultAudioModelId(): string {
  return listAudioModels()[0]?.id ?? '';
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

/** 即梦图片的画幅枚举(取自 CLI `--help`), 注意不含自定义平台用的 5:4 / 4:5。 */
const JIMENG_CLI_IMAGE_ASPECT_RATIOS = [
  '21:9',
  '16:9',
  '3:2',
  '4:3',
  '1:1',
  '3:4',
  '2:3',
  '9:16',
] as const;

/**
 * 即梦图片各版本支持的档位 —— `resolution_type` 会被 CLI 严格校验:
 * 3.x 只有 1K/2K, 4.x~5.0 是 2K/4K, 5.0Pro 多一档 1.5K。
 */
function resolveJimengCliImageResolutions(version: string): string[] {
  if (version === '3.0' || version === '3.1') {
    return ['1k', '2k'];
  }
  if (version === '5.0Pro') {
    return ['1.5k', '2k', '4k'];
  }
  return ['2k', '4k'];
}

/**
 * 即梦 CLI 的图片模型。它走本机 CLI, 没有 API Key, 所以不出现在「密钥」页的
 * 平台列表里 —— 图片模型选择器要靠 {@link isApiKeylessProvider} 放行。
 *
 * 有没有参考图决定走 `text2image` 还是 `image2image`, 由 Rust 侧按参考图数量决定。
 */
function buildJimengCliImageModels(): ImageModelDefinition[] {
  const models = [
    { version: '5.0Pro', label: '图片 5.0 Pro' },
    { version: '5.0', label: '图片 5.0' },
    { version: '4.7', label: '图片 4.7' },
    { version: '4.6', label: '图片 4.6' },
    { version: '4.5', label: '图片 4.5' },
    { version: '4.1', label: '图片 4.1' },
    { version: '4.0', label: '图片 4.0' },
    { version: '3.1', label: '图片 3.1' },
    { version: '3.0', label: '图片 3.0' },
  ] as const;

  return models.map(({ version, label }) => {
    const tiers = resolveJimengCliImageResolutions(version);
    return {
      id: `${JIMENG_CLI_PROVIDER_ID}/image-${version}`,
      mediaType: 'image' as const,
      displayName: `即梦 CLI · ${label}`,
      providerId: JIMENG_CLI_PROVIDER_ID,
      description: `即梦 CLI · ${label}`,
      eta: '1min',
      expectedDurationMs: 120000,
      defaultAspectRatio: '1:1',
      defaultResolution: (tiers[0] ?? '2k').toUpperCase(),
      aspectRatios: JIMENG_CLI_IMAGE_ASPECT_RATIOS.map((value) => ({ value, label: value })),
      resolutions: tiers.map((value) => ({ value: value.toUpperCase(), label: value.toUpperCase() })),
      resolveRequest: ({ referenceImageCount }) => ({
        requestModel: `${JIMENG_CLI_PROVIDER_ID}/image-${version}`,
        modeLabel: referenceImageCount > 0 ? '编辑模式' : '生成模式',
      }),
    };
  });
}

/**
 * 即梦 CLI 图片超清(image_upscale)的内部模型 id。
 *
 * 它不是可选项 —— 图片模型下拉里出现的始终是 `jimeng-cli/image-{版本}`, 这个 id
 * 只用来让「超清」这次任务在统一 job 通道和用量记账里能被识别出来。因此它必须
 * 能被 {@link getImageModel} 解析出定义(否则记账会兜底成内置模型、算出假费用),
 * 但**不能**出现在 {@link listImageModels} 里。
 */
export const JIMENG_CLI_IMAGE_UPSCALE_MODEL_ID = 'jimeng-cli/upscale';

const JIMENG_CLI_IMAGE_UPSCALE_RESOLUTIONS = ['2k', '4k', '8k'] as const;

const JIMENG_CLI_IMAGE_UPSCALE_MODEL: ImageModelDefinition = {
  id: JIMENG_CLI_IMAGE_UPSCALE_MODEL_ID,
  mediaType: 'image',
  displayName: '即梦 CLI · 图片超清',
  providerId: JIMENG_CLI_PROVIDER_ID,
  description: '把已有图片放大到 2K / 4K / 8K',
  eta: '1min',
  expectedDurationMs: 90000,
  defaultAspectRatio: '1:1',
  defaultResolution: JIMENG_CLI_IMAGE_UPSCALE_RESOLUTIONS[0].toUpperCase(),
  aspectRatios: JIMENG_CLI_IMAGE_ASPECT_RATIOS.map((value) => ({ value, label: value })),
  resolutions: JIMENG_CLI_IMAGE_UPSCALE_RESOLUTIONS.map((value) => ({
    value: value.toUpperCase(),
    label: value.toUpperCase(),
  })),
  resolveRequest: () => ({
    requestModel: JIMENG_CLI_IMAGE_UPSCALE_MODEL_ID,
    modeLabel: '超清',
  }),
};

/** 判断一个模型 id 是不是即梦图片超清任务。 */
export function isJimengCliImageUpscaleModel(modelId: string): boolean {
  return modelId === JIMENG_CLI_IMAGE_UPSCALE_MODEL_ID;
}

/**
 * 「图片高清」可选的模型。
 *
 * 目前只有即梦 CLI 超清(本机 CLI, 无需密钥)。**中转站的超分模型暂不并入** ——
 * 用户明确要求先不放进来; 需要放开时在这里追加即可,「更换模型」按钮已经把
 * 入口与列表渲染都留好了。
 */
export function listImageUpscaleModels(): ImageModelDefinition[] {
  return [JIMENG_CLI_IMAGE_UPSCALE_MODEL];
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
  if (providerId === WAN_CLI_PROVIDER_ID) return wanCliProvider;
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

/**
 * 知鸟 AI(TokenGo)视频模型的档位清单, 直接取自平台 GET /v1/logical-models 的
 * param_schema(enum)。平台会按模型校验 duration / resolution, 传枚举外的值会被拒,
 * 所以这里按模型族给出真实可选值, 而不是统一放开 1~30 秒。
 */
function resolveZhiniaoVideoOptions(model: string): {
  aspectRatios: string[];
  durationOptions: number[];
  resolutionValues: string[];
} {
  const normalized = model.trim().toLowerCase();
  const DEFAULT_ASPECTS = ['16:9', '9:16', '1:1'];
  if (normalized.includes('seedance')) {
    return {
      aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
      durationOptions: [4, 5, 6, 8, 10, 12, 15, 20, 25, 30],
      resolutionValues: ['480p', '720p', '1080p'],
    };
  }
  if (normalized.startsWith('veo')) {
    return {
      aspectRatios: ['16:9', '9:16'],
      durationOptions: [8],
      resolutionValues: ['720p', '1080p'],
    };
  }
  if (normalized.startsWith('sora')) {
    return {
      aspectRatios: ['16:9', '9:16'],
      durationOptions: [4, 8, 12],
      resolutionValues: [],
    };
  }
  if (normalized.startsWith('kling')) {
    return {
      aspectRatios: ['16:9', '9:16', '1:1'],
      durationOptions: [5, 10, 15],
      resolutionValues: ['720p', '1080p', '4k'],
    };
  }
  if (normalized.startsWith('minimax')) {
    return {
      aspectRatios: ['16:9', '9:16', '21:9', '4:3', '1:1', '3:4'],
      durationOptions: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      resolutionValues: ['768p', '2k'],
    };
  }
  if (normalized.startsWith('wan-3') || normalized.startsWith('wan3')) {
    return {
      aspectRatios: ['16:9', '9:16', '3:4', '4:3', '1:1'],
      durationOptions: [5, 6, 7, 8, 9, 10, 12, 15, 20, 25, 30],
      resolutionValues: ['480p', '720p', '1080p'],
    };
  }
  if (normalized.startsWith('pixverse') || normalized.startsWith('vidu') || normalized.startsWith('happyhorse')) {
    return { aspectRatios: DEFAULT_ASPECTS, durationOptions: [5, 8, 10, 15], resolutionValues: ['720p', '1080p'] };
  }
  return {
    aspectRatios: DEFAULT_ASPECTS,
    durationOptions: [5, 8, 10, 15, 20, 30],
    resolutionValues: ['720p', '1080p'],
  };
}

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
    : normalized.includes('2k')
      ? '2K'
      : normalized.includes('1080p')
      ? '1080P'
      : normalized.includes('768p')
        ? '768P'
        : normalized.includes('480p')
          ? '480P'
          : '720P';
  return { aspectRatios, durationOptions, resolutionValues: [resolution] };
}

/**
 * 字子动画视频按秒计价(来源: 平台 /api/pricing, `price_display_unit=second`)。
 * 2026-09-12 同步: H3 五档 + Kling Omni + doubao-seedance 全系 + wan3.0 + happyhorse。
 */
const ZZDH_VIDEO_PRICE_PER_SECOND: Record<string, number> = {
  'zzdh-minimax-h3-480p': 0.06,
  'zzdh-minimax-h3-720p': 0.09,
  'zzdh-minimax-h3-1080p': 0.12,
  'zzdh-minimax-h3-2k': 0.16,
  'zzdh-minimax-h3-4k': 0.24,
  'happyhorse-1.0-t2v-720p': 1.08,
  'happyhorse-1.0-t2v-1080p': 1.92,
  'happyhorse-1.0-i2v-720p': 1.08,
  'happyhorse-1.0-i2v-1080p': 1.92,
  'happyhorse-1.0-r2v-720p': 1.08,
  'happyhorse-1.0-r2v-1080p': 1.92,
  'happyhorse-1.0-video-edit-720p': 1.08,
  'happyhorse-1.0-video-edit-1080p': 1.92,
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
  // 2026-09-11 价格表同步
  'sd2.5-720p-ch2': { type: 'per-second', amount: 0.69 },
  'sd2.5-720p-ch3': { type: 'per-second', amount: 0.59 },
  'rd2.5-480p': { type: 'per-second', amount: 0.425 },
  'rd2.5-720p': { type: 'per-second', amount: 0.95 },
  'rd2.0-480p': { type: 'per-second', amount: 0.28 },
  'rd2.0-480pfast': { type: 'per-second', amount: 0.3 },
  'rd2.0-720p': { type: 'per-second', amount: 0.58 },
  'rd2.0-1080p': { type: 'per-second', amount: 1.39 },
  'sdvip720p': { type: 'per-second', amount: 0.39 },
  'sdvip1080p': { type: 'per-second', amount: 0.68 },
  'sdvip4k': { type: 'per-second', amount: 3.85 },
  'sd2.5-480p': { type: 'per-second', amount: 0.58 },
  'sd2.5-720p': { type: 'per-second', amount: 0.85 },
  'sd2.5-1080p': { type: 'per-second', amount: 1.59 },
  'sd2.5-backup': { type: 'per-second', amount: 0.65 },
  'sd2.5-cf-720p': { type: 'per-second', amount: 0.46 },
  'sd2.5-480p-ch1': { type: 'per-second', amount: 0.42 },
  'wan3.0-480p': { type: 'per-second', amount: 0.25 },
  'wan3.0-720p': { type: 'per-second', amount: 0.4 },
  'wan3.0-1080p': { type: 'per-second', amount: 0.7 },
  'tj-wan3.0-1080p': { type: 'per-second', amount: 0.36 },
  'tj-wan3.0-720p': { type: 'per-second', amount: 0.31 },
  'tj-wan3-720p': { type: 'per-second', amount: 0.31 },
  'minimax-h3-pro-768p': { type: 'per-second', amount: 0.05 },
  'minimax-h3-pro-2k': { type: 'per-run', amount: 0.25 },
  'minimax-h3-4k': { type: 'per-second', amount: 0.36 },
  'hailuo-h3-2k': { type: 'per-run', amount: 2.8 },
  'sp2.5-720p': { type: 'per-run', amount: 4.9, durationThreshold: 15, thresholdAmount: 6.1 },
  'sp2.5-720p-15s': { type: 'per-run', amount: 4.9 },
  'sp2.5-720p-30s': { type: 'per-run', amount: 6.1 },
  'sd2.5-720p-ch1': { type: 'per-run', amount: 2.5 },
  'tj-sp2.5': { type: 'per-run', amount: 3.85 },
  'sd2-vip720p': { type: 'per-run', amount: 3.55 },
  'quanneng2.0': { type: 'per-run', amount: 5.9 },
  'quanneng2.0-9tu': { type: 'per-run', amount: 1.58 },
  'b-quannengship2.0': { type: 'per-run', amount: 6.35 },
  'sdquan-2-miao': { type: 'per-second', amount: 0.38 },
  'sd2-福利': { type: 'per-run', amount: 0.35 },
  'sd2-fast福利': { type: 'per-run', amount: 2.85 },
  'sd2.0-720p': { type: 'per-run', amount: 1.5 },
  'sd2.0-480p': { type: 'per-run', amount: 1.99 },
  'sd2.0-720p-fast': { type: 'per-run', amount: 4.65 },
  'kuaile1.1': { type: 'per-second', amount: 0.18 },
  'wanneng1.1': { type: 'per-second', amount: 0.18 },
  'me-kuaile1.0': { type: 'per-run', amount: 1.85 },
  'kuaile1.0': { type: 'per-run', amount: 1.85 },
  'grok-imagine-video': { type: 'per-run', amount: 1.5 },
  'grok-imagine-video-1.5-preview': { type: 'per-run', amount: 1.5 },
  'bh2.0-720p': { type: 'per-second', amount: 0.49 },
  'bh2.0-480p': { type: 'per-second', amount: 0.39 },
  'bh2.0-1080p': { type: 'per-second', amount: 0.69 },
  'bh2.0-fast-480p': { type: 'per-second', amount: 0.29 },
  'bh2.0-fast-720p': { type: 'per-second', amount: 0.34 },
  'bh2.0-mini-480p': { type: 'per-second', amount: 0.28 },
  'bh2.0-mini-720p': { type: 'per-second', amount: 0.38 },
  'bh2.0-4k': { type: 'per-second', amount: 3.68 },
  'bh2.04k': { type: 'per-second', amount: 3.68 },
};

/** 炳火图片模型按张计价（全分辨率同价，2026-09-11 价格表）。 */
const BINGHUO_IMAGE_PRICES: Record<string, number> = {
  'image4k': 0.18,
  'image2k4k': 0.11,
  'image2-high': 0.13,
  'image2': 0.035,
  'gemini-3-pro-image-preview': 0.15,
  'gemini-3.1-flash-image-preview': 0.15,
  'by-image1k': 0.03,
  'by-image2k4k': 0.15,
  'cf-image4k': 0.06,
};

/** 字子动画图片按次计价(来源: 平台 /api/pricing, `price_display_unit=call`)。 */
const ZZDH_IMAGE_PRICES: Record<string, number> = {
  'qwen-image-2.0': 0.24,
  'qwen-image-2.0-pro': 0.6,
  'qwen-image-3.0': 0.21,
  'qwen-image-3.0-pro-1k': 0.3,
  'qwen-image-3.0-pro-2k': 0.6,
  'qwen-image-edit-max': 0.6,
  'qwen-image-max': 0.6,
  'z-image-turbo': 0.12,
  'zimage': 1,
  'wan2.6-image': 0.24,
  'wan2.7-image': 0.24,
};

function resolveCustomImagePricing(apiId: string, apiBaseUrl: string, model: string) {
  const officialAmount = resolveOfficialModelPrice(
    useSettingsStore.getState().customApis.find((api) => api.id === apiId)?.modelPrices,
    model,
  );
  if (officialAmount != null) {
    return { quote: () => ({ amount: officialAmount, currency: 'CNY' as const }) };
  }
  const normalizedApiId = apiId.trim().toLowerCase();
  const isBinghuo = normalizedApiId === 'binghuo'
    || apiBaseUrl.trim().toLowerCase().includes('api.7tai.cc');
  if (isBinghuo) {
    const amount = BINGHUO_IMAGE_PRICES[model.trim().toLowerCase()];
    if (amount == null) return undefined;
    return {
      quote: () => ({ amount, currency: 'CNY' as const }),
    };
  }
  if (isZzdhProvider('', apiBaseUrl)) {
    const amount = ZZDH_IMAGE_PRICES[model.trim().toLowerCase()];
    if (amount == null) return undefined;
    return {
      quote: () => ({ amount, currency: 'CNY' as const }),
    };
  }
  return undefined;
}

function resolveCustomVideoPricing(apiName: string, apiBaseUrl: string, model: string, isBinghuo: boolean) {
  const customApi = useSettingsStore.getState().customApis.find((api) =>
    api.name.trim().toLowerCase() === apiName.trim().toLowerCase()
    || api.baseUrl.trim().toLowerCase() === apiBaseUrl.trim().toLowerCase());
  const officialAmount = resolveOfficialModelPrice(customApi?.modelPrices, model);
  if (officialAmount != null) {
    return {
      quote: () => ({ amount: officialAmount, currency: 'CNY' as const }),
    };
  }
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
  if (normalizedApiName === '字子动画' || normalizedApiName === '字字动画' || isZzdhProvider('', apiBaseUrl)) {
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

function resolveOfficialModelPrice(
  prices: Record<string, number> | undefined,
  model: string,
): number | undefined {
  if (!prices) return undefined;
  const normalizedModel = model.trim().toLowerCase();
  const entry = Object.entries(prices).find(([modelId]) => modelId.trim().toLowerCase() === normalizedModel);
  if (!entry || !Number.isFinite(entry[1]) || entry[1] < 0) return undefined;
  return entry[1];
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
          return !isVideoGenerationModelName(model)
            && !isAudioModelName(model)
            && !api.videoModels.some((videoModel) => videoModel.trim().toLowerCase() === normalizedModel)
            && !(api.audioModels ?? []).some((audioModel) => audioModel.trim().toLowerCase() === normalizedModel);
        })
        .map((model) => {
        const modelId = buildCustomModelId(api.id, model);
        // 字子动画图片: 官方画幅枚举同为 16:9 / 9:16 / 1:1, 参考图字段 reference_images。
        const isZzdhImageApi = isZzdhProvider(api.id, api.baseUrl);
        const imageAspectRatios = isZzdhImageApi ? [...ZZDH_ASPECT_RATIOS] : CUSTOM_ASPECT_RATIOS;
        // 档位常被平台写进模型名(qwen-image-3.0-pro-1k / flux-2k / sd-4k), 这类模型
        // 只能按名字里那一档请求; 读不到档位时才放开 1K/2K/4K 全档位。
        const resolutions = resolveImageModelResolutionOptions(model);
        return {
          id: modelId,
          mediaType: 'image',
          displayName: `${api.name} · ${model}`,
          providerId: buildCustomProviderId(api.id),
          description: `${api.name} · ${model}`,
          eta: '1min',
          expectedDurationMs: 60000,
          defaultAspectRatio: '1:1',
          defaultResolution: resolutions[0]?.value ?? '1K',
          aspectRatios: imageAspectRatios.map((value) => ({ value, label: value })),
          resolutions,
          ...(resolveCustomImagePricing(api.id, api.baseUrl, model)
            ? { pricing: resolveCustomImagePricing(api.id, api.baseUrl, model) }
            : {}),
          resolveRequest: ({ referenceImageCount }) => ({
            requestModel: modelId,
            modeLabel: referenceImageCount > 0 ? '编辑模式' : '生成模式',
          }),
        };
      })
    );
}
