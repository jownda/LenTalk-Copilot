/**
 * AI 设置（P3.2）— 与 LenTalk Chat 配置合二为一
 *
 * 不再单独维护服务商 / 地址 / Key：直接读取 LenTalk「设置 → 自定义平台」
 * 里已添加的 Chat 模型。本模块只记录「选了哪个模型」，
 * baseUrl / apiKey 始终来自 LenTalk 的同一份配置，避免两处重复填写。
 */
import { useSettingsStore } from "@/stores/settingsStore";

export interface AISettings {
  /** LenTalk 自定义平台 id（customApi.id）；为空表示尚未配置 Chat 模型 */
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  /** 兼容旧版本地存储；默认 0.4，不来自 LenTalk 配置 */
  temperature?: number;
}

export const DEFAULT_AI_SETTINGS: AISettings = {
  provider: "",
  baseUrl: "",
  model: "",
  apiKey: "",
  temperature: 0.4,
};

const SELECTION_KEY = "cineprompt-ai-selection";

export interface LenTalkChatModelOption {
  providerId: string;
  providerName: string;
  model: string;
}

/** 从 LenTalk 设置中列出所有可用的 Chat 模型（customApis[].chatModels） */
export function listLenTalkChatModels(): LenTalkChatModelOption[] {
  const options: LenTalkChatModelOption[] = [];
  for (const api of useSettingsStore.getState().customApis) {
    for (const model of api.chatModels ?? []) {
      if (!model.trim()) continue;
      options.push({ providerId: api.id, providerName: api.name, model });
    }
  }
  return options;
}

function readSelection(): { provider: string; model: string } {
  try {
    const raw = localStorage.getItem(SELECTION_KEY);
    if (!raw) return { provider: "", model: "" };
    const parsed = JSON.parse(raw) as { provider?: unknown; model?: unknown };
    return {
      provider: typeof parsed.provider === "string" ? parsed.provider : "",
      model: typeof parsed.model === "string" ? parsed.model : "",
    };
  } catch {
    return { provider: "", model: "" };
  }
}

function resolveSettings(selection: { provider: string; model: string }): AISettings {
  const options = listLenTalkChatModels();
  const preferred =
    options.find((option) => option.providerId === selection.provider && option.model === selection.model) ??
    options.find((option) => option.providerId === selection.provider) ??
    options[0];
  if (!preferred) return { ...DEFAULT_AI_SETTINGS };
  const api = useSettingsStore.getState().customApis.find((item) => item.id === preferred.providerId);
  if (!api) return { ...DEFAULT_AI_SETTINGS };
  return {
    provider: api.id,
    baseUrl: api.baseUrl,
    model: preferred.model,
    apiKey: api.apiKey,
    temperature: 0.4,
  };
}

/** 解析 LenTalk 中某个 Chat 模型为完整 AISettings（地址/Key 来自该平台配置） */
export function resolveLenTalkChatModel(providerId: string, model: string): AISettings {
  return resolveSettings({ provider: providerId, model });
}

export function loadAISettings(): AISettings {
  return resolveSettings(readSelection());
}

/** 保存仅持久化「选中的 Chat 模型」；地址/Key 仍由 LenTalk 配置提供 */
export function saveAISettings(settings: AISettings): AISettings {
  localStorage.setItem(
    SELECTION_KEY,
    JSON.stringify({ provider: settings.provider, model: settings.model }),
  );
  return resolveSettings({ provider: settings.provider, model: settings.model });
}

export function clearAISettings(): void {
  localStorage.removeItem(SELECTION_KEY);
}

/** 是否已选中 LenTalk 中一个可用的 Chat 模型（含 Key） */
export function isRemoteConfigured(settings = loadAISettings()): boolean {
  return Boolean(
    settings.provider &&
    settings.apiKey.trim().length > 0 &&
    settings.model.trim().length > 0 &&
    settings.baseUrl.trim().length > 0,
  );
}

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** OpenAI 兼容 API 根地址：自动补齐 /v1（已带 /v1、/v4 等版本路径时不重复追加） */
export function openAICompatibleBaseUrl(url: string): string {
  const base = normalizeBaseUrl(url);
  if (!base) return "";
  if (/\/v\d+(?:\.\d+)?$/.test(base)) return base;
  return `${base}/v1`;
}
