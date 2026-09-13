import {
  AUTO_REQUEST_ASPECT_RATIO,
  CANVAS_NODE_TYPES,
  DEFAULT_ASPECT_RATIO,
  EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  type AudioNodeData,
  type AudioGenNodeData,
  type CinematicStudioNodeData,
  type DirectorDeskNodeData,
  type ImageSize,
  type CanvasNodeData,
  type CanvasNodeType,
  type ExportImageNodeData,
  type GroupNodeData,
  type ImageEditNodeData,
  type VideoGenNodeData,
  type PanoramaNodeData,
  type PromptOptimizerNodeData,
  type StoryboardSplitNodeData,
  type StoryboardGenNodeData,
  type TextAnnotationNodeData,
  type UploadImageNodeData,
  type SeamlessMosaicNodeData,
} from './canvasNodes';
import { DEFAULT_NODE_DISPLAY_NAME } from './nodeDisplay';
import { getAudioModel, getDefaultAudioModelId, getDefaultImageModelId, getImageModel } from '../models';
import { useSettingsStore } from '@/stores/settingsStore';
import { createCinematicProjectId } from '@/features/cinematicStudio/app/projectId';

export type MenuIconKey = 'upload' | 'sparkles' | 'layout' | 'text' | 'orbit' | 'box' | 'music' | 'video' | 'mosaic' | 'clapperboard';

export interface CanvasNodeCapabilities {
  toolbar: boolean;
  promptInput: boolean;
}

export interface CanvasNodeConnectivity {
  sourceHandle: boolean;
  targetHandle: boolean;
  connectMenu: {
    fromSource: boolean;
    fromTarget: boolean;
  };
}

export interface CanvasNodeDefinition<TData extends CanvasNodeData = CanvasNodeData> {
  type: CanvasNodeType;
  menuLabelKey: string;
  menuIcon: MenuIconKey;
  visibleInMenu: boolean;
  capabilities: CanvasNodeCapabilities;
  connectivity: CanvasNodeConnectivity;
  createDefaultData: () => TData;
  /** 创建节点时的初始尺寸(可选, 未设置则由 React Flow 按内容测量) */
  defaultSize?: { width: number; height: number };
}

const uploadNodeDefinition: CanvasNodeDefinition<UploadImageNodeData> = {
  type: CANVAS_NODE_TYPES.upload,
  menuLabelKey: 'node.menu.uploadImage',
  menuIcon: 'upload',
  visibleInMenu: true,
  capabilities: {
    toolbar: true,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: false,
    connectMenu: {
      fromSource: false,
      fromTarget: true,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.upload],
    imageUrl: null,
    previewImageUrl: null,
    aspectRatio: '1:1',
    isSizeManuallyAdjusted: false,
    sourceFileName: null,
  }),
};

const imageEditNodeDefinition: CanvasNodeDefinition<ImageEditNodeData> = {
  type: CANVAS_NODE_TYPES.imageEdit,
  menuLabelKey: 'node.menu.aiImageGeneration',
  menuIcon: 'sparkles',
  visibleInMenu: true,
  capabilities: {
    toolbar: true,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: false,
    },
  },
  createDefaultData: () => {
    // 默认选中「上一次使用的模型」;模型失效或未配置密钥时回退到默认模型
    let defaultModelId = getDefaultImageModelId();
    const lastModelId = useSettingsStore.getState().lastImageModelId;
    if (lastModelId) {
      const resolved = getImageModel(lastModelId);
      const keys = useSettingsStore.getState().apiKeys;
      if (resolved.id === lastModelId && Boolean((keys[resolved.providerId] ?? '').trim())) {
        defaultModelId = lastModelId;
      }
    }
    return {
      displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.imageEdit],
      imageUrl: null,
      previewImageUrl: null,
      aspectRatio: DEFAULT_ASPECT_RATIO,
      isSizeManuallyAdjusted: false,
      requestAspectRatio: AUTO_REQUEST_ASPECT_RATIO,
      prompt: '',
      model: defaultModelId,
      size: '2K' as ImageSize,
      extraParams: {},
      isGenerating: false,
      generationStartedAt: null,
      generationDurationMs: 60000,
    };
  },
};

const videoGenNodeDefinition: CanvasNodeDefinition<VideoGenNodeData> = {
  type: CANVAS_NODE_TYPES.videoGen,
  menuLabelKey: 'node.menu.aiVideoGeneration',
  menuIcon: 'video',
  visibleInMenu: true,
  capabilities: { toolbar: true, promptInput: false },
  connectivity: { sourceHandle: true, targetHandle: true, connectMenu: { fromSource: true, fromTarget: false } },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.videoGen],
    prompt: '',
    model: '',
    duration: useSettingsStore.getState().lastVideoDuration,
    aspectRatio: '16:9',
    resolution: '720p',
    imageMode: 'reference',
  }),
  defaultSize: { width: 420, height: 360 },
};

const exportImageNodeDefinition: CanvasNodeDefinition<ExportImageNodeData> = {
  type: CANVAS_NODE_TYPES.exportImage,
  menuLabelKey: 'node.menu.uploadImage',
  menuIcon: 'upload',
  visibleInMenu: false,
  capabilities: {
    toolbar: true,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: false,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.exportImage],
    imageUrl: null,
    previewImageUrl: null,
    aspectRatio: DEFAULT_ASPECT_RATIO,
    isSizeManuallyAdjusted: false,
    resultKind: 'generic',
  }),
};

const groupNodeDefinition: CanvasNodeDefinition<GroupNodeData> = {
  type: CANVAS_NODE_TYPES.group,
  menuLabelKey: 'node.menu.storyboard',
  menuIcon: 'layout',
  visibleInMenu: false,
  capabilities: {
    toolbar: false,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: false,
    connectMenu: {
      fromSource: true,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.group],
    label: '组',
  }),
};

const audioNodeDefinition: CanvasNodeDefinition<AudioNodeData> = {
  type: CANVAS_NODE_TYPES.audio,
  menuLabelKey: 'node.menu.audio',
  menuIcon: 'music',
  // 本地上传统一入口会根据文件类型创建媒体节点;媒体节点本身仍可由素材库和生成流程创建。
  visibleInMenu: false,
  capabilities: {
    toolbar: true,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: true,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.audio],
    sourcePath: null,
    previewImageUrl: null,
    aspectRatio: DEFAULT_ASPECT_RATIO,
    mediaType: 'audio',
  }),
  // 媒体节点与图片结果节点保持同一紧凑尺寸, 避免本地视频占满画布。
  defaultSize: { width: EXPORT_RESULT_NODE_DEFAULT_WIDTH, height: EXPORT_RESULT_NODE_LAYOUT_HEIGHT },
};

const textAnnotationNodeDefinition: CanvasNodeDefinition<TextAnnotationNodeData> = {
  type: CANVAS_NODE_TYPES.textAnnotation,
  menuLabelKey: 'node.menu.textAnnotation',
  menuIcon: 'text',
  visibleInMenu: true,
  capabilities: {
    toolbar: true,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: true,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.textAnnotation],
    content: '',
  }),
};

const storyboardSplitDefinition: CanvasNodeDefinition<StoryboardSplitNodeData> = {
  type: CANVAS_NODE_TYPES.storyboardSplit,
  menuLabelKey: 'node.menu.storyboard',
  menuIcon: 'layout',
  visibleInMenu: false,
  capabilities: {
    toolbar: false,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: false,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.storyboardSplit],
    aspectRatio: DEFAULT_ASPECT_RATIO,
    frameAspectRatio: DEFAULT_ASPECT_RATIO,
    gridRows: 2,
    gridCols: 2,
    frames: [],
    exportOptions: {
      showFrameIndex: false,
      showFrameNote: false,
      notePlacement: 'overlay',
      imageFit: 'cover',
      frameIndexPrefix: 'S',
      cellGap: 8,
      outerPadding: 0,
      fontSize: 4,
      backgroundColor: '#0f1115',
      textColor: '#f8fafc',
    },
  }),
};

const storyboardGenNodeDefinition: CanvasNodeDefinition<StoryboardGenNodeData> = {
  type: CANVAS_NODE_TYPES.storyboardGen,
  menuLabelKey: 'node.menu.storyboardGen',
  menuIcon: 'sparkles',
  visibleInMenu: true,
  capabilities: {
    toolbar: true,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.storyboardGen],
    gridRows: 2,
    gridCols: 2,
    frames: [],
    ratioControlMode: 'cell',
    model: getDefaultImageModelId(),
    size: '2K' as ImageSize,
    requestAspectRatio: AUTO_REQUEST_ASPECT_RATIO,
    extraParams: {},
    imageUrl: null,
    previewImageUrl: null,
    aspectRatio: DEFAULT_ASPECT_RATIO,
    isGenerating: false,
    generationStartedAt: null,
    generationDurationMs: 60000,
  }),
};

const panoramaNodeDefinition: CanvasNodeDefinition<PanoramaNodeData> = {
  type: CANVAS_NODE_TYPES.panorama,
  menuLabelKey: 'node.menu.panorama',
  menuIcon: 'orbit',
  visibleInMenu: true,
  capabilities: {
    toolbar: true,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.panorama],
    imageUrl: null,
    previewImageUrl: null,
    aspectRatio: DEFAULT_ASPECT_RATIO,
    inputImageUrl: null,
    previewInputImageUrl: null,
    yaw: 0,
    pitch: 0,
    fov: 75,
    outputAspect: '16:9',
    outputImageUrl: null,
    outputPreviewImageUrl: null,
    isFraming: false,
  }),
};

const directorDeskNodeDefinition: CanvasNodeDefinition<DirectorDeskNodeData> = {
  type: CANVAS_NODE_TYPES.directorDesk,
  menuLabelKey: 'node.menu.directorDesk',
  menuIcon: 'box',
  visibleInMenu: true,
  capabilities: {
    toolbar: true,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.directorDesk],
    lastCaptureUrl: null,
    lastCapturePreviewUrl: null,
    lastCaptureAspectRatio: DEFAULT_ASPECT_RATIO,
  }),
};

const cinematicStudioNodeDefinition: CanvasNodeDefinition<CinematicStudioNodeData> = {
  type: CANVAS_NODE_TYPES.cinematicStudio,
  menuLabelKey: 'node.menu.cinematicStudio',
  menuIcon: 'clapperboard',
  visibleInMenu: true,
  capabilities: {
    toolbar: true,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.cinematicStudio],
    // 每个新建的工作室节点领取一份独立工程 id：打开时不会带上别的节点/上一次的内容。
    studioProjectId: createCinematicProjectId(),
    lastProjectTitle: null,
    lastProjectDescription: null,
    lastPromptPreview: null,
    quickStyle: '',
    quickSynopsis: '',
    quickChatProvider: '',
    quickChatModel: '',
    quickSyncInitialized: false,
    quickStudioSceneId: '',
    quickStaging: {},
    quickSceneAssetIds: [],
    quickCharacterAssetIds: [],
    quickPrompt: null,
    quickReferenceImages: [],
    imagePromptDraft: '',
    imagePromptResult: '',
  }),
  defaultSize: { width: 430, height: 700 },
};

const promptOptimizerNodeDefinition: CanvasNodeDefinition<PromptOptimizerNodeData> = {
  type: CANVAS_NODE_TYPES.promptOptimizer,
  menuLabelKey: 'node.menu.promptOptimizer',
  menuIcon: 'sparkles',
  // 已合并到「提示词工作室」节点，保留注册仅用于兼容旧画布数据。
  visibleInMenu: false,
  capabilities: {
    toolbar: true,
    promptInput: true,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: true,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.promptOptimizer],
    purpose: '',
    taskType: 'auto',
    targetModel: '',
    referencePalette: '',
    outputLang: 'zh',
    optimizedPrompt: '',
    routeSummary: '',
    notes: [],
  }),
  defaultSize: { width: 400, height: 360 },
};

const seamlessMosaicNodeDefinition: CanvasNodeDefinition<SeamlessMosaicNodeData> = {
  type: CANVAS_NODE_TYPES.seamlessMosaic,
  menuLabelKey: 'node.menu.seamlessMosaic',
  menuIcon: 'mosaic',
  visibleInMenu: true,
  capabilities: {
    toolbar: true,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: true,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.seamlessMosaic],
    imageUrl: null,
    previewImageUrl: null,
    aspectRatio: DEFAULT_ASPECT_RATIO,
    isSizeManuallyAdjusted: false,
    layers: [],
    template: 'grid',
    canvasWidth: 1920,
    canvasHeight: 1080,
    gridCols: 3,
    gridRows: 2,
    gap: 8,
    backgroundColor: '#0f1115',
    importedSourceKeys: [],
    outputImageUrl: null,
    outputPreviewImageUrl: null,
  }),
  defaultSize: { width: 260, height: 200 },
};

const audioGenNodeDefinition: CanvasNodeDefinition<AudioGenNodeData> = {
  type: CANVAS_NODE_TYPES.audioGen,
  menuLabelKey: 'node.menu.aiAudioGeneration',
  menuIcon: 'music',
  visibleInMenu: true,
  capabilities: { toolbar: true, promptInput: false },
  connectivity: { sourceHandle: true, targetHandle: true, connectMenu: { fromSource: true, fromTarget: false } },
  createDefaultData: () => {
    // 与「AI 图片」节点同构:默认选中第一个可用音频模型,模型失效时下拉会提示重选。
    const modelId = getDefaultAudioModelId();
    const model = modelId ? getAudioModel(modelId) : undefined;
    return {
      displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.audioGen],
      prompt: '',
      model: modelId,
      audioKind: model?.audioKind ?? 'speech',
      voice: model?.defaultVoice,
      format: model?.defaultFormat ?? 'mp3',
      durationSeconds: 5,
      musicLengthMs: model?.defaultMusicLengthMs ?? 30000,
      lyrics: '',
    };
  },
  defaultSize: { width: 400, height: 340 },
};

export const canvasNodeDefinitions: Record<CanvasNodeType, CanvasNodeDefinition> = {
  [CANVAS_NODE_TYPES.upload]: uploadNodeDefinition,
  [CANVAS_NODE_TYPES.imageEdit]: imageEditNodeDefinition,
  [CANVAS_NODE_TYPES.videoGen]: videoGenNodeDefinition,
  [CANVAS_NODE_TYPES.exportImage]: exportImageNodeDefinition,
  [CANVAS_NODE_TYPES.textAnnotation]: textAnnotationNodeDefinition,
  [CANVAS_NODE_TYPES.group]: groupNodeDefinition,
  [CANVAS_NODE_TYPES.storyboardSplit]: storyboardSplitDefinition,
  [CANVAS_NODE_TYPES.cinematicStudio]: cinematicStudioNodeDefinition,
  [CANVAS_NODE_TYPES.storyboardGen]: storyboardGenNodeDefinition,
  [CANVAS_NODE_TYPES.panorama]: panoramaNodeDefinition,
  [CANVAS_NODE_TYPES.directorDesk]: directorDeskNodeDefinition,
  [CANVAS_NODE_TYPES.audio]: audioNodeDefinition,
  [CANVAS_NODE_TYPES.audioGen]: audioGenNodeDefinition,
  [CANVAS_NODE_TYPES.promptOptimizer]: promptOptimizerNodeDefinition,
  [CANVAS_NODE_TYPES.seamlessMosaic]: seamlessMosaicNodeDefinition,
};

export function getNodeDefinition(type: CanvasNodeType): CanvasNodeDefinition {
  return canvasNodeDefinitions[type];
}

export function getMenuNodeDefinitions(): CanvasNodeDefinition[] {
  return Object.values(canvasNodeDefinitions).filter((definition) => definition.visibleInMenu);
}

export function nodeHasSourceHandle(type: CanvasNodeType): boolean {
  return canvasNodeDefinitions[type].connectivity.sourceHandle;
}

export function nodeHasTargetHandle(type: CanvasNodeType): boolean {
  return canvasNodeDefinitions[type].connectivity.targetHandle;
}

export function getConnectMenuNodeTypes(handleType: 'source' | 'target'): CanvasNodeType[] {
  const fromSource = handleType === 'source';
  return Object.values(canvasNodeDefinitions)
    .filter((definition) => (fromSource
      ? definition.connectivity.connectMenu.fromSource
      : definition.connectivity.connectMenu.fromTarget))
    .filter((definition) => (fromSource
      ? definition.connectivity.targetHandle
      : definition.connectivity.sourceHandle))
    .map((definition) => definition.type);
}
