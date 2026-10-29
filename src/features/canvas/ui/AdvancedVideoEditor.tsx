import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { open as openNativeFile } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import {
  ChevronLeft,
  Diamond,
  Film,
  LoaderCircle,
  Music,
  Pause,
  Play,
  Scissors,
  StepBack,
  StepForward,
  Trash2,
  Type,
  Upload,
  Volume2,
  VolumeX,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import { extractVideoFilmstrip, probeVideoAudio, renderAdvancedVideoEdit } from "@/commands/videoEdit";
import { showErrorDialog } from "@/features/canvas/application/errorDialog";
import { resolveImageDisplayUrl } from "@/features/canvas/application/imageData";
import { isVideoTrackUndecoded } from "@/features/canvas/application/videoPlayback";
import { placeEditedVideoNode } from "@/features/canvas/application/videoEditExport";
import { loadWaveformPeaks } from "@/features/canvas/application/waveform";
import { PropertyRow, PropertySection, PropertySlider } from "@/features/canvas/ui/PropertySlider";
import { Waveform } from "@/features/canvas/ui/Waveform";
import {
  addTitle,
  appendClip,
  buildAdvancedRequest,
  clipDuration,
  clipRanges,
  createAdvancedState,
  duplicateClip,
  findClipAt,
  findTitleAt,
  insertClip,
  minClipTicks,
  moveClipToIndex,
  moveMusic,
  moveTitle,
  removeTitle,
  trimTitleEdge,
  pxToTicks,
  removeClip,
  resolveDropIndex,
  sequenceTicks,
  setMusic,
  setZoom,
  splitAt,
  ticksToPx,
  timelineTicks,
  trimClipEdge,
  trimClipInToPlayhead,
  trimClipOutToPlayhead,
  updateTitle,
  validateAdvancedState,
  KEYFRAME_EASINGS,
  clipKeyframeTicks,
  findKeyframe,
  resetClipTransform,
  resolveClipTransform,
  resolveDropPlan,
  resolveScaleAxes,
  sampleClipTransform,
  setClipKeyframeEasing,
  setClipUniformScale,
  toggleClipKeyframe,
  type AdvancedEditorState,
  type AnimatableProp,
  type KeyframeEasing,
  type TitlePosition,
  updateClipTransform,
} from "@/features/canvas/application/advancedEditor";
import { TICKS_PER_SECOND, formatTimecode, parseProbeFrameRate, ticksToSeconds } from "@/features/canvas/application/mediaTime";
import { isAudioNode, type CanvasNode } from "@/features/canvas/domain/canvasNodes";
import { useCanvasStore } from "@/stores/canvasStore";

const INSPECTOR_TABS = ["video", "audio", "text"] as const;
type InspectorTab = (typeof INSPECTOR_TABS)[number];

const TITLE_POSITIONS: TitlePosition[] = [
  "top-left",
  "top-center",
  "top-right",
  "middle-left",
  "middle-center",
  "middle-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
];

/** 预设色板：白/黑 + 4 个在深色画面上都够醒目的颜色。 */
const TITLE_COLORS = ["#FFFFFF", "#000000", "#FFCC00", "#FF5A5F", "#3DDC97", "#4AA8FF"];

/** 九宫格 → flex 对齐。预览与导出的 drawtext 用同一套位置语义。 */
const TITLE_ALIGN_CLASS: Record<TitlePosition, string> = {
  "top-left": "items-start justify-start text-left",
  "top-center": "items-start justify-center text-center",
  "top-right": "items-start justify-end text-right",
  "middle-left": "items-center justify-start text-left",
  "middle-center": "items-center justify-center text-center",
  "middle-right": "items-center justify-end text-right",
  "bottom-left": "items-end justify-start text-left",
  "bottom-center": "items-end justify-center text-center",
  "bottom-right": "items-end justify-end text-right",
};

/**
 * 预览里的棋盘格（表示透明区域）。
 *
 * 用 `conic-gradient` 两色交错，比叠两层 linear-gradient 省一半声明，缩放时也不会出接缝。
 */
const CHECKERBOARD =
  "repeating-conic-gradient(#20242a 0% 25%, #15181c 0% 50%)";

/** 素材池拖到时间轴用的自定义 MIME：只有自己认，别的窗口拖进来会被忽略。 */
const MEDIA_DRAG_TYPE = "application/x-lentalk-media";

const RULER_HEIGHT = 24;
/** 文字轨：比视频轨矮，但它只是个"贴片"，不需要放缩略图。 */
const TITLE_LANE_HEIGHT = 30;
const VIDEO_LANE_HEIGHT = 62;
const AUDIO_LANE_HEIGHT = 40;
const MUSIC_LANE_HEIGHT = 44;

/** 刻度候选（秒）。取第一个「间隔够宽」的档位，避免刻度挤成一团或稀得没法定位。 */
const RULER_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

interface AdvancedVideoEditorProps {
  open: boolean;
  node: CanvasNode;
  onClose: () => void;
}

interface PoolItem {
  id: string;
  path: string;
  label: string;
  kind: "video" | "audio";
  /** 画布节点上已有的封面帧（视频才有）；没有就退回图标。 */
  thumbUrl: string | null;
  /** 已知时长（tick），0 = 还没探测到。素材池直接显示，不必等点击。 */
  durationTicks: number;
}

/** 时间轴上正在进行的拖动。 */
type DragState =
  | { type: "playhead" }
  | { type: "clip-move"; id: string; startX: number }
  | { type: "clip-trim"; id: string; edge: "start" | "end"; appliedTicks: number; startX: number }
  | { type: "music-move"; startX: number; originTicks: number }
  | { type: "title-move"; id: string; startX: number; originTicks: number }
  | { type: "title-trim"; id: string; edge: "start" | "end" };

/**
 * 预览选框上的拖动。
 *
 * `center` 是**拖动开始时**片段中心的屏幕坐标，整段拖动都用它 —— 拖动过程中
 * 位移/缩放会让中心自己移动，每帧重算会形成正反馈（越拖越飘）。
 */
type PreviewDrag = { clientX0: number; clientY0: number; center: { x: number; y: number } } & (
  | { kind: "move"; originX: number; originY: number }
  | { kind: "uniform"; startDistance: number; originScale: number; originScaleX: number; originScaleY: number }
  | { kind: "rotate"; startAngle: number; origin: number }
  | { kind: "scale-x" | "scale-y"; startDistance: number; origin: number }
);

export function AdvancedVideoEditor({ open, node, onClose }: AdvancedVideoEditorProps) {
  const { t } = useTranslation();

  const canvasNodes = useCanvasStore((state) => state.nodes);
  const addNode = useCanvasStore((state) => state.addNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const findNodePosition = useCanvasStore((state) => state.findNodePosition);

  const nodeSourcePath = useMemo(() => {
    const value = isAudioNode(node) ? node.data.sourcePath : null;
    if (typeof value !== "string" || !value.trim()) return null;
    return node.data.mediaType === "video" ? value : null;
  }, [node]);

  const [state, setState] = useState<AdvancedEditorState>(() => createAdvancedState());
  const [isPlaying, setIsPlaying] = useState(false);
  const [isRendering, setIsRendering] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [durationTicksByPath, setDurationTicksByPath] = useState<Record<string, number>>({});
  const [waveforms, setWaveforms] = useState<Record<string, number[]>>({});
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("video");
  /**
   * 正在拖的素材。`getData()` 在 `dragover` 阶段是**读不到**的（浏览器安全限制），
   * 所以载荷在 `dragstart` 时存到这里，`dragover` 才能算出虚线占位的宽度。
   */
  const dragPayloadRef = useRef<{ path: string; kind: "video" | "audio"; label: string; durationTicks: number } | null>(
    null,
  );
  /**
   * 拖进轨道时的落点预览。
   *
   * `startTicks` 是块在时间轴上的起点，`at` 是给 `addFromPool` 的落点参数 ——
   * 两者语义不同：V1 是「插到第几段之前」（实心序列没有空隙），A2 是「从第几秒开始」。
   */
  const [dropPreview, setDropPreview] = useState<{
    lane: "video" | "audio";
    at: number;
    startTicks: number;
    durationTicks: number;
  } | null>(null);
  const [dragOffsetPx, setDragOffsetPx] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const musicRef = useRef<HTMLAudioElement>(null);
  /** 预览黑框容器，用来按视频比例算它应该占多大。 */
  const previewBoxRef = useRef<HTMLDivElement>(null);
  /** 画布框（棋盘格那层）。拖动换算都以它的 rect 为基准。 */
  const canvasRef = useRef<HTMLDivElement>(null);
  /** 画布在预览里的显示尺寸（px）。文字、选框都以它为准。 */
  const [canvasBox, setCanvasBox] = useState<{ w: number; h: number } | null>(null);
  /** 当前片段「等比放进画布」后的显示尺寸（未叠加用户变换）。 */
  const [clipBox, setClipBox] = useState<{ w: number; h: number } | null>(null);
  /**
   * 画布分辨率（像素）。
   *
   * 后端用**第一段素材**的原始尺寸当画布，这里必须拿到同一份数据，否则
   * ① 画布比例会和导出不一致、② 圆角 px 换算没有基准。第一段是隐藏 video 单独探的。
   */
  const [composition, setComposition] = useState<{ w: number; h: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const laneRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const playheadRef = useRef(0);
  playheadRef.current = state.playheadTicks;
  const pendingSeekRef = useRef<number | null>(null);
  const activePathRef = useRef<string | null>(null);
  /** 源路径 → 已转码成 H.264 的临时文件。HEVC/ProRes 素材 WebView 解不了，转一次缓起来。 */
  const playbackProxyRef = useRef<Record<string, string>>({});
  /** 正在转码的源路径，防止 `onLoadedMetadata` 反复触发重复转码。 */
  const pendingTranscodeRef = useRef<Set<string>>(new Set());
  const playbackHandleRef = useRef<number | null>(null);

  const totalTicks = timelineTicks(state);
  const sequence = sequenceTicks(state.clips);
  const ranges = useMemo(() => clipRanges(state.clips), [state.clips]);
  const activeHit = findClipAt(state.clips, state.playheadTicks);
  const contentWidth = Math.max(240, ticksToPx(Math.max(totalTicks, TICKS_PER_SECOND), state.pixelsPerSecond));
  const minTicks = minClipTicks(state.frameRate);
  const selectedClip = state.clips.find((clip) => clip.id === state.selectedId) ?? null;
  const selectedTitle = state.titles.find((title) => title.id === state.selectedId) ?? null;
  /** 播放头当前落在哪段文字上 —— 预览只显示这一段。 */
  const activeTitle = findTitleAt(state.titles, state.playheadTicks);
  const musicSelected = state.music?.id === state.selectedId;

  /** 播放头所在片段 —— 预览显示的就是它。 */
  const activeClip = activeHit?.clip ?? null;
  /** 第一段素材（后端拿它的原始尺寸当画布，预览要跟它对齐）。 */
  const firstClipPath = state.clips[0]?.sourcePath ?? null;
  /** 选框只在「选中的就是画面上的这一段」时出现：选中的片段不在画面上还画框会误导。 */
  const transformClip = activeClip && selectedClip?.id === activeClip.id ? activeClip : null;
  /**
   * 预览用的变换：**按播放头采样**，不读静态值。
   *
   * 打了关键帧的属性以曲线为准（和导出口径一致）；没打帧的仍是静态值。
   */
  const activeLocalTicks = activeClip && activeHit ? state.playheadTicks - activeHit.start : 0;
  const activeTransform = activeClip
    ? sampleClipTransform(activeClip, activeLocalTicks)
    : resolveClipTransform({});
  const selectedTransform = resolveClipTransform(selectedClip ?? {});
  const selectedAxes = resolveScaleAxes(selectedTransform);
  /** 选中片段在时间轴上的起点（关键帧时间相对片段起点，换算要用它）。 */
  const selectedClipStart = (() => {
    if (!selectedClip) return 0;
    const index = state.clips.findIndex((clip) => clip.id === selectedClip.id);
    if (index <= 0) return 0;
    return state.clips.slice(0, index).reduce((sum, clip) => sum + clipDuration(clip), 0);
  })();
  const keyframeTicks = Math.max(0, state.playheadTicks - selectedClipStart);
  /** 命中容差半帧：播放头一般不会正好落在整帧上。 */
  const keyframeTolerance = minTicks / 2;

  /**
   * 关键帧按钮：空心 = 此刻没有帧（点一下按当前值补一帧）；实心 = 有帧（点一下删掉）。
   *
   * 打帧用的是**当前显示的值**而不是静态值 —— 否则在动画中途补帧会让画面跳一下。
   */
  const keyframeButton = (prop: AnimatableProp, currentValue: number) => {
    if (!selectedClip) return null;
    const at = findKeyframe(selectedClip, prop, keyframeTicks, keyframeTolerance);
    return (
      <button
        type="button"
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors ${
          at ? "text-accent hover:bg-accent/15" : "text-text-muted/60 hover:bg-white/10 hover:text-text-dark"
        }`}
        title={at ? t("advancedEditor.keyframeRemove") : t("advancedEditor.keyframeAdd")}
        onClick={() =>
          setState((current) =>
            toggleClipKeyframe(current, selectedClip.id, prop, keyframeTicks, currentValue, keyframeTolerance),
          )
        }
      >
        <Diamond className={`h-3 w-3 ${at ? "fill-current" : ""}`} />
      </button>
    );
  };

  /** 播放头处有哪些属性打了帧 —— 决定缓动选择器是否可用。 */
  const keyframesAtPlayhead: AnimatableProp[] = selectedClip
    ? (["x", "y", "rotation"] as AnimatableProp[]).filter((prop) =>
        findKeyframe(selectedClip, prop, keyframeTicks, keyframeTolerance),
      )
    : [];
  const easingAtPlayhead = keyframesAtPlayhead.length
    ? findKeyframe(selectedClip ?? {}, keyframesAtPlayhead[0], keyframeTicks, keyframeTolerance)?.easing ?? "linear"
    : "linear";
  const activeAxes = resolveScaleAxes(activeTransform);
  /** 位移换算成预览像素（后端按画布百分比算，两端口径一致）。 */
  const clipOffsetX = canvasBox ? (activeTransform.x / 100) * canvasBox.w : 0;
  const clipOffsetY = canvasBox ? (activeTransform.y / 100) * canvasBox.h : 0;
  /** 圆角是画布像素，预览里要按「画布显示尺寸 / 画布分辨率」等比缩。 */
  const clipRadius = composition && canvasBox
    ? activeTransform.borderRadius * (canvasBox.h / composition.h)
    : activeTransform.borderRadius;

  /** 画布上可用的素材（视频进 V1、音频进 A2）。 */
  const pool = useMemo<PoolItem[]>(() => {
    return canvasNodes
      .filter((candidate) => isAudioNode(candidate) && typeof candidate.data.sourcePath === "string")
      .map((candidate) => {
        const path = candidate.data.sourcePath as string;
        if (!path.trim()) return null;
        const isVideo = candidate.data.mediaType === "video";
        const thumb = candidate.data.previewImageUrl;
        return {
          id: candidate.id,
          path,
          label: candidate.data.displayName?.trim() || path.split(/[\\/]/).pop() || path,
          kind: isVideo ? ("video" as const) : ("audio" as const),
          // 视频节点自己有封面帧（AudioNode 生成并写回 previewImageUrl），直接用。
          thumbUrl: isVideo && typeof thumb === "string" && thumb.trim() ? thumb : null,
          durationTicks: durationTicksByPath[path] ?? 0,
        };
      })
      .filter((item): item is PoolItem => Boolean(item));
    // durationTicksByPath 进依赖：探测完成后素材池要立刻显示时长。
  }, [canvasNodes, durationTicksByPath]);

  const ensureProbe = useCallback(async (path: string): Promise<number> => {
    if (!isTauri()) return 0;
    if (/^https?:\/\//i.test(path)) return 0;
    let durationTicks = 0;
    let rate = null as ReturnType<typeof parseProbeFrameRate>;
    try {
      const result = await probeVideoAudio(path);
      durationTicks = result.durationSec && result.durationSec > 0 ? Math.round(result.durationSec * TICKS_PER_SECOND) : 0;
      rate = result.fps ? parseProbeFrameRate(Math.round(result.fps * 1000), 1000) : null;
    } catch {
      // 探测失败不致命：时长未知时按「追加时给个占位」处理，后端会按真实时长收口。
      durationTicks = 0;
    }
    if (durationTicks > 0) {
      setDurationTicksByPath((current) => (current[path] ? current : { ...current, [path]: durationTicks }));
    }
    if (rate) {
      setState((current) => (current.frameRate ? current : { ...current, frameRate: rate }));
    }
    // 🔴 必须把时长**返回**给调用方：state 的更新是异步的，调用方读闭包里的
    // `durationTicksByPath` 只会拿到旧值（首次全 0），片段会被按 5 秒占位截短。
    return durationTicks;
  }, []);

  // 打开时重置，并把节点自身的视频放进时间线 —— 用户点进来就应该看到素材已经就位。
  useEffect(() => {
    if (!open) return;
    setIsPlaying(false);
    setPreviewError(null);
    setIsRendering(false);
    setDragOffsetPx(0);
    const fresh = createAdvancedState();
    setState(fresh);
    if (!nodeSourcePath) return;
    void (async () => {
      const probed = await ensureProbe(nodeSourcePath);
      setState((current) => {
        if (current.clips.length > 0) return current;
        // 探测失败才用 5 秒占位；后端还会按真实时长收口，不会导出一条超长片段。
        const durationTicks = probed > 0 ? probed : TICKS_PER_SECOND * 5;
        return appendClip(
          { ...current, playheadTicks: 0 },
          {
            sourcePath: nodeSourcePath,
            sourceName: nodeSourcePath.split(/[\\/]/).pop() || nodeSourcePath,
            durationTicks,
          },
        );
      });
    })();
    // 依赖里不能有 durationTicksByPath：它在探测返回后变化，重跑会把片段重复追加一遍。
  }, [open, nodeSourcePath, ensureProbe]);

  // 波形：素材池里的音频 + 时间线上出现的素材都尝试解码一次。
  useEffect(() => {
    if (!open) return;
    const paths = new Set<string>();
    state.clips.forEach((clip) => paths.add(clip.sourcePath));
    if (state.music) paths.add(state.music.sourcePath);
    pool.filter((item) => item.kind === "audio").forEach((item) => paths.add(item.path));
    paths.forEach((path) => {
      if (waveforms[path]) return;
      void loadWaveformPeaks(path).then((peaks) => {
        if (!peaks) return;
        setWaveforms((current) => (current[path] ? current : { ...current, [path]: peaks }));
      });
    });
  }, [open, pool, state.clips, state.music, waveforms]);

  /** 当前播放头下的源素材时间（秒）。 */
  const sourceSecondsFor = useCallback((ticks: number) => {
    const hit = findClipAt(stateRef.current.clips, ticks);
    if (!hit) return null;
    return {
      path: hit.clip.sourcePath,
      seconds: ticksToSeconds(hit.clip.inTicks + (ticks - hit.start)),
      outSeconds: ticksToSeconds(hit.clip.outTicks),
      clipStart: hit.start,
      inTicks: hit.clip.inTicks,
    };
  }, []);

  // 播放头变化 → 同步预览画面。
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const target = sourceSecondsFor(state.playheadTicks);
    if (!target) return;
    const src = resolveImageDisplayUrl(playbackProxyRef.current[target.path] ?? target.path);
    if (activePathRef.current !== target.path) {
      activePathRef.current = target.path;
      video.src = src;
      pendingSeekRef.current = target.seconds;
      return;
    }
    if (!isPlaying && Math.abs(video.currentTime - target.seconds) > 0.05) {
      try {
        video.currentTime = target.seconds;
      } catch {
        // 元数据未就绪时忽略，onLoadedMetadata 会补。
      }
    }
  }, [state.playheadTicks, state.clips, isPlaying, sourceSecondsFor]);

  // 关闭时清掉转码产生的临时文件：它们是 ffmpeg 现转的 H.264 副本，留着只在 temp 里堆积。
  useEffect(() => {
    if (open) return;
    const proxies = Object.values(playbackProxyRef.current);
    playbackProxyRef.current = {};
    pendingTranscodeRef.current.clear();
    for (const path of proxies) {
      void invoke("remove_video_playback_file", { path }).catch(() => undefined);
    }
  }, [open]);

  /**
   * 按视频固有比例在预览黑框里等比适配，算出它的显示尺寸。
   *
   * 之前用 `containerType: "size"` + `max-h-full` 让内层尺寸跟随视频，结果**高度塌陷成 0**：
   * `container-type: size` 会把元素变成尺寸容器、阻断内容撑高，`height:auto` 时就是 0 高，
   * 视频跟着看不见 —— 这就是"预览黑屏"。改成显式用 JS 量出来，简单且确定。
   */
  const fitFrame = useCallback(() => {
    const box = previewBoxRef.current;
    const video = videoRef.current;
    if (!box) return;
    // 画布比例优先用第一段的原始尺寸；还没探到时退到当前视频（单段序列下两者相同）。
    const canvasSource =
      composition ?? (video && video.videoWidth ? { w: video.videoWidth, h: video.videoHeight } : null);
    if (!canvasSource) return;
    // 🔴 `clientWidth/clientHeight` **含内边距**：容器有 `p-3` 时直接用它算会把画布撑大 24px
    // 并被 `overflow-hidden` 裁掉边缘，所以要减掉 padding。
    const style = getComputedStyle(box);
    const availableWidth =
      box.clientWidth - parseFloat(style.paddingLeft || "0") - parseFloat(style.paddingRight || "0");
    const availableHeight =
      box.clientHeight - parseFloat(style.paddingTop || "0") - parseFloat(style.paddingBottom || "0");
    if (availableWidth < 8 || availableHeight < 8) return;
    const scale = Math.min(availableWidth / canvasSource.w, availableHeight / canvasSource.h);
    const canvasWidth = Math.max(1, Math.round(canvasSource.w * scale));
    const canvasHeight = Math.max(1, Math.round(canvasSource.h * scale));
    setCanvasBox({ w: canvasWidth, h: canvasHeight });

    if (video?.videoWidth && video.videoHeight) {
      // 片段再「等比放进画布」：和后端 scale=W:H:decrease 一致，故比例不同就有黑边。
      const inner = Math.min(canvasWidth / video.videoWidth, canvasHeight / video.videoHeight);
      setClipBox({
        w: Math.max(1, Math.round(video.videoWidth * inner)),
        h: Math.max(1, Math.round(video.videoHeight * inner)),
      });
    }
  }, [composition]);

  // 预览窗口尺寸变化时重算（视频比例不变，但黑框会跟着窗口缩）。
  useEffect(() => {
    const box = previewBoxRef.current;
    if (!box) return;
    const observer = new ResizeObserver(() => fitFrame());
    observer.observe(box);
    return () => observer.disconnect();
  }, [fitFrame]);

  const stopPlayback = useCallback(() => {
    if (playbackHandleRef.current !== null) {
      cancelAnimationFrame(playbackHandleRef.current);
      playbackHandleRef.current = null;
    }
    videoRef.current?.pause();
    musicRef.current?.pause();
    setIsPlaying(false);
  }, []);

  /**
   * 播放循环：**由视频元素自己走**，再把 currentTime 映射回时间轴位置。
   *
   * 不用「按墙钟推进、再不断纠正视频」的做法：那样每帧都在拉锯，音画会轻微打嗝。
   * 这里视频是唯一的时钟，跨越片段边界时才换源。
   */
  const tickPlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const current = stateRef.current;
    const target = sourceSecondsFor(playheadRef.current);
    if (!target) {
      stopPlayback();
      return;
    }
    const seconds = video.currentTime;
    if (video.ended || seconds >= target.outSeconds - 0.02) {
      const hit = findClipAt(current.clips, playheadRef.current);
      const nextIndex = hit ? current.clips.findIndex((clip) => clip.id === hit.clip.id) + 1 : -1;
      const next = nextIndex >= 0 ? current.clips[nextIndex] : null;
      if (!next) {
        setState((prev) => ({ ...prev, playheadTicks: sequenceTicks(prev.clips) }));
        stopPlayback();
        return;
      }
      const nextStart = current.clips
        .slice(0, nextIndex)
        .reduce((sum, item) => sum + clipDuration(item), 0);
      setState((prev) => ({ ...prev, playheadTicks: nextStart }));
      playbackHandleRef.current = requestAnimationFrame(tickPlayback);
      return;
    }
    const ticks = target.clipStart + Math.round((seconds - ticksToSeconds(target.inTicks)) * TICKS_PER_SECOND);
    setState((prev) => (Math.abs(prev.playheadTicks - ticks) < 1_000 ? prev : { ...prev, playheadTicks: ticks }));
    playbackHandleRef.current = requestAnimationFrame(tickPlayback);
  }, [sourceSecondsFor, stopPlayback]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (isPlaying) {
      stopPlayback();
      return;
    }
    if (sequenceTicks(stateRef.current.clips) <= 0) return;
    // 停在片尾时从头播。
    if (stateRef.current.playheadTicks >= sequenceTicks(stateRef.current.clips) - 1) {
      setState((current) => ({ ...current, playheadTicks: 0 }));
    }
    setIsPlaying(true);
    const music = musicRef.current;
    if (music && stateRef.current.music) {
      const offset = ticksToSeconds(stateRef.current.music.startTicks);
      const start = Math.max(0, ticksToSeconds(stateRef.current.playheadTicks) - offset);
      try {
        music.currentTime = start;
      } catch {
        // 忽略。
      }
      void music.play().catch(() => undefined);
    }
    void video.play().catch(() => undefined);
    playbackHandleRef.current = requestAnimationFrame(tickPlayback);
  }, [isPlaying, stopPlayback, tickPlayback]);

  useEffect(() => {
    if (!open) {
      stopPlayback();
      return;
    }
    return () => stopPlayback();
  }, [open, stopPlayback]);

  // 播放中换了源（跨片段）→ 恢复播放位置并继续。
  const handleVideoLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const pending = pendingSeekRef.current;
    pendingSeekRef.current = null;
    if (pending !== null) {
      try {
        video.currentTime = pending;
      } catch {
        // 忽略。
      }
    }
    fitFrame();
    // HEVC/ProRes 素材：WebView 会**静默丢掉视频轨**（不报错、只有声音），
    // 判定后转成 H.264 临时文件再重设 src。之前这里传的是 video.src（一个 asset:// 的 URL）
    // 而且把转码结果丢掉了 —— 那等于白转一次，画面永远黑。
    const sourcePath = activePathRef.current;
    if (
      isVideoTrackUndecoded(video) &&
      sourcePath &&
      !playbackProxyRef.current[sourcePath] &&
      !pendingTranscodeRef.current.has(sourcePath)
    ) {
      pendingTranscodeRef.current.add(sourcePath);
      void invoke<string>("prepare_video_playback", { source: sourcePath })
        .then((prepared) => {
          playbackProxyRef.current[sourcePath] = prepared;
          // 重设 src 并强制重载；activePathRef 仍指向源路径，所以下次 seek 也会用代理版。
          video.src = resolveImageDisplayUrl(prepared);
          video.load();
        })
        .catch(() => setPreviewError(t("advancedEditor.previewFailed")))
        .finally(() => pendingTranscodeRef.current.delete(sourcePath));
    }
    if (isPlaying) void video.play().catch(() => undefined);
  }, [fitFrame, isPlaying, t]);

  const seekTo = useCallback((ticks: number) => {
    setState((current) => ({ ...current, playheadTicks: Math.max(0, Math.min(ticks, Math.max(0, totalTicks))) }));
  }, [totalTicks]);

  const stepFrame = useCallback((frames: number) => {
    const perFrame = state.frameRate ? TICKS_PER_SECOND / (state.frameRate.numerator / state.frameRate.denominator) : TICKS_PER_SECOND / 30;
    seekTo(state.playheadTicks + Math.round(frames * perFrame));
  }, [seekTo, state.frameRate, state.playheadTicks]);

  /**
   * 选中什么就切到对应 tab。
   *
   * 不做这件事的话，用户点了时间轴上的文字、右侧还停在「视频」页，会以为没选中。
   * 依赖用 id 而不是对象本身：拖动时对象每帧都变，但"选中变了没"不该跟着抖动。
   */
  useEffect(() => {
    if (!open) return;
    // 从 ref 读当前状态，依赖只留 selectedId：把 titles/music 也列进依赖会在拖动时反复触发。
    const current = stateRef.current;
    const id = current.selectedId;
    if (!id) return;
    if (current.titles.some((title) => title.id === id)) setInspectorTab("text");
    else if (current.music?.id === id) setInspectorTab("audio");
    else setInspectorTab("video");
  }, [open, state.selectedId]);

  const handleSplit = useCallback(() => {
    setState((current) => splitAt(current, current.playheadTicks));
  }, []);

  /** Q 键：裁掉选中片段里播放线左边的部分。 */
  const handleTrimToLeft = useCallback(() => {
    const current = stateRef.current;
    if (!current.selectedId) return;
    setState((cur) => trimClipInToPlayhead(cur, current.selectedId as string, cur.playheadTicks));
  }, []);

  /** W 键：裁掉选中片段里播放线右边的部分。 */
  const handleTrimToRight = useCallback(() => {
    const current = stateRef.current;
    if (!current.selectedId) return;
    setState((cur) => trimClipOutToPlayhead(cur, current.selectedId as string, cur.playheadTicks));
  }, []);

  const handleDelete = useCallback(() => {
    setState((current) => {
      const id = current.selectedId;
      if (!id) return current;
      // 三类对象的 id 不会撞，按顺序认即可。
      if (current.titles.some((title) => title.id === id)) return removeTitle(current, id);
      if (current.music?.id === id) {
        return { ...current, music: null, selectedId: current.clips[0]?.id ?? null };
      }
      return removeClip(current, id);
    });
  }, []);

  const handleDuplicate = useCallback(() => {
    setState((current) => (current.selectedId ? duplicateClip(current, current.selectedId) : current));
  }, []);

  /**
   * 把素材加进时间轴。
   *
   * `at` 的含义随轨道不同：
   * - 视频（V1）→ **插入位置索引**：V1 是首尾相接的实心序列，没有"空隙"可以放；
   * - 音频（A2）→ **起点秒数**：音乐本来就能停在任意位置。
   */
  const addFromPool = useCallback(
    async (item: Pick<PoolItem, "path" | "label" | "kind">, at?: number) => {
      const known = await ensureProbe(item.path);
      const durationTicks = known > 0 ? known : TICKS_PER_SECOND * 5;
      setState((current) => {
        if (item.kind === "audio") {
          return setMusic(current, { sourcePath: item.path, sourceName: item.label, durationTicks }, at ?? 0);
        }
        return insertClip(current, at ?? current.clips.length, {
          sourcePath: item.path,
          sourceName: item.label,
          durationTicks,
        });
      });
    },
    [ensureProbe],
  );

  const importLocal = useCallback(async () => {
    if (!isTauri()) {
      void showErrorDialog(t("advancedEditor.desktopOnly"), t("common.error"));
      return;
    }
    const picked = await openNativeFile({
      multiple: false,
      directory: false,
      filters: [
        { name: t("advancedEditor.videoFilter"), extensions: ["mp4", "mov", "mkv", "webm", "m4v"] },
        { name: t("advancedEditor.audioFilter"), extensions: ["mp3", "m4a", "wav", "aac", "flac", "ogg"] },
      ],
    });
    if (typeof picked !== "string" || !picked.trim()) return;
    const isAudioFile = /\.(mp3|m4a|wav|aac|flac|ogg)$/i.test(picked);
    const known = await ensureProbe(picked);
    const durationTicks = known > 0 ? known : TICKS_PER_SECOND * 5;
    const label = picked.split(/[\\/]/).pop() || picked;
    setState((current) =>
      isAudioFile
        ? setMusic(current, { sourcePath: picked, sourceName: label, durationTicks }, 0)
        : appendClip(current, { sourcePath: picked, sourceName: label, durationTicks }),
    );
  }, [ensureProbe, t]);

  const handleExport = useCallback(async () => {
    const invalid = validateAdvancedState(state, nodeSourcePath);
    if (invalid) {
      void showErrorDialog(t(`advancedEditor.errors.${invalid}`), t("common.error"));
      return;
    }
    if (!isTauri()) {
      void showErrorDialog(t("advancedEditor.desktopOnly"), t("common.error"));
      return;
    }
    setIsRendering(true);
    try {
      const request = buildAdvancedRequest(state, (path) => durationTicksByPath[path] ?? null);
      const result = await renderAdvancedVideoEdit(request);
      placeEditedVideoNode({
        node,
        outputPath: result.outputPath,
        suffix: t("advancedEditor.resultSuffix"),
        fallbackName: t("advancedEditor.defaultResultName"),
        addNode,
        addEdge,
        findNodePosition,
      });
      if (result.warnings?.length) {
        // 不阻断导出：成片已经生成了，只是有地方没做到（比如缺字体）。
        void showErrorDialog(result.warnings.join("\n"), t("advancedEditor.exportWarnings"));
      }
      onClose();
    } catch (error) {
      console.warn("[advancedEditor] render failed", error);
      void showErrorDialog(error instanceof Error ? error.message : String(error), t("common.error"));
    } finally {
      setIsRendering(false);
    }
  }, [addEdge, addNode, durationTicksByPath, findNodePosition, node, nodeSourcePath, onClose, state, t]);

  // ── 时间轴交互 ────────────────────────────────────────────────

  const ticksFromPointer = useCallback((clientX: number) => {
    const lane = laneRef.current;
    if (!lane) return 0;
    const rect = lane.getBoundingClientRect();
    return Math.max(0, pxToTicks(clientX - rect.left, stateRef.current.pixelsPerSecond));
  }, []);

  /**
   * 素材池拖进轨道。
   *
   * 用原生 HTML5 拖放而不是自己实现一套：拖动过程中浏览器会给出 `dragover`/`drop`，
   * 而且用户已经熟悉"拖到哪儿放哪儿"。落点用**指针的 clientX** 换算，和点时间轴同一套换算。
   */
  /**
   * 把「指针位置 + 目标轨」换算成落点（真正的算子在模型层 `resolveDropPlan`）。
   *
   * 预览和落子都走这里，保证虚线画在哪儿、东西就落在哪儿。
   */
  const describeDrop = useCallback(
    (clientX: number, lane: "video" | "audio", material: { kind: "video" | "audio"; durationTicks: number }) =>
      resolveDropPlan(
        stateRef.current.clips,
        ticksFromPointer(clientX),
        lane,
        material.kind,
        material.durationTicks,
        TICKS_PER_SECOND * 5,
      ),
    [ticksFromPointer],
  );

  /** 拖动经过轨道：算出落点并刷新虚线预览（值没变就不 setState，避免每帧重渲染）。 */
  const handleLaneDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>, lane: "video" | "audio") => {
      const payload = dragPayloadRef.current;
      // 只认自己拖的素材：`types` 在 dragover 阶段可读。
      if (!payload || !Array.from(event.dataTransfer.types).includes(MEDIA_DRAG_TYPE)) return;
      // 不 preventDefault 的话浏览器不会触发 drop（默认行为是「禁止放置」）。
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      // 时长优先用实时探测值：dragstart 时可能还没探到，拖动过程中才补上。
      const durationTicks = durationTicksByPath[payload.path] || payload.durationTicks;
      const plan = describeDrop(event.clientX, lane, { kind: payload.kind, durationTicks });
      setDropPreview((current) =>
        current &&
        current.lane === plan.lane &&
        current.startTicks === plan.startTicks &&
        current.durationTicks === plan.durationTicks
          ? current
          : plan,
      );
    },
    [describeDrop, durationTicksByPath],
  );

  const handleLaneDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    // 指针移到轨道内的子元素上也会触发 dragleave，只有真正离开轨道才清。
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setDropPreview(null);
  }, []);

  const handleLaneDrop = useCallback(
    async (event: React.DragEvent<HTMLDivElement>, lane: "video" | "audio") => {
      const raw = event.dataTransfer.getData(MEDIA_DRAG_TYPE);
      setDropPreview(null);
      dragPayloadRef.current = null;
      if (!raw) return;
      event.preventDefault();
      let payload: { path: string; kind: "video" | "audio"; label: string; durationTicks?: number };
      try {
        payload = JSON.parse(raw) as typeof payload;
      } catch {
        return;
      }
      const durationTicks = durationTicksByPath[payload.path] || payload.durationTicks || 0;
      const plan = describeDrop(event.clientX, lane, { kind: payload.kind, durationTicks });
      await addFromPool(payload, plan.at);
    },
    [addFromPool, describeDrop, durationTicksByPath],
  );

  // ── 预览选框拖动 ────────────────────────────────────────
  /**
   * 预览里的拖动状态。
   *
   * 所有比例都用「指针相对**片段中心**的距离」算，而不是相对画布左上角：
   * 绕中心缩放才符合直觉，也和后端 `rotate` 的默认中心一致。
   */
  const previewDragRef = useRef<PreviewDrag | null>(null);
  /** 拖动过就不当成点击（否则一拖就把播放暂停了）。 */
  const previewMovedRef = useRef(false);

  /** 片段中心在屏幕上的位置：画布中心 + 位移。 */
  const clipCenterOnScreen = useCallback(() => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return {
      x: rect.left + rect.width / 2 + clipOffsetX,
      y: rect.top + rect.height / 2 + clipOffsetY,
    };
  }, [clipOffsetX, clipOffsetY]);

  const beginPreviewDrag = useCallback(
    (event: React.PointerEvent, kind: PreviewDrag["kind"]) => {
      const current = stateRef.current;
      const id = current.selectedId;
      if (!id) return;
      event.stopPropagation();
      event.preventDefault();
      const clip = current.clips.find((item) => item.id === id);
      if (!clip) return;
      const transform = resolveClipTransform(clip);
      const axes = resolveScaleAxes(transform);
      const center = clipCenterOnScreen();
      if (!center) return;

      previewMovedRef.current = false;
      const base = { clientX0: event.clientX, clientY0: event.clientY, center };
      const dx = event.clientX - center.x;
      const dy = event.clientY - center.y;
      const startAngle = (Math.atan2(dy, dx) * 180) / Math.PI;

      previewDragRef.current =
        kind === "move"
          ? { kind, ...base, originX: transform.x, originY: transform.y }
          : kind === "uniform"
            ? {
                kind,
                ...base,
                startDistance: Math.hypot(dx, dy),
                originScale: transform.scale,
                originScaleX: axes.scaleX,
                originScaleY: axes.scaleY,
              }
            : kind === "rotate"
              ? { kind, ...base, startAngle, origin: transform.rotation }
              : kind === "scale-x"
                ? { kind, ...base, startDistance: Math.abs(dx), origin: axes.scaleX }
                : { kind, ...base, startDistance: Math.abs(dy), origin: axes.scaleY };

      // 把指针捕获到画布上：手柄自己会随拖动移走，捕获在画布上才不会中途丢事件。
      canvasRef.current?.setPointerCapture(event.pointerId);
    },
    [clipCenterOnScreen],
  );

  const handlePreviewPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const drag = previewDragRef.current;
      if (!drag) return;
      const id = stateRef.current.selectedId;
      if (!id) return;
      if (
        Math.abs(event.clientX - drag.clientX0) > 3 ||
        Math.abs(event.clientY - drag.clientY0) > 3
      ) {
        previewMovedRef.current = true;
      }

      if (drag.kind === "move") {
        // 百分比换算用画布框的显示尺寸：窗口缩放不影响结果。
        const width = canvasRef.current?.clientWidth || 1;
        const height = canvasRef.current?.clientHeight || 1;
        const dx = ((event.clientX - drag.clientX0) / width) * 100;
        const dy = ((event.clientY - drag.clientY0) / height) * 100;
        setState((current) =>
          updateClipTransform(current, id, { x: drag.originX + dx, y: drag.originY + dy }),
        );
        return;
      }

      const dx = event.clientX - drag.center.x;
      const dy = event.clientY - drag.center.y;

      if (drag.kind === "rotate") {
        const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
        // 跨过 ±180° 时角度会跳 360°，取最短差值再累加。
        let delta = angle - drag.startAngle;
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        const next = drag.origin + delta;
        // Shift = 吸附 15°，和别家剪辑软件一致。
        const snapped = event.shiftKey ? Math.round(next / 15) * 15 : next;
        setState((current) => updateClipTransform(current, id, { rotation: snapped }));
        return;
      }

      if (drag.kind === "uniform") {
        const distance = Math.hypot(dx, dy);
        if (drag.startDistance < 2) return;
        const factor = distance / drag.startDistance;
        setState((current) =>
          updateClipTransform(current, id, {
            scale: drag.originScale * factor,
            scaleX: drag.originScaleX * factor,
            scaleY: drag.originScaleY * factor,
          }),
        );
        return;
      }

      // 单轴：只按这一轴到中心的距离比例缩放。
      const distance = drag.kind === "scale-x" ? Math.abs(dx) : Math.abs(dy);
      if (drag.startDistance < 2) return;
      const factor = distance / drag.startDistance;
      setState((current) =>
        updateClipTransform(
          current,
          id,
          drag.kind === "scale-x" ? { scaleX: drag.origin * factor } : { scaleY: drag.origin * factor },
        ),
      );
    },
    [],
  );

  const endPreviewDrag = useCallback((event: React.PointerEvent) => {
    if (!previewDragRef.current) return;
    previewDragRef.current = null;
    if (canvasRef.current?.hasPointerCapture(event.pointerId)) {
      canvasRef.current.releasePointerCapture(event.pointerId);
    }
    // click 在 pointerup 之后触发，这里排到宏任务里清标记：既能让这一次 click 被忽略，
    // 又不会出现「拖完一次之后点击永久失灵」。
    setTimeout(() => {
      previewMovedRef.current = false;
    }, 0);
  }, []);

  const handlePreviewClick = useCallback(() => {
    // 刚拖过就不算点击。
    if (previewMovedRef.current) {
      previewMovedRef.current = false;
      return;
    }
    togglePlay();
  }, [togglePlay]);

  const beginDrag = useCallback(
    (drag: DragState) => (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault();
      // 🔴 起点一律取真实 clientX。调用点若写成 0，第一次 move 会把「绝对坐标」当成位移，
      // 片段瞬间被裁到边界（症状：一碰手柄就跳到底）。
      dragRef.current = "startX" in drag ? { ...drag, startX: event.clientX } : drag;
      setDragOffsetPx(0);
      laneRef.current?.setPointerCapture(event.pointerId);
    },
    [],
  );

  const handleLanePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // 只响应左键：右键/中键留给以后的上下文菜单与手动平移。
      if (event.button !== 0) return;
      // 点哪儿先跳到哪儿，并**立刻进入拖动状态** —— 按住不放继续横向拖动就是擦洗，
      // 不需要非得抓住那条 1px 的播放线。
      seekTo(ticksFromPointer(event.clientX));
      dragRef.current = { type: "playhead" };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [seekTo, ticksFromPointer],
  );

  const handleLanePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.type === "playhead") {
        seekTo(ticksFromPointer(event.clientX));
        return;
      }
      if (drag.type === "clip-move") {
        setDragOffsetPx(event.clientX - drag.startX);
        return;
      }
      if (drag.type === "music-move") {
        const deltaTicks = pxToTicks(event.clientX - drag.startX, stateRef.current.pixelsPerSecond);
        setState((current) => moveMusic(current, drag.originTicks + deltaTicks));
        return;
      }
      if (drag.type === "title-move") {
        const deltaTicks = pxToTicks(event.clientX - drag.startX, stateRef.current.pixelsPerSecond);
        setState((current) => moveTitle(current, drag.id, drag.originTicks + deltaTicks));
        return;
      }
      if (drag.type === "title-trim") {
        // 文字的入出点可以按**绝对位置**算（它没有 in/out 偏移，只有时间轴位置），
        // 不像视频片段要按增量施加。
        const ticks = ticksFromPointer(event.clientX);
        setState((current) => trimTitleEdge(current, drag.id, drag.edge, ticks, current.frameRate));
        return;
      }
      // 逐次施加增量：直接按起点算会在多次 move 后重复累加。
      const deltaTicks = pxToTicks(event.clientX - drag.startX, stateRef.current.pixelsPerSecond);
      const step = deltaTicks - drag.appliedTicks;
      dragRef.current = { ...drag, appliedTicks: deltaTicks };
      setState((current) => trimClipEdge(current, drag.id, drag.edge, step));
    },
    [seekTo, ticksFromPointer],
  );

  const endDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!drag) return;
      if (drag.type === "clip-move") {
        const ticks = ticksFromPointer(event.clientX);
        const target = resolveDropIndex(stateRef.current.clips, ticks);
        setState((current) => moveClipToIndex(current, drag.id, target));
      }
      setDragOffsetPx(0);
    },
    [ticksFromPointer],
  );

  /**
   * 快捷键走**窗口捕获阶段**，而不是 React 的 onKeyDown。
   *
   * 原因是画布在 `document` 上挂了全局 keydown（Delete = 删除选中节点）。React 的合成事件
   * 走完自己的根容器后，原生事件还会继续冒泡到 document —— 只 preventDefault 拦不住，
   * 结果是「在剪辑器里按 Delete，整个视频节点被删掉」。捕获阶段先截断才是确定的行为。
   */
  const keyActionsRef = useRef({
    togglePlay,
    stepFrame,
    handleSplit,
    handleDelete,
    handleTrimToLeft,
    handleTrimToRight,
    onClose,
  });
  keyActionsRef.current = {
    togglePlay,
    stepFrame,
    handleSplit,
    handleDelete,
    handleTrimToLeft,
    handleTrimToRight,
    onClose,
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // 正在输入（含时间码、滑块的键盘调整）时一律不抢键。
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
          actions.handleSplit();
          break;
        case "b":
        case "B":
          // Ctrl/⌘+B = 切一刀（剪辑软件通用）。
          if (event.ctrlKey || event.metaKey) {
            actions.handleSplit();
            break;
          }
          return;
        case "q":
        case "Q":
          actions.handleTrimToLeft();
          break;
        case "w":
        case "W":
          actions.handleTrimToRight();
          break;
        case "Delete":
        case "Backspace":
          actions.handleDelete();
          break;
        case "Escape":
          actions.onClose();
          break;
        default:
          // 不是我们处理的键：原样放行，别影响画布/输入框。
          return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  if (!open) return null;

  const rulerStep = RULER_STEPS.find((step) => step * state.pixelsPerSecond >= 64) ?? RULER_STEPS[RULER_STEPS.length - 1];
  const rulerCount = Math.ceil(ticksToSeconds(totalTicks) / rulerStep) + 1;
  const playheadLeft = ticksToPx(state.playheadTicks, state.pixelsPerSecond);
  const musicPeaks = state.music ? (waveforms[state.music.sourcePath] ?? null) : null;

  /*
   * 必须 portal 到 body。
   *
   * 这个组件挂在节点工具栏里，而工具栏是 React Flow 的 `NodeToolbar` —— 它用
   * `transform: translate(...)` 定位。有 transform 祖先时 `position: fixed` 会相对**祖先**
   * 而不是视口定位，`inset-0` 于是只填满那个几百像素的工具栏容器：
   * 表现为「点了【高级剪辑】什么都不出来」。
   *
   * 层级同时抬到 z-[200]：基础弹窗是 UiModal（z-140），覆盖层必须压在它上面。
   */
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="nodrag nowheel fixed inset-0 z-[200] flex flex-col bg-[#0b0c0f] text-text-dark"
      tabIndex={0}
      role="dialog"
      aria-label={t("advancedEditor.title")}
    >
      {/*
        顶栏只留「返回 / 标题 / 导出 / 关闭」四样。
        原来这里还挤着缩放两个按钮，加上导出和关闭一共五组，右上角很满；
        缩放挪到时间轴工具条，离它影响的区域更近。
      */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-white/10 pl-2 pr-3">
        <button
          type="button"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-text-muted transition-colors hover:bg-white/10 hover:text-text-dark"
          onClick={onClose}
          title={t("advancedEditor.back")}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="truncate text-xs font-medium">
            {node.data.displayName?.trim() || t("advancedEditor.untitled")}
          </span>
          <span className="shrink-0 text-[10px] tabular-nums text-text-muted">
            {formatTimecode(state.playheadTicks, state.frameRate)} / {formatTimecode(sequence, state.frameRate)}
          </span>
        </div>
        <button
          type="button"
          disabled={isRendering}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
          onClick={() => void handleExport()}
        >
          {isRendering ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Scissors className="h-3.5 w-3.5" />}
          {isRendering ? t("advancedEditor.exporting") : t("advancedEditor.export")}
        </button>
        <button
          type="button"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-text-muted transition-colors hover:bg-white/10 hover:text-text-dark"
          onClick={onClose}
          title={t("common.close")}
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      {/* ── 主体：素材池 / 预览 / 属性 ─────────────────────────── */}
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[252px] shrink-0 flex-col border-r border-white/10">
          <div className="flex h-9 shrink-0 items-center justify-between px-3 text-[11px] font-medium uppercase tracking-wide text-text-muted">
            {t("advancedEditor.pool")}
            <button
              type="button"
              className="flex h-6 w-6 items-center justify-center rounded text-text-muted hover:bg-white/10 hover:text-text-dark"
              title={t("advancedEditor.import")}
              onClick={() => void importLocal()}
            >
              <Upload className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {pool.length === 0 && (
              <p className="px-1 py-2 text-[11px] leading-5 text-text-muted/70">{t("advancedEditor.poolEmpty")}</p>
            )}
            {/* 缩略图网格：视频用节点自己的封面帧，音频没有封面就退到波形图标。 */}
            <div className="grid grid-cols-2 gap-2">
              {pool.map((item) => {
                const known = item.durationTicks || durationTicksByPath[item.path] || 0;
                return (
                  <div
                    key={item.id}
                    draggable
                    onDragStart={(event) => {
                      // 拖拽是主路径，点击仍然保留（不想拖的人点一下也能加）。
                      const known = durationTicksByPath[item.path] || item.durationTicks || 0;
                      const payload = {
                        path: item.path,
                        kind: item.kind,
                        label: item.label,
                        durationTicks: known,
                      };
                      event.dataTransfer.setData(MEDIA_DRAG_TYPE, JSON.stringify(payload));
                      event.dataTransfer.effectAllowed = "copy";
                      // dragover 阶段读不到 getData，载荷必须自己存一份。
                      dragPayloadRef.current = payload;
                      // 还没探到时长就顺手探一下：拖动过程中虚线块会从「默认 5 秒」变成真实宽度。
                      if (!known) void ensureProbe(item.path);
                    }}
                    onDragEnd={() => {
                      dragPayloadRef.current = null;
                      setDropPreview(null);
                    }}
                    onClick={() => void addFromPool(item)}
                    title={`${item.label}\n${t("advancedEditor.dragHint")}`}
                    className="group cursor-grab overflow-hidden rounded-md border border-white/10 bg-white/[0.03] transition-colors hover:border-accent/50 hover:bg-accent/10 active:cursor-grabbing"
                  >
                    <div className="relative aspect-video bg-black/50">
                      {item.thumbUrl ? (
                        <img
                          src={resolveImageDisplayUrl(item.thumbUrl)}
                          alt=""
                          draggable={false}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <span className="flex h-full w-full items-center justify-center text-text-muted/70">
                          {item.kind === "video" ? <Film className="h-4 w-4" /> : <Music className="h-4 w-4" />}
                        </span>
                      )}
                      <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[9px] tabular-nums text-white/85">
                        {known > 0 ? ticksToSeconds(known).toFixed(1) + "s" : "—"}
                      </span>
                    </div>
                    <div className="truncate px-1.5 py-1 text-[10px] text-text-dark/90">{item.label}</div>
                  </div>
                );
              })}
            </div>

            <button
              type="button"
              className="mt-2 flex h-8 w-full items-center justify-center gap-1 rounded-md border border-dashed border-white/15 text-[11px] text-text-muted transition-colors hover:border-accent/60 hover:text-text-dark"
              onClick={() => setState((current) => addTitle(current, current.playheadTicks))}
            >
              <Type className="h-3.5 w-3.5" />
              {t("advancedEditor.addText")}
            </button>
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          {/*
            预览用 grid + 内层相对定位：内层尺寸由 video 的固有比例撑出来，
            文字叠在 `absolute inset-0` 上才能精确贴合画面。
            换成 flex + `max-h-full max-w-full` 的话，video 的实际显示区小于容器，
            文字会落到黑边上（竖屏素材尤其明显）。
          */}
          <div
            ref={previewBoxRef}
            className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[#0d0f12] p-3"
          >
            {activeHit ? (
              // 外层不裁切（选框的手柄要能露到画布外），内层裁切（超出画布的画面必须切掉）。
              <div
                className="relative shrink-0"
                style={canvasBox ? { width: canvasBox.w, height: canvasBox.h } : { width: "100%", height: "100%" }}
              >
                <div
                  ref={canvasRef}
                  className="absolute inset-0 overflow-hidden rounded-sm"
                  style={{
                    // 棋盘格 = 透明。片段缩小/旋转后露出的部分必须看得出来是「空的」，
                    // 否则会被误认为画面本身是黑的。
                    backgroundImage: CHECKERBOARD,
                    backgroundSize: "16px 16px",
                    touchAction: "none",
                  }}
                  onPointerMove={handlePreviewPointerMove}
                  onPointerUp={endPreviewDrag}
                  onPointerCancel={endPreviewDrag}
                >
                  <video
                    ref={videoRef}
                    className="block"
                    preload="metadata"
                    onClick={handlePreviewClick}
                    onLoadedMetadata={handleVideoLoadedMetadata}
                    onError={() => setPreviewError(t("advancedEditor.previewFailed"))}
                    style={
                      clipBox && canvasBox
                        ? {
                            position: "absolute",
                            left: (canvasBox.w - clipBox.w) / 2,
                            top: (canvasBox.h - clipBox.h) / 2,
                            width: clipBox.w,
                            height: clipBox.h,
                            // 顺序 = 缩放 → 旋转 → 位移，和后端滤镜链完全一致。
                            transform: `translate(${clipOffsetX}px, ${clipOffsetY}px) rotate(${activeTransform.rotation}deg) scale(${activeAxes.scaleX}, ${activeAxes.scaleY})`,
                            transformOrigin: "center center",
                            opacity: activeTransform.opacity,
                            borderRadius: clipRadius,
                          }
                        : { width: "100%", height: "100%", objectFit: "contain" }
                    }
                  />

                  {activeTitle && canvasBox && (
                    <div
                      className={`pointer-events-none absolute inset-0 flex p-[3%] ${
                        TITLE_ALIGN_CLASS[activeTitle.position]
                      }`}
                    >
                      <span
                        className={`max-w-full whitespace-pre-wrap break-words text-center leading-snug ${
                          activeTitle.backdrop ? "rounded bg-black/45 px-2 py-1" : ""
                        }`}
                        style={{
                          // 字号按 1080p 设计，按「预览实际高度 / 1080」缩放成 px。
                          fontSize: Math.max(10, Math.round((activeTitle.fontSize / 1080) * canvasBox.h)),
                          color: activeTitle.color,
                        }}
                      >
                        {activeTitle.text}
                      </span>
                    </div>
                  )}
                </div>

                {/* 选框：和视频用同一套变换，所以框永远贴着实际画面。 */}
                {transformClip && canvasBox && clipBox && (
                  <div
                    className="absolute"
                    style={{
                      left: (canvasBox.w - clipBox.w) / 2,
                      top: (canvasBox.h - clipBox.h) / 2,
                      width: clipBox.w,
                      height: clipBox.h,
                      transform: `translate(${clipOffsetX}px, ${clipOffsetY}px) rotate(${activeTransform.rotation}deg) scale(${activeAxes.scaleX}, ${activeAxes.scaleY})`,
                      transformOrigin: "center center",
                      // 透明度只影响画面，选框必须始终看得见。
                      pointerEvents: activeTransform.opacity < 0.05 ? "auto" : undefined,
                    }}
                  >
                    <div
                      className="absolute inset-0 cursor-move border border-accent"
                      onPointerDown={(event) => beginPreviewDrag(event, "move")}
                      // 选中时画面上盖着这层，点击事件到不了 video —— 在这里补上播放/暂停。
                      onClick={handlePreviewClick}
                    />
                    <SelectionHandles
                      scaleX={activeAxes.scaleX}
                      scaleY={activeAxes.scaleY}
                      onDrag={beginPreviewDrag}
                    />
                  </div>
                )}
              </div>
            ) : (
              <p className="text-xs text-text-muted">{t("advancedEditor.previewEmpty")}</p>
            )}

            {/*
              隐藏 video：只读第一段素材的原始尺寸，用来确定画布分辨率。
              后端用第一段的尺寸当画布，这里拿到同一份数据，画布比例与圆角换算才对得上。
            */}
            {firstClipPath && (
              <video
                className="pointer-events-none absolute h-px w-px opacity-0"
                preload="metadata"
                src={resolveImageDisplayUrl(playbackProxyRef.current[firstClipPath] ?? firstClipPath)}
                onLoadedMetadata={(event) => {
                  const element = event.currentTarget;
                  if (!element.videoWidth || !element.videoHeight) return;
                  setComposition((current) =>
                    current && current.w === element.videoWidth && current.h === element.videoHeight
                      ? current
                      : { w: element.videoWidth, h: element.videoHeight },
                  );
                }}
              />
            )}
            {state.music && (
              <audio
                ref={musicRef}
                src={resolveImageDisplayUrl(state.music.sourcePath)}
                preload="metadata"
                onError={() => undefined}
              />
            )}
            {previewError && (
              <p className="absolute bottom-2 left-2 right-2 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">
                {previewError}
              </p>
            )}
          </div>
          <div className="flex h-10 shrink-0 items-center justify-center gap-1 border-t border-white/10">
            <button
              type="button"
              className="flex h-7 w-7 items-center justify-center rounded text-text-muted hover:bg-white/10 hover:text-text-dark"
              onClick={() => stepFrame(-1)}
              title={t("advancedEditor.prevFrame")}
            >
              <StepBack className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-text-dark hover:bg-white/20"
              onClick={togglePlay}
              title={isPlaying ? t("advancedEditor.pause") : t("advancedEditor.play")}
            >
              {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </button>
            <button
              type="button"
              className="flex h-7 w-7 items-center justify-center rounded text-text-muted hover:bg-white/10 hover:text-text-dark"
              onClick={() => stepFrame(1)}
              title={t("advancedEditor.nextFrame")}
            >
              <StepForward className="h-3.5 w-3.5" />
            </button>
            <span className="ml-3 text-[11px] tabular-nums text-text-muted">
              {formatTimecode(state.playheadTicks, state.frameRate)}
            </span>
          </div>
        </section>

        <aside className="flex w-[248px] shrink-0 flex-col border-l border-white/10">
          {/* 三个 tab 对应三类可编辑对象；选中什么会自动切到对应 tab（见上面的 effect）。 */}
          <div className="flex h-9 shrink-0 items-center gap-1 px-2">
            {INSPECTOR_TABS.map((tab) => (
              <button
                key={tab}
                type="button"
                className={`h-6 rounded px-2 text-[11px] transition-colors ${
                  inspectorTab === tab ? "bg-white/15 text-text-dark" : "text-text-muted hover:text-text-dark"
                }`}
                onClick={() => setInspectorTab(tab)}
              >
                {t(`advancedEditor.tab_${tab}`)}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3 text-[11px]">
            {/* ── 视频 ── */}
            {inspectorTab === "video" &&
              (selectedClip ? (
                <>
                  <div className="truncate text-text-dark" title={selectedClip.sourcePath}>
                    {selectedClip.sourceName}
                  </div>
                  {/* ── 变换 ── 后端是真的按这些值滤镜渲染的，不是只改预览。 */}
                  <div className="space-y-1.5 rounded-md border border-white/[0.06] bg-white/[0.02] p-2">
                    <div className="flex items-center justify-between">
                      <span className="text-text-dark">{t("advancedEditor.transform")}</span>
                      <button
                        type="button"
                        className="text-[10px] text-text-muted transition-colors hover:text-text-dark"
                        onClick={() => setState((current) => resetClipTransform(current, selectedClip.id))}
                      >
                        {t("advancedEditor.transformReset")}
                      </button>
                    </div>

                    <PropertySlider
                      label={t("advancedEditor.transformScale")}
                      value={selectedTransform.scale}
                      min={0.05}
                      max={8}
                      step={0.01}
                      displayScale={100}
                      suffix="%"
                      defaultValue={1}
                      onChange={(value) => setState((current) => setClipUniformScale(current, selectedClip.id, value))}
                    />
                    <PropertySlider
                      label={t("advancedEditor.transformScaleX")}
                      value={selectedAxes.scaleX}
                      min={0.05}
                      max={8}
                      step={0.01}
                      displayScale={100}
                      suffix="%"
                      defaultValue={1}
                      onChange={(value) =>
                        setState((current) => updateClipTransform(current, selectedClip.id, { scaleX: value }))
                      }
                    />
                    <PropertySlider
                      label={t("advancedEditor.transformScaleY")}
                      value={selectedAxes.scaleY}
                      min={0.05}
                      max={8}
                      step={0.01}
                      displayScale={100}
                      suffix="%"
                      defaultValue={1}
                      onChange={(value) =>
                        setState((current) => updateClipTransform(current, selectedClip.id, { scaleY: value }))
                      }
                    />
                    <PropertySlider
                      label={t("advancedEditor.transformX")}
                      value={sampleClipTransform(selectedClip, keyframeTicks).x}
                      min={-100}
                      max={100}
                      step={0.5}
                      suffix="%"
                      defaultValue={0}
                      trailing={keyframeButton("x", sampleClipTransform(selectedClip, keyframeTicks).x)}
                      onChange={(value) =>
                        setState((current) => updateClipTransform(current, selectedClip.id, { x: value }))
                      }
                    />
                    <PropertySlider
                      label={t("advancedEditor.transformY")}
                      value={sampleClipTransform(selectedClip, keyframeTicks).y}
                      min={-100}
                      max={100}
                      step={0.5}
                      suffix="%"
                      defaultValue={0}
                      trailing={keyframeButton("y", sampleClipTransform(selectedClip, keyframeTicks).y)}
                      onChange={(value) =>
                        setState((current) => updateClipTransform(current, selectedClip.id, { y: value }))
                      }
                    />
                    <PropertySlider
                      label={t("advancedEditor.transformRotation")}
                      value={sampleClipTransform(selectedClip, keyframeTicks).rotation}
                      min={-180}
                      max={180}
                      step={1}
                      suffix="°"
                      defaultValue={0}
                      trailing={keyframeButton("rotation", sampleClipTransform(selectedClip, keyframeTicks).rotation)}
                      onChange={(value) =>
                        setState((current) => updateClipTransform(current, selectedClip.id, { rotation: value }))
                      }
                    />
                    <PropertySlider
                      label={t("advancedEditor.transformOpacity")}
                      value={selectedTransform.opacity}
                      min={0}
                      max={1}
                      step={0.01}
                      displayScale={100}
                      suffix="%"
                      defaultValue={1}
                      onChange={(value) =>
                        setState((current) => updateClipTransform(current, selectedClip.id, { opacity: value }))
                      }
                    />
                    <PropertySlider
                      label={t("advancedEditor.transformRadius")}
                      value={selectedTransform.borderRadius}
                      min={0}
                      max={400}
                      step={1}
                      suffix="px"
                      defaultValue={0}
                      onChange={(value) =>
                        setState((current) => updateClipTransform(current, selectedClip.id, { borderRadius: value }))
                      }
                    />

                    {/* 缓动：作用于「播放头这一刻」存在的所有关键帧（通常一次只调一个属性）。 */}
                    <div className="flex items-center justify-between pt-0.5">
                      <span className={keyframesAtPlayhead.length ? "text-text-muted" : "text-text-muted/40"}>
                        {t("advancedEditor.keyframeEasing")}
                      </span>
                      <select
                        disabled={!keyframesAtPlayhead.length}
                        value={easingAtPlayhead}
                        onChange={(event) => {
                          const easing = event.target.value as KeyframeEasing;
                          setState((current) =>
                            keyframesAtPlayhead.reduce(
                              (next, prop) =>
                                setClipKeyframeEasing(next, selectedClip.id, prop, keyframeTicks, easing, keyframeTolerance),
                              current,
                            ),
                          );
                        }}
                        className="h-6 rounded border border-white/10 bg-black/40 px-1 text-[10px] text-text-dark disabled:opacity-40"
                      >
                        {KEYFRAME_EASINGS.map((easing) => (
                          <option key={easing} value={easing}>
                            {t(`advancedEditor.easing_${easing}`)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <PropertyRow label={t("advancedEditor.inPoint")} value={formatTimecode(selectedClip.inTicks, state.frameRate)} />
                  <PropertyRow label={t("advancedEditor.outPoint")} value={formatTimecode(selectedClip.outTicks, state.frameRate)} />
                  <PropertyRow
                    label={t("advancedEditor.clipDuration")}
                    value={formatTimecode(clipDuration(selectedClip), state.frameRate)}
                  />
                  <div className="flex gap-1 pt-1">
                    <button
                      type="button"
                      className="flex-1 rounded border border-white/10 py-1 text-[11px] hover:border-accent/50"
                      onClick={() => setState((current) => trimClipEdge(current, selectedClip.id, "end", -minTicks))}
                    >
                      −{t("advancedEditor.oneFrame")}
                    </button>
                    <button
                      type="button"
                      className="flex-1 rounded border border-white/10 py-1 text-[11px] hover:border-accent/50"
                      onClick={() => setState((current) => trimClipEdge(current, selectedClip.id, "end", minTicks))}
                    >
                      +{t("advancedEditor.oneFrame")}
                    </button>
                  </div>
                  <div className="flex gap-1 pt-1">
                    <button
                      type="button"
                      className="flex-1 rounded border border-white/10 py-1 text-[11px] hover:border-accent/50"
                      onClick={handleSplit}
                    >
                      {t("advancedEditor.split")}
                    </button>
                    <button
                      type="button"
                      className="flex-1 rounded border border-white/10 py-1 text-[11px] hover:border-accent/50"
                      onClick={handleDuplicate}
                    >
                      {t("advancedEditor.duplicate")}
                    </button>
                  </div>
                </>
              ) : (
                <p className="leading-5 text-text-muted/70">{t("advancedEditor.noSelection")}</p>
              ))}

            {/* ── 音频 ── */}
            {inspectorTab === "audio" && (
              <>
                <PropertySection title={t("advancedEditor.originalAudio")}>
                  <div className="flex items-center gap-2">
                    <PropertySlider
                      label={t("advancedEditor.musicVolume")}
                      value={state.originalVolume}
                      min={0}
                      max={2}
                      step={0.05}
                      displayScale={100}
                      suffix="%"
                      defaultValue={1}
                      disabled={state.muted}
                      onChange={(value) => setState((current) => ({ ...current, originalVolume: value }))}
                    />
                    <button
                      type="button"
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-muted hover:bg-white/10 hover:text-text-dark"
                      onClick={() => setState((current) => ({ ...current, muted: !current.muted }))}
                      title={state.muted ? t("advancedEditor.unmute") : t("advancedEditor.mute")}
                    >
                      {state.muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                </PropertySection>

                {state.music ? (
                  <PropertySection title={t("advancedEditor.music")}>
                    <div className="truncate text-text-dark" title={state.music.sourcePath}>
                      {state.music.sourceName}
                    </div>
                    <PropertyRow
                      label={t("advancedEditor.musicStart")}
                      value={formatTimecode(state.music.startTicks, state.frameRate)}
                    />
                    <PropertySlider
                      label={t("advancedEditor.musicVolume")}
                      value={state.musicVolume}
                      min={0}
                      max={2}
                      step={0.05}
                      displayScale={100}
                      suffix="%"
                      defaultValue={0.6}
                      onChange={(value) => setState((current) => ({ ...current, musicVolume: value }))}
                    />
                    <PropertySlider
                      label={t("advancedEditor.fadeIn")}
                      value={state.musicFadeIn}
                      min={0}
                      max={5}
                      step={0.1}
                      suffix="s"
                      defaultValue={0}
                      onChange={(value) => setState((current) => ({ ...current, musicFadeIn: value }))}
                    />
                    <PropertySlider
                      label={t("advancedEditor.fadeOut")}
                      value={state.musicFadeOut}
                      min={0}
                      max={5}
                      step={0.1}
                      suffix="s"
                      defaultValue={0}
                      onChange={(value) => setState((current) => ({ ...current, musicFadeOut: value }))}
                    />
                  </PropertySection>
                ) : (
                  <p className="leading-5 text-text-muted/70">{t("advancedEditor.musicEmpty")}</p>
                )}
              </>
            )}

            {/* ── 文字 ── */}
            {inspectorTab === "text" &&
              (selectedTitle ? (
                <>
                  <textarea
                    className="nodrag nowheel h-20 w-full resize-none rounded-md border border-white/10 bg-black/40 p-2 text-[11px] leading-5 text-text-dark outline-none focus:border-accent/60"
                    value={selectedTitle.text}
                    placeholder={t("advancedEditor.titlePlaceholder")}
                    onChange={(event) =>
                      setState((current) => updateTitle(current, selectedTitle.id, { text: event.target.value }))
                    }
                  />

                  <PropertySlider
                    label={t("advancedEditor.titleSize")}
                    value={selectedTitle.fontSize}
                    min={12}
                    max={160}
                    step={1}
                    suffix="px"
                    defaultValue={48}
                    onChange={(value) => setState((current) => updateTitle(current, selectedTitle.id, { fontSize: value }))}
                  />

                  <div className="space-y-1">
                    <div className="text-text-muted">{t("advancedEditor.titleColor")}</div>
                    <div className="flex items-center gap-1">
                      {TITLE_COLORS.map((color) => (
                        <button
                          key={color}
                          type="button"
                          className={`h-5 w-5 rounded border-2 ${
                            selectedTitle.color.toUpperCase() === color ? "border-accent" : "border-white/20"
                          }`}
                          style={{ background: color }}
                          onClick={() => setState((current) => updateTitle(current, selectedTitle.id, { color }))}
                          title={color}
                        />
                      ))}
                      <input
                        type="color"
                        className="h-5 w-6 cursor-pointer rounded border border-white/20 bg-transparent"
                        value={selectedTitle.color}
                        onChange={(event) =>
                          setState((current) => updateTitle(current, selectedTitle.id, { color: event.target.value }))
                        }
                      />
                    </div>
                  </div>

                  <div className="space-y-1">
                    <div className="text-text-muted">{t("advancedEditor.titlePosition")}</div>
                    <div className="grid w-24 grid-cols-3 gap-1">
                      {TITLE_POSITIONS.map((position) => (
                        <button
                          key={position}
                          type="button"
                          className={`h-6 rounded border ${
                            selectedTitle.position === position
                              ? "border-accent bg-accent/25"
                              : "border-white/10 hover:border-white/30"
                          }`}
                          onClick={() => setState((current) => updateTitle(current, selectedTitle.id, { position }))}
                          title={position}
                        >
                          <span className="mx-auto block h-1.5 w-1.5 rounded-sm bg-current text-text-muted" />
                        </button>
                      ))}
                    </div>
                  </div>

                  <label className="flex items-center justify-between">
                    <span className="text-text-muted">{t("advancedEditor.titleBackdrop")}</span>
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-[var(--accent)]"
                      checked={selectedTitle.backdrop}
                      onChange={(event) =>
                        setState((current) =>
                          updateTitle(current, selectedTitle.id, { backdrop: event.target.checked }),
                        )
                      }
                    />
                  </label>

                  <PropertySlider
                    label={t("advancedEditor.titleDuration")}
                    value={selectedTitle.durationTicks / TICKS_PER_SECOND}
                    min={0.2}
                    max={30}
                    step={0.1}
                    suffix="s"
                    onChange={(value) =>
                      setState((current) =>
                        updateTitle(current, selectedTitle.id, {
                          durationTicks: Math.max(minTicks, Math.round(value * TICKS_PER_SECOND)),
                        }),
                      )
                    }
                  />
                  <PropertyRow
                    label={t("advancedEditor.musicStart")}
                    value={formatTimecode(selectedTitle.startTicks, state.frameRate)}
                  />
                </>
              ) : (
                <>
                  <p className="leading-5 text-text-muted/70">{t("advancedEditor.noTitleSelection")}</p>
                  <button
                    type="button"
                    className="flex h-8 w-full items-center justify-center gap-1 rounded-md border border-dashed border-white/15 text-[11px] text-text-muted transition-colors hover:border-accent/60 hover:text-text-dark"
                    onClick={() => setState((current) => addTitle(current, current.playheadTicks))}
                  >
                    <Type className="h-3.5 w-3.5" />
                    {t("advancedEditor.addText")}
                  </button>
                </>
              ))}
          </div>
        </aside>
      </div>

      {/* ── 时间线 ───────────────────────────────────────────── */}
      <div className="flex h-[236px] shrink-0 flex-col border-t border-white/10">
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-white/10 px-2">
          <button
            type="button"
            className="flex h-7 items-center gap-1 rounded px-2 text-[11px] text-text-muted hover:bg-white/10 hover:text-text-dark"
            onClick={handleSplit}
            title={t("advancedEditor.splitHint")}
          >
            <Scissors className="h-3.5 w-3.5" />
            {t("advancedEditor.split")}
          </button>
          <button
            type="button"
            className="flex h-7 items-center gap-1 rounded px-2 text-[11px] text-text-muted hover:bg-white/10 hover:text-text-dark"
            onClick={handleDuplicate}
          >
            {t("advancedEditor.duplicate")}
          </button>
          <button
            type="button"
            className="flex h-7 items-center gap-1 rounded px-2 text-[11px] text-text-muted hover:bg-white/10 hover:text-text-dark"
            onClick={handleDelete}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t("advancedEditor.delete")}
          </button>
          <button
            type="button"
            className="flex h-7 items-center gap-1 rounded px-2 text-[11px] text-text-muted hover:bg-white/10 hover:text-text-dark"
            onClick={() => setState((current) => addTitle(current, current.playheadTicks))}
          >
            <Type className="h-3.5 w-3.5" />
            {t("advancedEditor.addText")}
          </button>

          {/* 缩放从顶栏挪到这里：它影响的就是下面这条时间轴。 */}
          <div className="ml-auto flex items-center gap-0.5">
            <button
              type="button"
              className="flex h-7 w-7 items-center justify-center rounded text-text-muted hover:bg-white/10 hover:text-text-dark"
              title={t("advancedEditor.zoomOut")}
              onClick={() => setState((current) => setZoom(current, current.pixelsPerSecond / 1.4))}
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className="flex h-7 w-7 items-center justify-center rounded text-text-muted hover:bg-white/10 hover:text-text-dark"
              title={t("advancedEditor.zoomIn")}
              onClick={() => setState((current) => setZoom(current, current.pixelsPerSecond * 1.4))}
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </button>
          </div>
          <span className="ml-2 hidden text-[10px] text-text-muted/50 xl:inline">{t("advancedEditor.keyHint")}</span>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* 轨道头 */}
          <div className="w-28 shrink-0 border-r border-white/10 pt-[24px] text-[10px]">
            <div className="flex items-center gap-1 px-2 text-amber-200/70" style={{ height: TITLE_LANE_HEIGHT }}>
              <Type className="h-3 w-3" /> T1
            </div>
            <div className="flex items-center gap-1 px-2 text-text-muted" style={{ height: VIDEO_LANE_HEIGHT }}>
              <Film className="h-3 w-3" /> V1
            </div>
            <div className="flex items-center gap-1 px-2 text-text-muted/70" style={{ height: AUDIO_LANE_HEIGHT }}>
              {state.muted ? <VolumeX className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />} A1
            </div>
            <div className="flex items-center gap-1 px-2 text-text-muted/70" style={{ height: MUSIC_LANE_HEIGHT }}>
              <Music className="h-3 w-3" /> A2
            </div>
          </div>

          <div ref={scrollRef} className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden">
            <div
              ref={laneRef}
              className="relative select-none touch-none"
              style={{ width: contentWidth }}
              onPointerDown={handleLanePointerDown}
              onPointerMove={handleLanePointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onWheel={(event) => {
                if (!event.ctrlKey && !event.metaKey) return;
                event.preventDefault();
                const factor = event.deltaY > 0 ? 1 / 1.15 : 1.15;
                setState((current) => setZoom(current, current.pixelsPerSecond * factor));
              }}
            >
              {/* 刻度尺 */}
              <div className="relative border-b border-white/10" style={{ height: RULER_HEIGHT }}>
                {Array.from({ length: rulerCount }, (_, index) => {
                  const seconds = index * rulerStep;
                  return (
                    <div
                      key={index}
                      className="absolute top-0 flex h-full items-center"
                      style={{ left: ticksToPx(seconds * TICKS_PER_SECOND, state.pixelsPerSecond) }}
                    >
                      <span className="h-2 w-px bg-white/25" />
                      <span className="ml-1 text-[10px] tabular-nums text-text-muted/70">
                        {formatTimecode(seconds * TICKS_PER_SECOND, state.frameRate)}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* T1 文字轨：贴在 V1 上方，块高矮一些，拖起点/拖边缘改时长。 */}
              <div className="relative border-b border-white/5 bg-white/[0.02]" style={{ height: TITLE_LANE_HEIGHT }}>
                {state.titles.map((title) => {
                  const isSelected = title.id === state.selectedId;
                  const left = ticksToPx(title.startTicks, state.pixelsPerSecond);
                  const width = Math.max(16, ticksToPx(title.durationTicks, state.pixelsPerSecond));
                  return (
                    <div
                      key={title.id}
                      className={`absolute inset-y-1 flex items-center overflow-hidden rounded border ${
                        isSelected ? "border-accent bg-accent/30" : "border-amber-300/40 bg-amber-400/15"
                      }`}
                      style={{ left, width, zIndex: isSelected ? 5 : 1 }}
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        setState((current) => ({ ...current, selectedId: title.id }));
                        dragRef.current = {
                          type: "title-move",
                          id: title.id,
                          startX: event.clientX,
                          originTicks: title.startTicks,
                        };
                        laneRef.current?.setPointerCapture(event.pointerId);
                      }}
                      title={title.text}
                    >
                      <span className="pointer-events-none truncate px-1.5 text-[10px] text-amber-100/90">
                        {title.text.trim() || "…"}
                      </span>
                      <div
                        className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-amber-300/50"
                        onPointerDown={beginDrag({ type: "title-trim", id: title.id, edge: "start" })}
                      />
                      <div
                        className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-amber-300/50"
                        onPointerDown={beginDrag({ type: "title-trim", id: title.id, edge: "end" })}
                      />
                    </div>
                  );
                })}
              </div>

              {/* V1 视频轨 */}
              <div
                className={`relative border-b border-white/5 transition-colors ${
                  dropPreview?.lane === "video" ? "bg-accent/[0.07]" : ""
                }`}
                style={{ height: VIDEO_LANE_HEIGHT }}
                onDragOver={(event) => handleLaneDragOver(event, "video")}
                onDragLeave={handleLaneDragLeave}
                onDrop={(event) => void handleLaneDrop(event, "video")}
              >
                {/* 落点虚线：宽度 = 素材时长，位置 = 它将要插进去的那一段起点。 */}
                {dropPreview?.lane === "video" && (
                  <div
                    className="pointer-events-none absolute inset-y-1 z-20 rounded border border-dashed border-accent bg-accent/20"
                    style={{
                      left: ticksToPx(dropPreview.startTicks, state.pixelsPerSecond),
                      width: Math.max(6, ticksToPx(dropPreview.durationTicks, state.pixelsPerSecond)),
                    }}
                  >
                    <span className="absolute left-0 top-0 h-full w-0.5 bg-accent" />
                  </div>
                )}
                {ranges.map((range) => {
                  const isSelected = range.clip.id === state.selectedId;
                  const left = ticksToPx(range.start, state.pixelsPerSecond);
                  const width = Math.max(12, ticksToPx(range.end - range.start, state.pixelsPerSecond));
                  const isDragging = dragRef.current?.type === "clip-move" && dragRef.current.id === range.clip.id;
                  return (
                    <div
                      key={range.clip.id}
                      className={`absolute top-1 flex h-[calc(100%-8px)] flex-col overflow-hidden rounded border ${
                        isSelected ? "border-accent bg-black/40" : "border-white/15 bg-black/40"
                      }`}
                      style={{
                        left,
                        width,
                        transform: isDragging ? `translateX(${dragOffsetPx}px)` : undefined,
                        zIndex: isDragging ? 20 : 1,
                      }}
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        // 起点必须取真实 clientX：写 0 会让第一帧就把方块平移出可视区。
                        setState((current) => ({ ...current, selectedId: range.clip.id }));
                        dragRef.current = { type: "clip-move", id: range.clip.id, startX: event.clientX };
                        laneRef.current?.setPointerCapture(event.pointerId);
                      }}
                    >
                      {/* 标题栏：文件名 + 时长，压在缩略图条之上 */}
                      <div className="pointer-events-none flex shrink-0 items-center gap-1 bg-black/60 px-1.5 py-0.5">
                        <span className="min-w-0 truncate text-[10px] text-white/90">{range.clip.sourceName}</span>
                        <span className="ml-auto shrink-0 text-[9px] tabular-nums text-text-muted/80">
                          {formatTimecode(clipDuration(range.clip), state.frameRate)}
                        </span>
                      </div>
                      {/* 缩略图条：把片段源内的 [in, out] 均匀抽帧铺满 */}
                      <VideoFilmstrip
                        path={range.clip.sourcePath}
                        startSec={ticksToSeconds(range.clip.inTicks)}
                        endSec={ticksToSeconds(range.clip.outTicks)}
                      />
                      {/* 关键帧标记：菱形贴在块底部，点一下把播放头跳过去。 */}
                      {clipKeyframeTicks(range.clip).map((tick) => (
                        <span
                          key={tick}
                          role="button"
                          tabIndex={-1}
                          title={formatTimecode(tick, state.frameRate)}
                          className="absolute bottom-0.5 h-1.5 w-1.5 cursor-pointer rotate-45 border border-black/40 bg-amber-300 hover:bg-amber-200"
                          style={{ left: ticksToPx(tick, state.pixelsPerSecond) }}
                          onPointerDown={(event) => {
                            // 别让片段块的拖动接管：点菱形只移动播放头。
                            event.stopPropagation();
                            setState((current) => ({ ...current, playheadTicks: range.start + tick }));
                          }}
                        />
                      ))}
                      {/* 两侧裁剪手柄 */}
                      <div
                        className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-accent/60"
                        onPointerDown={beginDrag({
                          type: "clip-trim",
                          id: range.clip.id,
                          edge: "start",
                          appliedTicks: 0,
                          startX: 0,
                        })}
                      />
                      <div
                        className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-accent/60"
                        onPointerDown={beginDrag({
                          type: "clip-trim",
                          id: range.clip.id,
                          edge: "end",
                          appliedTicks: 0,
                          startX: 0,
                        })}
                      />
                    </div>
                  );
                })}
                {state.clips.length === 0 && (
                  <p className="px-3 py-4 text-[11px] text-text-muted/60">{t("advancedEditor.timelineEmpty")}</p>
                )}
              </div>

              {/* A1 原声轨（跟随 V1，只做可视化） */}
              <div
                className="relative border-b border-white/5 bg-white/[0.02]"
                style={{ height: AUDIO_LANE_HEIGHT, opacity: state.muted ? 0.35 : 1 }}
              >
                {ranges.map((range) => {
                  // 解不出音频就不画 —— 占位波形是编的，会让人照着它找「有声的位置」。
                  const peaks = waveforms[range.clip.sourcePath];
                  const left = ticksToPx(range.start, state.pixelsPerSecond);
                  const width = Math.max(6, ticksToPx(range.end - range.start, state.pixelsPerSecond));
                  return (
                    <div
                      key={`a1-${range.clip.id}`}
                      className="absolute inset-y-1 overflow-hidden rounded bg-emerald-500/10"
                      style={{ left, width }}
                    >
                      {peaks && <Waveform peaks={peaks} className="text-emerald-400/70" />}
                    </div>
                  );
                })}
              </div>

              {/* A2 音乐轨 */}
              <div
                className={`relative transition-colors ${
                  dropPreview?.lane === "audio" ? "bg-accent/[0.07]" : ""
                }`}
                style={{ height: MUSIC_LANE_HEIGHT }}
                onDragOver={(event) => handleLaneDragOver(event, "audio")}
                onDragLeave={handleLaneDragLeave}
                onDrop={(event) => void handleLaneDrop(event, "audio")}
              >
                {/* 音乐能自由定位，所以虚线块从指针所在的那一秒开始。 */}
                {dropPreview?.lane === "audio" && (
                  <div
                    className="pointer-events-none absolute inset-y-1 z-20 rounded border border-dashed border-accent bg-accent/20"
                    style={{
                      left: ticksToPx(dropPreview.startTicks, state.pixelsPerSecond),
                      width: Math.max(6, ticksToPx(dropPreview.durationTicks, state.pixelsPerSecond)),
                    }}
                  >
                    <span className="absolute left-0 top-0 h-full w-0.5 bg-accent" />
                  </div>
                )}
                {state.music && musicPeaks && (
                  <div
                    className={`absolute inset-y-1 overflow-hidden rounded border ${
                      musicSelected ? "border-accent bg-accent/20" : "border-sky-400/40 bg-sky-500/15"
                    }`}
                    style={{
                      left: ticksToPx(state.music.startTicks, state.pixelsPerSecond),
                      width: Math.max(16, ticksToPx(clipDuration(state.music), state.pixelsPerSecond)),
                    }}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      setState((current) => ({ ...current, selectedId: state.music?.id ?? null }));
                      dragRef.current = {
                        type: "music-move",
                        startX: event.clientX,
                        originTicks: stateRef.current.music?.startTicks ?? 0,
                      };
                      laneRef.current?.setPointerCapture(event.pointerId);
                    }}
                  >
                    <span className="pointer-events-none absolute left-1 top-0 text-[9px] text-text-dark/80">
                      {state.music.sourceName}
                    </span>
                    {musicPeaks && <Waveform peaks={musicPeaks} className="text-sky-300/80" />}
                  </div>
                )}
                {!state.music && (
                  <p className="px-3 py-3 text-[11px] text-text-muted/50">{t("advancedEditor.musicEmpty")}</p>
                )}
              </div>

              {/* 播放头 */}
              <div
                className="absolute top-0 z-30 w-px bg-white/85"
                style={{
                  left: playheadLeft,
                  height: RULER_HEIGHT + TITLE_LANE_HEIGHT + VIDEO_LANE_HEIGHT + AUDIO_LANE_HEIGHT + MUSIC_LANE_HEIGHT,
                }}
              >
                {/* 整条线都可抓：1px 的线点不中，铺一条 12px 的透明热区。 */}
                <div
                  className="absolute inset-y-0 -left-1.5 w-3 cursor-ew-resize"
                  onPointerDown={beginDrag({ type: "playhead" })}
                />
                {/* 顶部抓手与基础弹窗同款：白描边胶囊，竖线从中间穿过。 */}
                <div className="pointer-events-none absolute left-1/2 top-1 h-4 w-2.5 -translate-x-1/2 rounded-[3px] border-[1.5px] border-white bg-[#141414] shadow-[0_0_0_1px_rgba(0,0,0,0.45)]" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * 时间轴片段块上的缩略图条（胶片条）。
 *
 * 后端一次抽 `FILMSTRIP_FRAMES` 帧拼成一张横排 JPEG，这里用 `background-position` 切成
 * 等宽格子铺满片段块。每格之间留一道白色细线，看起来像一格一格的帧。
 *
 * 失败 / 还没抽好时退回纯黑底 —— 缩略图不该成为编辑器的阻塞点。
 */
function VideoFilmstrip({ path, startSec, endSec }: { path: string; startSec: number; endSec: number }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [strip, setStrip] = useState<string | null>(null);
  /** 需要几格 + 每格在屏幕上的宽度。 */
  const [layout, setLayout] = useState<{ frames: number; cellWidth: number } | null>(null);

  /**
   * 量容器，算出「切几格、每格多宽」。
   *
   * 🔴 这一版的关键：**格数由块宽反推，整张图随后被拉伸到块宽**。
   *
   * 上一版是「每格固定 16:9、能放几格放几格，然后靠 repeat-x 补尾巴」，
   * 结果图总宽（N × 64px）和块宽（时长 × 缩放）对不上，图又从左边贴齐 ——
   * 横坐标到时间的映射不再是线性的，越靠右偏得越多（最多偏一整格，约 0.4~0.6 秒），
   * 表现就是「缩略图和播放位置不匹配」。用户拖播放头到某处，看到的却是另一时刻的画面。
   *
   * 现在：`frames = round(块宽 / 理想格宽)`，每格屏幕宽 = 块宽 / frames，
   * 这个**真实格宽比**传给后端，让它在抽帧时把每帧**裁**成这个比例（不是拉伸内容），
   * 再把整张图按 100% 宽铺满块 —— 时间与横坐标严格线性，画面内容也不变形（只裁掉一点边）。
   */
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const measure = () => {
      const height = box.clientHeight;
      const width = box.clientWidth;
      if (height < 8 || width < 8) return;
      const idealCell = (height * 16) / 9;
      const frames = Math.min(24, Math.max(1, Math.round(width / idealCell)));
      setLayout({ frames, cellWidth: width / frames });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const box = boxRef.current;
    if (!isTauri() || /^https?:\/\//i.test(path) || !layout) return;
    const height = box?.clientHeight ?? 0;
    if (height < 8) return;
    let cancelled = false;
    // 不先清空：改格数时保留旧图，避免缩略图闪一下黑块。
    void extractVideoFilmstrip(path, startSec, endSec, layout.frames, layout.cellWidth / height).then((url) => {
      if (!cancelled && url) setStrip(resolveImageDisplayUrl(url));
    });
    return () => {
      cancelled = true;
    };
  }, [layout, path, startSec, endSec]);

  return (
    <div
      ref={boxRef}
      className="min-h-0 flex-1 bg-black/25"
      style={
        strip && layout
          ? {
              // 整图铺满块宽：时间↔横坐标因此严格线性（格数就是按块宽算的，拉伸量可忽略）。
              backgroundImage: cellGradient(layout.cellWidth, strip),
              backgroundSize: "100% 100%",
              backgroundRepeat: "no-repeat",
              backgroundPosition: "left center",
            }
          : undefined
      }
    />
  );
}

/**
 * 两层背景：上层是格间分隔线（按真实格宽画竖线），下层是胶片图。
 *
 * 分隔线用 `repeating-linear-gradient` 而不是给每格一个 div：格数是变的，
 * 生成 N 个 div 既要 key 又要重排，渐变只改一个数值。
 */
function cellGradient(cellWidth: number, strip: string): string {
  const line = Math.max(1, cellWidth - 1);
  return (
    `repeating-linear-gradient(to right, transparent 0, transparent ${line}px, ` +
    `rgba(255,255,255,0.22) ${line}px, rgba(255,255,255,0.22) ${cellWidth}px), url("${strip}")`
  );
}


/** 选框手柄的边长（px）。 */
const HANDLE_SIZE = 9;

/**
 * 片段选框的 8 个缩放手柄 + 1 个旋转手柄。
 *
 * 手柄要对父层的 `scale` 做**反向缩放**：片段被放大 8 倍时，手柄不能跟着变成 72px 的方块。
 * 用 `margin` 居中 + `transform: scale(1/k)`，中心不会因为缩放而偏移。
 */
function SelectionHandles({
  scaleX,
  scaleY,
  onDrag,
}: {
  scaleX: number;
  scaleY: number;
  onDrag: (event: React.PointerEvent, kind: PreviewDrag["kind"]) => void;
}) {
  const inverse = `scale(${1 / Math.max(0.05, Math.abs(scaleX))}, ${1 / Math.max(0.05, Math.abs(scaleY))})`;
  const base: React.CSSProperties = {
    position: "absolute",
    transform: inverse,
    transformOrigin: "center center",
    touchAction: "none",
  };
  const square = (key: string, left: string, top: string, cursor: string, kind: PreviewDrag["kind"]) => (
    <div
      key={key}
      className="rounded-[2px] border border-white bg-accent shadow-[0_0_0_1px_rgba(0,0,0,0.55)]"
      style={{
        ...base,
        left,
        top,
        width: HANDLE_SIZE,
        height: HANDLE_SIZE,
        marginLeft: -HANDLE_SIZE / 2,
        marginTop: -HANDLE_SIZE / 2,
        cursor,
      }}
      onPointerDown={(event) => onDrag(event, kind)}
    />
  );

  return (
    <>
      {square("nw", "0%", "0%", "nwse-resize", "uniform")}
      {square("ne", "100%", "0%", "nesw-resize", "uniform")}
      {square("sw", "0%", "100%", "nesw-resize", "uniform")}
      {square("se", "100%", "100%", "nwse-resize", "uniform")}
      {square("w", "0%", "50%", "ew-resize", "scale-x")}
      {square("e", "100%", "50%", "ew-resize", "scale-x")}
      {square("n", "50%", "0%", "ns-resize", "scale-y")}
      {square("s", "50%", "100%", "ns-resize", "scale-y")}

      {/* 旋转手柄：顶边上方一根连杆 + 一个圆点。 */}
      <div
        className="pointer-events-none bg-accent"
        style={{ position: "absolute", left: "50%", top: -28, width: 1, height: 28, marginLeft: -0.5 }}
      />
      <div
        className="rounded-full border border-white bg-accent shadow-[0_0_0_1px_rgba(0,0,0,0.55)]"
        style={{
          ...base,
          left: "50%",
          top: 0,
          width: 12,
          height: 12,
          marginLeft: -6,
          marginTop: -34,
          cursor: "grab",
        }}
        onPointerDown={(event) => onDrag(event, "rotate")}
      />
    </>
  );
}
