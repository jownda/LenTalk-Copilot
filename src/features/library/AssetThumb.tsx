import { memo, useEffect, useRef, useState } from "react";

import type { LibraryAsset } from "@/features/library/assetStore";
import {
  THUMBNAIL_MAX_EDGE,
  readThumbnail,
  requestThumbnail,
  resolveFallbackSource,
} from "@/features/canvas/application/thumbnailCache";

/**
 * 素材卡片缩略图：**进视口才加载，且优先用 256 缩略图**。
 *
 * 为什么必须这样做（本机实测数据）：素材库 209 条记录、`asset-library` 这个 JSON 已经
 * 7.79 MB，其中 47% 是内嵌 base64 预览图；剩下的记录里 `previewImageUrl` 多数直接指向原图
 * （单张常见 4~10 MB）。面板一次性把 209 张卡片全渲染出来，等于同一帧里发起几百个
 * 读盘 + 解码请求 —— 打开素材库卡几秒，就是这一步。
 *
 * 三道限制：
 * 1. `IntersectionObserver` 划定「滚到附近才加载」（提前 240px），首屏只处理可见的十几张；
 * 2. 本地文件走 `thumbnailCache` 的 256 档，尺寸降两个量级，且带并发闸门与内存缓存；
 * 3. `data:` 内嵌图直接用（无法再缩，但至少不再于挂载时就解码）。
 *
 * 🔴 `root` 必须取**内部的滚动容器**：面板是覆盖在画布上的浮层，卡片滚出面板可视区后
 * 仍在 viewport 内，用默认 root 会被判成「可见」→ 等于没懒加载。
 */
export const AssetThumb = memo(function AssetThumb({ asset }: { asset: LibraryAsset }) {
  const holderRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  const [src, setSrc] = useState<string | null>(null);

  // 1) 滚到附近才激活。
  useEffect(() => {
    const element = holderRef.current;
    if (!element || active) return;
    if (typeof IntersectionObserver === "undefined") {
      setActive(true);
      return;
    }
    // `closest` 而不是固定 ref：素材库有两个滚动区（网格 / 全屏模式），传进来会更麻烦。
    const scrollRoot = element.closest("[data-asset-scroll-root]");
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setActive(true);
          observer.disconnect();
        }
      },
      { root: scrollRoot instanceof Element ? scrollRoot : null, rootMargin: "240px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [active]);

  // 2) 激活后取图。
  useEffect(() => {
    if (!active) return;
    const raw = asset.previewImageUrl || asset.sourcePath;
    if (!raw) return;
    // base64 内嵌图没有「更小的版本」可用，只能直接用。
    if (raw.startsWith("data:")) {
      setSrc(raw);
      return;
    }
    // 内存缓存命中时同步拿，滚动回看不会闪。
    const cached = readThumbnail(raw, THUMBNAIL_MAX_EDGE);
    if (cached) {
      setSrc(cached);
      return;
    }
    let cancelled = false;
    void requestThumbnail(raw, THUMBNAIL_MAX_EDGE).then((next) => {
      if (cancelled) return;
      // 生成失败时回落原图（此时才可能吃到一次大图，但只会发生在异常素材上）。
      setSrc(next ?? resolveFallbackSource(raw));
    });
    return () => {
      cancelled = true;
    };
  }, [active, asset.previewImageUrl, asset.sourcePath]);

  return (
    <div ref={holderRef} className="h-full w-full">
      {src ? (
        <img src={src} alt={asset.name} className="h-full w-full object-cover" draggable={false} />
      ) : (
        // 占位与卡片同色，滚动时不会出现一格格白闪。
        <div className="h-full w-full animate-pulse bg-white/[0.05]" aria-hidden />
      )}
    </div>
  );
});
