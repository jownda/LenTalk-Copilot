import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { open as openNativeFile } from "@tauri-apps/plugin-dialog";
import { Film, LoaderCircle, Scissors, Volume2, VolumeX, Wand2, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { UiButton, UiModal, UiSelect } from "@/components/ui/primitives";
import {
  CANVAS_NODE_TYPES,
  DEFAULT_ASPECT_RATIO,
  isAudioNode,
  type CanvasNode,
} from "@/features/canvas/domain/canvasNodes";
import { resolveImageDisplayUrl } from "@/features/canvas/application/imageData";
import { showErrorDialog } from "@/features/canvas/application/errorDialog";
import { renderVideoEdit, type VideoEditAudioMode } from "@/commands/videoEdit";
import { useCanvasStore } from "@/stores/canvasStore";
import {
  buildVideoEditRequest,
  createFullTrimRange,
  createVideoEditState,
  formatTimecode,
  moveTrimHandle,
  pickNearestTrimHandle,
  ratioToSeconds,
  resolveAudioModeAfterTrackPick,
  resolveOutputDuration,
  resolveTimelineDuration,
  secondsToRatio,
  trimSelectionDuration,
  validateVideoEditState,
  type VideoEditState,
} from "@/features/canvas/application/videoEdit";

export interface VideoEditDialogProps {
  open: boolean;
  node: CanvasNode;
  onClose: () => void;
}

/** 拖动时间轴时，鼠标与手柄多远算「抓到了」——按比例算，长视频才不至于要求像素级精准。 */
const HANDLE_GRAB_RATIO = 0.02;
const MIN_HANDLE_GRAB_SEC = 0.35;

/** 音量/淡入淡出的滑杆步长。 */
const VOLUME_STEP = 0.05;
const FADE_STEP = 0.1;

function resolveAudioModeLabelKey(mode: VideoEditAudioMode): string {
  switch (mode) {
    case "mute":
      return "videoEdit.audioModeMute";
    case "replace":
      return "videoEdit.audioModeReplace";
    case "mix":
      return "videoEdit.audioModeMix";
    default:
      return "videoEdit.audioModeKeep";
  }
}

/**
 * 秒数输入框。
 *
 * 不能把受控值直接绑到 `toFixed(1)` 上：输入 "1." 会被 `Number("1.") = 1` 立刻打回 "1"，
 * 小数点根本打不出来。所以编辑期间保留用户原样的草稿字符串，只在失焦时对齐显示值。
 */
function SecondsInput({
  value,
  label,
  onCommit,
}: {
  value: number;
  label: string;
  onCommit: (seconds: number) => void;
}) {
  const [draft, setDraft] = useState(() => value.toFixed(1));
  const [isFocused, setIsFocused] = useState(false);

  useEffect(() => {
    if (!isFocused) setDraft(value.toFixed(1));
  }, [isFocused, value]);

  return (
    <label className="flex items-center gap-1.5">
      {label}
      <input
        type="text"
        inputMode="decimal"
        value={draft}
        onFocus={() => setIsFocused(true)}
        onBlur={() => {
          setIsFocused(false);
          setDraft(value.toFixed(1));
        }}
        onChange={(event) => {
          setDraft(event.target.value);
          const parsed = Number(event.target.value);
          // 只把能解析出来的中间态写回；空串/半截小数点交给失焦时的对齐处理。
          if (event.target.value.trim() !== "" && Number.isFinite(parsed)) {
            onCommit(parsed);
          }
        }}
        className="h-7 w-20 rounded border border-border-dark bg-bg-dark/50 px-2 text-[11px] tabular-nums text-text-dark"
      />
    </label>
  );
}

export function VideoEditDialog({ open, node, onClose }: VideoEditDialogProps) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef<"start" | "end" | null>(null);
  const playbackTempPathRef = useRef<string | null>(null);

  const addNode = useCanvasStore((state) => state.addNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const findNodePosition = useCanvasStore((state) => state.findNodePosition);
  const canvasNodes = useCanvasStore((state) => state.nodes);

  const sourcePath = useMemo(() => {
    const value = isAudioNode(node) ? node.data.sourcePath : null;
    return typeof value === "string" && value.trim() ? value : null;
  }, [node]);

  const [state, setState] = useState<VideoEditState>(() => createVideoEditState());
  const [currentTime, setCurrentTime] = useState(0);
  const [isExporting, setIsExporting] = useState(false);
  const [playbackSrc, setPlaybackSrc] = useState<string | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);

  const duration = state.duration;
  const timelineDuration = resolveTimelineDuration(duration);
  const startRatio = secondsToRatio(state.trim.start, duration);
  const endRatio = secondsToRatio(state.trim.end, duration);
  const playheadRatio = secondsToRatio(currentTime, duration);
  const clipLength = trimSelectionDuration(state.trim);

  /** 画布上可作为音轨的媒体节点（排除自己，否则等于把原声再叠一遍）。 */
  const trackCandidates = useMemo(() => {
    return canvasNodes
      .filter((candidate) => candidate.id !== node.id && isAudioNode(candidate))
      .map((candidate) => {
        const path = candidate.data.sourcePath;
        if (typeof path !== "string" || !path.trim()) return null;
        return {
          id: candidate.id,
          path,
          label: candidate.data.displayName?.trim() || (candidate.data.mediaType === "video" ? "视频节点" : "音频节点"),
          kind: candidate.data.mediaType === "video" ? "video" : "audio",
        };
      })
      .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
  }, [canvasNodes, node.id]);

  // 每次打开都从零开始，避免上一段视频的区间/音轨被带过来。
  useEffect(() => {
    if (!open) return;
    setState(createVideoEditState());
    setCurrentTime(0);
    setIsExporting(false);
    setPlaybackError(null);
    setPlaybackSrc(sourcePath ? resolveImageDisplayUrl(sourcePath) : null);
  }, [open, sourcePath]);

  // 卸载/关闭时回收播放兼容临时文件，与视频帧抽取弹窗保持一致。
  useEffect(() => {
    return () => {
      const path = playbackTempPathRef.current;
      playbackTempPathRef.current = null;
      if (path) {
        void invoke("remove_video_playback_file", { path }).catch(() => undefined);
      }
    };
  }, []);

  const updateState = useCallback((patch: Partial<VideoEditState>) => {
    setState((current) => ({ ...current, ...patch }));
  }, []);

  const seekTo = useCallback((seconds: number) => {
    const video = videoRef.current;
    if (video && Number.isFinite(seconds)) {
      try {
        video.currentTime = seconds;
      } catch {
        // 源还没 ready 时赋值会被忽略，交给 onLoadedMetadata 重新对齐。
      }
    }
    setCurrentTime(seconds);
  }, []);

  /** 元数据到位前 duration 为 0，时间轴用的是占位时长；拿到真实值后重算整段区间。 */
  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const nextDuration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    if (nextDuration <= 0) return;
    setState((current) =>
      current.duration === nextDuration
        ? current
        : { ...current, duration: nextDuration, trim: createFullTrimRange(nextDuration) },
    );
    setCurrentTime(video.currentTime || 0);
  }, []);

  /** 原生播放器解不了的编码（HEVC/ProRes/MOV）统一转成 H.264 播放代理。 */
  const handleVideoError = useCallback(() => {
    if (!isTauri() || !sourcePath || playbackTempPathRef.current) {
      setPlaybackError(t("videoEdit.playbackFailed"));
      return;
    }
    void invoke<string>("prepare_video_playback", { source: sourcePath })
      .then((preparedPath) => {
        playbackTempPathRef.current = preparedPath;
        setPlaybackSrc(resolveImageDisplayUrl(preparedPath));
        setPlaybackError(null);
      })
      .catch((error: unknown) => {
        console.warn("[videoEdit] playback compatibility fallback failed", error);
        setPlaybackError(t("videoEdit.playbackFailed"));
      });
  }, [sourcePath, t]);

  const secondsFromPointer = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track) return 0;
      const rect = track.getBoundingClientRect();
      const ratio = (clientX - rect.left) / Math.max(1, rect.width);
      return ratioToSeconds(ratio, duration);
    },
    [duration],
  );

  const beginHandleDrag = useCallback(
    (handle: "start" | "end") => (event: ReactPointerEvent<HTMLElement>) => {
      event.stopPropagation();
      draggingRef.current = handle;
      trackRef.current?.setPointerCapture(event.pointerId);
    },
    [],
  );

  const handleTrackPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const seconds = secondsFromPointer(event.clientX);
      const grabWindow = Math.max(MIN_HANDLE_GRAB_SEC, timelineDuration * HANDLE_GRAB_RATIO);
      const nearest = Math.min(Math.abs(seconds - state.trim.start), Math.abs(seconds - state.trim.end));
      if (nearest <= grabWindow) {
        draggingRef.current = pickNearestTrimHandle(seconds, state.trim);
        event.currentTarget.setPointerCapture(event.pointerId);
        return;
      }
      // 点空白处 = 定位播放头，方便先看画面再决定裁哪里。
      seekTo(seconds);
    },
    [secondsFromPointer, seekTo, state.trim, timelineDuration],
  );

  const handleTrackPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const handle = draggingRef.current;
      if (!handle) return;
      const seconds = secondsFromPointer(event.clientX);
      const nextTrim = moveTrimHandle(handle, seconds, state.trim, duration);
      updateState({ trim: nextTrim });
      // 拖到哪儿就把画面跳到哪儿：用户要看的正是「这一刀切在这儿」的那一帧。
      seekTo(handle === "start" ? nextTrim.start : nextTrim.end);
    },
    [duration, secondsFromPointer, seekTo, state.trim, updateState],
  );

  const endHandleDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const applyTrack = useCallback((path: string, label: string) => {
    setState((current) => ({
      ...current,
      trackPath: path,
      trackPathLabel: label,
      audioMode: resolveAudioModeAfterTrackPick(current.audioMode, true),
    }));
  }, []);

  const handlePickLocalTrack = useCallback(async () => {
    if (!isTauri()) {
      void showErrorDialog(t("videoEdit.desktopOnly"), t("common.error"));
      return;
    }
    const selected = await openNativeFile({
      multiple: false,
      directory: false,
      filters: [{ name: t("videoEdit.audioFileFilter"), extensions: ["mp3", "m4a", "wav", "aac", "flac", "ogg"] }],
    });
    if (typeof selected !== "string" || !selected.trim()) return;
    applyTrack(selected, selected.split(/[\\/]/).pop() || selected);
  }, [applyTrack, t]);

  const clearTrack = useCallback(() => {
    setState((current) => ({ ...current, trackPath: null, trackPathLabel: null, audioMode: "keep" }));
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
      const baseName = node.data.displayName?.trim() || t("videoEdit.defaultResultName");
      const placement = findNodePosition(node.id, 360, 240);
      const newNodeId = addNode(CANVAS_NODE_TYPES.audio, placement, {
        displayName: `${baseName} ${t("videoEdit.resultSuffix")}`,
        mediaType: "video",
        sourcePath: result.outputPath,
        previewImageUrl: null,
        aspectRatio:
          typeof node.data.aspectRatio === "string" && node.data.aspectRatio.trim()
            ? node.data.aspectRatio
            : DEFAULT_ASPECT_RATIO,
      });
      addEdge(node.id, newNodeId);
      onClose();
    } catch (error) {
      console.warn("[videoEdit] export failed", error);
      void showErrorDialog(error instanceof Error ? error.message : String(error), t("common.error"));
    } finally {
      setIsExporting(false);
    }
  }, [addEdge, addNode, findNodePosition, node, onClose, sourcePath, state, t]);

  const hasTrack = Boolean(state.trackPath);
  const fadesDisabled = clipLength <= 0;
  const maxFade = Math.max(0.5, Math.min(5, timelineDuration / 2));

  return (
    <UiModal
      isOpen={open}
      title={t("videoEdit.title")}
      onClose={onClose}
      widthClassName="w-[min(680px,calc(100vw-32px))]"
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
                {t("videoEdit.export", "导出")}
              </>
            )}
          </UiButton>
        </>
      }
    >
      <div className="space-y-4">
        {/* ── 画面预览 ────────────────────────────────────────────── */}
        <div className="overflow-hidden rounded-xl border border-border-dark bg-black">
          {playbackSrc ? (
            <video
              ref={videoRef}
              src={playbackSrc}
              className="max-h-[min(260px,40vh)] w-full"
              controls
              draggable={false}
              preload="metadata"
              onDragStart={(event) => event.preventDefault()}
              onLoadedMetadata={handleLoadedMetadata}
              onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
              onSeeked={(event) => setCurrentTime(event.currentTarget.currentTime)}
              onError={handleVideoError}
            />
          ) : (
            <div className="flex h-[180px] items-center justify-center text-xs text-text-muted">
              {t("videoEdit.noSource")}
            </div>
          )}
        </div>
        {playbackError && (
          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            {playbackError}
          </p>
        )}

        {/* ── 剪辑时间轴 ──────────────────────────────────────────── */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-text-muted">{t("videoEdit.trimSection")}</span>
            <span className="text-[11px] tabular-nums text-text-muted/80">
              {t("videoEdit.clipLength", {
                duration: formatTimecode(clipLength),
                total: formatTimecode(timelineDuration),
              })}
            </span>
          </div>

          <div
            ref={trackRef}
            className="relative h-14 cursor-pointer touch-none select-none overflow-hidden rounded-lg border border-border-dark bg-bg-dark/60"
            onPointerDown={handleTrackPointerDown}
            onPointerMove={handleTrackPointerMove}
            onPointerUp={endHandleDrag}
            onPointerCancel={endHandleDrag}
          >
            {/* 选中区间 */}
            <div
              className="pointer-events-none absolute inset-y-0 bg-accent/25"
              style={{ left: `${startRatio * 100}%`, width: `${Math.max(0, endRatio - startRatio) * 100}%` }}
            />
            {/* 被裁掉的两段压暗，一眼看出留了哪一截 */}
            <div
              className="pointer-events-none absolute inset-y-0 left-0 bg-black/45"
              style={{ width: `${startRatio * 100}%` }}
            />
            <div
              className="pointer-events-none absolute inset-y-0 right-0 bg-black/45"
              style={{ width: `${Math.max(0, 1 - endRatio) * 100}%` }}
            />
            {/* 刻度 */}
            {[0.25, 0.5, 0.75].map((ratio) => (
              <div
                key={ratio}
                className="pointer-events-none absolute inset-y-0 w-px bg-white/10"
                style={{ left: `${ratio * 100}%` }}
              />
            ))}
            {/* 播放头 */}
            <div
              className="pointer-events-none absolute inset-y-0 w-px bg-white/80"
              style={{ left: `${playheadRatio * 100}%` }}
            />
            {/* 起止手柄 */}
            {(["start", "end"] as const).map((handle) => (
              <div
                key={handle}
                role="slider"
                tabIndex={0}
                aria-label={handle === "start" ? t("videoEdit.trimStart") : t("videoEdit.trimEnd")}
                aria-valuemin={0}
                aria-valuemax={timelineDuration}
                aria-valuenow={handle === "start" ? state.trim.start : state.trim.end}
                className="absolute top-0 z-10 flex h-full w-4 -translate-x-1/2 cursor-ew-resize items-center justify-center"
                style={{ left: `${(handle === "start" ? startRatio : endRatio) * 100}%` }}
                onPointerDown={beginHandleDrag(handle)}
              >
                <span className="h-full w-1 rounded-full bg-accent shadow-[0_0_0_1px_rgba(255,255,255,0.35)]" />
              </div>
            ))}
          </div>

          <div className="flex items-center gap-3 text-[11px] text-text-muted">
            <SecondsInput
              value={state.trim.start}
              label={t("videoEdit.trimStart")}
              onCommit={(seconds) => updateState({ trim: moveTrimHandle("start", seconds, state.trim, duration) })}
            />
            <SecondsInput
              value={state.trim.end}
              label={t("videoEdit.trimEnd")}
              onCommit={(seconds) => updateState({ trim: moveTrimHandle("end", seconds, state.trim, duration) })}
            />
            <button
              type="button"
              className="rounded px-1.5 py-0.5 text-[11px] text-text-muted transition-colors hover:bg-white/10 hover:text-text-dark"
              onClick={() => updateState({ trim: createFullTrimRange(duration) })}
            >
              {t("videoEdit.resetTrim")}
            </button>
          </div>
        </div>

        {/* ── 原声 ────────────────────────────────────────────────── */}
        <div className="space-y-2 rounded-xl border border-border-dark p-3">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-xs font-medium text-text-muted">
              {state.audioMode === "mute" ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
              {t("videoEdit.audioSection")}
            </span>
            <div className="flex items-center gap-1">
              {(["keep", "mute"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`rounded-full px-2.5 py-1 text-[11px] transition-colors ${
                    state.audioMode === mode ||
                    (mode === "keep" && (state.audioMode === "replace" || state.audioMode === "mix"))
                      ? "bg-accent/25 text-text-dark"
                      : "text-text-muted hover:bg-white/10"
                  }`}
                  onClick={() => updateState({ audioMode: mode === "keep" ? "keep" : "mute" })}
                >
                  {mode === "keep" ? t("videoEdit.audioModeKeep") : t("videoEdit.audioModeMute")}
                </button>
              ))}
            </div>
          </div>

          <div className={`space-y-2 ${state.audioMode === "mute" ? "pointer-events-none opacity-40" : ""}`}>
            <label className="flex items-center gap-3 text-[11px] text-text-muted">
              <span className="w-16 shrink-0">{t("videoEdit.audioVolume")}</span>
              <input
                type="range"
                min={0}
                max={2}
                step={VOLUME_STEP}
                value={state.audioVolume}
                onChange={(event) => updateState({ audioVolume: Number(event.target.value) })}
                className="h-3 flex-1 accent-[var(--accent)]"
              />
              <span className="w-12 shrink-0 text-right tabular-nums">{Math.round(state.audioVolume * 100)}%</span>
            </label>
          </div>

          {/* ── 附加音轨 ──────────────────────────────────────────── */}
          <div className="space-y-2 border-t border-white/10 pt-2">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-xs font-medium text-text-muted">
                <Film className="h-3.5 w-3.5" />
                {t("videoEdit.trackSection")}
              </span>
              {hasTrack && (
                <button
                  type="button"
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-text-muted transition-colors hover:bg-white/10 hover:text-text-dark"
                  onClick={clearTrack}
                >
                  <X className="h-3 w-3" />
                  {t("videoEdit.clearTrack")}
                </button>
              )}
            </div>

            {hasTrack ? (
              <p className="truncate rounded-md border border-border-dark bg-bg-dark/40 px-2.5 py-1.5 text-[11px] text-text-dark">
                {state.trackPathLabel ?? state.trackPath}
              </p>
            ) : (
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <UiSelect
                    value=""
                    className="h-8 text-[11px]"
                    onChange={(event) => {
                      const path = event.target.value;
                      const candidate = trackCandidates.find((item) => item.path === path);
                      if (candidate) applyTrack(candidate.path, candidate.label);
                    }}
                  >
                    <option value="">
                      {trackCandidates.length > 0 ? t("videoEdit.pickFromCanvas") : t("videoEdit.noCanvasTrack")}
                    </option>
                    {trackCandidates.map((candidate) => (
                      <option key={candidate.id} value={candidate.path}>
                        {candidate.kind === "video" ? `🎬 ${candidate.label}` : `🎵 ${candidate.label}`}
                      </option>
                    ))}
                  </UiSelect>
                </div>
                <UiButton variant="muted" size="sm" onClick={() => void handlePickLocalTrack()}>
                  {t("videoEdit.pickLocalTrack")}
                </UiButton>
              </div>
            )}

            {hasTrack && (
              <>
                <div className="flex items-center gap-1">
                  {(["replace", "mix"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={`rounded-full px-2.5 py-1 text-[11px] transition-colors ${
                        state.audioMode === mode ? "bg-accent/25 text-text-dark" : "text-text-muted hover:bg-white/10"
                      }`}
                      onClick={() => updateState({ audioMode: mode })}
                    >
                      {t(resolveAudioModeLabelKey(mode))}
                    </button>
                  ))}
                </div>
                <label className="flex items-center gap-3 text-[11px] text-text-muted">
                  <span className="w-16 shrink-0">{t("videoEdit.trackVolume")}</span>
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={VOLUME_STEP}
                    value={state.trackVolume}
                    onChange={(event) => updateState({ trackVolume: Number(event.target.value) })}
                    className="h-3 flex-1 accent-[var(--accent)]"
                  />
                  <span className="w-12 shrink-0 text-right tabular-nums">{Math.round(state.trackVolume * 100)}%</span>
                </label>
              </>
            )}
          </div>

          {/* ── 淡入淡出 ──────────────────────────────────────────── */}
          <div className="space-y-2 border-t border-white/10 pt-2">
            {(["fadeIn", "fadeOut"] as const).map((key) => (
              <label key={key} className="flex items-center gap-3 text-[11px] text-text-muted">
                <span className="w-16 shrink-0">
                  {key === "fadeIn" ? t("videoEdit.fadeIn") : t("videoEdit.fadeOut")}
                </span>
                <input
                  type="range"
                  min={0}
                  max={maxFade}
                  step={FADE_STEP}
                  value={key === "fadeIn" ? state.fadeIn : state.fadeOut}
                  disabled={fadesDisabled}
                  onChange={(event) => updateState({ [key]: Number(event.target.value) } as Partial<VideoEditState>)}
                  className="h-3 flex-1 accent-[var(--accent)]"
                />
                <span className="w-12 shrink-0 text-right tabular-nums">
                  {(key === "fadeIn" ? state.fadeIn : state.fadeOut).toFixed(1)}s
                </span>
              </label>
            ))}
          </div>
        </div>

        <p className="flex items-start gap-1.5 text-[11px] leading-5 text-text-muted/80">
          <Wand2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t("videoEdit.hint", { duration: formatTimecode(resolveOutputDuration(state)) })}
        </p>
      </div>
    </UiModal>
  );
}
