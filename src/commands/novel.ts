// ---------------------------------------------------------------------------
// 下载小说（番茄小说下载器 sidecar）命令封装。
//
// 下载器是一个第三方单文件程序，上游**禁用了命令行建任务**，只保留 `--server`
// 模式：在 127.0.0.1 上开一个 axum 服务提供 HTTP 接口。该服务不带任何 CORS 头，
// WebView 无法直连，因此全部请求都经 Rust 侧代理转发。
//
// 这一层只做两件事：
// 1. 托管 sidecar 生命周期（探测 / 启动 / 停止 / 状态）。
// 2. 把上游的 REST 契约翻译成有类型的 TS 函数。
// ---------------------------------------------------------------------------

import { invoke, isTauri } from "@tauri-apps/api/core";
import { downloadDir, join } from "@tauri-apps/api/path";

/** 下载器组件（sidecar 可执行文件）的探测结果。 */
export interface NovelEnvironment {
  /** sidecar 实际路径；null = 没找到（打包漏了 binaries）。 */
  binaryPath: string | null;
  available: boolean;
  message: string;
}

/** 已拉起的下载器服务。 */
export interface NovelServerInfo {
  baseUrl: string;
  port: number;
  version: string | null;
}

/** `GET /api/status`。 */
export interface NovelStatus {
  bind_addr: string;
  bind_addrs: string[];
  config: {
    api_endpoints_len: number;
    old_cli: boolean;
    save_path: string;
    use_official_api: boolean;
  };
  docker_build: boolean;
  locked: boolean;
  prewarm_error: string | null;
  prewarm_in_progress: boolean;
  save_dir: string;
  version: string;
}

/**
 * 搜索结果里的原始书目数据。
 *
 * 上游把番茄接口返回的字段几乎原样透传，字段多且杂，这里只列出界面会用到
 * 的部分，其余按需通过索引访问。
 */
export interface NovelBookRaw {
  abstract?: string;
  book_name?: string;
  original_book_name?: string;
  author?: string;
  category?: string;
  /** 封面（绝对地址，可直接渲染）。 */
  thumb_url?: string;
  detail_page_thumb_url?: string;
  /** 「186.5万人在读」。 */
  read_cnt_text?: string;
  sub_info?: string;
  score?: string;
  /** 字数，字符串形式。 */
  word_number?: string;
  tags?: string;
  first_chapter_title?: string;
  last_chapter_title?: string;
  serial_count?: string;
  creation_status?: string;
  update_status?: string;
  source?: string;
  [key: string]: unknown;
}

/** `GET /api/search?q=` 的单条结果。 */
export interface NovelSearchItem {
  author: string;
  book_id: string;
  title: string;
  raw: NovelBookRaw;
}

export interface NovelSearchResponse {
  items: NovelSearchItem[];
}

/** `GET /api/preview/:book_id`。 */
export interface NovelPreview {
  author: string;
  book_id: string;
  book_name: string;
  category: string;
  chapter_count: number;
  /** 相对路径（`/api/preview-cover/<hash>`），需经 `fetchNovelAsset` 转 data URL。 */
  cover_url: string;
  detail_cover_url: string;
  description: string;
  finished: boolean;
  first_chapter_title: string;
  last_chapter_title: string;
  original_book_name: string;
  read_count: string;
  read_count_text: string;
  score: number;
  tags: string[];
  word_count: number;
}

/** 任务状态；`done` 但章节没下全时上游会呈现为 `partial`。 */
export type NovelJobState = "queued" | "running" | "done" | "failed" | "canceled" | "partial";

/**
 * 单条下载任务。
 *
 * 注意上游的 `id` 是**自增数字**（不是字符串），`book_name_options` /
 * `format_options` 在不需要用户配置时是 `null` 而非空数组，`title` 在任务
 * 建好后的一小段时间里也可能是 `null`。
 */
export interface NovelJob {
  id: string | number;
  book_id: string;
  title: string | null;
  author?: string | null;
  state: NovelJobState | string;
  progress: { saved_chapters: number; chapter_total: number } | null;
  /** 非空 = 需要用户挑一个书名（多来源书名不一致）。 */
  book_name_options: string[] | null;
  /** 非空 = 需要用户挑输出格式。 */
  format_options: string[] | null;
  message: string | null;
  created_ms?: number;
  updated_ms?: number;
}

/** `POST /api/jobs` 的返回体，比完整任务精简。 */
export interface NovelJobCreated {
  id: string | number;
  book_id: string;
  state: string;
}

export interface NovelJobsResponse {
  done_retention_ms: number;
  items: NovelJob[];
}

export interface NovelHistoryItem {
  timestamp: string;
  book_id: string;
  book_name: string;
  author: string;
  progress: string;
  status: string;
  selected_chapters?: number | null;
  success_chapters?: number | null;
  failed_chapters?: number | null;
}

export interface NovelHistoryResponse {
  items: NovelHistoryItem[];
  keyword?: string | null;
  limit: number;
}

export interface NovelLibraryItem {
  kind: "file" | "dir" | string;
  rel_path: string;
  name: string;
  /** 扩展名（不含点）；目录为空串。 */
  ext?: string;
  size: number;
  file_count?: number | null;
  modified_ms?: number | null;
}

export interface NovelLibraryResponse {
  items: NovelLibraryItem[];
  path: string;
  root: string;
  running: boolean;
  scanned: number;
  error: string | null;
  started_ms?: number;
  updated_ms?: number;
}

/** `GET /api/config/full`；字段很多，改保存目录时会整体回写。 */
export interface NovelFullConfig {
  novel_format?: string;
  save_path?: string;
  use_official_api?: boolean;
  max_workers?: number;
  request_timeout?: number;
  max_retries?: number;
  enable_audiobook?: boolean;
  audiobook_format?: string;
  preferred_book_name_field?: string;
  allow_overwrite_files?: boolean;
  [key: string]: unknown;
}

function ensureDesktop(): void {
  if (!isTauri()) {
    throw new Error("下载小说需要在 LenTalk 桌面端运行");
  }
}

// ---------------------------------------------------------------------------
// sidecar 生命周期
// ---------------------------------------------------------------------------

/** 探测随包下载器组件是否就位；打开面板时调用一次。 */
export async function probeNovelEnvironment(): Promise<NovelEnvironment> {
  ensureDesktop();
  return invoke<NovelEnvironment>("novel_environment");
}

/** 确保服务在跑并拿到地址；已就绪会直接复用，冷启动最长等 30 秒。 */
export async function startNovelServer(): Promise<NovelServerInfo> {
  ensureDesktop();
  return invoke<NovelServerInfo>("novel_server_start");
}

export async function stopNovelServer(): Promise<void> {
  ensureDesktop();
  await invoke("novel_server_stop");
}

/** 当前服务句柄；子进程已退出时返回 null。 */
export async function novelServerStatus(): Promise<NovelServerInfo | null> {
  ensureDesktop();
  return invoke<NovelServerInfo | null>("novel_server_status");
}

// ---------------------------------------------------------------------------
// 通用代理
// ---------------------------------------------------------------------------

/** 代理一次 GET。`path` 可以带或不带前导斜杠。 */
export async function novelGet<T>(path: string): Promise<T> {
  ensureDesktop();
  return invoke<T>("novel_api_get", { path });
}

/** 代理一次 POST；`body` 省略时不带请求体。 */
export async function novelPost<T>(path: string, body?: unknown): Promise<T> {
  ensureDesktop();
  return invoke<T>("novel_api_post", { path, body: body ?? null });
}

/**
 * 把下载器上的静态资源（封面）取成 data URL。
 *
 * 上游返回的 `cover_url` 是相对路径，WebView 不在同一 origin，直接当 `<img src>`
 * 用会 404；走这里由 Rust 取回再内联。
 */
export async function fetchNovelAsset(path: string): Promise<string> {
  ensureDesktop();
  return invoke<string>("novel_asset_data_url", { path });
}

// ---------------------------------------------------------------------------
// 业务接口
// ---------------------------------------------------------------------------

export function fetchNovelStatus(): Promise<NovelStatus> {
  return novelGet<NovelStatus>("/api/status");
}

export function searchNovels(keyword: string): Promise<NovelSearchResponse> {
  return novelGet<NovelSearchResponse>(`/api/search?q=${encodeURIComponent(keyword)}`);
}

export function fetchNovelPreview(bookId: string): Promise<NovelPreview> {
  return novelGet<NovelPreview>(`/api/preview/${encodeURIComponent(bookId)}`);
}

/** 新建下载任务；`range` 省略则整本下载。 */
export function createNovelJob(options: {
  bookId: string;
  rangeStart?: number | null;
  rangeEnd?: number | null;
}): Promise<NovelJobCreated> {
  const payload: Record<string, unknown> = { book_id: options.bookId };
  if (options.rangeStart != null && options.rangeEnd != null) {
    payload.range_start = options.rangeStart;
    payload.range_end = options.rangeEnd;
  }
  return novelPost<NovelJobCreated>("/api/jobs", payload);
}

export function listNovelJobs(): Promise<NovelJobsResponse> {
  return novelGet<NovelJobsResponse>("/api/jobs");
}

export function cancelNovelJob(jobId: string | number): Promise<unknown> {
  return novelPost(`/api/jobs/${encodeURIComponent(String(jobId))}/cancel`);
}

/** 任务结束后如果书名有多个候选，用它定稿。 */
export function chooseNovelJobBookName(jobId: string | number, value: string): Promise<unknown> {
  return novelPost(`/api/jobs/${encodeURIComponent(String(jobId))}/book_name`, { value });
}

/** 任务结束后如果格式有多个候选，用它定稿。 */
export function chooseNovelJobFormat(jobId: string | number, value: string): Promise<unknown> {
  return novelPost(`/api/jobs/${encodeURIComponent(String(jobId))}/format`, { value });
}

export function listNovelHistory(options?: { limit?: number; keyword?: string | null }): Promise<NovelHistoryResponse> {
  const params = new URLSearchParams();
  params.set("limit", String(options?.limit ?? 200));
  const keyword = options?.keyword?.trim();
  if (keyword) params.set("q", keyword);
  return novelGet<NovelHistoryResponse>(`/api/history?${params.toString()}`);
}

export function fetchNovelLibrary(options?: { path?: string; start?: boolean }): Promise<NovelLibraryResponse> {
  const params = new URLSearchParams();
  const dir = options?.path?.trim();
  if (dir) params.set("path", dir);
  params.set("start", options?.start === false ? "false" : "true");
  return novelGet<NovelLibraryResponse>(`/api/library?${params.toString()}`);
}

export function fetchNovelFullConfig(): Promise<NovelFullConfig> {
  return novelGet<NovelFullConfig>("/api/config/full");
}

/** 整体回写配置（上游是全量替换，所以要先读再改再写）。 */
export function saveNovelFullConfig(config: NovelFullConfig): Promise<unknown> {
  return novelPost("/api/config/full", config);
}

/** 只改保存目录：先读全量配置，替换 `save_path` 后回写。 */
export async function updateNovelSavePath(savePath: string): Promise<NovelFullConfig> {
  const current = await fetchNovelFullConfig();
  const next: NovelFullConfig = { ...current, save_path: savePath };
  await saveNovelFullConfig(next);
  return next;
}

/** 首次启动时写入的默认保存目录名（放在系统「下载」目录下）。 */
export const DEFAULT_SAVE_FOLDER = "LenTalk小说";

/**
 * 首次启动时给保存目录一个可见的默认值。
 *
 * 上游 `save_path` 默认为空串，此时它把产物落到**自己进程的工作目录**；而我们把
 * sidecar 的 cwd 设成了应用数据目录，那是个隐藏路径，用户下完小说会找不到。
 *
 * 只在 `save_path` 为空时写入，绝不会覆盖用户手动设过的目录。
 */
export async function ensureDefaultNovelSavePath(folderName: string = DEFAULT_SAVE_FOLDER): Promise<NovelFullConfig> {
  const current = await fetchNovelFullConfig();
  if (current.save_path?.trim()) return current;
  const next: NovelFullConfig = { ...current, save_path: await join(await downloadDir(), folderName) };
  await saveNovelFullConfig(next);
  return next;
}

// ---------------------------------------------------------------------------
// 展示辅助
// ---------------------------------------------------------------------------

/**
 * 从搜索结果里挑一张能直接渲染的封面。
 *
 * 搜索接口给的是番茄 CDN 的绝对地址，WebView 可以直接加载；预览接口给的是
 * 相对路径，必须走 `fetchNovelAsset`。
 */
export function pickSearchCover(item: NovelSearchItem): string | null {
  const raw = item.raw ?? {};
  const candidates = [raw.thumb_url, raw.detail_page_thumb_url];
  for (const value of candidates) {
    if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
  }
  return null;
}
