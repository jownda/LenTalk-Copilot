import { memo, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Handle, Position, type NodeProps, useUpdateNodeInternals } from "@xyflow/react";
import { Accessibility, AudioLines, ImagePlus, LoaderCircle, Upload, UserRound, UserRoundCog, Video } from "lucide-react";
import { useTranslation } from "react-i18next";
import { isTauri } from "@tauri-apps/api/core";

import {
  CANVAS_NODE_TYPES,
  CHARACTER_SWAP_ASPECT_RATIOS,
  CHARACTER_SWAP_DURATION_OPTIONS,
  CHARACTER_SWAP_MEGAPIXEL_OPTIONS,
  CHARACTER_SWAP_STEP_OPTIONS,
  type CharacterSwapAspectRatio,
  type MotionControlLipSyncInput,
  type MotionControlMode,
  type MotionControlNodeData,
} from "@/features/canvas/domain/canvasNodes";
import {
  CHARACTER_SWAP_PROMPT_TEMPLATE,
  resolveCharacterSwapPrompt,
} from "@/features/canvas/domain/characterSwapPrompt";
import { MOTION_CONTROL_SWAP_DISPLAY_NAME, resolveNodeDisplayName } from "@/features/canvas/domain/nodeDisplay";
import { canvasAiGateway, graphImageResolver } from "@/features/canvas/application/canvasServices";
import { useCanvasInputGraph } from "@/features/canvas/application/useCanvasInputGraph";
import { prepareNodeImageFromFile } from "@/features/canvas/application/imageData";
import { useThumbnailFallback } from "@/features/canvas/ui/useCanvasImageSource";
import { getVideoModel, listVideoModels } from "@/features/canvas/models";
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from "@/features/canvas/ui/NodeHeader";
import { NodeResizeHandle } from "@/features/canvas/ui/NodeResizeHandle";
import { showErrorDialog } from "@/features/canvas/application/errorDialog";
import { useCanvasStore } from "@/stores/canvasStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { persistLibraryAssetFile, persistLibraryAssetFromFile } from "@/commands/assetLibrary";
import { isZzdhLipSyncModel } from "@/commands/zzdhApi";
import {
  isRunningHubBaseUrl,
  isRunningHubDedicatedVideoEndpoint,
} from "@/commands/runningHubProtocol";

type MotionControlNodeProps = NodeProps & {
  id: string;
  data: MotionControlNodeData;
  selected?: boolean;
  width?: number;
  height?: number;
};

type UploadKind = "image" | "motion-video" | "source-video" | "audio";

function fileExtension(file: File): string {
  const extension = file.name.split(".").pop()?.trim().toLowerCase();
  return extension && /^[a-z0-9]{1,8}$/.test(extension) ? extension : "bin";
}

async function persistMediaFile(file: File): Promise<string> {
  const path = (file as File & { path?: string }).path?.trim();
  if (isTauri()) {
    if (path) {
      return await persistLibraryAssetFile(path, fileExtension(file));
    }
    return await persistLibraryAssetFromFile(file, fileExtension(file));
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
  return dataUrl;
}

function sourceLabel(source: string | null | undefined, fallback: string): string {
  if (!source) return fallback;
  if (/^data:/i.test(source)) return fallback;
  const clean = source.split(/[\\/]/).pop()?.trim();
  return clean || fallback;
}

function resolveModeModelLabel(modelId: string): string {
  const model = modelId ? getVideoModel(modelId) : undefined;
  return model?.displayName ?? modelId;
}

/**
 * 素材预览小方块（36x48）。
 *
 * 这里原先是 `resolveImageDisplayUrl(preview)` 把原图直接喂给 `<img>` —— 一张 4000x3000 的
 * 照片解码要几十 MB 瞬时内存，却只画一个 36px 的方块，节点一挂就是好几张。
 * 现在走 256 缩略图（与素材选择器**共用同一份缓存**，磁盘命中几乎零成本）。
 */
const MotionSourceThumb = memo(({ source, alt }: { source: string; alt: string }) => {
  const image = useThumbnailFallback(source);
  if (image.isPlaceholder) {
    return <div className="h-9 w-12 animate-pulse rounded bg-white/[0.06]" aria-hidden />;
  }
  return <img src={image.url ?? ""} alt={alt} className="h-9 w-12 rounded object-cover" />;
});
MotionSourceThumb.displayName = "MotionSourceThumb";

export const MotionControlNode = memo(({ id, data, selected, width, height }: MotionControlNodeProps) => {
  const { t } = useTranslation();
  const updateNodeInternals = useUpdateNodeInternals();
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const addNode = useCanvasStore((state) => state.addNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const findNodePosition = useCanvasStore((state) => state.findNodePosition);
  const { nodes, edges } = useCanvasInputGraph();
  const apiKeys = useSettingsStore((state) => state.apiKeys);
  const customApis = useSettingsStore((state) => state.customApis);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadKind, setUploadKind] = useState<UploadKind | null>(null);
  const [isGenerating, setIsGenerating] = useState(Boolean(data.isGenerating));
  const [error, setError] = useState<string | null>(data.generationError ?? null);

  const inputImages = useMemo(() => graphImageResolver.collectInputImages(id, nodes, edges), [edges, id, nodes]);
  const inputVideos = useMemo(() => graphImageResolver.collectInputVideos(id, nodes, edges), [edges, id, nodes]);
  const inputAudio = useMemo(() => graphImageResolver.collectInputAudio(id, nodes, edges), [edges, id, nodes]);

  const mode: MotionControlMode =
    data.mode === "lip-sync"
      ? "lip-sync"
      : data.mode === "character-swap"
        ? "character-swap"
        : "motion-control";
  const models = useMemo(() => {
    // 角色替换对应的是一个**具体的 RunningHub 应用**，不是可选的视频模型 ——
    // 它没有模型下拉，直接返回空表让下面所有 model 相关计算短路。
    if (mode === "character-swap") return [];
    const allVideoModels = listVideoModels();
    const isRunningHubModel = (model: (typeof allVideoModels)[number]) => {
      const providerId = model.providerId.replace(/^custom:/, "");
      const api = customApis.find((item) => item.id === providerId);
      const endpoint = model.id.split("/").slice(1).join("/");
      return isRunningHubBaseUrl(api?.baseUrl) && isRunningHubDedicatedVideoEndpoint(endpoint);
    };
    const klingModels = allVideoModels.filter(
      (model) =>
        model.id.startsWith("custom:") &&
        (model.id.toLowerCase().includes("kling") ||
          model.displayName.toLowerCase().includes("kling") ||
          model.displayName.toLowerCase().includes("可灵")),
    );
    if (mode !== "motion-control") {
      // RunningHub 的数字人口播端点是专用 RunningHub 协议；其它 Kling 模型继续
      // 走现有 Kling 对口型端点，避免把普通文生/图生模型误放进对口型页。
      return klingModels.filter(
        (model) => isRunningHubModel(model) || isZzdhLipSyncModel(model.id) || !isRunningHubBaseUrl(
          customApis.find((item) => item.id === model.providerId.replace(/^custom:/, ""))?.baseUrl,
        ),
      );
    }
    return klingModels.filter(
      (model) =>
        (!isRunningHubModel(model) && model.id.toLowerCase().includes("motion-control")) ||
        model.displayName.toLowerCase().includes("motion control") ||
        model.displayName.toLowerCase().includes("动作控制"),
    );
  }, [customApis, mode]);
  const allModels = useMemo(() => {
    if (mode === "motion-control") return models;
    if (mode === "character-swap") return [];
    const lipSyncModels = listVideoModels().filter(
      (model) => {
        if (isZzdhLipSyncModel(model.id)) return true;
        if (!model.id.startsWith("custom:") || !model.id.toLowerCase().includes("kling")) return false;
        const providerId = model.providerId.replace(/^custom:/, "");
        const api = customApis.find((item) => item.id === providerId);
        const endpoint = model.id.split("/").slice(1).join("/");
        return !isRunningHubBaseUrl(api?.baseUrl) || isRunningHubDedicatedVideoEndpoint(endpoint);
      },
    );
    return lipSyncModels;
  }, [customApis, mode, models]);
  const selectedModelId = allModels.some((model) => model.id === data.model) ? data.model : allModels[0]?.id || "";
  const imageSource = data.imageSource || inputImages[0] || null;
  const motionVideoSource = data.motionVideoSource || inputVideos[0] || null;
  const sourceVideo = data.inputVideoSource || inputVideos[0] || null;
  const audioSource = data.audioSource || inputAudio[0] || null;
  const isZzdhLipSync = mode === "lip-sync" && isZzdhLipSyncModel(selectedModelId);
  const selectedProviderId = selectedModelId.split("/")[0]?.replace(/^custom:/, "") ?? "";
  const selectedApiBaseUrl = customApis.find((item) => item.id === selectedProviderId)?.baseUrl ?? "";
  const isRunningHubLipSync =
    mode === "lip-sync" &&
    isRunningHubBaseUrl(selectedApiBaseUrl) &&
    isRunningHubDedicatedVideoEndpoint(selectedModelId.split("/").slice(1).join("/"));
  const lipSyncInput: MotionControlLipSyncInput = data.lipSyncInput === "video" ? "video" : "image";
  const zzdhUsesVideoInput = isZzdhLipSync && lipSyncInput === "video";
  const lipSyncNeedsSourceVideo = mode === "lip-sync" && !isZzdhLipSync && !isRunningHubLipSync;
  /**
   * 角色替换的「渠道」= 任意一条 RunningHub 平台配置。
   *
   * 它只需要 Base URL + Key，与具体模型无关，所以不能复用上面的模型下拉：
   * 应用本身（webappId）是写死的，用户能选的只有走哪条 Key。
   */
  const runningHubProviders = useMemo(
    () => customApis.filter((api) => isRunningHubBaseUrl(api.baseUrl)),
    [customApis],
  );
  const storedSwapProviderId = typeof data.swapProviderId === "string" ? data.swapProviderId : "";
  const swapProviderId = runningHubProviders.some((api) => api.id === storedSwapProviderId)
    ? storedSwapProviderId
    : runningHubProviders[0]?.id ?? "";
  const swapProviderBaseUrl = runningHubProviders.find((api) => api.id === swapProviderId)?.baseUrl ?? "";
  // 三个出片参数的取值都做一次收敛：老节点没有这些字段，读出来是 undefined。
  const swapAspectRatio: CharacterSwapAspectRatio = (
    CHARACTER_SWAP_ASPECT_RATIOS as readonly string[]
  ).includes(data.swapAspectRatio ?? "")
    ? (data.swapAspectRatio as CharacterSwapAspectRatio)
    : "16:9";
  const swapMegapixels =
    Number.isFinite(Number(data.swapMegapixels)) && Number(data.swapMegapixels) > 0
      ? Number(data.swapMegapixels)
      : 0.8;
  const swapSteps =
    Number.isFinite(Number(data.swapSteps)) && Number(data.swapSteps) > 0
      ? Math.round(Number(data.swapSteps))
      : 8;
  const swapDuration =
    Number.isFinite(Number(data.swapDuration)) && Number(data.swapDuration) > 0
      ? Math.round(Number(data.swapDuration))
      : 5;
  /**
   * 像素档位 → 实际输出尺寸的**近似值**（按应用文档的说法短边对齐 32）。
   *
   * 应用侧是按 `sqrt(MP / (w*h))` 缩放后再对齐，这里照同一口径估一个给人看的数字；
   * 不用它参与请求 —— 真正的尺寸由平台自己算。
   */
  const swapOutputSize = useMemo(() => {
    const [aspectWidth, aspectHeight] = swapAspectRatio.split(":").map(Number);
    if (!aspectWidth || !aspectHeight) return "";
    const scale = Math.sqrt((swapMegapixels * 1_000_000) / (aspectWidth * aspectHeight));
    const align = (value: number) => Math.max(32, Math.round((value * scale) / 32) * 32);
    return `${align(aspectWidth)}×${align(aspectHeight)}`;
  }, [swapAspectRatio, swapMegapixels]);
  const resolvedWidth = Math.max(360, Math.round(width ?? 420));
  // 角色替换模式多一行参数 + 一行模板工具条；老节点存下来的 460 高会把底部按钮挤没。
  const resolvedHeight = Math.max(500, Math.round(height ?? 560));

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, mode, updateNodeInternals]);

  useEffect(() => {
    if (data.model !== selectedModelId && selectedModelId) {
      updateNodeData(id, { model: selectedModelId });
    }
  }, [data.model, id, selectedModelId, updateNodeData]);

  useEffect(() => {
    return () => {
      for (const source of [data.motionVideoPreviewUrl, data.inputVideoPreviewUrl, data.audioPreviewUrl]) {
        if (source?.startsWith("blob:")) URL.revokeObjectURL(source);
      }
    };
  }, [data.audioPreviewUrl, data.inputVideoPreviewUrl, data.motionVideoPreviewUrl]);

  const openUpload = useCallback((kind: UploadKind) => {
    setUploadKind(kind);
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      const kind = uploadKind;
      event.target.value = "";
      if (!file || !kind) return;
      try {
        if (kind === "image") {
          const prepared = await prepareNodeImageFromFile(file);
          updateNodeData(id, {
            imageSource: prepared.imageUrl,
            imagePreviewUrl: prepared.previewImageUrl,
          });
        } else {
          const source = await persistMediaFile(file);
          const preview = URL.createObjectURL(file);
          const fields: Partial<MotionControlNodeData> =
            kind === "motion-video"
              ? { motionVideoSource: source, motionVideoPreviewUrl: preview }
              : kind === "source-video"
                ? { inputVideoSource: source, inputVideoPreviewUrl: preview }
                : { audioSource: source, audioPreviewUrl: preview };
          updateNodeData(id, fields);
        }
      } catch (uploadError) {
        const message = uploadError instanceof Error ? uploadError.message : String(uploadError);
        setError(message);
        void showErrorDialog(message, t("common.error"));
      } finally {
        setUploadKind(null);
      }
    },
    [id, t, updateNodeData, uploadKind],
  );

  const handleGenerate = useCallback(async () => {
    setError(null);
    const chosenModel = getVideoModel(selectedModelId);
    if (!chosenModel) return setError(t("node.motionControl.needModel"));
    if (!imageSource && mode === "motion-control") return setError(t("node.motionControl.needImage"));
    if (!motionVideoSource && mode === "motion-control") return setError(t("node.motionControl.needMotionVideo"));
    if (!sourceVideo && (lipSyncNeedsSourceVideo || zzdhUsesVideoInput))
      return setError(t("node.motionControl.needSourceVideo"));
    if (!imageSource && (isZzdhLipSync || isRunningHubLipSync) && !zzdhUsesVideoInput) {
      return setError(t("node.motionControl.needLipSyncImage"));
    }
    if (!audioSource && mode === "lip-sync") return setError(t("node.motionControl.needAudio"));
    const providerKey = apiKeys[chosenModel.providerId] ?? "";
    if (!providerKey.trim() && !chosenModel.id.startsWith("jimeng-cli/")) {
      return setError(t("node.imageEdit.apiKeyRequired"));
    }

    const prompt = data.prompt.trim();
    const outputId = addNode(CANVAS_NODE_TYPES.audio, findNodePosition(id, 420, 260), {
      displayName: prompt || resolveNodeDisplayName(CANVAS_NODE_TYPES.motionControl, data),
      mediaType: "video",
      sourcePath: null,
      aspectRatio: "16:9",
      isGenerating: true,
      generationStartedAt: Date.now(),
      generationProviderId: chosenModel.providerId,
      generationModel: chosenModel.id,
      providerBaseUrl:
        customApis.find((api) => api.id === chosenModel.providerId.replace(/^custom:/, ""))?.baseUrl ?? null,
    });
    addEdge(id, outputId);
    setIsGenerating(true);
    updateNodeData(id, { isGenerating: true, generationError: null });

    try {
      const outputUrl = await canvasAiGateway.generateVideo({
        prompt,
        model: chosenModel.id,
        duration: mode === "lip-sync" ? 10 : Number(data.duration ?? 5),
        aspectRatio: "16:9",
        videoResolution: data.resolution,
        referenceImages:
          (mode === "motion-control" || ((isZzdhLipSync || isRunningHubLipSync) && !zzdhUsesVideoInput)) && imageSource
            ? [imageSource]
            : [],
        referenceAudio: mode === "lip-sync" && audioSource ? [audioSource] : [],
        extraParams: {
          video_transport: isZzdhLipSync
            ? "zzdh-v8-video"
            : isRunningHubLipSync
              ? "runninghub-model"
              : "kling-control",
          control_mode: mode,
          character_orientation: data.characterOrientation,
          keep_original_audio: data.keepOriginalAudio,
          resolution: data.resolution,
          motion_reference_video: motionVideoSource,
          source_video: sourceVideo,
          reference_videos: zzdhUsesVideoInput && sourceVideo ? [sourceVideo] : undefined,
          lip_sync_audio: audioSource,
          face_session_id: data.faceSessionId?.trim(),
          face_id: data.faceId?.trim(),
        },
      });
      updateNodeData(outputId, {
        sourcePath: outputUrl,
        isGenerating: false,
        generationResultProtected: true,
      });
      updateNodeData(id, { isGenerating: false, outputVideoUrl: outputUrl });
    } catch (generationError) {
      const message = generationError instanceof Error ? generationError.message : String(generationError);
      setError(message);
      updateNodeData(outputId, { isGenerating: false, generationError: message, generationErrorDetails: message });
      updateNodeData(id, { isGenerating: false, generationError: message });
      void showErrorDialog(message, t("node.motionControl.generationFailed"));
    } finally {
      setIsGenerating(false);
    }
  }, [
    addEdge,
    addNode,
    apiKeys,
    audioSource,
    customApis,
    data,
    findNodePosition,
    id,
    imageSource,
    isZzdhLipSync,
    isRunningHubLipSync,
    lipSyncNeedsSourceVideo,
    mode,
    motionVideoSource,
    selectedModelId,
    sourceVideo,
    t,
    updateNodeData,
    zzdhUsesVideoInput,
  ]);

  /**
   * 角色替换：把原视频里的人物换成参考图里的角色（RunningHub 应用「更换视频人物MinimaxH3」）。
   *
   * 与另外两个模式的区别是**没有模型可选**：提交目标是一个固定应用，模型 id 只需拼出
   * `custom:<providerId>/...` 供网关取 Key，斜杠后面那截只作标识用途。
   *
   * 提示词留空时发的是**通用模板**（`resolveCharacterSwapPrompt`），不是"不传"：
   * 应用自带的那个内置模板是围着一位具体角色写的，留空等于把别人的衣服发型套到你的
   * 角色身上 —— 看着像"不干预"，其实干预得最狠。
   */
  const handleCharacterSwap = useCallback(async () => {
    setError(null);
    if (!imageSource) return setError(t("node.motionControl.needSwapImage"));
    if (!sourceVideo) return setError(t("node.motionControl.needSwapVideo"));
    if (!swapProviderId) return setError(t("node.motionControl.needRunningHub"));
    const providerKey = apiKeys[`custom:${swapProviderId}`] ?? "";
    if (!providerKey.trim()) return setError(t("node.imageEdit.apiKeyRequired"));

    const prompt = data.prompt.trim();
    const modelId = `custom:${swapProviderId}/runninghub-character-swap`;
    const outputId = addNode(CANVAS_NODE_TYPES.audio, findNodePosition(id, 420, 260), {
      displayName: prompt
        ? prompt.slice(0, 24)
        : resolveNodeDisplayName(CANVAS_NODE_TYPES.motionControl, data),
      mediaType: "video",
      sourcePath: null,
      aspectRatio: swapAspectRatio,
      isGenerating: true,
      generationStartedAt: Date.now(),
      generationProviderId: `custom:${swapProviderId}`,
      generationModel: modelId,
      providerBaseUrl: swapProviderBaseUrl || null,
    });
    addEdge(id, outputId);
    setIsGenerating(true);
    updateNodeData(id, { isGenerating: true, generationError: null });

    try {
      const outputUrl = await canvasAiGateway.characterSwapVideo({
        characterImage: imageSource,
        videoSource: sourceVideo,
        model: modelId,
        prompt: resolveCharacterSwapPrompt(data.prompt),
        duration: swapDuration,
        aspectRatio: swapAspectRatio,
        megapixels: swapMegapixels,
        steps: swapSteps,
        extraParams: { provider_base_url: swapProviderBaseUrl },
      });
      updateNodeData(outputId, {
        sourcePath: outputUrl,
        isGenerating: false,
        generationResultProtected: true,
      });
      updateNodeData(id, { isGenerating: false, outputVideoUrl: outputUrl });
    } catch (generationError) {
      const message = generationError instanceof Error ? generationError.message : String(generationError);
      setError(message);
      updateNodeData(outputId, { isGenerating: false, generationError: message, generationErrorDetails: message });
      updateNodeData(id, { isGenerating: false, generationError: message });
      void showErrorDialog(message, t("node.motionControl.generationFailed"));
    } finally {
      setIsGenerating(false);
    }
  }, [
    addEdge,
    addNode,
    apiKeys,
    data,
    findNodePosition,
    id,
    imageSource,
    sourceVideo,
    swapAspectRatio,
    swapDuration,
    swapMegapixels,
    swapProviderBaseUrl,
    swapProviderId,
    swapSteps,
    t,
    updateNodeData,
  ]);

  const setMode = (nextMode: MotionControlMode) => {
    const patch: Partial<MotionControlNodeData> = { mode: nextMode };
    // 标题还是默认值时跟着模式走：切到角色替换要把「动作控制 / 对口型」换掉，
    // 切回来也要还原；用户自己改过的名字一律不动。
    const currentTitle = typeof data.displayName === "string" ? data.displayName.trim() : "";
    if (
      nextMode === "character-swap" &&
      (currentTitle === "" || currentTitle === resolveNodeDisplayName(CANVAS_NODE_TYPES.motionControl, {}))
    ) {
      patch.displayName = MOTION_CONTROL_SWAP_DISPLAY_NAME;
    } else if (nextMode !== "character-swap" && currentTitle === MOTION_CONTROL_SWAP_DISPLAY_NAME) {
      patch.displayName = resolveNodeDisplayName(CANVAS_NODE_TYPES.motionControl, {});
    }
    updateNodeData(id, patch);
    setError(null);
  };

  const renderSource = (
    kind: UploadKind,
    label: string,
    source: string | null,
    preview: string | null | undefined,
    icon: React.ReactNode,
  ) => (
    <div className="min-w-0 rounded-lg border border-border-dark bg-bg-dark/60 p-2">
      <div className="mb-1 flex items-center gap-1 text-[11px] text-text-muted">
        {icon}
        <span>{label}</span>
      </div>
      <button
        type="button"
        className="nodrag flex h-12 w-full items-center gap-2 overflow-hidden rounded border border-dashed border-border-dark px-2 text-left text-xs text-text-muted hover:border-accent/60 hover:text-text-dark"
        onClick={(event) => {
          event.stopPropagation();
          openUpload(kind);
        }}
        onMouseDown={(event) => event.stopPropagation()}
        title={sourceLabel(source, t("node.motionControl.notSet"))}
      >
        {preview ? (
          kind === "image" ? (
            <MotionSourceThumb source={preview} alt={label} />
          ) : (
            <span className="flex h-9 w-12 items-center justify-center rounded bg-accent/10 text-accent">{icon}</span>
          )
        ) : (
          <Upload className="h-4 w-4 shrink-0" />
        )}
        <span className="truncate">
          {source ? sourceLabel(source, t("node.motionControl.connected")) : t("node.motionControl.upload")}
        </span>
      </button>
    </div>
  );

  return (
    // `[&>*]:shrink-0` —— 除提示词输入框外，所有块都保持自身高度：拖外框拉高节点时，
    // 增长的只有那个 `flex-1` 的 textarea（见下面 textarea 的类名）。
    // 逐个给二十来个块写 `shrink-0` 只会让 diff 变长，后代选择器一处说清更不容易漏。
    <div
      className={`relative flex h-full flex-col gap-2 rounded-xl border bg-surface-dark p-3 text-text-dark shadow-lg ${selected ? "border-accent/70 ring-1 ring-accent/30" : "border-border-dark"} [&>*]:shrink-0`}
      style={{ width: resolvedWidth, height: resolvedHeight }}
    >
      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<Accessibility className="h-4 w-4" />}
        titleText={resolveNodeDisplayName(CANVAS_NODE_TYPES.motionControl, data)}
        editable
        onTitleChange={(displayName) => updateNodeData(id, { displayName })}
      />
      <Handle
        type="target"
        position={Position.Left}
        id="target"
        className="!h-3 !w-3 !border-2 !border-surface-dark !bg-accent"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="source"
        className="!h-3 !w-3 !border-2 !border-surface-dark !bg-accent"
      />

      <div className="mt-7 flex gap-1 rounded-lg bg-bg-dark p-1">
        {(["motion-control", "lip-sync", "character-swap"] as MotionControlMode[]).map((item) => (
          <button
            key={item}
            type="button"
            className={`nodrag flex-1 rounded-md px-1.5 py-1.5 text-xs ${mode === item ? "bg-accent/20 text-text-dark" : "text-text-muted hover:text-text-dark"}`}
            onClick={(event) => {
              event.stopPropagation();
              setMode(item);
            }}
          >
            {t(
              item === "motion-control"
                ? "node.motionControl.modeMotion"
                : item === "lip-sync"
                  ? "node.motionControl.modeLipSync"
                  : "node.motionControl.modeCharacterSwap",
            )}
          </button>
        ))}
      </div>

      <div className="text-[10px] leading-4 text-text-muted">
        {t(
          mode === "motion-control"
            ? "node.motionControl.motionHint"
            : mode === "character-swap"
              ? "node.motionControl.swapHint"
              : isZzdhLipSync
                ? "node.motionControl.zzdhLipHint"
                : "node.motionControl.faceHint",
        )}
      </div>

      {mode === "character-swap" ? (
        <>
          <select
            className="nodrag h-8 rounded border border-border-dark bg-bg-dark px-2 text-xs text-text-dark"
            value={swapProviderId}
            onChange={(event) => updateNodeData(id, { swapProviderId: event.target.value })}
            onMouseDown={(event) => event.stopPropagation()}
          >
            {runningHubProviders.length === 0 ? (
              <option value="">{t("node.motionControl.swapNoProvider")}</option>
            ) : null}
            {runningHubProviders.map((api) => (
              <option key={api.id} value={api.id}>
                {api.name || api.id}
              </option>
            ))}
          </select>
          <div className="truncate text-[10px] text-text-muted" title={swapProviderBaseUrl}>
            {t("node.motionControl.swapAppLabel")}
          </div>
          <div className="text-[10px] leading-4 text-text-muted">
            {t(
              runningHubProviders.length === 0
                ? "node.motionControl.swapProviderMissing"
                : "node.motionControl.swapProviderHint",
            )}
          </div>
        </>
      ) : (
        <>
          <select
            className="nodrag h-8 rounded border border-border-dark bg-bg-dark px-2 text-xs text-text-dark"
            value={selectedModelId}
            onChange={(event) => updateNodeData(id, { model: event.target.value })}
            onMouseDown={(event) => event.stopPropagation()}
          >
            {allModels.length === 0 ? <option value="">{t("node.motionControl.needModel")}</option> : null}
            {allModels.map((model) => (
              <option key={model.id} value={model.id}>
                {model.displayName}
              </option>
            ))}
          </select>
          <div className="truncate text-[10px] text-text-muted" title={selectedModelId}>
            {resolveModeModelLabel(selectedModelId) || t("node.motionControl.needModel")}
          </div>
          <div className="text-[10px] leading-4 text-text-muted">
            {t(isZzdhLipSync ? "node.motionControl.zzdhModelHint" : "node.motionControl.modelHint")}
          </div>
        </>
      )}

      {mode === "character-swap" ? (
        <div className="grid grid-cols-2 gap-2">
          {renderSource(
            "image",
            t("node.motionControl.swapCharacterImage"),
            imageSource,
            data.imagePreviewUrl || imageSource,
            <UserRound className="h-4 w-4" />,
          )}
          {renderSource(
            "source-video",
            t("node.motionControl.swapSourceVideo"),
            sourceVideo,
            data.inputVideoPreviewUrl,
            <Video className="h-4 w-4" />,
          )}
        </div>
      ) : mode === "motion-control" ? (
        <div className="grid grid-cols-2 gap-2">
          {renderSource(
            "image",
            t("node.motionControl.characterImage"),
            imageSource,
            data.imagePreviewUrl || imageSource,
            <ImagePlus className="h-4 w-4" />,
          )}
          {renderSource(
            "motion-video",
            t("node.motionControl.motionVideo"),
            motionVideoSource,
            data.motionVideoPreviewUrl,
            <Video className="h-4 w-4" />,
          )}
        </div>
      ) : isZzdhLipSync ? (
        <div className="space-y-2">
          <div className="flex gap-1 rounded-lg bg-bg-dark p-1">
            {(["image", "video"] as MotionControlLipSyncInput[]).map((item) => (
              <button
                key={item}
                type="button"
                className={`nodrag flex-1 rounded-md px-2 py-1.5 text-[11px] ${lipSyncInput === item ? "bg-accent/20 text-text-dark" : "text-text-muted hover:text-text-dark"}`}
                onClick={(event) => {
                  event.stopPropagation();
                  updateNodeData(id, { lipSyncInput: item });
                  setError(null);
                }}
                onMouseDown={(event) => event.stopPropagation()}
              >
                {t(item === "image" ? "node.motionControl.lipSyncImageAudio" : "node.motionControl.lipSyncVideoAudio")}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {zzdhUsesVideoInput
              ? renderSource(
                  "source-video",
                  t("node.motionControl.sourceVideo"),
                  sourceVideo,
                  data.inputVideoPreviewUrl,
                  <Video className="h-4 w-4" />,
                )
              : renderSource(
                  "image",
                  t("node.motionControl.characterImage"),
                  imageSource,
                  data.imagePreviewUrl || imageSource,
                  <ImagePlus className="h-4 w-4" />,
                )}
            {renderSource(
              "audio",
              t("node.motionControl.sourceAudio"),
              audioSource,
              data.audioPreviewUrl,
              <AudioLines className="h-4 w-4" />,
            )}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {renderSource(
            "source-video",
            t("node.motionControl.sourceVideo"),
            sourceVideo,
            data.inputVideoPreviewUrl,
            <Video className="h-4 w-4" />,
          )}
          {renderSource(
            "audio",
            t("node.motionControl.sourceAudio"),
            audioSource,
            data.audioPreviewUrl,
            <AudioLines className="h-4 w-4" />,
          )}
        </div>
      )}

      {mode === "character-swap" && (
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[10px] text-text-muted">
            {t("node.motionControl.swapPromptLabel")}
          </span>
          <button
            type="button"
            className="nodrag shrink-0 rounded px-1.5 py-0.5 text-[10px] text-accent hover:bg-accent/10"
            onClick={(event) => {
              event.stopPropagation();
              // 手写过的提示词不能一键冲掉 —— 覆盖前先问一次。
              if (
                data.prompt.trim() &&
                !window.confirm(t("node.motionControl.swapPromptReplaceConfirm"))
              ) {
                return;
              }
              updateNodeData(id, { prompt: CHARACTER_SWAP_PROMPT_TEMPLATE });
            }}
            onMouseDown={(event) => event.stopPropagation()}
            title={t("node.motionControl.swapPromptTemplateHint")}
          >
            {t("node.motionControl.swapPromptTemplate")}
          </button>
        </div>
      )}

      {/*
        提示词框是这张卡片里**唯一**会吸收尺寸变化的元素（`flex-1`）：
        拖外框拉高节点，长高的只有它；内容超长时内部滚动，不会把节点撑破。
      */}
      <textarea
        className="nodrag nowheel ui-scrollbar min-h-[52px] flex-1 resize-none overflow-y-auto rounded border border-border-dark bg-bg-dark p-2 text-xs text-text-dark outline-none placeholder:text-text-muted focus:border-accent/60"
        value={data.prompt}
        placeholder={t(
          mode === "character-swap"
            ? "node.motionControl.swapPromptPlaceholder"
            : "node.motionControl.promptPlaceholder",
        )}
        onChange={(event) => updateNodeData(id, { prompt: event.target.value })}
        onMouseDown={(event) => event.stopPropagation()}
      />

      {mode === "character-swap" ? (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[10px] text-text-muted">
              {t("node.motionControl.swapDuration")}
              <select
                className="nodrag mt-1 h-7 w-full rounded border border-border-dark bg-bg-dark px-1.5 text-xs text-text-dark"
                value={String(swapDuration)}
                onChange={(event) => updateNodeData(id, { swapDuration: Number(event.target.value) })}
                onMouseDown={(event) => event.stopPropagation()}
              >
                {CHARACTER_SWAP_DURATION_OPTIONS.map((value) => (
                  <option key={value} value={String(value)}>
                    {value} {t("node.motionControl.swapSeconds")}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[10px] text-text-muted">
              {t("node.motionControl.swapAspectRatio")}
              <select
                className="nodrag mt-1 h-7 w-full rounded border border-border-dark bg-bg-dark px-1.5 text-xs text-text-dark"
                value={swapAspectRatio}
                onChange={(event) =>
                  updateNodeData(id, { swapAspectRatio: event.target.value as CharacterSwapAspectRatio })
                }
                onMouseDown={(event) => event.stopPropagation()}
              >
                {CHARACTER_SWAP_ASPECT_RATIOS.map((ratio) => (
                  <option key={ratio} value={ratio}>
                    {ratio}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[10px] text-text-muted">
              {t("node.motionControl.swapMegapixels")}
              <select
                className="nodrag mt-1 h-7 w-full rounded border border-border-dark bg-bg-dark px-1.5 text-xs text-text-dark"
                value={String(swapMegapixels)}
                onChange={(event) => updateNodeData(id, { swapMegapixels: Number(event.target.value) })}
                onMouseDown={(event) => event.stopPropagation()}
              >
                {CHARACTER_SWAP_MEGAPIXEL_OPTIONS.map((value) => (
                  <option key={value} value={String(value)}>
                    {value.toFixed(1)} MP
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[10px] text-text-muted">
              {t("node.motionControl.swapSteps")}
              <select
                className="nodrag mt-1 h-7 w-full rounded border border-border-dark bg-bg-dark px-1.5 text-xs text-text-dark"
                value={String(swapSteps)}
                onChange={(event) => updateNodeData(id, { swapSteps: Number(event.target.value) })}
                onMouseDown={(event) => event.stopPropagation()}
              >
                {CHARACTER_SWAP_STEP_OPTIONS.map((value) => (
                  <option key={value} value={String(value)}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="text-[10px] leading-4 text-text-muted">
            {t("node.motionControl.swapOutputSummary", { size: swapOutputSize, seconds: swapDuration })}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-text-muted">
            {t("node.motionControl.resolution")}
            <select
              className="nodrag mt-1 h-7 w-full rounded border border-border-dark bg-bg-dark px-1.5 text-xs text-text-dark"
              value={data.resolution}
              onChange={(event) =>
                updateNodeData(id, { resolution: event.target.value as MotionControlNodeData["resolution"] })
              }
            >
              <option value="720p">720p</option>
              <option value="1080p">1080p</option>
            </select>
          </label>
          {mode === "motion-control" ? (
            <label className="text-[10px] text-text-muted">
              {t("node.motionControl.orientation")}
              <select
                className="nodrag mt-1 h-7 w-full rounded border border-border-dark bg-bg-dark px-1.5 text-xs text-text-dark"
                value={data.characterOrientation}
                onChange={(event) =>
                  updateNodeData(id, {
                    characterOrientation: event.target.value as MotionControlNodeData["characterOrientation"],
                  })
                }
              >
                <option value="image">{t("node.motionControl.orientationImage")}</option>
                <option value="video">{t("node.motionControl.orientationVideo")}</option>
              </select>
            </label>
          ) : (
            <label className="text-[10px] text-text-muted">
              {t("node.motionControl.faceId")}
              <input
                className="nodrag mt-1 h-7 w-full rounded border border-border-dark bg-bg-dark px-1.5 text-xs text-text-dark"
                value={data.faceId ?? ""}
                onChange={(event) => updateNodeData(id, { faceId: event.target.value })}
              />
            </label>
          )}
        </div>
      )}

      {mode === "lip-sync" && (
        <input
          className="nodrag h-7 rounded border border-border-dark bg-bg-dark px-1.5 text-xs text-text-dark"
          placeholder={t("node.motionControl.faceSessionId")}
          value={data.faceSessionId ?? ""}
          onChange={(event) => updateNodeData(id, { faceSessionId: event.target.value })}
          onMouseDown={(event) => event.stopPropagation()}
        />
      )}

      {mode === "motion-control" && (
        <label className="flex items-center gap-2 text-[11px] text-text-muted">
          <input
            type="checkbox"
            checked={data.keepOriginalAudio}
            onChange={(event) => updateNodeData(id, { keepOriginalAudio: event.target.checked })}
          />
          {t("node.motionControl.keepOriginalAudio")}
        </label>
      )}

      {error && (
        <div className="max-h-12 overflow-auto rounded bg-red-500/10 px-2 py-1 text-[10px] leading-4 text-red-300">
          {error}
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept={uploadKind === "image" ? "image/*" : uploadKind === "audio" ? "audio/*" : "video/*"}
        className="hidden"
        onChange={handleFileChange}
      />
      <button
        type="button"
        className="nodrag mt-auto flex h-8 items-center justify-center gap-1.5 rounded-md bg-accent px-3 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
        disabled={isGenerating}
        onClick={(event) => {
          event.stopPropagation();
          void (mode === "character-swap" ? handleCharacterSwap() : handleGenerate());
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {isGenerating ? (
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
        ) : mode === "character-swap" ? (
          <UserRoundCog className="h-3.5 w-3.5" />
        ) : (
          <Accessibility className="h-3.5 w-3.5" />
        )}
        {isGenerating
          ? t("node.motionControl.generating")
          : t(mode === "character-swap" ? "node.motionControl.swapGenerate" : "node.motionControl.generate")}
      </button>
      {/* 角色替换多了一行参数 + 一行「插入通用模板」工具条，460 会把生成按钮挤出去。 */}
      <NodeResizeHandle minWidth={360} minHeight={500} maxWidth={720} maxHeight={900} />
    </div>
  );
});

MotionControlNode.displayName = "MotionControlNode";
