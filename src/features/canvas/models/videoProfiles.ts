import { wanCliVideoProfile } from './wanCli';
import { isZzdhProvider, ZZDH_VIDEO_QUERY_PATH, ZZDH_VIDEO_SUBMIT_PATH } from '@/commands/zzdhApi';
import { isZhenjianProvider } from '@/commands/zhenjianApi';
import {
  isRunningHubBaseUrl,
  RUNNINGHUB_API_PREFIX,
  RUNNINGHUB_QUERY_PATH,
} from '@/commands/runningHubProtocol';

export type VideoProfileId = 'openai-video' | 'seedance-v2' | 'sub2api-video' | 'zzdh-v8-video' | 'binghuo-video' | 'wgspai-video' | 'zhiniao-video' | 'zhenjian-task-api' | 'runninghub-model' | 'jimeng-cli' | 'wan-cli';
export type VideoProfileStatus = 'verified' | 'pending-adaptation';
export type VideoReferenceTarget = 'data-url' | 'public-url' | 'platform-file';

export interface VideoModelProfile {
  id: VideoProfileId;
  status: VideoProfileStatus;
  protocolLabel: string;
  submitPath?: string;
  queryPath?: string;
  referenceImageTarget: VideoReferenceTarget;
  supportsReferenceImages: boolean;
  supportsFirstLast: boolean;
  supportsReferenceAudio: boolean;
  unavailableReason?: string;
}

const OPENAI_VIDEO_PROFILE: VideoModelProfile = {
  id: 'openai-video',
  status: 'verified',
  protocolLabel: 'OpenAI Video / 已验证',
  submitPath: '/v1/videos/generations',
  queryPath: '/v1/videos/generations/{taskId}',
  referenceImageTarget: 'data-url',
  supportsReferenceImages: true,
  supportsFirstLast: true,
  supportsReferenceAudio: false,
};

/** Seedance 2 平台链路: 直接按通用 OpenAI 视频协议提交, 不再本地拦截(失败由平台返回真实错误) */
const SEEDANCE_V2_PROFILE: VideoModelProfile = {
  id: 'seedance-v2',
  status: 'verified',
  protocolLabel: 'OpenAI Video / 已验证',
  submitPath: '/v1/videos/generations',
  queryPath: '/v1/videos/generations/{taskId}',
  referenceImageTarget: 'platform-file',
  supportsReferenceImages: false,
  supportsFirstLast: false,
  supportsReferenceAudio: false,
};

const SUB2API_VIDEO_PROFILE: VideoModelProfile = {
  id: 'sub2api-video',
  status: 'verified',
  protocolLabel: 'Sub2API Video / 已验证',
  submitPath: '/v1/videos',
  queryPath: '/v1/videos/{taskId}',
  referenceImageTarget: 'platform-file',
  supportsReferenceImages: true,
  supportsFirstLast: false,
  supportsReferenceAudio: false,
};

/** 即梦 CLI(本地命令)专用: 不走 HTTP 平台协议, 由本地 CLI 自校验模型/时长/分辨率 */
const JIMENG_CLI_VIDEO_PROFILE: VideoModelProfile = {
  id: 'jimeng-cli',
  status: 'verified',
  protocolLabel: '即梦 CLI / 本地命令',
  referenceImageTarget: 'platform-file',
  supportsReferenceImages: true,
  supportsFirstLast: true,
  supportsReferenceAudio: true,
};

/**
 * 字子动画(zizidonghua.com)专有链路。
 *
 * 视频走官方统一异步入口 `/v8/videos/generations`(提交 + `/{task_id}` 轮询),
 * 另有 `GET /v1/videos/{task_id}/content` 可直接取内容。
 * 参考图: 官方支持公网 URL 或 `data:` base64, 本地图转 data URL 内嵌即可
 * (实测平台会把 data URL 转成公网 URL, 该步骤偶发失败 → 有界重试, 见 generateZzdhVideo)。
 * 参考音频: 文档在模型家族字段表里列出 `reference_audios`, 我们按原样转发。
 */
const ZZDH_V8_VIDEO_PROFILE: VideoModelProfile = {
  id: 'zzdh-v8-video',
  status: 'verified',
  protocolLabel: '字子动画 V8 视频 / 已验证',
  submitPath: ZZDH_VIDEO_SUBMIT_PATH,
  queryPath: ZZDH_VIDEO_QUERY_PATH,
  referenceImageTarget: 'data-url',
  supportsReferenceImages: true,
  supportsFirstLast: true,
  supportsReferenceAudio: true,
};

const BINGHUO_VIDEO_PROFILE: VideoModelProfile = {
  id: 'binghuo-video',
  status: 'verified',
  protocolLabel: '炳火异步视频 / 已验证',
  submitPath: '/v1/video/generations',
  queryPath: '/v1/video/generations/{taskId}',
  referenceImageTarget: 'public-url',
  supportsReferenceImages: true,
  supportsFirstLast: true,
  supportsReferenceAudio: true,
};

/**
 * wgspai 平台链路(api.wgspai.cn)。
 *
 * 端点按站点文档取正典路径 —— 四份对接文档三处写明「推荐统一用 /v1/videos」,
 * `/v1/video/generations` 只是「兼容路径(可选)」, 因此这里的默认提交与轮询都走
 * `/v1/videos`。
 *
 * 注意: 该站点在**同一个 Base 下还有第二族接口** —— 总览文档「异步：任务」一节的
 * `POST /v1/task/create` → `GET /v1/task/{id}`(`sd-2` / `LongXia-*` / `ltx2.3` /
 * `VEO-3.1` / `flashvsr-restore` / `seedance-v2-1080p` 等, 模型参数包在 `params`
 * 里)。族别由**模型名**决定, 协议层会自己改端点并改写查询地址, 所以这份 profile
 * 里写的是族 1 的路径(`src/commands/wgspaiProtocol.ts` 的 `wgspaiSubmitPath` /
 * `wgspaiQueryPath`, 后端同源实现见 `video_protocols/wgspai.rs`)。
 *
 * 参考素材走**官方背景机图床**(`https://wgspai.cn/image-bed/api/upload`, 字段 `file`,
 * 匿名可传), 所以是 `platform-file` 而非 data-url: 文档明确要求参考图是公网可访问
 * URL, 并对内联 data URL 标注「体积大、易触达请求上限」。
 *
 * 参考音视频字段与炳火不同(720p 文档口径): 音频 `audio_urls`、视频 `video_urls`
 * (视频仅 seedance-v2-*-video 支持); Minimax-h3 文档明确不支持参考音视频。
 */
const WGSPAI_VIDEO_PROFILE: VideoModelProfile = {
  id: 'wgspai-video',
  status: 'verified',
  protocolLabel: 'WGSPAI 异步视频 / 已验证',
  submitPath: '/v1/videos',
  queryPath: '/v1/videos/{taskId}',
  referenceImageTarget: 'platform-file',
  supportsReferenceImages: true,
  supportsFirstLast: true,
  supportsReferenceAudio: true,
};

/**
 * 知鸟 AI(TokenGo 网关)视频链路:
 * - 提交用 OpenAI 风格**扁平**入口 /v1/videos/generations(model/prompt/duration/
 *   aspect_ratio/resolution/images 全部放顶层, 不接受 params 信封)
 * - 轮询是网关统一的 /v1/tasks/{task_id}, 不是 提交路径 + /{taskId}
 * - 生成类参考字段只收公网 URL, 本地素材需先 POST /v1/files 换取 URL
 */
const ZHINIAO_VIDEO_PROFILE: VideoModelProfile = {
  id: 'zhiniao-video',
  status: 'verified',
  protocolLabel: '知鸟 AI 异步视频 / 已验证',
  submitPath: '/v1/videos/generations',
  queryPath: '/v1/tasks/{taskId}',
  referenceImageTarget: 'platform-file',
  supportsReferenceImages: true,
  supportsFirstLast: true,
  supportsReferenceAudio: true,
};

const ZHENJIAN_TASK_PROFILE: VideoModelProfile = {
  id: 'zhenjian-task-api',
  status: 'verified',
  protocolLabel: '帧间 API 异步任务 / 已验证',
  submitPath: '/v1/videos',
  queryPath: '/v1/tasks/{taskId}',
  referenceImageTarget: 'platform-file',
  supportsReferenceImages: true,
  supportsFirstLast: true,
  supportsReferenceAudio: true,
};

/**
 * RunningHub(runninghub.cn / runninghub.ai)专有链路。
 *
 * 端点形状与其它平台都不同: **模型就是端点**, 提交路径是
 * `POST /openapi/v2/{endpoint}`(如 `/openapi/v2/kling-v3.0-pro/image-to-video`),
 * 没有统一的 `/v1/videos`; 查询固定为 `POST /openapi/v2/query` + body `{taskId}`
 * (**不是** GET, 也不是提交路径 + `/{taskId}`)。
 *
 * 参考图: 本地图先走 `POST /openapi/v2/media/upload/binary`(multipart 字段 `file`)
 * 换公网 URL 再提交 —— 与官方文档口径一致, 所以是 `platform-file`。
 * 首尾帧支持按端点而异(图生视频端点才有尾帧), 这里给 `supportsFirstLast: true`
 * 表示「UI 允许选」, 真正的字段名与是否支持由端点 schema 决定。
 *
 * `submitPath` 里的 `{endpoint}` 只是形状说明: 真正的绝对地址由后端
 * `video_protocols/runninghub.rs` 用 `API_PREFIX` + 端点 ID 拼出来。
 */
const RUNNINGHUB_VIDEO_PROFILE: VideoModelProfile = {
  id: 'runninghub-model',
  status: 'verified',
  protocolLabel: 'RunningHub 端点 / 已验证',
  submitPath: `${RUNNINGHUB_API_PREFIX}/{endpoint}`,
  queryPath: RUNNINGHUB_QUERY_PATH,
  referenceImageTarget: 'platform-file',
  supportsReferenceImages: true,
  supportsFirstLast: true,
  supportsReferenceAudio: false,
};

function isZhiniaoVideoProvider(provider: string, providerBaseUrl?: string): boolean {
  const baseUrl = providerBaseUrl?.trim().toLowerCase() ?? '';
  return provider === 'custom:zhiniao'
    || baseUrl.includes('cuai.token6688.com')
    || baseUrl.includes('api.tokengo.love');
}

/**
 * RunningHub 的识别。
 *
 * 平台 id 可能是用户自建的(按名称生成, 如「RH国际」→ `custom:rh国际`), 所以
 * **Base URL 才是主判据**, id 只作为预设条目的快捷命中。`.cn` / `.ai` 两个站点
 * 共用同一套协议, 一并识别。
 */
function isRunningHubVideoProvider(provider: string, providerBaseUrl?: string): boolean {
  const id = provider.trim().toLowerCase().replace(/^custom:/, '');
  return id === 'runninghub' || id === 'runninghub-cn' || isRunningHubBaseUrl(providerBaseUrl);
}

export function resolveVideoModelProfile(modelId: string, providerBaseUrl?: string): VideoModelProfile {
  if (modelId.startsWith('wan-cli/')) return wanCliVideoProfile;
  const provider = modelId.split('/')[0]?.trim().toLowerCase();
  const model = modelId.split('/').slice(1).join('/').trim().toLowerCase();
  // 即梦 CLI 是本地命令, seedance 系列由 CLI 自行校验, 不套用平台协议适配状态
  if (provider === 'jimeng-cli') return JIMENG_CLI_VIDEO_PROFILE;
  // RunningHub 必须排在下面的 seedance 正则之前: 它的端点 ID 里就带 seedance
  // (`seedance-v1.5-pro/text-to-video`), 认成通用 Seedance 平台会挑错协议页签。
  if (isRunningHubVideoProvider(provider, providerBaseUrl)) return RUNNINGHUB_VIDEO_PROFILE;
  if (isZhiniaoVideoProvider(provider, providerBaseUrl)) return ZHINIAO_VIDEO_PROFILE;
  if (isZhenjianProvider(provider, providerBaseUrl)) return ZHENJIAN_TASK_PROFILE;
  if (/^(?:https?:\/\/)?(?:video|sub2api)\.rjm\.us\.ci(?:[/:]|$)/i.test(providerBaseUrl?.trim() ?? '')
    || provider === 'custom:sub2api-video') {
    return SUB2API_VIDEO_PROFILE;
  }
  // 字子动画的识别必须同时看 id 与 Base URL: 用户自建平台时 id 常是中文「字子动画」,
  // 只认 'custom:zizidonghua' 会掉到通用 OpenAI Video 档案(节点页签显示错误的协议)。
  if (isZzdhProvider(provider, providerBaseUrl)) return ZZDH_V8_VIDEO_PROFILE;
  if (provider === 'custom:binghuo') return BINGHUO_VIDEO_PROFILE;
  if (provider === 'custom:wgspai') return WGSPAI_VIDEO_PROFILE;
  if (/^seedance(?:[-_.]?v?2|2(?:[._-]|$))/.test(model)) return SEEDANCE_V2_PROFILE;
  return OPENAI_VIDEO_PROFILE;
}

export function getVideoModelProfile(profileId?: string): VideoModelProfile {
  if (!profileId) return OPENAI_VIDEO_PROFILE;
  const profiles: Record<VideoProfileId, VideoModelProfile> = {
    'wan-cli': wanCliVideoProfile,
    'openai-video': OPENAI_VIDEO_PROFILE,
    'seedance-v2': SEEDANCE_V2_PROFILE,
    'sub2api-video': SUB2API_VIDEO_PROFILE,
    'zzdh-v8-video': ZZDH_V8_VIDEO_PROFILE,
    'binghuo-video': BINGHUO_VIDEO_PROFILE,
    'wgspai-video': WGSPAI_VIDEO_PROFILE,
    'zhiniao-video': ZHINIAO_VIDEO_PROFILE,
    'zhenjian-task-api': ZHENJIAN_TASK_PROFILE,
    'runninghub-model': RUNNINGHUB_VIDEO_PROFILE,
    'jimeng-cli': JIMENG_CLI_VIDEO_PROFILE,
  };
  return profiles[profileId as VideoProfileId] ?? OPENAI_VIDEO_PROFILE;
}

export function getVideoProfileStatusLabel(profile: VideoModelProfile): string {
  return profile.protocolLabel;
}
