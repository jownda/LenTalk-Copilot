import {
  generateAudio,
  generateImage,
  generateJimengCliVideo,
  generateVideo,
  upscaleVideo as upscaleVideoCommand,
  getGenerateImageJob,
  setApiKey,
  submitGenerateImageJob,
  uploadZhiniaoReferenceAsset,
} from '@/commands/ai';
import {
  createCompactImageDataUrl,
  imageUrlToDataUrl,
} from '@/features/canvas/application/imageData';
import { useSettingsStore } from '@/stores/settingsStore';
import { JIMENG_CLI_PROVIDER_ID, resolveVideoModelProfile } from '@/features/canvas/models';
import { toVideoGenerationRequest } from '@/features/canvas/application/videoGeneration';
import { isRjmVideoApiBaseUrl } from '@/commands/videoApi';
import { isZhenjianProvider } from '@/commands/zhenjianApi';
import { isZzdhProvider } from '@/commands/zzdhApi';

import type { AiGateway, GenerateAudioPayload, GenerateImagePayload, GenerateVideoPayload, UpscaleVideoPayload } from '../application/ports';
import { generateWanCliVideo } from '@/commands/wanCli';
import { useWanCliStore } from '@/stores/wanCliStore';

function mergeNegativePrompt(
  payload: GenerateImagePayload
): Record<string, unknown> | undefined {
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
  const numeric = typeof imageCount === 'number' && Number.isFinite(imageCount)
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
  return baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/i, '').replace(/\/+$/, '');
}

function isZhiniaoProviderId(providerId: string): boolean {
  return providerId.trim().replace(/^custom:/i, '').toLowerCase() === 'zhiniao';
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
  providerId: string
): Promise<string[] | undefined> {
  if (!referenceImages?.length) return referenceImages;
  const store = useSettingsStore.getState();
  const customApi = store.customApis.find((api) => `custom:${api.id}` === providerId);
  const baseUrl = toSiteRootBaseUrl(customApi?.baseUrl ?? '');
  if (!customApi || (!isZhiniaoProviderId(providerId) && !isZhiniaoBaseUrl(baseUrl))) {
    return referenceImages;
  }
  const apiKey = (store.apiKeys[providerId] ?? '').trim();
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
    })
  );
}

/**
 * 知鸟 AI 把「参考图的用途」放在 model 参数 mode 上, 默认 text-to-image 会**忽略**
 * 随请求送来的参考图。有参考图时必须显式声明, 否则会静默退化成纯文生图:
 * 单图 = image-edit(基于已有图片编辑), 多图 = multi-reference(多图融合生成)。
 */
export function withZhiniaoImageMode<
  T extends { model: string; extraParams?: Record<string, unknown>; referenceImages?: string[] }
>(payload: T): T {
  const usableReferences = (payload.referenceImages ?? []).filter((item) => item?.trim());
  if (usableReferences.length === 0) return payload;
  const extraParams: Record<string, unknown> = { ...(payload.extraParams ?? {}) };
  if (extraParams.image_generation_mode != null) return payload;
  const providerId = payload.model.split('/')[0]?.replace(/^custom:/i, '') ?? '';
  const baseUrl = typeof extraParams.provider_base_url === 'string' ? extraParams.provider_base_url : '';
  if (!isZhiniaoProviderId(providerId) && !isZhiniaoBaseUrl(baseUrl)) return payload;
  extraParams.image_generation_mode = usableReferences.length > 1 ? 'multi-reference' : 'image-edit';
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
  forceMode?: 'sync' | 'async'
): T {
  if (!payload.model.startsWith('custom:')) {
    return payload;
  }
  const providerId = payload.model.split('/')[0].replace('custom:', '');
  const customApi = useSettingsStore
    .getState()
    .customApis.find((api) => api.id === providerId);
  const requestMode = forceMode ?? customApi?.requestMode ?? 'sync';
  const extraParams: Record<string, unknown> = {
    ...(payload.extraParams ?? {}),
  };
  // 平台设置是协议的唯一来源。节点可能保存了旧的 protocol 值，不能让
  // 旧值覆盖用户刚在设置中选择的 /v1/chat/completions 或 /v1/responses。
  const protocol = customApi?.protocol ?? (
    extraParams.protocol === 'responses' || extraParams.protocol === 'chat'
      ? extraParams.protocol
      : 'images'
  );
  const referenceImageField = extraParams.reference_image_field === 'input_image'
    ? 'input_image'
    : extraParams.reference_image_field === 'images'
      ? 'images'
      : extraParams.reference_image_field === 'reference_images'
        ? 'reference_images'
        : customApi?.referenceImageField ?? 'image';
  const referenceImageEncoding = typeof extraParams.reference_image_encoding === 'string'
    ? extraParams.reference_image_encoding
    : customApi?.referenceImageEncoding ?? 'auto';
  const imageTransport = typeof extraParams.image_transport === 'string'
    ? extraParams.image_transport
    : customApi?.imageTransport ?? 'auto';
  if (requestMode === 'async') {
    extraParams.request_mode = 'async';
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
  if (customApi?.capabilities?.confidence === 'high' && customApi.capabilities.videoSubmitPath) {
    extraParams.video_submit_path = customApi.capabilities.videoSubmitPath;
  }
  if (customApi?.capabilities?.confidence === 'high' && customApi.capabilities.videoQueryPath) {
    extraParams.video_query_path = customApi.capabilities.videoQueryPath;
  }
  if (customApi?.capabilities?.confidence === 'high' && customApi.capabilities.videoTransport) {
    extraParams.video_transport = customApi.capabilities.videoTransport;
  }
  if (extraParams.video_reference_encoding == null
    && customApi?.capabilities?.confidence === 'high'
    && customApi.capabilities.videoReferenceEncoding
    && customApi.capabilities.videoReferenceEncoding !== 'unknown') {
    extraParams.video_reference_encoding = customApi.capabilities.videoReferenceEncoding;
  }
  const providerBaseUrl = customApi?.baseUrl?.trim().toLowerCase() ?? '';
  // 帧间 API 是异步任务协议，图片和视频都必须由前端专有链路提交、轮询并
  // 携带 Bearer 下载结果。按 Base URL 兜底，用户手动新增或改平台名称也能命中。
  if (isZhenjianProvider(providerId, providerBaseUrl)) {
    extraParams.request_mode = 'async';
    extraParams.image_transport = 'zhenjian-task-api';
    extraParams.video_transport = 'zhenjian-task-api';
  }
  // 字子动画: 图片/视频/音频三条链路都走专有协议(见 @/commands/zzdhApi)。
  // 判据同时看平台 id(可能是中文「字子动画」)与 Base URL。
  if (isZzdhProvider(providerId, providerBaseUrl)) {
    extraParams.video_transport = 'zzdh-v8-video';
    extraParams.audio_transport = 'zzdh-openai-audio';
    // 参考图字段: 官方模型页是 reference_images 对象数组。通用 'image' 写法平台虽会
    // 自动对齐, 这里仍统一升级成文档原生字段; 用户显式选过 images / input_image 则保留。
    if (referenceImageField === 'image') {
      extraParams.reference_image_field = 'reference_images';
    }
  }
  if (providerId === 'sub2api-video' || isRjmVideoApiBaseUrl(providerBaseUrl)) {
    extraParams.video_transport = 'sub2api-video';
  }
  if (providerId === 'binghuo' || providerBaseUrl.includes('api.7tai.cc')) {
    extraParams.video_transport = 'binghuo-video';
  }
  if (providerId === 'wgspai' || providerBaseUrl.includes('api.wgspai.cn')) {
    extraParams.video_transport = 'wgspai-video';
  }
  if (providerId === 'zhiniao' || providerBaseUrl.includes('cuai.token6688.com') || providerBaseUrl.includes('api.tokengo.love')) {
    extraParams.video_transport = 'zhiniao-video';
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
  const usesEnglishProtocol = model.startsWith('fal/') || model.startsWith('ppio/');
  if (!usesEnglishProtocol) return prompt;

  return prompt.replace(
    /(^|[\s，。；：、,.;:！？!?（）()【】[\]"'“”‘’])(@?\s*图)(\d+)/g,
    (_match, prefix: string, _marker: string, index: string) => `${prefix}Image ${index}`
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
  options?: { compactCustomImages?: boolean }
): Promise<string[] | undefined> {
  if (!urls?.length) return undefined;
  const compactCustomImages = options?.compactCustomImages === true;
  const nonEmptyUrls = urls.map((url) => url.trim()).filter(Boolean);
  const perImageBudget = Math.max(
    1_500_000,
    Math.floor(CUSTOM_IMAGE_REFERENCE_TOTAL_BUDGET / Math.max(1, nonEmptyUrls.length))
  );

  return await Promise.all(
    nonEmptyUrls.map(async (url) => {
      if (/^https?:\/\//i.test(url)) return url;

      const rawDataUrl = imageReferenceDataUrlCache.get(url) ?? await imageUrlToDataUrl(url);
      imageReferenceDataUrlCache.set(url, rawDataUrl);
      if (!compactCustomImages || rawDataUrl.length <= perImageBudget) return rawDataUrl;

      return await createCompactImageDataUrl(
        url,
        CUSTOM_IMAGE_REFERENCE_MAX_DIMENSION,
        CUSTOM_IMAGE_REFERENCE_QUALITY,
        perImageBudget
      );
    })
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
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) return false;
  if (host.startsWith('[') || host.includes(':')) {
    // IPv6: 环回 / 唯一本地地址(fc00::/7) / 链路本地(fe80::/10)
    const bare = host.replace(/^\[|\]$/g, '');
    if (bare === '::1' || bare === '::') return false;
    if (/^f[cd]/i.test(bare) || /^fe[89ab]/i.test(bare)) return false;
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const [a, b] = host.split('.').map(Number);
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
  extraParams: Record<string, unknown> | undefined
): Promise<string[] | undefined> {
  if (!imageUrls?.length) return undefined;
  const useZzdhCompactImage = extraParams?.video_transport === 'zzdh-v8-video';
  const videoEncoding = extraParams?.video_reference_encoding === 'raw_base64'
    ? 'raw_base64'
    : extraParams?.video_reference_encoding === 'url' ? 'url' : 'data_url';
  // zzdh 官方文档: 素材支持 data: base64, 单图上限 20MB。
  // 但整包 task payload 有限制(实测传大图会 HTTP 400 task payload too large)。
  // 本地图策略: 小图(≤预算)无损直传, 大图压缩到 2048px/0.9(接近视觉无损);
  // 总 data URL 预算控制在 ~3MB, 多图按图数分摊, 单图下限 400KB。
  const zzdhImageBudget = Math.max(400_000, Math.floor(3_000_000 / Math.max(1, imageUrls.length)));
  const zzdhMaxDimension = 2048;
  const zzdhQuality = 0.9;

  return await Promise.all(imageUrls.map(async (imageUrl) => {
    const source = imageUrl.trim();
    if (!source) return source;
    if (/^https?:\/\//i.test(source)) {
      if (!useZzdhCompactImage) return source;
      // 官方文档: 素材支持公网 HTTP(S) URL 或 data: Base64。
      // 公网 URL 且路径带图片扩展名 → 直接无损透传(官方最清晰方式);
      // 无扩展名的签名 URL 可能被上游拒绝(Kling 文档), 才压缩成 data URL 兜底。
      if (isPubliclyReachableHttpUrl(source)
        && /\.(jpe?g|png|webp|gif|bmp|heic)(\?|#|$)/i.test(source)) {
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
    if (videoEncoding === 'raw_base64' && dataUrl.startsWith('data:')) {
      return dataUrl.split(',', 2)[1] ?? dataUrl;
    }
    return dataUrl;
  }));
}

/**
 * 本地图最清晰策略: 先转无损原始 data URL, 未超预算直接使用(完全不损失画质);
 * 超预算(大图/多图)才压缩到 maxDimension / quality, 保证请求体不超限。
 */
async function resolveZzdhReferenceDataUrl(
  source: string,
  maxDimension: number,
  quality: number,
  budget: number
): Promise<string> {
  const cacheKey = source.trim();
  const cached = referenceDataUrlCache.get(cacheKey);
  const rawDataUrl = cached ?? await imageUrlToDataUrl(source);
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
  setApiKey,
  generateImage: async (payload: GenerateImagePayload) => {
    // 显式同步通道(等价 Infinite-Canvas /api/generate): 强制 request_mode=sync,
    // 后端走 generate_image 直出, 不创建异步任务, 避免 poll 不收敛导致的永久转圈。
    const providerId = payload.model.split('/')[0]?.replace(/^custom:/i, '') ?? '';
    const providerBaseUrl = typeof payload.extraParams?.provider_base_url === 'string'
      ? payload.extraParams.provider_base_url
      : useSettingsStore.getState().customApis.find((api) => api.id === providerId)?.baseUrl ?? '';
    const injected = withZhiniaoImageMode(
      injectCustomApiRequestMode(
        payload,
        isZhenjianProvider(providerId, providerBaseUrl) ? 'async' : 'sync',
      ),
    );
    // 图片直传: http URL 透传。本地多张大图为自定义中转压缩到安全请求体大小。
    const normalizedReferenceImages = await normalizeReferenceUrls(injected.referenceImages, {
      compactCustomImages: injected.model.startsWith('custom:'),
    });
    // 知鸟 AI 只收公网 URL, 本地参考图先上传 /v1/files 换 URL。
    const referenceImages = await resolveZhiniaoImageReferences(
      normalizedReferenceImages,
      injected.model.split('/')[0] ?? ''
    );
    const mergedExtraParams = mergeImageCount(
      mergeNegativePrompt(injected),
      payload.imageCount,
    );

    return await generateImage({
      prompt: localizeReferenceTokens(
        withAspectRatioRequirement(payload.prompt, payload.aspectRatio),
        payload.model
      ),
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
      compactCustomImages: injected.model.startsWith('custom:'),
    });
    const referenceImages = await resolveZhiniaoImageReferences(
      normalizedReferenceImages,
      injected.model.split('/')[0] ?? ''
    );
    const mergedExtraParams = mergeImageCount(
      mergeNegativePrompt(injected),
      payload.imageCount,
    );
    // 即梦 CLI 的画幅由 `--ratio` 直接决定, 不需要(也不该)往提示词里追加画幅约束;
    // 其余平台依赖这句英文兜底上游忽略 aspect_ratio 参数的情况。
    // 这里按整个 provider 前缀判断: 普通图片(`image-*`)与超清(`upscale`)都算。
    const isJimengCliImage = payload.model.startsWith(`${JIMENG_CLI_PROVIDER_ID}/`);
    const prompt = localizeReferenceTokens(
      isJimengCliImage
        ? payload.prompt
        : withAspectRatioRequirement(payload.prompt, payload.aspectRatio),
      payload.model
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
  generateVideo: async (payload: GenerateVideoPayload) => {
    if (payload.model.startsWith('wan-cli/')) {
      return generateWanCliVideo({
        client_job_id: payload.clientJobId,
        executable: useWanCliStore.getState().executable,
        prompt: payload.prompt,
        model_version: payload.model.slice('wan-cli/'.length),
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
      const referenceAudio = payload.referenceAudio
        ?.map((audioUrl) => audioUrl.trim())
        .filter(Boolean);
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

    // 视频语义固定为异步任务(提交+轮询), 不受图片默认 sync 影响
    const requestedTransport = payload.extraParams?.video_transport;
    const injected = injectCustomApiRequestMode(payload, 'async');
    // 动作控制 / 对口型是 Kling 专用 endpoint。即使自定义平台之前探测过
    // 普通视频 transport，也不能覆盖节点显式选择的控制协议。
    if (requestedTransport === 'kling-control' || requestedTransport === 'zzdh-v8-video') {
      injected.extraParams = {
        ...(injected.extraParams ?? {}),
        video_transport: 'kling-control',
      };
    }
    const profile = resolveVideoModelProfile(
      payload.model,
      typeof injected.extraParams?.provider_base_url === 'string'
        ? injected.extraParams.provider_base_url
        : undefined,
    );
    if (profile.status === 'pending-adaptation') {
      throw new Error(profile.unavailableReason ?? '该视频模型尚未完成独立适配');
    }
    const unifiedRequest = toVideoGenerationRequest(payload);
    const imageResources = payload.imageMode === 'first-last'
      ? [unifiedRequest.firstFrame, unifiedRequest.lastFrame].filter(
        (resource): resource is NonNullable<typeof resource> => Boolean(resource)
      )
      : unifiedRequest.referenceImages;
    const referenceImages = await normalizeVideoReferenceImages(
      imageResources.map((resource) => resource.source),
      injected.extraParams
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
    const api = useSettingsStore.getState().customApis.find(
      (item) => item.id === payload.model.split('/')[0]?.replace('custom:', ''),
    );
    const providerBaseUrl = typeof payload.extraParams?.provider_base_url === 'string'
      ? payload.extraParams.provider_base_url
      : (api?.baseUrl ?? '');
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
   * 音频接口是**同步**返回音频文件字节, 没有异步任务轮询;
   * 字子动画走 /v1/audio/speech | /v1/audio/sound-effects | /v1/audio/music,
   * 其它平台退化为 OpenAI 兼容 /v1/audio/speech。
   */
  generateAudio: async (payload: GenerateAudioPayload) => {
    const injected = injectCustomApiRequestMode(payload);
    return await generateAudio({
      prompt: payload.prompt,
      model: injected.model,
      audio_kind: payload.audioKind,
      voice: payload.voice,
      format: payload.format,
      duration_seconds: payload.durationSeconds,
      music_length_ms: payload.musicLengthMs,
      lyrics: payload.lyrics,
      extra_params: injected.extraParams,
    });
  },
};
