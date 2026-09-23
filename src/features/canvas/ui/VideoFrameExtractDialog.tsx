import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Camera, Film, Plus, X } from "lucide-react";
import { open as openNativeFile } from "@tauri-apps/plugin-dialog";
import { invoke, isTauri } from "@tauri-apps/api/core";

import { UiButton, UiModal } from "@/components/ui/primitives";
import { useCanvasStore } from "@/stores/canvasStore";
import {
  CANVAS_NODE_TYPES,
  EXPORT_RESULT_NODE_MIN_HEIGHT,
  EXPORT_RESULT_NODE_MIN_WIDTH,
} from "@/features/canvas/domain/canvasNodes";
import { nodeCatalog } from "@/features/canvas/application/nodeCatalog";
import { prepareNodeImage, resolveImageDisplayUrl } from "@/features/canvas/application/imageData";
import { captureVideoFrame } from "@/features/canvas/application/videoFrameCapture";
import { resolveMinEdgeFittedSize } from "@/features/canvas/application/imageNodeSizing";
import { resolveFrameInsertPositions } from "@/features/canvas/application/videoFramePlacement";
import { useAssetLibraryStore } from "@/features/library/assetStore";
import { createAssetId } from "@/features/library/importAssets";

export interface VideoFrameExtractDialogProps {
  open: boolean;
  onClose: () => void;
}

interface ExtractedFrame {
  id: string;
  dataUrl: string;
  timeSec: number;
}

const MAX_FRAME_WIDTH = 1920;
const MAX_FRAMES = 20;

function drawVideoFrame(video: HTMLVideoElement): string {
  const ratio = video.videoWidth / video.videoHeight;
  let targetWidth = video.videoWidth;
  let targetHeight = video.videoHeight;
  if (targetWidth > MAX_FRAME_WIDTH) {
    targetWidth = MAX_FRAME_WIDTH;
    targetHeight = Math.round(MAX_FRAME_WIDTH / ratio);
  }

  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("无法初始化画布");
  }
  context.drawImage(video, 0, 0, targetWidth, targetHeight);
  return canvas.toDataURL("image/jpeg", 0.9);
}

function waitForSeeked(video: HTMLVideoElement, timeSec: number): Promise<void> {
  const target = Math.max(0, timeSec);
  if (Math.abs(video.currentTime - target) < 0.01 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let timeoutId = 0;
    const cleanup = () => {
      window.clearTimeout(timeoutId);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("视频定位失败"));
    };
    timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error("视频定位超时"));
    }, 8000);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    video.currentTime = target;
  });
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

export function VideoFrameExtractDialog({ open, onClose }: VideoFrameExtractDialogProps) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const playbackTempPathRef = useRef<string | null>(null);
  const currentTimeRef = useRef(0);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoSource, setVideoSource] = useState<string | null>(null);
  const [videoName, setVideoName] = useState("");
  const [videoDuration, setVideoDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [frames, setFrames] = useState<ExtractedFrame[]>([]);
  const [isPreparing, setIsPreparing] = useState(false);

  const addNode = useCanvasStore((state) => state.addNode);
  const addAssets = useAssetLibraryStore((state) => state.addAssets);

  const resetState = useCallback(() => {
    if (videoUrl?.startsWith("blob:")) {
      URL.revokeObjectURL(videoUrl);
    }
    const playbackTempPath = playbackTempPathRef.current;
    playbackTempPathRef.current = null;
    if (playbackTempPath) {
      void invoke("remove_video_playback_file", { path: playbackTempPath }).catch(() => undefined);
    }
    setVideoUrl(null);
    setVideoSource(null);
    setVideoName("");
    setVideoDuration(0);
    setCurrentTime(0);
    currentTimeRef.current = 0;
    setFrames([]);
  }, [videoUrl]);

  useEffect(() => {
    if (!open) {
      return;
    }
    return () => {
      if (videoUrl?.startsWith("blob:")) {
        URL.revokeObjectURL(videoUrl);
      }
    };
  }, [open, videoUrl]);

  useEffect(() => {
    return () => {
      const playbackTempPath = playbackTempPathRef.current;
      if (playbackTempPath) {
        void invoke("remove_video_playback_file", { path: playbackTempPath }).catch(() => undefined);
      }
    };
  }, []);

  useEffect(() => {
    if (!open) {
      resetState();
    }
  }, [open, resetState]);

  const setSelectedVideo = useCallback(
    (name: string, displayUrl: string, source: string) => {
      if (videoUrl && videoUrl.startsWith("blob:")) {
        URL.revokeObjectURL(videoUrl);
      }
      const previousPlaybackPath = playbackTempPathRef.current;
      playbackTempPathRef.current = null;
      if (previousPlaybackPath) {
        void invoke("remove_video_playback_file", { path: previousPlaybackPath }).catch(() => undefined);
      }
      setFrames([]);
      setVideoName(name);
      setVideoSource(source);
      setVideoUrl(displayUrl);
      setCurrentTime(0);
      currentTimeRef.current = 0;
      setVideoDuration(0);
    },
    [videoUrl],
  );

  const handleSelectVideo = useCallback(async () => {
    if (!isTauri()) {
      fileInputRef.current?.click();
      return;
    }
    const selected = await openNativeFile({
      multiple: false,
      directory: false,
      filters: [{ name: "Video", extensions: ["mp4", "mov", "m4v", "webm", "mkv", "avi"] }],
    });
    if (typeof selected !== "string" || !selected.trim()) return;
    const name = selected.split(/[\\/]/).pop() || selected;
    setSelectedVideo(name, resolveImageDisplayUrl(selected), selected);
  }, [setSelectedVideo]);

  const handleFileChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      const nativePath = (file as File & { path?: unknown }).path;
      const source = typeof nativePath === "string" && nativePath.trim() ? nativePath : URL.createObjectURL(file);
      const displayUrl = source.startsWith("blob:") ? source : resolveImageDisplayUrl(source);
      setSelectedVideo(file.name, displayUrl, source);
    },
    [setSelectedVideo],
  );

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    setVideoDuration(video.duration || 0);
  }, []);

  const handleVideoError = useCallback(() => {
    if (!isTauri() || !videoSource || playbackTempPathRef.current) return;
    void invoke<string>("prepare_video_playback", { source: videoSource })
      .then((preparedPath) => {
        playbackTempPathRef.current = preparedPath;
        setVideoUrl(resolveImageDisplayUrl(preparedPath));
      })
      .catch((error) => {
        console.warn("[videoFrame] playback compatibility fallback failed", error);
      });
  }, [videoSource]);

  const handleSeek = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const video = videoRef.current;
    if (!video) return;
    const nextTime = Number(event.target.value);
    currentTimeRef.current = nextTime;
    setCurrentTime(nextTime);
    video.currentTime = nextTime;
  }, []);

  const captureCurrentFrame = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    // range 的 onChange 会先更新 state，再等待 video 元素完成 seek；直接读
    // video.currentTime 在这里经常还是上一次的位置，因此会重复抽到首帧/旧帧。
    const timeSec = currentTimeRef.current;
    try {
      // 等待用户最后一次拖动真正解码完成，避免点击截图时仍绘制 seek 前的首帧。
      await waitForSeeked(video, timeSec);
      const dataUrl = await captureVideoFrame({
        source: videoSource ?? videoUrl ?? "",
        timeSec,
        maxWidth: MAX_FRAME_WIDTH,
      }).catch(() => drawVideoFrame(video));
      setFrames((current) => {
        if (current.length >= MAX_FRAMES) {
          return current;
        }
        return [...current, { id: createAssetId(), dataUrl, timeSec }];
      });
    } catch (error) {
      console.warn("[videoFrame] capture failed", error);
    }
  }, [videoSource, videoUrl]);

  const removeFrame = useCallback((frameId: string) => {
    setFrames((current) => current.filter((frame) => frame.id !== frameId));
  }, []);

  const handleInsertFrames = useCallback(async () => {
    if (frames.length === 0) return;
    setIsPreparing(true);
    try {
      const definition = nodeCatalog.getDefinition(CANVAS_NODE_TYPES.upload);
      const defaultData = definition.createDefaultData();
      const preparedFrames: Array<{
        frame: ExtractedFrame;
        prepared: Awaited<ReturnType<typeof prepareNodeImage>>;
      }> = [];
      for (const frame of frames) {
        try {
          preparedFrames.push({ frame, prepared: await prepareNodeImage(frame.dataUrl) });
        } catch (error) {
          console.warn("[videoFrame] prepare frame failed", error);
        }
      }

      const canvasState = useCanvasStore.getState();
      const positions = resolveFrameInsertPositions(
        canvasState.nodes,
        canvasState.currentViewport,
        canvasState.canvasViewportSize,
        preparedFrames.map(({ prepared }) =>
          resolveMinEdgeFittedSize(prepared.aspectRatio, {
            minWidth: EXPORT_RESULT_NODE_MIN_WIDTH,
            minHeight: EXPORT_RESULT_NODE_MIN_HEIGHT,
          }),
        ),
      );

      for (const [index, { frame, prepared }] of preparedFrames.entries()) {
        try {
          addNode(CANVAS_NODE_TYPES.upload, positions[index] ?? { x: 0, y: 0 }, {
            ...defaultData,
            imageUrl: prepared.imageUrl,
            previewImageUrl: prepared.previewImageUrl,
            aspectRatio: prepared.aspectRatio,
            sourceFileName: null,
            displayName: `${videoName || "视频帧"} @${formatTime(frame.timeSec)}`,
          });
        } catch (error) {
          console.warn("[videoFrame] insert frame failed", error);
        }
      }
      onClose();
    } finally {
      setIsPreparing(false);
    }
  }, [addNode, frames, onClose, videoName]);

  const handleSaveToLibrary = useCallback(() => {
    if (frames.length === 0) return;
    void (async () => {
      const saved: Awaited<ReturnType<typeof prepareNodeImage>>[] = [];
      for (const frame of frames) {
        try {
          saved.push(await prepareNodeImage(frame.dataUrl));
        } catch (error) {
          console.warn("[videoFrame] prepare for library failed", error);
        }
      }
      const assets = saved.map((prepared, index) => ({
        id: createAssetId(),
        libraryId: useAssetLibraryStore.getState().activeLibraryId,
        name: `${videoName || "视频帧"} @${formatTime(frames[index].timeSec)}`,
        categoryId: null,
        mediaType: "image" as const,
        sourcePath: prepared.imageUrl,
        previewImageUrl: prepared.previewImageUrl,
        aspectRatio: prepared.aspectRatio,
        sourceFileName: null,
        tags: [],
        createdAt: Date.now(),
      }));
      if (assets.length > 0) {
        addAssets(assets);
      }
      onClose();
    })();
  }, [addAssets, frames, onClose, videoName]);

  const frameCount = frames.length;
  const hasVideo = Boolean(videoUrl);

  return (
    <UiModal
      isOpen={open}
      title={t("videoFrame.title", "视频帧抽取")}
      onClose={onClose}
      widthClassName="w-[680px]"
      footer={
        <>
          <UiButton variant="muted" onClick={onClose}>
            {t("common.cancel", "取消")}
          </UiButton>
          <UiButton variant="muted" onClick={handleSaveToLibrary} disabled={frameCount === 0}>
            {t("videoFrame.saveToLibrary", "存入素材库")}
          </UiButton>
          <UiButton
            variant="primary"
            onClick={() => void handleInsertFrames()}
            disabled={frameCount === 0 || isPreparing}
          >
            {isPreparing
              ? t("videoFrame.preparing", "处理中…")
              : t("videoFrame.insertToCanvas", "插入画布 ({{count}})", { count: frameCount })}
          </UiButton>
        </>
      }
    >
      <div className="space-y-4">
        <input ref={fileInputRef} type="file" accept="video/*" className="hidden" onChange={handleFileChange} />

        {!hasVideo ? (
          <button
            className="flex h-48 w-full flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border-dark text-text-muted transition-colors hover:border-accent/60 hover:text-text-dark"
            onClick={() => void handleSelectVideo()}
          >
            <Film className="h-8 w-8 opacity-60" />
            <span className="text-sm">{t("videoFrame.selectVideo", "选择视频文件")}</span>
          </button>
        ) : (
          <div className="space-y-3">
            <div className="overflow-hidden rounded-xl border border-border-dark bg-black">
              <video
                ref={videoRef}
                src={videoUrl ?? undefined}
                className="max-h-[320px] w-full"
                controls
                draggable={false}
                onDragStart={(event) => event.preventDefault()}
                preload="metadata"
                onLoadedMetadata={handleLoadedMetadata}
                onTimeUpdate={() => {
                  const nextTime = videoRef.current?.currentTime || 0;
                  currentTimeRef.current = nextTime;
                  setCurrentTime(nextTime);
                }}
                onSeeked={() => {
                  const nextTime = videoRef.current?.currentTime || 0;
                  currentTimeRef.current = nextTime;
                  setCurrentTime(nextTime);
                }}
                onError={handleVideoError}
              />
            </div>

            <div className="flex items-center gap-3">
              <span className="min-w-[52px] text-xs tabular-nums text-text-muted">{formatTime(currentTime)}</span>
              <input
                type="range"
                min={0}
                max={Math.max(1, videoDuration || 1)}
                step={0.05}
                value={Math.min(currentTime, videoDuration || 0)}
                onChange={handleSeek}
                className="flex-1 accent-[var(--accent)]"
              />
              <span className="min-w-[52px] text-right text-xs tabular-nums text-text-muted">
                {formatTime(videoDuration)}
              </span>
              <UiButton variant="primary" size="sm" onClick={captureCurrentFrame} disabled={frameCount >= MAX_FRAMES}>
                <Camera className="h-4 w-4" />
                {t("videoFrame.capture", "抽取此帧")}
              </UiButton>
            </div>
          </div>
        )}

        {frameCount > 0 && (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-medium text-text-muted">
                {t("videoFrame.extracted", "已抽取 {{count}} 帧", { count: frameCount })}
              </h3>
            </div>
            <div className="grid max-h-[220px] grid-cols-4 gap-2 overflow-y-auto pr-1">
              {frames.map((frame) => (
                <div key={frame.id} className="group relative overflow-hidden rounded-lg border border-border-dark">
                  <img
                    src={resolveImageDisplayUrl(frame.dataUrl)}
                    alt={`@${formatTime(frame.timeSec)}`}
                    className="aspect-video w-full object-cover"
                    draggable={false}
                  />
                  <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] tabular-nums text-white">
                    {formatTime(frame.timeSec)}
                  </span>
                  <button
                    className="absolute right-1 top-1 rounded-full bg-black/60 p-1 text-white opacity-0 transition-opacity hover:bg-red-500/80 group-hover:opacity-100"
                    onClick={() => removeFrame(frame.id)}
                    title={t("common.delete", "删除")}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
              {frameCount < MAX_FRAMES && (
                <button
                  className="flex aspect-video flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border-dark text-text-muted transition-colors hover:border-accent/60 hover:text-text-dark"
                  onClick={() => void handleSelectVideo()}
                >
                  <Plus className="h-4 w-4" />
                  <span className="text-[10px]">{t("videoFrame.changeVideo", "更换视频")}</span>
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </UiModal>
  );
}
