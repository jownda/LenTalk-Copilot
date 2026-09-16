import { useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';

export interface MediaDimensions {
  width: number;
  height: number;
}

function isValidDimensions(width: number, height: number): boolean {
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
}

/** 读取媒体原始像素尺寸，不使用节点的 CSS 显示尺寸。 */
export function useImageDimensions(source: string | null | undefined): MediaDimensions | null {
  const [dimensions, setDimensions] = useState<MediaDimensions | null>(null);

  useEffect(() => {
    setDimensions(null);
    const normalizedSource = source?.trim();
    if (!normalizedSource) {
      return;
    }

    let disposed = false;
    const image = new Image();
    const applyDimensions = () => {
      if (!disposed && isValidDimensions(image.naturalWidth, image.naturalHeight)) {
        setDimensions({ width: image.naturalWidth, height: image.naturalHeight });
      }
    };
    image.onload = applyDimensions;
    image.src = normalizedSource;
    if (image.complete) {
      applyDimensions();
    }

    return () => {
      disposed = true;
      image.onload = null;
      image.onerror = null;
    };
  }, [source]);

  return dimensions;
}

export function formatMediaDimensions(dimensions: MediaDimensions | null): string | null {
  if (!dimensions) {
    return null;
  }
  return `${dimensions.width} × ${dimensions.height}px`;
}

/** 把字节数格式化成便于阅读的体积文本, 例如 `1.2 MB` / `356 KB`。 */
export function formatMediaByteSize(bytes: number | null | undefined): string | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) {
    return null;
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  // B 与 KB 不带小数, 更大的单位保留一位, 避免出现 `1024.0 KB` 这类冗余精度。
  const rounded = unitIndex <= 1 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unitIndex]}`;
}

/**
 * 读取媒体文件的存储体积。
 * 远程地址由 Rust 侧探测, 绕过前端 fetch 的 CORS 限制; 取不到时返回 null,
 * 由调用方决定只显示尺寸还是完全不显示。
 */
export function useMediaByteSize(source: string | null | undefined): number | null {
  const [bytes, setBytes] = useState<number | null>(null);

  useEffect(() => {
    setBytes(null);
    const normalizedSource = source?.trim();
    if (!normalizedSource || !isTauri()) {
      return;
    }

    let disposed = false;
    void invoke<number>('resolve_media_file_size', { source: normalizedSource })
      .then((value) => {
        if (!disposed && typeof value === 'number' && Number.isFinite(value) && value > 0) {
          setBytes(value);
        }
      })
      .catch(() => {
        // 体积只是附加信息, 探测失败时静默降级为只显示尺寸。
      });

    return () => {
      disposed = true;
    };
  }, [source]);

  return bytes;
}

/** 悬停意图延迟: 指针在节点上停留超过该时长才显示标注, 避免划过时闪烁。 */
export const HOVER_INTENT_DELAY_MS = 1500;

interface HoverIntentOptions {
  delayMs: number;
  onVisibilityChange: (visible: boolean) => void;
}

export interface HoverIntentController {
  readonly visible: boolean;
  /** 指针进入节点: 启动延迟计时, 到时才显示。 */
  enter(): void;
  /** 指针离开节点: 取消计时并立即隐藏。 */
  leave(): void;
  setDelayMs(delayMs: number): void;
  dispose(): void;
}

/**
 * 与框架无关的悬停意图计时器, 便于用假定时器单测。
 * 反复 enter 不会重置已显示状态, 但会重置未到时的计时。
 */
export function createHoverIntent({
  delayMs,
  onVisibilityChange,
}: HoverIntentOptions): HoverIntentController {
  let currentDelayMs = delayMs;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let visible = false;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const applyVisible = (next: boolean) => {
    if (visible === next) {
      return;
    }
    visible = next;
    onVisibilityChange(next);
  };

  return {
    get visible() {
      return visible;
    },
    enter() {
      clearTimer();
      if (visible) {
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        applyVisible(true);
      }, currentDelayMs);
    },
    leave() {
      clearTimer();
      applyVisible(false);
    },
    setDelayMs(nextDelayMs) {
      currentDelayMs = nextDelayMs;
    },
    dispose() {
      clearTimer();
    },
  };
}

export interface HoverIntent {
  visible: boolean;
  hoverProps: {
    onPointerEnter: () => void;
    onPointerLeave: () => void;
  };
}

/** 在节点根元素上展开 hoverProps, 即可获得延迟显示的悬停状态。 */
export function useHoverIntent(delayMs: number = HOVER_INTENT_DELAY_MS): HoverIntent {
  const [visible, setVisible] = useState(false);
  const [controller] = useState(() =>
    createHoverIntent({ delayMs, onVisibilityChange: setVisible })
  );

  useEffect(() => {
    controller.setDelayMs(delayMs);
  }, [controller, delayMs]);

  useEffect(() => () => controller.dispose(), [controller]);

  return {
    visible,
    hoverProps: {
      onPointerEnter: () => controller.enter(),
      onPointerLeave: () => controller.leave(),
    },
  };
}

interface MediaDimensionsLabelProps {
  dimensions: MediaDimensions | null;
  fileSize?: number | null;
  /** 悬停延迟到期后置为 true; 未悬停时保留占位但不可见, 以便淡入淡出。 */
  visible?: boolean;
  className?: string;
}

/**
 * 媒体信息标注: 尺寸与存储体积。
 * 定位在节点边框外侧(画面下方), 与右上角价格徽章一致 —— 悬浮、无底色、纯文字,
 * 因而不占用节点内部空间, 媒体画面可以铺满整个节点。
 * 默认隐藏, 由 `visible` 控制淡入, 配合 useHoverIntent 实现悬停延迟显示。
 */
export function MediaDimensionsLabel({
  dimensions,
  fileSize,
  visible = false,
  className = '',
}: MediaDimensionsLabelProps) {
  const parts = [formatMediaDimensions(dimensions), formatMediaByteSize(fileSize)].filter(
    (part): part is string => Boolean(part)
  );
  if (parts.length === 0) {
    return null;
  }

  return (
    <div
      aria-hidden={!visible}
      className={`pointer-events-none absolute top-full right-3 z-10 mt-1.5 whitespace-nowrap text-[14px] leading-none font-normal text-[rgba(15,23,42,0.68)] transition-opacity duration-200 ease-out dark:text-white/55 ${
        visible ? 'opacity-100' : 'opacity-0'
      } ${className}`}
    >
      {parts.join(' · ')}
    </div>
  );
}
