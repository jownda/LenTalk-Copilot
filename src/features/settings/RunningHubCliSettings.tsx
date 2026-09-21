import { useEffect, useState } from 'react';
import { ChevronRight, Terminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { UiButton, UiInput, UiModal } from '@/components/ui';
import { checkRunningHubCli, setRunningHubCliKey } from '@/commands/runningHubCli';
import { useSettingsStore } from '@/stores/settingsStore';
import { useRunningHubCliStore } from '@/stores/runningHubCliStore';

const RUNNINGHUB_CLI_PROVIDER_ID = 'runninghub-cli';

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
  const [message, setMessage] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => setKeyDraft(apiKey), [apiKey]);

  const check = async (saveKey: boolean) => {
    const command = commandDraft.trim() || 'rh';
    setBusy(true);
    setMessage('');
    try {
      const result = saveKey
        ? await setRunningHubCliKey(command, keyDraft)
        : await checkRunningHubCli(command);
      setExecutable(result.executable);
      if (saveKey) setProviderApiKey(RUNNINGHUB_CLI_PROVIDER_ID, keyDraft);
      setReady(result.ready);
      setMessage(result.message);
    } catch (error) {
      const detail = String(error);
      setReady(false);
      setMessage(keyDraft.trim() ? detail.split(keyDraft.trim()).join('[REDACTED]') : detail);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="rounded-lg border border-border-dark bg-bg-dark/60 p-4">
        <button
          type="button"
          className="flex w-full items-start gap-3 text-left transition-colors hover:opacity-80"
          onClick={() => {
            setCommandDraft(executable);
            setMessage('');
            setOpen(true);
          }}
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
            <Terminal className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center justify-between gap-3 text-sm font-medium text-text-dark">
              {t('runningHubCli.title')}
              <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" />
            </span>
            <span className="mt-0.5 block text-xs text-text-muted">{t('runningHubCli.description')}</span>
          </span>
        </button>
      </div>

      <UiModal isOpen={open} title={t('runningHubCli.title')} widthClassName="w-[560px]" onClose={() => !busy && setOpen(false)}>
        <div className="space-y-4 text-sm text-text-dark">
          <p className="text-xs leading-5 text-text-muted">{t('runningHubCli.help')}</p>
          <label className="block space-y-1.5 text-xs font-medium text-text-dark">
            {t('runningHubCli.executable')}
            <UiInput value={commandDraft} onChange={(event) => setCommandDraft(event.target.value)} placeholder="rh" />
          </label>
          <label className="block space-y-1.5 text-xs font-medium text-text-dark">
            {t('runningHubCli.apiKey')}
            <div className="flex gap-2">
              <UiInput type={showKey ? 'text' : 'password'} value={keyDraft} onChange={(event) => setKeyDraft(event.target.value)} placeholder={t('runningHubCli.apiKeyPlaceholder')} />
              <UiButton type="button" variant="muted" size="sm" onClick={() => setShowKey((current) => !current)}>
                {showKey ? t('common.hide') : t('common.show')}
              </UiButton>
            </div>
          </label>
          {message && <p className={`whitespace-pre-wrap break-words rounded-md px-3 py-2 text-xs ${ready ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>{message}</p>}
          <div className="flex justify-end gap-2">
            <UiButton type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setOpen(false)}>{t('common.close')}</UiButton>
            <UiButton type="button" variant="muted" size="sm" disabled={busy} onClick={() => void check(false)}>{t('runningHubCli.check')}</UiButton>
            <UiButton type="button" variant="primary" size="sm" disabled={busy || !keyDraft.trim()} onClick={() => void check(true)}>{busy ? t('runningHubCli.checking') : t('runningHubCli.saveAndCheck')}</UiButton>
          </div>
        </div>
      </UiModal>
    </>
  );
}
