/**
 * 设置弹窗（P3.2）— 与 LenTalk Chat 配置合二为一
 * 模型 / 地址 / Key 全部来自 LenTalk「设置 → 自定义平台」里的 Chat 模型；
 * 这里只选择使用哪个模型，并提供连接测试。
 */
import { useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, KeyRound, ListChecks, RefreshCw, Save, Trash2, X, Zap } from "lucide-react";
import type { CopyZh } from "../i18n";
import {
  clearAISettings,
  DEFAULT_AI_SETTINGS,
  listLenTalkChatModels,
  loadAISettings,
  resolveLenTalkChatModel,
  saveAISettings,
  type AISettings,
  type LenTalkChatModelOption,
} from "../providers/aiSettings";
import { testAIConnection } from "../providers/ai";

interface SettingsModalProps {
  t: CopyZh;
  onClose: () => void;
  onSaved: (settings: AISettings) => void;
}

export default function SettingsModal({ t, onClose, onSaved }: SettingsModalProps) {
  const [draft, setDraft] = useState<AISettings>(() => loadAISettings());
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const options = useMemo<LenTalkChatModelOption[]>(() => listLenTalkChatModels(), [refreshTick]);
  const selected =
    options.find((option) => option.providerId === draft.provider && option.model === draft.model) ??
    options.find((option) => option.providerId === draft.provider) ??
    null;
  const providerName = selected?.providerName ?? "";
  const remoteActive = Boolean(draft.provider && draft.model && draft.apiKey && draft.baseUrl);

  const chooseModel = (option: LenTalkChatModelOption) => {
    setTestResult(null);
    setDraft(resolveLenTalkChatModel(option.providerId, option.model));
  };

  const refresh = () => {
    setTestResult(null);
    setRefreshTick((value) => value + 1);
    setDraft(loadAISettings());
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    const result = await testAIConnection(draft);
    setTesting(false);
    setTestResult(result.ok
      ? { ok: true, text: t.testOk.replace("{model}", result.model ?? draft.model) }
      : { ok: false, text: t.testFailed.replace("{error}",
          result.errorKind === "network" ? t.networkErrorHint
            : result.errorKind === "timeout" ? t.aiRequestInterrupted
            : (result.error ?? "unknown")) });
  };

  const doSave = () => {
    onSaved(saveAISettings(draft));
    onClose();
  };

  const doClear = () => {
    clearAISettings();
    onSaved({ ...DEFAULT_AI_SETTINGS });
    onClose();
  };

  return <div className="modal-overlay settings-overlay" onClick={onClose}>
    <div className="modal settings-modal" role="dialog" aria-modal="true" aria-label={t.apiSettings} onClick={(event) => event.stopPropagation()}>
      <div className="modal-head">
        <h2>{t.apiSettings}</h2>
        <button className="icon-button" title={t.settings} onClick={onClose}><X size={15} /></button>
      </div>

      <div className="settings-mode-line">
        <span className={`settings-mode-dot ${remoteActive ? "remote" : ""}`} />
        <span className="settings-mode-text">{remoteActive ? t.settingsModeRemote.replace("{provider}", providerName).replace("{model}", draft.model) : t.settingsModeLocal}</span>
        <button className="outline-button settings-refresh" onClick={refresh} title={t.refreshModels}>
          <RefreshCw size={13} /> {t.refreshModels}
        </button>
      </div>

      <div className="settings-section">
        <div className="settings-section-title"><ListChecks size={13} /> {t.chatModel}</div>
        {options.length === 0 ? (
          <div className="settings-empty">
            <AlertCircle size={15} />
            <strong>{t.noChatModels}</strong>
            <p>{t.noChatModelsHint}</p>
          </div>
        ) : (
          <div className="settings-model-list">
            {options.map((option) => {
              const active = selected?.providerId === option.providerId && selected?.model === option.model;
              return (
                <button key={`${option.providerId}:${option.model}`} type="button" className={`provider-chip ${active ? "active" : ""}`} onClick={() => chooseModel(option)} title={t.pickModel}>
                  <span className="provider-chip-mark">◆</span>
                  <span className="provider-chip-name">{option.providerName}</span>
                  <span className="provider-chip-model">{option.model}</span>
                  {active && <CheckCircle2 size={13} className="provider-chip-check" />}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {remoteActive && <div className="settings-test-row">
        <button className="outline-button" disabled={testing} onClick={runTest}>
          <Zap size={13} /> {testing ? t.testingConnection : t.testConnection}
        </button>
        {testResult && <span className={`settings-test-status ${testResult.ok ? "ok" : "error"}`}>{testResult.ok ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />}{testResult.text}</span>}
      </div>}

      <div className="settings-note">
        <strong>{t.settingsUsageTitle}</strong>
        <p>{t.settingsUsageHint}</p>
      </div>
      <div className="settings-security">
        <KeyRound size={13} />
        <span>{t.settingsSecurityHint}</span>
      </div>

      <div className="modal-actions">
        <button className="outline-button danger" onClick={doClear} title={t.clearSettings}><Trash2 size={13} /> {t.clearSettings}</button>
        <button className="primary-button" onClick={doSave} disabled={options.length === 0}><Save size={14} /> {t.saveSettings}</button>
      </div>
    </div>
  </div>;
}
