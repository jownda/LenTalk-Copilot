import { useEffect } from 'react';

import { RHTV_CANVAS_PROVIDER_ID } from '@/features/canvas/models/registry';
import {
  ensureRhtvSpec,
  useRhtvCatalogRevision,
  type RhtvCatalogKind,
} from '@/features/canvas/models/rhtvCatalog';

const PREFIX = `${RHTV_CANVAS_PROVIDER_ID}/`;

/**
 * 画布模型被选中时补齐它的参数清单，并返回目录版本号用于触发重渲染。
 *
 * 节点面板的比例/分辨率/时长档位直接来自 schema（各模型取值差别很大，写死一份会被
 * 服务端拒绝）。schema 大约 2 秒到，所以这里返回 revision：拉到之后组件重算，下拉里
 * 的档位从"保守兜底"换成"该模型真实支持的"。
 */
export function useRhtvModelSpec(
  modelId: string | null | undefined,
  kind: RhtvCatalogKind,
): number {
  const revision = useRhtvCatalogRevision();

  useEffect(() => {
    if (!modelId || !modelId.startsWith(PREFIX)) return;
    void ensureRhtvSpec(modelId.slice(PREFIX.length), kind);
    // 依赖 revision：节点可能先于目录加载被打开（那时还没有登录态），目录到位后要重试。
    // ensureRhtvSpec 自带缓存与去重，重复调用是幂等的。
  }, [modelId, kind, revision]);

  return revision;
}
