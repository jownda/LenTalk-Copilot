import {
  generateAudio,
  generateAudioAsset,
  generateSunoLyrics as generateAudioLyrics,
  generateImage,
  generateJimengCliVideo,
  generateRunningHubCliModel,
  generateVideo,
  getGenerateVideoJob,
  upscaleVideo as upscaleVideoCommand,
  getGenerateImageJob,
  setApiKey,
  submitGenerateImageJob,
  submitGenerateVideoJob,
  uploadZhiniaoReferenceAsset,
} from "@/commands/ai";
import { createCompactImageDataUrl, imageUrlToDataUrl } from "@/features/canvas/application/imageData";
import { useSettingsStore } from "@/stores/settingsStore";
import { JIMENG_CLI_PROVIDER_ID, resolveVideoModelProfile } from "@/features/canvas/models";
import { RUNNINGHUB_CLI_PROVIDER_ID } from "@/features/canvas/models";
import { useRunningHubCliStore } from "@/stores/runningHubCliStore";
import { toVideoGenerationRequest } from "@/features/canvas/application/videoGeneration";
import { isRjmVideoApiBaseUrl } from "@/commands/videoApi";
import { isZhenjianProvider } from "@/commands/zhenjianApi";
import { isZzdhProvider } from "@/commands/zzdhApi";
import {
  isRunningHubBaseUrl,
  RUNNINGHUB_VIDEO_TRANSPORT,
  buildRunningHubRequestBody,
  resolveRunningHubVideoEndpointForInput,
  resolveRunningHubVideoEndpoint,
  runningHubVideoExtraParams,
} from "@/commands/runningHubProtocol";
import { invoke } from "@tauri-apps/api/core";

type LocalVideoJob = { job_id: string; status: string; result: string | null; error: string | null };
// 本地 CLI 类视频链路(即梦 / Wan)只能在本机跑可执行文件, 仍由前端适配器承载;
// 其余视频协议全部由 Rust 后端任务执行器承载 —— 它们与后端任务共用同一套 job
// 状态接口, 画布无需区分轮询方式。
const compatibilityVideoJobs = new Map<string, LocalVideoJob>();

/** CLI 需要本地文件或 data URL；把画布的 asset/blob 来源先规整成可读的 data URL。 */
async function normalizeUrlsForCli(
  sources: string[] | undefined,
  kind: "image" | "video" | "audio",
): Promise<string[] | undefined> {
  if (!sources?.length) return undefined;
  return await Promise.all(
    sources.map(async (source) => {
      const value = source.trim();
      if (!value || /^https?:\/\//i.test(value) || /^data:/i.test(value)) return value;
      return kind === "image"
        ? await imageUrlToDataUrl(value)
        : await invoke<string>("load_media_data_url", { source: value });
    }),
  );
}

/**
 * 仍需前端兼容 worker 承载的视频协议 —— 本地 CLI 模型。
 *
 * 所有远端视频协议(kling-control / zhenjian-task-api / zzdh-v8-video /
 * sub2api-video / binghuo-video / wgspai-video / zhiniao-video / openai-video)
 * 已迁到 Rust 后端任务执行器。协议判定统一以 `video_transport` 为准, 因为
 * `injectCustomApiRequestMode` 会按平台 id 与 Base URL 把它注入好; 这里不再做
 * Base URL 兜底 —— 兜底会让本该交给后端的任务退回 WebView 内存 Map(刷新即丢,
 * 仍在平台生成且已计费的付费任务会被判成「中断」, 用户只能重新提交)。
 *
 * **必须与 Rust 的 `video_protocols::BACKEND_VIDEO_TRANSPORTS` 严格互补**:
 * 已迁后端的协议若仍留在这里, 任务会继续存在 WebView 内存 Map 里(刷新即丢);
 * 反过来, 未迁后端的协议若被交给后端, Rust 会直接拒绝(连请求都不发)。
 */
export function needsCompatibilityVideoWorker(payload: GenerateVideoPayload): boolean {
  return (
    payload.model.startsWith("wan-cli/") || payload.model.startsWith(`${JIMENG_CLI_PROVIDER_ID}/`) ||
    (payload.model.startsWith(`${RUNNINGHUB_CLI_PROVIDER_ID}/`) && !usesRunningHubCliDirectApi(payload.model))
  );
}

import type {
  AiGateway,
  GenerateAudioAssetPayload,
  GenerateAudioLyricsPayload,
  GenerateAudioPayload,
  GenerateImagePayload,
  GenerateVideoPayload,
  UpscaleVideoPayload,
} from "../application/ports";
import { generateWanCliVideo } from "@/commands/wanCli";
import { useWanCliStore } from "@/stores/wanCliStore";

function mergeNegativePrompt(payload: GenerateImagePayload): Record<string, unknown> | undefined {
  const extras = { ...(payload.extraParams ?? {}) };
  if (payload.negativePrompt && payload.negativePrompt.trim()) {
    // 兼容:同时写入 negative_prompt 与 extra_params.negative_prompt,
    // 让 Tauri 命令和上游 AI 后端都能读到。
    extras.negative_prompt = payload.negativePrompt.trim();
  }
  return Object.keys(extras).length > 0 ? extras : payload.extraParams;
}

function mergeImageCount(
  extraParams: Record<string, unknown> | undefined,
  imageCount: number | undefined,
): Record<string, unknown> | undefined {
  const numeric =
    typeof imageCount === "number" && Number.isFinite(imageCount)
      ? Math.max(1, Math.min(4, Math.round(imageCount)))
      : undefined;
  if (numeric == null) return extraParams;
  return { ...(extraParams ?? {}), image_count: numeric };
}

function withAspectRatioRequirement(prompt: string, aspectRatio: string): string {
  const match = aspectRatio.trim().match(/^(\d+)\s*:\s*(\d+)$/);
  if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0) {
    return prompt;
  }
  return `${prompt.trim()}\n\n[Required image aspect ratio: ${match[1]}:${match[2]}. Compose for this exact frame without borders or empty padding.]`;
}

/** 站点根地址: 去掉结尾斜杠与 /v1 后缀, 避免拼出 /v1/v1/... */
function toSiteRootBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "").replace(/\/+$/, "");
}

function isZhiniaoProviderId(providerId: string): boolean {
  return (
    providerId
      .trim()
      .replace(/^custom:/i, "")
      .toLowerCase() === "zhiniao"
  );
}

/** RunningHub 两条内置预设与 CLI 兼容 provider 的 id。 */
function isRunningHubProviderId(providerId: string): boolean {
  const id = providerId.trim().replace(/^custom:/i, "").toLowerCase();
  return id === "runninghub" || id === "runninghub-cn" || id === RUNNINGHUB_CLI_PROVIDER_ID;
}

const RUNNINGHUB_CLI_BASE_URL = "https://www.runninghub.cn";

/**
 * 官网已上线、但 rh-cli 内置 capabilities.json 尚未收录的模型家族。
 * 这些模型不能交给 `rh model run`，改走项目已有的 RunningHub 标准模型后端协议。
 */
export function usesRunningHubCliDirectApi(model: string): boolean {
  if (!model.startsWith(`${RUNNINGHUB_CLI_PROVIDER_ID}/`)) return false;
  const endpoint = model.slice(`${RUNNINGHUB_CLI_PROVIDER_ID}/`.length).trim().toLowerCase();
  return endpoint.startsWith("bytedance/seedance-2.5-token/") || endpoint.startsWith("minimax/hailuo-h3/");
}

function routeRunningHubCliDirectModel<T extends { model: string }>(payload: T): T {
  const endpoint = payload.model.slice(`${RUNNINGHUB_CLI_PROVIDER_ID}/`.length);
  return {
    ...payload,
    model: `custom:${RUNNINGHUB_CLI_PROVIDER_ID}/${endpoint}`,
  };
}

async function prepareRunningHubCliDirectVideo<T extends { model: string }>(payload: T): Promise<T> {
  const apiKey = (useSettingsStore.getState().apiKeys[RUNNINGHUB_CLI_PROVIDER_ID] ?? "").trim();
  if (!apiKey) {
    throw new Error("请先在 RunningHub CLI 设置中完成授权");
  }
  await setApiKey(`custom:${RUNNINGHUB_CLI_PROVIDER_ID}`, apiKey);
  return routeRunningHubCliDirectModel(payload);
}

function isZhiniaoBaseUrl(baseUrl: string): boolean {
  return /(?:cuai\.token6688\.com|api\.tokengo\.love)/i.test(baseUrl);
}

/**
 * 知鸟 AI(TokenGo)的生成类参考字段只收公网 URL, 不收 data URL / 原始字节。
 * 本地素材先走 POST /v1/files 换取公网 URL 再提交; 已是 http(s) 的原样透传。
 * 上传失败**必须显式报错**: 原样回退 data URL 会被上游直接关闭连接(只表现为
 * "Network error: error sending request"), 完全看不出是参考图不合规导致的。
 */
async function resolveZhiniaoImageReferences(
  referenceImages: string[] | undefined,
  providerId: string,
): Promise<string[] | undefined> {
  if (!referenceImages?.length) return referenceImages;
  const store = useSettingsStore.getState();
  const customApi = store.customApis.find((api) => `custom:${api.id}` === providerId);
  const baseUrl = toSiteRootBaseUrl(customApi?.baseUrl ?? "");
  if (!customApi || (!isZhiniaoProviderId(providerId) && !isZhiniaoBaseUrl(baseUrl))) {
    return referenceImages;
  }
  const apiKey = (store.apiKeys[providerId] ?? "").trim();
  if (!baseUrl || !apiKey) return referenceImages;
  const headers = { Authorization: `Bearer ${apiKey}` };
  return await Promise.all(
    referenceImages.map(async (source, index) => {
      if (/^https?:\/\//i.test(source.trim())) return source;
      try {
        return await uploadZhiniaoReferenceAsset(source, baseUrl, headers, index);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`知鸟 AI 参考图上传失败(第 ${index + 1} 张): ${reason}`);
      }
    }),
  );
}

/**
 * 知鸟 AI 把「参考图的用途」放在 model 参数 mode 上, 默认 text-to-image 会**忽略**
 * 随请求送来的参考图。有参考图时必须显式声明, 否则会静默退化成纯文生图:
 * 单图 = image-edit(基于已有图片编辑), 多图 = multi-reference(多图融合生成)。
 */
export function withZhiniaoImageMode<
  T extends { model: string; extraParams?: Record<string, unknown>; referenceImages?: string[] },
>(payload: T): T {
  const usableReferences = (payload.referenceImages ?? []).filter((item) => item?.trim());
  if (usableReferences.length === 0) return payload;
  const extraParams: Record<string, unknown> = { ...(payload.extraParams ?? {}) };
  if (extraParams.image_generation_mode != null) return payload;
  const providerId = payload.model.split("/")[0]?.replace(/^custom:/i, "") ?? "";
  const baseUrl = typeof extraParams.provider_base_url === "string" ? extraParams.provider_base_url : "";
  if (!isZhiniaoProviderId(providerId) && !isZhiniaoBaseUrl(baseUrl)) return payload;
  extraParams.image_generation_mode = usableReferences.length > 1 ? "multi-reference" : "image-edit";
  return { ...payload, extraParams };
}

/**
 * 自定义平台按设置里的请求模式注入 request_mode:
 * sync → 后端同步等待; async → 后端提交任务后轮询。
 */
/**
 * 自定义平台按请求模式注入 request_mode(显式双通道, Infinite-Canvas 风格):
 * sync → 后端同步等待(generate_image 直出); async → 后端提交任务后轮询。
 * 未指定时回退到设置里的 requestMode, 默认 sync。异步必须由平台配置显式开启。
 */
function injectCustomApiRequestMode<T extends { model: string; extraParams?: Record<string, unknown> }>(
  payload: T,
  forceMode?: "sync" | "async",
): T {
  if (!payload.model.startsWith("custom:")) {
    return payload;
  }
  const providerId = payload.model.split("/")[0].replace("custom:", "");
  const customApi = useSettingsStore.getState().customApis.find((api) => api.id === providerId);
  const requestMode = forceMode ?? customApi?.requestMode ?? "sync";
  const extraParams: Record<string, unknown> = {
    ...(payload.extraParams ?? {}),
  };
  // 平台设置是协议的唯一来源。节点可能保存了旧的 protocol 值，不能让
  // 旧值覆盖用户刚在设置中选择的 /v1/chat/completions 或 /v1/responses。
  const protocol =
    customApi?.protocol ??
    (extraParams.protocol === "responses" || extraParams.protocol === "chat" ? extraParams.protocol : "images");
  const referenceImageField =
    extraParams.reference_image_field === "input_image"
      ? "input_image"
      : extraParams.reference_image_field === "images"
        ? "images"
        : extraParams.reference_image_field === "reference_images"
          ? "reference_images"
          : (customApi?.referenceImageField ?? "image");
  const referenceImageEncoding =
    typeof extraParams.reference_image_encoding === "string"
      ? extraParams.reference_image_encoding
      : (customApi?.referenceImageEncoding ?? "auto");
  const imageTransport =
    typeof extraParams.image_transport === "string"
      ? extraParams.image_transport
      : (customApi?.imageTransport ?? "auto");
  if (requestMode === "async") {
    extraParams.request_mode = "async";
  } else {
    // 同步通道: 显式清掉 request_mode, 确保后端走 generate_image 直出而非异步任务
    delete extraParams.request_mode;
  }
  extraParams.protocol = protocol;
  if (customApi?.baseUrl) {
    extraParams.provider_base_url = customApi.baseUrl;
  }
  if (customApi?.referenceAssetUploadUrl) {
    extraParams.reference_asset_upload_url = customApi.referenceAssetUploadUrl;
  }
  if (customApi?.referenceAssetUploadToken) {
    extraParams.reference_asset_upload_token = customApi.referenceAssetUploadToken;
  }
  if (customApi?.capabilities?.confidence === "high" && customApi.capabilities.videoSubmitPath) {
    extraParams.video_submit_path = customApi.capabilities.videoSubmitPath;
  }
  if (customApi?.capabilities?.confidence === "high" && customApi.capabilities.videoQueryPath) {
    extraParams.video_query_path = customApi.capabilities.videoQueryPath;
  }
  if (customApi?.capabilities?.confidence === "high" && customApi.capabilities.videoTransport) {
    extraParams.video_transport = customApi.capabilities.videoTransport;
  }
  if (
    extraParams.video_reference_encoding == null &&
    customApi?.capabilities?.confidence === "high" &&
    customApi.capabilities.videoReferenceEncoding &&
    customApi.capabilities.videoReferenceEncoding !== "unknown"
  ) {
    extraParams.video_reference_encoding = customApi.capabilities.videoReferenceEncoding;
  }
  const providerBaseUrl = customApi?.baseUrl?.trim().toLowerCase() ?? "";
  // 帧间 API 是异步任务协议，图片和视频都必须由前端专有链路提交、轮询并
  // 携带 Bearer 下载结果。按 Base URL 兜底，用户手动新增或改平台名称也能命中。
  if (isZhenjianProvider(providerId, providerBaseUrl)) {
    extraParams.request_mode = "async";
    extraParams.image_transport = "zhenjian-task-api";
    extraParams.video_transport = "zhenjian-task-api";
  }
  // 字子动画: 图片/视频/音频三条链路都走专有协议(见 @/commands/zzdhApi)。
  // 判据同时看平台 id(可能是中文「字子动画」)与 Base URL。
  if (isZzdhProvider(providerId, providerBaseUrl)) {
    extraParams.video_transport = "zzdh-v8-video";
    extraParams.audio_transport = "zzdh-openai-audio";
    // 参考图字段: 官方模型页是 reference_images 对象数组。通用 'image' 写法平台虽会
    // 自动对齐, 这里仍统一升级成文档原生字段; 用户显式选过 images / input_image 则保留。
    if (referenceImageField === "image") {
      extraParams.reference_image_field = "reference_images";
    }
  }
  if (providerId === "sub2api-video" || isRjmVideoApiBaseUrl(providerBaseUrl)) {
    extraParams.video_transport = "sub2api-video";
  }
  if (providerId === "binghuo" || providerBaseUrl.includes("api.7tai.cc")) {
    extraParams.video_transport = "binghuo-video";
  }
  if (providerId === "wgspai" || providerBaseUrl.includes("api.wgspai.cn")) {
    extraParams.video_transport = "wgspai-video";
  }
  if (
    providerId === "zhiniao" ||
    providerBaseUrl.includes("cuai.token6688.com") ||
    providerBaseUrl.includes("api.tokengo.love")
  ) {
    extraParams.video_transport = "zhiniao-video";
  }
  // RunningHub: 「模型」就是官方端点 ID(`kling-v3.0-pro/image-to-video`), 而且
  // **每个端点的参数 schema 都不一样**(参考图字段有 imageUrl / firstImageUrl +
  // lastImageUrl / firstFrameUrl + lastFrameUrl 三种写法, 画幅有 aspectRatio /
  // ratio / size 三种), 还有一批必填但不由用户驱动的固定参数。平台对 schema 外的
  // 键回 PARAMS_INVALID 而**不是忽略**, 所以字段表必须随请求交给后端 ——
  // `video_protocols/runninghub.rs` 刻意不认识任何具体模型, 只按这份说明装填。
  // 端点 ID 是模型名里**第一段斜杠之后的全部**(端点自己还带斜杠, 不能按斜杠切段)。
  if (isRunningHubProviderId(providerId) || isRunningHubBaseUrl(customApi?.baseUrl)) {
    const videoPayload = payload as T & {
      referenceImages?: string[];
      referenceAudio?: string[];
      imageMode?: "reference" | "first-last";
    };
    extraParams.video_transport = RUNNINGHUB_VIDEO_TRANSPORT;
    if (providerId === RUNNINGHUB_CLI_PROVIDER_ID && extraParams.provider_base_url == null) {
      extraParams.provider_base_url = RUNNINGHUB_CLI_BASE_URL;
    }
    const endpointId = payload.model.split("/").slice(1).join("/").trim();
    const hasImages = (videoPayload.referenceImages?.length ?? 0) > 0;
    const hasVideos = Array.isArray(extraParams.reference_videos) && extraParams.reference_videos.length > 0;
    const hasAudios = (videoPayload.referenceAudio?.length ?? 0) > 0;
    const inputMode =
      videoPayload.imageMode === "first-last"
        ? "first-last"
        : hasVideos || hasAudios
          ? "multimodal"
          : hasImages
            ? "image"
            : "text";
    const resolvedEndpointId = resolveRunningHubVideoEndpointForInput(endpointId, inputMode);
    const requestEndpointId = resolvedEndpointId ?? endpointId;
    if (resolvedEndpointId && resolvedEndpointId !== endpointId) {
      // endpoint 是模型家族的 canonical id；真正请求端点按输入类型选。
      extraParams.runninghub_endpoint = requestEndpointId;
    }
    const spec = runningHubVideoExtraParams(requestEndpointId);
    if (spec) {
      extraParams.runninghub_video = spec;
    }
    // 查不到说明端点 ID 不在官方目录快照里(用户手填了别的端点), 此时不发说明,
    // 由后端回落到保守字段映射 —— 能提交就提交, 被平台拒也会带回可读的
    // errorCode / errorMessage, 比在这里硬拦更利于排查。
  }
  if (extraParams.reference_image_field == null) {
    extraParams.reference_image_field = referenceImageField;
  }
  if (extraParams.reference_image_encoding == null) {
    extraParams.reference_image_encoding = referenceImageEncoding;
  }
  if (extraParams.image_transport == null) {
    extraParams.image_transport = imageTransport;
  }
  return {
    ...payload,
    extraParams,
  };
}

/**
 * 参考图引用标记本地化:
 * 画布提示词里用 `@图N` 引用参考图(提交前被去掉 @ 变为 `图N`),
 * 参考图按数组顺序传给后端(image_urls / urls / image_base64s)。
 * 英文模型(fal / ppio gemini)的引用协议是 `Image N`, 中文 `图N` 会被当作普通文字,
 * 导致模型无法把引用与参考图对应 —— 这里按模型把标记转换成协议语言。
 * 仅当 token 前是行首/空白/标点时视为引用, 避免误伤正文里的"如图1所示"等普通文字。
 */
export function localizeReferenceTokens(prompt: string, model: string): string {
  if (!prompt) return prompt;
  const usesEnglishProtocol = model.startsWith("fal/") || model.startsWith("ppio/");
  if (!usesEnglishProtocol) return prompt;

  return prompt.replace(
    /(^|[\s，。；：、,.;:！？!?（）()【】[\]"'“”‘’])(@?\s*图)(\d+)/g,
    (_match, prefix: string, _marker: string, index: string) => `${prefix}Image ${index}`,
  );
}

const CUSTOM_IMAGE_REFERENCE_TOTAL_BUDGET = 8_000_000;
const CUSTOM_IMAGE_REFERENCE_MAX_DIMENSION = 2048;
const CUSTOM_IMAGE_REFERENCE_QUALITY = 0.9;
const imageReferenceDataUrlCache = new Map<string, string>();

/**
 * 参考图片直传: http(s) URL 直接透传(平台可下载); 本地路径/dataURL 转 base64 内嵌。
 * 部分图片中转会在接收多张 4K data URL 时直接关闭连接而不返回 HTTP 状态。
 * 自定义图片模型因此为本地大图预留总共约 8MB 的请求预算；小图不会重编码。
 */
async function normalizeReferenceUrls(
  urls: string[] | undefined,
  options?: { compactCustomImages?: boolean },
): Promise<string[] | undefined> {
  if (!urls?.length) return undefined;
  const compactCustomImages = options?.compactCustomImages === true;
  const nonEmptyUrls = urls.map((url) => url.trim()).filter(Boolean);
  const perImageBudget = Math.max(
    1_500_000,
    Math.floor(CUSTOM_IMAGE_REFERENCE_TOTAL_BUDGET / Math.max(1, nonEmptyUrls.length)),
  );

  return await Promise.all(
    nonEmptyUrls.map(async (url) => {
      if (/^https?:\/\//i.test(url)) return url;

      const rawDataUrl = imageReferenceDataUrlCache.get(url) ?? (await imageUrlToDataUrl(url));
      imageReferenceDataUrlCache.set(url, rawDataUrl);
      if (!compactCustomImages || rawDataUrl.length <= perImageBudget) return rawDataUrl;

      return await createCompactImageDataUrl(
        url,
        CUSTOM_IMAGE_REFERENCE_MAX_DIMENSION,
        CUSTOM_IMAGE_REFERENCE_QUALITY,
        perImageBudget,
      );
    }),
  );
}

/**
 * 平台侧是**远端**去下载参考图的: 本机/内网地址(loopback、私网段、.local 等)
 * 远端一定取不到, 实测提交后异步失败 `invalid reference image: upstream returned HTTP 502`。
 * 这类地址必须先在本地读成 data URL 再交出, 不能当公网 URL 直传。
 */
export function isPubliclyReachableHttpUrl(source: string): boolean {
  let host: string;
  try {
    host = new URL(source).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) return false;
  if (host.startsWith("[") || host.includes(":")) {
    // IPv6: 环回 / 唯一本地地址(fc00::/7) / 链路本地(fe80::/10)
    const bare = host.replace(/^\[|\]$/g, "");
    if (bare === "::1" || bare === "::") return false;
    if (/^f[cd]/i.test(bare) || /^fe[89ab]/i.test(bare)) return false;
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const [a, b] = host.split(".").map(Number);
    if (a === 0 || a === 127 || a === 10) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
  }
  return true;
}

/** 视频参考图默认使用 OpenAI Video API 可接受的 URL / Data URL。 */
async function normalizeVideoReferenceImages(
  imageUrls: string[] | undefined,
  extraParams: Record<string, unknown> | undefined,
): Promise<string[] | undefined> {
  if (!imageUrls?.length) return undefined;
  const useZzdhCompactImage = extraParams?.video_transport === "zzdh-v8-video";
  const videoEncoding =
    extraParams?.video_reference_encoding === "raw_base64"
      ? "raw_base64"
      : extraParams?.video_reference_encoding === "url"
        ? "url"
        : "data_url";
  // zzdh 官方文档: 素材支持 data: base64, 单图上限 20MB。
  // 但整包 task payload 有限制(实测传大图会 HTTP 400 task payload too large)。
  // 本地图策略: 小图(≤预算)无损直传, 大图压缩到 2048px/0.9(接近视觉无损);
  // 总 data URL 预算控制在 ~3MB, 多图按图数分摊, 单图下限 400KB。
  const zzdhImageBudget = Math.max(400_000, Math.floor(3_000_000 / Math.max(1, imageUrls.length)));
  const zzdhMaxDimension = 2048;
  const zzdhQuality = 0.9;

  return await Promise.all(
    imageUrls.map(async (imageUrl) => {
      const source = imageUrl.trim();
      if (!source) return source;
      if (/^https?:\/\//i.test(source)) {
        if (!useZzdhCompactImage) return source;
        // 官方文档: 素材支持公网 HTTP(S) URL 或 data: Base64。
        // 公网 URL 且路径带图片扩展名 → 直接无损透传(官方最清晰方式);
        // 无扩展名的签名 URL 可能被上游拒绝(Kling 文档), 才压缩成 data URL 兜底。
        if (isPubliclyReachableHttpUrl(source) && /\.(jpe?g|png|webp|gif|bmp|heic)(\?|#|$)/i.test(source)) {
          return source;
        }
        try {
          return await createCompactImageDataUrl(source, zzdhMaxDimension, zzdhQuality, zzdhImageBudget);
        } catch {
          // If a remote host blocks browser-side image reads, its public URL is
          // still usable by the provider and is much smaller than a data URL.
          return source;
        }
      }
      const dataUrl = useZzdhCompactImage
        ? await resolveZzdhReferenceDataUrl(source, zzdhMaxDimension, zzdhQuality, zzdhImageBudget)
        : await imageUrlToDataUrl(source);
      if (videoEncoding === "raw_base64" && dataUrl.startsWith("data:")) {
        return dataUrl.split(",", 2)[1] ?? dataUrl;
      }
      return dataUrl;
    }),
  );
}

/**
 * 本地图最清晰策略: 先转无损原始 data URL, 未超预算直接使用(完全不损失画质);
 * 超预算(大图/多图)才压缩到 maxDimension / quality, 保证请求体不超限。
 */
async function resolveZzdhReferenceDataUrl(
  source: string,
  maxDimension: number,
  quality: number,
  budget: number,
): Promise<string> {
  const cacheKey = source.trim();
  const cached = referenceDataUrlCache.get(cacheKey);
  const rawDataUrl = cached ?? (await imageUrlToDataUrl(source));
  if (!cached) {
    referenceDataUrlCache.set(cacheKey, rawDataUrl);
  }
  if (rawDataUrl.length <= budget) {
    return rawDataUrl;
  }
  return await createCompactImageDataUrl(source, maxDimension, quality, budget);
}

const referenceDataUrlCache = new Map<string, string>();

export const tauriAiGateway: AiGateway = {
  setApiKey: async (provider, apiKey) => {
    if (provider === RUNNINGHUB_CLI_PROVIDER_ID) {
      await setApiKey(`custom:${RUNNINGHUB_CLI_PROVIDER_ID}`, apiKey);
      return;
    }
    await setApiKey(provider, apiKey);
  },
  generateImage: async (payload: GenerateImagePayload) => {
    // 显式同步通道(等价 Infinite-Canvas /api/generate): 强制 request_mode=sync,
    // 后端走 generate_image 直出, 不创建异步任务, 避免 poll 不收敛导致的永久转圈。
    const providerId = payload.model.split("/")[0]?.replace(/^custom:/i, "") ?? "";
    const providerBaseUrl =
      typeof payload.extraParams?.provider_base_url === "string"
        ? payload.extraParams.provider_base_url
        : (useSettingsStore.getState().customApis.find((api) => api.id === providerId)?.baseUrl ?? "");
    const injected = withZhiniaoImageMode(
      injectCustomApiRequestMode(payload, isZhenjianProvider(providerId, providerBaseUrl) ? "async" : "sync"),
    );
    // 图片直传: http URL 透传。本地多张大图为自定义中转压缩到安全请求体大小。
    const normalizedReferenceImages = await normalizeReferenceUrls(injected.referenceImages, {
      compactCustomImages: injected.model.startsWith("custom:"),
    });
    // 知鸟 AI 只收公网 URL, 本地参考图先上传 /v1/files 换 URL。
    const referenceImages = await resolveZhiniaoImageReferences(
      normalizedReferenceImages,
      injected.model.split("/")[0] ?? "",
    );
    const mergedExtraParams = mergeImageCount(mergeNegativePrompt(injected), payload.imageCount);

    return await generateImage({
      prompt: localizeReferenceTokens(withAspectRatioRequirement(payload.prompt, payload.aspectRatio), payload.model),
      negative_prompt: payload.negativePrompt,
      model: payload.model,
      size: payload.size,
      aspect_ratio: payload.aspectRatio,
      image_count: payload.imageCount,
      reference_images: referenceImages,
      extra_params: mergedExtraParams,
    });
  },
  submitGenerateImageJob: async (payload: GenerateImagePayload) => {
    // 只有平台明确配置 requestMode=async 时才进入任务轮询；普通 OpenAI
    // 兼容接口走同步提交，避免猜测不存在的查询端点导致永久 pending。
    const injected = withZhiniaoImageMode(injectCustomApiRequestMode(payload));
    // 图片直传: http URL 透传。本地多张大图为自定义中转压缩到安全请求体大小。
    const normalizedReferenceImages = await normalizeReferenceUrls(injected.referenceImages, {
      compactCustomImages: injected.model.startsWith("custom:"),
    });
    const referenceImages = await resolveZhiniaoImageReferences(
      normalizedReferenceImages,
      injected.model.split("/")[0] ?? "",
    );
    const mergedExtraParams = mergeImageCount(mergeNegativePrompt(injected), payload.imageCount);
    // 即梦 CLI 的画幅由 `--ratio` 直接决定, 不需要(也不该)往提示词里追加画幅约束;
    // 其余平台依赖这句英文兜底上游忽略 aspect_ratio 参数的情况。
    // 这里按整个 provider 前缀判断: 普通图片(`image-*`)与超清(`upscale`)都算。
    const isJimengCliImage = payload.model.startsWith(`${JIMENG_CLI_PROVIDER_ID}/`);
    const prompt = localizeReferenceTokens(
      isJimengCliImage ? payload.prompt : withAspectRatioRequirement(payload.prompt, payload.aspectRatio),
      payload.model,
    );
    return await submitGenerateImageJob({
      prompt,
      negative_prompt: payload.negativePrompt,
      model: payload.model,
      size: payload.size,
      aspect_ratio: payload.aspectRatio,
      image_count: payload.imageCount,
      reference_images: referenceImages,
      extra_params: mergedExtraParams,
    });
  },
  getGenerateImageJob,
  getGenerateVideoJob: async (jobId: string) => compatibilityVideoJobs.get(jobId) ?? (await getGenerateVideoJob(jobId)),
  submitGenerateVideoJob: async (payload: GenerateVideoPayload) => {
    const routedPayload = usesRunningHubCliDirectApi(payload.model)
      ? await prepareRunningHubCliDirectVideo(payload)
      : payload;
    // 先按平台设置补全协议参数, 再判定由谁承载这次视频任务。
    // 节点上保存的 extraParams 通常只含模型自身字段, video_transport 与
    // provider_base_url 都是由 injectCustomApiRequestMode 从平台配置(Base URL /
    // capabilities)推导出来的。若只用裸 payload 判定, 炳火 / WGSPAI 这类靠 Base URL
    // 推导 transport 的平台会被误判成通用 OpenAI 视频协议而投给后端任务执行器;
    // 后者对白名单之外的协议直接返回 InvalidRequest, 连一个网络请求都不会发出
    // —— 表现为「点了生成但平台收不到请求」。
    const normalized = injectCustomApiRequestMode(routedPayload, "async");
    if (needsCompatibilityVideoWorker(routedPayload) || needsCompatibilityVideoWorker(normalized)) {
      const jobId = crypto.randomUUID();
      compatibilityVideoJobs.set(jobId, { job_id: jobId, status: "running", result: null, error: null });
      // 这里仍传原始 payload: 注入交给 generateVideo 内部统一处理 —— 它还会顺带
      // 保留「节点显式选择的 transport 优先」的补偿分支(见下 :619), 提前注入会把
      // 用户的选择覆盖掉。注意本分支现在只承载本地 CLI 模型；RunningHub 官网
      // 新增但 rh-cli 目录尚未同步的模型会在上面改走可恢复的后端协议：
      // 8 条远程协议已全部由后端任务执行器承载, 不再走这里。
      void tauriAiGateway.generateVideo(routedPayload).then(
        (result: string) =>
          compatibilityVideoJobs.set(jobId, { job_id: jobId, status: "succeeded", result, error: null }),
        (error: unknown) =>
          compatibilityVideoJobs.set(jobId, {
            job_id: jobId,
            status: "failed",
            result: null,
            error: error instanceof Error ? error.message : String(error),
          }),
      );
      return jobId;
    }
    // 复用上面已注入的结果, 不再二次注入。能走到这里说明该平台确实由后端
    // OpenAI 兼容视频任务执行器承载(transport 为空或 openai-video)。
    const injected = normalized;
    const unifiedRequest = toVideoGenerationRequest(routedPayload);
    const imageResources =
      routedPayload.imageMode === "first-last"
        ? [unifiedRequest.firstFrame, unifiedRequest.lastFrame].filter(
            (resource): resource is NonNullable<typeof resource> => Boolean(resource),
          )
        : unifiedRequest.referenceImages;
    const imageSources = imageResources.map((resource) => resource.source);
    // 知鸟只收公网 URL(videoReferenceEncoding: url): 本地素材先经 /v1/files 换成 URL
    // 再交给后端任务执行器; 其余平台仍走通用规整。
    const referenceImages =
      injected.extraParams?.video_transport === "zhiniao-video"
        ? await resolveZhiniaoImageReferences(imageSources, payload.model.split("/")[0] ?? "")
        : await normalizeVideoReferenceImages(imageSources, injected.extraParams);
    return await submitGenerateVideoJob({
      prompt: unifiedRequest.prompt,
      model: unifiedRequest.modelId,
      duration: unifiedRequest.duration,
      aspect_ratio: unifiedRequest.aspectRatio,
      video_resolution: unifiedRequest.videoResolution,
      image_mode: routedPayload.imageMode,
      reference_images: referenceImages,
      reference_audio: unifiedRequest.referenceAudio.map((resource) => resource.source.trim()).filter(Boolean),
      extra_params: injected.extraParams,
    });
  },
  generateVideo: async (payload: GenerateVideoPayload) => {
    if (usesRunningHubCliDirectApi(payload.model)) {
      return await tauriAiGateway.generateVideo(await prepareRunningHubCliDirectVideo(payload));
    }
    if (payload.model.startsWith("wan-cli/")) {
      return generateWanCliVideo({
        client_job_id: payload.clientJobId,
        executable: useWanCliStore.getState().executable,
        prompt: payload.prompt,
        model_version: payload.model.slice("wan-cli/".length),
        duration: payload.duration,
        aspect_ratio: payload.aspectRatio,
        video_resolution: payload.videoResolution,
        image_mode: payload.imageMode,
        reference_images: await normalizeReferenceUrls(payload.referenceImages),
        reference_audio: payload.referenceAudio,
      });
    }
    if (payload.model.startsWith(`${JIMENG_CLI_PROVIDER_ID}/`)) {
      const referenceImages = await normalizeReferenceUrls(payload.referenceImages);
      const referenceAudio = payload.referenceAudio?.map((audioUrl) => audioUrl.trim()).filter(Boolean);
      const modelVersion = payload.model.slice(`${JIMENG_CLI_PROVIDER_ID}/`.length);

      return await generateJimengCliVideo({
        client_job_id: payload.clientJobId,
        executable: useSettingsStore.getState().jimengCli.executable,
        prompt: payload.prompt,
        model_version: modelVersion,
        duration: payload.duration,
        aspect_ratio: payload.aspectRatio,
        video_resolution: payload.videoResolution,
        image_mode: payload.imageMode,
        reference_images: referenceImages,
        reference_audio: referenceAudio,
      });
    }
    if (payload.model.startsWith(`${RUNNINGHUB_CLI_PROVIDER_ID}/`)) {
      const canonicalEndpoint = payload.model.slice(`${RUNNINGHUB_CLI_PROVIDER_ID}/`.length);
      const sources = await normalizeUrlsForCli(payload.referenceImages, "image");
      const videos = await normalizeUrlsForCli(
        payload.extraParams?.reference_videos as string[] | undefined,
        "video",
      );
      const audios = await normalizeUrlsForCli(payload.referenceAudio, "audio");
      const inputMode = payload.imageMode === "first-last"
        ? "first-last"
        : videos?.length || audios?.length
          ? "multimodal"
          : sources?.length
            ? "image"
            : "text";
      const endpoint = resolveRunningHubVideoEndpointForInput(canonicalEndpoint, inputMode) ?? canonicalEndpoint;
      const spec = resolveRunningHubVideoEndpoint(endpoint);
      const body = spec
        ? buildRunningHubRequestBody(spec, {
            prompt: payload.prompt,
            images: sources ?? [],
            videos,
            audios,
            duration: payload.duration,
            aspectRatio: payload.aspectRatio,
            resolution: payload.videoResolution,
          })
        : {};
      return await generateRunningHubCliModel({
        executable: useRunningHubCliStore.getState().executable,
        endpoint,
        prompt: payload.prompt,
        images: sources,
        video: videos?.[0],
        audio: audios?.[0],
        params: Object.entries(body)
          .filter(([key]) => key !== (spec?.fields.prompt ?? "prompt") && ![spec?.fields.image, spec?.fields.imageList, spec?.fields.video, spec?.fields.videoList, spec?.fields.audio, spec?.fields.audioList].includes(key))
          .map(([key, value]) => `${key}=${typeof value === "boolean" ? String(value) : String(value)}`),
        output_kind: "video",
      });
    }

    // 视频语义固定为异步任务(提交+轮询), 不受图片默认 sync 影响
    const requestedTransport = payload.extraParams?.video_transport;
    const injected = injectCustomApiRequestMode(payload, "async");
    // 动作控制 / 对口型是 Kling 专用 endpoint, 字子动画是 /v8 专用 endpoint: 两者
    // 都不能被平台级探测出来的通用视频 transport 覆盖。这里必须**回填节点自己选中的
    // 那个值** —— 早先写死成 "kling-control" 会把字子动画节点错路由到 Kling 接口。
    if (requestedTransport === "kling-control" || requestedTransport === "zzdh-v8-video") {
      injected.extraParams = {
        ...(injected.extraParams ?? {}),
        video_transport: requestedTransport,
      };
    }
    const profile = resolveVideoModelProfile(
      payload.model,
      typeof injected.extraParams?.provider_base_url === "string" ? injected.extraParams.provider_base_url : undefined,
    );
    if (profile.status === "pending-adaptation") {
      throw new Error(profile.unavailableReason ?? "该视频模型尚未完成独立适配");
    }
    const unifiedRequest = toVideoGenerationRequest(payload);
    const imageResources =
      payload.imageMode === "first-last"
        ? [unifiedRequest.firstFrame, unifiedRequest.lastFrame].filter(
            (resource): resource is NonNullable<typeof resource> => Boolean(resource),
          )
        : unifiedRequest.referenceImages;
    const referenceImages = await normalizeVideoReferenceImages(
      imageResources.map((resource) => resource.source),
      injected.extraParams,
    );
    // 音频直传: 直接把上游音频 URL 数组透传给后端(不做 /v1/files 上传),
    // 由后端按 audio_url / audio_urls 字段提交给平台。
    const referenceAudio = unifiedRequest.referenceAudio
      .map((resource) => resource.source)
      .map((audioUrl) => audioUrl.trim())
      .filter(Boolean);
    return await generateVideo({
      prompt: unifiedRequest.prompt,
      model: unifiedRequest.modelId,
      duration: unifiedRequest.duration,
      aspect_ratio: unifiedRequest.aspectRatio,
      video_resolution: unifiedRequest.videoResolution,
      image_mode: payload.imageMode,
      reference_images: referenceImages,
      reference_audio: referenceAudio,
      extra_params: injected.extraParams,
    });
  },
  upscaleVideo: async (payload: UpscaleVideoPayload) => {
    const api = useSettingsStore
      .getState()
      .customApis.find((item) => item.id === payload.model.split("/")[0]?.replace("custom:", ""));
    const providerBaseUrl =
      typeof payload.extraParams?.provider_base_url === "string"
        ? payload.extraParams.provider_base_url
        : (api?.baseUrl ?? "");
    return await upscaleVideoCommand({
      videoSource: payload.videoSource,
      model: payload.model,
      tier: payload.tier,
      bitRate: payload.bitRate,
      extra_params: { ...payload.extraParams, provider_base_url: providerBaseUrl },
    });
  },
  /**
   * 音频生成(语音合成 / 音效 / 音乐)。
   *
   * 三条互不相同的链路, 由适配层按模型名与平台分流:
   *   - MiniMax 三件套 → speech-2.8 (同步二进制)
   *   - 字子动画        → /v1/audio/speech | /sound-effects | /music (同步二进制)
   *   - 知鸟 Suno       → /v1/audio/speech/async + /v1/tasks/{id} (**异步轮询**)
   *   - 其余平台        → OpenAI 兼容 /v1/audio/speech
   */
  generateAudio: async (payload: GenerateAudioPayload) => {
    if (payload.model.startsWith(`${RUNNINGHUB_CLI_PROVIDER_ID}/`)) {
      const endpoint = payload.model.slice(`${RUNNINGHUB_CLI_PROVIDER_ID}/`.length);
      const params = [
        payload.voice && endpoint.includes("speech") ? `voice_id=${payload.voice}` : "",
        payload.voice && endpoint.includes("doubao") ? `speaker=${payload.voice}` : "",
        payload.format ? `format=${payload.format}` : "",
        payload.suno?.title ? `title=${payload.suno.title}` : "",
        payload.suno?.operation === "generate" ? `description=${payload.prompt}` : "",
        payload.suno?.operation === "custom" ? `tags=${payload.suno.style ?? ""}` : "",
        payload.suno?.operation === "custom" ? `title=${payload.suno.title ?? ""}` : "",
        payload.suno?.operation === "custom" ? `prompt=${payload.lyrics ?? payload.prompt}` : "",
        endpoint.includes("suno") && endpoint.endsWith("/single")
          ? `make_instrumental=${payload.suno?.mode === "instrumental"}`
          : "",
        endpoint.includes("music-2.6") ? `lyrics=${payload.lyrics ?? payload.prompt}` : "",
      ].filter(Boolean);
      return await generateRunningHubCliModel({
        executable: useRunningHubCliStore.getState().executable,
        endpoint,
        prompt: endpoint.includes("speech") || endpoint.includes("doubao") ? payload.prompt : undefined,
        params,
        output_kind: "audio",
      });
    }
    const injected = injectCustomApiRequestMode(payload);
    return await generateAudio({
      prompt: payload.prompt,
      model: injected.model,
      audio_kind: payload.audioKind,
      voice: payload.voice,
      reference_audio: payload.referenceAudio,
      emotion: payload.emotion,
      emotion_intensity: payload.emotionIntensity,
      instructions: payload.instructions,
      speed: payload.speed,
      format: payload.format,
      duration_seconds: payload.durationSeconds,
      music_length_ms: payload.musicLengthMs,
      lyrics: payload.lyrics,
      voice_id: payload.voiceId,
      mmx_params: payload.mmxParams,
      suno_operation: payload.suno?.operation,
      suno_version: payload.suno?.version,
      suno_mode: payload.suno?.mode,
      suno_style: payload.suno?.style,
      suno_title: payload.suno?.title,
      suno_vocal_gender: payload.suno?.vocalGender,
      suno_negative_tags: payload.suno?.negativeTags,
      suno_clip_id: payload.suno?.clipId,
      suno_continue_clip_id: payload.suno?.continueClipId,
      suno_continue_at: payload.suno?.continueAt,
      suno_cover_clip_id: payload.suno?.coverClipId,
      extra_params: injected.extraParams,
    });
  },
  /**
   * 创建音色资产(音色克隆 / 音色设计)。
   *
   * 与 `generateAudio` 分开是刻意的: 这两个能力**产出 voice_id 而不是音频**, 且都是
   * 按次一次性计费(⚡2.2 上下)。混进同一个入口会让「生成音频」按钮在克隆页上
   * 发出一个语义完全不同的请求。
   */
  generateAudioAsset: async (payload: GenerateAudioAssetPayload) => {
    const injected = injectCustomApiRequestMode(payload);
    return await generateAudioAsset({
      model: injected.model,
      prompt: payload.prompt,
      voiceId: payload.voiceId,
      sampleAudio: payload.sampleAudio,
      previewText: payload.previewText,
      format: payload.format,
      extra_params: injected.extraParams,
    });
  },
  /**
   * 按主题生成歌词文本。
   *
   * 同样与 `generateAudio` 分开: 它的产出是**文本**, 返回的是 `string` 而不是媒体路径。
   * 挂在音乐页歌词框旁的「AI 写词」按钮上, 结果直接回填歌词框。
   */
  generateAudioLyrics: async (payload: GenerateAudioLyricsPayload) => {
    const injected = injectCustomApiRequestMode(payload);
    return await generateAudioLyrics({
      prompt: payload.prompt,
      model: injected.model,
      extra_params: injected.extraParams,
    });
  },
};
