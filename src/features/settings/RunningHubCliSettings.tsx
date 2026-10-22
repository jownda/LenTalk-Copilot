import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, Terminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { openUrl } from '@tauri-apps/plugin-opener';

import { UiButton, UiInput, UiModal } from '@/components/ui';
import { formatProviderBalance, queryProviderBalance, type ProviderBalance } from '@/commands/balance';
import {
  checkRunningHubCli,
  detectRunningHubCli,
  installRunningHubCli,
  logoutRunningHubCli,
  readRunningHubCliClipboard,
  setRunningHubCliKey,
} from '@/commands/runningHubCli';
import { useSettingsStore } from '@/stores/settingsStore';
import { useRunningHubCliStore } from '@/stores/runningHubCliStore';

const RUNNINGHUB_CLI_PROVIDER_ID = 'runninghub-cli';

/**
 * RunningHub CLI 把接口地址硬编码在国内站（`https://www.runninghub.cn`），
 * 因此校验与 Key 页都必须用同一个域，判定才和 `rh check` 一致。
 */
const RUNNINGHUB_BASE_URL = 'https://www.runninghub.cn';
const CREATE_KEY_URL = 'https://www.runninghub.cn/enterprise-api/sharedApi';
const INSTALL_COMMAND =
  'python -m pip install --user git+https://github.com/HM-RunningHub/RH_CLI.git';

/** 剪贴板轮询节奏与上限：用户需要先在网页上创建再复制，给到 6 分钟。 */
const CLIPBOARD_POLL_INTERVAL_MS = 1500;
const CLIPBOARD_MAX_ATTEMPTS = 240;

type DetectState = 'detecting' | 'ready' | 'missing' | 'installing' | 'failed';
type LoginState = 'idle' | 'detecting' | 'installing' | 'waiting' | 'verifying' | 'success' | 'error';

/**
 * 从剪贴板文本里挑出可能的 API Key。
 *
 * 用户从网页复制时可能带上换行或整段文字，这里只接受「不含空白、长度合理、
 * 字符集合法」的单个 token；是否真的是有效 Key 交给 RunningHub 接口判定。
 */
function extractKeyCandidate(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(trimmed)) return null;
  return trimmed;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function RunningHubCliSettings() {
  const { t } = useTranslation();
  const executable = useRunningHubCliStore((state) => state.executable);
  const setExecutable = useRunningHubCliStore((state) => state.setExecutable);
  const apiKey = useSettingsStore((state) => state.apiKeys[RUNNINGHUB_CLI_PROVIDER_ID] ?? '');
  const setProviderApiKey = useSettingsStore((state) => state.setProviderApiKey);

  const [open, setOpen] = useState(false);
  const [commandDraft, setCommandDraft] = useState(executable);
  const [keyDraft, setKeyDraft] = useState(apiKey);
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);

  /** CLI 探测状态（与登录状态分开：未授权也能看到 CLI 装没装）。 */
  const [detectState, setDetectState] = useState<DetectState>('detecting');
  const [detectedPath, setDetectedPath] = useState<string | null>(null);
  const [detectMessage, setDetectMessage] = useState('');

  const [loginState, setLoginState] = useState<LoginState>('idle');
  const [loginMessage, setLoginMessage] = useState('');
  const [balance, setBalance] = useState<ProviderBalance | null>(null);

  const timerRef = useRef<number | null>(null);
  const pollingRef = useRef(false);
  const authorizeTokenRef = useRef(0);
  const lastCandidateRef = useRef('');
  const lastErrorRef = useRef('');

  useEffect(() => setKeyDraft(apiKey), [apiKey]);

  const stopPolling = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    pollingRef.current = false;
  }, []);

  /** 卸载时停掉轮询并让在途回调失效，避免后台继续读剪贴板。 */
  useEffect(() => {
    return () => {
      authorizeTokenRef.current += 1;
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const refreshDetect = useCallback(async (command: string) => {
    setDetectState('detecting');
    setDetectMessage('');
    try {
      const detection = await detectRunningHubCli(command);
      setDetectedPath(detection.resolvedPath);
      setDetectState(detection.found ? 'ready' : 'missing');
    } catch (error) {
      setDetectedPath(null);
      setDetectState('failed');
      setDetectMessage(errorText(error));
    }
  }, []);

  // 打开弹窗时探测一次本机 CLI，不发起授权、不打开浏览器。
  useEffect(() => {
    if (!open) return;
    void refreshDetect(executable);
  }, [open, executable, refreshDetect]);

  // 已保存 Key 时顺手查一次余额，卡片上直接可见；查不到就不显示。
  useEffect(() => {
    const key = apiKey.trim();
    if (!key) {
      setBalance(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await queryProviderBalance('runninghub', RUNNINGHUB_BASE_URL, key);
        if (!cancelled) setBalance(result);
      } catch {
        if (!cancelled) setBalance(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiKey]);

  const handleAutoInstall = useCallback(async () => {
    setDetectState('installing');
    setDetectMessage('');
    try {
      const result = await installRunningHubCli();
      if (result.success && result.resolvedPath) {
        setExecutable(result.resolvedPath);
        setCommandDraft(result.resolvedPath);
        setDetectedPath(result.resolvedPath);
        setDetectState('ready');
        setDetectMessage(result.message);
        return;
      }
      setDetectState('failed');
      setDetectMessage(result.message || t('runningHubCli.installFailed'));
    } catch (error) {
      setDetectState('failed');
      setDetectMessage(errorText(error));
    }
  }, [setExecutable, t]);

  /**
   * 一键授权：检测（必要时自动安装）CLI → 打开官方 Key 页 → 轮询剪贴板 →
   * 校验通过后写入 CLI 配置。用户只需要在网页上「创建 + 复制」。
   */
  const startAuthorize = useCallback(async () => {
    const token = authorizeTokenRef.current + 1;
    authorizeTokenRef.current = token;
    const stale = () => authorizeTokenRef.current !== token;

    stopPolling();
    lastCandidateRef.current = '';
    lastErrorRef.current = '';
    setBalance(null);
    setLoginState('detecting');
    setLoginMessage(t('runningHubCli.authDetecting'));

    let command = commandDraft.trim() || 'rh';
    try {
      const detection = await detectRunningHubCli(command);
      if (stale()) return;
      if (detection.found && detection.resolvedPath) {
        command = detection.resolvedPath;
        setExecutable(command);
        setCommandDraft(command);
        setDetectedPath(command);
        setDetectState('ready');
      } else {
        setDetectState('installing');
        setLoginState('installing');
        setLoginMessage(t('runningHubCli.authInstalling'));
        const install = await installRunningHubCli();
        if (stale()) return;
        if (!install.success || !install.resolvedPath) {
          setDetectState('failed');
          setDetectMessage(install.message);
          setLoginState('error');
          setLoginMessage(install.message || t('runningHubCli.installFailed'));
          return;
        }
        command = install.resolvedPath;
        setExecutable(command);
        setCommandDraft(command);
        setDetectedPath(command);
        setDetectState('ready');
        setDetectMessage(install.message);
      }
    } catch (error) {
      if (stale()) return;
      setLoginState('error');
      setLoginMessage(errorText(error));
      return;
    }

    setLoginState('waiting');
    setLoginMessage(t('runningHubCli.authWaiting'));
    try {
      await openUrl(CREATE_KEY_URL);
    } catch {
      setLoginMessage(t('runningHubCli.authOpenBrowserFailed', { url: CREATE_KEY_URL }));
    }
    if (stale()) return;

    let attempts = 0;
    timerRef.current = window.setInterval(() => {
      if (pollingRef.current) return;
      pollingRef.current = true;
      attempts += 1;
      void (async () => {
        try {
          if (stale()) return;
          const text = await readRunningHubCliClipboard();
          if (stale()) return;
          const candidate = extractKeyCandidate(text);

          if (candidate && candidate !== lastCandidateRef.current) {
            lastCandidateRef.current = candidate;
            setLoginState('verifying');
            setLoginMessage(t('runningHubCli.authVerifying'));
            try {
              // 先让接口确认这串东西确实是有效 Key，避免把脏数据写进 CLI 配置。
              const verified = await queryProviderBalance('runninghub', RUNNINGHUB_BASE_URL, candidate);
              if (stale()) return;
              const saved = await setRunningHubCliKey(command, candidate);
              if (stale()) return;
              if (!saved.ready) {
                lastErrorRef.current = saved.message || t('runningHubCli.authKeyRejected');
                setLoginState('waiting');
                setLoginMessage(lastErrorRef.current);
                return;
              }
              setProviderApiKey(RUNNINGHUB_CLI_PROVIDER_ID, candidate);
              setKeyDraft(candidate);
              setBalance(verified);
              setLoginState('success');
              setLoginMessage(t('runningHubCli.authSuccess'));
              stopPolling();
            } catch (error) {
              // 剪贴板里多半是别的内容，继续等下一次复制。
              lastErrorRef.current = errorText(error);
              setLoginState('waiting');
              setLoginMessage(t('runningHubCli.authWaitingRetry', { message: lastErrorRef.current }));
            }
            return;
          }

          if (attempts >= CLIPBOARD_MAX_ATTEMPTS) {
            stopPolling();
            setLoginState('error');
            setLoginMessage(lastErrorRef.current || t('runningHubCli.authTimeout'));
          }
        } catch (error) {
          // 读剪贴板本身失败（例如系统剪贴板被独占）不应该中断轮询。
          lastErrorRef.current = errorText(error);
        } finally {
          pollingRef.current = false;
        }
      })();
    }, CLIPBOARD_POLL_INTERVAL_MS);
  }, [commandDraft, setExecutable, setProviderApiKey, stopPolling, t]);

  const handleLogout = useCallback(async () => {
    authorizeTokenRef.current += 1;
    stopPolling();
    setBusy(true);
    try {
      const result = await logoutRunningHubCli();
      setProviderApiKey(RUNNINGHUB_CLI_PROVIDER_ID, '');
      setKeyDraft('');
      setBalance(null);
      setLoginState('idle');
      setLoginMessage(result.message || t('runningHubCli.logoutDone'));
    } catch (error) {
      setLoginState('error');
      setLoginMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }, [setProviderApiKey, stopPolling, t]);

  /** 手动兜底：先把 Key 交给接口校验，通过后再写入 CLI 配置。 */
  const handleManualSave = useCallback(async () => {
    const command = commandDraft.trim() || 'rh';
    const value = keyDraft.trim();
    if (!value) return;
    // 手动提交即用户已自行完成配置，停掉可能在跑的剪贴板轮询，避免稍后被覆盖。
    authorizeTokenRef.current += 1;
    stopPolling();
    setBusy(true);
    setLoginState('verifying');
    setLoginMessage('');
    try {
      const verified = await queryProviderBalance('runninghub', RUNNINGHUB_BASE_URL, value);
      const result = await setRunningHubCliKey(command, value);
      setExecutable(result.executable);
      setDetectedPath(result.executable);
      setDetectState('ready');
      setProviderApiKey(RUNNINGHUB_CLI_PROVIDER_ID, value);
      setBalance(verified);
      setLoginState('success');
      setLoginMessage(result.message || t('runningHubCli.authSuccess'));
    } catch (error) {
      setLoginState('error');
      setLoginMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }, [commandDraft, keyDraft, setExecutable, setProviderApiKey, stopPolling, t]);

  const handleCheck = useCallback(async () => {
    const command = commandDraft.trim() || 'rh';
    setBusy(true);
    setLoginMessage('');
    try {
      const result = await checkRunningHubCli(command);
      setExecutable(result.executable);
      setDetectedPath(result.executable);
      setDetectState('ready');
      setLoginState(result.ready ? 'success' : 'error');
      setLoginMessage(result.message);
    } catch (error) {
      setLoginState('error');
      setLoginMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }, [commandDraft, setExecutable]);

  const authorizing =
    loginState === 'detecting' || loginState === 'installing' || loginState === 'waiting' || loginState === 'verifying';

  const detectLabel = (() => {
    if (detectState === 'detecting') return t('runningHubCli.detectDetecting');
    if (detectState === 'installing') return t('runningHubCli.installing');
    if (detectState === 'ready') return t('runningHubCli.detectReady');
    if (detectState === 'failed') return t('runningHubCli.detectFailed');
    return t('runningHubCli.detectMissing');
  })();

  return (
    <>
      <div className="rounded-lg border border-border-dark bg-bg-dark/60 p-4">
        <button
          type="button"
          className="flex w-full items-start gap-3 text-left transition-colors hover:opacity-80"
          onClick={() => {
            setCommandDraft(executable);
            setLoginMessage('');
            setOpen(true);
          }}
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
            <Terminal className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center justify-between gap-3 text-sm font-medium text-text-dark">
              {t('runningHubCli.title')}
              <span className="flex shrink-0 items-center gap-1.5">
                {/* 余额（RH 币）；未授权 / 查不到就不显示。 */}
                {balance && (
                  <span className="rounded-full bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                    {formatProviderBalance(balance)}
                  </span>
                )}
                <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" />
              </span>
            </span>
            <span className="mt-0.5 block text-xs text-text-muted">{t('runningHubCli.description')}</span>
          </span>
        </button>
      </div>

      <UiModal
        isOpen={open}
        title={t('runningHubCli.title')}
        widthClassName="w-[560px]"
        onClose={() => {
          if (busy) return;
          authorizeTokenRef.current += 1;
          stopPolling();
          setOpen(false);
        }}
      >
        <div className="space-y-4 text-sm text-text-dark">
          <p className="text-xs leading-5 text-text-muted">{t('runningHubCli.help')}</p>

          {/* CLI 检测 / 自动安装 */}
          <div className="rounded-md border border-border-dark bg-surface-dark/50 p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-text-dark">{detectLabel}</p>
                {detectedPath && (
                  <p className="mt-0.5 break-all text-[11px] leading-4 text-text-muted">
                    {t('runningHubCli.detectedPath')}: {detectedPath}
                  </p>
                )}
                {detectMessage && detectState !== 'ready' && (
                  <p className="mt-0.5 break-all text-[11px] leading-4 text-text-muted">{detectMessage}</p>
                )}
              </div>
              {(detectState === 'missing' || detectState === 'failed') && (
                <UiButton type="button" variant="primary" size="sm" onClick={() => void handleAutoInstall()}>
                  {t('runningHubCli.autoInstall')}
                </UiButton>
              )}
            </div>
            <p className="mt-2 text-[11px] leading-4 text-text-muted">{t('runningHubCli.installNotice')}</p>
          </div>

          <label className="block space-y-1.5 text-xs font-medium text-text-dark">
            {t('runningHubCli.executable')}
            <UiInput
              value={commandDraft}
              onChange={(event) => setCommandDraft(event.target.value)}
              placeholder="rh"
            />
            <span className="block text-[11px] font-normal leading-4 text-text-muted">
              {t('runningHubCli.executableDesc')}
            </span>
          </label>

          {/* 一键授权 */}
          <div className="rounded-md border border-border-dark bg-surface-dark/50 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-text-dark">{t('runningHubCli.authTitle')}</p>
                <p className="mt-0.5 text-[11px] leading-4 text-text-muted">{t('runningHubCli.authDesc')}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <UiButton
                  type="button"
                  variant="primary"
                  size="sm"
                  disabled={authorizing}
                  onClick={() => void startAuthorize()}
                >
                  {authorizing
                    ? t('runningHubCli.authInProgress')
                    : loginState === 'success'
                      ? t('runningHubCli.authRetryHint')
                      : t('runningHubCli.authButton')}
                </UiButton>
                {loginState === 'success' && (
                  <UiButton
                    type="button"
                    variant="muted"
                    size="sm"
                    disabled={busy}
                    onClick={() => void handleLogout()}
                  >
                    {t('runningHubCli.logout')}
                  </UiButton>
                )}
              </div>
            </div>

            {loginMessage && (
              <p
                className={`mt-2 whitespace-pre-wrap break-words text-[11px] leading-4 ${
                  loginState === 'error' ? 'text-red-400' : 'text-text-muted'
                }`}
              >
                {loginState === 'error' && '✗ '}
                {loginState === 'success' && '✓ '}
                {loginMessage}
              </p>
            )}

            {balance && (
              <div className="mt-2 flex items-center gap-2 rounded-md bg-accent/10 px-2 py-1.5">
                <span className="text-[11px] text-text-muted">{t('runningHubCli.balance')}</span>
                <span className="text-xs font-medium text-text-dark">{formatProviderBalance(balance)}</span>
                {balance.detail && <span className="text-[10px] text-text-muted">{balance.detail}</span>}
              </div>
            )}
          </div>

          {/* 手动兜底 */}
          <div className="space-y-3 rounded-md border border-border-dark bg-surface-dark/50 p-3">
            <p className="text-xs font-medium text-text-dark">{t('runningHubCli.manualTitle')}</p>
            <label className="block space-y-1.5 text-xs font-medium text-text-dark">
              {t('runningHubCli.apiKey')}
              <div className="flex gap-2">
                <UiInput
                  type={showKey ? 'text' : 'password'}
                  value={keyDraft}
                  onChange={(event) => setKeyDraft(event.target.value)}
                  placeholder={t('runningHubCli.apiKeyPlaceholder')}
                />
                <UiButton type="button" variant="muted" size="sm" onClick={() => setShowKey((current) => !current)}>
                  {showKey ? t('common.hide') : t('common.show')}
                </UiButton>
              </div>
            </label>
            <ol className="list-decimal space-y-2 pl-4 text-[11px] leading-4 text-text-muted">
              <li className="space-y-1">
                <p>{t('runningHubCli.manualInstallHint')}</p>
                <code className="block overflow-x-auto rounded bg-bg-dark px-2 py-1.5 text-[11px] text-text-dark">
                  {INSTALL_COMMAND}
                </code>
              </li>
              <li>
                {t('runningHubCli.manualKeyHint')}{' '}
                <span className="break-all text-text-dark">{CREATE_KEY_URL}</span>
              </li>
            </ol>
            <div className="flex justify-end gap-2">
              <UiButton type="button" variant="muted" size="sm" disabled={busy} onClick={() => void handleCheck()}>
                {busy ? t('runningHubCli.checking') : t('runningHubCli.check')}
              </UiButton>
              <UiButton
                type="button"
                variant="primary"
                size="sm"
                disabled={busy || !keyDraft.trim()}
                onClick={() => void handleManualSave()}
              >
                {t('runningHubCli.saveAndCheck')}
              </UiButton>
            </div>
          </div>
        </div>
      </UiModal>
    </>
  );
}
