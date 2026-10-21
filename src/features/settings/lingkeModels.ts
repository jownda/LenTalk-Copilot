/**
 * 灵柯AI(API666888 同源网关)图片模型的**真实参数与能力表**。
 *
 * 数据源: 2026-10-20 抓自官网文档的运行时接口
 * `GET /houduan/gongkai/apidoc/moxing-liebiao?domain=lingkeai.vip` +
 * `GET /v1/skills/models/{name}`(后者带 params[].options)。
 *
 * 这张表存在的理由:
 * 1. 平台的 21 个图片模型**全部**只认 `POST /v1/media/generate`, 打
 *    `/v1/images/generations` 一律 400「请改用 media/generate」;
 * 2. 同类参数的**键名按模型族不同**: `banana-*` 要 `aspectRatio` / `imageSize`,
 *    `tt-image-2.5` 要 `aspect_ratio` / `resolution`, `doubao-seedream-*` 要
 *    `aspect_ratio` / `size`, `qwen-image` 的 `size` 直接就是画幅比例;
 * 3. 键名传错平台**不报错**, 直接按默认值出图 —— 用户选的比例/分辨率等于白选
 *    (实测 banana-2.1 传 `resolution:"1K"` 仍返回 2048×2048);
 * 4. 每个模型的可选值范围也不同, UI 放开全部档位会让用户选出平台必拒的值
 *    (如 `gk-image-2.0` 没有 4K、`doubao-seedream-5-0-260128` 没有 1K)。
 *
 * `ratios: []` 表示该模型没有独立比例参数(`tt-image-2` 族用像素 `size`),
 * `resolutions: []` 表示没有独立分辨率参数(`qwen-image` / `wan2.x-image` 用
 * `size` 表达画幅, `mj_imagine` 用 `quality`)。这两种情况调用方回退到通用档位。
 */

export interface LingkeImageCapability {
  /** 平台 `options` 里的画幅比例; 空数组 = 该模型不接受比例参数 */
  ratios: readonly string[];
  /** 平台 `options` 里的分辨率档位; 空数组 = 该模型不接受分辨率参数 */
  resolutions: readonly string[];
}

/**
 * 灵柯网关里「只在 media 信封出现」的 21 个图片模型。
 * 与 `src-tauri/.../openai_compat/mod.rs` 的 `MEDIA_ONLY_IMAGE_MODELS` 保持一致。
 */
export const LINGKE_MEDIA_IMAGE_MODELS: readonly string[] = [
  "tt-image-2.5",
  "tt-image-2.5-token",
  "tt-image-2",
  "tt-image-2-token",
  "banana-2.1",
  "banana-2.1-token",
  "banana-2",
  "banana-2-token",
  "banana-pro",
  "banana-pro-token",
  "mj_imagine",
  "doubao-seedream-4-5-251128",
  "doubao-seedream-5-0-260128",
  "doubao-seedream-5-0-pro-260628",
  "gk-image-2.0",
  "kling-v3",
  "kling-v3-omni",
  "vidu-image-2",
  "qwen-image",
  "wan2.6-image",
  "wan2.7-image",
];

/**
 * 两个名字命中视频/对话分类器、但平台把它们当**图片模型**的特例。
 *
 * `kling-v3` / `kling-v3-omni` 在灵柯是「可灵出图」, 名字却会被 `kling` 规则
 * 判成视频, 结果图片下拉里没有、视频下拉里又跑不通(提交时被当视频任务处理)。
 */
export const LINGKE_IMAGE_NAME_OVERRIDES: readonly string[] = ["kling-v3", "kling-v3-omni"];

export const LINGKE_IMAGE_CAPABILITIES: Record<string, LingkeImageCapability> = {
  "tt-image-2.5": {
    ratios: ["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "2:1", "1:2", "21:9", "9:21"],
    resolutions: ["1K", "2K", "4K"],
  },
  "tt-image-2.5-token": {
    ratios: ["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "2:1", "1:2", "21:9", "9:21"],
    resolutions: ["1K", "2K", "4K"],
  },
  // 像素 size 族: 比例与档位由后端折成具体像素, UI 沿用通用档位
  "tt-image-2": { ratios: [], resolutions: [] },
  "tt-image-2-token": { ratios: [], resolutions: [] },
  "banana-2.1": {
    ratios: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "1:4", "4:1", "1:8", "8:1"],
    resolutions: ["1K", "2K", "4K"],
  },
  "banana-2.1-token": {
    ratios: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "1:4", "4:1", "1:8", "8:1"],
    resolutions: ["1K", "2K", "4K"],
  },
  "banana-2": {
    ratios: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "1:4", "4:1", "1:8", "8:1"],
    // 0.5K 是极速档, 排在正常档位之后 —— 面板默认取第一项
    resolutions: ["1K", "2K", "4K", "0.5K"],
  },
  "banana-2-token": {
    ratios: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "1:4", "4:1", "1:8", "8:1"],
    resolutions: ["1K", "2K", "4K", "0.5K"],
  },
  "banana-pro": {
    ratios: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
    resolutions: ["1K", "2K", "4K"],
  },
  "banana-pro-token": {
    ratios: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
    resolutions: ["1K", "2K", "4K"],
  },
  mj_imagine: {
    ratios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "4:5", "5:4", "21:9"],
    resolutions: [],
  },
  "doubao-seedream-4-5-251128": {
    ratios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"],
    resolutions: ["2K", "4K"],
  },
  "doubao-seedream-5-0-260128": {
    ratios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"],
    resolutions: ["2K", "3K"],
  },
  "doubao-seedream-5-0-pro-260628": {
    ratios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"],
    resolutions: ["1K", "2K"],
  },
  "gk-image-2.0": {
    ratios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
    resolutions: ["1K", "2K"],
  },
  "kling-v3": {
    ratios: ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3", "21:9"],
    resolutions: ["1K", "2K"],
  },
  "kling-v3-omni": {
    ratios: ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3", "21:9"],
    resolutions: ["1K", "2K", "4K"],
  },
  "vidu-image-2": {
    ratios: ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "7:3"],
    resolutions: ["1K", "2K", "3K"],
  },
  "qwen-image": {
    ratios: ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"],
    resolutions: [],
  },
  "wan2.6-image": {
    ratios: ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"],
    resolutions: [],
  },
  "wan2.7-image": {
    ratios: ["1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2"],
    resolutions: [],
  },
};

/** 灵柯网关的域名白名单 —— 主域名、白标站和备用域名都算。 */
export function isLingkeBaseUrl(baseUrl: string | undefined | null): boolean {
  const value = (baseUrl ?? "").trim().toLowerCase();
  if (!value) {
    return false;
  }
  return ["lk888", "lk666", "lingkeai", "api666888"].some((host) => value.includes(host));
}

/** 该模型名是否属于「平台明确登记为图片」的 21 个之一(大小写不敏感)。 */
export function isLingkeMediaImageModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return LINGKE_MEDIA_IMAGE_MODELS.some((item) => item === normalized);
}

export function resolveLingkeImageCapability(model: string): LingkeImageCapability | undefined {
  return LINGKE_IMAGE_CAPABILITIES[model.trim().toLowerCase()];
}
