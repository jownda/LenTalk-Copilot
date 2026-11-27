/**
 * RunningHub 画布（rhtvcli）模型目录。
 *
 * 为什么要有这一层：画布目录由服务端**实时下发**，而且是唯一含 RH Enhanced 系
 * （`Minimax-H3-RH-Enhanced` 这类只在画布里存在的自研增强模型）的来源。硬编码一份
 * 清单，画布一上新模型就得跟着发版；所以这里只缓存，不在源码里登记模型。
 *
 * 除目录本身，这里还缓存**每个模型的参数清单**（比例/分辨率/时长…）。画布的每个模型
 * 字段名都不一样（`aspectRatio` / `whAspectRatio` / `duration` / `videoDuration`），
 * 猜错服务端只回 `INVALID_ARGUMENT` 且不说是哪个字段，所以只能按实时 schema 渲染。
 *
 * 与 `jimengCatalog` 的分工保持一致：本文件管"取数与缓存"，`registry.ts` 管"怎么变成
 * 下拉里的模型"。取数失败不抛错（没装 CLI / 没登录都是常态），由界面提示。
 */

import { create } from 'zustand';

import {
  fetchRhtvCliStatus,
  fetchRhtvModelParams,
  fetchRhtvModels,
  type RhtvCliStatus,
  type RhtvModelItem,
  type RhtvParamSpec,
} from '@/commands/rhtvCli';
import { useRhtvCanvasStore } from '@/stores/rhtvCanvasStore';

export type RhtvCatalogKind = 'image' | 'video' | 'audio';

const KINDS: RhtvCatalogKind[] = ['image', 'video', 'audio'];

/** 目录缓存有效期。画布上新不频繁，5 分钟足够，也避免每次开面板都跑一次 CLI。 */
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * 每次批量取 schema 的模型数。
 *
 * Rust 侧是**串行**的（CLI 有本机单实例锁，并发只会拿到 `LOCAL_BUSY`），所以这个数字
 * 决定单次 IPC 的耗时：单个模型约 1.9 秒，8 个约 15 秒。分批是为了让界面能
 * 边拉边出现可选项，而不是等全部结束才刷新一次。
 */
const SPEC_BATCH_SIZE = 8;

export interface RhtvSpecEntry {
  /** 取这份 schema 时目录给的 `schemaHash`；变了说明服务端改了参数，要重拉。 */
  hash?: string;
  params: RhtvParamSpec[];
}

interface RhtvCatalogState {
  status: RhtvCliStatus | null;
  image: RhtvModelItem[];
  video: RhtvModelItem[];
  audio: RhtvModelItem[];
  loadedAt: number | null;
  loading: boolean;
  error: string | null;
  /** 递增即代表"目录变了"，订阅它的组件会重渲染。 */
  revision: number;
  /** `modelCode -> 参数清单`。初值来自持久化缓存，避免每次启动都重拉 140 次。 */
  specs: Record<string, RhtvSpecEntry>;
  specsLoading: boolean;
}

export const useRhtvCatalogStore = create<RhtvCatalogState>(() => ({
  status: null,
  image: [],
  video: [],
  audio: [],
  loadedAt: null,
  loading: false,
  error: null,
  revision: 0,
  specs: useRhtvCanvasStore.getState().specs,
  specsLoading: false,
}));

/** 用户在设置里填的 rhtvcli 可执行文件（留空 = 自动探测）。 */
export function rhtvExecutable(): string | undefined {
  const value = useRhtvCanvasStore.getState().executable?.trim();
  return value && value.length > 0 ? value : undefined;
}

export function useRhtvCatalogRevision(): number {
  return useRhtvCatalogStore((state) => state.revision);
}

export function useRhtvCatalogStatus(): RhtvCliStatus | null {
  return useRhtvCatalogStore((state) => state.status);
}

export function useRhtvCatalogError(): string | null {
  return useRhtvCatalogStore((state) => state.error);
}

export function getRhtvCatalog(): {
  status: RhtvCliStatus | null;
  image: RhtvModelItem[];
  video: RhtvModelItem[];
  audio: RhtvModelItem[];
} {
  const state = useRhtvCatalogStore.getState();
  return { status: state.status, image: state.image, video: state.video, audio: state.audio };
}

/** 某个模型的参数清单；还没拉到就返回空数组（调用方据此退回通用档位）。 */
export function getRhtvSpec(modelCode: string): RhtvParamSpec[] {
  return useRhtvCatalogStore.getState().specs[modelCode]?.params ?? [];
}

export function isRhtvSpecLoaded(modelCode: string): boolean {
  return Boolean(useRhtvCatalogStore.getState().specs[modelCode]);
}

/** 目录是否已经可用（装了 CLI 并登录成功、且拉到过模型）。 */
export function isRhtvCatalogReady(): boolean {
  const state = useRhtvCatalogStore.getState();
  return Boolean(state.status?.loggedIn) && state.loadedAt !== null;
}

export function listRhtvModels(kind: RhtvCatalogKind): RhtvModelItem[] {
  return useRhtvCatalogStore.getState()[kind];
}

function persistSpecs(specs: Record<string, RhtvSpecEntry>): void {
  useRhtvCanvasStore.getState().setSpecs(specs);
}

/** 正在拉取的模型，避免同一模型被多个节点重复请求。 */
const inFlightSpecs = new Set<string>();

/**
 * 按需拉某个模型的参数清单（节点选中画布模型时调用）。
 *
 * 为什么是懒加载：每个模型要起一次 CLI（约 1.9 秒），画布有 100 个图文模型，
 * 全量预取要三分钟。而且 CLI 是单实例的，后台长跑会和用户点生成抢锁。
 * 结果按 `schemaHash` 落盘，同一个模型只拉一次。
 */
export async function ensureRhtvSpec(
  modelCode: string,
  kind: RhtvCatalogKind,
): Promise<void> {
  const state = useRhtvCatalogStore.getState();
  const cached = state.specs[modelCode];
  const item = state[kind].find((entry) => entry.modelCode === modelCode);
  const stale =
    Boolean(cached?.hash) && Boolean(item?.schemaHash) && cached?.hash !== item?.schemaHash;
  if (cached && !stale) return;
  if (inFlightSpecs.has(modelCode)) return;
  if (!state.status?.loggedIn) return;

  inFlightSpecs.add(modelCode);
  try {
    const [result] = await fetchRhtvModelParams([{ model: modelCode, kind }], rhtvExecutable());
    if (!result || result.error || result.params.length === 0) return;
    const specs = {
      ...useRhtvCatalogStore.getState().specs,
      [modelCode]: { hash: item?.schemaHash, params: result.params },
    };
    persistSpecs(specs);
    useRhtvCatalogStore.setState({
      specs,
      revision: useRhtvCatalogStore.getState().revision + 1,
    });
  } catch (error) {
    console.warn(`[rhtvCatalog] 取模型参数失败：${modelCode}`, error);
  } finally {
    inFlightSpecs.delete(modelCode);
  }
}

/**
 * 补齐模型参数清单。
 *
 * 只拉「目录里有、缓存里没有或 schemaHash 变了」的模型；`force` 用于设置页的手动同步。
 * 分批提交：每批回来就落盘 + 递增 revision，界面能边拉边出现可选项，而不是等全部结束。
 */
export async function ensureRhtvSpecs(
  options: { force?: boolean; kinds?: RhtvCatalogKind[] } = {},
): Promise<void> {
  const state = useRhtvCatalogStore.getState();
  if (state.specsLoading) return;
  if (!state.status?.loggedIn) return;

  const kinds = options.kinds ?? (['image', 'video'] as RhtvCatalogKind[]);
  const pending: Array<{ model: string; kind: string }> = [];
  for (const kind of kinds) {
    for (const item of state[kind]) {
      if (item.available === false) continue;
      const cached = state.specs[item.modelCode];
      const stale = Boolean(cached) && Boolean(cached.hash) && Boolean(item.schemaHash) && cached.hash !== item.schemaHash;
      if (!options.force && cached && !stale) continue;
      pending.push({ model: item.modelCode, kind });
    }
  }
  if (pending.length === 0) return;

  const executable = rhtvExecutable();
  useRhtvCatalogStore.setState({ specsLoading: true });

  let specs = { ...useRhtvCatalogStore.getState().specs };
  let consecutiveEmpty = 0;

  try {
    for (let index = 0; index < pending.length; index += SPEC_BATCH_SIZE) {
      const batch = pending.slice(index, index + SPEC_BATCH_SIZE);
      let results;
      try {
        results = await fetchRhtvModelParams(batch, executable);
      } catch (error) {
        console.warn('[rhtvCatalog] 批量取模型参数失败', error);
        break;
      }

      let filled = 0;
      for (const result of results) {
        if (result.error || result.params.length === 0) continue;
        const hash = state[result.kind as RhtvCatalogKind]?.find(
          (item) => item.modelCode === result.model,
        )?.schemaHash;
        specs[result.model] = { hash, params: result.params };
        filled += 1;
      }

      // 服务端不可用（未授权 / 断网）时别把剩下的 100 个也刷一遍，只会得到一堆同样的错误。
      consecutiveEmpty = filled === 0 ? consecutiveEmpty + 1 : 0;
      if (consecutiveEmpty >= 2) {
        console.warn('[rhtvCatalog] 连续两批都取不到参数，停止本轮同步');
        break;
      }

      persistSpecs(specs);
      useRhtvCatalogStore.setState({
        specs,
        revision: useRhtvCatalogStore.getState().revision + 1,
      });
    }
  } finally {
    persistSpecs(specs);
    useRhtvCatalogStore.setState({ specsLoading: false });
  }
}

/** 拉一次目录。`force=false` 时走 TTL 缓存。 */
export async function refreshRhtvCatalog(force = false): Promise<void> {
  const state = useRhtvCatalogStore.getState();
  if (state.loading) return;
  if (!force && state.loadedAt && Date.now() - state.loadedAt < CACHE_TTL_MS) return;

  useRhtvCatalogStore.setState({ loading: true });
  const executable = rhtvExecutable();

  try {
    const status = await fetchRhtvCliStatus(executable);
    if (!status.found || !status.loggedIn) {
      useRhtvCatalogStore.setState({
        status,
        image: [],
        video: [],
        audio: [],
        loadedAt: Date.now(),
        loading: false,
        error: status.found ? status.message : status.message,
        revision: useRhtvCatalogStore.getState().revision + 1,
      });
      return;
    }

    const results = await Promise.all(
      KINDS.map(async (kind) => {
        try {
          return [kind, await fetchRhtvModels(kind, { executable })] as const;
        } catch (error) {
          // 单个类型失败不该让整份目录作废。
          console.warn(`[rhtvCatalog] 拉取 ${kind} 目录失败`, error);
          return [kind, [] as RhtvModelItem[]] as const;
        }
      }),
    );

    const next: Partial<RhtvCatalogState> = {
      status,
      loadedAt: Date.now(),
      loading: false,
      error: null,
    };
    for (const [kind, items] of results) {
      next[kind] = items;
    }
    useRhtvCatalogStore.setState({
      ...next,
      revision: useRhtvCatalogStore.getState().revision + 1,
    });

  } catch (error) {
    useRhtvCatalogStore.setState({
      loading: false,
      loadedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
      revision: useRhtvCatalogStore.getState().revision + 1,
    });
  }
}

/** 应用启动时调用：只读探测 + 后台刷新，失败静默（没装 CLI 是常态）。 */
export function bootstrapRhtvCatalog(): void {
  void refreshRhtvCatalog().catch((error) => {
    console.warn('[rhtvCatalog] 初始化失败', error);
  });
}

export function __setRhtvCatalogForTest(payload: Partial<RhtvCatalogState>): void {
  useRhtvCatalogStore.setState(payload);
}
