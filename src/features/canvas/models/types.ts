import type { ModelPricingDefinition } from '@/features/canvas/pricing/types';

export type MediaModelType = 'image' | 'video' | 'audio';

export interface ModelProviderDefinition {
  id: string;
  name: string;
  label: string;
}

export interface AspectRatioOption {
  value: string;
  label: string;
}

export interface ResolutionOption {
  value: string;
  label: string;
}

export interface ImageModelRuntimeContext {
  extraParams?: Record<string, unknown>;
}

export type ExtraParamType = 'boolean' | 'enum' | 'number' | 'string';

export interface ExtraParamDefinition {
  key: string;
  label: string;
  labelKey?: string;
  type: ExtraParamType;
  description?: string;
  descriptionKey?: string;
  defaultValue?: boolean | number | string;
  options?: Array<{ value: string; label: string; labelKey?: string }>;
  min?: number;
  max?: number;
  step?: number;
}

export interface ImageModelDefinition {
  id: string;
  mediaType: 'image';
  displayName: string;
  providerId: string;
  description: string;
  eta: string;
  expectedDurationMs?: number;
  defaultAspectRatio: string;
  defaultResolution: string;
  aspectRatios: AspectRatioOption[];
  resolutions: ResolutionOption[];
  resolveResolutions?: (context: ImageModelRuntimeContext) => ResolutionOption[];
  extraParamsSchema?: ExtraParamDefinition[];
  defaultExtraParams?: Record<string, unknown>;
  pricing?: ModelPricingDefinition;
  resolveRequest: (context: { referenceImageCount: number }) => {
    requestModel: string;
    modeLabel: string;
  };
}

export interface VideoModelDefinition {
  id: string;
  mediaType: 'video';
  displayName: string;
  providerId: string;
  description: string;
  expectedDurationMs?: number;
  aspectRatios: AspectRatioOption[];
  defaultAspectRatio: string;
  durationOptions: number[];
  defaultDuration: number;
  /** 仅在供应商公开了视频分辨率约束时显示。 */
  resolutions?: ResolutionOption[];
  defaultResolution?: string;
  pricing?: ModelPricingDefinition;
  profileId?: string;
  profileStatus?: 'verified' | 'pending-adaptation';
  profileLabel?: string;
  profileUnavailableReason?: string;
}

/** 音频生成类型: 语音合成 / 音效 / 音乐(对应平台三个端点)。 */
export type AudioModelKind = 'speech' | 'sound-effects' | 'music';

export interface AudioModelDefinition {
  id: string;
  mediaType: 'audio';
  displayName: string;
  providerId: string;
  description: string;
  expectedDurationMs?: number;
  /** 端点类型(决定提交路径与请求体字段)。 */
  audioKind: AudioModelKind;
  /** 音色候选(语音合成); 平台可选项时留空。 */
  voiceOptions?: string[];
  defaultVoice?: string;
  /** 输出格式候选(语音合成)。 */
  formatOptions?: string[];
  defaultFormat?: string;
  /** 音乐时长候选(毫秒)。 */
  musicLengthOptionsMs?: number[];
  defaultMusicLengthMs?: number;
  pricing?: ModelPricingDefinition;
}
