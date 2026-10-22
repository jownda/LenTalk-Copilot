import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AlertCircle,
  CheckCircle2,
  CloudDownload,
  CloudUpload,
  KeyRound,
  Loader2,
  Lock,
  RefreshCw,
  Unplug,
  Upload,
  X,
} from "lucide-react";

import { UI_CONTENT_OVERLAY_INSET_CLASS, UI_DIALOG_TRANSITION_MS } from "@/components/ui/motion";
import { useDialogTransition } from "@/components/ui/useDialogTransition";
import type { ProjectRecord } from "@/commands/projectState";
import {
  cloudDriveAuthorizeComplete,
  cloudDriveBeginAuthorize,
  cloudDriveDisconnect,
  cloudDriveListVersions,
  cloudDriveRestoreProject,
  cloudDriveSetCredentials,
  cloudDriveSetFolder,
  cloudDriveStatus,
  cloudDriveUploadProject,
  type CloudDriveFileEntry,
  type CloudDriveProvider,
  type CloudDriveStatus,
  type CloudUploadProgress,
} from "@/commands/cloudDrive";

interface CloudDriveUploadDialogProps {
  project: ProjectRecord;
  onClose: () => void;
  onRestored?: () => void;
}

const PROVIDERS: CloudDriveProvider[] = ["baidu"];
const CREDENTIAL_PAGES: Record<CloudDriveProvider, string> = {
  baidu: "https://pan.baidu.com/union",
};

const emptyStatus = (provider: CloudDriveProvider): CloudDriveStatus => ({
  provider,
  connected: false,
  hasCredentials: false,
  accountName: null,
  folderPath: null,
});

function projectNameFromFile(fileName: string): string {
  const stem = fileName.endsWith(".zip") ? fileName.slice(0, -4) : fileName;
  const match = /^(.*)-([0-9a-fA-F]{32})$/.exec(stem);
  return match ? match[1] : stem;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

function formatTime(ms: number): string {
  if (!ms) {
    return "-";
  }
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

interface VersionGroup {
  name: string;
  items: CloudDriveFileEntry[];
}

export function CloudDriveUploadDialog({
  project,
  onClose,
  onRestored,
}: CloudDriveUploadDialogProps) {
  const { t } = useTranslation();
  const { shouldRender, isVisible } = useDialogTransition(true, UI_DIALOG_TRANSITION_MS);
  const [provider, setProvider] = useState<CloudDriveProvider>("baidu");
  const [mode, setMode] = useState<"upload" | "restore">("upload");
  const [statuses, setStatuses] = useState<Record<CloudDriveProvider, CloudDriveStatus>>({
    baidu: emptyStatus("baidu"),
  });
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [authState, setAuthState] = useState<string | null>(null);
  const [authWaiting, setAuthWaiting] = useState(false);
  const [pasteCode, setPasteCode] = useState("");
  const [folderInput, setFolderInput] = useState("");
  const [progress, setProgress] = useState<CloudUploadProgress | null>(null);
  const [uploaded, setUploaded] = useState(false);
  const [restoreProjectName, setRestoreProjectName] = useState(project.name);
  const [versions, setVersions] = useState<CloudDriveFileEntry[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsLoaded, setVersionsLoaded] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<CloudDriveFileEntry | null>(null);
  const [restored, setRestored] = useState(false);

  const status = statuses[provider];
  const credentialLabels = {
    id: t("cloudDrive.clientIdBaidu"),
    secret: t("cloudDrive.clientSecretBaidu"),
    hint: t("cloudDrive.credentialHintBaidu"),
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const baidu = await cloudDriveStatus("baidu");
        if (!cancelled) {
          setStatuses({ baidu });
        }
      } catch (exception) {
        if (!cancelled) {
          setError(String(exception));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    void (async () => {
      unlisten = await listen<CloudUploadProgress>("cloud-upload-progress", (event) => {
        if (cancelled) {
          return;
        }
        if (event.payload.provider === provider) {
          setProgress(event.payload);
        }
      });
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [provider]);

  useEffect(() => {
    setFolderInput(statuses[provider]?.folderPath ?? "");
  }, [provider, statuses]);

  const switchProvider = (next: CloudDriveProvider) => {
    setProvider(next);
    setError(null);
    setNotice(null);
    setAuthState(null);
    setAuthWaiting(false);
    setPasteCode("");
    setFolderInput(statuses[next]?.folderPath ?? "");
    setProgress(null);
    setUploaded(false);
    setRestored(false);
    setVersions([]);
    setVersionsLoaded(false);
    setSelectedVersion(null);
  };

  const handleAuthorize = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await cloudDriveSetCredentials(provider, clientId.trim(), clientSecret.trim());
      setStatuses((current) => ({ ...current, [provider]: saved }));
      const init = await cloudDriveBeginAuthorize(provider);
      setAuthState(init.state);
      setAuthWaiting(init.kind === "callback");
      if (init.kind === "paste") {
        setNotice(t("cloudDrive.pasteHint"));
      }
    } catch (exception) {
      setError(String(exception));
    } finally {
      setBusy(false);
    }
  };

  const handleGetCredentials = async () => {
    setError(null);
    try {
      await openUrl(CREDENTIAL_PAGES[provider]);
    } catch (exception) {
      setError(String(exception));
    }
  };

  const handlePasteComplete = async () => {
    if (!pasteCode.trim()) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await cloudDriveAuthorizeComplete(provider, pasteCode.trim());
      setStatuses((current) => ({ ...current, [provider]: result }));
      setAuthState(null);
      setPasteCode("");
      setNotice(t("cloudDrive.connectedDone"));
    } catch (exception) {
      setError(String(exception));
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      await cloudDriveDisconnect(provider);
      setStatuses((current) => ({ ...current, [provider]: emptyStatus(provider) }));
      setNotice(t("cloudDrive.disconnected"));
      setProgress(null);
      setUploaded(false);
    } catch (exception) {
      setError(String(exception));
    } finally {
      setBusy(false);
    }
  };

  const handleSaveFolder = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await cloudDriveSetFolder(provider, folderInput.trim());
      setStatuses((current) => ({ ...current, [provider]: saved }));
      setFolderInput(saved.folderPath ?? "");
      setNotice(t("cloudDrive.folderSaved"));
    } catch (exception) {
      setError(String(exception));
    } finally {
      setBusy(false);
    }
  };

  const handleUpload = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    setProgress(null);
    setUploaded(false);
    setRestored(false);
    try {
      await cloudDriveUploadProject(provider, project);
      setUploaded(true);
      setNotice(t("cloudDrive.uploadSuccess"));
    } catch (exception) {
      setError(String(exception));
    } finally {
      setBusy(false);
    }
  };

  const handleListVersions = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    setVersionsLoading(true);
    setVersionsLoaded(false);
    try {
      const list = await cloudDriveListVersions(provider, restoreProjectName.trim());
      setVersions(list);
      setVersionsLoaded(true);
      if (list.length > 0) {
        // 后端按上传时间升序返回，最后一条为最新版本。
        setSelectedVersion(list[list.length - 1]);
      } else {
        setSelectedVersion(null);
      }
    } catch (exception) {
      setError(String(exception));
    } finally {
      setVersionsLoading(false);
      setBusy(false);
    }
  };

  const handleRestore = async () => {
    if (!selectedVersion) {
      return;
    }
    if (!window.confirm(t("cloudDrive.confirmRestore"))) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    setProgress(null);
    setRestored(false);
    try {
      const summary = await cloudDriveRestoreProject(
        provider,
        selectedVersion.path,
        selectedVersion.fsId
      );
      setRestored(true);
      setNotice(t("cloudDrive.restoreSuccess", { name: summary.projectName }));
      await onRestored?.();
    } catch (exception) {
      setError(String(exception));
    } finally {
      setBusy(false);
    }
  };

  const groups: VersionGroup[] = (() => {
    const grouped = new Map<string, CloudDriveFileEntry[]>();
    for (const entry of versions) {
      const name = projectNameFromFile(entry.name);
      const items = grouped.get(name) ?? [];
      items.push(entry);
      grouped.set(name, items);
    }
    return Array.from(grouped.entries())
      .map(([name, items]) => ({ name, items }))
      .sort((left, right) => left.name.localeCompare(right.name));
  })();

  if (!shouldRender) {
    return null;
  }

  const canAuthorize =
    (status.hasCredentials || (clientId.trim() && clientSecret.trim())) && !busy;

  return (
    <div className={`fixed ${UI_CONTENT_OVERLAY_INSET_CLASS} z-[100] flex items-center justify-center`}>
      <div
        className={`absolute inset-0 bg-black/50 transition-opacity duration-200 ${isVisible ? "opacity-100" : "opacity-0"}`}
        onClick={onClose}
      />
      <div
        className={`relative w-[480px] max-w-[92vw] rounded-lg border border-border-dark bg-surface-dark p-5 shadow-xl transition-opacity duration-200 ${isVisible ? "opacity-100" : "opacity-0"}`}
      >
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {mode === "restore" ? (
              <CloudDownload className="h-5 w-5 text-accent" />
            ) : (
              <CloudUpload className="h-5 w-5 text-accent" />
            )}
            <h2 className="text-lg font-semibold text-text-dark">
              {mode === "restore" ? t("cloudDrive.restoreTab") : t("cloudDrive.title")}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark"
            aria-label={t("common.close") ?? "关闭"}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mb-4 flex gap-2">
          {PROVIDERS.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => switchProvider(item)}
              className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                provider === item
                  ? "bg-accent text-white"
                  : "bg-bg-dark text-text-muted hover:text-text-dark"
              }`}
            >
              {t("cloudDrive.providerBaidu")}
            </button>
          ))}
        </div>

        {status.connected && (
          <div className="mb-4 flex gap-2">
            <button
              type="button"
              onClick={() => setMode("upload")}
              className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                mode === "upload"
                  ? "bg-accent text-white"
                  : "bg-bg-dark text-text-muted hover:text-text-dark"
              }`}
            >
              {t("cloudDrive.upload")}
            </button>
            <button
              type="button"
              onClick={() => setMode("restore")}
              className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                mode === "restore"
                  ? "bg-accent text-white"
                  : "bg-bg-dark text-text-muted hover:text-text-dark"
              }`}
            >
              {t("cloudDrive.restoreTab")}
            </button>
          </div>
        )}

        <div className="mb-2 truncate text-xs text-text-muted">
          {t("cloudDrive.project")}: {project.name}
        </div>

        {error && (
          <div className="mb-3 flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </div>
        )}

        {notice && (
          <div className="mb-3 flex items-start gap-2 rounded-md border border-border-dark bg-bg-dark px-3 py-2 text-sm text-text-muted">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
            <span className="min-w-0 break-words">{notice}</span>
          </div>
        )}

        {status.connected ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded-md border border-border-dark bg-bg-dark px-3 py-2 text-sm text-text-dark">
              <Lock className="h-4 w-4 shrink-0 text-accent" />
              <span className="min-w-0 truncate">
                {t("cloudDrive.connectedAs")}: {status.accountName || provider}
              </span>
            </div>
            {mode === "restore" ? (
              <div className="space-y-3">
                <p className="text-xs leading-relaxed text-text-muted">
                  {t("cloudDrive.restoreDesc")}
                </p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={restoreProjectName}
                    onChange={(event) => setRestoreProjectName(event.target.value)}
                    placeholder={t("cloudDrive.restoreProjectName")}
                    className="min-w-0 flex-1 rounded-md border border-border-dark bg-bg-dark px-3 py-2 text-sm text-text-dark outline-none placeholder:text-text-muted focus:border-accent"
                  />
                  <button
                    type="button"
                    onClick={() => void handleListVersions()}
                    disabled={busy || versionsLoading}
                    className="flex shrink-0 items-center gap-2 rounded-md border border-border-dark px-3 py-2 text-sm text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark disabled:cursor-wait disabled:opacity-60"
                  >
                    {versionsLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCw className="h-4 w-4" />
                    )}
                    {t("cloudDrive.listVersions")}
                  </button>
                </div>

                {progress && !restored && (
                  <div className="space-y-1">
                    <div className="h-2 overflow-hidden rounded-full bg-bg-dark">
                      <div
                        className="h-full rounded-full bg-accent transition-all duration-300"
                        style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }}
                      />
                    </div>
                    <div className="text-xs text-text-muted">
                      {progress.message}（{Math.min(100, progress.percent)}%）
                    </div>
                  </div>
                )}

                {groups.length > 0 ? (
                  <div className="max-h-64 space-y-3 overflow-y-auto rounded-md border border-border-dark bg-bg-dark p-2">
                    {groups.map((group) => (
                      <div key={group.name} className="space-y-1">
                        <div className="flex items-center justify-between px-1 pt-1 text-xs font-medium text-text-dark">
                          <span className="min-w-0 truncate">{group.name}</span>
                          <span className="shrink-0 pl-2 text-text-muted">{group.items.length}</span>
                        </div>
                        {group.items.map((entry, index) => {
                          const active =
                            selectedVersion?.path === entry.path &&
                            selectedVersion?.fsId === entry.fsId;
                          return (
                            <label
                              key={`${entry.path}:${entry.fsId}`}
                              className={`flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-xs transition-colors ${
                                active
                                  ? "border-accent/60 bg-accent/10"
                                  : "border-transparent hover:bg-surface-dark"
                              }`}
                            >
                              <input
                                type="radio"
                                name={`cloud-version-${group.name}`}
                                checked={active}
                                onChange={() => setSelectedVersion(entry)}
                                className="accent-accent"
                              />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-text-dark">
                                  {formatTime(entry.modifiedAtMs)}
                                </span>
                                <span className="block text-text-muted">
                                  {formatSize(entry.sizeBytes)}
                                </span>
                              </span>
                              {index === group.items.length - 1 && (
                                <span className="shrink-0 rounded bg-accent/20 px-1.5 py-0.5 text-[10px] text-accent">
                                  {t("cloudDrive.latestTag")}
                                </span>
                              )}
                            </label>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                ) : versionsLoaded ? (
                  <div className="text-xs text-text-muted">{t("cloudDrive.versionsEmpty")}</div>
                ) : null}
              </div>
            ) : (
              <>
                {provider === "baidu" ? (
                  <div className="rounded-md border border-border-dark bg-bg-dark p-3">
                    <label className="block text-xs text-text-muted">{t("cloudDrive.folder")}</label>
                    <div className="mt-1 flex gap-2">
                      <input
                        type="text"
                        value={folderInput}
                        onChange={(event) => setFolderInput(event.target.value)}
                        placeholder="/apps/产品名称"
                        className="min-w-0 flex-1 rounded-md border border-border-dark bg-bg-dark px-3 py-2 text-sm text-text-dark outline-none placeholder:text-text-muted focus:border-accent"
                      />
                      <button
                        type="button"
                        onClick={() => void handleSaveFolder()}
                        disabled={busy || !folderInput.trim()}
                        className="shrink-0 rounded-md border border-border-dark px-3 py-2 text-sm text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {t("cloudDrive.saveFolder")}
                      </button>
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-text-muted">
                      {t("cloudDrive.folderHintBaidu")}
                    </p>
                  </div>
                ) : status.folderPath ? (
                  <div className="rounded-md border border-border-dark bg-bg-dark px-3 py-2 text-xs text-text-muted">
                    {t("cloudDrive.folder")}: {status.folderPath}
                  </div>
                ) : null}

                {progress && !uploaded && (
                  <div className="space-y-1">
                    <div className="h-2 overflow-hidden rounded-full bg-bg-dark">
                      <div
                        className="h-full rounded-full bg-accent transition-all duration-300"
                        style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }}
                      />
                    </div>
                    <div className="text-xs text-text-muted">
                      {progress.message}（{Math.min(100, progress.percent)}%）
                    </div>
                  </div>
                )}

                {uploaded && (
                  <div className="flex items-center gap-2 text-sm text-emerald-400">
                    <CheckCircle2 className="h-4 w-4" />
                    {t("cloudDrive.uploadSuccess")}
                  </div>
                )}
              </>
            )}

            <div className="flex gap-2 pt-1">
              {mode === "restore" ? (
                <button
                  type="button"
                  onClick={() => void handleRestore()}
                  disabled={!selectedVersion || busy}
                  className="flex flex-1 items-center justify-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/85 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {busy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <CloudDownload className="h-4 w-4" />
                  )}
                  {busy ? t("cloudDrive.restoring") : t("cloudDrive.restoreButton")}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void handleUpload()}
                  disabled={busy}
                  className="flex flex-1 items-center justify-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/85 disabled:cursor-wait disabled:opacity-60"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                  {busy ? t("cloudDrive.uploading") : t("cloudDrive.upload")}
                </button>
              )}
              <button
                type="button"
                onClick={() => void handleDisconnect()}
                disabled={busy}
                className="flex items-center gap-2 rounded-md border border-border-dark px-3 py-2 text-sm text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark disabled:opacity-60"
              >
                <Unplug className="h-4 w-4" />
                {t("cloudDrive.disconnect")}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="block text-xs text-text-muted">{t("cloudDrive.credentials")}</label>
                <button
                  type="button"
                  onClick={() => void handleGetCredentials()}
                  className="text-xs text-accent transition-colors hover:underline"
                >
                  {t("cloudDrive.getCredentials")} ↗
                </button>
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={clientId}
                  onChange={(event) => setClientId(event.target.value)}
                  placeholder={credentialLabels.id}
                  className="min-w-0 flex-1 rounded-md border border-border-dark bg-bg-dark px-3 py-2 text-sm text-text-dark outline-none placeholder:text-text-muted focus:border-accent"
                />
                <input
                  type="password"
                  value={clientSecret}
                  onChange={(event) => setClientSecret(event.target.value)}
                  placeholder={credentialLabels.secret}
                  className="min-w-0 flex-1 rounded-md border border-border-dark bg-bg-dark px-3 py-2 text-sm text-text-dark outline-none placeholder:text-text-muted focus:border-accent"
                />
              </div>
              <p className="text-xs leading-relaxed text-text-muted">{credentialLabels.hint}</p>
            </div>

            {authWaiting && (
              <div className="flex items-center gap-2 text-sm text-text-muted">
                <Loader2 className="h-4 w-4 animate-spin text-accent" />
                {t("cloudDrive.waitingAuth")}
              </div>
            )}

            {authState && provider === "baidu" && (
              <div className="space-y-2">
                <label className="block text-xs text-text-muted">{t("cloudDrive.pasteCode")}</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={pasteCode}
                    onChange={(event) => setPasteCode(event.target.value)}
                    placeholder={t("cloudDrive.pasteCodePlaceholder")}
                    className="min-w-0 flex-1 rounded-md border border-border-dark bg-bg-dark px-3 py-2 text-sm text-text-dark outline-none placeholder:text-text-muted focus:border-accent"
                  />
                  <button
                    type="button"
                    onClick={() => void handlePasteComplete()}
                    disabled={busy || !pasteCode.trim()}
                    className="rounded-md bg-accent px-3 py-2 text-sm text-white transition-colors hover:bg-accent/85 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {t("cloudDrive.finishAuth")}
                  </button>
                </div>
              </div>
            )}

            {!authWaiting && !authState && (
              <button
                type="button"
                onClick={() => void handleAuthorize()}
                disabled={!canAuthorize}
                className="flex w-full items-center justify-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/85 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <KeyRound className="h-4 w-4" />
                {t("cloudDrive.saveAndAuthorize")}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
