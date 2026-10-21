import type {
  AudioCreativePanel,
  AudioModelDefinition,
  AudioModelKind,
  AudioModelOperation,
  ImageModelDefinition,
  ImageModelRuntimeContext,
  ModelProviderDefinition,
  ResolutionOption,
  VideoModelDefinition,
} from "./types";
import {
  buildCustomModelId,
  buildCustomProviderId,
  isAudioModelName,
  isChatCompletionModelName,
  isVideoGenerationModelName,
  useSettingsStore,
} from "@/stores/settingsStore";
import { isWindowsDesktopRuntime } from "@/platform/runtime";
import { createPointsOnlyPricing } from "@/features/canvas/pricing";
import { resolveVideoModelProfile } from "./videoProfiles";
import { resolveImageModelResolutionOptions } from "./imageModelCapabilities";
import {
  isLingkeBaseUrl,
  LINGKE_IMAGE_NAME_OVERRIDES,
  resolveLingkeImageCapability,
  type LingkeImageCapability,
} from "@/features/settings/lingkeModels";
import { createZhiniaoImagePricing, createZhiniaoVideoPricing, isZhiniaoProvider } from "./zhiniaoPricing";
import { createWgspaiImagePricing, createWgspaiVideoPricing, isWgspaiProvider } from "./wgspaiPricing";
import {
  isMidjourneyImageModel,
  MIDJOURNEY_DEFAULT_EXTRA_PARAMS,
  MIDJOURNEY_EXTRA_PARAMS,
  MIDJOURNEY_IMAGES_PER_GROUP,
} from "./midjourney";
import { isRjmVideoApiBaseUrl } from "@/commands/videoApi";
import { resolveMmxVoiceOperation } from "@/commands/minimaxVoice";
import { isSunoMusicModel } from "@/commands/sunoMusic";
import { resolveAudioModelFamily } from "./audioFamilies";
import { resolveAudioVoiceCatalog } from "./audioVoices";
import {
  isZzdhProvider,
  resolveZzdhAudioKind,
  resolveZzdhResolutionTier,
  resolveZzdhVideoDurationRange,
  ZZDH_LIP_SYNC_MODEL_NAMES,
  ZZDH_ASPECT_RATIOS,
  ZZDH_VIDEO_DURATION_OPTIONS,
} from "@/commands/zzdhApi";
import { WAN_CLI_PROVIDER_ID, wanCliProvider, wanCliVideoModels } from "./wanCli";
import { resolveWgspaiAspectRatioOptions, resolveWgspaiDurationOptions } from "@/commands/wgspaiProtocol";
import {
  isRunningHubBaseUrl,
  resolveRunningHubAspectRatioOptions,
  resolveRunningHubDurationOptions,
  resolveRunningHubResolutionOptions,
  resolveRunningHubVideoEndpoint,
  resolveRunningHubVideoDisplayName,
  runningHubEndpointSupportsInput,
  collapseRunningHubVideoModels,
  isRunningHubDedicatedVideoEndpoint,
} from "@/commands/runningHubProtocol";
import { resolveApi666888VideoOptions } from "./lingkeVideoOptions";

const providerModules = import.meta.glob<{ provider: ModelProviderDefinition }>("./providers/*.ts", { eager: true });
const modelModules = import.meta.glob<{ imageModel: ImageModelDefinition }>("./image/**/*.ts", { eager: true });

const providers: ModelProviderDefinition[] = Object.values(providerModules)
  .map((module) => module.provider)
  .filter((provider): provider is ModelProviderDefinition => Boolean(provider))
  .sort((a, b) => a.id.localeCompare(b.id));

const imageModels: ImageModelDefinition[] = Object.values(modelModules)
  .map((module) => module.imageModel)
  .filter((model): model is ImageModelDefinition => Boolean(model))
  .sort((a, b) => a.id.localeCompare(b.id));

const providerMap = new Map<string, ModelProviderDefinition>(providers.map((provider) => [provider.id, provider]));
const imageModelMap = new Map<string, ImageModelDefinition>(imageModels.map((model) => [model.id, model]));

export const DEFAULT_IMAGE_MODEL_ID = "builtin:default";
export const JIMENG_CLI_PROVIDER_ID = "jimeng-cli";
const JIMENG_CLI_PROVIDER: ModelProviderDefinition = {
  id: JIMENG_CLI_PROVIDER_ID,
  name: "即梦 CLI",
  label: "即梦 CLI",
};

/** RunningHub 官方 CLI 使用本机 rh 配置中的 Key，模型仍复用官方端点目录。 */
export const RUNNINGHUB_CLI_PROVIDER_ID = "runninghub-cli";
const RUNNINGHUB_CLI_PROVIDER: ModelProviderDefinition = {
  id: RUNNINGHUB_CLI_PROVIDER_ID,
  name: "RunningHub CLI",
  label: "RunningHub CLI",
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
  RUNNINGHUB_CLI_PROVIDER_ID,
]);

export function isApiKeylessProvider(providerId: string): boolean {
  return API_KEYLESS_PROVIDER_IDS.has(providerId);
}
const JIMENG_CLI_VIDEO_POINTS_PER_SECOND: Record<string, number> = {
  "seedance2.0_vip": 14,
  "seedance2.5": 26,
  "seedance2.0mini": 6,
  "seedance2.0fast_vip": 6,
  "seedance2.0fast": 2,
  "seedance2.0": 3,
};
const WINDOWS_UNCONFIGURED_IMAGE_MODEL_ID = "custom:unconfigured/configure-api";
const WINDOWS_UNCONFIGURED_IMAGE_MODEL: ImageModelDefinition = {
  id: WINDOWS_UNCONFIGURED_IMAGE_MODEL_ID,
  mediaType: "image",
  displayName: "请先配置自定义 API",
  providerId: "custom:unconfigured",
  description: "Windows 桌面端仅支持自定义 OpenAI 兼容 API",
  eta: "1min",
  expectedDurationMs: 60000,
  defaultAspectRatio: "1:1",
  defaultResolution: "1K",
  aspectRatios: [{ value: "1:1", label: "1:1" }],
  resolutions: [{ value: "1K", label: "1K" }],
  resolveRequest: () => ({
    requestModel: WINDOWS_UNCONFIGURED_IMAGE_MODEL_ID,
    modeLabel: "需要配置",
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
  return [...providers, RUNNINGHUB_CLI_PROVIDER, ...buildCustomProviders()];
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
  return (
    imageModelMap.get(resolvedModelId) ??
    imageModelMap.get(DEFAULT_IMAGE_MODEL_ID) ??
    listImageModels()[0] ??
    WINDOWS_UNCONFIGURED_IMAGE_MODEL
  );
}

export function getDefaultImageModelId(): string {
  return listImageModels()[0]?.id ?? DEFAULT_IMAGE_MODEL_ID;
}

// 超分模型只服务“超分”入口，不进入普通视频生成下拉。
function isVideoUpscaleModelName(model: string): boolean {
  return model.trim().toLowerCase() === "aliyun-video-superres";
}

export function listVideoModels(): VideoModelDefinition[] {
  const customVideoModels: VideoModelDefinition[] = useSettingsStore.getState().customApis.flatMap((api) => {
    const isRunningHubApi =
      isRunningHubBaseUrl(api.baseUrl) || ["runninghub", "runninghub-cn"].includes(api.id.trim().toLowerCase());
    // RunningHub 的文生/图生/多模态是同一个模型家族的不同端点。
    // 普通视频节点只保留一个 canonical id，提交时根据实际素材选择端点。
    const configuredVideoModels = isRunningHubApi
      ? [
          ...collapseRunningHubVideoModels(api.videoModels),
          ...api.videoModels.filter((model) => {
            const endpoint = resolveRunningHubVideoEndpoint(model);
            return endpoint ? isRunningHubDedicatedVideoEndpoint(endpoint.endpoint) : false;
          }),
        ]
      : api.videoModels;
    return Array.from(
      new Set([
        ...(isZzdhProvider(api.id, api.baseUrl)
          ? [...api.videoModels, ...ZZDH_LIP_SYNC_MODEL_NAMES]
          : configuredVideoModels
        ).filter((model) => !isVideoUpscaleModelName(model)),
        ...api.models.filter(isVideoGenerationModelName),
      ]),
    ).map((model) => {
      const modelId = buildCustomModelId(api.id, model);
      const profile = resolveVideoModelProfile(modelId, api.baseUrl);
      const normalizedModel = model.trim().toLowerCase();
      const isZzdh = isZzdhProvider(api.id, api.baseUrl);
      const isSub2Api = api.id.trim().toLowerCase() === "sub2api-video" || isRjmVideoApiBaseUrl(api.baseUrl);
      // WGSPAI 曾经和炳火并在一起共用 `resolveBinghuoVideoOptions`。两家的模型名
      // 并不重合(那份表是炳火自己的 sd2.5 / quanneng2.0 系列), 于是 WGSPAI 的
      // `seedance2.5`(固定 30 秒按次计费)会落到默认的 4~15 秒档位 —— 用户在下拉里
      // 选 12 秒, 平台照 30 秒出片。现在按站点文档单独解析。
      const isWgspai =
        api.id.trim().toLowerCase() === "wgspai" || api.baseUrl.trim().toLowerCase().includes("api.wgspai.cn");
      const isBinghuo =
        api.id.trim().toLowerCase() === "binghuo" || api.baseUrl.trim().toLowerCase().includes("api.7tai.cc");
      const isZhiniao =
        api.id.trim().toLowerCase() === "zhiniao" ||
        api.baseUrl.trim().toLowerCase().includes("cuai.token6688.com") ||
        api.baseUrl.trim().toLowerCase().includes("api.tokengo.love");
      // RunningHub: 「模型」就是官方端点 ID(`kling-v3.0-pro/image-to-video`),
      // 每个端点的时长 / 画幅 / 分辨率枚举都不一样 —— 档位表只能按端点查官方目录。
      // `.cn` 与 `.ai` 是同一套协议, 一并识别。
      const isRunningHub =
        isRunningHubBaseUrl(api.baseUrl) || ["runninghub", "runninghub-cn"].includes(api.id.trim().toLowerCase());
      const binghuoOptions = isBinghuo ? resolveBinghuoVideoOptions(model) : undefined;
      const wgspaiOptions = isWgspai
        ? {
            durationOptions: resolveWgspaiDurationOptions(
              model,
              Array.from({ length: 30 }, (_, index) => index + 1),
            ),
            aspectRatios: resolveWgspaiAspectRatioOptions(model, CUSTOM_ASPECT_RATIOS),
          }
        : undefined;
      const zhiniaoOptions = isZhiniao ? resolveZhiniaoVideoOptions(model) : undefined;
      // api666888「暗苗」链路: 9 个 seedance 模型, 2.5 系 4~30 秒 / 2.0 系 4~15 秒。
      // 官方主域名是 api.lk888.ai(备用 api.lk666.ai), 但同名白标站(api666888.com /
      // lingkeai.ai / lingkeai.vip)与别名 api.lingkeai.ai 在历史配置里都出现过 ——
      // 四种 baseUrl 全认, 不能让任何一边掉档位。
      const isApi666888 =
        api.id.trim().toLowerCase() === "api666888" ||
        ["api666888.com", "lingkeai", "lk888.ai", "lk666.ai"].some((host) =>
          api.baseUrl.trim().toLowerCase().includes(host),
        );
      const api666888Options = isApi666888 ? resolveApi666888VideoOptions(model) : undefined;
      // RunningHub 的档位表逐端点不同。这里的**空数组是有意义的返回值**: 表示该
      // 端点官方 schema 里没有这个参数(UI 应隐藏该控件), 或它的画幅字段收像素串、
      // 选项已在提交时折成像素。所以下面每处都先判 `.length` 再取用 —— 直接 `??`
      // 兜底是错的, 空数组不是 nullish, 会把通用档位表吃掉。
      const runningHubOptions = isRunningHub
        ? {
            durationOptions: resolveRunningHubDurationOptions(model, []),
            aspectRatios: resolveRunningHubAspectRatioOptions(model, []),
            resolutionValues: resolveRunningHubResolutionOptions(model, []),
          }
        : undefined;
      const sub2ApiDuration =
        normalizedModel === "seedance2.5" ? 30 : normalizedModel === "seedance2.0" ? 15 : undefined;
      const isSub2ApiSeedance = isSub2Api && sub2ApiDuration !== undefined;
      // 字子动画: 档位写在模型名里(zddh-Minimax-h3-480p / doubao-seedance-2-4k),
      // UI 只提供该档位一个选项; 档位不在模型名里时按文档给 720p/1080p 两档。
      const zzdhTier = isZzdh ? resolveZzdhResolutionTier(model) : null;
      const zzdhDurationRange = isZzdh ? resolveZzdhVideoDurationRange(model) : null;
      const zzdhDurationOptions = isZzdh
        ? zzdhDurationRange
          ? Array.from(
              { length: zzdhDurationRange.max - zzdhDurationRange.min + 1 },
              (_, index) => zzdhDurationRange.min + index,
            )
          : ZZDH_VIDEO_DURATION_OPTIONS
        : undefined;
      const resolutionValues = isSub2ApiSeedance
        ? normalizedModel === "seedance2.5"
          ? ["480p", "720p"]
          : ["480p", "720p", "1080p", "4k"]
        : isZzdh
          ? zzdhTier
            ? [zzdhTier]
            : ["720p", "1080p"]
          : runningHubOptions?.resolutionValues.length
            ? runningHubOptions.resolutionValues
            : api666888Options?.resolutionValues.length
              ? api666888Options.resolutionValues
              : zhiniaoOptions?.resolutionValues.length
                ? zhiniaoOptions.resolutionValues
                : binghuoOptions?.resolutionValues;
      // 字子动画画幅枚举只有 16:9 / 9:16 / 1:1(官方文档), 不要放 21:9 等超纲值。
      // WGSPAI 的白名单来自 `wgspaiProtocol`(seedance-v2 只认 9:16 / 16:9), 必须排在
      // 炳火前面 —— 两家现在是各自独立解析的, 顺序只影响可读性。
      const aspectRatios = isSub2ApiSeedance
        ? ["16:9", "9:16"]
        : isZzdh
          ? [...ZZDH_ASPECT_RATIOS]
          : runningHubOptions?.aspectRatios.length
            ? runningHubOptions.aspectRatios
            : (wgspaiOptions?.aspectRatios ??
              api666888Options?.aspectRatios ??
              zhiniaoOptions?.aspectRatios ??
              binghuoOptions?.aspectRatios ??
              CUSTOM_ASPECT_RATIOS);
      const durationOptions =
        sub2ApiDuration !== undefined
          ? [sub2ApiDuration]
          : runningHubOptions?.durationOptions.length
            ? runningHubOptions.durationOptions
            : (wgspaiOptions?.durationOptions ??
              api666888Options?.durationOptions ??
              zhiniaoOptions?.durationOptions ??
              binghuoOptions?.durationOptions ??
              zzdhDurationOptions ??
              Array.from({ length: 30 }, (_, index) => index + 1));
      // RunningHub 的官方端点有中文名(`可灵图生视频3.0-pro`), 直接当展示名 ——
      // 端点 ID 里带斜杠, 原样显示在下拉里可读性太差。
      const runningHubEndpoint = isRunningHub ? resolveRunningHubVideoEndpoint(model) : undefined;
      const displayModelName =
        (runningHubEndpoint ? resolveRunningHubVideoDisplayName(model) : undefined) ??
        (normalizedModel === "seedance2.5"
          ? "Seedance 2.5"
          : normalizedModel === "seedance2.0"
            ? "Seedance 2.0"
            : model);
      return {
        id: modelId,
        mediaType: "video" as const,
        displayName: `${api.name} · ${displayModelName}`,
        providerId: buildCustomProviderId(api.id),
        description: `${api.name} · ${displayModelName}`,
        expectedDurationMs: 180000,
        aspectRatios: aspectRatios.map((value) => ({ value, label: value })),
        // 默认值必须落在可选档位里: RunningHub 的端点没有 16:9 时(如纯竖屏端点)
        // 硬写 16:9 会让下拉显示一个不存在的选项。`?? "16:9"` 兜住理论上的空表。
        defaultAspectRatio: aspectRatios.includes("16:9") ? "16:9" : (aspectRatios[0] ?? "16:9"),
        durationOptions,
        // 默认时长取该平台档位表的首项, 保证「默认值一定在可选档位里」——
        // WGSPAI 的 seedance2.5 档位只有 [30], 落到通用的 5 会让下拉显示一个
        // 并不存在的选项。
        defaultDuration:
          sub2ApiDuration ??
          runningHubOptions?.durationOptions[0] ??
          api666888Options?.defaultDuration ??
          (zhiniaoOptions ? resolveZhiniaoDefaultDuration(zhiniaoOptions) : undefined) ??
          wgspaiOptions?.durationOptions[0] ??
          binghuoOptions?.durationOptions[0] ??
          5,
        ...(resolutionValues
          ? {
              resolutions: resolutionValues.map((value) => ({
                value,
                label: value.toUpperCase(),
              })),
              defaultResolution: resolutionValues.includes("720p") ? "720p" : resolutionValues[0],
            }
          : {}),
        pricing: resolveCustomVideoPricing(api.name, api.baseUrl, model, isBinghuo),
        profileId: profile.id,
        profileStatus: profile.status,
        profileLabel: profile.protocolLabel,
        profileUnavailableReason: profile.unavailableReason,
      };
    });
  });

  return [
    ...customVideoModels,
    ...buildRunningHubCliVideoModels(),
    ...buildJimengCliVideoModels(),
    ...wanCliVideoModels,
  ];
}

export function getVideoModel(modelId: string): VideoModelDefinition | undefined {
  return listVideoModels().find((model) => model.id === modelId);
}

export function getDefaultVideoModelId(): string {
  return listVideoModels()[0]?.id ?? "";
}

/**
 * 声明了「支持参考样音克隆」的模型名标记 —— 音频节点的「音色克隆」页只列命中它的模型
 * (选中后那一整块参考样音才有意义)。
 *
 * 显式列名的原因: 大多数平台的克隆模型名字里有 voice-clone / indextts / cosyvoice /
 * eleven 这类词, 靠它们就能认出来。
 *
 * ⚠️ 2026-09-20 修正: 原来这里还挂着 `speech[-_ ]?\d` 与 `minimax[-_ ]?(?:speech|tts)`,
 * 目的是让知鸟AI 的 `speech-2.8` 出现在克隆页(平台侧 display_name 就写着 "Voice Clone")。
 * 这个判断**方向错了**: `speech-2.8` 是**消费端** —— 它的 param_schema 里
 * **没有任何参考样音字段**, 只吃 `voice`(voice_id)。把它列进克隆页, 用户上传样音后
 * 请求照发, 平台静默忽略, 表现是「克隆了但声音没变」。
 *
 * 正确分工(见 docs/api_docs/ZhiniaoAI_MiniMax_Voice_Chain.md):
 *   voice-clone  → 「音色克隆」页(上传样音建音色, 按次一次性计费)
 *   voice-design → 「音色设计」页(文字描述建音色)
 *   speech-2.8   → 「2.8 配音」页(用 voice_id 合成, 按字符计费)
 * 所以这里**不能**再匹配 speech。
 *
 * `voice-design` 同样不算: 音色设计是「用文字描述生成音色」, 不吃参考样音。
 */
const AUDIO_VOICE_CLONE_MARKER =
  /voice[-_ ]?clone|voiceclone|indextts|cosyvoice|fish[-_ ]?speech|eleven|xtts|chatterbox/;

/**
 * 模型的操作语义 —— 端点(audioKind)不足以决定请求体, 必须再分一层。
 *
 * MiniMax 三件套都打同一个 `/v1/audio/speech`, 靠 `model` 分流; 而 `speech-2.8` 与
 * `voice-clone` 的 audioKind 都是 `speech`, 光看端点分不出「建音色」还是「合成」。
 * 所以先按 MiniMax 规则判, 未命中再退回 audioKind。
 */
function resolveAudioModelOperation(model: string, audioKind: AudioModelKind): AudioModelOperation {
  return resolveMmxVoiceOperation(model) ?? audioKind;
}

/** 从已构建的模型定义里取 operation(兼容老数据: 没有 operation 时退回按 id 重算)。 */
function resolveDefinitionOperation(model: AudioModelDefinition): AudioModelOperation {
  return model.operation ?? resolveAudioModelOperation(model.id, model.audioKind);
}

/**
 * 音频生成模型(语音合成 / 音效 / 音乐)。
 *
 * 之前 `audioModels` 只是个配置分桶(`buildCustomImageModels` 里把它排除掉),
 * 没有任何运行期消费方 —— 这里把它变成真正的模型定义, 供音频节点下拉使用。
 * 三个面板(声音克隆 / 文字转语音 / 音乐创作)的归属全部由模型名推出:
 * kind 走 resolveZzdhAudioKind, 克隆能力走 AUDIO_VOICE_CLONE_MARKER。
 *
 * 定价: 平台对音频按字符用量计费(quota_type=0 / model_ratio), 没有可按次展示的
 * 固定价, 因此不提供 pricing —— 界面上不显示价格, 而不是显示一个错误数字。
 */
function buildCustomAudioModels(): AudioModelDefinition[] {
  return useSettingsStore.getState().customApis.flatMap((api) =>
    Array.from(new Set([...(api.audioModels ?? []), ...api.models.filter(isAudioModelName)])).map((model) => {
      const modelId = buildCustomModelId(api.id, model);
      // 端点/面板归类只取决于模型名(见 ZZDH_AUDIO_KIND_PATTERNS), 与平台无关:
      // 知鸟的 `music`(Suno)、FHL 的 `suno-v3` 名字里就写着 music, 必须进「音乐创作」页。
      // 以前非字子动画平台一律当 speech, 结果是「音乐创作」页对所有其它平台恒空,
      // 而音乐模型全部错列在「文字转语音」页。
      const audioKind: AudioModelKind = resolveZzdhAudioKind(model) ?? "speech";
      const normalizedModel = model.trim().toLowerCase();
      const isRunningHubSunoSingle = normalizedModel === "rhart-audio/suno-v5.5/single";
      const isRunningHubSunoCustom = normalizedModel === "rhart-audio/suno-v5.5/custom";
      const operation =
        isRunningHubSunoSingle || isRunningHubSunoCustom
          ? "music"
          : resolveAudioModelOperation(normalizedModel, audioKind);
      const family = resolveAudioModelFamily(normalizedModel);
      // 音色表按模型解析, 不再所有模型共用一份写死的 6 音色(那是 tts-1 的清单):
      // GM 系列真实有 30 种预置音色且只输出 wav, GT 系列 6 种、支持 6 种输出格式。
      const voiceCatalog = resolveAudioVoiceCatalog(normalizedModel);
      const supportsVoiceClone = AUDIO_VOICE_CLONE_MARKER.test(normalizedModel);
      const supportsEmotion =
        supportsVoiceClone || /tts|speech|voice|gpt-4o-mini-tts|gemini.*tts/.test(normalizedModel);
      return {
        id: modelId,
        mediaType: "audio" as const,
        displayName: `${api.name} · ${model}`,
        providerId: buildCustomProviderId(api.id),
        description: `${api.name} · ${model}`,
        expectedDurationMs: audioKind === "music" ? 180000 : 45000,
        audioKind,
        // 操作语义与端点分开: MiniMax 的 voice-clone / voice-design / speech-2.8 端点相同,
        // 只有 operation 能区分「建音色」还是「合成」。
        operation,
        family,
        // 克隆/情绪是模型自身的属性, 不能只挂在 speech 上: 音效类模型
        // (eleven_text_to_sound_v2) 既不是 speech 也不是 music, 只在克隆页有位置,
        // 少这个字段它就会从三个面板里同时消失。
        supportsVoiceClone,
        supportsEmotion,
        ...(audioKind === "speech" && operation === "speech"
          ? family === "minimax"
            ? {
                /*
                 * MiniMax 海螺**不给预置音色表**。
                 *
                 * 它的音色是**资产**: `voice-clone` / `voice-design` 产出一个真实 `voice_id`,
                 * 再由 `speech-2.8` 消费 —— 没有「内置音色」这一层。以前这里走的是通用兜底
                 * 目录(GT 那套), 于是 `defaultVoice: "alloy"` 被写进节点, 界面上就出现了一个
                 * 服务端从未听说过的默认音色。UI 侧也据此改为「默认不选、只列音色库」。
                 *
                 * 输出格式保留 mp3: 那是 speech-2.8 的常规产物, 与音色来源无关。
                 */
                formatOptions: ["mp3"],
                defaultFormat: "mp3",
              }
            : {
                voiceOptions: voiceCatalog.voices.map((entry) => entry.id),
                defaultVoice: voiceCatalog.defaultVoice,
                formatOptions: voiceCatalog.formatOptions,
                defaultFormat: voiceCatalog.defaultFormat,
                // UI 需要风格说明(「Zephyr · 明亮」)与「是否支持自然语言风格指令」,
                // 这两样在扁平数组里表达不了。
                voiceCatalog,
              }
          : {}),
        ...(audioKind === "music"
          ? isSunoMusicModel(normalizedModel)
            ? {
                // 知鸟 Suno: 没有 music_length_ms(曲长由模型定), 换成 8 种 operation 的协议标记。
                musicProtocol: "suno" as const,
              }
            : isRunningHubSunoSingle || isRunningHubSunoCustom
              ? {
                  musicProtocol: "suno" as const,
                  sunoSupportedOperations: isRunningHubSunoSingle ? ["generate"] : ["custom"],
                }
              : {
                  // 字子动画等: 保持原来的「歌词 + 时长」最小集。
                  musicProtocol: "generic" as const,
                  musicLengthOptionsMs: [15000, 30000, 60000, 120000],
                  defaultMusicLengthMs: 30000,
                }
          : {}),
      };
    }),
  );
}

export function listAudioModels(): AudioModelDefinition[] {
  return [...buildCustomAudioModels(), ...buildRunningHubCliAudioModels()];
}

export function getAudioModel(modelId: string): AudioModelDefinition | undefined {
  return listAudioModels().find((model) => model.id === modelId);
}

export function getDefaultAudioModelId(): string {
  return listAudioModels()[0]?.id ?? "";
}

/**
 * 创作面板与模型的匹配规则 —— 四个面板各列自己真正能用的模型:
 *
 * - **音色克隆**: 只列「上传样音就能建音色」的模型(`supportsVoiceClone`)。
 *   `speech-2.8` **不在其列** —— 它是消费端, 没有参考样音字段, 列进来只会让用户
 *   传完样音发现声音没变。建音色请走 `voice-clone`。
 * - **音色设计**: 只列「文字描述就能建音色」的模型(operation = voice-design)。
 * - **2.8 配音(文字转语音)**: 列能直接合成的 TTS 模型; 排掉两个创建类
 *   (voice-clone / voice-design) —— 它们不接受要朗读的文本, 混进来会发出一条
 *   语义错误的请求。
 * - **音乐创作**: 只列 audioKind = music。
 *
 * 供应商筛选和面板筛选必须走同一套规则, 否则会出现「切了供应商但列表没变」。
 *
 * 放在这里(而不是节点组件里)是为了能被测试直接覆盖 —— 这几条规则漏一个词,
 * 表现就是「某个平台的模型整个不见了」, 很难从界面上看出来。
 *
 * 注意 `sound-effects` 类模型(字子动画的 eleven_text_to_sound_v2):
 * 节点没有「音效」页, 它靠 `eleven` 命中克隆标记落在「音色克隆」页, 不要为了「语义更准」
 * 把它排除 —— 排掉就是所有面板都看不到它。
 */
export function matchesAudioCreativePanel(model: AudioModelDefinition, mode: AudioCreativePanel): boolean {
  const operation = resolveDefinitionOperation(model);
  if (mode === "voice-clone") {
    return Boolean(model.supportsVoiceClone) && model.audioKind !== "music" && operation !== "voice-design";
  }
  if (mode === "voice-design") return operation === "voice-design";
  if (mode === "music") return model.audioKind === "music";
  return model.audioKind === "speech" && operation !== "voice-clone" && operation !== "voice-design";
}

function buildJimengCliVideoModels(): VideoModelDefinition[] {
  const models = [
    { version: "seedance2.0fast", label: "Seedance 2.0 Fast", maxDuration: 15, resolutions: ["720p"] },
    { version: "seedance2.0", label: "Seedance 2.0", maxDuration: 15, resolutions: ["720p"] },
    { version: "seedance2.0fast_vip", label: "Seedance 2.0 Fast VIP", maxDuration: 15, resolutions: ["720p"] },
    { version: "seedance2.0_vip", label: "Seedance 2.0 VIP", maxDuration: 15, resolutions: ["720p", "1080p", "4k"] },
    { version: "seedance2.0mini", label: "Seedance 2.0 Mini", maxDuration: 15, resolutions: ["720p"] },
    { version: "seedance2.5", label: "Seedance 2.5", maxDuration: 30, resolutions: ["480p", "720p", "1080p"] },
  ] as const;

  return models.map(({ version, label, maxDuration, resolutions }) => ({
    id: `${JIMENG_CLI_PROVIDER_ID}/${version}`,
    mediaType: "video" as const,
    displayName: `即梦 CLI · ${label}`,
    providerId: JIMENG_CLI_PROVIDER_ID,
    description: `即梦 CLI · ${label}`,
    expectedDurationMs: 300000,
    aspectRatios: CUSTOM_ASPECT_RATIOS.map((value) => ({ value, label: value })),
    defaultAspectRatio: "16:9",
    durationOptions: Array.from({ length: maxDuration - 3 }, (_, index) => index + 4),
    defaultDuration: 5,
    resolutions: resolutions.map((value) => ({ value, label: value.toUpperCase() })),
    defaultResolution: resolutions[0],
    pricing: createPointsOnlyPricing(
      ({ extraParams }) =>
        (JIMENG_CLI_VIDEO_POINTS_PER_SECOND[version] ?? 0) * Math.max(1, Number(extraParams?.duration) || 5),
    ),
  }));
}

/**
 * RunningHub CLI 与 HTTP 版共用官方端点 ID，但走本机 `rh model run`。
 * 只注册 CLI 本地 catalog 中存在的端点，避免用户选中 CLI 后才发现端点不可用。
 */
function buildRunningHubCliVideoModels(): VideoModelDefinition[] {
  // The CLI catalog is not bundled into the frontend. Keep a broad fallback for
  // web preview and use the complete local catalog when the desktop bridge has
  // exposed it through settings.
  const endpoints = [
    "rhart-video-s/text-to-video",
    "rhart-video-s-official/text-to-video",
    "rhart-video-s-official/text-to-video-pro",
    "kling-v3.0-pro/text-to-video",
    "kling-v3.0-std/text-to-video",
    "kling-video-o3-pro/text-to-video",
    "kling-video-o3-std/text-to-video",
    "kling-video-o1/text-to-video",
    "kling-v2.6-pro/text-to-video",
    "kling-v2.5-turbo-pro/text-to-video",
    "kling-v2.5-turbo-std/text-to-video",
    "rhart-video-v3.1-pro/text-to-video",
    "rhart-video-v3.1-fast/text-to-video",
    "rhart-video-v3.1-pro-official/text-to-video",
    "rhart-video-v3.1-fast-official/text-to-video",
    "rhart-video-g/text-to-video",
    "rhart-video-g-official/text-to-video",
    "minimax/hailuo-02/t2v-pro",
    "minimax/hailuo-2.3/t2v-pro",
    "minimax/hailuo-02/t2v-standard",
    "minimax/hailuo-2.3/t2v-standard",
    "vidu/text-to-video-q3-pro",
    "vidu/text-to-video-q3-turbo",
    "vidu/text-to-video",
    "alibaba/wan-2.6/text-to-video",
    "seedance-v1.5-pro/text-to-video",
    "seedance-v1.5-pro/text-to-video-fast",
    "rhart-video/sparkvideo-2.0/text-to-video",
    "rhart-video/sparkvideo-2.0-fast/text-to-video",
    "bytedance/seedance-2.5-token/text-to-video",
    "minimax/hailuo-h3/text-to-video",
    "alibaba/wan-2.7/text-to-video",
    "pixverse-v6/text-to-video",
    "alibaba/wan-2.5-preview/text-to-video",
    "bytedance/seedance-2.0-global/text-to-video",
    "alibaba/happyhorse-1.0/text-to-video",
    "kling-v3-4k/text-to-video",
    "kling-video-o3-4k/text-to-video",
    "skyreels-v4/text-to-video-std",
    "gemini-omni-flash/text-to-video",
    "pixverse-v5.5/text-to-video",
    "vidu/text-to-video-q3-pro-fast",
    "pixverse-v5.6/text-to-video",
    "minimax/nova-video-2.0/text-to-video",
    "minimax/nova-video-2.0-fast/text-to-video",
    "minimax/eva-video-2.0/text-to-video",
    "minimax/eva-video-2.0-fast/text-to-video",
  ];
  const seenFamilies = new Set<string>();
  return endpoints
    .map((endpoint) => resolveRunningHubVideoEndpoint(endpoint))
    .filter((spec): spec is NonNullable<typeof spec> => Boolean(spec))
    .filter((spec) => runningHubEndpointSupportsInput(spec, "text"))
    .filter((spec) => {
      const family = spec.endpoint.replace(/\/text-to-video$/, "");
      if (seenFamilies.has(family)) return false;
      seenFamilies.add(family);
      return true;
    })
    .map((spec) => ({
      id: `${RUNNINGHUB_CLI_PROVIDER_ID}/${spec.endpoint}`,
      mediaType: "video" as const,
      displayName: `RunningHub CLI · ${resolveRunningHubVideoDisplayName(spec.endpoint)}`,
      providerId: RUNNINGHUB_CLI_PROVIDER_ID,
      description: `RunningHub CLI · ${resolveRunningHubVideoDisplayName(spec.endpoint)}`,
      expectedDurationMs: 300000,
      aspectRatios: (spec.ratios.length ? spec.ratios : CUSTOM_ASPECT_RATIOS).map((value) => ({ value, label: value })),
      defaultAspectRatio: spec.ratios[0] ?? "16:9",
      durationOptions: spec.durations.length ? spec.durations : Array.from({ length: 30 }, (_, index) => index + 1),
      defaultDuration: spec.durations[0] ?? 5,
      ...(spec.resolutions.length
        ? {
            resolutions: spec.resolutions.map((value) => ({ value, label: value.toUpperCase() })),
            defaultResolution: spec.resolutions[0],
          }
        : {}),
      profileId: "runninghub-model",
      profileStatus: "verified" as const,
    }));
}

function buildRunningHubCliAudioModels(): AudioModelDefinition[] {
  return [
    ["rhart-audio/text-to-audio/speech-2.8-turbo", "speech"],
    ["rhart-audio/text-to-audio/speech-2.8-hd", "speech"],
    ["rhart-audio/text-to-audio/speech-02-turbo", "speech"],
    ["minimax/music-2.6/text-to-music", "music"],
    ["minimax/music-2.6/text-to-instrumental", "music"],
    ["rhart-audio/suno-v5/single", "music"],
    ["rhart-audio/suno-v5/custom", "music"],
    ["rhart-audio/suno-v5.5/single", "music"],
    ["rhart-audio/suno-v5.5/custom", "music"],
    ["rhart-audio/suno-v4.5/single", "music"],
    ["rhart-audio/suno-v4.5/custom", "music"],
  ].map(([model, kind]) => {
    const audioKind = kind as AudioModelKind;
    const isSuno = model.includes("/suno-");
    return {
      id: `${RUNNINGHUB_CLI_PROVIDER_ID}/${model}`,
      mediaType: "audio" as const,
      displayName: `RunningHub CLI · ${model.split("/").pop()}`,
      providerId: RUNNINGHUB_CLI_PROVIDER_ID,
      description: `RunningHub CLI · ${model}`,
      audioKind,
      family: model.includes("suno") ? "suno" : resolveAudioModelFamily(model),
      operation: audioKind === "music" ? "music" : "speech",
      musicProtocol: isSuno ? "suno" : audioKind === "music" ? "generic" : undefined,
      sunoSupportedOperations: isSuno ? (model.endsWith("/single") ? ["generate"] : ["custom"]) : undefined,
      audioUiProtocol: model.includes("doubao") ? "doubao-tts" : undefined,
      formatOptions: audioKind === "speech" ? ["mp3", "wav"] : undefined,
      defaultFormat: audioKind === "speech" ? "mp3" : undefined,
    };
  });
}

/** 即梦图片的画幅枚举(取自 CLI `--help`), 注意不含自定义平台用的 5:4 / 4:5。 */
const JIMENG_CLI_IMAGE_ASPECT_RATIOS = ["21:9", "16:9", "3:2", "4:3", "1:1", "3:4", "2:3", "9:16"] as const;

/**
 * 即梦图片各版本支持的档位 —— `resolution_type` 会被 CLI 严格校验:
 * 3.x 只有 1K/2K, 4.x~5.0 是 2K/4K, 5.0Pro 多一档 1.5K。
 */
function resolveJimengCliImageResolutions(version: string): string[] {
  if (version === "3.0" || version === "3.1") {
    return ["1k", "2k"];
  }
  if (version === "5.0Pro") {
    return ["1.5k", "2k", "4k"];
  }
  return ["2k", "4k"];
}

/**
 * 即梦 CLI 的图片模型。它走本机 CLI, 没有 API Key, 所以不出现在「密钥」页的
 * 平台列表里 —— 图片模型选择器要靠 {@link isApiKeylessProvider} 放行。
 *
 * 有没有参考图决定走 `text2image` 还是 `image2image`, 由 Rust 侧按参考图数量决定。
 */
function buildJimengCliImageModels(): ImageModelDefinition[] {
  const models = [
    { version: "5.0Pro", label: "图片 5.0 Pro" },
    { version: "5.0", label: "图片 5.0" },
    { version: "4.7", label: "图片 4.7" },
    { version: "4.6", label: "图片 4.6" },
    { version: "4.5", label: "图片 4.5" },
    { version: "4.1", label: "图片 4.1" },
    { version: "4.0", label: "图片 4.0" },
    { version: "3.1", label: "图片 3.1" },
    { version: "3.0", label: "图片 3.0" },
  ] as const;

  return models.map(({ version, label }) => {
    const tiers = resolveJimengCliImageResolutions(version);
    return {
      id: `${JIMENG_CLI_PROVIDER_ID}/image-${version}`,
      mediaType: "image" as const,
      displayName: `即梦 CLI · ${label}`,
      providerId: JIMENG_CLI_PROVIDER_ID,
      description: `即梦 CLI · ${label}`,
      eta: "1min",
      expectedDurationMs: 120000,
      defaultAspectRatio: "1:1",
      defaultResolution: (tiers[0] ?? "2k").toUpperCase(),
      aspectRatios: JIMENG_CLI_IMAGE_ASPECT_RATIOS.map((value) => ({ value, label: value })),
      resolutions: tiers.map((value) => ({ value: value.toUpperCase(), label: value.toUpperCase() })),
      resolveRequest: ({ referenceImageCount }) => ({
        requestModel: `${JIMENG_CLI_PROVIDER_ID}/image-${version}`,
        modeLabel: referenceImageCount > 0 ? "编辑模式" : "生成模式",
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
export const JIMENG_CLI_IMAGE_UPSCALE_MODEL_ID = "jimeng-cli/upscale";

const JIMENG_CLI_IMAGE_UPSCALE_RESOLUTIONS = ["2k", "4k", "8k"] as const;

const JIMENG_CLI_IMAGE_UPSCALE_MODEL: ImageModelDefinition = {
  id: JIMENG_CLI_IMAGE_UPSCALE_MODEL_ID,
  mediaType: "image",
  displayName: "即梦 CLI · 图片超清",
  providerId: JIMENG_CLI_PROVIDER_ID,
  description: "把已有图片放大到 2K / 4K / 8K",
  eta: "1min",
  expectedDurationMs: 90000,
  defaultAspectRatio: "1:1",
  defaultResolution: JIMENG_CLI_IMAGE_UPSCALE_RESOLUTIONS[0].toUpperCase(),
  aspectRatios: JIMENG_CLI_IMAGE_ASPECT_RATIOS.map((value) => ({ value, label: value })),
  resolutions: JIMENG_CLI_IMAGE_UPSCALE_RESOLUTIONS.map((value) => ({
    value: value.toUpperCase(),
    label: value.toUpperCase(),
  })),
  resolveRequest: () => ({
    requestModel: JIMENG_CLI_IMAGE_UPSCALE_MODEL_ID,
    modeLabel: "超清",
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
  context: ImageModelRuntimeContext = {},
): ResolutionOption[] {
  const resolvedOptions = model.resolveResolutions?.(context);
  return resolvedOptions && resolvedOptions.length > 0 ? resolvedOptions : model.resolutions;
}

export function resolveImageModelResolution(
  model: ImageModelDefinition,
  requestedResolution: string | undefined,
  context: ImageModelRuntimeContext = {},
): ResolutionOption {
  const resolutionOptions = resolveImageModelResolutions(model, context);

  return (
    (requestedResolution ? resolutionOptions.find((item) => item.value === requestedResolution) : undefined) ??
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
  if (providerId === RUNNINGHUB_CLI_PROVIDER_ID) {
    return RUNNINGHUB_CLI_PROVIDER;
  }
  const builtin = providerMap.get(providerId);
  if (builtin) {
    return builtin;
  }
  const custom = buildCustomProviders().find((provider) => provider.id === providerId);
  return (
    custom ?? {
      id: "unknown",
      name: "Unknown Provider",
      label: "Unknown",
    }
  );
}

// ---------------------------------------------------------------------------
// 自定义平台(OpenAI 兼容):从设置里的 customApis 动态生成 provider 与模型
// ---------------------------------------------------------------------------

const CUSTOM_ASPECT_RATIOS = ["1:1", "16:9", "9:16", "21:9", "5:4", "4:5", "3:2", "2:3", "4:3", "3:4"] as const;

/**
 * 灵柯图片模型自己的画幅枚举, 与 App 通用档位取**交集**。
 *
 * 平台每个模型的 `aspect_ratio` / `aspectRatio` options 都不一样, 传枚举外的值
 * 会被拒。取交集既裁掉 `gk-image-2.0` 没有的 21:9 / 5:4, 也不会把表里那些
 * `1:4` / `9:21` / `7:3` 的极端比例塞进下拉。
 *
 * 交集为空(`tt-image-2` 族根本没有比例参数, 靠像素 `size` 表达)时返回
 * `undefined`, 调用方回退通用档位。
 */
function resolveLingkeAspectRatios(
  capability: LingkeImageCapability | undefined,
): readonly string[] | undefined {
  if (!capability || capability.ratios.length === 0) {
    return undefined;
  }
  const allowed = CUSTOM_ASPECT_RATIOS.filter((ratio) => capability.ratios.includes(ratio));
  return allowed.length > 0 ? allowed : undefined;
}

/**
 * 灵柯图片模型的分辨率档位。空数组返回 `undefined` ——
 * `qwen-image` / `wan2.x-image` 用 `size` 表达画幅、`mj_imagine` 用 `quality`,
 * 这三类都没有档位参数, 回退默认三档即可(后端不会把它发出去)。
 */
function resolveLingkeImageResolutions(
  capability: LingkeImageCapability | undefined,
): ResolutionOption[] | undefined {
  if (!capability || capability.resolutions.length === 0) {
    return undefined;
  }
  return capability.resolutions.map((value) => ({ value, label: value }));
}

/**
 * 知鸟 AI(TokenGo)视频模型的档位清单。
 *
 * 数据源: 官方文档 2026-10-07《模型清单与参数约束》里 **每个模型卡的**
 * duration / resolution / aspect_ratio 枚举。平台逐模型校验这三个字段, 传枚举外的
 * 值会被直接拒; 而且**按秒计费**的模型(文档里绝大多数)实付价 = 单价 × 秒数,
 * 时长枚举本身就是价格档位 —— 所以这里逐模型照抄文档, 不再只按模型族粗分。
 *
 * 文档未逐一列出的变体 SKU / 后续新增端点, 回落到函数末尾的模型族兜底。
 * 文档标注的计费方式(按秒 / 按次)决定时长是否可选: 按次模型把 duration 锁成
 * 文档给的那一档(如 seedance-2-5-special=30s 一口价), 免得用户改秒数却按原价结算。
 */
const ZHINIAO_DEFAULT_ASPECTS = ["16:9", "9:16", "1:1"];
/** 文档未声明 duration 的模型(数字人 / 对口型 / 视频编辑 / 超分, 时长由参考素材决定)。 */
const ZHINIAO_FALLBACK_DURATIONS = [5, 8, 10, 15, 20, 30];

interface ZhiniaoVideoOptionEntry {
  aspectRatios: string[];
  durationOptions: number[];
  resolutionValues: string[];
  /**
   * 该模型进节点时默认选中的秒数（必须落在 `durationOptions` 里）。
   * 不写就按通用规则：有 5 选 5，否则取首个合法档。新上线的长镜头模型在这里写 30。
   */
  defaultDuration?: number;
}

const ZHINIAO_VIDEO_OPTION_TABLE: Record<string, ZhiniaoVideoOptionEntry> = {
  // Seedance 2.5 · 官方直连(按秒) / 特价按秒 / 特价按次(30s 一口价)
  "seedance-2-5": {
    aspectRatios: ["16:9", "9:16", "21:9", "3:4", "1:1", "4:3"],
    durationOptions: [4, 5, 6, 8, 10, 12, 15, 20, 25, 29, 30],
    resolutionValues: ["480p", "720p", "1080p"],
  },
  "seedance-2-5-promo": {
    aspectRatios: ["16:9", "9:16", "21:9", "3:4", "1:1", "4:3"],
    durationOptions: [4, 5, 6, 8, 10, 12, 15, 20, 25, 29, 30],
    resolutionValues: ["480p", "720p", "1080p"],
  },
  "seedance-2-5-special": {
    aspectRatios: ["9:16", "16:9", "1:1", "4:3", "3:4", "21:9"],
    durationOptions: [30],
    resolutionValues: ["720p", "1080p"],
  },
  // Seedance 2.0 · 官方直连(按秒, 4~15s) / 特价按秒 / 特价按次(15s 一口价)
  "seedance-2-0-official": {
    aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
    durationOptions: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    resolutionValues: ["480p", "720p", "1080p", "4k"],
  },
  "seedance-2-0-promo": {
    aspectRatios: ["9:16", "16:9", "1:1", "4:3", "3:4", "21:9"],
    durationOptions: [4, 5, 6, 7, 8, 9, 10, 12, 15],
    resolutionValues: ["480p", "720p", "1080p", "4k"],
  },
  "seedance-2-0-special": {
    aspectRatios: ["9:16", "16:9", "21:9", "1:1", "4:3", "3:4"],
    durationOptions: [15],
    resolutionValues: ["480p", "720p"],
  },
  "seedance-2-0-ecom-special": {
    aspectRatios: ["9:16", "16:9", "1:1"],
    durationOptions: [5, 10, 15],
    resolutionValues: [],
  },
  "seedance-2-0-9tu-special": {
    aspectRatios: ["9:16", "16:9"],
    durationOptions: [5, 10, 15],
    resolutionValues: ["480p", "720p"],
  },
  "seedance-video-edit": {
    aspectRatios: [],
    durationOptions: [],
    resolutionValues: [],
  },
  // Veo / Sora
  "veo-3.1": {
    aspectRatios: ["16:9", "9:16"],
    durationOptions: [8],
    resolutionValues: ["720p", "1080p"],
  },
  "veo-3-1-manju-special": {
    aspectRatios: ["16:9", "9:16"],
    durationOptions: [8],
    resolutionValues: [],
  },
  "veo-4-omni": {
    aspectRatios: ["16:9", "9:16"],
    durationOptions: [3, 4, 5, 6, 7, 8, 9, 10],
    resolutionValues: ["720p", "1080p"],
  },
  "veo-4-omni-v2v": {
    aspectRatios: ["16:9", "9:16"],
    durationOptions: [],
    resolutionValues: [],
  },
  "sora-2-official": {
    aspectRatios: ["16:9", "9:16"],
    durationOptions: [4, 8, 12],
    resolutionValues: [],
  },
  // 可灵 Kling(含运动控制 / 数字人 / 对口型)
  "kling-v3": {
    aspectRatios: ["16:9", "9:16", "1:1"],
    durationOptions: [5, 10, 15],
    resolutionValues: ["720p", "1080p"],
  },
  // 可灵 4.0: 文档(ZN 2026-10-19)的 duration 是 3~30 的**逐秒枚举**, 不是 5/10/15/30 四档。
  // 之前只列四档, 16~29 秒这些中间值在 UI 上根本选不到。平台默认 3s, 但按「长镜头优先」
  // 的约定仍默认 30s(合法枚举内)。
  "kling-v4": {
    aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
    durationOptions: [
      3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
    ],
    resolutionValues: ["720p", "1080p"],
    defaultDuration: 30,
  },
  "kling-v3-omni-cankao": {
    aspectRatios: ["16:9", "9:16", "1:1"],
    durationOptions: [5, 6, 10, 15],
    resolutionValues: [],
  },
  "kling-v3-motion-control": {
    aspectRatios: ["16:9", "9:16", "1:1"],
    durationOptions: [],
    resolutionValues: ["720p", "1080p"],
  },
  "kling-3.0-turbo": {
    aspectRatios: ["16:9", "9:16"],
    durationOptions: [3, 5, 8, 10, 15],
    resolutionValues: ["720p"],
  },
  "kling-avatar": {
    aspectRatios: [],
    durationOptions: [],
    resolutionValues: [],
  },
  "kling-lip-sync": {
    aspectRatios: [],
    durationOptions: [],
    resolutionValues: [],
  },
  // MiniMax / Wan / Vidu / PixVerse / HappyHorse
  "minimax-h3": {
    aspectRatios: ["16:9", "9:16", "21:9", "4:3", "1:1", "3:4"],
    durationOptions: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    resolutionValues: ["768p", "2k"],
  },
  "minimax-hailuo-2-3": {
    aspectRatios: [],
    durationOptions: [6, 10],
    resolutionValues: ["768p", "1080p"],
  },
  "wan-3-0": {
    aspectRatios: ["16:9", "9:16", "3:4", "4:3", "1:1"],
    durationOptions: [
      4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
    ],
    resolutionValues: ["480p", "720p", "1080p"],
  },
  "wan-3-0-special": {
    aspectRatios: ["16:9", "9:16"],
    durationOptions: [5, 10, 15, 20, 25, 30],
    resolutionValues: ["720p", "1080p"],
  },
  "wan2.7-video": {
    aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4"],
    durationOptions: [2, 3, 4, 5, 6, 8, 10, 12, 15],
    resolutionValues: ["720p", "1080p"],
  },
  viduq3: {
    aspectRatios: ["16:9", "9:16", "4:3", "3:4", "1:1"],
    durationOptions: [4, 5, 8, 12, 16],
    resolutionValues: ["540p", "720p", "1080p"],
  },
  "pixverse-v6": {
    aspectRatios: ["16:9", "9:16", "1:1"],
    durationOptions: [5, 8],
    resolutionValues: ["720p", "1080p"],
  },
  "pixverse-c1": {
    aspectRatios: ["16:9", "9:16"],
    durationOptions: [5, 8],
    resolutionValues: ["720p", "1080p"],
  },
  "happyhorse-1-1": {
    aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "4:5", "5:4", "9:21", "21:9"],
    durationOptions: [3, 5, 10, 15],
    resolutionValues: ["720p", "1080p"],
  },
  // xAI Grok Imagine 视频族 —— 曾因名字含 imagine 被判成图片, 这里给出各自档位
  "grok-imagine-1.5": {
    aspectRatios: ["16:9", "9:16", "1:1"],
    durationOptions: [4, 6, 8, 10, 12, 15, 20, 30],
    resolutionValues: ["480p", "720p", "1080p"],
  },
  "grok-imagine-1-5-7tu-special": {
    aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"],
    durationOptions: [3, 5, 6, 8, 10, 12, 15],
    resolutionValues: ["480p", "720p"],
  },
  "grok-imagine-1.5-special": {
    aspectRatios: ["16:9", "9:16"],
    durationOptions: [6, 15],
    resolutionValues: ["720p"],
  },
  "grok-imagine-video": {
    aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4"],
    durationOptions: [3, 4, 5, 6, 8, 10, 12, 15, 20, 30],
    resolutionValues: ["480p", "720p"],
  },
  "grok-imagine-video-special": {
    aspectRatios: ["16:9", "9:16"],
    durationOptions: [6, 10],
    resolutionValues: ["720p"],
  },
  // 其它
  "omni-flash-1-1": {
    aspectRatios: ["16:9", "9:16"],
    durationOptions: [10],
    resolutionValues: ["720p", "1080p"],
  },
  "aliyun-video-superres": {
    aspectRatios: [],
    durationOptions: [],
    resolutionValues: [],
  },
};

// ---------------------------------------------------------------------------
// api666888 / 灵柯 AI「暗苗」链路
//
// 早期只有 9 个 seedance 模型, 档位靠「模型名里带 2.0 就 4~15 秒」硬推断; 2026-10-20
// 平台已有 74 个视频模型, 各家族档位完全不同(kling 5/10/15、gk-video 1~15、viduq4 3~16、
// omni-flash 4/6/8/10), 推断法必然给错档。
//
// 现在档位表整份抽到 `lingkeVideoOptions.ts` —— 由平台文档全量抓取生成(74/74),
// registry 只负责按模型名查表, 不再持有任何档位常量。
// ---------------------------------------------------------------------------

interface ZhiniaoVideoOptions {
  aspectRatios: string[];
  durationOptions: number[];
  resolutionValues: string[];
  /**
   * 是否来自逐模型登记表（只有登记表分支会置 true，族兜底一律缺省）。
   *
   * false/undefined = 平台新上、我们还没核过档位的模型。这类模型按「新模型先按
   * 30 秒默认」处理；一旦把它的真实枚举补进 `ZHINIAO_VIDEO_OPTION_TABLE`（或将来
   * 能从平台元数据直接读到时长），`listed` 变 true，默认值就改听登记表/平台声明的。
   */
  listed?: boolean;
  /** 登记表显式指定的默认秒数（见 `ZhiniaoVideoOptionEntry.defaultDuration`）。 */
  defaultDuration?: number;
}

function resolveZhiniaoVideoOptions(model: string): ZhiniaoVideoOptions {
  const normalized = model.trim().toLowerCase();
  const exact = ZHINIAO_VIDEO_OPTION_TABLE[normalized];
  if (exact) {
    return {
      // 文档没给画幅的模型(数字人 / 对口型 / 超分…)回落到通用三档, 不让控件空掉;
      // 时长同理(这类模型时长由参考素材决定)。
      aspectRatios: exact.aspectRatios.length ? exact.aspectRatios : ZHINIAO_DEFAULT_ASPECTS,
      durationOptions: exact.durationOptions.length ? exact.durationOptions : ZHINIAO_FALLBACK_DURATIONS,
      // 分辨率保持空数组: 注册表把「空」当作「该模型没有这个参数」, 直接隐藏控件。
      resolutionValues: exact.resolutionValues,
      listed: true,
      defaultDuration: exact.defaultDuration,
    };
  }
  // 未逐一登记的变体 SKU: 按模型族兜底。
  if (normalized.includes("seedance")) {
    return {
      aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
      durationOptions: [4, 5, 6, 8, 10, 12, 15, 20, 25, 29, 30],
      resolutionValues: ["480p", "720p", "1080p"],
    };
  }
  if (normalized.startsWith("veo")) {
    return {
      aspectRatios: ["16:9", "9:16"],
      durationOptions: [3, 4, 5, 6, 7, 8, 9, 10],
      resolutionValues: ["720p", "1080p"],
    };
  }
  if (normalized.startsWith("sora")) {
    return {
      aspectRatios: ["16:9", "9:16"],
      durationOptions: [4, 8, 12],
      resolutionValues: [],
    };
  }
  if (normalized.startsWith("kling")) {
    return {
      aspectRatios: ["16:9", "9:16", "1:1"],
      // 未登记的可灵 SKU: 按「新模型先给到 30s」处理, 具体档位等平台声明后再收窄。
      durationOptions: [5, 10, 15, 30],
      resolutionValues: ["720p", "1080p"],
    };
  }
  if (normalized.startsWith("minimax")) {
    return {
      aspectRatios: ["16:9", "9:16", "21:9", "4:3", "1:1", "3:4"],
      durationOptions: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      resolutionValues: ["768p", "2k"],
    };
  }
  if (normalized.startsWith("wan-3") || normalized.startsWith("wan3")) {
    return {
      aspectRatios: ["16:9", "9:16", "3:4", "4:3", "1:1"],
      durationOptions: Array.from({ length: 27 }, (_, index) => index + 4),
      resolutionValues: ["480p", "720p", "1080p"],
    };
  }
  if (normalized.startsWith("grok-imagine")) {
    return {
      aspectRatios: ["16:9", "9:16", "1:1"],
      durationOptions: [3, 4, 5, 6, 8, 10, 12, 15, 20, 30],
      resolutionValues: ["480p", "720p"],
    };
  }
  if (normalized.startsWith("pixverse") || normalized.startsWith("vidu") || normalized.startsWith("happyhorse")) {
    return {
      aspectRatios: ZHINIAO_DEFAULT_ASPECTS,
      durationOptions: [3, 5, 8, 10, 15],
      resolutionValues: ["720p", "1080p"],
    };
  }
  return {
    aspectRatios: ZHINIAO_DEFAULT_ASPECTS,
    durationOptions: ZHINIAO_FALLBACK_DURATIONS,
    resolutionValues: ["720p", "1080p"],
  };
}

/**
 * 知鸟视频节点的默认秒数（用户规则，2026-10-19）。
 *
 * 1. **已登记的模型**：沿用老习惯「有 5 就用 5」—— 短镜头便宜、试错成本低。
 * 2. **未登记的新模型**：默认 **30 秒**。可灵 v4 这类支持长镜头的模型越来越多，
 *    再默认 5s 等于把能力藏起来；用户想缩短随时能改。
 * 3. 拿不到 30 档（登记表把上限锁在 15 之类）就退到该模型的最大合法档位。
 *
 * 一旦能从平台元数据直接读到时长枚举（填入 `ZHINIAO_VIDEO_OPTION_TABLE` 即可），
 * 这条规则自动改听平台的 —— 判断依据就是 `listed`。
 */
function resolveZhiniaoDefaultDuration(options: ZhiniaoVideoOptions): number | undefined {
  const { durationOptions, defaultDuration } = options;
  if (durationOptions.length === 0) return undefined;
  // 登记表显式声明了默认档(如 kling-v4 = 30s)就以它为准, 但必须是合法枚举之一。
  if (defaultDuration !== undefined && durationOptions.includes(defaultDuration)) return defaultDuration;
  if (!options.listed) {
    return durationOptions.includes(30) ? 30 : durationOptions[durationOptions.length - 1];
  }
  return durationOptions.includes(5) ? 5 : durationOptions[0];
}

function resolveBinghuoVideoOptions(model: string): {
  aspectRatios: string[];
  durationOptions: number[];
  resolutionValues: string[];
} {
  const normalized = model.trim().toLowerCase();
  const aspectRatios =
    normalized === "minimax-h3-pro-768p" ? ["16:9", "9:16"] : ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];
  let durationOptions = Array.from({ length: 12 }, (_, index) => index + 4);
  if (normalized === "sd2.0-720p" || normalized === "sd2.0-720p-fast") {
    durationOptions = [5, 10, 15];
  } else if (normalized === "tj-sp2.5" || normalized === "sd2.5-720p-ch1") {
    durationOptions = [30];
  } else if (normalized === "sp2.5-720p-30s") {
    durationOptions = Array.from({ length: 15 }, (_, index) => index + 16);
  } else if (normalized === "sp2.5-720p") {
    durationOptions = Array.from({ length: 27 }, (_, index) => index + 4);
  } else if (normalized === "sp2.5-720p-15s") {
    durationOptions = Array.from({ length: 12 }, (_, index) => index + 4);
  } else if (
    normalized === "sd2-vip720p" ||
    normalized === "quanneng2.0" ||
    normalized === "sdquan-2-miao" ||
    normalized === "quanneng2.0-9tu"
  ) {
    durationOptions = [15];
  } else if (normalized === "wan3.0-480p" || normalized === "wan3.0-720p" || normalized === "wan3.0-1080p") {
    durationOptions = [...Array.from({ length: 11 }, (_, index) => index + 5), 20, 25, 30];
  } else if (["sd2.5-480p", "sd2.5-1080p", "sd2.5-backup", "sd2.5-720p-ch2"].includes(normalized)) {
    durationOptions = Array.from({ length: 26 }, (_, index) => index + 4);
  } else if (normalized.includes("sd2.5") || normalized.includes("rd2.5") || normalized.includes("gz-sd2.5")) {
    durationOptions = Array.from({ length: 27 }, (_, index) => index + 4);
  } else if (normalized.includes("bh2.5")) {
    // bh2.5 全系(bh2.5-1080p / bh2.5-720p …)平台口径是 **4~30 秒逐秒**(用户 2026-10-13 核对文档确认)。
    // 之前这一族没有任何登记, 于是和函数末尾的默认值撞在一起 —— 默认恰好也是 4~15, 而 UI 是用
    // `durationOptions` 的头/尾夹滑杆的, 症状就是「模型只能最高 15 秒」。**不能删这条去蹭默认值**:
    // 默认值将来若调整, bh2.5 会跟着漂。注意判据写 `bh2.5` 而不是 `sd2.5` —— 名字里是 `bh` 不是 `sd`,
    // 下面那条 `includes("sd2.5")` 兜不住它。
    durationOptions = Array.from({ length: 27 }, (_, index) => index + 4);
  } else if (normalized === "minimax-h3-pro-2k" || normalized === "hailuo-h3-2k") {
    durationOptions = normalized === "hailuo-h3-2k" ? [6, 10] : Array.from({ length: 12 }, (_, index) => index + 4);
  } else if (normalized === "grok-imagine-video" || normalized === "grok-imagine-video-1.5-preview") {
    durationOptions = Array.from({ length: 15 }, (_, index) => index + 1);
  }
  const resolution = normalized.includes("4k")
    ? "4K"
    : normalized.includes("2k")
      ? "2K"
      : normalized.includes("1080p")
        ? "1080P"
        : normalized.includes("768p")
          ? "768P"
          : normalized.includes("480p")
            ? "480P"
            : "720P";
  return { aspectRatios, durationOptions, resolutionValues: [resolution] };
}

/**
 * 字子动画视频按秒计价(来源: 平台 /api/pricing, `price_display_unit=second`)。
 * 2026-09-12 同步: H3 五档 + Kling Omni + doubao-seedance 全系 + wan3.0 + happyhorse。
 */
const ZZDH_VIDEO_PRICE_PER_SECOND: Record<string, number> = {
  "zzdh-minimax-h3-480p": 0.06,
  "zzdh-minimax-h3-720p": 0.09,
  "zzdh-minimax-h3-1080p": 0.12,
  "zzdh-minimax-h3-2k": 0.16,
  "zzdh-minimax-h3-4k": 0.24,
  "happyhorse-1.0-t2v-720p": 1.08,
  "happyhorse-1.0-t2v-1080p": 1.92,
  "happyhorse-1.0-i2v-720p": 1.08,
  "happyhorse-1.0-i2v-1080p": 1.92,
  "happyhorse-1.0-r2v-720p": 1.08,
  "happyhorse-1.0-r2v-1080p": 1.92,
  "happyhorse-1.0-video-edit-720p": 1.08,
  "happyhorse-1.0-video-edit-1080p": 1.92,
  "kling-v3-omni": 0.8,
  "kling-3.0-omni-720p-noref-mute": 0.51,
  "kling-3.0-omni-720p-noref-audio": 0.68,
  "kling-3.0-omni-720p-ref-mute": 0.77,
  "kling-3.0-omni-720p-ref-audio": 0.94,
  "kling-3.0-omni-1080p-noref-mute": 0.68,
  "kling-3.0-omni-1080p-noref-audio": 0.85,
  "kling-3.0-omni-1080p-ref-mute": 1.19,
  "kling-3.0-omni-1080p-ref-audio": 1.02,
  "doubao-seedance-2-480p": 0.49,
  "doubao-seedance-2-720p": 1.09,
  "doubao-seedance-2-1080p": 2.7,
  "doubao-seedance-2-4k": 5.56,
  "doubao-seedance-2-0-fast-480p": 0.4,
  "doubao-seedance-2-0-fast-720p": 0.88,
  "doubao-seedance-2-0-mini-480p": 0.25,
  "doubao-seedance-2-0-mini-720p": 0.55,
  "doubao-seedance-2-5-480p": 0.84,
  "doubao-seedance-2-5-720p": 1.81,
  "doubao-seedance-2-video-480p": 0.3,
  "doubao-seedance-2-video-720p": 0.67,
  "doubao-seedance-2-video-1080p": 1.66,
  "doubao-seedance-2-video-4k": 3.42,
  "doubao-seedance-2-0-fast-video-480p": 0.24,
  "doubao-seedance-2-0-fast-video-720p": 0.52,
  "doubao-seedance-2-0-mini-video-480p": 0.15,
  "doubao-seedance-2-0-mini-video-720p": 0.33,
  "doubao-seedance-2-5-video-480p": 0.51,
  "doubao-seedance-2-5-video-720p": 1.09,
  "doubao-seedance-2-video-优惠版-720p": 0.6,
  "doubao-seedance-2-video-优惠版-1080p": 1.2,
};

type BinghuoVideoPrice =
  | { type: "per-second"; amount: number }
  | { type: "per-run"; amount: number; durationThreshold?: number; thresholdAmount?: number };

const BINGHUO_VIDEO_PRICES: Record<string, BinghuoVideoPrice> = {
  // ── 2026-10-13 价格表同步（平台公开表格 gid=0）────────────────────────────
  // 新增渠道前缀：`db-`（56 折直连）/ `hs-`（官方直连）。原表这两族是本次新上架。
  "db-sd2.5-720p": { type: "per-second", amount: 0.85 },
  "db-sd2.5-1080p": { type: "per-second", amount: 2.15 },
  "hs-sd2.0-480p": { type: "per-second", amount: 0.42 },
  "hs-sd2.0-720p": { type: "per-second", amount: 0.58 },
  "hs-sd2.0-1080p": { type: "per-second", amount: 1.43 },
  "hs-sd2.0-4k": { type: "per-second", amount: 4.6 },
  "hs-sd2.5-480p": { type: "per-second", amount: 0.62 },
  "hs-sd2.5-720p": { type: "per-second", amount: 0.84 },
  "hs-sd2.5-1080p": { type: "per-second", amount: 2.19 },
  "hs-sd2.0-mini-480p": { type: "per-second", amount: 0.086 },
  "hs-sd2.0-mini-720p": { type: "per-second", amount: 0.18 },
  "hs-sd2.0-fast-480p": { type: "per-second", amount: 0.26 },
  "hs-sd2.0-fast-720p": { type: "per-second", amount: 0.46 },
  // 官转稳定
  "gz-sd480p": { type: "per-second", amount: 0.28 },
  "gz-sd720p": { type: "per-second", amount: 0.5 },
  "gz-sd1080p": { type: "per-second", amount: 1.15 },
  "gz-sd4k": { type: "per-second", amount: 2.2 },
  "gz-sd2.5-480p": { type: "per-second", amount: 0.46 },
  "gz-sd2.5-720p": { type: "per-second", amount: 0.92 },
  "gz-sd2.5-1080p": { type: "per-second", amount: 2.2 },
  sdvip720p: { type: "per-second", amount: 0.39 },
  sdvip1080p: { type: "per-second", amount: 0.68 },
  sdvip4k: { type: "per-second", amount: 3.85 },
  "sd2.5-720p-ch2": { type: "per-second", amount: 0.89 },
  "sd2.5-720p-ch3": { type: "per-second", amount: 0.75 },
  "sd2.5-480p": { type: "per-second", amount: 0.59 },
  // ⚠️ 计价方式变了：表里 720p 是「3.99 元/条（30 秒）」，480p/1080p 仍是元/秒。
  "sd2.5-720p": { type: "per-run", amount: 3.99 },
  "sd2.5-1080p": { type: "per-second", amount: 1.39 },
  "sd2.5-backup": { type: "per-second", amount: 0.65 },
  "sd2.5-cf-720p": { type: "per-second", amount: 0.46 },
  "sd2.5-cf-1080p": { type: "per-run", amount: 4.9 },
  "sd2.5-480p-ch1": { type: "per-run", amount: 7.5 },
  "sd2.5-720p-ch1": { type: "per-run", amount: 3.5 },
  "sd2.5-福利": { type: "per-run", amount: 11.8 },
  "rd2.5-480p": { type: "per-second", amount: 0.62 },
  "rd2.5-720p": { type: "per-second", amount: 0.73 },
  "rd2.0-480p": { type: "per-second", amount: 0.28 },
  "rd2.0-480pfast": { type: "per-second", amount: 0.3 },
  "rd2.0-720p": { type: "per-run", amount: 5.6 },
  "rd2.0-1080p": { type: "per-run", amount: 8.8 },
  "wan3.0-480p": { type: "per-second", amount: 0.31 },
  "wan3.0-720p": { type: "per-second", amount: 0.4 },
  "wan3.0-1080p": { type: "per-second", amount: 0.7 },
  "tj-wan3.0-1080p": { type: "per-second", amount: 0.41 },
  "tj-wan3.0-720p": { type: "per-second", amount: 0.31 },
  "tj-wan3-720p": { type: "per-second", amount: 0.36 },
  "minimax-h3-pro-768p": { type: "per-run", amount: 2.5 },
  "minimax-h3-pro-2k": { type: "per-run", amount: 0.25 },
  "minimax-h3-4k": { type: "per-second", amount: 0.36 },
  "hailuo-h3-2k": { type: "per-run", amount: 2.8 },
  "sp2.5-720p": { type: "per-run", amount: 8.99 },
  "sp2.5-720p-15s": { type: "per-run", amount: 4.9 },
  "sp2.5-720p-30s": { type: "per-run", amount: 6.1 },
  "tj-sp2.5": { type: "per-run", amount: 3.85 },
  "sd2-vip720p": { type: "per-run", amount: 3.55 },
  "quanneng2.0": { type: "per-run", amount: 5.9 },
  "quanneng2.0-9tu": { type: "per-run", amount: 3.5 },
  "b-quannengship2.0": { type: "per-run", amount: 2.9 },
  "sdquan-2-miao": { type: "per-second", amount: 0.38 },
  "sd2-福利": { type: "per-second", amount: 0.4 },
  "sd2-fast福利": { type: "per-run", amount: 2.85 },
  "sd2.0-720p": { type: "per-run", amount: 1.8 },
  "sd2.0-480p": { type: "per-run", amount: 1.99 },
  "sd2.0-720p-fast": { type: "per-run", amount: 4.65 },
  "kuaile1.1": { type: "per-second", amount: 0.18 },
  "wanneng1.1": { type: "per-second", amount: 0.18 },
  "me-kuaile1.0": { type: "per-run", amount: 1.85 },
  "kuaile1.0": { type: "per-run", amount: 1.85 },
  "grok-imagine-video": { type: "per-run", amount: 1.5 },
  "grok-imagine-video-1.5-preview": { type: "per-run", amount: 1.5 },
  "sora-v4-pro": { type: "per-second", amount: 0.45 },
  "bh2.5-720p": { type: "per-second", amount: 0.78 },
  "bh2.5-1080p": { type: "per-second", amount: 1.06 },
  "bh2.0-720p": { type: "per-second", amount: 0.55 },
  "bh2.0-480p": { type: "per-second", amount: 0.39 },
  "bh2.0-1080p": { type: "per-second", amount: 0.69 },
  "bh2.0-fast-480p": { type: "per-second", amount: 0.29 },
  "bh2.0-fast-720p": { type: "per-second", amount: 0.34 },
  "bh2.0-mini-480p": { type: "per-second", amount: 0.28 },
  "bh2.0-mini-720p": { type: "per-second", amount: 0.38 },
  "bh2.0-4k": { type: "per-second", amount: 3.68 },
  "bh2.04k": { type: "per-second", amount: 3.68 },
};

/** 炳火图片模型按张计价（全分辨率同价，2026-10-13 价格表同步）。 */
const BINGHUO_IMAGE_PRICES: Record<string, number> = {
  image4k: 0.18,
  image2k4k: 0.11,
  "image2-high": 0.2,
  image2: 0.035,
  "image2.5": 0.02,
  "image-2.5-flare": 0.02,
  "image-2.5-sunburst": 0.02,
  "gpt-image-2.5": 0.25,
  "gpt-image-2.5-flare": 0.25,
  "gpt-image-2.5-sunburst": 0.25,
  "nano-banana-pro": 0.2,
  "nano-banana-2": 0.12,
  "grok-imagine-image-2.0": 0.16,
  "grok-imagine-image": 0.12,
  "gemini-3-pro-image-preview": 0.15,
  "gemini-3.1-flash-image-preview": 0.15,
  "gemini-3.1-flash-image": 0.13,
  "by-image1k": 0.03,
  "by-image2k4k": 0.15,
  "cf-image4k": 0.06,
  midjourney: 0.056,
};

/** 字子动画图片按次计价(来源: 平台 /api/pricing, `price_display_unit=call`)。 */
const ZZDH_IMAGE_PRICES: Record<string, number> = {
  "qwen-image-2.0": 0.24,
  "qwen-image-2.0-pro": 0.6,
  "qwen-image-3.0": 0.21,
  "qwen-image-3.0-pro-1k": 0.3,
  "qwen-image-3.0-pro-2k": 0.6,
  "qwen-image-edit-max": 0.6,
  "qwen-image-max": 0.6,
  "z-image-turbo": 0.12,
  zimage: 1,
  "wan2.6-image": 0.24,
  "wan2.7-image": 0.24,
};

function resolveCustomImagePricing(apiId: string, apiBaseUrl: string, model: string) {
  const officialAmount = resolveOfficialModelPrice(
    useSettingsStore.getState().customApis.find((api) => api.id === apiId)?.modelPrices,
    model,
  );
  if (officialAmount != null) {
    return { quote: () => ({ amount: officialAmount, currency: "CNY" as const }) };
  }
  const normalizedApiId = apiId.trim().toLowerCase();
  // 知鸟 AI: 价格全部来自平台自己的估价接口, 且按分辨率/按秒分档(见 models/zhiniaoPricing.ts)。
  // 先于下面的固定价表判断, 因为它的档位维度比其它平台细。
  if (isZhiniaoProvider(apiId, apiBaseUrl)) {
    const zhiniaoPricing = createZhiniaoImagePricing(model);
    if (zhiniaoPricing) return zhiniaoPricing;
  }
  // WGSPAI(api.wgspai.cn): 图片一律 0.1 元/张(见 models/wgspaiPricing.ts)。
  if (isWgspaiProvider(apiId, apiBaseUrl)) {
    const wgspaiPricing = createWgspaiImagePricing(model);
    if (wgspaiPricing) return wgspaiPricing;
  }
  const isBinghuo = normalizedApiId === "binghuo" || apiBaseUrl.trim().toLowerCase().includes("api.7tai.cc");
  if (isBinghuo) {
    const amount = BINGHUO_IMAGE_PRICES[model.trim().toLowerCase()];
    if (amount == null) return undefined;
    return {
      quote: () => ({ amount, currency: "CNY" as const }),
    };
  }
  if (isZzdhProvider("", apiBaseUrl)) {
    const amount = ZZDH_IMAGE_PRICES[model.trim().toLowerCase()];
    if (amount == null) return undefined;
    return {
      quote: () => ({ amount, currency: "CNY" as const }),
    };
  }
  return undefined;
}

function resolveCustomVideoPricing(apiName: string, apiBaseUrl: string, model: string, isBinghuo: boolean) {
  const customApi = useSettingsStore
    .getState()
    .customApis.find(
      (api) =>
        api.name.trim().toLowerCase() === apiName.trim().toLowerCase() ||
        api.baseUrl.trim().toLowerCase() === apiBaseUrl.trim().toLowerCase(),
    );
  const officialAmount = resolveOfficialModelPrice(customApi?.modelPrices, model);
  if (officialAmount != null) {
    return {
      quote: () => ({ amount: officialAmount, currency: "CNY" as const }),
    };
  }
  const normalizedApiName = apiName.trim().toLowerCase();
  const normalized = model.trim().toLowerCase();
  // 知鸟 AI: 同一模型不同分辨率可能一个按秒、一个按次(wan-3-0), 所以 unit 写在表里,
  // 不在这里按平台统一假设(见 models/zhiniaoPricing.ts)。
  if (isZhiniaoProvider(apiName, apiBaseUrl)) {
    const zhiniaoPricing = createZhiniaoVideoPricing(model);
    if (zhiniaoPricing) return zhiniaoPricing;
  }
  // WGSPAI: 同样把 unit 写在表里 —— 视频族多为按次一口价, 但
  // seedance-2.0-720-new 是 0.25 元/秒(见 models/wgspaiPricing.ts)。
  if (isWgspaiProvider(apiName, apiBaseUrl)) {
    const wgspaiPricing = createWgspaiVideoPricing(model);
    if (wgspaiPricing) return wgspaiPricing;
  }
  if (isBinghuo) {
    const price = BINGHUO_VIDEO_PRICES[normalized];
    if (price) {
      return {
        quote: ({ extraParams }: { extraParams?: Record<string, unknown> }) => {
          const duration = Math.max(1, Number(extraParams?.duration) || 5);
          const amount =
            price.type === "per-second"
              ? price.amount * duration
              : price.durationThreshold != null && duration > price.durationThreshold
                ? (price.thresholdAmount ?? price.amount)
                : price.amount;
          return { amount, currency: "CNY" as const };
        },
      };
    }
  }
  if (normalizedApiName === "字子动画" || normalizedApiName === "字字动画" || isZzdhProvider("", apiBaseUrl)) {
    const perSecond = ZZDH_VIDEO_PRICE_PER_SECOND[normalized];
    if (perSecond != null) {
      return {
        quote: ({ extraParams }: { extraParams?: Record<string, unknown> }) => ({
          amount: perSecond * Math.max(1, Number(extraParams?.duration) || 5),
          currency: "CNY" as const,
        }),
      };
    }
    return undefined;
  }
  return undefined;
}

function resolveOfficialModelPrice(prices: Record<string, number> | undefined, model: string): number | undefined {
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
  return useSettingsStore.getState().customApis.flatMap((api) =>
    api.models
      .filter((model) => {
        const normalizedModel = model.trim().toLowerCase();
        // 灵柯登记成图片的两个 kling 模型名字会被视频规则抓走, 这里放行
        const isLingkeImageOverride =
          isLingkeBaseUrl(api.baseUrl) && LINGKE_IMAGE_NAME_OVERRIDES.includes(normalizedModel);
        return (
          isLingkeImageOverride
          || (!isVideoGenerationModelName(model)
            && !isAudioModelName(model)
            // 对话模型不进图片下拉: 转售平台把 GPT/Gemini 写成 tt-/gk- 代号, 旧分类器
            // 认不出来就把它们留在 models 里, 图片节点会多出一串根本出不了图的模型。
            && !isChatCompletionModelName(model)
            && !api.videoModels.some((videoModel) => videoModel.trim().toLowerCase() === normalizedModel)
            && !(api.audioModels ?? []).some((audioModel) => audioModel.trim().toLowerCase() === normalizedModel))
        );
      })
      .map((model) => {
        const modelId = buildCustomModelId(api.id, model);
        // 字子动画图片: 官方画幅枚举同为 16:9 / 9:16 / 1:1, 参考图字段 reference_images。
        const isZzdhImageApi = isZzdhProvider(api.id, api.baseUrl);
        // 灵柯的每个图片模型都有自己的比例/档位枚举(gk-image-2.0 没有 4K、
        // doubao-seedream-5-0-260128 只有 2K/3K …), 放开通用档位等于让用户
        // 选出平台必拒的值。表见 features/settings/lingkeModels.ts。
        const lingkeCapability = isLingkeBaseUrl(api.baseUrl)
          ? resolveLingkeImageCapability(model)
          : undefined;
        const imageAspectRatios = isZzdhImageApi
          ? [...ZZDH_ASPECT_RATIOS]
          : (resolveLingkeAspectRatios(lingkeCapability) ?? CUSTOM_ASPECT_RATIOS);
        // 档位常被平台写进模型名(qwen-image-3.0-pro-1k / flux-2k / sd-4k), 这类模型
        // 只能按名字里那一档请求; 读不到档位时才放开 1K/2K/4K 全档位。
        const resolutions = resolveLingkeImageResolutions(lingkeCapability)
          ?? resolveImageModelResolutionOptions(model);
        // Midjourney 单独一套语义: 一档 = 一组 4 张, 且有引擎/版本/风格化三个专属参数。
        // 见 models/midjourney.ts —— 没有这段, 面板上选的 count/bot_type 根本发不出去。
        const isMidjourney = isMidjourneyImageModel(model);
        return {
          id: modelId,
          mediaType: "image",
          displayName: `${api.name} · ${model}`,
          providerId: buildCustomProviderId(api.id),
          description: `${api.name} · ${model}`,
          eta: "1min",
          expectedDurationMs: 60000,
          defaultAspectRatio: "1:1",
          defaultResolution: resolutions[0]?.value ?? "1K",
          aspectRatios: imageAspectRatios.map((value) => ({ value, label: value })),
          resolutions,
          ...(isMidjourney
            ? {
                imagesPerCountUnit: MIDJOURNEY_IMAGES_PER_GROUP,
                extraParamsSchema: MIDJOURNEY_EXTRA_PARAMS,
                defaultExtraParams: MIDJOURNEY_DEFAULT_EXTRA_PARAMS,
              }
            : {}),
          ...(resolveCustomImagePricing(api.id, api.baseUrl, model)
            ? { pricing: resolveCustomImagePricing(api.id, api.baseUrl, model) }
            : {}),
          resolveRequest: ({ referenceImageCount }) => ({
            requestModel: modelId,
            modeLabel: referenceImageCount > 0 ? "编辑模式" : "生成模式",
          }),
        };
      }),
  );
}
