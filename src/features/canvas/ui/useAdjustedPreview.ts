import { useEffect, useRef, useState } from "react";

import type { MosaicLayerItem } from "@/features/canvas/domain/canvasNodes";
import type { MosaicAdjust } from "@/features/canvas/domain/mosaicAdjust";
import { isAdjustIdentity } from "@/features/canvas/domain/mosaicAdjust";
import {
  PREVIEW_DRAFT_MAX_EDGE,
  PREVIEW_MAX_EDGE,
  getAdjustedPreviewUrl,
} from "@/features/canvas/application/mosaicAdjust";
import { createLatestTaskQueue } from "@/features/canvas/application/latestTaskQueue";
import { resolveImageDisplayUrl } from "@/features/canvas/application/imageData";

interface AdjustRequest {
  source: string;
  adjust: MosaicAdjust;
  maxEdge: number;
}

/** 停手多久之后补一张清晰图。 */
const REFINE_DELAY_MS = 160;

/**
 * 带调整的图层预览地址。
 *
 * 两条规矩，都是为了让「拖的时候就在变」：
 *
 * 1. **不再防抖**：以前参数一变就重置 60ms 计时器，拖动期间计时器永远不到点，
 *    所以只有松手才更新。现在参数一变立刻算。
 * 2. **两档分辨率**：先算 320px 的草稿立刻显示（全开调整项也就 20ms 上下），
 *    停手 160ms 后再补一张 720px 的清晰图。草稿和清晰图走同一份像素实现，
 *    画面内容一致，只是清晰度不同。
 *
 * 算的过程中又来了新参数，只保留最新那份接着算（`createLatestTaskQueue`），
 * 所以每一帧都对应当前手指位置，不会越拖越落后。
 */
export function useAdjustedPreview(layer: Pick<MosaicLayerItem, "imageUrl" | "previewImageUrl" | "adjust">): string {
  // 🔴 必须先解析成可加载的地址（本地路径 → asset://），否则 `new Image()` 根本取不到图，
  // 调整永远算不出来，表现就是「拉滑块没反应」。
  const source = resolveImageDisplayUrl(layer.previewImageUrl || layer.imageUrl);
  const adjust = layer.adjust;
  const active = Boolean(adjust) && !isAdjustIdentity(adjust);
  const key = active ? JSON.stringify(adjust) : "";

  const [url, setUrl] = useState(source);
  const aliveRef = useRef(true);
  const queueRef = useRef<ReturnType<typeof createLatestTaskQueue<AdjustRequest>> | null>(null);

  if (!queueRef.current) {
    queueRef.current = createLatestTaskQueue<AdjustRequest>(async (task) => {
      const next = await getAdjustedPreviewUrl(task.source, task.adjust, task.maxEdge);
      if (aliveRef.current) setUrl(next);
    });
  }

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      queueRef.current?.clear();
    };
  }, []);

  useEffect(() => {
    if (!active || !adjust) {
      queueRef.current?.clear();
      setUrl(source);
      return;
    }
    // 立刻出草稿：拖到哪里，画面就是哪里。
    queueRef.current?.push({ source, adjust, maxEdge: PREVIEW_DRAFT_MAX_EDGE });
    // 停手后补清晰图。计时器只作用于「补清晰」，不影响上面的实时草稿。
    const timer = window.setTimeout(() => {
      queueRef.current?.push({ source, adjust, maxEdge: PREVIEW_MAX_EDGE });
    }, REFINE_DELAY_MS);
    return () => window.clearTimeout(timer);
    // key 已经把参数压成字符串，不需要再依赖 adjust 的对象身份
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, source, active]);

  return url;
}
