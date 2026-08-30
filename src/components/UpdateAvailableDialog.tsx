import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { UiButton, UiModal, UiSelect } from '@/components/ui';

export type UpdateIgnoreMode = 'today-version' | 'forever-version' | 'forever-all';

interface UpdateAvailableDialogProps {
  isOpen: boolean;
  onClose: () => void;
  latestVersion?: string;
  currentVersion?: string;
  onApplyIgnore?: (mode: UpdateIgnoreMode) => void;
}

export function UpdateAvailableDialog({
  isOpen,
  onClose,
  latestVersion,
  currentVersion,
  onApplyIgnore
}: UpdateAvailableDialogProps) {
  const { t } = useTranslation();
  const [ignoreMode, setIgnoreMode] = useState<UpdateIgnoreMode>('today-version');
  const [updateState, setUpdateState] = useState<'idle' | 'downloading' | 'installing' | 'error'>('idle');
  const [updateError, setUpdateError] = useState<string | null>(null);

  const ignoreOptions = useMemo(
    () => [
      { value: 'today-version' as const, label: t('update.ignoreTodayVersion') },
      { value: 'forever-version' as const, label: t('update.ignoreThisVersionForever') },
      { value: 'forever-all' as const, label: t('update.ignoreAllForever') }
    ],
    [t]
  );

  /** OTA 更新: 下载 → 安装 → 自动重启 */
  const handleUpdate = useCallback(async () => {
    if (updateState === 'downloading' || updateState === 'installing') {
      return;
    }
    setUpdateState('downloading');
    setUpdateError(null);
    try {
      const update = await check();
      if (!update) {
        setUpdateState('error');
        setUpdateError(t('update.noUpdateAvailable', '没有可用更新'));
        return;
      }
      await update.downloadAndInstall();
      setUpdateState('installing');
      await relaunch();
    } catch (error) {
      setUpdateState('error');
      setUpdateError(error instanceof Error ? error.message : String(error));
    }
  }, [t, updateState]);

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
          <UiButton
            variant="primary"
            onClick={() => void handleUpdate()}
            disabled={updateState === 'downloading' || updateState === 'installing'}
          >
            {updateState === 'downloading'
              ? t('update.downloading', '正在下载更新…')
              : updateState === 'installing'
                ? t('update.installing', '正在安装…')
                : t('update.updateNow', '更新并重启')}
          </UiButton>
          <UiButton variant="ghost" onClick={handleApplyIgnore}>
            {t('update.applyIgnore')}
          </UiButton>
        </>
      }
    >
      {updateState === 'error' && updateError && (
        <p className="mb-3 text-xs text-red-400">{updateError}</p>
      )}
      <div className="text-sm leading-6">
        {(latestVersion || currentVersion) && (
          <p className="text-xs text-text-muted">
            {t('update.versionLine', {
              currentVersion: currentVersion ?? '-',
              latestVersion: latestVersion ?? '-'
            })}
          </p>
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
