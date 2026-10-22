import { Headphones, LoaderCircle } from "lucide-react";

import type { AudioPreviewState } from "./useAudioPreview";

/** 尺寸。列表行内用 `sm`, 卡片主按钮用 `md`。 */
export type VoicePreviewButtonSize = "sm" | "md";

export type VoicePreviewButtonProps = {
  state: AudioPreviewState;
  onClick: () => void;
  disabled?: boolean;
  /** 悬浮说明 —— 内置音色试听会真发一次计费请求, 要在 title 里讲明。 */
  title?: string;
  size?: VoicePreviewButtonSize;
  /** 带文案的整行按钮(音色克隆/音色设计两张卡用的就是这种)。 */
  label?: string;
  /** 撑满父容器宽度。 */
  block?: boolean;
  className?: string;
};

const ICON_CLASS: Record<VoicePreviewButtonSize, string> = {
  sm: "h-3 w-3",
  md: "h-3.5 w-3.5",
};

const BOX_CLASS: Record<VoicePreviewButtonSize, string> = {
  sm: "h-5 w-5",
  md: "h-7 w-7",
};

/**
 * 全局统一的「试听」按钮 —— 音频节点里所有能出声的地方都用它。
 *
 * 三态:
 *   - `idle`    耳机图标(可播)
 *   - `loading` 转圈(内置音色是现场合成的, 有一次真实网络往返, 必须给等待反馈)
 *   - `playing` **三根跳动的柱子** —— 这是要的「点了有反应」: 静态图标换成动画,
 *               并且再点一下会停, 而不是像以前那样点了毫无变化。
 *
 * 高亮颜色跟随 accent, 与节点里其它激活态一致。图标型(默认)与文案型(`label`)两种排布
 * 共用同一份状态机, 所以「播放中」在全节点是同一种视觉。
 */
export function VoicePreviewButton({
  state,
  onClick,
  disabled,
  title,
  size = "sm",
  label,
  block,
  className = "",
}: VoicePreviewButtonProps) {
  const playing = state === "playing";
  const loading = state === "loading";

  const indicator = loading ? (
    <LoaderCircle className={`${ICON_CLASS[size]} animate-spin`} />
  ) : playing ? (
    // 三根柱子: 高度略错开, 靠 animation-delay 做出「跳」的感觉。
    <span className="flex h-3 items-end justify-center gap-[2px]" aria-hidden="true">
      <span className="audio-preview-bar h-3 w-[2px] rounded-sm bg-accent" />
      <span className="audio-preview-bar h-3 w-[2px] rounded-sm bg-accent" />
      <span className="audio-preview-bar h-3 w-[2px] rounded-sm bg-accent" />
    </span>
  ) : (
    <Headphones className={ICON_CLASS[size]} />
  );

  return (
    <button
      type="button"
      className={`nodrag flex shrink-0 items-center justify-center transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
        label ? `h-6 gap-1 rounded border border-border-dark px-2 text-[10px] ${block ? "w-full" : ""}` : `rounded ${BOX_CLASS[size]}`
      } ${
        playing || loading
          ? "bg-accent/15 text-accent"
          : "text-text-muted hover:bg-white/10 hover:text-text-dark"
      } ${className}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title ?? label}
      aria-pressed={playing}
    >
      {indicator}
      {label && <span className="truncate">{label}</span>}
    </button>
  );
}
