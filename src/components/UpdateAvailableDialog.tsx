import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { openUrl } from '@tauri-apps/plugin-opener';
import { UiButton, UiModal, UiSelect } from '@/components/ui';

const GITHUB_RELEASES_URL = 'https://github.com/jownda/LenTalk-Copilot/releases';
export type UpdateIgnoreMode = 'today-version' | 'forever-version' | 'forever-all';

interface UpdateAvailableDialogProps {
  isOpen: boolean;
  onClose: () => void;
  latestVersion?: string;
  currentVersion?: string;
  downloadUrl?: string;
  releaseUrl?: string;
  releaseNotes?: string;
  onApplyIgnore?: (mode: UpdateIgnoreMode) => void;
}

export function UpdateAvailableDialog({
  isOpen,
  onClose,
  latestVersion,
  currentVersion,
  downloadUrl,
  releaseUrl,
  releaseNotes,
  onApplyIgnore
}: UpdateAvailableDialogProps) {
  const { t } = useTranslation();
  const [ignoreMode, setIgnoreMode] = useState<UpdateIgnoreMode>('today-version');

  const ignoreOptions = useMemo(
    () => [
      { value: 'today-version' as const, label: t('update.ignoreTodayVersion') },
      { value: 'forever-version' as const, label: t('update.ignoreThisVersionForever') },
      { value: 'forever-all' as const, label: t('update.ignoreAllForever') }
    ],
    [t]
  );

  const handleOpenGithub = useCallback(() => {
    void openUrl(downloadUrl ?? releaseUrl ?? GITHUB_RELEASES_URL);
  }, [downloadUrl, releaseUrl]);

  const handleApplyIgnore = useCallback(() => {
    onApplyIgnore?.(ignoreMode);
    onClose();
  }, [ignoreMode, onApplyIgnore, onClose]);

  return (
    <UiModal
      isOpen={isOpen}
      onClose={onClose}
      title={t('update.dialogTitle')}
      footer={
        <>
          <UiButton variant="muted" onClick={onClose}>
            {t('common.cancel')}
          </UiButton>
          <UiButton variant="primary" onClick={handleOpenGithub}>
            {t(downloadUrl ? 'update.downloadGithubInstaller' : 'update.goToGithubDownload')}
          </UiButton>
          <UiButton variant="ghost" onClick={handleApplyIgnore}>
            {t('update.applyIgnore')}
          </UiButton>
        </>
      }
    >
      <div className="text-sm text-text-muted leading-6">
        <p>{t('update.dialogDescription')}</p>
        {(latestVersion || currentVersion) && (
          <p className="mt-2 text-xs">
            {t('update.versionLine', {
              currentVersion: currentVersion ?? '-',
              latestVersion: latestVersion ?? '-'
            })}
          </p>
        )}
        {releaseNotes && (
          <div className="mt-3 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md bg-bg-dark/60 px-3 py-2 text-xs leading-5 text-text-muted">
            {releaseNotes}
          </div>
        )}
        <div className="mt-3">
          <p className="mb-1 text-xs text-text-muted">{t('update.ignoreRule')}</p>
          <UiSelect
            value={ignoreMode}
            onChange={(event) => setIgnoreMode(event.target.value as UpdateIgnoreMode)}
            className="h-9 text-sm"
          >
            {ignoreOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </UiSelect>
        </div>
      </div>
    </UiModal>
  );
}
