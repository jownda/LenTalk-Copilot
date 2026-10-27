import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { AudioLines, Image as ImageIcon, Music2, Video, X } from 'lucide-react';

import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import type { LibraryAsset } from './types';

export interface AssetPreviewDialogProps {
  /** 为 null 时不渲染 —— 只负责「放大查看」, 插入画布一律走拖拽。 */
  asset: LibraryAsset | null;
  onClose: () => void;
}

const MEDIA_LABEL: Record<LibraryAsset['mediaType'], { text: string; icon: typeof ImageIcon }> = {
  image: { text: '图片', icon: ImageIcon },
  video: { text: '视频', icon: Video },
  audio: { text: '音频', icon: Music2 },
};

/**
 * 素材库 · 单击放大查看。
 *
 * 刻意**不是全屏看图器**: 它是一个居中的卡片(最大 76vw × 76vh), 四周留出画布,
 * 这样「看一眼大图」不会把整个工作区盖住, 也不需要退出全屏才能继续。
 * 播放入口也收在同一张卡片里(视频 / 音频直接给原生控件), 不另开播放器窗口。
 *
 * 需要全屏写实看图(缩放 / 平移 / 全景)时仍走画布节点上的 ImageViewerModal ——
 * 那是另一个入口, 两边不冲突。
 */
export function AssetPreviewDialog({ asset, onClose }: AssetPreviewDialogProps) {
  const { t } = useTranslation();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    if (!asset) {
      setIsReady(false);
      return;
    }
    // 下一帧再淡入, 避免打开瞬间闪一下白底/黑块
    const frame = window.requestAnimationFrame(() => setIsReady(true));
    return () => window.cancelAnimationFrame(frame);
  }, [asset]);

  useEffect(() => {
    if (!asset) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [asset, onClose]);

  if (!asset) return null;

  const meta = MEDIA_LABEL[asset.mediaType];
  const Icon = meta.icon;
  const displayUrl = resolveImageDisplayUrl(asset.previewImageUrl || asset.sourcePath);
  const playableUrl = resolveImageDisplayUrl(asset.sourcePath);

  return createPortal(
    <div
      className={`fixed inset-0 z-[210] flex items-center justify-center bg-black/55 p-6 backdrop-blur-[2px] transition-opacity duration-150 ${isReady ? 'opacity-100' : 'opacity-0'}`}
      onMouseDown={(event) => {
        // 只在点到遮罩本身时关闭; 点卡片内部(含图片拖拽起手)不关
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={asset.name}
        className={`flex max-h-[76vh] w-fit max-w-[76vw] min-w-[280px] flex-col overflow-hidden rounded-xl border border-border-dark bg-surface-dark shadow-2xl transition-transform duration-150 ${isReady ? 'scale-100' : 'scale-[0.98]'}`}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-border-dark px-3 py-2">
          <Icon className="h-3.5 w-3.5 shrink-0 text-text-muted" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-text-dark" title={asset.name}>
            {asset.name}
          </span>
          <span className="shrink-0 rounded border border-border-dark px-1.5 py-0.5 text-[10px] text-text-muted">
            {t(`assetLibrary.mediaType.${asset.mediaType}`, meta.text)}
          </span>
          <button
            type="button"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark"
            title={t('common.close', '关闭')}
            onClick={onClose}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 items-center justify-center bg-black/35 p-2">
          {asset.mediaType === 'image' ? (
            <img
              src={displayUrl}
              alt={asset.name}
              // 不铺满: 长边最多 62vh, 窄图不会被放大到糊
              className="max-h-[62vh] max-w-full object-contain"
              draggable={false}
            />
          ) : asset.mediaType === 'video' ? (
            <video
              src={playableUrl}
              controls
              autoPlay
              loop
              playsInline
              preload="metadata"
              className="max-h-[62vh] max-w-full rounded-md bg-black"
            />
          ) : (
            <div className="flex w-[320px] max-w-full flex-col items-center gap-3 rounded-lg bg-gradient-to-br from-amber-500/20 to-rose-500/10 px-5 py-6">
              <AudioLines className="h-9 w-9 text-amber-200" />
              <audio src={playableUrl} controls preload="metadata" className="w-full" />
            </div>
          )}
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border-dark px-3 py-1.5">
          <span className="truncate text-[10px] text-text-muted" title={asset.sourcePath}>
            {asset.sourcePath}
          </span>
          <span className="shrink-0 text-[10px] text-text-muted">
            {t('assetLibrary.dragToCanvasHint', '按住拖到画布即可插入')}
          </span>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
