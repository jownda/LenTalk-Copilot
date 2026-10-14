import { describe, expect, it } from 'vitest';

import { mapRequestedImageSize } from './ai';

/** OpenAI 图像族的硬上限:单边 3840、总像素 8294400(= 3840x2160)。 */
const MAX_OPENAI_IMAGE_PIXELS = 8_294_400;

function parseSize(size: string): { width: number; height: number } {
  const [width, height] = size.split('x').map(Number);
  return { width, height };
}

describe('mapRequestedImageSize · OpenAI 图像族像素预算', () => {
  it('把 4K + 4:3 收敛到预算内(回归:3840x2880 曾被上游 400 拒绝)', () => {
    // 症状来源: custom 平台 gpt-image-2 + 4K + 4:3 →
    // "invalid params.size 3840x2880 ... total pixels must be <= 8294400"
    const size = mapRequestedImageSize('gpt-image-2', '4K', '4:3');
    const { width, height } = parseSize(size);

    expect(width * height).toBeLessThanOrEqual(MAX_OPENAI_IMAGE_PIXELS);
    expect(width).toBeLessThanOrEqual(3840);
    expect(height).toBeLessThanOrEqual(3840);
    expect(size).toBe('3312x2480');
  });

  it('竖幅同样收敛,不因镜像比例漏掉', () => {
    const size = mapRequestedImageSize('gpt-image-2', '4K', '3:4');
    const { width, height } = parseSize(size);

    expect(width * height).toBeLessThanOrEqual(MAX_OPENAI_IMAGE_PIXELS);
    expect(size).toBe('2480x3312');
  });

  it('16:9 / 9:16 / 21:9 的 4K 不超预算,保持原尺寸不被缩小', () => {
    expect(mapRequestedImageSize('gpt-image-2', '4K', '16:9')).toBe('3840x2160');
    expect(mapRequestedImageSize('gpt-image-2', '4K', '9:16')).toBe('2160x3840');
    expect(mapRequestedImageSize('gpt-image-2', '4K', '21:9')).toBe('3840x1648');
  });

  it('1:1 的 4K 仍在预算内收敛(既有行为不回退)', () => {
    const size = mapRequestedImageSize('gpt-image-2', '4K', '1:1');
    expect(size).toBe('2880x2880');
  });

  it('gpt-image 全系变体都命中预算', () => {
    for (const model of [
      'gpt-image-1',
      'gpt-image-1.5',
      'gpt-image-2',
      'gpt-image-2-auto',
      'gpt-image-2-eco',
      'gpt-image-2-2k',
      'gpt-image-2.5-flare',
      'gpt-image2-4k',
      'gpt-image-2-native',
      'dall-e-3',
    ]) {
      const { width, height } = parseSize(mapRequestedImageSize(model, '4K', '4:3'));
      expect(`${model}: ${width}x${height}`).toBe(`${model}: 3312x2480`);
    }
  });

  it('非 OpenAI 图像族的模型不受该预算约束', () => {
    expect(mapRequestedImageSize('seedream-4', '4K', '4:3')).toBe('3840x2880');
    expect(mapRequestedImageSize('nano-banana', '4K', '4:3')).toBe('3840x2880');
    expect(mapRequestedImageSize('', '4K', '4:3')).toBe('3840x2880');
  });
});

describe('mapRequestedImageSize · 档位与画幅映射', () => {
  it('1K 走 gpt-image 官方三档尺寸', () => {
    expect(mapRequestedImageSize('gpt-image-2', '1K', '1:1')).toBe('1024x1024');
    expect(mapRequestedImageSize('gpt-image-2', '1K', '4:3')).toBe('1536x1024');
    expect(mapRequestedImageSize('gpt-image-2', '1K', '9:16')).toBe('1024x1536');
  });

  it('2K 取长边 2048 且不触发预算收敛', () => {
    expect(mapRequestedImageSize('gpt-image-2', '2K', '16:9')).toBe('2048x1152');
    expect(mapRequestedImageSize('gpt-image-2', '2K', '4:3')).toBe('2048x1536');
    expect(mapRequestedImageSize('gpt-image-2', '2K', '1:1')).toBe('2048x2048');
  });

  it('已经是 WxH 的显式尺寸原样透传', () => {
    expect(mapRequestedImageSize('gpt-image-2', '1536x1024', '4:3')).toBe('1536x1024');
    expect(mapRequestedImageSize('gpt-image-2', '4096x4096', '1:1')).toBe('4096x4096');
  });

  it('无法识别的档位退化为 gpt-image 官方尺寸', () => {
    expect(mapRequestedImageSize('gpt-image-2', 'auto', '16:9')).toBe('1536x1024');
    expect(mapRequestedImageSize('gpt-image-2', '0.5K', '1:1')).toBe('1024x1024');
  });

  it('画幅非法时退化为正方形', () => {
    expect(mapRequestedImageSize('gpt-image-2', '1K', 'not-a-ratio')).toBe('1024x1024');
  });
});
