import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ScanSearch, Wand2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Handle, Position } from "@xyflow/react";

import { chatCompletion, type ChatCompletionContentPart } from "@/commands/ai";
import { imageUrlToDataUrl } from "@/features/canvas/application/imageData";
import { graphImageResolver } from "@/features/canvas/application/canvasServices";
import { useCanvasInputGraph } from "@/features/canvas/application/useCanvasInputGraph";
import { CANVAS_NODE_TYPES, type CanvasNode, type CinematicStudioNodeData } from "@/features/canvas/domain/canvasNodes";
import { optimizeLiraPrompt } from "@/features/canvas/domain/liraRules";
import { reversePromptSystemPrompt, reversePromptUserMessage } from "@/features/canvas/domain/reversePrompt";
import { usePromptLibraryStore } from "@/features/prompts/promptLibraryStore";
import { loadAISettings } from "@/features/cinematicStudio/app/providers/aiSettings";
import { useCanvasStore } from "@/stores/canvasStore";

interface ImagePromptOptimizerPanelProps {
  nodeId: string;
  data: CinematicStudioNodeData;
  onOpenChange?: (isOpen: boolean) => void;
}

export const IMAGE_PROMPT_INPUT_HANDLE = "image-prompt-media-input";

function stripThinkingBlock(text: string): string {
  return text
    .trim()
    .replace(/^(?:<thinking>[\s\S]*?<\/thinking>|<reason>[\s\S]*?<\/reason>)\s*/i, "")
    .trim();
}

async function toVisionImageSource(source: string): Promise<string> {
  const trimmed = source.trim();
  if (trimmed.startsWith("data:") || trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }
  const dataUrl = await imageUrlToDataUrl(trimmed);
  if (dataUrl.startsWith("data:")) return dataUrl;
  const mime = /\.jpe?g$/i.test(trimmed) ? "image/jpeg" : /\.webp$/i.test(trimmed) ? "image/webp" : "image/png";
  return `data:${mime};base64,${dataUrl}`;
}

export function ImagePromptOptimizerPanel({ nodeId, data, onOpenChange }: ImagePromptOptimizerPanelProps) {
  const { t, i18n } = useTranslation();
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const addNode = useCanvasStore((state) => state.addNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const findNodePosition = useCanvasStore((state) => state.findNodePosition);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const { nodes, edges } = useCanvasInputGraph();
  const libraries = usePromptLibraryStore((state) => state.libraries);
  const [isReversing, setIsReversing] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [error, setError] = useState("");
  const [selectedPresetId, setSelectedPresetId] = useState("");

  useEffect(() => {
    onOpenChange?.(isOpen);
  }, [isOpen, onOpenChange]);

  const promptDraft = typeof data.imagePromptDraft === "string" ? data.imagePromptDraft : "";
  const outputLang = i18n.language.startsWith("en") ? "en" : "zh";
  const mediaInputEdges = useMemo(
    () => edges.filter((edge) => edge.target === nodeId && edge.targetHandle === IMAGE_PROMPT_INPUT_HANDLE),
    [edges, nodeId],
  );
  const incomingImages = useMemo(
    () => graphImageResolver.collectInputImages(nodeId, nodes, mediaInputEdges),
    [mediaInputEdges, nodeId, nodes],
  );
  const incomingVideos = useMemo(() => {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    return mediaInputEdges
      .map((edge) => nodeById.get(edge.source))
      .filter((node): node is CanvasNode => Boolean(node))
      .flatMap((node) => {
        if (node.type !== CANVAS_NODE_TYPES.audio || node.data.mediaType !== "video" || !node.data.sourcePath) {
          return [];
        }
        return [
          {
            source: node.data.sourcePath,
            preview: node.data.previewImageUrl ?? null,
          },
        ];
      });
  }, [mediaInputEdges, nodes]);
  const reverseImageSources = useMemo(
    () => [
      ...incomingImages,
      ...incomingVideos.map((video) => video.preview).filter((source): source is string => Boolean(source)),
    ],
    [incomingImages, incomingVideos],
  );
  const presetTemplates = useMemo(() => libraries.flatMap((library) => library.items), [libraries]);

  const setResult = (result: string) => updateNodeData(nodeId, { imagePromptResult: result });
  const emitResultNode = (content: string) => {
    setResult(content);
    const position = findNodePosition(nodeId, 300, 180);
    const resultNodeId = addNode(CANVAS_NODE_TYPES.textAnnotation, position, {
      displayName: t("node.promptOptimizer.resultTitle"),
      content,
    });
    addEdge(nodeId, resultNodeId);
    setSelectedNode(resultNodeId);
  };
  const buildLocalPrompt = (purpose: string) =>
    optimizeLiraPrompt({
      purpose,
      taskType: "auto",
      lang: outputLang,
    }).prompt;

  const handleGenerate = () => {
    const result = buildLocalPrompt(promptDraft);
    if (!result) return;
    setError("");
    emitResultNode(result);
  };

  const handleReverse = async () => {
    if (reverseImageSources.length === 0) {
      setError(t("node.promptOptimizer.reverseNoImages"));
      return;
    }

    const fallbackPurpose = [
      incomingImages.map((_, index) => `@图${index + 1}`).join(" "),
      incomingVideos.map((_, index) => `@视频${index + 1}`).join(" "),
      promptDraft,
    ]
      .filter(Boolean)
      .join(" ")
      .trim();
    const fallback = buildLocalPrompt(fallbackPurpose);
    const settings = loadAISettings();
    if (!settings.baseUrl || !settings.apiKey || !settings.model) {
      setError("");
      emitResultNode(fallback);
      return;
    }

    setError("");
    setIsReversing(true);
    try {
      const images: ChatCompletionContentPart[] = [];
      for (const source of reverseImageSources) {
        images.push({ type: "image_url", image_url: { url: await toVisionImageSource(source) } });
      }
      const result = await chatCompletion(settings.baseUrl, settings.apiKey, settings.model, [
        { role: "system", content: reversePromptSystemPrompt(outputLang) },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: reversePromptUserMessage({
                taskType: "auto",
                purpose: promptDraft.trim(),
                imageCount: images.length,
                lang: outputLang,
              }),
            },
            ...images,
          ],
        },
      ]);
      const cleaned = stripThinkingBlock(result);
      if (!cleaned) throw new Error(t("node.promptOptimizer.reverseFailed"));
      emitResultNode(cleaned);
    } catch (reverseError) {
      emitResultNode(fallback);
      setError(reverseError instanceof Error ? reverseError.message : t("node.promptOptimizer.reverseFailed"));
    } finally {
      setIsReversing(false);
    }
  };

  const handleApplyPreset = () => {
    const template = presetTemplates.find((item) => item.id === selectedPresetId);
    if (!template) return;
    const nextDraft = [promptDraft.trim(), template.positive.trim()].filter(Boolean).join("\n\n");
    updateNodeData(nodeId, { imagePromptDraft: nextDraft });
  };

  return (
    <section className="relative shrink-0 rounded-lg border border-[rgba(255,255,255,0.12)] bg-black/15 p-2.5">
      <Handle
        type="target"
        id={IMAGE_PROMPT_INPUT_HANDLE}
        position={Position.Left}
        title="输入图片或视频"
        className="!left-[-13px] !top-1/2 !h-2.5 !w-2.5 !-translate-y-1/2 !border-surface-dark !bg-accent"
      />
      <button
        type="button"
        className="nodrag flex w-full items-center justify-between gap-2 text-left"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((current) => !current)}
      >
        <span className="flex min-w-0 items-center gap-1 text-[11px] font-medium text-text">
          <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${isOpen ? "rotate-180" : ""}`} />
          <span className="truncate">{t("node.promptOptimizer.imagePromptTitle")}</span>
        </span>
        <span className="text-[9px] text-text-muted">
          {t("node.promptOptimizer.imageInput")} {incomingImages.length} · {t("node.promptOptimizer.videoInput")}{" "}
          {incomingVideos.length}
        </span>
      </button>

      {isOpen ? <div className="mt-2">
      <textarea
        value={promptDraft}
        onChange={(event) => updateNodeData(nodeId, { imagePromptDraft: event.target.value })}
        onPointerDown={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
        placeholder={t("node.promptOptimizer.placeholder")}
        className="nodrag nowheel ui-scrollbar h-24 w-full resize-y overflow-y-auto rounded border border-[rgba(255,255,255,0.12)] bg-black/20 px-2 py-1.5 text-[11px] leading-relaxed text-text outline-none placeholder:text-text-muted/60 focus:border-accent"
      />

      <div className="mt-2 flex gap-2">
        <select
          value={selectedPresetId}
          onChange={(event) => setSelectedPresetId(event.target.value)}
          className="nodrag nowheel min-w-0 flex-1 rounded border border-[rgba(255,255,255,0.12)] bg-black/20 px-2 text-[11px] text-text outline-none focus:border-accent"
        >
          <option value="">
            {presetTemplates.length ? t("node.promptOptimizer.presetTemplate") : t("node.promptOptimizer.presetEmpty")}
          </option>
          {presetTemplates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={!selectedPresetId}
          onClick={handleApplyPreset}
          className="nodrag shrink-0 rounded border border-white/15 px-2 text-[11px] text-text hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t("node.promptOptimizer.applyPreset")}
        </button>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={handleGenerate}
          className="nodrag flex h-8 items-center justify-center gap-1.5 rounded bg-accent px-2 text-[11px] font-medium text-white hover:bg-accent/90 disabled:opacity-60"
        >
          <Wand2 className="h-3.5 w-3.5" />
          {t("node.promptOptimizer.optimize")}
        </button>
        <button
          type="button"
          disabled={isReversing || reverseImageSources.length === 0}
          onClick={() => void handleReverse()}
          className="nodrag flex h-8 items-center justify-center gap-1.5 rounded border border-white/15 bg-white/5 px-2 text-[11px] font-medium text-text hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <ScanSearch className="h-3.5 w-3.5" />
          {isReversing ? t("node.promptOptimizer.reverseRunning") : t("node.promptOptimizer.reversePrompt")}
        </button>
      </div>

      {error ? <p className="mt-2 text-[10px] leading-snug text-amber-400">{error}</p> : null}
      </div> : null}
    </section>
  );
}
