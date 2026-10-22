import { useEffect, useRef, useState } from "react";

import {
  canGenerateThumbnail,
  readThumbnail,
  requestThumbnails,
} from "@/features/canvas/application/thumbnailCache";

/** 把新解析出来的结果并进已有 Map；没有实际变化时返回原对象，避免无谓重渲染。 */
function mergeThumbnails(
  current: Map<string, string>,
  incoming: Map<string, string>,
): Map<string, string> {
  let changed = false;
  for (const [source, url] of incoming) {
    if (current.get(source) !== url) {
      changed = true;
      break;
    }
  }
  if (!changed) return current;
  const next = new Map(current);
  for (const [source, url] of incoming) next.set(source, url);
  return next;
}

/**
 * 为一组源地址准备缩略图，返回「源地址 → 小图地址」。
 *
 * 值可能是空串，含义是「这张图确认生成不了，请用原图」—— 卡片据此判断该停止占位动画。
 * 没出现在 Map 里的源地址才是「还在生成中」。
 *
 * 只处理当前真正要渲染的那批（卡片里的 `visibleItems`），所以滚动补批时会自然带上
 * 新一批的请求；已经生成过的走同步命中，不会重复走 IPC。
 *
 * `sourcesKey` 只是依赖标识：源数组每次渲染都是新引用，用内容拼串当依赖才能让
 * effect 只在候选集合真的变化时触发。
 */
export function useAssetThumbnails(
  sources: readonly string[],
  enabled: boolean,
): Map<string, string> {
  const sourcesRef = useRef<readonly string[]>(sources);
  sourcesRef.current = sources;
  const sourcesKey = sources.join("\n");

  const [thumbnails, setThumbnails] = useState<Map<string, string>>(() => {
    const initial = new Map<string, string>();
    for (const source of sources) {
      const cached = readThumbnail(source);
      if (cached) initial.set(source, cached);
    }
    return initial;
  });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    // 先在同步阶段收拢所有已就绪的（含上一次缓存下来的），只把缺失的排进队列。
    const ready = new Map<string, string>();
    const missing: string[] = [];
    for (const source of sourcesRef.current) {
      const cached = readThumbnail(source);
      if (cached) ready.set(source, cached);
      else if (canGenerateThumbnail(source)) missing.push(source);
    }
    if (ready.size) setThumbnails((current) => mergeThumbnails(current, ready));
    if (!missing.length) return;

    void requestThumbnails(missing).then((resolved) => {
      if (cancelled || resolved.size === 0) return;
      setThumbnails((current) => mergeThumbnails(current, resolved));
    });

    return () => {
      cancelled = true;
    };
  }, [enabled, sourcesKey]);

  return thumbnails;
}
