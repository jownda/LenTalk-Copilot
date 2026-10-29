import {
  isAudioNode,
  isDirectorDeskNode,
  isExportImageNode,
  isImageEditNode,
  isPanoramaNode,
  isSeamlessMosaicNode,
  isStoryboardGenNode,
  isStoryboardSplitNode,
  isUploadNode,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';

export type CanvasMediaKind = 'image' | 'video';

/** 画布媒体节点索引项(节点管理工具栏的一行)。 */
export interface CanvasMediaEntry {
  nodeId: string;
  /** React Flow 的节点类型 key, UI 回退显示名时会用到。 */
  nodeType: string;
  kind: CanvasMediaKind;
  /** 列表里的小图; 视频取封面帧, 没有封面时为 null(UI 显示占位图标)。 */
  thumbnailUrl: string | null;
  /** 放大预览的主资源: 图片是原图, 视频是源文件路径。 */
  previewUrl: string | null;
  /** 同一节点内的多张图(分镜/全景等), 供预览弹窗翻页。 */
  previewList: string[];
  /** 节点展示名, 为空时由 UI 回退到节点类型名。 */
  displayName: string;
  /**
   * 所属分组节点的 id（React Flow 的 `parentId`）；不在任何组里时为 null。
   *
   * 侧栏按它把条目归到画布上的分组节点下面 —— 分组是**画布本来的结构**，
   * 不再另造一套「文件夹」，否则同一张图会有两个归属。
   */
  parentId: string | null;
}

function pickText(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function uniqueUrls(values: Array<string | null | undefined>): string[] {
  const result: string[] = [];
  for (const value of values) {
    const text = pickText(value);
    if (text && !result.includes(text)) {
      result.push(text);
    }
  }
  return result;
}

function createEntry(
  node: CanvasNode,
  input: Omit<CanvasMediaEntry, 'nodeId' | 'nodeType' | 'parentId'>,
): CanvasMediaEntry {
  return {
    nodeId: node.id,
    nodeType: typeof node.type === 'string' ? node.type : '',
    // 组内节点的 `parentId` 指向分组节点；顶层节点没有这个字段。
    parentId: typeof node.parentId === 'string' && node.parentId.trim() ? node.parentId : null,
    ...input,
  };
}

/**
 * 把一个画布节点解析成媒体索引项; 不含图像/视频产物的节点返回 null。
 *
 * 覆盖: 上传图 / AI 图片 / 导出结果图 / 分镜生成 / 分镜拆分(多帧) /
 * 全景(输出优先, 退输入) / 无缝拼图输出 / 导演台截图 / 媒体节点中的视频。
 * 纯音频节点不纳入(它没有可预览的视觉内容)。
 */
function resolveMediaEntry(node: CanvasNode): CanvasMediaEntry | null {
  if (
    isUploadNode(node)
    || isImageEditNode(node)
    || isExportImageNode(node)
    || isStoryboardGenNode(node)
  ) {
    const imageUrl = pickText(node.data.imageUrl);
    if (!imageUrl) {
      return null;
    }
    return createEntry(node, {
      kind: 'image',
      thumbnailUrl: pickText(node.data.previewImageUrl, imageUrl),
      previewUrl: imageUrl,
      previewList: [imageUrl],
      displayName: pickText(node.data.displayName) ?? '',
    });
  }

  if (isStoryboardSplitNode(node)) {
    const frames = node.data.frames ?? [];
    const previewList = uniqueUrls(frames.map((frame) => frame.imageUrl));
    if (previewList.length === 0) {
      return null;
    }
    return createEntry(node, {
      kind: 'image',
      thumbnailUrl: pickText(
        frames[0]?.previewImageUrl,
        frames[0]?.imageUrl,
        previewList[0],
      ),
      previewUrl: previewList[0],
      previewList,
      displayName: pickText(node.data.displayName) ?? '',
    });
  }

  if (isPanoramaNode(node)) {
    const previewList = uniqueUrls([node.data.outputImageUrl, node.data.inputImageUrl]);
    if (previewList.length === 0) {
      return null;
    }
    return createEntry(node, {
      kind: 'image',
      thumbnailUrl: pickText(
        node.data.outputPreviewImageUrl,
        node.data.previewInputImageUrl,
        node.data.outputImageUrl,
        node.data.inputImageUrl,
      ),
      previewUrl: previewList[0],
      previewList,
      displayName: pickText(node.data.displayName) ?? '',
    });
  }

  if (isSeamlessMosaicNode(node)) {
    const outputImageUrl = pickText(node.data.outputImageUrl);
    if (!outputImageUrl) {
      return null;
    }
    return createEntry(node, {
      kind: 'image',
      thumbnailUrl: pickText(node.data.outputPreviewImageUrl, outputImageUrl),
      previewUrl: outputImageUrl,
      previewList: [outputImageUrl],
      displayName: pickText(node.data.displayName) ?? '',
    });
  }

  if (isDirectorDeskNode(node)) {
    const captureUrl = pickText(node.data.lastCaptureUrl);
    if (!captureUrl) {
      return null;
    }
    return createEntry(node, {
      kind: 'image',
      thumbnailUrl: pickText(node.data.lastCapturePreviewUrl, captureUrl),
      previewUrl: captureUrl,
      previewList: [captureUrl],
      displayName: pickText(node.data.displayName) ?? '',
    });
  }

  if (isAudioNode(node)) {
    // 媒体节点同时承载音频与视频, 这里只收视频(音频没有可放大预览的画面)。
    if (node.data.mediaType !== 'video') {
      return null;
    }
    const sourcePath = pickText(node.data.sourcePath);
    if (!sourcePath) {
      return null;
    }
    return createEntry(node, {
      kind: 'video',
      thumbnailUrl: pickText(node.data.previewImageUrl),
      previewUrl: sourcePath,
      previewList: [sourcePath],
      displayName: pickText(node.data.displayName) ?? '',
    });
  }

  return null;
}

/**
 * 收集画布里的媒体节点, **倒序**返回(最后创建的排最前)。
 *
 * 节点数组按创建顺序追加(`addNode` 永远 push 到尾部), 节点本身上又没有可靠的
 * 时间戳字段, 所以创建顺序是唯一可用的「新鲜度」信号 —— 倒过来正好等于
 * 「最新生成的排最上面」, 新出的图 / 视频一眼就能在侧栏顶部看到。
 */
export function collectCanvasMediaEntries(
  nodes: readonly CanvasNode[],
): CanvasMediaEntry[] {
  const entries: CanvasMediaEntry[] = [];
  for (const node of nodes) {
    const entry = resolveMediaEntry(node);
    if (entry) {
      entries.push(entry);
    }
  }
  return entries.reverse();
}

/** 侧栏的一节（一个画布分组，或末尾的「未分组」）。 */
export interface NodeManagerSection {
  id: string;
  label: string;
  entries: CanvasMediaEntry[];
}

/** 「未分组」这一节的固定 id（真实分组 id 不会与它冲突）。 */
export const NODE_MANAGER_UNGROUPED_SECTION_ID = '__ungrouped__';

/**
 * 把条目按画布分组归节。
 *
 * 三条规则，都是踩过的坑：
 * 1. **`parentId` 指向已删分组的条目要落回「未分组」** —— 直接按 id 分组会让它整条消失，
 *    用户会以为节点丢了；
 * 2. **空分组不出现**（画布上一堆空组会把真正的产物挤到看不见的地方）；
 * 3. **「未分组」永远排在最后**，且只在有内容时出现。
 */
export function buildNodeManagerSections(
  entries: readonly CanvasMediaEntry[],
  groups: ReadonlyArray<{ id: string; label: string }>,
  ungroupedLabel: string,
): NodeManagerSection[] {
  const knownGroupIds = new Set(groups.map((group) => group.id));
  const byGroup = new Map<string, CanvasMediaEntry[]>();
  const ungrouped: CanvasMediaEntry[] = [];

  for (const entry of entries) {
    if (entry.parentId && knownGroupIds.has(entry.parentId)) {
      const list = byGroup.get(entry.parentId);
      if (list) {
        list.push(entry);
      } else {
        byGroup.set(entry.parentId, [entry]);
      }
    } else {
      ungrouped.push(entry);
    }
  }

  const sections: NodeManagerSection[] = [];
  for (const group of groups) {
    const groupEntries = byGroup.get(group.id);
    if (groupEntries?.length) {
      sections.push({ id: group.id, label: group.label, entries: groupEntries });
    }
  }
  if (ungrouped.length) {
    sections.push({
      id: NODE_MANAGER_UNGROUPED_SECTION_ID,
      label: ungroupedLabel,
      entries: ungrouped,
    });
  }
  return sections;
}
