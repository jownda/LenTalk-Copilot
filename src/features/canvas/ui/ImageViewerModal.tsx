import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Library, RotateCcw, X } from 'lucide-react';
import { Orbit } from 'lucide-react';
import { UI_CONTENT_OVERLAY_INSET_CLASS } from '@/components/ui/motion';
import { useImageViewerTransform } from '../hooks/useImageViewerTransform';
import { PanoramaViewer } from './PanoramaViewer';
import { useAssetLibraryStore } from '@/features/library/assetStore';
import { importImageUrlToAsset } from '@/features/library/importAssets';

export interface ImageViewerModalProps {
  open: boolean;
  imageUrl: string;
  imageList: string[];
  currentIndex: number;
  onClose: () => void;
  onNavigate: (direction: 'prev' | 'next') => void;
}

export function ImageViewerModal({
  open,
  imageUrl,
  imageList,
  currentIndex,
  onClose,
  onNavigate,
}: ImageViewerModalProps): JSX.Element | null {
  const { t } = useTranslation();
  const viewerControlClass =
    'inline-flex h-10 items-center justify-center rounded-full border border-white/20 bg-black/60 px-4 text-sm text-white backdrop-blur-xl';
  const [isVisible, setIsVisible] = useState(false);
  const [overlayOpacity, setOverlayOpacity] = useState(0);
  const [displayImageUrl, setDisplayImageUrl] = useState(imageUrl);
  const [isPanoramaMode, setIsPanoramaMode] = useState(false);
  const closeTimerRef = useRef<number | null>(null);

  // 添加到素材库
  const libraries = useAssetLibraryStore((state) => state.libraries);
  const categories = useAssetLibraryStore((state) => state.categories);
  const activeLibraryId = useAssetLibraryStore((state) => state.activeLibraryId);
  const addAssets = useAssetLibraryStore((state) => state.addAssets);
  const [isAddToLibraryOpen, setIsAddToLibraryOpen] = useState(false);
  const [isSavingToLibrary, setIsSavingToLibrary] = useState(false);
  const [saveResult, setSaveResult] = useState<'ok' | 'fail' | null>(null);

  const handleAddToLibrary = useCallback(async (categoryId: string | null) => {
    if (!displayImageUrl || isSavingToLibrary) return;
    const libraryId = activeLibraryId || libraries[0]?.id;
    if (!libraryId) return;
    setIsSavingToLibrary(true);
    setSaveResult(null);
    try {
      const asset = await importImageUrlToAsset(displayImageUrl, libraryId, categoryId);
      if (asset) {
        addAssets([asset]);
        setSaveResult('ok');
      } else {
        setSaveResult('fail');
      }
    } catch {
      setSaveResult('fail');
    } finally {
      setIsSavingToLibrary(false);
    }
  }, [activeLibraryId, addAssets, displayImageUrl, isSavingToLibrary, libraries]);

  const saveTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (saveResult === null) return;
    saveTimerRef.current = window.setTimeout(() => {
      setSaveResult(null);
      setIsAddToLibraryOpen(false);
    }, 1500);
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [saveResult]);

  const {
    containerRef,
    imageRef,
    scaleDisplayRef,
    viewerOpacity,
    resetView,
    handleImageMouseDown,
    handleContainerMouseMove,
    handleContainerMouseUp,
    handleImageMouseMove,
    handleImageLoad,
    isPointOnImageContent,
  } = useImageViewerTransform(open && isVisible);

  useEffect(() => {
    if (!isVisible) return;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, [isVisible]);

  useEffect(() => {
    if (open) {
      setDisplayImageUrl(imageUrl);
      setIsPanoramaMode(false);
      setIsVisible(true);
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      setOverlayOpacity(0);
      requestAnimationFrame(() => {
        setOverlayOpacity(1);
      });
      return;
    }
    if (!isVisible) return;
    setOverlayOpacity(0);
    setIsPanoramaMode(false);
    closeTimerRef.current = window.setTimeout(() => {
      setIsVisible(false);
      setDisplayImageUrl('');
    }, 400);
    return () => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
  }, [open, isVisible]);

  useEffect(() => {
    if (!open || !imageUrl) {
      return;
    }
    setDisplayImageUrl(imageUrl);
  }, [open, imageUrl]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    resetView();
  }, [open, imageUrl, resetView]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        onNavigate('prev');
      } else if (e.key === 'ArrowRight') {
        onNavigate('next');
      } else if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onNavigate, onClose]);

  if (!isVisible) return null;

  if (isPanoramaMode && displayImageUrl) {
    return (
      <PanoramaViewer
        imageUrl={displayImageUrl}
        onExit={() => setIsPanoramaMode(false)}
      />
    );
  }

  return (
    <div
      className={`fixed ${UI_CONTENT_OVERLAY_INSET_CLASS} z-[100] overflow-hidden bg-black/90 backdrop-blur-lg`}
      style={{
        opacity: overlayOpacity,
        transition: 'opacity 400ms ease',
        pointerEvents: open ? 'auto' : 'none',
      }}
    >
      <div
        ref={containerRef}
        className="absolute inset-0 flex items-center justify-center overflow-hidden p-4"
        style={{ overscrollBehavior: 'contain' }}
        onMouseMove={handleContainerMouseMove}
        onMouseUp={handleContainerMouseUp}
        onMouseLeave={handleContainerMouseUp}
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className="relative">
          <img
            ref={imageRef}
            src={displayImageUrl}
            alt={t('viewer.imageAlt', '图片')}
            className="select-none transition-opacity duration-300"
            style={{
              opacity: viewerOpacity * overlayOpacity,
              transformOrigin: 'center',
              width: '95vw',
              height: '95vh',
              objectFit: 'contain',
            }}
            onLoad={handleImageLoad}
            onMouseDown={handleImageMouseDown}
            onMouseMove={handleImageMouseMove}
            onClick={(e) => {
              if (isPointOnImageContent(e.clientX, e.clientY)) {
                e.stopPropagation();
              } else {
                onClose();
              }
            }}
            draggable={false}
          />
        </div>

        <div className="absolute bottom-8 left-1/2 flex -translate-x-1/2 flex-col items-center gap-3">
          {imageList.length > 1 && (
            <div className="flex items-center gap-3">
              <button
                onClick={() => onNavigate('prev')}
                disabled={currentIndex <= 0}
                className="rounded-full bg-zinc-800/80 p-2 text-white backdrop-blur-sm transition-all duration-200 hover:bg-zinc-700/80 disabled:cursor-not-allowed disabled:opacity-50"
                title={t('viewer.prev', '上一张')}
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
              <button
                onClick={() => onNavigate('next')}
                disabled={currentIndex >= imageList.length - 1}
                className="rounded-full bg-zinc-800/80 p-2 text-white backdrop-blur-sm transition-all duration-200 hover:bg-zinc-700/80 disabled:cursor-not-allowed disabled:opacity-50"
                title={t('viewer.next', '下一张')}
              >
                <ChevronRight className="h-5 w-5" />
              </button>
            </div>
          )}

          <div className="flex items-center gap-4">
            {imageList.length > 1 && (
              <div className={viewerControlClass}>
                {currentIndex + 1} / {imageList.length}
              </div>
            )}
            <div
              ref={scaleDisplayRef}
              className={`${viewerControlClass} min-w-[74px]`}
            >
              100%
            </div>
            <button
              onClick={resetView}
              className={`${viewerControlClass} transition-colors hover:bg-white/10`}
              title={t('viewer.reset', '重置视图')}
            >
              <RotateCcw className="h-4 w-4" />
            </button>
            <button
              onClick={() => setIsPanoramaMode(true)}
              className={`${viewerControlClass} transition-colors hover:bg-white/10`}
              title={t('viewer.panorama', '360 全景查看')}
            >
              <Orbit className="h-4 w-4" />
            </button>
            <button
              onClick={() => {
                setSaveResult(null);
                setIsAddToLibraryOpen((current) => !current);
              }}
              className={`${viewerControlClass} transition-colors hover:bg-white/10`}
              title={t('viewer.addToLibrary', '添加到素材库')}
            >
              <Library className="h-4 w-4" />
              {t('viewer.addToLibrary', '添加到素材库')}
            </button>
            <button
              onClick={onClose}
              className={`${viewerControlClass} transition-colors hover:bg-white/10`}
              title={t('common.close', '关闭')}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* 添加到素材库:分类选择 */}
          {isAddToLibraryOpen && (
            <div className="absolute bottom-24 left-1/2 w-64 -translate-x-1/2 rounded-2xl border border-white/15 bg-zinc-900/95 p-3 shadow-2xl backdrop-blur-xl">
              <p className="mb-2 text-xs font-medium text-white/90">
                {t('viewer.addToLibraryPickCategory', '选择分类')}
              </p>
              <div className="max-h-56 space-y-0.5 overflow-y-auto">
                <button
                  type="button"
                  disabled={isSavingToLibrary}
                  onClick={() => void handleAddToLibrary(null)}
                  className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs text-white/80 transition-colors hover:bg-white/10 disabled:opacity-50"
                >
                  {t('assetLibrary.uncategorized', '未分类')}
                </button>
                {categories
                  .filter((category) => !category.parentId && category.libraryId === (activeLibraryId || libraries[0]?.id))
                  .map((category) => (
                    <div key={category.id}>
                      <button
                        type="button"
                        disabled={isSavingToLibrary}
                        onClick={() => void handleAddToLibrary(category.id)}
                        className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs text-white/80 transition-colors hover:bg-white/10 disabled:opacity-50"
                      >
                        {category.name}
                      </button>
                      {categories
                        .filter((child) => child.parentId === category.id && child.libraryId === (activeLibraryId || libraries[0]?.id))
                        .map((child) => (
                          <button
                            key={child.id}
                            type="button"
                            disabled={isSavingToLibrary}
                            onClick={() => void handleAddToLibrary(child.id)}
                            className="flex w-full items-center justify-between rounded-lg py-2 pl-6 pr-2.5 text-left text-xs text-white/60 transition-colors hover:bg-white/10 disabled:opacity-50"
                          >
                            {child.name}
                          </button>
                        ))}
                    </div>
                  ))}
              </div>
              {isSavingToLibrary && (
                <p className="mt-2 text-center text-[11px] text-white/60">{t('common.saving', '保存中…')}</p>
              )}
              {saveResult === 'ok' && (
                <p className="mt-2 text-center text-[11px] text-emerald-400">{t('viewer.addToLibrarySuccess', '已添加到素材库')}</p>
              )}
              {saveResult === 'fail' && (
                <p className="mt-2 text-center text-[11px] text-red-400">{t('viewer.addToLibraryFailed', '添加失败')}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
