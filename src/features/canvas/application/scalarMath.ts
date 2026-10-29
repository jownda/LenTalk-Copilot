/**
 * 数值控件的数学部分。
 *
 * 搬自 OpenChatCut（MIT）`components/inspector/scalarMath.ts` —— 纯函数、零依赖，
 * 而且是那套「滑块 + 数值框 + 拖拽」交互里最容易写错的地方，值得原样保留。
 * 其中 `snapScalar` 的小数位处理是自己算的（按 step 的小数位 +2 位再 toFixed），
 * 不是简单 `Math.round`：步长 0.05 时后者会算出 0.30000000000000004。
 */

export interface ScalarModifiers {
  shiftKey: boolean;
  metaKey: boolean;
}

/** 按住 Shift 走大步、按住 Cmd/Ctrl 走小步 —— 拖拽时精确与快速之间不再要改设置。 */
export function scalarModifier({ shiftKey, metaKey }: ScalarModifiers): number {
  return (shiftKey ? 10 : 1) * (metaKey ? 0.1 : 1);
}

export function clampScalar(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function snapScalar(value: number, min: number, max: number, step: number): number {
  const snapped = min + Math.round((value - min) / step) * step;
  const precision = Math.max(0, `${step}`.split('.')[1]?.length ?? 0) + 2;
  return clampScalar(Number(snapped.toFixed(precision)), min, max);
}

export function scrubScalar(
  start: number,
  deltaX: number,
  step: number,
  min: number,
  max: number,
  modifiers: ScalarModifiers,
): number {
  const next = start + deltaX * step * scalarModifier(modifiers);
  const precision = Math.max(0, `${step}`.split('.')[1]?.length ?? 0) + 2;
  return clampScalar(Number(next.toFixed(precision)), min, max);
}
