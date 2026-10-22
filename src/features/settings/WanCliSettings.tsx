import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { UiButton, UiInput, UiModal, UiSelect } from "@/components/ui";
import { checkWanCli, loginWanCli } from "@/commands/wanCli";
import { queryWanCliCredits, type WanCliCredits } from "@/commands/balance";
import { useWanCliStore } from "@/stores/wanCliStore";

export function WanCliSettings() {
  const { t } = useTranslation();
  const executable = useWanCliStore((state) => state.executable);
  const setExecutable = useWanCliStore((state) => state.setExecutable);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(executable);
  const [site, setSite] = useState("cn");
  const [accessKey, setAccessKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  /** 万相 CLI 剩余积分（`wan credits`）；查不到就保持 null、整块不渲染。 */
  const [credits, setCredits] = useState<WanCliCredits | null>(null);

  /** 积分构成（会员 / 充值 / 赠送），拼成一行小字。 */
  const creditBreakdown = credits
    ? [
        credits.memberCount ? `${t("wanCli.creditsMember")} ${Math.round(credits.memberCount)}` : null,
        credits.topUpCount ? `${t("wanCli.creditsTopUp")} ${Math.round(credits.topUpCount)}` : null,
        credits.bonusCount ? `${t("wanCli.creditsBonus")} ${Math.round(credits.bonusCount)}` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  const loadCredits = useCallback(async (command: string) => {
    try {
      setCredits(await queryWanCliCredits(command));
    } catch {
      // 未登录 / CLI 不可用时不显示积分，也不必打扰用户。
      setCredits(null);
    }
  }, []);

  // 打开密钥页时顺手查一次积分，卡片上就能直接看到（未登录 / CLI 不可用时静默忽略）。
  useEffect(() => {
    void loadCredits(executable);
  }, [executable, loadCredits]);

  const check = async (login: boolean) => {
    setBusy(true);
    setMessage("");
    setFailed(false);
    const command = draft.trim() || "wan";
    setExecutable(command);
    try {
      if (login) {
        await loginWanCli(command, site, accessKey.trim());
        setAccessKey("");
      }
      const status = await checkWanCli(command);
      setFailed(!status.authenticated);
      setMessage(
        t(status.authenticated ? "wanCli.ready" : "wanCli.notAuthenticated", {
          version: status.version,
          message: status.message ?? "",
        }),
      );
      if (status.authenticated) {
        await loadCredits(command);
      } else {
        setCredits(null);
      }
    } catch (error) {
      // Do not echo the submitted credential, even if an upstream error contains it.
      const detail = String(error);
      setMessage(accessKey.trim() ? detail.split(accessKey.trim()).join("[REDACTED]") : detail);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="rounded-lg border border-border-dark bg-bg-dark/60 p-4">
        <button
          type="button"
          className="flex w-full items-start gap-3 text-left hover:opacity-80"
          onClick={() => {
            setDraft(executable);
            setMessage("");
            setOpen(true);
            // 打开面板顺手查一次积分；未登录 / CLI 不可用时静默忽略。
            void loadCredits(executable);
          }}
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
            <Terminal className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center justify-between gap-3 text-sm font-medium text-text-dark">
              {t("wanCli.title")}
              <span className="flex shrink-0 items-center gap-1.5">
                {/* 万相积分（`wan credits`）；未登录 / 查不到就不显示。 */}
                {credits && (
                  <span className="rounded-full bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                    {t("wanCli.credits")} {Math.round(credits.availableCount)}
                  </span>
                )}
                <ChevronRight className="h-4 w-4 text-text-muted" />
              </span>
            </span>
            <span className="mt-0.5 block text-xs text-text-muted">{t("wanCli.description")}</span>
          </span>
        </button>
      </div>
      <UiModal
        isOpen={open}
        title={t("wanCli.title")}
        widthClassName="w-[560px]"
        onClose={() => {
          if (!busy) {
            setAccessKey("");
            setOpen(false);
          }
        }}
      >
        <div className="ui-scrollbar max-h-[calc(100vh-180px)] space-y-4 overflow-y-auto text-sm text-text-dark">
          <p className="text-xs text-text-muted">{t("wanCli.installHelp")}</p>
          <code className="block overflow-x-auto rounded bg-bg-dark p-2 text-xs">npm install --global @wan-ai/cli</code>
          <label className="block space-y-1">
            <span>{t("wanCli.executable")}</span>
            <UiInput
              value={draft}
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="wan"
            />
          </label>
          <p className="text-xs text-text-muted">{t("wanCli.pathHelp")}</p>
          <UiButton size="sm" disabled={busy} onClick={() => void check(false)}>
            {t(busy ? "wanCli.checking" : "wanCli.saveAndCheck")}
          </UiButton>
          <div className="space-y-3 border-t border-border-dark pt-4">
            <p className="text-xs text-text-muted">{t("wanCli.loginHelp")}</p>
            <label className="block space-y-1">
              <span>{t("wanCli.site")}</span>
              <UiSelect value={site} disabled={busy} onChange={(event) => setSite(event.target.value)}>
                <option value="cn">{t("wanCli.cn")}</option>
                <option value="intl">{t("wanCli.intl")}</option>
              </UiSelect>
            </label>
            <a
              className="text-xs text-accent hover:underline"
              target="_blank"
              rel="noreferrer"
              href={site === "cn" ? "https://wanxiang.aliyun.com" : "https://create.wan.video"}
            >
              {t("wanCli.accountPage")}
            </a>
            <label className="block space-y-1">
              <span>AccessKey</span>
              <UiInput
                type="password"
                autoComplete="off"
                value={accessKey}
                disabled={busy}
                onChange={(event) => setAccessKey(event.target.value)}
                placeholder="wan-sk.…"
              />
            </label>
            <UiButton size="sm" disabled={busy || !accessKey.trim()} onClick={() => void check(true)}>
              {t("wanCli.login")}
            </UiButton>
          </div>
          {message && (
            <p role="status" className={`break-words text-xs ${failed ? "text-red-400" : "text-text-muted"}`}>
              {message}
            </p>
          )}
          {/* 万相 CLI 剩余积分（`wan credits`）；未登录 / 查不到时整块不渲染。 */}
          {credits && (
            <div className="rounded-md bg-accent/10 px-2 py-1.5 text-xs">
              <span className="text-text-muted">{t("wanCli.credits")}</span>
              <span className="ml-2 font-medium text-text-dark">
                {Math.round(credits.availableCount)}
              </span>
              {creditBreakdown && (
                <span className="ml-2 text-[10px] text-text-muted">{creditBreakdown}</span>
              )}
            </div>
          )}
          <p className="text-xs text-text-muted">{t("wanCli.videoHelp")}</p>
          <a
            className="text-xs text-accent hover:underline"
            target="_blank"
            rel="noreferrer"
            href="https://alidocs.dingtalk.com/i/nodes/kDnRL6jAJMLgNkw7tqkEa774VyMoPYe1"
          >
            {t("wanCli.guide")}
          </a>
        </div>
      </UiModal>
    </>
  );
}
