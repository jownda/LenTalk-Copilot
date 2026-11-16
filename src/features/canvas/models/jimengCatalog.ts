import { create } from "zustand";

import {
  fetchLegacyJimengCliCatalog,
  fetchJimengModelCatalog,
  probeJimengModelPrices,
  readCachedJimengModelPrices,
  type JimengModelCatalog,
  type JimengPriceProbeRequest,
  type JimengPriceQuote,
  type JimengPriceReport,
  type LegacyCliCatalog,
} from "@/commands/jimengCatalog";
import { useJimengCanvasCliStore } from "@/stores/jimengCanvasCliStore";
import { useSettingsStore } from "@/stores/settingsStore";

export type {
  JimengCatalogEntry,
  LegacyCliCatalog,
  LegacyCliModel,
  JimengModelCatalog,
  JimengPriceProbeRequest,
  JimengPriceQuote,
  JimengPriceReport,
} from "@/commands/jimengCatalog";

/**
 * 即梦画布 CLI 的模型目录与价目**运行时缓存**。
 *
 * 分工：
 * - 本模块只负责「拿到什么」，不负责怎么变成模型定义 —— 那是 `registry.ts` 的事。
 * - `registry.ts` 是纯函数模块，每次 `listImageModels()` 都重新构建，所以它直接读本模块的
 *   `getState()`；组件要跟着刷新就订阅 `useJimengCatalogRevision()`（数字变了就重渲染）。
 *
 * 为什么启动时只拉目录、不拉价目：目录是几次免费的 `model list`，几百毫秒；价目要在
 * 用户账号里建/删探针节点，属于**有副作用**的操作，只能由用户点按钮显式触发。
 */

interface JimengCatalogState {
  catalog: JimengModelCatalog | null;
  /** 旧 CLI（`dreamina`）的版本→档位表，来源是 `-h` 文本 */
  legacy: LegacyCliCatalog | null;
  prices: JimengPriceReport | null;
  loading: boolean;
  /** 价目探测进行中（会建节点，可能要几十秒） */
  probing: boolean;
  error: string | null;
  /** 目录或价目每变一次自增，组件靠它重渲染 */
  revision: number;
}

export const useJimengCatalogStore = create<JimengCatalogState>(() => ({
  catalog: null,
  legacy: null,
  prices: null,
  loading: false,
  probing: false,
  error: null,
  revision: 0,
}));

function currentExecutable(): string {
  return useJimengCanvasCliStore.getState().executable.trim();
}

export function getJimengCatalog(): JimengModelCatalog | null {
  return useJimengCatalogStore.getState().catalog;
}

/** 旧 CLI 的模型声明；没同步到就返回 null（registry 回退内置表）。 */
export function getLegacyJimengCatalog(): LegacyCliCatalog | null {
  return useJimengCatalogStore.getState().legacy;
}

export function getJimengPriceReport(): JimengPriceReport | null {
  return useJimengCatalogStore.getState().prices;
}

/** 订阅目录版本号：变更即重渲染，用在渲染模型下拉的组件里。 */
export function useJimengCatalogRevision(): number {
  return useJimengCatalogStore((state) => state.revision);
}

/**
 * 旧 CLI 的模型声明：解析 `-h`，再由后端用服务端回显的清单补齐新型号，失败静默。
 *
 * 它和画布 CLI 的目录分开拉：`dreamina` 可能没装（只有画布 CLI），这时这里失败、
 * 画布 CLI 的目录照样能用。
 */
async function loadLegacyCatalog(forceRefresh = false): Promise<void> {
  const executable = useSettingsStore.getState().jimengCli.executable?.trim();
  if (!executable) {
    return;
  }
  try {
    const legacy = await fetchLegacyJimengCliCatalog(executable, forceRefresh);
    if (legacy.image.length === 0 && legacy.video.length === 0) {
      return;
    }
    useJimengCatalogStore.setState((state) => ({
      legacy,
      revision: state.revision + 1,
    }));
  } catch {
    // 未安装 / 版本太老解析不出来 —— 都退回内置表。
  }
}

let inFlight: Promise<void> | null = null;

async function loadCatalog(forceRefresh: boolean): Promise<void> {
  const executable = currentExecutable();
  if (!executable) {
    return;
  }
  useJimengCatalogStore.setState({ loading: true });
  try {
    const catalog = await fetchJimengModelCatalog(executable, forceRefresh);
    useJimengCatalogStore.setState((state) => ({
      catalog,
      loading: false,
      error: null,
      revision: state.revision + 1,
    }));
  } catch (error) {
    // 同步失败不该影响任何生成功能：registry 会退回内置表，这里只把原因留给设置页看。
    useJimengCatalogStore.setState({
      loading: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 启动时调用一次（幂等）。
 *
 * 走缓存优先：24 小时内的目录直接返回，不发网络请求。失败静默 —— 模型列表退回内置策展表。
 */
export function bootstrapJimengCatalog(): Promise<void> {
  if (inFlight) {
    return inFlight;
  }
  // 价目只读缓存，绝不在这里触发探测。
  void (async () => {
    try {
      const cached = await readCachedJimengModelPrices();
      if (cached) {
        useJimengCatalogStore.setState((state) => ({
          prices: cached,
          revision: state.revision + 1,
        }));
      }
    } catch {
      // 缓存读不到就是没有，忽略。
    }
  })();

  void loadLegacyCatalog();

  inFlight = loadCatalog(false).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * 设置页「刷新模型列表」。强制绕过 24h 缓存。
 *
 * 两个 CLI 一起刷：画布 CLI 走 `model list`（要网络），旧 CLI 走「解析 `-h` + 服务端
 * 型号探针」（会提交一两次必然失败的请求，不扣积分）。旧 CLI 可能没装，失败会被
 * `loadLegacyCatalog` 吞掉，不影响画布侧的结果。
 */
export async function refreshJimengCatalog(): Promise<void> {
  await Promise.all([loadCatalog(true), loadLegacyCatalog(true)]);
}

/**
 * 设置页「刷新积分价格」。
 *
 * 请求组合的来源就是目录本身：图片取每个模型 × 每个档位；视频取每个模型 × 每个档位 ×
 * 一个基准时长（价格随时长线性，实测 4 秒与 8 秒严格成比例）。
 */
export async function refreshJimengPrices(): Promise<JimengPriceReport> {
  const executable = currentExecutable();
  if (!executable) {
    throw new Error("请先填写即梦画布 CLI 的可执行命令");
  }
  const catalog = getJimengCatalog();
  if (!catalog) {
    throw new Error("请先刷新模型列表，再刷新积分价格");
  }

  const requests: JimengPriceProbeRequest[] = [];
  for (const entry of catalog.image) {
    for (const resolution of entry.resolutions) {
      requests.push({ model: entry.model, mediaType: "image", resolution });
    }
  }
  for (const entry of catalog.video) {
    // 基准时长取区间中最小可用值：总价小、报价快，单价照样算得准。
    const duration = entry.durations[0] ?? 5;
    for (const resolution of entry.resolutions) {
      requests.push({
        model: entry.model,
        mediaType: "video",
        resolution,
        duration,
      });
    }
  }

  if (requests.length === 0) {
    throw new Error("模型目录为空，无法报价");
  }

  useJimengCatalogStore.setState({ probing: true, error: null });
  try {
    const report = await probeJimengModelPrices(executable, requests);
    useJimengCatalogStore.setState((state) => ({
      prices: report,
      probing: false,
      revision: state.revision + 1,
    }));
    return report;
  } catch (error) {
    useJimengCatalogStore.setState({
      probing: false,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function normalizePriceKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9.]/g, "");
}

function findQuote(
  model: string,
  resolution: string,
  mediaType: "image" | "video"
): JimengPriceQuote | null {
  const report = getJimengPriceReport();
  if (!report) {
    return null;
  }
  const targetResolution = normalizePriceKey(resolution);
  // 分辨率大小写两套写法并存（清单里的 `720p` / `720P`），按归一化后的键比。
  return (
    report.quotes.find(
      (quote) =>
        quote.model === model &&
        quote.mediaType === mediaType &&
        normalizePriceKey(quote.resolution) === targetResolution
    ) ?? null
  );
}

/** 自动报价得到的**单张**图片积分；没测过返回 null（调用方回退人工表）。 */
export function jimengAutoImageUnitCredits(
  model: string,
  resolution: string
): number | null {
  return findQuote(model, resolution, "image")?.unitCredits ?? null;
}

/** 自动报价得到的**每秒**视频积分；没测过返回 null。 */
export function jimengAutoVideoUnitCredits(
  model: string,
  resolution: string
): number | null {
  const quote = findQuote(model, resolution, "video");
  if (!quote) {
    return null;
  }
  return quote.unitCredits;
}

/** 测试用：把目录与价目直接塞进来，跳过 IPC。 */
export function __setJimengCatalogForTest(
  catalog: JimengModelCatalog | null,
  prices: JimengPriceReport | null = null
): void {
  useJimengCatalogStore.setState((state) => ({
    catalog,
    prices,
    revision: state.revision + 1,
  }));
}
