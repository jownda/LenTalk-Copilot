export type VideoProfileId = 'openai-video' | 'minimax-h3' | 'seedance-v2' | 'zzdh-v8-video' | 'jimeng-cli';
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

const MINIMAX_H3_PROFILE: VideoModelProfile = {
  id: 'minimax-h3',
  status: 'verified',
  protocolLabel: 'OpenAI Video / 已验证',
  submitPath: '/v1/video/generations',
  queryPath: '/v1/video/generations/{taskId}',
  referenceImageTarget: 'platform-file',
  supportsReferenceImages: true,
  supportsFirstLast: true,
  supportsReferenceAudio: true,
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

const ZZDH_V8_VIDEO_PROFILE: VideoModelProfile = {
  id: 'zzdh-v8-video',
  status: 'verified',
  protocolLabel: '字子动画 V8 视频 / 已验证',
  submitPath: '/v8/videos/generations',
  queryPath: '/v8/videos/generations/{taskId}',
  referenceImageTarget: 'data-url',
  supportsReferenceImages: true,
  supportsFirstLast: true,
  supportsReferenceAudio: false,
};

export function resolveVideoModelProfile(modelId: string): VideoModelProfile {
  const provider = modelId.split('/')[0]?.trim().toLowerCase();
  const model = modelId.split('/').slice(1).join('/').trim().toLowerCase();
  // 即梦 CLI 是本地命令, seedance 系列由 CLI 自行校验, 不套用平台协议适配状态
  if (provider === 'jimeng-cli') return JIMENG_CLI_VIDEO_PROFILE;
  if (provider === 'custom:zizidonghua') return ZZDH_V8_VIDEO_PROFILE;
  if (model === 'minimax-h3') return MINIMAX_H3_PROFILE;
  if (/^seedance(?:[-_.]?v?2|2(?:[._-]|$))/.test(model)) return SEEDANCE_V2_PROFILE;
  return OPENAI_VIDEO_PROFILE;
}

export function getVideoProfileStatusLabel(profile: VideoModelProfile): string {
  return profile.protocolLabel;
}
