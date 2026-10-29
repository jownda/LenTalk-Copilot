import { invoke, isTauri } from "@tauri-apps/api/core";

import { resolveImageDisplayUrl } from "./imageData";

/**
 * 音频波形采样。
 *
 * 桌面端走 Rust 的 `audio_waveform`（ffmpeg 只解音频轨），浏览器预览退回 WebView 的
 * `decodeAudioData`。
 *
 * 为什么桌面端不用 `decodeAudioData`：它要求先把**整个文件**读进 JS 内存再解码。
 * 剪辑素材动辄几十 MB，每次打开面板都这么干，既慢又占内存；容器/编码不受支持时
 * （HEVC、ProRes）还会直接失败。ffmpeg 只解音频轨，代价小得多。
 *
 * ⚠️ **拿不到就返回 null，调用方不要画假波形**：假峰值会让用户照着它去找「有声的位置」，
 * 那条信息是编的，比空白更糟。
 */

/** 桶数越多越细，但 DOM 也会更重。400 在 1200px 宽的轨道上够看。 */
const DEFAULT_BUCKETS = 400;
const CACHE_LIMIT = 12;

const cache = new Map<string, number[] | null>();

/** 同一文件只解码一次；失败也缓存（避免每次渲染都重试一次慢操作）。 */
export async function loadWaveformPeaks(
  sourcePath: string,
  buckets = DEFAULT_BUCKETS,
): Promise<number[] | null> {
  if (!sourcePath) return null;
  const key = `${sourcePath}#${buckets}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const peaks = isTauri()
    ? await peaksFromBackend(sourcePath, buckets)
    : await decodePeaks(sourcePath, buckets).catch(() => null);

  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, peaks);
  return peaks;
}

/** 后端只回数据，不做兜底：空数组（没有音轨 / ffmpeg 不可用）一律当「拿不到」。 */
async function peaksFromBackend(sourcePath: string, buckets: number): Promise<number[] | null> {
  try {
    const peaks = await invoke<number[]>("audio_waveform", { sourcePath, buckets });
    return Array.isArray(peaks) && peaks.length > 0 ? peaks : null;
  } catch {
    return null;
  }
}

async function decodePeaks(sourcePath: string, buckets: number): Promise<number[] | null> {
  const AudioCtor: typeof AudioContext | undefined =
    typeof window === "undefined"
      ? undefined
      : (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  if (!AudioCtor) return null;

  const response = await fetch(resolveImageDisplayUrl(sourcePath));
  if (!response.ok) return null;
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength === 0) return null;

  const context = new AudioCtor();
  try {
    const buffer = await context.decodeAudioData(bytes.slice(0));
    const channels = buffer.numberOfChannels;
    if (channels === 0 || buffer.length === 0) return null;

    // 只取第一声道算 RMS：波形是给眼睛定位用的，多声道逐帧平均没有必要。
    const samples = buffer.getChannelData(0);
    const perBucket = Math.max(1, Math.floor(samples.length / buckets));
    const peaks: number[] = [];
    for (let bucket = 0; bucket < buckets; bucket += 1) {
      const start = bucket * perBucket;
      if (start >= samples.length) {
        peaks.push(0);
        continue;
      }
      const end = Math.min(start + perBucket, samples.length);
      let sum = 0;
      for (let index = start; index < end; index += 1) {
        const value = samples[index];
        sum += value * value;
      }
      peaks.push(Math.sqrt(sum / Math.max(1, end - start)));
    }

    // 归一化到 0~1：绝对音量没意义，能看出强弱就够。
    const max = peaks.reduce((best, value) => Math.max(best, value), 0);
    if (max <= 0) return peaks.map(() => 0);
    return peaks.map((value) => Math.min(1, value / max));
  } finally {
    void context.close().catch(() => undefined);
  }
}
