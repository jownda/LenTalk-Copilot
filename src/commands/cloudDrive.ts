import { invoke, isTauri } from "@tauri-apps/api/core";

import type { ProjectRecord } from "@/commands/projectState";

export type CloudDriveProvider = "baidu";

export interface CloudDriveAuthInit {
  kind: "callback" | "paste";
  url: string;
  state: string;
}

export interface CloudDriveStatus {
  provider: string;
  connected: boolean;
  hasCredentials?: boolean;
  accountName?: string | null;
  folderPath?: string | null;
}

export interface CloudUploadSummary {
  provider: string;
  fileName: string;
  sizeBytes: number;
}

export interface CloudDriveFileEntry {
  path: string;
  name: string;
  sizeBytes: number;
  modifiedAtMs: number;
  fsId: string;
}

export interface CloudRestoreSummary {
  provider: string;
  projectId: string;
  projectName: string;
  sizeBytes: number;
}

export interface CloudUploadProgress {
  provider: string;
  phase: string;
  percent: number;
  message: string;
}

function unavailable(): never {
  throw new Error("云空间上传仅支持桌面端应用");
}

export async function cloudDriveStatus(provider: CloudDriveProvider): Promise<CloudDriveStatus> {
  if (!isTauri()) {
    return unavailable();
  }
  return invoke<CloudDriveStatus>("cloud_drive_status", { provider });
}

export async function cloudDriveSetCredentials(
  provider: CloudDriveProvider,
  clientId: string,
  clientSecret: string
): Promise<CloudDriveStatus> {
  if (!isTauri()) {
    return unavailable();
  }
  return invoke<CloudDriveStatus>("cloud_drive_set_credentials", {
    provider,
    clientId,
    clientSecret,
  });
}

export async function cloudDriveSetFolder(
  provider: CloudDriveProvider,
  folderPath: string
): Promise<CloudDriveStatus> {
  if (!isTauri()) {
    return unavailable();
  }
  return invoke<CloudDriveStatus>("cloud_drive_set_folder", { provider, folderPath });
}

export async function cloudDriveBeginAuthorize(provider: CloudDriveProvider): Promise<CloudDriveAuthInit> {
  if (!isTauri()) {
    return unavailable();
  }
  return invoke<CloudDriveAuthInit>("cloud_drive_begin_authorize", { provider });
}

export async function cloudDriveAuthorizeComplete(
  provider: CloudDriveProvider,
  code: string
): Promise<CloudDriveStatus> {
  if (!isTauri()) {
    return unavailable();
  }
  return invoke<CloudDriveStatus>("cloud_drive_authorize_complete", { provider, code });
}

export async function cloudDriveDisconnect(provider: CloudDriveProvider): Promise<void> {
  if (!isTauri()) {
    return unavailable();
  }
  await invoke("cloud_drive_disconnect", { provider });
}

export async function cloudDriveUploadProject(
  provider: CloudDriveProvider,
  record: ProjectRecord
): Promise<CloudUploadSummary> {
  if (!isTauri()) {
    return unavailable();
  }
  return invoke<CloudUploadSummary>("cloud_drive_upload_project", { provider, record });
}

export async function cloudDriveListVersions(
  provider: CloudDriveProvider,
  projectName: string
): Promise<CloudDriveFileEntry[]> {
  if (!isTauri()) {
    return unavailable();
  }
  return invoke<CloudDriveFileEntry[]>("cloud_drive_list_versions", {
    provider,
    projectName,
  });
}

export async function cloudDriveRestoreProject(
  provider: CloudDriveProvider,
  path: string,
  fsId: string
): Promise<CloudRestoreSummary> {
  if (!isTauri()) {
    return unavailable();
  }
  return invoke<CloudRestoreSummary>("cloud_drive_restore_project", {
    provider,
    path,
    fsId,
  });
}
