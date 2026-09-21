import { invoke, isTauri } from '@tauri-apps/api/core';
import i18n from '@/i18n';

export interface RunningHubCliCheck {
  executable: string;
  ready: boolean;
  message: string;
}

function requireDesktop(): void {
  if (!isTauri()) throw new Error(i18n.t('runningHubCli.desktopOnly'));
}

export async function setRunningHubCliKey(executable: string, apiKey: string): Promise<RunningHubCliCheck> {
  requireDesktop();
  return invoke<RunningHubCliCheck>('runninghub_cli_set_key', { executable, apiKey });
}

export async function checkRunningHubCli(executable: string): Promise<RunningHubCliCheck> {
  requireDesktop();
  return invoke<RunningHubCliCheck>('runninghub_cli_check', { executable });
}
