import type { ResolutionOption } from './types';

/**
 * 自定义(OpenAI 兼容)图片模型的分辨率档位解析。
 *
 * 中转平台常把档位直接编进模型名 —— `qwen-image-3.0-pro-1k`、`flux-2k`、
 * `sd-4k`(字子动画的价格表就是按 `-1k` / `-2k` 分条目的)。这类模型只能按名字里
 * 那一档请求, 继续把 1K/2K/4K 全列出来只会让用户选中后拿到平台报错。
 *
 * 名字里读不到档位时返回 `null`, 由调用方回退 {@link FALLBACK_IMAGE_RESOLUTIONS},
 * 保持"查不到就给全档位"的既有行为。
 */

/** 查不到模型档位时的兜底: 与引入能力解析前的固定行为一致。 */
export const FALLBACK_IMAGE_RESOLUTIONS: ResolutionOption[] = [
  { value: '1K', label: '1K' },
  { value: '2K', label: '2K' },
  { value: '4K', label: '4K' },
];

/**
 * 档位数字。只认 1 / 2 / 4 —— 用户侧的档位就这么三档, 名字里的 `3k`、`8k`
 * 属于其它语义(上下文长度、超分倍率), 不参与判定。
 */
const RESOLUTION_TIER_DIGITS = ['1', '2', '4'] as const;

/**
 * 档位必须整体落在分隔符或首尾上, 否则 `gpt-image-1`、`seedream-4` 这类
 * 带数字的版本号会被误判成分辨率。
 */
function declaresTier(normalizedModelName: string, digit: string): boolean {
  return new RegExp(`(?:^|[-_./])${digit}k(?:$|[-_./])`).test(normalizedModelName);
}

/**
 * 从模型名解析平台声明支持的分辨率档位。
 *
 * @returns 命中时返回按 1K → 2K → 4K 排序的档位; 名字里读不到档位时返回 `null`。
 */
export function resolveDeclaredImageResolutions(modelName: string): ResolutionOption[] | null {
  const normalizedModelName = modelName.trim().toLowerCase();
  if (!normalizedModelName) {
    return null;
  }

  const tiers = RESOLUTION_TIER_DIGITS.filter((digit) =>
    declaresTier(normalizedModelName, digit)
  );
  if (tiers.length === 0) {
    return null;
  }

  return tiers.map((digit) => {
    const value = `${digit.toUpperCase()}K`;
    return { value, label: value };
  });
}

/**
 * 模型实际可选的分辨率档位: 能从名字解析出来就用解析结果, 否则给全档位。
 */
export function resolveImageModelResolutionOptions(modelName: string): ResolutionOption[] {
  return resolveDeclaredImageResolutions(modelName) ?? FALLBACK_IMAGE_RESOLUTIONS;
}
