import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { AudioLines, Check, ChevronDown, Clapperboard, LoaderCircle, Plus, Settings2, Sparkles, Video, X } from 'lucide-react';

import {
  CANVAS_NODE_TYPES,
  isAudioNode,
  type CanvasEdge,
  type CanvasNode,
  type CinematicStudioNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName, isNodeUsingDefaultDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { graphImageResolver } from '@/features/canvas/application/canvasServices';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { useCanvasInputGraph } from '@/features/canvas/application/useCanvasInputGraph';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { ImagePromptOptimizerPanel } from '@/features/canvas/nodes/ImagePromptOptimizerPanel';
import {
  cinematicAssetDescription,
  cinematicAssetIdFromMirrorId,
  cinematicAssetKey,
  cinematicAssetKind,
  cinematicImageAssets,
} from '@/features/library/cinematicMirror';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { CinematicStudioWorkbench } from '@/features/cinematicStudio/CinematicStudioWorkbench';
import type { CanvasImageSource } from '@/features/cinematicStudio/app/components/DirectorLayersCard';
import type { Locale } from '@/features/cinematicStudio/app/i18n';
import { generateQuickPrompt } from '@/features/cinematicStudio/app/providers/ai';
import type { QuickPromptAsset } from '@/features/cinematicStudio/app/providers/quickPromptAgent';
import { listLenTalkChatModels, loadAISettings, resolveLenTalkChatModel } from '@/features/cinematicStudio/app/providers/aiSettings';
import {
  duplicateCinematicProject,
  loadProjectById,
  loadProjectFromDatabaseById,
  loadSharedAssets,
  mergeAssetPool,
  persistProjectById,
  persistProjectToDatabaseById,
} from '@/features/cinematicStudio/app/model';
import { DEFAULT_CINEMATIC_PROJECT_ID, createCinematicProjectId } from '@/features/cinematicStudio/app/projectId';
import { applyQuickStudioSync, mergeUpstreamText, stripUpstreamText, type CinematicStudioQuickSync, type CinematicStudioUpstreamText } from '@/features/cinematicStudio/app/quickStudioSync';
import { buildQuickStagingContext } from '@/features/cinematicStudio/app/quickStagingContext';
import type { SceneStaging } from '@/features/cinematicStudio/shared-types';
import { useAssetLibraryStore } from '@/features/library/assetStore';
import type { LibraryAsset } from '@/features/library/types';

type CinematicStudioNodeProps = NodeProps & {
  id: string;
  data: CinematicStudioNodeData;
  selected?: boolean;
};

const CINEMATIC_STUDIO_NODE_MIN_WIDTH = 400;
// 风格/质量与故事梗概的输入框固定为 h-24；AI 图片提示词展开时需要额外空间，
// 折叠后则允许外框收缩，避免内容已经隐藏但节点仍保留原来的 700px 高度。
const CINEMATIC_STUDIO_NODE_COLLAPSED_MIN_HEIGHT = 520;
const CINEMATIC_STUDIO_NODE_EXPANDED_MIN_HEIGHT = 700;
const IMAGE_PROMPT_PANEL_HEIGHT_DELTA = 180;
const QUICK_INPUT_HANDLES = {
  style: 'quick-style-input',
  synopsis: 'quick-synopsis-input',
  sceneAssets: 'quick-scene-assets-input',
  characterAssets: 'quick-character-assets-input',
} as const;

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

function selectedCinematicAssets(ids: string[], assets: LibraryAsset[]): LibraryAsset[] {
  const assetsByCinematicId = new Map<string, LibraryAsset>();
  for (const asset of assets) {
    if (asset.mediaType !== 'image' || !asset.sourcePath.trim()) continue;
    const key = cinematicAssetKey(asset);
    if (!assetsByCinematicId.has(key)) assetsByCinematicId.set(key, asset);
  }
  return ids
    .map((assetId) => assetsByCinematicId.get(assetId) ?? assets.find((asset) => asset.id === assetId))
    .filter((asset): asset is LibraryAsset => Boolean(asset));
}

function cinematicDisplayName(asset: LibraryAsset, canonicalNames: Map<string, string>): string {
  return canonicalNames.get(cinematicAssetKey(asset))?.trim() || asset.name.trim() || '未命名素材';
}

function inputEdgesForHandle(edges: CanvasEdge[], nodeId: string, handleId: string): CanvasEdge[] {
  return edges.filter((edge) => edge.target === nodeId && edge.targetHandle === handleId);
}

function collectInputVideos(edges: CanvasEdge[], nodes: CanvasNode[]): string[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const videos = edges
    .map((edge) => nodeById.get(edge.source))
    .filter((node): node is CanvasNode => Boolean(node))
    .flatMap((node) => {
      const data = node.data as { mediaType?: unknown; sourcePath?: unknown };
      return node.type === CANVAS_NODE_TYPES.audio && data.mediaType === 'video' && typeof data.sourcePath === 'string' && data.sourcePath.trim()
        ? [data.sourcePath.trim()]
        : [];
    });
  return [...new Set(videos)];
}

function fileLabel(source: string, fallback: string): string {
  return source.split(/[\\/]/).pop()?.trim() || fallback;
}

/** Write compact-node edits into its matching advanced-workbench project. */
async function persistQuickStudioSync(projectId: string, sync: CinematicStudioQuickSync) {
  if (!projectId) return;
  // Browser/local fallback is written immediately; the SQLite copy is then
  // refreshed from the latest stored project to avoid discarding other edits.
  const localProject = applyQuickStudioSync(loadProjectById(projectId), sync);
  persistProjectById(projectId, localProject);
  const storedProject = await loadProjectFromDatabaseById(projectId);
  const nextProject = applyQuickStudioSync(storedProject ?? localProject, sync);
  const saved = await persistProjectToDatabaseById(projectId, nextProject);
  if (!saved) persistProjectById(projectId, nextProject);
}

export const CinematicStudioNode = memo(({ id, data, selected, width, height }: CinematicStudioNodeProps) => {
  const { i18n } = useTranslation();
  const updateNodeInternals = useUpdateNodeInternals();
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const updateNodeSize = useCanvasStore((state) => state.updateNodeSize);
  const { nodes, edges } = useCanvasInputGraph();
  const addEdge = useCanvasStore((state) => state.addEdge);
  const addNode = useCanvasStore((state) => state.addNode);
  const findNodePosition = useCanvasStore((state) => state.findNodePosition);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const libraryAssets = useAssetLibraryStore((state) => state.assets);
  const assetLibraryHydrated = useAssetLibraryStore((state) => state.isHydrated);
  const hydrateAssetLibrary = useAssetLibraryStore((state) => state.hydrate);
  const customApis = useSettingsStore((state) => state.customApis);
  const cinematicAiSelection = useSettingsStore((state) => state.cinematicAiSelection);
  const [isOpen, setIsOpen] = useState(false);
  const [quickGenerating, setQuickGenerating] = useState(false);
  const [quickError, setQuickError] = useState('');
  const [activeAssetPicker, setActiveAssetPicker] = useState<'scene' | 'character' | null>(null);
  const [isChatModelPickerOpen, setIsChatModelPickerOpen] = useState(false);
  const [activeChatProviderId, setActiveChatProviderId] = useState('');
  const [cinematicAssetNames, setCinematicAssetNames] = useState<Map<string, string>>(() => new Map());
  const [isImagePromptOpen, setIsImagePromptOpen] = useState(false);
  const expandedHeightRef = useRef(CINEMATIC_STUDIO_NODE_EXPANDED_MIN_HEIGHT);

  useEffect(() => {
    if (!assetLibraryHydrated) return;
    let cancelled = false;
    void loadSharedAssets().then((assets) => {
      if (cancelled) return;
      setCinematicAssetNames(new Map(
        assets
          .filter((asset) => asset.id.trim() && asset.name.trim())
          .map((asset) => [asset.id, asset.name.trim()]),
      ));
    }).catch(() => {
      // 素材库读取失败时继续使用镜像名称，不能阻塞节点操作。
    });
    return () => {
      cancelled = true;
    };
  }, [assetLibraryHydrated]);

  const chatModels = useMemo(() => listLenTalkChatModels(), [customApis]);
  // 与 AI 图片模型面板一致：先按平台区分，再在平台内选择模型。
  const chatModelGroups = useMemo(() => {
    const groups = new Map<string, { providerId: string; providerName: string; models: string[] }>();
    for (const option of chatModels) {
      const group = groups.get(option.providerId) ?? {
        providerId: option.providerId,
        providerName: option.providerName,
        models: [],
      };
      if (!group.models.includes(option.model)) group.models.push(option.model);
      groups.set(option.providerId, group);
    }
    return [...groups.values()];
  }, [chatModels]);
  const defaultChatSettings = useMemo(() => loadAISettings(), [cinematicAiSelection, customApis]);

  const resolvedWidth = typeof width === 'number' && width > 1
    ? Math.round(width)
    : CINEMATIC_STUDIO_NODE_MIN_WIDTH;
  const resolvedHeight = Math.max(
    isImagePromptOpen ? CINEMATIC_STUDIO_NODE_EXPANDED_MIN_HEIGHT : CINEMATIC_STUDIO_NODE_COLLAPSED_MIN_HEIGHT,
    typeof height === 'number' && height > 1
      ? Math.round(height)
      : CINEMATIC_STUDIO_NODE_COLLAPSED_MIN_HEIGHT,
  );
  const currentHeightRef = useRef(resolvedHeight);
  const currentWidthRef = useRef(resolvedWidth);
  currentHeightRef.current = resolvedHeight;
  currentWidthRef.current = resolvedWidth;

  const handleImagePromptOpenChange = useCallback((nextOpen: boolean) => {
    setIsImagePromptOpen(nextOpen);
    const currentHeight = currentHeightRef.current;
    if (nextOpen) {
      const nextHeight = Math.max(CINEMATIC_STUDIO_NODE_EXPANDED_MIN_HEIGHT, expandedHeightRef.current);
      updateNodeSize(id, currentWidthRef.current, nextHeight);
      return;
    }

    expandedHeightRef.current = Math.max(CINEMATIC_STUDIO_NODE_EXPANDED_MIN_HEIGHT, currentHeight);
    updateNodeSize(
      id,
      currentWidthRef.current,
      Math.max(CINEMATIC_STUDIO_NODE_COLLAPSED_MIN_HEIGHT, expandedHeightRef.current - IMAGE_PROMPT_PANEL_HEIGHT_DELTA),
    );
  }, [id, updateNodeSize]);

  const displayName = useMemo(
    () => resolveNodeDisplayName(CANVAS_NODE_TYPES.cinematicStudio, data),
    [data]
  );

  // 每个节点一份独立工程：老节点没有 id 时补发一个，
  // 之后双击打开就是它自己的空白模板 / 既有内容，不再和别的节点共用工程。
  const studioProjectId = typeof data.studioProjectId === 'string' && data.studioProjectId.trim()
    ? data.studioProjectId.trim()
    : '';

  // 老节点此前与别的节点共用全局工程：若它确实用过（有缓存快照），
  // 把那份工程复制到自己的 id 下，避免升级后看起来「内容丢了」。
  const hadStudioActivity = Boolean(
    (typeof data.lastProjectTitle === 'string' && data.lastProjectTitle.trim())
    || (typeof data.lastProjectDescription === 'string' && data.lastProjectDescription.trim())
    || (typeof data.lastPromptPreview === 'string' && data.lastPromptPreview.trim())
  );

  useEffect(() => {
    if (studioProjectId) return;
    const nextProjectId = createCinematicProjectId();
    if (hadStudioActivity) void duplicateCinematicProject(DEFAULT_CINEMATIC_PROJECT_ID, nextProjectId);
    updateNodeData(id, { studioProjectId: nextProjectId });
  }, [hadStudioActivity, id, studioProjectId, updateNodeData]);

  useEffect(() => {
    if (!assetLibraryHydrated) void hydrateAssetLibrary();
  }, [assetLibraryHydrated, hydrateAssetLibrary]);

  /** 点击节点外/画布空白或按 Escape 时，所有轻量选择卡片自动收起。 */
  useEffect(() => {
    if (!activeAssetPicker && !isChatModelPickerOpen) return;
    const closePickers = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[data-quick-popover]')) return;
      setActiveAssetPicker(null);
      setIsChatModelPickerOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setActiveAssetPicker(null);
      setIsChatModelPickerOpen(false);
    };
    document.addEventListener('pointerdown', closePickers, true);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closePickers, true);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [activeAssetPicker, isChatModelPickerOpen]);

  const canvasAudioSources = useMemo(() => {
    const connectedSources = graphImageResolver.collectInputAudio(id, nodes, edges);
    const labelBySource = new Map<string, string>();

    for (const node of nodes) {
      if (!isAudioNode(node) || node.data.mediaType === 'video' || !node.data.sourcePath) {
        continue;
      }
      const source = node.data.sourcePath;
      const nodeLabel = resolveNodeDisplayName(CANVAS_NODE_TYPES.audio, node.data);
      const fileName = source.split(/[\\/]/).pop()?.trim() ?? '';
      labelBySource.set(source, nodeLabel !== '媒体' ? nodeLabel : fileName || '画布音频');
    }

    return connectedSources
      .filter((source) => labelBySource.has(source))
      .map((source) => ({ source, label: labelBySource.get(source) ?? '画布音频' }));
  }, [edges, id, nodes]);

  const canvasImageSources = useMemo<CanvasImageSource[]>(() => {
    const connectedSources = graphImageResolver.collectInputImages(id, nodes, edges);
    const labelBySource = new Map<string, string>();
    for (const node of nodes) {
      const nodeData = node.data as Record<string, unknown>;
      const nodeLabel = resolveNodeDisplayName(node.type as typeof CANVAS_NODE_TYPES[keyof typeof CANVAS_NODE_TYPES], node.data);
      const sources = [
        nodeData.imageUrl,
        nodeData.outputImageUrl,
        nodeData.inputImageUrl,
        ...(Array.isArray(nodeData.frames) ? nodeData.frames.map((frame) => (frame as Record<string, unknown>).imageUrl ?? (frame as Record<string, unknown>).previewImageUrl) : []),
      ].filter((source): source is string => typeof source === 'string' && source.trim().length > 0);
      for (const source of sources) labelBySource.set(source, nodeLabel || '画布图片');
    }
    return connectedSources.map((source) => ({ source, label: labelBySource.get(source) ?? '画布图片' }));
  }, [edges, id, nodes]);

  const styleInputEdges = useMemo(() => inputEdgesForHandle(edges, id, QUICK_INPUT_HANDLES.style), [edges, id]);
  const synopsisInputEdges = useMemo(() => inputEdgesForHandle(edges, id, QUICK_INPUT_HANDLES.synopsis), [edges, id]);
  const sceneAssetInputEdges = useMemo(() => inputEdgesForHandle(edges, id, QUICK_INPUT_HANDLES.sceneAssets), [edges, id]);
  const characterAssetInputEdges = useMemo(() => inputEdgesForHandle(edges, id, QUICK_INPUT_HANDLES.characterAssets), [edges, id]);
  const upstreamStyleTexts = useMemo(
    () => graphImageResolver.collectInputText(id, nodes, styleInputEdges),
    [id, nodes, styleInputEdges],
  );
  const upstreamSynopsisTexts = useMemo(
    () => graphImageResolver.collectInputText(id, nodes, synopsisInputEdges),
    [id, nodes, synopsisInputEdges],
  );
  const sceneInputMedia = useMemo(() => ({
    images: graphImageResolver.collectInputImages(id, nodes, sceneAssetInputEdges),
    audio: graphImageResolver.collectInputAudio(id, nodes, sceneAssetInputEdges),
    videos: collectInputVideos(sceneAssetInputEdges, nodes),
  }), [id, nodes, sceneAssetInputEdges]);
  const characterInputMedia = useMemo(() => ({
    images: graphImageResolver.collectInputImages(id, nodes, characterAssetInputEdges),
    audio: graphImageResolver.collectInputAudio(id, nodes, characterAssetInputEdges),
    videos: collectInputVideos(characterAssetInputEdges, nodes),
  }), [id, nodes, characterAssetInputEdges]);

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, resolvedHeight, resolvedWidth, updateNodeInternals]);

  const handleOpen = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      setSelectedNode(id);
      setIsOpen(true);
    },
    [id, setSelectedNode]
  );

  const handleClose = useCallback(() => {
    setIsOpen(false);
  }, []);

  const handleStateChange = useCallback(
    (snapshot: {
      projectTitle?: string;
      projectDescription?: string;
      promptPreview?: string;
      referenceImages?: string[];
      referenceAudio?: string[];
      quickSync?: CinematicStudioQuickSync;
    }) => {
      updateNodeData(id, {
        lastProjectTitle: typeof snapshot.projectTitle === 'string' ? snapshot.projectTitle : null,
        lastProjectDescription: typeof snapshot.projectDescription === 'string' ? snapshot.projectDescription : null,
        lastPromptPreview: typeof snapshot.promptPreview === 'string' ? snapshot.promptPreview : null,
        studioReferenceImages: Array.isArray(snapshot.referenceImages) ? snapshot.referenceImages : [],
        studioReferenceAudio: Array.isArray(snapshot.referenceAudio) ? snapshot.referenceAudio : [],
        ...(snapshot.quickSync ? {
          // 回写的应当是节点手输的原文；早期版本会把「上游 + 本地」合并后再写进工程，
          // 这里顺手剥掉可能残留的上游块，避免它被当成用户输入长期留在输入框里。
          quickStyle: stripUpstreamText(snapshot.quickSync.styleBrief, upstreamStyleTexts),
          quickSynopsis: stripUpstreamText(snapshot.quickSync.storySynopsis, upstreamSynopsisTexts),
          quickStaging: snapshot.quickSync.staging,
          quickSyncInitialized: true,
          quickStudioSceneId: snapshot.quickSync.sceneId ?? '',
        } : {}),
      });
    },
    [id, updateNodeData, upstreamStyleTexts, upstreamSynopsisTexts]
  );

  const handleSendToVideo = useCallback((payload: { prompt: string; referenceImages: string[]; referenceAudio: string[] }) => {
    const nextPrompt = payload.prompt.trim();
    if (!nextPrompt) return;
    const placement = findNodePosition(id, 420, 360);
    const videoNodeId = addNode(CANVAS_NODE_TYPES.videoGen, placement, {
      prompt: nextPrompt,
      // 模型 / 宽高比 / 分辨率不再写死: 交给 createDefaultData 沿用「上次使用」的配置
      // (与 duration 的既有行为一致), 避免工作室发过去的节点还要重新选一遍。
      studioReferenceImages: payload.referenceImages,
      studioReferenceAudio: payload.referenceAudio,
    });
    addEdge(id, videoNodeId);
    setSelectedNode(videoNodeId);
  }, [addEdge, addNode, findNodePosition, id, setSelectedNode]);

  const quickStyle = typeof data.quickStyle === 'string' ? data.quickStyle : '';
  const quickSynopsis = typeof data.quickSynopsis === 'string' ? data.quickSynopsis : '';
  // 上游接入的文本在前、节点里手输的在后，合并成一份 —— 只给本地生成用。
  const effectiveQuickStyle = mergeUpstreamText(upstreamStyleTexts, quickStyle);
  const effectiveQuickSynopsis = mergeUpstreamText(upstreamSynopsisTexts, quickSynopsis);
  // 上游文本单独走一条通道进高级编辑，在输入框下方作灰色只读回显（不进工程文件）。
  const quickSyncUpstream = useMemo<CinematicStudioUpstreamText>(() => ({
    styleBrief: upstreamStyleTexts,
    storySynopsis: upstreamSynopsisTexts,
  }), [upstreamStyleTexts, upstreamSynopsisTexts]);
  const hasUpstreamText = upstreamStyleTexts.length > 0 || upstreamSynopsisTexts.length > 0;
  const quickChatProvider = typeof data.quickChatProvider === 'string' ? data.quickChatProvider : '';
  const quickChatModel = typeof data.quickChatModel === 'string' ? data.quickChatModel : '';
  const selectedQuickChatProvider = quickChatProvider || defaultChatSettings.provider;
  const selectedQuickChatModel = quickChatModel || defaultChatSettings.model;
  const hasSelectedQuickChatModel = chatModels.some(
    (option) => option.providerId === selectedQuickChatProvider && option.model === selectedQuickChatModel,
  );
  const selectedQuickChatOption = chatModels.find(
    (option) => option.providerId === selectedQuickChatProvider && option.model === selectedQuickChatModel,
  );
  const resolvedActiveChatProviderId = chatModelGroups.some((group) => group.providerId === activeChatProviderId)
    ? activeChatProviderId
    : (hasSelectedQuickChatModel ? selectedQuickChatProvider : chatModelGroups[0]?.providerId ?? '');
  const activeChatModelGroup = chatModelGroups.find((group) => group.providerId === resolvedActiveChatProviderId);
  // 提示词输出语言：画布语言是默认值，节点上一旦点过中/英切换就固定为用户的选择。
  const canvasLocale: Locale = i18n.language.startsWith('en') ? 'en' : 'zh';
  const storedQuickPromptLang: Locale | undefined = data.quickPromptLang === 'en' || data.quickPromptLang === 'zh'
    ? data.quickPromptLang
    : undefined;
  const quickPromptLang: Locale = storedQuickPromptLang ?? canvasLocale;
  const handleQuickPromptLangChange = useCallback((lang: Locale) => {
    updateNodeData(id, { quickPromptLang: lang });
  }, [id, updateNodeData]);
  // `quickStaging` intentionally follows SceneStaging from the advanced editor.
  // The two legacy arrays are read only as a migration path for existing canvases.
  const hasQuickStaging = Boolean(data.quickStaging && typeof data.quickStaging === 'object' && !Array.isArray(data.quickStaging));
  const quickStaging = (hasQuickStaging
    ? data.quickStaging
    : {}) as SceneStaging;
  // 空对象代表「这个节点还没点过场景站位」——那种情况不能把站位推给高级编辑，
  // 否则一打开高级编辑就会把里面已经设好的地点 / 角色候选清空。
  const hasQuickStagingData = hasQuickStaging && Object.keys(quickStaging).length > 0;
  const quickStudioSync = useMemo<CinematicStudioQuickSync>(() => ({
    sceneId: typeof data.quickStudioSceneId === 'string' && data.quickStudioSceneId.trim()
      ? data.quickStudioSceneId.trim()
      : undefined,
    // 只传节点里手输的原文：高级编辑里的白字就是这份内容，
    // 上游文本另走 quickSyncUpstream，在输入框下方作灰色回显。
    styleBrief: quickStyle,
    storySynopsis: quickSynopsis,
    // 站位整对象双向同步：节点改 → 高级编辑跟着改，高级编辑改 → 节点跟着改。
    ...(hasQuickStagingData ? { staging: { ...quickStaging } } : {}),
  }), [data.quickStudioSceneId, hasQuickStagingData, quickStyle, quickSynopsis, quickStaging]);
  const quickSyncInitialized = data.quickSyncInitialized === true;
  const quickStudioSyncRef = useRef(quickStudioSync);
  const quickStudioSyncTimer = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  useEffect(() => {
    quickStudioSyncRef.current = quickStudioSync;
  }, [quickStudioSync]);
  useEffect(() => () => {
    if (quickStudioSyncTimer.current !== null) window.clearTimeout(quickStudioSyncTimer.current);
  }, []);
  const scheduleQuickStudioSync = useCallback((patch: Partial<CinematicStudioQuickSync>) => {
    const next = { ...quickStudioSyncRef.current, ...patch };
    quickStudioSyncRef.current = next;
    if (!studioProjectId) return;
    if (quickStudioSyncTimer.current !== null) window.clearTimeout(quickStudioSyncTimer.current);
    quickStudioSyncTimer.current = window.setTimeout(() => {
      quickStudioSyncTimer.current = null;
      void persistQuickStudioSync(studioProjectId, quickStudioSyncRef.current);
    }, 300);
  }, [studioProjectId]);
  const handleQuickStyleChange = useCallback((value: string) => {
    updateNodeData(id, { quickStyle: value, quickSyncInitialized: true });
    scheduleQuickStudioSync({ styleBrief: value });
  }, [id, scheduleQuickStudioSync, updateNodeData]);
  const handleQuickSynopsisChange = useCallback((value: string) => {
    updateNodeData(id, { quickSynopsis: value, quickSyncInitialized: true });
    scheduleQuickStudioSync({ storySynopsis: value });
  }, [id, scheduleQuickStudioSync, updateNodeData]);
  const legacySceneAssetIds = stringArray(data.quickSceneAssetIds);
  const legacyCharacterAssetIds = stringArray(data.quickCharacterAssetIds);
  const sceneAssetIds = hasQuickStaging
    ? (quickStaging.locationAssetId ? [quickStaging.locationAssetId] : [])
    : legacySceneAssetIds;
  const characterAssetIds = hasQuickStaging
    ? [...new Set(quickStaging.characterRoster ?? [])]
    : legacyCharacterAssetIds;
  const selectedSceneAssets = useMemo(
    () => selectedCinematicAssets(sceneAssetIds, libraryAssets),
    [libraryAssets, sceneAssetIds.join('|')],
  );
  const selectedCharacterAssets = useMemo(
    () => selectedCinematicAssets(characterAssetIds, libraryAssets),
    [characterAssetIds.join('|'), libraryAssets],
  );
  // 与高级编辑器一致：地点是单一的场景站位资产；场景角色候选由
  // characterRoster 维护。镜像库中的多张参考图仍属于同一电影资产。
  const locationAssets = useMemo(
    () => cinematicImageAssets(libraryAssets, 'location'),
    [libraryAssets],
  );
  const characterAssets = useMemo(
    () => cinematicImageAssets(libraryAssets, 'character'),
    [libraryAssets],
  );
  const characterCandidates = useMemo(
    () => characterAssets.filter((asset) => !characterAssetIds.includes(cinematicAssetKey(asset))),
    [characterAssetIds.join('|'), characterAssets],
  );
  const selectedCharacterVoiceAssets = useMemo(() => {
    const selectedCharacterIds = new Set(characterAssetIds);
    const seenSources = new Set<string>();
    return libraryAssets.filter((asset) => {
      const source = asset.sourcePath.trim();
      if (asset.mediaType !== 'audio' || cinematicAssetKind(asset) !== 'character' || !source) return false;
      if (!selectedCharacterIds.has(cinematicAssetKey(asset)) || seenSources.has(source)) return false;
      seenSources.add(source);
      return true;
    });
  }, [characterAssetIds.join('|'), libraryAssets]);

  // 道具的参考图只存在于画布素材库的镜像条目里，工程资产记录只保存语义。
  // 同一个道具取首张参考图，与场景 / 角色资产的取图规则一致。
  const propImageSources = useMemo(() => {
    const map = new Map<string, string>();
    for (const asset of libraryAssets) {
      const source = asset.sourcePath.trim();
      if (asset.mediaType !== 'image' || !source) continue;
      if (cinematicAssetKind(asset) !== 'prop') continue;
      const key = cinematicAssetKey(asset);
      if (!map.has(key)) map.set(key, source);
    }
    return map;
  }, [libraryAssets]);

  // 所有引用统一使用电影工程资产名称；镜像名称仅作为旧数据的 fallback。
  const cinematicMirrorNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const asset of libraryAssets) {
      if (!asset.sourcePath.trim()) continue;
      const key = cinematicAssetKey(asset);
      if (!map.has(key)) map.set(key, cinematicDisplayName(asset, cinematicAssetNames));
    }
    return map;
  }, [cinematicAssetNames, libraryAssets]);

  const toggleQuickAsset = useCallback((kind: 'scene' | 'character', assetId: string) => {
    const asset = libraryAssets.find((item) => item.id === assetId);
    const cinematicId = asset ? cinematicAssetKey(asset) : assetId;
    if (kind === 'scene') {
      const staging = {
        ...quickStaging,
        locationAssetId: sceneAssetIds.includes(cinematicId) ? undefined : cinematicId,
      };
      updateNodeData(id, {
        quickStaging: staging,
        quickSyncInitialized: true,
      });
      scheduleQuickStudioSync({ staging });
      return;
    }
    const characterRoster = characterAssetIds.includes(cinematicId)
      ? characterAssetIds.filter((item) => item !== cinematicId)
      : [...characterAssetIds, cinematicId];
    const staging = {
      ...quickStaging,
      characterRoster,
      // 与高级编辑器的候选角色删除逻辑一致：移出候选时同时移出站位排序，
      // 但新增候选不会自动占用一个左右站位。
      characterOrder: characterRoster.includes(cinematicId)
        ? quickStaging.characterOrder
        : (quickStaging.characterOrder ?? []).filter((item) => item !== cinematicId),
    };
    updateNodeData(id, { quickStaging: staging, quickSyncInitialized: true });
    scheduleQuickStudioSync({ staging });
  }, [characterAssetIds, id, libraryAssets, quickStaging, sceneAssetIds, scheduleQuickStudioSync, updateNodeData]);

  const quickPromptAssets = useMemo(() => {
    const imageSources: string[] = [];
    const audioSources: string[] = [];
    const imageIndex = new Map<string, number>();
    const audioIndex = new Map<string, number>();
    const toPromptAsset = ({ id: assetId, name, description, source, mediaType = 'image' }: {
      id: string;
      name: string;
      description?: string;
      source: string;
      mediaType?: QuickPromptAsset['mediaType'];
    }): QuickPromptAsset => {
      const path = source.trim();
      let referenceIndex: number | undefined;
      if (path && mediaType !== 'video') {
        const sources = mediaType === 'audio' ? audioSources : imageSources;
        const index = mediaType === 'audio' ? audioIndex : imageIndex;
        referenceIndex = index.get(path);
        if (!referenceIndex) {
          referenceIndex = sources.length + 1;
          index.set(path, referenceIndex);
          sources.push(path);
        }
      }
      return { id: assetId, name: name.trim() || '未命名素材', description, mediaType, referenceIndex };
    };
    const libraryAssetToPromptAsset = (asset: LibraryAsset) => toPromptAsset({
      id: asset.id,
      name: cinematicDisplayName(asset, cinematicAssetNames),
      description: cinematicAssetDescription(asset),
      source: asset.sourcePath,
      mediaType: asset.mediaType,
    });
    const upstreamAsset = (kind: 'scene' | 'character', mediaType: QuickPromptAsset['mediaType'], source: string, index: number) => toPromptAsset({
      id: `upstream-${kind}-${mediaType}-${index}-${source}`,
      name: `${kind === 'scene' ? '场景' : '角色'}${mediaType === 'image' ? '图片' : mediaType === 'audio' ? '音频' : '视频'} ${index + 1}`,
      description: `上游接入：${fileLabel(source, '素材')}`,
      source,
      mediaType,
    });
    return {
      sceneAssets: [
        ...selectedSceneAssets.map(libraryAssetToPromptAsset),
        ...sceneInputMedia.images.map((source, index) => upstreamAsset('scene', 'image', source, index)),
        ...sceneInputMedia.audio.map((source, index) => upstreamAsset('scene', 'audio', source, index)),
        ...sceneInputMedia.videos.map((source, index) => upstreamAsset('scene', 'video', source, index)),
      ],
      characterAssets: [
        ...selectedCharacterAssets.map(libraryAssetToPromptAsset),
        ...selectedCharacterVoiceAssets.map(libraryAssetToPromptAsset),
        ...characterInputMedia.images.map((source, index) => upstreamAsset('character', 'image', source, index)),
        ...characterInputMedia.audio.map((source, index) => upstreamAsset('character', 'audio', source, index)),
        ...characterInputMedia.videos.map((source, index) => upstreamAsset('character', 'video', source, index)),
      ],
      referenceImages: imageSources,
      referenceAudio: audioSources,
    };
  }, [characterInputMedia, cinematicAssetNames, sceneInputMedia, selectedCharacterAssets, selectedCharacterVoiceAssets, selectedSceneAssets]);

  const handleQuickGenerate = useCallback(async (event: React.MouseEvent) => {
    event.stopPropagation();
    if (quickGenerating) return;
    if (!effectiveQuickStyle || !effectiveQuickSynopsis) {
      setQuickError('请先填写风格/质量和故事梗概。');
      return;
    }
    setQuickError('');
    setQuickGenerating(true);
    try {
      const selectedSettings = quickChatProvider && quickChatModel
        ? resolveLenTalkChatModel(quickChatProvider, quickChatModel)
        : defaultChatSettings;
      // 场景站位 / 场景角色候选里除了资产 id 还有描述、表演母版、声音锁、随身道具和
      // 站位的空间文字，这些只存在于电影工程的资产记录里。生成前读一次资产库，把它们
      // 一起带给 Agent，模型才能「按故事梗概」决定引用谁。
      // 注意：资产是全局共享的（节点工程只保存场景结构），所以必须读共享资产库，
      // 再并上节点工程自己的遗留资产，否则拿到的 assets 是空的。
      const [storedProject, sharedAssets] = await Promise.all([
        studioProjectId ? loadProjectFromDatabaseById(studioProjectId) : Promise.resolve(null),
        loadSharedAssets(),
      ]);
      const assets = mergeAssetPool(sharedAssets, storedProject?.assets ?? []);
      const projectAssetNames = new Map(
        assets
          .filter((asset) => asset.name.trim())
          .map((asset) => [asset.id, asset.name.trim()]),
      );
      const stagingContext = buildQuickStagingContext({
        assets,
        staging: hasQuickStagingData ? quickStaging : undefined,
        imageSources: quickPromptAssets.referenceImages,
        resolveImageSource: (assetId) => propImageSources.get(assetId),
        resolveAssetName: (assetId) => projectAssetNames.get(assetId) ?? cinematicMirrorNames.get(assetId),
      });
      // 素材库镜像里的描述是从工程资产复制过来的，旧数据曾被落库丢过该字段，
      // 退化成一串标签（「场景、电影资产」）。生成前用工程资产的描述兜底，
      // 保证「场景站位 / 角色候选里的描述」一定进提示词。
      const descriptionByAssetId = new Map<string, string>();
      for (const asset of assets) {
        const description = asset.descriptionZh?.trim() || asset.description?.trim();
        if (description) descriptionByAssetId.set(asset.id, description);
      }
      const withProjectMetadata = (list: QuickPromptAsset[]): QuickPromptAsset[] => list.map((item) => {
        const assetId = cinematicAssetIdFromMirrorId(item.id);
        const description = descriptionByAssetId.get(assetId);
        const name = projectAssetNames.get(assetId);
        if (!description && !name) return item;
        return {
          ...item,
          ...(name && name !== item.name ? { name } : {}),
          ...(description && description !== item.description ? { description } : {}),
        };
      });
      const prompt = await generateQuickPrompt({
        style: effectiveQuickStyle,
        synopsis: effectiveQuickSynopsis,
        sceneAssets: withProjectMetadata(quickPromptAssets.sceneAssets),
        characterAssets: withProjectMetadata(quickPromptAssets.characterAssets),
        ...(stagingContext.staging ? { staging: stagingContext.staging } : {}),
        ...(stagingContext.characterProfiles.length ? { characterProfiles: stagingContext.characterProfiles } : {}),
        ...(stagingContext.props.length ? { props: stagingContext.props } : {}),
      }, quickPromptLang, selectedSettings);
      // 道具参考图续在场景 / 角色之后，既有 [imageN] 顺序完全不变。
      const referenceImages = [...quickPromptAssets.referenceImages, ...stagingContext.referenceImages];
      // 极简生成链路：保存当前结果后立即创建右侧 AI 视频节点并自动连线。
      // 图片与声音均来自场景/角色输入口及其本地资产选择；视频输入作为提示词 Agent 的上下文素材。
      const referenceAudio = quickPromptAssets.referenceAudio;
      updateNodeData(id, {
        quickPrompt: prompt,
        quickReferenceImages: referenceImages,
        lastPromptPreview: prompt,
        studioReferenceImages: referenceImages,
        studioReferenceAudio: referenceAudio,
      });
      handleSendToVideo({ prompt, referenceImages, referenceAudio });
    } catch (error) {
      setQuickError(error instanceof Error ? error.message : '生成提示词失败，请稍后重试。');
    } finally {
      setQuickGenerating(false);
    }
  }, [cinematicMirrorNames, defaultChatSettings, effectiveQuickStyle, effectiveQuickSynopsis, handleSendToVideo, hasQuickStagingData, id, propImageSources, quickChatModel, quickChatProvider, quickGenerating, quickPromptAssets, quickPromptLang, quickStaging, studioProjectId, updateNodeData]);

  const cachedTitle = typeof data.lastProjectTitle === 'string' ? data.lastProjectTitle.trim() : '';
  const isLegacyPreview = cachedTitle === '雨夜' || cachedTitle === 'Rain Night';
  const projectTitle = cachedTitle && !isLegacyPreview ? cachedTitle : null;
  // 标题优先级：用户给节点起的名字 > 工作室工程标题 > 默认名。
  const hasCustomTitle = !isNodeUsingDefaultDisplayName(CANVAS_NODE_TYPES.cinematicStudio, data);
  const nodeTitle = hasCustomTitle ? displayName : (projectTitle ?? displayName);

  return (
    <div
      className={`
        group relative flex h-full flex-col overflow-visible rounded-[var(--node-radius)] border bg-surface-dark/90 p-2 transition-colors duration-150
        ${selected
          ? 'border-accent shadow-[0_0_0_1px_rgba(59,130,246,0.32)]'
          : 'border-[rgba(15,23,42,0.22)] hover:border-[rgba(15,23,42,0.34)] dark:border-[rgba(255,255,255,0.22)] dark:hover:border-[rgba(255,255,255,0.34)]'}
      `}
      style={{ width: resolvedWidth, height: resolvedHeight }}
    >
      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<Clapperboard className="h-4 w-4" />}
        titleText={nodeTitle}
        editable
        onTitleChange={(value) => updateNodeData(id, { displayName: value })}
        rightSlot={(
          <button
            type="button"
            className="nodrag flex items-center gap-1 rounded border border-[rgba(255,255,255,0.14)] px-1.5 py-1 text-[10px] text-text-muted transition-colors hover:border-accent hover:text-text"
            onClick={handleOpen}
            title="进入完整高级工作台"
          >
            <Settings2 className="h-3 w-3" /> 高级编辑
          </button>
        )}
      />

      <section
        className="relative mt-7 flex min-h-0 flex-1 flex-col gap-2.5 overflow-visible rounded-lg border border-[rgba(255,255,255,0.12)] bg-bg-dark/70 p-2.5"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <label className="relative flex min-h-0 flex-col gap-1 text-[10px] text-text-muted">
          <Handle
            type="target"
            id={QUICK_INPUT_HANDLES.style}
            position={Position.Left}
            title="接入上游文本：风格 / 质量"
            className="!left-[-13px] !top-1/2 !h-2.5 !w-2.5 !-translate-y-1/2 !border-surface-dark !bg-accent"
          />
          <span className="flex items-center justify-between gap-2">
            风格 / 质量
            {upstreamStyleTexts.length ? <span className="text-[9px] text-accent">已接入 {upstreamStyleTexts.length} 条文本</span> : null}
          </span>
          <div className="relative">
            {/* 与 AI 图片节点(ImageEditNode)一致：上游接入的文本以灰色只读行贴在输入框底部。 */}
            <textarea
              className={`nodrag nowheel ui-scrollbar h-24 w-full resize-y overflow-y-auto rounded border border-[rgba(255,255,255,0.12)] bg-black/20 px-2 py-1.5 text-[11px] leading-relaxed text-text outline-none placeholder:text-text-muted/60 focus:border-accent ${upstreamStyleTexts.length > 0 ? 'pb-[62px]' : ''}`}
              value={quickStyle}
              placeholder="例如：胶片感写实、冷暖对比、35mm、细腻颗粒"
              onChange={(event) => handleQuickStyleChange(event.target.value)}
              onPointerDown={(event) => event.stopPropagation()}
              onWheel={(event) => event.stopPropagation()}
            />
            {upstreamStyleTexts.length > 0 && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute bottom-0 left-0 right-0 z-10 flex flex-col rounded-b bg-bg-dark/90 px-2 py-1 text-[11px] leading-relaxed text-text-muted"
              >
                {upstreamStyleTexts.slice(0, 3).map((text, index) => (
                  <div
                    key={`upstream-style-${index}`}
                    className="overflow-hidden text-ellipsis whitespace-nowrap"
                    title={text}
                  >
                    {text}
                  </div>
                ))}
              </div>
            )}
          </div>
        </label>

        <label className="relative flex min-h-0 flex-col gap-1 text-[10px] text-text-muted">
          <Handle
            type="target"
            id={QUICK_INPUT_HANDLES.synopsis}
            position={Position.Left}
            title="接入上游文本：故事梗概"
            className="!left-[-13px] !top-1/2 !h-2.5 !w-2.5 !-translate-y-1/2 !border-surface-dark !bg-accent"
          />
          <span className="flex items-center justify-between gap-2">
            故事梗概
            {upstreamSynopsisTexts.length ? <span className="text-[9px] text-accent">已接入 {upstreamSynopsisTexts.length} 条文本</span> : null}
          </span>
          <div className="relative">
            {/* 与 AI 图片节点(ImageEditNode)一致：上游接入的文本以灰色只读行贴在输入框底部。 */}
            <textarea
              className={`nodrag nowheel ui-scrollbar h-24 w-full resize-y overflow-y-auto rounded border border-[rgba(255,255,255,0.12)] bg-black/20 px-2 py-1.5 text-[11px] leading-relaxed text-text outline-none placeholder:text-text-muted/60 focus:border-accent ${upstreamSynopsisTexts.length > 0 ? 'pb-[62px]' : ''}`}
              value={quickSynopsis}
              placeholder="写清人物、事件、动作顺序和关键变化"
              onChange={(event) => handleQuickSynopsisChange(event.target.value)}
              onPointerDown={(event) => event.stopPropagation()}
              onWheel={(event) => event.stopPropagation()}
            />
            {upstreamSynopsisTexts.length > 0 && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute bottom-0 left-0 right-0 z-10 flex flex-col rounded-b bg-bg-dark/90 px-2 py-1 text-[11px] leading-relaxed text-text-muted"
              >
                {upstreamSynopsisTexts.slice(0, 3).map((text, index) => (
                  <div
                    key={`upstream-synopsis-${index}`}
                    className="overflow-hidden text-ellipsis whitespace-nowrap"
                    title={text}
                  >
                    {text}
                  </div>
                ))}
              </div>
            )}
          </div>
        </label>

        <div className="grid grid-cols-2 gap-2">
          {([
            ['scene', '场景站位', '地点', '选择地点资产', QUICK_INPUT_HANDLES.sceneAssets, selectedSceneAssets, locationAssets, sceneInputMedia],
            ['character', '场景角色候选', '角色', '选择角色加入场景角色候选', QUICK_INPUT_HANDLES.characterAssets, selectedCharacterAssets, characterCandidates, characterInputMedia],
          ] as const).map(([kind, label, sourceLabel, pickerLabel, inputHandleId, chosen, availableAssets, connectedMedia]) => (
            <div key={kind} data-quick-popover className="relative rounded border border-[rgba(255,255,255,0.12)] bg-black/15 p-1.5">
              <Handle
                type="target"
                id={inputHandleId}
                position={Position.Left}
                title={`接入上游${label}：图片、音频或视频`}
                className="!left-[-13px] !top-1/2 !h-2.5 !w-2.5 !-translate-y-1/2 !border-surface-dark !bg-accent"
              />
              <p className="mb-1 flex items-center justify-between gap-2 text-[10px] text-text-muted">
                <span>{label}</span>
                {connectedMedia.images.length + connectedMedia.audio.length + connectedMedia.videos.length > 0 ? (
                  <span className="text-[9px] text-accent">已接入 {connectedMedia.images.length + connectedMedia.audio.length + connectedMedia.videos.length}</span>
                ) : null}
              </p>
              <div className="flex min-h-10 items-center gap-1 overflow-x-auto pb-0.5">
                {connectedMedia.images.map((source, index) => (
                  <div key={`input-image-${source}`} className="relative h-9 w-9 shrink-0 overflow-hidden rounded border border-accent/60 bg-black/30" title={`上游图片：${fileLabel(source, `图片 ${index + 1}`)}`}>
                    <img className="h-full w-full object-cover" src={resolveImageDisplayUrl(source)} alt={`上游图片 ${index + 1}`} />
                    <span className="absolute inset-x-0 bottom-0 bg-black/70 px-0.5 py-px text-center text-[8px] text-white">接入</span>
                  </div>
                ))}
                {connectedMedia.audio.map((source, index) => (
                  <div key={`input-audio-${source}`} className="relative flex h-9 w-9 shrink-0 flex-col items-center justify-center rounded border border-accent/60 bg-accent/10 text-accent" title={`上游音频：${fileLabel(source, `音频 ${index + 1}`)}`}>
                    <AudioLines className="h-3.5 w-3.5" />
                    <span className="mt-0.5 text-[8px]">音频</span>
                  </div>
                ))}
                {connectedMedia.videos.map((source, index) => (
                  <div key={`input-video-${source}`} className="relative flex h-9 w-9 shrink-0 flex-col items-center justify-center rounded border border-accent/60 bg-accent/10 text-accent" title={`上游视频：${fileLabel(source, `视频 ${index + 1}`)}`}>
                    <Video className="h-3.5 w-3.5" />
                    <span className="mt-0.5 text-[8px]">视频</span>
                  </div>
                ))}
                {chosen.map((asset) => (
                  <div key={asset.id} className="group/asset relative h-9 w-9 shrink-0 overflow-hidden rounded border border-white/15 bg-black/30" title={cinematicDisplayName(asset, cinematicAssetNames)}>
                    <img className="h-full w-full object-cover" src={resolveImageDisplayUrl(asset.previewImageUrl || asset.sourcePath)} alt={cinematicDisplayName(asset, cinematicAssetNames)} />
                    <button
                      type="button"
                      aria-label={`移除${cinematicDisplayName(asset, cinematicAssetNames)}`}
                      className="absolute inset-0 flex items-center justify-center bg-black/65 opacity-0 transition-opacity group-hover/asset:opacity-100"
                      onClick={() => toggleQuickAsset(kind, asset.id)}
                    >
                      <X className="h-3.5 w-3.5 text-white" />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  aria-label={`添加${label}`}
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded border border-dashed text-text-muted transition-colors hover:border-accent hover:bg-accent/10 hover:text-accent ${activeAssetPicker === kind ? 'border-accent bg-accent/10 text-accent' : 'border-white/25'}`}
                  onClick={() => setActiveAssetPicker((current) => current === kind ? null : kind)}
                >
                  <Plus className="h-4 w-4" />
                </button>
                {chosen.length === 0 && connectedMedia.images.length + connectedMedia.audio.length + connectedMedia.videos.length === 0 ? <span className="whitespace-nowrap text-[9px] text-text-muted/70">接入媒体或点击 + 选择</span> : null}
              </div>

              {activeAssetPicker === kind ? (
                <div
                  className="absolute left-0 top-[calc(100%+6px)] z-40 w-[min(360px,calc(100vw-40px))] rounded-lg border border-white/15 bg-[#171b25] p-2 shadow-2xl"
                  onPointerDown={(event) => event.stopPropagation()}
                  onWheel={(event) => event.stopPropagation()}
                >
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-text">{pickerLabel}</span>
                    <button type="button" className="rounded p-0.5 text-text-muted hover:bg-white/10 hover:text-white" onClick={() => setActiveAssetPicker(null)} aria-label="关闭选择器">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  {/* Compact six-column cards keep the picker usable with a large asset library.
                      The fixed-height panel deliberately scrolls inside the popover instead of
                      overflowing the canvas viewport. */}
                  <div className="grid h-56 grid-cols-6 content-start gap-1 overflow-y-auto overscroll-contain pr-0.5">
                    {availableAssets.length ? availableAssets.map((asset) => {
                      const active = (kind === 'scene' ? sceneAssetIds : characterAssetIds).includes(cinematicAssetKey(asset));
                      return (
                        <button
                          key={asset.id}
                          type="button"
                          className={`relative overflow-hidden rounded border text-left transition-colors ${active ? 'border-accent ring-1 ring-accent' : 'border-white/15 hover:border-white/40'}`}
                          onClick={() => toggleQuickAsset(kind, asset.id)}
                          title={cinematicDisplayName(asset, cinematicAssetNames)}
                        >
                          <img className="aspect-square w-full object-cover" src={resolveImageDisplayUrl(asset.previewImageUrl || asset.sourcePath)} alt={cinematicDisplayName(asset, cinematicAssetNames)} />
                          <span className="block truncate bg-black/70 px-0.5 py-0.5 text-[8px] text-white">{cinematicDisplayName(asset, cinematicAssetNames)}</span>
                          {active ? <span className="absolute right-0.5 top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-accent text-white"><Check className="h-2.5 w-2.5" /></span> : null}
                        </button>
                      );
                    }) : (
                      <p className="col-span-6 py-4 text-center text-[10px] text-text-muted">
                        {kind === 'character' && characterAssets.length ? '所有角色都已加入场景角色候选' : `资产库「${sourceLabel}」中暂无资产`}
                      </p>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>

        {quickError ? <p className="text-[10px] leading-snug text-red-400">{quickError}</p> : null}

        <div className="flex items-center justify-between gap-2">
          <div data-quick-popover className="relative min-w-0 flex-1">
            <button
              type="button"
              className="nodrag flex h-8 w-full min-w-0 items-center gap-1.5 rounded border border-[rgba(255,255,255,0.16)] bg-black/25 px-2 text-left transition-colors hover:border-[rgba(255,255,255,0.32)] focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
              disabled={quickGenerating || chatModels.length === 0}
              aria-label="Chat 模型"
              onClick={() => {
                setActiveChatProviderId(hasSelectedQuickChatModel ? selectedQuickChatProvider : chatModelGroups[0]?.providerId ?? '');
                setIsChatModelPickerOpen((current) => !current);
              }}
            >
              <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-text">
                {selectedQuickChatOption?.model ?? (chatModels.length ? '选择 Chat 模型' : '请先配置 Chat 模型')}
              </span>
              {selectedQuickChatOption ? <span className="max-w-[72px] truncate text-[10px] text-text-muted">{selectedQuickChatOption.providerName}</span> : null}
              <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-text-muted transition-transform ${isChatModelPickerOpen ? 'rotate-180' : ''}`} />
            </button>

            {isChatModelPickerOpen && chatModelGroups.length ? (
              <div
                className="absolute bottom-[calc(100%+8px)] left-0 z-50 w-[min(420px,calc(100vw-40px))] rounded-lg border border-[rgba(255,255,255,0.16)] bg-[#171b25] p-2 shadow-2xl"
                onPointerDown={(event) => event.stopPropagation()}
                onWheel={(event) => event.stopPropagation()}
              >
                <div className="max-h-60 overflow-y-auto overscroll-contain pr-0.5">
                <section>
                  <p className="mb-2 text-[10px] font-medium text-text-muted">平台</p>
                  <div className="flex flex-wrap gap-1.5">
                    {chatModelGroups.map((group) => {
                      const active = group.providerId === resolvedActiveChatProviderId;
                      return (
                        <button
                          key={group.providerId}
                          type="button"
                          className={`h-7 rounded-md border px-2 text-[10px] transition-colors ${active ? 'border-accent/50 bg-accent/15 text-text' : 'border-white/15 bg-black/20 text-text-muted hover:border-white/30 hover:text-text'}`}
                          onClick={() => setActiveChatProviderId(group.providerId)}
                        >
                          {group.providerName}
                        </button>
                      );
                    })}
                  </div>
                </section>
                <section className="mt-3 border-t border-white/10 pt-3">
                  <p className="mb-2 text-[10px] font-medium text-text-muted">Chat 模型</p>
                  <div className="flex flex-wrap gap-1.5">
                    {activeChatModelGroup?.models.map((model) => {
                      const active = activeChatModelGroup.providerId === selectedQuickChatProvider && model === selectedQuickChatModel;
                      return (
                        <button
                          key={`${activeChatModelGroup.providerId}:${model}`}
                          type="button"
                          className={`min-w-0 max-w-full rounded-md border px-2 py-1.5 text-left text-[10px] transition-colors ${active ? 'border-accent/50 bg-accent/15 text-text' : 'border-white/15 bg-black/20 text-text-muted hover:border-white/30 hover:text-text'}`}
                          onClick={() => {
                            updateNodeData(id, { quickChatProvider: activeChatModelGroup.providerId, quickChatModel: model });
                            setIsChatModelPickerOpen(false);
                          }}
                        >
                          {model}
                        </button>
                      );
                    })}
                  </div>
                </section>
                </div>
              </div>
            ) : null}
          </div>
          {/* 提示词输出语言：默认跟随画布语言，点过之后固定为用户的选择。 */}
          <div
            className="nodrag flex h-8 shrink-0 items-stretch overflow-hidden rounded border border-[rgba(255,255,255,0.16)]"
            title={storedQuickPromptLang
              ? '提示词输出语言（已固定，不再跟随画布）'
              : `提示词输出语言：跟随画布（当前${canvasLocale === 'zh' ? '中文' : 'English'}）`}
          >
            <button
              type="button"
              className={`px-2 text-[11px] font-medium transition-colors ${quickPromptLang === 'zh' ? 'bg-accent text-white' : 'text-text-muted hover:bg-white/5 hover:text-text'}`}
              onClick={() => handleQuickPromptLangChange('zh')}
            >
              中
            </button>
            <button
              type="button"
              className={`px-2 text-[11px] font-medium transition-colors ${quickPromptLang === 'en' ? 'bg-accent text-white' : 'text-text-muted hover:bg-white/5 hover:text-text'}`}
              onClick={() => handleQuickPromptLangChange('en')}
            >
              EN
            </button>
          </div>
          <button
            type="button"
            className="shrink-0 flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={quickGenerating || chatModels.length === 0}
            onClick={handleQuickGenerate}
          >
            {quickGenerating ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            {quickGenerating ? '生成中…' : '生成并创建视频'}
          </button>
        </div>

        <ImagePromptOptimizerPanel nodeId={id} data={data} onOpenChange={handleImagePromptOpenChange} />
      </section>

      <Handle
        type="source"
        id="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-surface-dark !bg-accent"
      />
      <NodeResizeHandle
        minWidth={CINEMATIC_STUDIO_NODE_MIN_WIDTH}
        minHeight={isImagePromptOpen ? CINEMATIC_STUDIO_NODE_EXPANDED_MIN_HEIGHT : CINEMATIC_STUDIO_NODE_COLLAPSED_MIN_HEIGHT}
      />

      {isOpen && typeof document !== 'undefined'
        ? createPortal(
          <CinematicStudioWorkbench onClose={handleClose} onStateChange={handleStateChange} onSendToVideo={handleSendToVideo} canvasAudioSources={canvasAudioSources} canvasImageSources={canvasImageSources} projectId={studioProjectId || undefined} quickSync={quickSyncInitialized || hasUpstreamText || hasQuickStagingData ? quickStudioSync : undefined} quickSyncUpstream={quickSyncUpstream} />,
          document.body
        )
        : null}
    </div>
  );
});

CinematicStudioNode.displayName = 'CinematicStudioNode';
