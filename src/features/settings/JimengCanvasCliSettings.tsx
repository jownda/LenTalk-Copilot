import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, LayoutGrid } from "lucide-react";
import { UiButton, UiInput, UiModal } from "@/components/ui";
import {
  checkJimengCanvasCliLogin,
  logoutJimengCanvasCli,
  queryJimengCanvasCliStatus,
  startJimengCanvasCliLogin,
  type JimengCanvasCliStatus,
} from "@/commands/jimengCanvasCli";
import { jimengCliCloseLoginWindow, jimengCliOpenLoginWindow } from "@/commands/ai";
import { useJimengCanvasCliStore } from "@/stores/jimengCanvasCliStore";

/** 即梦画布 CLI 的安装脚本（与 `dreamina` 的 /cli 同构，程序名是 dreamina-canvas）。 */
const CANVAS_CLI_INSTALL = "curl -fsSL https://jimeng.jianying.com/canvas-cli | bash";
const CANVAS_CLI_DOC = "https://bytedance.larkoffice.com/wiki/QO66wGahSiakEHkJbxIcNBtDnAc";
const POLL_INTERVAL_MS = 500;
/** 单次 `auth wait` 会阻塞约 4 秒, 5 分钟足够走完扫码/登录。 */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export function JimengCanvasCliSettings() {
  const executable = useJimengCanvasCliStore((state) => state.executable);
  const setExecutable = useJimengCanvasCliStore((state) => state.setExecutable);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(executable);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const [status, setStatus] = useState<JimengCanvasCliStatus | null>(null);
  const [loginState, setLoginState] = useState<"idle" | "opening" | "polling">("idle");
  const [challenge, setChallenge] = useState<{
    uri: string;
    userCode: string;
    deviceCode: string;
  } | null>(null);
  const timerRef = useRef<number | null>(null);
  const pollingRef = useRef(false);
  const statusRequestRef = useRef<Promise<JimengCanvasCliStatus | null> | null>(null);
  const forceRef = useRef(false);
  /**
   * 每次发起授权自增，用来作废上一轮的轮询回调。
   *
   * 与「即梦 CLI」同一类坑：授权码一次一码、发新码即废旧码。上一轮那个还在飞行的
   * `auth wait` 回来报过期后，会把**新一轮**的计时器停掉并写错误信息 ——
   * 表现就是点了几次都停在「授权码已过期」。
   */
  const loginSeqRef = useRef(0);

  const stopPolling = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    pollingRef.current = false;
  }, []);

  useEffect(
    () => () => {
      loginSeqRef.current += 1;
      stopPolling();
    },
    [stopPolling],
  );

  const refreshStatus = useCallback(async () => {
    // 卡片挂载、打开面板、每次 executable 变化都会触发一次。复用同一个在途请求 ——
    // 否则几次探测会排队抢同一把 CLI 进程锁, 后到的那次容易被拖到超时。
    if (statusRequestRef.current) {
      return statusRequestRef.current;
    }
    const request = (async () => {
      try {
        const next = await queryJimengCanvasCliStatus(executable);
        setStatus(next);
        setFailed(false);
        return next;
      } catch (error) {
        // 🔴 查询失败（CLI 忙 / 进程锁被占）**不等于未登录**。
        // 之前这里把 status 置 null, 于是卡片在「已登录 / 未检测到」之间反复跳。
        setFailed(true);
        setMessage(error instanceof Error ? error.message : String(error));
        return null;
      } finally {
        statusRequestRef.current = null;
      }
    })();
    statusRequestRef.current = request;
    return request;
  }, [executable]);

  // 打开密钥页时探测一次，卡片上能直接看到版本/登录态。
  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  /** 打开授权页：优先应用内内置窗口（与即梦 CLI 的登录窗口共用一份会话），失败退回系统浏览器。 */
  const openAuthPage = useCallback(async (uri: string, force: boolean) => {
    try {
      const result = await jimengCliOpenLoginWindow(uri, {
        resetSession: force,
        title: "即梦画布授权",
      });
      if (result.opened) {
        return;
      }
    } catch {
      // 内置窗口不可用时继续往下兜底。
    }
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(uri);
    } catch {
      setMessage(`请在浏览器手动打开: ${uri}`);
    }
  }, []);

  const startLogin = useCallback(
    async (force: boolean) => {
      forceRef.current = force;
      setLoginState("opening");
      setFailed(false);
      setMessage(force ? "正在为「切换账号」重新申请授权…" : "正在申请授权链接…");
      stopPolling();
      // 作废上一轮：它可能正带着已被新码废掉的 device_code 在飞行中。
      const seq = (loginSeqRef.current += 1);
      /** 只允许本轮结束自己的计时器，避免旧回调把新一轮的轮询停掉。 */
      const stopThisPolling = () => {
        if (seq !== loginSeqRef.current) return;
        stopPolling();
      };
      try {
        const result = await startJimengCanvasCliLogin(executable, { force });
        if (seq !== loginSeqRef.current) return;
        if (!result.needAuth) {
          setLoginState("idle");
          setMessage(result.message || "当前已登录");
          await refreshStatus();
          return;
        }
        if (!result.verificationUri) {
          throw new Error(result.message || "未拿到授权链接");
        }
        setChallenge({
          uri: result.verificationUri,
          userCode: result.userCode ?? "",
          deviceCode: result.deviceCode ?? "",
        });
        await openAuthPage(result.verificationUri, force);
        if (seq !== loginSeqRef.current) return;
        setLoginState("polling");
        setMessage("等待在窗口中完成授权…");
        const deviceCode = result.deviceCode ?? "";
        const startedAt = Date.now();
        timerRef.current = window.setInterval(async () => {
          // 队列里可能还压着上一轮的定时器，带着旧码的错误结果不许影响本轮。
          if (seq !== loginSeqRef.current) return;
          // 上一轮 `auth wait` 还没返回就别叠进程。
          if (pollingRef.current) return;
          pollingRef.current = true;
          try {
            const check = await checkJimengCanvasCliLogin(executable, deviceCode);
            if (seq !== loginSeqRef.current) return;
            if (check.success) {
              stopThisPolling();
              setLoginState("idle");
              setChallenge(null);
              void jimengCliCloseLoginWindow().catch(() => {});
              const next = await refreshStatus();
              setMessage(
                next?.account ? `已登录：${next.account}` : check.message || "登录成功"
              );
              return;
            }
            if (Date.now() - startedAt >= LOGIN_TIMEOUT_MS) {
              stopThisPolling();
              setLoginState("idle");
              setFailed(true);
              setMessage("等待授权超时，请重新点登录。");
              return;
            }
            setMessage(
              `等待授权完成…（已等待 ${Math.round((Date.now() - startedAt) / 1000)} 秒）`
            );
          } catch (error) {
            if (seq !== loginSeqRef.current) return;
            // 授权码过期 / profile 冲突这类错误要立刻报出来, 别干等到 5 分钟。
            stopThisPolling();
            setLoginState("idle");
            setFailed(true);
            const message = error instanceof Error ? error.message : String(error);
            setMessage(
              /过期|expired/i.test(message)
                ? "这次授权码已失效：每点一次授权都会发放新码并作废上一个。请重新点一次，并在窗口里一次完成授权，中间不要再点。"
                : message
            );
          } finally {
            // 只有本轮才能释放防重入闸门，否则会和下一轮的请求叠在一起。
            if (seq === loginSeqRef.current) {
              pollingRef.current = false;
            }
          }
        }, POLL_INTERVAL_MS);
      } catch (error) {
        if (seq !== loginSeqRef.current) return;
        stopPolling();
        setLoginState("idle");
        setFailed(true);
        setMessage(error instanceof Error ? error.message : String(error));
      }
    },
    [executable, openAuthPage, refreshStatus, stopPolling]
  );

  const saveAndCheck = useCallback(async () => {
    setBusy(true);
    setFailed(false);
    setMessage("");
    const command = draft.trim() || "dreamina-canvas";
    setExecutable(command);
    try {
      const next = await queryJimengCanvasCliStatus(command);
      setStatus(next);
      if (!next.found) {
        setFailed(true);
        setMessage(next.message || "未找到即梦画布 CLI，请先按上面的命令安装");
      } else {
        setMessage(
          `已就绪 · v${next.version ?? "?"} · ${next.loggedIn ? `已登录${next.account ? `（${next.account}）` : ""}` : "未登录"}`
        );
      }
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [draft, setExecutable]);

  const handleLogout = useCallback(async () => {
    setFailed(false);
    setMessage("正在退出登录…");
    try {
      await logoutJimengCanvasCli(executable);
      setChallenge(null);
      const next = await refreshStatus();
      setMessage(next?.loggedIn ? "退出登录失败，请重试" : "已退出登录");
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [executable, refreshStatus]);

  const busyLogin = loginState === "opening" || loginState === "polling";

  return (
    <>
      <div className="rounded-lg border border-border-dark bg-bg-dark/60 p-4">
        <button
          type="button"
          className="flex w-full items-start gap-3 text-left transition-colors hover:opacity-80"
          onClick={() => {
            setDraft(executable);
            setMessage("");
            setFailed(false);
            setOpen(true);
            void refreshStatus();
          }}
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
            <LayoutGrid className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-text-dark">即梦画布 CLI</span>
              <span className="flex shrink-0 items-center gap-1.5">
                {status?.loggedIn && (
                  <span className="rounded-full bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                    已登录
                  </span>
                )}
                <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" />
              </span>
            </span>
            <span className="mt-0.5 block text-xs text-text-muted">
              给 Agent / 自动化流程操作即梦协同画布（独立于即梦 CLI 的另一个工具）
            </span>
          </span>
        </button>
      </div>

      <UiModal
        isOpen={open}
        title="即梦画布 CLI"
        widthClassName="w-[580px]"
        onClose={() => {
          if (!busy) {
            setOpen(false);
          }
        }}
      >
        <div className="ui-scrollbar max-h-[calc(100vh-180px)] space-y-4 overflow-y-auto text-sm text-text-dark">
          <p className="text-xs leading-5 text-text-muted">
            即梦画布 CLI（命令名 <code className="text-text-dark">dreamina-canvas</code>）用于在终端或
            Agent 环境里操作即梦协同画布：建画布、上传素材、生成图片/视频/音频、查任务、下载结果。
            它和上面那个「即梦 CLI」（<code className="text-text-dark">dreamina</code>）是两个独立工具，装在一起不冲突。
          </p>

          <div className="space-y-1">
            <p className="text-xs text-text-muted">安装（Windows 可在 Git Bash 里执行）：</p>
            <code className="block select-all overflow-x-auto rounded bg-bg-dark px-2 py-1.5 text-[11px]">
              {CANVAS_CLI_INSTALL}
            </code>
          </div>

          <label className="block space-y-1">
            <span className="text-xs">可执行命令</span>
            <UiInput
              value={draft}
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="dreamina-canvas"
            />
            <span className="block text-[11px] leading-4 text-text-muted">
              装好后一般是 <code>dreamina-canvas</code>；不在 PATH 里就填完整路径。
            </span>
          </label>

          <UiButton size="sm" disabled={busy || busyLogin} onClick={() => void saveAndCheck()}>
            {busy ? "检测中…" : "保存并检测"}
          </UiButton>

          {/* 状态 / 登录 */}
          <div className="space-y-2 border-t border-border-dark pt-4">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-text-muted">状态</span>
              <span className={status?.found ? "text-text-dark" : "text-text-muted"}>
                {status
                  ? status.found
                    ? `v${status.version ?? "?"} · ${status.loggedIn ? "已登录" : "未登录"}`
                    : "未检测到"
                  : "—"}
              </span>
              {status?.loggedIn && status.account && (
                <span className="rounded-full bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                  {status.account}
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {busyLogin ? (
                <UiButton size="sm" disabled>
                  获取授权中…
                </UiButton>
              ) : status?.loggedIn ? (
                <>
                  <UiButton size="sm" variant="primary" onClick={() => void startLogin(true)}>
                    切换账号
                  </UiButton>
                  <UiButton size="sm" onClick={() => void handleLogout()}>
                    退出登录
                  </UiButton>
                </>
              ) : (
                <UiButton size="sm" variant="primary" onClick={() => void startLogin(false)}>
                  一键登录
                </UiButton>
              )}
              <button
                type="button"
                className="text-xs text-accent hover:underline"
                onClick={() => void refreshStatus()}
              >
                重新检测
              </button>
            </div>

            {loginState === "polling" && challenge && (
              <div className="flex flex-wrap items-center gap-2 rounded-md bg-bg-dark px-2 py-1.5">
                <span className="text-[11px] text-text-muted">用户码</span>
                <code className="select-all font-mono text-[11px] text-text-dark">
                  {challenge.userCode}
                </code>
                <button
                  type="button"
                  className="ml-auto shrink-0 text-[11px] font-medium text-accent hover:underline"
                  onClick={() => void openAuthPage(challenge.uri, forceRef.current)}
                >
                  重新打开授权页
                </button>
              </div>
            )}
          </div>

          {message && (
            <p
              role="status"
              className={`break-words text-xs ${failed ? "text-red-400" : "text-text-muted"}`}
            >
              {message}
            </p>
          )}

          <div className="border-t border-border-dark pt-3">
            <a
              className="text-xs text-accent hover:underline"
              target="_blank"
              rel="noreferrer"
              href={CANVAS_CLI_DOC}
            >
              打开《即梦画布 CLI 使用说明》
            </a>
          </div>
        </div>
      </UiModal>
    </>
  );
}
