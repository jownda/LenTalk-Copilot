/**
 * 图层混合模式：数据枚举 ↔ canvas 合成算子。
 *
 * 放在 domain 里是因为导出（`SeamlessMosaicEditor`）与节点内舞台
 * （`SeamlessMosaicNode`）都要用同一套名称，别各写一份字符串。
 */
import type { MosaicBlendMode } from "./canvasNodes";

export interface MosaicBlendModeOption {
  id: MosaicBlendMode;
  label: string;
  /** canvas 2d 的 globalCompositeOperation 取值。 */
  operation: GlobalCompositeOperation;
}

export const MOSAIC_BLEND_MODE_OPTIONS: readonly MosaicBlendModeOption[] = [
  { id: "normal", label: "正常", operation: "source-over" },
  { id: "multiply", label: "正片叠底", operation: "multiply" },
  { id: "screen", label: "滤色", operation: "screen" },
  { id: "overlay", label: "叠加", operation: "overlay" },
  { id: "darken", label: "变暗", operation: "darken" },
  { id: "lighten", label: "变亮", operation: "lighten" },
  { id: "soft-light", label: "柔光", operation: "soft-light" },
  { id: "difference", label: "差值", operation: "difference" },
];

const BLEND_OPERATION = new Map<MosaicBlendMode, GlobalCompositeOperation>(
  MOSAIC_BLEND_MODE_OPTIONS.map((option) => [option.id, option.operation]),
);

export function mosaicBlendOperation(mode: MosaicBlendMode | undefined | null): GlobalCompositeOperation {
  if (!mode) return "source-over";
  return BLEND_OPERATION.get(mode) ?? "source-over";
}

/** 角度归一化到 (-180, 180]：拖动旋转时避免数值无限增长。 */
export function normalizeRotation(value: number): number {
  if (!Number.isFinite(value)) return 0;
  let angle = value % 360;
  if (angle > 180) angle -= 360;
  if (angle <= -180) angle += 360;
  return Math.round(angle * 10) / 10;
}

/**
 * 旋转后的图层包围盒（导出时用来算裁剪区，也用于舞台上的命中区）。
 * 返回相对画布坐标的矩形，rotation 以图层中心为轴。
 */
export function rotatedLayerBounds(layer: {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
}): { x: number; y: number; width: number; height: number } {
  const rotation = layer.rotation ?? 0;
  if (!rotation) {
    return { x: layer.x, y: layer.y, width: layer.width, height: layer.height };
  }
  const radians = (rotation * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  const width = layer.width * cos + layer.height * sin;
  const height = layer.width * sin + layer.height * cos;
  const centerX = layer.x + layer.width / 2;
  const centerY = layer.y + layer.height / 2;
  return { x: centerX - width / 2, y: centerY - height / 2, width, height };
}
