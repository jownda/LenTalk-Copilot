/**
 * 把解码后的 PCM 数据压缩成固定数量的波形峰值。
 *
 * 音频节点封面与音频预览弹窗共用这一份 —— 两处各写一遍，桶宽/归一化/下限迟早分叉，
 * 同一个文件在两处就会画出两种波形（用户会照着波形找"有声的位置"，画错就是误导）。
 *
 * 纯函数、只读入参：`AudioBuffer` 的解码结果按通道喂进来即可，便于单测。
 */
export function computeWaveformPeaks(
  channels: ReadonlyArray<ArrayLike<number>>,
  /** 每个通道的采样帧数（`AudioBuffer.length`）。 */
  length: number,
  count = 56,
): number[] {
  if (!Number.isFinite(count) || count <= 0 || length <= 0 || channels.length === 0) {
    return [];
  }

  const bucketSize = Math.max(1, Math.floor(length / count));
  const bars = Array.from({ length: count }, (_, index) => {
    const start = index * bucketSize;
    const end = Math.min(length, start + bucketSize);
    // 单桶采样步长：长音频一个桶里有上万帧，逐帧扫是白花 CPU，512 帧足够覆盖峰值。
    const step = Math.max(1, Math.floor((end - start) / 512));
    let peak = 0;
    for (const samples of channels) {
      for (let frame = start; frame < end; frame += step) {
        const value = Math.abs(samples[frame] ?? 0);
        if (value > peak) peak = value;
      }
    }
    return peak;
  });

  const maximum = Math.max(...bars, 0.0001);
  // 开方压缩动态范围：线性峰值下，人声/环境声几乎全是贴底的小柱子，看不出结构。
  return bars.map((bar) => Math.max(0.12, Math.min(1, Math.sqrt(bar / maximum))));
}
