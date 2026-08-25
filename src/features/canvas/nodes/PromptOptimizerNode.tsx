import { memo, useCallback, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Check, Copy, ScanSearch, Sparkles, Wand2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';

import {
  CANVAS_NODE_TYPES,
  type PromptOptimizerNodeData,
  type PromptOptimizerTaskType,
} from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { optimizeLiraPrompt } from '@/features/canvas/domain/liraRules';
import { reversePromptSystemPrompt, reversePromptUserMessage, reversePromptCombineUserMessage } from '@/features/canvas/domain/reversePrompt';
import { graphImageResolver } from '@/features/canvas/application/canvasServices';
import { findReferenceTokens, insertReferenceToken } from '@/features/canvas/application/referenceTokenEditing';
import { imageUrlToDataUrl, resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { CanvasNodeImage } from '@/features/canvas/ui/CanvasNodeImage';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { chatCompletion, type ChatCompletionContentPart } from '@/commands/ai';

type PromptOptimizerNodeProps = NodeProps & {
  id: string;
  data: PromptOptimizerNodeData;
  selected?: boolean;
};

const DEFAULT_WIDTH = 400;
const DEFAULT_HEIGHT = 360;
const MIN_WIDTH = 280;
const MIN_HEIGHT = 220;
const MAX_WIDTH = 820;
const MAX_HEIGHT = 900;

interface PickerAnchor {
  left: number;
  top: number;
}

const PICKER_FALLBACK_ANCHOR: PickerAnchor = { left: 8, top: 8 };
const PICKER_Y_OFFSET_PX = 20;

function stripThinkingBlock(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return trimmed;
  }

  const wrapper = /^(?:<thinking>[\s\S]*?<\/thinking>|\\?\s*(?:thinking|reason)\s*:?[\s\S]*?)\\?\s*(?:response|answer|output|final_answer)\s*:?\s*/i;
  const match = trimmed.match(wrapper);
  if (match) {
    const rest = trimmed.slice((match.index ?? 0) + match[0].length).trim();
    if (rest) {
      return rest;
    }
  }

  const enclosed = trimmed.replace(/^(?:<thinking>[\s\S]*?<\/thinking>|<reason>[\s\S]*?<\/reason>)\s*/i, '').trim();
  if (enclosed && enclosed !== trimmed) {
    return enclosed;
  }

  return trimmed;
}

function getTextareaCaretOffset(
  textarea: HTMLTextAreaElement,
  caretIndex: number
): PickerAnchor {
  const mirror = document.createElement('div');
  const computed = window.getComputedStyle(textarea);
  const mirrorStyle = mirror.style;

  mirrorStyle.position = 'absolute';
  mirrorStyle.visibility = 'hidden';
  mirrorStyle.pointerEvents = 'none';
  mirrorStyle.whiteSpace = 'pre-wrap';
  mirrorStyle.overflowWrap = 'break-word';
  mirrorStyle.wordBreak = 'break-word';
  mirrorStyle.boxSizing = computed.boxSizing;
  mirrorStyle.width = `${textarea.clientWidth}px`;
  mirrorStyle.font = computed.font;
  mirrorStyle.lineHeight = computed.lineHeight;
  mirrorStyle.letterSpacing = computed.letterSpacing;
  mirrorStyle.padding = computed.padding;
  mirrorStyle.border = computed.border;
  mirrorStyle.textTransform = computed.textTransform;
  mirrorStyle.textIndent = computed.textIndent;

  mirror.textContent = textarea.value.slice(0, caretIndex);

  const marker = document.createElement('span');
  marker.textContent = textarea.value.slice(caretIndex, caretIndex + 1) || ' ';
  mirror.appendChild(marker);

  document.body.appendChild(mirror);

  const left = marker.offsetLeft - textarea.scrollLeft;
  const top = marker.offsetTop - textarea.scrollTop;

  document.body.removeChild(mirror);

  return {
    left: Math.max(0, left),
    top: Math.max(0, top),
  };
}

function resolvePickerAnchor(
  container: HTMLDivElement | null,
  textarea: HTMLTextAreaElement,
  caretIndex: number
): PickerAnchor {
  if (!container) {
    return PICKER_FALLBACK_ANCHOR;
  }

  const containerRect = container.getBoundingClientRect();
  const textareaRect = textarea.getBoundingClientRect();
  const caretOffset = getTextareaCaretOffset(textarea, caretIndex);

  return {
    left: Math.max(0, textareaRect.left - containerRect.left + caretOffset.left),
    top: Math.max(0, textareaRect.top - containerRect.top + caretOffset.top + PICKER_Y_OFFSET_PX),
  };
}

interface ReferencePreviewState {
  url: string;
  x: number;
  y: number;
}

const REFERENCE_PREVIEW_WIDTH = 180;
const REFERENCE_PREVIEW_ESTIMATED_HEIGHT = 160;
const REFERENCE_PREVIEW_MARGIN = 8;
const REFERENCE_PREVIEW_OFFSET = 12;
const REFERENCE_PREVIEW_MAX_SIZE = 200;
const REFERENCE_PREVIEW_MIN_SIZE = 80;

function resolvePreviewDisplaySize(
  naturalWidth: number,
  naturalHeight: number
): { width: number; height: number } {
  const safeWidth = Math.max(1, naturalWidth);
  const safeHeight = Math.max(1, naturalHeight);
  const scale = Math.min(
    REFERENCE_PREVIEW_MAX_SIZE / safeWidth,
    REFERENCE_PREVIEW_MAX_SIZE / safeHeight,
    1
  );
  let width = Math.max(REFERENCE_PREVIEW_MIN_SIZE, Math.round(safeWidth * scale));
  let height = Math.max(REFERENCE_PREVIEW_MIN_SIZE, Math.round(safeHeight * scale));
  if (width > REFERENCE_PREVIEW_MAX_SIZE) {
    height = Math.round((height * REFERENCE_PREVIEW_MAX_SIZE) / width);
    width = REFERENCE_PREVIEW_MAX_SIZE;
  }
  if (height > REFERENCE_PREVIEW_MAX_SIZE) {
    width = Math.round((width * REFERENCE_PREVIEW_MAX_SIZE) / height);
    height = REFERENCE_PREVIEW_MAX_SIZE;
  }
  return { width, height };
}

function resolvePreviewLeft(clientX: number, width: number): number {
  if (typeof window === 'undefined') {
    return clientX + REFERENCE_PREVIEW_OFFSET;
  }
  let left = clientX + REFERENCE_PREVIEW_OFFSET;
  if (left + width > window.innerWidth - REFERENCE_PREVIEW_MARGIN) {
    left = clientX - width - REFERENCE_PREVIEW_OFFSET;
  }
  return Math.max(
    REFERENCE_PREVIEW_MARGIN,
    Math.min(left, window.innerWidth - width - REFERENCE_PREVIEW_MARGIN)
  );
}

function resolvePreviewTop(clientY: number, height: number): number {
  if (typeof window === 'undefined') {
    return clientY + REFERENCE_PREVIEW_OFFSET;
  }
  let top = clientY + REFERENCE_PREVIEW_OFFSET;
  if (top + height > window.innerHeight - REFERENCE_PREVIEW_MARGIN) {
    top = clientY - height - REFERENCE_PREVIEW_OFFSET;
  }
  return Math.max(
    REFERENCE_PREVIEW_MARGIN,
    Math.min(top, window.innerHeight - height - REFERENCE_PREVIEW_MARGIN)
  );
}

function renderPromptWithHighlights(
  prompt: string,
  maxImageCount: number,
  imageUrls: string[],
  onThumbnailClick: (imageIndex: number, event: ReactMouseEvent<HTMLSpanElement>) => void
): ReactNode {
  if (!prompt) {
    return ' ';
  }

  const segments: ReactNode[] = [];
  let lastIndex = 0;
  const referenceTokens = findReferenceTokens(prompt, maxImageCount);
  for (const token of referenceTokens) {
    const matchStart = token.start;
    const matchText = token.token;
    const imageIndex = token.value - 1;
    const imageUrl = imageUrls[imageIndex] ?? null;

    if (matchStart > lastIndex) {
      segments.push(
        <span key={`plain-${lastIndex}`}>{prompt.slice(lastIndex, matchStart)}</span>
      );
    }

    if (imageUrl) {
      segments.push(
        <span
          key={`ref-${matchStart}`}
          data-reference-image-index={imageIndex}
          className="pointer-events-auto relative z-0 cursor-zoom-in select-none text-transparent"
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.stopPropagation();
            onThumbnailClick(imageIndex, event);
          }}
        >
          <span
            className="pointer-events-none relative -mr-5 inline-flex h-5 w-5 shrink-0 translate-x-1/2 align-middle items-center justify-center overflow-hidden rounded-md bg-accent/20 shadow-sm"
          >
            <img
              src={imageUrl}
              alt={matchText}
              draggable={false}
              className="h-full w-full shrink-0 object-cover"
            />
          </span>
          {matchText}
        </span>
      );
    } else {
      segments.push(
        <span
          key={`ref-${matchStart}`}
          className="relative z-0 text-transparent"
        >
          {matchText}
        </span>
      );
    }

    lastIndex = matchStart + matchText.length;
  }

  if (lastIndex < prompt.length) {
    segments.push(<span key={`plain-${lastIndex}`}>{prompt.slice(lastIndex)}</span>);
  }

  return segments;
}

const TASK_OPTIONS: Array<{ value: PromptOptimizerTaskType; labelKey: string }> = [
  { value: 'auto', labelKey: 'node.promptOptimizer.taskAuto' },
  { value: 'character', labelKey: 'node.promptOptimizer.taskCharacter' },
  { value: 'location', labelKey: 'node.promptOptimizer.taskLocation' },
  { value: 'prop', labelKey: 'node.promptOptimizer.taskProp' },
  { value: 'edit', labelKey: 'node.promptOptimizer.taskEdit' },
  { value: 'texture', labelKey: 'node.promptOptimizer.taskTexture' },
  { value: 'viewChange', labelKey: 'node.promptOptimizer.taskViewChange' },
];

const LIRA_AI_SYSTEM_PROMPT = [
  '你是 LIRA 提示词优化器，把用户提供的提示词骨架丰富成可直接用于图片生成的高质量提示词。只输出最终提示词文本，不要解释、不要 Markdown 代码块、不要前后缀。',
  '输出语言遵循用户消息中的指定（中文或英文），不得切换语言。',
  '规则：',
  '- 构图清晰：景别、机位、主体、背景、光线方向与阴影。',
  '- 材质与细节具体；分镜头用段落或列表组织。',
  '- 人物：同一人物跨画面保持一致，补全性别、年龄、发型发色、五官、服装、表情、姿态；把“待补充”类占位符替换为具体中性细节。',
  '- 地点/环境：明确空间纵深、建筑与自然元素、静谧氛围。',
  '- 道具/产品：三视图或俯拍、材质与磨损状态、无品牌空白表面。',
  '- 编辑/机位反转：保留原有身份、服装、构图、光线与调色，只改指定内容。',
  '- 使用电影级摄影词汇，如 ARRI Alexa、Cooke/ARRI 镜头、soft falloff、cinematic grading。',
  '要求：意图中缺失的信息用合理中性细节补全；保留用户明确指定的内容。',
].join('\n');

function buildAiUserMessage(draft: string, skeleton: string, taskType: string, lang: 'zh' | 'en'): string {
  return [
    '原始意图草稿：',
    draft,
    '',
    '本地规则生成的提示词骨架：',
    skeleton,
    '',
    `任务类型：${taskType}`,
    `输出语言：${lang === 'zh' ? '中文' : 'English'}`,
    '',
    '请丰富该骨架为最终提示词，只输出最终提示词文本。',
  ].join('\n');
}

async function toVisionImageSource(source: string): Promise<string> {
  const trimmed = source.trim();
  if (trimmed.startsWith('data:')) {
    return trimmed;
  }
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }
  const dataUrl = await imageUrlToDataUrl(trimmed);
  if (dataUrl.startsWith('data:')) {
    return dataUrl;
  }
  const mime = /\.png$/i.test(trimmed)
    ? 'image/png'
    : /\.jpe?g$/i.test(trimmed)
      ? 'image/jpeg'
      : /\.webp$/i.test(trimmed)
        ? 'image/webp'
        : /\.gif$/i.test(trimmed)
          ? 'image/gif'
          : 'image/png';
  return `data:${mime};base64,${dataUrl}`;
}
function collectReferencedImages(text: string, incomingImages: string[]): string[] {
  const references = findReferenceTokens(text, incomingImages.length);
  const seen = new Set<number>();
  const sources: string[] = [];
  for (const token of references) {
    if (token.kind !== 'image') {
      continue;
    }
    if (token.value < 1 || token.value > incomingImages.length) {
      continue;
    }
    if (seen.has(token.value)) {
      continue;
    }
    seen.add(token.value);
    const source = incomingImages[token.value - 1];
    if (source) {
      sources.push(source);
    }
  }
  return sources;
}
export const PromptOptimizerNode = memo(({
  id,
  data,
  selected,
  width,
  height,
}: PromptOptimizerNodeProps) => {
  const { t } = useTranslation();
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const addNode = useCanvasStore((state) => state.addNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const findNodePosition = useCanvasStore((state) => state.findNodePosition);
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);

  const [isEditingResult, setIsEditingResult] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isAiRunning, setIsAiRunning] = useState(false);
  const [isReverseRunning, setIsReverseRunning] = useState(false);
  const [showImagePicker, setShowImagePicker] = useState(false);
  const [pickerCursor, setPickerCursor] = useState<number | null>(null);
  const [pickerActiveIndex, setPickerActiveIndex] = useState(0);
  const [pickerAnchor, setPickerAnchor] = useState<PickerAnchor>(PICKER_FALLBACK_ANCHOR);
  const [previewState, setPreviewState] = useState<ReferencePreviewState | null>(null);
  const [previewSize, setPreviewSize] = useState<{ width: number; height: number } | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const purposeTextareaRef = useRef<HTMLTextAreaElement>(null);
  const purposeHighlightRef = useRef<HTMLDivElement>(null);

  const purpose = typeof data.purpose === 'string' ? data.purpose : '';
  const taskType: PromptOptimizerTaskType = data.taskType ?? 'auto';
  const resolvedTitle = resolveNodeDisplayName(CANVAS_NODE_TYPES.promptOptimizer, data);
  const resolvedWidth = Math.max(MIN_WIDTH, Math.round(width ?? DEFAULT_WIDTH));
  const resolvedHeight = Math.max(MIN_HEIGHT, Math.round(height ?? DEFAULT_HEIGHT));
  const enhanceMode = data.enhanceMode;
  const customApis = useSettingsStore((state) => state.customApis);
  const outputLang: 'zh' | 'en' = data.outputLang ?? 'en';

  const chatModelOptions = useMemo(() => {
    const options: Array<{ providerId: string; model: string; label: string }> = [];
    customApis.forEach((api) => {
      (api.chatModels ?? []).forEach((model) => {
        options.push({ providerId: api.id, model, label: `${api.name} · ${model}` });
      });
    });
    return options;
  }, [customApis]);

  const incomingImages = useMemo(
    () => graphImageResolver.collectInputImages(id, nodes, edges),
    [id, nodes, edges],
  );

  const incomingImageItems = useMemo(
    () =>
      incomingImages.map((imageUrl, index) => ({
        imageUrl,
        displayUrl: resolveImageDisplayUrl(imageUrl),
        label: `图${index + 1}`,
      })),
    [incomingImages],
  );

  const incomingImageViewerList = useMemo(
    () => incomingImageItems.map((item) => resolveImageDisplayUrl(item.imageUrl)),
    [incomingImageItems],
  );

  const referencedImages = useMemo(
    () => collectReferencedImages(purpose, incomingImages),
    [purpose, incomingImages],
  );

  const selectedChatModel =
    chatModelOptions.find(
      (option) => option.providerId === data.chatProviderId && option.model === data.chatModel,
    ) ??
    chatModelOptions[0] ??
    null;

  const selectNode = () => setSelectedNode(id);
  const emitResultNode = (content: string) => {
    const position = findNodePosition(id, 300, 180);
    const newNodeId = addNode(CANVAS_NODE_TYPES.textAnnotation, position, {
      displayName: t('node.promptOptimizer.resultTitle'),
      content,
    });
    addEdge(id, newNodeId);
    setSelectedNode(null);
  };
  const handleOptimize = () => {
    selectNode();
    const result = optimizeLiraPrompt({
      purpose,
      taskType,
      targetModel: data.targetModel,
      referencePalette: data.referencePalette,
      lang: outputLang,
    });
    if (!result.prompt) {
      return;
    }
    const position = findNodePosition(id, 300, 180);
    const newNodeId = addNode(CANVAS_NODE_TYPES.textAnnotation, position, {
      displayName: t('node.promptOptimizer.resultTitle'),
      content: result.prompt,
    });
    addEdge(id, newNodeId);
    setSelectedNode(null);
  };

  const handleAiOptimize = async () => {
    selectNode();
    const local = optimizeLiraPrompt({
      purpose,
      taskType,
      targetModel: data.targetModel,
      referencePalette: data.referencePalette,
      lang: outputLang,
    });
    if (!local.prompt) {
      updateNodeData(id, {
        optimizedPrompt: '',
        routeSummary: '',
        notes: [],
      });
      return;
    }

    const chatModel = selectedChatModel;
    const provider = chatModel
      ? customApis.find((api) => api.id === chatModel.providerId)
      : undefined;
    if (!chatModel || !provider) {
      emitResultNode(local.prompt);
      updateNodeData(id, {
        optimizedPrompt: '',
        routeSummary: '',
        notes: [],
      });
      return;
    }

    const model = chatModel.model;
    setIsAiRunning(true);
    try {
      let finalPrompt = '';
      if (referencedImages.length > 0) {
        const imageParts: ChatCompletionContentPart[] = [];
        for (const source of referencedImages) {
          try {
            const url = await toVisionImageSource(source);
            imageParts.push({ type: 'image_url', image_url: { url } });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn('[PromptOptimizer] failed to read referenced image', { source, message });
          }
        }
        if (imageParts.length === 0) {
          throw new Error(t('node.promptOptimizer.reverseImageReadFailed'));
        }

        const enhanced = await chatCompletion(provider.baseUrl, provider.apiKey, model, [
          { role: 'system', content: reversePromptSystemPrompt(outputLang) },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: reversePromptCombineUserMessage({
                  draft: purpose,
                  taskType,
                  imageCount: imageParts.length,
                  lang: outputLang,
                }),
              },
              ...imageParts,
            ],
          },
        ]);
        finalPrompt = stripThinkingBlock(enhanced);
      } else {
        const enhanced = await chatCompletion(provider.baseUrl, provider.apiKey, model, [
          { role: 'system', content: LIRA_AI_SYSTEM_PROMPT },
          { role: 'user', content: buildAiUserMessage(purpose, local.prompt, local.route.taskType, outputLang) },
        ]);
        finalPrompt = stripThinkingBlock(enhanced);
      }

      if (!finalPrompt) {
        throw new Error('AI 返回内容为空');
      }
      emitResultNode(finalPrompt);
      updateNodeData(id, {
        optimizedPrompt: '',
        routeSummary: '',
        notes: [],
      });
    } catch (error) {
      emitResultNode(local.prompt);
      updateNodeData(id, {
        optimizedPrompt: '',
        routeSummary: '',
        notes: [],
      });
    } finally {
      setIsAiRunning(false);
    }
  };  const handleReversePrompt = async () => {
    selectNode();
    if (incomingImages.length === 0) {
      updateNodeData(id, {
        optimizedPrompt: '',
        routeSummary: t('node.promptOptimizer.reverseSummary'),
        notes: [t('node.promptOptimizer.reverseNoImages')],
        enhanceMode: 'local',
      });
      return;
    }

    const refs = incomingImages.map((_, index) => `@图${index + 1}`).join(' ');
    const fallbackPurpose = purpose.trim()
      ? `${refs} ${purpose.trim()}`
      : `${refs} ${outputLang === 'zh' ? '人物角色设定图' : 'character sheet'}`;

    const local = optimizeLiraPrompt({
      purpose: fallbackPurpose,
      taskType,
      targetModel: data.targetModel,
      referencePalette: data.referencePalette,
      lang: outputLang,
    });

    const chatModel = selectedChatModel;
    const provider = chatModel
      ? customApis.find((api) => api.id === chatModel.providerId)
      : undefined;
    if (!chatModel || !provider) {
      emitResultNode(local.prompt);
      updateNodeData(id, {
        optimizedPrompt: '',
        routeSummary: '',
        notes: [],
      });
      return;
    }

    setIsReverseRunning(true);
    try {
      const imageParts: ChatCompletionContentPart[] = [];
      for (const source of incomingImages) {
        try {
          const url = await toVisionImageSource(source);
          imageParts.push({ type: 'image_url', image_url: { url } });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn('[PromptOptimizer] failed to read reference image', { source, message });
        }
      }
      if (imageParts.length === 0) {
        throw new Error(t('node.promptOptimizer.reverseImageReadFailed'));
      }

      const enhanced = await chatCompletion(provider.baseUrl, provider.apiKey, chatModel.model, [
        { role: 'system', content: reversePromptSystemPrompt(outputLang) },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: reversePromptUserMessage({
                taskType,
                purpose: purpose.trim(),
                imageCount: imageParts.length,
                lang: outputLang,
              }),
            },
            ...imageParts,
          ],
        },
      ]);

      const cleaned = stripThinkingBlock(enhanced);
      if (!cleaned) {
        throw new Error('AI 返回内容为空');
      }

      emitResultNode(cleaned);
      updateNodeData(id, {
        optimizedPrompt: '',
        routeSummary: '',
        notes: [],
      });
    } catch (error) {
      emitResultNode(local.prompt);
      updateNodeData(id, {
        optimizedPrompt: '',
        routeSummary: '',
        notes: [],
      });
    } finally {
      setIsReverseRunning(false);
    }
  };

  const handleChatModelChange = (value: string) => {
    const separatorIndex = value.indexOf('\u0000');
    if (separatorIndex < 0) {
      updateNodeData(id, { chatProviderId: undefined, chatModel: undefined });
      return;
    }
    updateNodeData(id, {
      chatProviderId: value.slice(0, separatorIndex),
      chatModel: value.slice(separatorIndex + 1),
    });
  };

  const handleOutputLangChange = (lang: 'zh' | 'en') => {
    updateNodeData(id, { outputLang: lang });
  };

  const handleCopy = async () => {
    const text = typeof data.optimizedPrompt === 'string' ? data.optimizedPrompt : '';
    if (!text) {
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard can be blocked in some webview contexts; keep the result editable as fallback.
    }
  };

  const handleNodeClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('a, button, input, textarea, select')) {
      return;
    }
    selectNode();
  };

  const insertImageReference = useCallback((imageIndex: number) => {
    const marker = `@图${imageIndex + 1}`;
    let basePurpose = purpose;
    let baseCursor = pickerCursor ?? basePurpose.length;
    const trimmedBefore = basePurpose.slice(0, baseCursor).replace(/\s+$/, '');
    if (trimmedBefore.endsWith('@')) {
      const atIndex = trimmedBefore.length - 1;
      basePurpose = basePurpose.slice(0, atIndex) + basePurpose.slice(atIndex + 1);
      baseCursor = atIndex;
    }
    const { nextText, nextCursor } = insertReferenceToken(basePurpose, baseCursor, marker);
    updateNodeData(id, { purpose: nextText });
    setShowImagePicker(false);
    setPickerCursor(null);
    setPickerActiveIndex(0);
    requestAnimationFrame(() => {
      purposeTextareaRef.current?.focus();
      purposeTextareaRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  }, [id, pickerCursor, purpose, updateNodeData]);

  const handlePurposeKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (showImagePicker && incomingImages.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setPickerActiveIndex((previous) => (previous + 1) % incomingImages.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setPickerActiveIndex((previous) =>
          previous === 0 ? incomingImages.length - 1 : previous - 1
        );
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        insertImageReference(pickerActiveIndex);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setShowImagePicker(false);
        setPickerCursor(null);
        setPickerActiveIndex(0);
        return;
      }
    }

    const isAtKey = event.key === '@' || (event.shiftKey && event.code === 'Digit2');
    if (isAtKey && !event.ctrlKey && !event.metaKey && !event.altKey && incomingImages.length > 0) {
      event.preventDefault();
      const cursor = event.currentTarget.selectionStart ?? purpose.length;
      setPickerAnchor(resolvePickerAnchor(rootRef.current, event.currentTarget, cursor));
      setPickerCursor(cursor);
      setShowImagePicker(true);
      setPickerActiveIndex(0);
    }
  };

  const syncPurposeHighlightScroll = () => {
    if (!purposeTextareaRef.current || !purposeHighlightRef.current) {
      return;
    }
    purposeHighlightRef.current.scrollTop = purposeTextareaRef.current.scrollTop;
    purposeHighlightRef.current.scrollLeft = purposeTextareaRef.current.scrollLeft;
  };

  const handlePurposeAreaClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const referenceElements = event.currentTarget.querySelectorAll<HTMLElement>(
      '[data-reference-image-index]'
    );
    for (const element of referenceElements) {
      const rect = element.getBoundingClientRect();
      if (
        event.clientX < rect.left
        || event.clientX > rect.right
        || event.clientY < rect.top
        || event.clientY > rect.bottom
      ) {
        continue;
      }
      const imageIndex = Number(element.dataset.referenceImageIndex);
      const image = incomingImageItems[imageIndex];
      if (!image) {
        return;
      }
      setPreviewState({ url: image.displayUrl, x: event.clientX, y: event.clientY });
      setPreviewSize(null);
      return;
    }
  }, [incomingImageItems]);

  const handleReferenceThumbnailClick = useCallback((
    imageIndex: number,
    event: ReactMouseEvent<HTMLSpanElement>
  ) => {
    const image = incomingImageItems[imageIndex];
    if (!image) {
      return;
    }
    setPreviewState({ url: image.displayUrl, x: event.clientX, y: event.clientY });
    setPreviewSize(null);
  }, [incomingImageItems]);

  return (
    <div
      ref={rootRef}
      className={`
        group relative flex h-full w-full flex-col overflow-visible rounded-[var(--node-radius)] border bg-surface-dark/85 transition-colors duration-150
        ${selected
          ? 'border-accent shadow-[0_0_0_1px_rgba(59,130,246,0.32)]'
          : 'border-[rgba(15,23,42,0.22)] hover:border-[rgba(15,23,42,0.34)] dark:border-[rgba(255,255,255,0.22)] dark:hover:border-[rgba(255,255,255,0.34)]'}
      `}
      style={{ width: resolvedWidth, height: resolvedHeight }}
      onClick={handleNodeClick}
    >
      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<Wand2 className="h-4 w-4" />}
        titleText={resolvedTitle}
        editable
        onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
      />

      <Handle id="target" type="target" position={Position.Left} className="!h-2 !w-2 !border-surface-dark !bg-accent" />
      <Handle id="source" type="source" position={Position.Right} className="!h-2 !w-2 !border-surface-dark !bg-accent" />

      <NodeResizeHandle
        minWidth={MIN_WIDTH}
        minHeight={MIN_HEIGHT}
        maxWidth={MAX_WIDTH}
        maxHeight={MAX_HEIGHT}
      />

      <div className="nowheel flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2 pt-3">
        <div className="relative" onClick={handlePurposeAreaClick}>
          <div
            ref={purposeHighlightRef}
            aria-hidden="true"
            className="ui-scrollbar pointer-events-none absolute inset-0 z-20 overflow-y-auto overflow-x-hidden text-sm leading-5 text-text-dark"
          >
            <div className="min-h-full whitespace-pre-wrap break-words px-2 py-1.5">
              {renderPromptWithHighlights(
                purpose,
                incomingImages.length,
                incomingImageItems.map((item) => item.displayUrl),
                handleReferenceThumbnailClick
              )}
            </div>
          </div>
          <textarea
            ref={purposeTextareaRef}
            value={purpose}
            onChange={(event) => updateNodeData(id, { purpose: event.target.value })}
            onKeyDown={handlePurposeKeyDown}
            onScroll={syncPurposeHighlightScroll}
            onMouseDown={(event) => event.stopPropagation()}
            placeholder={t('node.promptOptimizer.placeholder')}
            className="ui-scrollbar nodrag nowheel relative z-10 min-h-[72px] w-full resize-none overflow-y-auto overflow-x-hidden border border-white/10 bg-black/20 px-2 py-1.5 text-sm leading-5 text-transparent caret-text-dark outline-none placeholder:text-text-muted/70 focus:border-accent/60 whitespace-pre-wrap break-words [font-family:inherit]"
          />
        </div>

        <div className="flex items-center gap-2">
          <select
            value={taskType}
            onChange={(event) => updateNodeData(id, { taskType: event.target.value as PromptOptimizerTaskType })}
            className="nodrag nowheel h-8 min-w-0 flex-1 rounded-md border border-white/10 bg-black/20 px-2 text-sm text-text-dark outline-none focus:border-accent/60"
          >
            {TASK_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.labelKey)}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleOptimize}
            className="nodrag flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-white hover:bg-accent/90"
          >
            <Wand2 className="h-3.5 w-3.5" />
            {t('node.promptOptimizer.optimize')}
          </button>
        </div>

        <div className="flex items-center gap-2">
          <select
            value={selectedChatModel ? `${selectedChatModel.providerId}\u0000${selectedChatModel.model}` : ''}
            onChange={(event) => handleChatModelChange(event.target.value)}
            className="nodrag nowheel h-8 min-w-0 flex-1 rounded-md border border-white/10 bg-black/20 px-2 text-sm text-text-dark outline-none focus:border-accent/60"
          >
            {chatModelOptions.length > 0 ? (
              chatModelOptions.map((option) => (
                <option key={`${option.providerId}\u0000${option.model}`} value={`${option.providerId}\u0000${option.model}`}>
                  {option.label}
                </option>
              ))
            ) : (
              <option value="">{t('node.promptOptimizer.chatModelEmpty')}</option>
            )}
          </select>

          <div className="nodrag flex h-8 shrink-0 items-stretch overflow-hidden rounded-md border border-white/10">
            <button
              type="button"
              onClick={() => handleOutputLangChange('zh')}
              className={`px-2 text-sm ${outputLang === 'zh' ? 'bg-accent text-white' : 'text-text-muted hover:bg-white/5'}`}
            >
              中
            </button>
            <button
              type="button"
              onClick={() => handleOutputLangChange('en')}
              className={`px-2 text-sm ${outputLang === 'en' ? 'bg-accent text-white' : 'text-text-muted hover:bg-white/5'}`}
            >
              EN
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={handleAiOptimize}
            disabled={isAiRunning}
            className="nodrag flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-2 text-sm font-medium text-accent hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Sparkles className="h-3.5 w-3.5" />
            {isAiRunning ? t('node.promptOptimizer.aiOptimizing') : t('node.promptOptimizer.aiOptimize')}
          </button>
          <button
            type="button"
            onClick={handleReversePrompt}
            disabled={isReverseRunning || incomingImages.length === 0}
            title={incomingImages.length === 0 ? t('node.promptOptimizer.reverseNoImages') : undefined}
            className="nodrag flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-white/15 bg-white/5 px-2 text-sm font-medium text-text-dark hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <ScanSearch className="h-3.5 w-3.5" />
            {isReverseRunning ? t('node.promptOptimizer.reverseRunning') : t('node.promptOptimizer.reversePrompt')}
          </button>
        </div>

        {(typeof data.routeSummary === 'string' && data.routeSummary) || (typeof data.optimizedPrompt === 'string' && data.optimizedPrompt) ? (
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              {typeof data.routeSummary === 'string' && data.routeSummary ? (
                <div className="inline-flex w-fit items-center rounded-full bg-accent/15 px-2 py-0.5 text-xs text-accent">
                  {data.routeSummary}
                </div>
              ) : null}
              {enhanceMode === 'ai' || enhanceMode === 'local' || enhanceMode === 'ai-fallback' ? (
                <div
                  className={[
                    'inline-flex w-fit items-center rounded-full px-2 py-0.5 text-xs',
                    enhanceMode === 'ai'
                      ? 'bg-emerald-500/15 text-emerald-400'
                      : enhanceMode === 'ai-fallback'
                        ? 'bg-amber-500/15 text-amber-400'
                        : 'bg-white/10 text-text-muted',
                  ].join(' ')}
                >
                  {enhanceMode === 'ai'
                    ? t('node.promptOptimizer.modeAi')
                    : enhanceMode === 'ai-fallback'
                      ? t('node.promptOptimizer.modeFallback')
                      : t('node.promptOptimizer.modeLocal')}
                </div>
              ) : null}
            </div>

            {isEditingResult ? (
              <textarea
                autoFocus
                value={typeof data.optimizedPrompt === 'string' ? data.optimizedPrompt : ''}
                onChange={(event) => updateNodeData(id, { optimizedPrompt: event.target.value })}
                onBlur={() => setIsEditingResult(false)}
                className="nodrag nowheel min-h-[100px] w-full flex-1 resize-none rounded-md border border-white/10 bg-black/20 px-2 py-1.5 text-sm leading-5 text-text-dark outline-none focus:border-accent/60"
              />
            ) : (
              <div
                className="nodrag min-h-[80px] w-full flex-1 cursor-text whitespace-pre-wrap overflow-auto rounded-md bg-black/20 px-2 py-1.5 text-sm leading-5 text-text-dark"
                onClick={(event) => {
                  event.stopPropagation();
                  setIsEditingResult(true);
                }}
              >
                {typeof data.optimizedPrompt === 'string' && data.optimizedPrompt ? data.optimizedPrompt : t('node.promptOptimizer.emptyResult')}
              </div>
            )}

            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 flex-1 text-xs leading-4 text-text-muted">
                {Array.isArray(data.notes) && data.notes.length > 0
                  ? data.notes.map((note) => <div key={note}>{note}</div>)
                  : null}
              </div>
              <button
                type="button"
                onClick={handleCopy}
                className="nodrag flex h-7 shrink-0 items-center gap-1 rounded-md border border-white/10 px-2 text-xs text-text-dark hover:bg-white/5"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? t('node.promptOptimizer.copied') : t('node.promptOptimizer.copy')}
              </button>
            </div>
          </div>
        ) : null}
      </div>
      {showImagePicker && incomingImageItems.length > 0 && (
        <div
          className="nowheel absolute z-30 w-[120px] overflow-hidden rounded-xl border border-[rgba(255,255,255,0.16)] bg-surface-dark shadow-xl"
          style={{ left: pickerAnchor.left, top: pickerAnchor.top }}
          onMouseDown={(event) => event.stopPropagation()}
          onWheelCapture={(event) => event.stopPropagation()}
        >
          <div
            className="ui-scrollbar nowheel max-h-[180px] overflow-y-auto"
            onWheelCapture={(event) => event.stopPropagation()}
          >
            {incomingImageItems.map((item, index) => (
              <button
                key={`${item.imageUrl}-${index}`}
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  insertImageReference(index);
                }}
                onMouseEnter={() => setPickerActiveIndex(index)}
                className={`flex w-full items-center gap-2 border border-transparent bg-bg-dark/70 px-2 py-2 text-left text-sm text-text-dark transition-colors hover:border-[rgba(255,255,255,0.18)] ${
                  pickerActiveIndex === index
                    ? 'border-[rgba(255,255,255,0.24)] bg-bg-dark'
                    : ''
                }`}
              >
                <CanvasNodeImage
                  src={item.displayUrl}
                  alt={item.label}
                  viewerSourceUrl={resolveImageDisplayUrl(item.imageUrl)}
                  viewerImageList={incomingImageViewerList}
                  className="h-8 w-8 rounded object-cover"
                  draggable={false}
                />
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {previewState && createPortal(
        <>
          <div className="fixed inset-0 z-[190]" onClick={() => setPreviewState(null)} />
          <div
            className="fixed z-[200] overflow-hidden rounded-lg border border-[rgba(255,255,255,0.16)] bg-black/60 shadow-2xl"
            style={{
              width: previewSize?.width ?? REFERENCE_PREVIEW_WIDTH,
              height: previewSize?.height ?? REFERENCE_PREVIEW_ESTIMATED_HEIGHT,
              left: resolvePreviewLeft(
                previewState.x,
                previewSize?.width ?? REFERENCE_PREVIEW_WIDTH
              ),
              top: resolvePreviewTop(
                previewState.y,
                previewSize?.height ?? REFERENCE_PREVIEW_ESTIMATED_HEIGHT
              ),
              transformOrigin: 'left center',
              animation: 'reference-preview-pop 0.16s ease-out',
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <img
              src={previewState.url}
              alt="参考图预览"
              draggable={false}
              className="h-full w-full object-contain"
              onLoad={(event) => {
                const img = event.currentTarget;
                setPreviewSize(resolvePreviewDisplaySize(img.naturalWidth, img.naturalHeight));
              }}
            />
          </div>
          <style>{`@keyframes reference-preview-pop { from { transform: translateX(-12px) scaleX(0.75); opacity: 0; } to { transform: translateX(0) scaleX(1); opacity: 1; } }`}</style>
        </>,
        document.body
      )}
    </div>
  );
});

PromptOptimizerNode.displayName = 'PromptOptimizerNode';