import { useMemo } from "react";

/**
 * 音频波形条（镜像对称）。
 *
 * 基础剪辑与高级剪辑共用这一份 —— 两处各写一遍迟早会在断点/高度/颜色上分叉。
 *
 * 只画 `peaks` 给出的数据，**不做任何兜底**：拿不到真实波形时应当不渲染，
 * 而不是画一串假的峰值。假的波形会被当真（用户会照着它找"有声的位置"），
 * 而它跟实际音频毫无关系。
 */
export function Waveform({
  peaks,
  className,
  barCount = 220,
}: {
  peaks: readonly number[];
  className?: string;
  /** 最多画多少根条。远超像素宽度时多出来的看不见，只是白费渲染。 */
  barCount?: number;
}) {
  const sampled = useMemo(() => {
    if (peaks.length <= barCount) return peaks;
    const step = peaks.length / barCount;
    return Array.from({ length: barCount }, (_, index) => peaks[Math.floor(index * step)] ?? 0);
  }, [barCount, peaks]);

  if (!sampled.length) return null;

  return (
    <div className={`flex h-full w-full items-center gap-px px-0.5 ${className ?? ""}`}>
      {sampled.map((peak, index) => (
        <span
          key={index}
          className="flex-1 rounded-sm bg-current"
          // 高度居中、上下对称：比"底部对齐"更像剪辑软件的波形。
          style={{ height: `${Math.max(6, Math.min(1, peak) * 100)}%`, opacity: 0.75 }}
        />
      ))}
    </div>
  );
}
