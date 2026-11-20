import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import type { CanvasNode } from '@/stores/canvasStore';

/**
 * 上游连进来的一条音频素材 —— 用于在节点上显示「我到底收到了什么」。
 *
 * 视频节点早就有这条展示（引用素材条），音频节点一直没有：上游连了音频后界面上
 * 一个字都看不到，既不知道连上没有，也没法试听确认是哪一个。
 */
export interface UpstreamAudioTile {
  /** 音频地址（与提交链路拿到的同一个字符串，方便直接送去试听） */
  source: string;
  /** 展示名：优先节点标题，其次文件名 */
  label: string;
  /**
   * Suno 平台内的 clip id（只有 Suno 生成的结果节点上才有）。
   *
   * empty = 普通音频文件。Suno 的续写/翻唱/分离/出片只接受 `*_clip_id`；
   * 普通音频只能用「上传翻唱」（`upload_cover`，吃这条 `source`，提交前换公网直链）。
   * 界面上必须把这两类区分开，否则用户会一直以为「连上了就能翻唱」。
   */
  clipId: string;
}

/** 节点默认标题，没有区分度，视同未命名。 */
const DEFAULT_MEDIA_NAMES = new Set(['媒体', 'Media', 'media', '音频', 'audio', 'Audio']);

/** 从路径 / URL 里取一个能认出来的名字（去掉目录、扩展名和查询串）。 */
export function audioSourceLabel(source: string): string {
  const withoutQuery = source.split(/[?#]/)[0] ?? source;
  const base = withoutQuery.split(/[\\/]/).pop() ?? '';
  const withoutExt = base.replace(/\.[a-z0-9]{1,5}$/i, '');
  return withoutExt.trim();
}

/**
 * 把 `collectInputAudio` 拿到的地址列表，配上「哪个节点给的 / 有没有 clip id」。
 *
 * 只扫音频节点：`graphImageResolver.extractAudio` 的实际来源就是媒体节点(音频)的
 * `sourcePath`，两边必须用同一判据，否则会出现「显示了一条但提交时没有」。
 */
export function buildUpstreamAudioTiles(
  sources: string[],
  nodes: CanvasNode[],
): UpstreamAudioTile[] {
  const metaBySource = new Map<string, { label: string; clipId: string }>();
  for (const node of nodes) {
    if (node.type !== CANVAS_NODE_TYPES.audio) continue;
    const data = node.data as Record<string, unknown>;
    const path = typeof data.sourcePath === 'string' ? data.sourcePath.trim() : '';
    if (!path || metaBySource.has(path)) continue;
    const rawName = typeof data.displayName === 'string' ? data.displayName.trim() : '';
    const named = rawName && !DEFAULT_MEDIA_NAMES.has(rawName) ? rawName : '';
    const clipId = typeof data.sunoResultClipId === 'string' ? data.sunoResultClipId.trim() : '';
    metaBySource.set(path, { label: named, clipId });
  }

  return sources.map((source, index) => {
    const meta = metaBySource.get(source);
    const label = meta?.label || audioSourceLabel(source) || `音频${index + 1}`;
    return { source, label, clipId: meta?.clipId ?? '' };
  });
}
