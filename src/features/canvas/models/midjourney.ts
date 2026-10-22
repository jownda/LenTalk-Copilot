import type { ExtraParamDefinition } from "./types";

/**
 * Midjourney 的「张数」语义 —— 与其它图片模型不一样，必须先讲清楚再写代码。
 *
 * 实测（2026-10-18，知鸟 AI / `mj_imagine`，模型卡 param_schema 与真实返回一致的部分只有比例、引擎这些）：
 *   - 传 `n: 1`（也就是 OpenAI Images 的「要几张」）→ 上游仍然回 **4 张**，响应里没有 `param_adjustments`；
 *   - 传 `count: 2` → 回 **8 张**，费用也正好翻倍。
 * 结论：这条链路上的 `count` 是**组数**，一组恒为 4 张，`n` 被上游忽略。
 * 所以 MJ 的「生成张数」最小单位就是 4，客户端再怎么选也拿不到 1~3 张。
 */
export const MIDJOURNEY_IMAGES_PER_GROUP = 4;

/**
 * 识别 Midjourney 模型。
 *
 * 只认 `mj_imagine` / `midjourney` 这两个完整 token：`grok-imagine-image` 名字里
 * 也有 `imagine`，但它是 xAI 的模型、按张出图，绝不能跟着 MJ 的组数语义走。
 */
const MIDJOURNEY_MODEL_PATTERN = /(?:^|[/:_.-])(?:mj[_-]?imagine|midjourney)(?:$|[/:_.-])/i;

export function isMidjourneyImageModel(modelId: string | null | undefined): boolean {
  if (typeof modelId !== "string") return false;
  const normalized = modelId.trim();
  if (!normalized) return false;
  return MIDJOURNEY_MODEL_PATTERN.test(normalized);
}

/**
 * 档位 → 实际出图张数。
 *
 * `imagesPerCountUnit` 缺省 1（一档一张）；MJ 是 4（一档一组）。节点上存的
 * `imageCount` 始终是「档位」（1~4），张数只在展示与请求时换算，不改节点数据结构。
 */
export function resolveImageCountImages(count: number, imagesPerCountUnit = 1): number {
  const unit =
    Number.isFinite(imagesPerCountUnit) && imagesPerCountUnit > 0
      ? Math.round(imagesPerCountUnit)
      : 1;
  const units = Number.isFinite(count) && count > 0 ? Math.round(count) : 1;
  return units * unit;
}

/**
 * MJ 的模型专属参数：引擎 / 版本 / 风格化。
 *
 * 字段名与取值全部取自模型卡的 `param_schema`（`GET /v1/logical-models`），
 * 不是猜的：`bot_type` 是**必填**（文档说默认 MID_JOURNEY，但显式带上更稳），
 * `version` 空串就是官方默认档，`stylize` 默认 100。
 *
 * 这些字段由 Rust 侧 `apply_model_extra_params` 透传进请求体 —— 不加那条白名单，
 * 面板上选了也发不出去。
 */
export const MIDJOURNEY_EXTRA_PARAMS: ExtraParamDefinition[] = [
  {
    key: "bot_type",
    label: "模型引擎",
    labelKey: "modelParams.midjourney.botType",
    type: "enum",
    defaultValue: "MID_JOURNEY",
    options: [
      {
        value: "MID_JOURNEY",
        label: "MJ 写实模式",
        labelKey: "modelParams.midjourney.midJourney",
      },
      {
        value: "NIJI_JOURNEY",
        label: "Niji 动漫模式",
        labelKey: "modelParams.midjourney.nijiJourney",
      },
    ],
  },
  {
    key: "version",
    label: "版本",
    labelKey: "modelParams.midjourney.version",
    type: "enum",
    defaultValue: "",
    options: [
      { value: "", label: "默认" },
      { value: "8.2", label: "v8.2 最新" },
      { value: "8.1", label: "v8.1" },
      { value: "7", label: "v7 / Niji 7" },
      { value: "6.1", label: "v6.1" },
      { value: "6", label: "v6 / Niji 6" },
      { value: "5.2", label: "v5.2" },
      { value: "5.1", label: "v5.1" },
    ],
  },
  {
    key: "stylize",
    label: "风格化",
    labelKey: "modelParams.midjourney.stylize",
    type: "enum",
    defaultValue: "100",
    options: [
      { value: "0", label: "0 写实" },
      { value: "50", label: "50 轻微" },
      { value: "100", label: "100 默认" },
      { value: "250", label: "250 中等" },
      { value: "500", label: "500 强烈" },
      { value: "750", label: "750 极强" },
      { value: "1000", label: "1000 极致" },
    ],
  },
];

/** 面板打开时就该带上、避免用户不动引擎时也漏字段的默认值。 */
export const MIDJOURNEY_DEFAULT_EXTRA_PARAMS: Record<string, unknown> = {
  bot_type: "MID_JOURNEY",
  stylize: "100",
};
