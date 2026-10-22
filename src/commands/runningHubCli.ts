import { invoke, isTauri } from '@tauri-apps/api/core';
import i18n from '@/i18n';

export interface RunningHubCliCheck {
  executable: string;
  ready: boolean;
  message: string;
}

export interface RunningHubCliDetect {
  found: boolean;
  resolvedPath: string | null;
  source: string;
  candidatePaths: string[];
}

export interface RunningHubCliInstall {
  success: boolean;
  installed: boolean;
  resolvedPath: string | null;
  message: string;
}

export interface RunningHubCliLogout {
  success: boolean;
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

/** 只读探测本机是否安装 RunningHub CLI；不会触发安装。 */
export async function detectRunningHubCli(executable: string): Promise<RunningHubCliDetect> {
  requireDesktop();
  return invoke<RunningHubCliDetect>('runninghub_cli_detect', { executable });
}

/** 自动安装 RunningHub CLI（官方仓库源码安装，仅写入当前用户目录）。 */
export async function installRunningHubCli(): Promise<RunningHubCliInstall> {
  requireDesktop();
  return invoke<RunningHubCliInstall>('runninghub_cli_install');
}

/** 移除 CLI 配置里的 api_key（CLI 自身没有 logout 命令）。 */
export async function logoutRunningHubCli(): Promise<RunningHubCliLogout> {
  requireDesktop();
  return invoke<RunningHubCliLogout>('runninghub_cli_logout');
}

/** 读取系统剪贴板文本，用于识别用户刚从官方 Key 页复制的 API Key。 */
export async function readRunningHubCliClipboard(): Promise<string> {
  requireDesktop();
  return invoke<string>('runninghub_cli_read_clipboard');
}
