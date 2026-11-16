import { describe, expect, it } from 'vitest';
import { computeWaveformPeaks } from './waveformPeaks';

/** 造一个单通道数据：前半静音、后半满幅，便于断言峰值分布。 */
function halfHalf(length: number): Float32Array {
  const data = new Float32Array(length);
  for (let index = Math.floor(length / 2); index < length; index += 1) {
    data[index] = 1;
  }
  return data;
}

describe('computeWaveformPeaks', () => {
  it('桶数固定，且静音段明显低于有声段', () => {
    const peaks = computeWaveformPeaks([halfHalf(1000)], 1000, 10);
    expect(peaks).toHaveLength(10);
    expect(peaks[0]).toBeCloseTo(0.12, 5);
    expect(peaks[9]).toBeCloseTo(1, 5);
  });

  it('全部静音时不留 0（保底高度，否则波形条不可见）', () => {
    const peaks = computeWaveformPeaks([new Float32Array(200)], 200, 8);
    expect(peaks).toHaveLength(8);
    for (const peak of peaks) {
      expect(peak).toBeCloseTo(0.12, 5);
    }
  });

  it('多通道取各通道峰值的最大值（单声道有声音就不能漏）', () => {
    const left = new Float32Array(100);
    const right = new Float32Array(100).fill(0.5);
    const peaks = computeWaveformPeaks([left, right], 100, 4);
    expect(peaks.every((peak) => peak > 0.9)).toBe(true);
  });

  it('负数采样按绝对值处理', () => {
    const data = new Float32Array(64).fill(-0.8);
    const peaks = computeWaveformPeaks([data], 64, 4);
    expect(peaks.every((peak) => peak > 0.9)).toBe(true);
  });

  it('结果始终落在 [0.12, 1] 区间', () => {
    const mixed = new Float32Array(500);
    for (let index = 0; index < mixed.length; index += 1) {
      mixed[index] = Math.sin(index / 7) * 0.3;
    }
    for (const peak of computeWaveformPeaks([mixed], mixed.length, 32)) {
      expect(peak).toBeGreaterThanOrEqual(0.12);
      expect(peak).toBeLessThanOrEqual(1);
    }
  });

  it('空输入 / 非法桶数返回空数组（调用方据此不画波形，而不是画假波形）', () => {
    expect(computeWaveformPeaks([], 0, 8)).toEqual([]);
    expect(computeWaveformPeaks([new Float32Array(10)], 10, 0)).toEqual([]);
    expect(computeWaveformPeaks([new Float32Array(10)], 0, 8)).toEqual([]);
  });
});
