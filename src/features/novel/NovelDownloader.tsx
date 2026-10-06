// ---------------------------------------------------------------------------
// 下载小说：番茄小说下载器（sidecar）的图形界面。
//
// 上游程序本身是一份 TUI / 带内嵌网页的程序，这里按 LenTalk 的卡片式风格
// 重做界面，功能与上游 Web UI 对齐：
//   搜索 → 书籍预览（含章节范围）→ 建任务 → 进度与取消 → 下载历史 → 书库
//
// 所有请求都经 Rust 代理（上游服务没有 CORS 头，WebView 不能直连）；
// 封面分两种：搜索结果是番茄 CDN 的绝对地址可直接渲染，预览接口给的是相对
// 路径，必须经 `fetchNovelAsset` 转成 data URL。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Ban, BookOpen, CircleAlert, Download, FolderOpen, LoaderCircle, RefreshCw, Search } from "lucide-react";

import { UiButton, UiGhostIconButton, UiInput, UiModal, UiSelect } from "@/components/ui/primitives";
import {
  cancelNovelJob,
  chooseNovelJobBookName,
  chooseNovelJobFormat,
  createNovelJob,
  ensureDefaultNovelSavePath,
  fetchNovelAsset,
  fetchNovelFullConfig,
  fetchNovelLibrary,
  fetchNovelPreview,
  fetchNovelStatus,
  listNovelHistory,
  listNovelJobs,
  pickSearchCover,
  probeNovelEnvironment,
  saveNovelFullConfig,
  searchNovels,
  startNovelServer,
  updateNovelSavePath,
  type NovelEnvironment,
  type NovelFullConfig,
  type NovelHistoryItem,
  type NovelJob,
  type NovelLibraryResponse,
  type NovelPreview,
  type NovelSearchItem,
  type NovelServerInfo,
  type NovelStatus,
} from "@/commands/novel";

interface Notice {
  kind: "error" | "success" | "info";
  text: string;
}

const CARD_CLASS = "rounded-xl border border-border-dark bg-surface-dark p-4";
const LABEL_CLASS = "text-xs font-medium text-text-muted";

/** 任务轮询间隔：上游任务表是前端轮询式的，没有推送通道。 */
const JOB_POLL_MS = 2000;
/** 每轮询这么多次顺带刷一次历史。 */
const HISTORY_EVERY_TICKS = 5;

function formatWords(value: string | undefined): string | null {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  if (raw >= 10000) return `${(raw / 10000).toFixed(1)} 万字`;
  return `${raw} 字`;
}

function formatBytes(bytes: number | null | undefined): string {
  const value = Number(bytes ?? 0);
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

/**
 * 过滤下载器自己的内部条目。
 *
 * 数据目录里混着 `logs/` 和随包依赖 `_deps/`，它们跟「我下载的小说」无关，
 * 列出来只会干扰判断。
 */
function isInternalEntry(name: string): boolean {
  return name === "logs" || name.startsWith("_") || name.startsWith(".");
}

/** 把取消/失败消息压成一行，避免撑破布局。 */
function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function NovelDownloader() {
  const { t } = useTranslation();

  const [environment, setEnvironment] = useState<NovelEnvironment | null>(null);
  const [probing, setProbing] = useState(true);
  const [server, setServer] = useState<NovelServerInfo | null>(null);
  const [starting, setStarting] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const [status, setStatus] = useState<NovelStatus | null>(null);
  const [fullConfig, setFullConfig] = useState<NovelFullConfig | null>(null);
  const [novelFormat, setNovelFormat] = useState("epub");

  const [keyword, setKeyword] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<NovelSearchItem[]>([]);
  const [searched, setSearched] = useState(false);

  const [preview, setPreview] = useState<NovelPreview | null>(null);
  const [previewCover, setPreviewCover] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  const [creating, setCreating] = useState(false);

  const [jobs, setJobs] = useState<NovelJob[]>([]);
  const [pendingConfig, setPendingConfig] = useState<{ jobId: string | number; value: string } | null>(null);

  const [history, setHistory] = useState<NovelHistoryItem[]>([]);
  const [historyKeyword, setHistoryKeyword] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);

  const [library, setLibrary] = useState<NovelLibraryResponse | null>(null);
  const [libraryPath, setLibraryPath] = useState("");
  const [libraryLoading, setLibraryLoading] = useState(false);

  const tickRef = useRef(0);
  const activeRef = useRef(true);
  /** React StrictMode 会把 effect 跑两遍，这里挡掉第二次 —— 否则会多起一个下载器进程。 */
  const bootedRef = useRef(false);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  // -------------------------------------------------------------------------
  // 取数
  // -------------------------------------------------------------------------

  const refreshJobs = useCallback(async () => {
    try {
      const data = await listNovelJobs();
      if (!activeRef.current) return;
      setJobs(data.items ?? []);
    } catch {
      // 轮询失败静默处理：服务重启瞬间会短暂失败，不值得打断用户。
    }
  }, []);

  const refreshHistory = useCallback(async (search?: string, silent = false) => {
    setHistoryLoading(true);
    try {
      const data = await listNovelHistory({ limit: 200, keyword: search ?? null });
      if (!activeRef.current) return;
      setHistory(data.items ?? []);
    } catch (error) {
      // 轮询刷新失败静默处理，只有用户主动点「刷新」才值得报错。
      if (!activeRef.current || silent) return;
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      if (activeRef.current) setHistoryLoading(false);
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    const [nextStatus, config] = await Promise.all([fetchNovelStatus(), fetchNovelFullConfig()]);
    if (!activeRef.current) return;
    setStatus(nextStatus);
    setFullConfig(config);
    setNovelFormat(String(config.novel_format ?? "epub"));
  }, []);

  const boot = useCallback(async () => {
    setProbing(true);
    try {
      const env = await probeNovelEnvironment();
      if (!activeRef.current) return;
      setEnvironment(env);
      if (!env.available) {
        setNotice({ kind: "error", text: env.message });
        return;
      }

      setStarting(true);
      const info = await startNovelServer();
      if (!activeRef.current) return;
      setServer(info);
      setStarting(false);

      // 首次启动时给保存目录一个可见的默认值（上游默认为空 → 产物会落进
      // 隐藏的应用数据目录）。写失败不阻断启动，用户仍可手动选目录。
      await ensureDefaultNovelSavePath().catch(() => undefined);

      await refreshStatus();
      await refreshJobs();
      await refreshHistory();
    } catch (error) {
      if (!activeRef.current) return;
      setStarting(false);
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      if (activeRef.current) setProbing(false);
    }
  }, [refreshHistory, refreshJobs, refreshStatus]);

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    void boot();
  }, [boot]);

  const handleRetryBoot = useCallback(() => {
    setNotice(null);
    bootedRef.current = true;
    void boot();
  }, [boot]);

  /** 是否还有在跑的任务（决定要不要显示小转圈）。 */
  const hasActiveJobs = useMemo(() => jobs.some((job) => job.state === "running" || job.state === "queued"), [jobs]);

  /** 书库里剔掉下载器自己的内部条目（logs / _deps / 点文件）。 */
  const libraryEntries = useMemo(
    () => (library?.items ?? []).filter((item) => !isInternalEntry(item.name || item.rel_path)),
    [library],
  );

  // 任务轮询：只在服务就绪后开。
  useEffect(() => {
    if (!server) return;
    const timer = window.setInterval(() => {
      void refreshJobs();
      tickRef.current += 1;
      if (tickRef.current % HISTORY_EVERY_TICKS === 0) {
        void refreshHistory(historyKeyword, true);
      }
    }, JOB_POLL_MS);
    return () => window.clearInterval(timer);
  }, [server, refreshJobs, refreshHistory, historyKeyword]);

  // 有任务在跑 → 跑完的那一刻补刷一次历史，让「任务完成 / 历史出现」衔接上。
  const prevActiveRef = useRef(false);
  useEffect(() => {
    const previous = prevActiveRef.current;
    prevActiveRef.current = hasActiveJobs;
    if (previous && !hasActiveJobs && server) {
      void refreshHistory(historyKeyword, true);
    }
  }, [hasActiveJobs, server, refreshHistory, historyKeyword]);

  // -------------------------------------------------------------------------
  // 行为
  // -------------------------------------------------------------------------

  const handleSearch = useCallback(async () => {
    const query = keyword.trim();
    if (!query) return;
    setSearching(true);
    setNotice(null);
    try {
      const data = await searchNovels(query);
      if (!activeRef.current) return;
      setResults(data.items ?? []);
      setSearched(true);
    } catch (error) {
      if (!activeRef.current) return;
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      if (activeRef.current) setSearching(false);
    }
  }, [keyword]);

  const handleOpenPreview = useCallback(async (bookId: string) => {
    setPreviewLoading(true);
    setPreviewCover(null);
    setRangeStart("");
    setRangeEnd("");
    setPreview({
      // 先用最小占位撑住弹窗，避免点击到数据回来之间闪一下。
      book_id: bookId,
    } as NovelPreview);
    try {
      const data = await fetchNovelPreview(bookId);
      if (!activeRef.current) return;
      setPreview(data);
      const cover = data.cover_url || data.detail_cover_url;
      if (cover) {
        const dataUrl = await fetchNovelAsset(cover);
        if (activeRef.current) setPreviewCover(dataUrl);
      }
    } catch (error) {
      if (!activeRef.current) return;
      setPreview(null);
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      if (activeRef.current) setPreviewLoading(false);
    }
  }, []);

  const handleCreateJob = useCallback(async () => {
    if (!preview) return;
    const total = preview.chapter_count ?? 0;
    const start = rangeStart.trim() ? Number(rangeStart) : null;
    const end = rangeEnd.trim() ? Number(rangeEnd) : null;

    if (start != null && (!Number.isInteger(start) || start < 1)) {
      setNotice({ kind: "error", text: t("novel.rangeInvalid", "章节范围无效") });
      return;
    }
    if (end != null && (!Number.isInteger(end) || end < 1 || (start != null && end < start))) {
      setNotice({ kind: "error", text: t("novel.rangeInvalid", "章节范围无效") });
      return;
    }
    if (total > 0 && end != null && end > total) {
      setNotice({
        kind: "error",
        text: t("novel.rangeOutOfBounds", "结束章超出该书章节总数（共 {{n}} 章）", { n: total }),
      });
      return;
    }

    setCreating(true);
    setNotice(null);
    try {
      await createNovelJob({
        bookId: preview.book_id,
        rangeStart: start != null && end != null ? start : null,
        rangeEnd: start != null && end != null ? end : null,
      });
      if (!activeRef.current) return;
      setPreview(null);
      setNotice({ kind: "success", text: t("novel.jobCreated", "已加入下载队列") });
      await refreshJobs();
    } catch (error) {
      if (!activeRef.current) return;
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      if (activeRef.current) setCreating(false);
    }
  }, [preview, rangeEnd, rangeStart, refreshJobs, t]);

  const handleCancel = useCallback(
    async (jobId: string | number) => {
      try {
        await cancelNovelJob(jobId);
        await refreshJobs();
      } catch (error) {
        setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
      }
    },
    [refreshJobs],
  );

  const handleRetry = useCallback(
    async (job: NovelJob) => {
      try {
        await createNovelJob({ bookId: job.book_id });
        setNotice({ kind: "success", text: t("novel.jobCreated", "已加入下载队列") });
        await refreshJobs();
      } catch (error) {
        setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
      }
    },
    [refreshJobs, t],
  );

  const handleSubmitConfig = useCallback(
    async (job: NovelJob) => {
      if (!pendingConfig || pendingConfig.jobId !== job.id) return;
      const value = pendingConfig.value.trim();
      if (!value) return;
      try {
        if ((job.book_name_options ?? []).length > 0) {
          await chooseNovelJobBookName(job.id, value);
        } else {
          await chooseNovelJobFormat(job.id, value);
        }
        setPendingConfig(null);
        await refreshJobs();
      } catch (error) {
        setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
      }
    },
    [pendingConfig, refreshJobs],
  );

  const handlePickSaveDir = useCallback(async () => {
    try {
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked !== "string" || !picked) return;
      const next = await updateNovelSavePath(picked);
      if (!activeRef.current) return;
      setFullConfig(next);
      // 换了目录，之前那份列表属于旧目录，清掉免得误导。
      setLibrary(null);
      setLibraryPath("");
      await refreshStatus();
      setNotice({ kind: "success", text: t("novel.savePathUpdated", "保存目录已更新") });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }, [refreshStatus, t]);

  const handleFormatChange = useCallback(
    async (value: string) => {
      setNovelFormat(value);
      if (!fullConfig) return;
      try {
        // 上游的配置接口是全量替换，必须先读再改再写。
        const next: NovelFullConfig = { ...fullConfig, novel_format: value };
        await saveNovelFullConfig(next);
        if (!activeRef.current) return;
        setFullConfig(next);
      } catch (error) {
        if (!activeRef.current) return;
        setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
      }
    },
    [fullConfig],
  );

  const handleLoadLibrary = useCallback(async (path: string, start: boolean) => {
    setLibraryLoading(true);
    try {
      const data = await fetchNovelLibrary({ path, start });
      if (!activeRef.current) return;
      setLibrary(data);
      setLibraryPath(data.path ?? "");
    } catch (error) {
      if (!activeRef.current) return;
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      if (activeRef.current) setLibraryLoading(false);
    }
  }, []);

  const handleRevealSaveDir = useCallback(async () => {
    // 同 effectiveSaveDir：优先用实时配置，否则会打开到启动快照里的旧目录。
    const root = fullConfig?.save_path?.trim() || status?.save_dir;
    if (!root) return;
    try {
      await revealItemInDir(root);
    } catch (error) {
      if (!activeRef.current) return;
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }, [fullConfig, status]);

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  const ready = Boolean(server) && !probing;
  // 上游 /api/status 里的 config 是「服务启动那一刻」的快照，改完保存目录不会刷新；
  // /api/config/full 才是实时的，所以显示优先取它，快照仅作兜底。
  const effectiveSaveDir = fullConfig?.save_path?.trim() || status?.save_dir || status?.config.save_path?.trim() || "";

  if (probing || starting) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-text-muted">
        <LoaderCircle className="h-4 w-4 animate-spin" />
        {t("novel.starting", "正在启动下载器组件…")}
      </div>
    );
  }

  if (environment && !environment.available) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <CircleAlert className="h-6 w-6 text-red-400" />
        <p className="text-sm text-red-400">{environment.message}</p>
        <p className="max-w-md text-xs text-text-muted">
          {t(
            "novel.envHint",
            "安装包内应包含 tomato-novel-downloader 可执行文件；开发态请确认 src-tauri/binaries 下存在对应平台的二进制。",
          )}
        </p>
        <UiButton size="sm" variant="muted" onClick={handleRetryBoot}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          {t("novel.retryBoot", "重新检测")}
        </UiButton>
      </div>
    );
  }

  if (!server) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <CircleAlert className="h-6 w-6 text-amber-400" />
        <p className="max-w-lg text-sm text-amber-400">
          {notice?.text || t("novel.serverFailed", "下载器组件启动失败。")}
        </p>
        <UiButton size="sm" variant="muted" onClick={handleRetryBoot}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          {t("novel.retryBoot", "重新检测")}
        </UiButton>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 py-4">
      {notice && (
        <div
          className={`flex shrink-0 items-start gap-2 rounded-lg border px-3 py-2 text-sm ${
            notice.kind === "error"
              ? "border-red-500/40 bg-red-500/10 text-red-400"
              : notice.kind === "success"
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                : "border-border-dark bg-surface-dark text-text-muted"
          }`}
        >
          {notice.kind === "error" ? <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" /> : null}
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{notice.text}</span>
          <UiGhostIconButton onClick={() => setNotice(null)} title={t("common.close", "关闭")}>
            <Ban className="h-3.5 w-3.5" />
          </UiGhostIconButton>
        </div>
      )}

      {/* 运行状态 + 保存位置 */}
      <section className={CARD_CLASS}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="flex items-center gap-1.5 text-xs text-text-muted">
            <span className={`inline-block h-2 w-2 rounded-full ${ready ? "bg-emerald-500" : "bg-amber-500"}`} />
            {ready
              ? t("novel.serverReady", "下载器就绪 · v{{v}} · 端口 {{port}}", {
                  v: server?.version ?? "?",
                  port: server?.port ?? "?",
                })
              : t("novel.serverDown", "下载器未就绪")}
          </span>

          <span className="min-w-0 flex-1 truncate text-xs text-text-muted" title={effectiveSaveDir}>
            {t("novel.saveDir", "保存目录")}：<code className="text-text-dark">{effectiveSaveDir || "—"}</code>
          </span>

          <UiButton size="sm" variant="muted" onClick={() => void handlePickSaveDir()} disabled={!ready}>
            <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
            {t("novel.changeSaveDir", "更改目录")}
          </UiButton>

          <UiButton
            size="sm"
            variant="muted"
            onClick={() => void handleRevealSaveDir()}
            disabled={!ready || !effectiveSaveDir}
          >
            <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
            {t("novel.revealSaveDir", "打开目录")}
          </UiButton>

          <label className="flex items-center gap-1.5 text-xs text-text-muted">
            {t("novel.format", "输出格式")}
            <UiSelect
              className="h-8 w-24"
              value={novelFormat}
              onChange={(event) => void handleFormatChange(event.target.value)}
              disabled={!ready}
              aria-label={t("novel.format", "输出格式")}
            >
              <option value="epub">EPUB</option>
              <option value="txt">TXT</option>
            </UiSelect>
          </label>
        </div>
      </section>

      {/* 搜索 */}
      <section className={CARD_CLASS}>
        <h2 className="mb-3 text-sm font-medium text-text-dark">{t("novel.searchTitle", "搜索小说")}</h2>
        <div className="flex items-center gap-2">
          <UiInput
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void handleSearch();
            }}
            placeholder={t("novel.searchPlaceholder", "输入书名或作者，例如：斗破苍穹")}
            disabled={!ready}
          />
          <UiButton
            variant="primary"
            onClick={() => void handleSearch()}
            disabled={!ready || searching || !keyword.trim()}
          >
            {searching ? (
              <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Search className="mr-1.5 h-4 w-4" />
            )}
            {t("novel.search", "搜索")}
          </UiButton>
        </div>

        {results.length > 0 && (
          <div className="mt-3 flex flex-col gap-2">
            {results.map((item) => {
              const cover = pickSearchCover(item);
              const raw = item.raw ?? {};
              const meta = [
                raw.category,
                raw.read_cnt_text,
                raw.score ? `评分 ${raw.score}` : null,
                formatWords(raw.word_number),
              ].filter(Boolean);
              return (
                <div
                  key={item.book_id}
                  className="flex items-start gap-3 rounded-lg border border-border-dark bg-bg-dark/40 p-2.5"
                >
                  <div className="h-[74px] w-[54px] shrink-0 overflow-hidden rounded bg-black/30">
                    {cover ? (
                      <img
                        src={cover}
                        alt={item.title}
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-text-muted">
                        <BookOpen className="h-5 w-5" />
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-text-dark">{item.title}</p>
                    <p className="mt-0.5 truncate text-xs text-text-muted">{item.author}</p>
                    {meta.length > 0 && <p className="mt-1 truncate text-[11px] text-text-muted">{meta.join(" · ")}</p>}
                    {typeof raw.abstract === "string" && raw.abstract.trim() && (
                      <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-text-muted/80">
                        {singleLine(raw.abstract)}
                      </p>
                    )}
                  </div>
                  <UiButton size="sm" onClick={() => void handleOpenPreview(item.book_id)} disabled={!ready}>
                    <Download className="mr-1.5 h-3.5 w-3.5" />
                    {t("novel.download", "下载")}
                  </UiButton>
                </div>
              );
            })}
          </div>
        )}

        {searched && results.length === 0 && !searching && (
          <p className="mt-3 text-xs text-text-muted">{t("novel.searchEmpty", "没有找到匹配的书。")}</p>
        )}
      </section>

      {/* 任务 */}
      <section className={CARD_CLASS}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium text-text-dark">
            {t("novel.jobsTitle", "下载任务")}
            {hasActiveJobs && <LoaderCircle className="ml-2 inline h-3.5 w-3.5 animate-spin text-accent" />}
          </h2>
          <UiButton size="sm" variant="ghost" onClick={() => void refreshJobs()} disabled={!ready}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            {t("novel.refresh", "刷新")}
          </UiButton>
        </div>

        {jobs.length === 0 ? (
          <p className="text-xs text-text-muted">{t("novel.jobsEmpty", "暂无任务（已完成超过 2 小时会自动隐藏）")}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {jobs.map((job) => {
              const saved = job.progress?.saved_chapters ?? 0;
              const total = job.progress?.chapter_total ?? 0;
              const percent = total > 0 ? Math.min(100, Math.round((saved / total) * 100)) : 0;
              const rawState = String(job.state ?? "").toLowerCase();
              const state = rawState === "done" && total > 0 && saved < total ? "partial" : rawState;
              // 上游在没有待配置项时给的是 null，不是空数组。
              const nameOptions = job.book_name_options ?? [];
              const formatOptions = job.format_options ?? [];
              const needsName = nameOptions.length > 0;
              const needsFormat = formatOptions.length > 0;
              const needsConfig = needsName || needsFormat;
              const configOptions = needsName ? nameOptions : formatOptions;
              const title = job.title || job.book_id;

              const badge = needsConfig
                ? {
                    text: t("novel.statePending", "待配置"),
                    className: "border-amber-500/40 bg-amber-500/10 text-amber-400",
                  }
                : state === "running"
                  ? { text: `${percent}%`, className: "border-accent/40 bg-accent/10 text-accent" }
                  : state === "queued"
                    ? { text: t("novel.stateQueued", "排队中"), className: "border-border-dark text-text-muted" }
                    : state === "done"
                      ? {
                          text: t("novel.stateDone", "完成"),
                          className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
                        }
                      : state === "partial"
                        ? {
                            text: t("novel.statePartial", "部分失败"),
                            className: "border-amber-500/40 bg-amber-500/10 text-amber-400",
                          }
                        : state === "canceled"
                          ? {
                              text: t("novel.stateCanceled", "已取消"),
                              className: "border-border-dark text-text-muted",
                            }
                          : state === "failed"
                            ? {
                                text: t("novel.stateFailed", "失败"),
                                className: "border-red-500/40 bg-red-500/10 text-red-400",
                              }
                            : { text: String(job.state ?? ""), className: "border-border-dark text-text-muted" };

              return (
                <div key={job.id} className="rounded-lg border border-border-dark bg-bg-dark/40 p-2.5">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm text-text-dark" title={title}>
                      {title}
                    </span>
                    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${badge.className}`}>
                      {badge.text}
                    </span>
                    {needsConfig ? (
                      <UiButton
                        size="sm"
                        variant="primary"
                        onClick={() =>
                          setPendingConfig({
                            jobId: job.id,
                            value: configOptions[0] ?? "",
                          })
                        }
                      >
                        {t("novel.configure", "配置…")}
                      </UiButton>
                    ) : state === "running" || state === "queued" ? (
                      <UiButton size="sm" variant="muted" onClick={() => void handleCancel(job.id)}>
                        <Ban className="mr-1.5 h-3.5 w-3.5" />
                        {t("novel.cancel", "取消")}
                      </UiButton>
                    ) : state === "failed" || state === "partial" || state === "canceled" ? (
                      <UiButton size="sm" variant="muted" onClick={() => void handleRetry(job)}>
                        <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                        {t("novel.retry", "重试")}
                      </UiButton>
                    ) : null}
                  </div>

                  {(state === "running" || state === "queued") && (
                    <div className="mt-2 flex items-center gap-2">
                      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/10">
                        <div
                          className="h-full rounded-full bg-accent transition-all"
                          style={{ width: `${percent}%` }}
                        />
                      </div>
                      <span className="shrink-0 tabular-nums text-[11px] text-text-muted">
                        {saved}/{total || "?"}
                      </span>
                    </div>
                  )}

                  {job.message && (
                    <p className="mt-1.5 break-words text-[11px] text-text-muted/85">{singleLine(job.message)}</p>
                  )}

                  {needsConfig && pendingConfig?.jobId === job.id && (
                    <div className="mt-2 flex items-center gap-2">
                      <UiSelect
                        className="h-8 min-w-0 flex-1"
                        value={pendingConfig.value}
                        onChange={(event) => setPendingConfig({ jobId: job.id, value: event.target.value })}
                        aria-label={needsName ? t("novel.pickBookName", "选择书名") : t("novel.pickFormat", "选择格式")}
                      >
                        {(needsName ? job.book_name_options : job.format_options)?.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </UiSelect>
                      <UiButton size="sm" variant="primary" onClick={() => void handleSubmitConfig(job)}>
                        {t("novel.confirm", "确定")}
                      </UiButton>
                      <UiButton size="sm" variant="ghost" onClick={() => setPendingConfig(null)}>
                        {t("novel.dismiss", "忽略")}
                      </UiButton>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* 历史 */}
      <section className={CARD_CLASS}>
        <div className="mb-3 flex items-center gap-2">
          <h2 className="shrink-0 text-sm font-medium text-text-dark">{t("novel.historyTitle", "下载历史")}</h2>
          <UiInput
            className="h-8 flex-1"
            value={historyKeyword}
            onChange={(event) => setHistoryKeyword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void refreshHistory(historyKeyword);
            }}
            placeholder={t("novel.historySearchPlaceholder", "按书名 / 作者筛选")}
            disabled={!ready}
          />
          <UiButton
            size="sm"
            variant="muted"
            onClick={() => void refreshHistory(historyKeyword)}
            disabled={!ready || historyLoading}
          >
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${historyLoading ? "animate-spin" : ""}`} />
            {t("novel.refresh", "刷新")}
          </UiButton>
        </div>

        {history.length === 0 ? (
          <p className="text-xs text-text-muted">{t("novel.historyEmpty", "暂无历史记录")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] border-collapse text-left text-xs">
              <thead>
                <tr className="text-text-muted">
                  <th className="pb-1.5 pr-3 font-medium">{t("novel.colTime", "时间")}</th>
                  <th className="pb-1.5 pr-3 font-medium">{t("novel.colBook", "书名")}</th>
                  <th className="pb-1.5 pr-3 font-medium">{t("novel.colAuthor", "作者")}</th>
                  <th className="pb-1.5 pr-3 font-medium">{t("novel.colProgress", "进度")}</th>
                  <th className="pb-1.5 font-medium">{t("novel.colStatus", "结果")}</th>
                </tr>
              </thead>
              <tbody>
                {history.map((item, index) => {
                  const ok = String(item.status ?? "").toLowerCase() === "success";
                  return (
                    <tr key={`${item.book_id}-${item.timestamp}-${index}`} className="border-t border-border-dark/60">
                      <td className="py-1.5 pr-3 whitespace-nowrap text-text-muted">
                        {String(item.timestamp ?? "")
                          .replace("T", " ")
                          .slice(0, 19)}
                      </td>
                      <td className="max-w-[200px] truncate py-1.5 pr-3 text-text-dark" title={item.book_name}>
                        {item.book_name}
                      </td>
                      <td className="max-w-[120px] truncate py-1.5 pr-3 text-text-muted">{item.author}</td>
                      <td className="py-1.5 pr-3 whitespace-nowrap text-text-muted">{item.progress}</td>
                      <td className="py-1.5">
                        <span
                          className={`rounded-full border px-2 py-0.5 text-[11px] ${
                            ok
                              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                              : "border-red-500/40 bg-red-500/10 text-red-400"
                          }`}
                        >
                          {ok ? t("novel.historySuccess", "成功") : t("novel.historyFailed", "失败")}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 书库 */}
      <section className={CARD_CLASS}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="shrink-0 text-sm font-medium text-text-dark">{t("novel.libraryTitle", "已下载文件")}</h2>
          <code className="min-w-0 flex-1 truncate text-[11px] text-text-muted" title={library?.root ?? ""}>
            {libraryPath ? `/${libraryPath}` : "/"}
          </code>
          {libraryPath && (
            <UiButton
              size="sm"
              variant="ghost"
              disabled={libraryLoading}
              onClick={() => {
                const parent = libraryPath.split("/").filter(Boolean).slice(0, -1).join("/");
                void handleLoadLibrary(parent, true);
              }}
            >
              {t("novel.libraryUp", "上一层")}
            </UiButton>
          )}
          <UiButton
            size="sm"
            variant="muted"
            disabled={!ready || libraryLoading}
            onClick={() => void handleLoadLibrary(libraryPath, true)}
          >
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${libraryLoading ? "animate-spin" : ""}`} />
            {t("novel.libraryScan", "扫描")}
          </UiButton>
        </div>

        {!library ? (
          <p className="text-xs text-text-muted">{t("novel.libraryIdle", "点「扫描」列出保存目录里的文件。")}</p>
        ) : library.error ? (
          <p className="text-xs text-red-400">{t("novel.libraryError", "读取失败：{{msg}}", { msg: library.error })}</p>
        ) : libraryEntries.length === 0 ? (
          <p className="text-xs text-text-muted">
            {library.running
              ? t("novel.libraryScanning", "分批读取中，已发现 {{n}} 项…", { n: libraryEntries.length })
              : t("novel.libraryEmpty", "这个目录还是空的。")}
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {libraryEntries.map((item) => {
              const isDir = item.kind === "dir";
              return (
                <button
                  key={item.rel_path}
                  type="button"
                  disabled={!isDir}
                  onClick={() => {
                    const base = libraryPath.split("/").filter(Boolean);
                    void handleLoadLibrary([...base, item.name].join("/"), true);
                  }}
                  className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                    isDir ? "hover:bg-bg-dark" : "cursor-default"
                  }`}
                >
                  <FolderOpen className={`h-3.5 w-3.5 shrink-0 ${isDir ? "text-accent" : "text-text-muted/60"}`} />
                  <span className="min-w-0 flex-1 truncate text-text-dark" title={item.rel_path}>
                    {item.name || item.rel_path}
                  </span>
                  <span className="shrink-0 text-[11px] text-text-muted">
                    {isDir
                      ? t("novel.libraryDir", "文件夹 · {{n}} 个文件", { n: item.file_count ?? 0 })
                      : formatBytes(item.size)}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* 书籍预览 / 选择章节范围 */}
      <UiModal
        isOpen={Boolean(preview)}
        title={preview?.book_name || t("novel.previewTitle", "书籍信息")}
        onClose={() => setPreview(null)}
        widthClassName="w-[640px] max-w-[92vw]"
        footer={
          <>
            <UiButton variant="ghost" onClick={() => setPreview(null)} disabled={creating}>
              {t("common.cancel", "取消")}
            </UiButton>
            <UiButton
              variant="primary"
              onClick={() => void handleCreateJob()}
              disabled={creating || previewLoading || !preview?.book_id}
            >
              {creating ? (
                <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Download className="mr-1.5 h-4 w-4" />
              )}
              {t("novel.startDownload", "开始下载")}
            </UiButton>
          </>
        }
      >
        {previewLoading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-text-muted">
            <LoaderCircle className="h-4 w-4 animate-spin" />
            {t("novel.previewLoading", "正在拉取书籍信息…")}
          </div>
        ) : preview ? (
          <div className="flex gap-4">
            <div className="h-[186px] w-[136px] shrink-0 overflow-hidden rounded-lg bg-black/30">
              {previewCover ? (
                <img src={previewCover} alt={preview.book_name} className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-text-muted">
                  <BookOpen className="h-6 w-6" />
                </div>
              )}
            </div>

            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-text-dark">{preview.book_name}</p>
              <p className="mt-0.5 text-xs text-text-muted">
                {preview.author}
                {preview.category ? ` · ${preview.category}` : ""}
                {preview.finished ? ` · ${t("novel.finished", "已完结")}` : ` · ${t("novel.serializing", "连载中")}`}
              </p>

              <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-text-muted">
                {preview.score ? (
                  <span>
                    {t("novel.score", "评分")} {preview.score.toFixed(1)}
                  </span>
                ) : null}
                {preview.read_count_text ? <span>{preview.read_count_text}</span> : null}
                {preview.word_count ? <span>{formatWords(String(preview.word_count))}</span> : null}
                {preview.chapter_count ? (
                  <span>{t("novel.chapters", "{{n}} 章", { n: preview.chapter_count })}</span>
                ) : null}
              </p>

              {preview.tags?.length > 0 && (
                <p className="mt-1.5 flex flex-wrap gap-1">
                  {preview.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded border border-border-dark px-1.5 py-0.5 text-[11px] text-text-muted"
                    >
                      {tag}
                    </span>
                  ))}
                </p>
              )}

              {preview.description && (
                <p className="mt-2 max-h-[92px] overflow-y-auto text-[11px] leading-relaxed text-text-muted/85">
                  {preview.description}
                </p>
              )}
            </div>
          </div>
        ) : null}

        {preview && !previewLoading && (
          <div className="mt-4 border-t border-border-dark pt-3">
            <p className={LABEL_CLASS}>{t("novel.rangeTitle", "下载范围（留空 = 整本）")}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <UiInput
                className="h-8 w-24"
                value={rangeStart}
                onChange={(event) => setRangeStart(event.target.value.replace(/[^\d]/g, ""))}
                placeholder={t("novel.rangeFrom", "起始章")}
                inputMode="numeric"
              />
              <span className="text-xs text-text-muted">—</span>
              <UiInput
                className="h-8 w-24"
                value={rangeEnd}
                onChange={(event) => setRangeEnd(event.target.value.replace(/[^\d]/g, ""))}
                placeholder={t("novel.rangeTo", "结束章")}
                inputMode="numeric"
              />
              <span className="text-[11px] text-text-muted">
                {preview.chapter_count > 0
                  ? t("novel.rangeHint", "本书共 {{n}} 章，可用范围 1-{{n}}", { n: preview.chapter_count })
                  : t("novel.rangeUnknown", "章节数未知，留空整本下载")}
              </span>
            </div>
            {preview.last_chapter_title && (
              <p className="mt-2 truncate text-[11px] text-text-muted/80" title={preview.last_chapter_title}>
                {t("novel.lastChapter", "最新章节")}：{preview.last_chapter_title}
              </p>
            )}
          </div>
        )}
      </UiModal>
    </div>
  );
}
