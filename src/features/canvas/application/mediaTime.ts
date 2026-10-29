/**
 * 帧精确时基。
 *
 * 设计参考 OpenCut（`rust/crates/time`，MIT）的 MediaTime：**时间是整数 tick，不是浮点秒**。
 * 原来剪辑弹窗全程用秒，`5.1 - 5` 在二进制浮点下是 `0.09999999999999964`，只能靠
 * 「四舍五入到毫秒」糊过去 —— 那是拿精度换正确性。换成 tick 之后：
 *
 * - 加减是整数运算，不做四舍五入也不会漂；
 * - 帧边界天然可整除，吸附就是 `round(ticks / ticksPerFrame) * ticksPerFrame`；
 * - 时间码能精确到帧，不会出现「显示 1.0 秒，实际 0.96 秒」。
 *
 * 为什么是 120,000：它必须能被所有标准帧率的分母整除，**包括丢帧率**。
 * 23.976（= 24000/1001）每帧 5,005 ticks、29.97（= 30000/1001）4,004、30 是 4,000、
 * 25 是 4,800 —— 全是整数，不需要任何近似。
 */

/** 每秒钟的 tick 数。改它等于改所有已存数据的语义，不要动。 */
export const TICKS_PER_SECOND = 120_000;

/** 有理数帧率。用分数而不是 `23.976` 这种小数，是为了让每帧 tick 数能被整除。 */
export interface FrameRate {
  numerator: number;
  denominator: number;
}

export const FPS_23_976: FrameRate = { numerator: 24_000, denominator: 1_001 };
export const FPS_24: FrameRate = { numerator: 24, denominator: 1 };
export const FPS_25: FrameRate = { numerator: 25, denominator: 1 };
export const FPS_29_97: FrameRate = { numerator: 30_000, denominator: 1_001 };
export const FPS_30: FrameRate = { numerator: 30, denominator: 1 };
export const FPS_48: FrameRate = { numerator: 48, denominator: 1 };
export const FPS_50: FrameRate = { numerator: 50, denominator: 1 };
export const FPS_59_94: FrameRate = { numerator: 60_000, denominator: 1_001 };
export const FPS_60: FrameRate = { numerator: 60, denominator: 1 };
export const FPS_120: FrameRate = { numerator: 120, denominator: 1 };

/** 探测回来的帧率只会落在这些常见档位上。 */
const KNOWN_FRAME_RATES: FrameRate[] = [
  FPS_23_976,
  FPS_24,
  FPS_25,
  FPS_29_97,
  FPS_30,
  FPS_48,
  FPS_50,
  FPS_59_94,
  FPS_60,
  FPS_120,
];

export function isFrameRateValid(rate: FrameRate | null | undefined): rate is FrameRate {
  return Boolean(rate && rate.numerator > 0 && rate.denominator > 0);
}

/** 帧率的十进制值；非法帧率返回 null。 */
export function frameRateToFps(rate: FrameRate | null | undefined): number | null {
  if (!isFrameRateValid(rate)) return null;
  return rate.numerator / rate.denominator;
}

/**
 * 每帧多少 tick。除不尽返回 null —— 这是有意的：宁可让调用方退回「按毫秒吸附」，
 * 也不要偷偷四舍五入，那会把整条时间轴慢慢带偏。
 */
export function ticksPerFrame(rate: FrameRate | null | undefined): number | null {
  if (!isFrameRateValid(rate)) return null;
  const numerator = TICKS_PER_SECOND * rate.denominator;
  if (numerator % rate.numerator !== 0) return null;
  return numerator / rate.numerator;
}

/** 秒 → ticks。非有限值返回 0，避免 NaN 顺着计算链扩散。 */
export function ticksFromSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return 0;
  return Math.round(seconds * TICKS_PER_SECOND);
}

export function ticksToSeconds(ticks: number): number {
  if (!Number.isFinite(ticks)) return 0;
  return ticks / TICKS_PER_SECOND;
}

/** ticks → 帧号（向下取整）。 */
export function ticksToFrame(ticks: number, rate: FrameRate | null | undefined): number | null {
  const perFrame = ticksPerFrame(rate);
  if (!perFrame) return null;
  return Math.floor(ticks / perFrame);
}

/** 帧号 → ticks。 */
export function frameToTicks(frame: number, rate: FrameRate | null | undefined): number | null {
  const perFrame = ticksPerFrame(rate);
  if (!perFrame) return null;
  return Math.round(frame) * perFrame;
}

/**
 * 吸附到最近的帧边界。
 *
 * 帧率未知（或除不尽）时退化成「按毫秒取整」—— 仍然比原来的自由浮点稳，
 * 只是不保证落在帧上。
 */
export function snapTicksToFrame(ticks: number, rate: FrameRate | null | undefined): number {
  if (!Number.isFinite(ticks)) return 0;
  const perFrame = ticksPerFrame(rate);
  if (!perFrame) return Math.round(ticks / 1000) * 1000;
  return Math.round(ticks / perFrame) * perFrame;
}

/** 吸附到「不晚于该点」的帧边界，用于起点（宁可少留一帧，不越界）。 */
export function floorTicksToFrame(ticks: number, rate: FrameRate | null | undefined): number {
  if (!Number.isFinite(ticks)) return 0;
  const perFrame = ticksPerFrame(rate);
  if (!perFrame) return Math.floor(ticks / 1000) * 1000;
  return Math.floor(ticks / perFrame) * perFrame;
}

/** 该点是否正好落在帧边界上。 */
export function isFrameAligned(ticks: number, rate: FrameRate | null | undefined): boolean {
  const perFrame = ticksPerFrame(rate);
  if (!perFrame) return false;
  return ticks % perFrame === 0;
}

/**
 * 剪辑时间码，**精确到帧**。
 *
 * 有帧率时显示 `0:03.12`（第 12 帧），最后一组是帧号而不是小数秒 —— 用户拖到哪一帧
 * 就应该看到哪一帧，而不是「0.4 秒」这种再看不出差别的数字。
 * 没有帧率时退回一位小数秒（和旧行为一致）。
 */
export function formatTimecode(ticks: number, rate: FrameRate | null | undefined): string {
  if (!Number.isFinite(ticks) || ticks < 0) ticks = 0;
  const totalSeconds = Math.floor(ticks / TICKS_PER_SECOND);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const perFrame = ticksPerFrame(rate);
  if (!perFrame) {
    const tenths = Math.floor((ticks % TICKS_PER_SECOND) / (TICKS_PER_SECOND / 10));
    const secondsText = `${String(seconds).padStart(2, "0")}.${tenths}`;
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, "0")}:${secondsText}`
      : `${minutes}:${secondsText}`;
  }

  const frame = Math.floor((ticks - totalSeconds * TICKS_PER_SECOND) / perFrame);
  const frameDigits = String(Math.max(1, Math.ceil(rate!.numerator / rate!.denominator))).length;
  const secondsText = `${String(seconds).padStart(2, "0")}.${String(frame).padStart(frameDigits, "0")}`;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${secondsText}`
    : `${minutes}:${secondsText}`;
}

/** 解析后端探测回来的帧率；小数会吸附到最近的已知档位（如 23.98 → 24000/1001）。 */
export function parseProbeFrameRate(
  numerator: number | null | undefined,
  denominator: number | null | undefined,
): FrameRate | null {
  if (!numerator || !denominator || numerator <= 0 || denominator <= 0) return null;
  // ⚠️ 不要先取整再算帧率：`23.98` 取整成 24 之后会「精确匹配」到 24fps，
  // 丢帧率就彻底认不出来了。先用原始值算，只有入参本来就是整数时才做精确匹配。
  const fps = numerator / denominator;
  if (!Number.isFinite(fps) || fps <= 0) return null;

  const isIntegral = Number.isInteger(numerator) && Number.isInteger(denominator);
  if (isIntegral) {
    for (const known of KNOWN_FRAME_RATES) {
      if (known.numerator === numerator && known.denominator === denominator) {
        return known;
      }
    }
  }

  // 容差收到 0.05%：够认 23.98 → 23.976（0.017%），又不会把 30 错认成 29.97（0.10%）。
  let best: FrameRate | null = null;
  let bestError = Number.POSITIVE_INFINITY;
  for (const known of KNOWN_FRAME_RATES) {
    const error = Math.abs(frameRateToFps(known)! - fps) / fps;
    if (error < bestError) {
      bestError = error;
      best = known;
    }
  }
  if (best && bestError < 5e-4) return best;

  // 认不出来的帧率原样保留；后续 `ticksPerFrame` 除不尽时会自动退回毫秒吸附。
  return { numerator: Math.round(numerator), denominator: Math.round(denominator) };
}
