import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  DEFAULT_GRSAI_CREDIT_TIER_ID,
  PRICE_DISPLAY_CURRENCY_MODES,
  type GrsaiCreditTierId,
  type PriceDisplayCurrencyMode,
} from '@/features/canvas/pricing/types';

export type UiRadiusPreset = 'compact' | 'default' | 'large';
export type ThemeTonePreset = 'neutral' | 'warm' | 'cool';
export type CanvasEdgeRoutingMode = 'spline' | 'orthogonal' | 'smartOrthogonal';
export type ProviderApiKeys = Record<string, string>;
export const DEFAULT_GRSAI_NANO_BANANA_PRO_MODEL = 'nano-banana-pro';
export const DEFAULT_JIMENG_CLI_EXECUTABLE = 'dreamina';

/** 即梦 CLI 是本地命令行工具，不使用 OpenAI 兼容平台的 API Key 配置。 */
export interface JimengCliSettings {
  executable: string;
}

/** 视频模型必须与图片模型分开注册，避免通用模型拉取结果污染图片节点。 */
export function isVideoGenerationModelName(model: string): boolean {
  return /seedance|minimax-h3|grok-imagine-video|(?:^|[-_])video(?:[-_]|$)|hailuo|kling|runway|(?:^|[-_])veo(?:[-_]|$)|(?:^|[-_])sora(?:[-_]|$)|pixverse|vidu|luma/i.test(
    model.trim()
  );
}

/** 自定义 AI 平台(OpenAI 兼容),参考 Infinite Canvas 的 API 设置写法 */
export interface CustomApiProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  /** 视频生成模型：与图像模型分开，避免在图片节点中误选。 */
  videoModels: string[];
  createdAt: number;
  /** 请求模式: sync=同步等待平台返回图片; async=提交后轮询任务状态 */
  requestMode: 'sync' | 'async';
  /** 接口协议: images=/v1/images/generations; responses=/v1/responses(gpt-image 中转平台常用) */
  protocol: 'images' | 'responses';
  /** Images 协议的参考图字段: 大多数中转平台用 image, 原生 GPT Image 用 input_image。 */
  referenceImageField: 'image' | 'input_image';
}

export type CustomApiRequestMode = CustomApiProvider['requestMode'];
export type CustomApiProtocol = CustomApiProvider['protocol'];
export type CustomApiReferenceImageField = CustomApiProvider['referenceImageField'];

/** 自定义平台在模型/密钥体系里的 provider id 前缀 */
export const CUSTOM_API_PROVIDER_PREFIX = 'custom:';
export function buildCustomProviderId(customApiId: string): string {
  return `${CUSTOM_API_PROVIDER_PREFIX}${customApiId}`;
}
export function buildCustomModelId(customApiId: string, model: string): string {
  return `${buildCustomProviderId(customApiId)}/${model}`;
}

interface SettingsState {
  isHydrated: boolean;
  apiKeys: ProviderApiKeys;
  customApis: CustomApiProvider[];
  jimengCli: JimengCliSettings;
  grsaiNanoBananaProModel: string;
  hideProviderGuidePopover: boolean;
  downloadPresetPaths: string[];
  useUploadFilenameAsNodeTitle: boolean;
  storyboardGenKeepStyleConsistent: boolean;
  storyboardGenDisableTextInImage: boolean;
  storyboardGenAutoInferEmptyFrame: boolean;
  ignoreAtTagWhenCopyingAndGenerating: boolean;
  enableStoryboardGenGridPreviewShortcut: boolean;
  showStoryboardGenAdvancedRatioControls: boolean;
  showNodePrice: boolean;
  priceDisplayCurrencyMode: PriceDisplayCurrencyMode;
  usdToCnyRate: number;
  preferDiscountedPrice: boolean;
  grsaiCreditTierId: GrsaiCreditTierId;
  uiRadiusPreset: UiRadiusPreset;
  themeTonePreset: ThemeTonePreset;
  accentColor: string;
  canvasEdgeRoutingMode: CanvasEdgeRoutingMode;
  /** 节点拖拽磁吸网格开关 */
  snapToGrid: boolean;
  autoCheckAppUpdateOnLaunch: boolean;
  enableUpdateDialog: boolean;
  /** 最近一次使用的图片生成模型 id(新建 AI 图片节点默认选中) */
  lastImageModelId: string | null;
  setProviderApiKey: (providerId: string, key: string) => void;
  setJimengCliExecutable: (executable: string) => void;
  addCustomApi: (input: Omit<CustomApiProvider, 'id' | 'createdAt'>) => CustomApiProvider;
  updateCustomApi: (id: string, patch: Partial<Omit<CustomApiProvider, 'id'>>) => void;
  removeCustomApi: (id: string) => void;
  setGrsaiNanoBananaProModel: (model: string) => void;
  setHideProviderGuidePopover: (hide: boolean) => void;
  setDownloadPresetPaths: (paths: string[]) => void;
  setUseUploadFilenameAsNodeTitle: (enabled: boolean) => void;
  setStoryboardGenKeepStyleConsistent: (enabled: boolean) => void;
  setStoryboardGenDisableTextInImage: (enabled: boolean) => void;
  setStoryboardGenAutoInferEmptyFrame: (enabled: boolean) => void;
  setIgnoreAtTagWhenCopyingAndGenerating: (enabled: boolean) => void;
  setEnableStoryboardGenGridPreviewShortcut: (enabled: boolean) => void;
  setShowStoryboardGenAdvancedRatioControls: (enabled: boolean) => void;
  setShowNodePrice: (enabled: boolean) => void;
  setPriceDisplayCurrencyMode: (mode: PriceDisplayCurrencyMode) => void;
  setUsdToCnyRate: (rate: number) => void;
  setPreferDiscountedPrice: (enabled: boolean) => void;
  setGrsaiCreditTierId: (tierId: GrsaiCreditTierId) => void;
  setUiRadiusPreset: (preset: UiRadiusPreset) => void;
  setThemeTonePreset: (preset: ThemeTonePreset) => void;
  setAccentColor: (color: string) => void;
  setCanvasEdgeRoutingMode: (mode: CanvasEdgeRoutingMode) => void;
  setSnapToGrid: (enabled: boolean) => void;
  setAutoCheckAppUpdateOnLaunch: (enabled: boolean) => void;
  setEnableUpdateDialog: (enabled: boolean) => void;
  setLastImageModelId: (modelId: string | null) => void;
}

const HEX_COLOR_PATTERN = /^#?[0-9a-fA-F]{6}$/;

function normalizeHexColor(input: string): string {
  const trimmed = input.trim();
  if (!HEX_COLOR_PATTERN.test(trimmed)) {
    return '#3B82F6';
  }
  return trimmed.startsWith('#') ? trimmed.toUpperCase() : `#${trimmed.toUpperCase()}`;
}

function normalizeApiKey(input: string): string {
  return input.trim();
}

function normalizePriceDisplayCurrencyMode(
  input: PriceDisplayCurrencyMode | string | null | undefined
): PriceDisplayCurrencyMode {
  return PRICE_DISPLAY_CURRENCY_MODES.includes(input as PriceDisplayCurrencyMode)
    ? (input as PriceDisplayCurrencyMode)
    : 'auto';
}

function normalizeUsdToCnyRate(input: number | string | null | undefined): number {
  const numeric = typeof input === 'number' ? input : Number(input);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 7.2;
  }

  return Math.min(100, Math.max(0.01, Math.round(numeric * 100) / 100));
}

function normalizeGrsaiCreditTierId(
  input: GrsaiCreditTierId | string | null | undefined
): GrsaiCreditTierId {
  switch (input) {
    case 'tier-10':
    case 'tier-20':
    case 'tier-49':
    case 'tier-99':
    case 'tier-499':
    case 'tier-999':
      return input;
    default:
      return DEFAULT_GRSAI_CREDIT_TIER_ID;
  }
}

function normalizeGrsaiNanoBananaProModel(input: string | null | undefined): string {
  const trimmed = (input ?? '').trim().toLowerCase();
  if (trimmed === DEFAULT_GRSAI_NANO_BANANA_PRO_MODEL || trimmed.startsWith('nano-banana-pro-')) {
    return trimmed;
  }
  return DEFAULT_GRSAI_NANO_BANANA_PRO_MODEL;
}

function normalizeCanvasEdgeRoutingMode(
  input: CanvasEdgeRoutingMode | string | null | undefined
): CanvasEdgeRoutingMode {
  if (input === 'orthogonal' || input === 'smartOrthogonal' || input === 'spline') {
    return input;
  }
  return 'spline';
}

function normalizeApiKeys(input: ProviderApiKeys | null | undefined): ProviderApiKeys {
  if (!input) {
    return {};
  }

  return Object.entries(input).reduce<ProviderApiKeys>((acc, [providerId, key]) => {
    const normalizedProviderId = providerId.trim();
    if (!normalizedProviderId) {
      return acc;
    }

    acc[normalizedProviderId] = normalizeApiKey(key);
    return acc;
  }, {});
}

function normalizeJimengCliSettings(input: unknown): JimengCliSettings {
  const executable =
    input && typeof input === 'object' && 'executable' in input
      ? String((input as { executable?: unknown }).executable ?? '').trim()
      : '';

  return {
    executable: executable.slice(0, 512) || DEFAULT_JIMENG_CLI_EXECUTABLE,
  };
}

function normalizeCustomApis(input: unknown): CustomApiProvider[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => {
      const explicitVideoModels = Array.isArray(item.videoModels)
        ? item.videoModels.map((model) => String(model).trim()).filter(Boolean)
        : [];
      const configuredModels = Array.isArray(item.models)
        ? item.models.map((model) => String(model).trim()).filter(Boolean)
        : [];
      const videoModels = Array.from(new Set([
        ...explicitVideoModels,
        ...configuredModels.filter(isVideoGenerationModelName),
      ]));
      const videoModelIds = new Set(videoModels.map((model) => model.toLowerCase()));
      const models = configuredModels.filter(
        (model) => !videoModelIds.has(model.toLowerCase()) && !isVideoGenerationModelName(model)
      );

      return {
        id: String(item.id ?? '').trim(),
        name: String(item.name ?? '').trim(),
        baseUrl: String(item.baseUrl ?? '').trim().replace(/\/+$/, ''),
        apiKey: normalizeApiKey(String(item.apiKey ?? '')),
        models,
        videoModels,
        createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
        requestMode: item.requestMode === 'sync' ? ('sync' as const) : ('async' as const),
        protocol: item.protocol === 'responses' ? ('responses' as const) : ('images' as const),
        referenceImageField:
          item.referenceImageField === 'input_image' ? ('input_image' as const) : ('image' as const),
      };
    })
    .filter((item) => item.id && item.name && item.baseUrl);
}

/** 基于名称生成稳定的自定义平台 id(附加短随机避免重名覆盖) */
function deriveCustomApiId(name: string, existingIds: Set<string>): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'custom-api';
  let candidate = base;
  const suffix = Math.random().toString(36).slice(2, 6);
  if (existingIds.has(candidate)) {
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}

export function hasConfiguredApiKey(apiKeys: ProviderApiKeys): boolean {
  return getConfiguredApiKeyCount(apiKeys) > 0;
}

export function getConfiguredApiKeyCount(
  apiKeys: ProviderApiKeys,
  providerIds?: readonly string[]
): number {
  const keysToCount = providerIds
    ? providerIds.map((providerId) => apiKeys[providerId] ?? '')
    : Object.values(apiKeys);

  return keysToCount.reduce((count, key) => {
    return normalizeApiKey(key).length > 0 ? count + 1 : count;
  }, 0);
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      isHydrated: false,
      apiKeys: {},
      customApis: [],
      jimengCli: { executable: DEFAULT_JIMENG_CLI_EXECUTABLE },
      grsaiNanoBananaProModel: DEFAULT_GRSAI_NANO_BANANA_PRO_MODEL,
      hideProviderGuidePopover: false,
      downloadPresetPaths: [],
      useUploadFilenameAsNodeTitle: true,
      storyboardGenKeepStyleConsistent: true,
      storyboardGenDisableTextInImage: true,
      storyboardGenAutoInferEmptyFrame: true,
      ignoreAtTagWhenCopyingAndGenerating: true,
      enableStoryboardGenGridPreviewShortcut: false,
      showStoryboardGenAdvancedRatioControls: false,
      showNodePrice: true,
      priceDisplayCurrencyMode: 'auto',
      usdToCnyRate: 7.2,
      preferDiscountedPrice: false,
      grsaiCreditTierId: DEFAULT_GRSAI_CREDIT_TIER_ID,
      uiRadiusPreset: 'default',
      themeTonePreset: 'neutral',
      accentColor: '#3B82F6',
      canvasEdgeRoutingMode: 'spline',
      snapToGrid: false,
      autoCheckAppUpdateOnLaunch: true,
      enableUpdateDialog: true,
      lastImageModelId: null,
      setProviderApiKey: (providerId, key) =>
        set((state) => ({
          apiKeys: {
            ...state.apiKeys,
            [providerId]: normalizeApiKey(key),
          },
        })),
      setJimengCliExecutable: (executable) =>
        set({ jimengCli: normalizeJimengCliSettings({ executable }) }),
      addCustomApi: (input) => {
        const existingIds = new Set(get().customApis.map((item) => item.id));
        const id = deriveCustomApiId(input.name, existingIds);
        const entry: CustomApiProvider = {
          ...input,
          id,
          createdAt: Date.now(),
        };
        const customApis = normalizeCustomApis([...get().customApis, entry]);
        set((state) => ({
          customApis,
          apiKeys: {
            ...state.apiKeys,
            [buildCustomProviderId(id)]: normalizeApiKey(input.apiKey),
          },
        }));
        return entry;
      },
      updateCustomApi: (id, patch) => {
        const customApis = get().customApis.map((item) =>
          item.id === id ? { ...item, ...patch } : item
        );
        set((state) => ({
          customApis: normalizeCustomApis(customApis),
          apiKeys:
            patch.apiKey !== undefined
              ? {
                  ...state.apiKeys,
                  [buildCustomProviderId(id)]: normalizeApiKey(patch.apiKey),
                }
              : state.apiKeys,
        }));
      },
      removeCustomApi: (id) => {
        const customApis = get().customApis.filter((item) => item.id !== id);
        set((state) => {
          const nextKeys = { ...state.apiKeys };
          delete nextKeys[buildCustomProviderId(id)];
          return { customApis, apiKeys: nextKeys };
        });
      },
      setGrsaiNanoBananaProModel: (model) =>
        set({
          grsaiNanoBananaProModel: normalizeGrsaiNanoBananaProModel(model),
        }),
      setHideProviderGuidePopover: (hide) => set({ hideProviderGuidePopover: hide }),
      setDownloadPresetPaths: (paths) => {
        const uniquePaths = Array.from(
          new Set(paths.map((path) => path.trim()).filter((path) => path.length > 0))
        ).slice(0, 8);
        set({ downloadPresetPaths: uniquePaths });
      },
      setUseUploadFilenameAsNodeTitle: (enabled) => set({ useUploadFilenameAsNodeTitle: enabled }),
      setStoryboardGenKeepStyleConsistent: (enabled) =>
        set({ storyboardGenKeepStyleConsistent: enabled }),
      setStoryboardGenDisableTextInImage: (enabled) =>
        set({ storyboardGenDisableTextInImage: enabled }),
      setStoryboardGenAutoInferEmptyFrame: (enabled) =>
        set({ storyboardGenAutoInferEmptyFrame: enabled }),
      setIgnoreAtTagWhenCopyingAndGenerating: (enabled) =>
        set({ ignoreAtTagWhenCopyingAndGenerating: enabled }),
      setEnableStoryboardGenGridPreviewShortcut: (enabled) =>
        set({ enableStoryboardGenGridPreviewShortcut: enabled }),
      setShowStoryboardGenAdvancedRatioControls: (enabled) =>
        set({ showStoryboardGenAdvancedRatioControls: enabled }),
      setShowNodePrice: (enabled) => set({ showNodePrice: enabled }),
      setPriceDisplayCurrencyMode: (priceDisplayCurrencyMode) =>
        set({
          priceDisplayCurrencyMode:
            normalizePriceDisplayCurrencyMode(priceDisplayCurrencyMode),
        }),
      setUsdToCnyRate: (usdToCnyRate) =>
        set({ usdToCnyRate: normalizeUsdToCnyRate(usdToCnyRate) }),
      setPreferDiscountedPrice: (enabled) => set({ preferDiscountedPrice: enabled }),
      setGrsaiCreditTierId: (grsaiCreditTierId) =>
        set({ grsaiCreditTierId: normalizeGrsaiCreditTierId(grsaiCreditTierId) }),
      setUiRadiusPreset: (uiRadiusPreset) => set({ uiRadiusPreset }),
      setThemeTonePreset: (themeTonePreset) => set({ themeTonePreset }),
      setAccentColor: (color) => set({ accentColor: normalizeHexColor(color) }),
      setCanvasEdgeRoutingMode: (canvasEdgeRoutingMode) =>
        set({ canvasEdgeRoutingMode: normalizeCanvasEdgeRoutingMode(canvasEdgeRoutingMode) }),
      setSnapToGrid: (enabled) => set({ snapToGrid: Boolean(enabled) }),
      setAutoCheckAppUpdateOnLaunch: (enabled) => set({ autoCheckAppUpdateOnLaunch: enabled }),
      setEnableUpdateDialog: (enabled) => set({ enableUpdateDialog: enabled }),
      setLastImageModelId: (modelId) => set({ lastImageModelId: modelId }),
    }),
    {
      name: 'settings-storage',
      version: 15,
      onRehydrateStorage: () => {
        return (_state, error) => {
          if (error) {
            console.error('failed to hydrate settings storage', error);
          }
          // 延迟到下一个 tick: persist 的同步 rehydrate 发生在 create() 返回前,
          // 此时直接访问 useSettingsStore 会触发 TDZ(Cannot access before initialization)
          setTimeout(() => {
            useSettingsStore.setState({ isHydrated: true });
          }, 0);
        };
      },
      migrate: (persistedState: unknown) => {
        const state = (persistedState ?? {}) as {
          apiKey?: string;
          apiKeys?: ProviderApiKeys;
          ignoreAtTagWhenCopyingAndGenerating?: boolean;
          grsaiNanoBananaProModel?: string;
          hideProviderGuidePopover?: boolean;
          canvasEdgeRoutingMode?: CanvasEdgeRoutingMode | string;
          autoCheckAppUpdateOnLaunch?: boolean;
          enableUpdateDialog?: boolean;
          lastImageModelId?: string | null;
          enableStoryboardGenGridPreviewShortcut?: boolean;
          showStoryboardGenAdvancedRatioControls?: boolean;
          storyboardGenAutoInferEmptyFrame?: boolean;
          showNodePrice?: boolean;
          priceDisplayCurrencyMode?: PriceDisplayCurrencyMode | string;
          usdToCnyRate?: number | string;
          preferDiscountedPrice?: boolean;
          grsaiCreditTierId?: GrsaiCreditTierId | string;
          jimengCli?: unknown;
        };

        const migratedApiKeys = normalizeApiKeys(state.apiKeys);
        const ignoreAtTagWhenCopyingAndGenerating =
          state.ignoreAtTagWhenCopyingAndGenerating ?? true;
        const customApis = normalizeCustomApis(
          (persistedState as { customApis?: unknown }).customApis
        );
        if (Object.keys(migratedApiKeys).length > 0) {
          return {
            ...(persistedState as object),
            isHydrated: true,
            apiKeys: migratedApiKeys,
            customApis,
            jimengCli: normalizeJimengCliSettings(state.jimengCli),
            ignoreAtTagWhenCopyingAndGenerating,
            grsaiNanoBananaProModel: normalizeGrsaiNanoBananaProModel(
              state.grsaiNanoBananaProModel
            ),
            hideProviderGuidePopover: state.hideProviderGuidePopover ?? false,
            canvasEdgeRoutingMode: normalizeCanvasEdgeRoutingMode(state.canvasEdgeRoutingMode),
            autoCheckAppUpdateOnLaunch: state.autoCheckAppUpdateOnLaunch ?? true,
            enableUpdateDialog: state.enableUpdateDialog ?? true,
            lastImageModelId: typeof state.lastImageModelId === 'string' && state.lastImageModelId ? state.lastImageModelId : null,
            enableStoryboardGenGridPreviewShortcut:
              state.enableStoryboardGenGridPreviewShortcut ?? false,
            showStoryboardGenAdvancedRatioControls:
              state.showStoryboardGenAdvancedRatioControls ?? false,
            storyboardGenAutoInferEmptyFrame: state.storyboardGenAutoInferEmptyFrame ?? true,
            showNodePrice: state.showNodePrice ?? true,
            priceDisplayCurrencyMode: normalizePriceDisplayCurrencyMode(
              state.priceDisplayCurrencyMode
            ),
            usdToCnyRate: normalizeUsdToCnyRate(state.usdToCnyRate),
            preferDiscountedPrice: state.preferDiscountedPrice ?? false,
            grsaiCreditTierId: normalizeGrsaiCreditTierId(state.grsaiCreditTierId),
          };
        }

        return {
          ...(persistedState as object),
          isHydrated: true,
          apiKeys: state.apiKey ? { ppio: normalizeApiKey(state.apiKey) } : {},
          customApis,
          jimengCli: normalizeJimengCliSettings(state.jimengCli),
          ignoreAtTagWhenCopyingAndGenerating,
          grsaiNanoBananaProModel: normalizeGrsaiNanoBananaProModel(
            state.grsaiNanoBananaProModel
          ),
          hideProviderGuidePopover: state.hideProviderGuidePopover ?? false,
          canvasEdgeRoutingMode: normalizeCanvasEdgeRoutingMode(state.canvasEdgeRoutingMode),
          autoCheckAppUpdateOnLaunch: state.autoCheckAppUpdateOnLaunch ?? true,
          enableUpdateDialog: state.enableUpdateDialog ?? true,
          lastImageModelId: typeof state.lastImageModelId === 'string' && state.lastImageModelId ? state.lastImageModelId : null,
          enableStoryboardGenGridPreviewShortcut:
            state.enableStoryboardGenGridPreviewShortcut ?? false,
          showStoryboardGenAdvancedRatioControls:
            state.showStoryboardGenAdvancedRatioControls ?? false,
          storyboardGenAutoInferEmptyFrame: state.storyboardGenAutoInferEmptyFrame ?? true,
          showNodePrice: state.showNodePrice ?? true,
          priceDisplayCurrencyMode: normalizePriceDisplayCurrencyMode(
            state.priceDisplayCurrencyMode
          ),
          usdToCnyRate: normalizeUsdToCnyRate(state.usdToCnyRate),
          preferDiscountedPrice: state.preferDiscountedPrice ?? false,
          grsaiCreditTierId: normalizeGrsaiCreditTierId(state.grsaiCreditTierId),
        };
      },
    }
  )
);
