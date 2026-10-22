/**
 * 缩略图解析器：把素材的原图地址换成真正的小图。
 *
 * 背景：候选卡片里的缩略图格子只有约 54x40 像素，但素材记录里的「预览图」常常就是原图
 * 本身（`cinematicMirrorSync` 直接把 `referencePaths[0]` 写进 `previewImageUrl`）。
 * 实测本机素材库前 36 张角色参考图合计约 145MB，单张 p90 近 10MB —— 展开卡片那一下
 * 要读盘并解码上百 MB 只为画几十个小方格，怎么调整渲染批次都不会快。
 *
 * 所以这里做三件事：
 * 1. 判定哪些源地址可以交给 Rust 生成缩略图（只认本地文件路径）。
 * 2. 生成结果进内存缓存，重复打开、滚动回看都是同步命中，不再走 IPC。
 * 3. 用并发闸门限制同时进行的生成任务：单张原图解码要占几百 MB 瞬时内存，
 *    36 个任务一起上会把机器压住，反而更慢。
 *
 * 生成失败（文件被删、格式不支持、非 Tauri 环境）时静默回落原图，
 * 调用方通过 `resolveDisplaySource` 拿到兜底地址即可，不需要处理错误分支。
 */

import { convertFileSrc, isTauri } from "@tauri-apps/api/core";

import { ensureImageThumbnail } from "@/commands/thumbnail";
import { resolveImageDisplayUrl } from "@/features/canvas/application/imageData";

/**
 * 目标长边像素。
 *
 * 卡片格子放大到约 108px 宽（四列网格）之后，2x 屏需要约 216 物理像素，
 * 192 会明显发糊 —— 提到 256。缓存键里带了这个尺寸，改值只会让旧图重新生成一次。
 */
export const THUMBNAIL_MAX_EDGE = 256;

/**
 * 画布节点主体图的专用尺寸。
 *
 * 与素材选择器的 256 分开的理由：卡片格子只有约 108px 宽，256 绰绰有余；而画布节点
 * 动辄 200~320 CSS px，2x 屏要 500+ 物理像素，256 会明显发糊。
 *
 * 为什么定 512 而不是更小：生成流水线落盘的 preview 就是 512（`DEFAULT_PREVIEW_MAX_DIMENSION`），
 * 取同一个尺寸能保证**有 preview 的图和没 preview 的图观感一致**，不会出现「新建的图清楚、
 * 上传的照片发糊」。再小就开始肉眼可见地软了，而 512 相比原图仍是量级上的节省 ——
 * 一张 4000x3000 的照片解码要几十 MB 瞬时内存，512 长边只有约 0.2M 像素。
 *
 * 为什么不干脆用原图：一屏挂 20 个节点就是几百 MB —— 这正是「每次打开项目都要重新加载媒体、
 * 很卡」的根因。而 Rust 侧生成的缩略图**落盘持久化**，重开项目时命中只做一次文件 stat。
 *
 * 改了值只会让旧缩略图重新生成一次（缓存键里带了尺寸）。
 */
export const CANVAS_THUMBNAIL_MAX_EDGE = 512;

/** 同时在跑的生成任务上限的下界：太少的话首屏要填很久。 */
const THUMBNAIL_CONCURRENCY_MIN = 2;
/** 上界：原图动辄 8MP，每张解码瞬时占用几十 MB，开太多了反而互相拖慢。 */
const THUMBNAIL_CONCURRENCY_MAX = 6;

/**
 * 纯函数：按 CPU 核数决定并发度。
 *
 * 解码是纯 CPU 工作，并发超过核数只会互相抢占，还会成倍放大瞬时内存；
 * 但只用 1~2 个的话，36 张 8MP 的参考图要填十几秒。留一个核给界面。
 */
export function resolveThumbnailConcurrency(hardwareConcurrency?: number): number {
  const cores =
    typeof hardwareConcurrency === "number" && Number.isFinite(hardwareConcurrency) && hardwareConcurrency > 0
      ? Math.floor(hardwareConcurrency)
      : 4;
  return Math.min(THUMBNAIL_CONCURRENCY_MAX, Math.max(THUMBNAIL_CONCURRENCY_MIN, cores - 1));
}

/** 当前环境的并发度。 */
export const THUMBNAIL_CONCURRENCY = resolveThumbnailConcurrency(
  typeof navigator === "undefined" ? undefined : navigator.hardwareConcurrency,
);

/** 纯函数：这个源地址是不是「本地文件」，能不能交给 Rust 生成缩略图。 */
export function isThumbnailableLocalSource(source: string): boolean {
  const value = (source ?? "").trim();
  if (!value) return false;
  const lower = value.toLowerCase();
  if (
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("data:") ||
    lower.startsWith("blob:") ||
    lower.startsWith("asset://") ||
    lower.startsWith("ipc://")
  ) {
    return false;
  }
  // 剩下的都是本地路径：Windows 盘符 / UNC / POSIX 绝对路径 / file:// 地址。
  return true;
}

/** 纯函数：当前环境能不能真的生成缩略图（浏览器预览模式下不行）。 */
export function canGenerateThumbnail(source: string): boolean {
  return isTauri() && isThumbnailableLocalSource(source);
}

/**
 * 带并发上限的任务闸门。
 *
 * 抽成独立函数是为了能单测：它只关心「最多几个在跑」和「排队顺序」，
 * 与缩略图本身无关。
 */
export function createTaskGate(limit: number) {
  const safeLimit = Math.max(1, Math.floor(limit));
  const waiting: Array<() => void> = [];
  let active = 0;

  return function schedule<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        active += 1;
        task()
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            const next = waiting.shift();
            if (next) next();
          });
      };
      if (active < safeLimit) run();
      else waiting.push(run);
    });
  };
}

/** 缓存键：同一张图在不同尺寸下是两份独立的缩略图。 */
function thumbnailKey(source: string, maxEdge: number): string {
  return `${maxEdge}|${source}`;
}

/** 生成成功的缩略图地址（`尺寸|源地址` → 可直接给 `<img>` 的 asset:// 地址）。 */
const readyThumbnails = new Map<string, string>();
/** 生成失败的键。不重试：同一张图反复失败只会刷屏。 */
const failedThumbnails = new Set<string>();
/** 进行中的任务，同一个键并发请求时复用同一个 Promise。 */
const pendingThumbnails = new Map<string, Promise<string | null>>();

const scheduleThumbnail = createTaskGate(THUMBNAIL_CONCURRENCY);

/** 已生成好的缩略图地址；没有则返回 undefined。 */
export function readThumbnail(
  source: string,
  maxEdge: number = THUMBNAIL_MAX_EDGE,
): string | undefined {
  return readyThumbnails.get(thumbnailKey(source, maxEdge));
}

/**
 * 不能/不必生成缩略图时的展示地址（原图，经 asset 协议转换）。
 *
 * 缓存刻意**不在这里做** —— `resolveImageDisplayUrl` 自身已经带上有界缓存，
 * 再维护一份只是重复。
 */
export function resolveFallbackSource(source: string): string {
  return resolveImageDisplayUrl(source);
}

/** 卡片里 `<img>` 最终该用的地址：优先小图，其次原图。 */
export function resolveDisplaySource(
  source: string,
  maxEdge: number = THUMBNAIL_MAX_EDGE,
): string {
  return readThumbnail(source, maxEdge) ?? resolveFallbackSource(source);
}

async function generateThumbnail(source: string, maxEdge: number): Promise<string | null> {
  const key = thumbnailKey(source, maxEdge);
  try {
    const generatedPath = await ensureImageThumbnail(source, maxEdge);
    const displayUrl = convertFileSrc(generatedPath);
    readyThumbnails.set(key, displayUrl);
    return displayUrl;
  } catch (error) {
    failedThumbnails.add(key);
    console.warn("[thumbnail] 生成缩略图失败，回落原图", source, error);
    return null;
  }
}

/**
 * 请求一张缩略图。已生成时同步 resolve；进行中时复用同一个 Promise。
 * 生成失败返回 `null`（调用方用 `resolveFallbackSource` 兜底）。
 */
export function requestThumbnail(
  source: string,
  maxEdge: number = THUMBNAIL_MAX_EDGE,
): Promise<string | null> {
  const cached = readThumbnail(source, maxEdge);
  if (cached) return Promise.resolve(cached);

  const key = thumbnailKey(source, maxEdge);
  if (failedThumbnails.has(key) || !canGenerateThumbnail(source)) return Promise.resolve(null);

  const existing = pendingThumbnails.get(key);
  if (existing) return existing;

  const task = scheduleThumbnail(() => generateThumbnail(source, maxEdge));
  const tracked = task.finally(() => {
    pendingThumbnails.delete(key);
  });
  pendingThumbnails.set(key, tracked);
  return tracked;
}

/**
 * 一次性请求一批缩略图。
 *
 * 返回的 Map **对每个请求过的源地址都有条目**：成功是小图地址，失败是空串。
 * 空串不是可有可无的细节 —— 卡片要靠「有条目」来判断该停止占位动画；
 * 只回传成功项的话，源文件被删掉的那些格子会永远停在闪烁的占位上。
 */
export async function requestThumbnails(
  sources: readonly string[],
  maxEdge: number = THUMBNAIL_MAX_EDGE,
): Promise<Map<string, string>> {
  const unique = [...new Set(sources)];
  if (unique.length === 0) return new Map();
  const results = await Promise.all(unique.map((source) => requestThumbnail(source, maxEdge)));
  const resolved = new Map<string, string>();
  unique.forEach((source, index) => {
    resolved.set(source, results[index] ?? "");
  });
  return resolved;
}

/** 测试与排查用：把内存缓存清空。 */
export function resetThumbnailCache(): void {
  readyThumbnails.clear();
  failedThumbnails.clear();
  pendingThumbnails.clear();
}
