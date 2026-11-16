import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * 即梦画布 CLI 的**模型目录**与**积分价目**（自动同步）。
 *
 * 后端实现在 `src-tauri/src/commands/jimeng_catalog.rs`：
 * - 目录：`dreamina-canvas model list --type=image|video|audio`（免费、无副作用，缓存 24h）
 * - 价目：在「LenTalk-价格探针」画布建一批节点 → 批量 `node quote` → 立刻删除（不扣积分）
 */

function requireDesktop() {
  if (!isTauri()) {
    throw new Error("即梦模型自动同步只能在桌面端使用，请打开 LenTalk 桌面应用后再操作。");
  }
}

/** 清单里的一个模型。能力字段已由后端按「取并集」归一。 */
export interface JimengCatalogEntry {
  model: string;
  displayName: string;
  aliases: string[];
  /** image / video / audio */
  mediaType: string;
  modes: string[];
  /** 已按画质从小到大排序 */
  resolutions: string[];
  aspectRatios: string[];
  /** 可选时长（秒），由 --duration 的 min/max/step 展开 */
  durations: number[];
  maxCount: number;
  /** `--count` 的下限；固定张数模型等于 `fixedCount` */
  minCount?: number;
  /** 固定出图张数（MJ 8.2 必出 4 张才有值） */
  fixedCount: number | null;
  maxReferences: number;
  /** 图生图最少几张参考图（`references.min`） */
  minReferences?: number;
  /** `--prompt` 字符上限，取各 mode 最小值；0 = 未声明 */
  maxPromptLength?: number;
  supportsFirstFrame: boolean;
  vipRequired: boolean;
}

export interface JimengModelCatalog {
  cliVersion: string;
  /** 秒级时间戳 */
  fetchedAt: number;
  image: JimengCatalogEntry[];
  video: JimengCatalogEntry[];
  audio: JimengCatalogEntry[];
}

/** 一次报价请求：模型 × 档位（视频再带基准时长）。 */
export interface JimengPriceProbeRequest {
  model: string;
  mediaType: "image" | "video";
  resolution: string;
  duration?: number;
}

export interface JimengPriceQuote {
  model: string;
  mediaType: string;
  resolution: string;
  duration: number | null;
  /** 本次报价的总积分（图片=一批，视频=整段） */
  credits: number;
  /** 批内数量：图片=张数，视频=秒数 */
  units: number;
  /** 计价单位积分：图片=单张，视频=每秒 */
  unitCredits: number;
}

export interface JimengPriceReport {
  quotes: JimengPriceQuote[];
  /** 「模型 @ 档位：原因」，不影响已拿到的价格 */
  failures: string[];
  probedAt: number;
}

/** 拉模型目录。`forceRefresh=false` 时后端可能直接回缓存（24h 内）。 */
export async function fetchJimengModelCatalog(
  executable: string,
  forceRefresh = false
): Promise<JimengModelCatalog> {
  requireDesktop();
  return await invoke<JimengModelCatalog>("jimeng_canvas_model_catalog", {
    executable,
    forceRefresh,
  });
}

/** 批量报价。⚠️ 有副作用：会在探针画布里建节点再删除（不扣积分）。 */
export async function probeJimengModelPrices(
  executable: string,
  requests: JimengPriceProbeRequest[]
): Promise<JimengPriceReport> {
  requireDesktop();
  return await invoke<JimengPriceReport>("jimeng_canvas_probe_model_prices", {
    executable,
    requests,
  });
}

/** 读取已缓存的价目，不触发探测。 */
export async function readCachedJimengModelPrices(): Promise<JimengPriceReport | null> {
  if (!isTauri()) {
    return null;
  }
  return await invoke<JimengPriceReport | null>("jimeng_canvas_cached_model_prices");
}

/* ── 旧 CLI（dreamina）：没有 model list，只能解析 `-h` 的说明文本 ───────── */

export interface LegacyCliModel {
  version: string;
  resolutions: string[];
  minDuration: number | null;
  maxDuration: number | null;
}

export interface LegacyCliCatalog {
  cliVersion: string;
  /** 抓取时间（秒）；老缓存是 0，会被后端当成过期。 */
  fetchedAt?: number;
  image: LegacyCliModel[];
  video: LegacyCliModel[];
}

/**
 * 读取旧 CLI 的模型与档位。
 *
 * `-h` 文本只是起点 —— CLI 的说明是编译期写死的，服务端加型号时它不会变，
 * 所以后端还会发一两次「必然失败但不扣积分」的探测请求，从服务端回显的
 * `version should be in [...]` 里读权威清单再合并。结果缓存 24 小时，
 * `forceRefresh` 用于设置页的手动刷新。
 */
export async function fetchLegacyJimengCliCatalog(
  executable: string,
  forceRefresh = false
): Promise<LegacyCliCatalog> {
  requireDesktop();
  return await invoke<LegacyCliCatalog>("jimeng_cli_model_catalog", {
    executable,
    forceRefresh,
  });
}
