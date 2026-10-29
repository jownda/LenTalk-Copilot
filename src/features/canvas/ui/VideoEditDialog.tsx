import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { LoaderCircle, Maximize2, Pause, Play, Scissors, SkipBack, SkipForward, Trash2 } from "lucide-react";

import { probeVideoAudio, renderVideoEdit } from "@/commands/videoEdit";
import { UiButton, UiModal } from "@/components/ui/primitives";
import { isVideoTrackUndecoded } from "@/features/canvas/application/videoPlayback";
import { resolveImageDisplayUrl } from "@/features/canvas/application/imageData";
import { showErrorDialog } from "@/features/canvas/application/errorDialog";
import { placeEditedVideoNode } from "@/features/canvas/application/videoEditExport";
import { loadWaveformPeaks } from "@/features/canvas/application/waveform";
import { AdvancedVideoEditor } from "@/features/canvas/ui/AdvancedVideoEditor";
import { Waveform } from "@/features/canvas/ui/Waveform";
import {
  applySourceMeta,
  buildTimelineTicks,
  buildVideoEditRequest,
  createVideoEditState,
  deleteSegment,
  findSegmentAt,
  isTicksRemoved,
  makeSegment,
  moveSegmentEdge,
  nextKeptTick,
  ratioToTicks,
  removedRanges,
  splitSegmentsAt,
  ticksToRatio,
  timelineTicks,
  totalKeptTicks,
  validateVideoEditState,
  type VideoEditState,
} from "@/features/canvas/application/videoEdit";
import {
  TICKS_PER_SECOND,
  formatTimecode,
  parseProbeFrameRate,
  snapTicksToFrame,
  ticksFromSeconds,
  ticksPerFrame,
  ticksToSeconds,
} from "@/features/canvas/application/mediaTime";
import { isAudioNode, type CanvasNode } from "@/features/canvas/domain/canvasNodes";
import { useCanvasStore } from "@/stores/canvasStore";

/** 手柄抓取范围：至少 0.35 秒，长视频按 2% 放大 —— 几十像素宽的时间轴上手不抖。 */
const HANDLE_GRAB_RATIO = 0.02;
const MIN_HANDLE_GRAB_TICKS = TICKS_PER_SECOND * 0.35;
/** 没有帧率时逐帧步进用的步长（约 1/30 秒）。 */
const FALLBACK_STEP_TICKS = Math.round(TICKS_PER_SECOND / 30);

/** 时间轴拖拽：拖播放头，或拖某段的入/出点。 */
type DragState =
  | { type: "playhead" }
  | { type: "edge"; id: string; edge: "start" | "end" };

export interface VideoEditDialogProps {
  open: boolean;
  node: CanvasNode;
  onClose: () => void;
}

/**
 * 基础剪辑窗口：**只做最核心的裁剪**。
 *
 * 原来这里什么都塞一点（裁剪 + 音轨替换 + 混合 + 音量 + 淡入淡出），窗口越堆越高，
 * 高频操作（切一刀、删一段）反而要在一堆滑块里找。这些搬到高级剪辑，这边只留：
 * 预览、多段裁剪、切/删、逐帧、导出。
 */
export function VideoEditDialog({ open, node, onClose }: VideoEditDialogProps) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  /**
   * 时间轴上的拖拽状态。
   *
   * `playhead` 与 `edge` 必须分开：两者在 `pointermove` 里做的事完全不同 ——
   * 前者只移动播放头（不动片段），后者改片段边界并顺带把播放头跟过去。
   * 合成一个状态会导致「拖播放线时把段落边缘也拖了」。
   */
  const draggingRef = useRef<DragState | null>(null);
  const playbackTempPathRef = useRef<string | null>(null);

  const addNode = useCanvasStore((state) => state.addNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const findNodePosition = useCanvasStore((state) => state.findNodePosition);

  const sourcePath = useMemo(() => {
    const value = isAudioNode(node) ? node.data.sourcePath : null;
    return typeof value === "string" && value.trim() ? value : null;
  }, [node]);

  const [state, setState] = useState<VideoEditState>(() => createVideoEditState());
  const [currentTicks, setCurrentTicks] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [playbackSrc, setPlaybackSrc] = useState<string | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
  /** 整段视频的音频波形（0~1）。`null` = 还没好或拿不到 —— 此时不画任何东西。 */
  const [peaks, setPeaks] = useState<number[] | null>(null);

  const durationTicks = timelineTicks(state);
  const stepTicks = ticksPerFrame(state.frameRate) ?? FALLBACK_STEP_TICKS;
  const keptTicks = totalKeptTicks(state.segments);
  const selectedSegment = state.segments.find((segment) => segment.id === state.selectedId) ?? null;
  /** 被剪掉的区间：波形要在这几段上面压暗，否则空隙里的波形比保留区还亮。 */
  const gaps = useMemo(() => removedRanges(state.segments, durationTicks), [state.segments, durationTicks]);

  const segmentsRef = useRef(state.segments);
  segmentsRef.current = state.segments;

  useEffect(() => {
    if (!open) return;
    setState(createVideoEditState());
    setCurrentTicks(0);
    setIsPlaying(false);
    setHint(null);
    setIsExporting(false);
    setPlaybackError(null);
    setIsAdvancedOpen(false);
    setPlaybackSrc(sourcePath ? resolveImageDisplayUrl(sourcePath) : null);
  }, [open, sourcePath]);

  // 探测帧率；失败就退回毫秒吸附，不影响剪切本身。远程 URL 不探（ffmpeg 会真去拉网络）。
  useEffect(() => {
    if (!open || !sourcePath || !isTauri()) return;
    if (/^https?:\/\//i.test(sourcePath)) return;
    let cancelled = false;
    void probeVideoAudio(sourcePath)
      .then((result) => {
        if (cancelled) return;
        const rate = result.fps ? parseProbeFrameRate(Math.round(result.fps * 1000), 1000) : null;
        if (rate) setState((current) => ({ ...current, frameRate: rate }));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, sourcePath]);

  /**
   * 声音波形。
   *
   * 拿不到就**什么都不画**。曾经这里用「按路径生成确定性占位波形」兜底，但假峰值会让
   * 用户照着它去找「有声的位置」——那条信息是编的，比空白更糟。
   *
   * 桶数给 600：轨道宽约 550px，260 根可见条，剩余精度留给缩放后仍然够用。
   */
  useEffect(() => {
    if (!open || !sourcePath || !isTauri() || /^https?:\/\//i.test(sourcePath)) {
      setPeaks(null);
      return;
    }
    let cancelled = false;
    setPeaks(null);
    void loadWaveformPeaks(sourcePath, 600).then((result) => {
      if (!cancelled) setPeaks(result);
    });
    return () => {
      cancelled = true;
    };
  }, [open, sourcePath]);

  useEffect(() => {
    return () => {
      const path = playbackTempPathRef.current;
      playbackTempPathRef.current = null;
      if (path) {
        void invoke("remove_video_playback_file", { path }).catch(() => undefined);
      }
    };
  }, []);

  const seekTo = useCallback((ticks: number) => {
    const clamped = Math.max(0, Math.min(ticks, durationTicks));
    const video = videoRef.current;
    if (video && Number.isFinite(clamped)) {
      try {
        video.currentTime = ticksToSeconds(clamped);
      } catch {
        // 元数据未就绪时忽略。
      }
    }
    setCurrentTicks(clamped);
  }, [durationTicks]);

  const handleVideoError = useCallback(() => {
    if (!isTauri() || !sourcePath || playbackTempPathRef.current) {
      setPlaybackError(t("videoEdit.playbackFailed"));
      return;
    }
    void invoke<string>("prepare_video_playback", { source: sourcePath })
      .then((prepared) => {
        playbackTempPathRef.current = prepared;
        setPlaybackSrc(resolveImageDisplayUrl(prepared));
        setPlaybackError(null);
      })
      .catch((error: unknown) => {
        console.warn("[videoEdit] playback fallback failed", error);
        setPlaybackError(t("videoEdit.playbackFailed"));
      });
  }, [sourcePath, t]);

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const seconds = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    if (seconds <= 0) return;
    setState((current) =>
      applySourceMeta(current, { durationTicks: ticksFromSeconds(seconds), frameRate: current.frameRate }),
    );
    setCurrentTicks(ticksFromSeconds(video.currentTime || 0));
    if (isVideoTrackUndecoded(video)) handleVideoError();
  }, [handleVideoError]);

  /** 播放时跳过已剪掉的区间：否则删了中间一段按播放，画面照常播出来，用户以为没剪上。 */
  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const ticks = ticksFromSeconds(video.currentTime);
    setCurrentTicks(ticks);
    if (!isTicksRemoved(segmentsRef.current, ticks)) return;
    const next = nextKeptTick(segmentsRef.current, ticks, durationTicks);
    if (next === null) return;
    try {
      video.currentTime = ticksToSeconds(next);
    } catch {
      // 下次 timeupdate 再试。
    }
    setCurrentTicks(next);
  }, [durationTicks]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play().catch(() => undefined);
      setIsPlaying(true);
    } else {
      video.pause();
      setIsPlaying(false);
    }
  }, []);

  const stepFrame = useCallback((frames: number) => {
    const video = videoRef.current;
    if (video && !video.paused) {
      video.pause();
      setIsPlaying(false);
    }
    setCurrentTicks((current) => {
      const next = Math.max(
        0,
        Math.min(durationTicks, snapTicksToFrame(current + frames * stepTicks, state.frameRate)),
      );
      const element = videoRef.current;
      if (element) {
        try {
          element.currentTime = ticksToSeconds(next);
        } catch {
          // 忽略。
        }
      }
      return next;
    });
  }, [durationTicks, state.frameRate, stepTicks]);

  const ticksFromPointer = useCallback((clientX: number) => {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    const ratio = (clientX - rect.left) / Math.max(1, rect.width);
    return snapTicksToFrame(ratioToTicks(ratio, durationTicks), state.frameRate);
  }, [durationTicks, state.frameRate]);

  const beginEdgeDrag = useCallback(
    (id: string, edge: "start" | "end") => (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      draggingRef.current = { type: "edge", id, edge };
      setState((current) => ({ ...current, selectedId: id }));
      trackRef.current?.setPointerCapture(event.pointerId);
    },
    [],
  );

  /**
   * 抓播放头。放在轨道最上层、并且 `stopPropagation`，所以**压在段落边缘上也依然拖播放头** ——
   * 否则「线正好停在切点上」时怎么点都在改段落，播放头动不了。
   */
  const beginPlayheadDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    draggingRef.current = { type: "playhead" };
    trackRef.current?.setPointerCapture(event.pointerId);
  }, []);

  const handleTrackPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const ticks = ticksFromPointer(event.clientX);
      const grabTicks = Math.max(MIN_HANDLE_GRAB_TICKS, durationTicks * HANDLE_GRAB_RATIO);
      for (const segment of state.segments) {
        if (Math.abs(ticks - segment.startTicks) <= grabTicks) {
          draggingRef.current = { type: "edge", id: segment.id, edge: "start" };
          setState((current) => ({ ...current, selectedId: segment.id }));
          event.currentTarget.setPointerCapture(event.pointerId);
          return;
        }
        if (Math.abs(ticks - segment.endTicks) <= grabTicks) {
          draggingRef.current = { type: "edge", id: segment.id, edge: "end" };
          setState((current) => ({ ...current, selectedId: segment.id }));
          event.currentTarget.setPointerCapture(event.pointerId);
          return;
        }
      }
      const hit = findSegmentAt(state.segments, ticks);
      if (hit) setState((current) => ({ ...current, selectedId: hit.id }));
      seekTo(ticks);
      // 点轨道任意位置 = 把播放头放过去并**按住就能继续拖**（擦洗）。
      // 这是 NLE 的通用手感：不该要求用户精确抓住那条 1px 的线。
      draggingRef.current = { type: "playhead" };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [durationTicks, seekTo, state.segments, ticksFromPointer],
  );

  const handleTrackPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = draggingRef.current;
      if (!drag) return;
      const ticks = ticksFromPointer(event.clientX);
      if (drag.type === "playhead") {
        seekTo(ticks);
        return;
      }
      setState((current) => ({
        ...current,
        segments: moveSegmentEdge(current.segments, drag.id, drag.edge, ticks, current.frameRate, durationTicks),
      }));
      seekTo(ticks);
    },
    [durationTicks, seekTo, ticksFromPointer],
  );

  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const splitAtPlayhead = useCallback(() => {
    const next = splitSegmentsAt(state.segments, currentTicks, state.frameRate);
    if (next.length === state.segments.length) {
      setHint(t("videoEdit.hintSplitInvalid"));
      return;
    }
    setHint(null);
    const cut = snapTicksToFrame(currentTicks, state.frameRate);
    const created = next.find((segment) => segment.startTicks === cut);
    setState((current) => ({ ...current, segments: next, selectedId: created?.id ?? current.selectedId }));
  }, [currentTicks, state.frameRate, state.segments, t]);

  const removeSelected = useCallback(() => {
    if (state.segments.length <= 1) {
      setHint(t("videoEdit.hintLastSegment"));
      return;
    }
    const next = deleteSegment(state.segments, state.selectedId ?? "");
    setHint(null);
    setState((current) => ({ ...current, segments: next, selectedId: next[0]?.id ?? null }));
  }, [state.segments, state.selectedId, t]);

  const resetSegments = useCallback(() => {
    setHint(null);
    setState((current) => ({
      ...current,
      segments: current.durationTicks > 0 ? [makeSegment(0, current.durationTicks)] : current.segments,
      selectedId: null,
    }));
  }, []);

  const handleExport = useCallback(async () => {
    const invalid = validateVideoEditState(state, sourcePath);
    if (invalid) {
      void showErrorDialog(t(`videoEdit.errors.${invalid}`), t("common.error"));
      return;
    }
    if (!isTauri()) {
      void showErrorDialog(t("videoEdit.desktopOnly"), t("common.error"));
      return;
    }
    setIsExporting(true);
    try {
      const result = await renderVideoEdit(buildVideoEditRequest(state, sourcePath as string));
      placeEditedVideoNode({
        node,
        outputPath: result.outputPath,
        suffix: t("videoEdit.resultSuffix"),
        fallbackName: t("videoEdit.defaultResultName"),
        addNode,
        addEdge,
        findNodePosition,
      });
      onClose();
    } catch (error) {
      console.warn("[videoEdit] export failed", error);
      void showErrorDialog(error instanceof Error ? error.message : String(error), t("common.error"));
    } finally {
      setIsExporting(false);
    }
  }, [addEdge, addNode, findNodePosition, node, onClose, sourcePath, state, t]);

  /**
   * 快捷键同样走**窗口捕获阶段**。
   *
   * 画布在 `document` 上有全局 keydown（Delete = 删除选中节点），React 的 onKeyDown 之后
   * 原生事件会继续冒到 document —— 结果是「在剪辑窗里按 Delete，整个视频节点被删掉」。
   *
   * 高级剪辑打开时这个监听必须让位，否则一次按键会同时触发两个窗口的删除。
   */
  /**
   * Q = 裁掉播放线左边（入点移到播放线），W = 裁掉右边（出点移到播放线）。
   *
   * 裁完把播放线**跟着设到新的边界**：`moveSegmentEdge` 会做吸附 / 最短约束，边界可能
   * 和播放线位置不完全一致（例如贴着前一段裁，会被 clamp 到前一段末尾），播放线跟过去才准。
   */
  const trimToPlayhead = useCallback(
    (edge: "start" | "end") => {
      const id = state.selectedId;
      if (!id) return;
      const segments = moveSegmentEdge(state.segments, id, edge, currentTicks, state.frameRate, durationTicks);
      const segment = segments.find((item) => item.id === id);
      const boundary = segment ? (edge === "start" ? segment.startTicks : segment.endTicks) : currentTicks;
      setState((current) => ({ ...current, segments }));
      setCurrentTicks(boundary);
    },
    [currentTicks, durationTicks, state.frameRate, state.selectedId, state.segments],
  );

  const keyActionsRef = useRef({ togglePlay, stepFrame, splitAtPlayhead, removeSelected, trimToPlayhead });
  keyActionsRef.current = { togglePlay, stepFrame, splitAtPlayhead, removeSelected, trimToPlayhead };

  useEffect(() => {
    if (!open || isAdvancedOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) {
        return;
      }
      const actions = keyActionsRef.current;
      switch (event.key) {
        case " ":
          actions.togglePlay();
          break;
        case "ArrowLeft":
          actions.stepFrame(event.shiftKey ? -10 : -1);
          break;
        case "ArrowRight":
          actions.stepFrame(event.shiftKey ? 10 : 1);
          break;
        case "s":
        case "S":
          actions.splitAtPlayhead();
          break;
        case "b":
        case "B":
          if (event.ctrlKey || event.metaKey) {
            actions.splitAtPlayhead();
            break;
          }
          return;
        case "q":
        case "Q":
          actions.trimToPlayhead("start");
          break;
        case "w":
        case "W":
          actions.trimToPlayhead("end");
          break;
        case "Delete":
        case "Backspace":
          actions.removeSelected();
          break;
        default:
          // Escape 等交给 UiModal 自己处理，这里放行。
          return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [isAdvancedOpen, open]);

  return (
    <>
      <UiModal
        isOpen={open}
        title={t("videoEdit.title")}
        onClose={onClose}
        widthClassName="w-[min(600px,calc(100vw-32px))]"
        headerActions={
          <button
            type="button"
            className="flex h-8 items-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-2.5 text-[11px] font-medium text-accent transition-colors hover:bg-accent/20"
            title={t("videoEdit.advancedHint")}
            onClick={() => setIsAdvancedOpen(true)}
          >
            <Maximize2 className="h-3.5 w-3.5" />
            {t("videoEdit.advanced")}
          </button>
        }
        footer={
          <>
            <UiButton variant="muted" onClick={onClose} disabled={isExporting}>
              {t("common.cancel")}
            </UiButton>
            <UiButton variant="primary" onClick={() => void handleExport()} disabled={isExporting}>
              {isExporting ? (
                <>
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                  {t("videoEdit.exporting")}
                </>
              ) : (
                <>
                  <Scissors className="h-4 w-4" />
                  {t("videoEdit.export")}
                </>
              )}
            </UiButton>
          </>
        }
      >
        <div className="space-y-3 outline-none">
          <div className="overflow-hidden rounded-xl border border-border-dark bg-black">
            {playbackSrc ? (
              <video
                ref={videoRef}
                src={playbackSrc}
                className="max-h-[min(240px,38vh)] w-full cursor-pointer"
                draggable={false}
                preload="metadata"
                onClick={togglePlay}
                onDragStart={(event) => event.preventDefault()}
                onLoadedMetadata={handleLoadedMetadata}
                onTimeUpdate={handleTimeUpdate}
                onSeeked={handleTimeUpdate}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onError={handleVideoError}
              />
            ) : (
              <div className="flex h-[160px] items-center justify-center text-xs text-text-muted">
                {t("videoEdit.noSource")}
              </div>
            )}
          </div>
          {playbackError && (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              {playbackError}
            </p>
          )}

          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-text-muted">{t("videoEdit.trimSection")}</span>
            <span className="text-[11px] tabular-nums text-text-muted/80">
              {t("videoEdit.clipLength", {
                duration: formatTimecode(keptTicks, state.frameRate),
                total: formatTimecode(durationTicks, state.frameRate),
              })}
              {state.segments.length > 1 && ` · ${t("videoEdit.segmentCount", { count: state.segments.length })}`}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              className="flex h-7 items-center gap-1 rounded px-2 text-[11px] text-text-muted transition-colors hover:bg-white/10 hover:text-text-dark"
              onClick={togglePlay}
            >
              {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              {isPlaying ? t("videoEdit.pause") : t("videoEdit.play")}
            </button>
            <button
              type="button"
              className="flex h-7 w-7 items-center justify-center rounded text-text-muted transition-colors hover:bg-white/10 hover:text-text-dark"
              title={t("videoEdit.stepBack")}
              onClick={() => stepFrame(-1)}
            >
              <SkipBack className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className="flex h-7 w-7 items-center justify-center rounded text-text-muted transition-colors hover:bg-white/10 hover:text-text-dark"
              title={t("videoEdit.stepForward")}
              onClick={() => stepFrame(1)}
            >
              <SkipForward className="h-3.5 w-3.5" />
            </button>
            <span className="mx-1 h-4 w-px bg-white/10" />
            <button
              type="button"
              className="flex h-7 items-center gap-1 rounded px-2 text-[11px] text-text-muted transition-colors hover:bg-white/10 hover:text-text-dark"
              title={t("videoEdit.splitHint")}
              onClick={splitAtPlayhead}
            >
              <Scissors className="h-3.5 w-3.5" />
              {t("videoEdit.split")}
            </button>
            <button
              type="button"
              className="flex h-7 items-center gap-1 rounded px-2 text-[11px] text-text-muted transition-colors hover:bg-white/10 hover:text-text-dark"
              onClick={removeSelected}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t("videoEdit.deleteSelected")}
            </button>
            <button
              type="button"
              className="ml-auto flex h-7 items-center gap-1 rounded px-2 text-[11px] text-text-muted transition-colors hover:bg-white/10 hover:text-text-dark"
              onClick={resetSegments}
            >
              {t("videoEdit.resetTrim")}
            </button>
          </div>

          <div
            ref={trackRef}
            className="relative h-14 cursor-pointer touch-none select-none overflow-hidden rounded-lg border border-border-dark bg-black/55"
            onPointerDown={handleTrackPointerDown}
            onPointerMove={handleTrackPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            {/*
              声音波形垫在最底层：段落块是半透明的，透上来就是「保留区间里的声音」。
              拿不到波形时整层不渲染 —— 空白好过编出来的假峰值。
            */}
            {peaks && peaks.length > 0 && (
              // 上下各留 7px：波形占满整条 56px 的轨道会顶到边框，看起来像把轨道填死了。
              <div className="pointer-events-none absolute inset-x-0 inset-y-[7px] text-white/55">
                <Waveform peaks={peaks} barCount={200} />
              </div>
            )}

            {state.segments.map((segment) => {
              const left = ticksToRatio(segment.startTicks, durationTicks) * 100;
              const width = Math.max(
                0,
                (ticksToRatio(segment.endTicks, durationTicks) - ticksToRatio(segment.startTicks, durationTicks)) * 100,
              );
              const isSelected = segment.id === state.selectedId;
              return (
                <div
                  key={segment.id}
                  className={`absolute inset-y-0 border-x ${
                    isSelected ? "border-accent/80 bg-accent/35" : "border-accent/40 bg-accent/20"
                  }`}
                  style={{ left: `${left}%`, width: `${width}%` }}
                >
                  {width > 9 && (
                    <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[10px] tabular-nums text-text-dark/80">
                      {formatTimecode(segment.endTicks - segment.startTicks, state.frameRate)}
                    </span>
                  )}
                  <div
                    className="absolute inset-y-0 left-0 w-2 cursor-ew-resize bg-accent/70"
                    onPointerDown={beginEdgeDrag(segment.id, "start")}
                  />
                  <div
                    className="absolute inset-y-0 right-0 w-2 cursor-ew-resize bg-accent/70"
                    onPointerDown={beginEdgeDrag(segment.id, "end")}
                  />
                </div>
              );
            })}

            {/*
              被剪掉的区间压暗。波形是整段视频的，空隙里也有声 —— 不压的话那里没有段落块盖着，
              反而比保留区更亮，视觉上会读成「这段才是要的」。
            */}
            {gaps.map((gap) => (
              <div
                key={`gap-${gap.startTicks}`}
                className="pointer-events-none absolute inset-y-0 bg-black/60"
                style={{
                  left: `${ticksToRatio(gap.startTicks, durationTicks) * 100}%`,
                  width: `${
                    (ticksToRatio(gap.endTicks, durationTicks) - ticksToRatio(gap.startTicks, durationTicks)) * 100
                  }%`,
                }}
              />
            ))}

            {/*
              播放头。三层结构：
              - 外层 z-20 压在所有片段之上，**任何位置按下去都拖播放头**（哪怕它正停在切点上）；
              - 中间 14px 透明热区：可见的线只有 1px，靠它才抓得住；
              - 顶部一个白描边胶囊当抓手，竖线盖在胶囊之上（NLE 的常见样式）。
            */}
            <div
              className="absolute inset-y-0 z-20"
              // 两端各留 5px：手柄居中于播放位置，贴到 0% / 100% 时会被轨道的 overflow-hidden
              // 裁掉一半。夹住之后视觉上仍停得住，而拖动时的 seek 依然按真实鼠标位置算。
              style={{ left: `clamp(5px, ${ticksToRatio(currentTicks, durationTicks) * 100}%, calc(100% - 5px))` }}
              onPointerDown={beginPlayheadDrag}
            >
              <div className="absolute inset-y-0 left-1/2 w-3.5 -translate-x-1/2 cursor-ew-resize" />
              <div className="pointer-events-none absolute left-1/2 top-1 h-4 w-2.5 -translate-x-1/2 rounded-[3px] border-[1.5px] border-white bg-[#141414] shadow-[0_0_0_1px_rgba(0,0,0,0.45)]" />
              <div className="pointer-events-none absolute inset-y-0 left-1/2 z-10 w-px -translate-x-1/2 bg-white/85" />
            </div>
          </div>

          <div className="relative h-4 select-none">
            {buildTimelineTicks(durationTicks, state.frameRate, durationTicks >= TICKS_PER_SECOND * 60 ? 8 : 5).map(
              (tick) => (
                <span
                  key={tick.ratio}
                  className="absolute top-0 -translate-x-1/2 text-[10px] tabular-nums text-text-muted/70"
                  style={{ left: `${tick.ratio * 100}%` }}
                >
                  {tick.label}
                </span>
              ),
            )}
          </div>

          <div className="flex items-center gap-2 text-[11px] tabular-nums text-text-muted">
            <span>{formatTimecode(currentTicks, state.frameRate)}</span>
            <span className="h-3 w-px bg-white/10" />
            <span>
              {selectedSegment
                ? t("videoEdit.selectionRange", {
                    start: formatTimecode(selectedSegment.startTicks, state.frameRate),
                    end: formatTimecode(selectedSegment.endTicks, state.frameRate),
                  })
                : t("videoEdit.selectHint")}
            </span>
          </div>

          {hint && (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-200">
              {hint}
            </p>
          )}
        </div>
      </UiModal>

      <AdvancedVideoEditor open={open && isAdvancedOpen} node={node} onClose={() => setIsAdvancedOpen(false)} />
    </>
  );
}
