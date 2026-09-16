import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { isTauri } from '@tauri-apps/api/core';
import { loadAppSetting, saveAppSetting, deleteAppSetting } from '@/commands/appDatabase';
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
/** 提示词工作室 AI 请求的推理强度；'' 表示不发送 reasoning_effort 参数（兼容非推理模型） */
export type CinematicReasoningEffort = '' | 'low' | 'medium' | 'high' | 'xhigh';
const CINEMATIC_REASONING_EFFORTS: CinematicReasoningEffort[] = ['', 'low', 'medium', 'high', 'xhigh'];
export function normalizeCinematicReasoningEffort(value?: string): CinematicReasoningEffort {
  return (CINEMATIC_REASONING_EFFORTS as string[]).includes(value ?? '')
    ? (value as CinematicReasoningEffort)
    : '';
}
export interface CinematicAiSelection {
  provider: string;
  model: string;
  reasoningEffort?: CinematicReasoningEffort;
}
export const DEFAULT_GRSAI_NANO_BANANA_PRO_MODEL = 'nano-banana-pro';
export const DEFAULT_JIMENG_CLI_EXECUTABLE = 'dreamina';

export interface CustomApiCapabilities {
  detectedAt: number;
  detectionSource: 'probe' | 'manual';
  confidence: 'low' | 'high';
  imageProtocol: 'images' | 'responses' | 'chat' | 'unknown';
  /** 参考图字段: image / input_image 为常见 OpenAI 兼容写法, images 为纯数组写法(知鸟 AI)。 */
  imageReferenceField: 'image' | 'input_image' | 'image_urls' | 'images' | 'unknown';
  imageReferenceEncoding: 'data_url' | 'raw_base64' | 'url' | 'multipart' | 'unknown';
  imageTransport: 'generations_json' | 'edits_multipart' | 'apimart_json' | 'unknown';
  videoSubmitPath: string;
  videoQueryPath: string;
  videoReferenceEncoding: 'data_url' | 'raw_base64' | 'url' | 'multipart' | 'unknown';
  taskProtocol: 'generic' | 'unknown';
  videoTransport?: 'sub2api-video' | 'zzdh-v8-video' | 'binghuo-video' | 'zhiniao-video' | 'zhenjian-task-api';
}

/** 即梦 CLI 是本地命令行工具，不使用 OpenAI 兼容平台的 API Key 配置。 */
export interface JimengCliSettings {
  executable: string;
}

/** 视频模型必须与图片模型分开注册，避免通用模型拉取结果污染图片节点。 */
export function isVideoGenerationModelName(model: string): boolean {
  const value = model.trim().toLowerCase();
  if (!value) {
    return false;
  }

  // Keep the markers explicit and boundary-aware. Several video providers use
  // short IDs such as `sd2.5` and `bh2.0`; matching a bare `sd` or `2` would
  // incorrectly move image models like `sdxl` into the video list.
  return [
    /(?:^|[-_.])seedance(?:[-_.]|\d|$)/,
    /(?:^|[-_.])bh2(?:\.0)?(?:[-_.]|\d|$)/,
    /(?:^|[-_.])sd2(?:\.0|\.5)?(?:[-_.]|\d|$)/,
    /(?:^|[-_.])sdvip(?:[-_.]|\d|$)/,
    /(?:^|[-_.])sdquan(?:[-_.]|\d|$)/,
    /(?:^|[-_.])gz-sd(?:[-_.]|\d|$)/,
    /(?:^|[-_.])rd2(?:\.0|\.5)?(?:[-_.]|\d|$)/,
    /(?:^|[-_.])wan3(?:\.0)?(?:[-_.]|\d|$)/,
    /(?:^|[-_.])wanneng(?:[-_.]|\d|$)/,
    /(?:^|[-_.])doubaofast(?:[-_.]|\d|$)/,
    /(?:^|[-_.])minimax-h3(?:[-_.]|\d|$)/,
    /(?:^|[-_.])sp2(?:\.5)?(?:[-_.]|\d|$)/,
    /(?:^|[-_.])tj-(?:wan3|sp2)(?:[-_.]|\d|$)/,
    /(?:^|[-_.])quanneng(?:[-_.]|\d|$)/,
    /(?:^|[-_.])video(?:[-_.]|\d|$)/,
    // 视频任务后缀是通用写法(t2v 文生 / i2v 图生 / r2v 参考生 / kf2v 首尾帧 / videoedit 改视频)。
    // 字子动画的 wan2.x、happyhorse 系列只靠这些后缀区分于同名的图片/文本模型。
    /(?:^|[-_.])(?:t2v|i2v|r2v|kf2v|flf2v|videoedit)(?:[-_.]|\d|$)/,
    /(?:^|[-_.])hailuo(?:[-_.]|\d|$)/,
    /(?:^|[-_.])kling(?:[-_.]|\d|$)/,
    /(?:^|[-_.])runway(?:[-_.]|\d|$)/,
    /(?:^|[-_.])veo(?:[-_.]|\d|$)/,
    /(?:^|[-_.])sora(?:[-_.]|\d|$)/,
    /(?:^|[-_.])pixverse(?:[-_.]|\d|$)/,
    /(?:^|[-_.])vidu(?:[-_.]|\d|$)/,
    /(?:^|[-_.])luma(?:[-_.]|\d|$)/,
    /grok-imagine-video/,
    /xb-sora/,
    /me-kuaile/,
  ].some((marker) => marker.test(value));
}

/** 音频模型(语音合成 / 音色克隆 / 音乐生成)也必须单独归类，避免拉取结果污染图片模型。 */
export function isAudioModelName(model: string): boolean {
  const value = model.trim().toLowerCase();
  if (!value || isVideoGenerationModelName(value)) {
    return false;
  }
  return [
    // 语音合成 / 克隆 / 音频与音乐生成：tts-1-hd、speech-2.8、voice-clone、music、suno...
    // eleven_* 是 ElevenLabs 全家桶(TTS/music/sound-effects), indextts 是国内 TTS,
    // 名字里没有 tts/speech 边界, 必须显式列出, 否则保存平台时会被启发式丢掉。
    /(?:^|[-_./])(?:tts|speech|voice|voiceclone|audio|music|suno|mureka|whisper|asr|elevenlabs|eleven|vocoder|cosyvoice|indextts|sound)(?:[-_./]|\d|$)/,
    /(?:^|[-_./])ace[-_]?step(?:[-_./]|\d|$)/,
    /(?:^|[-_./])fish[-_]?audio(?:[-_./]|\d|$)/,
    // gpt-4o-audio-preview / qwen-audio 这类「模型名+audio」写法
    /(?:gpt-\d+o?|qwen\d?|doubao|step)[-_]?audio/,
  ].some((marker) => marker.test(value));
}

/** 自定义 AI 平台(OpenAI 兼容),参考 Infinite Canvas 的 API 设置写法 */
/** Classify a model id as a chat-completion LLM (excludes image/video/audio generators). */
export function isChatCompletionModelName(model: string): boolean {
  const value = model.trim().toLowerCase();
  if (!value || isVideoGenerationModelName(value) || isAudioModelName(value)) {
    return false;
  }
  const imageMarker =
    /gpt-image|dall-?e|imagen|midjourney|stable[- ]?diffusion|sdxl|\bflux\b|nano[- ]?banana|\bbanana\b|seedream|z-image|qwen-image|tongyi[- ]image|image[- ]?(gen|edit|generation)|\bimage\b/i;
  if (imageMarker.test(value)) {
    return false;
  }
  const llmMarker =
    /(?:^|[-_/])(gpt|o[1-4]|claude|codex|gemini|deepseek|glm|chatglm|llama|mistral|mixtral|qwen[23]?|kimi|moonshot|doubao|hunyuan|ernie|spark|baichuan|abab|phi|falcon|vicuna|wizard|openchat|hermes|nemotron|granite|olmo|jamba|command|nova|titan|minimax|groq|grok)(?=[-_.0-9]|$)|gpt-|claude-|codex-|gemini-|deepseek-|glm-|llama-|kimi|moonshot|doubao/i;
  return llmMarker.test(value);
}

export interface CustomApiProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  /** 视频生成模型：与图像模型分开，避免在图片节点中误选。 */
  videoModels: string[];
  /** 音频模型（语音合成 / 音色克隆 / 音乐生成）：与图片模型分开，避免下拉里混入 TTS。 */
  audioModels: string[];
  /** Chat LLM models for text tasks. */
  chatModels: string[];
  createdAt: number;
  /** 请求模式: sync=同步等待平台返回图片; async=提交后轮询任务状态 */
  requestMode: 'sync' | 'async';
  /** 接口协议: images=/v1/images/generations; responses=/v1/responses; chat=/v1/chat/completions(gpt-image 中转平台常用) */
  protocol: 'images' | 'responses' | 'chat';
  /** Images 协议的参考图字段: 大多数中转平台用 image, 原生 GPT Image 用 input_image, 知鸟 AI 用 images(纯数组), 字子动画用 reference_images(对象数组)。 */
  referenceImageField: 'image' | 'input_image' | 'images' | 'reference_images';
  /** 参考图编码: auto 按字段选择, 也可显式指定纯 Base64 / data URL / URL。 */
  referenceImageEncoding: 'auto' | 'data_url' | 'raw_base64' | 'url';
  /** Images 协议的图生图传输方式。auto 使用平台/模型专用适配，默认保持 generations JSON。 */
  imageTransport: 'auto' | 'generations_json' | 'edits_multipart' | 'apimart_json';
  /** 需要公网参考素材的视频模型可使用的上传接口完整 URL。 */
  referenceAssetUploadUrl?: string;
  /** 参考素材上传接口的 Bearer 令牌，仅保存在本机设置。 */
  referenceAssetUploadToken?: string;
  /** 平台同步的官方模型价格，单位为 CNY 元；用户手动价格保存在 customModelPrices 中并优先显示。 */
  modelPrices?: Record<string, number>;
  capabilities?: CustomApiCapabilities;
}

export type CustomApiRequestMode = CustomApiProvider['requestMode'];
export type CustomApiProtocol = CustomApiProvider['protocol'];
export type CustomApiReferenceImageField = CustomApiProvider['referenceImageField'];
export type CustomApiReferenceImageEncoding = CustomApiProvider['referenceImageEncoding'];
export type CustomApiImageTransport = CustomApiProvider['imageTransport'];

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
  cinematicAiSelection: CinematicAiSelection;
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
  /** 最近一次使用的图片分辨率(新建 AI 图片节点默认选中); 当前模型不支持时回退默认值。 */
  lastImageSize: string | null;
  /** 最近一次使用的图片宽高比(新建 AI 图片节点默认选中); `auto` 表示交给模型决定。 */
  lastImageAspectRatio: string | null;
  /** 最近一次选择的视频生成时长；AI 视频和即梦 CLI 新节点共用。 */
  lastVideoDuration: number;
  /** 最近一次使用的视频模型 id(新建 AI 视频节点默认选中); 模型已不存在时回退默认模型。 */
  lastVideoModelId: string | null;
  /** 最近一次使用的视频宽高比(新建节点默认选中); 当前模型不支持时回退模型默认值。 */
  lastVideoAspectRatio: string | null;
  /** 最近一次使用的视频分辨率(新建节点默认选中); 当前模型不支持时回退模型默认值。 */
  lastVideoResolution: string | null;
  /** 用户为 AI 图片/视频模型设置的价格覆盖，key 为模型唯一 ID。 */
  customModelPrices: Record<string, string>;
  /** 已实际成功生成过的模型，供拉取模型列表标记为可用。 */
  usableModelIds: string[];
  setProviderApiKey: (providerId: string, key: string) => void;
  setJimengCliExecutable: (executable: string) => void;
  addCustomApi: (input: Omit<CustomApiProvider, 'id' | 'createdAt'>) => CustomApiProvider;
  updateCustomApi: (id: string, patch: Partial<Omit<CustomApiProvider, 'id'>>) => void;
  removeCustomApi: (id: string) => void;
  setCinematicAiSelection: (selection: CinematicAiSelection) => void;
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
  setLastImageSize: (size: string | null) => void;
  setLastImageAspectRatio: (aspectRatio: string | null) => void;
  setLastVideoDuration: (duration: number) => void;
  setLastVideoModelId: (modelId: string | null) => void;
  setLastVideoAspectRatio: (aspectRatio: string | null) => void;
  setLastVideoResolution: (resolution: string | null) => void;
  setCustomModelPrice: (modelId: string, price: string | null) => void;
  markModelAvailable: (modelId: string) => void;
}

const SETTINGS_STORAGE_KEY = 'settings-storage';

// Zustand's persist middleware supports async storage. Desktop builds use the
// unified SQLite database; browser previews retain localStorage as a fallback.
const settingsStorage = {
  getItem: async (name: string): Promise<string | null> => {
    if (isTauri()) {
      const stored = await loadAppSetting(name).catch(() => null);
      if (stored !== null) {
        if (typeof localStorage !== 'undefined') localStorage.removeItem(name);
        return stored;
      }

      const legacy = typeof localStorage !== 'undefined' ? localStorage.getItem(name) : null;
      if (legacy !== null) {
        try {
          await saveAppSetting(name, legacy);
          localStorage.removeItem(name);
        } catch {
          // Keep the legacy copy if SQLite is temporarily unavailable.
        }
      }
      return legacy;
    }
    return typeof localStorage !== 'undefined' ? localStorage.getItem(name) : null;
  },
  setItem: async (name: string, value: string): Promise<void> => {
    if (isTauri()) {
      try {
        await saveAppSetting(name, value);
        return;
      } catch {
        // Development/webview fallback; never lose a settings update.
      }
    }
    if (typeof localStorage !== 'undefined') localStorage.setItem(name, value);
  },
  removeItem: async (name: string): Promise<void> => {
    if (isTauri()) {
      await deleteAppSetting(name).catch(() => undefined);
    }
    if (typeof localStorage !== 'undefined') localStorage.removeItem(name);
  },
};

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

function normalizeVideoDuration(value: number | string | null | undefined): number {
  const duration = Math.round(Number(value));
  return Number.isFinite(duration) ? Math.min(30, Math.max(1, duration)) : 5;
}

/** 可空的"上次使用"记忆值(模型 id / 宽高比 / 分辨率): 去空白, 空串归一为 null。 */
function normalizeOptionalSettingString(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed ? trimmed : null;
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

function normalizeUsableModelIds(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return Array.from(new Set(
    input
      .filter((modelId): modelId is string => typeof modelId === 'string')
      .map((modelId) => modelId.trim())
      .filter(Boolean)
  )).slice(-500);
}

function normalizeCustomModelPrices(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }

  return Object.entries(input as Record<string, unknown>).reduce<Record<string, string>>(
    (result, [modelId, price]) => {
      const normalizedModelId = modelId.trim();
      const normalizedPrice = typeof price === 'string' ? price.trim() : '';
      if (normalizedModelId && normalizedPrice) {
        result[normalizedModelId] = normalizedPrice;
      }
      return result;
    },
    {},
  );
}

function normalizeOfficialModelPrices(input: unknown): Record<string, number> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  return Object.entries(input as Record<string, unknown>).reduce<Record<string, number>>(
    (result, [modelId, price]) => {
      const normalizedModelId = modelId.trim();
      const numericPrice = typeof price === 'number' ? price : Number(price);
      if (normalizedModelId && Number.isFinite(numericPrice) && numericPrice >= 0) {
        result[normalizedModelId] = numericPrice;
      }
      return result;
    },
    {},
  );
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

function normalizeCustomApiCapabilities(input: unknown): CustomApiCapabilities | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const value = input as Record<string, unknown>;
  const protocol = value.imageProtocol;
  const field = value.imageReferenceField;
  const imageEncoding = value.imageReferenceEncoding;
  const imageTransport = value.imageTransport;
  const videoEncoding = value.videoReferenceEncoding;
  const taskProtocol = value.taskProtocol;
  const videoTransport = value.videoTransport;
  return {
    detectedAt: typeof value.detectedAt === 'number' ? value.detectedAt : Date.now(),
    detectionSource: value.detectionSource === 'manual' ? 'manual' : 'probe',
    confidence: value.confidence === 'high' ? 'high' : 'low',
    imageProtocol: protocol === 'responses' || protocol === 'images' || protocol === 'chat' ? protocol : 'unknown',
    imageReferenceField: field === 'input_image' || field === 'image' || field === 'image_urls' || field === 'images' ? field : 'unknown',
    imageReferenceEncoding: imageEncoding === 'data_url' || imageEncoding === 'raw_base64' || imageEncoding === 'url' || imageEncoding === 'multipart'
      ? imageEncoding
      : 'unknown',
    imageTransport: imageTransport === 'generations_json' || imageTransport === 'edits_multipart' || imageTransport === 'apimart_json'
      ? imageTransport
      : 'unknown',
    videoSubmitPath: typeof value.videoSubmitPath === 'string' ? value.videoSubmitPath : '/v1/videos/generations',
    videoQueryPath: typeof value.videoQueryPath === 'string' ? value.videoQueryPath : '/v1/videos/generations/{taskId}',
    videoReferenceEncoding: videoEncoding === 'data_url' || videoEncoding === 'raw_base64' || videoEncoding === 'url' || videoEncoding === 'multipart'
      ? videoEncoding
      : 'unknown',
    taskProtocol: taskProtocol === 'unknown' ? 'unknown' : 'generic',
    ...(videoTransport === 'sub2api-video' || videoTransport === 'zzdh-v8-video' || videoTransport === 'binghuo-video' || videoTransport === 'zhiniao-video' || videoTransport === 'zhenjian-task-api'
      ? { videoTransport }
      : {}),
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
      const chatModels = Array.isArray(item.chatModels)
        ? item.chatModels.map((model) => String(model).trim()).filter(Boolean)
        : [];
      const audioModels = Array.from(new Set([
        ...(Array.isArray(item.audioModels)
          ? item.audioModels.map((model) => String(model).trim()).filter(Boolean)
          : []),
        ...configuredModels.filter(isAudioModelName),
      ]));
      const videoModelIds = new Set(videoModels.map((model) => model.toLowerCase()));
      const audioModelIds = new Set(audioModels.map((model) => model.toLowerCase()));
      const models = configuredModels.filter(
        (model) =>
          !videoModelIds.has(model.toLowerCase())
          && !audioModelIds.has(model.toLowerCase())
          && !isVideoGenerationModelName(model)
          && !isAudioModelName(model)
      );

      return {
        id: String(item.id ?? '').trim(),
        name: String(item.name ?? '').trim(),
        baseUrl: String(item.baseUrl ?? '').trim().replace(/\/+$/, ''),
        apiKey: normalizeApiKey(String(item.apiKey ?? '')),
        models,
        videoModels,
        audioModels,
        chatModels,
        createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
        // Older builds silently assigned async to every custom platform even
        // though the UI had no async selector. Migrate that legacy value to
        // sync; async must be explicitly reintroduced with a known query URL.
        requestMode: 'sync' as const,
        protocol:
          item.protocol === 'responses'
            ? ('responses' as const)
            : item.protocol === 'chat' || item.protocol === 'chat/completions' || item.protocol === 'chat_completions'
              ? ('chat' as const)
              : ('images' as const),
        referenceImageField:
          item.referenceImageField === 'input_image'
            ? ('input_image' as const)
            : item.referenceImageField === 'images'
              ? ('images' as const)
              : item.referenceImageField === 'reference_images'
                ? ('reference_images' as const)
                : ('image' as const),
        referenceImageEncoding:
          item.referenceImageEncoding === 'raw_base64' || item.referenceImageEncoding === 'url' || item.referenceImageEncoding === 'data_url'
            ? (item.referenceImageEncoding as 'raw_base64' | 'url' | 'data_url')
            : ('auto' as const),
        imageTransport:
          item.imageTransport === 'generations_json'
          || item.imageTransport === 'edits_multipart'
          || item.imageTransport === 'apimart_json'
            ? (item.imageTransport as 'generations_json' | 'edits_multipart' | 'apimart_json')
            : ('auto' as const),
        referenceAssetUploadUrl: String(item.referenceAssetUploadUrl ?? '').trim().replace(/\/+$/, '') || undefined,
        referenceAssetUploadToken: String(item.referenceAssetUploadToken ?? '').trim() || undefined,
        modelPrices: normalizeOfficialModelPrices(item.modelPrices),
        capabilities: normalizeCustomApiCapabilities(item.capabilities),
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
      cinematicAiSelection: { provider: '', model: '', reasoningEffort: '' },
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
      lastImageSize: null,
      lastImageAspectRatio: null,
      lastVideoDuration: 5,
      lastVideoModelId: null,
      lastVideoAspectRatio: null,
      lastVideoResolution: null,
      customModelPrices: {},
      usableModelIds: [],
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
      setCinematicAiSelection: (selection) =>
        set({
          cinematicAiSelection: {
            provider: selection.provider.trim(),
            model: selection.model.trim(),
            reasoningEffort: normalizeCinematicReasoningEffort(selection.reasoningEffort),
          },
        }),
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
      setLastImageModelId: (modelId) =>
        set({ lastImageModelId: normalizeOptionalSettingString(modelId) }),
      setLastImageSize: (size) => set({ lastImageSize: normalizeOptionalSettingString(size) }),
      setLastImageAspectRatio: (aspectRatio) =>
        set({ lastImageAspectRatio: normalizeOptionalSettingString(aspectRatio) }),
      setLastVideoDuration: (duration) => set({ lastVideoDuration: normalizeVideoDuration(duration) }),
      setLastVideoModelId: (modelId) =>
        set({ lastVideoModelId: normalizeOptionalSettingString(modelId) }),
      setLastVideoAspectRatio: (aspectRatio) =>
        set({ lastVideoAspectRatio: normalizeOptionalSettingString(aspectRatio) }),
      setLastVideoResolution: (resolution) =>
        set({ lastVideoResolution: normalizeOptionalSettingString(resolution) }),
      setCustomModelPrice: (modelId, price) => {
        const normalizedModelId = modelId.trim();
        if (!normalizedModelId) return;
        const normalizedPrice = typeof price === 'string' ? price.trim() : '';
        set((state) => {
          const customModelPrices = { ...state.customModelPrices };
          if (normalizedPrice) {
            customModelPrices[normalizedModelId] = normalizedPrice;
          } else {
            delete customModelPrices[normalizedModelId];
          }
          return { customModelPrices };
        });
      },
      markModelAvailable: (modelId) => {
        const normalizedModelId = modelId.trim();
        if (!normalizedModelId) return;
        set((state) => state.usableModelIds.includes(normalizedModelId)
          ? state
          : { usableModelIds: [...state.usableModelIds, normalizedModelId].slice(-500) });
      },
    }),
    {
      name: SETTINGS_STORAGE_KEY,
      storage: createJSONStorage(() => settingsStorage),
      version: 20,
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
          lastImageSize?: string | null;
          lastImageAspectRatio?: string | null;
          lastVideoDuration?: number | string | null;
          lastVideoModelId?: string | null;
          lastVideoAspectRatio?: string | null;
          lastVideoResolution?: string | null;
          customModelPrices?: unknown;
          usableModelIds?: unknown;
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
            lastImageModelId: normalizeOptionalSettingString(state.lastImageModelId),
            lastImageSize: normalizeOptionalSettingString(state.lastImageSize),
            lastImageAspectRatio: normalizeOptionalSettingString(state.lastImageAspectRatio),
            lastVideoDuration: normalizeVideoDuration(state.lastVideoDuration),
            lastVideoModelId: normalizeOptionalSettingString(state.lastVideoModelId),
            lastVideoAspectRatio: normalizeOptionalSettingString(state.lastVideoAspectRatio),
            lastVideoResolution: normalizeOptionalSettingString(state.lastVideoResolution),
            customModelPrices: normalizeCustomModelPrices(state.customModelPrices),
            usableModelIds: normalizeUsableModelIds(state.usableModelIds),
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
          lastImageModelId: normalizeOptionalSettingString(state.lastImageModelId),
          lastImageSize: normalizeOptionalSettingString(state.lastImageSize),
          lastImageAspectRatio: normalizeOptionalSettingString(state.lastImageAspectRatio),
          lastVideoDuration: normalizeVideoDuration(state.lastVideoDuration),
          lastVideoModelId: normalizeOptionalSettingString(state.lastVideoModelId),
          lastVideoAspectRatio: normalizeOptionalSettingString(state.lastVideoAspectRatio),
          lastVideoResolution: normalizeOptionalSettingString(state.lastVideoResolution),
          customModelPrices: normalizeCustomModelPrices(state.customModelPrices),
          usableModelIds: normalizeUsableModelIds(state.usableModelIds),
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
