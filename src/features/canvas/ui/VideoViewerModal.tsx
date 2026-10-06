import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { X } from 'lucide-react';

import { UI_CONTENT_OVERLAY_INSET_CLASS } from '@/components/ui/motion';
import { resolveImageDisplayUrl } from '../application/imageData';

export interface VideoViewerModalProps {
  open: boolean;
  /** 视频来源: 本地绝对路径或可访问 URL。 */
  videoUrl: string;
  title?: string;
  onClose: () => void;
}

/**
 * 全屏视频预览。
 *
 * 与节点内的播放器共用同一套取址策略: 先走 asset 协议直接播放; 原生播放器解不了
 * (MOV/HEVC/ProRes 等) 时再调 prepare_video_playback 转成 H.264/AAC MP4, 关闭时
 * 回收转码产生的临时文件。
 */
export function VideoViewerModal({ open, videoUrl, title, onClose }: VideoViewerModalProps) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const tempPathRef = useRef<string | null>(null);
  const prepareRequestRef = useRef(0);
  const [playbackSrc, setPlaybackSrc] = useState('');
  const [isPreparing, setIsPreparing] = useState(false);
  const [hasFailed, setHasFailed] = useState(false);
  const [isVisible, setIsVisible] = useState(false);

  const releaseTempFile = useCallback(() => {
    const tempPath = tempPathRef.current;
    tempPathRef.current = null;
    if (tempPath) {
      void invoke('remove_video_playback_file', { path: tempPath }).catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      setIsVisible(false);
      setPlaybackSrc('');
      setIsPreparing(false);
      setHasFailed(false);
      releaseTempFile();
      return;
    }

    prepareRequestRef.current += 1;
    setPlaybackSrc(videoUrl ? resolveImageDisplayUrl(videoUrl) : '');
    setIsPreparing(false);
    setHasFailed(false);
    const frame = requestAnimationFrame(() => setIsVisible(true));
    return () => cancelAnimationFrame(frame);
  }, [open, releaseTempFile, videoUrl]);

  useEffect(() => () => releaseTempFile(), [releaseTempFile]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, open]);

  const handlePlaybackError = useCallback(() => {
    const source = videoUrl?.trim();
    if (!source || !isTauri() || isPreparing) {
      setHasFailed(true);
      return;
    }
    const lower = source.toLowerCase();
    if (lower.startsWith('blob:') || lower.startsWith('data:') || lower.startsWith('asset:')) {
      setHasFailed(true);
      return;
    }

    const requestId = prepareRequestRef.current + 1;
    prepareRequestRef.current = requestId;
    setIsPreparing(true);
    void invoke<string>('prepare_video_playback', { source })
      .then((preparedPath) => {
        if (prepareRequestRef.current !== requestId) {
          void invoke('remove_video_playback_file', { path: preparedPath }).catch(() => undefined);
          return;
        }
        tempPathRef.current = preparedPath;
        setPlaybackSrc(resolveImageDisplayUrl(preparedPath));
        setHasFailed(false);
      })
      .catch(() => {
        if (prepareRequestRef.current === requestId) {
          setHasFailed(true);
        }
      })
      .finally(() => {
        if (prepareRequestRef.current === requestId) {
          setIsPreparing(false);
        }
      });
  }, [isPreparing, videoUrl]);

  if (!open) {
    return null;
  }

  const heading = title?.trim() || t('viewer.video', '视频');

  return (
    <div
      className={`fixed ${UI_CONTENT_OVERLAY_INSET_CLASS} z-[100] flex flex-col items-center justify-center gap-4 bg-black/90 p-6 backdrop-blur-lg`}
      style={{ opacity: isVisible ? 1 : 0, transition: 'opacity 240ms ease' }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="flex w-full max-w-[92vw] items-center justify-between gap-3">
        <span className="truncate text-sm text-white/80">{heading}</span>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/20 bg-black/60 text-white backdrop-blur-xl transition-colors hover:bg-white/10"
          title={t('common.close', '关闭')}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center">
        {playbackSrc ? (
          <video
            ref={videoRef}
            src={playbackSrc}
            controls
            autoPlay
            playsInline
            className="max-h-[78vh] max-w-[92vw] rounded-lg bg-black shadow-2xl"
            onError={handlePlaybackError}
          />
        ) : null}
      </div>

      {isPreparing ? (
        <p className="text-xs text-white/70">
          {t('viewer.preparingVideo', '正在转码以便播放…')}
        </p>
      ) : null}
      {hasFailed ? (
        <p className="text-xs text-red-300">
          {t('viewer.videoFailed', '该视频无法播放，可能是编码不受支持或文件已被移动。')}
        </p>
      ) : null}
    </div>
  );
}
