import { isZzdhVideoReferenceModel } from '@/commands/zzdhApi';
import { resolveWgspaiModelSpec } from '@/commands/wgspaiProtocol';
import type { VideoProfileId } from './videoProfiles';

/**
 * 「参考视频」在各视频协议里的真实支持度。
 *
 * 判据是后端各 `video_protocols/*` 的实现，不是平台文档的宣传口径：
 * 只有**真的会把 `reference_videos` 读出来塞进请求体**的协议才算支持，
 * 其余协议收到这个字段也只是丢掉 —— 那种情况下节点上标「已引用」就是骗人。
 *
 * 现状（对照源码逐条核过）：
 * - `zzdh` → `string_array_param(request, "reference_videos", 3)`，但只有模型名带
 *   `-video` 的才是视频参考调用，普通模型传了无效；
 * - `binghuo` → 参考视频先换 OSS，再填 `reference_videos`，上限 3；
 * - `wgspai` → 字段叫 `video_urls`，且**按模型**决定（`-video` / `seedance` 系才有）；
 * - `ark`（筷子 / 方舟同形）→ `content` 数组里塞 `type: "video_url"`，2.0 系 ≤3、2.5 系 ≤10；
 * - `likeai` → `content` 数组里的 `video_url` 角色；
 * - `runninghub` → 端点 schema 决定（`spec.max_videos`）；
 * - `jimeng-canvas`（即梦画布 CLI）→ `m2v` 模式下 `--ref` 可以挂视频资源，但**按模型**
 *   决定（`seedance_2.5_flash` 收 5 段、`seedance_pro_fast` 一段都不收），额度只认
 *   目录里的 `references.types[video].max`，所以这里不登记固定数字，交给模型定义；
 * - `jimeng-cli`（即梦 CLI）→ `multimodal2video`（全能参考）认 `--video`，额度按型号
 *   （2.5 系 10 段、2.0 家族 3 段），见 `JIMENG_CLI_REFERENCE_VIDEO_MAX`；
 * - 其余（通用 OpenAI Video / Sub2API / 万相本地 CLI / 知鸟 / 帧间 / Dramaya）
 *   在代码里都不读这个字段，所以登记为 0。
 */
const REFERENCE_VIDEO_MAX: Partial<Record<VideoProfileId, number>> = {
  'zzdh-v8-video': 3,
  'binghuo-video': 3,
  'wgspai-video': 3,
  'kuaizi-video': 3,
  'likeai-video': 3,
  'runninghub-model': 3,
};

export interface VideoReferenceSupport {
  /** 当前模型是否真的会把参考视频提交给上游。 */
  supported: boolean;
  /** 上限；`0` = 不支持。 */
  maxVideos: number;
}

const UNSUPPORTED: VideoReferenceSupport = { supported: false, maxVideos: 0 };

/**
 * 即梦 CLI（`dreamina multimodal2video` 全能参考）按型号登记的参考视频额度。
 *
 * 来源是 `multimodal2video -h` 的原文：2.5 系 图≤30 / 视频≤10 / 音频≤10，
 * 2.0 家族与 mini 图≤9 / 视频≤3 / 音频≤3。`seedance2.5_flash` 不在该命令的
 * model_version 列表里（只有 `text2video` 认它），所以额度按 0 处理 ——
 * 给多了只会让节点标「会提交」之后被服务端拒掉。
 *
 * 键是型号去掉 `/`、`_`、`-`、`.` 后的小写形式，两个通道的命名差异自动归一。
 */
const JIMENG_CLI_REFERENCE_VIDEO_MAX: Record<string, number> = {
  seedance25: 10,
  seedance20: 3,
  seedance20fast: 3,
  seedance20vip: 3,
  seedance20fastvip: 3,
  seedance20mini: 3,
};

function jimengCliVideoQuota(modelId?: string | null): number {
  const raw = (modelId ?? '').trim();
  // 节点里是 `jimeng-cli/seedance2.5`，额度表只认型号那一段。
  const tail = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
  const key = tail.toLowerCase().replace(/[-_.]/g, '');
  return JIMENG_CLI_REFERENCE_VIDEO_MAX[key] ?? 0;
}

/**
 * 解析当前视频模型对「参考视频」的支持度。
 *
 * `modelId` 参与判定，因为同一协议里也分能力档：字子只有 `-video` 型号、WGSPAI 只有
 * 部分型号收视频，且条数上限不同。
 */
export function resolveVideoReferenceSupport(
  profileId: VideoProfileId | null | undefined,
  modelId?: string | null,
  /** 模型定义上的 `maxReferenceVideos`（来自平台目录）。即梦画布 CLI 只认这个。 */
  modelMaxVideos?: number | null,
): VideoReferenceSupport {
  // 即梦画布 CLI 的额度按模型走，协议表里登记不了：目录没同步到就当不支持，
  // 宁可少标一次，也不要在提示里骗用户「视频会被提交」。
  if (profileId === 'jimeng-canvas') {
    const declared = Math.floor(Number(modelMaxVideos) || 0);
    return declared > 0 ? { supported: true, maxVideos: declared } : UNSUPPORTED;
  }

  // 即梦 CLI 的全能参考同样按型号分档，但旧 CLI 没有可用的能力目录，
  // 只能按 `multimodal2video -h` 的声明登记（见 `JIMENG_CLI_REFERENCE_VIDEO_MAX`）。
  if (profileId === 'jimeng-cli') {
    const quota = jimengCliVideoQuota(modelId);
    return quota > 0 ? { supported: true, maxVideos: quota } : UNSUPPORTED;
  }

  const maxVideos = profileId ? REFERENCE_VIDEO_MAX[profileId] : undefined;
  if (!maxVideos) {
    return UNSUPPORTED;
  }
  const normalizedModelId = (modelId ?? '').trim();

  if (profileId === 'wgspai-video') {
    // WGSPAI 的模型档位表是唯一权威：它的「视频参考」字段名与上限都和炳火不同。
    const spec = resolveWgspaiModelSpec(normalizedModelId);
    return spec.supportsReferenceVideo
      ? { supported: true, maxVideos: Math.max(1, spec.maxReferenceVideos) }
      : UNSUPPORTED;
  }

  if (profileId === 'zzdh-v8-video') {
    // 字子动画: 与 `zzdhApi` 的 `isZzdhVideoReferenceModel` 同一判据 ——
    // 名称含 `-video` 段的模型才是视频参考调用，普通模型传了会被忽略。
    return isZzdhVideoReferenceModel(normalizedModelId) ? { supported: true, maxVideos } : UNSUPPORTED;
  }

  return { supported: true, maxVideos };
}
