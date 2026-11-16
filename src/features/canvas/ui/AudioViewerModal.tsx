import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { AudioLines, LoaderCircle, Pause, Play, X } from 'lucide-react';

import { UI_CONTENT_OVERLAY_INSET_CLASS } from '@/components/ui/motion';
import { resolveImageDisplayUrl } from '../application/imageData';
import { computeWaveformPeaks } from '../application/waveformPeaks';
import { Waveform } from './Waveform';

export interface AudioViewerModalProps {
  open: boolean;
  /** 音频来源：本地绝对路径、`asset://` 或公网 URL。 */
  audioUrl: string;
  /** 顶部标题，一般是素材名（「音频1」这种编号没有区分度）。 */
  title?: string;
  onClose: () => void;
}

/** 秒 -> `m:ss`；未加载完/非法值统一显示 0:00。 */
function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * 音频全屏试听弹窗 —— 与图片/视频的「点击放大预览」对齐。
 *
 * 画布里的引用素材条只有 36px 一格，音频节点又在别处（还可能被折叠进组），
 * 想确认「这条音频是不是我要的那条」只能把节点拖出来点播放。这里给音频引用一个
 * 和图片一致的重播放入口：波形 + 播放/暂停 + 进度，Esc 或点背景关闭。
 *
 * 自身 portal 到 `document.body`：节点在 React Flow 的 transform 容器里，
 * `position: fixed` 会以那个容器为包含块，不 portal 就会跟着画布缩放跑偏。
 */
export function AudioViewerModal({ open, audioUrl, title, onClose }: AudioViewerModalProps) {
  const { t } = useTranslation();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [isDecoding, setIsDecoding] = useState(false);

  const playbackSrc = useMemo(
    () => (audioUrl ? resolveImageDisplayUrl(audioUrl) : ''),
    [audioUrl],
  );

  // 关闭后保留一小段挂载，让透明度过渡能走完，然后彻底收掉 audio 元素（停止发声）。
  useEffect(() => {
    if (open) {
      setIsVisible(true);
      return;
    }
    setIsPlaying(false);
    audioRef.current?.pause();
    const timer = window.setTimeout(() => setIsVisible(false), 200);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
  }, [open, playbackSrc]);

  /**
   * 波形：真实解码，拿不到就**不画**。
   *
   * 这里刻意不做「按文件名生成稳定柱高」的兜底 —— 那种柱子看起来像波形、实则和音频
   * 毫无关系，用户会照着它找有声的位置。解码失败时降级成纯进度条。
   */
  useEffect(() => {
    if (!open || !playbackSrc || typeof AudioContext === 'undefined') {
      setPeaks([]);
      return;
    }
    const controller = new AbortController();
    const audioContext = new AudioContext();
    let disposed = false;
    setIsDecoding(true);
    setPeaks([]);
    void fetch(playbackSrc, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Audio fetch failed: ${response.status}`);
        return response.arrayBuffer();
      })
      .then((bytes) => audioContext.decodeAudioData(bytes))
      .then((buffer) => {
        if (disposed || controller.signal.aborted) return;
        const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) =>
          buffer.getChannelData(index),
        );
        setPeaks(computeWaveformPeaks(channels, buffer.length, 220));
      })
      .catch((error: unknown) => {
        if (!disposed) console.debug('[audioViewer] waveform decode failed', error);
      })
      .finally(() => {
        if (!disposed) setIsDecoding(false);
        void audioContext.close();
      });
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [open, playbackSrc]);

  // 播放中按帧读 currentTime：timeupdate 只有 4~10fps，进度条会一格一格跳。
  useEffect(() => {
    if (!isPlaying) return;
    let frameId = 0;
    const tick = () => {
      const audio = audioRef.current;
      if (!audio || audio.paused) return;
      setCurrentTime(audio.currentTime);
      frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [isPlaying]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key === ' ' || event.key === 'Spacebar') {
        // 空格 = 播放/暂停。要看当前状态，所以不用 isPlaying 闭包，直接读元素。
        const audio = audioRef.current;
        if (!audio) return;
        event.preventDefault();
        if (audio.paused) void audio.play().catch(() => undefined);
        else audio.pause();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, open]);

  const togglePlayback = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play().catch((error: unknown) => console.warn('[audioViewer] play failed', error));
    } else {
      audio.pause();
    }
  }, []);

  const seekTo = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * audio.duration;
    setCurrentTime(audio.currentTime);
  }, []);

  // 关掉时保留到淡出结束再卸载，否则「关闭」会硬切一下；`playbackSrc` 空则根本没什么可显示。
  if (!playbackSrc || (!open && !isVisible)) return null;

  const percent = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const heading = title?.trim() || t('viewer.audio', '音频');

  return createPortal(
    <div
      className={`fixed ${UI_CONTENT_OVERLAY_INSET_CLASS} z-[100] flex items-center justify-center bg-black/85 p-6 backdrop-blur-lg`}
      style={{ opacity: isVisible ? 1 : 0, transition: 'opacity 200ms ease', pointerEvents: open ? 'auto' : 'none' }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onMouseDown={(event) => event.stopPropagation()}
      data-audio-viewer=""
    >
      <div
        className="w-full max-w-[560px] rounded-2xl border border-white/15 bg-zinc-900/95 p-4 text-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center gap-2">
          <AudioLines className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium" title={heading}>
            {heading}
          </span>
          {isDecoding && <LoaderCircle className="h-3.5 w-3.5 animate-spin text-white/50" aria-hidden="true" />}
          <button
            type="button"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/20 bg-black/40 transition-colors hover:bg-white/15"
            onClick={onClose}
            title={t('common.close', '关闭')}
            aria-label={t('common.close', '关闭')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-white shadow-md transition-transform hover:scale-105"
            onClick={togglePlayback}
            aria-label={isPlaying ? t('viewer.pause', '暂停') : t('viewer.play', '播放')}
            title={isPlaying ? t('viewer.pause', '暂停') : t('viewer.play', '播放')}
          >
            {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}
          </button>

          <div
            className="relative h-16 min-w-0 flex-1 cursor-pointer overflow-hidden rounded-lg bg-white/[0.06]"
            onClick={seekTo}
            role="slider"
            aria-label={t('viewer.audioProgress', '播放进度')}
            aria-valuemin={0}
            aria-valuemax={duration || 0}
            aria-valuenow={currentTime}
          >
            {peaks.length > 0 ? (
              <div className="pointer-events-none absolute inset-0 text-white/30">
                <Waveform peaks={peaks} barCount={220} />
              </div>
            ) : (
              <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-white/20" />
            )}
            {/* 已播放部分：同一份波形，用 clip-path 裁出进度，放大镜式的颜色叠加很直观 */}
            {peaks.length > 0 && (
              <div
                className="pointer-events-none absolute inset-0 text-accent"
                style={{ clipPath: `inset(0 ${100 - percent}% 0 0)` }}
              >
                <Waveform peaks={peaks} barCount={220} />
              </div>
            )}
            <div
              className="pointer-events-none absolute inset-y-0 w-px bg-accent shadow-[0_0_5px_rgba(59,130,246,0.75)]"
              style={{ left: `${percent}%` }}
            />
          </div>

          <span className="shrink-0 text-[11px] tabular-nums text-white/70">
            {formatClock(currentTime)} / {formatClock(duration)}
          </span>
        </div>

        <audio
          ref={audioRef}
          src={playbackSrc}
          preload="auto"
          autoPlay
          // 用 sr-only 而不是 hidden: display:none 的媒体元素在个别 WebView 上会拒绝播放，
          // 而这里只需要"听得到"，不需要占位。
          className="sr-only"
          onLoadedMetadata={(event) => {
            const next = event.currentTarget.duration;
            if (Number.isFinite(next) && next > 0) setDuration(next);
          }}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => setIsPlaying(false)}
          onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
          onError={() =>
            // 解码不了的容器（如部分 WAV/APE）不要静默：至少让时间显示成 0:00 并停在播放按钮。
            setIsPlaying(false)
          }
        />
      </div>
    </div>,
    document.body,
  );
}
