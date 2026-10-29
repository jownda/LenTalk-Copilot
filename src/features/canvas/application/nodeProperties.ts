import type { CanvasNodeType } from "../domain/canvasNodes";
import { DEFAULT_NODE_DISPLAY_NAME } from "../domain/nodeDisplay";
import {
  formatByteSize,
  formatDurationMs,
  formatDurationSeconds,
  formatResolution,
  formatTimestamp,
  resolveMediaFormatLabel,
} from "./mediaFormat";

/** 右键「属性」只对这三类媒体开放。 */
export type NodeMediaKind = "image" | "video" | "audio";

export interface NodePropertyRow {
  label: string;
  value: string;
  /** 稳定的语义 id(如 `prompt`),供面板做「复制提示词」这类快捷操作。 */
  id?: string;
  /** 提示词、路径、JSON 这类长文本: 等宽字体 + 保留换行 + 单独复制按钮。 */
  multiline?: boolean;
  /** 值得一键复制的值(路径 / 任务 ID / 参数)。 */
  copyable?: boolean;
}

export interface NodePropertyGroup {
  /** 稳定的 key,用作 React 列表键,不参与展示。 */
  key: string;
  title: string;
  rows: NodePropertyRow[];
}

/** 探测得到的媒体实际数据;取不到的项留空,对应行不显示。 */
export interface MediaProbe {
  width?: number | null;
  height?: number | null;
  /** 音视频真实时长(秒)。 */
  durationSeconds?: number | null;
  /** 文件/远程资源的字节数。 */
  byteSize?: number | null;
}

export interface ProviderLookup {
  /** providerId → 平台显示名(如 `custom:zhiniao` → `知鸟ai`)。 */
  label?: (providerId: string) => string | null;
  /** providerId → 接口地址。 */
  baseUrl?: (providerId: string) => string | null;
}

/**
 * 上游节点(通常是产出这份媒体的生成节点)。
 *
 * 结果节点只负责「存媒体」, 生成信息归上游生成节点所有 —— 而且结果节点在生成完成时
 * 会清掉 `generationProviderId` / `generationRequest`(见 Canvas 的完成回调), 所以
 * 只看节点自身必然拿不到平台与模型。这里由调用方按连线找到上游后传进来。
 */
export interface UpstreamGenerationSource {
  nodeId?: string;
  nodeType: string;
  data: Record<string, unknown>;
}

export interface BuildNodePropertiesInput {
  nodeType: string;
  data: Record<string, unknown>;
  mediaKind: NodeMediaKind;
  /** 节点的媒体地址(本地路径 / URL),用于推断格式与来源。 */
  mediaUrl: string | null;
  probe?: MediaProbe | null;
  provider?: ProviderLookup;
  /** 上游生成节点: 本节点没有生成记录时从它补平台/模型/提示词等信息。 */
  upstream?: UpstreamGenerationSource | null;
  /** 模型 id → providerId: 上游只记了模型、没记平台时用它反查(例如 `seedance2.5`)。 */
  resolveModelProviderId?: (modelId: string) => string | null;
  /** i18n 取词: 缺失时用 fallback,保证文案永远不空。 */
  t: (key: string, fallback: string) => string;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(source: UnknownRecord | null, key: string): string | null {
  if (!source) {
    return null;
  }
  const value = source[key];
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function readNumber(source: UnknownRecord | null, key: string): number | null {
  if (!source) {
    return null;
  }
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readCount(source: UnknownRecord | null, key: string): number | null {
  if (!source) {
    return null;
  }
  const value = source[key];
  return Array.isArray(value) ? value.length : null;
}

/** 生成来源节点类型 → 中文名。缺省时直接展示原始 sourceType。 */
const GENERATION_SOURCE_LABEL: Record<string, string> = {
  imageEdit: "AI 图片节点",
  videoGen: "AI 视频节点",
  audioGen: "AI 音频节点",
  storyboardGen: "分镜生成节点",
};

/** 上游节点类型 → 生成来源枚举(上游节点只记节点类型、不记 sourceType 时用它还原)。 */
const SOURCE_TYPE_BY_NODE_TYPE: Record<string, string> = {
  imageNode: "imageEdit",
  videoGenNode: "videoGen",
  audioGenNode: "audioGen",
  storyboardGenNode: "storyboardGen",
  motionControlNode: "videoGen",
  // 工作流产物类型由 Save* 节点决定（图片/视频/音频都可能有），来源归类统一按最重的
  // 视频算 —— 这里只影响"生成来源"的显示文案，不影响实际落盘类型。
  runningHubWorkflowNode: "videoGen",
};

const MEDIA_KIND_LABEL: Record<NodeMediaKind, string> = {
  image: "图片",
  video: "视频",
  audio: "音频",
};

/**
 * 模型 id 的展示写法。
 *
 * 自定义平台的模型 id 形如 `custom:binghuo/doubao-seedance-2.5`, 平台已经在上一行单独
 * 展示过了, 这里只留模型名(`doubao-seedance-2.5`), 避免同一信息出现两遍。
 */
function formatModelLabel(modelId: string | null): string | null {
  if (!modelId) {
    return null;
  }
  const slash = modelId.indexOf("/");
  if (modelId.startsWith("custom:") && slash > 0 && slash < modelId.length - 1) {
    return modelId.slice(slash + 1);
  }
  return modelId;
}

function nodeTypeLabel(nodeType: string): string {
  const label = DEFAULT_NODE_DISPLAY_NAME[nodeType as CanvasNodeType];
  return label ?? nodeType;
}

/**
 * 从节点数据里归纳出「属性」面板要展示的分组。
 *
 * 设计原则:
 * - 只在**确实有值**时出行,没有的项不占位(节点可能来自上传/素材库,本来就没有生成记录);
 * - 一律从节点自身的快照字段读取,不回查平台设置 —— 用户当时用的模型/参数可能后来被改过;
 * - 纯函数,不碰 DOM、不发请求,探测结果由调用方以 `probe` 传入,便于单测。
 */
export function buildNodeProperties({
  nodeType,
  data,
  mediaKind,
  mediaUrl,
  probe,
  provider,
  upstream,
  resolveModelProviderId,
  t,
}: BuildNodePropertiesInput): NodePropertyGroup[] {
  const ownRequest = isRecord(data.generationRequest) ? data.generationRequest : null;
  const ownDebug = isRecord(data.generationDebugContext) ? data.generationDebugContext : null;

  const upstreamData = isRecord(upstream?.data) ? upstream?.data ?? null : null;
  const upstreamRequest = isRecord(upstreamData?.generationRequest)
    ? (upstreamData?.generationRequest as UnknownRecord)
    : null;
  const upstreamDebug = isRecord(upstreamData?.generationDebugContext)
    ? (upstreamData?.generationDebugContext as UnknownRecord)
    : null;

  // 请求快照统一口径: 自己有就用自己的(最精确), 否则用上游那次提交的快照。
  const request = ownRequest ?? upstreamRequest;
  const debug = ownDebug ?? upstreamDebug;

  const groups: NodePropertyGroup[] = [];

  // ---------- 媒体本体 ----------
  const mediaRows: NodePropertyRow[] = [
    {
      label: t("canvas.nodeProperties.kind", "类型"),
      value: t(
        `canvas.nodeProperties.kind_${mediaKind}`,
        MEDIA_KIND_LABEL[mediaKind],
      ),
    },
    {
      label: t("canvas.nodeProperties.nodeType", "节点类型"),
      value: nodeTypeLabel(nodeType),
    },
  ];

  const resolution = formatResolution(probe?.width, probe?.height);
  if (resolution) {
    mediaRows.push({
      label: t("canvas.nodeProperties.resolution", "分辨率"),
      value: resolution,
      copyable: true,
    });
  }

  const duration = formatDurationSeconds(probe?.durationSeconds);
  if (duration) {
    mediaRows.push({
      label: t("canvas.nodeProperties.duration", "时长"),
      value: duration,
    });
  }

  const byteSize = formatByteSize(probe?.byteSize);
  if (byteSize) {
    mediaRows.push({
      label: t("canvas.nodeProperties.fileSize", "文件大小"),
      value: byteSize,
    });
  }

  const format = resolveMediaFormatLabel(mediaUrl);
  if (format) {
    mediaRows.push({
      label: t("canvas.nodeProperties.format", "格式"),
      value: format,
    });
  }

  if (mediaUrl) {
    mediaRows.push({
      label: t("canvas.nodeProperties.source", "源地址"),
      value: mediaUrl,
      multiline: true,
      copyable: true,
    });
  }

  groups.push({
    key: "media",
    title: t("canvas.nodeProperties.groupMedia", "媒体信息"),
    rows: mediaRows,
  });

  // ---------- 生成信息 ----------
  // 取值顺序: 本节点快照 → 上游生成节点的快照 → 由模型反查平台。
  const ownProviderId =
    readString(data, "generationProviderId") ?? readString(ownDebug, "providerId");
  const ownModel =
    readString(ownRequest, "model") ??
    readString(data, "generationModel") ??
    readString(data, "model");
  const ownBaseUrl = readString(data, "providerBaseUrl");
  const ownSourceType =
    readString(data, "generationSourceType") ?? readString(ownDebug, "sourceType");
  const ownJobId = readString(data, "generationJobId");
  const ownStartedAt = readNumber(data, "generationStartedAt");
  const ownError = readString(data, "generationError");
  const ownIsGenerating = data.isGenerating === true;

  /** 本节点自己是否有生成记录(决定要不要退到上游取)。 */
  const hasOwnGenerationInfo = Boolean(
    ownProviderId ||
      ownModel ||
      ownBaseUrl ||
      ownJobId ||
      ownStartedAt ||
      ownError ||
      ownIsGenerating ||
      ownRequest,
  );

  const model =
    ownModel ??
    readString(upstreamData, "generationModel") ??
    readString(upstreamRequest, "model") ??
    readString(upstreamData, "model");
  const providerId =
    ownProviderId ??
    readString(upstreamData, "generationProviderId") ??
    readString(upstreamDebug, "providerId") ??
    (model ? resolveModelProviderId?.(model) ?? null : null);
  const baseUrl =
    ownBaseUrl ??
    readString(upstreamData, "providerBaseUrl") ??
    (providerId ? provider?.baseUrl?.(providerId) ?? null : null);
  const providerLabel = providerId ? provider?.label?.(providerId) ?? providerId : null;
  const sourceType =
    ownSourceType ??
    readString(upstreamData, "generationSourceType") ??
    (upstream ? SOURCE_TYPE_BY_NODE_TYPE[upstream.nodeType] ?? null : null);
  const jobId = ownJobId ?? readString(upstreamData, "generationJobId");
  const startedAt = ownStartedAt ?? readNumber(upstreamData, "generationStartedAt");
  const expectedDurationMs =
    readNumber(data, "generationDurationMs") ?? readNumber(upstreamData, "generationDurationMs");
  const generationError = ownError ?? readString(upstreamData, "generationError");
  const isGenerating = ownIsGenerating;
  const expectedDuration = formatDurationMs(expectedDurationMs);

  const hasGenerationInfo = Boolean(
    providerId ||
      model ||
      baseUrl ||
      jobId ||
      startedAt ||
      generationError ||
      isGenerating ||
      request,
  );
  // 本节点自己没记录、信息来自上游: 面板要标出来, 免得用户以为是结果节点自带的。
  const inheritedFromUpstream = hasGenerationInfo && !hasOwnGenerationInfo && Boolean(upstreamData);

  if (hasGenerationInfo) {
    const generationRows: NodePropertyRow[] = [];

    const push = (label: string, value: string | null, options?: Partial<NodePropertyRow>) => {
      if (!value) {
        return;
      }
      generationRows.push({ label, value, ...options });
    };

    if (inheritedFromUpstream) {
      // 明确标出来源: 这些字段不属于结果节点本身, 而是它上游生成节点当时的记录。
      push(
        t("canvas.nodeProperties.infoSource", "信息来源"),
        `${t("canvas.nodeProperties.fromUpstream", "取自上游")} · ${nodeTypeLabel(upstream?.nodeType ?? "")}`,
      );
    }

    if (sourceType) {
      push(
        t("canvas.nodeProperties.generationSource", "生成来源"),
        GENERATION_SOURCE_LABEL[sourceType] ?? sourceType,
      );
    }
    push(t("canvas.nodeProperties.platform", "生成平台"), providerLabel);
    push(t("canvas.nodeProperties.endpoint", "接口地址"), baseUrl, { copyable: true });
    push(t("canvas.nodeProperties.model", "生成模型"), formatModelLabel(model), { copyable: true });

    // 请求快照里的参数(用户当时实际提交的),优先于节点当前控件值。
    push(
      t("canvas.nodeProperties.sizeTier", "尺寸档位"),
      readString(request, "size") ?? readString(data, "size") ?? readString(upstreamData, "size"),
    );
    push(
      t("canvas.nodeProperties.aspectRatio", "画幅比例"),
      readString(request, "aspectRatio") ??
        readString(data, "requestAspectRatio") ??
        readString(data, "aspectRatio") ??
        readString(upstreamData, "aspectRatio"),
    );
    push(
      t("canvas.nodeProperties.videoResolution", "输出分辨率"),
      readString(request, "videoResolution") ??
        readString(data, "resolution") ??
        readString(upstreamData, "videoResolution") ??
        readString(upstreamData, "resolution"),
    );

    const requestDuration = readNumber(request, "duration");
    if (requestDuration && (mediaKind === "video" || mediaKind === "audio")) {
      push(
        t("canvas.nodeProperties.requestDuration", "生成时长"),
        formatDurationSeconds(requestDuration),
      );
    }

    const imageCount = readNumber(request, "imageCount");
    if (imageCount && imageCount > 0) {
      push(t("canvas.nodeProperties.imageCount", "生成数量"), `${imageCount}`);
    }

    push(t("canvas.nodeProperties.jobId", "任务 ID"), jobId, { copyable: true, multiline: true });
    push(t("canvas.nodeProperties.startedAt", "生成时间"), formatTimestamp(startedAt));

    if (expectedDuration) {
      push(t("canvas.nodeProperties.expectedDuration", "预计耗时"), expectedDuration);
    }

    if (isGenerating) {
      push(
        t("canvas.nodeProperties.status", "生成状态"),
        t("canvas.nodeProperties.statusRunning", "生成中"),
      );
    } else if (generationError) {
      push(
        t("canvas.nodeProperties.status", "生成状态"),
        t("canvas.nodeProperties.statusFailed", "失败"),
      );
      push(t("canvas.nodeProperties.error", "失败原因"), generationError, { multiline: true });
      push(
        t("canvas.nodeProperties.errorDetails", "详细报错"),
        readString(data, "generationErrorDetails"),
        { multiline: true, copyable: true },
      );
    } else if (jobId || request || inheritedFromUpstream) {
      // 结果是实打实存在的媒体文件; 信息取自上游时也说明这次生成已经完成。
      push(
        t("canvas.nodeProperties.status", "生成状态"),
        t("canvas.nodeProperties.statusSucceeded", "已完成"),
      );
    }

    if (generationRows.length > 0) {
      groups.push({
        key: "generation",
        title: t("canvas.nodeProperties.groupGeneration", "生成信息"),
        rows: generationRows,
      });
    }

    // ---------- 参考素材 ----------
    const referenceImageCount =
      readCount(request, "referenceImages") ??
      readCount(data, "referenceImages") ??
      readCount(upstreamData, "referenceImages") ??
      null;
    const referenceAudioCount =
      readCount(request, "referenceAudio") ??
      readCount(data, "studioReferenceAudio") ??
      readNumber(debug, "referenceAudioCount");
    const referenceRows: NodePropertyRow[] = [];
    if (referenceImageCount && referenceImageCount > 0) {
      referenceRows.push({
        label: t("canvas.nodeProperties.referenceImages", "参考图片"),
        value: `${referenceImageCount}`,
      });
    }
    if (referenceAudioCount && referenceAudioCount > 0) {
      referenceRows.push({
        label: t("canvas.nodeProperties.referenceAudio", "参考音频"),
        value: `${referenceAudioCount}`,
      });
    }
    if (referenceRows.length > 0) {
      groups.push({
        key: "references",
        title: t("canvas.nodeProperties.groupReferences", "参考素材"),
        rows: referenceRows,
      });
    }
  } else {
    groups.push({
      key: "no-generation",
      title: t("canvas.nodeProperties.groupGeneration", "生成信息"),
      rows: [
        {
          label: t("canvas.nodeProperties.status", "生成状态"),
          value: t(
            "canvas.nodeProperties.noGeneration",
            "无生成记录（上传或手动导入的素材）",
          ),
        },
      ],
    });
  }

  // ---------- 提示词与内容 ----------
  // 与「生成信息」解耦: 只要节点或上游生成节点上留了提示词就展示, 便于直接复制复用。
  // 取值顺序: 请求快照 → 节点自身 → 上游生成节点(视频/音频的提示词常常只存在生成节点上)。
  const prompt =
    readString(request, "prompt") ?? readString(data, "prompt") ?? readString(upstreamData, "prompt");
  const negativePrompt =
    readString(request, "negativePrompt") ??
    readString(data, "negativePrompt") ??
    readString(upstreamData, "negativePrompt");
  const lyrics =
    readString(request, "lyrics") ?? readString(data, "lyrics") ?? readString(upstreamData, "lyrics");
  const voice =
    readString(request, "voice") ?? readString(data, "voice") ?? readString(upstreamData, "voice");
  const audioKind =
    readString(request, "audioKind") ??
    readString(data, "audioKind") ??
    readString(upstreamData, "audioKind");
  const emotion =
    readString(request, "emotion") ?? readString(data, "emotion") ?? readString(upstreamData, "emotion");

  const promptRows: NodePropertyRow[] = [];
  if (prompt) {
    promptRows.push({
      label: t("canvas.nodeProperties.prompt", "提示词"),
      value: prompt,
      id: "prompt",
      multiline: true,
      copyable: true,
    });
  }
  if (negativePrompt) {
    promptRows.push({
      label: t("canvas.nodeProperties.negativePrompt", "负向提示词"),
      value: negativePrompt,
      multiline: true,
      copyable: true,
    });
  }
  if (lyrics) {
    promptRows.push({
      label: t("canvas.nodeProperties.lyrics", "歌词"),
      value: lyrics,
      multiline: true,
      copyable: true,
    });
  }
  if (voice) {
    promptRows.push({ label: t("canvas.nodeProperties.voice", "音色"), value: voice, copyable: true });
  }
  if (audioKind) {
    promptRows.push({ label: t("canvas.nodeProperties.audioKind", "音频类型"), value: audioKind });
  }
  if (emotion) {
    promptRows.push({ label: t("canvas.nodeProperties.emotion", "情绪"), value: emotion });
  }
  if (promptRows.length > 0) {
    const promptGroup: NodePropertyGroup = {
      key: "prompt",
      title: t("canvas.nodeProperties.groupPrompt", "提示词与内容"),
      rows: promptRows,
    };
    // 紧接「生成信息」放, 比排在参考素材/高级参数后面更好找。
    const generationIndex = groups.findIndex(
      (group) => group.key === "generation" || group.key === "no-generation",
    );
    if (generationIndex >= 0) {
      groups.splice(generationIndex + 1, 0, promptGroup);
    } else {
      groups.push(promptGroup);
    }
  }

  // ---------- 高级参数 ----------
  const extraParams = isRecord(request?.extraParams)
    ? request?.extraParams
    : isRecord(data.extraParams)
      ? data.extraParams
      : null;
  if (extraParams && Object.keys(extraParams).length > 0) {
    groups.push({
      key: "extra-params",
      title: t("canvas.nodeProperties.groupExtraParams", "高级参数"),
      rows: [
        {
          label: t("canvas.nodeProperties.extraParams", "请求附加参数"),
          value: JSON.stringify(extraParams, null, 2),
          multiline: true,
          copyable: true,
        },
      ],
    });
  }

  return groups;
}

/**
 * 把分组渲染成纯文本,供「复制全部」使用。
 * 与面板展示同源,避免复制出来少字段或格式对不上。
 */
export function serializeNodeProperties(
  groups: NodePropertyGroup[],
  header: { name: string; nodeId: string },
): string {
  const lines: string[] = [`${header.name}（${header.nodeId}）`];
  for (const group of groups) {
    lines.push("", `[${group.title}]`);
    for (const row of group.rows) {
      lines.push(`${row.label}：${row.value}`);
    }
  }
  return lines.join("\n");
}
