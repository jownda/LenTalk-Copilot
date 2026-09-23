// ---------------------------------------------------------------------------
// 扒剧本的模型清单：把用户在「设置 → 密钥」里已配置的渠道摊平成
// 「模型 → 渠道参数」列表，供面板上的模型选择按钮使用。
//
// 不预设任何渠道：没选模型就不能开始，避免悄悄走某个默认平台。
// ---------------------------------------------------------------------------

import { useMemo } from "react";

import { recommendedApis } from "@/features/settings/recommendedApis";
import { useSettingsStore, type CustomApiProvider } from "@/stores/settingsStore";

export interface PajubenModelOption {
  /** 唯一键，形如 `custom:<apiId>/<model>`。 */
  key: string;
  model: string;
  providerName: string;
  baseUrl: string;
  apiKey: string;
  source: "custom" | "recommended";
}

/** 模型能否直接接收扒视频流程使用的 OpenAI `input_audio` 内容。 */
export function isPajubenAudioInputModel(model: string): boolean {
  const value = model.trim().toLowerCase();
  return (
    /(?:^|[-_/.])gemini(?:[-_/.]|\d|$)/.test(value) ||
    /(?:^|[-_/.])qwen\d*[-_.]?omni(?:[-_/.]|\d|$)/.test(value) ||
    /(?:^|[-_/.])gpt[-_]?4o[-_]?(?:audio|realtime)(?:[-_.]|\d|$)/.test(value)
  );
}

function samePajubenProvider(left: PajubenModelOption, right: PajubenModelOption): boolean {
  const normalize = (value: string) => value.trim().replace(/\/+$/, "").replace(/\/v1$/i, "").toLowerCase();
  return normalize(left.baseUrl) === normalize(right.baseUrl) && left.apiKey.trim() === right.apiKey.trim();
}

/** 为普通 Chat/视觉模型寻找同渠道的音频模型，避免把音频硬塞给不支持的模型。 */
export function findPajubenAudioFallbackModel(
  options: PajubenModelOption[],
  selected: PajubenModelOption | null,
): PajubenModelOption | null {
  if (!selected || isPajubenAudioInputModel(selected.model)) return selected;
  return (
    options.find((option) => samePajubenProvider(option, selected) && isPajubenAudioInputModel(option.model)) ?? null
  );
}

export function customProviderKey(apiId: string): string {
  return `custom:${apiId}`;
}

/**
 * 两类渠道都扫：
 * - 自定义平台（用户「添加」的平台，key 存在 `provider.apiKey` 与 `apiKeys.custom:<id>`）；
 * - 推荐平台（内置渠道，key 存在 `apiKeys[<platformId>]`）。
 *
 * 同名模型分属不同平台时各自保留 —— 扒剧本要的是「哪个渠道的哪个模型」。
 */
export function collectPajubenModelOptions(
  customApis: CustomApiProvider[],
  apiKeys: Record<string, string>,
): PajubenModelOption[] {
  const options: PajubenModelOption[] = [];
  const seen = new Set<string>();

  /**
   * 同一个渠道名下「同名模型」只保留一条：历史上重复连接同一个平台会留下
   * `知鸟ai` 与 `知鸟ai-23oa` 两条记录，两条都叫「知鸟AI」，不合并的话
   * 按供应商分组后同一个模型会在下拉里出现两次。
   * 合并时优先留「有密钥」的那条，避免留下一份用不了的条目。
   */
  const push = (option: PajubenModelOption) => {
    if (seen.has(option.key)) return;
    const label = `${option.providerName}\u0000${option.model}`;
    const existingIndex = options.findIndex((item) => `${item.providerName}\u0000${item.model}` === label);
    if (existingIndex >= 0) {
      const existing = options[existingIndex];
      if (!existing.apiKey.trim() && option.apiKey.trim()) {
        options[existingIndex] = option;
        seen.add(option.key);
      }
      return;
    }
    seen.add(option.key);
    options.push(option);
  };

  const custom: PajubenModelOption[] = [];
  for (const api of customApis) {
    const apiKey = api.apiKey || apiKeys[customProviderKey(api.id)] || "";
    for (const model of api.chatModels ?? []) {
      if (!model.trim()) continue;
      custom.push({
        key: `${customProviderKey(api.id)}/${model}`,
        model,
        providerName: api.name,
        baseUrl: api.baseUrl,
        apiKey,
        source: "custom",
      });
    }
  }
  custom.sort((a, b) => a.providerName.localeCompare(b.providerName) || a.model.localeCompare(b.model));
  custom.forEach(push);

  const recommended: PajubenModelOption[] = [];
  for (const api of recommendedApis) {
    const apiKey = apiKeys[api.id] ?? "";
    if (!apiKey.trim()) continue;
    for (const model of api.chatModels ?? []) {
      if (!model.trim()) continue;
      recommended.push({
        key: `recommended:${api.id}/${model}`,
        model,
        providerName: api.name,
        baseUrl: api.baseUrl,
        apiKey,
        source: "recommended",
      });
    }
  }
  recommended.sort((a, b) => a.providerName.localeCompare(b.providerName) || a.model.localeCompare(b.model));
  recommended.forEach(push);

  return options;
}

export function usePajubenModelOptions(): PajubenModelOption[] {
  const customApis = useSettingsStore((state) => state.customApis);
  const apiKeys = useSettingsStore((state) => state.apiKeys);
  return useMemo(() => collectPajubenModelOptions(customApis, apiKeys), [customApis, apiKeys]);
}

export interface PajubenModelGroup {
  /** 渠道名（供应商），用作 `<optgroup>` 的标题。 */
  providerName: string;
  options: PajubenModelOption[];
}

/**
 * 按供应商分组：下拉里同一渠道的模型收在一个 `<optgroup>` 里，
 * 免得「同名模型分属不同渠道」时用户分不清点的是哪一家。
 *
 * 组内按模型名排序，组之间按渠道名排序 —— 与 collectPajubenModelOptions 的
 * 排序规则一致，保证「上面列出的顺序」稳定，不会因为重渲染跳来跳去。
 */
export function groupPajubenModelOptions(options: PajubenModelOption[]): PajubenModelGroup[] {
  const groups = new Map<string, PajubenModelOption[]>();
  for (const option of options) {
    const bucket = groups.get(option.providerName);
    if (bucket) {
      bucket.push(option);
    } else {
      groups.set(option.providerName, [option]);
    }
  }
  return Array.from(groups, ([providerName, list]) => ({
    providerName,
    options: [...list].sort((a, b) => a.model.localeCompare(b.model)),
  })).sort((a, b) => a.providerName.localeCompare(b.providerName));
}
