export type VideoProfileId = 'openai-video' | 'minimax-h3' | 'seedance-v2' | 'zzdh-v8-video';
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

const SEEDANCE_V2_PROFILE: VideoModelProfile = {
  id: 'seedance-v2',
  status: 'pending-adaptation',
  protocolLabel: '待适配',
  referenceImageTarget: 'platform-file',
  supportsReferenceImages: false,
  supportsFirstLast: false,
  supportsReferenceAudio: false,
  unavailableReason: 'Seedance 2 需要 WGSPAI 的真实成功请求样本后单独适配，当前不会复用 MiniMax-H3 字段。',
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
  if (provider === 'custom:zizidonghua') return ZZDH_V8_VIDEO_PROFILE;
  if (model === 'minimax-h3') return MINIMAX_H3_PROFILE;
  if (/^seedance(?:[-_.]?v?2|2(?:[._-]|$))/.test(model)) return SEEDANCE_V2_PROFILE;
  return OPENAI_VIDEO_PROFILE;
}

export function getVideoProfileStatusLabel(profile: VideoModelProfile): string {
  return profile.protocolLabel;
}
