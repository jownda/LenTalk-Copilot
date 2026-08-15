import { canvasToDataUrl, loadImageElement } from './imageData';

export interface ImageAdjustments {
  /** 亮度 -100 ~ 100 */
  brightness: number;
  /** 对比度 -100 ~ 100 */
  contrast: number;
  /** 饱和度 -100 ~ 100 */
  saturation: number;
  /** 色温 -100 ~ 100(正=暖, 负=冷) */
  temperature: number;
  /** 暗部 -100 ~ 100 */
  shadows: number;
  /** 亮部 -100 ~ 100 */
  highlights: number;
}

export const DEFAULT_IMAGE_ADJUSTMENTS: ImageAdjustments = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  temperature: 0,
  shadows: 0,
  highlights: 0,
};

function clampChannel(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

/**
 * 对 ImageData 应用亮度/对比度/饱和度/色温/暗部/亮部调节(原地修改)。
 */
export function applyAdjustmentsToImageData(
  imageData: ImageData,
  adjustments: ImageAdjustments
): void {
  const data = imageData.data;
  const brightness = (adjustments.brightness / 100) * 100;
  const contrastValue = (adjustments.contrast / 100) * 255;
  // 标准对比度公式: factor = 259*(C+255) / (255*(259-C)), C ∈ [-255, 255]
  const contrastFactor =
    (259 * (contrastValue + 255)) / (255 * (259 - contrastValue));
  const saturation = 1 + adjustments.saturation / 100;
  const temperature = (adjustments.temperature / 100) * 30;
  const shadows = adjustments.shadows / 100;
  const highlights = adjustments.highlights / 100;

  for (let index = 0; index < data.length; index += 4) {
    let r = data[index];
    let g = data[index + 1];
    let b = data[index + 2];

    // 色温: 暖色加红减蓝, 冷色相反
    r += temperature;
    b -= temperature;

    // 亮度
    r += brightness;
    g += brightness;
    b += brightness;

    // 对比度(围绕中灰 128)
    r = contrastFactor * (r - 128) + 128;
    g = contrastFactor * (g - 128) + 128;
    b = contrastFactor * (b - 128) + 128;

    // 饱和度(灰度插值)
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = luminance + (r - luminance) * saturation;
    g = luminance + (g - luminance) * saturation;
    b = luminance + (b - luminance) * saturation;

    // 暗部/亮部(按亮度分段加权)
    const normalizedLuminance = luminance / 255;
    if (normalizedLuminance < 0.5) {
      const factor = shadows * (0.5 - normalizedLuminance) * 2;
      r += factor * 255;
      g += factor * 255;
      b += factor * 255;
    } else {
      const factor = highlights * (normalizedLuminance - 0.5) * 2;
      r += factor * 255;
      g += factor * 255;
      b += factor * 255;
    }

    data[index] = clampChannel(r);
    data[index + 1] = clampChannel(g);
    data[index + 2] = clampChannel(b);
  }
}

/**
 * 加载图片 → 应用调节 → 输出 data URL。
 * maxDimension > 0 时缩放到该边长内(用于实时预览提速)。
 */
export async function adjustImageSource(
  source: string,
  adjustments: ImageAdjustments,
  maxDimension = 0
): Promise<string> {
  const image = await loadImageElement(source);
  let width = image.naturalWidth;
  let height = image.naturalHeight;
  if (maxDimension > 0) {
    const scale = Math.min(1, maxDimension / Math.max(width, height));
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    return source;
  }
  context.drawImage(image, 0, 0, width, height);
  const imageData = context.getImageData(0, 0, width, height);
  applyAdjustmentsToImageData(imageData, adjustments);
  context.putImageData(imageData, 0, 0);
  return canvasToDataUrl(canvas);
}
