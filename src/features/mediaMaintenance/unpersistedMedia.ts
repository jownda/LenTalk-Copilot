import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { isDetachedLocalMediaSource } from '@/features/canvas/application/mediaPersistence';
import { isDownloadableRemoteSource, listLocalizableMediaSources } from './localizeMedia';

/**
 * 画布上「还没落盘」的媒体扫描。
 *
 * 存在的理由：生成侧的落盘失败是**静默**的（`mediaPersistence.ts` 只 warn 一句就退回
 * 远端 URL），用户在界面上完全看不出这条素材其实还挂在平台的临时链接上 —— 链接一断，
 * 表现就是「前几天还好好的视频，今天变成裂图」。这个模块只负责把这种情况找出来，
 * 修不修由用户决定。
 *
 * 三类都算「未落盘」：
 * - `remote`：`http(s)://` 的平台临时链接（会过期）；
 * - `remote`：寄居在 `%APPDATA%\...\jimeng-cli\videos\<run_id>\` 里的本地文件
 *   （不会过期，但清缓存 / 重装 / 换机就整批丢，同样要搬出来）；
 * - `inline`：够大的 `data:` 内联 base64（不会裂，但会撑大工程、拖慢打开）。
 */

export type UnpersistedMediaKind = 'remote' | 'inline';

export interface UnpersistedMediaHit {
  nodeId: string;
  nodeLabel: string;
  /** 字段名（数组带下标）。 */
  key: string;
  source: string;
  kind: UnpersistedMediaKind;
}

/** 节点在提示里怎么称呼自己：优先用户填的标题，其次节点类型。 */
function describeNode(node: CanvasNode): string {
  const data = (node.data ?? {}) as Record<string, unknown>;
  for (const key of ['label', 'title', 'name']) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim().slice(0, 24);
    }
  }
  const prompt = data.prompt;
  if (typeof prompt === 'string' && prompt.trim()) {
    return prompt.trim().replace(/\s+/g, ' ').slice(0, 24);
  }
  return String(node.type ?? '节点');
}

/** 扫描一批节点，返回所有需要落盘的媒体引用（按节点顺序，未去重）。 */
export function collectUnpersistedMedia(nodes: readonly CanvasNode[]): UnpersistedMediaHit[] {
  const hits: UnpersistedMediaHit[] = [];
  for (const node of nodes) {
    for (const entry of listLocalizableMediaSources(node.data)) {
      hits.push({
        nodeId: node.id,
        nodeLabel: describeNode(node),
        key: entry.key,
        source: entry.source,
        kind:
          isDownloadableRemoteSource(entry.source) || isDetachedLocalMediaSource(entry.source)
            ? 'remote'
            : 'inline',
      });
    }
  }
  return hits;
}

export interface UnpersistedMediaSummary {
  /** 去重后的来源条数（同一条链接挂在多个节点上只算一次）。 */
  total: number;
  remote: number;
  inline: number;
  /** 涉及的节点数。 */
  nodes: number;
  /** 只在「有远端链接」的节点数 —— 提示条只报这一类，所以要单独一个计数。 */
  remoteNodes: number;
}

export function summarizeUnpersistedMedia(
  hits: readonly UnpersistedMediaHit[],
): UnpersistedMediaSummary {
  const sources = new Set<string>();
  const nodeIds = new Set<string>();
  const remoteNodeIds = new Set<string>();
  let remote = 0;
  let inline = 0;
  for (const hit of hits) {
    nodeIds.add(hit.nodeId);
    if (hit.kind === 'remote') remoteNodeIds.add(hit.nodeId);
    if (sources.has(hit.source)) continue;
    sources.add(hit.source);
    if (hit.kind === 'remote') remote += 1;
    else inline += 1;
  }
  return { total: sources.size, remote, inline, nodes: nodeIds.size, remoteNodes: remoteNodeIds.size };
}
