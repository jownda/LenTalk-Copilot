import {
  CANVAS_NODE_TYPES,
  type CanvasNodeData,
  type CanvasNodeType,
  type ExportImageNodeResultKind,
} from './canvasNodes';

export const DEFAULT_NODE_DISPLAY_NAME: Record<CanvasNodeType, string> = {
  [CANVAS_NODE_TYPES.upload]: '本地上传',
  [CANVAS_NODE_TYPES.imageEdit]: 'AI 图片',
  [CANVAS_NODE_TYPES.videoGen]: 'AI 视频',
  [CANVAS_NODE_TYPES.exportImage]: '结果图片',
  [CANVAS_NODE_TYPES.textAnnotation]: '文本',
  [CANVAS_NODE_TYPES.group]: '分组',
  [CANVAS_NODE_TYPES.storyboardSplit]: '切割结果',
  [CANVAS_NODE_TYPES.storyboardGen]: '分镜生成',
  [CANVAS_NODE_TYPES.panorama]: '360 全景',
  [CANVAS_NODE_TYPES.directorDesk]: '3D 导演台',
  [CANVAS_NODE_TYPES.cinematicStudio]: '提示词工作室',
  [CANVAS_NODE_TYPES.promptOptimizer]: '提示词优化',
  [CANVAS_NODE_TYPES.audio]: '媒体',
  [CANVAS_NODE_TYPES.audioGen]: 'AI 音频',
  [CANVAS_NODE_TYPES.motionControl]: '动作控制 / 对口型',
  [CANVAS_NODE_TYPES.runningHubWorkflow]: 'RunningHub 工作流',
  [CANVAS_NODE_TYPES.seamlessMosaic]: '无缝拼图',
};

/**
 * 「角色替换」模式的默认标题。
 *
 * 动作控制节点有三个模式，但共用一个节点类型；默认标题还停在「动作控制 / 对口型」
 * 时（用户没自己改过名字），切到角色替换就跟着换，免得标题与面板内容对不上。
 */
export const MOTION_CONTROL_SWAP_DISPLAY_NAME = '角色替换';

export const EXPORT_RESULT_DISPLAY_NAME: Record<ExportImageNodeResultKind, string> = {
  generic: '结果图片',
  storyboardGenOutput: '分镜输出',
  storyboardSplitExport: '切割导出',
  storyboardFrameEdit: '分镜帧',
};

function resolveExportResultDefault(data: Partial<CanvasNodeData>): string {
  const resultKind = (data as { resultKind?: ExportImageNodeResultKind }).resultKind ?? 'generic';
  return EXPORT_RESULT_DISPLAY_NAME[resultKind];
}

export function getDefaultNodeDisplayName(type: CanvasNodeType, data: Partial<CanvasNodeData>): string {
  if (type === CANVAS_NODE_TYPES.exportImage) {
    return resolveExportResultDefault(data);
  }
  return DEFAULT_NODE_DISPLAY_NAME[type];
}

export function resolveNodeDisplayName(type: CanvasNodeType, data: Partial<CanvasNodeData>): string {
  const customTitle = typeof data.displayName === 'string' ? data.displayName.trim() : '';
  if (customTitle) {
    // Older projects persisted the former default as displayName. Treat only
    // that exact legacy value as a default so user-customized titles remain intact.
    if (
      type === CANVAS_NODE_TYPES.cinematicStudio &&
      (customTitle === '电影提示词工作室' || customTitle === 'Cinematic Prompt Studio')
    ) {
      return DEFAULT_NODE_DISPLAY_NAME[type];
    }
    if (
      type === CANVAS_NODE_TYPES.upload &&
      (customTitle === '上传图片' || customTitle === 'Upload Image')
    ) {
      return DEFAULT_NODE_DISPLAY_NAME[type];
    }
    return customTitle;
  }

  if (type === CANVAS_NODE_TYPES.group) {
    const legacyLabel = typeof (data as { label?: string }).label === 'string'
      ? (data as { label?: string }).label?.trim()
      : '';
    if (legacyLabel) {
      return legacyLabel;
    }
  }

  return getDefaultNodeDisplayName(type, data);
}

export function isNodeUsingDefaultDisplayName(type: CanvasNodeType, data: Partial<CanvasNodeData>): boolean {
  const customTitle = typeof data.displayName === 'string' ? data.displayName.trim() : '';
  if (!customTitle) {
    return true;
  }
  return customTitle === getDefaultNodeDisplayName(type, data);
}
