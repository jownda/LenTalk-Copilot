import {
  generateImage,
  generateJimengCliVideo,
  generateVideo,
  getGenerateImageJob,
  setApiKey,
  submitGenerateImageJob,
} from '@/commands/ai';
import {
  createCompactImageDataUrl,
  imageUrlToDataUrl,
} from '@/features/canvas/application/imageData';
import { useSettingsStore } from '@/stores/settingsStore';
import { JIMENG_CLI_PROVIDER_ID, resolveVideoModelProfile } from '@/features/canvas/models';
import { toVideoGenerationRequest } from '@/features/canvas/application/videoGeneration';

import type { AiGateway, GenerateImagePayload, GenerateVideoPayload } from '../application/ports';

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

function withAspectRatioRequirement(prompt: string, aspectRatio: string): string {
  const match = aspectRatio.trim().match(/^(\d+)\s*:\s*(\d+)$/);
  if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0) {
    return prompt;
  }
  return `${prompt.trim()}\n\n[Required image aspect ratio: ${match[1]}:${match[2]}. Compose for this exact frame without borders or empty padding.]`;
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
  if (customApi?.capabilities?.confidence === 'high' && customApi.capabilities.videoSubmitPath) {
    extraParams.video_submit_path = customApi.capabilities.videoSubmitPath;
  }
  if (customApi?.capabilities?.confidence === 'high' && customApi.capabilities.videoQueryPath) {
    extraParams.video_query_path = customApi.capabilities.videoQueryPath;
  }
  if (extraParams.video_reference_encoding == null
    && customApi?.capabilities?.confidence === 'high'
    && customApi.capabilities.videoReferenceEncoding
    && customApi.capabilities.videoReferenceEncoding !== 'unknown') {
    extraParams.video_reference_encoding = customApi.capabilities.videoReferenceEncoding;
  }
  const providerBaseUrl = customApi?.baseUrl?.trim().toLowerCase() ?? '';
  if (providerId === 'zizidonghua' || providerBaseUrl.includes('zizidonghua.com')) {
    extraParams.video_transport = 'zzdh-v8-video';
  }
  if (providerId === 'sub2api-video' || providerBaseUrl.includes('video.rjm.us.ci')) {
    extraParams.video_transport = 'sub2api-video';
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
      if (/\.(jpe?g|png|webp|gif|bmp|heic)(\?|#|$)/i.test(source)) {
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
    const injected = injectCustomApiRequestMode(payload, 'sync');
    // 图片直传: http URL 透传。本地多张大图为自定义中转压缩到安全请求体大小。
    const normalizedReferenceImages = await normalizeReferenceUrls(injected.referenceImages, {
      compactCustomImages: injected.model.startsWith('custom:'),
    });
    const mergedExtraParams = mergeNegativePrompt(injected);

    return await generateImage({
      prompt: localizeReferenceTokens(
        withAspectRatioRequirement(payload.prompt, payload.aspectRatio),
        payload.model
      ),
      negative_prompt: payload.negativePrompt,
      model: payload.model,
      size: payload.size,
      aspect_ratio: payload.aspectRatio,
      reference_images: normalizedReferenceImages,
      extra_params: mergedExtraParams,
    });
  },
  submitGenerateImageJob: async (payload: GenerateImagePayload) => {
    // 只有平台明确配置 requestMode=async 时才进入任务轮询；普通 OpenAI
    // 兼容接口走同步提交，避免猜测不存在的查询端点导致永久 pending。
    const injected = injectCustomApiRequestMode(payload);
    // 图片直传: http URL 透传。本地多张大图为自定义中转压缩到安全请求体大小。
    const normalizedReferenceImages = await normalizeReferenceUrls(injected.referenceImages, {
      compactCustomImages: injected.model.startsWith('custom:'),
    });
    const mergedExtraParams = mergeNegativePrompt(injected);
    return await submitGenerateImageJob({
      prompt: localizeReferenceTokens(
        withAspectRatioRequirement(payload.prompt, payload.aspectRatio),
        payload.model
      ),
      negative_prompt: payload.negativePrompt,
      model: payload.model,
      size: payload.size,
      aspect_ratio: payload.aspectRatio,
      reference_images: normalizedReferenceImages,
      extra_params: mergedExtraParams,
    });
  },
  getGenerateImageJob,
  generateVideo: async (payload: GenerateVideoPayload) => {
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
    const injected = injectCustomApiRequestMode(payload, 'async');
    const profile = resolveVideoModelProfile(payload.model);
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
};
