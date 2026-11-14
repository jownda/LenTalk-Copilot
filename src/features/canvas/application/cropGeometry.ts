/**
 * 裁剪框的坐标换算。
 *
 * 抽成纯函数是为了能被测试钉住 —— 这段换算是「裁剪结果和操作不符」这类问题的唯一
 * 现场，改错一个除号，用户框的是一块、切出来是另一块。
 */

export interface CropRectPixels {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 源图像素坐标系里的裁剪矩形（就是发给后端的 cropX/cropY/cropWidth/cropHeight）。 */
export interface ImageSpaceCrop {
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
}

/**
 * 把框选结果换算成**源图像素**。
 *
 * 🔴 优先用库给的**百分比**（react-image-crop `onComplete` 的第二个参数）来换算，
 * 不要拿"我们算出来的渲染宽高"去反推。百分比是库自己按图片元素的真实盒子归一化的
 * （`getBox()` 读 `getBoundingClientRect()`），而 `renderedImageSize` 是我们算出来的
 * **期望**尺寸 —— 只要两者有 1px 以上偏差（flex 收缩、滚动条出现/消失、容器 padding
 * 变化、CSS 改写实际渲染尺寸），按比例反推就会把裁剪框整体缩放/平移，后端切出来的
 * 就是"另一块"。百分比没有这个假设。
 *
 * `pixelCrop` 只在拿不到百分比时兜底（例如我们自己构造的默认框）。
 */
export function toImageSpaceCrop(
  pixelCrop: CropRectPixels,
  percentCrop: CropRectPixels | null | undefined,
  renderedWidth: number,
  renderedHeight: number,
  naturalWidth: number,
  naturalHeight: number
): ImageSpaceCrop {
  const normalized =
    percentCrop && percentCrop.width > 0 && percentCrop.height > 0
      ? percentCrop
      : {
          x: renderedWidth > 0 ? pixelCrop.x / renderedWidth : 0,
          y: renderedHeight > 0 ? pixelCrop.y / renderedHeight : 0,
          width: renderedWidth > 0 ? pixelCrop.width / renderedWidth : 1,
          height: renderedHeight > 0 ? pixelCrop.height / renderedHeight : 1,
        };

  return {
    cropX: Math.round(normalized.x * naturalWidth),
    cropY: Math.round(normalized.y * naturalHeight),
    cropWidth: Math.round(normalized.width * naturalWidth),
    cropHeight: Math.round(normalized.height * naturalHeight),
  };
}

/**
 * 已保存的源图像素裁剪 → 渲染尺寸下的框选位置（反过来用，用于重开对话框时还原）。
 */
export function toRenderedCrop(
  crop: ImageSpaceCrop,
  renderedWidth: number,
  renderedHeight: number,
  naturalWidth: number,
  naturalHeight: number
): CropRectPixels {
  const scaleX = naturalWidth > 0 ? renderedWidth / naturalWidth : 1;
  const scaleY = naturalHeight > 0 ? renderedHeight / naturalHeight : 1;

  return {
    x: Math.max(0, crop.cropX * scaleX),
    y: Math.max(0, crop.cropY * scaleY),
    width: Math.max(1, crop.cropWidth * scaleX),
    height: Math.max(1, crop.cropHeight * scaleY),
  };
}
